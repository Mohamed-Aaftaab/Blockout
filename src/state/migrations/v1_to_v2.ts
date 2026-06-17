import type { SystemState } from '../../types/index';

/**
 * Migration stub: v1 → v2
 * Add new migrations here when the SystemState schema evolves.
 */
export function migrate(state: unknown): SystemState {
  // For now, assume the state is already compatible.
  // In production, add transformation logic here.
  return state as SystemState;
}
