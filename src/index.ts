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
  TradingSignal, Order, Position, Transaction, TradeRecord,
} from './types/index';
import { uuid } from './utils/uuid';

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {

  // ── [1] Load and validate configuration ───────────────────────────────────
  const configSvc = new ConfigurationService();
  const cfgResult = configSvc.load();
  if (!cfgResult.ok) {
    logger.error('Configuration failed — fix .env before starting', { error: cfgResult.error.message });
    process.exit(1);
  }
  const cfg = configSvc.get();

  // ── [2] Event bus ─────────────────────────────────────────────────────────
  const bus = new EventBus();

  // ── [3] State ─────────────────────────────────────────────────────────────
  const stateMgr    = new StateManager(configSvc, bus);
  const stateResult = await stateMgr.loadState();
  const state       = stateResult.ok ? stateResult.value : stateMgr.emptyState();

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
  const analytics   = new AnalyticsEngine(stateMgr, configSvc, bus);
  const regimeDet   = new RegimeDetector(marketData, configSvc, bus);
  const poolAnalyzer= new PoolAnalyzer(tradingEngine, configSvc, bus);
  const riskMgr     = new RiskManager(tradingEngine, configSvc, bus);
  const mevModule   = new MEVDefenseModule(configSvc, bus);
  const signalGen   = new SignalGenerator(marketData, configSvc, bus);

  analytics.start();
  regimeDet.start();
  await riskMgr.start();

  // ── [7] Recover open positions from persisted state ───────────────────────
  for (const position of state.openPositions) {
    riskMgr.onPositionOpened(position);
    logger.info('Recovered open position', { id: position.id, pair: position.pair });
  }

  // ── [8] Strategy manager ──────────────────────────────────────────────────
  const stratMgr = new StrategyManager(signalGen, regimeDet, configSvc, bus);

  const midBattle = new MidBattleScalpingStrategy(configSvc, bus);
  const momentum  = new MomentumStrategy(configSvc, bus);
  const meanRev   = new MeanReversionStrategy(configSvc, bus);
  const range     = new RangeStrategy(configSvc, bus);

  stratMgr.registerStrategy(midBattle);
  stratMgr.registerStrategy(momentum);
  stratMgr.registerStrategy(meanRev);
  stratMgr.registerStrategy(range);
  stratMgr.start();

  // ── [8b] Wire market:data → SignalGenerator → strategies ─────────────────
  // This is the missing link: market data arrives → signals generated → strategies act
  bus.on('market:data', ({ pair, data }) => {
    // Keep all strategies' ATH / market state current
    for (const strategy of stratMgr.getActiveStrategies()) {
      strategy.onMarketData(data);
    }

    // Update regime classification for this pair's data
    const regime = regimeDet.detectRegime(pair, data);

    // Generate signals from the latest market data
    const signals = signalGen.generateSignals(pair, data);

    // Only produce a composite signal if there is at least one component signal
    if (signals.length > 0) {
      // computeCompositeSignal internally emits 'signal:generated' on the bus
      // which StrategyManager listens to and routes to strategies
      const composite = signalGen.computeCompositeSignal(signals);
      // Attach the detected regime to the composite so strategies see it
      composite.regime = regime;
    }
  });

  // ── [8c] Wire strategy:signal → Pool check → Risk check → MEV → Execute ──
  // This is the order execution pipeline
  bus.on('strategy:signal', ({ signal }) => {
    void executeSignalPipeline(signal);
  });

  // ── [8d] Wire SL/TP triggers → close positions ────────────────────────────
  bus.on('risk:sl_triggered', ({ positionId, price }) => {
    void handlePositionClose(positionId, price, 'stop_loss');
  });
  bus.on('risk:tp_triggered', ({ positionId, price }) => {
    void handlePositionClose(positionId, price, 'take_profit');
  });

  // Open position registry for the lifecycle handler
  const openPositionMap = new Map<string, { position: Position; signal: TradingSignal; openedAt: number }>();

  async function executeSignalPipeline(signal: TradingSignal): Promise<void> {
    try {
      const signalTimestamp = Date.now();

      // Step 1: Pool health check
      const poolHealth = await poolAnalyzer.analyzePool(signal.pair);
      if (!poolHealth.healthy) {
        logger.warn('Signal rejected: pool health check failed', {
          pair:   signal.pair,
          reason: poolHealth.rejectionReason,
        });
        return;
      }

      // Step 2: Get portfolio value and build order
      const portfolioUsd = await executionSvc.getPortfolioUsd();
      const posResult    = riskMgr.calculatePositionSize(portfolioUsd, signal.pair);
      if (!posResult.ok) {
        logger.warn('Signal rejected: position size calculation failed', { error: posResult.error.message });
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

      // Step 3: Risk validation
      const validatedResult = await riskMgr.validateNewPosition(order, []);
      if (!validatedResult.ok) {
        logger.warn('Signal rejected: risk validation failed', { error: validatedResult.error.message });
        return;
      }
      const validOrder = validatedResult.value;

      // Step 4: MEV Defense — split large orders via Anaconda Squeeze TWAP
      let txResults: Transaction[];
      if (mevModule.shouldSplit(validOrder)) {
        logger.info('Order above TWAP threshold — executing Anaconda Squeeze', {
          orderId: validOrder.id,
          size:    validOrder.size,
          chunks:  cfg.twap.chunkCount,
        });
        const twapPlan = mevModule.buildTwapPlan(validOrder);
        txResults = await mevModule.executeTwap(
          validOrder,
          twapPlan,
          (chunk) => executionSvc.executeChunk(chunk, 0)
            .then(r => {
              if (!r.ok) throw r.error;
              return r.value;
            }),
        );
      } else {
        // Step 5: Direct execution
        const execResult = await executionSvc.executeOrder(validOrder);
        if (!execResult.ok) {
          logger.error('Order execution failed', { error: execResult.error.message, orderId: validOrder.id });
          return;
        }
        txResults = [execResult.value];
      }

      // Step 6: Record the open position
      const firstTx    = txResults[0];
      const entryPrice = await tradingEngine.getCurrentPrice(signal.pair);

      const position: Position = {
        id:         validOrder.id,
        pair:       signal.pair,
        side:       signal.side,
        entryPrice,
        size:       validOrder.size,
        stopLoss:   signal.side === 'buy'
          ? entryPrice * (1 - cfg.risk.stopLossPct / 100)
          : entryPrice * (1 + cfg.risk.stopLossPct / 100),
        takeProfit: signal.side === 'buy'
          ? entryPrice * (1 + cfg.risk.takeProfitPct / 100)
          : entryPrice * (1 - cfg.risk.takeProfitPct / 100),
        leverage:   1,
        strategy:   signal.strategy,
        venue:      validOrder.venue,
        openedAt:   Date.now(),
        txHash:     firstTx?.hash ?? '0x',
      };

      riskMgr.onPositionOpened(position);
      openPositionMap.set(position.id, { position, signal, openedAt: signalTimestamp });

      // Persist updated state
      await stateMgr.saveState({
        ...state,
        openPositions: [...state.openPositions, position],
      });

      // Track signal-to-tx latency
      const latencyMs = (firstTx?.submittedAt ?? Date.now()) - signalTimestamp;
      logger.info('Position opened', {
        id:        position.id,
        pair:      signal.pair,
        side:      signal.side,
        entry:     entryPrice,
        sl:        position.stopLoss.toFixed(4),
        tp:        position.takeProfit.toFixed(4),
        latencyMs,
      });

      if (latencyMs > cfg.latencyWarningMs) {
        bus.emit('health:latency', { latencyMs, threshold: cfg.latencyWarningMs });
      }

    } catch (e) {
      logger.error('Signal pipeline error', { pair: signal.pair, error: String(e) });
    }
  }

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

    // Execute the closing order
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
    const closeTx    = execResult.ok ? [execResult.value] : [];

    // Calculate PnL
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
      transactions: closeTx,
      signalToTxMs: closeTx[0] ? closeTx[0].submittedAt - openedAt : 0,
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

    // Update persisted state
    await stateMgr.saveState({
      ...state,
      openPositions: state.openPositions.filter(p => p.id !== positionId),
    });
  }

  // ── [9] Log network mode ──────────────────────────────────────────────────
  logger.info('══════════════════════════════════════════════════════════');
  logger.info(`  BLOCKOUT — NETWORK: ${cfg.network.mode.toUpperCase()}`);
  logger.info(`  Wallet: ${executionSvc.getWalletAddress()}`);
  logger.info('══════════════════════════════════════════════════════════');

  // ── [10] System READY ─────────────────────────────────────────────────────
  logger.info('System READY — Blockout is live', {
    pairs:      cfg.tradingPairs,
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

    // Stop accepting new signals first
    stratMgr.stop();

    // Stop all timers
    riskMgr.stop();
    analytics.stop();
    regimeDet.stop();
    marketData.stop();
    health.stop();
    tradingEngine.stop();

    // Generate final report
    const finalReport = analytics.generateReport('shutdown');
    logger.info(finalReport);

    // Persist final state
    await stateMgr.saveState({
      ...state,
      openPositions:       [],
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
