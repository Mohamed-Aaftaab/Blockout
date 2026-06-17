# Design Document: Sovereign BNB Agent

## Overview

The Sovereign BNB Agent is an institutional-grade, fully autonomous AI trading system for BNB Smart Chain. It integrates three sponsor technologies — CoinMarketCap Agent Hub (market intelligence), Trust Wallet Agent Kit (self-custody execution), and BNB AI Agent SDK (on-chain primitives) — into a cohesive event-driven TypeScript system that executes proven MEV-resistant strategies without human intervention.

The system implements four battle-tested strategies: Anaconda Squeeze TWAP (10-chunk MEV-resistant order splitting), Mid-Battle Scalping (ATH dip entry with defined risk-reward), Dead-Coin Filter (pool health analysis before execution), and Market Regime Detection (adaptive strategy selection across bull/bear/sideways conditions). It is designed for continuous operation with circuit breakers, atomic state persistence, RPC failover, and sub-3-second signal-to-transaction latency.

The architecture follows a strict dependency injection model with a typed event bus, zero `any` types, Zod runtime validation at all external boundaries, and atomic file writes for crash-safe state management.

---

## 1. High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SOVEREIGN BNB AGENT                                  │
│                                                                             │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────┐  │
│  │ ConfigurationSvc │    │  HealthMonitor   │    │   AnalyticsEngine    │  │
│  │  (Zod + env)     │    │  (circuit break) │    │  (PnL + Sharpe)      │  │
│  └────────┬─────────┘    └────────┬─────────┘    └──────────┬───────────┘  │
│           │                       │                          │              │
│           ▼               ┌───────▼──────────────────────────▼───────────┐  │
│  ┌────────────────────────┤              EventBus (typed)                 │  │
│  │                        └───────────────────────────────────────────────┘  │
│  │    MARKET LAYER                           EXECUTION LAYER               │
│  │  ┌───────────────┐                    ┌──────────────────────┐          │
│  │  │MarketDataSvc  │──OHLCV/indicators─▶│  SignalGenerator     │          │
│  │  │  (CMC API)    │                    │  (RSI/MACD/BB/whale) │          │
│  │  └───────────────┘                    └──────────┬───────────┘          │
│  │                                                   │ TradingSignal        │
│  │  ┌───────────────┐                    ┌──────────▼───────────┐          │
│  │  │RegimeDetector │──RegimeChange─────▶│  StrategyManager     │          │
│  │  │  (MA slope)   │                    │  (registry + weights)│          │
│  │  └───────────────┘                    └──────────┬───────────┘          │
│  │                                                   │ Order                │
│  │                                        ┌──────────▼───────────┐          │
│  │                                        │   PoolAnalyzer       │          │
│  │                                        │  (dead-coin filter)  │          │
│  │                                        └──────────┬───────────┘          │
│  │                                                   │ validated            │
│  │                                        ┌──────────▼───────────┐          │
│  │                                        │    RiskManager       │          │
│  │                                        │  (sizing + SL/TP)    │          │
│  │                                        └──────────┬───────────┘          │
│  │                                                   │ sized Order          │
│  │                                        ┌──────────▼───────────┐          │
│  │                                        │  MEVDefenseModule    │          │
│  │                                        │  (Anaconda Squeeze)  │          │
│  │                                        └──────────┬───────────┘          │
│  │                                                   │ TWAP chunks          │
│  │                                        ┌──────────▼───────────┐          │
│  │                                        │   GasOptimizer       │          │
│  │                                        │  (clamp formula)     │          │
│  │                                        └──────────┬───────────┘          │
│  │                                                   │ priced tx            │
│  │                                        ┌──────────▼───────────┐          │
│  │                                        │  ExecutionService    │          │
│  │                                        │  (TWAK sign + submit)│          │
│  │                                        └──────────┬───────────┘          │
│  │                                                   │                      │
│  │  ┌─────────────────────────────────────┐          │                      │
│  │  │         TradingEngine               │◀─────────┘                      │
│  │  │  (PancakeSwap + BSC Perps + RPC     │                                 │
│  │  │   failover + order routing)         │                                 │
│  │  └─────────────────────────────────────┘                                 │
│  │                                                                          │
│  │  ┌───────────────┐                                                       │
│  │  │  StateManager │  (atomic write + crash recovery)                      │
│  │  └───────────────┘                                                       │
└──┴──────────────────────────────────────────────────────────────────────────┘

External Dependencies:
  CMC Agent Hub ──────▶ MarketDataService  (REST + MCP)
  Trust Wallet Kit ───▶ ExecutionService   (@trustwallet/agent-sdk)
  BNB AI Agent SDK ───▶ TradingEngine      (@bnb-chain/agent-sdk)
```

---

## 2. Component Responsibility Table

| Component | Primary Responsibility | Key Dependencies | Emits Events |
|---|---|---|---|
| ConfigurationService | Load + validate all env vars via Zod schema | — | `config:loaded`, `config:error` |
| MarketDataService | CMC API polling, OHLCV cache, rate-limit backoff | ConfigSvc, EventBus | `market:data`, `market:error` |
| SignalGenerator | RSI/MACD/BB composite signal with 0.0–1.0 confidence | MarketDataSvc, ConfigSvc, EventBus | `signal:generated` |
| RegimeDetector | MA slope + BB width → bull/bear/sideways classification | MarketDataSvc, ConfigSvc, EventBus | `regime:changed` |
| StrategyManager | Registry, regime-based activation, weight tuning, conflict resolution | SignalGen, RegimeDetector, ConfigSvc, EventBus | `strategy:signal`, `strategy:deactivated` |
| MidBattleScalpingStrategy | ATH tracking, −35% dip entry, TWAP trigger | ConfigSvc, EventBus | `strategy:signal` |
| PoolAnalyzer | BNB SDK reserve fetch, volume/tx health checks | TradingEngine, ConfigSvc, EventBus | `pool:rejected`, `pool:approved` |
| RiskManager | Position sizing, max exposure, SL/TP loop, drawdown check | TradingEngine, ConfigSvc, EventBus | `risk:sl_triggered`, `risk:tp_triggered`, `risk:circuit_breaker`, `risk:position_rejected` |
| MEVDefenseModule | Anaconda Squeeze: randomized chunk sizes + intervals | ConfigSvc, EventBus | `mev:chunk_submitted`, `mev:chunk_failed` |
| GasOptimizer | BNB SDK gas fetch, urgency multiplier, min/max clamp | TradingEngine, ConfigSvc | — |
| ExecutionService | TWAK signing, BNB SDK submission, retry logic | TWAK, TradingEngine, GasOptimizer, ConfigSvc, EventBus | `execution:submitted`, `execution:confirmed`, `execution:failed` |
| TradingEngine | Order routing, PancakeSwap/BSC Perps, RPC failover | BNB SDK, ConfigSvc, EventBus | `engine:rpc_failover`, `engine:order_routed` |
| StateManager | Atomic file persistence, integrity check, crash recovery | ConfigSvc | `state:saved`, `state:loaded`, `state:corrupted` |
| AnalyticsEngine | Trade recording, PnL, Sharpe, win rate, latency tracking | StateManager, ConfigSvc, EventBus | `analytics:metrics_updated` |
| HealthMonitor | Circuit breaker, component recovery, emergency shutdown, uptime | All components, ConfigSvc, EventBus | `health:critical`, `health:recovery`, `health:shutdown` |

---

## 3. TypeScript Data Models

All shared types live in `src/types/index.ts`. No `any` is used anywhere.

```typescript
// ─── Primitives ────────────────────────────────────────────────────────────

export type MarketRegime = 'bull' | 'bear' | 'sideways';
export type OrderSide     = 'buy' | 'sell';
export type OrderType     = 'market' | 'limit' | 'twap';
export type Venue         = 'pancakeswap' | 'bsc_perpetuals';
export type TxStatus      = 'pending' | 'confirmed' | 'failed' | 'replaced';
export type CircuitState  = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type NetworkMode   = 'testnet' | 'mainnet';
export type LogLevel      = 'debug' | 'info' | 'warn' | 'error' | 'critical';

// ─── Result monad ──────────────────────────────────────────────────────────

