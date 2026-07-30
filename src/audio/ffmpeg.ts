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
export async function toVoiceNote(inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-vn',
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

/** Decodes any audio file to signed 16-bit PCM WAV, ready to pipe into `aplay`. */
export async function toPlayableWav(inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-vn',
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
