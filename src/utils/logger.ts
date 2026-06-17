import { createLogger, transports, format } from 'winston';
import type { Logger } from 'winston';

/**
 * Shared logger factory.
 * All module-level loggers should use this so LOG_LEVEL env var is respected.
 * Winston loggers read the level at creation time from the environment.
 */
const RESOLVED_LOG_LEVEL = (process.env['LOG_LEVEL'] ?? 'info') as string;

export function makeLogger(): Logger {
  return createLogger({
    level:      RESOLVED_LOG_LEVEL,
    format:     format.combine(format.timestamp(), format.json()),
    transports: [new transports.Console()],
  });
}