export type Result<T, E extends Error = Error> =
  | { ok: true;  value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never>  { return { ok: true,  value }; }
export function err<E extends Error>(e: E): Result<never, E> { return { ok: false, error: e }; }

// ─── Config ────────────────────────────────────────────────────────────────

export interface RiskConfig {
  maxPositionPct:    number;   // 0–100, % of portfolio per position
  maxExposurePct:    number;   // 0–100, max total exposure
  stopLossPct:       number;   // 0–100
  takeProfitPct:     number;   // 0–100
  maxDrawdownPct:    number;   // 0–100
  minPortfolioUsd:   number;   // > 0
  leverageMultiplier:number;   // >= 1, BSC Perps only
}

export interface TwapConfig {
  thresholdUsd:    number;   // order size above which TWAP is used
  chunkCount:      number;   // e.g. 10
  minChunkPct:     number;   // e.g. 0.7
  maxChunkPct:     number;   // e.g. 1.3
  minIntervalMs:   number;   // e.g. 15000
  maxIntervalMs:   number;   // e.g. 45000
}

export interface GasConfig {
  urgencyMultiplier: number;   // e.g. 1.2
  minGasGwei:        number;
  maxGasGwei:        number;
  gasBumpPct:        number;   // % to increase on retry
  maxRetries:        number;
}

export interface SlippageConfig {
  defaultPct:   number;   // e.g. 0.5
  maxPct:       number;   // e.g. 3.0
  bumpPct:      number;   // e.g. 0.3 per retry
  maxRetries:   number;
}

export interface RegimeConfig {
  shortMaPeriod:       number;   // e.g. 20
  longMaPeriod:        number;   // e.g. 50
  slopeUpThreshold:    number;
  slopeDownThreshold:  number;
  bbWidthThreshold:    number;   // % for sideways detection
  updateIntervalSec:   number;   // e.g. 300
}

export interface SignalConfig {
  rsiOversold:         number;   // e.g. 30
  rsiOverbought:       number;   // e.g. 70
  whaleBuyThresholdUsd:number;
  exchangeInflowUsd:   number;
  weights: {
    rsi:       number;
    macd:      number;
    bollinger: number;
    whale:     number;
    onchain:   number;
  };
}

export interface ScalpingConfig {
  athDropPct:       number;   // e.g. 35
  positionSizeUsd:  number;
  takeProfitPct:    number;   // e.g. 15
  stopLossPct:      number;
}

export interface PoolConfig {
  minReserveUsd:     number;
  minVolToReservePct:number;
  minTxCount24h:     number;
  maxReserveDrainPct:number;
}

export interface NetworkConfig {
  mode:          NetworkMode;
  rpcEndpoints:  string[];       // ordered list
  rpcTimeoutMs:  number;
  rpcBackoffBase:number;
  rpcBackoffMax: number;
  chainId:       number;
}

export interface VenueConfig {
  pancakeswapRouter: string;     // contract address
  bscPerpsContract:  string;
  pancakeV3Factory:  string;
}

export interface AdaptiveConfig {
  enabled:          boolean;
  evaluationPeriodSec:number;
  weightAdjPct:     number;
  benchmarkReturn:  number;
}

export interface Config {
  // Credentials
  cmcApiKey:         string;
  twakAccessId:      string;
  twakHmacSecret:    string;

  // Trading
  tradingPairs:      string[];   // e.g. ['BNB/USDT', 'CAKE/USDT']
  network:           NetworkConfig;
  venue:             VenueConfig;

  // Strategy parameters
  risk:      RiskConfig;
  twap:      TwapConfig;
  gas:       GasConfig;
  slippage:  SlippageConfig;
  regime:    RegimeConfig;
  signal:    SignalConfig;
  scalping:  ScalpingConfig;
  pool:      PoolConfig;
  adaptive:  AdaptiveConfig;

  // Operations
  dataRefreshSec:      number;   // e.g. 60
  slMonitorMs:         number;   // e.g. 10000
  drawdownCheckSec:    number;   // e.g. 60
  shutdownPollMs:      number;   // e.g. 5000
  metricsCalcSec:      number;   // e.g. 300
  latencyWarningMs:    number;   // e.g. 5000
  txTimeoutSec:        number;   // e.g. 120
  latencyTargetMs:     number;   // e.g. 3000
  statePersistSec:     number;   // e.g. 5
  stateFilePath:       string;
  analyticsFilePath:   string;
  shutdownSignalFile:  string;
  logLevel:            LogLevel;
  tradingHoursStart:   string;   // 'HH:MM' UTC
  tradingHoursEnd:     string;

  // Backtest / demo
  backtestMode:    boolean;
  backtestFrom:    string;       // ISO date
  backtestTo:      string;
  backtestCapital: number;
  demoMode:        boolean;
  demoDuration:    number;
  demoCapital:     number;
}
```

---

```typescript
// ─── Market Data ───────────────────────────────────────────────────────────

export interface OHLCVCandle {
  timestamp:  number;   // Unix ms
  open:       number;
  high:       number;
  low:        number;
  close:      number;
  volume:     number;
}

export interface TechnicalIndicators {
  rsi14:          number;
  macdLine:       number;
  macdSignal:     number;
  macdHistogram:  number;
  bbUpper:        number;
  bbMiddle:       number;
  bbLower:        number;
  ma20:           number;
  ma50:           number;
  bbWidth:        number;   // (upper - lower) / middle, as %
}

export interface OnChainMetrics {
  whaleNetFlow24h:    number;   // USD, positive = accumulation
  exchangeInflow24h:  number;   // USD
  exchangeOutflow24h: number;   // USD
  largeTransactions:  number;   // count > $100k
}

export interface MarketData {
  pair:         string;
  price:        number;
  volume24h:    number;
  marketCap:    number;
  ath:          number;   // tracked internally; updated from price history
  candles:      OHLCVCandle[];
  indicators:   TechnicalIndicators;
  onChain:      OnChainMetrics;
  fetchedAt:    number;   // Unix ms
}

// ─── Signals ───────────────────────────────────────────────────────────────

export type SignalType =
  | 'rsi_oversold' | 'rsi_overbought'
  | 'macd_bullish' | 'macd_bearish'
  | 'bb_lower' | 'bb_upper'
  | 'whale_accumulation' | 'exchange_inflow'
  | 'scalping_entry' | 'composite';

export interface TradingSignal {
  id:          string;   // uuid
  pair:        string;
  type:        SignalType;
  side:        OrderSide;
  confidence:  number;   // 0.0–1.0
  indicators:  TechnicalIndicators;
  onChain:     OnChainMetrics;
  regime:      MarketRegime;
  strategy:    string;   // strategy name
  timestamp:   number;   // Unix ms
}

// ─── Pool Health ───────────────────────────────────────────────────────────

export interface PoolHealth {
  pair:              string;
  token0Reserve:     number;   // USD
  token1Reserve:     number;   // USD
  totalReserveUsd:   number;
  volume24h:         number;
  txCount24h:        number;
  reserveDrainPct:   number;   // % change in reserve over 24h
  healthy:           boolean;
  rejectionReason:   string | null;
  fetchedAt:         number;
}

// ─── Positions & Orders ────────────────────────────────────────────────────

export interface Position {
  id:           string;   // uuid
  pair:         string;
  side:         OrderSide;
  entryPrice:   number;
  size:         number;   // USD
  stopLoss:     number;
  takeProfit:   number;
  leverage:     number;   // 1 for spot
  strategy:     string;
  venue:        Venue;
  openedAt:     number;   // Unix ms
  txHash:       string;
}

export interface TwapParams {
  totalSize:    number;
  chunkSizes:   number[];
  intervals:    number[];   // ms between chunks
  submittedAt:  number[];   // Unix ms per chunk (filled as executed)
  chunksTotal:  number;
  chunksDone:   number;
}

export interface Order {
  id:          string;   // uuid
  pair:        string;
  type:        OrderType;
  side:        OrderSide;
  size:        number;   // USD
  venue:       Venue;
  slippage:    number;   // %
  twap:        TwapParams | null;
  createdAt:   number;
  signalId:    string;
}

// ─── Transactions ──────────────────────────────────────────────────────────

export interface Transaction {
  hash:           string;
  orderId:        string;
  status:         TxStatus;
  gasPrice:       number;   // Gwei
  gasLimit:       number;
  gasUsed:        number | null;
  actualSlippage: number | null;   // % filled after confirmation
  submittedAt:    number;
  confirmedAt:    number | null;
  blockNumber:    number | null;
  error:          string | null;
}

// ─── Trade Records ─────────────────────────────────────────────────────────

export interface TradeRecord {
  id:           string;
  position:     Position;
  closePrice:   number;
  closedAt:     number;
  exitReason:   'stop_loss' | 'take_profit' | 'manual' | 'circuit_breaker' | 'emergency';
  pnlUsd:       number;
  pnlPct:       number;
  holdMs:       number;
  transactions: Transaction[];
  signalToTxMs: number;   // latency: signal generation → first tx submission
}

// ─── System State (persisted) ──────────────────────────────────────────────

export interface SystemState {
  version:              string;   // semver for migration
  openPositions:        Position[];
  pendingTransactions:  Transaction[];
  drawdownBaseline:     number;   // portfolio USD at last reset
  circuitBreakerActive: boolean;
  emergencyShutdown:    boolean;
  savedAt:              number;   // Unix ms
  checksum:             string;   // SHA-256 of JSON for integrity
}

// ─── Performance Metrics ───────────────────────────────────────────────────

export interface PerformanceMetrics {
  // PnL
  totalPnlUsd:      number;
  totalPnlPct:      number;
  dailyReturns:     number[];   // last 30 days, as %
  sharpeRatio:      number;
  maxDrawdownPct:   number;

  // Trade quality
  totalTrades:      number;
  winningTrades:    number;
  winRate:          number;   // 0.0–1.0
  avgPnlUsd:        number;

  // Execution quality
  avgSlippagePct:   number;
  recentSlippage:   number[];   // last 100 trades
  latencyAvgMs:     number;
  latencyMedianMs:  number;
  latencyP95Ms:     number;

  // Per-pair breakdown
  byPair:    Record<string, PairMetrics>;
  byVenue:   Record<Venue, VenueMetrics>;
  byStrategy:Record<string, StrategyMetrics>;

  calculatedAt: number;
}

export interface PairMetrics {
  pair:       string;
  totalTrades:number;
  winRate:    number;
  pnlUsd:     number;
}

export interface VenueMetrics {
  venue:           Venue;
  totalTrades:     number;
  avgSlippagePct:  number;
  pnlUsd:          number;
}

export interface StrategyMetrics {
  strategy:    string;
  totalTrades: number;
  winRate:     number;
  pnlUsd:      number;
  weight:      number;   // current allocation weight 0–1
}
```

---

## 4. Event Catalog

All events flow through a strongly-typed `EventBus` extending Node.js `EventEmitter`.

```typescript
// src/events/EventBus.ts

export interface AgentEvents {
  // ── Config ────────────────────────────────────
  'config:loaded':       Config;
  'config:error':        { message: string };

  // ── Market Data ───────────────────────────────
  'market:data':         { pair: string; data: MarketData };
  'market:error':        { pair: string; error: string; backoffMs: number };
  'market:circuit_open': { pair: string; reason: string };

  // ── Signals ───────────────────────────────────
  'signal:generated':    TradingSignal;

  // ── Regime ────────────────────────────────────
  'regime:changed':      { pair: string; from: MarketRegime; to: MarketRegime; timestamp: number };

  // ── Strategy ──────────────────────────────────
  'strategy:signal':     { signal: TradingSignal; strategy: string };
  'strategy:deactivated':{ strategy: string; reason: string };
  'strategy:weights':    { weights: Record<string, number>; reason: string };

  // ── Pool ──────────────────────────────────────
  'pool:approved':       { pair: string; health: PoolHealth };
  'pool:rejected':       { pair: string; health: PoolHealth; reason: string };

  // ── Risk ──────────────────────────────────────
  'risk:position_sized': { orderId: string; size: number; portfolioUsd: number };
  'risk:position_rejected': { orderId: string; reason: string };
  'risk:sl_triggered':   { positionId: string; price: number };
  'risk:tp_triggered':   { positionId: string; price: number };
  'risk:circuit_breaker':{ drawdownPct: number; portfolioUsd: number; timestamp: number };
  'risk:slippage_warning':{ avgSlippagePct: number };

  // ── MEV Defense ───────────────────────────────
  'mev:chunk_submitted': { orderId: string; chunk: number; size: number; txHash: string };
  'mev:chunk_failed':    { orderId: string; chunk: number; error: string };
  'mev:twap_complete':   { orderId: string; totalChunks: number };

  // ── Execution ─────────────────────────────────
  'execution:submitted': { txHash: string; orderId: string; gasPrice: number };
  'execution:confirmed': { tx: Transaction };
  'execution:failed':    { orderId: string; error: string; attempt: number };

  // ── Engine ────────────────────────────────────
  'engine:rpc_failover': { from: string; to: string; blockNumber: number };
  'engine:order_routed': { orderId: string; venue: Venue };

  // ── State ─────────────────────────────────────
  'state:saved':         { path: string; timestamp: number };
  'state:loaded':        { state: SystemState };
  'state:corrupted':     { path: string; error: string };

  // ── Analytics ─────────────────────────────────
  'analytics:trade_recorded':   TradeRecord;
  'analytics:metrics_updated':  PerformanceMetrics;

  // ── Health ────────────────────────────────────
  'health:critical':    { component: string; message: string; timestamp: number };
  'health:warning':     { component: string; message: string };
  'health:recovery':    { component: string; timestamp: number };
  'health:shutdown':    { reason: string; timestamp: number };
  'health:latency':     { latencyMs: number; threshold: number };
}

export class EventBus extends TypedEventEmitter<AgentEvents> {}
```

---

## 5. Class Signatures with Constructor Dependencies

```typescript
// src/config/index.ts
class ConfigurationService {
  constructor()  // no dependencies — bootstrapped first
  load(): Result<Config, ConfigValidationError>
  get(): Config                              // throws if not loaded
  getSchema(): ZodType<Config>               // for documentation
}

// src/market/MarketDataService.ts
class MarketDataService {
  constructor(config: ConfigurationService, bus: EventBus)
  start(): Promise<void>
  stop(): void
  getLatestData(pair: string): MarketData | null
  getHistory(pair: string, limit: number): OHLCVCandle[]
}

// src/market/SignalGenerator.ts
class SignalGenerator {
  constructor(marketData: MarketDataService, config: ConfigurationService, bus: EventBus)
  generateSignals(pair: string, data: MarketData): TradingSignal[]
  computeCompositeSignal(signals: TradingSignal[]): TradingSignal
  private computeRSISignal(indicators: TechnicalIndicators, pair: string): TradingSignal | null
  private computeMACDSignal(indicators: TechnicalIndicators, pair: string): TradingSignal | null
  private computeBollingerSignal(indicators: TechnicalIndicators, pair: string, price: number): TradingSignal | null
  private computeWhaleSignal(onchain: OnChainMetrics, pair: string): TradingSignal | null
}

// src/market/RegimeDetector.ts
class RegimeDetector {
  constructor(marketData: MarketDataService, config: ConfigurationService, bus: EventBus)
  start(): void
  stop(): void
  detectRegime(pair: string, data: MarketData): MarketRegime
  getCurrentRegime(pair: string): MarketRegime
  private calcMASlope(values: number[], period: number): number
}

// src/strategies/IStrategy.ts
interface IStrategy {
  readonly name: string
  readonly supportedRegimes: MarketRegime[]
  weight: number
  isActive: boolean
  onSignal(signal: TradingSignal, regime: MarketRegime): Order | null
  onMarketData(data: MarketData): void
}

// src/strategies/StrategyManager.ts
class StrategyManager {
  constructor(
    signalGen: SignalGenerator,
    regimeDetector: RegimeDetector,
    config: ConfigurationService,
    bus: EventBus
  )
  registerStrategy(strategy: IStrategy): void
  start(): void
  stop(): void
  getActiveStrategies(): IStrategy[]
  getStrategyWeights(): Record<string, number>
  evaluateAndAdjustWeights(): void
  private resolveConflict(orders: Order[]): Order
}

// src/strategies/MidBattleScalpingStrategy.ts
class MidBattleScalpingStrategy implements IStrategy {
  constructor(config: ConfigurationService, bus: EventBus)
  readonly name = 'MidBattleScalping'
  readonly supportedRegimes: MarketRegime[] = ['bull', 'bear', 'sideways']
  weight: number
  isActive: boolean
  onSignal(signal: TradingSignal, regime: MarketRegime): Order | null
  onMarketData(data: MarketData): void
  private updateATH(pair: string, price: number): void
  private isDipConditionMet(pair: string, price: number): boolean
}

// src/risk/PoolAnalyzer.ts
class PoolAnalyzer {
  constructor(tradingEngine: TradingEngine, config: ConfigurationService, bus: EventBus)
  analyzePool(pair: string): Promise<PoolHealth>
  isHealthy(health: PoolHealth): boolean
}

// src/risk/RiskManager.ts
class RiskManager {
  constructor(tradingEngine: TradingEngine, config: ConfigurationService, bus: EventBus)
  start(): void
  stop(): void
  calculatePositionSize(portfolioUsd: number, pair: string): Result<number, RiskError>
  validateNewPosition(order: Order, openPositions: Position[]): Result<Order, RiskError>
  onPositionOpened(position: Position): void
  onPositionClosed(positionId: string): void
  checkDrawdown(): Promise<void>
  private monitorStopLossAndTakeProfit(): Promise<void>
  triggerCircuitBreaker(reason: string): void
  resetCircuitBreaker(): void
}

// src/execution/MEVDefenseModule.ts
class MEVDefenseModule {
  constructor(config: ConfigurationService, bus: EventBus)
  shouldSplit(order: Order): boolean
  buildTwapPlan(order: Order): TwapParams
  executeTwap(
    order: Order,
    twap: TwapParams,
    submitFn: (chunk: Order) => Promise<Transaction>
  ): Promise<Transaction[]>
  private randomBetween(min: number, max: number): number
  private normalizeSizes(raw: number[], total: number): number[]
}

// src/execution/GasOptimizer.ts
class GasOptimizer {
  constructor(tradingEngine: TradingEngine, config: ConfigurationService)
  getOptimalGasPrice(urgency?: number): Promise<number>   // returns Gwei
  private clamp(value: number, min: number, max: number): number
}

// src/execution/ExecutionService.ts
class ExecutionService {
  constructor(
    tradingEngine: TradingEngine,
    gasOptimizer: GasOptimizer,
    config: ConfigurationService,
    bus: EventBus
  )
  executeOrder(order: Order): Promise<Result<Transaction, ExecutionError>>
  executeChunk(chunk: Order, gasPrice: number): Promise<Result<Transaction, ExecutionError>>
  awaitConfirmation(txHash: string, timeoutMs: number): Promise<Result<Transaction, ExecutionError>>
  private buildSwapTx(order: Order, gasPrice: number): Promise<UnsignedTransaction>
  private signAndSubmit(tx: UnsignedTransaction): Promise<string>   // returns txHash
}

// src/execution/TradingEngine.ts
class TradingEngine {
  constructor(config: ConfigurationService, bus: EventBus)
  initialize(): Promise<void>
  routeOrder(order: Order): Promise<Result<Transaction, EngineError>>
  getGasPrice(): Promise<{ baseFee: number; priorityFee: number }>
  getPoolReserves(pair: string): Promise<PoolReserves>
  getCurrentPrice(pair: string): Promise<number>
  getBlockNumber(): Promise<number>
  getPortfolioValue(): Promise<number>
  failoverRPC(): Promise<boolean>
  stop(): void
}

// src/state/StateManager.ts
class StateManager {
  constructor(config: ConfigurationService, bus: EventBus)
  saveState(state: SystemState): Promise<void>
  loadState(): Promise<Result<SystemState, StateError>>
  private atomicWrite(path: string, content: string): Promise<void>
  private verifyChecksum(state: SystemState): boolean
  private computeChecksum(state: Omit<SystemState, 'checksum'>): string
}

// src/analytics/AnalyticsEngine.ts
class AnalyticsEngine {
  constructor(stateManager: StateManager, config: ConfigurationService, bus: EventBus)
  start(): void
  stop(): void
  recordTrade(record: TradeRecord): void
  getMetrics(): PerformanceMetrics
  calculateSharpe(returns: number[]): number
  generateReport(type: 'shutdown' | 'backtest' | 'demo'): string
  private calcWinRate(records: TradeRecord[]): number
  private calcP95(latencies: number[]): number
}

// src/health/HealthMonitor.ts
class HealthMonitor {
  constructor(config: ConfigurationService, bus: EventBus)
  start(): void
  stop(): void
  getCircuitState(): CircuitState
  getUptime(): number   // seconds
  triggerEmergencyShutdown(reason: string): Promise<void>
  private pollShutdownSignal(): void
  private checkInitTimeout(component: string, timeoutMs: number): void
  private attemptRecovery(component: string): Promise<boolean>
}
```

---

## 6. Configuration Schema (Zod + Environment Variables)

```typescript
// src/config/schema.ts
import { z } from 'zod';

const NetworkConfigSchema = z.object({
  mode:           z.enum(['testnet', 'mainnet']).default('testnet'),
  rpcEndpoints:   z.array(z.string().url()).min(1),
  rpcTimeoutMs:   z.number().int().min(1000).max(30000).default(10000),
  rpcBackoffBase: z.number().min(1).max(10).default(2),
  rpcBackoffMax:  z.number().min(10).max(120).default(60),
  chainId:        z.number().int().positive(),
});

const RiskConfigSchema = z.object({
  maxPositionPct:     z.number().min(0.1).max(20),
  maxExposurePct:     z.number().min(1).max(100),
  stopLossPct:        z.number().min(0.1).max(50),
  takeProfitPct:      z.number().min(0.1).max(200),
  maxDrawdownPct:     z.number().min(1).max(50),
  minPortfolioUsd:    z.number().min(10),
  leverageMultiplier: z.number().min(1).max(20),
});

const TwapConfigSchema = z.object({
  thresholdUsd:  z.number().min(100),
  chunkCount:    z.number().int().min(2).max(20).default(10),
  minChunkPct:   z.number().min(0.5).max(1.0).default(0.7),
  maxChunkPct:   z.number().min(1.0).max(2.0).default(1.3),
  minIntervalMs: z.number().min(5000).max(60000).default(15000),
  maxIntervalMs: z.number().min(5000).max(300000).default(45000),
});

const GasConfigSchema = z.object({
  urgencyMultiplier: z.number().min(1.0).max(3.0).default(1.2),
  minGasGwei:        z.number().min(1).max(100),
  maxGasGwei:        z.number().min(1).max(1000),
  gasBumpPct:        z.number().min(1).max(50).default(20),
  maxRetries:        z.number().int().min(1).max(10).default(3),
});

export const ConfigSchema = z.object({
  cmcApiKey:        z.string().min(32),
  twakAccessId:     z.string().min(8),
  twakHmacSecret:   z.string().min(16),
  tradingPairs:     z.array(z.string().regex(/^[A-Z]+\/[A-Z]+$/)).min(1),
  network:          NetworkConfigSchema,
  // ... (all nested schemas follow same pattern)
  stateFilePath:    z.string().default('./data/state.json'),
  analyticsFilePath:z.string().default('./data/analytics.json'),
  shutdownSignalFile:z.string().default('./SHUTDOWN'),
  logLevel:         z.enum(['debug','info','warn','error','critical']).default('info'),
  tradingHoursStart:z.string().regex(/^\d{2}:\d{2}$/).default('00:00'),
  tradingHoursEnd:  z.string().regex(/^\d{2}:\d{2}$/).default('23:59'),
  backtestMode:     z.boolean().default(false),
  demoMode:         z.boolean().default(false),
});
```

### Environment Variable Reference

| Variable | Type | Range / Format | Required | Default | Description |
|---|---|---|---|---|---|
| `CMC_API_KEY` | string | min 32 chars | ✓ | — | CoinMarketCap Pro API key |
| `TWAK_ACCESS_ID` | string | min 8 chars | ✓ | — | Trust Wallet Agent Kit access ID |
| `TWAK_HMAC_SECRET` | string | min 16 chars | ✓ | — | TWAK HMAC signing secret |
| `NETWORK_MODE` | enum | `testnet` \| `mainnet` | — | `testnet` | Blockchain network to use |
| `RPC_ENDPOINTS` | string | comma-separated URLs | ✓ | — | Ordered BSC RPC endpoints |
| `CHAIN_ID` | integer | 56 or 97 | ✓ | — | 56=mainnet, 97=testnet |
| `TRADING_PAIRS` | string | comma-sep `A/B` | ✓ | — | e.g. `BNB/USDT,CAKE/USDT` |
| `MAX_POSITION_PCT` | float | 0.1–20 | — | 5 | Max portfolio % per position |
| `MAX_EXPOSURE_PCT` | float | 1–100 | — | 30 | Max total portfolio exposure |
| `STOP_LOSS_PCT` | float | 0.1–50 | — | 5 | Stop-loss % below entry |
| `TAKE_PROFIT_PCT` | float | 0.1–200 | — | 15 | Take-profit % above entry |
| `MAX_DRAWDOWN_PCT` | float | 1–50 | — | 20 | Max drawdown before circuit breaker |
| `MIN_PORTFOLIO_USD` | float | ≥10 | — | 100 | Min portfolio to allow new trades |
| `TWAP_THRESHOLD_USD` | float | ≥100 | — | 1000 | Order size threshold for TWAP |
| `TWAP_CHUNK_COUNT` | integer | 2–20 | — | 10 | Number of TWAP chunks |
| `TWAP_MIN_INTERVAL_MS` | integer | 5000–60000 | — | 15000 | Min delay between chunks |
| `TWAP_MAX_INTERVAL_MS` | integer | 5000–300000 | — | 45000 | Max delay between chunks |
| `GAS_URGENCY_MULTIPLIER` | float | 1.0–3.0 | — | 1.2 | Gas price urgency multiplier |
| `MIN_GAS_GWEI` | float | 1–100 | — | 3 | Minimum gas price in Gwei |
| `MAX_GAS_GWEI` | float | 1–1000 | — | 100 | Maximum gas price in Gwei |
| `DEFAULT_SLIPPAGE_PCT` | float | 0.1–5 | — | 0.5 | Default slippage tolerance |
| `MAX_SLIPPAGE_PCT` | float | 0.5–10 | — | 3.0 | Maximum allowed slippage |
| `RSI_OVERSOLD` | integer | 10–40 | — | 30 | RSI buy threshold |
| `RSI_OVERBOUGHT` | integer | 60–90 | — | 70 | RSI sell threshold |
| `SCALPING_ATH_DROP_PCT` | float | 10–80 | — | 35 | ATH dip % to trigger scalping |
| `SCALPING_TP_PCT` | float | 1–100 | — | 15 | Scalping take-profit % |
| `MIN_POOL_RESERVE_USD` | float | ≥1000 | — | 50000 | Min pool reserve to trade |
| `MIN_VOL_TO_RESERVE_PCT` | float | 0.1–100 | — | 5 | Min vol/reserve ratio |
| `MIN_TX_COUNT_24H` | integer | ≥1 | — | 100 | Min 24h tx count |
| `PANCAKESWAP_ROUTER` | string | 0x… | ✓ | — | PancakeSwap V2/V3 router address |
| `BSC_PERPS_CONTRACT` | string | 0x… | ✓ | — | BSC Perpetuals contract address |
| `LEVERAGE_MULTIPLIER` | float | 1–20 | — | 1 | Leverage for BSC Perps |
| `SHUTDOWN_SIGNAL_FILE` | string | file path | — | `./SHUTDOWN` | Touch this file to trigger shutdown |
| `STATE_FILE_PATH` | string | file path | — | `./data/state.json` | State persistence file |
| `LOG_LEVEL` | enum | `debug`…`critical` | — | `info` | Log verbosity |
| `BACKTEST_MODE` | boolean | `true`\|`false` | — | `false` | Enable backtesting mode |
| `DEMO_MODE` | boolean | `true`\|`false` | — | `false` | Enable demo mode on testnet |

---

## 7. SDK Integration Details

### 7.1 CoinMarketCap Agent Hub

```typescript
// Base URL
const CMC_BASE = 'https://pro-api.coinmarketcap.com';

// Endpoints used
const ENDPOINTS = {
  ohlcv:       '/v2/cryptocurrency/ohlcv/historical',
  quotes:      '/v2/cryptocurrency/quotes/latest',
  indicators:  '/v3/cryptocurrency/technical-indicator/latest',
  onchain:     '/v1/cryptocurrency/market-pairs/latest',  // whale/exchange flows
} as const;

// Auth header
headers['X-CMC_PRO_API_KEY'] = config.cmcApiKey;

// Rate limit handling
// Free: 333 calls/day  |  Basic: 10k/month  |  Pro: 333k/month
// On 429: exponential backoff min 5s, max 300s
async function fetchWithBackoff<T>(
  url: string,
  params: Record<string, string>,
  attempt = 0
): Promise<T> {
  try {
    return await httpGet<T>(url, params);
  } catch (e) {
    if (isRateLimitError(e) && attempt < MAX_ATTEMPTS) {
      const delay = Math.min(5000 * Math.pow(2, attempt), 300_000);
      await sleep(delay);
      return fetchWithBackoff(url, params, attempt + 1);
    }
    throw e;
  }
}

// OHLCV request shape
interface CMCOHLCVRequest {
  id:          string;    // CMC coin ID or symbol
  time_start:  string;    // ISO 8601
  time_end:    string;
  interval:    '1m' | '5m' | '15m' | '1h' | '1d';
  count:       number;
  convert:     'USD';
}

// MCP tools (where available via Agent Hub)
// Tools: get_price, get_trending, get_fear_greed_index, get_whale_alerts
// Accessed via standard MCP protocol over HTTP SSE
```

### 7.2 Trust Wallet Agent Kit (TWAK)

```typescript
import { AgentKit } from '@trustwallet/agent-sdk';

// Initialization
const wallet = new AgentKit({
  accessId:   config.twakAccessId,
  hmacSecret: config.twakHmacSecret,
  network:    config.network.mode,   // 'testnet' | 'mainnet'
  autonomous: true,                  // no per-tx approval prompts
});

await wallet.initialize();

// Key operations
const balance:   WalletBalance = await wallet.getBalance();       // USD + token breakdown
const signed:    string        = await wallet.signTransaction(tx); // returns signed hex
const submitted: string        = await wallet.broadcastTransaction(signedHex);

// Balance type (inferred from TWAK SDK)
interface WalletBalance {
  totalUsd:  number;
  tokens:    Array<{ symbol: string; amount: number; valueUsd: number }>;
}
```

### 7.3 BNB AI Agent SDK

```typescript
import { BNBAgentProvider } from '@bnb-chain/agent-sdk';

// Initialization
const provider = new BNBAgentProvider({
  rpcUrl:  config.network.rpcEndpoints[0],
  chainId: config.network.chainId,
});

await provider.connect();

// Gas
const gasData = await provider.getGasPrice();
// → { baseFee: number, priorityFee: number }  (Gwei)

// Pool reserves (for dead-coin filter)
const reserves = await provider.getPoolReserves(pairAddress);
// → { token0: string, token1: string, reserve0: bigint, reserve1: bigint }

// PancakeSwap swap construction
const swapTx = await provider.buildPancakeSwapTx({
  tokenIn:  '0x...',
  tokenOut: '0x...',
  amountIn: amountWei,
  slippage: config.slippage.defaultPct,
  deadline: Math.floor(Date.now() / 1000) + 300,
  router:   config.venue.pancakeswapRouter,
});

// BSC Perpetuals position
const perpTx = await provider.buildPerpPosition({
  market:    config.venue.bscPerpsContract,
  side:      'long' | 'short',
  size:      sizeUsd,
  leverage:  config.risk.leverageMultiplier,
  slippage:  config.slippage.defaultPct,
});

// RPC failover
async function failoverRPC(): Promise<boolean> {
  const endpoints = config.network.rpcEndpoints;
  let backoffMs = config.network.rpcBackoffBase * 1000;
  for (const endpoint of endpoints.slice(1)) {
    await sleep(backoffMs);
    try {
      await provider.reconnect(endpoint);
      const block = await provider.getBlockNumber();
      bus.emit('engine:rpc_failover', { from: current, to: endpoint, blockNumber: block });
      return true;
    } catch { backoffMs = Math.min(backoffMs * 2, config.network.rpcBackoffMax * 1000); }
  }
  return false;
}
```

---

## 8. State Persistence Schema

The `SystemState` object is persisted to `STATE_FILE_PATH` using an atomic write pattern.

```typescript
// Atomic write implementation
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, path);   // atomic on POSIX; near-atomic on Windows
}

