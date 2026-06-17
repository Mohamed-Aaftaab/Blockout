import { RiskManager } from '../risk/RiskManager';
import type { ConfigurationService } from '../config/index';
import type { TradingEngine } from '../execution/TradingEngine';
import type { EventBus } from '../events/EventBus';
import type { Order } from '../types/index';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildRiskManager(overrides: {
  maxPositionPct?: number;
  minPortfolioUsd?: number;
  maxExposurePct?: number;
  portfolioValue?: number;
} = {}) {
  const {
    maxPositionPct  = 5,
    minPortfolioUsd = 100,
    maxExposurePct  = 30,
    portfolioValue  = 1000,
  } = overrides;

  const mockEngine = {
    getPortfolioValue: jest.fn().mockResolvedValue(portfolioValue),
    getCurrentPrice:   jest.fn().mockResolvedValue(300),
  } as unknown as TradingEngine;

  const mockConfig = {
    get: jest.fn().mockReturnValue({
      risk: {
        maxPositionPct,
        minPortfolioUsd,
        maxExposurePct,
        stopLossPct:        5,
        takeProfitPct:      15,
        maxDrawdownPct:     20,
        leverageMultiplier: 1,
      },
      slMonitorMs:    60000,
      drawdownCheckSec: 60,
    }),
  } as unknown as ConfigurationService;

  const mockBus = {
    emit: jest.fn(),
    on:   jest.fn(),
    off:  jest.fn(),
  } as unknown as EventBus;

  return { manager: new RiskManager(mockEngine, mockConfig, mockBus), mockBus };
}

function makeOrder(size: number): Order {
  return {
    id:        'order-1',
    pair:      'BNB/USDT',
    type:      'market',
    side:      'buy',
    size,
    venue:     'pancakeswap',
    slippage:  0.5,
    twap:      null,
    createdAt: Date.now(),
    signalId:  'sig-1',
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RiskManager.calculatePositionSize', () => {
  it('returns ok(50) for portfolio=1000 and maxPositionPct=5', () => {
    const { manager } = buildRiskManager({ maxPositionPct: 5, portfolioValue: 1000 });
    const result = manager.calculatePositionSize(1000, 'BNB/USDT');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(50);
    }
  });

  it('returns err(RiskError) when portfolio=50 is below minPortfolioUsd=100', () => {
    const { manager } = buildRiskManager({ minPortfolioUsd: 100 });
    const result = manager.calculatePositionSize(50, 'BNB/USDT');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe('RiskError');
    }
  });
});

describe('RiskManager circuit breaker', () => {
  it('triggerCircuitBreaker sets circuitBreakerActive', () => {
    const { manager } = buildRiskManager();
    manager.triggerCircuitBreaker('test reason');
    // Access private field via type assertion to verify the state change
    expect((manager as unknown as Record<string, unknown>)['circuitBreakerActive']).toBe(true);
  });

  it('after triggerCircuitBreaker, validateNewPosition returns err', async () => {
    const { manager } = buildRiskManager();
    manager.triggerCircuitBreaker('test');
    const result = await manager.validateNewPosition(makeOrder(100), []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe('RiskError');
    }
  });
});
