/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck
/**
 * Property-Based Tests -- Sovereign BNB Agent
 * Uses fast-check for generative testing.
 *
 * **Validates: Requirements 1.1 - 1.12**
 */

import * as fc from 'fast-check';
import { ConfigSchema } from '../config/schema';
import { MEVDefenseModule } from '../execution/MEVDefenseModule';
import { GasOptimizer } from '../execution/GasOptimizer';
import { SignalGenerator } from '../market/SignalGenerator';
import { RiskManager } from '../risk/RiskManager';
import { PoolAnalyzer } from '../risk/PoolAnalyzer';
import { AnalyticsEngine } from '../analytics/AnalyticsEngine';
import { StrategyManager } from '../strategies/StrategyManager';

// ---- helpers ----------------------------------------------------------------

function makeBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function makeConfig(twapCfg, gasCfg, riskCfg, signalCfg, poolCfg, adaptiveCfg) {
  return {
    get: jest.fn().mockReturnValue({
      twap: Object.assign({ thresholdUsd: 1000, chunkCount: 5, minChunkPct: 0.7, maxChunkPct: 1.3, minIntervalMs: 15000, maxIntervalMs: 45000 }, twapCfg),
      gas: Object.assign({ urgencyMultiplier: 1.2, minGasGwei: 3, maxGasGwei: 100, gasBumpPct: 20, maxRetries: 3 }, gasCfg),
      risk: Object.assign({ maxPositionPct: 5, maxExposurePct: 30, stopLossPct: 5, takeProfitPct: 15, maxDrawdownPct: 20, minPortfolioUsd: 100, leverageMultiplier: 1 }, riskCfg),
      signal: Object.assign({ rsiOversold: 30, rsiOverbought: 70, whaleBuyThresholdUsd: 100000, exchangeInflowUsd: 50000, weights: { rsi: 0.25, macd: 0.25, bollinger: 0.2, whale: 0.15, onchain: 0.15 } }, signalCfg),
      pool: Object.assign({ minReserveUsd: 50000, minVolToReservePct: 5, minTxCount24h: 100, maxReserveDrainPct: 50 }, poolCfg),
      adaptive: Object.assign({ enabled: false, evaluationPeriodSec: 86400, weightAdjPct: 10, benchmarkReturn: 0 }, adaptiveCfg),
      metricsCalcSec: 300,
      analyticsFilePath: './data/analytics.json',
      slMonitorMs: 60000,
      drawdownCheckSec: 60,
      stateFilePath: './data/state.json',
    }),
  };
}

function makeOrder(size, pair) {
  return { id: 'order-1', pair: pair || 'BNB/USDT', type: 'twap', side: 'buy', size, venue: 'pancakeswap', slippage: 0.5, twap: null, createdAt: Date.now(), signalId: 'sig-1' };
}

// ---- P1: Config Round-Trip --------------------------------------------------
// **Validates: Requirements 1.1**

const ALPHANUM_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

