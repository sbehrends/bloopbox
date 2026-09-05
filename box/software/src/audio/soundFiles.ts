import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_AUDIO_CUES, AudioCue } from './cues.ts';

/**
 * Locations of the cue WAVs and of the recordings some of them are made from.
 *
 * The WAVs are produced by `npm run sounds` (scripts/generate-sounds.ts) rather than
 * committed as binaries, so they are reproducible and reviewable as code. `aplay` — the
 * only player on the device — reads WAV and nothing else, which is why even the designed
 * sounds are transcoded rather than shipped as-is.
 */

/** Where the WAVs live, relative to this module in both src/ and dist/. */
export const SOUNDS_DIRECTORY = resolve(import.meta.dirname, 'sounds');

/**
 * Where the designed source recordings live. **Committed**, unlike the WAVs: they are
 * authored audio, not something a script can regenerate.
 *
 * Build inputs only. `scripts/copy-assets.ts` copies `sounds/` and not this, so the device
 * never has to decode an MP3 — which also means this path does not exist under `dist/` and
 * `missingSamples()` below is a check for a source tree, not for a deployed device.
 */
export const SAMPLES_DIRECTORY = resolve(import.meta.dirname, 'samples');

/**
 * Cues whose sound is a designed recording rather than synthesised tones.
 *
 * Filenames are the ones the audio was delivered under, deliberately unrenamed — this table
 * is the only place the two vocabularies meet, so a redesign is a one-line change here and
 * the provenance of every cue stays legible. Cues absent from this table are synthesised;
 * the recipes for those live in `scripts/generate-sounds.ts`.
 *
 * `success.mp3` sits in `samples/` without an entry here: it was the delivery cue, retired
 * 2026-08-17 when a send went down to one sound. Kept because it is authored audio — a
 * checkout can regenerate a WAV but not a recording.
 */
export const CUE_SAMPLES = {
  [AudioCue.Boot]: 'boot.mp3',
  [AudioCue.Notify]: 'notification-in.mp3',
} as const satisfies Partial<Record<AudioCue, string>>;

export type SampledCue = keyof typeof CUE_SAMPLES;

/** Whether this cue's sound comes from a recording. Narrows, so no cast is needed below. */
export function isSampledCue(cue: AudioCue): cue is SampledCue {
  return cue in CUE_SAMPLES;
}

export function cuePath(cue: AudioCue): string {
  return resolve(SOUNDS_DIRECTORY, `${cue}.wav`);
}

/** The source recording for a cue, or null if the cue is synthesised. */
export function samplePath(cue: AudioCue): string | null {
  if (!isSampledCue(cue)) return null;
  return resolve(SAMPLES_DIRECTORY, CUE_SAMPLES[cue]);
}

/** Cues whose file is missing. Non-empty means `npm run sounds` has not been run. */
export function missingCues(): AudioCue[] {
  return ALL_AUDIO_CUES.filter((cue) => !existsSync(cuePath(cue)));
}

/**
 * Sampled cues whose source recording is missing.
 *
 * Non-empty means the checkout is incomplete or a file was renamed: `npm run sounds` would
 * then fail, so this is what reports it as a missing asset rather than an ffmpeg error.
 */
export function missingSamples(): SampledCue[] {
  return sampledCues().filter((cue) => !existsSync(resolve(SAMPLES_DIRECTORY, CUE_SAMPLES[cue])));
}

/** Every cue backed by a recording, in cue order rather than object-key order. */
export function sampledCues(): SampledCue[] {
  return ALL_AUDIO_CUES.filter(isSampledCue);
}

/** URL the browser fetches a cue from; served by the hardware server. */
export function cueUrl(cue: AudioCue): string {
  return `/sounds/${cue}.wav`;
}
