import { GasOptimizer } from '../execution/GasOptimizer';
import type { ConfigurationService } from '../config/index';
import type { TradingEngine } from '../execution/TradingEngine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildOptimizer(gasConfig: {
  baseFee:           number;
  priorityFee:       number;
  urgencyMultiplier: number;
  minGasGwei:        number;
  maxGasGwei:        number;
}) {
  const mockEngine = {
    getGasPrice: jest.fn().mockResolvedValue({
      baseFee:     gasConfig.baseFee,
      priorityFee: gasConfig.priorityFee,
    }),
  } as unknown as TradingEngine;

  const mockConfig = {
    get: jest.fn().mockReturnValue({
      gas: {
        urgencyMultiplier: gasConfig.urgencyMultiplier,
        minGasGwei:        gasConfig.minGasGwei,
        maxGasGwei:        gasConfig.maxGasGwei,
        gasBumpPct:        20,
        maxRetries:        3,
      },
    }),
  } as unknown as ConfigurationService;

  return new GasOptimizer(mockEngine, mockConfig);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GasOptimizer.getOptimalGasPrice', () => {
  it('computes (baseFee+priorityFee)*multiplier when within bounds', async () => {
    const optimizer = buildOptimizer({
      baseFee:           5,
      priorityFee:       1,
      urgencyMultiplier: 1.2,
      minGasGwei:        3,
      maxGasGwei:        100,
    });
    const result = await optimizer.getOptimalGasPrice();
    // (5 + 1) * 1.2 = 7.2
    expect(result).toBeCloseTo(7.2, 10);
  });

  it('clamps result to max when raw > maxGasGwei', async () => {
    const optimizer = buildOptimizer({
      baseFee:           60,
      priorityFee:       10,
      urgencyMultiplier: 3.0,
      minGasGwei:        3,
      maxGasGwei:        100,
    });
    // raw = (60+10)*3 = 210 → clamped to 100
    const result = await optimizer.getOptimalGasPrice();
    expect(result).toBe(100);
  });

  it('clamps result to min when raw < minGasGwei', async () => {
    const optimizer = buildOptimizer({
      baseFee:           0.3,
      priorityFee:       0.2,
      urgencyMultiplier: 1.0,
      minGasGwei:        3,
      maxGasGwei:        100,
    });
    // raw = 0.5 → clamped to 3
    const result = await optimizer.getOptimalGasPrice();
    expect(result).toBe(3);
  });

  it('custom urgency overrides config multiplier', async () => {
    const optimizer = buildOptimizer({
      baseFee:           5,
      priorityFee:       1,
      urgencyMultiplier: 1.2, // default, should be ignored
      minGasGwei:        3,
      maxGasGwei:        100,
    });
    // Pass urgency=2.0 explicitly: (5+1)*2.0 = 12
    const result = await optimizer.getOptimalGasPrice(2.0);
    expect(result).toBeCloseTo(12, 10);
  });
});
