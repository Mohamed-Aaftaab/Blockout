# Tasks

## Task 1: Initialize Project Structure
**Status:** not_started
**Dependencies:** none
**Requirements:** 19, 25, 29, 30
**Files:**
- package.json
- tsconfig.json
- .env.example
- .gitignore

### Subtasks
- [x] 1.1 Create package.json with all production dependencies (`@trustwallet/agent-sdk`, `@bnb-chain/agent-sdk`, `zod@^3.22.0`, `ethers@^6.9.0`, `axios@^1.6.0`, `winston@^3.11.0`, `uuid@^9.0.0`) and dev dependencies (`typescript@^5.3.0`, `ts-jest@^29.1.0`, `jest@^29.7.0`, `fast-check@^3.14.0`, `@types/node@^20.0.0`, `@types/uuid@^9.0.0`, `ts-node@^10.9.0`) with exact pinned versions
- [x] 1.2 Create tsconfig.json with `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`, `target: ES2022`, `module: CommonJS`, `outDir: dist`, `rootDir: src`, `esModuleInterop: true`, `resolveJsonModule: true`
- [x] 1.3 Create .gitignore excluding `.env`, `data/`, `node_modules/`, `dist/`, `*.tmp`, `SHUTDOWN`
- [x] 1.4 Create .env.example listing all 35 environment variables from the configuration schema with inline comments documenting type, range, whether required, and default value

### Acceptance Criteria
- `npm install` completes without errors
- `npx tsc --noEmit` passes with zero type errors on an empty src/index.ts
- .env.example contains all 35 variables: `CMC_API_KEY`, `TWAK_ACCESS_ID`, `TWAK_HMAC_SECRET`, `NETWORK_MODE`, `RPC_ENDPOINTS`, `CHAIN_ID`, `TRADING_PAIRS`, `MAX_POSITION_PCT`, `MAX_EXPOSURE_PCT`, `STOP_LOSS_PCT`, `TAKE_PROFIT_PCT`, `MAX_DRAWDOWN_PCT`, `MIN_PORTFOLIO_USD`, `TWAP_THRESHOLD_USD`, `TWAP_CHUNK_COUNT`, `TWAP_MIN_INTERVAL_MS`, `TWAP_MAX_INTERVAL_MS`, `GAS_URGENCY_MULTIPLIER`, `MIN_GAS_GWEI`, `MAX_GAS_GWEI`, `DEFAULT_SLIPPAGE_PCT`, `MAX_SLIPPAGE_PCT`, `RSI_OVERSOLD`, `RSI_OVERBOUGHT`, `SCALPING_ATH_DROP_PCT`, `SCALPING_TP_PCT`, `MIN_POOL_RESERVE_USD`, `MIN_VOL_TO_RESERVE_PCT`, `MIN_TX_COUNT_24H`, `PANCAKESWAP_ROUTER`, `BSC_PERPS_CONTRACT`, `LEVERAGE_MULTIPLIER`, `SHUTDOWN_SIGNAL_FILE`, `STATE_FILE_PATH`, `LOG_LEVEL`
- .gitignore excludes `.env` and `data/` directory

## Task 2: Shared Types and Error Classes
**Status:** not_started
**Dependencies:** 1
**Requirements:** 29, 19
**Files:**
- src/types/index.ts
- src/types/errors.ts

### Subtasks
- [x] 2.1 Implement all primitive union types: `MarketRegime`, `OrderSide`, `OrderType`, `Venue`, `TxStatus`, `CircuitState`, `NetworkMode`, `LogLevel`
- [x] 2.2 Implement the `Result<T, E>` monad with `ok()` and `err()` helper functions using the exact signatures from the design document
- [x] 2.3 Implement all Config-related interfaces: `RiskConfig`, `TwapConfig`, `GasConfig`, `SlippageConfig`, `RegimeConfig`, `SignalConfig`, `ScalpingConfig`, `PoolConfig`, `NetworkConfig`, `VenueConfig`, `AdaptiveConfig`, and the top-level `Config`
- [x] 2.4 Implement all domain interfaces: `OHLCVCandle`, `TechnicalIndicators`, `OnChainMetrics`, `MarketData`, `TradingSignal`, `PoolHealth`, `Position`, `TwapParams`, `Order`, `Transaction`, `TradeRecord`, `SystemState`, `PerformanceMetrics`, `PairMetrics`, `VenueMetrics`, `StrategyMetrics`
- [x] 2.5 Implement error class hierarchy in errors.ts: `AgentError` (base), `ConfigValidationError`, `MarketDataError`, `ExecutionError`, `RiskError`, `StateError`, `EngineError` — each with the constructor signature and `name` field from the design document

### Acceptance Criteria
- `npx tsc --noEmit` passes with zero errors after adding these files
- `Result<T>` type narrows correctly: inside `if (result.ok)` branch, `result.value` is accessible; in else branch, `result.error` is accessible
- All error classes have correct `component`, `recoverable` fields and set `this.name` to the class name
- No `any` types used anywhere in either file
- `SignalType` union covers all 10 signal types from the design

## Task 3: EventBus with Typed Events
**Status:** not_started
**Dependencies:** 2
**Requirements:** 19, 29
**Files:**
- src/events/EventBus.ts

### Subtasks
- [x] 3.1 Create a `TypedEventEmitter<T>` generic base class that wraps Node.js `EventEmitter` and provides type-safe `emit`, `on`, `once`, and `off` methods where the event names and payload types are derived from the generic parameter `T`
- [x] 3.2 Define the complete `AgentEvents` interface with all event names and their payload types as specified in Section 4 of the design document (covers config, market, signal, regime, strategy, pool, risk, mev, execution, engine, state, analytics, and health event groups)
- [x] 3.3 Export the `EventBus` class that extends `TypedEventEmitter<AgentEvents>` with no additional state
- [x] 3.4 Ensure the emit and listener methods are fully typed so calling `bus.emit('config:loaded', config)` with a wrong payload type produces a TypeScript compile error

### Acceptance Criteria
- `npx tsc --noEmit` passes with zero errors
- Calling `bus.emit('signal:generated', tradingSignal)` with a `TradingSignal` payload compiles without error
- Calling `bus.emit('signal:generated', 'wrong-type')` produces a TypeScript compile error
- All 30+ event names from the design document's event catalog are present in `AgentEvents`
- No `any` types used

## Task 4: Utility Functions
**Status:** not_started
**Dependencies:** 2
**Requirements:** 14, 29
**Files:**
- src/utils/backoff.ts
- src/utils/sleep.ts
- src/utils/uuid.ts

