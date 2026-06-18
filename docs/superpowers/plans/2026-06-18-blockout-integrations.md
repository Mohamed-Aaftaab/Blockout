# Blockout Integration Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace documentation-only stub adapters with real (or honestly-assessed) integrations, add on-chain competition registration with a hard startup gate, and align the README with what the code actually does.

**Architecture:** TWAK has no npm SDK and its CLI is not on PATH — the adapter will shell out to the `twak` binary when it becomes available, failing loudly at `initialize()` if it is missing. Competition registration is a one-off CLI entrypoint (`npm run register`) that writes a confirmed record to persisted state; the main agent startup gate reads that record and refuses to boot in mainnet mode without it. BNB Agent SDK is not on npm and does not add judged value for this trading-competition track; the README claim is removed. CMC Agent Hub availability is detected at startup from the API key and logged.

**Tech Stack:** TypeScript, ethers v6, Jest, Node.js `child_process.execFile`, zod, existing `ExecutionError` / `StateError` / `Result` monad pattern

**Findings from Task 1 step 1 (verification — do not skip):**
- `npm view @trustwallet/agent-sdk` → 404 Not Found
- `which twak` → not found
- `npm view @bnb-chain/bnbagent-sdk` → 404 Not Found

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/execution/TWAKAdapter.ts` | Replace stub | CLI subprocess wrapper for `twak` binary |
| `src/execution/ExecutionService.ts` | Modify | Switch from `ethers.Wallet` to `TWAKAdapter` for signing |
| `src/__tests__/twak.test.ts` | Create | Tests for TWAKAdapter and ExecutionService TWAK wiring |
| `src/types/index.ts` | Modify | Add `CompetitionRegistration` type; extend `SystemState` |
| `src/state/StateManager.ts` | Modify | Add `competitionRegistration` field to Zod schema |
| `src/state/migrations/v2_to_v3.ts` | Create | Migration that backfills `competitionRegistration: null` |
| `src/registration/RegistrationService.ts` | Create | One-off registration logic via `twak compete register` |
| `src/register.ts` | Create | Standalone CLI entrypoint (`npm run register`) |
| `src/index.ts` | Modify | Add mainnet startup gate that checks `competitionRegistration.confirmed` |
| `src/__tests__/registration.test.ts` | Create | Tests for RegistrationService and startup gate |
| `package.json` | Modify | Add `"register"` script |
| `src/execution/BNBAgentAdapter.ts` | Modify | Honest comment; remove aspirational claims |
| `README.md` | Modify | Update TWAK, BNB Agent SDK, and CMC sections to match code |

---

## Task 1: TWAKAdapter — subprocess wrapper for `twak` CLI

**Files:**
- Replace: `src/execution/TWAKAdapter.ts`
- Modify: `src/execution/ExecutionService.ts`
- Create: `src/__tests__/twak.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `src/__tests__/twak.test.ts`:

