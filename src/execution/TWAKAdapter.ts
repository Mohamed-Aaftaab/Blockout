import { execFile } from 'node:child_process';
import { makeLogger } from '../utils/logger';
import { ExecutionError } from '../types/errors';

const logger = makeLogger();

// TWAK CLI is available via npx @trustwallet/cli (no global install required).
// The TWAK_WALLET_PASSWORD env var provides the signing password.
const TWAK_CMD  = 'npx';
const TWAK_ARGS = ['@trustwallet/cli'];

export class TWAKAdapter {
  private address = '';
  private ready    = false;

  async initialize(): Promise<void> {
    await this.checkCli();
    await this.loadAddress();
    this.ready = true;
    logger.info('TWAKAdapter initialized', { address: this.address });
  }

  getAddress(): string {
    this.requireReady();
    return this.address;
  }

  async sign(unsignedTxHex: string): Promise<string> {
    this.requireReady();
    const out = await this.run(['wallet', 'sign-message', '--chain', 'bsc', '--message', unsignedTxHex,
      '--password', process.env['TWAK_WALLET_PASSWORD'] ?? '', '--json']).catch((e: unknown) => {
      throw new ExecutionError(`TWAK sign failed: ${String(e)}`, '', 'signing');
    });
    // Parse JSON response from sign-message
    try {
      const parsed = JSON.parse(out) as Record<string, unknown>;
      const sig = String(parsed['signature'] ?? parsed['result'] ?? out);
      if (!sig.startsWith('0x')) {
        throw new ExecutionError(`TWAK sign returned unexpected output: ${sig}`, '', 'signing');
      }
      return sig;
    } catch {
      if (!out.startsWith('0x')) {
        throw new ExecutionError(`TWAK sign returned unexpected output: ${out}`, '', 'signing');
      }
      return out;
    }
  }

  async getBalance(): Promise<bigint> {
    this.requireReady();
    const out = await this.run(['wallet', 'balance', '--chain', 'bsc', '--json',
      '--password', process.env['TWAK_WALLET_PASSWORD'] ?? '']).catch((e: unknown) => {
      throw new ExecutionError(`TWAK balance failed: ${String(e)}`, '', 'rpc');
    });
    try {
      const parsed = JSON.parse(out) as Record<string, unknown>;
      const native = (parsed['native'] as Record<string, unknown> | undefined)?.['balance'];
      if (typeof native === 'string') {
        // Convert decimal BNB to wei
        const bnbFloat = parseFloat(native);
        return BigInt(Math.floor(bnbFloat * 1e18));
      }
    } catch { /* fall through */ }
    return 0n;
  }

  private async checkCli(): Promise<void> {
    await this.run(['--version']).catch(() => {
      throw new ExecutionError(
        'TWAK CLI not found. Install via: npm install -g @trustwallet/cli',
        'init',
        'signing',
      );
    });
  }

  private async loadAddress(): Promise<void> {
    const addr = await this.run(['wallet', 'address', '--chain', 'bsc', '--json']).catch((e: unknown) => {
      throw new ExecutionError(
        `TWAK wallet address lookup failed: ${String(e)}`,
        'init',
        'signing',
      );
    });
    // Parse JSON {"address": "0x..."}
    try {
      const parsed = JSON.parse(addr) as Record<string, unknown>;
      const address = String(parsed['address'] ?? '');
      if (address && address.startsWith('0x')) {
        this.address = address;
        return;
      }
    } catch { /* fall through to plain string */ }
    if (!addr || !addr.startsWith('0x')) {
      throw new ExecutionError('TWAK returned invalid wallet address', 'init', 'signing');
    }
    this.address = addr;
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(TWAK_CMD, [...TWAK_ARGS, ...args], (err, stdout) => {
        if (err) { reject(err); return; }
        resolve(stdout.trim());
      });
    });
  }

  private requireReady(): void {
    if (!this.ready) {
      throw new ExecutionError(
        'TWAKAdapter.initialize() must be called first',
        '',
        'signing',
      );
    }
  }
}
