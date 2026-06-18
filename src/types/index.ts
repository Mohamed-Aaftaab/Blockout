// ─── Primitives ─────────────────────────────────────────────────────────────

export type MarketRegime = 'bull' | 'bear' | 'sideways';
export type OrderSide    = 'buy' | 'sell';
export type OrderType    = 'market' | 'limit' | 'twap';
export type Venue        = 'pancakeswap' | 'bsc_perpetuals';
export type TxStatus     = 'pending' | 'confirmed' | 'failed' | 'replaced';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type NetworkMode  = 'testnet' | 'mainnet';
export type LogLevel     = 'debug' | 'info' | 'warn' | 'error' | 'critical';
export type SignalType =
  | 'rsi_oversold' | 'rsi_overbought'
  | 'macd_bullish' | 'macd_bearish'
  | 'bb_lower' | 'bb_upper'
  | 'whale_accumulation' | 'exchange_inflow'
  | 'scalping_entry' | 'composite'
  | 'price_momentum_buy' | 'price_momentum_sell';

// ─── Result Monad ────────────────────────────────────────────────────────────

export type Result<T, E extends Error = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends Error>(e: E): Result<never, E> {
  return { ok: false, error: e };
}

// ─── Config Interfaces ───────────────────────────────────────────────────────

export interface RiskConfig {
  maxPositionPct:      number;
  maxExposurePct:      number;
  stopLossPct:         number;
  takeProfitPct:       number;
  maxDrawdownPct:      number;
  minPortfolioUsd:     number;
  leverageMultiplier:  number;
}

export interface TwapConfig {
  thresholdUsd:   number;
  chunkCount:     number;
  minChunkPct:    number;
  maxChunkPct:    number;
  minIntervalMs:  number;
  maxIntervalMs:  number;
}

export interface GasConfig {
  urgencyMultiplier: number;
  minGasGwei:        number;
  maxGasGwei:        number;
  gasBumpPct:        number;
  maxRetries:        number;
}

export interface SlippageConfig {
  defaultPct: number;
  maxPct:     number;
  bumpPct:    number;
  maxRetries: number;
}

export interface RegimeConfig {
  shortMaPeriod:      number;
  longMaPeriod:       number;
  slopeUpThreshold:   number;
  slopeDownThreshold: number;
  bbWidthThreshold:   number;
  updateIntervalSec:  number;
}

export interface SignalWeights {
  rsi:       number;
  macd:      number;
  bollinger: number;
  whale:     number;
  onchain:   number;
}

export interface SignalConfig {
  rsiOversold:           number;
  rsiOverbought:         number;
  whaleBuyThresholdUsd:  number;
  exchangeInflowUsd:     number;
  weights:               SignalWeights;
}

export interface ScalpingConfig {
  athDropPct:      number;
  positionSizeUsd: number;
  takeProfitPct:   number;
  stopLossPct:     number;
}

export interface PoolConfig {
  minReserveUsd:       number;
  minVolToReservePct:  number;
  minTxCount24h:       number;
  maxReserveDrainPct:  number;
}

export interface NetworkConfig {
  mode:           NetworkMode;
  rpcEndpoints:   string[];
  rpcTimeoutMs:   number;
  rpcBackoffBase: number;
  rpcBackoffMax:  number;
  chainId:        number;
}

export interface VenueConfig {
  pancakeswapRouter: string;
  bscPerpsContract:  string;
  // pancakeV3Factory removed — V2 factory hardcoded in TradingEngine (immutable on-chain)
}

export interface AdaptiveConfig {
  enabled:              boolean;
  evaluationPeriodSec:  number;
  weightAdjPct:         number;
  benchmarkReturn:      number;
}

// Config is the authoritative type inferred from the Zod schema in src/config/schema.ts
export type { Config } from '../config/schema';

// ─── Market Data ─────────────────────────────────────────────────────────────

export interface OHLCVCandle {
  timestamp: number;
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
}

export interface TechnicalIndicators {
  rsi14:         number;
  macdLine:      number;
  macdSignal:    number;
  macdHistogram: number;
  bbUpper:       number;
  bbMiddle:      number;
  bbLower:       number;
  ma20:          number;
  ma50:          number;
  bbWidth:       number;
}

export interface OnChainMetrics {
  whaleNetFlow24h:    number;
  exchangeInflow24h:  number;
  exchangeOutflow24h: number;
  largeTransactions:  number;
}

export interface MarketData {
  pair:       string;
  price:      number;
  volume24h:  number;
  marketCap:  number;
  ath:        number;
  candles:    OHLCVCandle[];
  indicators: TechnicalIndicators;
  onChain:    OnChainMetrics;
  fetchedAt:  number;
}

