import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type { MarketRegime, TradingSignal, Order, MarketData } from '../types/index';
import type { IStrategy }            from './IStrategy';
import { uuid }                      from '../utils/uuid';

export class MidBattleScalpingStrategy implements IStrategy {
  readonly name             = 'MidBattleScalping';
  readonly supportedRegimes: MarketRegime[] = ['bull', 'bear', 'sideways'];
  weight:   number;
  isActive: boolean = true;

  private readonly config: ConfigurationService;
  private readonly bus:    EventBus;
  private readonly athMap: Map<string, number> = new Map();

  constructor(config: ConfigurationService, bus: EventBus) {
    this.config = config;
    this.bus    = bus;
    this.weight = 0.4; // default weight — adjusted by StrategyManager
  }

  onMarketData(data: MarketData): void {
    this.updateATH(data.pair, data.price);
  }

  onSignal(signal: TradingSignal, _regime: MarketRegime): Order | null {
    if (!this.isDipConditionMet(signal.pair, signal.indicators.ma20 || 0)) {
      return null;
    }

    const cfg = this.config.get();
    return {
      id:        uuid(),
      pair:      signal.pair,
      type:      'twap',
      side:      'buy',
      size:      cfg.scalping.positionSizeUsd,
      venue:     'pancakeswap',
      slippage:  cfg.slippage.defaultPct,
      twap:      null,
      createdAt: Date.now(),
      signalId:  signal.id,
    };
  }

  private updateATH(pair: string, price: number): void {
    const current = this.athMap.get(pair) ?? 0;
    if (price > current) this.athMap.set(pair, price);
  }

  private isDipConditionMet(pair: string, price: number): boolean {
    const ath = this.athMap.get(pair) ?? 0;
    if (ath === 0) return false;
    const cfg      = this.config.get().scalping;
    const dipLevel = ath * (1 - cfg.athDropPct / 100);
    return price <= dipLevel;
  }
}