### Subtasks
- [x] 4.1 Implement `sleep(ms: number): Promise<void>` in sleep.ts using `setTimeout` wrapped in a Promise
- [x] 4.2 Implement `uuid(): string` in uuid.ts that wraps the `uuid` npm package's `v4()` function with a typed return signature
- [x] 4.3 Implement `withRetry<T>(fn, options): Promise<T>` in backoff.ts with the exact signature from Section 9.2 of the design document: `maxAttempts`, `baseMs`, `maxMs`, `shouldRetry?` options; uses exponential backoff formula `baseMs * 2^(attempt-1)` capped at `maxMs`, plus random jitter up to 1000ms
- [x] 4.4 Export all three utilities as named exports

### Acceptance Criteria
- `sleep(100)` resolves after approximately 100ms in a test
- `uuid()` returns a string matching the UUID v4 format (`/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`)
- `withRetry` throws after `maxAttempts` exhausted
- `withRetry` respects `shouldRetry` predicate: does not retry when predicate returns false
- `withRetry` delay increases exponentially between attempts (first delay ~`baseMs`, second ~`2*baseMs`)
- `npx tsc --noEmit` passes with zero errors

## Task 5: Zod Configuration Schema
**Status:** not_started
**Dependencies:** 2
**Requirements:** 19, 1, 25
**Files:**
- src/config/schema.ts

### Subtasks
- [x] 5.1 Implement all nested Zod sub-schemas: `NetworkConfigSchema`, `RiskConfigSchema`, `TwapConfigSchema`, `GasConfigSchema`, `SlippageConfigSchema`, `RegimeConfigSchema`, `SignalConfigSchema` (including nested `weights` object), `ScalpingConfigSchema`, `PoolConfigSchema`, `VenueConfigSchema`, `AdaptiveConfigSchema` — each with the exact min/max constraints and defaults from Section 6 of the design document
- [x] 5.2 Implement the top-level `ConfigSchema` combining all sub-schemas plus all scalar fields: `cmcApiKey` (min 32 chars), `twakAccessId` (min 8 chars), `twakHmacSecret` (min 16 chars), `tradingPairs` (array of strings matching `/^[A-Z]+\/[A-Z]+$/`, min 1), `stateFilePath`, `analyticsFilePath`, `shutdownSignalFile`, `logLevel` enum, `tradingHoursStart`/`End` with HH:MM regex, `backtestMode`, `backtestFrom`, `backtestTo`, `backtestCapital`, `demoMode`, `demoDuration`, `demoCapital`
- [x] 5.3 Export `ConfigSchema` and the inferred TypeScript type `ConfigInput = z.input<typeof ConfigSchema>` for use in the ConfigurationService
- [x] 5.4 Validate that `ConfigSchema` covers all 35 environment variables from the .env.example by adding a comment listing each env var and its corresponding schema field

### Acceptance Criteria
- `ConfigSchema.parse(validInput)` succeeds for a complete valid config object
- `ConfigSchema.parse({ cmcApiKey: 'short' })` throws a `ZodError` mentioning the field
- A config with `maxPositionPct: 25` (above max of 20) throws `ZodError`
- A config with `tradingPairs: ['bnb/usdt']` (lowercase) throws `ZodError` (regex mismatch)
- A config with `rpcEndpoints: ['not-a-url']` throws `ZodError`
- `npx tsc --noEmit` passes with zero errors

## Task 6: ConfigurationService
**Status:** not_started
**Dependencies:** 5
**Requirements:** 1, 19, 25, 29
**Files:**
- src/config/index.ts

### Subtasks
- [x] 6.1 Implement the `ConfigurationService` class with a private `config: Config | null` field initialized to null
- [x] 6.2 Implement `load(): Result<Config, ConfigValidationError>` that reads all environment variables (mapping env var names to schema fields per the table in design Section 6), parses comma-separated values for `RPC_ENDPOINTS` and `TRADING_PAIRS`, parses boolean strings, then calls `ConfigSchema.safeParse()` and returns `ok(config)` on success or `err(new ConfigValidationError(...))` on failure — logging each validation error with field name and message
- [x] 6.3 Implement `get(): Config` that returns the loaded config or throws `ConfigValidationError` if `load()` was not called successfully
- [x] 6.4 Implement `getSchema(): ZodType<Config>` that returns `ConfigSchema` for documentation/introspection purposes
- [x] 6.5 Ensure `load()` defaults are applied: `NETWORK_MODE` defaults to `testnet` and logs a warning when not set; all other optional vars use their documented defaults

### Acceptance Criteria
- `load()` returns `ok(config)` when all required env vars are set with valid values
- `load()` returns `err(ConfigValidationError)` when `CMC_API_KEY` is missing
- `load()` returns `err(ConfigValidationError)` when `CHAIN_ID` is not a valid integer
- `get()` throws when called before `load()` or after a failed `load()`
- `config.tradingPairs` is an array (not a raw comma string) after `load()`
- `config.network.rpcEndpoints` is an array after `load()`
- `config.network.mode` defaults to `'testnet'` when `NETWORK_MODE` env var is not set
- `npx tsc --noEmit` passes with zero errors

## Task 7: TradingEngine
**Status:** not_started
**Dependencies:** 6, 3, 4
**Requirements:** 1, 14, 20, 25, 29
**Files:**
- src/execution/TradingEngine.ts

### Subtasks
- [x] 7.1 Implement the `TradingEngine` class with constructor `(config: ConfigurationService, bus: EventBus)` and private fields for the `BNBAgentProvider` instance and current RPC endpoint index
- [x] 7.2 Implement `initialize(): Promise<void>` that instantiates `BNBAgentProvider` with the first RPC endpoint and `chainId` from config, calls `provider.connect()`, and verifies connectivity by calling `getBlockNumber()` within 30 seconds — on failure emits `health:critical` and throws
- [x] 7.3 Implement `routeOrder(order: Order): Promise<Result<Transaction, EngineError>>` that checks `order.venue` and delegates to `buildPancakeSwapTx()` for `'pancakeswap'` or `buildPerpPosition()` for `'bsc_perpetuals'` using the BNB SDK methods from design Section 7.3, emits `engine:order_routed`
- [x] 7.4 Implement `getGasPrice(): Promise<{ baseFee: number; priorityFee: number }>`, `getPoolReserves(pair: string): Promise<PoolReserves>`, `getCurrentPrice(pair: string): Promise<number>`, `getBlockNumber(): Promise<number>`, and `getPortfolioValue(): Promise<number>` using BNB SDK calls
- [x] 7.5 Implement `failoverRPC(): Promise<boolean>` following the exact algorithm in design Section 7.3: iterate remaining endpoints, sleep with exponential backoff starting at `rpcBackoffBase * 1000` ms capped at `rpcBackoffMax * 1000` ms, call `provider.reconnect()`, verify with `getBlockNumber()`, emit `engine:rpc_failover` on success
- [x] 7.6 Implement `stop(): void` that closes the provider connection

