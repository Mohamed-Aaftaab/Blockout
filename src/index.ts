import { makeLogger } from './utils/logger';
import { ConfigurationService }      from './config/index';
import { EventBus }                  from './events/EventBus';
import { TradingEngine }             from './execution/TradingEngine';
import { GasOptimizer }              from './execution/GasOptimizer';
import { ExecutionService }          from './execution/ExecutionService';
import { MEVDefenseModule }          from './execution/MEVDefenseModule';
import { MarketDataService }         from './market/MarketDataService';
import { SignalGenerator }           from './market/SignalGenerator';
import { RegimeDetector }            from './market/RegimeDetector';
import { PoolAnalyzer }              from './risk/PoolAnalyzer';
import { RiskManager }               from './risk/RiskManager';
import { StrategyManager }           from './strategies/StrategyManager';
import { MidBattleScalpingStrategy } from './strategies/MidBattleScalpingStrategy';
import { MomentumStrategy }          from './strategies/MomentumStrategy';
import { MeanReversionStrategy }     from './strategies/MeanReversionStrategy';
import { RangeStrategy }             from './strategies/RangeStrategy';
import { StateManager }              from './state/StateManager';
import { AnalyticsEngine }           from './analytics/AnalyticsEngine';
import { HealthMonitor }             from './health/HealthMonitor';
import type {
  TradingSignal, Order, Position, Transaction, TradeRecord, SystemState,
} from './types/index';
import { uuid } from './utils/uuid';

const logger = makeLogger();

/**
 * Lightweight async mutex — ensures sequential state saves.
 * Prevents race conditions when open and close operations overlap.
 */
class StateMutex {
  private queue: Promise<void> = Promise.resolve();