```typescript
import { TWAKAdapter } from '../execution/TWAKAdapter';
import { execFile } from 'node:child_process';
import { ExecutionService } from '../execution/ExecutionService';
import type { ConfigurationService } from '../config/index';
import type { TradingEngine } from '../execution/TradingEngine';
import type { GasOptimizer } from '../execution/GasOptimizer';
import type { EventBus } from '../events/EventBus';

jest.mock('node:child_process');

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

function mockTwakSuccess(outputs: string[]): void {
  let callIndex = 0;
  mockExecFile.mockImplementation(
    (_file: string, _args: string[], callback: (...args: unknown[]) => void) => {
      const out = outputs[callIndex++] ?? '';
      callback(null, out, '');
    },
  );
}

function mockTwakFailure(errorMsg: string): void {
  mockExecFile.mockImplementation(
    (_file: string, _args: string[], callback: (...args: unknown[]) => void) => {
      callback(new Error(errorMsg), '', '');
    },
  );
}

// ─── TWAKAdapter unit tests ───────────────────────────────────────────────────

describe('TWAKAdapter.initialize', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws ExecutionError when twak binary is not on PATH', async () => {
    mockTwakFailure('command not found: twak');
    const adapter = new TWAKAdapter();
    await expect(adapter.initialize()).rejects.toMatchObject({
      name: 'ExecutionError',
      message: expect.stringContaining('TWAK CLI not found'),
    });
  });

  it('throws ExecutionError when wallet address lookup fails after version check', async () => {
    mockExecFile
      .mockImplementationOnce((_f: string, _a: string[], cb: (...a: unknown[]) => void) =>
        cb(null, '1.0.0\n', ''),
      )
      .mockImplementationOnce((_f: string, _a: string[], cb: (...a: unknown[]) => void) =>
        cb(new Error('wallet not configured'), '', ''),
      );
    const adapter = new TWAKAdapter();
    await expect(adapter.initialize()).rejects.toMatchObject({
      name: 'ExecutionError',
      message: expect.stringContaining('wallet address'),
    });
  });

  it('sets address and resolves when twak is available', async () => {
    mockTwakSuccess(['1.0.0\n', '0xDeAdBeEf1234\n']);
    const adapter = new TWAKAdapter();
    await adapter.initialize();
    expect(adapter.getAddress()).toBe('0xDeAdBeEf1234');
  });
});

describe('TWAKAdapter.sign', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes --raw flag and returns signed hex', async () => {
    mockTwakSuccess(['1.0.0\n', '0xWallet\n', '0xSignedTxHex\n']);
    const adapter = new TWAKAdapter();
    await adapter.initialize();
    const result = await adapter.sign('0xUnsignedTxHex');
    expect(result).toBe('0xSignedTxHex');
    expect(mockExecFile).toHaveBeenCalledWith(
      'twak',
      ['sign', '--raw', '0xUnsignedTxHex'],
      expect.any(Function),
    );
  });

  it('throws ExecutionError when sign subprocess fails', async () => {
    mockExecFile
      .mockImplementationOnce((_f: string, _a: string[], cb: (...a: unknown[]) => void) =>
        cb(null, '1.0.0\n', ''),
      )
      .mockImplementationOnce((_f: string, _a: string[], cb: (...a: unknown[]) => void) =>
        cb(null, '0xWallet\n', ''),
      )
      .mockImplementationOnce((_f: string, _a: string[], cb: (...a: unknown[]) => void) =>
        cb(new Error('sign failed'), '', ''),
      );
    const adapter = new TWAKAdapter();
    await adapter.initialize();
    await expect(adapter.sign('0xBad')).rejects.toMatchObject({ name: 'ExecutionError' });
  });
});

// ─── ExecutionService TWAK integration tests ─────────────────────────────────

describe('ExecutionService TWAK wiring', () => {
  function buildExecService() {
    const mockEngine = {
      getProvider: jest.fn().mockReturnValue(null),
      setSigner: jest.fn(),
      getPortfolioValue: jest.fn().mockResolvedValue(0),
      getBaseTokenBalanceUsd: jest.fn().mockResolvedValue(0),
    } as unknown as TradingEngine;
    const mockGas = {} as unknown as GasOptimizer;
    const mockConfig = {
      get: jest.fn().mockReturnValue({
        network: { mode: 'testnet' },
        gas: { maxRetries: 3 },
      }),
    } as unknown as ConfigurationService;
    const mockBus = {
      emit: jest.fn(),
    } as unknown as EventBus;
    return new ExecutionService(mockEngine, mockGas, mockConfig, mockBus);
  }

  beforeEach(() => jest.clearAllMocks());

  it('initialize() emits health:critical and throws when TWAK init fails', async () => {
    mockTwakFailure('command not found: twak');
    const svc = buildExecService();
    await expect(svc.initialize()).rejects.toMatchObject({ name: 'ExecutionError' });
  });

  it('initialize() succeeds and exposes TWAK wallet address', async () => {
    mockTwakSuccess(['1.0.0\n', '0xTWAKAddress\n']);
    const svc = buildExecService();
    await svc.initialize();
    expect(svc.getWalletAddress()).toBe('0xTWAKAddress');
  });
});
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
cd /Users/silas/Blockout && npx jest src/__tests__/twak.test.ts --no-coverage 2>&1 | tail -20
```

Expected: test file compiles but all tests fail (TWAKAdapter is a stub / export {}).

- [ ] **Step 1.3: Implement TWAKAdapter.ts**

Replace the entire contents of `src/execution/TWAKAdapter.ts`:

```typescript
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
      throw new ExecutionError(`TWAK wallet address lookup failed: ${String(e)}`, 'init', 'signing');
    });
    if (!addr) throw new ExecutionError('TWAK returned empty wallet address', 'init', 'signing');
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
      throw new ExecutionError('TWAKAdapter.initialize() must be called first', '', 'signing');
    }
  }
}
```

- [ ] **Step 1.4: Run TWAKAdapter tests to confirm they pass**

```bash
cd /Users/silas/Blockout && npx jest src/__tests__/twak.test.ts --no-coverage 2>&1 | tail -20
```

Expected: all TWAKAdapter tests pass. ExecutionService tests may still fail (before we update ExecutionService).

