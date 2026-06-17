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
                    │  30+ typed events (AgentEvents)      │
                    └────────────────┬────────────────────┘
                                     │
         ┌───────────────────────────┼──────────────────────────┐
         │                           │                          │
┌────────▼──────────┐   ┌────────────▼────────┐   ┌────────────▼────────┐
│   Market Layer    │   │  Strategy Layer      │   │  Execution Layer    │
│                   │   │                      │   │                     │
│ MarketDataService │   │ StrategyManager      │   │ ExecutionService    │
│   (CMC polling)   │   │   (signal routing)   │   │   (TWAK signing)    │
│                   │   │                      │   │                     │
│ SignalGenerator   │   │ MomentumStrategy     │   │ TradingEngine       │
│   (RSI/MACD/BB)   │   │ MeanReversionStrat.  │   │   (BNB SDK/RPC)     │
│                   │   │ RangeStrategy        │   │                     │
│ RegimeDetector    │   │ MidBattleScalping    │   │ GasOptimizer        │
│   (bull/bear/     │   │                      │   │   (Gwei clamping)   │
│    sideways)      │   │                      │   │                     │
└────────────────────┘   └─────────────────────┘   │ MEVDefenseModule    │
                                                    │   (TWAP splitting)  │
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
                                              │   (RPC/latency checks)  │
                                              └─────────────────────────┘
```

---

## Component Responsibility Table

| # | Component | File | Responsibility |
|---|---|---|---|
| 1 | **AgentOrchestrator** | `src/index.ts` | Top-level wiring, startup/shutdown sequencing, SIGTERM handler |
| 2 | **EventBus** | `src/events/EventBus.ts` | Typed publish-subscribe bus; all 30+ events use compile-time checked payloads |
| 3 | **ConfigurationService** | `src/config/index.ts` | Reads all 35 env vars, validates with Zod schema, exposes typed `Config` object |
| 4 | **ConfigSchema** | `src/config/schema.ts` | Zod schema with min/max constraints, defaults, and regex validators for all config fields |
| 5 | **MarketDataService** | `src/market/MarketDataService.ts` | Polls CoinMarketCap Pro API for OHLCV, quotes, technical indicators; caches per-pair data; emits `market:data` |
| 6 | **SignalGenerator** | `src/market/SignalGenerator.ts` | Computes RSI, MACD, Bollinger Band, whale, and exchange-inflow signals; produces composite signal with weighted confidence |
| 7 | **RegimeDetector** | `src/market/RegimeDetector.ts` | Classifies market as `bull`/`bear`/`sideways` using MA slope and Bollinger width; emits `regime:changed` |
| 8 | **StrategyManager** | `src/strategies/StrategyManager.ts` | Routes signals to regime-appropriate strategies; resolves conflicts by strategy weight; runs adaptive weight adjustment |
| 9 | **MidBattleScalpingStrategy** | `src/strategies/MidBattleScalpingStrategy.ts` | Enters TWAP buy when price drops ≥ `athDropPct` from ATH; active in all regimes |
| 10 | **MomentumStrategy** | `src/strategies/MomentumStrategy.ts` | Follows buy/sell signals in `bull` regime when confidence ≥ 0.6 |
| 11 | **MeanReversionStrategy** | `src/strategies/MeanReversionStrategy.ts` | Buys oversold dips (`rsi_oversold`, `bb_lower`) in `bear` regime |
| 12 | **RangeStrategy** | `src/strategies/RangeStrategy.ts` | Buys at BB lower, sells at BB upper in `sideways` regime |
| 13 | **RiskManager** | `src/risk/RiskManager.ts` | Enforces position size limits, max exposure, drawdown circuit breaker, SL/TP monitoring |
| 14 | **PoolAnalyzer** | `src/risk/PoolAnalyzer.ts` | Dead-coin filter: rejects illiquid, low-volume, or draining pools before order submission |
| 15 | **TradingEngine** | `src/execution/TradingEngine.ts` | BNB SDK provider wrapper; routes orders to PancakeSwap or BSC Perps; RPC failover |
| 16 | **GasOptimizer** | `src/execution/GasOptimizer.ts` | Fetches `baseFee + priorityFee`, applies urgency multiplier, clamps to `[minGasGwei, maxGasGwei]` |
| 17 | **MEVDefenseModule** | `src/execution/MEVDefenseModule.ts` | Splits orders above `thresholdUsd` into N randomized TWAP chunks with jittered intervals |
| 18 | **ExecutionService** | `src/execution/ExecutionService.ts` | TWAK-signed transaction submission; gas bump + nonce retry loop; slippage retry |
| 19 | **StateManager** | `src/state/StateManager.ts` | Atomic file writes with SHA-256 checksums; Zod validation on load; migration support |
| 20 | **AnalyticsEngine** | `src/analytics/AnalyticsEngine.ts` | Computes Sharpe ratio, win rate, max drawdown, latency P95; generates shutdown/backtest reports |
| 21 | **HealthMonitor** | `src/health/HealthMonitor.ts` | Periodic RPC connectivity checks; latency threshold alerts; emits `health:warning` / `health:critical` |

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
  ExecutionService     → TradingEngine, GasOptimizer, MEVDefenseModule, ConfigurationService
  StrategyManager      → SignalGenerator, RegimeDetector, ConfigurationService

Level 5 (depends on L0-4):
  Strategies (Momentum, MeanReversion, Range, MidBattleScalping) → ConfigurationService, StrategyManager

Level 6 (depends on L0-5):
  AnalyticsEngine      → StateManager, ConfigurationService
  HealthMonitor        → TradingEngine, ConfigurationService

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
| `strategy:signal` | `{ signal, strategy }` | StrategyManager | ExecutionService |
| `strategy:weights` | `{ weights, reason }` | StrategyManager | AnalyticsEngine |
| `strategy:deactivated` | `{ strategy, reason }` | StrategyManager | HealthMonitor |

### Risk Events
| Event | Payload | Emitter | Consumer |
|---|---|---|---|
| `risk:position_sized` | `{ orderId, size, portfolioUsd }` | RiskManager | AnalyticsEngine |
| `risk:position_rejected` | `{ orderId, reason }` | RiskManager | AnalyticsEngine |
| `risk:sl_triggered` | `{ positionId, price }` | RiskManager | ExecutionService |
| `risk:tp_triggered` | `{ positionId, price }` | RiskManager | ExecutionService |
| `risk:circuit_breaker` | `{ drawdownPct, portfolioUsd, timestamp }` | RiskManager | AgentOrchestrator |

### Execution Events
| Event | Payload | Emitter | Consumer |
|---|---|---|---|
| `execution:submitted` | `{ txHash, orderId, gasPrice }` | ExecutionService | AnalyticsEngine |
| `execution:confirmed` | `{ tx: Transaction }` | ExecutionService | RiskManager, StateManager |
| `execution:failed` | `{ orderId, error, attempt }` | ExecutionService | HealthMonitor |
| `mev:chunk_submitted` | `{ orderId, chunk, size, txHash }` | MEVDefenseModule | AnalyticsEngine |
| `mev:twap_complete` | `{ orderId, totalChunks }` | MEVDefenseModule | AnalyticsEngine |

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
| `health:warning` | `{ component, message }` | HealthMonitor | Logging |
| `health:shutdown` | `{ reason, timestamp }` | AgentOrchestrator | All components |

---

## Position Lifecycle Flow

```
Signal Generated (SignalGenerator)
        │
        ▼
