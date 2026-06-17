import type { Venue } from './index';

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly component: string,
    public readonly recoverable: boolean,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'AgentError';
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack ?? String(cause)}`;
    }
  }
}

export class ConfigValidationError extends AgentError {
  constructor(message: string, public readonly field: string) {
    super(message, 'ConfigurationService', false);
    this.name = 'ConfigValidationError';
  }
}

export class MarketDataError extends AgentError {
  constructor(
    message: string,
    public readonly pair: string,
    public readonly statusCode?: number
  ) {
    super(message, 'MarketDataService', true);
    this.name = 'MarketDataError';
  }
}

export class ExecutionError extends AgentError {
  constructor(
    message: string,
    public readonly orderId: string,
    public readonly errorType: 'gas' | 'slippage' | 'nonce' | 'rpc' | 'signing' | 'unknown'
  ) {
    super(message, 'ExecutionService', errorType !== 'signing');
    this.name = 'ExecutionError';
  }
}

export class RiskError extends AgentError {
  constructor(message: string, public readonly reason: string) {
    super(message, 'RiskManager', false);
    this.name = 'RiskError';
  }
}

export class StateError extends AgentError {
  constructor(message: string) {
    super(message, 'StateManager', true);
    this.name = 'StateError';
  }
}

export class EngineError extends AgentError {
  constructor(message: string, public readonly venue?: Venue) {
    super(message, 'TradingEngine', true);
    this.name = 'EngineError';
  }
}
