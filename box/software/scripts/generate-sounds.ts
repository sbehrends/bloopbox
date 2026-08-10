/**
 * Builds the system cue WAVs with ffmpeg (PRODUCT.md §7).
 *
 * A cue is either **designed** — a recording under `src/audio/samples/`, mastered here — or
 * **synthesised** from the tone recipes below. Both end up as one WAV per cue, because
 * `aplay` is the only player on the device and WAV is the only thing it reads. Run with
 * `npm run sounds`; the output is gitignored, so this is the reviewable form of the sounds
 * in both cases.
 *
 * These are heard by a 2-5 year old at close range, so every cue is short, soft-edged
 * (windowed to avoid clicks) and well below full scale.
 */
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { ALL_AUDIO_CUES, AudioCue } from '../src/audio/cues.ts';
import { assertFfmpegReady, FFMPEG_PATH, probeDurationMs, runFfmpeg } from '../src/audio/ffmpeg.ts';
import { cuePath, samplePath, SOUNDS_DIRECTORY } from '../src/audio/soundFiles.ts';

const execFileAsync = promisify(execFile);

/** Cues are mono at the playback rate the device uses. */
const SAMPLE_RATE = 48_000;

/**
 * Anything averaging quieter than this counts as silence when trimming a recording.
 *
 * Averaged, not peak: an MP3 decoder rings, and the padding on these sources carries isolated
 * spikes up to -35 dBFS over a mean of -70 to -82 dBFS. A peak-based rule calls that padding
 * "audio" and trims nothing at all.
 */
const SILENCE_FLOOR_DB = -50;

/** How much silence has to persist before it counts as the end of the sound, in seconds. */
const MIN_SILENCE_S = 0.1;

/** Kept after the last audible sample, so a decay is never cut off abruptly. */
const TAIL_PAD_S = 0.03;

/**
 * Windowing applied at a cut edge, in seconds. Same anti-click purpose as the tone fades,
 * but only where the audio was actually cut — see `buildSampleFilter`.
 */
const SAMPLE_FADE_IN_S = 0.005;
const SAMPLE_FADE_OUT_S = 0.02;

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

/** A cue built from tones. */
type SynthesisedCue = {
  readonly cue: AudioCue;
  readonly description: string;
  readonly tones: readonly Tone[];
};

/**
 * A cue built from its recording in `src/audio/samples/`.
 *
 * `peak` is the only knob: the source is trimmed, windowed and scaled so its loudest sample
 * lands exactly there. It is on the same 0-1 scale as a tone's `gain` for a reason — the
 * designed sounds and the synthesised ones share one speaker, and a cue that is twice as
 * loud as its neighbour is a defect however nice it sounds alone.
 */
type RecordedCue = {
  readonly cue: AudioCue;
  readonly description: string;
  readonly peak: number;
};

type CueRecipe = SynthesisedCue | RecordedCue;

function isRecorded(recipe: CueRecipe): recipe is RecordedCue {
  return 'peak' in recipe;
}

/**
 * Every cue, designed or synthesised, in the order they were introduced.
 *
 * A synthesised cue's shape follows the spec's descriptions, with frequencies in the
 * 400-1400 Hz band where small speakers are efficient and toddler hearing is most sensitive.
 */
const RECIPES: readonly CueRecipe[] = [
  {
    cue: AudioCue.Boot,
    description: 'designed startup sound — the device has come up',
    peak: 0.45,
  },
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
    description: 'designed success sound — delivered to WhatsApp',
    peak: 0.45,
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
    description: 'designed arrival sound — a voice note came in',
    peak: 0.4,
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

async function synthesise(recipe: SynthesisedCue): Promise<void> {
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
    cuePath(recipe.cue),
  ]);
}

/**
 * The mastering chain for a designed recording: trim to the audible part, window it, scale it.
 *
 * Trimming is the part that matters. All three sources are padded out to a round two or three
 * seconds of silence, and a cue file's length is dwell time on the audio device: `playCue`
 * awaits `aplay`, and the next cue interrupts this one when it arrives. Untrimmed, "delivered"
 * would hold the speaker for 2 s to say something that takes 400 ms, and the chime separating
 * two queued notes would land on top of it.
 *
 * Both edges are cut with `atrim` at a measured boundary rather than by `silenceremove`, whose
 * rms accumulator gave non-monotonic results on exactly these files — a *lower* threshold
 * trimming *less* — and would in any case also eat the gap inside a two-note sound.
 */
function buildSampleFilter(content: ContentWindow, gainDb: number): string {
  const lengthS = content.endS - content.startS;
  const fadeOutStart = Math.max(0, lengthS - SAMPLE_FADE_OUT_S);

  return [
    `atrim=start=${content.startS.toFixed(4)}:end=${content.endS.toFixed(4)}`,
    // Timestamps have to be rebased after a trim, or the fades below use source time.
    'asetpts=N/SR/TB',
    /*
     * Only fade in if the head was cut. These sources begin at silence, so there is no click
     * to window — and a 5 ms ramp over the attack is audible as a softer transient, which on
     * a percussive "delivered" sound is the one thing it needs to keep. It also cost 1.4 dB
     * of the declared peak, because the loudest sample is inside the attack.
     */
    ...(content.startS > 0 ? [`afade=t=in:st=0:d=${SAMPLE_FADE_IN_S}`] : []),
    `afade=t=out:st=${fadeOutStart.toFixed(4)}:d=${SAMPLE_FADE_OUT_S}`,
    `volume=${gainDb.toFixed(2)}dB`,
  ].join(',');
}