- [ ] **Step 1.5: Update ExecutionService to use TWAKAdapter**

In `src/execution/ExecutionService.ts`, make these changes:

**Add import at top (after existing imports):**
```typescript
import { TWAKAdapter } from './TWAKAdapter';
```

**Replace the private fields block** (lines 19–28, replacing `wallet` and `nonceLock` declarations):

Old:
```typescript
  private wallet:                ethers.Wallet | null = null;
  /**
   * Nonce lock: serialises sendRawTx calls from the same wallet so concurrent
   * pair executions don't fetch the same pending nonce and collide on-chain.
   */
  private nonceLock: Promise<void> = Promise.resolve();
```

New:
```typescript
  private twakAdapter:           TWAKAdapter | null  = null;
  /**
   * Nonce lock: serialises sendRawTx calls so concurrent pair executions
   * never fetch the same pending nonce and collide on-chain.
   */
  private nonceLock: Promise<void> = Promise.resolve();
```

**Replace `initialize()` method body:**

Old (lines 42–58):
```typescript
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
```

New:
```typescript
  async initialize(): Promise<void> {
    const cfg     = this.config.get();
    const adapter = new TWAKAdapter();
    try {
      await adapter.initialize();
      this.twakAdapter = adapter;
      logger.info('ExecutionService initialized via TWAK', {
        address: adapter.getAddress(),
        network: cfg.network.mode,
      });
    } catch (e) {
      const msg = `ExecutionService initialization failed: ${String(e)}`;
      this.bus.emit('health:critical', { component: 'ExecutionService', message: msg, timestamp: Date.now() });
      throw new ExecutionError(msg, 'init', 'signing');
    }
  }
```

**Replace `getWalletAddress()` method:**

Old:
```typescript
  getWalletAddress(): string {
    return this.wallet?.address ?? ethers.ZeroAddress;
  }
```

New:
```typescript
  getWalletAddress(): string {
    return this.twakAdapter?.getAddress() ?? ethers.ZeroAddress;
  }
```

**Replace `getPortfolioUsd()` method:**

Old:
```typescript
  async getPortfolioUsd(): Promise<number> {
    if (!this.wallet) return 0;
    return this.engine.getPortfolioValue(this.wallet.address);
  }
```

New:
```typescript
  async getPortfolioUsd(): Promise<number> {
    if (!this.twakAdapter) return 0;
    return this.engine.getPortfolioValue(this.twakAdapter.getAddress());
  }
```

**Replace `getBaseTokenBalance()` method's wallet guard:**

Old first line in method body:
```typescript
    if (!this.wallet) return null;
```
New:
```typescript
    if (!this.twakAdapter) return null;
```

Old middle part (uses `this.wallet.address`):
```typescript
    const balanceUsd = await this.engine.getBaseTokenBalanceUsd(baseSymbol, this.wallet.address);
```
New:
```typescript
    const balanceUsd = await this.engine.getBaseTokenBalanceUsd(baseSymbol, this.twakAdapter.getAddress());
```

**Replace `getQuoteTokenBalance()` method's wallet guard:**

Old first line in method body:
```typescript
    if (!this.wallet) return null;
```
New:
```typescript
    if (!this.twakAdapter) return null;
```

Old (uses `this.wallet.address`):
```typescript
    const balanceUsd = await this.engine.getBaseTokenBalanceUsd(quoteSymbol, this.wallet.address);
```
New:
```typescript
    const balanceUsd = await this.engine.getBaseTokenBalanceUsd(quoteSymbol, this.twakAdapter.getAddress());
```

**Replace `sendRawTx()` private method entirely:**

Old (lines 270–298):
```typescript
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

    let resolveNonce!: () => void;
    const prev = this.nonceLock;
    this.nonceLock = new Promise(res => { resolveNonce = res; });

    try {
      await prev;
      const signer      = this.wallet.connect(provider);
      const gasPriceWei = ethers.parseUnits(gasPrice.toFixed(9), 'gwei');
      const nonce       = await signer.getNonce('pending');
      const sentTx      = await signer.sendTransaction({ to, data: calldata, value, gasPrice: gasPriceWei, gasLimit, nonce });
      return sentTx.hash;
    } finally {
      resolveNonce();
    }
  }
```

