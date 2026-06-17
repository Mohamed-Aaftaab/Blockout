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
      const orders: Order[] = [];

      for (const strategy of this.getActiveStrategies()) {
        if (!strategy.supportedRegimes.includes(currentRegime)) continue;
        const order = strategy.onSignal(signal, currentRegime);
        if (order !== null) orders.push(order);
      }

      if (orders.length === 0) return;
      const resolved = orders.length === 1 ? orders[0]! : this.resolveConflict(orders, signal);
      this.bus.emit('strategy:signal', { signal, strategy: resolved.id });
      logger.info('Strategy order produced', {
        pair:     signal.pair,
        regime:   currentRegime,
        orderId:  resolved.id,
        side:     resolved.side,
        size:     resolved.size,
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
      // Simple stub: adjust weight based on isActive (real impl uses AnalyticsEngine data)
      if (!strategy.isActive) {
        strategy.weight = Math.max(0, strategy.weight - cfg.weightAdjPct / 100);
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

  private resolveConflict(orders: Order[], signal: TradingSignal): Order {
    // Select the order whose strategy has the highest weight
    let best = orders[0]!;
    let bestWeight = 0;

    for (const order of orders) {
      // Derive strategy name from order (strategy name is in position.strategy for trades,
      // but here we identify by checking the strategy registry)
      const stratName = [...this.strategies.keys()].find(name => {
        const s = this.strategies.get(name);
        return s !== undefined && s.supportedRegimes.includes(
          this.regime.getCurrentRegime(signal.pair)
        );
      });
      const weight = stratName !== undefined ? (this.strategies.get(stratName)?.weight ?? 0) : 0;
      if (weight >= bestWeight) {
        bestWeight = weight;
        best = order;
      }
    }
    return best;
  }
}
