# Blockout

**Autonomous AI Trading Agent — BNB Hack 2026**

Blockout is a production-grade autonomous AI trading agent for BNB Smart Chain. It **blocks out MEV bots** using the Anaconda Squeeze TWAP strategy, streams live intelligence from CoinMarketCap, signs and submits on-chain transactions through Trust Wallet Agent Kit, and executes trades on PancakeSwap and BSC Perpetuals — all without any human in the loop.

---

## Sponsor Integrations

### CoinMarketCap Agent Hub

The agent uses the [CoinMarketCap Pro API](https://coinmarketcap.com/api/) as its primary market-data oracle.

**Endpoints used:**
| Endpoint | Purpose |
|---|---|
| `GET /v2/cryptocurrency/quotes/latest` | Real-time price, volume, market cap |
| `GET /v2/cryptocurrency/ohlcv/historical` | Candlestick data for indicator computation |
| `GET /v3/cryptocurrency/technical-indicator/latest` | RSI-14, MACD, Bollinger Bands |

**Getting an API key:**
1. Register at https://coinmarketcap.com/api/
2. Choose a plan (Basic tier works for testing; Pro tier for production polling at 60s intervals)
3. Copy your key into `.env` as `CMC_API_KEY`

The key must be at least 32 characters. The agent validates this at startup and refuses to run with a missing or short key.

---

### Trust Wallet Agent Kit (TWAK)

The agent uses [Trust Wallet Agent Kit](https://developer.trustwallet.com/agent-kit) for **self-custody transaction signing in autonomous mode**. No private key is ever transmitted to a third party.

**Integration pattern:**
1. TWAK is initialized with `TWAK_ACCESS_ID` and `TWAK_HMAC_SECRET` from environment
2. The `ExecutionService` requests a signed transaction payload from TWAK for each order
3. TWAK signs the transaction locally and returns the raw signed bytes
4. The agent broadcasts the signed transaction to BSC via its configured RPC endpoints

**Autonomous mode:** TWAK's autonomous signing mode allows the agent to submit transactions without interactive approval. This is enabled by setting your HMAC secret in `.env`.

> **Security note:** Never commit `.env` to source control. The `.gitignore` excludes it by default.

---

### BNB AI Agent SDK

The agent uses the [BNB AI Agent SDK](https://docs.bnbchain.org/bnb-smart-chain/) to interact with BSC mainnet (Chain ID 56) and testnet (Chain ID 97).

**Capabilities used:**
| Feature | SDK Component |
|---|---|
| BSC RPC provider with failover | `BNBAgentProvider` |
| PancakeSwap V2 swaps | `PancakeSwapRouter` (0x10ED43C718714eb63d5aA57B78B54704E256024E) |
| BSC Perpetuals long/short | `BSCPerpsContract` |
| Pool reserve queries | `PancakeV3Factory` |
| Gas estimation | `provider.getFeeData()` |

**Network switching:** Set `NETWORK_MODE=mainnet` and `CHAIN_ID=56` for live trading. Defaults to `testnet` (Chain ID 97) for safe development.

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-username/sovereign-bnb-agent.git
cd sovereign-bnb-agent

# 2. Install dependencies
npm install

# 3. Copy the example environment file
cp .env.example .env

# 4. Edit .env with your API keys and configuration
# Required: CMC_API_KEY, TWAK_ACCESS_ID, TWAK_HMAC_SECRET
# Required: RPC_ENDPOINTS, CHAIN_ID, PANCAKESWAP_ROUTER
nano .env   # or your editor of choice

# 5a. Run in testnet mode (safe, default)
npm run dev

# 5b. Run in mainnet mode (LIVE TRADING — real funds at risk)
NETWORK_MODE=mainnet npm start
```

### Running Tests

```bash
# Unit tests + property-based tests
npm test

# With coverage report
npm run test:coverage

# Type-check only (no compilation output)
npm run typecheck
```

---

## Architecture Overview

The agent is built as a layered event-driven system with 15 components communicating through a typed `EventBus`.

```
┌─────────────────────────────────────────────────────────┐
│                    AgentOrchestrator                     │
├────────────┬──────────────┬──────────────┬──────────────┤
│  Market    │  Strategy    │    Risk      │  Execution   │
│  Layer     │  Layer       │    Layer     │  Layer       │
├────────────┼──────────────┼──────────────┼──────────────┤
│MarketData  │StrategyMgr   │ RiskManager  │ExecutionSvc  │
│Service     │MomentumStrat │ PoolAnalyzer │TradingEngine │
│SignalGen   │MeanReversion │              │GasOptimizer  │
│RegimeDet.  │RangeStrategy │              │MEVDefense    │
│            │MidBattle     │              │              │
├────────────┴──────────────┴──────────────┴──────────────┤
│          StateManager  │  AnalyticsEngine               │
│          HealthMonitor │  EventBus                      │
└─────────────────────────────────────────────────────────┘
```

**Data flow:**
1. `MarketDataService` polls CMC every 60s and emits `market:data`
2. `SignalGenerator` computes RSI/MACD/Bollinger/Whale signals and emits `signal:generated`
3. `StrategyManager` routes the composite signal to the active strategy for the current regime
4. `RiskManager` validates position size and exposure before accepting an order
5. `MEVDefenseModule` splits large orders into TWAP chunks
6. `ExecutionService` signs via TWAK and broadcasts to BSC
7. `AnalyticsEngine` records the trade and updates Sharpe/drawdown metrics

**Full documentation:**
- [Architecture](docs/architecture.md) — component diagram, event catalog, position lifecycle
- [Configuration Reference](docs/configuration-reference.md) — all 35 environment variables
- [Deployment Guide](docs/deployment-guide.md) — testnet, mainnet, backtest, demo, monitoring

---

## Directory Structure

```
sovereign-bnb-agent/
├── src/
│   ├── analytics/        # AnalyticsEngine — Sharpe, drawdown, P&L
│   ├── config/           # ConfigurationService + Zod schema
│   ├── events/           # Typed EventBus
│   ├── execution/        # TradingEngine, GasOptimizer, MEVDefense, ExecutionService
│   ├── health/           # HealthMonitor
│   ├── market/           # MarketDataService, SignalGenerator, RegimeDetector
│   ├── risk/             # RiskManager, PoolAnalyzer
│   ├── state/            # StateManager with atomic writes + checksums
│   ├── strategies/       # IStrategy + 4 concrete strategies + StrategyManager
│   ├── types/            # Shared types + error classes
│   ├── utils/            # sleep, uuid, withRetry (exponential backoff)
│   └── __tests__/        # Unit tests + property-based tests (fast-check)
├── data/                 # Runtime state and analytics (gitignored)
├── docs/                 # Documentation
├── .env.example          # All 35 config vars with comments
├── jest.config.ts        # Jest + ts-jest configuration
└── tsconfig.json         # TypeScript strict config
```

---

## Environment Variables

See [docs/configuration-reference.md](docs/configuration-reference.md) for the full table of all 35 variables.

**Required variables (no defaults):**

| Variable | Description |
|---|---|
| `CMC_API_KEY` | CoinMarketCap Pro API key (min 32 chars) |
| `TWAK_ACCESS_ID` | Trust Wallet Agent Kit access ID |
| `TWAK_HMAC_SECRET` | Trust Wallet Agent Kit HMAC secret (min 16 chars) |
| `RPC_ENDPOINTS` | Comma-separated BSC RPC URLs |
| `CHAIN_ID` | 56 (mainnet) or 97 (testnet) |
| `TRADING_PAIRS` | Comma-separated pairs e.g. `BNB/USDT,CAKE/USDT` |
| `PANCAKESWAP_ROUTER` | PancakeSwap V2 Router contract address |
| `BSC_PERPS_CONTRACT` | BSC Perpetuals contract address |

---

## Safety Features

- **Circuit breaker**: automatically halts trading if drawdown exceeds `MAX_DRAWDOWN_PCT`
- **TWAP / MEV defense**: splits orders above `TWAP_THRESHOLD_USD` into randomized time-weighted chunks
- **Dead-coin filter**: `PoolAnalyzer` rejects pools with insufficient liquidity or activity
- **State persistence**: atomic writes with SHA-256 checksums prevent corrupt state on restart
- **Emergency shutdown**: `touch SHUTDOWN` (or set `SHUTDOWN_SIGNAL_FILE` path) gracefully stops the agent

---

## License

MIT License — see `LICENSE` for details.

> **Disclaimer:** This software is provided for educational and hackathon purposes. Live trading with real funds carries substantial risk of loss. The authors are not responsible for any financial losses incurred through use of this software.