// ─── Signals ─────────────────────────────────────────────────────────────────

export interface TradingSignal {
  id:         string;
  pair:       string;
  type:       SignalType;
  side:       OrderSide;
  confidence: number;
  indicators: TechnicalIndicators;
  onChain:    OnChainMetrics;
  regime:     MarketRegime;
  strategy:   string;
  timestamp:  number;
}

// ─── Pool Health ─────────────────────────────────────────────────────────────

export interface PoolHealth {
  pair:             string;
  token0Reserve:    number;
  token1Reserve:    number;
  totalReserveUsd:  number;
  volume24h:        number;
  txCount24h:       number;
  reserveDrainPct:  number;
  healthy:          boolean;
  rejectionReason:  string | null;
  fetchedAt:        number;
}

// ─── Positions & Orders ──────────────────────────────────────────────────────

export interface Position {
  id:          string;
  pair:        string;
  side:        OrderSide;
  entryPrice:  number;
  size:        number;
  stopLoss:    number;
  takeProfit:  number;
  leverage:    number;
  strategy:    string;
  venue:       Venue;
  openedAt:    number;
  txHash:      string;
}

export interface TwapParams {
  totalSize:   number;
  chunkSizes:  number[];
  intervals:   number[];
  submittedAt: number[];
  chunksTotal: number;
  chunksDone:  number;
}

export interface Order {
  id:        string;
  pair:      string;
  type:      OrderType;
  side:      OrderSide;
  size:      number;
  venue:     Venue;
  slippage:  number;
  twap:      TwapParams | null;
  createdAt: number;
  signalId:  string;
}

// ─── Transactions ─────────────────────────────────────────────────────────────
// calldata is included so ExecutionService can sign the exact swap calldata
// built by TradingEngine without rebuilding it

export interface Transaction {
  hash:           string;
  orderId:        string;
  status:         TxStatus;
  gasPrice:       number;
  gasLimit:       number;
  gasUsed:        number | null;
  actualSlippage: number | null;
  submittedAt:    number;
  confirmedAt:    number | null;
  blockNumber:    number | null;
  error:          string | null;
  // Swap calldata for signing — populated by TradingEngine, consumed by ExecutionService
  calldata:       string;
  // Value to send with the transaction (BNB amount for buy swaps)
  value:          bigint;
  // Destination contract address
  to:             string;
}

// ─── Trade Records ───────────────────────────────────────────────────────────

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
  signalToTxMs: number;
}

// ─── Competition Registration ─────────────────────────────────────────────────

export interface CompetitionRegistration {
  walletAddress: string;
  txHash:        string;
  timestamp:     number;
  confirmed:     boolean;
}

// ─── System State ────────────────────────────────────────────────────────────

export interface SystemState {
  version:                  string;
  openPositions:            Position[];
  pendingTransactions:      Transaction[];
  drawdownBaseline:         number;
  circuitBreakerActive:     boolean;
  emergencyShutdown:        boolean;
  /** Last known market regime per pair — persisted so restart doesn't have a 60s blind window */
  lastRegimes:              Record<string, MarketRegime>;
  savedAt:                  number;
  checksum:                 string;
  competitionRegistration:  CompetitionRegistration | null;
}

// ─── Performance Metrics ─────────────────────────────────────────────────────

export interface PairMetrics {
  pair:        string;
  totalTrades: number;
  winRate:     number;
  pnlUsd:      number;
}

export interface VenueMetrics {
  venue:          Venue;
  totalTrades:    number;
  avgSlippagePct: number;
  pnlUsd:         number;
}

export interface StrategyMetrics {
  strategy:    string;
  totalTrades: number;
  winRate:     number;
  pnlUsd:      number;
  weight:      number;
}

export interface PerformanceMetrics {
  totalPnlUsd:     number;
  totalPnlPct:     number;
  dailyReturns:    number[];
  sharpeRatio:     number;
  maxDrawdownPct:  number;
  totalTrades:     number;
  winningTrades:   number;
  winRate:         number;
  avgPnlUsd:       number;
  avgSlippagePct:  number;
  recentSlippage:  number[];
  latencyAvgMs:    number;
  latencyMedianMs: number;
  latencyP95Ms:    number;
  byPair:          Record<string, PairMetrics>;
  byVenue:         Record<string, VenueMetrics>;
  byStrategy:      Record<string, StrategyMetrics>;
  calculatedAt:    number;
}

// ─── Convenience re-export ───────────────────────────────────────────────────
export type { Config as AgentConfig } from '../config/schema';
