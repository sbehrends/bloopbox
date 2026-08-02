import { EventEmitter } from 'node:events';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AudioCue } from '../audio/cues.ts';
import { toVoiceNote } from '../audio/ffmpeg.ts';
import type { ButtonIndex } from '../config/schema.ts';
import { createRequestId } from '../ipc/events.ts';
import type { Hal, HalEvents, HalOptions, RecordingHandle, RecordingResult } from './types.ts';

/**
 * HAL backed by a browser tab (PRODUCT.md §5).
 *
 * Buttons are mouse-held, LEDs are canvas circles, and audio uses the Web Audio APIs. The
 * transport is injected rather than owned so this driver stays testable and the Socket.io
 * server lives in the process layer where it belongs.
 *
 * The browser is untrusted and may vanish mid-recording, so every operation that waits on
 * it is bounded by a timeout — a closed tab must never wedge the device pipeline.
 */

/** How long to wait for the browser before giving up on an operation. */
export const SIMULATOR_TIMEOUT_MS = 15_000;

/** What the driver needs from the transport, so tests can supply a fake. */
export type SimulatorTransport = {
  /** True while at least one browser tab is connected. */
  readonly connected: boolean;
  /** Pushes authoritative LED states to every tab. */
  sendLeds(states: readonly [boolean, boolean, boolean]): void;
  sendStartCapture(recordingId: string, index: ButtonIndex): void;
  sendStopCapture(recordingId: string): void;
  sendCancelCapture(recordingId: string): void;
  sendPlay(token: string, url: string, volumePercent: number): void;
  sendPlayCue(token: string, cue: AudioCue, volumePercent: number): void;
  sendStopPlayback(): void;
};

