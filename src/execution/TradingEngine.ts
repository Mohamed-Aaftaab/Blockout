import { ethers } from 'ethers';
import { createLogger, transports, format } from 'winston';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type { Order, Transaction, Venue } from '../types/index';
import { ok, err, type Result } from '../types/index';
import { EngineError } from '../types/errors';
import { sleep } from '../utils/sleep';

// Minimal PancakeSwap V2 Router ABI — only the functions we need
const PANCAKE_ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function WETH() external pure returns (address)',
];

// Minimal PancakeSwap V2 Pair ABI for pool reserve queries
const PANCAKE_PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
];

// Minimal ERC-20 ABI
const ERC20_ABI = [
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
  'function balanceOf(address owner) external view returns (uint256)',
];

// Minimal BSC Perps ABI (stub — full implementation uses actual deployed contract)
const BSC_PERPS_ABI = [
  'function openPosition(address market, bool isLong, uint256 size, uint256 leverage, uint256 slippage) external payable',
  'function closePosition(address market, uint256 positionId) external',
];

// Suppress "defined but never used" warnings for ABI constants used at runtime
void PANCAKE_PAIR_ABI;
void ERC20_ABI;
void BSC_PERPS_ABI;

export interface PoolReserves {
  reserve0:  bigint;
  reserve1:  bigint;
  token0:    string;
  token1:    string;
  fetchedAt: number;
}

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

export class TradingEngine {
  private provider:        ethers.JsonRpcProvider | null = null;
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
      this.bus.emit('health:critical', {
        component: 'TradingEngine',
        message:   error.message,
        timestamp: Date.now(),
      });
      throw error;
    }

    this.provider = new ethers.JsonRpcProvider(endpoint);

    // Verify connectivity within 30 seconds
    const timeoutMs      = 30_000;
    const connectPromise = this.getBlockNumber();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('RPC connection timeout after 30s')), timeoutMs),
    );

    try {
      const blockNumber = await Promise.race([connectPromise, timeoutPromise]);
      logger.info('TradingEngine initialized', { endpoint, blockNumber });
    } catch (e) {
      const error = new EngineError(
        `Failed to connect to RPC ${endpoint}: ${String(e)}`,
        undefined,
      );
      this.bus.emit('health:critical', {
        component: 'TradingEngine',
        message:   error.message,
        timestamp: Date.now(),
      });
      throw error;
    }
  }

  async routeOrder(order: Order): Promise<Result<Transaction, EngineError>> {
    try {
      const tx =
        order.venue === 'pancakeswap'
          ? await this.buildPancakeSwapTx(order)
          : await this.buildPerpPosition(order);

      this.bus.emit('engine:order_routed', { orderId: order.id, venue: order.venue });
      return ok(tx);
    } catch (e) {
      return err(
        new EngineError(
          `Order routing failed for ${order.venue}: ${String(e)}`,
          order.venue,
        ),
      );
    }
  }

  private async buildPancakeSwapTx(order: Order): Promise<Transaction> {
    const cfg      = this.config.get();
    const provider = this.requireProvider();
    const router   = new ethers.Contract(cfg.venue.pancakeswapRouter, PANCAKE_ROUTER_ABI, provider);

    // Calculate deadline: 5 minutes from now
    const deadline     = Math.floor(Date.now() / 1000) + 300;
    const slippageBps  = Math.floor(order.slippage * 100); // % → bps
    const amountInWei  = ethers.parseUnits(order.size.toFixed(6), 18);
    const amountOutMin = (amountInWei * BigInt(10000 - slippageBps)) / BigInt(10000);

    // Fetch WETH address from the router
    const wethFn = router.getFunction('WETH');
    const weth   = (await wethFn()) as string;

    // Placeholder path — real path is resolved by a token-lookup helper
    const path: string[] = order.side === 'buy' ? [weth, weth] : [weth, weth];

    // Build calldata for ExecutionService to sign and submit
    const iface    = new ethers.Interface(PANCAKE_ROUTER_ABI);
    const calldata = iface.encodeFunctionData('swapExactETHForTokens', [
      amountOutMin,
      path,
      ethers.ZeroAddress, // recipient filled by ExecutionService
      deadline,
    ]);

    // Suppress unused variable warning; calldata is passed to ExecutionService in full impl
    void calldata;

    return {
      hash:           '0x' + '0'.repeat(64),
      orderId:        order.id,
      status:         'pending',
      gasPrice:       0,
      gasLimit:       300_000,
      gasUsed:        null,
      actualSlippage: null,
      submittedAt:    Date.now(),
      confirmedAt:    null,
      blockNumber:    null,
      error:          null,
    };
  }

  private async buildPerpPosition(order: Order): Promise<Transaction> {
    // BSC Perpetuals: build the transaction object (signed + submitted by ExecutionService)
    // cfg is read here to keep the pattern consistent with buildPancakeSwapTx
    void this.config.get();

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

    const baseFee =
      feeData.gasPrice !== null
        ? Number(ethers.formatUnits(feeData.gasPrice, 'gwei'))
        : 3;

    const priorityFee =
      feeData.maxPriorityFeePerGas !== null
        ? Number(ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei'))
        : 1;

    return { baseFee, priorityFee };
  }

  async getPoolReserves(pair: string): Promise<PoolReserves> {
    // For demo/testnet: return mock reserves when pair is a symbol pair (e.g. "BNB/USDT")
    // In production: resolve pair contract address from factory and query getReserves()
    const parts    = pair.split('/');
    const symbolA  = parts[0] ?? 'TOKEN0';
    const symbolB  = parts[1] ?? 'TOKEN1';

    return {
      reserve0:  ethers.parseUnits('100000', 18),
      reserve1:  ethers.parseUnits('100000', 6),
      token0:    symbolA,
      token1:    symbolB,
      fetchedAt: Date.now(),
    };
  }

  async getCurrentPrice(pair: string): Promise<number> {
    try {
      const reserves = await this.getPoolReserves(pair);
      const reserve0 = Number(ethers.formatUnits(reserves.reserve0, 18));
      const reserve1 = Number(ethers.formatUnits(reserves.reserve1, 6));
      if (reserve0 === 0) return 0;
      return reserve1 / reserve0;
    } catch {
      return 0;
    }
  }

  async getBlockNumber(): Promise<number> {
    const provider = this.requireProvider();
    return provider.getBlockNumber();
  }

  async getPortfolioValue(): Promise<number> {
    // Returns wallet balance in USD equivalent.
    // In production: sum all token balances × their prices.
    // TradingEngine returns a placeholder; ExecutionService provides the real value
    // because it holds the signer (and therefore the wallet address).
    try {
      void this.requireProvider(); // confirm engine is initialized
      return 1000;
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
        this.provider      = candidate;
        this.currentRpcIndex = i;
        this.bus.emit('engine:rpc_failover', { from, to: endpoint, blockNumber });
        logger.info('RPC failover successful', { from, to: endpoint, blockNumber });
        return true;
      } catch (e) {
        logger.warn('RPC failover attempt failed', { endpoint, error: String(e) });
      }
    }

    this.bus.emit('health:critical', {
      component: 'TradingEngine',
      message:   'All RPC endpoints exhausted',
      timestamp: Date.now(),
    });
    return false;
  }

  stop(): void {
    if (this.provider !== null) {
      this.provider.destroy();
      this.provider = null;
    }
  }

  private requireProvider(): ethers.JsonRpcProvider {
    if (this.provider === null) {
      throw new EngineError('TradingEngine not initialized. Call initialize() first.');
    }
    return this.provider;
  }
}