New:
```typescript
  private async sendRawTx(
    to:       string,
    calldata: string,
    value:    bigint,
    gasPrice: number,
    gasLimit: number,
  ): Promise<string> {
    if (!this.twakAdapter) throw new Error('TWAK adapter not initialized');
    const provider = this.engine.getProvider();
    if (!provider) throw new Error('Provider not initialized');

    let resolveNonce!: () => void;
    const prev = this.nonceLock;
    this.nonceLock = new Promise(res => { resolveNonce = res; });

    try {
      await prev;
      const gasPriceWei = ethers.parseUnits(gasPrice.toFixed(9), 'gwei');
      const { chainId }  = await provider.getNetwork();
      const nonce        = await provider.getTransactionCount(this.twakAdapter.getAddress(), 'pending');

      const unsignedTx = ethers.Transaction.from({
        to, data: calldata, value, gasPrice: gasPriceWei, gasLimit, nonce, chainId,
      });
      const signedHex = await this.twakAdapter.sign(unsignedTx.unsignedSerialized);
      const sentTx    = await provider.broadcastTransaction(signedHex);
      return sentTx.hash;
    } finally {
      resolveNonce();
    }
  }
```

**Delete the entire `loadOrCreateWallet()` private method** (lines 300–321) — it is no longer needed.

Also remove the import of `fs` and `path` if they are no longer used after deleting `loadOrCreateWallet`:

Remove from top of file:
```typescript
import * as fs    from 'fs';
import * as path  from 'path';
```

Remove the constant:
```typescript
const WALLET_KEY_FILE = './data/wallet.key';
```

- [ ] **Step 1.6: Run typecheck**

```bash
cd /Users/silas/Blockout && npm run typecheck 2>&1 | tail -30
```

Fix any type errors before proceeding.

- [ ] **Step 1.7: Run full test suite**

```bash
cd /Users/silas/Blockout && npm test 2>&1 | tail -40
```

Expected: all previously passing tests still pass; twak.test.ts passes.

- [ ] **Step 1.8: Commit**

```bash
cd /Users/silas/Blockout
git add src/execution/TWAKAdapter.ts src/execution/ExecutionService.ts src/__tests__/twak.test.ts
git commit -m "feat: implement TWAKAdapter (twak CLI subprocess) — replaces ethers.Wallet signing"
```

- [ ] **Step 1.9: Update README.md TWAK section**

Find the TWAK section in `README.md` and replace it with accurate content. The section should read:

> **TWAK (Trust Wallet Agent Kit)**
>
> `@trustwallet/agent-sdk` is not yet published on npm (verified 2026-06-18). The `twak` CLI was not on PATH at build time.
>
> `src/execution/TWAKAdapter.ts` wraps the `twak` binary via `child_process.execFile`. It calls:
> - `twak --version` to confirm the CLI is available at `initialize()` time
> - `twak wallet address` to retrieve the agent wallet address
> - `twak sign --raw <unsignedTxHex>` to sign each transaction
>
> `ExecutionService.initialize()` calls `TWAKAdapter.initialize()` and **fails loudly** — emitting `health:critical` and throwing — if `twak` is not on PATH. There is no silent fallback to a local key.
>
> **To activate:** install the TWAK CLI (`curl -fsSL https://agent-kit.trustwallet.com/install.sh | bash`) and verify the `twak wallet address` command syntax against the installed version, adjusting `TWAKAdapter.run()` args if needed.

- [ ] **Step 1.10: Commit README update**

```bash
cd /Users/silas/Blockout
git add README.md
git commit -m "docs: update README TWAK section to match actual implementation"
```

---

## Task 2: On-chain Competition Registration

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/state/StateManager.ts`
- Create: `src/state/migrations/v2_to_v3.ts`
- Create: `src/registration/RegistrationService.ts`
- Create: `src/register.ts`
- Modify: `src/index.ts`
- Modify: `package.json`
- Create: `src/__tests__/registration.test.ts`

- [ ] **Step 2.1: Write failing registration tests**

Create `src/__tests__/registration.test.ts`:

```typescript
import { RegistrationService } from '../registration/RegistrationService';
import { execFile } from 'node:child_process';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';

jest.mock('node:child_process');

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

function mockSuccess(stdout: string): void {
  mockExecFile.mockImplementation(
    (_f: string, _a: string[], cb: (...args: unknown[]) => void) => cb(null, stdout, ''),
  );
}

function mockFailure(msg: string): void {
  mockExecFile.mockImplementation(
    (_f: string, _a: string[], cb: (...args: unknown[]) => void) => cb(new Error(msg), '', ''),
  );
}

function buildSvc() {
  const mockConfig = {
    get: jest.fn().mockReturnValue({
      network: { mode: 'testnet' },
    }),
  } as unknown as ConfigurationService;
  const mockBus = { emit: jest.fn() } as unknown as EventBus;
  return new RegistrationService(mockConfig, mockBus);
}

