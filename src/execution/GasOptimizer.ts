import type { ConfigurationService } from '../config/index';
import type { TradingEngine } from './TradingEngine';

export class GasOptimizer {
  private readonly engine: TradingEngine;
  private readonly config: ConfigurationService;

  constructor(tradingEngine: TradingEngine, config: ConfigurationService) {
    this.engine = tradingEngine;
    this.config = config;
  }

  async getOptimalGasPrice(urgency?: number): Promise<number> {
    const cfg = this.config.get();
    const { baseFee, priorityFee } = await this.engine.getGasPrice();
    const multiplier = urgency ?? cfg.gas.urgencyMultiplier;
    const raw = (baseFee + priorityFee) * multiplier;
    return this.clamp(raw, cfg.gas.minGasGwei, cfg.gas.maxGasGwei);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