### Acceptance Criteria
- `initialize()` throws and emits `health:critical` if no RPC endpoint is reachable within 30 seconds
- `routeOrder()` with `venue: 'pancakeswap'` calls the PancakeSwap builder
- `routeOrder()` with `venue: 'bsc_perpetuals'` calls the perps builder
- `failoverRPC()` tries each configured endpoint in order and returns `false` when all fail
- `failoverRPC()` emits `engine:rpc_failover` with the new endpoint and block number on success
- `npx tsc --noEmit` passes with zero errors

## Task 8: GasOptimizer
**Status:** not_started
**Dependencies:** 7
**Requirements:** 13, 29
**Files:**
- src/execution/GasOptimizer.ts

### Subtasks
- [x] 8.1 Implement the `GasOptimizer` class with constructor `(tradingEngine: TradingEngine, config: ConfigurationService)`
- [x] 8.2 Implement private `clamp(value: number, min: number, max: number): number` that returns `Math.min(Math.max(value, min), max)`
- [x] 8.3 Implement `getOptimalGasPrice(urgency?: number): Promise<number>` that calls `tradingEngine.getGasPrice()`, computes `(baseFee + priorityFee) * (urgency ?? config.gas.urgencyMultiplier)`, then clamps the result to `[config.gas.minGasGwei, config.gas.maxGasGwei]` and returns the clamped value in Gwei

### Acceptance Criteria
- When `baseFee=5`, `priorityFee=1`, `urgencyMultiplier=1.2`, `minGasGwei=3`, `maxGasGwei=100`: result is `clamp(7.2, 3, 100)` = `7.2`
- When raw computed value is `150` and `maxGasGwei=100`: result is `100`
- When raw computed value is `1` and `minGasGwei=3`: result is `3`
- Custom `urgency` parameter overrides config multiplier
- `npx tsc --noEmit` passes with zero errors

## Task 9: MarketDataService
**Status:** not_started
**Dependencies:** 6, 3, 4
**Requirements:** 2, 26, 29
**Files:**
- src/market/MarketDataService.ts

### Subtasks
- [x] 9.1 Implement the `MarketDataService` class with constructor `(config: ConfigurationService, bus: EventBus)` and private maps for OHLCV cache (`Map<string, OHLCVCandle[]>`) and ATH tracking (`Map<string, number>`) and refresh interval handles
- [x] 9.2 Implement `start(): Promise<void>` that verifies CMC API access by fetching a test quote, then sets up per-pair polling intervals at `config.dataRefreshSec * 1000` ms calling `fetchPairData()` for each configured trading pair
- [x] 9.3 Implement private `fetchPairData(pair: string): Promise<void>` that calls CMC endpoints for OHLCV (`/v2/cryptocurrency/ohlcv/historical`), quotes (`/v2/cryptocurrency/quotes/latest`), technical indicators (`/v3/cryptocurrency/technical-indicator/latest`), and on-chain metrics — using `axios` with `X-CMC_PRO_API_KEY` header — then emits `market:data`
- [x] 9.4 Implement rate-limit handling: wrap all CMC HTTP calls with `withRetry` using `baseMs=5000`, `maxMs=300000`; on `429` response emit `market:error` with `backoffMs`; on 5 consecutive failures emit `market:circuit_open`
- [x] 9.5 Implement `getLatestData(pair: string): MarketData | null` and `getHistory(pair: string, limit: number): OHLCVCandle[]` returning from the internal cache
- [x] 9.6 Implement `stop(): void` that clears all polling intervals

### Acceptance Criteria
- `start()` emits `market:data` for each configured pair within the first refresh interval
- `getLatestData('BNB/USDT')` returns cached data after first fetch
- On HTTP 429, the service retries with exponential backoff starting at 5 seconds
- After 300 seconds of consecutive CMC failures, `market:circuit_open` is emitted
- `stop()` clears all intervals (no further polling after stop)
- `npx tsc --noEmit` passes with zero errors

## Task 10: SignalGenerator
**Status:** not_started
**Dependencies:** 9
**Requirements:** 3, 26, 29
**Files:**
- src/market/SignalGenerator.ts

### Subtasks
- [x] 10.1 Implement the `SignalGenerator` class with constructor `(marketData: MarketDataService, config: ConfigurationService, bus: EventBus)`
- [x] 10.2 Implement private `computeRSISignal(indicators, pair): TradingSignal | null` — returns a `rsi_oversold` buy signal when `rsi14 < config.signal.rsiOversold`; returns `rsi_overbought` sell signal when `rsi14 > config.signal.rsiOverbought`; confidence proportional to distance from threshold
- [x] 10.3 Implement private `computeMACDSignal(indicators, pair): TradingSignal | null` — `macd_bullish` buy when `macdLine > macdSignal` and `macdHistogram > 0`; `macd_bearish` sell when opposite; confidence proportional to histogram magnitude
- [x] 10.4 Implement private `computeBollingerSignal(indicators, pair, price): TradingSignal | null` — `bb_lower` buy when `price <= indicators.bbLower`; `bb_upper` sell when `price >= indicators.bbUpper`
- [x] 10.5 Implement private `computeWhaleSignal(onchain, pair): TradingSignal | null` — `whale_accumulation` buy when `whaleNetFlow24h > config.signal.whaleBuyThresholdUsd`; `exchange_inflow` sell when `exchangeInflow24h > config.signal.exchangeInflowUsd`
- [x] 10.6 Implement `generateSignals(pair, data): TradingSignal[]` collecting all non-null individual signals, and `computeCompositeSignal(signals): TradingSignal` using the exact weighted-average algorithm from Section 12.3 of the design document; emit `signal:generated` for the composite signal

### Acceptance Criteria
- `generateSignals` with `rsi14=25` and `rsiOversold=30` returns at least one signal with `type: 'rsi_oversold'` and `side: 'buy'`
- `computeCompositeSignal` returns confidence in `[0.0, 1.0]` for any input
- Composite `side` is `'buy'` when buy signals outnumber sell signals
- All signal objects include `id` (UUID), `pair`, `timestamp`, `indicators`, `onChain`, `regime`, `strategy` fields
- `generateSignals` reads all thresholds from `config.signal` — no hardcoded constants
- `npx tsc --noEmit` passes with zero errors

## Task 11: RegimeDetector
**Status:** not_started
**Dependencies:** 9
**Requirements:** 4, 5, 29
**Files:**
- src/market/RegimeDetector.ts

### Subtasks
- [x] 11.1 Implement the `RegimeDetector` class with constructor `(marketData: MarketDataService, config: ConfigurationService, bus: EventBus)` and private `currentRegimes: Map<string, MarketRegime>` map
- [x] 11.2 Implement private `calcMASlope(values: number[], period: number): number` that computes the slope of the moving average over the last `period` values using linear regression or simple first-difference over the window
- [x] 11.3 Implement `detectRegime(pair: string, data: MarketData): MarketRegime` following the logic from Requirement 4: bull when MA20 slope > `slopeUpThreshold` and price > MA50; bear when MA20 slope < `-slopeDownThreshold` and price < MA50; sideways when `bbWidth < config.regime.bbWidthThreshold`
- [x] 11.4 Implement `start(): void` that sets up an interval at `config.regime.updateIntervalSec * 1000` ms, calls `detectRegime` for each pair using latest market data, and emits `regime:changed` when the classification changes from the previous value
- [x] 11.5 Implement `getCurrentRegime(pair: string): MarketRegime` returning the cached regime (defaulting to `'sideways'` if not yet detected) and `stop(): void` clearing the interval

