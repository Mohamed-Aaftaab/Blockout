import { execFile } from 'node:child_process';
import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type { SystemState, CompetitionRegistration } from '../types/index';
import { ok, err, type Result } from '../types/index';
import { ExecutionError } from '../types/errors';

const logger = makeLogger();

const COMPETITION_CONTRACT = '0x212c61b9b72c95d95bf29cf032f5e5635629aed5';

export class RegistrationService {
  private readonly config: ConfigurationService;
  private readonly bus:    EventBus;

  constructor(config: ConfigurationService, bus: EventBus) {
    this.config = config;
    this.bus    = bus;
  }

  async register(): Promise<Result<CompetitionRegistration, ExecutionError>> {
    const cfg     = this.config.get();
    const network = cfg.network.mode === 'mainnet' ? 'bsc' : 'bsc-testnet';

    logger.info('Registering with competition contract', {
      contract: COMPETITION_CONTRACT,
      network,
    });

    try {
      const stdout = await this.runTwak([
        'compete', 'register',
        '--contract', COMPETITION_CONTRACT,
        '--network',  network,
        '--output',   'json',
      ]);

      const parsed = JSON.parse(stdout) as { txHash?: string; walletAddress?: string };
      if (!parsed.txHash || !parsed.walletAddress) {
        throw new Error(`unexpected twak output: ${stdout}`);
      }

      const registration: CompetitionRegistration = {
        walletAddress: parsed.walletAddress,
        txHash:        parsed.txHash,
        timestamp:     Date.now(),
        confirmed:     false,
      };

      logger.info('Competition registration submitted', registration);
      this.bus.emit('registration:submitted', registration);
      return ok(registration);
    } catch (e) {
      const msg = `Competition registration failed: ${String(e)}`;
      logger.error(msg);
      return err(new ExecutionError(msg, 'registration', 'rpc'));
    }
  }

  private runTwak(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('twak', args, (error, stdout) => {
        if (error) { reject(error); return; }
        resolve(stdout.trim());
      });
    });
  }
}

/**
 * Hard gate: throws if the agent is running in mainnet mode without a
 * confirmed competition registration. Call this in bootstrap() before
 * starting any trading services.
 */
export function registrationGate(
  mode:  string,
  state: SystemState,
): void {
  if (mode !== 'mainnet') return;
  const reg = state.competitionRegistration;
  if (!reg || !reg.confirmed) {
    throw new Error(
      'Cannot start in mainnet mode without a confirmed competition registration. ' +
      'Run: npm run register',
    );
  }
}
