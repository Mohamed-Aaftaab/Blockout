import { ethers } from 'ethers';
import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type { Order, Transaction } from '../types/index';
import { ok, err, type Result } from '../types/index';
import { EngineError } from '../types/errors';
import { sleep } from '../utils/sleep';

// ─── ABIs ────────────────────────────────────────────────────────────────────

const PANCAKE_ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
];

const PANCAKE_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];

const PANCAKE_PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
];

// ERC-20 ABI — needed for approve(), allowance(), and balanceOf() calls
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address owner) external view returns (uint256)',
];

// ─── Token addresses ─────────────────────────────────────────────────────────
const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  mainnet: {
    WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    BTC:  '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
    ETH:  '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
  },
  testnet: {
    WBNB: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',
    USDT: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
    USDC: '0x64544969ed7EBf5f083679233325356EbE738930',
    CAKE: '0xFa60D973F7642B748046464e165A65B7323b0DEE',
    BTC:  '0x6ce8dA28E2f864420840cF74474eFf5fD80E65B8',
    ETH:  '0x98f7A83361F7Ac8765CcEBAB1425da6b341958a7',
  },
};

// PancakeSwap V2 Factory addresses (used for pool reserve lookups — must match V2 router)
const PANCAKE_V2_FACTORY: Record<string, string> = {
  mainnet: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
  testnet: '0x6725F303b657a9451d8BA641348b6761A6CC7a17',
};

// Token decimals — USDT/USDC use 6, everything else 18
const TOKEN_DECIMALS: Record<string, number> = {
  USDT: 6,
  USDC: 6,
};

function getTokenDecimals(symbol: string): number {
  return TOKEN_DECIMALS[symbol] ?? 18;
}

export interface PoolReserves {
  reserve0:     bigint;
  reserve1:     bigint;
  token0:       string;
  token1:       string;
  token0Symbol: string;
  token1Symbol: string;
  pairAddress:  string;
  fetchedAt:    number;
}

/** Describes the full set of calldata needed to execute a swap, including any prior approval */
export interface SwapPlan {
  /** If non-null: send this approve tx first (for ERC-20 input tokens) */
  approveTx: {
    to:       string;
    calldata: string;
    value:    bigint;
  } | null;
  /** The actual swap transaction */
  swapTx: {
    to:       string;
    calldata: string;
    value:    bigint;
    gasLimit: number;
  };
}

const logger = makeLogger();

export class TradingEngine {
  private provider:        ethers.JsonRpcProvider | null = null;
  private wallet:          ethers.Wallet | null = null;
  private currentRpcIndex: number = 0;
  private readonly config: ConfigurationService;
  private readonly bus:    EventBus;
  /** CMC-sourced BNB price. Updated by MarketDataService. Fallback: $300 */
  private bnbPriceUsd: number = 300;
  /** Portfolio value cache (5s TTL) — prevents N+1 RPC calls per signal */
  private portfolioCache: { value: number; expiresAt: number } = { value: 0, expiresAt: 0 };

  constructor(config: ConfigurationService, bus: EventBus) {
    this.config = config;
    this.bus    = bus;
  }