### Acceptance Criteria
- `detectRegime` returns `'bull'` when MA20 slope > threshold and price > MA50
- `detectRegime` returns `'bear'` when MA20 slope < -threshold and price < MA50
- `detectRegime` returns `'sideways'` when BB width is below threshold
- `regime:changed` event is emitted when regime changes from bull to bear
- `regime:changed` is NOT emitted when regime stays the same between updates
- All thresholds read from `config.regime` — no hardcoded values
- `npx tsc --noEmit` passes with zero errors

## Task 12: PoolAnalyzer
**Status:** not_started
**Dependencies:** 7, 6, 3
**Requirements:** 7, 29
**Files:**
- src/risk/PoolAnalyzer.ts

### Subtasks
- [x] 12.1 Implement the `PoolAnalyzer` class with constructor `(tradingEngine: TradingEngine, config: ConfigurationService, bus: EventBus)`
- [x] 12.2 Implement `analyzePool(pair: string): Promise<PoolHealth>` that calls `tradingEngine.getPoolReserves(pair)` to fetch `reserve0`, `reserve1`, converts to USD values, calculates `totalReserveUsd`, fetches 24h volume and tx count, computes `reserveDrainPct`, and returns a fully populated `PoolHealth` object
- [x] 12.3 Implement `isHealthy(health: PoolHealth): boolean` that checks all four conditions from Requirement 7: `totalReserveUsd >= config.pool.minReserveUsd`, `(volume24h / totalReserveUsd * 100) >= config.pool.minVolToReservePct`, `txCount24h >= config.pool.minTxCount24h`, `reserveDrainPct <= config.pool.maxReserveDrainPct` — sets `health.healthy` and `health.rejectionReason` accordingly
- [x] 12.4 Emit `pool:approved` when `isHealthy` returns true; emit `pool:rejected` with reason when false

### Acceptance Criteria
- Pool with `totalReserveUsd=1000` when `minReserveUsd=50000` is rejected with reason mentioning "reserve"
- Pool with `txCount24h=10` when `minTxCount24h=100` is rejected with reason mentioning "transaction count"
- Pool passing all thresholds returns `healthy: true` and `rejectionReason: null`
- `pool:approved` and `pool:rejected` events carry the full `PoolHealth` object
- All thresholds read from `config.pool` — no hardcoded values
- `npx tsc --noEmit` passes with zero errors

## Task 13: RiskManager
**Status:** not_started
**Dependencies:** 7, 6, 3, 4
**Requirements:** 8, 11, 12, 20, 23, 26, 29
**Files:**
- src/risk/RiskManager.ts

### Subtasks
- [x] 13.1 Implement the `RiskManager` class with constructor `(tradingEngine: TradingEngine, config: ConfigurationService, bus: EventBus)` and private state: `openPositions: Map<string, Position>`, `drawdownBaseline: number`, `circuitBreakerActive: boolean`, `slMonitorInterval: NodeJS.Timeout | null`, `drawdownInterval: NodeJS.Timeout | null`
- [x] 13.2 Implement `calculatePositionSize(portfolioUsd: number, pair: string): Result<number, RiskError>` — returns `ok(portfolioUsd * maxPositionPct / 100)` or `err` if portfolio < `minPortfolioUsd`
- [x] 13.3 Implement `validateNewPosition(order: Order, openPositions: Position[]): Result<Order, RiskError>` that checks total exposure (sum of all open position sizes + new order size) ≤ `portfolioUsd * maxExposurePct / 100`; reduces order size if needed; rejects if circuit breaker is active
- [x] 13.4 Implement private `monitorStopLossAndTakeProfit(): Promise<void>` that iterates open positions, fetches current price via `tradingEngine.getCurrentPrice()`, emits `risk:sl_triggered` when price ≤ stopLoss, emits `risk:tp_triggered` when price ≥ takeProfit
- [x] 13.5 Implement `checkDrawdown(): Promise<void>` that fetches portfolio value, computes `drawdownPct = (drawdownBaseline - current) / drawdownBaseline * 100`, and calls `triggerCircuitBreaker()` when drawdownPct ≥ `config.risk.maxDrawdownPct`; emits `risk:circuit_breaker`
- [x] 13.6 Implement `start(): void` that initializes `drawdownBaseline`, sets up SL/TP monitor interval at `config.slMonitorMs`, drawdown check at `config.drawdownCheckSec * 1000`; implement `stop(): void` clearing both intervals; implement `triggerCircuitBreaker(reason)` and `resetCircuitBreaker()`

### Acceptance Criteria
- `calculatePositionSize(1000, 'BNB/USDT')` with `maxPositionPct=5` returns `ok(50)`
- `calculatePositionSize(50, 'BNB/USDT')` with `minPortfolioUsd=100` returns `err(RiskError)`
- `validateNewPosition` rejects when total exposure would exceed `maxExposurePct`
- `validateNewPosition` rejects when `circuitBreakerActive` is true
- SL monitor emits `risk:sl_triggered` when price drops to stopLoss
- TP monitor emits `risk:tp_triggered` when price rises to takeProfit
- `triggerCircuitBreaker` sets `circuitBreakerActive=true` and emits `risk:circuit_breaker`
- `npx tsc --noEmit` passes with zero errors

## Task 14: Strategy Interface and StrategyManager
**Status:** not_started
**Dependencies:** 10, 11, 6, 3
**Requirements:** 5, 24, 29
**Files:**
- src/strategies/IStrategy.ts
- src/strategies/StrategyManager.ts

### Subtasks
- [x] 14.1 Define the `IStrategy` interface in IStrategy.ts with: `readonly name: string`, `readonly supportedRegimes: MarketRegime[]`, `weight: number`, `isActive: boolean`, `onSignal(signal: TradingSignal, regime: MarketRegime): Order | null`, `onMarketData(data: MarketData): void`
- [x] 14.2 Implement the `StrategyManager` class with constructor `(signalGen: SignalGenerator, regimeDetector: RegimeDetector, config: ConfigurationService, bus: EventBus)` and a private `strategies: Map<string, IStrategy>` registry
- [x] 14.3 Implement `registerStrategy(strategy: IStrategy): void`, `getActiveStrategies(): IStrategy[]` (filtered by `isActive`), and `getStrategyWeights(): Record<string, number>`
- [x] 14.4 Implement `start(): void` that subscribes to `signal:generated` on the bus, and for each signal calls each active strategy's `onSignal()` if the current regime is in `strategy.supportedRegimes`; when multiple strategies produce non-null orders, calls `resolveConflict(orders)` which selects the order from the strategy with highest signal confidence
- [x] 14.5 Implement `evaluateAndAdjustWeights(): void` that runs every `config.adaptive.evaluationPeriodSec`; if a strategy has negative returns, decreases its weight by `weightAdjPct`; if returns exceed benchmark, increases weight; then normalizes all weights to sum to 1.0; emits `strategy:weights`
- [x] 14.6 Implement `stop(): void` unsubscribing all event listeners and clearing the weight evaluation interval

