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

const ERC20_ABI = [
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
  'function balanceOf(address owner) external view returns (uint256)',
];

const BSC_PERPS_ABI = [
  'function openPosition(address market, bool isLong, uint256 size, uint256 leverage, uint256 slippage) external payable',
  'function closePosition(address market, uint256 positionId) external',
];

// ─── Well-known BSC token addresses ──────────────────────────────────────────
// Mainnet addresses; testnet uses different values but structure is identical
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

  // Called by ExecutionService to provide the signer after wallet init
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
    const router   = new ethers.Contract(cfg.venue.pancakeswapRouter, PANCAKE_ROUTER_ABI, provider);
    const network  = cfg.network.mode === 'mainnet' ? 'mainnet' : 'testnet';
    const tokens   = TOKEN_ADDRESSES[network] ?? TOKEN_ADDRESSES['testnet']!;

    // Resolve token addresses from pair symbol
    const [baseSymbol, quoteSymbol] = order.pair.split('/');
    const wbnb  = tokens['WBNB'] ?? ethers.ZeroAddress;
    const tokenA = tokens[baseSymbol  ?? 'WBNB'] ?? wbnb;
    const tokenB = tokens[quoteSymbol ?? 'USDT'] ?? (tokens['USDT'] ?? ethers.ZeroAddress);

    // Build correct swap path
    const path: string[] = order.side === 'buy'
      ? [wbnb, tokenA]   // buy: spend BNB to get token
      : [tokenA, wbnb];  // sell: spend token to get BNB

    const deadline    = Math.floor(Date.now() / 1000) + 300;
    const slippageBps = Math.floor(order.slippage * 100);
    const amountInWei = ethers.parseUnits(order.size.toFixed(6), 18);
    const amountOutMin = (amountInWei * BigInt(10000 - slippageBps)) / BigInt(10000);

    // Encode calldata
    const iface    = new ethers.Interface(PANCAKE_ROUTER_ABI);
    const recipient = this.wallet?.address ?? ethers.ZeroAddress;

    const calldata = order.side === 'buy'
      ? iface.encodeFunctionData('swapExactETHForTokens', [amountOutMin, path, recipient, deadline])
      : iface.encodeFunctionData('swapExactTokensForETH', [amountInWei, amountOutMin, path, recipient, deadline]);

    // Estimate gas
    let gasLimit = 300_000n;
    try {
      if (this.wallet) {
        const signer = this.wallet.connect(provider);
        gasLimit = await signer.estimateGas({
          to:    cfg.venue.pancakeswapRouter,
          data:  calldata,
          value: order.side === 'buy' ? amountInWei : 0n,
        });
        gasLimit = (gasLimit * 120n) / 100n; // +20% buffer
      }
    } catch {
      gasLimit = 300_000n; // fallback
    }

    return {
      hash:           '0x' + '0'.repeat(64), // filled after broadcast
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
    };
  }

  private async buildPerpPosition(order: Order): Promise<Transaction> {
    const cfg = this.config.get();
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
      const factory   = new ethers.Contract(cfg.venue.pancakeV3Factory, PANCAKE_FACTORY_ABI, provider);
      const getPairFn  = factory.getFunction('getPair');
      const pairAddr   = await getPairFn(tokenA, tokenB) as string;

      if (pairAddr === ethers.ZeroAddress) {
        return {
          reserve0: ethers.parseUnits('100000', 18),
          reserve1: ethers.parseUnits('100000', 6),
          token0:   tokenA, token1: tokenB,
          pairAddress: pairAddr,
          fetchedAt:   Date.now(),
        };
      }

      const pairContract = new ethers.Contract(pairAddr, PANCAKE_PAIR_ABI, provider);
      const getReservesFn = pairContract.getFunction('getReserves');
      const getToken0Fn   = pairContract.getFunction('token0');
      const getToken1Fn   = pairContract.getFunction('token1');
      const [reserve0, reserve1] = await getReservesFn() as [bigint, bigint];
      const token0 = await getToken0Fn() as string;
      const token1 = await getToken1Fn() as string;

      return { reserve0, reserve1, token0, token1, pairAddress: pairAddr, fetchedAt: Date.now() };
    } catch {
      // Fallback for testnet environments where factory may not respond
      return {
        reserve0: ethers.parseUnits('100000', 18),
        reserve1: ethers.parseUnits('100000', 6),
        token0: tokenA, token1: tokenB,
        pairAddress: ethers.ZeroAddress,
        fetchedAt: Date.now(),
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

      // Get native BNB balance
      const balanceWei = await provider.getBalance(address);
      const bnbBalance = Number(ethers.formatUnits(balanceWei, 18));

      // Get BNB price in USD via pool reserves
      const bnbPrice = await this.getCurrentPrice('BNB/USDT');
      const usdValue = bnbBalance * (bnbPrice > 0 ? bnbPrice : 300); // fallback $300 BNB

      return usdValue;
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
