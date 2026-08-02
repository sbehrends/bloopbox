import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_AUDIO_CUES, type AudioCue } from './cues.ts';

/**
 * Locations of the generated cue WAVs.
 *
 * The files are produced by `npm run sounds` (scripts/generate-sounds.ts) rather than
 * committed as binaries, so they are reproducible and reviewable as code.
 */

/** Where the WAVs live, relative to this module in both src/ and dist/. */
export const SOUNDS_DIRECTORY = resolve(import.meta.dirname, 'sounds');

export function cuePath(cue: AudioCue): string {
  return resolve(SOUNDS_DIRECTORY, `${cue}.wav`);
}

/** Cues whose file is missing. Non-empty means `npm run sounds` has not been run. */
export function missingCues(): AudioCue[] {
  return ALL_AUDIO_CUES.filter((cue) => !existsSync(cuePath(cue)));
}

/** URL the browser fetches a cue from; served by the hardware server. */
export function cueUrl(cue: AudioCue): string {
  return `/sounds/${cue}.wav`;
}
