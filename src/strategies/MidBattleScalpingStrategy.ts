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

  private readonly config:   ConfigurationService;
  private readonly bus:      EventBus;
  private readonly athMap:   Map<string, number> = new Map();
  // Track last known real price per pair (updated via onMarketData)
  private readonly lastPrices: Map<string, number> = new Map();

  constructor(config: ConfigurationService, bus: EventBus) {
    this.config = config;
    this.bus    = bus;
    this.weight = 0.4;
  }

  onMarketData(data: MarketData): void {
    // Store real current price
    this.lastPrices.set(data.pair, data.price);
    // Update ATH using the real price
    this.updateATH(data.pair, data.price);
  }

  onSignal(signal: TradingSignal, _regime: MarketRegime): Order | null {
    // Use real current price from onMarketData, not an indicator value
    const currentPrice = this.lastPrices.get(signal.pair) ?? 0;

    // Can't evaluate dip without a known price
    if (currentPrice === 0) return null;

    if (!this.isDipConditionMet(signal.pair, currentPrice)) {
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
    // ATH only increases, never decreases
    if (price > current) this.athMap.set(pair, price);
  }

  private isDipConditionMet(pair: string, price: number): boolean {
    const ath = this.athMap.get(pair) ?? 0;
    if (ath === 0) return false; // no ATH tracked yet
    const cfg      = this.config.get().scalping;
    const dipLevel = ath * (1 - cfg.athDropPct / 100);
    return price <= dipLevel;
  }
}
