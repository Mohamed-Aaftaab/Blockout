import { execFile } from 'node:child_process';
import { makeLogger } from '../utils/logger';
import { ExecutionError } from '../types/errors';

const logger = makeLogger();

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
    const out = await this.run(['sign', '--raw', unsignedTxHex]).catch((e: unknown) => {
      throw new ExecutionError(`TWAK sign failed: ${String(e)}`, '', 'signing');
    });
    if (!out.startsWith('0x')) {
      throw new ExecutionError(`TWAK sign returned unexpected output: ${out}`, '', 'signing');
    }
    return out;
  }

  async getBalance(): Promise<bigint> {
    this.requireReady();
    const out = await this.run(['wallet', 'balance', '--unit', 'wei']).catch((e: unknown) => {
      throw new ExecutionError(`TWAK balance failed: ${String(e)}`, '', 'rpc');
    });
    return BigInt(out);
  }

  private async checkCli(): Promise<void> {
    await this.run(['--version']).catch(() => {
      throw new ExecutionError(
        'TWAK CLI not found on PATH. ' +
        'Install via: curl -fsSL https://agent-kit.trustwallet.com/install.sh | bash',
        'init',
        'signing',
      );
    });
  }

  private async loadAddress(): Promise<void> {
    const addr = await this.run(['wallet', 'address']).catch((e: unknown) => {
      throw new ExecutionError(
        `TWAK wallet address lookup failed: ${String(e)}`,
        'init',
        'signing',
      );
    });
    if (!addr) {
      throw new ExecutionError('TWAK returned empty wallet address', 'init', 'signing');
    }
    this.address = addr;
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('twak', args, (err, stdout) => {
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
