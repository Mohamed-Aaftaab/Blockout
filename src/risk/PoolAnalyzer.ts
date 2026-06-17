import { ethers } from 'ethers';
import { createLogger, transports, format } from 'winston';
import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type { PoolHealth }           from '../types/index';
import type { TradingEngine }        from '../execution/TradingEngine';

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

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
    const reserve0Num = Number(ethers.formatUnits(reserves.reserve0, 18));
    const reserve1Num = Number(ethers.formatUnits(reserves.reserve1, 6));
    const totalReserveUsd = reserve0Num + reserve1Num;

    // For demo/testnet: derive plausible 24h volume and tx count from reserves
    const volume24h    = totalReserveUsd * 0.05;  // ~5% turnover
    const txCount24h   = Math.floor(totalReserveUsd / 1000);
    const reserveDrainPct = 0;  // No history available yet — 0 means healthy

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