type PendingCapture = {
  readonly handle: RecordingHandle;
  resolve: (result: RecordingResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingPlayback = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class SimulatorHal extends EventEmitter<HalEvents> implements Hal {
  readonly name = 'simulator';

  readonly #transport: SimulatorTransport;
  readonly #recordingDirectory: string;
  #volumePercent: number;
  #counter = 0;
  #ledStates: [boolean, boolean, boolean] = [false, false, false];

  readonly #captures = new Map<string, PendingCapture>();
  /**
   * Audio as it streams in, keyed by recording id.
   *
   * Separate from {@link #captures} because the browser starts sending the moment the button
   * goes down, while the promise that consumes it is only created on `stopRecording` — a
   * quarter of a second of speech, including MediaRecorder's header chunk, arrives before
   * anything is waiting for it. Buffering from `startRecording` is what keeps it.
   */
  readonly #chunks = new Map<string, Buffer[]>();
  readonly #playbacks = new Map<string, PendingPlayback>();

  constructor(transport: SimulatorTransport, options: HalOptions) {
    super();
    this.#transport = transport;
    this.#recordingDirectory = options.recordingDirectory;
    this.#volumePercent = options.volumePercent;
  }

  get available(): boolean {
    return this.#transport.connected;
  }

  async init(): Promise<void> {
    await mkdir(this.#recordingDirectory, { recursive: true });
  }

  async dispose(): Promise<void> {
    for (const capture of this.#captures.values()) {
      clearTimeout(capture.timer);
      capture.reject(new Error('simulator disposed'));
    }
    this.#captures.clear();
    this.#chunks.clear();

    for (const playback of this.#playbacks.values()) {
      clearTimeout(playback.timer);
      playback.reject(new Error('simulator disposed'));
    }
    this.#playbacks.clear();

    // Contract: dispose leaves every LED off.
    this.#ledStates = [false, false, false];
    if (this.#transport.connected) this.#transport.sendLeds(this.#ledStates);
    await Promise.resolve();
  }

  setLed(index: ButtonIndex, on: boolean): void {
    if (this.#ledStates[index] === on) return;
    this.#ledStates[index] = on;
    // The browser renders whatever we say; it never decides LED state itself.
    if (this.#transport.connected) this.#transport.sendLeds([...this.#ledStates]);
  }

  /** Current LED states, for pushing a full frame to a tab that just connected. */
  ledStates(): readonly [boolean, boolean, boolean] {
    return [...this.#ledStates];
  }

  startRecording(index: ButtonIndex): Promise<RecordingHandle> {
    if (!this.#transport.connected) {
      return Promise.reject(new Error('simulator: no browser connected'));
    }

    this.#counter += 1;
    const handle: RecordingHandle = {
      id: createRequestId('simrec', this.#counter),
      index,
      startedAt: Date.now(),
    };

    // Ready to receive before the browser can possibly answer.
    this.#chunks.set(handle.id, []);
    this.#transport.sendStartCapture(handle.id, index);
    return Promise.resolve(handle);
  }

  /**
   * Asks the browser to flush, then resolves once every chunk has arrived and been
   * transcoded. Rejects on timeout so a closed tab cannot strand the caller.
   */
  stopRecording(handle: RecordingHandle): Promise<RecordingResult> {
    return new Promise<RecordingResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#captures.delete(handle.id);
        this.#chunks.delete(handle.id);
        reject(new Error(`simulator: browser did not deliver audio for ${handle.id}`));
      }, SIMULATOR_TIMEOUT_MS);
      timer.unref();

      this.#captures.set(handle.id, { handle, resolve, reject, timer });
      this.#transport.sendStopCapture(handle.id);
    });
  }

  async cancelRecording(handle: RecordingHandle): Promise<void> {
    const pending = this.#captures.get(handle.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.#captures.delete(handle.id);
      pending.reject(new Error('recording cancelled'));
    }
    this.#chunks.delete(handle.id);
    this.#transport.sendCancelCapture(handle.id);
    await this.#deleteIfPresent(this.#rawPath(handle.id));
  }

  play(path: string): Promise<void> {
    // The browser fetches the file over HTTP; the server exposes /audio/<name>.
    const url = `/audio/${encodeURIComponent(path.split('/').pop() ?? '')}`;
    return this.#awaitPlayback((token) =>
      this.#transport.sendPlay(token, url, this.#volumePercent),
    );
  }

  playCue(cue: AudioCue): Promise<void> {
    return this.#awaitPlayback((token) =>
      this.#transport.sendPlayCue(token, cue, this.#volumePercent),
    );
  }

  async stopPlayback(): Promise<void> {
    this.#transport.sendStopPlayback();
    for (const [token, playback] of this.#playbacks) {
      clearTimeout(playback.timer);
      this.#playbacks.delete(token);
      // Treat an interruption as success: the caller asked for it.
      playback.resolve();
    }
    await Promise.resolve();
  }

  setVolume(percent: number): Promise<void> {
    // Applied per-playback via the Web Audio gain node.
    this.#volumePercent = percent;
    return Promise.resolve();
  }

  /* ---- inbound, called by the transport layer ---- */

  /** A virtual button went down. */
  handleButtonDown(index: ButtonIndex): void {
    this.emit('buttonDown', { index });
  }

  handleButtonUp(index: ButtonIndex): void {
    this.emit('buttonUp', { index });
  }

  /** Accumulates a chunk of captured audio. Unknown ids are dropped, not buffered. */
  handleAudioChunk(recordingId: string, chunk: Buffer): void {
    this.#chunks.get(recordingId)?.push(chunk);
  }

  /**
   * The browser finished flushing. Writes the raw blob, transcodes it to Ogg/Opus, and
   * resolves the pending stopRecording.
   */
  async handleAudioComplete(recordingId: string, mimeType: string): Promise<void> {
    const pending = this.#captures.get(recordingId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.#captures.delete(recordingId);
    const chunks = this.#chunks.get(recordingId) ?? [];
    this.#chunks.delete(recordingId);

    const rawPath = this.#rawPath(recordingId, extensionFor(mimeType));
    const outputPath = join(this.#recordingDirectory, `${recordingId}.ogg`);

    try {
      const raw = Buffer.concat(chunks);
      if (raw.byteLength === 0) {
        throw new Error('browser delivered no audio');
      }
      await writeFile(rawPath, raw);
      // MediaRecorder gives WebM/Opus in Chrome; WhatsApp needs Ogg/Opus.
      await toVoiceNote(rawPath, outputPath);
      const { size } = await stat(outputPath);

      pending.resolve({
        path: outputPath,
        durationMs: Date.now() - pending.handle.startedAt,
        byteLength: size,
      });
    } catch (error: unknown) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await this.#deleteIfPresent(rawPath);
    }
  }

  /** The browser could not capture (permission denied, no microphone). */
  handleAudioError(recordingId: string, reason: string): void {
    this.#chunks.delete(recordingId);
    const pending = this.#captures.get(recordingId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#captures.delete(recordingId);
    pending.reject(new Error(`simulator capture failed: ${reason}`));
  }

  handlePlaybackComplete(token: string): void {
    const pending = this.#playbacks.get(token);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#playbacks.delete(token);
    pending.resolve();
  }

  handlePlaybackError(token: string, reason: string): void {
    const pending = this.#playbacks.get(token);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#playbacks.delete(token);
    pending.reject(new Error(`simulator playback failed: ${reason}`));
  }

  /** A tab connected; push the current frame so it renders immediately. */
  handleBrowserConnected(): void {
    this.#transport.sendLeds([...this.#ledStates]);
    this.emit('available');
  }

  /** The last tab went away. */
  handleBrowserDisconnected(): void {
    // Nothing will ever flush these, and the RAM disk is 512MB of the device's memory.
    this.#chunks.clear();
    this.emit('unavailable', { reason: 'browser disconnected' });
  }

  /* ---- internals ---- */

  #awaitPlayback(send: (token: string) => void): Promise<void> {
    if (!this.#transport.connected) {
      // No tab: silently succeed rather than blocking the audio pipeline.
      return Promise.resolve();
    }

    this.#counter += 1;
    const token = createRequestId('simplay', this.#counter);

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#playbacks.delete(token);
        reject(new Error(`simulator: playback ${token} timed out`));
      }, SIMULATOR_TIMEOUT_MS);
      timer.unref();

      this.#playbacks.set(token, { resolve, reject, timer });
      send(token);
    });
  }

  #rawPath(recordingId: string, extension = 'webm'): string {
    return join(this.#recordingDirectory, `${recordingId}.raw.${extension}`);
  }

  async #deleteIfPresent(path: string): Promise<void> {
    await rm(path, { force: true });
  }
}

/** Maps a MediaRecorder MIME type onto a container extension ffmpeg will recognise. */
function extensionFor(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  switch (base) {
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
    case 'audio/aac':
      return 'm4a';
    case 'audio/wav':
    case 'audio/wave':
      return 'wav';
    default:
      // Chrome's default, and the most common case.
      return 'webm';
  }
}
