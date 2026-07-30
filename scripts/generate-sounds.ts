/**
 * Generates the system cue WAVs with ffmpeg (PRODUCT.md §7).
 *
 * Written as code rather than committed as binaries so the sounds are reviewable,
 * reproducible and tweakable. Run with `npm run sounds`.
 *
 * These are heard by a 2-5 year old at close range, so every cue is short, soft-edged
 * (windowed to avoid clicks) and well below full scale.
 */
import { mkdir } from 'node:fs/promises';
import { AudioCue } from '../src/audio/cues.ts';
import { assertFfmpegReady, runFfmpeg } from '../src/audio/ffmpeg.ts';
import { cuePath, SOUNDS_DIRECTORY } from '../src/audio/soundFiles.ts';

/** Cues are mono at the playback rate the device uses. */
const SAMPLE_RATE = 48_000;

type Tone = {
  /** Start frequency in Hz. */
  readonly from: number;
  /** End frequency, for a glide. Omit for a steady tone. */
  readonly to?: number;
  readonly durationMs: number;
  /** Silence before this tone, for multi-beep cues. */
  readonly gapBeforeMs?: number;
  /** Peak amplitude, 0-1. */
  readonly gain: number;
};

type CueRecipe = {
  readonly cue: AudioCue;
  readonly description: string;
  readonly tones: readonly Tone[];
};

/**
 * Each cue's shape follows the spec's descriptions. Frequencies sit in the 400-1400 Hz
 * band where small speakers are efficient and toddler hearing is most sensitive.
 */
const RECIPES: readonly CueRecipe[] = [
  {
    cue: AudioCue.Pop,
    description: 'high, ultra-short "pop" — recording started',
    tones: [{ from: 1200, durationMs: 90, gain: 0.5 }],
  },
  {
    cue: AudioCue.Whoosh,
    description: 'upward glide — recording finished',
    tones: [{ from: 500, to: 1300, durationMs: 220, gain: 0.45 }],
  },
  {
    cue: AudioCue.Swoosh,
    description: 'bright rising success — delivered to WhatsApp',
    tones: [{ from: 700, to: 1500, durationMs: 260, gain: 0.45 }],
  },
  {
    cue: AudioCue.Oops,
    description: 'low double-beep — nothing sent',
    tones: [
      { from: 420, durationMs: 130, gain: 0.4 },
      { from: 330, durationMs: 130, gapBeforeMs: 70, gain: 0.4 },
    ],
  },
  {
    cue: AudioCue.Chime,
    description: 'soft separator between queued voice notes',
    tones: [{ from: 880, durationMs: 140, gain: 0.3 }],
  },
  {
    cue: AudioCue.Notify,
    description: 'gentle two-note arrival — a voice note came in',
    tones: [
      { from: 660, durationMs: 150, gain: 0.4 },
      { from: 990, durationMs: 190, gapBeforeMs: 40, gain: 0.4 },
    ],
  },
];

/**
 * Builds an ffmpeg filtergraph for one cue.
 *
 * Every tone is windowed with a short fade in and out. Without that, starting a sine at
 * non-zero amplitude produces an audible click that is worse than the cue itself.
 */
function buildFilter(tones: readonly Tone[]): string {
  const segments: string[] = [];
  const labels: string[] = [];

  tones.forEach((tone, position) => {
    const seconds = (tone.durationMs / 1000).toFixed(4);
    // 15ms edges, or a quarter of the tone if it is very short.
    const fade = Math.min(0.015, tone.durationMs / 4000).toFixed(4);
    const label = `t${position}`;

    /*
     * Everything is synthesised with aevalsrc, including steady tones. ffmpeg's `sine`
     * source and `aevalsrc` do not emit at the same scale — mixing them made the glide
     * cues ~19 dB louder than the steady ones for the same `gain`. Using one source means
     * peak amplitude is exactly `gain` for every cue, so the relative loudness of the
     * cues is a decision here rather than an accident of ffmpeg internals.
     */
    const phase =
      tone.to === undefined
        ? // Steady tone.
          `${tone.from}*t`
        : // Linear frequency sweep: integrate f(t) to get phase.
          `${tone.from}*t+(${tone.to}-${tone.from})/2*t*t/${seconds}`;
    const expression = `aevalsrc=sin(2*PI*(${phase})):s=${SAMPLE_RATE}:d=${seconds}`;

    segments.push(
      `${expression},afade=t=in:st=0:d=${fade},` +
        `afade=t=out:st=${(tone.durationMs / 1000 - Number(fade)).toFixed(4)}:d=${fade},` +
        `volume=${tone.gain}[${label}]`,
    );

    if (tone.gapBeforeMs !== undefined && tone.gapBeforeMs > 0) {
      const gapLabel = `g${position}`;
      const gapSeconds = (tone.gapBeforeMs / 1000).toFixed(4);
      segments.push(`anullsrc=r=${SAMPLE_RATE}:cl=mono,atrim=duration=${gapSeconds}[${gapLabel}]`);
      labels.push(gapLabel);
    }
    labels.push(label);
  });

  const inputs = labels.map((label) => `[${label}]`).join('');
  const concat =
    labels.length > 1 ? `${inputs}concat=n=${labels.length}:v=0:a=1[out]` : `${inputs}anull[out]`;

  return [...segments, concat].join(';');
}

async function generate(recipe: CueRecipe): Promise<void> {
  const output = cuePath(recipe.cue);
  await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-filter_complex',
    buildFilter(recipe.tones),
    '-map',
    '[out]',
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    output,
  ]);
  console.log(`  ✓ ${recipe.cue.padEnd(8)} ${recipe.description}`);
}

async function main(): Promise<void> {
  await assertFfmpegReady();
  await mkdir(SOUNDS_DIRECTORY, { recursive: true });

  console.log(`Generating ${RECIPES.length} cues into ${SOUNDS_DIRECTORY}\n`);
  for (const recipe of RECIPES) {
    // Sequential: ffmpeg is cheap here and serial output stays readable.
    await generate(recipe);
  }
  console.log('\nDone. These are gitignored — rerun `npm run sounds` after a clone.');
}

await main();