### Acceptance Criteria
- `registerStrategy` adds strategy to registry; `getActiveStrategies()` returns only those with `isActive: true`
- In `'bull'` regime, only strategies whose `supportedRegimes` includes `'bull'` receive `onSignal` calls
- `resolveConflict` selects the order from the strategy whose originating signal has the highest `confidence`
- After `evaluateAndAdjustWeights`, the sum of all weights equals `1.0` (within 1e-10 floating-point epsilon)
- `strategy:weights` event is emitted after each weight adjustment
- `npx tsc --noEmit` passes with zero errors

## Task 15: MidBattleScalpingStrategy
**Status:** not_started
**Dependencies:** 14
**Requirements:** 6, 5, 29
**Files:**
- src/strategies/MidBattleScalpingStrategy.ts

### Subtasks
- [x] 15.1 Implement the `MidBattleScalpingStrategy` class implementing `IStrategy` with constructor `(config: ConfigurationService, bus: EventBus)` and private `athMap: Map<string, number>` for per-pair ATH tracking
- [x] 15.2 Set `readonly name = 'MidBattleScalping'`, `readonly supportedRegimes: MarketRegime[] = ['bull', 'bear', 'sideways']`, initialize `weight` from `config.scalping` and `isActive = true`
- [x] 15.3 Implement private `updateATH(pair: string, price: number): void` that sets a new ATH when `price > currentATH`
- [x] 15.4 Implement private `isDipConditionMet(pair: string, price: number): boolean` returning true when `price <= ath * (1 - config.scalping.athDropPct / 100)`
- [x] 15.5 Implement `onMarketData(data: MarketData): void` that calls `updateATH(data.pair, data.price)` to keep ATH current
- [x] 15.6 Implement `onSignal(signal: TradingSignal, regime: MarketRegime): Order | null` — when `isDipConditionMet` is true, returns a TWAP buy `Order` with `size: config.scalping.positionSizeUsd`, `type: 'twap'`, `side: 'buy'`, populated `id` (UUID), `pair`, `venue: 'pancakeswap'`, `slippage: config.slippage.defaultPct`, `twap: null` (MEVDefenseModule will build the plan), `createdAt: Date.now()`, `signalId: signal.id`; otherwise returns null

### Acceptance Criteria
- `onMarketData` updates ATH when price is a new high
- `isDipConditionMet` returns true when price = ATH * 0.65 with `athDropPct=35`
- `isDipConditionMet` returns false when price = ATH * 0.70 with `athDropPct=35`
- `onSignal` returns an `Order` when dip condition is met
- `onSignal` returns `null` when dip condition is not met
- ATH never decreases (only updates upward)
- `npx tsc --noEmit` passes with zero errors

## Task 16: MomentumStrategy, MeanReversionStrategy, and RangeStrategy
**Status:** not_started
**Dependencies:** 14
**Requirements:** 5, 29
**Files:**
- src/strategies/MomentumStrategy.ts
- src/strategies/MeanReversionStrategy.ts
- src/strategies/RangeStrategy.ts

### Subtasks
- [x] 16.1 Implement `MomentumStrategy` implementing `IStrategy` with `name = 'Momentum'`, `supportedRegimes = ['bull']`; `onSignal` returns a buy `Order` when signal `side === 'buy'` and `confidence >= 0.6`; returns a sell `Order` when `side === 'sell'` and `confidence >= 0.6`; otherwise returns null
- [x] 16.2 Implement `MeanReversionStrategy` implementing `IStrategy` with `name = 'MeanReversion'`, `supportedRegimes = ['bear']`; `onSignal` returns a buy `Order` on oversold signals (`type === 'rsi_oversold'` or `type === 'bb_lower'`) to fade the downtrend; returns null for momentum-following signals
- [x] 16.3 Implement `RangeStrategy` implementing `IStrategy` with `name = 'Range'`, `supportedRegimes = ['sideways']`; `onSignal` returns a buy `Order` on `bb_lower` signals and a sell `Order` on `bb_upper` signals — targeting the range boundaries
- [x] 16.4 All three strategies share the same `Order` construction pattern: `id = uuid()`, correct `pair`, `type: 'market'` (or `'twap'` for large sizes), `venue: 'pancakeswap'`, `slippage: config.slippage.defaultPct`, `twap: null`, `createdAt: Date.now()`, `signalId: signal.id`
- [x] 16.5 All three constructors take `(config: ConfigurationService, bus: EventBus)` and read `weight` and initial `isActive` state from config

### Acceptance Criteria
- `MomentumStrategy.onSignal` returns non-null only for `confidence >= 0.6`
- `MeanReversionStrategy.onSignal` returns a buy Order for `type === 'rsi_oversold'`
- `RangeStrategy.onSignal` returns a buy Order for `bb_lower` signal and sell Order for `bb_upper` signal
- All three strategies have `isActive = true` after construction
- All three strategies' `supportedRegimes` match their intended market condition
- `npx tsc --noEmit` passes with zero errors

## Task 17: MEVDefenseModule
**Status:** not_started
**Dependencies:** 6, 3, 4
**Requirements:** 9, 29
**Files:**
- src/execution/MEVDefenseModule.ts

### Subtasks
- [x] 17.1 Implement the `MEVDefenseModule` class with constructor `(config: ConfigurationService, bus: EventBus)`
- [x] 17.2 Implement private `randomBetween(min: number, max: number): number` returning a uniformly distributed random number in `[min, max]`
- [x] 17.3 Implement private `normalizeSizes(raw: number[], total: number): number[]` that divides each raw chunk by the sum of all raw chunks and multiplies by total, ensuring the output array sums exactly to `total`
- [x] 17.4 Implement `shouldSplit(order: Order): boolean` returning true when `order.size > config.twap.thresholdUsd`
- [x] 17.5 Implement `buildTwapPlan(order: Order): TwapParams` following the exact algorithm from Section 12.1: generate `N` raw chunks each as `(total/N) * randomBetween(minChunkPct, maxChunkPct)`, normalize them, generate `N-1` random intervals in `[minIntervalMs, maxIntervalMs]` and append `0` for the last chunk
- [x] 17.6 Implement `executeTwap(order, twap, submitFn): Promise<Transaction[]>` that iterates chunks, calls `submitFn` for each, records `submittedAt`, emits `mev:chunk_submitted`, sleeps for the interval, and on any chunk failure emits `mev:chunk_failed` and rethrows; emits `mev:twap_complete` after all chunks succeed

