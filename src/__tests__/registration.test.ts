import { RegistrationService, registrationGate } from '../registration/RegistrationService';
import { execFile } from 'node:child_process';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type { SystemState } from '../types/index';

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
    get: jest.fn().mockReturnValue({ network: { mode: 'testnet' } }),
  } as unknown as ConfigurationService;
  const mockBus = { emit: jest.fn() } as unknown as EventBus;
  return new RegistrationService(mockConfig, mockBus);
}

// ─── RegistrationService tests ────────────────────────────────────────────────

describe('RegistrationService.register', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns ok with txHash and walletAddress on success', async () => {
    mockSuccess('{"txHash":"0xRegTx","walletAddress":"0xMyWallet"}\n');
    const result = await buildSvc().register();
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
    const result = await buildSvc().register();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('registration failed');
    }
  });

  it('calls twak with the correct competition contract address', async () => {
    mockSuccess('{"txHash":"0xTx","walletAddress":"0xW"}\n');
    await buildSvc().register();
    expect(mockExecFile).toHaveBeenCalledWith(
      'twak',
      expect.arrayContaining(['compete', 'register', '--contract', '0x212c61b9b72c95d95bf29cf032f5e5635629aed5']),
      expect.any(Function),
    );
  });
});

// ─── registrationGate tests ───────────────────────────────────────────────────

function stateWith(reg: SystemState['competitionRegistration']): SystemState {
  return {
    version:                 '2.0.0',
    openPositions:           [],
    pendingTransactions:     [],
    drawdownBaseline:        0,
    circuitBreakerActive:    false,
    emergencyShutdown:       false,
    savedAt:                 Date.now(),
    checksum:                '',
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
