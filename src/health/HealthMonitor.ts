import * as fs from 'fs';
import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type { CircuitState } from '../types/index';

const logger = makeLogger();

export class HealthMonitor {
  private readonly config: ConfigurationService;
  private readonly bus: EventBus;
  private circuitState: CircuitState = 'CLOSED';
  private startTime: number = 0;
  private shutdownTriggered: boolean = false;
  private shutdownPollInterval: NodeJS.Timeout | null = null;
  private circuitBreakerListener: (() => void) | null = null;

  constructor(config: ConfigurationService, bus: EventBus) {
    this.config = config;
    this.bus = bus;
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
    if (this.circuitBreakerListener !== null) {
      this.bus.off('risk:circuit_breaker', this.circuitBreakerListener);
      this.circuitBreakerListener = null;
    }
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
      void this.triggerEmergencyShutdown('file-trigger');
    }
    // Check for circuit breaker reset signal
    if (fs.existsSync(cfg.resetCircuitBreakerFile)) {
      logger.info('Circuit breaker reset file detected — resetting circuit breaker', {
        file: cfg.resetCircuitBreakerFile,
      });
      // Remove the reset file first so we don't re-trigger next poll
      try { fs.unlinkSync(cfg.resetCircuitBreakerFile); } catch { /* ignore */ }
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

  async attemptRecovery(component: string): Promise<boolean> {
    logger.info('Attempting component recovery', { component });
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
