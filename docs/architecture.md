# Architecture

## High-Level Component Diagram

```
                        ┌───────────────────────────────────┐
                        │         AgentOrchestrator          │
                        │  (src/index.ts)                    │
                        │  Wires all components, starts      │
                        │  intervals, handles shutdown       │
                        └────────────┬──────────────────────┘
                                     │
                    ┌────────────────▼────────────────────┐
                    │              EventBus                │
                    │  Typed Node.js EventEmitter          │
                    │  35+ typed events (AgentEvents)      │
                    └────────────────┬────────────────────┘
                                     │
         ┌───────────────────────────┼──────────────────────────┐
         │                           │                          │
┌────────▼──────────┐   ┌────────────▼────────┐   ┌────────────▼────────┐
│   Market Layer    │   │  Strategy Layer      │   │  Execution Layer    │
│                   │   │                      │   │                     │
│ MarketDataService │   │ StrategyManager      │   │ ExecutionService    │
│   (CMC polling)   │   │   (signal routing)   │   │   (ethers wallet)   │
│                   │   │                      │   │                     │
│ SignalGenerator   │   │ MomentumStrategy     │   │ TradingEngine       │
│ (RSI/MACD/BB/     │   │ MeanReversionStrat.  │   │   (PancakeSwap V2 / │
│  whale/momentum)  │   │ RangeStrategy        │   │    BSC RPC failover)│
│                   │   │ MidBattleScalping    │   │                     │
│ RegimeDetector    │   │                      │   │ GasOptimizer        │
│   (bull/bear/     │   │                      │   │   (Gwei clamping)   │
│    sideways)      │   │                      │   │                     │
└────────────────────┘   └─────────────────────┘   │ MEVDefenseModule    │
                                                    │ (Anaconda Squeeze)  │
         ┌───────────────────────────┐              └─────────────────────┘
         │      Risk Layer           │
         │                           │
         │ RiskManager               │        ┌─────────────────────────┐
         │   (position sizing,       │        │  Infrastructure Layer   │
         │    drawdown, CB)          │        │                         │
         │                           │        │ StateManager            │
         │ PoolAnalyzer              │        │   (atomic JSON + SHA256) │
         │   (dead-coin filter)      │        │                         │
         └───────────────────────────┘        │ AnalyticsEngine         │
                                              │   (Sharpe, PnL, P95)   │
                                              │                         │
                                              │ HealthMonitor           │
                                              │  (shutdown/CB-reset     │
                                              │   file polling)         │
                                              └─────────────────────────┘
```

---

## Component Responsibility Table