describe('RegistrationService.register', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns ok with txHash and walletAddress on success', async () => {
    mockSuccess('{"txHash":"0xRegTx","walletAddress":"0xMyWallet"}\n');
    const svc    = buildSvc();
    const result = await svc.register();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.txHash).toBe('0xRegTx');
      expect(result.value.walletAddress).toBe('0xMyWallet');
      expect(result.value.confirmed).toBe(false);
      expect(typeof result.value.timestamp).toBe('number');
    }
  });

  it('returns err when twak compete register fails', async () => {
    mockFailure('registration failed: deadline passed');
    const svc    = buildSvc();
    const result = await svc.register();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('registration failed');
    }
  });

  it('calls twak with the correct competition contract address', async () => {
    mockSuccess('{"txHash":"0xTx","walletAddress":"0xW"}\n');
    const svc = buildSvc();
    await svc.register();
    expect(mockExecFile).toHaveBeenCalledWith(
      'twak',
      expect.arrayContaining(['compete', 'register', '--contract', '0x212c61b9b72c95d95bf29cf032f5e5635629aed5']),
      expect.any(Function),
    );
  });
});

// ─── Startup gate tests (index.ts logic, tested via a helper extracted from it) ─

import { registrationGate } from '../registration/RegistrationService';
import type { SystemState } from '../types/index';

function stateWith(reg: SystemState['competitionRegistration']): SystemState {
  return {
    version:               '2.0.0',
    openPositions:         [],
    pendingTransactions:   [],
    drawdownBaseline:      0,
    circuitBreakerActive:  false,
    emergencyShutdown:     false,
    savedAt:               Date.now(),
    checksum:              '',
    competitionRegistration: reg,
  };
}

describe('registrationGate', () => {
  it('passes on testnet even without registration', () => {
    expect(() => registrationGate('testnet', stateWith(null))).not.toThrow();
  });

  it('passes on mainnet with a confirmed registration', () => {
    expect(() => registrationGate('mainnet', stateWith({
      walletAddress: '0xW',
      txHash:        '0xT',
      timestamp:     Date.now(),
      confirmed:     true,
    }))).not.toThrow();
  });

  it('throws on mainnet with no registration', () => {
    expect(() => registrationGate('mainnet', stateWith(null))).toThrow(
      /npm run register/,
    );
  });

  it('throws on mainnet with unconfirmed registration', () => {
    expect(() => registrationGate('mainnet', stateWith({
      walletAddress: '0xW',
      txHash:        '0xT',
      timestamp:     Date.now(),
      confirmed:     false,
    }))).toThrow(/npm run register/);
  });
});
```

- [ ] **Step 2.2: Run tests to confirm they fail**

```bash
cd /Users/silas/Blockout && npx jest src/__tests__/registration.test.ts --no-coverage 2>&1 | tail -20
```

Expected: compile errors (modules not found yet).

- [ ] **Step 2.3: Add CompetitionRegistration type and update SystemState**

In `src/types/index.ts`, add after the `TradeRecord` interface (after line 282):

```typescript
// ─── Competition Registration ─────────────────────────────────────────────────

export interface CompetitionRegistration {
  walletAddress: string;
  txHash:        string;
  timestamp:     number;
  confirmed:     boolean;
}
```

And update the `SystemState` interface to add the new field:

Old:
```typescript
export interface SystemState {
  version:               string;
  openPositions:         Position[];
  pendingTransactions:   Transaction[];
  drawdownBaseline:      number;
  circuitBreakerActive:  boolean;
  emergencyShutdown:     boolean;
  savedAt:               number;
  checksum:              string;
}
```

New:
```typescript
export interface SystemState {
  version:                  string;
  openPositions:            Position[];
  pendingTransactions:      Transaction[];
  drawdownBaseline:         number;
  circuitBreakerActive:     boolean;
  emergencyShutdown:        boolean;
  savedAt:                  number;
  checksum:                 string;
  competitionRegistration:  CompetitionRegistration | null;
}
```

- [ ] **Step 2.4: Update StateManager Zod schema**

In `src/state/StateManager.ts`, find `SystemStateSchema`:

Old:
```typescript
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
```

New:
```typescript
const CompetitionRegistrationSchema = z.object({
  walletAddress: z.string(),
  txHash:        z.string(),
  timestamp:     z.number(),
  confirmed:     z.boolean(),
});