### Acceptance Criteria
- `shouldSplit` returns true when `order.size=1500` and `config.twap.thresholdUsd=1000`
- `buildTwapPlan` with `chunkCount=10` and `totalSize=1000` produces exactly 10 chunk sizes that sum to 1000 (within 1e-10)
- `buildTwapPlan` produces exactly 10 interval values (last one is 0)
- `executeTwap` emits `mev:chunk_submitted` for each chunk
- `executeTwap` emits `mev:chunk_failed` and throws when `submitFn` rejects on chunk 3
- `executeTwap` emits `mev:twap_complete` after all chunks succeed
- `npx tsc --noEmit` passes with zero errors

## Task 18: ExecutionService
**Status:** not_started
**Dependencies:** 7, 8, 17, 6, 3
**Requirements:** 10, 17, 23, 25, 29
**Files:**
- src/execution/ExecutionService.ts

### Subtasks
- [x] 18.1 Implement the `ExecutionService` class with constructor `(tradingEngine: TradingEngine, gasOptimizer: GasOptimizer, config: ConfigurationService, bus: EventBus)` and a private TWAK `AgentKit` instance field
- [x] 18.2 Implement `initialize(): Promise<void>` that instantiates `AgentKit` with `twakAccessId`, `twakHmacSecret`, `network`, and `autonomous: true`, calls `wallet.initialize()`, and verifies signing capability — throws and emits `health:critical` on failure
- [x] 18.3 Implement private `buildSwapTx(order: Order, gasPrice: number): Promise<UnsignedTransaction>` that calls the appropriate BNB SDK builder based on `order.venue` with slippage, gas, and deadline parameters
- [x] 18.4 Implement private `signAndSubmit(tx: UnsignedTransaction): Promise<string>` that calls `wallet.signTransaction(tx)` then `wallet.broadcastTransaction(signedHex)` and returns the txHash; emits `execution:submitted`
- [x] 18.5 Implement `executeOrder(order: Order): Promise<Result<Transaction, ExecutionError>>` that gets optimal gas, builds tx, signs and submits, then calls `awaitConfirmation()`; on `gas` error bumps gas price by `config.gas.gasBumpPct%` up to `maxRetries` times; on `slippage` error bumps slippage by `config.slippage.bumpPct` up to `maxRetries` times; on final failure emits `execution:failed`
- [x] 18.6 Implement `awaitConfirmation(txHash: string, timeoutMs: number): Promise<Result<Transaction, ExecutionError>>` that polls every 2 seconds up to `timeoutMs`, emits `execution:confirmed` on success
- [x] 18.7 Implement `executeChunk(chunk: Order, gasPrice: number): Promise<Result<Transaction, ExecutionError>>` for use by MEVDefenseModule

### Acceptance Criteria
- `initialize()` throws and emits `health:critical` if TWAK credentials are invalid
- `executeOrder` retries with bumped gas price on gas error (up to `maxRetries` times)
- `executeOrder` retries with bumped slippage on slippage error (up to `maxRetries` times)
- `executeOrder` emits `execution:failed` after exhausting all retries
- `awaitConfirmation` emits `execution:confirmed` and returns `ok(tx)` when tx is confirmed
- `awaitConfirmation` returns `err(ExecutionError)` after `timeoutMs` elapses without confirmation
- `npx tsc --noEmit` passes with zero errors

## Task 19: StateManager
**Status:** not_started
**Dependencies:** 6, 3, 2
**Requirements:** 15, 29
**Files:**
- src/state/StateManager.ts
- src/state/migrations/v1_to_v2.ts

### Subtasks
- [x] 19.1 Implement the `StateManager` class with constructor `(config: ConfigurationService, bus: EventBus)`
- [x] 19.2 Implement private `computeChecksum(state: Omit<SystemState, 'checksum'>): string` using Node.js `crypto.createHash('sha256')` on the JSON stringification of the state object (fields in deterministic order), returning `'sha256:' + hexDigest`
- [x] 19.3 Implement private `verifyChecksum(state: SystemState): boolean` that recomputes the checksum on the state minus the checksum field and compares
- [x] 19.4 Implement private `atomicWrite(path: string, content: string): Promise<void>` writing to a temp file `path + '.tmp.' + Date.now()` then renaming to the target path using `fs.promises.rename`
- [x] 19.5 Implement `saveState(state: SystemState): Promise<void>` that computes checksum, sets `state.checksum` and `state.savedAt`, serializes to JSON, calls `atomicWrite`, and emits `state:saved`
- [x] 19.6 Implement `loadState(): Promise<Result<SystemState, StateError>>` that reads the file, parses JSON, validates with a `SystemStateSchema` (Zod schema mirroring `SystemState`), verifies checksum, and returns `ok(state)`; on any error emits `state:corrupted` and returns `err(StateError)`
- [x] 19.7 Create stub migration file `src/state/migrations/v1_to_v2.ts` exporting `function migrate(state: unknown): SystemState`

### Acceptance Criteria
- `saveState(state)` followed by `loadState()` returns the same state with `result.ok === true`
- Manually corrupting the saved JSON causes `loadState()` to return `err(StateError)` and emit `state:corrupted`
- Truncating the state file (simulating a crash during write) does not corrupt the original file (atomic write guarantee)
- `verifyChecksum` returns false when any field in the state is modified after saving
- `npx tsc --noEmit` passes with zero errors

## Task 20: AnalyticsEngine
**Status:** not_started
**Dependencies:** 19, 6, 3
**Requirements:** 16, 17, 21, 27, 28, 29
**Files:**
- src/analytics/AnalyticsEngine.ts

### Subtasks
- [x] 20.1 Implement the `AnalyticsEngine` class with constructor `(stateManager: StateManager, config: ConfigurationService, bus: EventBus)` and private `tradeRecords: TradeRecord[]` and `latencies: number[]` arrays
- [x] 20.2 Implement `recordTrade(record: TradeRecord): void` that appends the trade to `tradeRecords`, logs structured details (signal type, confidence, entry/exit price, PnL, latency, strategy, venue, gas price), and emits `analytics:trade_recorded`
- [x] 20.3 Implement `calculateSharpe(returns: number[]): number` using the exact algorithm from Section 12.4 of the design: sample variance (n-1 denominator), risk-free rate of 5% annual = `0.05/365` daily, annualized by `× sqrt(365)`; returns `0` when `returns.length < 2` or `stdDev === 0`
- [x] 20.4 Implement `getMetrics(): PerformanceMetrics` computing `totalPnlUsd`, `totalPnlPct`, `dailyReturns` (last 30), `sharpeRatio`, `maxDrawdownPct`, `winRate`, `avgPnlUsd`, `avgSlippagePct`, `latencyAvgMs`, `latencyMedianMs`, `latencyP95Ms`, `byPair`, `byVenue`, `byStrategy`
- [x] 20.5 Implement private `calcP95(latencies: number[]): number` that sorts the array and returns the value at the 95th percentile index
- [x] 20.6 Implement `start(): void` setting up intervals at `metricsCalcSec` (300s) to call `getMetrics()` and emit `analytics:metrics_updated`, and at 3600s to log latency percentiles; `stop(): void` clearing intervals
- [x] 20.7 Implement `generateReport(type: 'shutdown' | 'backtest' | 'demo'): string` returning a formatted string with all `PerformanceMetrics` fields plus trade log summary

