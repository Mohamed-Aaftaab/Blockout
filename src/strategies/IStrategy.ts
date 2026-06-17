import type { MarketRegime, TradingSignal, Order, MarketData } from '../types/index';

export interface IStrategy {
  readonly name:             string;
  readonly supportedRegimes: MarketRegime[];
  weight:                    number;
  isActive:                  boolean;
  onSignal(signal: TradingSignal, regime: MarketRegime): Order | null;
  onMarketData(data: MarketData): void;
}
