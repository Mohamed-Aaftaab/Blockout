/**
 * Blockout Regime-Aware Trading Skill
 * Track 2 — CMC Agent Hub Skill
 *
 * A CMC Skills Marketplace–compatible callable that takes a token symbol
 * and returns a structured, LLM-ready trading decision with entry/exit rules,
 * regime classification, and backtestable signal logic.
 *
 * Compatible with CMC MCP, x402, and direct API invocation.
 * Consumes: /v2/quotes/latest, /v2/ohlcv/historical,
 *           /v3/technical-indicator/latest, /v4/agent/market-insights
 *
 * Usage (MCP):
 *   skill: "blockout_regime_trading"
 *   input: { symbol: "CAKE", timeframe: "1h", capital_usd: 1000 }
 *
 * Usage (CLI):
 *   npx ts-node skill.ts CAKE 1h 1000
 */

import axios from 'axios';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SkillInput {
  symbol:       string;   // e.g. "CAKE", "BNB", "ETH"
  timeframe:    string;   // "1h", "4h", "1d"
  capital_usd:  number;   // portfolio capital to size positions against
  cmcApiKey:    string;   // CMC Pro API key
}

interface SkillOutput {
  skill:          string;
  status:         'signal' | 'no_signal' | 'blocked';
  symbol:         string;
  regime:         'bull' | 'bear' | 'sideways';
  action:         'buy' | 'sell' | 'hold';
  confidence:     number;   // 0.0 – 1.0
  entry_price:    number | null;
  stop_loss:      number | null;
  take_profit:    number | null;
  position_size_usd: number | null;
  signals_fired:  string[];
  fear_greed:     number | null;
  social_sentiment: number | null;
  reasoning:      string;
  backtestable_rules: BacktestableRules;
  data_freshness: string;
  coverage_gaps:  string[];
}

interface BacktestableRules {
  entry_conditions:  string[];
  exit_conditions:   string[];
  risk_per_trade_pct: number;
  max_drawdown_pct:   number;
  regime_filter:      string;
}

// ─── CMC Data Fetcher ─────────────────────────────────────────────────────────

const CMC_BASE = 'https://pro-api.coinmarketcap.com';

const SYMBOL_TO_ID: Record<string, number> = {
  BNB: 1839, BTC: 1, ETH: 1027, CAKE: 7186,
  USDT: 825, USDC: 3408, DOT: 6636, LINK: 1975,
};

async function fetchAll(input: SkillInput) {
  const id      = SYMBOL_TO_ID[input.symbol] ?? 1839;
  const headers = { 'X-CMC_PRO_API_KEY': input.cmcApiKey };
  const http    = axios.create({ baseURL: CMC_BASE, timeout: 15_000 });

  const [quoteResp, ohlcvResp, indicatorResp, agentHubResp] = await Promise.allSettled([
    http.get('/v2/cryptocurrency/quotes/latest', { headers, params: { id, convert: 'USD' } }),
    http.get('/v2/cryptocurrency/ohlcv/historical', { headers, params: { id, convert: 'USD', count: 100, interval: input.timeframe } }),
    http.get('/v3/cryptocurrency/technical-indicator/latest', { headers, params: { id, convert: 'USD' } }),
    http.get('/v4/agent/market-insights', { headers, params: { id, limit: 1 } }),
  ]);

  return { id, quoteResp, ohlcvResp, indicatorResp, agentHubResp };
}

// ─── Signal Computation ───────────────────────────────────────────────────────

