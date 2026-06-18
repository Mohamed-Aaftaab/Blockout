import * as fs from 'fs';
import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type { CircuitState } from '../types/index';
import type { TradingEngine } from '../execution/TradingEngine';

const logger = makeLogger();

export class HealthMonitor {
  private readonly config: ConfigurationService;
  private readonly bus: EventBus;
  private circuitState: CircuitState = 'CLOSED';
  private startTime: number = 0;
  private shutdownTriggered: boolean = false;
  private shutdownPollInterval: NodeJS.Timeout | null = null;
  private rpcPingInterval: NodeJS.Timeout | null = null;
  private circuitBreakerListener: (() => void) | null = null;
  private tradingEngine: TradingEngine | null = null;

  constructor(config: ConfigurationService, bus: EventBus) {
    this.config = config;
    this.bus = bus;
  }

  /** Wire TradingEngine so HealthMonitor can ping RPC liveness */
  setTradingEngine(engine: TradingEngine): void {
    this.tradingEngine = engine;
  }

  start(): void {
    // Guard against double-start (e.g. bootstrap retry)
    if (this.startTime > 0) {
      logger.warn('HealthMonitor.start() called while already running — ignoring');
      return;
    }
    this.startTime = Date.now();
    const cfg = this.config.get();

    // Log network mode prominently at startup
    logger.info('═══════════════════════════════════════');
    logger.info(`BLOCKOUT — NETWORK: ${cfg.network.mode.toUpperCase()}`);
    logger.info('═══════════════════════════════════════');

    // Start shutdown signal file polling
    this.shutdownPollInterval = setInterval(() => {
      this.pollShutdownSignal();
    }, cfg.shutdownPollMs);

    // Periodic RPC liveness ping — detects dead nodes between trades.
    // Runs every shutdownPollMs * 6 (default: every 30s). On failure, emits health:warning
    // so the operator is alerted before the next trade attempt fails.
    const rpcPingMs = cfg.shutdownPollMs * 6;
    this.rpcPingInterval = setInterval(() => {
      void this.pingRpc();
    }, rpcPingMs);

    // Wire circuit state to RiskManager's circuit breaker events
    this.circuitBreakerListener = () => {
      this.circuitState = 'OPEN';
      logger.warn('Circuit state: OPEN (circuit breaker triggered)');
    };
    this.bus.on('risk:circuit_breaker', this.circuitBreakerListener);

    logger.info('HealthMonitor started', { networkMode: cfg.network.mode });
  }

  stop(): void {
    if (this.shutdownPollInterval !== null) {
      clearInterval(this.shutdownPollInterval);
      this.shutdownPollInterval = null;
    }
    if (this.rpcPingInterval !== null) {
      clearInterval(this.rpcPingInterval);
      this.rpcPingInterval = null;
    }
    if (this.circuitBreakerListener !== null) {
      this.bus.off('risk:circuit_breaker', this.circuitBreakerListener);
      this.circuitBreakerListener = null;
    }
    // Reset startTime so start() can be called again if needed (e.g. service restart)
    this.startTime = 0;
    logger.info('HealthMonitor stopped');
  }

  getCircuitState(): CircuitState {
    return this.circuitState;
  }

  getUptime(): number {
    if (this.startTime === 0) return 0;
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  async triggerEmergencyShutdown(reason: string): Promise<void> {
    if (this.shutdownTriggered) return; // prevent double-trigger
    this.shutdownTriggered = true;

    logger.error('EMERGENCY SHUTDOWN TRIGGERED', { reason });

    this.bus.emit('health:shutdown', { reason, timestamp: Date.now() });
  }

  private pollShutdownSignal(): void {
    const cfg = this.config.get();
    if (fs.existsSync(cfg.shutdownSignalFile)) {
      logger.warn('Shutdown signal file detected', { file: cfg.shutdownSignalFile });
      // Unlink immediately so subsequent polls don't re-trigger while shutdown is in progress
      fs.promises.unlink(cfg.shutdownSignalFile).catch(() => undefined);
      void this.triggerEmergencyShutdown('file-trigger');
    }
    // Check for circuit breaker reset signal
    if (fs.existsSync(cfg.resetCircuitBreakerFile)) {
      logger.info('Circuit breaker reset file detected — resetting circuit breaker', {
        file: cfg.resetCircuitBreakerFile,
      });
      // Remove the reset file asynchronously so we don't re-trigger next poll
      fs.promises.unlink(cfg.resetCircuitBreakerFile).catch(() => undefined);
      this.bus.emit('health:circuit_breaker_reset', { timestamp: Date.now() });
    }
  }

  // Called externally during startup to enforce init timeout
  checkInitTimeout(component: string, timeoutMs: number): void {
    setTimeout(() => {
      logger.error('Component initialization timed out', { component, timeoutMs });
      void this.triggerEmergencyShutdown(`init-timeout:${component}`);
    }, timeoutMs);
  }

  /** Periodic RPC liveness ping. Emits health:warning if the node is unreachable. */
  private async pingRpc(): Promise<void> {
    if (this.tradingEngine === null) return;
    try {
      const provider = this.tradingEngine.getProvider();
      if (provider === null) return;
      // getBlockNumber is the lightest possible RPC call
      await provider.getBlockNumber();
    } catch (e) {
      logger.warn('RPC liveness ping failed — node may be unreachable', { error: String(e) });
      this.bus.emit('health:warning', {
        component: 'HealthMonitor',
        message:   `RPC ping failed: ${String(e)}`,
      });
    }
  }

  async attemptRecovery(component: string): Promise<boolean> {    logger.info('Attempting component recovery', { component });
    try {
      // Stub: in production this would restart the component process/service
      await Promise.resolve();
      this.bus.emit('health:recovery', { component, timestamp: Date.now() });
      logger.info('Component recovery succeeded', { component });
      return true;
    } catch (e) {
      this.bus.emit('health:critical', {
        component,
        message: `Recovery failed: ${String(e)}`,
        timestamp: Date.now(),
      });
      return false;
    }
  }
}
