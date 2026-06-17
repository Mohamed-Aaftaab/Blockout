import { createLogger, transports, format } from 'winston';
import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type {
  MarketData, TradingSignal, TechnicalIndicators,
  OnChainMetrics, MarketRegime, SignalType, OrderSide,
} from '../types/index';
import type { MarketDataService } from './MarketDataService';
import { uuid } from '../utils/uuid';

const logger = createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

// Fixed weights for composite signal — no magic numbers, all in one place
const SIGNAL_TYPE_WEIGHTS: Record<SignalType, number> = {
  rsi_oversold:          0.25,
  rsi_overbought:        0.25,
  macd_bullish:          0.25,
  macd_bearish:          0.25,
  bb_lower:              0.20,
  bb_upper:              0.20,
  whale_accumulation:    0.15,
  exchange_inflow:       0.15,
  scalping_entry:        1.00,
  composite:             1.00,
  price_momentum_buy:    0.20,
  price_momentum_sell:   0.20,
};

// Price-momentum fallback thresholds — fires even without CMC Pro indicators
const MOMENTUM_DROP_PCT = 2.0; // buy signal when price drops >= 2% in last candle period
const MOMENTUM_RISE_PCT = 2.0; // sell signal when price rises >= 2% in last candle period

export class SignalGenerator {
  private readonly marketData: MarketDataService;
  private readonly config:     ConfigurationService;
  private readonly bus:        EventBus;

  constructor(marketData: MarketDataService, config: ConfigurationService, bus: EventBus) {
    this.marketData = marketData;
    this.config     = config;
    this.bus        = bus;
  }

  generateSignals(pair: string, data: MarketData): TradingSignal[] {
    const signals: TradingSignal[] = [];

    const rsi      = this.computeRSISignal(data.indicators, pair, data.onChain);
    const macd     = this.computeMACDSignal(data.indicators, pair, data.onChain);
    const bb       = this.computeBollingerSignal(data.indicators, pair, data.price, data.onChain);
    const whal     = this.computeWhaleSignal(data.onChain, pair, data.indicators);
    // Price momentum: fires even when CMC indicator endpoints are unavailable (free tier)
    const momentum = this.computePriceMomentumSignal(data, pair);

    if (rsi      !== null) signals.push(rsi);
    if (macd     !== null) signals.push(macd);
    if (bb       !== null) signals.push(bb);
    if (whal     !== null) signals.push(whal);
    if (momentum !== null) signals.push(momentum);

    return signals;
  }

  computeCompositeSignal(signals: TradingSignal[]): TradingSignal {
    const defaultIndicators = this.defaultIndicators();
    const defaultOnChain    = this.defaultOnChain();

    if (signals.length === 0) {
      return this.buildSignal('composite', 'buy', 0, 'composite', 'unknown',
        defaultIndicators, defaultOnChain, 'sideways');
    }

    let totalWeight  = 0;
    let weightedConf = 0;
    let buyVotes     = 0;
    let sellVotes    = 0;

    for (const s of signals) {
      const w = SIGNAL_TYPE_WEIGHTS[s.type] ?? 1.0;
      weightedConf += s.confidence * w;
      totalWeight  += w;
      if (s.side === 'buy') buyVotes++;
      else                  sellVotes++;
    }

    const confidence = totalWeight > 0 ? Math.min(weightedConf / totalWeight, 1.0) : 0;
    const side: OrderSide = buyVotes >= sellVotes ? 'buy' : 'sell';

    const first = signals[0]!;
    const composite = this.buildSignal(
      'composite', side, confidence, 'composite',
      first.pair, first.indicators, first.onChain, first.regime,
    );

    this.bus.emit('signal:generated', composite);

    logger.debug('Composite signal generated', {
      pair:       composite.pair,
      side:       composite.side,
      confidence: composite.confidence.toFixed(3),
      regime:     composite.regime,
      components: signals.map(s => s.type),
    });

    return composite;
  }

  private computeRSISignal(
    indicators: TechnicalIndicators,
    pair:       string,
    onChain:    OnChainMetrics,
  ): TradingSignal | null {
    const cfg    = this.config.get().signal;
    const regime = this.getDefaultRegime();

    if (indicators.rsi14 < cfg.rsiOversold) {
      const conf = Math.min((cfg.rsiOversold - indicators.rsi14) / cfg.rsiOversold, 1.0);
      return this.buildSignal('rsi_oversold', 'buy', conf, 'rsi', pair, indicators, onChain, regime);
    }
    if (indicators.rsi14 > cfg.rsiOverbought) {
      const conf = Math.min((indicators.rsi14 - cfg.rsiOverbought) / (100 - cfg.rsiOverbought), 1.0);
      return this.buildSignal('rsi_overbought', 'sell', conf, 'rsi', pair, indicators, onChain, regime);
    }
    return null;
  }

