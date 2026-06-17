# Configuration Reference

All configuration is provided through environment variables. Copy `.env.example` to `.env` and fill in the required values before starting the agent.

---

## Complete Variable Table

| Variable | Type | Range / Format | Required | Default | Description |
|---|---|---|---|---|---|
| `CMC_API_KEY` | string | min 32 chars | **yes** | — | CoinMarketCap Pro API key. Register at https://coinmarketcap.com/api/ |
| `TWAK_ACCESS_ID` | string | min 8 chars | **yes** | — | Trust Wallet Agent Kit access ID for transaction signing |
| `TWAK_HMAC_SECRET` | string | min 16 chars | **yes** | — | Trust Wallet Agent Kit HMAC secret for autonomous signing |
| `NETWORK_MODE` | enum | `testnet` \| `mainnet` | no | `testnet` | BSC network to connect to. Logs a warning when not set |
| `RPC_ENDPOINTS` | string | comma-separated URLs | **yes** | — | Ordered list of BSC JSON-RPC endpoints. First is primary; rest are failover candidates |
| `RPC_TIMEOUT_MS` | integer | 1000–30000 | no | `10000` | Per-RPC-call timeout in milliseconds |
| `RPC_BACKOFF_BASE` | number | 1–10 | no | `2` | Base multiplier for exponential backoff between RPC failover attempts (seconds) |
| `RPC_BACKOFF_MAX` | number | 10–120 | no | `60` | Maximum backoff wait between RPC failover attempts (seconds) |
| `CHAIN_ID` | integer | positive | **yes** | — | BSC chain ID: `97` for testnet, `56` for mainnet |
| `TRADING_PAIRS` | string | comma-separated `UPPER/UPPER` | **yes** | — | Trading pairs to monitor and trade, e.g. `BNB/USDT,CAKE/USDT` |
| `PANCAKESWAP_ROUTER` | string | `0x[40 hex chars]` | **yes** | — | PancakeSwap V2 Router contract address |
| `BSC_PERPS_CONTRACT` | string | `0x[40 hex chars]` | **yes** | — | BSC Perpetuals contract address for leveraged positions |
| `PANCAKE_V3_FACTORY` | string | `0x[40 hex chars]` | no | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` | PancakeSwap V3 Factory address for pool reserve queries |
| `MAX_POSITION_PCT` | number | 0.1–20 | no | `5` | Maximum portfolio percentage allowed per individual position |
| `MAX_EXPOSURE_PCT` | number | 1–100 | no | `30` | Maximum total portfolio percentage across all open positions |
| `STOP_LOSS_PCT` | number | 0.1–50 | no | `5` | Stop-loss distance as percentage below entry price |
| `TAKE_PROFIT_PCT` | number | 0.1–200 | no | `15` | Take-profit distance as percentage above entry price |
| `MAX_DRAWDOWN_PCT` | number | 1–50 | no | `20` | Maximum drawdown percentage before circuit breaker activates |
| `MIN_PORTFOLIO_USD` | number | ≥10 | no | `100` | Minimum portfolio value in USD required to open new positions |
| `LEVERAGE_MULTIPLIER` | number | 1–20 | no | `1` | Leverage multiplier for BSC Perpetuals positions (1 = no leverage) |
| `TWAP_THRESHOLD_USD` | number | ≥100 | no | `1000` | Order size threshold above which TWAP splitting is activated |
| `TWAP_CHUNK_COUNT` | integer | 2–20 | no | `10` | Number of equal-time chunks to split a TWAP order into |
| `TWAP_MIN_INTERVAL_MS` | integer | 5000–60000 | no | `15000` | Minimum random interval between TWAP chunks (milliseconds) |
| `TWAP_MAX_INTERVAL_MS` | integer | 5000–300000 | no | `45000` | Maximum random interval between TWAP chunks (milliseconds) |
| `GAS_URGENCY_MULTIPLIER` | number | 1.0–3.0 | no | `1.2` | Multiplier applied to `(baseFee + priorityFee)` for default urgency |
| `MIN_GAS_GWEI` | number | 1–100 | no | `3` | Minimum gas price floor in Gwei |
| `MAX_GAS_GWEI` | number | 1–1000 | no | `100` | Maximum gas price ceiling in Gwei |
| `DEFAULT_SLIPPAGE_PCT` | number | 0.1–5 | no | `0.5` | Default slippage tolerance percentage for market orders |
| `MAX_SLIPPAGE_PCT` | number | 0.5–10 | no | `3.0` | Maximum allowed slippage before order is rejected |
| `RSI_OVERSOLD` | integer | 10–40 | no | `30` | RSI-14 value below which a `rsi_oversold` buy signal is generated |
| `RSI_OVERBOUGHT` | integer | 60–90 | no | `70` | RSI-14 value above which a `rsi_overbought` sell signal is generated |
| `SCALPING_ATH_DROP_PCT` | number | 10–80 | no | `35` | ATH dip percentage required to trigger mid-battle scalping entry |
| `SCALPING_TP_PCT` | number | 1–100 | no | `15` | Take-profit percentage for scalping strategy positions |
| `MIN_POOL_RESERVE_USD` | number | ≥1000 | no | `50000` | Minimum pool reserve in USD for PoolAnalyzer to approve trading |
| `MIN_VOL_TO_RESERVE_PCT` | number | 0.1–100 | no | `5` | Minimum 24h volume-to-reserve ratio percentage for pool approval |
| `MIN_TX_COUNT_24H` | integer | ≥1 | no | `100` | Minimum 24h transaction count for pool approval |

---

## Additional Operational Variables

These variables control the runtime behavior of the agent but are not strictly required for basic operation.

| Variable | Type | Range / Format | Required | Default | Description |
|---|---|---|---|---|---|
| `DATA_REFRESH_SEC` | integer | 10–3600 | no | `60` | Interval in seconds between CoinMarketCap data polling cycles |
| `SL_MONITOR_MS` | integer | 1000–60000 | no | `10000` | Interval in milliseconds between stop-loss/take-profit price checks |
| `DRAWDOWN_CHECK_SEC` | integer | 10–3600 | no | `60` | Interval in seconds between portfolio drawdown calculations |
| `SHUTDOWN_POLL_MS` | integer | 1000–30000 | no | `5000` | Interval in milliseconds for checking the SHUTDOWN signal file |
| `METRICS_CALC_SEC` | integer | 60–3600 | no | `300` | Interval in seconds between analytics metric recalculations |
| `LATENCY_WARNING_MS` | integer | 1000–30000 | no | `5000` | Signal-to-transaction latency threshold in ms before a warning is logged |
| `TX_TIMEOUT_SEC` | integer | 30–600 | no | `120` | Maximum seconds to wait for a transaction to confirm before timing out |
| `LATENCY_TARGET_MS` | integer | 100–10000 | no | `3000` | Target signal-to-transaction latency in milliseconds |
| `STATE_PERSIST_SEC` | integer | 1–60 | no | `5` | Interval in seconds between state persistence writes |
| `STATE_FILE_PATH` | string | file path | no | `./data/state.json` | Path where agent state JSON is saved |
| `ANALYTICS_FILE_PATH` | string | file path | no | `./data/analytics.json` | Path where performance analytics JSON is saved |
| `SHUTDOWN_SIGNAL_FILE` | string | file path | no | `./SHUTDOWN` | File path that triggers graceful shutdown when it exists |
| `LOG_LEVEL` | enum | `debug`\|`info`\|`warn`\|`error`\|`critical` | no | `info` | Winston logger verbosity level |
| `TRADING_HOURS_START` | string | `HH:MM` | no | `00:00` | UTC hour when trading is allowed to begin |
| `TRADING_HOURS_END` | string | `HH:MM` | no | `23:59` | UTC hour when trading must stop |
| `BACKTEST_MODE` | boolean | `true`\|`false` | no | `false` | Run in backtest mode using historical data instead of live feeds |
| `BACKTEST_FROM` | string | ISO date | no | `""` | Start date for backtest (e.g. `2024-01-01`) |
| `BACKTEST_TO` | string | ISO date | no | `""` | End date for backtest (e.g. `2024-12-31`) |
| `BACKTEST_CAPITAL` | number | ≥0 | no | `10000` | Starting capital in USD for backtest simulation |
| `DEMO_MODE` | boolean | `true`\|`false` | no | `false` | Run in demo mode — paper trading with no real transactions |
| `DEMO_DURATION` | integer | ≥0 | no | `3600` | Duration of demo mode run in seconds (0 = run indefinitely) |
| `DEMO_CAPITAL` | number | ≥0 | no | `1000` | Simulated starting capital in USD for demo mode |
| `ADAPTIVE_ENABLED` | boolean | `true`\|`false` | no | `false` | Enable adaptive strategy weight adjustment based on performance |

---

## Nested Sub-Schema Breakdown

### Risk Configuration (`risk.*`)

| Field | Env Var | Default | Notes |
|---|---|---|---|
| `maxPositionPct` | `MAX_POSITION_PCT` | `5` | % of portfolio per position |
| `maxExposurePct` | `MAX_EXPOSURE_PCT` | `30` | % total open exposure |
| `stopLossPct` | `STOP_LOSS_PCT` | `5` | % below entry |
| `takeProfitPct` | `TAKE_PROFIT_PCT` | `15` | % above entry |
| `maxDrawdownPct` | `MAX_DRAWDOWN_PCT` | `20` | Triggers circuit breaker |
| `minPortfolioUsd` | `MIN_PORTFOLIO_USD` | `100` | Minimum to trade |
| `leverageMultiplier` | `LEVERAGE_MULTIPLIER` | `1` | BSC Perps only |

### TWAP / MEV Defense (`twap.*`)

| Field | Env Var | Default | Notes |
|---|---|---|---|
| `thresholdUsd` | `TWAP_THRESHOLD_USD` | `1000` | Activate TWAP above this |
| `chunkCount` | `TWAP_CHUNK_COUNT` | `10` | Number of time slices |
| `minChunkPct` | — | `0.7` | Min chunk size = 70% of mean |
| `maxChunkPct` | — | `1.3` | Max chunk size = 130% of mean |
| `minIntervalMs` | `TWAP_MIN_INTERVAL_MS` | `15000` | Min random delay between chunks |
| `maxIntervalMs` | `TWAP_MAX_INTERVAL_MS` | `45000` | Max random delay between chunks |

### Gas Configuration (`gas.*`)

| Field | Env Var | Default | Notes |
|---|---|---|---|
| `urgencyMultiplier` | `GAS_URGENCY_MULTIPLIER` | `1.2` | Applied to baseFee+priorityFee |
| `minGasGwei` | `MIN_GAS_GWEI` | `3` | Floor |
| `maxGasGwei` | `MAX_GAS_GWEI` | `100` | Ceiling |
| `gasBumpPct` | — | `20` | % increase on stuck tx retry |
| `maxRetries` | — | `3` | Max gas bump retries |

### Signal Configuration (`signal.*`)

| Field | Env Var | Default | Notes |
|---|---|---|---|
| `rsiOversold` | `RSI_OVERSOLD` | `30` | Trigger for rsi_oversold buy |
| `rsiOverbought` | `RSI_OVERBOUGHT` | `70` | Trigger for rsi_overbought sell |
| `whaleBuyThresholdUsd` | — | `100000` | Whale net flow threshold |
| `exchangeInflowUsd` | — | `50000` | Exchange inflow sell threshold |
| `weights.rsi` | — | `0.25` | RSI signal weight in composite |
| `weights.macd` | — | `0.25` | MACD signal weight |
| `weights.bollinger` | — | `0.20` | Bollinger signal weight |
| `weights.whale` | — | `0.15` | Whale signal weight |
| `weights.onchain` | — | `0.15` | On-chain signal weight |

### Pool Health Configuration (`pool.*`)

| Field | Env Var | Default | Notes |
|---|---|---|---|
| `minReserveUsd` | `MIN_POOL_RESERVE_USD` | `50000` | Dead-coin filter floor |
| `minVolToReservePct` | `MIN_VOL_TO_RESERVE_PCT` | `5` | Min liquidity utilization |
| `minTxCount24h` | `MIN_TX_COUNT_24H` | `100` | Min activity threshold |
| `maxReserveDrainPct` | — | `50` | Max reserve depletion |

### Network Configuration (`network.*`)

| Field | Env Var | Default | Notes |
|---|---|---|---|
| `mode` | `NETWORK_MODE` | `testnet` | `testnet` or `mainnet` |
| `rpcEndpoints` | `RPC_ENDPOINTS` | — | Comma-separated, ordered |
| `chainId` | `CHAIN_ID` | — | 97 or 56 |
| `rpcTimeoutMs` | `RPC_TIMEOUT_MS` | `10000` | Per-call timeout |
| `rpcBackoffBase` | `RPC_BACKOFF_BASE` | `2` | Failover backoff base (s) |
| `rpcBackoffMax` | `RPC_BACKOFF_MAX` | `60` | Failover backoff max (s) |

### Adaptive Configuration (`adaptive.*`)

| Field | Env Var | Default | Notes |
|---|---|---|---|
| `enabled` | `ADAPTIVE_ENABLED` | `false` | Enable weight adjustment |
| `evaluationPeriodSec` | — | `86400` | How often to recalculate (1 day) |
| `weightAdjPct` | — | `10` | Weight change step (% of current) |
| `benchmarkReturn` | — | `0` | Benchmark for outperformance check |

---

## Validation Rules

The entire configuration is validated with [Zod](https://zod.dev/) at startup. The agent will refuse to start and log detailed errors for any validation failure.

**Common validation errors:**
- `CMC_API_KEY` length < 32 → increase API key length
- `CHAIN_ID` not a positive integer → set to `97` or `56`
- `TRADING_PAIRS` contains lowercase → use `BNB/USDT` not `bnb/usdt`
- `RPC_ENDPOINTS` not valid URLs → include `https://` prefix
- `MAX_POSITION_PCT` > 20 → reduce to stay within allowed range
