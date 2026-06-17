import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type { MarketRegime, TradingSignal, Order, MarketData, OrderSide } from '../types/index';
import type { IStrategy }            from './IStrategy';
import { uuid }                      from '../utils/uuid';

export class RangeStrategy implements IStrategy {
  readonly name             = 'Range';
  readonly supportedRegimes: MarketRegime[] = ['sideways'];
  weight:   number          = 0.3;
  isActive: boolean         = true;

  private readonly config: ConfigurationService;
  constructor(config: ConfigurationService, _bus: EventBus) { this.config = config; }

  onMarketData(_data: MarketData): void { /* not needed */ }

  onSignal(signal: TradingSignal, _regime: MarketRegime): Order | null {
    let side: OrderSide | null = null;
    if (signal.type === 'bb_lower') side = 'buy';
    else if (signal.type === 'bb_upper') side = 'sell';
    if (side === null) return null;

    const cfg = this.config.get();
    return {
      id: uuid(), pair: signal.pair, type: 'market',
      side, size: cfg.scalping.positionSizeUsd,
      venue: 'pancakeswap', slippage: cfg.slippage.defaultPct,
      twap: null, createdAt: Date.now(), signalId: signal.id,
    };
  }
}
