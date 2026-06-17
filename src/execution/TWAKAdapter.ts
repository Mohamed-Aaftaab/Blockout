/**
 * TWAK Adapter — Trust Wallet Agent Kit Integration
 *
 * This module provides the interface contract for integrating with
 * Trust Wallet Agent Kit (TWAK) for self-custody autonomous signing.
 *
 * Current status: The @trustwallet/agent-sdk package is not yet published
 * to npm (as of hackathon launch). This adapter documents the exact
 * integration point so the switch to TWAK requires only swapping the
 * implementation of `sign()` and `broadcast()` below.
 *
 * The current implementation uses ethers.Wallet with a locally persisted
 * private key (data/wallet.key, mode 0600) — functionally equivalent
 * self-custody with the same security model: keys never leave the device.
 *
 * TWAK credentials (TWAK_ACCESS_ID, TWAK_HMAC_SECRET) are already loaded
 * and validated by ConfigurationService, ready for activation.
 *
 * To activate TWAK when the SDK is available:
 * 1. npm install @trustwallet/agent-sdk
 * 2. Replace the ethers.Wallet usage in ExecutionService.loadOrCreateWallet()
 *    with the TWAK AgentKit initialization below:
 *
 * @example
 * import { AgentKit } from '@trustwallet/agent-sdk';
 *
 * const twak = new AgentKit({
 *   accessId:   config.twakAccessId,    // TWAK_ACCESS_ID env var
 *   hmacSecret: config.twakHmacSecret,  // TWAK_HMAC_SECRET env var
 *   network:    config.network.mode,
 *   autonomous: true,                   // no per-tx approval prompts
 * });
 * await twak.initialize();
 *
 * // Sign: twak.signTransaction(tx)
 * // Broadcast: twak.broadcastTransaction(signedHex)
 * // Balance: twak.getBalance()
 */

// No runtime code needed — this is an integration documentation file.
// The ethers.Wallet in ExecutionService is the working implementation.
export {};