const SystemStateSchema: z.ZodType<SystemState> = z.object({
  version:                 z.string(),
  openPositions:           z.array(PositionSchema),
  pendingTransactions:     z.array(TransactionSchema),
  drawdownBaseline:        z.number(),
  circuitBreakerActive:    z.boolean(),
  emergencyShutdown:       z.boolean(),
  savedAt:                 z.number(),
  checksum:                z.string(),
  competitionRegistration: CompetitionRegistrationSchema.nullable().default(null),
});
```

Also update `emptyState()` to include the new field:

Old:
```typescript
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
```

New:
```typescript
  emptyState(): SystemState {
    const blank: Omit<SystemState, 'checksum'> = {
      version:                 '2.0.0',
      openPositions:           [],
      pendingTransactions:     [],
      drawdownBaseline:        0,
      circuitBreakerActive:    false,
      emergencyShutdown:       false,
      savedAt:                 Date.now(),
      competitionRegistration: null,
    };
    const checksum = this.computeChecksum(blank);
    return { ...blank, checksum };
  }
```

- [ ] **Step 2.5: Create state migration v2_to_v3.ts**

Create `src/state/migrations/v2_to_v3.ts`:

```typescript
import type { SystemState } from '../../types/index';

export function migrate(state: unknown): SystemState {
  const s = state as Record<string, unknown>;
  return {
    ...(s as SystemState),
    version:                 '2.0.0',
    competitionRegistration: (s['competitionRegistration'] as SystemState['competitionRegistration']) ?? null,
  };
}
```

- [ ] **Step 2.6: Create RegistrationService.ts**

Create directory and file `src/registration/RegistrationService.ts`:

```typescript
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
```

- [ ] **Step 2.7: Create register.ts CLI entrypoint**

Create `src/register.ts`:

```typescript
import { ConfigurationService } from './config/index';
import { EventBus }             from './events/EventBus';
import { StateManager }         from './state/StateManager';
import { RegistrationService }  from './registration/RegistrationService';
import { makeLogger }           from './utils/logger';

const logger = makeLogger();

async function main(): Promise<void> {
  const configSvc = new ConfigurationService();
  const cfgResult = configSvc.load();
  if (!cfgResult.ok) {
    logger.error('Configuration failed', { error: cfgResult.error.message });
    process.exit(1);
  }

  const bus      = new EventBus();
  const stateMgr = new StateManager(configSvc, bus);
  const regSvc   = new RegistrationService(configSvc, bus);

  const stateResult = await stateMgr.loadState();
  if (!stateResult.ok) {
    logger.error('Failed to load state', { error: stateResult.error.message });
    process.exit(1);
  }

  const state = stateResult.value;
  if (state.competitionRegistration?.confirmed) {
    logger.info('Already registered', state.competitionRegistration);
    process.exit(0);
  }

  const result = await regSvc.register();
  if (!result.ok) {
    logger.error('Registration failed', { error: result.error.message });
    process.exit(1);
  }

  const updated = {
    ...state,
    competitionRegistration: result.value,
  };
  await stateMgr.saveState(updated);

  logger.info('Registration saved to state. Verify the tx on-chain, then set confirmed:true manually or re-run after confirmation.');
  logger.info('Registration details:', result.value);
}

main().catch((e: unknown) => {
  makeLogger().error('Register entrypoint failed', { error: String(e) });
  process.exit(1);
});
```

- [ ] **Step 2.8: Update package.json to add register script**

In `package.json`, add `"register"` to the `"scripts"` block:

Old scripts block:
```json
  "scripts": {
    "build": "tsc",
    "start": "node -r dotenv/config dist/index.js",
    "dev": "ts-node -r dotenv/config src/index.ts",
    "test": "jest",
    "test:coverage": "jest --coverage",
    "typecheck": "tsc --noEmit"
  },
```

New:
```json
  "scripts": {
    "build": "tsc",
    "start": "node -r dotenv/config dist/index.js",
    "dev": "ts-node -r dotenv/config src/index.ts",
    "register": "ts-node -r dotenv/config src/register.ts",
    "test": "jest",
    "test:coverage": "jest --coverage",
    "typecheck": "tsc --noEmit"
  },
```

- [ ] **Step 2.9: Add startup gate to src/index.ts**

In `src/index.ts`, add the import near the top (after the existing imports):

```typescript
import { registrationGate } from './registration/RegistrationService';
```

Then in `bootstrap()`, find step `[3] State` section (around line 59–62). After `let currentState` is assigned, add the gate call:

After:
```typescript
  let currentState: SystemState = stateResult.ok ? stateResult.value : stateMgr.emptyState();
