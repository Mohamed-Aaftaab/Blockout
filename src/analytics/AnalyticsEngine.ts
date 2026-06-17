import * as fs from 'fs';
import * as path from 'path';
import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type {
  TradeRecord, PerformanceMetrics, PairMetrics,
  VenueMetrics, StrategyMetrics, Venue,
} from '../types/index';

const logger = makeLogger();

export class AnalyticsEngine {
  private readonly config:   ConfigurationService;
  private readonly bus:      EventBus;

  private tradeRecords: TradeRecord[] = [];
  private latencies:    number[]      = [];
  private metricsInterval: NodeJS.Timeout | null = null;
  private latencyInterval: NodeJS.Timeout | null = null;

  // stateManager parameter kept for API compatibility but not used internally
  // analytics persists via its own file write (analyticsFilePath config)
  constructor(_stateManager: unknown, config: ConfigurationService, bus: EventBus) {
    this.config   = config;
    this.bus      = bus;
  }

  start(): void {
    const cfg = this.config.get();
    this.metricsInterval = setInterval(() => {
      const metrics = this.getMetrics();
      this.bus.emit('analytics:metrics_updated', metrics);
      void this.persistMetrics(metrics);
    }, cfg.metricsCalcSec * 1000);

    this.latencyInterval = setInterval(() => {
      const p95 = this.calcP95([...this.latencies]);
      const avg = this.latencies.length > 0
        ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
        : 0;
      logger.info('Latency stats', { avgMs: avg.toFixed(1), p95Ms: p95.toFixed(1), samples: this.latencies.length });
    }, 3600 * 1000);
  }

  stop(): void {
    if (this.metricsInterval !== null) { clearInterval(this.metricsInterval); this.metricsInterval = null; }
    if (this.latencyInterval !== null) { clearInterval(this.latencyInterval); this.latencyInterval = null; }
  }

  recordTrade(record: TradeRecord): void {
    this.tradeRecords.push(record);
    this.latencies.push(record.signalToTxMs);

    const tx = record.transactions[0];
    logger.info('Trade recorded', {
      id:         record.id,
      pair:       record.position.pair,
      side:       record.position.side,
      entry:      record.position.entryPrice,
      exit:       record.closePrice,
      pnlUsd:     record.pnlUsd.toFixed(2),
      pnlPct:     record.pnlPct.toFixed(2),
      latencyMs:  record.signalToTxMs,
      strategy:   record.position.strategy,
      venue:      record.position.venue,
      exitReason: record.exitReason,
      gasPrice:   tx?.gasPrice ?? 0,
    });

    this.bus.emit('analytics:trade_recorded', record);
  }

  calculateSharpe(returns: number[]): number {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return 0;
    const riskFreeDaily = 0.05 / 365;
    return ((mean - riskFreeDaily) / stdDev) * Math.sqrt(365);
  }

