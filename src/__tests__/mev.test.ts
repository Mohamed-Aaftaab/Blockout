import { MEVDefenseModule } from '../execution/MEVDefenseModule';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type { Order } from '../types/index';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildMEV(overrides: {
  thresholdUsd?: number;
  chunkCount?:   number;
  minChunkPct?:  number;
  maxChunkPct?:  number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
} = {}) {
  const {
    thresholdUsd  = 1000,
    chunkCount    = 5,
    minChunkPct   = 0.7,
    maxChunkPct   = 1.3,
    minIntervalMs = 15000,
    maxIntervalMs = 45000,
  } = overrides;

  const mockConfig = {
    get: jest.fn().mockReturnValue({
      twap: { thresholdUsd, chunkCount, minChunkPct, maxChunkPct, minIntervalMs, maxIntervalMs },
    }),
  } as unknown as ConfigurationService;

  const mockBus = {
    emit: jest.fn(),
    on:   jest.fn(),
    off:  jest.fn(),
  } as unknown as EventBus;

  return new MEVDefenseModule(mockConfig, mockBus);
}

function makeOrder(size: number): Order {
  return {
    id:        'order-1',
    pair:      'BNB/USDT',
    type:      'twap',
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

describe('MEVDefenseModule.shouldSplit', () => {
  it('returns true when order.size=1500 and threshold=1000', () => {
    const mev = buildMEV({ thresholdUsd: 1000 });
    expect(mev.shouldSplit(makeOrder(1500))).toBe(true);
  });

  it('returns false when order.size=500 and threshold=1000', () => {
    const mev = buildMEV({ thresholdUsd: 1000 });
    expect(mev.shouldSplit(makeOrder(500))).toBe(false);
  });
});

describe('MEVDefenseModule.buildTwapPlan', () => {
  const CHUNK_COUNT = 5;

  it('produces exactly chunkCount chunk sizes', () => {
    const mev  = buildMEV({ chunkCount: CHUNK_COUNT });
    const plan = mev.buildTwapPlan(makeOrder(2000));
    expect(plan.chunkSizes).toHaveLength(CHUNK_COUNT);
  });

  it('sum of chunk sizes equals totalSize within 1e-10', () => {
    const mev       = buildMEV({ chunkCount: CHUNK_COUNT });
    const totalSize = 2000;
    const plan      = mev.buildTwapPlan(makeOrder(totalSize));
    const sum       = plan.chunkSizes.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - totalSize)).toBeLessThan(1e-10);
  });

  it('produces exactly chunkCount intervals and last one is 0', () => {
    const mev  = buildMEV({ chunkCount: CHUNK_COUNT });
    const plan = mev.buildTwapPlan(makeOrder(2000));
    expect(plan.intervals).toHaveLength(CHUNK_COUNT);
    expect(plan.intervals[plan.intervals.length - 1]).toBe(0);
  });
});
