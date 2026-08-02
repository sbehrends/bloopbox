import type { ButtonIndex } from '../config/schema.ts';
import { runFfmpeg } from './ffmpeg.ts';

/**
 * Synthesises a stand-in "voice note" for the simulator's event injector.
 *
 * Previously the injector copied `chime.wav` — 140ms at -10.5dB — which is so short and
 * quiet that tapping a blinking button sounded like nothing happened, making it impossible
 * to tell a working receive pipeline from a broken one.
 *
 * These notes are deliberately unmistakable: about 1.4 seconds, at cue level, with a
 * distinct pitch per button so you can hear *which* contact "spoke".
 */

/** Roughly the length of a toddler saying a short sentence. */
const NOTE_DURATION_MS = 1400;

/** Base pitch per button, spaced widely enough to tell apart by ear. */
const BASE_FREQUENCIES: Readonly<Record<ButtonIndex, number>> = {
  0: 392, // G4 — Button 1
  1: 523, // C5 — Button 2
  2: 659, // E5 — Button 3
};

/** Clearly audible, still below the cue peaks so it never startles. */
const NOTE_GAIN = 0.45;

/**
 * Writes a WAV test note to `path`.
 *
 * A three-syllable rise-fall-rise shape reads as "someone said something" rather than as a
 * system beep, which is what makes it useful for judging the receive flow by ear.
 */
export async function generateTestNote(path: string, index: ButtonIndex): Promise<void> {
  const base = BASE_FREQUENCIES[index];
  const seconds = (NOTE_DURATION_MS / 1000).toFixed(3);

  /*
   * Frequency wobbles between the base and a fifth above on a slow sine, giving speech-like
   * contour. Phase is the integral of that frequency, hence the -cos term.
   */
  const wobbleHz = 2.1;
  const depth = base * 0.5;
  const phase =
    `${base}*t - ${(depth / (2 * Math.PI * wobbleHz)).toFixed(4)}*` +
    `(cos(2*PI*${wobbleHz}*t) - 1)`;

  await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-filter_complex',
    `aevalsrc=sin(2*PI*(${phase})):s=48000:d=${seconds},` +
      // Tremolo gives the syllable pulses; fades keep the edges click-free.
      `tremolo=f=3.2:d=0.7,` +
      `afade=t=in:st=0:d=0.04,` +
      `afade=t=out:st=${(NOTE_DURATION_MS / 1000 - 0.06).toFixed(3)}:d=0.06,` +
      `volume=${NOTE_GAIN}[out]`,
    '-map',
    '[out]',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-c:a',
    'pcm_s16le',
    path,
  ]);
}

/** How long a generated note lasts, for the queue's duration bookkeeping. */
export const TEST_NOTE_DURATION_MS = NOTE_DURATION_MS;