  async initialize(): Promise<void> {
    const cfg      = this.config.get();
    const endpoint = cfg.network.rpcEndpoints[0];
    if (endpoint === undefined) {
      const error = new EngineError('No RPC endpoints configured', undefined);
      this.bus.emit('health:critical', { component: 'TradingEngine', message: error.message, timestamp: Date.now() });
      throw error;
    }

    this.provider = new ethers.JsonRpcProvider(endpoint);

    try {
      const blockNumber = await Promise.race([
        this.getBlockNumber(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), 30_000)),
      ]);
      logger.info('TradingEngine initialized', { endpoint, blockNumber, network: cfg.network.mode });
    } catch (e) {
      const error = new EngineError(`Failed to connect to RPC ${endpoint}: ${String(e)}`, undefined);
      this.bus.emit('health:critical', { component: 'TradingEngine', message: error.message, timestamp: Date.now() });
      throw error;
    }
  }

  setSigner(wallet: ethers.Wallet): void {
    this.wallet = wallet.connect(this.requireProvider());
    logger.info('TradingEngine signer set', { address: wallet.address });
  }

  /** Receives real CMC BNB price from MarketDataService */
  setBnbPrice(priceUsd: number): void {
    if (priceUsd > 0) this.bnbPriceUsd = priceUsd;
  }

  getBnbPrice(): number { return this.bnbPriceUsd; }

  /** Public provider access for ExecutionService receipt polling */
  getProvider(): ethers.JsonRpcProvider | null { return this.provider; }

  async routeOrder(order: Order): Promise<Result<Transaction, EngineError>> {
    try {
      let tx: Transaction;
      if (order.venue === 'bsc_perpetuals') {
        tx = await this.buildPerpPosition(order);
      } else {
        // pancakeswap (default)
        const plan = await this.buildSwapPlan(order);
        tx = {
          hash:           '0x' + '0'.repeat(64),
          orderId:        order.id,
          status:         'pending',
          gasPrice:       0,
          gasLimit:       plan.swapTx.gasLimit,
          gasUsed:        null,
          actualSlippage: null,
          submittedAt:    Date.now(),
          confirmedAt:    null,
          blockNumber:    null,
          error:          null,
          calldata:       plan.swapTx.calldata,
          value:          plan.swapTx.value,
          to:             plan.swapTx.to,
        };
      }
      this.bus.emit('engine:order_routed', { orderId: order.id, venue: order.venue });
      return ok(tx);
    } catch (e) {
      return err(new EngineError(`Order routing failed for ${order.venue}: ${String(e)}`, order.venue));
    }
  }

  /** Returns the full swap plan including any required ERC-20 approval */
  async buildSwapPlan(order: Order): Promise<SwapPlan> {
    const cfg      = this.config.get();
    const provider = this.requireProvider();
    const network  = cfg.network.mode === 'mainnet' ? 'mainnet' : 'testnet';
    const tokens   = TOKEN_ADDRESSES[network] ?? TOKEN_ADDRESSES['testnet']!;
    // Always use V2 factory for pair lookups — must match V2 router
    const v2Factory = PANCAKE_V2_FACTORY[network] ?? PANCAKE_V2_FACTORY['testnet']!;

    const [baseSymbol, quoteSymbol] = order.pair.split('/');
    const wbnb       = tokens['WBNB']          ?? ethers.ZeroAddress;
    const baseToken  = tokens[baseSymbol  ?? 'BNB']  ?? wbnb;
    const quoteToken = tokens[quoteSymbol ?? 'USDT'] ?? (tokens['USDT'] ?? ethers.ZeroAddress);

    const baseIsNative = baseToken.toLowerCase() === wbnb.toLowerCase();

    const deadline    = Math.floor(Date.now() / 1000) + 300;
    const slippageBps = Math.floor(order.slippage * 100);
    const iface       = new ethers.Interface(PANCAKE_ROUTER_ABI);
    const recipient   = this.wallet?.address ?? ethers.ZeroAddress;
    const router      = new ethers.Contract(cfg.venue.pancakeswapRouter, PANCAKE_ROUTER_ABI, provider);

    let calldata:        string;
    let value:           bigint;
    let path:            string[];
    let spendToken:      string | null = null;
    let spendAmountWei:  bigint        = 0n;

    /**
     * Get amountOutMin with proper fallback.
     * @param amountIn        Input amount in the INPUT token's wei units
     * @param swapPath        Token path for the swap
     * @param outputDecimals  Decimal count of the OUTPUT token (18 for BNB/CAKE/ETH, 6 for USDT)
     * @param inputIsNative   True when the input is native BNB (18 decimals)
     */
    const getAmountOutMin = async (
      amountIn:       bigint,
      swapPath:       string[],
      outputDecimals: number,
      inputIsNative:  boolean,
    ): Promise<bigint> => {
      try {
        const amounts = await router.getFunction('getAmountsOut')(amountIn, swapPath) as bigint[];
        const expectedOut = amounts[amounts.length - 1] ?? 0n;
        if (expectedOut === 0n) throw new Error('zero expected output');
        return (expectedOut * BigInt(10000 - slippageBps)) / BigInt(10000);
      } catch {
        // Fallback: compute minimum output using price estimates so we never accept 0.
        // The key insight: we need minimum OUTPUT in OUTPUT token's units.
        let minOutputWei: bigint;

        if (inputIsNative) {
          // Spending native BNB → receiving token (CAKE, USDT, etc.)
          const bnbIn   = Number(ethers.formatUnits(amountIn, 18));
          const usdIn   = bnbIn * this.bnbPriceUsd;
          // If outputDecimals = 6 (USDT): minOut = usdIn * 0.95 in USDT units
          // If outputDecimals = 18 (CAKE): min is harder to estimate without price; use 95% of input value
          // Conservative: accept at least 90% of USD value in output token terms
          const minUsd  = usdIn * 0.90;
          if (outputDecimals === 6) {
            // USDT/USDC output: minUsd ≈ minOut amount directly
            minOutputWei = ethers.parseUnits(minUsd.toFixed(6), 6);
          } else {
            // Token output: convert USD back to BNB equivalent as floor
            // (we can't know CAKE price here, so use a 90% of BNB input as floor in token wei)
            const minBnb = bnbIn * 0.90;
            minOutputWei = ethers.parseUnits(minBnb.toFixed(8), outputDecimals);
          }
        } else {
          // Spending ERC-20 (USDT/CAKE) → receiving native BNB
          if (outputDecimals === 18) {
            // Input is USDT (6 dec), output is BNB (18 dec)
            const usdIn     = Number(ethers.formatUnits(amountIn, 6)); // USDT ≈ USD
            const minBnbOut = (usdIn * 0.90) / this.bnbPriceUsd;
            minOutputWei    = ethers.parseUnits(minBnbOut.toFixed(8), 18);
          } else {
            // Input is some token, output is BNB: conservative 90% of input in output units
            minOutputWei = (amountIn * 9000n) / 10000n;
          }
        }

        logger.warn('getAmountsOut unavailable — using price-based amountOutMin', {
          minOutputWei: minOutputWei.toString(),
          outputDecimals,
          inputIsNative,
        });
        return minOutputWei;
      }
    };

    if (order.side === 'buy') {
      if (baseIsNative) {
        // Buying BNB with USDT — spend USDT (ERC-20), receive BNB (native)
        // order.size is USD ≈ USDT amount (1:1 since USDT ≈ $1)
        const usdtDec    = getTokenDecimals(quoteSymbol ?? 'USDT');
        spendAmountWei   = ethers.parseUnits(order.size.toFixed(usdtDec), usdtDec);
        path             = [quoteToken, wbnb];
        // Input: USDT (non-native), Output: BNB (18 decimals)
        const outMin     = await getAmountOutMin(spendAmountWei, path, 18, false);
        calldata         = iface.encodeFunctionData('swapExactTokensForETH', [spendAmountWei, outMin, path, recipient, deadline]);
        value            = 0n;
        spendToken       = quoteToken;
      } else {
        // Buying CAKE/ETH/BTC with BNB — convert USD→BNB, spend native BNB
        const bnbAmount  = order.size / this.bnbPriceUsd;
        // Use 8 decimal places — sufficient precision without float representation issues
        spendAmountWei   = ethers.parseUnits(bnbAmount.toFixed(8), 18);
        path             = [wbnb, baseToken];
        // Input: BNB (native, 18 dec), Output: base token (e.g. CAKE, 18 dec)
        const baseOutDec = getTokenDecimals(baseSymbol ?? 'CAKE');
        const outMin     = await getAmountOutMin(spendAmountWei, path, baseOutDec, true);
        calldata         = iface.encodeFunctionData('swapExactETHForTokens', [outMin, path, recipient, deadline]);
        value            = spendAmountWei;
        spendToken       = null; // native BNB, no approval needed
      }
    } else {
      // sell
      if (baseIsNative) {
        // Selling BNB for USDT — convert USD→BNB, spend native BNB
        const bnbAmount  = order.size / this.bnbPriceUsd;
        spendAmountWei   = ethers.parseUnits(bnbAmount.toFixed(8), 18);
        path             = [wbnb, quoteToken];
        // Input: BNB (native, 18 dec), Output: quote token (e.g. USDT, 6 dec)
        const quoteOutDec = getTokenDecimals(quoteSymbol ?? 'USDT');
        const outMin     = await getAmountOutMin(spendAmountWei, path, quoteOutDec, true);
        calldata         = iface.encodeFunctionData('swapExactETHForTokens', [outMin, path, recipient, deadline]);
        value            = spendAmountWei;
        spendToken       = null;
      } else {
        // Selling CAKE/ETH/BTC for BNB
        // Convert USD→token using estimated token price from pool
        const baseTokenDecimals  = getTokenDecimals(baseSymbol ?? 'CAKE');
        // Get token price in BNB then USD using V2 pool reserves
        const tokenPriceInBnb = await this.getTokenPriceInBnb(baseToken, wbnb, provider, v2Factory);
        const tokenPriceUsd   = tokenPriceInBnb * this.bnbPriceUsd;
        const tokenAmount     = tokenPriceUsd > 0 ? order.size / tokenPriceUsd : order.size; // fallback: treat as raw token
        spendAmountWei        = ethers.parseUnits(tokenAmount.toFixed(8), baseTokenDecimals);
        path                  = [baseToken, wbnb];
        // Input: base token (non-native, e.g. CAKE), Output: BNB (18 decimals)
        const outMin          = await getAmountOutMin(spendAmountWei, path, 18, false);
        calldata              = iface.encodeFunctionData('swapExactTokensForETH', [spendAmountWei, outMin, path, recipient, deadline]);
        value                 = 0n;
        spendToken            = baseToken; // need ERC-20 approval
      }
    }

    // Estimate gas for the swap
    let gasLimit = 300_000n;
    try {
      if (this.wallet) {
        const signer = this.wallet.connect(provider);
        gasLimit = await signer.estimateGas({ to: cfg.venue.pancakeswapRouter, data: calldata, value });
        gasLimit = (gasLimit * 120n) / 100n;
      }
    } catch {
      gasLimit = 300_000n;
    }

    // Build approve tx if ERC-20 input token needs allowance
    let approveTx: SwapPlan['approveTx'] = null;
    if (spendToken !== null && this.wallet !== null) {
      try {
        const erc20     = new ethers.Contract(spendToken, ERC20_ABI, provider);
        const allowance = await erc20.getFunction('allowance')(this.wallet.address, cfg.venue.pancakeswapRouter) as bigint;
        // Use the actual spend amount (in the spend token's decimals) for comparison
        if (allowance < spendAmountWei) {
          const approveIface = new ethers.Interface(ERC20_ABI);
          const approveData  = approveIface.encodeFunctionData('approve', [
            cfg.venue.pancakeswapRouter,
            ethers.MaxUint256,
          ]);
          approveTx = { to: spendToken, calldata: approveData, value: 0n };
          logger.info('ERC-20 approval required', { token: spendToken, spender: cfg.venue.pancakeswapRouter, spendAmount: spendAmountWei.toString() });
        }
      } catch (e) {
        logger.warn('Could not check allowance — proceeding without approval (may fail)', { error: String(e) });
      }
    }

    logger.info('Swap plan built', {
      pair:          order.pair,
      side:          order.side,
      path,
      spendAmount:   spendAmountWei.toString(),
      needsApproval: approveTx !== null,
    });

    return {
      approveTx,
      swapTx: { to: cfg.venue.pancakeswapRouter, calldata, value, gasLimit: Number(gasLimit) },
    };
  }

  /** Helper: get approximate token price in BNB via pool reserves */
  private async getTokenPriceInBnb(
    tokenAddress:   string,
    wbnb:           string,
    provider:       ethers.JsonRpcProvider,
    factoryAddress: string,
  ): Promise<number> {
    try {
      // Try direct token/WBNB pool first
      const factory  = new ethers.Contract(factoryAddress, PANCAKE_FACTORY_ABI, provider);
      const pairAddr = await factory.getFunction('getPair')(tokenAddress, wbnb) as string;
      if (pairAddr === ethers.ZeroAddress) return 0;

      const pc   = new ethers.Contract(pairAddr, PANCAKE_PAIR_ABI, provider);
      const t0   = await pc.getFunction('token0')() as string;
      const [r0, r1] = await pc.getFunction('getReserves')() as [bigint, bigint];

      // Determine which reserve is the token and which is WBNB
      const tokenIsToken0 = t0.toLowerCase() === tokenAddress.toLowerCase();
      const tokenReserve  = tokenIsToken0 ? r0 : r1;
      const bnbReserve    = tokenIsToken0 ? r1 : r0;

      if (tokenReserve === 0n) return 0;
      // Look up the correct decimal count for this token from the address map.
      // WBNB is always 18; USDT/USDC use 6; everything else defaults to 18.
      const cfg2    = this.config.get();
      const net2    = cfg2.network.mode === 'mainnet' ? 'mainnet' : 'testnet';
      const tokMap  = TOKEN_ADDRESSES[net2] ?? TOKEN_ADDRESSES['testnet']!;
      const addrLow = tokenAddress.toLowerCase();
      let tokenDecimals = 18;
      for (const [sym, addr] of Object.entries(tokMap)) {
        if (addr.toLowerCase() === addrLow) {
          tokenDecimals = getTokenDecimals(sym);
          break;
        }
      }
      const tokenAmt = Number(ethers.formatUnits(tokenReserve, tokenDecimals));
      const bnbAmt   = Number(ethers.formatUnits(bnbReserve, 18)); // WBNB always 18
      if (tokenAmt === 0) return 0;
      return bnbAmt / tokenAmt;
    } catch {
      return 0;
    }
  }

  private async buildPerpPosition(order: Order): Promise<Transaction> {
    const cfg      = this.config.get();
    const isLong   = order.side === 'buy';
    const sizeWei  = ethers.parseUnits((order.size / this.bnbPriceUsd).toFixed(8), 18);
    const leverage = cfg.risk.leverageMultiplier;
    const slipBps  = Math.floor(order.slippage * 100);
    // NOTE: This ABI signature is a documented stub matching common perp protocol conventions
    // (GMX/Gains-style). Production use requires verifying the actual deployed ABI at
    // cfg.venue.bscPerpsContract and updating this signature accordingly.
    const iface    = new ethers.Interface([
      'function openPosition(address market, bool isLong, uint256 size, uint256 leverage, uint256 slippage) external payable',
    ]);
    const calldata = iface.encodeFunctionData('openPosition', [cfg.venue.bscPerpsContract, isLong, sizeWei, leverage, slipBps]);
    logger.warn('BSC Perpetuals order built — verify contract ABI matches deployed contract before live use', {
      contract: cfg.venue.bscPerpsContract,
      isLong,
      size: sizeWei.toString(),
    });
    return {
      hash:           '0x' + '0'.repeat(64),
      orderId:        order.id,
      status:         'pending',
      gasPrice:       0,
      gasLimit:       500_000,
      gasUsed:        null,
      actualSlippage: null,
      submittedAt:    Date.now(),
      confirmedAt:    null,
      blockNumber:    null,
      error:          null,
      calldata,
      value:          isLong ? sizeWei : 0n,
      to:             cfg.venue.bscPerpsContract,
    };
  }

  async getGasPrice(): Promise<{ baseFee: number; priorityFee: number }> {
    try {
      const feeData = await this.requireProvider().getFeeData();
      const baseFee = feeData.gasPrice !== null ? Number(ethers.formatUnits(feeData.gasPrice, 'gwei')) : 3;
      const prio    = feeData.maxPriorityFeePerGas !== null ? Number(ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei')) : 1;
      return { baseFee, priorityFee: prio };
    } catch (e) {
      logger.warn('getGasPrice failed — triggering RPC failover', { error: String(e) });
      const ok = await this.failoverRPC();
      if (!ok) return { baseFee: 3, priorityFee: 1 };
      try {
        const feeData = await this.requireProvider().getFeeData();
        const baseFee = feeData.gasPrice !== null ? Number(ethers.formatUnits(feeData.gasPrice, 'gwei')) : 3;
        const prio    = feeData.maxPriorityFeePerGas !== null ? Number(ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei')) : 1;
        return { baseFee, priorityFee: prio };
      } catch {
        return { baseFee: 3, priorityFee: 1 };
      }
    }
  }

  async getPoolReserves(pair: string): Promise<PoolReserves> {
    const cfg     = this.config.get();
    const network = cfg.network.mode === 'mainnet' ? 'mainnet' : 'testnet';
    const tokens  = TOKEN_ADDRESSES[network] ?? TOKEN_ADDRESSES['testnet']!;
    // Use V2 factory — matches the V2 router used for swaps
    const v2Factory = PANCAKE_V2_FACTORY[network] ?? PANCAKE_V2_FACTORY['testnet']!;

    const [baseSymbol, quoteSymbol] = pair.split('/');
    const tokenA = tokens[baseSymbol  ?? 'WBNB'] ?? (tokens['WBNB'] ?? ethers.ZeroAddress);
    const tokenB = tokens[quoteSymbol ?? 'USDT'] ?? (tokens['USDT'] ?? ethers.ZeroAddress);

    // Fallback uses correct decimal precision per token symbol
    const fallback: PoolReserves = {
      reserve0: ethers.parseUnits('100000', getTokenDecimals(baseSymbol  ?? 'BNB')),
      reserve1: ethers.parseUnits('100000', getTokenDecimals(quoteSymbol ?? 'USDT')),
      token0: tokenA, token1: tokenB,
      token0Symbol: baseSymbol ?? 'BNB', token1Symbol: quoteSymbol ?? 'USDT',
      pairAddress: ethers.ZeroAddress, fetchedAt: Date.now(),
    };

    try {
      const provider = this.requireProvider();
      const factory  = new ethers.Contract(v2Factory, PANCAKE_FACTORY_ABI, provider);
      const pairAddr = await factory.getFunction('getPair')(tokenA, tokenB) as string;
      if (pairAddr === ethers.ZeroAddress) return fallback;

      const pc        = new ethers.Contract(pairAddr, PANCAKE_PAIR_ABI, provider);
      const [r0, r1]  = await pc.getFunction('getReserves')() as [bigint, bigint];
      const t0        = await pc.getFunction('token0')() as string;
      const t1        = await pc.getFunction('token1')() as string;

      // PancakeSwap sorts tokens by address on pair creation, so t0 may not match tokenA.
      // Derive symbol labels from addresses to keep PoolAnalyzer decimals correct.
      const tokenALower   = tokenA.toLowerCase();
      const t0IsTokenA    = t0.toLowerCase() === tokenALower;
      const actual0Symbol = t0IsTokenA ? (baseSymbol ?? 'BNB') : (quoteSymbol ?? 'USDT');
      const actual1Symbol = t0IsTokenA ? (quoteSymbol ?? 'USDT') : (baseSymbol ?? 'BNB');

      return {
        reserve0: r0, reserve1: r1, token0: t0, token1: t1,
        token0Symbol: actual0Symbol,
        token1Symbol: actual1Symbol,
        pairAddress: pairAddr, fetchedAt: Date.now(),
      };
    } catch {
      return fallback;
    }
  }

  async getCurrentPrice(pair: string): Promise<number> {
    try {
      const reserves = await this.getPoolReserves(pair);
      // Use reserves.token0Symbol/token1Symbol (on-chain sorted order) not pair string order
      // because PancakeSwap sorts tokens by address when creating pairs.
      const r0 = Number(ethers.formatUnits(reserves.reserve0, getTokenDecimals(reserves.token0Symbol)));
      const r1 = Number(ethers.formatUnits(reserves.reserve1, getTokenDecimals(reserves.token1Symbol)));
      if (r0 === 0) return 0;

      // r1/r0 gives "token1 per token0". We need "quote per base" (e.g. USDT per BNB).
      // If token0 is the base (BNB) and token1 is the quote (USDT), price = r1/r0.
      // If the on-chain order is reversed (USDT=token0, BNB=token1), price = r0/r1.
      const [baseSymbol] = pair.split('/');
      const baseIsToken0 = reserves.token0Symbol === (baseSymbol ?? 'BNB');
      return baseIsToken0 ? r1 / r0 : r0 / r1;
    } catch {
      return 0;
    }
  }

  async getBlockNumber(): Promise<number> {
    try {
      return await this.requireProvider().getBlockNumber();
    } catch (e) {
      logger.warn('getBlockNumber failed — triggering RPC failover', { error: String(e) });
      const ok = await this.failoverRPC();
      if (!ok) throw new EngineError('All RPC endpoints exhausted during getBlockNumber');
      return this.requireProvider().getBlockNumber();
    }
  }

  /**
   * Returns the USD value of the wallet's on-chain balance of a named token.
   * Used by ExecutionService.getBaseTokenBalance() to cap sell sizes.
   */
  async getBaseTokenBalanceUsd(tokenSymbol: string, walletAddress: string): Promise<number> {
    try {
      const cfg     = this.config.get();
      const network = cfg.network.mode === 'mainnet' ? 'mainnet' : 'testnet';
      const tokens  = TOKEN_ADDRESSES[network] ?? TOKEN_ADDRESSES['testnet']!;
      const wbnb    = tokens['WBNB'] ?? ethers.ZeroAddress;
      const tokenAddr = tokens[tokenSymbol];
      if (!tokenAddr) return 0;

      const balWei = await this.getERC20Balance(tokenAddr, walletAddress);
      if (balWei === 0n) return 0;

      const dec      = getTokenDecimals(tokenSymbol);
      const tokenAmt = Number(ethers.formatUnits(balWei, dec));

      const v2Factory       = PANCAKE_V2_FACTORY[network] ?? PANCAKE_V2_FACTORY['testnet']!;
      const tokenPriceInBnb = await this.getTokenPriceInBnb(tokenAddr, wbnb, this.requireProvider(), v2Factory);
      return tokenAmt * tokenPriceInBnb * this.bnbPriceUsd;
    } catch {
      return 0;
    }
  }

  // ─── ERC-20 balance helpers ─────────────────────────────────────────────────

  /**
   * Returns the ERC-20 token balance of walletAddress in token-native units (wei).
   * Returns 0n on any failure so callers can gracefully handle missing tokens.
   */
  async getERC20Balance(tokenAddress: string, walletAddress: string): Promise<bigint> {
    try {
      const provider = this.requireProvider();
      const erc20    = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      return await erc20.getFunction('balanceOf')(walletAddress) as bigint;
    } catch {
      return 0n;
    }
  }

  /**
   * Returns the full portfolio USD value including:
   *  - Native BNB balance (always included)
   *  - ERC-20 token balances for each configured trading pair's base token
   *
   * This prevents the circuit breaker from triggering prematurely after a buy
   * converts BNB → token (which would otherwise make the BNB balance appear to shrink).
   */
  async getPortfolioValue(walletAddress?: string): Promise<number> {
    try {
      const address = walletAddress ?? this.wallet?.address;
      if (!address) return 0;

      // Short-lived cache (5s) to prevent 13+ RPC calls per signal invocation.
      // Cache is valid even when value=0 (empty wallet) to avoid constant RPC polling.
      const now = Date.now();
      if (now < this.portfolioCache.expiresAt) {
        return this.portfolioCache.value;
      }

      const cfg     = this.config.get();
      const network = cfg.network.mode === 'mainnet' ? 'mainnet' : 'testnet';
      const tokens  = TOKEN_ADDRESSES[network] ?? TOKEN_ADDRESSES['testnet']!;
      const wbnb    = tokens['WBNB'] ?? ethers.ZeroAddress;

      // Native BNB balance
      const balanceWei = await this.requireProvider().getBalance(address);
      let totalUsd     = Number(ethers.formatUnits(balanceWei, 18)) * this.bnbPriceUsd;

      // ERC-20 token balances for each configured pair
      for (const pair of cfg.tradingPairs) {
        const [baseSymbol] = pair.split('/');
        const tokenAddr    = tokens[baseSymbol ?? ''];
        if (!tokenAddr || tokenAddr.toLowerCase() === wbnb.toLowerCase()) continue;

        const tokenBalWei = await this.getERC20Balance(tokenAddr, address);
        if (tokenBalWei === 0n) continue;

        const tokenPriceInBnb = await this.getTokenPriceInBnb(tokenAddr, wbnb, this.requireProvider(),
          PANCAKE_V2_FACTORY[network] ?? PANCAKE_V2_FACTORY['testnet']!);
        if (tokenPriceInBnb > 0) {
          const dec      = getTokenDecimals(baseSymbol ?? '');
          const tokenAmt = Number(ethers.formatUnits(tokenBalWei, dec));
          totalUsd      += tokenAmt * tokenPriceInBnb * this.bnbPriceUsd;
        }
      }

      this.portfolioCache = { value: totalUsd, expiresAt: now + 5_000 };
      return totalUsd;
    } catch {
      return 0;
    }
  }

  /** Invalidate portfolio cache — call after a swap so next read reflects the change */
  invalidatePortfolioCache(): void {
    this.portfolioCache = { value: 0, expiresAt: 0 };
  }

  async failoverRPC(): Promise<boolean> {
    const cfg       = this.config.get();
    const endpoints = cfg.network.rpcEndpoints;
    let backoffMs   = cfg.network.rpcBackoffBase * 1000;
    const from      = endpoints[this.currentRpcIndex] ?? 'unknown';

    // Start from the next index after current. When all endpoints are exhausted,
    // wrap around from index 0 so the agent can recover if a previously-failed
    // RPC comes back up on the next call. Without wrapping, currentRpcIndex stays
    // past the end of the array and no endpoint is ever tried again.
    const startFrom = this.currentRpcIndex + 1;
    const candidateIndices: number[] = [];
    for (let i = startFrom; i < endpoints.length; i++) candidateIndices.push(i);
    // Wrap: also try indices 0..currentRpcIndex-1 so recovery is possible
    for (let i = 0; i < this.currentRpcIndex; i++) candidateIndices.push(i);

    for (const i of candidateIndices) {
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, cfg.network.rpcBackoffMax * 1000);
      const endpoint = endpoints[i];
      if (endpoint === undefined) continue;
      try {
        const candidate   = new ethers.JsonRpcProvider(endpoint);
        const blockNumber = await candidate.getBlockNumber();
        this.provider         = candidate;
        // Re-connect wallet to the new provider so subsequent signs use it
        if (this.wallet) this.wallet = this.wallet.connect(candidate);
        this.currentRpcIndex = i;
        this.bus.emit('engine:rpc_failover', { from, to: endpoint, blockNumber });
        logger.info('RPC failover successful', { from, to: endpoint, blockNumber });
        return true;
      } catch (e) {
        logger.warn('RPC failover attempt failed', { endpoint, error: String(e) });
      }
    }

    this.bus.emit('health:critical', { component: 'TradingEngine', message: 'All RPC endpoints exhausted', timestamp: Date.now() });
    return false;
  }

  stop(): void {
    if (this.provider !== null) { this.provider.destroy(); this.provider = null; }
    // Null wallet so stale provider reference cannot be used after stop()
    this.wallet = null;
  }

  getWallet(): ethers.Wallet | null { return this.wallet; }

  private requireProvider(): ethers.JsonRpcProvider {
    if (this.provider === null) throw new EngineError('TradingEngine not initialized. Call initialize() first.');
    return this.provider;
  }
}
