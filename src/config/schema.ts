import { z } from 'zod';

// ─── Nested Sub-Schemas ──────────────────────────────────────────────────────

const NetworkConfigSchema = z.object({
  mode:           z.enum(['testnet', 'mainnet']).default('testnet'),
  rpcEndpoints:   z.array(z.string().url()).min(1),
  rpcTimeoutMs:   z.number().int().min(1000).max(30000).default(10000),
  rpcBackoffBase: z.number().min(1).max(10).default(2),
  rpcBackoffMax:  z.number().min(10).max(120).default(60),
  chainId:        z.number().int().positive(),
});

const RiskConfigSchema = z.object({
  maxPositionPct:     z.number().min(0.1).max(20).default(5),
  maxExposurePct:     z.number().min(1).max(100).default(30),
  stopLossPct:        z.number().min(0.1).max(50).default(5),
  takeProfitPct:      z.number().min(0.1).max(200).default(15),
  maxDrawdownPct:     z.number().min(1).max(50).default(20),
  minPortfolioUsd:    z.number().min(10).default(100),
  leverageMultiplier: z.number().min(1).max(20).default(1),
});

const TwapConfigSchema = z.object({
  thresholdUsd:  z.number().min(1).default(50),
  chunkCount:    z.number().int().min(2).max(20).default(10),
  minChunkPct:   z.number().min(0.5).max(1.0).default(0.7),
  maxChunkPct:   z.number().min(1.0).max(2.0).default(1.3),
  minIntervalMs: z.number().int().min(5000).max(60000).default(15000),
  maxIntervalMs: z.number().int().min(5000).max(300000).default(45000),
});

const GasConfigSchema = z.object({
  urgencyMultiplier: z.number().min(1.0).max(3.0).default(1.2),
  minGasGwei:        z.number().min(1).max(100).default(3),
  maxGasGwei:        z.number().min(1).max(1000).default(100),
  gasBumpPct:        z.number().min(1).max(50).default(20),
  maxRetries:        z.number().int().min(1).max(10).default(3),
});

const SlippageConfigSchema = z.object({
  defaultPct: z.number().min(0.1).max(5).default(1.5),   // 1.5% default — BSC V2 pools commonly need ≥1%
  maxPct:     z.number().min(0.5).max(10).default(5.0),  // raised to 5% max for volatile tokens
  bumpPct:    z.number().min(0.1).max(2.0).default(0.5), // 0.5% bump per retry
  maxRetries: z.number().int().min(1).max(10).default(3),
});

const RegimeConfigSchema = z.object({
  shortMaPeriod:      z.number().int().min(5).max(50).default(20),
  longMaPeriod:       z.number().int().min(10).max(200).default(50),
  slopeUpThreshold:   z.number().min(0).max(1).default(0.001),
  slopeDownThreshold: z.number().min(0).max(1).default(0.001),
  // bbWidthThreshold: default 5 would mean `bbWidth < 5` which is false when indicators
  // default to bbWidth=5. Using 6 ensures sideways is detected on neutral/default data.
  bbWidthThreshold:   z.number().min(0.01).max(50).default(6),
  updateIntervalSec:  z.number().int().min(60).max(3600).default(300),
});

const SignalWeightsSchema = z.object({
  rsi:       z.number().min(0).max(1).default(0.25),
  macd:      z.number().min(0).max(1).default(0.25),
  bollinger: z.number().min(0).max(1).default(0.2),
  whale:     z.number().min(0).max(1).default(0.15),
  onchain:   z.number().min(0).max(1).default(0.15),
});

const SignalConfigSchema = z.object({
  rsiOversold:          z.number().int().min(10).max(40).default(30),
  rsiOverbought:        z.number().int().min(60).max(90).default(70),
  whaleBuyThresholdUsd: z.number().min(1000).default(100000),
  exchangeInflowUsd:    z.number().min(1000).default(50000),
  weights:              SignalWeightsSchema,
});

const ScalpingConfigSchema = z.object({
  athDropPct:      z.number().min(1).max(80).default(10),  // 10% dip from ATH — fires in normal market swings
  positionSizeUsd: z.number().min(1).default(100),
  takeProfitPct:   z.number().min(0.1).max(100).default(15),
  stopLossPct:     z.number().min(0.1).max(50).default(5),
});

const PoolConfigSchema = z.object({
  minReserveUsd:      z.number().min(1000).default(50000),
  minVolToReservePct: z.number().min(0.1).max(100).default(5),
  minTxCount24h:      z.number().int().min(1).default(100),
  maxReserveDrainPct: z.number().min(1).max(100).default(50),
});