// State file format (JSON, pretty-printed for debuggability)
const stateOnDisk: SystemState = {
  version:              '1.0.0',
  openPositions:        [...],
  pendingTransactions:  [...],
  drawdownBaseline:     5000.00,
  circuitBreakerActive: false,
  emergencyShutdown:    false,
  savedAt:              1700000000000,
  checksum:             'sha256:abc123...',   // SHA-256 of everything except checksum field
};

// Recovery on startup
async function loadAndVerify(): Promise<Result<SystemState, StateError>> {
  try {
    const raw  = await fs.readFile(path, 'utf8');
    const json = JSON.parse(raw) as unknown;
    const state = SystemStateSchema.parse(json);    // Zod validation
    if (!verifyChecksum(state)) {
      return err(new StateError('Checksum mismatch — state may be corrupted'));
    }
    return ok(state);
  } catch (e) {
    return err(new StateError(`Failed to load state: ${String(e)}`));
  }
}
```

### State Migration Strategy

State files include a `version` field. When a version mismatch is detected:
1. Log a migration warning
2. Apply forward-migration transforms (defined in `src/state/migrations/`)
3. Save migrated state before proceeding

---

## 9. Error Handling Strategy

### 9.1 Error Type Hierarchy

```typescript
// src/types/errors.ts

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly component: string,
    public readonly recoverable: boolean,
    public readonly cause?: Error
  ) { super(message); this.name = 'AgentError'; }
}

