import { createLogger, transports, format } from 'winston';
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

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

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

  // ── [4] Parallel SDK init ─────────────────────────────────────────────────
  const tradingEngine = new TradingEngine(configSvc, bus);
  const gasOptimizer  = new GasOptimizer(tradingEngine, configSvc);
  const executionSvc  = new ExecutionService(tradingEngine, gasOptimizer, configSvc, bus);
  const marketData    = new MarketDataService(configSvc, bus);

  await Promise.all([
    tradingEngine.initialize(),
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

  // ── [7] Recover open positions from persisted state ───────────────────────
  for (const position of currentState.openPositions) {
    riskMgr.onPositionOpened(position);
    logger.info('Recovered open position', { id: position.id, pair: position.pair });
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

  // ── Live position registry (truth source across closures) ─────────────────
  const openPositionMap = new Map<string, { position: Position; signal: TradingSignal; openedAt: number }>();

  // ── Concurrency guard: one pipeline execution per pair at a time ──────────
  const pipelineInProgress = new Set<string>();

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
  bus.on('strategy:signal', ({ signal }) => {
    // Skip if already processing this pair — prevents duplicate positions
    if (pipelineInProgress.has(signal.pair)) {
      logger.debug('Pipeline already in progress for pair, skipping duplicate signal', { pair: signal.pair });
      return;
    }
    pipelineInProgress.add(signal.pair);
    void executeSignalPipeline(signal).finally(() => {
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

  // ─────────────────────────────────────────────────────────────────────────
  // Full order execution pipeline
  // ─────────────────────────────────────────────────────────────────────────
  async function executeSignalPipeline(signal: TradingSignal): Promise<void> {
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

      const order: Order = {
        id:        uuid(),
        pair:      signal.pair,
        type:      'market',
        side:      signal.side,
        size:      posResult.value,
        venue:     'pancakeswap',
        slippage:  cfg.slippage.defaultPct,
        twap:      null,
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

      // SL/TP directions are correct for both buy and sell:
      // Buy:  SL below entry, TP above entry
      // Sell: SL above entry, TP below entry
      const stopLoss   = signal.side === 'buy'
        ? entryPrice * (1 - cfg.risk.stopLossPct  / 100)
        : entryPrice * (1 + cfg.risk.stopLossPct  / 100);
      const takeProfit = signal.side === 'buy'
        ? entryPrice * (1 + cfg.risk.takeProfitPct / 100)
        : entryPrice * (1 - cfg.risk.takeProfitPct / 100);

      const position: Position = {
        id:         validOrder.id,
        pair:       signal.pair,
        side:       signal.side,
        entryPrice,
        size:       validOrder.size,
        stopLoss,
        takeProfit,
        leverage:   1,
        strategy:   signal.strategy,
        venue:      validOrder.venue,
        openedAt:   Date.now(),
        txHash:     firstTx?.hash ?? '0x',
      };

      riskMgr.onPositionOpened(position);
      openPositionMap.set(position.id, { position, signal, openedAt: signalTimestamp });

      // Update the live state snapshot (not the stale startup snapshot)
      currentState = {
        ...currentState,
        openPositions: [...currentState.openPositions, position],
      };
      await stateMgr.saveState(currentState);

      const latencyMs = (firstTx?.submittedAt ?? Date.now()) - signalTimestamp;
      logger.info('Position opened', {
        id:        position.id,
        pair:      signal.pair,
        side:      signal.side,
        entry:     entryPrice,
        sl:        stopLoss.toFixed(4),
        tp:        takeProfit.toFixed(4),
        latencyMs,
      });

      if (latencyMs > cfg.latencyWarningMs) {
        bus.emit('health:latency', { latencyMs, threshold: cfg.latencyWarningMs });
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

    const { position, signal, openedAt } = entry;
    openPositionMap.delete(positionId);
    riskMgr.onPositionClosed(positionId);

    // Execute closing order (reverse of open)
    const closeOrder: Order = {
      id:        uuid(),
      pair:      position.pair,
      type:      'market',
      side:      position.side === 'buy' ? 'sell' : 'buy',
      size:      position.size,
      venue:     position.venue,
      slippage:  cfg.slippage.defaultPct,
      twap:      null,
      createdAt: Date.now(),
      signalId:  signal.id,
    };

    const execResult = await executionSvc.executeOrder(closeOrder);
    const closeTxs   = execResult.ok ? [execResult.value] : [];

    // PnL calculation — correct for both long (buy) and short (sell)
    const pnlUsd = position.side === 'buy'
      ? (exitPrice - position.entryPrice) / position.entryPrice * position.size
      : (position.entryPrice - exitPrice) / position.entryPrice * position.size;
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

    // Update live state (remove closed position)
    currentState = {
      ...currentState,
      openPositions: currentState.openPositions.filter(p => p.id !== positionId),
    };
    await stateMgr.saveState(currentState);
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

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  let shutdownInProgress = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logger.info('Shutting down Blockout...', { reason });

    stratMgr.stop();
    riskMgr.stop();
    analytics.stop();
    regimeDet.stop();
    marketData.stop();
    health.stop();
    tradingEngine.stop();

    logger.info(analytics.generateReport('shutdown'));

    // Persist the current live state (not the stale startup snapshot)
    await stateMgr.saveState({
      ...currentState,
      openPositions:       currentState.openPositions,
      pendingTransactions: [],
      emergencyShutdown:   reason === 'emergency' || reason === 'file-trigger',
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
