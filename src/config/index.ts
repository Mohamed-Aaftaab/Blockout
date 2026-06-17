import { makeLogger } from '../utils/logger';
import { ConfigSchema } from './schema';
import type { Config } from '../types/index';
import { ok, err, type Result } from '../types/index';
import { ConfigValidationError } from '../types/errors';

const logger = makeLogger();

/**
 * Parse a boolean env var string ('true'/'1' → true, anything else → false).
 * Returns undefined when the var is not set, so schema defaults apply.
 */
function parseBoolEnv(val: string | undefined): boolean | undefined {
  if (val === undefined) return undefined;
  return val === 'true' || val === '1';
}

/**
 * Parse a numeric env var. Returns undefined when not set so schema defaults apply.
 */
function parseNumEnv(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  return Number(val);
}

export class ConfigurationService {
  private config: Config | null = null;

  load(): Result<Config, ConfigValidationError> {
    // Warn on missing NETWORK_MODE before building raw object
    if (!process.env['NETWORK_MODE']) {
      logger.warn('NETWORK_MODE not set, defaulting to testnet');
    }

    // Parse all env vars into a raw object matching ConfigInput.
    // Fields with schema defaults are passed as undefined when absent so Zod
    // can apply the defaults; required fields get an explicit fallback value
    // (empty string / 0 / []) so validation errors are descriptive.
    const raw = {
      cmcApiKey:          process.env['CMC_API_KEY'] ?? '',
      twakAccessId:       process.env['TWAK_ACCESS_ID'],
      twakHmacSecret:     process.env['TWAK_HMAC_SECRET'],
      tradingPairs:       (process.env['TRADING_PAIRS'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),

      network: {
        mode:           process.env['NETWORK_MODE'],
        rpcEndpoints:   (process.env['RPC_ENDPOINTS'] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        rpcTimeoutMs:   parseNumEnv(process.env['RPC_TIMEOUT_MS']),
        rpcBackoffBase: parseNumEnv(process.env['RPC_BACKOFF_BASE']),
        rpcBackoffMax:  parseNumEnv(process.env['RPC_BACKOFF_MAX']),
        chainId:        Number(process.env['CHAIN_ID']),
      },

      venue: {
        pancakeswapRouter: process.env['PANCAKESWAP_ROUTER'] ?? '',
        bscPerpsContract:  process.env['BSC_PERPS_CONTRACT'] ?? '',
      },

      risk: {
        maxPositionPct:     parseNumEnv(process.env['MAX_POSITION_PCT']),
        maxExposurePct:     parseNumEnv(process.env['MAX_EXPOSURE_PCT']),
        stopLossPct:        parseNumEnv(process.env['STOP_LOSS_PCT']),
        takeProfitPct:      parseNumEnv(process.env['TAKE_PROFIT_PCT']),
        maxDrawdownPct:     parseNumEnv(process.env['MAX_DRAWDOWN_PCT']),
        minPortfolioUsd:    parseNumEnv(process.env['MIN_PORTFOLIO_USD']),
        leverageMultiplier: parseNumEnv(process.env['LEVERAGE_MULTIPLIER']),
      },

      twap: {
        thresholdUsd:  parseNumEnv(process.env['TWAP_THRESHOLD_USD']),
        chunkCount:    parseNumEnv(process.env['TWAP_CHUNK_COUNT']),
        minChunkPct:   undefined,
        maxChunkPct:   undefined,
        minIntervalMs: parseNumEnv(process.env['TWAP_MIN_INTERVAL_MS']),
        maxIntervalMs: parseNumEnv(process.env['TWAP_MAX_INTERVAL_MS']),
      },

      gas: {
        urgencyMultiplier: parseNumEnv(process.env['GAS_URGENCY_MULTIPLIER']),
        minGasGwei:        parseNumEnv(process.env['MIN_GAS_GWEI']),
        maxGasGwei:        parseNumEnv(process.env['MAX_GAS_GWEI']),
        gasBumpPct:        undefined,
        maxRetries:        undefined,
      },

      slippage: {
        defaultPct: parseNumEnv(process.env['DEFAULT_SLIPPAGE_PCT']),
        maxPct:     parseNumEnv(process.env['MAX_SLIPPAGE_PCT']),
        bumpPct:    undefined,
        maxRetries: undefined,
      },

      regime: {
        shortMaPeriod:      undefined,
        longMaPeriod:       undefined,
        slopeUpThreshold:   undefined,
        slopeDownThreshold: undefined,
        bbWidthThreshold:   undefined,
        updateIntervalSec:  undefined,
      },

      signal: {
        rsiOversold:          parseNumEnv(process.env['RSI_OVERSOLD']),
        rsiOverbought:        parseNumEnv(process.env['RSI_OVERBOUGHT']),
        whaleBuyThresholdUsd: undefined,
        exchangeInflowUsd:    undefined,
        weights:              undefined,
      },

      scalping: {
        athDropPct:      parseNumEnv(process.env['SCALPING_ATH_DROP_PCT']),
        positionSizeUsd: undefined,
        takeProfitPct:   parseNumEnv(process.env['SCALPING_TP_PCT']),
        stopLossPct:     undefined,
      },

      pool: {
        minReserveUsd:      parseNumEnv(process.env['MIN_POOL_RESERVE_USD']),
        minVolToReservePct: parseNumEnv(process.env['MIN_VOL_TO_RESERVE_PCT']),
        minTxCount24h:      parseNumEnv(process.env['MIN_TX_COUNT_24H']),
        maxReserveDrainPct: undefined,
      },

      adaptive: {
        enabled:             parseBoolEnv(process.env['ADAPTIVE_ENABLED']),
        evaluationPeriodSec: undefined,
        weightAdjPct:        undefined,
        benchmarkReturn:     undefined,
      },

      dataRefreshSec:     parseNumEnv(process.env['DATA_REFRESH_SEC']),
      slMonitorMs:        parseNumEnv(process.env['SL_MONITOR_MS']),
      drawdownCheckSec:   parseNumEnv(process.env['DRAWDOWN_CHECK_SEC']),
      shutdownPollMs:     parseNumEnv(process.env['SHUTDOWN_POLL_MS']),
      metricsCalcSec:     parseNumEnv(process.env['METRICS_CALC_SEC']),
      latencyWarningMs:   parseNumEnv(process.env['LATENCY_WARNING_MS']),
      txTimeoutSec:       parseNumEnv(process.env['TX_TIMEOUT_SEC']),
      latencyTargetMs:    parseNumEnv(process.env['LATENCY_TARGET_MS']),
      statePersistSec:    parseNumEnv(process.env['STATE_PERSIST_SEC']),
      stateFilePath:      process.env['STATE_FILE_PATH'],
      analyticsFilePath:  process.env['ANALYTICS_FILE_PATH'],
      shutdownSignalFile: process.env['SHUTDOWN_SIGNAL_FILE'],
      logLevel:           process.env['LOG_LEVEL'],
      tradingHoursStart:  process.env['TRADING_HOURS_START'],
      tradingHoursEnd:    process.env['TRADING_HOURS_END'],
      backtestMode:       parseBoolEnv(process.env['BACKTEST_MODE']),
      backtestFrom:       process.env['BACKTEST_FROM'],
      backtestTo:         process.env['BACKTEST_TO'],
      backtestCapital:    parseNumEnv(process.env['BACKTEST_CAPITAL']),
      demoMode:           parseBoolEnv(process.env['DEMO_MODE']),
      demoDuration:       parseNumEnv(process.env['DEMO_DURATION']),
      demoCapital:        parseNumEnv(process.env['DEMO_CAPITAL']),
    };

    const result = ConfigSchema.safeParse(raw);

    if (!result.success) {
      for (const issue of result.error.issues) {
        logger.error('Config validation error', {
          field:   issue.path.join('.'),
          message: issue.message,
          code:    issue.code,
        });
      }
      const firstIssue = result.error.issues[0];
      const field   = firstIssue?.path.join('.') ?? 'unknown';
      const message = firstIssue?.message ?? 'Configuration validation failed';
      return err(new ConfigValidationError(message, field));
    }

    this.config = result.data;
    return ok(this.config);
  }

  get(): Config {
    if (this.config === null) {
      throw new ConfigValidationError(
        'Configuration not loaded. Call load() first.',
        'config',
      );
    }
    return this.config;
  }
}