async function transcode(recipe: RecordedCue): Promise<string> {
  const source = samplePath(recipe.cue);
  if (source === null) {
    throw new Error(
      `${recipe.cue} is declared as a recorded cue but has no entry in CUE_SAMPLES ` +
        `(src/audio/soundFiles.ts).`,
    );
  }

  const content = await measureContent(source);
  const targetDb = 20 * Math.log10(recipe.peak);
  const gainDb = targetDb - (await measureMonoPeakDb(source));

  await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    source,
    '-vn',
    '-af',
    buildSampleFilter(content, gainDb),
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    cuePath(recipe.cue),
  ]);

  const lengthMs = Math.round((content.endS - content.startS) * 1000);
  return `${lengthMs} ms, ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB`;
}

/** The audible span of a source recording, in seconds. */
type ContentWindow = { readonly startS: number; readonly endS: number };

/**
 * Finds where the sound actually starts and stops inside a padded source.
 *
 * `silencedetect` reports boundaries and leaves the decision here, which is the same
 * arrangement as the tone gains: what the cue ends up being is legible in this file rather
 * than an emergent property of a filter's internal state. A source with no detected padding
 * is used whole.
 */
async function measureContent(source: string): Promise<ContentWindow> {
  const durationMs = await probeDurationMs(source);
  if (durationMs === null) throw new Error(`could not read the duration of ${source}`);
  const durationS = durationMs / 1000;

  const { stderr } = await execFileAsync(FFMPEG_PATH, [
    '-hide_banner',
    '-i',
    source,
    '-vn',
    '-ac',
    '1',
    '-af',
    `silencedetect=noise=${SILENCE_FLOOR_DB}dB:d=${MIN_SILENCE_S}`,
    '-f',
    'null',
    '-',
  ]);

  const starts = readAll(stderr, /silence_start:\s*(-?\d+(?:\.\d+)?)/g);
  const ends = readAll(stderr, /silence_end:\s*(-?\d+(?:\.\d+)?)/g);

  /*
   * Leading padding exists only if the first reported silence begins at the top of the file;
   * anything later is a gap inside the sound and must survive.
   */
  const firstStart = starts[0];
  const firstEnd = ends[0];
  const startS =
    firstStart !== undefined && firstEnd !== undefined && firstStart <= MIN_SILENCE_S
      ? firstEnd
      : 0;

  /*
   * Trailing padding is a silence that runs to the end of the file. ffmpeg closes the final
   * period at EOF, so its `silence_end` sits within a frame of the duration.
   */
  const lastStart = starts.at(-1);
  const lastEnd = ends.at(-1);
  const runsToEnd = lastEnd !== undefined && lastEnd >= durationS - MIN_SILENCE_S;
  const endS =
    lastStart !== undefined && runsToEnd && lastStart > startS
      ? Math.min(durationS, lastStart + TAIL_PAD_S)
      : durationS;

  return { startS, endS };
}

function readAll(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((match) => Number(match[1]));
}

/**
 * Peak level of a source **after** the mono downmix, in dBFS.
 *
 * Measured with the downmix applied because that is what gets written: averaging two
 * channels can only lower the peak, and measuring the stereo file would leave every designed
 * cue slightly quieter than its declared `peak`. Two passes rather than a normalisation
 * filter so the level is arithmetic we can read here, not an ffmpeg internal.
 */
async function measureMonoPeakDb(source: string): Promise<number> {
  // volumedetect reports on stderr, and ffmpeg exits 0, so this cannot go through runFfmpeg.
  const { stderr } = await execFileAsync(FFMPEG_PATH, [
    '-hide_banner',
    '-i',
    source,
    '-vn',
    '-ac',
    '1',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);

  const peak = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr)?.[1];
  if (peak === undefined) {
    throw new Error(`ffmpeg volumedetect reported no max_volume for ${source}`);
  }
  return Number(peak);
}

async function generate(recipe: CueRecipe): Promise<void> {
  let detail = 'tones';
  if (isRecorded(recipe)) {
    detail = await transcode(recipe);
  } else {
    await synthesise(recipe);
  }
  console.log(`  ✓ ${recipe.cue.padEnd(8)} ${recipe.description}  [${detail}]`);
}

/**
 * Every cue in the vocabulary needs a recipe here.
 *
 * Checked before building anything, because the alternative failure is remote from its cause: a
 * cue added to `cues.ts` and forgotten here produces a successful `npm run sounds` and then a
 * "cannot build: audio cues are missing" from `build:assets`, which reads like the script was
 * never run.
 */
function assertEveryCueHasARecipe(): void {
  const covered = new Set(RECIPES.map((recipe) => recipe.cue));
  const uncovered = ALL_AUDIO_CUES.filter((cue) => !covered.has(cue));
  if (uncovered.length > 0) {
    throw new Error(
      `no recipe for ${uncovered.join(', ')} — add tones, or a peak plus an entry in ` +
        `CUE_SAMPLES (src/audio/soundFiles.ts), to RECIPES in this file.`,
    );
  }
}

async function main(): Promise<void> {
  assertEveryCueHasARecipe();
  await assertFfmpegReady();
  await mkdir(SOUNDS_DIRECTORY, { recursive: true });

  console.log(`Building ${RECIPES.length} cues into ${SOUNDS_DIRECTORY}\n`);
  for (const recipe of RECIPES) {
    // Sequential: ffmpeg is cheap here and serial output stays readable.
    await generate(recipe);
  }
  console.log('\nDone. These are gitignored — rerun `npm run sounds` after a clone.');
}

await main();