StrategyManager.onSignal()
  → Checks regime compatibility
  → Strategy.onSignal() returns Order | null
        │
        ▼
RiskManager.validateNewPosition(order)
  ├─ Circuit breaker active? → REJECT
  ├─ Portfolio < minPortfolioUsd? → REJECT
  ├─ Total exposure would exceed maxExposurePct? → REDUCE or REJECT
  └─ OK → emit risk:position_sized
        │
        ▼
PoolAnalyzer.analyzePool(order.pair)
  ├─ Reserve < minReserveUsd? → REJECT (emit pool:rejected)
  ├─ Volume/Reserve ratio too low? → REJECT
  ├─ Tx count too low? → REJECT
  └─ OK → emit pool:approved
        │
        ▼
MEVDefenseModule.shouldSplit(order)?
  ├─ YES → buildTwapPlan(order) → executeTwap() → N chunks
  └─ NO  → single execution
        │
        ▼
ExecutionService.submitOrder(order)
  → GasOptimizer.getOptimalGasPrice()
  → TradingEngine.routeOrder(order)
      ├─ pancakeswap → PancakeSwap V2 swap tx
      └─ bsc_perpetuals → BSC Perps position tx
  → Sign via TWAK
  → Broadcast to BSC RPC
  → Wait for confirmation (up to txTimeoutSec)
  → emit execution:confirmed
        │
        ▼
RiskManager.onPositionOpened(position)
  → Add to openPositions map
  → SL/TP monitor starts watching
        │
        ▼
Position Open
  → SL monitor: price ≤ stopLoss → emit risk:sl_triggered
  → TP monitor: price ≥ takeProfit → emit risk:tp_triggered
        │
        ▼
ExecutionService closes position
        │
        ▼
AnalyticsEngine.recordTrade(tradeRecord)
  → Compute PnL, update metrics
  → Persist to analyticsFilePath
        │
        ▼
StateManager.saveState(state)
  → Atomic write with SHA-256 checksum
  → Every statePersistSec seconds
```
