/**
 * Preflight check for external prerequisites the daemons cannot supply themselves.
 * Run with `npm run doctor`. Exits non-zero if anything required is missing.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, release } from 'node:os';
import { ALL_AUDIO_CUES } from '../src/audio/cues.ts';
import { missingCues } from '../src/audio/soundFiles.ts';

const run = promisify(execFile);

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
};

const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg';

function checkNode(): CheckResult {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    name: 'Node.js >= 22',
    ok: major >= 22,
    detail: `found v${process.versions.node}`,
    required: true,
  };
}

async function checkFfmpeg(): Promise<CheckResult> {
  try {
    const { stdout } = await run(FFMPEG, ['-version']);
    const version = stdout.split('\n')[0] ?? 'unknown';
    return { name: 'ffmpeg on PATH', ok: true, detail: version, required: true };
  } catch {
    return {
      name: 'ffmpeg on PATH',
      ok: false,
      detail: `not found (tried "${FFMPEG}") — brew install ffmpeg / apt install ffmpeg, or set FFMPEG_PATH`,
      required: true,
    };
  }
}

async function checkOpusEncoder(): Promise<CheckResult> {
  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-encoders']);
    const ok = stdout.includes('libopus') || stdout.includes(' opus ');
    return {
      name: 'ffmpeg Opus encoder',
      ok,
      detail: ok ? 'libopus available' : 'no Opus encoder — WhatsApp voice notes require Opus',
      required: true,
    };
  } catch {
    return {
      name: 'ffmpeg Opus encoder',
      ok: false,
      detail: 'skipped (ffmpeg missing)',
      required: true,
    };
  }
}

/** ALSA only exists on Linux. On macOS the simulator driver uses browser audio instead. */
async function checkAlsa(): Promise<CheckResult> {
  if (platform() !== 'linux') {
    return {
      name: 'ALSA capture device',
      ok: true,
      detail: `skipped on ${platform()} — simulator driver uses browser audio`,
      required: false,
    };
  }
  try {
    const { stdout } = await run('arecord', ['-l']);
    const ok = stdout.includes('card');
    return {
      name: 'ALSA capture device',
      ok,
      detail: ok
        ? 'capture device present'
        : 'no capture device found — is the USB mic plugged in?',
      required: true,
    };
  } catch {
    return {
      name: 'ALSA capture device',
      ok: false,
      detail: 'arecord not found — apt install alsa-utils',
      required: true,
    };
  }
}

/** Cue WAVs are generated, not committed, so a fresh clone has none. */
function checkCueFiles(): CheckResult {
  const missing = missingCues();
  return {
    name: 'audio cue files',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `all ${ALL_AUDIO_CUES.length} cues present`
        : `missing ${missing.join(', ')} — run "npm run sounds"`,
    required: true,
  };
}

async function main(): Promise<void> {
  console.log(`bloopbox doctor — ${platform()} ${release()}\n`);

  const results: CheckResult[] = [
    checkNode(),
    ...(await Promise.all([checkFfmpeg(), checkOpusEncoder(), checkAlsa()])),
    checkCueFiles(),
  ];

  for (const r of results) {
    const mark = r.ok ? '✓' : r.required ? '✗' : '–';
    console.log(`  ${mark} ${r.name.padEnd(24)} ${r.detail}`);
  }

  const failures = results.filter((r) => !r.ok && r.required);
  if (failures.length > 0) {
    console.error(`\n${failures.length} required check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll required checks passed.');
}

await main();
