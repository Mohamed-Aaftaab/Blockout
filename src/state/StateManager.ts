import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { z } from 'zod';
import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type { SystemState, Position, Transaction } from '../types/index';
import { ok, err, type Result } from '../types/index';
import { StateError } from '../types/errors';

const logger = makeLogger();

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
  // value is serialised as a decimal string by saveState (JSON cannot hold bigint)
  // Accept both bigint (in-memory) and string (from JSON) and coerce to bigint
  value:          z.union([z.bigint(), z.string()]).transform(v => BigInt(v)),
  to:             z.string(),
}) as z.ZodType<Transaction>;

const CompetitionRegistrationSchema = z.object({
  walletAddress: z.string(),
  txHash:        z.string(),
  timestamp:     z.number(),
  confirmed:     z.boolean(),
});

const SystemStateSchema = z.object({
  version:                 z.string(),
  openPositions:           z.array(PositionSchema),
  pendingTransactions:     z.array(TransactionSchema),
  drawdownBaseline:        z.number(),
  circuitBreakerActive:    z.boolean(),
  emergencyShutdown:       z.boolean(),
  lastRegimes:             z.record(z.enum(['bull', 'bear', 'sideways'])).default({}),
  savedAt:                 z.number(),
  checksum:                z.string(),
  // .default(null) handles old state files that predate competitionRegistration (pre-v2)
  competitionRegistration: CompetitionRegistrationSchema.nullable().default(null),
  // .default({}) handles old state files that predate dailyTrades (pre-v3)
  dailyTrades:             z.record(z.string(), z.number()).default({}),
}) as unknown as z.ZodType<SystemState>;

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

    // JSON.stringify cannot handle bigint natively (Transaction.value is bigint).
    // Serialise bigint as a decimal string; reviver in loadState restores it.
    const content = JSON.stringify(stateToSave, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    , 2);

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
      // Revive bigint values that were serialised as decimal strings by saveState.
      // Only the Transaction.value field is bigint — it always parses to a valid BigInt.
      const json = JSON.parse(raw, (key, value) => {
        if (key === 'value' && typeof value === 'string') {
          try { return BigInt(value); } catch { return value; }
        }
        return value;
      }) as unknown;

      // Zod validation
      const parsed = SystemStateSchema.safeParse(json);
      if (!parsed.success) {
        const msg = `State file failed schema validation: ${parsed.error.message}`;
        logger.error(msg, { path: filePath });
        this.bus.emit('state:corrupted', { path: filePath, error: msg });
        return err(new StateError(msg));
      }

      const state: SystemState = parsed.data;

      // Checksum verification — skip for pre-v2 state files that predate
      // competitionRegistration. Zod's .default(null) adds the field after
      // the fact, so the stored checksum (computed without it) would never
      // match. The next saveState() will recompute and persist the new checksum.
      const rawObj = json as Record<string, unknown>;
      // Skip checksum for state files that predate a field addition (Zod fills defaults
      // after the fact, so the stored checksum would never match the defaulted shape).
      const isMigratedState =
        !('competitionRegistration' in rawObj) ||
        !('dailyTrades' in rawObj);
      if (!isMigratedState && !this.verifyChecksum(state)) {
        const msg = 'State file checksum mismatch — file may be corrupted';
        logger.error(msg, { path: filePath });
        this.bus.emit('state:corrupted', { path: filePath, error: msg });
        return err(new StateError(msg));
      }
      if (isMigratedState) {
        logger.info('State file migrated to v2 (competitionRegistration added)', { path: filePath });
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
    // Deep-sort all object keys so the hash is deterministic regardless of
    // insertion order or Node.js version. Convert bigint to string so
    // JSON.stringify doesn't throw on Transaction.value fields.
    const stableStringify = (val: unknown): string => {
      if (typeof val === 'bigint') return `"${val.toString()}"`;
      if (val === null || typeof val !== 'object') return JSON.stringify(val);
      if (Array.isArray(val)) return '[' + val.map(stableStringify).join(',') + ']';
      const sorted = Object.keys(val as object).sort().map(k => {
        return JSON.stringify(k) + ':' + stableStringify((val as Record<string, unknown>)[k]);
      });
      return '{' + sorted.join(',') + '}';
    };
    return 'sha256:' + crypto.createHash('sha256').update(stableStringify(state)).digest('hex');
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
      version:                 '3.0.0',
      openPositions:           [],
      pendingTransactions:     [],
      drawdownBaseline:        0,
      circuitBreakerActive:    false,
      emergencyShutdown:       false,
      lastRegimes:             {},
      savedAt:                 Date.now(),
      competitionRegistration: null,
      dailyTrades:             {},
    };
    const checksum = this.computeChecksum(blank);
    return { ...blank, checksum };
  }
}
