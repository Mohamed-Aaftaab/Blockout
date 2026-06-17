import axios, { type AxiosInstance } from 'axios';
import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type {
  MarketData, OHLCVCandle, TechnicalIndicators, OnChainMetrics,
} from '../types/index';
import type { TradingEngine } from '../execution/TradingEngine';
import { withRetry } from '../utils/backoff';

const logger = makeLogger();

const CMC_BASE = 'https://pro-api.coinmarketcap.com';

// CMC symbol → CMC ID map for major pairs
const SYMBOL_TO_CMC_ID: Record<string, number> = {
  BNB:  1839,
  BTC:  1,
  ETH:  1027,
  CAKE: 7186,
  USDT: 825,
  USDC: 3408,
};

function getSymbolFromPair(pair: string): { base: string; quote: string } {
  const parts = pair.split('/');
  return { base: parts[0] ?? 'BNB', quote: parts[1] ?? 'USDT' };
}

function cmcIdForSymbol(symbol: string): number {
  return SYMBOL_TO_CMC_ID[symbol] ?? 1839;
}

function buildDefaultIndicators(): TechnicalIndicators {
  return {
    rsi14: 50, macdLine: 0, macdSignal: 0, macdHistogram: 0,
    bbUpper: 0, bbMiddle: 0, bbLower: 0, ma20: 0, ma50: 0, bbWidth: 5,
  };
}

function buildDefaultOnChain(): OnChainMetrics {
  return {
    whaleNetFlow24h: 0,
    exchangeInflow24h: 0,
    exchangeOutflow24h: 0,
    largeTransactions: 0,
  };
}

// Safe numeric coercion from an unknown record value
function toNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  return 0;
}

// Safe string coercion
function toString(val: unknown): string {
  if (typeof val === 'string') return val;
  return '';
}

export class MarketDataService {
  private readonly config:     ConfigurationService;
  private readonly bus:        EventBus;
  private readonly http:       AxiosInstance;
  private readonly cache:      Map<string, MarketData>    = new Map();
  private readonly ohlcvCache: Map<string, OHLCVCandle[]> = new Map();
  private readonly athMap:     Map<string, number>        = new Map();
  private readonly intervals:  NodeJS.Timeout[]           = [];
  private readonly failCounts: Map<string, number>        = new Map();
  // Optional reference to TradingEngine so we can push CMC BNB price for portfolio valuation
  private tradingEngine: TradingEngine | null             = null;

  constructor(config: ConfigurationService, bus: EventBus) {
    this.config = config;
    this.bus    = bus;
    this.http   = axios.create({ baseURL: CMC_BASE, timeout: 15_000 });
  }

  /** Wire the TradingEngine so MarketDataService can push accurate BNB price */
  setTradingEngine(engine: TradingEngine): void {
    this.tradingEngine = engine;
  }

  async start(): Promise<void> {
    const cfg = this.config.get();
    // Verify API access
    const firstPair = cfg.tradingPairs[0] ?? 'BNB/USDT';
    try {
      await this.fetchQuote(firstPair);
    } catch (e) {
      logger.warn('CMC API verification failed — will retry on first poll', { error: String(e) });
    }

    // If BNB/USDT is not in the configured pairs, set up a background poller
    // to keep bnbPriceUsd accurate for portfolio valuation and USD→BNB conversions.
    const hasBnbUsdtPair = cfg.tradingPairs.some(p => p === 'BNB/USDT');
    if (!hasBnbUsdtPair && this.tradingEngine !== null) {
      // Fetch BNB price immediately and then every dataRefreshSec
      void this.fetchQuote('BNB/USDT').then(q => {
        if (q.price > 0 && this.tradingEngine !== null) this.tradingEngine.setBnbPrice(q.price);
      }).catch(() => undefined);

      const bnbHandle = setInterval(() => {
        void this.fetchQuote('BNB/USDT').then(q => {
          if (q.price > 0 && this.tradingEngine !== null) this.tradingEngine.setBnbPrice(q.price);
        }).catch(() => undefined);
      }, cfg.dataRefreshSec * 1000);
      this.intervals.push(bnbHandle);
      logger.info('BNB/USDT price poller started (not in trading pairs)');
    }

    // Set up per-pair polling
    for (const pair of cfg.tradingPairs) {
      // Initial fetch
      await this.fetchPairData(pair).catch((err: unknown) =>
        logger.warn('Initial pair fetch failed', { pair, error: String(err) }),
      );
      const handle = setInterval(() => {
        void this.fetchPairData(pair);
      }, cfg.dataRefreshSec * 1000);
      this.intervals.push(handle);
    }
  }