| # | Component | File | Responsibility |
|---|---|---|---|
| 1 | **AgentOrchestrator** | `src/index.ts` | Top-level wiring, startup/shutdown sequencing, StateMutex for race-free state writes, SIGTERM handler |
| 2 | **EventBus** | `src/events/EventBus.ts` | Typed publish-subscribe bus; all 35+ events use compile-time checked payloads |
| 3 | **ConfigurationService** | `src/config/index.ts` | Reads all 40+ env vars, validates with Zod schema, exposes typed `Config` object |
| 4 | **ConfigSchema** | `src/config/schema.ts` | Zod schema with min/max constraints, defaults, and regex validators for all config fields |
| 5 | **MarketDataService** | `src/market/MarketDataService.ts` | Polls CoinMarketCap Pro API for OHLCV, quotes, technical indicators; caches per-pair data; emits `market:data`; pushes BNB price to TradingEngine |
| 6 | **SignalGenerator** | `src/market/SignalGenerator.ts` | Computes RSI, MACD, Bollinger Band, whale, exchange-inflow, and price-momentum signals; produces composite signal with weighted confidence |
| 7 | **RegimeDetector** | `src/market/RegimeDetector.ts` | Classifies market as `bull`/`bear`/`sideways` using MA slope and Bollinger width (`bbWidthThreshold=6`); emits `regime:changed` |
| 8 | **StrategyManager** | `src/strategies/StrategyManager.ts` | Routes signals to regime-appropriate strategies; resolves conflicts by strategy weight; runs adaptive weight adjustment |
| 9 | **MidBattleScalpingStrategy** | `src/strategies/MidBattleScalpingStrategy.ts` | Enters TWAP buy when price drops ≥ `scalping.athDropPct` (default 10%) from session ATH; active in all regimes |
| 10 | **MomentumStrategy** | `src/strategies/MomentumStrategy.ts` | Follows buy/sell signals in `bull` regime when confidence ≥ 0.6 |
| 11 | **MeanReversionStrategy** | `src/strategies/MeanReversionStrategy.ts` | Buys oversold dips (`rsi_oversold`, `bb_lower`) in `bear` regime |
| 12 | **RangeStrategy** | `src/strategies/RangeStrategy.ts` | Buys at BB lower, sells at BB upper in `sideways` regime |
| 13 | **RiskManager** | `src/risk/RiskManager.ts` | Enforces position size limits, max exposure, drawdown circuit breaker (persisted across restarts), SL/TP monitoring |
| 14 | **PoolAnalyzer** | `src/risk/PoolAnalyzer.ts` | Dead-coin filter: rejects illiquid, low-volume, or draining pools. `checkHealth()` is pure (no mutation); `isHealthy()` mutates for backwards-compat |
| 15 | **TradingEngine** | `src/execution/TradingEngine.ts` | ethers.js v6 provider; PancakeSwap V2 swap path builder with correct token sort order; pool reserve queries; ERC-20 approve flow; 5s portfolio cache; RPC failover |
| 16 | **GasOptimizer** | `src/execution/GasOptimizer.ts` | Fetches `baseFee + priorityFee`, applies urgency multiplier, clamps to `[minGasGwei, maxGasGwei]` |
| 17 | **MEVDefenseModule** | `src/execution/MEVDefenseModule.ts` | Anaconda Squeeze: splits orders above `twap.thresholdUsd` into N randomized TWAP chunks with jittered intervals |
| 18 | **ExecutionService** | `src/execution/ExecutionService.ts` | Self-custody ethers.Wallet; nonce-serialized transaction submission; gas bump + nonce retry loop; slippage retry; ERC-20 balance cap on close |
| 19 | **StateManager** | `src/state/StateManager.ts` | Atomic file writes with SHA-256 checksums; Zod validation on load; migration support |
| 20 | **AnalyticsEngine** | `src/analytics/AnalyticsEngine.ts` | Computes Sharpe ratio, win rate, max drawdown, latency P95; persists to `analyticsFilePath`; generates shutdown/backtest reports; capped at 50k trade records |
| 21 | **HealthMonitor** | `src/health/HealthMonitor.ts` | Polls `SHUTDOWN` signal file and `RESET_CIRCUIT_BREAKER` file every `shutdownPollMs`; emits `health:shutdown` / `health:circuit_breaker_reset` |

---

## Dependency Graph

```
Level 0 (no deps):
  EventBus, ConfigSchema, Shared Types, Error Classes, Utils (sleep, uuid, withRetry)

Level 1 (depends only on L0):
  ConfigurationService

Level 2 (depends on L0-1):
  TradingEngine
  MarketDataService

Level 3 (depends on L0-2):
  GasOptimizer         → TradingEngine, ConfigurationService
  MEVDefenseModule     → ConfigurationService
  SignalGenerator      → MarketDataService, ConfigurationService
  RegimeDetector       → MarketDataService, ConfigurationService
  PoolAnalyzer         → TradingEngine, ConfigurationService
  StateManager         → ConfigurationService

Level 4 (depends on L0-3):
  RiskManager          → TradingEngine, ConfigurationService
  ExecutionService     → TradingEngine, GasOptimizer, ConfigurationService
  StrategyManager      → SignalGenerator, RegimeDetector, ConfigurationService

Level 5 (depends on L0-4):
  Strategies (Momentum, MeanReversion, Range, MidBattleScalping) → ConfigurationService, StrategyManager

Level 6 (depends on L0-5):
  AnalyticsEngine      → StateManager, ConfigurationService
  HealthMonitor        → ConfigurationService

Level 7 (depends on L0-6):
  AgentOrchestrator    → ALL components
```

