/**
 * CompetitionRegistrar
 *
 * Registers the agent wallet with the BNB Hack AI Trading competition contract
 * on BSC Testnet. Registration is required for Track 1 (Autonomous Trading Agents)
 * to be included in the live PnL leaderboard.
 *
 * Contract: 0x212c61b9b72c95d95bf29cf032f5e5635629aed5 (BSC Testnet)
 * Source: https://dorahacks.io/hackathon/bnbhack-twt-cmc/detail
 *
 * Registration is idempotent — re-registering the same wallet is a no-op
 * on-chain, so it's safe to call on every startup.
 */

import { ethers } from 'ethers';
import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';

const logger = makeLogger();

// Competition contract ABI — minimal surface needed for registration
// The contract exposes a `register(address agentWallet)` function that records
// the participant. If the registration deadline has passed, the call reverts.
const COMPETITION_ABI = [
  'function register(address agentWallet) external',
  'function isRegistered(address agentWallet) external view returns (bool)',
];

// Deployed on BSC Testnet
const COMPETITION_CONTRACT = '0x212c61b9b72c95d95bf29cf032f5e5635629aed5';

export class CompetitionRegistrar {
  private readonly config: ConfigurationService;

  constructor(config: ConfigurationService) {
    this.config = config;
  }

  /**
   * Attempt to register the agent wallet with the competition contract.
   * - Skips if already registered (checks on-chain before submitting).
   * - Skips if network is mainnet (competition is testnet only).
   * - Logs and continues on failure — registration failure should not halt the agent.
   */
  async register(
    wallet:   ethers.Wallet,
    provider: ethers.JsonRpcProvider,
  ): Promise<void> {
    const cfg = this.config.get();

    // Competition only applies to testnet
    if (cfg.network.mode !== 'testnet') {
      logger.debug('CompetitionRegistrar: skipping on mainnet');
      return;
    }

    try {
      const contract = new ethers.Contract(COMPETITION_CONTRACT, COMPETITION_ABI, provider);

      // Check if already registered to avoid wasting gas
      let alreadyRegistered = false;
      try {
        alreadyRegistered = await contract.getFunction('isRegistered')(wallet.address) as boolean;
      } catch {
        // isRegistered may not exist on all contract versions — proceed anyway
      }

      if (alreadyRegistered) {
        logger.info('Competition registration: already registered', {
          contract: COMPETITION_CONTRACT,
          wallet:   wallet.address,
        });
        return;
      }

      // Estimate gas for registration tx
      const gasPrice = ethers.parseUnits('5', 'gwei');
      const signer   = wallet.connect(provider);

      logger.info('Registering agent wallet with competition contract…', {
        contract: COMPETITION_CONTRACT,
        wallet:   wallet.address,
      });

      const tx = await signer.sendTransaction({
        to:       COMPETITION_CONTRACT,
        data:     new ethers.Interface(COMPETITION_ABI).encodeFunctionData('register', [wallet.address]),
        gasPrice,
        gasLimit: 150_000,
      });

      logger.info('Competition registration tx submitted', {
        txHash:   tx.hash,
        wallet:   wallet.address,
        contract: COMPETITION_CONTRACT,
      });

      // Wait for confirmation (up to 30s)
      const receipt = await Promise.race([
        tx.wait(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 30_000)),
      ]);

      if (receipt && 'status' in receipt && receipt.status === 1) {
        logger.info('✅ Competition registration confirmed on-chain', {
          txHash:  tx.hash,
          block:   receipt.blockNumber,
          wallet:  wallet.address,
        });
      } else if (receipt) {
        logger.warn('Competition registration tx may have failed (status != 1)', { txHash: tx.hash });
      } else {
        logger.warn('Competition registration tx submitted but confirmation timed out — may still confirm', {
          txHash: tx.hash,
        });
      }
    } catch (e) {
      // Deadline passed, insufficient funds, or other error — log and continue.
      // A registration failure must not prevent the agent from starting up and trading.
      const errMsg = String(e);
      if (errMsg.includes('deadline') || errMsg.includes('registration failed')) {
        logger.warn('Competition registration: deadline has passed — agent will trade but may not appear on leaderboard', {
          error: errMsg,
        });
      } else if (errMsg.includes('insufficient') || errMsg.includes('funds')) {
        logger.warn('Competition registration: insufficient tBNB for gas — fund wallet and restart to register', {
          wallet: wallet.address,
          error:  errMsg,
        });
      } else {
        logger.warn('Competition registration failed (non-fatal) — agent continues', { error: errMsg });
      }
    }
  }
}
