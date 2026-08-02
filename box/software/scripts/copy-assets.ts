/**
 * Copies non-TypeScript runtime assets into `dist/`.
 *
 * `tsc` only emits JavaScript, so the generated cue WAVs would be missing from a built
 * device image and every audio cue would silently fail. This runs as part of `npm run
 * build`.
 */
import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ALL_AUDIO_CUES } from '../src/audio/cues.ts';
import { missingCues, SOUNDS_DIRECTORY } from '../src/audio/soundFiles.ts';

const DIST_SOUNDS = resolve(import.meta.dirname, '../dist/audio/sounds');

async function main(): Promise<void> {
  const absent = missingCues();
  if (absent.length > 0) {
    // Fail loudly: a build that ships without cues produces a mute device.
    console.error(
      `Cannot build: ${absent.length} of ${ALL_AUDIO_CUES.length} audio cues are missing ` +
        `(${absent.join(', ')}).\nRun \`npm run sounds\` first.`,
    );
    process.exitCode = 1;
    return;
  }

  await mkdir(DIST_SOUNDS, { recursive: true });
  await cp(SOUNDS_DIRECTORY, DIST_SOUNDS, { recursive: true });
  console.log(`Copied ${ALL_AUDIO_CUES.length} audio cues to ${DIST_SOUNDS}`);
}

await main();
