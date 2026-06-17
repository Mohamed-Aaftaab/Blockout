# Deployment Guide

This guide covers all supported deployment modes for the Sovereign BNB Agent.

---

## Prerequisites

Before running the agent in any mode, ensure the following are in place:

1. **Node.js 20+** — Check with `node --version`. LTS 20.x or later is required.
2. **npm 10+** — Check with `npm --version`.
3. **BSC RPC endpoint** — A reliable JSON-RPC endpoint for BNB Smart Chain. Options:
   - Public: `https://bsc-dataseed1.binance.org` (may have rate limits)
   - Private: [QuickNode](https://www.quicknode.com/), [Ankr](https://www.ankr.com/), [NodeReal](https://nodereal.io/)
   - Recommended: configure 3+ endpoints in `RPC_ENDPOINTS` for automatic failover
4. **CoinMarketCap Pro API key** — Required, min 32 characters. Free tier may be rate-limited; the agent polls every 60 seconds.
5. **Trust Wallet Agent Kit credentials** — `TWAK_ACCESS_ID` and `TWAK_HMAC_SECRET` from your TWAK dashboard.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/your-username/sovereign-bnb-agent.git
cd sovereign-bnb-agent

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
TWAK_ACCESS_ID=your_twak_access_id
TWAK_HMAC_SECRET=your_twak_hmac_secret_min_16_chars

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
# Development mode with ts-node (no build step)
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
{"level":"info","message":"Agent running in testnet mode"}
```

The agent persists state to `./data/state.json`. On restart it loads the previous state, verifies the SHA-256 checksum, and resumes open positions.

---

## Mainnet Deployment (Chain ID: 56)

> **WARNING: This uses real BNB. Ensure you fully understand the risks before running in mainnet mode. The circuit breaker protects against excessive drawdown, but cannot prevent all losses. Test thoroughly on testnet first.**

### 1. Configure `.env` for Mainnet

```dotenv
# Credentials
CMC_API_KEY=your_cmc_pro_api_key_here_32_chars_min
TWAK_ACCESS_ID=your_twak_access_id
TWAK_HMAC_SECRET=your_twak_hmac_secret_min_16_chars

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
```

### 2. Build and Start

```bash
npm run build
NETWORK_MODE=mainnet npm start
```

### 3. Mainnet Safety Checklist

Before going live, confirm:
- [ ] `NETWORK_MODE=mainnet` and `CHAIN_ID=56` are set correctly
- [ ] `MAX_DRAWDOWN_PCT` is set to a value you are comfortable losing
- [ ] `MAX_POSITION_PCT` limits exposure per trade
- [ ] Multiple `RPC_ENDPOINTS` are configured for failover
- [ ] `PANCAKESWAP_ROUTER` is the correct mainnet address
- [ ] State and analytics directories (`./data/`) have write permissions
- [ ] The TWAK signing key has been tested on testnet
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
=== SOVEREIGN BNB AGENT — BACKTEST REPORT ===
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

Demo mode runs the full agent logic in real time but signs all transactions in a simulated wallet — no on-chain transactions occur.

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

The `HealthMonitor` component runs periodic checks and emits events the orchestrator handles.

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
| Circuit breaker triggered | `risk:circuit_breaker` | Trading halted; manual reset required |
| State checksum mismatch | `state:corrupted` | Agent stops; fix state file |
| CMC circuit open | `market:circuit_open` | CMC unreachable for 5+ minutes; agent idles |

### Checking Agent Status

```bash
# View open positions and drawdown
cat ./data/state.json | jq '{positions: .openPositions | length, drawdown: .drawdownBaseline, cb: .circuitBreakerActive}'

# View latest performance metrics
cat ./data/analytics.json | jq '{pnl: .totalPnlUsd, winRate: .winRate, sharpe: .sharpeRatio}'
```

### Resetting the Circuit Breaker

The circuit breaker is reset only by restarting the agent after confirming the portfolio has recovered or after manually editing `./data/state.json` and setting `"circuitBreakerActive": false` with an updated checksum. Alternatively, wait for the portfolio to recover above the `drawdownBaseline`.

---

## Emergency Shutdown

To immediately halt all trading and close the agent gracefully:

### Method 1: Signal File (Recommended)

```bash
# Create the shutdown signal file
touch ./SHUTDOWN

# The agent polls every SHUTDOWN_POLL_MS (default 5s) and shuts down when the file exists
# It completes any in-flight transactions before stopping
```

### Method 2: SIGTERM

```bash
# Send SIGTERM to the process (graceful shutdown)
kill -SIGTERM $(pgrep -f "node dist/index.js")
```

### Method 3: SIGINT (Ctrl+C)

```bash
# Press Ctrl+C in the terminal where the agent is running
# The agent catches SIGINT and shuts down gracefully
```

On shutdown the agent:
1. Stops accepting new signals
2. Waits for in-flight transactions to confirm (up to `TX_TIMEOUT_SEC`)
3. Saves final state to `STATE_FILE_PATH`
4. Writes a shutdown report to the log
5. Exits with code 0

The shutdown file is automatically removed after the agent exits.

---

## Upgrading

To upgrade to a new version:

```bash
# 1. Stop the agent (gracefully)
touch ./SHUTDOWN
sleep 10

# 2. Backup state and config
cp ./data/state.json ./data/state.json.backup
cp .env .env.backup

# 3. Pull new code
git pull origin main

# 4. Install updated dependencies
npm install

# 5. Run migrations if any are listed in the CHANGELOG
# (Migrations run automatically on first start)

# 6. Type-check and test
npm run typecheck
npm test

# 7. Remove the shutdown signal and restart
rm ./SHUTDOWN
npm run build
npm start
```

### State Migration

The `StateManager` includes a migration system in `src/state/migrations/`. On startup, if the persisted state's `version` field is older than the current version, migrations are applied automatically.

Check the current state version:
```bash
cat ./data/state.json | jq .version
```

---

## Production Best Practices

1. **Use a process manager**: Run the agent under `pm2` or `systemd` for automatic restart on crash:
   ```bash
   npm install -g pm2
   pm2 start dist/index.js --name sovereign-bnb-agent
   pm2 save
   pm2 startup
   ```

2. **Log rotation**: The agent writes to stdout. Configure logrotate or `pm2`'s built-in log rotation to prevent unbounded disk usage.

3. **Separate `.env` per environment**: Use `.env.testnet` and `.env.mainnet`. Never reuse testnet credentials on mainnet.

4. **Monitor `MAX_GAS_GWEI`**: During BSC network congestion, you may need to increase `MAX_GAS_GWEI` temporarily or the agent will fail to get transactions included.

5. **Multiple RPC endpoints**: Configure at least 3 RPC endpoints. The agent automatically failovers with exponential backoff when an RPC node is unreachable.
