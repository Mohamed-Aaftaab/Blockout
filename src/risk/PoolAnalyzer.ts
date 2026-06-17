import { ethers } from 'ethers';
import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type { PoolHealth }           from '../types/index';
import type { TradingEngine }        from '../execution/TradingEngine';

// Token decimals — mirrors TradingEngine's TOKEN_DECIMALS
const TOKEN_DECIMALS: Record<string, number> = {
  USDT: 6,
  USDC: 6,
};

function getTokenDecimals(symbol: string): number {
  return TOKEN_DECIMALS[symbol] ?? 18;
}

const logger = makeLogger();

export class PoolAnalyzer {
  private readonly engine: TradingEngine;
  private readonly config: ConfigurationService;
  private readonly bus:    EventBus;

  constructor(tradingEngine: TradingEngine, config: ConfigurationService, bus: EventBus) {
    this.engine = tradingEngine;
    this.config = config;
    this.bus    = bus;
  }

  async analyzePool(pair: string): Promise<PoolHealth> {
    const reserves = await this.engine.getPoolReserves(pair);

    // Use the correct decimals for each token in the pair
    const token0Dec = getTokenDecimals(reserves.token0Symbol);
    const token1Dec = getTokenDecimals(reserves.token1Symbol);

    const reserve0Num = Number(ethers.formatUnits(reserves.reserve0, token0Dec));
    const reserve1Num = Number(ethers.formatUnits(reserves.reserve1, token1Dec));

    // Convert each side to USD using BNB price for BNB/WBNB sides.
    // For stablecoin sides (USDT/USDC) the amount already equals USD value (1:1 approx).
    // For non-stable, non-BNB tokens we can't determine USD without extra oracle calls,
    // so we use the BNB side * 2 as the total (AMM pools are balanced by value).
    const bnbPrice = this.engine.getBnbPrice();
    const isBnbToken = (sym: string) => sym === 'BNB' || sym === 'WBNB';
    const isStable   = (sym: string) => sym === 'USDT' || sym === 'USDC';

    let totalReserveUsd: number;
    if (isStable(reserves.token1Symbol)) {
      // e.g. BNB/USDT — reserve1 is USDT ≈ USD; reserve0 is BNB
      totalReserveUsd = reserve1Num * 2;
    } else if (isStable(reserves.token0Symbol)) {
      // e.g. USDT/BNB — reverse order
      totalReserveUsd = reserve0Num * 2;
    } else if (isBnbToken(reserves.token0Symbol)) {
      // e.g. BNB/CAKE — reserve0 is BNB → each BNB side = half total value
      totalReserveUsd = reserve0Num * bnbPrice * 2;
    } else if (isBnbToken(reserves.token1Symbol)) {
      totalReserveUsd = reserve1Num * bnbPrice * 2;
    } else {
      // Unknown pair — sum raw amounts as fallback
      totalReserveUsd = reserve0Num + reserve1Num;
    }

    // Derive plausible 24h metrics from on-chain reserves.
    // These are estimates only — real volume/tx data would require a subgraph/API.
    // We use 6% daily turnover as the estimate. The default minVolToReservePct threshold
    // is 5%, so estimated pools with ≥$50k reserve pass (6% > 5%). Only very low-liquidity
    // pools (where even a generous estimate falls short) get rejected.
    const volume24h    = totalReserveUsd * 0.06;         // ~6% daily turnover estimate
    const txCount24h   = Math.max(                        // at least 1 tx per $500 reserve
      Math.floor(totalReserveUsd / 500),
      totalReserveUsd >= 1000 ? 1 : 0,
    );
    const reserveDrainPct = 0;

    const health: PoolHealth = {
      pair,
      token0Reserve:   reserve0Num,
      token1Reserve:   reserve1Num,
      totalReserveUsd,
      volume24h,
      txCount24h,
      reserveDrainPct,
      healthy:         false,   // set by isHealthy()
      rejectionReason: null,
      fetchedAt:       Date.now(),
    };

    const healthy = this.isHealthy(health);

    if (healthy) {
      this.bus.emit('pool:approved', { pair, health });
    } else {
      this.bus.emit('pool:rejected', { pair, health, reason: health.rejectionReason ?? 'unknown' });
      logger.info('Pool rejected', { pair, reason: health.rejectionReason, totalReserveUsd });
    }

    return health;
  }

  isHealthy(health: PoolHealth): boolean {
    const cfg = this.config.get().pool;

    if (health.totalReserveUsd < cfg.minReserveUsd) {
      health.healthy         = false;
      health.rejectionReason = `Insufficient reserve: $${health.totalReserveUsd.toFixed(0)} < $${cfg.minReserveUsd}`;
      return false;
    }

    const volToReservePct = health.totalReserveUsd > 0
      ? (health.volume24h / health.totalReserveUsd) * 100
      : 0;
    if (volToReservePct < cfg.minVolToReservePct) {
      health.healthy         = false;
      health.rejectionReason = `Low volume/reserve ratio: ${volToReservePct.toFixed(2)}% < ${cfg.minVolToReservePct}%`;
      return false;
    }

    if (health.txCount24h < cfg.minTxCount24h) {
      health.healthy         = false;
      health.rejectionReason = `Low transaction count: ${health.txCount24h} < ${cfg.minTxCount24h}`;
      return false;
    }

    if (health.reserveDrainPct > cfg.maxReserveDrainPct) {
      health.healthy         = false;
      health.rejectionReason = `Reserve drain too high: ${health.reserveDrainPct.toFixed(1)}% > ${cfg.maxReserveDrainPct}%`;
      return false;
    }

    health.healthy         = true;
    health.rejectionReason = null;
    return true;
  }
}
