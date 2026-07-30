/**
 * Development supervisor for the hardware server.
 *
 * Saving config makes the daemon exit so it comes back with the new values. On the device
 * systemd handles that (`Restart=always`); in development nothing would, and `tsx watch` does
 * not restart a process that exits cleanly — so this stands in.
 *
 * Deliberately tiny and dependency-free: it exists only so the dev loop exercises the same
 * restart path the real device uses, rather than a special live-reload path that production
 * never runs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const ENTRY = resolve(import.meta.dirname, '../src/processes/hardware-server.ts');

/** Pause before respawning, so a crash loop cannot saturate the terminal. */
const RESTART_DELAY_MS = 300;

/** More failures than this in a row and something is genuinely broken. */
const MAX_CONSECUTIVE_FAILURES = 5;

let child: ChildProcess | null = null;
let consecutiveFailures = 0;
let stopping = false;

function start(): void {
  child = spawn('node', ['--import', 'tsx', ENTRY], {
    stdio: 'inherit',
    env: { ...process.env, SIMULATOR_MODE: process.env['SIMULATOR_MODE'] ?? 'true' },
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;

    if (signal !== null) {
      console.log(`\n[dev] server killed by ${signal}; not restarting`);
      process.exit(0);
    }

    if (code === 0) {
      // The expected path: an intentional restart after a config write.
      consecutiveFailures = 0;
      console.log('\n[dev] server exited cleanly (config change) — restarting\n');
    } else {
      consecutiveFailures += 1;
      console.error(`\n[dev] server exited with code ${String(code)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`[dev] ${MAX_CONSECUTIVE_FAILURES} failures in a row — giving up\n`);
        process.exit(1);
      }
      console.error(
        `[dev] restarting (${String(consecutiveFailures)}/${MAX_CONSECUTIVE_FAILURES})\n`,
      );
    }

    setTimeout(start, RESTART_DELAY_MS);
  });

  child.on('error', (error) => {
    console.error('[dev] failed to spawn server:', error.message);
    process.exit(1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
    // Give it a moment to release the port before we go.
    setTimeout(() => process.exit(0), 500).unref();
  });
}

console.log('[dev] supervising hardware server (restarts on config change)\n');
start();