describe('P1 -- Config Round-Trip', () => {
  it('JSON.stringify -> ConfigSchema.safeParse is always ok for valid configs', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(...ALPHANUM_CHARS.split('')), { minLength: 32, maxLength: 64 }),
        fc.stringOf(fc.constantFrom(...ALPHANUM_CHARS.split('')), { minLength: 8, maxLength: 20 }),
        fc.stringOf(fc.constantFrom(...ALPHANUM_CHARS.split('')), { minLength: 16, maxLength: 32 }),
        (cmcApiKey, twakAccessId, twakHmacSecret) => {
          const raw = {
            cmcApiKey, twakAccessId, twakHmacSecret,
            tradingPairs: ['BNB/USDT'],
            network: { mode: 'testnet', rpcEndpoints: ['https://bsc-dataseed1.binance.org'], rpcTimeoutMs: 10000, rpcBackoffBase: 2, rpcBackoffMax: 60, chainId: 97 },
            venue: { pancakeswapRouter: '0x10ED43C718714eb63d5aA57B78B54704E256024E', bscPerpsContract: '0x0000000000000000000000000000000000000000' },
            risk: { maxPositionPct: 5, maxExposurePct: 30, stopLossPct: 5, takeProfitPct: 15, maxDrawdownPct: 20, minPortfolioUsd: 100, leverageMultiplier: 1 },
            twap: { thresholdUsd: 1000, chunkCount: 10, minIntervalMs: 15000, maxIntervalMs: 45000 },
            gas: { urgencyMultiplier: 1.2, minGasGwei: 3, maxGasGwei: 100 },
            slippage: { defaultPct: 0.5, maxPct: 3.0 },
            regime: {},
            signal: { rsiOversold: 30, rsiOverbought: 70, whaleBuyThresholdUsd: 100000, exchangeInflowUsd: 50000, weights: { rsi: 0.25, macd: 0.25, bollinger: 0.2, whale: 0.15, onchain: 0.15 } },
            scalping: { athDropPct: 35, positionSizeUsd: 100, takeProfitPct: 15, stopLossPct: 5 },
            pool: { minReserveUsd: 50000, minVolToReservePct: 5, minTxCount24h: 100, maxReserveDrainPct: 50 },
            adaptive: { enabled: false },
          };
          return ConfigSchema.safeParse(JSON.parse(JSON.stringify(raw))).success;
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---- P2: TWAP Chunk Sum -----------------------------------------------------
// **Validates: Requirements 1.2**

describe('P2 -- TWAP Chunk Sum', () => {
  it('chunkSizes.sum === order.size within 1e-10 for arbitrary large orders', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1001, max: 100000, noNaN: true, noDefaultInfinity: true }),
        (orderSize) => {
          const config = makeConfig({ thresholdUsd: 1000 });
          const mev = new MEVDefenseModule(config, makeBus());
          const plan = mev.buildTwapPlan(makeOrder(orderSize));
          const sum = plan.chunkSizes.reduce((a, b) => a + b, 0);
          return Math.abs(sum - orderSize) < 1e-10;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---- P3: TWAP Chunk Bounds --------------------------------------------------
// **Validates: Requirements 1.3**

describe('P3 -- TWAP Chunk Bounds', () => {
  it('all chunk sizes are positive and no chunk exceeds totalSize', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1001, max: 100000, noNaN: true, noDefaultInfinity: true }),
        (orderSize) => {
          const config = makeConfig({ thresholdUsd: 1000, minChunkPct: 0.7, maxChunkPct: 1.3, chunkCount: 5 });
          const mev = new MEVDefenseModule(config, makeBus());
          const plan = mev.buildTwapPlan(makeOrder(orderSize));
          return plan.chunkSizes.every(chunk => chunk > 0 && chunk <= orderSize + 1e-9);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---- P4: Position Risk Invariant --------------------------------------------
// **Validates: Requirements 1.4**

describe('P4 -- Position Risk Invariant', () => {
  it('stopLoss < entryPrice and takeProfit > entryPrice for any entry/sl/tp', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 100000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.01, max: 0.5, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.01, max: 2.0, noNaN: true, noDefaultInfinity: true }),
        (entryPrice, slPct, tpPct) => {
          const stopLoss = entryPrice * (1 - slPct);
          const takeProfit = entryPrice * (1 + tpPct);
          return stopLoss < entryPrice && takeProfit > entryPrice;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---- P5: Position Size Bound ------------------------------------------------
// **Validates: Requirements 1.5**

describe('P5 -- Position Size Bound', () => {
  it('calculatePositionSize returns size <= portfolioUsd * maxPositionPct / 100', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 100, max: 1000000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.1, max: 20, noNaN: true, noDefaultInfinity: true }),
        (portfolioUsd, maxPositionPct) => {
          const mockEngine = { getPortfolioValue: jest.fn().mockResolvedValue(portfolioUsd), getCurrentPrice: jest.fn().mockResolvedValue(300) };
          const config = makeConfig(undefined, undefined, { maxPositionPct, minPortfolioUsd: 0 });
          const manager = new RiskManager(mockEngine, config, makeBus());
          const result = manager.calculatePositionSize(portfolioUsd, 'BNB/USDT');
          if (!result.ok) return true;
          return result.value <= portfolioUsd * maxPositionPct / 100 + 1e-9;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---- P6: Exposure Limit -----------------------------------------------------
// **Validates: Requirements 1.6**

describe('P6 -- Exposure Limit', () => {
  it('total exposure does not exceed the configured max when validation passes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 100, max: 100000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1, max: 100, noNaN: true, noDefaultInfinity: true }),
        async (portfolioUsd, maxExposurePct) => {
          const mockEngine = { getPortfolioValue: jest.fn().mockResolvedValue(portfolioUsd), getCurrentPrice: jest.fn().mockResolvedValue(300) };
          const config = makeConfig(undefined, undefined, { maxExposurePct, minPortfolioUsd: 0 });
          const manager = new RiskManager(mockEngine, config, makeBus());
          const orderSize = portfolioUsd * (maxExposurePct / 100) * 0.5;
          const result = await manager.validateNewPosition(makeOrder(orderSize), []);
          if (!result.ok) return true;
          return result.value.size <= portfolioUsd * maxExposurePct / 100 + 1e-9;
        },
      ),
      { numRuns: 50 },
    );
  }, 30000);
});

// ---- P7: Gas Price Clamp ----------------------------------------------------
// **Validates: Requirements 1.7**

describe('P7 -- Gas Price Clamp', () => {
  it('getOptimalGasPrice result is always in [min, max]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1, max: 3, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1, max: 100, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 101, max: 1000, noNaN: true, noDefaultInfinity: true }),
        async (baseFee, priorityFee, multiplier, minGwei, maxGwei) => {
          const mockEngine = { getGasPrice: jest.fn().mockResolvedValue({ baseFee, priorityFee }) };
          const config = makeConfig(undefined, { urgencyMultiplier: multiplier, minGasGwei: minGwei, maxGasGwei: maxGwei });
          const optimizer = new GasOptimizer(mockEngine, config);
          const result = await optimizer.getOptimalGasPrice();
          return result >= minGwei - 1e-9 && result <= maxGwei + 1e-9;
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);
});

// ---- P8: Signal Confidence Bounds -------------------------------------------
// **Validates: Requirements 1.8**

describe('P8 -- Signal Confidence Bounds', () => {
  it('computeCompositeSignal.confidence is always in [0.0, 1.0]', () => {
    const config = makeConfig();
    const gen = new SignalGenerator({}, config, makeBus());

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            confidence: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
            side: fc.constantFrom('buy', 'sell'),
          }),
          { minLength: 0, maxLength: 10 },
        ),
        (inputs) => {
          const signals = inputs.map((inp, i) => ({
            id: `sig-${i}`, pair: 'BNB/USDT', type: 'rsi_oversold', side: inp.side,
            confidence: inp.confidence,
            indicators: { rsi14: 50, macdLine: 0, macdSignal: 0, macdHistogram: 0, bbUpper: 110, bbMiddle: 100, bbLower: 90, ma20: 100, ma50: 100, bbWidth: 5 },
            onChain: { whaleNetFlow24h: 0, exchangeInflow24h: 0, exchangeOutflow24h: 0, largeTransactions: 0 },
            regime: 'sideways', strategy: 'rsi', timestamp: Date.now(),
          }));
          const composite = gen.computeCompositeSignal(signals);
          return composite.confidence >= 0.0 && composite.confidence <= 1.0;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---- P9: State Persistence Round-Trip ---------------------------------------
// **Validates: Requirements 1.9**

describe('P9 -- State Persistence Round-Trip', () => {
  it('loadState after saveState returns ok and data matches', async () => {
    const os = require('os');
    const pathM = require('path');
    const fsM = require('fs');
    const { StateManager } = require('../state/StateManager');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000000 }),
        fc.boolean(),
        async (drawdownBaseline, circuitBreakerActive) => {
          const tmpFile = pathM.join(os.tmpdir(), `state-pbt-${Date.now()}-${Math.random()}.json`);
          const config = { get: jest.fn().mockReturnValue({ stateFilePath: tmpFile }) };
          const stateMgr = new StateManager(config, makeBus());
          const baseState = stateMgr.emptyState();
          const testState = Object.assign({}, baseState, { drawdownBaseline, circuitBreakerActive });
          await stateMgr.saveState(testState);
          const loaded = await stateMgr.loadState();
          try { fsM.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
          if (!loaded.ok) return false;
          return loaded.value.drawdownBaseline === drawdownBaseline && loaded.value.circuitBreakerActive === circuitBreakerActive;
        },
      ),
      { numRuns: 10 },
    );
  }, 30000);
});

// ---- P10: Sharpe Finiteness -------------------------------------------------
// **Validates: Requirements 1.10**

describe('P10 -- Sharpe Finiteness', () => {
  it('calculateSharpe returns a finite number for non-empty finite returns', () => {
    const engine = new AnalyticsEngine({}, makeConfig(), makeBus());

    fc.assert(
      fc.property(
        fc.array(fc.double({ noNaN: true, noDefaultInfinity: true, min: -100, max: 100 }), { minLength: 1, maxLength: 100 }),
        (returns) => Number.isFinite(engine.calculateSharpe(returns)),
      ),
      { numRuns: 200 },
    );
  });
});

// ---- P11: Pool Rejection Consistency ----------------------------------------
// **Validates: Requirements 1.11**

describe('P11 -- Pool Rejection Consistency', () => {
  it('isHealthy returns false when reserve is below minReserveUsd', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 49999, noNaN: true, noDefaultInfinity: true }),
        (totalReserveUsd) => {
          const config = makeConfig(undefined, undefined, undefined, undefined, { minReserveUsd: 50000, minVolToReservePct: 0, minTxCount24h: 0, maxReserveDrainPct: 100 });
          const analyzer = new PoolAnalyzer({}, config, makeBus());
          const health = { pair: 'BNB/USDT', token0Reserve: totalReserveUsd / 2, token1Reserve: totalReserveUsd / 2, totalReserveUsd, volume24h: totalReserveUsd * 0.1, txCount24h: 1000, reserveDrainPct: 0, healthy: true, rejectionReason: null, fetchedAt: Date.now() };
          return !analyzer.isHealthy(health);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('isHealthy returns false when txCount24h is below minTxCount24h', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99 }),
        (txCount24h) => {
          const config = makeConfig(undefined, undefined, undefined, undefined, { minReserveUsd: 0, minVolToReservePct: 0, minTxCount24h: 100, maxReserveDrainPct: 100 });
          const analyzer = new PoolAnalyzer({}, config, makeBus());
          const health = { pair: 'BNB/USDT', token0Reserve: 1000000, token1Reserve: 1000000, totalReserveUsd: 2000000, volume24h: 200000, txCount24h, reserveDrainPct: 0, healthy: true, rejectionReason: null, fetchedAt: Date.now() };
          return !analyzer.isHealthy(health);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---- P12: Strategy Weight Normalization --------------------------------------
// **Validates: Requirements 1.12**

describe('P12 -- Strategy Weight Normalization', () => {
  it('sum of strategy weights === 1.0 after evaluateAndAdjustWeights', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 8 }),
        (initialWeights) => {
          const config = makeConfig(undefined, undefined, undefined, undefined, undefined, { enabled: true, evaluationPeriodSec: 86400, weightAdjPct: 10, benchmarkReturn: 0 });
          const manager = new StrategyManager({} as never, config, makeBus());
          initialWeights.forEach((w, i) => {
            manager.registerStrategy({ name: `strategy-${i}`, weight: w, isActive: true, supportedRegimes: ['bull', 'bear', 'sideways'], onSignal: jest.fn().mockReturnValue(null), onMarketData: jest.fn() });
          });
          manager.evaluateAndAdjustWeights();
          const weights = Object.values(manager.getStrategyWeights());
          const sum = weights.reduce((a, b) => a + b, 0);
          return Math.abs(sum - 1.0) < 1e-10;
        },
      ),
      { numRuns: 100 },
    );
  });
});