  stop(): void {
    for (const h of this.intervals) clearInterval(h);
    this.intervals.length = 0;
  }

  getLatestData(pair: string): MarketData | null {
    return this.cache.get(pair) ?? null;
  }

  getHistory(pair: string, limit: number): OHLCVCandle[] {
    const candles = this.ohlcvCache.get(pair) ?? [];
    return candles.slice(-limit);
  }

  private async fetchPairData(pair: string): Promise<void> {
    try {
      const [quote, candles, indicators] = await Promise.all([
        this.fetchQuote(pair),
        this.fetchOHLCV(pair),
        this.fetchIndicators(pair),
      ]);

      // Update ATH
      const currentATH = this.athMap.get(pair) ?? 0;
      if (quote.price > currentATH) this.athMap.set(pair, quote.price);

      // Push BNB price to TradingEngine for accurate portfolio valuation
      // (avoids relying on pool reserves which give price=1 on testnet fallback)
      if (pair === 'BNB/USDT' && quote.price > 0 && this.tradingEngine !== null) {
        this.tradingEngine.setBnbPrice(quote.price);
      }

      const data: MarketData = {
        pair,
        price:     quote.price,
        volume24h: quote.volume24h,
        marketCap: quote.marketCap,
        ath:       this.athMap.get(pair) ?? quote.price,
        candles,
        indicators,
        onChain:   buildDefaultOnChain(),
        fetchedAt: Date.now(),
      };

      this.cache.set(pair, data);
      this.ohlcvCache.set(pair, candles);
      this.failCounts.set(pair, 0);
      this.bus.emit('market:data', { pair, data });
    } catch (e) {
      const prev  = this.failCounts.get(pair) ?? 0;
      const count = prev + 1;
      this.failCounts.set(pair, count);

      const isRateLimit = axios.isAxiosError(e) && e.response?.status === 429;
      const backoffMs   = Math.min(5000 * Math.pow(2, count - 1), 300_000);

      this.bus.emit('market:error', { pair, error: String(e), backoffMs });
      logger.warn('Market data fetch failed', { pair, count, backoffMs, rateLimit: isRateLimit });

      // After 5 consecutive failures emit circuit open
      if (count >= 5) {
        this.bus.emit('market:circuit_open', { pair, reason: `${count} consecutive failures` });
      }
    }
  }

  private async fetchQuote(
    pair: string,
  ): Promise<{ price: number; volume24h: number; marketCap: number }> {
    const cfg        = this.config.get();
    const { base }   = getSymbolFromPair(pair);
    const id         = cmcIdForSymbol(base);

    const resp = await withRetry(
      () => this.http.get<unknown>('/v2/cryptocurrency/quotes/latest', {
        headers: { 'X-CMC_PRO_API_KEY': cfg.cmcApiKey },
        params:  { id, convert: 'USD' },
      }),
      {
        maxAttempts: 5,
        baseMs:      5000,
        maxMs:       300_000,
        shouldRetry: (err) =>
          !axios.isAxiosError(err) || (err.response?.status ?? 0) >= 500,
      },
    );

    // Parse CMC v2 response shape
    const body   = resp.data as Record<string, unknown>;
    const status = body['status'] as Record<string, unknown> | undefined;
    if (status !== undefined && toNumber(status['error_code']) !== 0) {
      throw new Error(`CMC API error: ${toString(status['error_message'])}`);
    }

    const dataMap  = body['data'] as Record<string, unknown> | undefined;
    const coinArr  = dataMap !== undefined
      ? (dataMap[String(id)] as unknown[] | undefined)
      : undefined;
    const coinData = coinArr !== undefined && coinArr.length > 0
      ? (coinArr[0] as Record<string, unknown>)
      : undefined;
    const quoteMap = coinData !== undefined
      ? (coinData['quote'] as Record<string, unknown> | undefined)
      : undefined;
    const usd      = quoteMap !== undefined
      ? (quoteMap['USD'] as Record<string, unknown> | undefined)
      : undefined;

    return {
      price:     toNumber(usd?.['price']),
      volume24h: toNumber(usd?.['volume_24h']),
      marketCap: toNumber(usd?.['market_cap']),
    };
  }

