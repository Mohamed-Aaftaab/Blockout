import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type { MarketRegime, TradingSignal, Order, MarketData } from '../types/index';
import type { IStrategy }            from './IStrategy';
import { uuid }                      from '../utils/uuid';

export class MomentumStrategy implements IStrategy {
  readonly name             = 'Momentum';
  readonly supportedRegimes: MarketRegime[] = ['bull'];
  weight:   number          = 0.3;
  isActive: boolean         = true;

  private readonly config: ConfigurationService;
  constructor(config: ConfigurationService, _bus: EventBus) { this.config = config; }

  onMarketData(_data: MarketData): void { /* not needed */ }

  onSignal(signal: TradingSignal, _regime: MarketRegime): Order | null {
    if (signal.confidence < 0.6) return null;
    const cfg = this.config.get();
    return {
      id: uuid(), pair: signal.pair, type: 'market',
      side: signal.side, size: cfg.scalping.positionSizeUsd,
      venue: 'pancakeswap', slippage: cfg.slippage.defaultPct,
      twap: null, createdAt: Date.now(), signalId: signal.id,
    };
  }
}