const VenueConfigSchema = z.object({
  pancakeswapRouter: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  bscPerpsContract:  z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  // pancakeV3Factory removed — V2 factory addresses are hardcoded in TradingEngine
  // (immutable on-chain, no need to configure)
});

const AdaptiveConfigSchema = z.object({
  enabled:             z.boolean().default(false),
  evaluationPeriodSec: z.number().int().min(3600).default(86400),
  weightAdjPct:        z.number().min(1).max(50).default(10),
  benchmarkReturn:     z.number().default(0),
});

// ─── Top-Level ConfigSchema ──────────────────────────────────────────────────

export const ConfigSchema = z.object({
  // CMC_API_KEY
  cmcApiKey:         z.string().min(32),
  // TWAK_ACCESS_ID — Trust Wallet Agent Kit API credential
  twakAccessId:        z.string().optional().default(''),
  // TWAK_HMAC_SECRET — Trust Wallet Agent Kit HMAC secret
  twakHmacSecret:      z.string().optional().default(''),
  // TWAK_WALLET_PASSWORD — password protecting the local TWAK wallet keystore
  twakWalletPassword:  z.string().optional().default(''),
  // TRADING_PAIRS (comma-separated)
  tradingPairs:      z.array(z.string().regex(/^[A-Z]+\/[A-Z]+$/)).min(1),

  // Nested
  network:  NetworkConfigSchema,
  venue:    VenueConfigSchema,
  risk:     RiskConfigSchema,
  twap:     TwapConfigSchema,
  gas:      GasConfigSchema,
  slippage: SlippageConfigSchema,
  regime:   RegimeConfigSchema,
  signal:   SignalConfigSchema,
  scalping: ScalpingConfigSchema,
  pool:     PoolConfigSchema,
  adaptive: AdaptiveConfigSchema,

  // DATA_REFRESH_SEC
  dataRefreshSec:     z.number().int().min(10).max(3600).default(60),
  // SL_MONITOR_MS
  slMonitorMs:        z.number().int().min(1000).max(60000).default(10000),
  // DRAWDOWN_CHECK_SEC
  drawdownCheckSec:   z.number().int().min(10).max(3600).default(60),
  // SHUTDOWN_POLL_MS
  shutdownPollMs:     z.number().int().min(1000).max(30000).default(5000),
  // METRICS_CALC_SEC
  metricsCalcSec:     z.number().int().min(60).max(3600).default(300),
  // LATENCY_WARNING_MS
  latencyWarningMs:   z.number().int().min(1000).max(30000).default(5000),
  // TX_TIMEOUT_SEC
  txTimeoutSec:       z.number().int().min(30).max(600).default(120),
  // LATENCY_TARGET_MS
  latencyTargetMs:    z.number().int().min(100).max(10000).default(3000),
  // STATE_PERSIST_SEC
  statePersistSec:    z.number().int().min(1).max(300).default(30),
  // STATE_FILE_PATH
  stateFilePath:      z.string().default('./data/state.json'),
  // ANALYTICS_FILE_PATH
  analyticsFilePath:  z.string().default('./data/analytics.json'),
  // SHUTDOWN_SIGNAL_FILE
  shutdownSignalFile: z.string().default('./SHUTDOWN'),
  // RESET_CIRCUIT_BREAKER_FILE — touch this file to reset the circuit breaker without restarting
  resetCircuitBreakerFile: z.string().default('./RESET_CIRCUIT_BREAKER'),
  // LOG_LEVEL
  logLevel:           z.enum(['debug', 'info', 'warn', 'error', 'critical']).default('info'),
  // TRADING_HOURS_START
  tradingHoursStart:  z.string().regex(/^\d{2}:\d{2}$/).default('00:00'),
  // TRADING_HOURS_END
  tradingHoursEnd:    z.string().regex(/^\d{2}:\d{2}$/).default('23:59'),
  // BACKTEST_MODE
  backtestMode:       z.boolean().default(false),
  // BACKTEST_FROM
  backtestFrom:       z.string().default(''),
  // BACKTEST_TO
  backtestTo:         z.string().default(''),
  // BACKTEST_CAPITAL
  backtestCapital:    z.number().min(0).default(10000),
  // DEMO_MODE
  demoMode:           z.boolean().default(false),
  // DEMO_DURATION
  demoDuration:       z.number().int().min(0).default(3600),
  // DEMO_CAPITAL
  demoCapital:        z.number().min(0).default(1000),
});

export type ConfigInput = z.input<typeof ConfigSchema>;
export type Config = z.output<typeof ConfigSchema>;
