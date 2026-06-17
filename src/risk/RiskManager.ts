import { createLogger, transports, format } from 'winston';
import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type { Position, Order, Result } from '../types/index';
import { ok, err }                   from '../types/index';
import { RiskError }                 from '../types/errors';
import type { TradingEngine }        from '../execution/TradingEngine';

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

export class RiskManager {
  private readonly engine:   TradingEngine;
  private readonly config:   ConfigurationService;
  private readonly bus:      EventBus;

  private openPositions:       Map<string, Position> = new Map();
  private drawdownBaseline:    number  = 0;
  private circuitBreakerActive:boolean = false;
  private slMonitorInterval:   NodeJS.Timeout | null = null;
  private drawdownInterval:    NodeJS.Timeout | null = null;

  constructor(tradingEngine: TradingEngine, config: ConfigurationService, bus: EventBus) {
    this.engine = tradingEngine;
    this.config = config;
    this.bus    = bus;
  }

  async start(): Promise<void> {
    const portfolioUsd = await this.engine.getPortfolioValue();
    this.drawdownBaseline = portfolioUsd;
    logger.info('RiskManager started', { drawdownBaseline: portfolioUsd });

    const cfg = this.config.get();
    this.slMonitorInterval = setInterval(() => {
      void this.monitorStopLossAndTakeProfit();
    }, cfg.slMonitorMs);

    this.drawdownInterval = setInterval(() => {
      void this.checkDrawdown();
    }, cfg.drawdownCheckSec * 1000);
  }

  stop(): void {
    if (this.slMonitorInterval !== null) {
      clearInterval(this.slMonitorInterval);
      this.slMonitorInterval = null;
    }
    if (this.drawdownInterval !== null) {
      clearInterval(this.drawdownInterval);
      this.drawdownInterval = null;
    }
  }

  calculatePositionSize(portfolioUsd: number, _pair: string): Result<number, RiskError> {
    const cfg = this.config.get().risk;
    if (portfolioUsd < cfg.minPortfolioUsd) {
      return err(new RiskError(
        `Portfolio $${portfolioUsd} below minimum $${cfg.minPortfolioUsd}`,
        'below_minimum',
      ));
    }
    return ok(portfolioUsd * cfg.maxPositionPct / 100);
  }

  async validateNewPosition(order: Order, _openPositions: Position[]): Promise<Result<Order, RiskError>> {
    if (this.circuitBreakerActive) {
      return err(new RiskError('Circuit breaker active — trading halted', 'circuit_breaker'));
    }

    const cfg          = this.config.get().risk;
    const portfolioUsd = await this.engine.getPortfolioValue();
    const currentExposure = Array.from(this.openPositions.values())
      .reduce((sum, pos) => sum + pos.size, 0);
    const maxExposure = portfolioUsd * cfg.maxExposurePct / 100;

    let adjustedOrder = order;
    if (currentExposure + order.size > maxExposure) {
      const available = maxExposure - currentExposure;
      if (available <= 0) {
        return err(new RiskError(
          `Max exposure reached: $${currentExposure.toFixed(0)} / $${maxExposure.toFixed(0)}`,
          'max_exposure',
        ));
      }
      adjustedOrder = { ...order, size: available };
    }

    this.bus.emit('risk:position_sized', {
      orderId:      adjustedOrder.id,
      size:         adjustedOrder.size,
      portfolioUsd,
    });

    return ok(adjustedOrder);
  }

  onPositionOpened(position: Position): void {
    this.openPositions.set(position.id, position);
    logger.info('Position opened', { id: position.id, pair: position.pair, size: position.size });
  }

  onPositionClosed(positionId: string): void {
    this.openPositions.delete(positionId);
  }

  triggerCircuitBreaker(reason: string): void {
    this.circuitBreakerActive = true;
    logger.error('Circuit breaker triggered', { reason });
    this.bus.emit('risk:circuit_breaker', {
      drawdownPct:  0,
      portfolioUsd: this.drawdownBaseline,
      timestamp:    Date.now(),
    });
  }

  resetCircuitBreaker(): void {
    this.circuitBreakerActive = false;
    logger.info('Circuit breaker reset');
  }

  async checkDrawdown(): Promise<void> {
    if (this.drawdownBaseline === 0) return;
    const current = await this.engine.getPortfolioValue();
    const drawdownPct = (this.drawdownBaseline - current) / this.drawdownBaseline * 100;
    const cfg = this.config.get().risk;

    if (drawdownPct >= cfg.maxDrawdownPct) {
      logger.error('Max drawdown exceeded', { drawdownPct, maxDrawdownPct: cfg.maxDrawdownPct });
      this.triggerCircuitBreaker(`Max drawdown ${drawdownPct.toFixed(1)}% >= ${cfg.maxDrawdownPct}%`);
    }
  }

  private async monitorStopLossAndTakeProfit(): Promise<void> {
    for (const [id, position] of this.openPositions) {
      try {
        const price = await this.engine.getCurrentPrice(position.pair);
        // For buy positions:  SL fires when price drops to/below SL, TP fires when price rises to/above TP
        // For sell positions: SL fires when price rises to/above SL, TP fires when price drops to/below TP
        const slTriggered = position.side === 'buy'
          ? price <= position.stopLoss
          : price >= position.stopLoss;
        const tpTriggered = position.side === 'buy'
          ? price >= position.takeProfit
          : price <= position.takeProfit;

        if (slTriggered) {
          logger.info('Stop-loss triggered', { id, pair: position.pair, side: position.side, price, stopLoss: position.stopLoss });
          this.bus.emit('risk:sl_triggered', { positionId: id, price });
        } else if (tpTriggered) {
          logger.info('Take-profit triggered', { id, pair: position.pair, side: position.side, price, takeProfit: position.takeProfit });
          this.bus.emit('risk:tp_triggered', { positionId: id, price });
        }
      } catch (e) {
        logger.warn('SL/TP price fetch failed', { id, error: String(e) });
      }
    }
  }
}
