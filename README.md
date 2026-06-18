# Blockout

**Autonomous AI Trading Agent — BNB Hack: AI Trading Agent Edition 2026**

Blockout is a production-grade autonomous AI trading agent for BNB Smart Chain. It **blocks out MEV bots** using the Anaconda Squeeze TWAP strategy, streams live intelligence from CoinMarketCap, signs and submits on-chain transactions via the `twak` CLI (Trust Wallet Agent Kit), and executes trades on PancakeSwap and BSC Perpetuals — all without any human in the loop.

---

## Sponsor Integrations

### CoinMarketCap

The agent uses the [CoinMarketCap Pro API](https://coinmarketcap.com/api/) as its primary market-data oracle via raw HTTP endpoints.

**Endpoints used:**
| Endpoint | Purpose |
|---|---|
| `GET /v2/cryptocurrency/quotes/latest` | Real-time price, volume, market cap |
| `GET /v2/cryptocurrency/ohlcv/historical` | Candlestick data for indicator computation |
| `GET /v3/cryptocurrency/technical-indicator/latest` | RSI-14, MACD, Bollinger Bands (falls back to neutral defaults if the API key tier does not include v3 indicator access) |

At startup, `MarketDataService` probes `GET /v4/agent/market-insights` to detect CMC Agent Hub access and logs the result. If Agent Hub is available on the configured key, its pre-computed regime/liquidity/risk signals can supplement or replace the raw indicator math in `SignalGenerator`. This is not yet wired — the probe is informational only and leaves existing behaviour unchanged.

**Getting an API key:**
1. Register at https://coinmarketcap.com/api/
2. Copy your key into `.env` as `CMC_API_KEY`

---

### Trust Wallet Agent Kit (TWAK)

`@trustwallet/agent-sdk` is not yet published on npm (verified 2026-06-18). The `twak` CLI was not on PATH at build time.

`src/execution/TWAKAdapter.ts` wraps the `twak` binary via `child_process.execFile`. It calls:
- `twak --version` to confirm the CLI is available at `initialize()` time
- `twak wallet address` to retrieve the agent wallet address
- `twak sign --raw <unsignedTxHex>` to sign each transaction before broadcasting

`ExecutionService.initialize()` calls `TWAKAdapter.initialize()` and **fails loudly** — emitting `health:critical` and throwing — if `twak` is not on PATH. There is no silent fallback to a local key.

**To activate:** install the TWAK CLI and configure your credentials:
```bash
curl -fsSL https://agent-kit.trustwallet.com/install.sh | bash
# Then verify: twak wallet address
```

`TWAK_ACCESS_ID` and `TWAK_HMAC_SECRET` are validated by `ConfigurationService` but currently optional (empty string is accepted) since the CLI handles authentication independently.

> **Security note:** Never commit `.env` to source control. The `.gitignore` excludes it by default.

---

### BNB AI Agent SDK

Not integrated. `@bnb-chain/bnbagent-sdk` is not published on npm (verified 2026-06-18). The package targets ERC-8004 identity registration and APEX agent commerce, not trading-competition execution or scoring. This is not a meaningful integration for this track.

`src/execution/BNBAgentAdapter.ts` documents this decision.

BSC network interaction (RPC provider, PancakeSwap V2 swaps, BSC Perpetuals, gas estimation) is handled directly via `ethers` v6 in `TradingEngine`. Network switching: set `NETWORK_MODE=mainnet` and `CHAIN_ID=56` for live trading. Defaults to `testnet` (Chain ID 97).

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Mohamed-Aaftaab/Blockout.git
cd Blockout
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — minimum required: CMC_API_KEY, RPC_ENDPOINTS, CHAIN_ID, 
#             PANCAKESWAP_ROUTER, BSC_PERPS_CONTRACT, TRADING_PAIRS

# 3a. Run in testnet mode (safe, default)
npm run dev

# 3b. Run in mainnet mode (LIVE TRADING — real funds at risk)
NETWORK_MODE=mainnet npm start
```

The agent loads `.env` automatically via `dotenv` on both `npm run dev` and `npm start`.

### Wallet Setup

On first run, a self-custody wallet is created and saved to `data/wallet.key` (mode 0600, gitignored). Fund this address with testnet BNB before trading:

```
# Testnet faucet: https://testnet.bnbchain.org/faucet-smart
```

### Running Tests

```bash
npm test                # Unit + property-based tests (44 tests)
npm run test:coverage   # With coverage report
npm run typecheck       # Type-check only
```

---

## Architecture Overview

The agent is an event-driven system with 15 components communicating through a typed `EventBus`.

```
┌─────────────────────────────────────────────────────────┐
│                    Bootstrap (index.ts)                  │
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
│        StateManager  │  AnalyticsEngine                 │
│        HealthMonitor │  EventBus                        │
└─────────────────────────────────────────────────────────┘
```

**Signal pipeline:**
1. `MarketDataService` polls CMC every 60s → emits `market:data`
2. `RegimeDetector` classifies market as bull / bear / sideways
3. `SignalGenerator` computes RSI, MACD, Bollinger, whale, and price-momentum signals
4. `StrategyManager` picks the winning strategy for the current regime
5. `RiskManager` validates position size and exposure limits
6. `MEVDefenseModule` (Anaconda Squeeze) splits large orders into randomized TWAP chunks
7. `ExecutionService` sends approve + swap transactions to BSC via the nonce-serialized wallet
8. `AnalyticsEngine` records the trade and updates Sharpe ratio, win rate, and drawdown

**Four trading strategies:**
| Strategy | Regime | Signal |
|---|---|---|
| `MidBattleScalping` | Any | Buy when price drops ≥10% from session ATH (TWAP) |
| `Momentum` | Bull | Buy/sell on composite confidence ≥0.6 |
| `MeanReversion` | Bear | Buy RSI oversold or Bollinger lower band |
| `Range` | Sideways | Buy at Bollinger lower, sell at upper |

**Key correctness properties tested (property-based, fast-check):**
- TWAP chunk sizes always sum exactly to `order.size`
- Position SL always < entry, TP always > entry for buys (reversed for sells)
- Gas price always clamped to `[minGasGwei, maxGasGwei]`
- Signal confidence always in `[0.0, 1.0]`
- State round-trips through persist/load with matching checksum
- Strategy weights always normalize to sum 1.0

---

## Key Safety Features

- **Circuit breaker**: halts trading if portfolio drawdown exceeds `MAX_DRAWDOWN_PCT` (default 20%). Persists across restarts. Reset via `touch RESET_CIRCUIT_BREAKER`.
- **Anaconda Squeeze TWAP**: orders above threshold split into N randomized time-weighted chunks to prevent front-running
- **Close size cap**: checks on-chain ERC-20 balance before selling to prevent reverts from partial fills
- **Dead-coin filter**: `PoolAnalyzer` rejects pools with insufficient reserve, volume, or tx count
- **State integrity**: atomic writes with SHA-256 checksums. Corrupted state detected on load.
- **Nonce serialization**: concurrent pair executions are serialized through a nonce lock to prevent collisions
- **Graceful shutdown**: `touch SHUTDOWN` triggers clean position close and final state save

---

## Configuration

See `.env.example` for all 40+ configuration variables with comments.

**Required variables (no defaults):**

| Variable | Example |
|---|---|
| `CMC_API_KEY` | `your_key_here...` (min 32 chars) |
| `RPC_ENDPOINTS` | `https://bsc-dataseed1.binance.org` |
| `CHAIN_ID` | `97` (testnet) or `56` (mainnet) |
| `TRADING_PAIRS` | `BNB/USDT,CAKE/USDT` |
| `PANCAKESWAP_ROUTER` | Testnet: `0xD99D1c33F9fC3444f8101754aBC46c52416550D1` |
| `BSC_PERPS_CONTRACT` | `0x0000000000000000000000000000000000000000` |

**TWAK credentials are optional** — the agent works without them using a local ethers wallet.

---

## Directory Structure

```
Blockout/
├── src/
│   ├── analytics/        # AnalyticsEngine — Sharpe, drawdown, P&L
│   ├── config/           # ConfigurationService + Zod schema (40+ vars)
│   ├── events/           # Typed EventBus (35+ events)
│   ├── execution/        # TradingEngine, GasOptimizer, MEVDefense, ExecutionService
│   │   ├── BNBAgentAdapter.ts   # BNB AI Agent SDK integration contract
│   │   └── TWAKAdapter.ts       # Trust Wallet Agent Kit integration contract
│   ├── health/           # HealthMonitor with circuit breaker wiring
│   ├── market/           # MarketDataService, SignalGenerator, RegimeDetector
│   ├── risk/             # RiskManager, PoolAnalyzer
│   ├── state/            # StateManager — atomic writes + SHA-256 checksums
│   ├── strategies/       # IStrategy + 4 concrete strategies + StrategyManager
│   ├── types/            # Shared types, Result monad, error classes
│   ├── utils/            # sleep, uuid, withRetry, makeLogger
│   └── __tests__/        # 44 unit + property-based tests (fast-check)
├── data/                 # Runtime state/analytics/wallet (gitignored)
├── docs/                 # Architecture, config reference, deployment guide
├── .env.example          # All config vars with comments and examples
├── jest.config.ts
└── tsconfig.json         # TypeScript strict mode
```

---

## License

MIT License — see `LICENSE` for details.

> **Disclaimer:** This software is provided for educational and hackathon purposes. Live trading with real funds carries substantial risk of loss. The authors are not responsible for any financial losses incurred.
