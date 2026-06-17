import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { z } from 'zod';
import { createLogger, transports, format } from 'winston';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type { SystemState, Position, Transaction } from '../types/index';
import { ok, err, type Result } from '../types/index';
import { StateError } from '../types/errors';

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const PositionSchema: z.ZodType<Position> = z.object({
  id:          z.string(),
  pair:        z.string(),
  side:        z.enum(['buy', 'sell']),
  entryPrice:  z.number(),
  size:        z.number(),
  stopLoss:    z.number(),
  takeProfit:  z.number(),
  leverage:    z.number(),
  strategy:    z.string(),
  venue:       z.enum(['pancakeswap', 'bsc_perpetuals']),
  openedAt:    z.number(),
  txHash:      z.string(),
});

const TransactionSchema: z.ZodType<Transaction> = z.object({
  hash:           z.string(),
  orderId:        z.string(),
  status:         z.enum(['pending', 'confirmed', 'failed', 'replaced']),
  gasPrice:       z.number(),
  gasLimit:       z.number(),
  gasUsed:        z.number().nullable(),
  actualSlippage: z.number().nullable(),
  submittedAt:    z.number(),
  confirmedAt:    z.number().nullable(),
  blockNumber:    z.number().nullable(),
  error:          z.string().nullable(),
  calldata:       z.string(),
  value:          z.bigint(),
  to:             z.string(),
}) as z.ZodType<Transaction>;

const SystemStateSchema: z.ZodType<SystemState> = z.object({
  version:              z.string(),
  openPositions:        z.array(PositionSchema),
  pendingTransactions:  z.array(TransactionSchema),
  drawdownBaseline:     z.number(),
  circuitBreakerActive: z.boolean(),
  emergencyShutdown:    z.boolean(),
  savedAt:              z.number(),
  checksum:             z.string(),
});

// ─── StateManager ─────────────────────────────────────────────────────────────

export class StateManager {
  private readonly config: ConfigurationService;
  private readonly bus:    EventBus;

  constructor(config: ConfigurationService, bus: EventBus) {
    this.config = config;
    this.bus    = bus;
  }

  async saveState(state: SystemState): Promise<void> {
    const cfg = this.config.get();

    // Build the state with updated savedAt first, then compute checksum over it
    const { checksum: _ignored, ...stateWithoutChecksum } = state;
    void _ignored;

    const stateBody: Omit<SystemState, 'checksum'> = {
      ...stateWithoutChecksum,
      savedAt: Date.now(),
    };

    const checksum = this.computeChecksum(stateBody);

    const stateToSave: SystemState = {
      ...stateBody,
      checksum,
    };

    const content = JSON.stringify(stateToSave, null, 2);

    // Ensure directory exists
    const dir = path.dirname(cfg.stateFilePath);
    await fs.promises.mkdir(dir, { recursive: true });

    await this.atomicWrite(cfg.stateFilePath, content);

    this.bus.emit('state:saved', {
      path:      cfg.stateFilePath,
      timestamp: stateToSave.savedAt,
    });

    logger.debug('State saved', {
      path:      cfg.stateFilePath,
      positions: state.openPositions.length,
      pending:   state.pendingTransactions.length,
    });
  }

  async loadState(): Promise<Result<SystemState, StateError>> {
    const cfg      = this.config.get();
    const filePath = cfg.stateFilePath;

    // If state file doesn't exist, return clean initial state
    if (!fs.existsSync(filePath)) {
      logger.info('No state file found — starting fresh', { path: filePath });
      return ok(this.emptyState());
    }

    try {
      const raw  = await fs.promises.readFile(filePath, 'utf8');
      const json = JSON.parse(raw) as unknown;

      // Zod validation
      const parsed = SystemStateSchema.safeParse(json);
      if (!parsed.success) {
        const msg = `State file failed schema validation: ${parsed.error.message}`;
        logger.error(msg, { path: filePath });
        this.bus.emit('state:corrupted', { path: filePath, error: msg });
        return err(new StateError(msg));
      }

      const state: SystemState = parsed.data;

      // Checksum verification
      if (!this.verifyChecksum(state)) {
        const msg = 'State file checksum mismatch — file may be corrupted';
        logger.error(msg, { path: filePath });
        this.bus.emit('state:corrupted', { path: filePath, error: msg });
        return err(new StateError(msg));
      }

      this.bus.emit('state:loaded', { state });
      logger.info('State loaded', {
        path:      filePath,
        positions: state.openPositions.length,
        pending:   state.pendingTransactions.length,
      });

      return ok(state);

    } catch (e) {
      const msg = `Failed to load state: ${String(e)}`;
      logger.error(msg, { path: filePath });
      this.bus.emit('state:corrupted', { path: filePath, error: msg });
      return err(new StateError(msg));
    }
  }

  private computeChecksum(state: Omit<SystemState, 'checksum'>): string {
    // Sort keys deterministically for consistent hashing
    const sorted = JSON.stringify(state, Object.keys(state).sort() as string[]);
    return 'sha256:' + crypto.createHash('sha256').update(sorted).digest('hex');
  }

  private verifyChecksum(state: SystemState): boolean {
    const { checksum, ...rest } = state;
    const expected = this.computeChecksum(rest);
    return checksum === expected;
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.tmp.${Date.now()}`;
    try {
      await fs.promises.writeFile(tmp, content, 'utf8');
      await fs.promises.rename(tmp, filePath);
    } catch (e) {
      // Clean up temp file if rename failed
      try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
      throw e;
    }
  }

  emptyState(): SystemState {
    const blank: Omit<SystemState, 'checksum'> = {
      version:              '1.0.0',
      openPositions:        [],
      pendingTransactions:  [],
      drawdownBaseline:     0,
      circuitBreakerActive: false,
      emergencyShutdown:    false,
      savedAt:              Date.now(),
    };
    const checksum = this.computeChecksum(blank);
    return { ...blank, checksum };
  }
}
