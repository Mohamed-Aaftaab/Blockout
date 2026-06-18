import { RegistrationService, registrationGate } from '../registration/RegistrationService';
import { execFile } from 'node:child_process';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type { SystemState } from '../types/index';

jest.mock('node:child_process');

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

// Sequence mocking: first call → status, subsequent calls → register output
function mockSequence(outputs: string[]): void {
  let i = 0;
  mockExecFile.mockImplementation(
    (_f: string, _a: string[], _opts: unknown, cb: (...args: unknown[]) => void) =>
      cb(null, outputs[i++] ?? '', ''),
  );
}

function mockFailure(msg: string): void {
  mockExecFile.mockImplementation(
    (_f: string, _a: string[], _opts: unknown, cb: (...args: unknown[]) => void) =>
      cb(new Error(msg), '', ''),
  );
}

function buildSvc() {
  const mockConfig = {
    get: jest.fn().mockReturnValue({
      network:            { mode: 'testnet' },
      twakWalletPassword: 'test-password',
    }),
  } as unknown as ConfigurationService;
  const mockBus = { emit: jest.fn() } as unknown as EventBus;
  return new RegistrationService(mockConfig, mockBus);
}

// ─── RegistrationService tests ────────────────────────────────────────────────

describe('RegistrationService.register', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns ok with txHash and participant on success', async () => {
    // status → not registered; register → success
    mockSequence([
      '{"registered":false,"participant":"0xMyWallet","open":true,"opensAt":"2026-06-01T00:00:00.000Z","deadline":"2026-06-25T00:00:00.000Z","secondsRemaining":100000,"chain":"bsc"}',
      '{"txHash":"0xRegTx","participant":"0xMyWallet","chain":"bsc"}',
    ]);
    const result = await buildSvc().register();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.txHash).toBe('0xRegTx');
      expect(result.value.walletAddress).toBe('0xMyWallet');
      expect(result.value.confirmed).toBe(false);
      expect(typeof result.value.timestamp).toBe('number');
    }
  });

  it('skips registration and returns confirmed when already registered on-chain', async () => {
    mockSequence([
      '{"registered":true,"participant":"0xMyWallet","txHash":"0xExistingTx","open":true,"opensAt":"2026-06-01T00:00:00.000Z","deadline":"2026-06-25T00:00:00.000Z","secondsRemaining":100000,"chain":"bsc"}',
    ]);
    const result = await buildSvc().register();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.confirmed).toBe(true);
      expect(result.value.txHash).toBe('0xExistingTx');
    }
    // Should only call status, not register
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('returns err when twak compete register subprocess fails', async () => {
    mockFailure('registration failed: deadline passed');
    const result = await buildSvc().register();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('registration failed');
    }
  });

  it('calls twak compete register with --json and --password flags', async () => {
    mockSequence([
      '{"registered":false,"participant":"0xW","open":true,"opensAt":"2026-06-01T00:00:00.000Z","deadline":"2026-06-25T00:00:00.000Z","secondsRemaining":100000,"chain":"bsc"}',
      '{"txHash":"0xTx","participant":"0xW","chain":"bsc"}',
    ]);
    await buildSvc().register();
    expect(mockExecFile).toHaveBeenCalledWith(
      'twak',
      expect.arrayContaining(['compete', 'register', '--json']),
      expect.any(Object),
      expect.any(Function),
    );
  });
});

// ─── registrationGate tests ───────────────────────────────────────────────────

function stateWith(reg: SystemState['competitionRegistration']): SystemState {
  return {
    version:                 '3.0.0',
    openPositions:           [],
    pendingTransactions:     [],
    drawdownBaseline:        0,
    circuitBreakerActive:    false,
    emergencyShutdown:       false,
    savedAt:                 Date.now(),
    checksum:                '',
    competitionRegistration: reg,
    dailyTrades:             {},
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
    expect(() => registrationGate('mainnet', stateWith(null))).toThrow(/npm run register/);
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