  /** Run `fn` exclusively — waits for any pending save to complete first */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    // Absorb rejections on the chain so later operations still run
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

async function bootstrap(): Promise<void> {

  // ── [1] Configuration ─────────────────────────────────────────────────────
  const configSvc = new ConfigurationService();
  const cfgResult = configSvc.load();
  if (!cfgResult.ok) {
    logger.error('Configuration failed — fix .env', { error: cfgResult.error.message });
    process.exit(1);
  }
  const cfg = configSvc.get();

  // ── [2] Event bus ─────────────────────────────────────────────────────────
  const bus = new EventBus();

  // ── [3] State ─────────────────────────────────────────────────────────────
  const stateMgr    = new StateManager(configSvc, bus);
  const stateResult = await stateMgr.loadState();
  // Use a mutable reference so state updates are reflected everywhere
  let currentState: SystemState = stateResult.ok ? stateResult.value : stateMgr.emptyState();

  // Mutex serialises all currentState mutations to prevent concurrent write corruption
  const stateMutex = new StateMutex();

  // ── [4] SDK init — sequential for engine first, then parallel for I/O ─────
  const tradingEngine = new TradingEngine(configSvc, bus);
  const gasOptimizer  = new GasOptimizer(tradingEngine, configSvc);
  const executionSvc  = new ExecutionService(tradingEngine, gasOptimizer, configSvc, bus);
  const marketData    = new MarketDataService(configSvc, bus);

  // Wire BEFORE start() so the very first CMC poll pushes BNB price
  marketData.setTradingEngine(tradingEngine);

  // TradingEngine MUST initialise before ExecutionService — ExecutionService.initialize()
  // calls engine.setSigner() which calls requireProvider(). If both run concurrently via
  // Promise.all, executionSvc may call setSigner before the provider is connected.
  await tradingEngine.initialize();
  await Promise.all([
    executionSvc.initialize(),
    marketData.start(),
  ]);

  // ── [5] Health monitor ────────────────────────────────────────────────────
  const health = new HealthMonitor(configSvc, bus);
  health.start();

  // ── [6] Supporting services ───────────────────────────────────────────────
  const analytics    = new AnalyticsEngine(stateMgr, configSvc, bus);
  const regimeDet    = new RegimeDetector(marketData, configSvc, bus);
  const poolAnalyzer = new PoolAnalyzer(tradingEngine, configSvc, bus);
  const riskMgr      = new RiskManager(tradingEngine, configSvc, bus);
  const mevModule    = new MEVDefenseModule(configSvc, bus);
  const signalGen    = new SignalGenerator(marketData, configSvc, bus);

  analytics.start();
  regimeDet.start();
  await riskMgr.start();

  // Restore persisted drawdown baseline ONLY when start() found an empty wallet (baseline=0).
  // If the wallet is funded, start() already set the correct live baseline — don't overwrite it
  // with a potentially stale persisted value that would trigger a false drawdown alarm.
  if (riskMgr.getDrawdownBaseline() === 0 && currentState.drawdownBaseline > 0) {
    riskMgr.restoreDrawdownBaseline(currentState.drawdownBaseline);
    logger.info('Drawdown baseline restored from persisted state (wallet was empty at start)', {
      baseline: currentState.drawdownBaseline,
    });
  }

  // Restore circuit breaker state — if the agent crashed with an active circuit breaker,
  // it should remain active on restart to prevent resuming trading after a drawdown event.
  if (currentState.circuitBreakerActive) {
    riskMgr.restoreCircuitBreakerState(true);
  }

  // ── Live position registry — declared early so step 7 recovery can populate it ──
  // closeRetries tracks failed close attempts per position to cap retries at 5.
  const openPositionMap = new Map<string, { position: Position; signal: TradingSignal; openedAt: number; closeRetries: number }>();

  // ── Concurrency guard: one pipeline execution per pair at a time ──────────
  const pipelineInProgress = new Set<string>();

  // ── [7] Recover open positions from persisted state ───────────────────────
  for (const position of currentState.openPositions) {
    riskMgr.onPositionOpened(position);
    logger.info('Recovered open position', { id: position.id, pair: position.pair });

    // CRITICAL: also populate openPositionMap so SL/TP monitoring can close these
    // positions after restart. Use a synthetic signal with the position's metadata.
    const recoveredSignal: TradingSignal = {
      id:         uuid(),
      pair:       position.pair,
      type:       'composite',
      side:       position.side,
      confidence: 0.5,
      indicators: { rsi14: 50, macdLine: 0, macdSignal: 0, macdHistogram: 0, bbUpper: 0, bbMiddle: 0, bbLower: 0, ma20: 0, ma50: 0, bbWidth: 5 },
      onChain:    { whaleNetFlow24h: 0, exchangeInflow24h: 0, exchangeOutflow24h: 0, largeTransactions: 0 },
      regime:     'sideways',
      strategy:   position.strategy,
      timestamp:  position.openedAt,
    };
    openPositionMap.set(position.id, {
      position,
      signal:    recoveredSignal,
      openedAt:  position.openedAt,
      closeRetries: 0,
    });
  }

  // ── [8] Strategies ────────────────────────────────────────────────────────
  const stratMgr  = new StrategyManager(signalGen, regimeDet, configSvc, bus);
  const midBattle = new MidBattleScalpingStrategy(configSvc, bus);
  const momentum  = new MomentumStrategy(configSvc, bus);
  const meanRev   = new MeanReversionStrategy(configSvc, bus);
  const range     = new RangeStrategy(configSvc, bus);

  stratMgr.registerStrategy(midBattle);
  stratMgr.registerStrategy(momentum);
  stratMgr.registerStrategy(meanRev);
  stratMgr.registerStrategy(range);
  stratMgr.start();

  // ── [8b] market:data → SignalGenerator pipeline ───────────────────────────
  bus.on('market:data', ({ pair, data }) => {
    // Keep strategy market state current (ATH tracking, price cache)
    for (const strategy of stratMgr.getActiveStrategies()) {
      strategy.onMarketData(data);
    }

    // Detect regime BEFORE computing composite signal, so regime is available synchronously
    const regime = regimeDet.detectRegime(pair, data);

    // Generate component signals
    const signals = signalGen.generateSignals(pair, data);
    if (signals.length === 0) return;

    // Attach the current regime to every signal before emitting composite
    for (const s of signals) {
      s.regime = regime;
    }

    // computeCompositeSignal emits 'signal:generated' synchronously on the bus.
    // StrategyManager receives it in the same tick, so regime is already correct.
    const composite = signalGen.computeCompositeSignal(signals);
    composite.regime = regime; // ensure composite also carries correct regime
  });

  // ── [8c] strategy:signal → execution pipeline ────────────────────────────
  /**
   * Returns true if the current UTC time is within the configured trading window.
   * Both start and end are HH:MM strings. Handles midnight-spanning windows
   * (e.g. "22:00" to "02:00") correctly.
   */
  function isWithinTradingHours(): boolean {
    const { tradingHoursStart, tradingHoursEnd } = cfg;
    if (tradingHoursStart === '00:00' && tradingHoursEnd === '23:59') return true; // default = always
    const now  = new Date();
    const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    if (tradingHoursStart <= tradingHoursEnd) {
      return hhmm >= tradingHoursStart && hhmm <= tradingHoursEnd;
    }
    // Midnight-spanning window
    return hhmm >= tradingHoursStart || hhmm <= tradingHoursEnd;
  }

  bus.on('strategy:signal', ({ signal, strategy: strategyName, order: strategyOrder }) => {
    // Enforce trading hours window
    if (!isWithinTradingHours()) {
      logger.debug('Signal skipped: outside trading hours', { pair: signal.pair, tradingHoursStart: cfg.tradingHoursStart, tradingHoursEnd: cfg.tradingHoursEnd });
      return;
    }
    // Skip if already processing this pair — prevents duplicate positions
    if (pipelineInProgress.has(signal.pair)) {
      logger.debug('Pipeline already in progress for pair, skipping duplicate signal', { pair: signal.pair });
      return;
    }
    pipelineInProgress.add(signal.pair);
    // Pass the resolved order from the strategy so side/size/type are correct
    void executeSignalPipeline(signal, strategyOrder, strategyName).finally(() => {
      pipelineInProgress.delete(signal.pair);
    });
  });

  // ── [8d] SL/TP triggers → position close ─────────────────────────────────
  bus.on('risk:sl_triggered', ({ positionId, price }) => {
    void handlePositionClose(positionId, price, 'stop_loss');
  });
  bus.on('risk:tp_triggered', ({ positionId, price }) => {
    void handlePositionClose(positionId, price, 'take_profit');
  });

  // ── [8e] Manual circuit breaker reset via file signal ─────────────────────
  bus.on('health:circuit_breaker_reset', () => {
    logger.info('Circuit breaker reset via file signal');
    riskMgr.resetCircuitBreaker();
    // Persist the reset state immediately
    void stateMutex.run(async () => {
      await stateMgr.saveState({
        ...currentState,
        drawdownBaseline:     riskMgr.getDrawdownBaseline(),
        circuitBreakerActive: false,
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Full order execution pipeline
  // ─────────────────────────────────────────────────────────────────────────
  async function executeSignalPipeline(signal: TradingSignal, strategyOrder: Order, strategyName: string): Promise<void> {
    const signalTimestamp = Date.now();
    try {
      // 1. Pool health check
      const poolHealth = await poolAnalyzer.analyzePool(signal.pair);
      if (!poolHealth.healthy) {
        logger.warn('Signal rejected: unhealthy pool', { pair: signal.pair, reason: poolHealth.rejectionReason });
        return;
      }

      // 2. Get real portfolio value via wallet balance
      const portfolioUsd = await executionSvc.getPortfolioUsd();
      const posResult    = riskMgr.calculatePositionSize(portfolioUsd, signal.pair);
      if (!posResult.ok) {
        logger.warn('Signal rejected: position sizing failed', { error: posResult.error.message, portfolioUsd });
        return;
      }

      // Use the strategy's resolved order for side/type/venue — critical for correctness.
      // Override size with the risk-manager-calculated size so we don't exceed portfolio limits.
      const order: Order = {
        ...strategyOrder,
        id:        uuid(),
        size:      posResult.value,
        slippage:  cfg.slippage.defaultPct,
        createdAt: Date.now(),
        signalId:  signal.id,
      };

      // 3. Risk validation (checks circuit breaker + exposure limits)
      const validatedResult = await riskMgr.validateNewPosition(order, []);
      if (!validatedResult.ok) {
        logger.warn('Signal rejected: risk validation failed', { error: validatedResult.error.message });
        return;
      }
      const validOrder = validatedResult.value;

      // 4. MEV Defense — Anaconda Squeeze for large orders, direct for small
      let txResults: Transaction[];

      if (mevModule.shouldSplit(validOrder)) {
        logger.info('Anaconda Squeeze activated', {
          orderId: validOrder.id,
          size:    validOrder.size,
          chunks:  cfg.twap.chunkCount,
        });
        const twapPlan = mevModule.buildTwapPlan(validOrder);
        txResults = await mevModule.executeTwap(
          validOrder,
          twapPlan,
          (chunk) => executionSvc.executeChunk(chunk, 0).then(r => {
            if (!r.ok) throw r.error;
            return r.value;
          }),
        );
      } else {
        const execResult = await executionSvc.executeOrder(validOrder);
        if (!execResult.ok) {
          logger.error('Order execution failed', { error: execResult.error.message, orderId: validOrder.id });
          return;
        }
        txResults = [execResult.value];
      }

      // 5. Record the open position
      const firstTx    = txResults[0];
      const entryPrice = await tradingEngine.getCurrentPrice(signal.pair);

      // Guard: if entry price is 0 (pool unavailable), do NOT open a position
      // A zero entry price would create SL=0 which triggers TP immediately
      if (entryPrice <= 0) {
        logger.error('Entry price is zero — aborting position open to prevent immediate SL/TP trigger', {
          pair: signal.pair,
        });
        return;
      }

      // SL/TP directions are correct for both buy and sell:
      // Buy:  SL below entry, TP above entry
      // Sell: SL above entry, TP below entry
      const stopLoss   = order.side === 'buy'
        ? entryPrice * (1 - cfg.risk.stopLossPct  / 100)
        : entryPrice * (1 + cfg.risk.stopLossPct  / 100);
      const takeProfit = order.side === 'buy'
        ? entryPrice * (1 + cfg.risk.takeProfitPct / 100)
        : entryPrice * (1 - cfg.risk.takeProfitPct / 100);

      const position: Position = {
        id:         validOrder.id,
        pair:       signal.pair,
        side:       order.side,
        entryPrice,
        size:       validOrder.size,
        stopLoss,
        takeProfit,
        leverage:   1,
        // Use the actual strategy name emitted from StrategyManager, not signal.strategy
        // which is always 'composite' for the aggregated composite signal.
        strategy:   strategyName,
        venue:      validOrder.venue,
        openedAt:   Date.now(),
        txHash:     firstTx?.hash ?? '0x',
      };

      riskMgr.onPositionOpened(position);
      openPositionMap.set(position.id, { position, signal, openedAt: signalTimestamp, closeRetries: 0 });

      // Serialised state update — prevents race with concurrent handlePositionClose
      await stateMutex.run(async () => {
        currentState = {
          ...currentState,
          openPositions: [...currentState.openPositions, position],
        };
        await stateMgr.saveState(currentState);
      });

      const latencyMs = (firstTx?.submittedAt ?? Date.now()) - signalTimestamp;
      logger.info('Position opened', {
        id:        position.id,
        pair:      signal.pair,
        side:      order.side,
        entry:     entryPrice,
        sl:        stopLoss.toFixed(4),
        tp:        takeProfit.toFixed(4),
        latencyMs,
      });

      if (latencyMs > cfg.latencyWarningMs) {
        bus.emit('health:latency', { latencyMs, threshold: cfg.latencyWarningMs });
      }
      if (latencyMs > cfg.latencyTargetMs) {
        logger.warn('Execution latency exceeded target', { latencyMs, latencyTargetMs: cfg.latencyTargetMs });
      }

    } catch (e) {
      logger.error('Signal pipeline error', { pair: signal.pair, error: String(e) });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Position close handler (SL or TP triggered)
  // ─────────────────────────────────────────────────────────────────────────
  async function handlePositionClose(
    positionId: string,
    exitPrice:  number,
    reason:     'stop_loss' | 'take_profit',
  ): Promise<void> {
    const entry = openPositionMap.get(positionId);
    if (!entry) return;

    const { position, signal, openedAt, closeRetries } = entry;
    openPositionMap.delete(positionId);
    riskMgr.onPositionClosed(positionId);

    // ── Balance cap: prevent on-chain reverts from partial fills ──────────────
    // For buy positions (closing = sell base token): check ERC-20 balance.
    // For sell positions (closing = buy back using quote token): check quote balance.
    let closeSize = position.size;
    if (position.side === 'buy') {
      const actualBalance = await executionSvc.getBaseTokenBalance(position.pair);
      if (actualBalance !== null && actualBalance < position.size) {
        logger.warn('Close size capped to actual base token balance', {
          positionId, expected: position.size, actual: actualBalance,
        });
        closeSize = actualBalance;
      }
    } else {
      const [, quoteSymbol] = position.pair.split('/');
      if (quoteSymbol && quoteSymbol !== 'BNB' && quoteSymbol !== 'WBNB') {
        const quoteBalance = await executionSvc.getQuoteTokenBalance(position.pair);
        if (quoteBalance !== null && quoteBalance < position.size) {
          logger.warn('Close size capped to actual quote token balance (sell position)', {
            positionId, expected: position.size, actual: quoteBalance,
          });
          closeSize = quoteBalance;
        }
      }
    }

    // If token balance is effectively zero (already moved or lost), record a zero-pnl trade
    if (closeSize <= 0) {
      logger.warn('Close size is zero — skipping close order (tokens no longer in wallet)', { positionId });
      // Still record the real price movement % so metrics reflect the actual market outcome
      const zeroPnlUsd = 0; // no tokens to sell = $0 recovered
      const realPnlPct = position.side === 'buy'
        ? (exitPrice - position.entryPrice) / position.entryPrice * 100
        : (position.entryPrice - exitPrice) / position.entryPrice * 100;
      const tradeRecord: TradeRecord = {
        id: uuid(), position, closePrice: exitPrice, closedAt: Date.now(),
        exitReason: reason, pnlUsd: zeroPnlUsd, pnlPct: realPnlPct,
        holdMs: Date.now() - openedAt, transactions: [], signalToTxMs: 0,
      };
      analytics.recordTrade(tradeRecord);
      await stateMutex.run(async () => {
        currentState = { ...currentState, openPositions: currentState.openPositions.filter(p => p.id !== positionId) };
        await stateMgr.saveState(currentState);
      });
      return;
    }

    // Execute closing order (reverse of open)
    const closeOrder: Order = {
      id:        uuid(),
      pair:      position.pair,
      type:      'market',
      side:      position.side === 'buy' ? 'sell' : 'buy',
      size:      closeSize,
      venue:     position.venue,
      slippage:  cfg.slippage.defaultPct,
      twap:      null,
      createdAt: Date.now(),
      signalId:  signal.id,
    };

    const execResult = await executionSvc.executeOrder(closeOrder);

    // ── Issue K: cap retries at 5 to prevent infinite retry loop ──────────────
    if (!execResult.ok) {
      const newRetries = closeRetries + 1;
      const maxRetries = 5;
      if (newRetries >= maxRetries) {
        logger.error('Close order failed after max retries — emitting critical alert', {
          positionId, pair: position.pair, reason, retries: newRetries, error: execResult.error.message,
        });
        bus.emit('health:critical', {
          component: 'handlePositionClose',
          message:   `Position ${positionId} stuck after ${maxRetries} close attempts: ${execResult.error.message}`,
          timestamp: Date.now(),
        });
        // Fall through to cleanup so internal state doesn't show it as open forever
      } else {
        logger.error('Close order failed — restoring position for SL/TP retry', {
          positionId, pair: position.pair, reason, retries: newRetries, error: execResult.error.message,
        });
        openPositionMap.set(positionId, { position, signal, openedAt, closeRetries: newRetries });
        riskMgr.onPositionOpened(position);
        bus.emit('health:warning', {
          component: 'handlePositionClose',
          message:   `Close attempt ${newRetries}/${maxRetries} failed for ${positionId}: ${execResult.error.message}`,
        });
        return;
      }
    }

    const closeTxs = execResult.ok ? [execResult.value] : [];

    // PnL calculation — use closeSize (what was actually closed) not position.size
    // (which may have been capped by partial fill balance check above).
    const pnlUsd = position.side === 'buy'
      ? (exitPrice - position.entryPrice) / position.entryPrice * closeSize
      : (position.entryPrice - exitPrice) / position.entryPrice * closeSize;
    const pnlPct = position.side === 'buy'
      ? (exitPrice - position.entryPrice) / position.entryPrice * 100
      : (position.entryPrice - exitPrice) / position.entryPrice * 100;

    const tradeRecord: TradeRecord = {
      id:           uuid(),
      position,
      closePrice:   exitPrice,
      closedAt:     Date.now(),
      exitReason:   reason,
      pnlUsd,
      pnlPct,
      holdMs:       Date.now() - openedAt,
      transactions: closeTxs,
      signalToTxMs: closeTxs[0] ? closeTxs[0].submittedAt - openedAt : 0,
    };

    analytics.recordTrade(tradeRecord);

    logger.info('Position closed', {
      id:     positionId,
      pair:   position.pair,
      reason,
      entry:  position.entryPrice,
      exit:   exitPrice,
      pnlUsd: pnlUsd.toFixed(2),
      pnlPct: pnlPct.toFixed(2),
    });

    // Serialised state update — prevents race with concurrent executeSignalPipeline
    await stateMutex.run(async () => {
      currentState = {
        ...currentState,
        openPositions: currentState.openPositions.filter(p => p.id !== positionId),
      };
      await stateMgr.saveState(currentState);
    });
  }

  // ── [9] Banner ────────────────────────────────────────────────────────────
  logger.info('══════════════════════════════════════════════════════════');
  logger.info(`  BLOCKOUT — NETWORK: ${cfg.network.mode.toUpperCase()}`);
  logger.info(`  Wallet:  ${executionSvc.getWalletAddress()}`);
  logger.info(`  Pairs:   ${cfg.tradingPairs.join(', ')}`);
  logger.info('══════════════════════════════════════════════════════════');

  // ── [10] System READY ─────────────────────────────────────────────────────
  logger.info('System READY — Blockout is live', {
    strategies: stratMgr.getActiveStrategies().map(s => s.name),
    network:    cfg.network.mode,
    wallet:     executionSvc.getWalletAddress(),
  });

  // ── Periodic state persistence ────────────────────────────────────────────
  // Saves the current state every statePersistSec seconds regardless of trade activity.
  // This ensures the drawdown baseline and circuit breaker state are persisted
  // even during quiet periods when no positions open or close.
  const statePersistInterval = setInterval(() => {
    void stateMutex.run(async () => {
      // Sync both drawdown baseline and circuit breaker state from RiskManager
      await stateMgr.saveState({
        ...currentState,
        drawdownBaseline:     riskMgr.getDrawdownBaseline(),
        circuitBreakerActive: riskMgr.getCircuitBreakerActive(),
      });
    });
  }, cfg.statePersistSec * 1000);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  let shutdownInProgress = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logger.info('Shutting down Blockout...', { reason });

    clearInterval(statePersistInterval);
    stratMgr.stop();
    riskMgr.stop();
    analytics.stop();
    regimeDet.stop();
    marketData.stop();
    health.stop();
    tradingEngine.stop();

    logger.info(analytics.generateReport('shutdown'));

    // Final state save via mutex to avoid racing with any in-flight operations
    await stateMutex.run(async () => {
      await stateMgr.saveState({
        ...currentState,
        drawdownBaseline:     riskMgr.getDrawdownBaseline(),
        circuitBreakerActive: riskMgr.getCircuitBreakerActive(),
        openPositions:        currentState.openPositions,
        pendingTransactions:  [],
        emergencyShutdown:    reason === 'emergency' || reason === 'file-trigger',
      });
    });

    logger.info('Blockout shutdown complete');
    process.exit(0);
  };

  bus.on('health:shutdown', ({ reason }) => { void shutdown(reason); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT');  });
}

bootstrap().catch((err: unknown) => {
  logger.error('Bootstrap failed', { error: String(err) });
  process.exit(1);
});