  private async fetchOHLCV(pair: string): Promise<OHLCVCandle[]> {
    const cfg      = this.config.get();
    const { base } = getSymbolFromPair(pair);
    const id       = cmcIdForSymbol(base);

    try {
      const resp = await withRetry(
        () => this.http.get<unknown>('/v2/cryptocurrency/ohlcv/historical', {
          headers: { 'X-CMC_PRO_API_KEY': cfg.cmcApiKey },
          params:  { id, convert: 'USD', count: 100, interval: '1h' },
        }),
        {
          maxAttempts: 3,
          baseMs:      5000,
          maxMs:       60_000,
          shouldRetry: (err) =>
            !axios.isAxiosError(err) || (err.response?.status ?? 0) >= 500,
        },
      );

      const body    = resp.data as Record<string, unknown>;
      const dataMap = body['data'] as Record<string, unknown> | undefined;
      const quotes  = dataMap !== undefined
        ? ((dataMap['quotes'] as unknown[] | undefined) ?? [])
        : [];

      return quotes.map((q) => {
        const entry  = q as Record<string, unknown>;
        const qMap   = entry['quote'] as Record<string, unknown> | undefined;
        const usd    = qMap !== undefined
          ? (qMap['USD'] as Record<string, unknown> | undefined)
          : undefined;

        return {
          timestamp: new Date(toString(entry['time_open'])).getTime(),
          open:      toNumber(usd?.['open']),
          high:      toNumber(usd?.['high']),
          low:       toNumber(usd?.['low']),
          close:     toNumber(usd?.['close']),
          volume:    toNumber(usd?.['volume']),
        };
      });
    } catch {
      return [];
    }
  }

  private async fetchIndicators(pair: string): Promise<TechnicalIndicators> {
    const cfg      = this.config.get();
    const { base } = getSymbolFromPair(pair);
    const id       = cmcIdForSymbol(base);

    try {
      const resp = await withRetry(
        () => this.http.get<unknown>('/v3/cryptocurrency/technical-indicator/latest', {
          headers: { 'X-CMC_PRO_API_KEY': cfg.cmcApiKey },
          params:  { id, convert: 'USD' },
        }),
        {
          maxAttempts: 3,
          baseMs:      5000,
          maxMs:       60_000,
          shouldRetry: (err) =>
            !axios.isAxiosError(err) || (err.response?.status ?? 0) >= 500,
        },
      );

      const body    = resp.data as Record<string, unknown>;
      const dataArr = body['data'] as unknown[] | undefined;
      const td      = dataArr !== undefined && dataArr.length > 0
        ? (dataArr[0] as Record<string, unknown>)
        : undefined;

      const rsi  = td !== undefined
        ? (td['rsi']  as Record<string, unknown> | undefined)
        : undefined;
      const macd = td !== undefined
        ? (td['macd'] as Record<string, unknown> | undefined)
        : undefined;
      const bb   = td !== undefined
        ? (td['bb']   as Record<string, unknown> | undefined)
        : undefined;
      const ma   = td !== undefined
        ? (td['ma']   as Record<string, unknown> | undefined)
        : undefined;

      const bbUpper  = toNumber(bb?.['upper_band']);
      const bbMiddle = toNumber(bb?.['middle_band']);
      const bbLower  = toNumber(bb?.['lower_band']);
      const bbWidth  = bbMiddle > 0
        ? ((bbUpper - bbLower) / bbMiddle) * 100
        : 5;

      return {
        rsi14:         toNumber(rsi?.['rsi_14']) || 50,
        macdLine:      toNumber(macd?.['macd']),
        macdSignal:    toNumber(macd?.['signal']),
        macdHistogram: toNumber(macd?.['histogram']),
        bbUpper,
        bbMiddle,
        bbLower,
        bbWidth,
        ma20: toNumber(ma?.['ma_20']),
        ma50: toNumber(ma?.['ma_50']),
      };
    } catch {
      logger.warn(
        'CMC technical indicators unavailable — using neutral defaults. ' +
        'Note: /v3/cryptocurrency/technical-indicator/latest requires CMC Agent Hub tier. ' +
        'Signals will rely on price momentum and OHLCV candles.',
        { pair, id },
      );
      return buildDefaultIndicators();
    }
  }
}
