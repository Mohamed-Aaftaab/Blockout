import { SignalGenerator } from '../market/SignalGenerator';
import type { ConfigurationService } from '../config/index';
import type { MarketDataService } from '../market/MarketDataService';
import type { EventBus } from '../events/EventBus';
import type { MarketData, TechnicalIndicators, OnChainMetrics, TradingSignal } from '../types/index';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeIndicators(overrides: Partial<TechnicalIndicators> = {}): TechnicalIndicators {
  return {
    rsi14:         50,
    macdLine:      0,
    macdSignal:    0,
    macdHistogram: 0,
    bbUpper:       110,
    bbMiddle:      100,
    bbLower:       90,
    ma20:          100,
    ma50:          100,
    bbWidth:       5,
    ...overrides,
  };
}

function makeOnChain(overrides: Partial<OnChainMetrics> = {}): OnChainMetrics {
  return {
    whaleNetFlow24h:    0,
    exchangeInflow24h:  0,
    exchangeOutflow24h: 0,
    largeTransactions:  0,
    ...overrides,
  };
}

function makeMarketData(
  indicators: TechnicalIndicators,
  price = 100,
  onChain: OnChainMetrics = makeOnChain(),
): MarketData {
  return {
    pair:      'BNB/USDT',
    price,
    volume24h: 1_000_000,
    marketCap: 50_000_000,
    ath:       650,
    candles:   [],
    indicators,
    onChain,
    fetchedAt: Date.now(),
  };
}

function buildGenerator(signalCfg?: { rsiOversold?: number; rsiOverbought?: number }) {
  const defaultCfg = {
    rsiOversold:          signalCfg?.rsiOversold  ?? 30,
    rsiOverbought:        signalCfg?.rsiOverbought ?? 70,
    whaleBuyThresholdUsd: 100_000,
    exchangeInflowUsd:    50_000,
    weights: { rsi: 0.25, macd: 0.25, bollinger: 0.2, whale: 0.15, onchain: 0.15 },
  };

  const mockConfig = {
    get: jest.fn().mockReturnValue({
      signal: defaultCfg,
    }),
  } as unknown as ConfigurationService;

  const mockMarketData = {} as MarketDataService;

  const mockBus = {
    emit: jest.fn(),
    on:   jest.fn(),
    off:  jest.fn(),
  } as unknown as EventBus;

  return new SignalGenerator(mockMarketData, mockConfig, mockBus);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SignalGenerator.generateSignals', () => {
  it('returns rsi_oversold buy signal when rsi14=25 and rsiOversold=30', () => {
    const gen = buildGenerator({ rsiOversold: 30 });
    const indicators = makeIndicators({ rsi14: 25 });
    const data = makeMarketData(indicators);

    const signals = gen.generateSignals('BNB/USDT', data);
    const rsiSignal = signals.find(s => s.type === 'rsi_oversold');
    expect(rsiSignal).toBeDefined();
    expect(rsiSignal?.side).toBe('buy');
  });

  it('returns rsi_overbought sell signal when rsi14=75 and rsiOverbought=70', () => {
    const gen = buildGenerator({ rsiOverbought: 70 });
    const indicators = makeIndicators({ rsi14: 75 });
    const data = makeMarketData(indicators);

    const signals = gen.generateSignals('BNB/USDT', data);
    const rsiSignal = signals.find(s => s.type === 'rsi_overbought');
    expect(rsiSignal).toBeDefined();
    expect(rsiSignal?.side).toBe('sell');
  });
});

describe('SignalGenerator.computeCompositeSignal', () => {
  function makeSignal(side: 'buy' | 'sell', type: TradingSignal['type'] = 'rsi_oversold', confidence = 0.8): TradingSignal {
    return {
      id:         'test-id',
      pair:       'BNB/USDT',
      type,
      side,
      confidence,
      indicators: makeIndicators(),
      onChain:    makeOnChain(),
      regime:     'sideways',
      strategy:   'rsi',
      timestamp:  Date.now(),
    };
  }

  it('confidence is in [0.0, 1.0]', () => {
    const gen = buildGenerator();
    const signals = [makeSignal('buy'), makeSignal('sell'), makeSignal('buy')];
    const composite = gen.computeCompositeSignal(signals);
    expect(composite.confidence).toBeGreaterThanOrEqual(0.0);
    expect(composite.confidence).toBeLessThanOrEqual(1.0);
  });

  it('side is buy when 3 buy signals and 1 sell signal', () => {
    const gen = buildGenerator();
    const signals: TradingSignal[] = [
      makeSignal('buy', 'rsi_oversold'),
      makeSignal('buy', 'macd_bullish'),
      makeSignal('buy', 'bb_lower'),
      makeSignal('sell', 'rsi_overbought'),
    ];
    const composite = gen.computeCompositeSignal(signals);
    expect(composite.side).toBe('buy');
  });

  it('returns buy for empty signals array', () => {
    const gen = buildGenerator();
    const composite = gen.computeCompositeSignal([]);
    expect(composite.side).toBe('buy');
    expect(composite.type).toBe('composite');
  });
});
