import { AnalyticsEngine } from '../analytics/AnalyticsEngine';
import type { ConfigurationService } from '../config/index';
import type { StateManager } from '../state/StateManager';
import type { EventBus } from '../events/EventBus';
import type { TradeRecord, Position, Transaction } from '../types/index';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildAnalytics() {
  const mockStateMgr = {} as StateManager;

  const mockConfig = {
    get: jest.fn().mockReturnValue({
      metricsCalcSec:    300,
      analyticsFilePath: './data/analytics.json',
    }),
  } as unknown as ConfigurationService;

  const mockBus = {
    emit: jest.fn(),
    on:   jest.fn(),
    off:  jest.fn(),
  } as unknown as EventBus;

  return new AnalyticsEngine(mockStateMgr, mockConfig, mockBus);
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id:          'pos-1',
    pair:        'BNB/USDT',
    side:        'buy',
    entryPrice:  300,
    size:        100,
    stopLoss:    285,
    takeProfit:  345,
    leverage:    1,
    strategy:    'momentum',
    venue:       'pancakeswap',
    openedAt:    Date.now() - 60000,
    txHash:      '0x' + '0'.repeat(64),
    ...overrides,
  };
}

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    hash:           '0x' + '0'.repeat(64),
    orderId:        'order-1',
    status:         'confirmed',
    gasPrice:       5,
    gasLimit:       300000,
    gasUsed:        210000,
    actualSlippage: 0.1,
    submittedAt:    Date.now() - 5000,
    confirmedAt:    Date.now(),
    blockNumber:    12345,
    error:          null,
    ...overrides,
  };
}

function makeTradeRecord(pnlUsd: number, pnlPct: number): TradeRecord {
  return {
    id:           'trade-1',
    position:     makePosition(),
    closePrice:   300 + pnlUsd,
    closedAt:     Date.now(),
    exitReason:   'take_profit',
    pnlUsd,
    pnlPct,
    holdMs:       60000,
    transactions: [makeTx()],
    signalToTxMs: 200,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AnalyticsEngine.calculateSharpe', () => {
  let engine: AnalyticsEngine;

  beforeEach(() => {
    engine = buildAnalytics();
  });

  it('returns 0 for empty array', () => {
    expect(engine.calculateSharpe([])).toBe(0);
  });

  it('returns 0 for array with zero variance (all same value)', () => {
    expect(engine.calculateSharpe([5, 5, 5])).toBe(0);
  });

  it('returns a finite number for non-degenerate returns', () => {
    const sharpe = engine.calculateSharpe([1, 2, 3]);
    expect(Number.isFinite(sharpe)).toBe(true);
  });
});

describe('AnalyticsEngine.getMetrics', () => {
  it('winRate equals winningTrades/totalTrades', () => {
    const engine = buildAnalytics();
    engine.recordTrade(makeTradeRecord(50, 5));   // winning
    engine.recordTrade(makeTradeRecord(-30, -3)); // losing
    engine.recordTrade(makeTradeRecord(20, 2));   // winning

    const metrics = engine.getMetrics();
    expect(metrics.totalTrades).toBe(3);
    expect(metrics.winningTrades).toBe(2);
    expect(metrics.winRate).toBeCloseTo(2 / 3, 10);
  });
});

describe('AnalyticsEngine.generateReport', () => {
  it('returns non-empty string for shutdown report', () => {
    const engine = buildAnalytics();
    const report = engine.generateReport('shutdown');
    expect(typeof report).toBe('string');
    expect(report.length).toBeGreaterThan(0);
  });
});