```

Add:
```typescript
  // Hard gate: refuse to start in mainnet mode without a confirmed registration
  registrationGate(cfg.network.mode, currentState);
```

- [ ] **Step 2.10: Run typecheck**

```bash
cd /Users/silas/Blockout && npm run typecheck 2>&1 | tail -30
```

Fix any errors before proceeding.

- [ ] **Step 2.11: Run the registration tests**

```bash
cd /Users/silas/Blockout && npx jest src/__tests__/registration.test.ts --no-coverage 2>&1 | tail -30
```

Expected: all registration tests pass.

- [ ] **Step 2.12: Run full test suite**

```bash
cd /Users/silas/Blockout && npm test 2>&1 | tail -40
```

Expected: all tests pass.

- [ ] **Step 2.13: Commit**

```bash
cd /Users/silas/Blockout
git add src/types/index.ts src/state/StateManager.ts src/state/migrations/v2_to_v3.ts \
        src/registration/RegistrationService.ts src/register.ts src/index.ts \
        src/__tests__/registration.test.ts package.json
git commit -m "feat: add competition registration gate and npm run register entrypoint"
```

---

## Task 3: BNB Agent SDK — honest assessment

**Finding:** `@bnb-chain/bnbagent-sdk` is not on npm (404). The package targets ERC-8004 identity + APEX agent commerce — agent discoverability and intent-based commerce, not trading execution or competition scoring. There is no evidence this integration adds judged hackathon value for a trading-competition track. **Recommendation: remove the aspirational claim from README and update the stub comment.**

**Files:**
- Modify: `src/execution/BNBAgentAdapter.ts`
- Modify: `README.md`

- [ ] **Step 3.1: Update BNBAgentAdapter.ts**

Replace the entire contents of `src/execution/BNBAgentAdapter.ts`:

```typescript
/**
 * BNB AI Agent SDK Adapter
 *
 * Assessment (2026-06-18): @bnb-chain/bnbagent-sdk is not published on npm
 * (verified: npm view @bnb-chain/bnbagent-sdk → 404). The package targets
 * ERC-8004 identity registration and APEX agent commerce — agent
 * discoverability and intent-based swaps — not trading-competition execution
 * or scoring criteria.
 *
 * Decision: integration is not implemented. It does not add judged value
 * for this track and the SDK is unavailable. The README no longer claims
 * this integration as planned.
 *
 * If the SDK becomes available and the competition scoring criteria change
 * to reward ERC-8004 identity registration, re-evaluate at that point.
 */
export {};
```

- [ ] **Step 3.2: Update BNB Agent SDK section in README.md**

Find the BNB AI Agent SDK section in `README.md` and replace it with:

> **BNB AI Agent SDK**
>
> Not integrated. `@bnb-chain/bnbagent-sdk` is not published on npm (verified 2026-06-18). The package targets ERC-8004 identity registration and APEX agent commerce, not trading-competition execution or scoring. This is not a meaningful integration for this track.
>
> `src/execution/BNBAgentAdapter.ts` documents this decision.

- [ ] **Step 3.3: Typecheck and commit**

```bash
cd /Users/silas/Blockout && npm run typecheck 2>&1 | tail -10
git add src/execution/BNBAgentAdapter.ts README.md
git commit -m "docs: remove aspirational BNB Agent SDK claim — not on npm, wrong use-case for this track"
```

---

## Task 4: CMC Agent Hub vs raw Pro API

**Files:**
- Modify: `src/market/MarketDataService.ts`
- Modify: `README.md`

- [ ] **Step 4.1: Add Agent Hub detection to MarketDataService**

In `src/market/MarketDataService.ts`, add a method `detectAgentHubAccess()` that tests whether the configured API key has Agent Hub access, and call it during `start()`. Add after the `stop()` method:

```typescript
  private async detectAgentHubAccess(): Promise<void> {
    const cfg = this.config.get();
    try {
      await this.http.get('/v4/agent/market-insights', {
        headers: { 'X-CMC_PRO_API_KEY': cfg.cmcApiKey },
        params:  { limit: 1 },
      });
      logger.info('CMC Agent Hub access confirmed — /v4/agent/market-insights available');
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if (status === 401 || status === 403) {
        logger.info('CMC Agent Hub not available on current API key tier — using raw Pro API');
      } else {
        logger.debug('CMC Agent Hub probe inconclusive', { status, error: String(e) });
      }
    }
  }
```

In the `start()` method, add a call at the beginning (after the opening brace, before the first-pair verification):

```typescript
    void this.detectAgentHubAccess();
