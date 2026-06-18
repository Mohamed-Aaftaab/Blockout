import type { SystemState } from '../../types/index';

export function migrate(state: unknown): SystemState {
  const s = state as Record<string, unknown>;
  return {
    ...(s as unknown as SystemState),
    version:                 '2.0.0',
    competitionRegistration: (s['competitionRegistration'] as SystemState['competitionRegistration']) ?? null,
  };
}
