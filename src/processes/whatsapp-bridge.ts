/**
 * Process 2 — WhatsApp bridge daemon.
 *
 * Phase 1: placeholder that starts, reports itself, and idles. Phase 3 adds the Baileys
 * socket, multi-file auth in /data/auth_info, the contact whitelist, and the media
 * pipeline. It talks to Process 1 only over the Socket.io IPC contract in src/ipc/.
 *
 * This process never touches GPIO or audio devices.
 */
import { childLogger } from '../logger.ts';

const log = childLogger('whatsapp');

function main(): void {
  log.info('WhatsApp bridge starting');
  log.warn('Baileys integration lands in Phase 3 — this process is currently idle');

  // Hold the event loop open so systemd sees a long-running service rather than a
  // process that exits immediately and gets restarted in a loop.
  const keepAlive = setInterval(() => {
    log.debug('bridge idle');
  }, 60_000);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info({ signal }, 'shutting down');
      clearInterval(keepAlive);
      process.exit(0);
    });
  }
}

main();
