import { ethers } from 'ethers';
import * as fs    from 'fs';
import * as path  from 'path';
import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';
import type { EventBus }             from '../events/EventBus';
import type { Order, Transaction, Result } from '../types/index';
import { ok, err }                   from '../types/index';
import { ExecutionError }            from '../types/errors';
import type { TradingEngine }        from './TradingEngine';
import type { GasOptimizer }         from './GasOptimizer';
import { sleep }                     from '../utils/sleep';

const WALLET_KEY_FILE = './data/wallet.key';

const logger = makeLogger();

export class ExecutionService {
  private readonly engine:       TradingEngine;
  private readonly gasOptimizer: GasOptimizer;
  private readonly config:       ConfigurationService;
  private readonly bus:          EventBus;
  private wallet:                ethers.Wallet | null = null;
  /**
   * Nonce lock: serialises sendRawTx calls from the same wallet so concurrent
   * pair executions don't fetch the same pending nonce and collide on-chain.
   */
  private nonceLock: Promise<void> = Promise.resolve();

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
      const wallet = await this.loadOrCreateWallet();
      this.wallet  = wallet;
      this.engine.setSigner(wallet);
      logger.info('ExecutionService initialized', {
        address: wallet.address,
        network: cfg.network.mode,
        mode:    'self-custody (persistent ethers wallet)',
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

    // Loop: attempt 0 is the initial try; attempts 1..maxRetries are retries.
    // Total: maxRetries + 1 attempts (e.g. maxRetries=3 → 4 total: 1 initial + 3 retries).
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // For BSC Perpetuals: use routeOrder directly (no ERC-20 approval needed)
        if (order.venue === 'bsc_perpetuals') {
          const txResult = await this.engine.routeOrder({ ...order, slippage });
          if (!txResult.ok) throw new Error(txResult.error.message);
          const perpTx = txResult.value;
          const txHash = await this.sendRawTx(perpTx.to, perpTx.calldata, perpTx.value, gasPrice, perpTx.gasLimit);
          this.bus.emit('execution:submitted', { txHash, orderId: order.id, gasPrice });
          logger.info('Perp position submitted', { txHash, orderId: order.id, gasPrice });
          const confirmed = await this.awaitConfirmation(txHash, cfg.txTimeoutSec * 1000);
          if (!confirmed.ok) return confirmed;
          return ok({ ...confirmed.value, orderId: order.id, gasPrice });
        }

        // For PancakeSwap: build full swap plan including any required ERC-20 approval
        const plan = await this.engine.buildSwapPlan({ ...order, slippage });

        // Step 1: Send ERC-20 approval if needed (before the swap)
        if (plan.approveTx !== null) {
          logger.info('Sending ERC-20 approve transaction', { token: plan.approveTx.to });
          const approveHash = await this.sendRawTx(plan.approveTx.to, plan.approveTx.calldata, plan.approveTx.value, gasPrice, 100_000);
          const approveConfirm = await this.awaitConfirmation(approveHash, 60_000);
          if (!approveConfirm.ok) {
            logger.error('Approval tx failed', { error: approveConfirm.error.message });
            return approveConfirm;
          }
          logger.info('ERC-20 approval confirmed', { txHash: approveHash });
        }

        // Step 2: Send the swap transaction
        const swapHash = await this.sendRawTx(plan.swapTx.to, plan.swapTx.calldata, plan.swapTx.value, gasPrice, plan.swapTx.gasLimit);
        this.bus.emit('execution:submitted', { txHash: swapHash, orderId: order.id, gasPrice });
        logger.info('Swap submitted', { txHash: swapHash, orderId: order.id, venue: order.venue, gasPrice });

        const confirmed = await this.awaitConfirmation(swapHash, cfg.txTimeoutSec * 1000);
        if (!confirmed.ok) return confirmed;

        // Invalidate portfolio cache so next portfolio read reflects the swap
        this.engine.invalidatePortfolioCache();
        return ok({ ...confirmed.value, orderId: order.id, gasPrice });
      } catch (e) {
        const errMsg = String(e);
        if (attempt < maxRetries) {
          if (errMsg.includes('gas') || errMsg.includes('underpriced') || errMsg.includes('insufficient funds')) {
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
      const actualGasPrice = gasPrice > 0 ? gasPrice : await this.gasOptimizer.getOptimalGasPrice();

      // TWAP chunks are always PancakeSwap — perp orders are never split
      // But guard defensively in case venue is unexpected
      if (chunk.venue === 'bsc_perpetuals') {
        const txResult = await this.engine.routeOrder(chunk);
        if (!txResult.ok) throw new Error(txResult.error.message);
        const perpTx = txResult.value;
        const txHash = await this.sendRawTx(perpTx.to, perpTx.calldata, perpTx.value, actualGasPrice, perpTx.gasLimit);
        const confirmed = await this.awaitConfirmation(txHash, 120_000);
        if (!confirmed.ok) return confirmed;
        return ok({ ...confirmed.value, orderId: chunk.id, gasPrice: actualGasPrice });
      }

      const plan = await this.engine.buildSwapPlan(chunk);

      // Send approval if needed
      if (plan.approveTx !== null) {
        const approveHash = await this.sendRawTx(plan.approveTx.to, plan.approveTx.calldata, plan.approveTx.value, actualGasPrice, 100_000);
        const approveConfirm = await this.awaitConfirmation(approveHash, 60_000);
        if (!approveConfirm.ok) return approveConfirm;
      }

      const swapHash = await this.sendRawTx(plan.swapTx.to, plan.swapTx.calldata, plan.swapTx.value, actualGasPrice, plan.swapTx.gasLimit);
      const confirmed = await this.awaitConfirmation(swapHash, 120_000);
      if (!confirmed.ok) return confirmed;
      this.engine.invalidatePortfolioCache();
      return ok({ ...confirmed.value, orderId: chunk.id, gasPrice: actualGasPrice });
    } catch (e) {
      return err(new ExecutionError(String(e), chunk.id, 'unknown'));
    }
  }

  async awaitConfirmation(txHash: string, timeoutMs: number): Promise<Result<Transaction, ExecutionError>> {
    // Use public getProvider() instead of unsafe private field cast
    const provider = this.engine.getProvider();
    const start    = Date.now();
    const pollMs   = 2000;

    while (Date.now() - start < timeoutMs) {
      // Poll first, then sleep — avoids an unnecessary 2s wait for fast confirmations
      try {
        if (provider !== null) {
          const receipt = await provider.getTransactionReceipt(txHash);
          if (receipt !== null && receipt.status !== undefined) {
            if (receipt.status === 0) {
              return err(new ExecutionError(`Transaction ${txHash} reverted on-chain`, '', 'rpc'));
            }
            // Calculate actual slippage from receipt in production; use estimate for now
            const actualSlippage = 0.1;
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
              calldata:       '0x',
              value:          0n,
              to:             '',
            };
            this.bus.emit('execution:confirmed', { tx });
            return ok(tx);
          }
        } else {
          // Demo mode: simulate confirmation (no actual provider available)
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
            calldata:       '0x',
            value:          0n,
            to:             '',
          };
          this.bus.emit('execution:confirmed', { tx });
          return ok(tx);
        }
      } catch {
        // Transient poll error — keep retrying until timeout
      }

      await sleep(pollMs);
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

  /**
   * Returns the wallet's actual on-chain balance (in USD) of the base token of a pair.
   * Used before issuing a sell to prevent reverts when a prior buy partially filled.
   * Returns null if the token is native BNB (no ERC-20 balance to check).
   */
  async getBaseTokenBalance(pair: string): Promise<number | null> {
    if (!this.wallet) return null;
    const [baseSymbol] = pair.split('/');
    if (!baseSymbol) return null;
    if (baseSymbol === 'BNB' || baseSymbol === 'WBNB') return null;
    const balanceUsd = await this.engine.getBaseTokenBalanceUsd(baseSymbol, this.wallet.address);
    return balanceUsd;
  }

  /**
   * Returns the wallet's on-chain quote token balance in USD.
   * Used before issuing a buy-to-close on a sell position to prevent reverts.
   */
  async getQuoteTokenBalance(pair: string): Promise<number | null> {
    if (!this.wallet) return null;
    const [, quoteSymbol] = pair.split('/');
    if (!quoteSymbol || quoteSymbol === 'BNB' || quoteSymbol === 'WBNB') return null;
    const balanceUsd = await this.engine.getBaseTokenBalanceUsd(quoteSymbol, this.wallet.address);
    return balanceUsd;
  }

  // Sends a raw transaction (approve or swap) and returns the tx hash.
  // Serialises via nonceLock so concurrent pair executions never share the same nonce.
  // Has a per-call timeout (cfg.txTimeoutSec) so a hung RPC never stalls the nonce queue.
  private async sendRawTx(
    to:       string,
    calldata: string,
    value:    bigint,
    gasPrice: number,
    gasLimit: number,
  ): Promise<string> {
    if (!this.wallet) throw new Error('Wallet not initialized');
    const provider = this.engine.getProvider();
    if (!provider) throw new Error('Provider not initialized');

    const cfg = this.config.get();
    const timeoutMs = cfg.txTimeoutSec * 1000;

    // Queue through the nonce lock so two concurrent sendRawTx calls never receive
    // the same pending nonce. The lock is released after the transaction is submitted
    // (not after confirmation) to keep throughput reasonable.
    let resolveNonce!: () => void;
    const prev = this.nonceLock;
    this.nonceLock = new Promise(res => { resolveNonce = res; });

    try {
      await prev; // wait for any in-flight send to finish fetching + using its nonce
      const signer      = this.wallet.connect(provider);
      const gasPriceWei = ethers.parseUnits(gasPrice.toFixed(9), 'gwei');
      const nonce       = await signer.getNonce('pending');

      // Wrap sendTransaction in a race against a timeout so a hung RPC node
      // never permanently stalls the nonce lock.
      const sentTx = await Promise.race([
        signer.sendTransaction({ to, data: calldata, value, gasPrice: gasPriceWei, gasLimit, nonce }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`sendTransaction timeout after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      return sentTx.hash;
    } finally {
      resolveNonce();
    }
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

    // createRandom() returns HDNodeWallet; extract a plain Wallet via the private key
    const hdWallet = ethers.Wallet.createRandom();
    const wallet   = new ethers.Wallet(hdWallet.privateKey);
    await fs.promises.writeFile(WALLET_KEY_FILE, wallet.privateKey, { mode: 0o600 });
    logger.info('Created new wallet', { address: wallet.address });
    logger.warn('⚠️  NEW WALLET — fund this address with testnet BNB before live trading:', {
      address: wallet.address,
      faucet:  'https://testnet.bnbchain.org/faucet-smart',
    });
    return wallet;
  }
}
