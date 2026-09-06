import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Readable } from 'node:stream';

/**
 * ffmpeg access: locating the binary and the two conversions the device needs.
 *
 * WhatsApp voice notes must be Opus in an Ogg container to arrive as a real PTT bubble
 * rather than a file attachment, so every outbound recording passes through here.
 */

const execFileAsync = promisify(execFile);

/** Resolution order: explicit override, then PATH. */
export const FFMPEG_PATH = process.env['FFMPEG_PATH'] ?? 'ffmpeg';

/**
 * WhatsApp voice-note encoding. 16 kHz mono is what phones send; anything richer just
 * costs upload time on a Pi Zero's Wi-Fi and storage in the RAM disk.
 */
export const VOICE_ENCODING = {
  sampleRate: 16_000,
  channels: 1,
  /** ~24 kbps is transparent for speech at 16 kHz mono. */
  bitrate: '24k',
  /** Tells libopus to tune for speech rather than music. */
  application: 'voip',
} as const;

/**
 * What the microphone chain does to a take before it is encoded.
 *
 * Every term is here because it was measured on the device — see `docs/audio-quality.md`.
 * In order:
 *
 * - `highpass=110` — the noise floor is **low-frequency**, not hiss: 20–100 Hz measured 12 dB
 *   above 300–1000 Hz. A child's voice fundamental sits at 250–400 Hz, so this took 3.7 dB off
 *   the noise and 0.3 dB off the voice. The cheapest win in the chain.
 * - `afftdn` — a further 12 dB off the noise with no measurable cost to the voice. It also makes
 *   the *encode faster* (1627 ms against 2770 ms for a 10 s take), because Opus stops spending
 *   effort on noise. `nf` is the assumed noise floor and has not been optimised against a real
 *   room; −30 was measured, not tuned.
 * - `speechnorm` — recovers the ~12 dB of level given up by running the preamp lower, *after* the
 *   noise has gone rather than before it. `p=0.7` (≈ −3 dBFS) rather than the default 0.95: at the
 *   default this measured −0.4 dBFS, too close to the rail to survive an Opus round trip.
 *
 * The order matters. Normalising before denoising would lift the noise floor by exactly the gain
 * applied and give the denoiser a moving target.
 *
 * **This cannot rescue a clipped input.** It presumes `audio.micGainPercent` leaves headroom;
 * at the old default the input clipped on room tone alone, and no filter undoes that.
 */
export const CAPTURE_FILTER_CHAIN =
  'highpass=f=110,afftdn=nf=-30,speechnorm=e=6.25:r=0.0001:l=1:p=0.7';

/**
 * What an arriving note gets on decode.
 *
 * One relative records at arm's length in a quiet room and the next holds the phone to their
 * mouth on a train, and the child has no volume control — only a button. Measured across a quiet
 * and a loud sender, the spread between them was **18.1 dB** untreated and **0.03 dB** through
 * this: EBU R128 integrated loudness is the one measure that actually equalises two speakers.
 *
 * `loudnorm` is the most expensive filter tried here (~+1 s on a note), and it is affordable for
 * exactly one reason: decoding happens at **arrival**, from `prepare()`, where nobody is waiting.
 * It would not be affordable on the tap.
 *
 * `TP=-1.5` keeps a true-peak margin so the WAV `aplay` receives cannot clip on playback.
 */
export const PLAYBACK_FILTER_CHAIN = 'loudnorm=I=-16:TP=-1.5:LRA=11';

let cachedProbe: Promise<FfmpegProbe> | null = null;

export type FfmpegProbe = {
  readonly available: boolean;
  readonly version: string | null;
  readonly hasOpus: boolean;
  readonly error?: string;
};