---

## Event Catalog

All events are defined in `src/events/EventBus.ts` as the `AgentEvents` interface.

### Market Events
| Event | Payload | Emitter | Consumer |
|---|---|---|---|
| `market:data` | `{ pair, data: MarketData }` | MarketDataService | SignalGenerator, RegimeDetector, Strategies |
| `market:error` | `{ pair, error, backoffMs }` | MarketDataService | HealthMonitor |
| `market:circuit_open` | `{ pair, reason }` | MarketDataService | AgentOrchestrator |

### Signal Events
| Event | Payload | Emitter | Consumer |
|---|---|---|---|
| `signal:generated` | `TradingSignal` | SignalGenerator | StrategyManager |

### Strategy Events
| Event | Payload | Emitter | Consumer |
|---|---|---|---|
| `strategy:signal` | `{ signal, strategy, order }` | StrategyManager | AgentOrchestrator (execution pipeline) |
| `strategy:weights` | `{ weights, reason }` | StrategyManager | AnalyticsEngine |
| `strategy:deactivated` | `{ strategy, reason }` | StrategyManager | HealthMonitor |

### Risk Events
| Event | Payload | Emitter | Consumer |
|---|---|---|---|
| `risk:position_sized` | `{ orderId, size, portfolioUsd }` | RiskManager | AnalyticsEngine |
| `risk:position_rejected` | `{ orderId, reason }` | RiskManager | AnalyticsEngine |
| `risk:sl_triggered` | `{ positionId, price }` | RiskManager | AgentOrchestrator (handlePositionClose) |
| `risk:tp_triggered` | `{ positionId, price }` | RiskManager | AgentOrchestrator (handlePositionClose) |
| `risk:circuit_breaker` | `{ drawdownPct, portfolioUsd, timestamp }` | RiskManager | HealthMonitor, AgentOrchestrator |

### Execution Events
| Event | Payload | Emitter | Consumer |
|---|---|---|---|
| `execution:submitted` | `{ txHash, orderId, gasPrice }` | ExecutionService | AnalyticsEngine |
| `execution:confirmed` | `{ tx: Transaction }` | ExecutionService | RiskManager, StateManager |
| `execution:failed` | `{ orderId, error, attempt }` | ExecutionService | HealthMonitor |
| `mev:chunk_submitted` | `{ orderId, chunk, size, txHash }` | MEVDefenseModule | AnalyticsEngine |
| `mev:twap_complete` | `{ orderId, totalChunks }` | MEVDefenseModule | AnalyticsEngine |
| `engine:order_routed` | `{ orderId, venue }` | TradingEngine | AnalyticsEngine |

### Pool Events
| Event | Payload | Emitter | Consumer |
|---|---|---|---|
| `pool:approved` | `{ pair, health }` | PoolAnalyzer | AnalyticsEngine |
| `pool:rejected` | `{ pair, health, reason }` | PoolAnalyzer | AnalyticsEngine |

### State Events
| Event | Payload | Emitter | Consumer |
|---|---|---|---|
| `state:saved` | `{ path, timestamp }` | StateManager | HealthMonitor |
| `state:loaded` | `{ state }` | StateManager | AgentOrchestrator |
| `state:corrupted` | `{ path, error }` | StateManager | AgentOrchestrator |

### Health Events
| Event | Payload | Emitter | Consumer |
|---|---|---|---|
| `health:critical` | `{ component, message, timestamp }` | Multiple | AgentOrchestrator |
| `health:warning` | `{ component, message }` | Multiple | Logging |
| `health:latency` | `{ latencyMs, threshold }` | AgentOrchestrator | AnalyticsEngine |
| `health:shutdown` | `{ reason, timestamp }` | HealthMonitor | AgentOrchestrator |
| `health:circuit_breaker_reset` | `{ timestamp }` | HealthMonitor | AgentOrchestrator |