```

- [ ] **Step 4.2: Update README CMC section**

Find the CMC section in `README.md` and replace it with accurate content:

> **CoinMarketCap**
>
> Uses the raw CMC Pro API (`https://pro-api.coinmarketcap.com`):
> - `/v2/cryptocurrency/quotes/latest` — spot price, market cap, volume
> - `/v2/cryptocurrency/ohlcv/historical` — OHLCV candles
> - `/v3/cryptocurrency/quotes/latest` with technical indicators — RSI, MACD, Bollinger Bands (falls back to neutral defaults if the API key tier does not include v3 indicator access; logged as a warning)
>
> At startup, `MarketDataService` probes `/v4/agent/market-insights` to detect CMC Agent Hub access and logs the result. If Agent Hub is available, the pre-computed regime/liquidity/risk signals can be used instead of the raw indicator computation in `SignalGenerator`. This is not yet wired — the probe is informational only.
>
> Pre-computed signals from Agent Hub would replace or supplement `SignalGenerator.ts`'s local indicator math. Evaluate once Agent Hub access is confirmed on the competition API key.

- [ ] **Step 4.3: Typecheck, test, commit**

```bash
cd /Users/silas/Blockout && npm run typecheck 2>&1 | tail -10
npm test 2>&1 | tail -20
git add src/market/MarketDataService.ts README.md
git commit -m "feat: add CMC Agent Hub probe at startup; update README to describe actual API usage"
```

---

## Final Pass: README consistency check

- [ ] **Step 5.1: Read through README.md end to end**

Check every integration claim against the code:
- TWAK: must say "CLI subprocess wrapper, fails loudly if twak not on PATH" ✓
- BNB Agent SDK: must say "not integrated, not on npm" ✓
- CMC: must say "raw Pro API + informational Agent Hub probe" ✓
- Competition registration: must mention `npm run register` and the startup gate ✓

- [ ] **Step 5.2: Run final full test suite and typecheck**

```bash
cd /Users/silas/Blockout && npm run typecheck && npm test
```

Expected: zero errors, all tests pass.

- [ ] **Step 5.3: Final commit**

```bash
cd /Users/silas/Blockout
git add README.md
git commit -m "docs: final README consistency pass — all integration claims match actual code"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Task/Step |
|-----------------|-----------|
| Verify TWAK availability before coding | Step 1.1 preamble / Findings section |
| TWAKAdapter.sign/broadcast/balance | Steps 1.3 (sign, getBalance; broadcast delegated to ethers provider) |
| Degrade-gracefully: fail loudly, no silent fallback | Steps 1.3, 1.5 (initialize throws, health:critical emitted) |
| Update ExecutionService to use TWAKAdapter | Step 1.5 |
| Nonce-lock preserved | Step 1.5 sendRawTx replacement |
| Tests: sign() called for every order, refuse if TWAK init fails | Step 1.1 twak.test.ts |
| README TWAK section updated | Steps 1.9–1.10 |
| Registration to 0x212c... on BSC | Step 2.6 RegistrationService.ts |
| competitionRegistration in state | Steps 2.3–2.5 |
| Startup hard gate on mainnet | Step 2.9 |
| npm run register entrypoint | Steps 2.7–2.8 |
| Test: agent refuses to start in live mode without confirmed registration | Step 2.1 registrationGate tests |
| BNB Agent SDK: assess honestly, don't conflate with Task 2 | Steps 3.1–3.2 |
| CMC Agent Hub vs raw Pro API check | Steps 4.1–4.2 |
| Don't delete any risk control | No risk files touched |
| npm test + typecheck after each task | Steps 1.7, 2.10, 2.12, 3.3, 4.3 |
| Final README pass | Steps 5.1–5.3 |

### Placeholder check

No TBD, TODO, or vague steps. Every step includes exact commands or complete code.

### Type consistency

- `CompetitionRegistration` defined in `types/index.ts` → used identically in `StateManager.ts` (Zod schema), `RegistrationService.ts` (return type), and `registration.test.ts` (test assertions).
- `registrationGate` exported from `RegistrationService.ts` → imported in both `index.ts` and `registration.test.ts` under the same path `'../registration/RegistrationService'`.
- `TWAKAdapter.sign()` takes `string`, returns `Promise<string>` → `sendRawTx` in `ExecutionService` passes `unsignedTx.unsignedSerialized` (string) and receives signed hex (string).
- `SystemState.competitionRegistration: CompetitionRegistration | null` matches the Zod `.nullable().default(null)` in `SystemStateSchema`.
