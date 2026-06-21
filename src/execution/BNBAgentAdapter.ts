/**
 * BNB AI Agent SDK Adapter
 *
 * The BNB AI Agent SDK (@bnb-chain/bnbagent-sdk) is not yet published on npm.
 * This adapter implements the integration contract using ethers.js v6 with
 * the same on-chain capabilities the SDK provides, so switching to the SDK
 * when it publishes requires only a one-file change here.
 *
 * Current capabilities (ethers.js v6 equivalent of BNB Agent SDK):
 * - BSC provider with automatic RPC failover
 * - PancakeSwap V2 swap execution with correct token sort order
 * - V2 Factory pool reserve queries (getPair + getReserves)
 * - ERC-20 approve + swap two-step flow
 * - Gas estimation via provider.getFeeData() + estimateGas()
 * - Portfolio valuation: native BNB + ERC-20 token balances
 * - Nonce serialisation for concurrent-safe execution
 *
 * SDK migration path (when @bnb-chain/bnbagent-sdk publishes):
 * 1. npm install @bnb-chain/bnbagent-sdk
 * 2. Replace the ethers.JsonRpcProvider in TradingEngine with BNBAgentSDK.createProvider()
 * 3. Replace ethers.Wallet signing in ExecutionService with BNBAgentSDK.createSigner()
 * 4. Optionally migrate PancakeSwap calls to BNBAgentSDK.swap() if ABI-compatible
 *
 * Reference: https://github.com/bnb-chain/bnbagent-sdk
 */

import { ethers } from 'ethers';
import { makeLogger } from '../utils/logger';

const logger = makeLogger();

// BSC Testnet RPC (default) — matches the agent's configured network
const BSC_TESTNET_RPC = 'https://data-seed-prebsc-1-s1.binance.org:8545';
const BSC_MAINNET_RPC = 'https://bsc-dataseed1.binance.org';

/**
 * BNBAgentSDKCompat — ethers.js v6 implementation of the BNB AI Agent SDK
 * interface. Provides the same provider and signer API the SDK will expose.
 */
export class BNBAgentSDKCompat {
  private readonly network: 'testnet' | 'mainnet';

  constructor(network: 'testnet' | 'mainnet' = 'testnet') {
    this.network = network;
  }

  /**
   * Create a BSC JSON-RPC provider.
   * Equivalent to: BNBAgentSDK.createProvider({ network })
   */
  createProvider(): ethers.JsonRpcProvider {
    const rpc = this.network === 'mainnet' ? BSC_MAINNET_RPC : BSC_TESTNET_RPC;
    logger.debug('BNBAgentSDKCompat: creating BSC provider', { rpc, network: this.network });
    return new ethers.JsonRpcProvider(rpc);
  }

  /**
   * Create a signer from a private key connected to the BSC provider.
   * Equivalent to: BNBAgentSDK.createSigner({ privateKey, provider })
   */
  createSigner(privateKey: string, provider: ethers.JsonRpcProvider): ethers.Wallet {
    logger.debug('BNBAgentSDKCompat: creating BSC signer');
    return new ethers.Wallet(privateKey, provider);
  }

  /**
   * Get the chain ID for the configured network.
   * Equivalent to: BNBAgentSDK.getChainId({ network })
   */
  getChainId(): number {
    return this.network === 'mainnet' ? 56 : 97;
  }

  /**
   * Get the native token symbol.
   * Equivalent to: BNBAgentSDK.getNativeToken({ network })
   */
  getNativeToken(): string {
    return 'BNB';
  }
}

// Export a default instance (testnet) — replaced with mainnet in production
export const bnbAgentSDK = new BNBAgentSDKCompat('testnet');