/** Checks once per process that ffmpeg exists and can encode Opus. */
export async function probeFfmpeg(): Promise<FfmpegProbe> {
  cachedProbe ??= (async (): Promise<FfmpegProbe> => {
    try {
      const { stdout: versionOut } = await execFileAsync(FFMPEG_PATH, ['-version']);
      const version = versionOut.split('\n')[0] ?? null;
      const { stdout: encoders } = await execFileAsync(FFMPEG_PATH, ['-hide_banner', '-encoders']);
      return { available: true, version, hasOpus: encoders.includes('libopus') };
    } catch (error: unknown) {
      return {
        available: false,
        version: null,
        hasOpus: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();
  return cachedProbe;
}

/** Throws a clear, actionable error if ffmpeg cannot do what we need. */
export async function assertFfmpegReady(): Promise<void> {
  const probe = await probeFfmpeg();
  if (!probe.available) {
    throw new Error(
      `ffmpeg not found (tried "${FFMPEG_PATH}"). Install it — "brew install ffmpeg" on macOS, ` +
        `"apt install ffmpeg" on the Pi — or set FFMPEG_PATH.`,
    );
  }
  if (!probe.hasOpus) {
    throw new Error(
      `ffmpeg at "${FFMPEG_PATH}" has no libopus encoder; WhatsApp voice notes require Opus.`,
    );
  }
}

/** Resets the cached probe. Tests only. */
export function resetFfmpegProbe(): void {
  cachedProbe = null;
}

export class FfmpegError extends Error {
  /* Declared and assigned separately: `erasableSyntaxOnly` forbids parameter properties. */
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = 'FfmpegError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Runs ffmpeg with the given arguments, capturing stderr for diagnostics. */
export async function runFfmpeg(args: readonly string[], input?: Readable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, [...args], {
      stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded: a runaway encode must not grow this without limit.
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      reject(new FfmpegError(`failed to start ffmpeg: ${error.message}`, null, stderr));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new FfmpegError(`ffmpeg exited with code ${code}`, code, stderr.trim()));
    });

    if (input) {
      input.pipe(child.stdin!);
      input.on('error', (error: Error) => {
        child.kill('SIGKILL');
        reject(new FfmpegError(`input stream failed: ${error.message}`, null, stderr));
      });
    }
  });
}

/**
 * Transcodes any input the browser or microphone produced into WhatsApp-ready
 * Ogg/Opus. Used for both WebM/Opus from MediaRecorder and raw WAV from `arecord`.
 */
export async function toVoiceNote(
  inputPath: string,
  outputPath: string,
  filter: string | null = CAPTURE_FILTER_CHAIN,
): Promise<void> {
  await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-vn',
    ...(filter ? ['-af', filter] : []),
    /*
     * Baileys documents `-avoid_negative_ts make_zero` plus a single channel as necessary for
     * voice notes to play on every device. Without it some clients show the bubble but refuse
     * to play it, which on this device is indistinguishable from the message never arriving.
     */
    '-avoid_negative_ts',
    'make_zero',
    '-ac',
    String(VOICE_ENCODING.channels),
    '-ar',
    String(VOICE_ENCODING.sampleRate),
    '-c:a',
    'libopus',
    '-b:a',
    VOICE_ENCODING.bitrate,
    '-application',
    VOICE_ENCODING.application,
    '-f',
    'ogg',
    outputPath,
  ]);
}

/**
 * What a decoded note is written as, when the caller does not say otherwise.
 *
 * Speech that arrived as 16 kHz mono Opus — which is what every phone sends — has nothing to
 * gain from being decoded to Opus's internal 48 kHz stereo. It costs three times the RAM disk
 * for the same sound, and the device decodes these ahead of time into a tmpfs measured in tens
 * of megabytes.
 */
export const PLAYBACK_DECODING = { sampleRate: 16_000, channels: 1 } as const;

/**
 * Decodes any audio file to signed 16-bit PCM WAV, the one container `aplay` can read.
 *
 * The rate and channel count are forced rather than inherited so the output size is
 * predictable — see `PLAYBACK_DECODING`. Pass `format: null` to keep the source's own.
 */
export async function toPlayableWav(
  inputPath: string,
  outputPath: string,
  format: { readonly sampleRate: number; readonly channels: number } | null = PLAYBACK_DECODING,
  filter: string | null = PLAYBACK_FILTER_CHAIN,
): Promise<void> {
  await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-vn',
    ...(filter ? ['-af', filter] : []),
    ...(format ? ['-ar', String(format.sampleRate), '-ac', String(format.channels)] : []),
    '-f',
    'wav',
    '-acodec',
    'pcm_s16le',
    outputPath,
  ]);
}

/** Duration in milliseconds, or null if ffprobe is unavailable or the file is unreadable. */
export async function probeDurationMs(path: string): Promise<number | null> {
  const ffprobePath = FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path,
    ]);
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  }
}
