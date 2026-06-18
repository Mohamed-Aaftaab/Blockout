import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type { MarketData, MarketRegime } from '../types/index';
import type { MarketDataService }    from './MarketDataService';

const logger = makeLogger();

export class RegimeDetector {
  private readonly marketData:     MarketDataService;
  private readonly config:         ConfigurationService;
  private readonly bus:            EventBus;
  private readonly currentRegimes: Map<string, MarketRegime> = new Map();
  private intervalHandle:          NodeJS.Timeout | null = null;

  constructor(marketData: MarketDataService, config: ConfigurationService, bus: EventBus) {
    this.marketData = marketData;
    this.config     = config;
    this.bus        = bus;
  }

  start(): void {
    const cfg = this.config.get();
    // Periodic re-evaluation so regime stays current even during quiet market periods
    // when no market:data events fire. detectRegime handles map updates and event emission.
    this.intervalHandle = setInterval(() => {
      for (const pair of cfg.tradingPairs) {
        const data = this.marketData.getLatestData(pair);
        if (data === null) continue;
        this.detectRegime(pair, data);
      }
    }, cfg.regime.updateIntervalSec * 1000);
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  getCurrentRegime(pair: string): MarketRegime {
    return this.currentRegimes.get(pair) ?? 'sideways';
  }

  /** Restore regime map from persisted state on restart to avoid the 60s blind window */
  restoreRegimes(regimes: Record<string, MarketRegime>): void {
    for (const [pair, regime] of Object.entries(regimes)) {
      this.currentRegimes.set(pair, regime);
    }
    if (Object.keys(regimes).length > 0) {
      const entries = Object.entries(regimes)
        .map(([p, r]) => `${p}=${r}`)
        .join(', ');
      logger.info('Market regimes restored from persisted state', { regimes: entries });
    }
  }

  /** Snapshot the current regime map for state persistence */
  getRegimes(): Record<string, MarketRegime> {
    const result: Record<string, MarketRegime> = {};
    for (const [pair, regime] of this.currentRegimes) {
      result[pair] = regime;
    }
    return result;
  }

  detectRegime(pair: string, data: MarketData): MarketRegime {
    const cfg = this.config.get().regime;
    const ind = data.indicators;

    // Use candle close prices for MA slope calculation
    const closes = data.candles.map(c => c.close);
    const ma20Slope = this.calcMASlope(closes, cfg.shortMaPeriod);

    let regime: MarketRegime;

    // Sideways: BB width below threshold
    if (ind.bbWidth < cfg.bbWidthThreshold) {
      regime = 'sideways';
    } else if (ind.ma50 === 0) {
      // Guard: if ma50 is 0 (CMC indicators unavailable), we cannot reliably classify
      // bull or bear — fall back to sideways rather than misclassifying based on price > 0.
      regime = 'sideways';
    } else if (ma20Slope > cfg.slopeUpThreshold && data.price > ind.ma50) {
      // Bull: MA20 sloping up and price above MA50
      regime = 'bull';
    } else if (ma20Slope < -cfg.slopeDownThreshold && data.price < ind.ma50) {
      // Bear: MA20 sloping down and price below MA50
      regime = 'bear';
    } else {
      regime = 'sideways';
    }

    // Always update the map so StrategyManager.getCurrentRegime() returns the fresh
    // regime immediately. Previously, the interval in start() only updated on change,
    // leaving StrategyManager up to 300s behind the live detectRegime result.
    const prev = this.currentRegimes.get(pair);
    if (regime !== prev) {
      this.currentRegimes.set(pair, regime);
      if (prev !== undefined) {
        this.bus.emit('regime:changed', {
          pair, from: prev, to: regime, timestamp: Date.now(),
        });
        logger.info('Market regime changed', { pair, from: prev, to: regime });
      } else {
        // First detection — just store, no "changed" event since there was no prior state
        logger.info('Market regime initialized', { pair, regime });
      }
    }

    return regime;
  }

  private calcMASlope(values: number[], period: number): number {
    if (values.length < period + 1) return 0;
    const recent = values.slice(-period);
    // Simple first-difference of MA
    const n = recent.length;
    if (n < 2) return 0;
    const first = recent[0];
    const last  = recent[n - 1];
    if (first === undefined || last === undefined || first === 0) return 0;
    return (last - first) / first / (n - 1);
  }
}
