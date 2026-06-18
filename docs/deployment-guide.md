# Deployment Guide

This guide covers all supported deployment modes for **Blockout** — the autonomous AI trading agent for BNB Smart Chain.

---

## Prerequisites

Before running the agent in any mode, ensure the following are in place:

1. **Node.js 20+** — Check with `node --version`. LTS 20.x or later is required.
2. **npm 10+** — Check with `npm --version`.
3. **BSC RPC endpoint** — A reliable JSON-RPC endpoint for BNB Smart Chain. Options:
   - Public: `https://bsc-dataseed1.binance.org` (may have rate limits)
   - Private: [QuickNode](https://www.quicknode.com/), [Ankr](https://www.ankr.com/), [NodeReal](https://nodereal.io/)
   - Recommended: configure 3+ endpoints in `RPC_ENDPOINTS` for automatic failover
4. **CoinMarketCap Pro API key** — Required, min 32 characters. The agent polls every 60 seconds and falls back to price-momentum signals if the v3 indicator endpoint is unavailable.
5. **Trust Wallet Agent Kit credentials** — Optional. `TWAK_ACCESS_ID` and `TWAK_HMAC_SECRET` are reserved for when the TWAK SDK publishes to npm. The agent runs fully without them using a self-custody ethers.Wallet.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/Mohamed-Aaftaab/Blockout.git
cd Blockout

# Install all dependencies (pinned versions for reproducibility)
npm install

# Verify TypeScript compilation
npm run typecheck

# Run test suite to confirm everything works
npm test
```

---

## Testnet Deployment (Chain ID: 97)

BSC Testnet is the recommended starting point. No real funds are at risk.

### 1. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
# Credentials
CMC_API_KEY=your_cmc_pro_api_key_here_32_chars_min

# Network — TESTNET
NETWORK_MODE=testnet
RPC_ENDPOINTS=https://data-seed-prebsc-1-s1.binance.org:8545,https://data-seed-prebsc-2-s1.binance.org:8545
CHAIN_ID=97

# Trading
TRADING_PAIRS=BNB/USDT
PANCAKESWAP_ROUTER=0xD99D1c33F9fC3444f8101754aBC46c52416550D1
BSC_PERPS_CONTRACT=0x0000000000000000000000000000000000000000

# Risk — conservative defaults
MAX_POSITION_PCT=5
MAX_EXPOSURE_PCT=30
MAX_DRAWDOWN_PCT=20
MIN_PORTFOLIO_USD=100
```

### 2. Start the Agent

```bash
# Development mode with ts-node (no build step, loads .env automatically)
npm run dev

# Or build first and run from dist/
npm run build
npm start
```

### 3. Verify It's Running

Watch the logs for:
```
{"level":"info","message":"TradingEngine initialized","endpoint":"https://data-seed-prebsc..."}
{"level":"info","message":"MarketDataService started"}
{"level":"info","message":"System READY — Blockout is live"}
```

On first run, a self-custody wallet is created and saved to `data/wallet.key` (mode 0600, gitignored). Fund this address with testnet BNB:

```
Testnet faucet: https://testnet.bnbchain.org/faucet-smart
```

The agent persists state to `./data/state.json`. On restart it loads the previous state, verifies the SHA-256 checksum, and resumes monitoring open positions.

---

## Mainnet Deployment (Chain ID: 56)

> **WARNING: This uses real BNB. Ensure you fully understand the risks before running in mainnet mode. The circuit breaker protects against excessive drawdown, but cannot prevent all losses. Test thoroughly on testnet first.**

### 1. Configure `.env` for Mainnet

```dotenv
# Credentials
CMC_API_KEY=your_cmc_pro_api_key_here_32_chars_min

# Network — MAINNET
NETWORK_MODE=mainnet
RPC_ENDPOINTS=https://bsc-dataseed1.binance.org,https://bsc-dataseed2.binance.org,https://bsc-dataseed3.binance.org
CHAIN_ID=56

# Trading
TRADING_PAIRS=BNB/USDT,CAKE/USDT
PANCAKESWAP_ROUTER=0x10ED43C718714eb63d5aA57B78B54704E256024E
BSC_PERPS_CONTRACT=0x0000000000000000000000000000000000000000

# Risk — recommended conservative settings for mainnet
MAX_POSITION_PCT=5
MAX_EXPOSURE_PCT=30
STOP_LOSS_PCT=5
TAKE_PROFIT_PCT=15
MAX_DRAWDOWN_PCT=15
MIN_PORTFOLIO_USD=500
LEVERAGE_MULTIPLIER=1

# Gas — mainnet requires accurate gas settings
GAS_URGENCY_MULTIPLIER=1.3
MIN_GAS_GWEI=3
MAX_GAS_GWEI=200

# Slippage — 1.5% default handles BSC V2 pool variance
DEFAULT_SLIPPAGE_PCT=1.5
MAX_SLIPPAGE_PCT=5.0
```

### 2. Build and Start

```bash
npm run build
npm start
```

### 3. Mainnet Safety Checklist

Before going live, confirm:
- [ ] `NETWORK_MODE=mainnet` and `CHAIN_ID=56` are set correctly
- [ ] `MAX_DRAWDOWN_PCT` is set to a value you are comfortable losing
- [ ] `MAX_POSITION_PCT` limits exposure per trade
- [ ] Multiple `RPC_ENDPOINTS` are configured for failover
- [ ] `PANCAKESWAP_ROUTER` is the correct mainnet V2 address
- [ ] State and analytics directories (`./data/`) have write permissions
- [ ] You have reviewed all logs from a testnet run

---

## Running Backtest Mode

Backtest mode replays historical market data without submitting any transactions.

```bash
# Set in .env or pass inline
BACKTEST_MODE=true \
BACKTEST_FROM=2024-01-01 \
BACKTEST_TO=2024-06-30 \
BACKTEST_CAPITAL=10000 \
npm start
```

On completion the agent prints a detailed report:
```
=== BLOCKOUT — BACKTEST REPORT ===
Generated: 2024-07-01T00:00:00.000Z
Total Trades:    247
Win Rate:        58.3%
Total PnL:       $1,432.18
Sharpe Ratio:    1.24
Max Drawdown:    8.2%
Avg Slippage:    0.041%
Latency P95:     N/A (simulated)
```

**Requirements:** The CMC API must be reachable for historical OHLCV data. Ensure `CMC_API_KEY` is valid.

---

## Running Demo Mode

Demo mode runs the full agent logic in real time but does not submit on-chain transactions.

```bash
# Run for 1 hour (3600 seconds)
DEMO_MODE=true DEMO_CAPITAL=1000 DEMO_DURATION=3600 npm start

# Run indefinitely
DEMO_MODE=true DEMO_CAPITAL=1000 DEMO_DURATION=0 npm run dev
```

Demo mode is useful for:
- Verifying signal generation logic with live CMC data
- Testing risk management thresholds without capital at risk
- Measuring actual signal-to-execution latency

---

## Health Monitoring

### Monitoring Endpoints

The agent logs JSON-structured health information to stdout. Pipe to your log aggregator of choice:

```bash
npm start 2>&1 | tee agent.log | grep '"level":"error"'
```

### Key Health Indicators

| Indicator | Log field | Action |
|---|---|---|
| RPC connectivity | `health:critical` | Auto-failover to next RPC |
| Signal-to-tx latency > target | `health:latency` | Warning log |
| Circuit breaker triggered | `risk:circuit_breaker` | Trading halted; reset via file signal |
| State checksum mismatch | `state:corrupted` | Agent stops; fix state file |
| CMC circuit open | `market:circuit_open` | CMC unreachable; agent idles |
| Close order failed 5× | `health:critical` | Position stuck; manual intervention required |

### Checking Agent Status

```bash
# View open positions and drawdown
cat ./data/state.json | jq '{positions: .openPositions | length, drawdown: .drawdownBaseline, cb: .circuitBreakerActive}'

# View latest performance metrics
cat ./data/analytics.json | jq '{pnl: .totalPnlUsd, winRate: .winRate, sharpe: .sharpeRatio}'
```

### Resetting the Circuit Breaker

Use the file-signal reset — no restart required:

```bash
touch ./RESET_CIRCUIT_BREAKER
# HealthMonitor polls every SHUTDOWN_POLL_MS (default 5s),
# deletes the file, and emits health:circuit_breaker_reset.
# RiskManager resets and trading resumes immediately.
```

Alternatively, set `"circuitBreakerActive": false` in `./data/state.json` and restart — the StateManager will validate and load the updated state.

---

## Emergency Shutdown

To immediately halt all trading and close the agent gracefully:

### Method 1: Signal File (Recommended)

```bash
# Create the shutdown signal file
touch ./SHUTDOWN

# The agent polls every SHUTDOWN_POLL_MS (default 5s) and shuts down when the file exists.
# In-flight transactions complete before the process exits.
```

### Method 2: SIGTERM

```bash
# Send SIGTERM to the process (graceful shutdown)
kill -SIGTERM $(pgrep -f "node dist/index.js")
```

### Method 3: SIGINT (Ctrl+C)

```bash
# Press Ctrl+C in the terminal where the agent is running
```

On shutdown the agent:
1. Stops accepting new signals
2. Completes in-flight transactions (up to `TX_TIMEOUT_SEC`)
3. Saves final state to `STATE_FILE_PATH` (atomic write with SHA-256)
4. Writes a shutdown report to the log
5. Exits with code 0

---

## Upgrading

```bash
# 1. Stop the agent
touch ./SHUTDOWN
sleep 10

# 2. Backup state and config
cp ./data/state.json ./data/state.json.backup
cp .env .env.backup

# 3. Pull new code
git pull origin master

# 4. Install updated dependencies
npm install

# 5. Type-check and test
npm run typecheck
npm test

# 6. Restart
rm ./SHUTDOWN
npm run build
npm start
```

### State Migration

The `StateManager` includes a migration system in `src/state/migrations/`. If the persisted state's `version` field is older than the current version, migrations run automatically on startup.

```bash
# Check current state version
cat ./data/state.json | jq .version
```

---

## Production Best Practices

1. **Use a process manager** — Run under `pm2` for automatic restart on crash:
   ```bash
   npm install -g pm2
   pm2 start dist/index.js --name blockout
   pm2 save
   pm2 startup
   ```

2. **Log rotation** — The agent writes to stdout. Configure `pm2` log rotation or `logrotate` to prevent unbounded disk usage.

3. **Separate `.env` per environment** — Never reuse testnet credentials on mainnet.

4. **Monitor `MAX_GAS_GWEI`** — During BSC congestion, temporarily increase `MAX_GAS_GWEI` or transactions will fail to land.

5. **Multiple RPC endpoints** — Configure at least 3. The agent failovers automatically with exponential backoff when an RPC node is unreachable.

6. **State backup** — The periodic state save runs every `STATE_PERSIST_SEC` (default 30s). Back up `./data/state.json` regularly in production.
