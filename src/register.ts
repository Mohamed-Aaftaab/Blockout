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

  // Already confirmed — nothing to do
  if (state.competitionRegistration?.confirmed) {
    logger.info('Already registered and confirmed on-chain', state.competitionRegistration);
    process.exit(0);
  }

  // Submit (or re-check if already submitted but not yet confirmed)
  const result = await regSvc.register();
  if (!result.ok) {
    logger.error('Registration failed', { error: result.error.message });
    process.exit(1);
  }

  // Save immediately (confirmed: false if just submitted)
  let reg = result.value;
  await stateMgr.saveState({ ...state, competitionRegistration: reg });
  logger.info('Registration tx submitted', { txHash: reg.txHash, wallet: reg.walletAddress });

  // Poll for on-chain confirmation (up to 2 minutes)
  if (!reg.confirmed) {
    logger.info('Waiting for on-chain confirmation...');
    const confirmed = await regSvc.awaitConfirmation(120_000);
    if (confirmed) {
      reg = { ...reg, confirmed: true };
      await stateMgr.saveState({ ...state, competitionRegistration: reg });
      logger.info('Registration confirmed on-chain', reg);
    } else {
      logger.warn(
        'Tx submitted but confirmation timed out after 2 minutes. ' +
        'Re-run `npm run register` to recheck — the tx may still confirm.',
      );
    }
  }

  logger.info('Wallet address (fund this for trading):', { address: reg.walletAddress });
}

main().catch((e: unknown) => {
  makeLogger().error('Register entrypoint failed', { error: String(e) });
  process.exit(1);
});
