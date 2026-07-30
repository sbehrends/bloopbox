/**
 * Process 1 — hardware and web server daemon.
 *
 * Phase 1: boots Express, serves the built UIs, and exposes a placeholder /api/status
 * so the shell is runnable end to end. Phases 2a–2d add the config manager, HAL, LED
 * state machine, audio pipeline, and Socket.io wiring.
 */
import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { childLogger } from '../logger.ts';

const log = childLogger('hardware');

const PORT = Number(process.env['PORT'] ?? 3000);
const SIMULATOR_MODE = process.env['SIMULATOR_MODE'] === 'true';

/** Built UI assets. Absent until `npm run build:web`; in dev use `npm run dev:web`. */
const STATIC_ROOT = resolve(import.meta.dirname, '../../dist/public');

function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/api/status', (_req, res) => {
    // Placeholder shape — replaced by the real device state machine in Phase 2a.
    res.json({
      state: 'BOOTING',
      silentMode: false,
      whatsappConnected: false,
      simulator: SIMULATOR_MODE,
    });
  });

  if (existsSync(STATIC_ROOT)) {
    app.use(express.static(STATIC_ROOT));
  } else {
    log.warn(
      { staticRoot: STATIC_ROOT },
      'built UI not found — run `npm run build:web`, or `npm run dev:web` for the Vite dev server on :5174',
    );
  }

  return app;
}

function main(): void {
  const app = createApp();

  const server = app.listen(PORT, () => {
    log.info({ port: PORT, simulator: SIMULATOR_MODE }, 'hardware server listening');
    if (!SIMULATOR_MODE) {
      log.warn('SIMULATOR_MODE is not set — the GPIO driver is unverified on real hardware');
    }
  });

  // The Pi loses power without warning; on a clean signal at least close sockets.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info({ signal }, 'shutting down');
      server.close(() => process.exit(0));
    });
  }
}

main();