---

## Position Lifecycle Flow

```
MarketDataService polls CMC (every dataRefreshSec)
        │
        ▼ market:data
AgentOrchestrator (bus.on 'market:data')
  → strategy.onMarketData(data)          ← keeps ATH tracking current
  → regimeDet.detectRegime(pair, data)   ← bull / bear / sideways
  → signalGen.generateSignals(pair, data)
  → signalGen.computeCompositeSignal()   ← emits signal:generated
        │
        ▼ strategy:signal
AgentOrchestrator.executeSignalPipeline()
        │
        ▼
PoolAnalyzer.analyzePool(pair)           ← dead-coin filter
  ├─ Reserve < minReserveUsd? → REJECT
  ├─ Volume/Reserve ratio too low? → REJECT
  ├─ Tx count too low? → REJECT
  └─ OK → emit pool:approved
        │
        ▼
ExecutionService.getPortfolioUsd()       ← wallet BNB + ERC-20 balances
RiskManager.calculatePositionSize()
RiskManager.validateNewPosition()
  ├─ Circuit breaker active? → REJECT
  ├─ Portfolio < minPortfolioUsd? → REJECT
  ├─ Total exposure > maxExposurePct? → REJECT
  └─ OK
        │
        ▼
MEVDefenseModule.shouldSplit(order)?
  ├─ YES → buildTwapPlan() → executeTwap() → N chunks (Anaconda Squeeze)
  └─ NO  → ExecutionService.executeOrder()
        │
        ▼
TradingEngine.buildSwapPlan()
  → ERC-20 approve (if needed)
  → PancakeSwap V2 swapExactETHForTokens / swapExactTokensForETH
  → Sign with ethers.Wallet, broadcast to BSC RPC
  → Wait for confirmation (up to txTimeoutSec)
        │
        ▼
RiskManager.onPositionOpened(position)
  → SL/TP monitor starts watching (every slMonitorMs)
        │
        ▼ risk:sl_triggered or risk:tp_triggered
AgentOrchestrator.handlePositionClose()
  → Cap closeSize to actual on-chain ERC-20 balance
  → ExecutionService.executeOrder() (reverse swap)
  → On failure: retry up to 5× then emit health:critical + record zero PnL
  → On success: AnalyticsEngine.recordTrade()
        │
        ▼
StateManager.saveState()                 ← atomic write + SHA-256 checksum
  → Every statePersistSec seconds (default 30s)
```

---

## Key Safety & Correctness Mechanisms

| Mechanism | Implementation | Purpose |
|---|---|---|
| **StateMutex** | `src/index.ts` `StateMutex` class | Serialises all `currentState` mutations to prevent concurrent write corruption |
| **Circuit breaker** | `RiskManager` + `StateManager` | Halts trading when drawdown exceeds `maxDrawdownPct`; state persisted across restarts |
| **RESET_CIRCUIT_BREAKER file** | `HealthMonitor.pollShutdownSignal()` | `touch RESET_CIRCUIT_BREAKER` resets CB without restarting the agent |
| **Close size cap** | `handlePositionClose()` | Checks actual on-chain ERC-20 balance before sell to prevent revert from partial fill |
| **Close retry cap** | `handlePositionClose()` | After 5 failed close attempts: emits `health:critical`, records 0 PnL, removes from state |
| **Entry price guard** | `executeSignalPipeline()` | Aborts position open if `getCurrentPrice()` returns 0 to prevent immediate SL/TP trigger |
| **Nonce serialization** | `ExecutionService` nonce lock | Concurrent pair executions serialize through a shared nonce to prevent collision |
| **Portfolio cache** | `TradingEngine.getPortfolioValue()` | 5s TTL cache (including value=0) prevents N+1 RPC calls per signal |
| **Anaconda Squeeze** | `MEVDefenseModule` | Orders above `twap.thresholdUsd` split into N randomized TWAP chunks |
| **Regime-first signal** | `bus.on('market:data')` handler | Regime detected before composite signal computed so regime is correct synchronously |