export class ConfigValidationError extends AgentError {
  constructor(message: string, public readonly field: string) {
    super(message, 'ConfigurationService', false);
    this.name = 'ConfigValidationError';
  }
}

export class MarketDataError extends AgentError {
  constructor(message: string, public readonly pair: string, public readonly statusCode?: number) {
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
```

### 9.2 Retry with Exponential Backoff

```typescript
// src/utils/backoff.ts

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts: number;
    baseMs:      number;
    maxMs:       number;
    shouldRetry?: (err: unknown) => boolean;
  }
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt >= options.maxAttempts) throw e;
      if (options.shouldRetry && !options.shouldRetry(e)) throw e;
      const delay = Math.min(options.baseMs * Math.pow(2, attempt - 1), options.maxMs);
      await sleep(delay + Math.random() * 1000); // jitter
    }
  }
}
```

### 9.3 Circuit Breaker States

```
  ┌──────────┐ failure threshold      ┌──────────┐
  │  CLOSED  │──────────────────────▶ │   OPEN   │
  │ (normal) │                        │ (halted) │
  └──────────┘                        └────┬─────┘
       ▲                                   │ cooldown elapsed
       │ success                           ▼
       │                            ┌──────────────┐
       └────────────────────────────│  HALF_OPEN   │
                                    │ (probe mode) │
                                    └──────────────┘
