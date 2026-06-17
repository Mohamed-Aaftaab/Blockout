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
  'function WETH() external pure returns (address)',
];

const PANCAKE_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];

const PANCAKE_PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
];

// ─── Well-known BSC token addresses ──────────────────────────────────────────
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

export interface PoolReserves {
  reserve0:    bigint;
  reserve1:    bigint;
  token0:      string;
  token1:      string;
  pairAddress: string;
  fetchedAt:   number;
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

    const timeoutMs      = 30_000;
    const connectPromise = this.getBlockNumber();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('RPC connection timeout after 30s')), timeoutMs),
    );

    try {
      const blockNumber = await Promise.race([connectPromise, timeoutPromise]);
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

  async routeOrder(order: Order): Promise<Result<Transaction, EngineError>> {
    try {
      const tx = order.venue === 'pancakeswap'
        ? await this.buildPancakeSwapTx(order)
        : await this.buildPerpPosition(order);

      this.bus.emit('engine:order_routed', { orderId: order.id, venue: order.venue });
      return ok(tx);
    } catch (e) {
      return err(new EngineError(`Order routing failed for ${order.venue}: ${String(e)}`, order.venue));
    }
  }

  private async buildPancakeSwapTx(order: Order): Promise<Transaction> {
    const cfg      = this.config.get();
    const provider = this.requireProvider();
    const network  = cfg.network.mode === 'mainnet' ? 'mainnet' : 'testnet';
    const tokens   = TOKEN_ADDRESSES[network] ?? TOKEN_ADDRESSES['testnet']!;

    // Resolve token addresses correctly from pair
    // For BNB/USDT: baseSymbol=BNB, quoteSymbol=USDT
    // Buy BNB/USDT means: spend USDT (quote), receive BNB (base)
    // But on DEX with WBNB: buy side = spend WBNB to get the other token, OR buy = receive base
    // Standard interpretation: buy BNB/USDT = you want BNB, you pay USDT
    // Path for buy: [WBNB, quoteToken] — spend wrapped BNB to get quote token
    // Wait — actually "BNB/USDT buy" in trading means: buy BNB with USDT
    // On PancakeSwap: swapExactTokensForETH path = [USDT, WBNB] to get BNB
    //                 swapExactETHForTokens path = [WBNB, CAKE] to buy CAKE with BNB
    // For pair BNB/USDT buy: you're buying the BASE (BNB) with your USDT
    // path = [USDT, WBNB] — use swapExactTokensForETH

    const [baseSymbol, quoteSymbol] = order.pair.split('/');
    const wbnb       = tokens['WBNB'] ?? ethers.ZeroAddress;
    const baseToken  = tokens[baseSymbol  ?? 'BNB']  ?? wbnb;
    const quoteToken = tokens[quoteSymbol ?? 'USDT'] ?? (tokens['USDT'] ?? ethers.ZeroAddress);

    // buy = acquire base token by spending quote token
    // sell = sell base token to receive quote token
    // If base is BNB (WBNB): buy uses swapExactTokensForETH [quoteToken, WBNB]
    //                         sell uses swapExactETHForTokens [WBNB, quoteToken]
    const baseIsNative = baseToken.toLowerCase() === wbnb.toLowerCase();

    const deadline    = Math.floor(Date.now() / 1000) + 300;
    const slippageBps = Math.floor(order.slippage * 100);
    const amountWei   = ethers.parseUnits(order.size.toFixed(6), 18);
    const amountMin   = (amountWei * BigInt(10000 - slippageBps)) / BigInt(10000);

    const iface     = new ethers.Interface(PANCAKE_ROUTER_ABI);
    const recipient  = this.wallet?.address ?? ethers.ZeroAddress;

    let calldata: string;
    let value: bigint;
    let path: string[];

    if (order.side === 'buy') {
      if (baseIsNative) {
        // Buying BNB with USDT: swapExactTokensForETH([USDT, WBNB], amountIn, amountOutMin)
        path     = [quoteToken, wbnb];
        calldata = iface.encodeFunctionData('swapExactTokensForETH', [amountWei, amountMin, path, recipient, deadline]);
        value    = 0n; // paying with ERC-20, no ETH value
      } else {
        // Buying CAKE with BNB: swapExactETHForTokens([WBNB, CAKE], amountOutMin)
        path     = [wbnb, baseToken];
        calldata = iface.encodeFunctionData('swapExactETHForTokens', [amountMin, path, recipient, deadline]);
        value    = amountWei; // paying with BNB
      }
    } else {
      if (baseIsNative) {
        // Selling BNB for USDT: swapExactETHForTokens([WBNB, USDT], amountOutMin)
        path     = [wbnb, quoteToken];
        calldata = iface.encodeFunctionData('swapExactETHForTokens', [amountMin, path, recipient, deadline]);
        value    = amountWei; // selling BNB
      } else {
        // Selling CAKE for BNB: swapExactTokensForETH([CAKE, WBNB], amountIn, amountOutMin)
        path     = [baseToken, wbnb];
        calldata = iface.encodeFunctionData('swapExactTokensForETH', [amountWei, amountMin, path, recipient, deadline]);
        value    = 0n;
      }
    }

    // Estimate gas with the real calldata
    let gasLimit = 300_000n;
    try {
      if (this.wallet) {
        const signer = this.wallet.connect(provider);
        gasLimit = await signer.estimateGas({
          to:   cfg.venue.pancakeswapRouter,
          data: calldata,
          value,
        });
        gasLimit = (gasLimit * 120n) / 100n; // +20% buffer
      }
    } catch {
      gasLimit = 300_000n;
    }

    logger.info('PancakeSwap tx built', {
      pair:     order.pair,
      side:     order.side,
      path,
      amountWei: amountWei.toString(),
      gasLimit:  gasLimit.toString(),
    });

    return {
      hash:           '0x' + '0'.repeat(64),
      orderId:        order.id,
      status:         'pending',
      gasPrice:       0,
      gasLimit:       Number(gasLimit),
      gasUsed:        null,
      actualSlippage: null,
      submittedAt:    Date.now(),
      confirmedAt:    null,
      blockNumber:    null,
      error:          null,
      calldata,
      value,
      to:             cfg.venue.pancakeswapRouter,
    };
  }

  private async buildPerpPosition(order: Order): Promise<Transaction> {
    const cfg = this.config.get();
    // BSC Perps: open a leveraged long or short position
    const isLong       = order.side === 'buy';
    const sizeWei      = ethers.parseUnits(order.size.toFixed(6), 18);
    const leverage     = cfg.risk.leverageMultiplier;
    const slippageBps  = Math.floor(order.slippage * 100);

    const iface    = new ethers.Interface([
      'function openPosition(address market, bool isLong, uint256 size, uint256 leverage, uint256 slippage) external payable',
    ]);
    const calldata = iface.encodeFunctionData('openPosition', [
      cfg.venue.bscPerpsContract,
      isLong,
      sizeWei,
      leverage,
      slippageBps,
    ]);

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
    const provider = this.requireProvider();
    const feeData  = await provider.getFeeData();
    const baseFee  = feeData.gasPrice !== null
      ? Number(ethers.formatUnits(feeData.gasPrice, 'gwei'))
      : 3;
    const priorityFee = feeData.maxPriorityFeePerGas !== null
      ? Number(ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei'))
      : 1;
    return { baseFee, priorityFee };
  }

  async getPoolReserves(pair: string): Promise<PoolReserves> {
    const cfg      = this.config.get();
    const provider = this.requireProvider();
    const network  = cfg.network.mode === 'mainnet' ? 'mainnet' : 'testnet';
    const tokens   = TOKEN_ADDRESSES[network] ?? TOKEN_ADDRESSES['testnet']!;

    const [baseSymbol, quoteSymbol] = pair.split('/');
    const tokenA = tokens[baseSymbol  ?? 'WBNB'] ?? (tokens['WBNB'] ?? ethers.ZeroAddress);
    const tokenB = tokens[quoteSymbol ?? 'USDT'] ?? (tokens['USDT'] ?? ethers.ZeroAddress);

    try {
      const factory    = new ethers.Contract(cfg.venue.pancakeV3Factory, PANCAKE_FACTORY_ABI, provider);
      const getPairFn  = factory.getFunction('getPair');
      const pairAddr   = await getPairFn(tokenA, tokenB) as string;

      if (pairAddr === ethers.ZeroAddress) {
        return {
          reserve0: ethers.parseUnits('100000', 18),
          reserve1: ethers.parseUnits('100000', 6),
          token0: tokenA, token1: tokenB,
          pairAddress: pairAddr, fetchedAt: Date.now(),
        };
      }

      const pairContract  = new ethers.Contract(pairAddr, PANCAKE_PAIR_ABI, provider);
      const getReservesFn = pairContract.getFunction('getReserves');
      const getToken0Fn   = pairContract.getFunction('token0');
      const getToken1Fn   = pairContract.getFunction('token1');
      const [reserve0, reserve1] = await getReservesFn() as [bigint, bigint];
      const token0 = await getToken0Fn() as string;
      const token1 = await getToken1Fn() as string;

      return { reserve0, reserve1, token0, token1, pairAddress: pairAddr, fetchedAt: Date.now() };
    } catch {
      return {
        reserve0: ethers.parseUnits('100000', 18),
        reserve1: ethers.parseUnits('100000', 6),
        token0: tokenA, token1: tokenB,
        pairAddress: ethers.ZeroAddress, fetchedAt: Date.now(),
      };
    }
  }

  async getCurrentPrice(pair: string): Promise<number> {
    try {
      const reserves = await this.getPoolReserves(pair);
      const r0 = Number(ethers.formatUnits(reserves.reserve0, 18));
      const r1 = Number(ethers.formatUnits(reserves.reserve1, 6));
      if (r0 === 0) return 0;
      return r1 / r0;
    } catch {
      return 0;
    }
  }

  async getBlockNumber(): Promise<number> {
    return this.requireProvider().getBlockNumber();
  }

  async getPortfolioValue(walletAddress?: string): Promise<number> {
    try {
      const provider = this.requireProvider();
      const address  = walletAddress ?? this.wallet?.address;
      if (!address) return 0;
      const balanceWei = await provider.getBalance(address);
      const bnbBalance = Number(ethers.formatUnits(balanceWei, 18));
      const bnbPrice   = await this.getCurrentPrice('BNB/USDT');
      return bnbBalance * (bnbPrice > 0 ? bnbPrice : 300);
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
    if (this.provider !== null) {
      this.provider.destroy();
      this.provider = null;
    }
  }

  getWallet(): ethers.Wallet | null { return this.wallet; }

  private requireProvider(): ethers.JsonRpcProvider {
    if (this.provider === null) {
      throw new EngineError('TradingEngine not initialized. Call initialize() first.');
    }
    return this.provider;
  }
}
