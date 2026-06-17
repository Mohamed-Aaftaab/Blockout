import { createLogger, transports, format } from 'winston';
import { ConfigurationService }  from './config/index';
import { EventBus }              from './events/EventBus';
import { TradingEngine }         from './execution/TradingEngine';
import { GasOptimizer }          from './execution/GasOptimizer';
import { ExecutionService }      from './execution/ExecutionService';
import { MEVDefenseModule }      from './execution/MEVDefenseModule';
import { MarketDataService }     from './market/MarketDataService';
import { SignalGenerator }       from './market/SignalGenerator';
import { RegimeDetector }        from './market/RegimeDetector';
import { PoolAnalyzer }          from './risk/PoolAnalyzer';
import { RiskManager }           from './risk/RiskManager';
import { StrategyManager }       from './strategies/StrategyManager';
import { MidBattleScalpingStrategy } from './strategies/MidBattleScalpingStrategy';
import { MomentumStrategy }      from './strategies/MomentumStrategy';
import { MeanReversionStrategy } from './strategies/MeanReversionStrategy';
import { RangeStrategy }         from './strategies/RangeStrategy';
import { StateManager }          from './state/StateManager';
import { AnalyticsEngine }       from './analytics/AnalyticsEngine';
import { HealthMonitor }         from './health/HealthMonitor';

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

async function bootstrap(): Promise<void> {
  // ── [1] Load configuration ────────────────────────────────────────────────
  const configSvc = new ConfigurationService();
  const cfgResult = configSvc.load();
  if (!cfgResult.ok) {
    logger.error('Configuration failed', { error: cfgResult.error.message });
    process.exit(1);
  }
  const cfg = configSvc.get();

  // ── [2] Event bus ─────────────────────────────────────────────────────────
  const bus = new EventBus();

  // ── [3] State ─────────────────────────────────────────────────────────────
  const stateMgr  = new StateManager(configSvc, bus);
  const stateResult = await stateMgr.loadState();
  const state       = stateResult.ok ? stateResult.value : stateMgr.emptyState();

  // ── [4] Parallel SDK init ─────────────────────────────────────────────────
  const tradingEngine = new TradingEngine(configSvc, bus);
  const marketData    = new MarketDataService(configSvc, bus);
  const gasOptimizer  = new GasOptimizer(tradingEngine, configSvc);
  const executionSvc  = new ExecutionService(tradingEngine, gasOptimizer, configSvc, bus);

  await Promise.all([
    tradingEngine.initialize(),
    marketData.start(),
    executionSvc.initialize(),
  ]);

  // ── [5] Health monitor ────────────────────────────────────────────────────
  const health = new HealthMonitor(configSvc, bus);
  health.start();

  // ── [6] Analytics, regime, risk ──────────────────────────────────────────
  const analytics   = new AnalyticsEngine(stateMgr, configSvc, bus);
  const regimeDet   = new RegimeDetector(marketData, configSvc, bus);
  const poolAnalyzer= new PoolAnalyzer(tradingEngine, configSvc, bus);
  const riskMgr     = new RiskManager(tradingEngine, configSvc, bus);
  const mevModule   = new MEVDefenseModule(configSvc, bus);
  const signalGen   = new SignalGenerator(marketData, configSvc, bus);

  analytics.start();
  regimeDet.start();
  await riskMgr.start();

  // ── [7] Recover open positions ────────────────────────────────────────────
  for (const position of state.openPositions) {
    riskMgr.onPositionOpened(position);
  }

  // ── [8] Strategy manager ──────────────────────────────────────────────────
  const stratMgr = new StrategyManager(signalGen, regimeDet, configSvc, bus);
  stratMgr.registerStrategy(new MidBattleScalpingStrategy(configSvc, bus));
  stratMgr.registerStrategy(new MomentumStrategy(configSvc, bus));
  stratMgr.registerStrategy(new MeanReversionStrategy(configSvc, bus));
  stratMgr.registerStrategy(new RangeStrategy(configSvc, bus));
  stratMgr.start();

  // ── [9] Log network mode ──────────────────────────────────────────────────
  logger.info('══════════════════════════════════════════════════════════');
  logger.info(`  BLOCKOUT — NETWORK: ${cfg.network.mode.toUpperCase()}`);
  logger.info('══════════════════════════════════════════════════════════');

  // ── [10] System READY ─────────────────────────────────────────────────────
  logger.info('System READY — Blockout is live', {
    pairs:      cfg.tradingPairs,
    strategies: stratMgr.getActiveStrategies().map(s => s.name),
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (reason: string): Promise<void> => {
    logger.info('Shutting down...', { reason });
    stratMgr.stop();
    riskMgr.stop();
    analytics.stop();
    regimeDet.stop();
    marketData.stop();
    health.stop();
    tradingEngine.stop();
    const finalMetrics = analytics.generateReport('shutdown');
    logger.info(finalMetrics);
    await stateMgr.saveState({
      ...state,
      openPositions:       [],
      pendingTransactions: [],
      emergencyShutdown:   reason === 'emergency',
    });
    process.exit(0);
  };

  bus.on('health:shutdown', ({ reason }) => { void shutdown(reason); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT');  });

  // Suppress unused warnings
  void poolAnalyzer;
  void mevModule;
}

bootstrap().catch((err: unknown) => {
  logger.error('Bootstrap failed', { error: String(err) });
  process.exit(1);
});
