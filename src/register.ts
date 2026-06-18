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

  const updated = { ...state, competitionRegistration: result.value };
  await stateMgr.saveState(updated);

  logger.info(
    'Registration submitted and saved to state. ' +
    'Verify the tx on-chain, then set confirmed:true in state or re-run after on-chain confirmation is implemented.',
  );
  logger.info('Registration details:', result.value);
}

main().catch((e: unknown) => {
  makeLogger().error('Register entrypoint failed', { error: String(e) });
  process.exit(1);
});
