import { ethers } from 'ethers';
import { createLogger, transports, format } from 'winston';
import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type { Order, Transaction, Result } from '../types/index';
import { ok, err }                   from '../types/index';
import { ExecutionError }            from '../types/errors';
import type { TradingEngine }        from './TradingEngine';
import type { GasOptimizer }         from './GasOptimizer';
import { sleep }                     from '../utils/sleep';

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

export class ExecutionService {
  private readonly engine:       TradingEngine;
  private readonly gasOptimizer: GasOptimizer;
  private readonly config:       ConfigurationService;
  private readonly bus:          EventBus;
  private walletAddress:         string = ethers.ZeroAddress;

  constructor(
    tradingEngine: TradingEngine,
    gasOptimizer:  GasOptimizer,
    config:        ConfigurationService,
    bus:           EventBus,
  ) {
    this.engine       = tradingEngine;
    this.gasOptimizer = gasOptimizer;
    this.config       = config;
    this.bus          = bus;
  }

  async initialize(): Promise<void> {
    // Since @trustwallet/agent-sdk is not yet published, we use ethers.js Wallet
    // for self-custody signing — functionally equivalent for the hackathon demo
    const cfg = this.config.get();
    try {
      // Generate or load a wallet for autonomous signing
      // In production this is replaced by TWAK's AgentKit with HMAC auth
      const randomWallet = ethers.Wallet.createRandom();
      this.walletAddress = randomWallet.address;
      logger.info('ExecutionService initialized (ethers wallet mode)', {
        address: this.walletAddress,
        network: cfg.network.mode,
      });
    } catch (e) {
      const msg = `ExecutionService initialization failed: ${String(e)}`;
      this.bus.emit('health:critical', { component: 'ExecutionService', message: msg, timestamp: Date.now() });
      throw new ExecutionError(msg, 'init', 'signing');
    }
  }

  async executeOrder(order: Order): Promise<Result<Transaction, ExecutionError>> {
    const cfg       = this.config.get();
    let gasPrice    = await this.gasOptimizer.getOptimalGasPrice();
    let slippage    = order.slippage;
    const maxRetries = cfg.gas.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const tx = await this.buildAndSubmit(order, gasPrice, slippage);
        const confirmed = await this.awaitConfirmation(tx.hash, cfg.txTimeoutSec * 1000);
        if (!confirmed.ok) return confirmed;
        return ok(confirmed.value);
      } catch (e) {
        const errMsg = String(e);
        if (attempt < maxRetries) {
          if (errMsg.includes('gas') || errMsg.includes('underpriced')) {
            gasPrice = Math.min(gasPrice * (1 + cfg.gas.gasBumpPct / 100), cfg.gas.maxGasGwei);
            logger.info('Retrying with higher gas', { attempt, gasPrice });
          } else if (errMsg.includes('slippage') || errMsg.includes('PRICE_IMPACT')) {
            slippage = Math.min(slippage + cfg.slippage.bumpPct, cfg.slippage.maxPct);
            logger.info('Retrying with higher slippage', { attempt, slippage });
          } else {
            break; // non-retryable error
          }
        } else {
          const execErr = new ExecutionError(errMsg, order.id, 'unknown');
          this.bus.emit('execution:failed', { orderId: order.id, error: errMsg, attempt });
          return err(execErr);
        }
      }
    }

    const execErr = new ExecutionError('Max retries exhausted', order.id, 'unknown');
    this.bus.emit('execution:failed', { orderId: order.id, error: execErr.message, attempt: maxRetries });
    return err(execErr);
  }

  async executeChunk(chunk: Order, gasPrice: number): Promise<Result<Transaction, ExecutionError>> {
    try {
      const tx = await this.buildAndSubmit(chunk, gasPrice, chunk.slippage);
      return ok(tx);
    } catch (e) {
      return err(new ExecutionError(String(e), chunk.id, 'unknown'));
    }
  }

  async awaitConfirmation(txHash: string, timeoutMs: number): Promise<Result<Transaction, ExecutionError>> {
    const cfg       = this.config.get();
    const start     = Date.now();
    const pollMs    = 2000;

    while (Date.now() - start < timeoutMs) {
      await sleep(pollMs);
      // In a real implementation we poll provider.getTransactionReceipt(txHash)
      // For the demo, simulate confirmation after one poll
      const tx: Transaction = {
        hash:           txHash,
        orderId:        '',
        status:         'confirmed',
        gasPrice:       0,
        gasLimit:       300_000,
        gasUsed:        150_000,
        actualSlippage: 0.1,
        submittedAt:    start,
        confirmedAt:    Date.now(),
        blockNumber:    null,
        error:          null,
      };
      this.bus.emit('execution:confirmed', { tx });
      return ok(tx);
    }

    return err(new ExecutionError(`Transaction ${txHash} timed out after ${timeoutMs}ms`, '', 'rpc'));
  }

  private async buildAndSubmit(order: Order, gasPrice: number, slippage: number): Promise<Transaction> {
    const tx = await this.engine.routeOrder({ ...order, slippage });
    if (!tx.ok) throw new Error(tx.error.message);

    // Simulate signing + submission
    const txHash = '0x' + Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');

    this.bus.emit('execution:submitted', { txHash, orderId: order.id, gasPrice });
    logger.info('Transaction submitted', { txHash, orderId: order.id, venue: order.venue, gasPrice });

    return { ...tx.value, hash: txHash, gasPrice, status: 'pending', submittedAt: Date.now() };
  }

  getWalletAddress(): string {
    return this.walletAddress;
  }
}
