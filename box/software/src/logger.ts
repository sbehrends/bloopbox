import pino from 'pino';
import { RecentEvents } from './system/recentEvents.ts';

const isDevelopment = process.env['NODE_ENV'] !== 'production';

/**
 * Shared structured logger. Both daemons tag their lines with a `proc` field so a
 * single `journalctl` stream on the Pi stays readable.
 *
 * Pretty-printed in development; plain JSON in production, where systemd captures it.
 */
/**
 * Every warning and error this process logs, also kept in memory for the admin panel's health card
 * (`system/recentEvents.ts`). Only the hardware server serves it; the bridge's simply fills.
 */
export const recentEvents = new RecentEvents();

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? (isDevelopment ? 'debug' : 'info'),
  hooks: {
    // Inherited by every child logger, so one hook sees every line with its `proc` and `mod`.
    logMethod(args, method, level) {
      recentEvents.record(level, args, this.bindings());
      method.apply(this, args);
    },
  },
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

/** Child logger for a named process or subsystem. */
export function childLogger(name: string): pino.Logger {
  return logger.child({ proc: name });
}