function safeNum(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function detectRegime(rsi: number, bbWidth: number, ma20: number, ma50: number, price: number): 'bull' | 'bear' | 'sideways' {
  if (bbWidth < 6 || ma50 === 0) return 'sideways';
  const slope = ma50 > 0 ? (ma20 - ma50) / ma50 : 0;
  if (slope > 0.001 && price > ma50) return 'bull';
  if (slope < -0.001 && price < ma50) return 'bear';
  return 'sideways';
}

// ─── Main Skill Function ──────────────────────────────────────────────────────

export async function blockoutRegimeTradingSkill(input: SkillInput): Promise<SkillOutput> {
  const coverageGaps: string[] = [];
  const { quoteResp, ohlcvResp, indicatorResp, agentHubResp } = await fetchAll(input);

  // ── Parse quote ──
  let price = 0;
  if (quoteResp.status === 'fulfilled') {
    const body    = quoteResp.value.data as Record<string, unknown>;
    const dataMap = body['data'] as Record<string, unknown> | undefined;
    // CMC v2 returns data keyed by ID string, not array
    const coinKey = dataMap ? Object.keys(dataMap)[0] : undefined;
    const coinVal = coinKey ? dataMap?.[coinKey] : undefined;
    // Value may be an array or an object directly
    const coin    = Array.isArray(coinVal) ? coinVal[0] as Record<string, unknown> : coinVal as Record<string, unknown> | undefined;
    const usd     = (coin?.['quote'] as Record<string, unknown> | undefined)?.['USD'] as Record<string, unknown> | undefined;
    price         = safeNum(usd?.['price']);
  } else {
    coverageGaps.push('price data unavailable');
  }

  // ── Parse indicators ──
  let rsi14 = 50, macdLine = 0, macdSignal = 0, macdHistogram = 0;
  let bbUpper = 0, bbMiddle = 0, bbLower = 0, ma20 = 0, ma50 = 0, bbWidth = 5;
  if (indicatorResp.status === 'fulfilled') {
    const body    = indicatorResp.value.data as Record<string, unknown>;
    const dataArr = body['data'] as Record<string, unknown>[] | undefined;
    const td      = dataArr?.[0] ?? {};
    const rsi     = td['rsi']  as Record<string, unknown> | undefined;
    const macd    = td['macd'] as Record<string, unknown> | undefined;
    const bb      = td['bb']   as Record<string, unknown> | undefined;
    const ma      = td['ma']   as Record<string, unknown> | undefined;
    rsi14         = safeNum(rsi?.['rsi_14']) || 50;
    macdLine      = safeNum(macd?.['macd']);
    macdSignal    = safeNum(macd?.['signal']);
    macdHistogram = safeNum(macd?.['histogram']);
    bbUpper       = safeNum(bb?.['upper_band']);
    bbMiddle      = safeNum(bb?.['middle_band']);
    bbLower       = safeNum(bb?.['lower_band']);
    bbWidth       = bbMiddle > 0 ? ((bbUpper - bbLower) / bbMiddle) * 100 : 5;
    ma20          = safeNum(ma?.['ma_20']);
    ma50          = safeNum(ma?.['ma_50']);
  } else {
    coverageGaps.push('technical indicators unavailable (/v3 requires Agent Hub tier) — using price momentum fallback');
  }

  // ── Parse OHLCV for price momentum ──
  let priceMomentum = 0;
  let sessionATH    = price;
  if (ohlcvResp.status === 'fulfilled') {
    const body    = ohlcvResp.value.data as Record<string, unknown>;
    const dataMap = body['data'] as Record<string, unknown> | undefined;
    const quotes  = (dataMap?.['quotes'] as unknown[]) ?? [];
    const candles = quotes.map((q: unknown) => {
      const e   = q as Record<string, unknown>;
      const usd = (e['quote'] as Record<string, unknown>)?.['USD'] as Record<string, unknown> | undefined;
      return { close: safeNum(usd?.['close']), high: safeNum(usd?.['high']) };
    }).filter(c => c.close > 0);
    if (candles.length >= 2) {
      const prev  = candles[candles.length - 2]!;
      const latest = candles[candles.length - 1]!;
      priceMomentum = prev.close > 0 ? ((latest.close - prev.close) / prev.close) * 100 : 0;
      sessionATH    = Math.max(...candles.map(c => c.high), price);
    }
  } else {
    coverageGaps.push('OHLCV data unavailable');
  }

  // ── Parse Agent Hub (Fear & Greed, social) ──
  let fearGreed: number | null = null;
  let socialSentiment: number | null = null;
  if (agentHubResp.status === 'fulfilled') {
    const body    = agentHubResp.value.data as Record<string, unknown>;
    const dataArr = body['data'] as Record<string, unknown>[] | undefined;
    const item    = dataArr?.[0] ?? {};
    fearGreed     = safeNum((item['market'] as Record<string, unknown> | undefined)?.['fear_greed_index']) || null;
    socialSentiment = safeNum((item['social'] as Record<string, unknown> | undefined)?.['sentiment_score']) || null;
  } else {
    coverageGaps.push('CMC Agent Hub /v4 unavailable — fear/greed and social sentiment missing');
  }

  // ── Regime detection ──
  const regime = detectRegime(rsi14, bbWidth, ma20, ma50, price);

  // ── Signal evaluation ──
  const signalsFired: string[] = [];
  const votes: { side: 'buy' | 'sell'; weight: number; confidence: number }[] = [];

  // RSI
  if (rsi14 < 35) {
    const conf = Math.min((35 - rsi14) / 35, 1.0);
    signalsFired.push(`RSI oversold (${rsi14.toFixed(1)}) → buy`);
    votes.push({ side: 'buy', weight: 0.25, confidence: conf });
  } else if (rsi14 > 65) {
    const conf = Math.min((rsi14 - 65) / 35, 1.0);
    signalsFired.push(`RSI overbought (${rsi14.toFixed(1)}) → sell`);
    votes.push({ side: 'sell', weight: 0.25, confidence: conf });
  }

  // MACD
  if (macdLine > macdSignal && macdHistogram > 0) {
    const conf = Math.min(Math.abs(macdHistogram) / 10, 1.0);
    signalsFired.push(`MACD bullish cross (hist=${macdHistogram.toFixed(4)}) → buy`);
    votes.push({ side: 'buy', weight: 0.25, confidence: conf });
  } else if (macdLine < macdSignal && macdHistogram < 0) {
    const conf = Math.min(Math.abs(macdHistogram) / 10, 1.0);
    signalsFired.push(`MACD bearish cross → sell`);
    votes.push({ side: 'sell', weight: 0.25, confidence: conf });
  }

  // Bollinger Bands
  const band = bbUpper - bbLower;
  if (band > 0 && price <= bbLower) {
    const conf = Math.min((bbLower - price) / band + 0.5, 1.0);
    signalsFired.push(`Price at BB lower (${bbLower.toFixed(4)}) → buy`);
    votes.push({ side: 'buy', weight: 0.20, confidence: conf });
  } else if (band > 0 && price >= bbUpper) {
    const conf = Math.min((price - bbUpper) / band + 0.5, 1.0);
    signalsFired.push(`Price at BB upper (${bbUpper.toFixed(4)}) → sell`);
    votes.push({ side: 'sell', weight: 0.20, confidence: conf });
  }

  // Price momentum
  if (priceMomentum <= -2.0) {
    const conf = Math.min(Math.abs(priceMomentum) / 6.0, 1.0);
    signalsFired.push(`Price momentum drop (${priceMomentum.toFixed(2)}%) → buy`);
    votes.push({ side: 'buy', weight: 0.20, confidence: conf });
  } else if (priceMomentum >= 2.0) {
    const conf = Math.min(priceMomentum / 6.0, 1.0);
    signalsFired.push(`Price momentum rise (${priceMomentum.toFixed(2)}%) → sell`);
    votes.push({ side: 'sell', weight: 0.20, confidence: conf });
  }

  // Fear & Greed (Agent Hub)
  if (fearGreed !== null && fearGreed < 30) {
    const conf = Math.min((30 - fearGreed) / 30, 1.0);
    signalsFired.push(`Fear & Greed extreme fear (${fearGreed}) → buy (contrarian)`);
    votes.push({ side: 'buy', weight: 0.15, confidence: conf });
  } else if (fearGreed !== null && fearGreed > 70) {
    const conf = Math.min((fearGreed - 70) / 30, 1.0);
    signalsFired.push(`Fear & Greed extreme greed (${fearGreed}) → sell (contrarian)`);
    votes.push({ side: 'sell', weight: 0.15, confidence: conf });
  }

  // Session ATH dip (MidBattle scalping)
  if (sessionATH > 0 && price <= sessionATH * 0.97) {
    const dipPct = ((sessionATH - price) / sessionATH) * 100;
    signalsFired.push(`ATH dip (${dipPct.toFixed(1)}% from ${sessionATH.toFixed(4)}) → buy`);
    votes.push({ side: 'buy', weight: 0.15, confidence: Math.min(dipPct / 10, 1.0) });
  }

  // ── Composite signal ──
  let totalWeight = 0;
  let weightedConf = 0;
  let buyScore = 0;
  let sellScore = 0;
  for (const v of votes) {
    weightedConf += v.confidence * v.weight;
    totalWeight  += v.weight;
    if (v.side === 'buy')  buyScore  += v.weight;
    else                   sellScore += v.weight;
  }

  const confidence = totalWeight > 0 ? Math.min(weightedConf / totalWeight, 1.0) : 0;
  const rawAction: 'buy' | 'sell' = buyScore >= sellScore ? 'buy' : 'sell';
  const action: 'buy' | 'sell' | 'hold' = votes.length === 0 ? 'hold' : rawAction;

  // ── Position sizing ──
  const stopLossPct    = 5;
  const takeProfitPct  = 10;
  const positionSizePct = 20; // % of capital per trade
  const positionSizeUsd = price > 0 && action !== 'hold' ? input.capital_usd * positionSizePct / 100 : null;
  const entryPrice     = price > 0 ? price : null;
  const stopLoss       = entryPrice && action === 'buy'  ? entryPrice * (1 - stopLossPct / 100)   : entryPrice && action === 'sell' ? entryPrice * (1 + stopLossPct / 100) : null;
  const takeProfit     = entryPrice && action === 'buy'  ? entryPrice * (1 + takeProfitPct / 100) : entryPrice && action === 'sell' ? entryPrice * (1 - takeProfitPct / 100) : null;

  // ── Reasoning ──
  const reasoning = [
    `## Blockout Trading Skill — ${input.symbol} (${input.timeframe})`,
    '',
    `**Regime:** ${regime.toUpperCase()} | **Action:** ${action.toUpperCase()} | **Confidence:** ${(confidence * 100).toFixed(0)}%`,
    '',
    `**Price:** $${price.toFixed(4)} | **Session ATH:** $${sessionATH.toFixed(4)}`,
    fearGreed !== null ? `**Fear & Greed:** ${fearGreed} (${fearGreed < 30 ? 'Extreme Fear' : fearGreed > 70 ? 'Extreme Greed' : 'Neutral'})` : '**Fear & Greed:** not available',
    socialSentiment !== null ? `**Social Sentiment:** ${socialSentiment.toFixed(0)}/100` : '',
    '',
    `**Signals fired (${signalsFired.length}):**`,
    ...signalsFired.map(s => `  - ${s}`),
    signalsFired.length === 0 ? '  - No signals above threshold — HOLD' : '',
    '',
    action !== 'hold' && entryPrice ? [
      `**Trade plan:**`,
      `  - Entry: $${entryPrice.toFixed(4)}`,
      `  - Stop loss: $${stopLoss?.toFixed(4)} (−${stopLossPct}%)`,
      `  - Take profit: $${takeProfit?.toFixed(4)} (+${takeProfitPct}%)`,
      `  - Position: $${positionSizeUsd?.toFixed(2)} (${positionSizePct}% of $${input.capital_usd} capital)`,
      `  - Risk/reward: 1:${(takeProfitPct / stopLossPct).toFixed(1)}`,
    ].join('\n') : '',
    '',
    coverageGaps.length > 0 ? `**Coverage gaps:** ${coverageGaps.join('; ')}` : '',
  ].filter(Boolean).join('\n');

  return {
    skill:            'blockout_regime_trading',
    status:           votes.length === 0 ? 'no_signal' : 'signal',
    symbol:           input.symbol,
    regime,
    action,
    confidence:       Math.round(confidence * 100) / 100,
    entry_price:      entryPrice,
    stop_loss:        stopLoss ? Math.round(stopLoss * 10000) / 10000 : null,
    take_profit:      takeProfit ? Math.round(takeProfit * 10000) / 10000 : null,
    position_size_usd: positionSizeUsd ? Math.round(positionSizeUsd * 100) / 100 : null,
    signals_fired:    signalsFired,
    fear_greed:       fearGreed,
    social_sentiment: socialSentiment,
    reasoning,
    backtestable_rules: {
      entry_conditions: [
        'RSI-14 < 35 (oversold)',
        'MACD bullish cross (line > signal AND histogram > 0)',
        'Price at or below Bollinger Band lower',
        '1h price change <= -2%',
        'CMC Fear & Greed < 30 (extreme fear, contrarian buy)',
        'Price drops >= 3% from session ATH',
      ],
      exit_conditions: [
        'RSI-14 > 65 (overbought)',
        'MACD bearish cross',
        'Price at or above Bollinger Band upper',
        '1h price change >= 2%',
        'CMC Fear & Greed > 70 (extreme greed, contrarian sell)',
        'Stop loss hit (-5% from entry)',
        'Take profit hit (+10% from entry)',
      ],
      risk_per_trade_pct: positionSizePct,
      max_drawdown_pct:   30,
      regime_filter:      `Entry only when regime = ${regime} (detected from BB width + MA slope)`,
    },
    data_freshness: new Date().toISOString(),
    coverage_gaps:  coverageGaps,
  };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, symbol = 'CAKE', timeframe = '1h', capital = '1000'] = process.argv;
  const cmcApiKey = process.env['CMC_API_KEY'] ?? '';

  if (!cmcApiKey) {
    console.error('CMC_API_KEY env var required');
    process.exit(1);
  }

  blockoutRegimeTradingSkill({ symbol, timeframe, capital_usd: Number(capital), cmcApiKey })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(e => { console.error(String(e)); process.exit(1); });
}
