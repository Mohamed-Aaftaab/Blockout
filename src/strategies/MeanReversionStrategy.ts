import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type { MarketRegime, TradingSignal, Order, MarketData } from '../types/index';
import type { IStrategy }            from './IStrategy';
import { uuid }                      from '../utils/uuid';

export class MeanReversionStrategy implements IStrategy {
  readonly name             = 'MeanReversion';
  readonly supportedRegimes: MarketRegime[] = ['bear'];
  weight:   number          = 0.3;
  isActive: boolean         = true;

  private readonly config: ConfigurationService;
  constructor(config: ConfigurationService, _bus: EventBus) { this.config = config; }

  onMarketData(_data: MarketData): void { /* not needed */ }

  onSignal(signal: TradingSignal, _regime: MarketRegime): Order | null {
    if (signal.type !== 'rsi_oversold' && signal.type !== 'bb_lower') return null;
    const cfg = this.config.get();
    return {
      id: uuid(), pair: signal.pair, type: 'market',
      side: 'buy', size: cfg.risk.maxPositionPct * 10,
      venue: 'pancakeswap', slippage: cfg.slippage.defaultPct,
      twap: null, createdAt: Date.now(), signalId: signal.id,
    };
  }
}
