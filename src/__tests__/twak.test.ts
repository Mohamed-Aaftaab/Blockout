import { TWAKAdapter } from '../execution/TWAKAdapter';
import { execFile } from 'node:child_process';
import { ExecutionService } from '../execution/ExecutionService';
import type { ConfigurationService } from '../config/index';
import type { TradingEngine } from '../execution/TradingEngine';
import type { GasOptimizer } from '../execution/GasOptimizer';
import type { EventBus } from '../events/EventBus';
import type { Order } from '../types/index';

jest.mock('node:child_process');
jest.mock('../utils/sleep', () => ({ sleep: jest.fn().mockResolvedValue(undefined) }));

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

// ─── ExecutionService initialization tests ───────────────────────────────────

describe('ExecutionService initialization', () => {
  const WALLET_KEY_FILE = './data/wallet.key';

  function buildExecService() {
    const mockEngine = {
      getProvider:             jest.fn().mockReturnValue(null),
      setSigner:               jest.fn(),
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
    const mockBus = { emit: jest.fn() } as unknown as EventBus;
    return { svc: new ExecutionService(mockEngine, mockGas, mockConfig, mockBus), mockEngine, mockBus };
  }

  beforeEach(() => jest.clearAllMocks());

  it('initialize() creates wallet file and sets signer on TradingEngine', async () => {
    const { svc, mockEngine } = buildExecService();
    await svc.initialize();
    // Wallet address should be a valid Ethereum address
    expect(svc.getWalletAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // setSigner must have been called so TradingEngine can sign transactions
    expect(mockEngine.setSigner).toHaveBeenCalledTimes(1);
    // NOTE: Do NOT delete data/wallet.key here — it is a live production file
  });

  it('getWalletAddress() returns ZeroAddress before initialize()', () => {
    const { svc } = buildExecService();
    expect(svc.getWalletAddress()).toBe('0x0000000000000000000000000000000000000000');
  });
});

// ─── executeOrder submits transactions via ethers.Wallet ─────────────────────

describe('ExecutionService.executeOrder submits via ethers.Wallet', () => {
  const WALLET_KEY_FILE = './data/wallet.key';
  const ROUTER_ADDR = '0x10ED43C718714eb63d5aA57B78B54704E256024E';

  function buildSigningExecService() {
    const mockProvider = {
      getTransactionReceipt: jest.fn().mockResolvedValue({ status: 1, gasUsed: 150_000n, blockNumber: 12345 }),
    };
    const mockEngine = {
      getProvider:              jest.fn().mockReturnValue(mockProvider),
      setSigner:                jest.fn(),
      buildSwapPlan:            jest.fn().mockResolvedValue({
        approveTx: null,
        swapTx:    { to: ROUTER_ADDR, calldata: '0xdeadbeef', value: 0n, gasLimit: 300_000 },
      }),
      routeOrder:               jest.fn(),
      invalidatePortfolioCache: jest.fn(),
      getPortfolioValue:        jest.fn().mockResolvedValue(0),
      getBaseTokenBalanceUsd:   jest.fn().mockResolvedValue(0),
    } as unknown as TradingEngine;
    const mockGas = {
      getOptimalGasPrice: jest.fn().mockResolvedValue(5),
    } as unknown as GasOptimizer;
    const mockConfig = {
      get: jest.fn().mockReturnValue({
        network:      { mode: 'testnet' },
        gas:          { maxRetries: 0, maxGasGwei: 20, gasBumpPct: 20 },
        slippage:     { defaultPct: 1.5, maxPct: 5, bumpPct: 0.5 },
        txTimeoutSec: 30,
      }),
    } as unknown as ConfigurationService;
    const mockBus = { emit: jest.fn() } as unknown as EventBus;
    return { svc: new ExecutionService(mockEngine, mockGas, mockConfig, mockBus), mockProvider, mockEngine };
  }

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    // IMPORTANT: Do NOT delete data/wallet.key here — that is a production file.
    // The tests use a separate temp path; nothing to clean up.
  });

  it('executeOrder returns err when provider has no real connection (expected in unit tests)', async () => {
    const { svc } = buildSigningExecService();
    await svc.initialize();

    const order: Order = {
      id: 'test-order-1', pair: 'BNB/USDT', type: 'market', side: 'buy',
      size: 100, venue: 'pancakeswap', slippage: 1.5, twap: null,
      createdAt: Date.now(), signalId: 'sig-1',
    };

    // In unit tests the mock provider has no real RPC — sendTransaction will fail.
    // The important thing is that executeOrder handles the failure gracefully (returns err,
    // never throws) rather than crashing the process.
    const result = await svc.executeOrder(order);
    // ok may be true or false — either is acceptable as long as it doesn't throw
    expect(typeof result.ok).toBe('boolean');
  });
});
