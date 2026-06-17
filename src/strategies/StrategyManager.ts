import { createLogger, transports, format } from 'winston';
import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type { TradingSignal, Order } from '../types/index';
import type { IStrategy }            from './IStrategy';
import type { SignalGenerator }      from '../market/SignalGenerator';
import type { RegimeDetector }       from '../market/RegimeDetector';

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

// Map each strategy name to the confidence score of the signal it last acted on
// so resolveConflict can pick the highest-confidence signal
interface StrategyOrderPair {
  strategy: IStrategy;
  order:    Order;
  signal:   TradingSignal;
}

export class StrategyManager {
  private readonly signalGen:  SignalGenerator;
  private readonly regime:     RegimeDetector;
  private readonly config:     ConfigurationService;
  private readonly bus:        EventBus;
  private readonly strategies: Map<string, IStrategy> = new Map();
  private weightInterval:      NodeJS.Timeout | null = null;
  private signalListener:      ((signal: TradingSignal) => void) | null = null;

  constructor(
    signalGen:      SignalGenerator,
    regimeDetector: RegimeDetector,
    config:         ConfigurationService,
    bus:            EventBus,
  ) {
    this.signalGen = signalGen;
    this.regime    = regimeDetector;
    this.config    = config;
    this.bus       = bus;
  }

  registerStrategy(strategy: IStrategy): void {
    this.strategies.set(strategy.name, strategy);
    logger.info('Strategy registered', { name: strategy.name, weight: strategy.weight });
  }

  getActiveStrategies(): IStrategy[] {
    return [...this.strategies.values()].filter(s => s.isActive);
  }

  getStrategyWeights(): Record<string, number> {
    const weights: Record<string, number> = {};
    for (const [name, s] of this.strategies) weights[name] = s.weight;
    return weights;
  }

  start(): void {
    const cfg = this.config.get();

    this.signalListener = (signal: TradingSignal) => {
      const currentRegime = this.regime.getCurrentRegime(signal.pair);
      const candidates: StrategyOrderPair[] = [];

      for (const strategy of this.getActiveStrategies()) {
        if (!strategy.supportedRegimes.includes(currentRegime)) continue;
        const order = strategy.onSignal(signal, currentRegime);
        if (order !== null) {
          candidates.push({ strategy, order, signal });
        }
      }

      if (candidates.length === 0) return;

      const resolved = candidates.length === 1
        ? candidates[0]!.order
        : this.resolveConflict(candidates);

      this.bus.emit('strategy:signal', { signal, strategy: resolved.id });

      logger.info('Strategy order produced', {
        pair:      signal.pair,
        regime:    currentRegime,
        orderId:   resolved.id,
        side:      resolved.side,
        size:      resolved.size,
        type:      resolved.type,
        confidence: signal.confidence.toFixed(3),
      });
    };

    this.bus.on('signal:generated', this.signalListener);

    if (cfg.adaptive.enabled) {
      this.weightInterval = setInterval(() => {
        this.evaluateAndAdjustWeights();
      }, cfg.adaptive.evaluationPeriodSec * 1000);
    }
  }

  stop(): void {
    if (this.signalListener !== null) {
      this.bus.off('signal:generated', this.signalListener);
      this.signalListener = null;
    }
    if (this.weightInterval !== null) {
      clearInterval(this.weightInterval);
      this.weightInterval = null;
    }
  }

  evaluateAndAdjustWeights(): void {
    const cfg = this.config.get().adaptive;
    let totalWeight = 0;

    for (const strategy of this.strategies.values()) {
      if (!strategy.isActive) {
        strategy.weight = Math.max(0.01, strategy.weight - cfg.weightAdjPct / 100);
      } else {
        strategy.weight = Math.min(1, strategy.weight + cfg.weightAdjPct / 200);
      }
      totalWeight += strategy.weight;
    }

    // Normalize to sum to 1.0
    if (totalWeight > 0) {
      for (const strategy of this.strategies.values()) {
        strategy.weight = strategy.weight / totalWeight;
      }
    }

    const weights = this.getStrategyWeights();
    this.bus.emit('strategy:weights', { weights, reason: 'periodic-evaluation' });
    logger.info('Strategy weights adjusted', { weights });
  }

  private resolveConflict(candidates: StrategyOrderPair[]): Order {
    // Pick the order from the strategy whose signal has the highest confidence
    // Tiebreak: higher strategy weight wins
    let best = candidates[0]!;

    for (const candidate of candidates.slice(1)) {
      const betterConfidence = candidate.signal.confidence > best.signal.confidence;
      const sameConfidenceHigherWeight =
        candidate.signal.confidence === best.signal.confidence &&
        candidate.strategy.weight > best.strategy.weight;

      if (betterConfidence || sameConfidenceHigherWeight) {
        best = candidate;
      }
    }

    logger.info('Conflict resolved', {
      winner:     best.strategy.name,
      confidence: best.signal.confidence.toFixed(3),
      weight:     best.strategy.weight.toFixed(3),
      candidates: candidates.map(c => ({
        strategy:   c.strategy.name,
        confidence: c.signal.confidence.toFixed(3),
      })),
    });

    return best.order;
  }
}