### Acceptance Criteria
- `calculateSharpe([1, 2, 3])` returns a finite number
- `calculateSharpe([])` returns `0`
- `calculateSharpe([5, 5, 5])` returns `0` (zero variance)
- `calcP95` on `[1..100]` returns `95`
- `getMetrics().winRate` equals `winningTrades / totalTrades`
- `analytics:metrics_updated` is emitted on the metrics interval
- `generateReport('shutdown')` includes portfolio value and open positions count
- `npx tsc --noEmit` passes with zero errors

## Task 21: HealthMonitor
**Status:** not_started
**Dependencies:** 6, 3, 4
**Requirements:** 1, 18, 22, 29
**Files:**
- src/health/HealthMonitor.ts

### Subtasks
- [x] 21.1 Implement the `HealthMonitor` class with constructor `(config: ConfigurationService, bus: EventBus)` and private fields `circuitState: CircuitState = 'CLOSED'`, `startTime: number`, `shutdownPollInterval: NodeJS.Timeout | null`
- [x] 21.2 Implement `start(): void` that records `startTime = Date.now()`, starts the shutdown signal file poll at `config.shutdownPollMs`, and logs the current `NETWORK_MODE` prominently
- [x] 21.3 Implement private `pollShutdownSignal(): void` that checks if `config.shutdownSignalFile` exists using `fs.existsSync`; if present calls `triggerEmergencyShutdown('file-trigger')`
- [x] 21.4 Implement `triggerEmergencyShutdown(reason: string): Promise<void>` that emits `health:shutdown` with the reason and timestamp, then emits the shutdown signal on the bus for other components to handle orderly teardown
- [x] 21.5 Implement private `checkInitTimeout(component: string, timeoutMs: number): void` that can be called during startup to enforce the 30-second initialization timeout from Requirement 1.7; triggers emergency shutdown if exceeded
- [x] 21.6 Implement private `attemptRecovery(component: string): Promise<boolean>` stub that logs recovery attempt and returns `true` to simulate component restart; emits `health:recovery` on success, `health:critical` on failure
- [x] 21.7 Implement `getCircuitState(): CircuitState`, `getUptime(): number` (current time minus `startTime` in seconds), and `stop(): void` clearing all intervals

### Acceptance Criteria
- `start()` logs network mode at startup
- `pollShutdownSignal()` emits `health:shutdown` when the SHUTDOWN file exists on disk
- `triggerEmergencyShutdown('manual')` emits `health:shutdown` with `reason: 'manual'`
- `getUptime()` returns elapsed seconds since `start()` was called
- `getCircuitState()` returns `'CLOSED'` initially
- `stop()` clears the shutdown poll interval (no more file checks after stop)
- `npx tsc --noEmit` passes with zero errors

## Task 22: Main Entry Point and Bootstrap
**Status:** not_started
**Dependencies:** 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21
**Requirements:** 1, 15, 18, 22, 25, 29
**Files:**
- src/index.ts

### Subtasks
- [x] 22.1 Implement the `bootstrap()` async function following the exact 10-step startup sequence from Section 10 of the design document: [1] `ConfigurationService.load()` (exit on failure), [2] `EventBus` instantiation, [3] `StateManager.loadState()`, [4] parallel `Promise.all` for `TradingEngine.initialize()`, `MarketDataService.start()`, and `ExecutionService.initialize()` with 30-second timeout enforced by `HealthMonitor`
- [x] 22.2 Continue startup steps: [5] `HealthMonitor.start()`, [6] `AnalyticsEngine.start()`, `RegimeDetector.start()`, `RiskManager.start()` with all timer initialization, [7] position recovery if state has open positions, [8] `StrategyManager.start()` registering all four strategies with initial weights from config
- [x] 22.3 Complete startup: [9] log `NETWORK_MODE` prominently, [10] log "System READY" message — then enter event loop
- [x] 22.4 Register `SIGTERM` and `SIGINT` handlers that trigger the graceful shutdown sequence: stop accepting new signals, stop all strategy timers, close all open positions via RiskManager, flush analytics to disk, persist final state, clear all intervals in LIFO order, then `process.exit(0)`
- [x] 22.5 Handle the `health:shutdown` event from HealthMonitor to trigger the same graceful shutdown sequence programmatically

### Acceptance Criteria
- `bootstrap()` calls `ConfigurationService.load()` first and exits with code 1 on validation failure
- All three SDK initializations are launched in parallel with `Promise.all`
- `SIGTERM` handler gracefully shuts down all components and exits with code 0
- `SIGINT` (Ctrl+C) handler triggers the same graceful shutdown as `SIGTERM`
- On restart with persisted state containing open positions, `RiskManager.onPositionOpened` is called for each recovered position
- "System READY" log message appears after all components are initialized
- `npx tsc --noEmit` passes with zero errors

## Task 23: Unit Tests
**Status:** not_started
**Dependencies:** 6, 8, 10, 13, 17, 20
**Requirements:** 29
**Files:**
- src/__tests__/config.test.ts
- src/__tests__/signal.test.ts
- src/__tests__/risk.test.ts
- src/__tests__/mev.test.ts
- src/__tests__/gas.test.ts
- src/__tests__/analytics.test.ts
- jest.config.ts (or jest.config.js)

