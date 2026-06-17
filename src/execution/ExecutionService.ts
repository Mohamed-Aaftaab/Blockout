import { ethers } from 'ethers';
import * as fs    from 'fs';
import * as path  from 'path';
import { createLogger, transports, format } from 'winston';
import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type { Order, Transaction, Result } from '../types/index';
import { ok, err }                   from '../types/index';
import { ExecutionError }            from '../types/errors';
import type { TradingEngine }        from './TradingEngine';
import type { GasOptimizer }         from './GasOptimizer';
import { sleep }                     from '../utils/sleep';

const WALLET_KEY_FILE = './data/wallet.key';

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
  private wallet:                ethers.Wallet | null = null;

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
    const cfg = this.config.get();
    try {
      // Load or create a persistent wallet key
      // In production this is replaced by TWAK AgentKit HMAC signing
      // For hackathon: use a persistent local key so wallet address is stable across restarts
      const wallet = await this.loadOrCreateWallet();
      this.wallet  = wallet;

      // Wire the signer into TradingEngine so it can estimate gas and sign txs
      this.engine.setSigner(wallet);

      logger.info('ExecutionService initialized', {
        address: wallet.address,
        network: cfg.network.mode,
        mode:    'self-custody (ethers wallet)',
      });
    } catch (e) {
      const msg = `ExecutionService initialization failed: ${String(e)}`;
      this.bus.emit('health:critical', { component: 'ExecutionService', message: msg, timestamp: Date.now() });
      throw new ExecutionError(msg, 'init', 'signing');
    }
  }

  async executeOrder(order: Order): Promise<Result<Transaction, ExecutionError>> {
    const cfg        = this.config.get();
    let gasPrice     = await this.gasOptimizer.getOptimalGasPrice();
    let slippage     = order.slippage;
    const maxRetries = cfg.gas.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const txResult = await this.engine.routeOrder({ ...order, slippage });
        if (!txResult.ok) throw new Error(txResult.error.message);

        const signedHash = await this.signAndBroadcast(txResult.value, order, gasPrice);
        this.bus.emit('execution:submitted', { txHash: signedHash, orderId: order.id, gasPrice });
        logger.info('Transaction submitted', { txHash: signedHash, orderId: order.id, venue: order.venue, gasPrice });

        const confirmed = await this.awaitConfirmation(signedHash, cfg.txTimeoutSec * 1000);
        if (!confirmed.ok) return confirmed;

        return ok({ ...confirmed.value, orderId: order.id, gasPrice });
      } catch (e) {
        const errMsg = String(e);
        if (attempt < maxRetries) {
          if (errMsg.includes('gas') || errMsg.includes('underpriced') || errMsg.includes('insufficient')) {
            gasPrice = Math.min(gasPrice * (1 + cfg.gas.gasBumpPct / 100), cfg.gas.maxGasGwei);
            logger.info('Retrying with higher gas', { attempt: attempt + 1, gasPrice });
            continue;
          }
          if (errMsg.includes('slippage') || errMsg.includes('PRICE_IMPACT') || errMsg.includes('K')) {
            slippage = Math.min(slippage + cfg.slippage.bumpPct, cfg.slippage.maxPct);
            logger.info('Retrying with higher slippage', { attempt: attempt + 1, slippage });
            continue;
          }
        }
        // Non-retryable or exhausted
        const execErr = new ExecutionError(errMsg, order.id, 'unknown');
        this.bus.emit('execution:failed', { orderId: order.id, error: errMsg, attempt });
        return err(execErr);
      }
    }

    const execErr = new ExecutionError('Max retries exhausted', order.id, 'unknown');
    this.bus.emit('execution:failed', { orderId: order.id, error: execErr.message, attempt: maxRetries });
    return err(execErr);
  }

  async executeChunk(chunk: Order, gasPrice: number): Promise<Result<Transaction, ExecutionError>> {
    try {
      const txResult = await this.engine.routeOrder(chunk);
      if (!txResult.ok) throw new Error(txResult.error.message);
      const signedHash = await this.signAndBroadcast(txResult.value, chunk, gasPrice);
      const confirmed  = await this.awaitConfirmation(signedHash, 120_000);
      if (!confirmed.ok) return confirmed;
      return ok({ ...confirmed.value, orderId: chunk.id, gasPrice });
    } catch (e) {
      return err(new ExecutionError(String(e), chunk.id, 'unknown'));
    }
  }

  async awaitConfirmation(txHash: string, timeoutMs: number): Promise<Result<Transaction, ExecutionError>> {
    const provider = (this.engine as unknown as { provider: ethers.JsonRpcProvider | null }).provider;
    const start    = Date.now();
    const pollMs   = 2000;

    while (Date.now() - start < timeoutMs) {
      await sleep(pollMs);

      try {
        if (provider) {
          const receipt = await provider.getTransactionReceipt(txHash);
          if (receipt !== null && receipt.status !== undefined) {
            if (receipt.status === 0) {
              // Transaction reverted on-chain
              return err(new ExecutionError(`Transaction ${txHash} reverted on-chain`, '', 'rpc'));
            }
            const actualSlippage = 0.1; // In production: calculate from receipt logs
            const tx: Transaction = {
              hash:           txHash,
              orderId:        '',
              status:         'confirmed',
              gasPrice:       0,
              gasLimit:       Number(receipt.gasUsed ?? 0),
              gasUsed:        Number(receipt.gasUsed ?? 0),
              actualSlippage,
              submittedAt:    start,
              confirmedAt:    Date.now(),
              blockNumber:    receipt.blockNumber,
              error:          null,
            };
            this.bus.emit('execution:confirmed', { tx });
            return ok(tx);
          }
        } else {
          // Demo/testnet mode without provider — simulate confirmation
          const tx: Transaction = {
            hash: txHash, orderId: '', status: 'confirmed',
            gasPrice: 0, gasLimit: 300_000, gasUsed: 150_000,
            actualSlippage: 0.1, submittedAt: start,
            confirmedAt: Date.now(), blockNumber: null, error: null,
          };
          this.bus.emit('execution:confirmed', { tx });
          return ok(tx);
        }
      } catch {
        // Poll error — keep waiting
      }
    }

    return err(new ExecutionError(`Transaction ${txHash} confirmation timeout after ${timeoutMs}ms`, '', 'rpc'));
  }

  getWalletAddress(): string {
    return this.wallet?.address ?? ethers.ZeroAddress;
  }

  async getPortfolioUsd(): Promise<number> {
    if (!this.wallet) return 0;
    return this.engine.getPortfolioValue(this.wallet.address);
  }

  private async signAndBroadcast(
    tx: Transaction,
    order: Order,
    gasPrice: number,
  ): Promise<string> {
    if (!this.wallet) throw new Error('Wallet not initialized');

    const cfg      = this.config.get();
    const provider = (this.engine as unknown as { provider: ethers.JsonRpcProvider }).provider;

    if (!provider) throw new Error('Provider not initialized');

    const signer   = this.wallet.connect(provider);
    const nonce    = await signer.getNonce();
    const gasPriceWei = ethers.parseUnits(gasPrice.toFixed(9), 'gwei');
    const amountInWei = ethers.parseUnits(order.size.toFixed(6), 18);

    const signedTx = await signer.sendTransaction({
      to:       cfg.venue.pancakeswapRouter,
      value:    order.side === 'buy' ? amountInWei : 0n,
      gasPrice: gasPriceWei,
      gasLimit: tx.gasLimit,
      nonce,
      data:     '0x', // In production: pass calldata from buildPancakeSwapTx
    });

    return signedTx.hash;
  }

  private async loadOrCreateWallet(): Promise<ethers.Wallet> {
    const keyDir = path.dirname(WALLET_KEY_FILE);
    await fs.promises.mkdir(keyDir, { recursive: true });

    if (fs.existsSync(WALLET_KEY_FILE)) {
      const privateKey = (await fs.promises.readFile(WALLET_KEY_FILE, 'utf8')).trim();
      const wallet = new ethers.Wallet(privateKey);
      logger.info('Loaded existing wallet', { address: wallet.address });
      return wallet;
    }

    // Create new wallet and persist the private key
    // createRandom() returns HDNodeWallet; extract a plain Wallet via the private key
    const hdWallet = ethers.Wallet.createRandom();
    const wallet   = new ethers.Wallet(hdWallet.privateKey);
    await fs.promises.writeFile(WALLET_KEY_FILE, wallet.privateKey, { mode: 0o600 });
    logger.info('Created new wallet', { address: wallet.address });
    logger.warn('⚠️  NEW WALLET CREATED — fund this address with testnet BNB before trading:', {
      address: wallet.address,
      faucet: 'https://testnet.bnbchain.org/faucet-smart',
    });
    return wallet;
  }
}
