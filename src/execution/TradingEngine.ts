import { ethers } from 'ethers';
import { createLogger, transports, format } from 'winston';
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

// ERC-20 ABI — needed for approve() before token swaps
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
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

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

export class TradingEngine {
  private provider:        ethers.JsonRpcProvider | null = null;
  private wallet:          ethers.Wallet | null = null;
  private currentRpcIndex: number = 0;
  private readonly config: ConfigurationService;
  private readonly bus:    EventBus;
  /** CMC-sourced BNB price. Updated by MarketDataService. Fallback: $300 */
  private bnbPriceUsd: number = 300;

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

    // Helper: get amountOutMin via getAmountsOut for real slippage protection
    async function getAmountOutMin(amountIn: bigint, swapPath: string[]): Promise<bigint> {
      try {
        const amounts = await router.getFunction('getAmountsOut')(amountIn, swapPath) as bigint[];
        const expectedOut = amounts[amounts.length - 1] ?? 0n;
        // Apply slippage tolerance
        return (expectedOut * BigInt(10000 - slippageBps)) / BigInt(10000);
      } catch {
        return 0n; // fallback if pool data unavailable
      }
    }

    if (order.side === 'buy') {
      if (baseIsNative) {
        // Buying BNB with USDT — spend USDT (ERC-20), receive BNB (native)
        // order.size is USD ≈ USDT amount (1:1 since USDT ≈ $1)
        const usdtDec    = getTokenDecimals(quoteSymbol ?? 'USDT');
        spendAmountWei   = ethers.parseUnits(order.size.toFixed(usdtDec), usdtDec);
        path             = [quoteToken, wbnb];
        const outMin     = await getAmountOutMin(spendAmountWei, path);
        calldata         = iface.encodeFunctionData('swapExactTokensForETH', [spendAmountWei, outMin, path, recipient, deadline]);
        value            = 0n;
        spendToken       = quoteToken;
      } else {
        // Buying CAKE/ETH/BTC with BNB — convert USD→BNB, spend native BNB
        const bnbAmount  = order.size / this.bnbPriceUsd;
        spendAmountWei   = ethers.parseUnits(bnbAmount.toFixed(18).slice(0, 20), 18);
        path             = [wbnb, baseToken];
        const outMin     = await getAmountOutMin(spendAmountWei, path);
        calldata         = iface.encodeFunctionData('swapExactETHForTokens', [outMin, path, recipient, deadline]);
        value            = spendAmountWei;
        spendToken       = null; // native BNB, no approval needed
      }
    } else {
      // sell
      if (baseIsNative) {
        // Selling BNB for USDT — convert USD→BNB, spend native BNB
        const bnbAmount  = order.size / this.bnbPriceUsd;
        spendAmountWei   = ethers.parseUnits(bnbAmount.toFixed(18).slice(0, 20), 18);
        path             = [wbnb, quoteToken];
        const outMin     = await getAmountOutMin(spendAmountWei, path);
        calldata         = iface.encodeFunctionData('swapExactETHForTokens', [outMin, path, recipient, deadline]);
        value            = spendAmountWei;
        spendToken       = null;
      } else {
        // Selling CAKE/ETH/BTC for BNB
        // Convert USD→token using estimated token price from pool
        const baseTokenDecimals  = getTokenDecimals(baseSymbol ?? 'CAKE');
        // Get token price in BNB then USD using V2 pool reserves
        const tokenPriceInBnb = await this.getTokenPriceInBnb(baseToken, quoteToken, wbnb, provider, v2Factory);
        const tokenPriceUsd   = tokenPriceInBnb * this.bnbPriceUsd;
        const tokenAmount     = tokenPriceUsd > 0 ? order.size / tokenPriceUsd : order.size; // fallback: treat as raw token
        spendAmountWei        = ethers.parseUnits(tokenAmount.toFixed(18).slice(0, 20), baseTokenDecimals);
        path                  = [baseToken, wbnb];
        const outMin          = await getAmountOutMin(spendAmountWei, path);
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
    tokenAddress: string,
    quoteAddress:  string,
    wbnb:          string,
    provider:      ethers.JsonRpcProvider,
    factoryAddress:string,
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
      // Both are 18-decimal tokens on BSC (wrapped)
      const tokenAmt = Number(ethers.formatUnits(tokenReserve, 18));
      const bnbAmt   = Number(ethers.formatUnits(bnbReserve, 18));
      return bnbAmt / tokenAmt; // price of 1 token in BNB
    } catch {
      return 0;
    }
  }

  private async buildPerpPosition(order: Order): Promise<Transaction> {
    const cfg      = this.config.get();
    const isLong   = order.side === 'buy';
    const sizeWei  = ethers.parseUnits((order.size / this.bnbPriceUsd).toFixed(18).slice(0, 20), 18);
    const leverage = cfg.risk.leverageMultiplier;
    const slipBps  = Math.floor(order.slippage * 100);
    const iface    = new ethers.Interface([
      'function openPosition(address market, bool isLong, uint256 size, uint256 leverage, uint256 slippage) external payable',
    ]);
    const calldata = iface.encodeFunctionData('openPosition', [cfg.venue.bscPerpsContract, isLong, sizeWei, leverage, slipBps]);
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

    const fallback: PoolReserves = {
      reserve0: ethers.parseUnits('100000', 18),
      reserve1: ethers.parseUnits('100000', 6),
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
      return { reserve0: r0, reserve1: r1, token0: t0, token1: t1, token0Symbol: baseSymbol ?? 'BNB', token1Symbol: quoteSymbol ?? 'USDT', pairAddress: pairAddr, fetchedAt: Date.now() };
    } catch {
      return fallback;
    }
  }

  async getCurrentPrice(pair: string): Promise<number> {
    try {
      const reserves = await this.getPoolReserves(pair);
      const [baseSymbol, quoteSymbol] = pair.split('/');
      const r0 = Number(ethers.formatUnits(reserves.reserve0, getTokenDecimals(baseSymbol  ?? 'BNB')));
      const r1 = Number(ethers.formatUnits(reserves.reserve1, getTokenDecimals(quoteSymbol ?? 'USDT')));
      if (r0 === 0) return 0;
      return r1 / r0;
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

  async getPortfolioValue(walletAddress?: string): Promise<number> {
    try {
      const address = walletAddress ?? this.wallet?.address;
      if (!address) return 0;
      const balanceWei = await this.requireProvider().getBalance(address);
      const bnbBalance = Number(ethers.formatUnits(balanceWei, 18));
      return bnbBalance * this.bnbPriceUsd;
    } catch {
      return 0;
    }
  }

  async failoverRPC(): Promise<boolean> {
    const cfg       = this.config.get();
    const endpoints = cfg.network.rpcEndpoints;
    let backoffMs   = cfg.network.rpcBackoffBase * 1000;
    const from      = endpoints[this.currentRpcIndex] ?? 'unknown';

    for (let i = this.currentRpcIndex + 1; i < endpoints.length; i++) {
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, cfg.network.rpcBackoffMax * 1000);
      const endpoint = endpoints[i];
      if (endpoint === undefined) continue;
      try {
        const candidate  = new ethers.JsonRpcProvider(endpoint);
        const blockNumber = await candidate.getBlockNumber();
        this.provider     = candidate;
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
  }

  getWallet(): ethers.Wallet | null { return this.wallet; }

  private requireProvider(): ethers.JsonRpcProvider {
    if (this.provider === null) throw new EngineError('TradingEngine not initialized. Call initialize() first.');
    return this.provider;
  }
}