```

- **CLOSED → OPEN**: drawdown breached, max retries exceeded, all RPCs down, or manual trigger
- **OPEN → HALF_OPEN**: after 5-minute cooldown period (configurable)
- **HALF_OPEN → CLOSED**: one successful trade completes without error
- **HALF_OPEN → OPEN**: any failure reverts to OPEN, resets cooldown timer

### 9.4 Transaction Retry Logic

```typescript
// On insufficient gas error:
//   newGasPrice = Math.min(prevGasPrice * (1 + config.gas.gasBumpPct/100), config.gas.maxGasGwei)
//   retry up to config.gas.maxRetries times

// On slippage error:
//   newSlippage = Math.min(prevSlippage + config.slippage.bumpPct, config.slippage.maxPct)
//   retry up to config.slippage.maxRetries times

// On nonce error:
//   fetch current nonce from chain; do NOT increment manually
//   retry once

// On all other errors:
//   emit 'execution:failed' to RiskManager and AnalyticsEngine
//   do NOT retry
```

---

## 10. Startup Sequence

```
Startup Sequence (index.ts → bootstrap)
─────────────────────────────────────────────────────────────────────────────

[1] ConfigurationService.load()
    │ Zod validate all env vars
    │ IF validation fails → log errors → process.exit(1)
    ▼
