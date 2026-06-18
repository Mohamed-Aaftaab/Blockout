import { EventEmitter } from 'events';
import type {
  Config,
  MarketData,
  TradingSignal,
  MarketRegime,
  PoolHealth,
  Order,
  Transaction,
  TradeRecord,
  PerformanceMetrics,
  SystemState,
  Venue,
  CompetitionRegistration,
} from '../types/index';

// ─── Event Catalog ───────────────────────────────────────────────────────────

export interface AgentEvents {
  // Config
  'config:loaded':       [Config];
  'config:error':        [{ message: string }];

  // Market Data
  'market:data':         [{ pair: string; data: MarketData }];
  'market:error':        [{ pair: string; error: string; backoffMs: number }];
  'market:circuit_open': [{ pair: string; reason: string }];

  // Signals
  'signal:generated':    [TradingSignal];

  // Regime
  'regime:changed':      [{ pair: string; from: MarketRegime; to: MarketRegime; timestamp: number }];

  // Strategy
  'strategy:signal':      [{ signal: TradingSignal; strategy: string; order: Order }];
  'strategy:deactivated': [{ strategy: string; reason: string }];
  'strategy:weights':     [{ weights: Record<string, number>; reason: string }];

  // Pool
  'pool:approved':  [{ pair: string; health: PoolHealth }];
  'pool:rejected':  [{ pair: string; health: PoolHealth; reason: string }];

  // Risk
  'risk:position_sized':    [{ orderId: string; size: number; portfolioUsd: number }];
  'risk:position_rejected': [{ orderId: string; reason: string }];
  'risk:sl_triggered':      [{ positionId: string; price: number }];
  'risk:tp_triggered':      [{ positionId: string; price: number }];
  'risk:circuit_breaker':   [{ drawdownPct: number; portfolioUsd: number; timestamp: number }];
  'risk:slippage_warning':  [{ avgSlippagePct: number }];

  // MEV Defense
  'mev:chunk_submitted': [{ orderId: string; chunk: number; size: number; txHash: string }];
  'mev:chunk_failed':    [{ orderId: string; chunk: number; error: string }];
  'mev:twap_complete':   [{ orderId: string; totalChunks: number }];

  // Execution
  'execution:submitted': [{ txHash: string; orderId: string; gasPrice: number }];
  'execution:confirmed': [{ tx: Transaction }];
  'execution:failed':    [{ orderId: string; error: string; attempt: number }];

  // Engine
  'engine:rpc_failover': [{ from: string; to: string; blockNumber: number }];
  'engine:order_routed': [{ orderId: string; venue: Venue }];

  // State
  'state:saved':     [{ path: string; timestamp: number }];
  'state:loaded':    [{ state: SystemState }];
  'state:corrupted': [{ path: string; error: string }];

  // Analytics
  'analytics:trade_recorded':  [TradeRecord];
  'analytics:metrics_updated': [PerformanceMetrics];

  // Health
  'health:critical':                [{ component: string; message: string; timestamp: number }];
  'health:warning':                 [{ component: string; message: string }];
  'health:recovery':                [{ component: string; timestamp: number }];
  'health:shutdown':                [{ reason: string; timestamp: number }];
  'health:latency':                 [{ latencyMs: number; threshold: number }];
  'health:circuit_breaker_reset':   [{ timestamp: number }];

  // Registration
  'registration:submitted': [CompetitionRegistration];

  // Unused imports kept for completeness — Order is referenced elsewhere
  'engine:order_created': [{ order: Order }];
}

// ─── Typed EventBus ──────────────────────────────────────────────────────────

export class EventBus extends EventEmitter {
  emit<K extends keyof AgentEvents>(
    event: K,
    ...args: AgentEvents[K]
  ): boolean {
    return super.emit(event as string, ...args);
  }

  on<K extends keyof AgentEvents>(
    event: K,
    listener: (...args: AgentEvents[K]) => void
  ): this {
    return super.on(event as string, listener as (...args: unknown[]) => void);
  }

  once<K extends keyof AgentEvents>(
    event: K,
    listener: (...args: AgentEvents[K]) => void
  ): this {
    return super.once(event as string, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof AgentEvents>(
    event: K,
    listener: (...args: AgentEvents[K]) => void
  ): this {
    return super.off(event as string, listener as (...args: unknown[]) => void);
  }
}
