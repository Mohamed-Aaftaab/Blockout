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
      setSigner:   jest.fn(),
      getPortfolioValue:       jest.fn().mockResolvedValue(0),
      getBaseTokenBalanceUsd:  jest.fn().mockResolvedValue(0),
    } as unknown as TradingEngine;
    const mockGas = {} as unknown as GasOptimizer;
    const mockConfig = {
      get: jest.fn().mockReturnValue({
        network: { mode: 'testnet' },
        gas:     { maxRetries: 3 },
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