[2] EventBus instantiation
    ▼
[3] StateManager.loadState()
    │ Read + verify checksum
    │ IF corrupted → log warning → start fresh
    ▼
[4] TradingEngine.initialize()            ┐
    MarketDataService.start()             │  parallel (Promise.all)
    ExecutionService.initialize(TWAK)     │
    └──────────────────────────────────── ┘
    │ Each must complete within 30s or HealthMonitor triggers shutdown
    ▼
[5] HealthMonitor.start()
    │ Register all components for heartbeat monitoring
    ▼
[6] AnalyticsEngine.start()
    RegimeDetector.start()
    RiskManager.start()
    ─── timers initialized:
        • SL/TP monitor loop (10s)
        • drawdown check (60s)
        • metrics calc (300s)
        • regime update (300s)
        • emergency poll (5s)
    ▼
[7] IF state had open positions:
    │   RiskManager.resumePositions(state.openPositions)
    │   ExecutionService.reconcilePending(state.pendingTransactions)
    ▼
[8] StrategyManager.start()
    │ Register: MidBattleScalpingStrategy, MomentumStrategy,
    │           MeanReversionStrategy, RangeStrategy
    │ Set initial weights from config
    ▼
[9] HealthMonitor logs: "NETWORK_MODE=testnet|mainnet" (prominent)
    ▼
[10] System READY — event loop active
     All components now consume EventBus events
```

---

## 11. Position Lifecycle Flow

```
Signal Generated (SignalGenerator)
        │
        ▼
Pool Health Check (PoolAnalyzer)
        │ REJECTED ──────────────▶ log rejection + pool metrics → STOP
        │ APPROVED
        ▼
Risk Validation (RiskManager)
        │ REJECTED (exposure/portfolio) ──▶ emit risk:position_rejected → STOP
        │ APPROVED + sized
        ▼
MEV Defense Decision (MEVDefenseModule)
        │ size > TWAP_THRESHOLD?
        ├── YES → buildTwapPlan() → N random chunks + intervals
        └── NO  → single order
        ▼
Gas Pricing (GasOptimizer)
        │ getOptimalGasPrice()
        │ clamp((baseFee + priorityFee) × urgency, min, max)
        ▼
Transaction Construction (ExecutionService)
        │ buildSwapTx() with slippage + gas + deadline
        ▼
TWAK Signing (ExecutionService → @trustwallet/agent-sdk)
        │ wallet.signTransaction(tx)
        ▼
BNB SDK Submission (ExecutionService → @bnb-chain/agent-sdk)
        │ provider.sendRawTransaction(signedHex)
        │ emit execution:submitted
        ▼
Confirmation Monitor (ExecutionService)
        │ poll txHash every 2s up to config.txTimeoutSec
        │ IF timeout → retry with gas bump
        │ IF confirmed → emit execution:confirmed
        ▼
Position Created (RiskManager + StateManager)
        │ StateManager.saveState() [atomic]
        │ RiskManager registers position for SL/TP monitoring
        ▼
╔══════════════════════════════════════════╗
║         POSITION MONITORING LOOP         ║
║  every 10s: compare price to SL / TP    ║
╚══════════════════════════════════════════╝
        │ SL or TP triggered
        ▼
Close Order issued (RiskManager → TradingEngine)
        │ same MEV defense / gas / sign / submit flow
        │ confirmation
        ▼
Trade Recorded (AnalyticsEngine)
        │ TradeRecord: PnL, latency, slippage, exit reason
        │ StateManager.saveState() (position removed)
        │ emit analytics:trade_recorded
        ▼
Metrics Updated (300s batch)
        │ Sharpe, win rate, avg slippage, latency percentiles
        ▼
[END]
```

---

## 12. Key Algorithm Designs

### 12.1 Anaconda Squeeze TWAP

```typescript
// MEVDefenseModule.buildTwapPlan()
function buildTwapPlan(order: Order): TwapParams {
  const N = config.twap.chunkCount;           // e.g. 10
  const total = order.size;

  // Step 1: Generate raw random chunks
  const rawChunks: number[] = [];
  for (let i = 0; i < N; i++) {
    rawChunks.push(total / N * randomBetween(config.twap.minChunkPct, config.twap.maxChunkPct));
  }

  // Step 2: Normalize so they sum exactly to total
  const sum = rawChunks.reduce((a, b) => a + b, 0);
  const chunkSizes = rawChunks.map(c => (c / sum) * total);

  // Step 3: Random intervals
  const intervals: number[] = [];
  for (let i = 0; i < N - 1; i++) {
    intervals.push(randomBetween(config.twap.minIntervalMs, config.twap.maxIntervalMs));
  }
  intervals.push(0); // last chunk has no delay after it

  return {
    totalSize:   total,
    chunkSizes,
    intervals,
    submittedAt: [],
    chunksTotal: N,
    chunksDone:  0,
  };
}

