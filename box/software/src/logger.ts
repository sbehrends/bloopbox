import pino from 'pino';

const isDevelopment = process.env['NODE_ENV'] !== 'production';

/**
 * Shared structured logger. Both daemons tag their lines with a `proc` field so a
 * single `journalctl` stream on the Pi stays readable.
 *
 * Pretty-printed in development; plain JSON in production, where systemd captures it.
 */
export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? (isDevelopment ? 'debug' : 'info'),
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