### Subtasks
- [x] 23.1 Configure Jest with `ts-jest` preset in `jest.config.ts`: `testEnvironment: 'node'`, `transform: { '^.+\\.tsx?$': 'ts-jest' }`, `testMatch: ['**/__tests__/**/*.test.ts']`, coverage thresholds 80%
- [x] 23.2 Write `config.test.ts`: test `ConfigSchema.parse` succeeds with valid input; fails with missing required fields; fails with out-of-range values; test `ConfigurationService.load()` reads env vars correctly; test defaults are applied when optional vars are absent
- [x] 23.3 Write `signal.test.ts`: test RSI oversold/overbought signal generation; test MACD bullish/bearish; test Bollinger band signals; test composite signal confidence is bounded `[0, 1]`; test `side` is `'buy'` when buy votes >= sell votes
- [x] 23.4 Write `risk.test.ts`: test `calculatePositionSize` returns correct value; test rejection when portfolio below minimum; test `validateNewPosition` rejects when exposure exceeds max; test circuit breaker blocks new positions; test SL/TP trigger conditions
- [x] 23.5 Write `mev.test.ts`: test `shouldSplit` threshold logic; test `buildTwapPlan` chunk count matches config; test chunk sizes sum to total; test interval count = chunk count; test `executeTwap` emits correct events; test chunk failure propagation
- [x] 23.6 Write `gas.test.ts`: test clamp when raw value is below min; test clamp when above max; test normal range passthrough; test urgency multiplier override
- [x] 23.7 Write `analytics.test.ts`: test `calculateSharpe` with known return series; test `calcP95` with sorted and unsorted input; test `recordTrade` increments trade count; test `getMetrics` win rate calculation; test `generateReport` returns non-empty string

### Acceptance Criteria
- `npx jest` runs all tests with zero failures
- Each test file has at least 5 test cases
- All mock dependencies use Jest's `jest.fn()` and `jest.mock()` — no real network calls
- Code coverage for the tested modules is ≥ 80%
- `npx tsc --noEmit` passes with zero errors

## Task 24: Property-Based Tests
**Status:** not_started
**Dependencies:** 23
**Requirements:** 9, 5, 8, 13, 15, 3, 7, 16, 24
**Files:**
- src/__tests__/properties.test.ts

### Subtasks
- [x] 24.1 Implement **P1 (Config Round-Trip)**: use `fc.record({...})` to generate valid `Config` objects, serialize to JSON with `JSON.stringify`, parse back through `ConfigSchema.parse`, and assert the result deep-equals the original — validates Req 19.1–19.6
- [x] 24.2 Implement **P2 (TWAP Chunk Sum Preservation)**: generate orders with `size > twap.thresholdUsd`, call `buildTwapPlan(order)`, assert `Math.abs(sum(chunkSizes) - order.size) < 1e-10` — validates Req 9.1, 9.2
- [x] 24.3 Implement **P3 (TWAP Chunk Size Bounds)**: for the same TWAP plan, assert each chunk size is within `[minChunkPct × (total/N), maxChunkPct × (total/N)]` after normalization — validates Req 9.2
- [x] 24.4 Implement **P4 (Position Risk Invariant)**: generate `(entryPrice, stopLossPct, takeProfitPct)` tuples, compute SL and TP, assert `stopLoss < entryPrice && takeProfit > entryPrice` for all buy positions — validates Req 11.1, 11.2
- [x] 24.5 Implement **P5 (Position Size Bound)**: generate `(portfolioUsd, maxPositionPct)` pairs, call `calculatePositionSize`, assert result `<= portfolioUsd * maxPositionPct / 100` — validates Req 8.1, 8.3
- [x] 24.6 Implement **P6 (Exposure Limit)**: generate sets of open positions, assert total exposure after each accepted position never exceeds `maxExposurePct × portfolioUsd / 100` — validates Req 8.2, 8.3
- [x] 24.7 Implement **P7 (Gas Price Clamp)**: generate `(baseFee, priorityFee, urgencyMultiplier, minGasGwei, maxGasGwei)` tuples with `min < max`, assert `getOptimalGasPrice()` result is in `[minGasGwei, maxGasGwei]` — validates Req 13.2–13.4
- [x] 24.8 Implement **P8 (Signal Confidence Bounds)**: generate arbitrary combinations of RSI, MACD histogram, Bollinger distances, and on-chain flows, call `computeCompositeSignal`, assert `0.0 <= confidence <= 1.0` — validates Req 3.10
- [x] 24.9 Implement **P9 (State Persistence Round-Trip)**: generate `SystemState` objects, call `saveState`, call `loadState`, assert the loaded state deep-equals the saved state and checksum passes — validates Req 15.1, 15.7
- [x] 24.10 Implement **P10 (Sharpe Finiteness)**, **P11 (Pool Rejection Consistency)**, **P12 (Strategy Weight Normalization)**: P10 asserts `calculateSharpe(returns)` is finite for any valid return array; P11 asserts `isHealthy` returns false when any single threshold is violated; P12 asserts sum of weights = 1.0 after any `evaluateAndAdjustWeights` call

### Acceptance Criteria
- `npx jest src/__tests__/properties.test.ts` passes with zero failures
- All 12 properties (P1–P12) are implemented as separate `it()` or `test()` blocks
- Each property uses `fc.assert(fc.property(...))` from the `fast-check` library
- Each property runs at least 100 test cases (default fast-check behavior)
- No `any` types used in test file
- `npx tsc --noEmit` passes with zero errors

## Task 25: Documentation
**Status:** not_started
**Dependencies:** 1, 22
**Requirements:** 30
**Files:**
- README.md
- .env.example (finalized with defaults)
- docs/architecture.md
- docs/configuration-reference.md
- docs/deployment-guide.md

### Subtasks
- [x] 25.1 Write `README.md` covering: project overview, all three sponsor SDK integrations (CMC Agent Hub — API key setup + endpoints used; Trust Wallet Agent Kit — wallet initialization + signing flow; BNB AI Agent SDK — RPC config + PancakeSwap/BSC Perps usage), quick-start (clone → install → copy .env → configure → run), and links to docs/
- [x] 25.2 Write `docs/architecture.md` documenting: the high-level component diagram (text/ASCII), component responsibility table, dependency graph (Level 0–7), event catalog with all event names and payloads, and the position lifecycle flow
- [x] 25.3 Write `docs/configuration-reference.md` as a complete table of all 35 environment variables with columns: Variable, Type, Range/Format, Required (yes/no), Default, Description — plus the nested sub-schema breakdowns for risk, twap, gas, slippage, regime, signal, scalping, pool, network, venue, adaptive
- [x] 25.4 Write `docs/deployment-guide.md` with step-by-step sections: Prerequisites, Testnet Deployment (BSC testnet 97), Mainnet Deployment (BSC mainnet 56), Running Backtest Mode, Running Demo Mode, Health Monitoring, Emergency Shutdown procedure (touching the SHUTDOWN file), and Upgrading
- [x] 25.5 Finalize `.env.example` to ensure every variable has a clear comment, a realistic example value, and is grouped by category (Credentials, Network, Risk, TWAP, Gas, etc.)

### Acceptance Criteria
- `README.md` mentions all three sponsor technologies: CoinMarketCap Agent Hub, Trust Wallet Agent Kit, BNB AI Agent SDK
- `docs/configuration-reference.md` has a row for each of the 35 env vars from Task 1
- `docs/deployment-guide.md` includes distinct testnet and mainnet sections
- `docs/deployment-guide.md` includes the emergency shutdown procedure
- `.env.example` has all 35 variables, grouped logically with comments
- All four documentation files exist and are non-empty (> 100 lines each)