// MEVDefenseModule.executeTwap()
async function executeTwap(
  order: Order,
  twap: TwapParams,
  submitFn: (chunk: Order) => Promise<Transaction>
): Promise<Transaction[]> {
  const results: Transaction[] = [];
  for (let i = 0; i < twap.chunksTotal; i++) {
    const chunk: Order = { ...order, size: twap.chunkSizes[i] };
    try {
      const tx = await submitFn(chunk);
      twap.submittedAt[i] = Date.now();
      twap.chunksDone++;
      results.push(tx);
      bus.emit('mev:chunk_submitted', { orderId: order.id, chunk: i, size: chunk.size, txHash: tx.hash });
      if (i < twap.chunksTotal - 1) await sleep(twap.intervals[i]);
    } catch (e) {
      bus.emit('mev:chunk_failed', { orderId: order.id, chunk: i, error: String(e) });
      throw e;  // propagates to RiskManager
    }
  }
  bus.emit('mev:twap_complete', { orderId: order.id, totalChunks: twap.chunksTotal });
  return results;
}
```

### 12.2 Gas Price Optimization

```typescript
// GasOptimizer.getOptimalGasPrice()
async function getOptimalGasPrice(urgency?: number): Promise<number> {
  const { baseFee, priorityFee } = await tradingEngine.getGasPrice();
  const multiplier = urgency ?? config.gas.urgencyMultiplier;
  const raw = (baseFee + priorityFee) * multiplier;
  return clamp(raw, config.gas.minGasGwei, config.gas.maxGasGwei);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
```

### 12.3 Composite Signal Confidence

```typescript
// SignalGenerator.computeCompositeSignal()
// Weighted average of all generated signals for a pair
function computeCompositeSignal(signals: TradingSignal[]): TradingSignal {
  const weights = config.signal.weights;
  const weightMap: Record<SignalType, number> = {
    rsi_oversold:        weights.rsi,
    rsi_overbought:      weights.rsi,
    macd_bullish:        weights.macd,
    macd_bearish:        weights.macd,
    bb_lower:            weights.bollinger,
    bb_upper:            weights.bollinger,
    whale_accumulation:  weights.whale,
    exchange_inflow:     weights.onchain,
    scalping_entry:      1.0,
    composite:           1.0,
  };

  let totalWeight = 0;
  let weightedConfidence = 0;
  let buyVotes = 0, sellVotes = 0;

  for (const s of signals) {
    const w = weightMap[s.type] ?? 1.0;
    weightedConfidence += s.confidence * w;
    totalWeight += w;
    if (s.side === 'buy')  buyVotes++;
    else                   sellVotes++;
  }

  const confidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;
  const side: OrderSide = buyVotes >= sellVotes ? 'buy' : 'sell';

  return {
    id:         uuid(),
    pair:       signals[0].pair,
    type:       'composite',
    side,
    confidence: Math.min(confidence, 1.0),
    indicators: signals[0].indicators,
    onChain:    signals[0].onChain,
    regime:     signals[0].regime,
    strategy:   'composite',
    timestamp:  Date.now(),
  };
}
```

### 12.4 Sharpe Ratio Calculation

```typescript
// AnalyticsEngine.calculateSharpe()
// Annualized Sharpe using trailing 30-day daily returns
function calculateSharpe(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0)
                   / (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  const riskFreeDaily = 0.05 / 365;  // 5% annual
  return ((mean - riskFreeDaily) / stdDev) * Math.sqrt(365);
}
```

---

## 13. Dependency Graph (Circular Dependency Avoidance)

```
Level 0 (no deps):       Config, EventBus, Types
Level 1 (config only):   ConfigurationService
Level 2:                 TradingEngine(Config, Bus)
                         StateManager(Config, Bus)
Level 3:                 MarketDataService(Config, Bus)
                         GasOptimizer(TradingEngine, Config)
                         PoolAnalyzer(TradingEngine, Config, Bus)
Level 4:                 SignalGenerator(MarketData, Config, Bus)
                         RegimeDetector(MarketData, Config, Bus)
                         ExecutionService(TradingEngine, GasOpt, Config, Bus)
                         AnalyticsEngine(StateManager, Config, Bus)
                         MEVDefenseModule(Config, Bus)
Level 5:                 RiskManager(TradingEngine, Config, Bus)
                         Strategies(Config, Bus)
Level 6:                 StrategyManager(SignalGen, Regime, Config, Bus)
Level 7:                 HealthMonitor(Config, Bus) + all Level 5–6
```

**No circular dependencies**: Each level only depends on lower levels.
`TradingEngine` emits events the bus delivers to `RiskManager` — they do not hold direct references to each other.

---

## 14. Timer Architecture

| Timer | Interval | Component | Cleanup |
|---|---|---|---|
| Market data refresh | 60s (configurable) | MarketDataService | `clearInterval` on stop() |
| Regime update | 300s | RegimeDetector | `clearInterval` on stop() |
| SL/TP monitor | 10s | RiskManager | `clearInterval` on stop() |
| Drawdown check | 60s | RiskManager | `clearInterval` on stop() |
| Emergency poll | 5s | HealthMonitor | `clearInterval` on stop() |
| Metrics calc | 300s | AnalyticsEngine | `clearInterval` on stop() |
| Latency calc | 3600s | AnalyticsEngine | `clearInterval` on stop() |
| Strategy weight eval | 86400s | StrategyManager | `clearInterval` on stop() |
| State auto-save | 30s | StateManager | `clearInterval` on stop() |

All intervals stored as `NodeJS.Timeout` references and cleared in LIFO order during shutdown.

---

## 15. File Structure

```
sovereign-bnb-agent/
├── src/
│   ├── index.ts                    # Bootstrap + graceful shutdown handler
│   ├── types/
│   │   ├── index.ts                # All shared types (Config, MarketData, Position…)
│   │   └── errors.ts               # Error class hierarchy
│   ├── events/
│   │   └── EventBus.ts             # TypedEventEmitter<AgentEvents>
│   ├── config/
│   │   ├── schema.ts               # Zod config schema
│   │   └── index.ts                # ConfigurationService
│   ├── market/
│   │   ├── MarketDataService.ts    # CMC polling, OHLCV cache
│   │   ├── SignalGenerator.ts      # RSI/MACD/BB/whale signals
│   │   └── RegimeDetector.ts       # Bull/bear/sideways classification
│   ├── strategies/
│   │   ├── IStrategy.ts            # Strategy interface
│   │   ├── StrategyManager.ts      # Registry + regime-based activation
│   │   ├── MidBattleScalpingStrategy.ts
│   │   ├── MomentumStrategy.ts     # Bull regime
│   │   ├── MeanReversionStrategy.ts# Bear regime
│   │   └── RangeStrategy.ts        # Sideways regime
│   ├── risk/
│   │   ├── RiskManager.ts          # Sizing, SL/TP, drawdown, circuit breaker
│   │   └── PoolAnalyzer.ts         # Dead-coin filter
│   ├── execution/
│   │   ├── MEVDefenseModule.ts     # Anaconda Squeeze TWAP
│   │   ├── GasOptimizer.ts         # clamp formula
│   │   ├── ExecutionService.ts     # TWAK sign + BNB SDK submit
│   │   └── TradingEngine.ts        # Routing + RPC failover
│   ├── state/
│   │   ├── StateManager.ts         # Atomic write + integrity check
│   │   └── migrations/
│   │       └── v1_to_v2.ts         # Future state migration
│   ├── analytics/
│   │   └── AnalyticsEngine.ts      # PnL, Sharpe, win rate, latency
│   ├── health/
│   │   └── HealthMonitor.ts        # Circuit breaker, recovery, shutdown
│   └── utils/
│       ├── backoff.ts              # withRetry + exponential backoff
│       ├── sleep.ts                # Promise-based sleep
│       └── uuid.ts                 # UUID generation
├── data/                           # Runtime data (gitignored)
│   ├── state.json                  # Persisted SystemState
│   └── analytics.json             # Performance metrics log
├── .env.example                    # All env vars with comments
├── tsconfig.json                   # strict: true, no any, exactOptional
├── package.json
├── README.md
└── docs/
    ├── architecture.md
    ├── configuration-reference.md
    └── deployment-guide.md
```

---

## 16. Testing Strategy

### 16.1 Unit Testing (Jest + ts-jest)

Each component tested in isolation with mocked dependencies:

```typescript
// Example: SignalGenerator unit test
describe('SignalGenerator', () => {
  it('emits RSI oversold buy signal when RSI < threshold', () => {
    const mockMarketData = createMockMarketData({ indicators: { rsi14: 25 } });
    const signals = signalGen.generateSignals('BNB/USDT', mockMarketData);
    expect(signals.some(s => s.type === 'rsi_oversold' && s.side === 'buy')).toBe(true);
  });
  it('composite confidence is bounded [0, 1]', () => {
    // fuzz: test with many random indicator combinations
  });
});
```

### 16.2 Property-Based Testing (fast-check)

```typescript
// Properties verified:
// P1: For any valid Config, Zod parse(stringify(config)) === config  (round-trip)
// P2: For any order above TWAP threshold, sum(chunk sizes) === order.size
// P3: For any order, chunk sizes are all within [min_pct, max_pct] × mean_chunk
// P4: For any position, stopLoss < entryPrice < takeProfit (for buy)
// P5: For any portfolio value, calculated position size ≤ maxPositionPct × portfolio
// P6: For any set of positions, total exposure ≤ maxExposurePct × portfolio
// P7: For any gas inputs, clamp(optimizedGas) is in [minGasGwei, maxGasGwei]
// P8: For any list of daily returns, sharpe(returns) produces a finite number
// P9: For any SystemState, serialize → deserialize → verify checksum passes
// P10: For any signal list, compositeSignal.confidence ∈ [0.0, 1.0]
```

### 16.3 Integration Testing

```typescript
// Test against BSC testnet (97):
// - Full initialization of all three SDKs
// - Place and confirm a small swap on PancakeSwap testnet
// - Verify state persistence after position open/close
// - Verify RPC failover when primary endpoint is disconnected
// - Verify TWAP execution completes with correct chunk count
```

### 16.4 Backtest Validation

The `Analytics_Engine` in backtest mode replays 30 days of historical CMC data and must demonstrate:
- Sharpe ratio > 1.0
- Max drawdown < 20%
- Win rate > 50%
- All strategy selections are logged and traceable

---

## 17. Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions — a formal statement about what the system must do regardless of input variation.*

### Property 1: Config Round-Trip

*For any* valid `Config` object, serializing it to JSON and parsing it back through the Zod schema must produce an equivalent object with no data loss or type coercion.

**Validates: Requirements 19.1, 19.2, 19.3, 19.6, 29.3**

### Property 2: TWAP Chunk Sum Preservation

*For any* order whose size exceeds the TWAP threshold, the sum of all generated chunk sizes produced by `MEVDefenseModule.buildTwapPlan()` must equal exactly the original order size.

**Validates: Requirements 9.1, 9.2**

### Property 3: TWAP Chunk Size Bounds

*For any* TWAP plan, every individual chunk size must fall within `[minChunkPct × meanChunk, maxChunkPct × meanChunk]` after normalization, confirming randomization stays within configured variation bounds.

**Validates: Requirements 9.2**

### Property 4: Position Risk Invariant

*For any* buy position, the stop-loss price must be strictly less than the entry price, and the take-profit price must be strictly greater than the entry price.

**Validates: Requirements 11.1, 11.2, 6.3, 6.4**

### Property 5: Position Size Bound

*For any* portfolio value and configured `maxPositionPct`, the `RiskManager.calculatePositionSize()` result must never exceed `portfolioValue × maxPositionPct / 100`.

**Validates: Requirements 8.1, 8.3**

### Property 6: Exposure Limit

*For any* set of open positions, the sum of all position sizes must not exceed `portfolioValue × maxExposurePct / 100` when a new position is accepted.

**Validates: Requirements 8.2, 8.3**

### Property 7: Gas Price Clamp Invariant

*For any* combination of `baseFee`, `priorityFee`, and `urgencyMultiplier`, the result of `GasOptimizer.getOptimalGasPrice()` must always be in the interval `[minGasGwei, maxGasGwei]`.

**Validates: Requirements 13.2, 13.3, 13.4**

### Property 8: Signal Confidence Bounds

*For any* combination of technical indicator values, `SignalGenerator.computeCompositeSignal()` must produce a composite confidence score in `[0.0, 1.0]`.

**Validates: Requirements 3.10, 3.1–3.8**

### Property 9: State Persistence Round-Trip

*For any* `SystemState` object, `StateManager.saveState()` followed by `StateManager.loadState()` must return an equivalent state with checksum verification passing.

**Validates: Requirements 15.1, 15.2, 15.3, 15.7**

### Property 10: Sharpe Ratio Finiteness

*For any* non-empty list of daily return values that are finite numbers, `AnalyticsEngine.calculateSharpe()` must return a finite number (not NaN or Infinity).

**Validates: Requirements 16.3, 27.4**

### Property 11: Pool Rejection Consistency

*For any* pool health data where any single health metric falls below its configured threshold, `PoolAnalyzer.isHealthy()` must return `false` and include a non-null rejection reason.

**Validates: Requirements 7.2, 7.3, 7.4, 7.5**

### Property 12: Strategy Weight Normalization

*For any* strategy weight adjustment by `StrategyManager`, the sum of all strategy weights after normalization must equal 1.0 (within floating-point epsilon).

**Validates: Requirements 24.4**

---

## 18. Security Considerations

- **No credentials in code**: All secrets via environment variables only; `.env` is gitignored
- **TWAK autonomous mode**: Wallet credentials scoped to the agent process only; no private key ever logged
- **Zod boundary validation**: Every external API response parsed through a typed Zod schema before use — prevents prototype pollution and unexpected type coercions
- **Atomic writes**: State files written via temp+rename to prevent partial writes that could corrupt position data
- **Gas price cap**: `maxGasGwei` prevents runaway gas costs if BNB SDK returns anomalous data
- **Slippage cap**: `maxSlippagePct` prevents execution at wildly unfavorable prices
- **Circuit breaker**: Drawdown limit caps worst-case loss before human intervention is needed
- **Emergency file trigger**: `SHUTDOWN_SIGNAL_FILE` allows out-of-band shutdown without exposing an API surface

## 19. Performance Considerations

- **CMC rate limits**: All pairs use shared polling with per-pair cache; single API call refreshes multiple pairs where CMC batch endpoints allow
- **Event bus over direct calls**: Avoids tight coupling and allows async fan-out without blocking the signal → execution critical path
- **No blocking I/O on hot path**: State saves are fire-and-forget (enqueued) so they do not delay the < 3s signal-to-tx latency target
- **TWAP parallelism**: Multiple simultaneous TWAP executions for different pairs are independent; they do not share a lock
- **TypeScript strict mode**: Eliminates runtime type errors that would add unpredictable latency

## 20. Dependencies

```json
{
  "dependencies": {
    "@trustwallet/agent-sdk": "latest",
    "@bnb-chain/agent-sdk":   "latest",
    "zod":                    "^3.22.0",
    "ethers":                 "^6.9.0",
    "axios":                  "^1.6.0",
    "winston":                "^3.11.0",
    "uuid":                   "^9.0.0"
  },
  "devDependencies": {
    "typescript":         "^5.3.0",
    "ts-jest":            "^29.1.0",
    "jest":               "^29.7.0",
    "fast-check":         "^3.14.0",
    "@types/node":        "^20.0.0",
    "@types/uuid":        "^9.0.0",
    "ts-node":            "^10.9.0"
  }
}
```

| Package | Purpose |
|---|---|
| `@trustwallet/agent-sdk` | Self-custody wallet signing (TWAK) |
| `@bnb-chain/agent-sdk` | BSC chain primitives, PancakeSwap, BSC Perps |
| `zod` | Runtime schema validation for config, API responses, state |
| `ethers` | Low-level ABI encoding and transaction construction |
| `axios` | HTTP client for CMC API with interceptors for retry |
| `winston` | Structured JSON logging with configurable transports |
| `uuid` | ID generation for positions, orders, signals |
| `fast-check` | Property-based testing with arbitrary generators |

---

*End of Design Document — Sovereign BNB Agent v1.0*
