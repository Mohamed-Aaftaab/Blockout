import { execFile } from 'node:child_process';
import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type { SystemState, CompetitionRegistration } from '../types/index';
import { ok, err, type Result } from '../types/index';
import { ExecutionError } from '../types/errors';

const logger = makeLogger();

// BNB Hack 2026 — competition contract on BSC mainnet.
// The twak CLI knows this address internally; we keep it here for logging only.
const COMPETITION_CONTRACT = '0x212c61b9b72c95d95bf29cf032f5e5635629aed5';

interface CompeteStatusJson {
  registered:       boolean;
  participant:      string;
  opensAt:          string;
  deadline:         string;
  open:             boolean;
  secondsRemaining: number;
  chain:            string;
  txHash?:          string;
}

interface CompeteRegisterJson {
  txHash:      string;
  participant: string;
  chain:       string;
  registered?: boolean;
}

export class RegistrationService {
  private readonly config: ConfigurationService;
  private readonly bus:    EventBus;

  constructor(config: ConfigurationService, bus: EventBus) {
    this.config = config;
    this.bus    = bus;
  }

  async register(): Promise<Result<CompetitionRegistration, ExecutionError>> {
    const cfg = this.config.get();

    logger.info('Registering with BNB Hack competition contract', {
      contract: COMPETITION_CONTRACT,
      network:  cfg.network.mode,
    });

    // Check if already registered on-chain before submitting
    try {
      const statusOut = await this.runTwak(['compete', 'status', '--json']);
      const status    = JSON.parse(statusOut) as CompeteStatusJson;
      if (status.registered) {
        logger.info('Already registered on-chain', { participant: status.participant, txHash: status.txHash });
        const reg: CompetitionRegistration = {
          walletAddress: status.participant,
          txHash:        status.txHash ?? '0x',
          timestamp:     Date.now(),
          confirmed:     true,
        };
        this.bus.emit('registration:submitted', reg);
        return ok(reg);
      }
      if (!status.open) {
        return err(new ExecutionError('Competition registration window is closed', 'registration', 'rpc'));
      }
    } catch {
      // Non-fatal — proceed to register even if status check fails
    }

    try {
      const stdout = await this.runTwak([
        'compete', 'register',
        '--password', cfg.twakWalletPassword,
        '--json',
      ]);

      const parsed = JSON.parse(stdout) as CompeteRegisterJson;
      if (!parsed.txHash || !parsed.participant) {
        throw new Error(`Unexpected twak output: ${stdout}`);
      }

      const registration: CompetitionRegistration = {
        walletAddress: parsed.participant,
        txHash:        parsed.txHash,
        timestamp:     Date.now(),
        confirmed:     parsed.registered ?? false,
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

  /** Polls compete status until on-chain confirmed or timeout. Call after register(). */
  async awaitConfirmation(timeoutMs = 120_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const out    = await this.runTwak(['compete', 'status', '--json']);
        const status = JSON.parse(out) as CompeteStatusJson;
        if (status.registered) return true;
      } catch {
        // keep polling
      }
    }
    return false;
  }

  private runTwak(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        TWAK_ACCESS_ID:       process.env['TWAK_ACCESS_ID'] ?? '',
        TWAK_HMAC_SECRET:     process.env['TWAK_HMAC_SECRET'] ?? '',
        TWAK_WALLET_PASSWORD: process.env['TWAK_WALLET_PASSWORD'] ?? '',
      };
      execFile('twak', args, { env }, (error, stdout, stderr) => {
        if (error) {
          const cleanErr = String(error)
            .replace(/twak: could not register testnet[^\n]*\n?/g, '')
            .trim();
          reject(new Error(cleanErr || stderr));
          return;
        }
        // Strip the testnet warning line that appears before JSON on stderr-mixed stdout
        const json = stdout
          .split('\n')
          .filter(l => !l.startsWith('twak: could not register'))
          .join('\n')
          .trim();
        resolve(json);
      });
    });
  }
}

/**
 * Hard gate: throws if the agent is running in mainnet mode without a
 * confirmed competition registration. Call in bootstrap() before starting
 * any trading services.
 */
export function registrationGate(mode: string, state: SystemState): void {
  if (mode !== 'mainnet') return;
  const reg = state.competitionRegistration;
  if (!reg || !reg.confirmed) {
    throw new Error(
      'Cannot start in mainnet mode without a confirmed competition registration. ' +
      'Run: npm run register',
    );
  }
}