  private computeMACDSignal(
    indicators: TechnicalIndicators,
    pair:       string,
    onChain:    OnChainMetrics,
  ): TradingSignal | null {
    const regime  = this.getDefaultRegime();
    const histAbs = Math.abs(indicators.macdHistogram);
    const maxHist = 10; // normalizer — histogram magnitudes rarely exceed 10 in practice
    const conf    = Math.min(histAbs / maxHist, 1.0);

    if (indicators.macdLine > indicators.macdSignal && indicators.macdHistogram > 0) {
      return this.buildSignal('macd_bullish', 'buy', conf, 'macd', pair, indicators, onChain, regime);
    }
    if (indicators.macdLine < indicators.macdSignal && indicators.macdHistogram < 0) {
      return this.buildSignal('macd_bearish', 'sell', conf, 'macd', pair, indicators, onChain, regime);
    }
    return null;
  }

  private computeBollingerSignal(
    indicators: TechnicalIndicators,
    pair:       string,
    price:      number,
    onChain:    OnChainMetrics,
  ): TradingSignal | null {
    const regime = this.getDefaultRegime();
    const band   = indicators.bbUpper - indicators.bbLower;
    if (band <= 0) return null;

    if (price <= indicators.bbLower) {
      // Confidence increases the further below the lower band price is
      const conf = Math.min((indicators.bbLower - price) / band + 0.5, 1.0);
      return this.buildSignal('bb_lower', 'buy', conf, 'bollinger', pair, indicators, onChain, regime);
    }
    if (price >= indicators.bbUpper) {
      const conf = Math.min((price - indicators.bbUpper) / band + 0.5, 1.0);
      return this.buildSignal('bb_upper', 'sell', conf, 'bollinger', pair, indicators, onChain, regime);
    }
    return null;
  }

  private computeWhaleSignal(
    onChain:    OnChainMetrics,
    pair:       string,
    indicators: TechnicalIndicators,
  ): TradingSignal | null {
    const cfg    = this.config.get().signal;
    const regime = this.getDefaultRegime();

    if (onChain.whaleNetFlow24h > cfg.whaleBuyThresholdUsd) {
      const conf = Math.min(onChain.whaleNetFlow24h / (cfg.whaleBuyThresholdUsd * 2), 1.0);
      return this.buildSignal('whale_accumulation', 'buy', conf, 'onchain', pair, indicators, onChain, regime);
    }
    if (onChain.exchangeInflow24h > cfg.exchangeInflowUsd) {
      const conf = Math.min(onChain.exchangeInflow24h / (cfg.exchangeInflowUsd * 2), 1.0);
      return this.buildSignal('exchange_inflow', 'sell', conf, 'onchain', pair, indicators, onChain, regime);
    }
    return null;
  }

  private computePriceMomentumSignal(
    data: MarketData,
    pair: string,
  ): TradingSignal | null {
    if (data.candles.length < 2) return null;

    const latest = data.candles[data.candles.length - 1];
    const prev   = data.candles[data.candles.length - 2];
    if (latest === undefined || prev === undefined || prev.close === 0) return null;

    const changePct = ((latest.close - prev.close) / prev.close) * 100;
    const regime    = this.getDefaultRegime();

    if (changePct <= -MOMENTUM_DROP_PCT) {
      const conf = Math.min(Math.abs(changePct) / (MOMENTUM_DROP_PCT * 3), 1.0);
      // Use dedicated price_momentum_buy type — does not collide with RSI weight
      return this.buildSignal('price_momentum_buy', 'buy', conf, 'momentum', pair, data.indicators, data.onChain, regime);
    }
    if (changePct >= MOMENTUM_RISE_PCT) {
      const conf = Math.min(changePct / (MOMENTUM_RISE_PCT * 3), 1.0);
      return this.buildSignal('price_momentum_sell', 'sell', conf, 'momentum', pair, data.indicators, data.onChain, regime);
    }
    return null;
  }

  private buildSignal(
    type:       SignalType,
    side:       OrderSide,
    confidence: number,
    strategy:   string,
    pair:       string,
    indicators: TechnicalIndicators,
    onChain:    OnChainMetrics,
    regime:     MarketRegime,
  ): TradingSignal {
    return {
      id:         uuid(),
      pair,
      type,
      side,
      confidence: Math.max(0, Math.min(confidence, 1.0)),
      indicators,
      onChain,
      regime,
      strategy,
      timestamp:  Date.now(),
    };
  }

  private getDefaultRegime(): MarketRegime { return 'sideways'; }

  private defaultIndicators(): TechnicalIndicators {
    return {
      rsi14: 50, macdLine: 0, macdSignal: 0, macdHistogram: 0,
      bbUpper: 0, bbMiddle: 0, bbLower: 0, ma20: 0, ma50: 0, bbWidth: 5,
    };
  }

  private defaultOnChain(): OnChainMetrics {
    return { whaleNetFlow24h: 0, exchangeInflow24h: 0, exchangeOutflow24h: 0, largeTransactions: 0 };
  }
}