  getMetrics(): PerformanceMetrics {
    const trades = this.tradeRecords;
    const totalPnlUsd  = trades.reduce((s, t) => s + t.pnlUsd, 0);
    const winning      = trades.filter(t => t.pnlUsd > 0);
    const winRate      = trades.length > 0 ? winning.length / trades.length : 0;
    const avgPnlUsd    = trades.length > 0 ? totalPnlUsd / trades.length : 0;
    // totalPnlPct = sum of all individual trade pnlPct (compound effect approximation)
    const totalPnlPct  = trades.reduce((s, t) => s + t.pnlPct, 0);

    // Daily returns (group by day)
    const dailyMap = new Map<string, number>();
    for (const t of trades) {
      const day = new Date(t.closedAt).toISOString().slice(0, 10);
      dailyMap.set(day, (dailyMap.get(day) ?? 0) + t.pnlPct);
    }
    const dailyReturns = [...dailyMap.values()].slice(-30);
    const sharpeRatio  = this.calculateSharpe(dailyReturns);

    // Max drawdown
    let peak = 0, maxDrawdownPct = 0, running = 0;
    for (const t of trades) {
      running += t.pnlUsd;
      if (running > peak) peak = running;
      const dd = peak > 0 ? (peak - running) / peak * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    const allSlippage = trades.flatMap(t => t.transactions.map(tx => tx.actualSlippage ?? 0));
    const avgSlippagePct = allSlippage.length > 0
      ? allSlippage.reduce((a, b) => a + b, 0) / allSlippage.length
      : 0;

    const lats = [...this.latencies];
    const latencyAvgMs    = lats.length > 0 ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
    const sorted          = [...lats].sort((a, b) => a - b);
    const mid             = Math.floor(sorted.length / 2);
    const latencyMedianMs = sorted.length > 0 ? (sorted[mid] ?? 0) : 0;
    const latencyP95Ms    = this.calcP95(lats);

    const byPair:     Record<string, PairMetrics>     = {};
    const byVenue:    Record<string, VenueMetrics>    = {};
    const byStrategy: Record<string, StrategyMetrics> = {};

    for (const t of trades) {
      const p = t.position.pair;
      if (!byPair[p]) byPair[p] = { pair: p, totalTrades: 0, winRate: 0, pnlUsd: 0 };
      byPair[p]!.totalTrades++;
      byPair[p]!.pnlUsd += t.pnlUsd;

      const v = t.position.venue;
      if (!byVenue[v]) byVenue[v] = { venue: v as Venue, totalTrades: 0, avgSlippagePct: 0, pnlUsd: 0 };
      byVenue[v]!.totalTrades++;
      byVenue[v]!.pnlUsd += t.pnlUsd;

      const s = t.position.strategy;
      if (!byStrategy[s]) byStrategy[s] = { strategy: s, totalTrades: 0, winRate: 0, pnlUsd: 0, weight: 0 };
      byStrategy[s]!.totalTrades++;
      byStrategy[s]!.pnlUsd += t.pnlUsd;
    }

    // Compute per-pair win rates
    for (const [pair, m] of Object.entries(byPair)) {
      const pairWins = trades.filter(t => t.position.pair === pair && t.pnlUsd > 0).length;
      m.winRate = m.totalTrades > 0 ? pairWins / m.totalTrades : 0;
    }

    return {
      totalPnlUsd, totalPnlPct, dailyReturns, sharpeRatio, maxDrawdownPct,
      totalTrades: trades.length, winningTrades: winning.length, winRate, avgPnlUsd,
      avgSlippagePct, recentSlippage: allSlippage.slice(-100),
      latencyAvgMs, latencyMedianMs, latencyP95Ms,
      byPair, byVenue, byStrategy,
      calculatedAt: Date.now(),
    };
  }

  generateReport(type: 'shutdown' | 'backtest' | 'demo'): string {
    const m = this.getMetrics();
    return [
      `=== BLOCKOUT — ${type.toUpperCase()} REPORT ===`,
      `Generated: ${new Date().toISOString()}`,
      `Total Trades:    ${m.totalTrades}`,
      `Win Rate:        ${(m.winRate * 100).toFixed(1)}%`,
      `Total PnL:       $${m.totalPnlUsd.toFixed(2)}`,
      `Sharpe Ratio:    ${m.sharpeRatio.toFixed(2)}`,
      `Max Drawdown:    ${m.maxDrawdownPct.toFixed(1)}%`,
      `Avg Slippage:    ${m.avgSlippagePct.toFixed(3)}%`,
      `Latency P95:     ${m.latencyP95Ms.toFixed(0)}ms`,
      `Open Positions:  ${Object.keys(m.byPair).length} pairs`,
    ].join('\n');
  }

  private calcP95(latencies: number[]): number {
    if (latencies.length === 0) return 0;
    const sorted = [...latencies].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[idx] ?? sorted[sorted.length - 1] ?? 0;
  }

  private async persistMetrics(metrics: PerformanceMetrics): Promise<void> {
    try {
      const cfg = this.config.get();
      const dir = path.dirname(cfg.analyticsFilePath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(cfg.analyticsFilePath, JSON.stringify(metrics, null, 2), 'utf8');
    } catch (e) {
      logger.warn('Failed to persist metrics', { error: String(e) });
    }
  }
}
