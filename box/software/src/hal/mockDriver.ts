import { EventEmitter } from 'node:events';
import type { ButtonIndex } from '../config/schema.ts';
import type { AudioCue } from '../audio/cues.ts';
import type { Hal, HalEvents, PlaybackOutcome, RecordingHandle, RecordingResult } from './types.ts';

/**
 * In-memory HAL for tests. Records every call with a timestamp so LED patterns, cue
 * sequencing and recording lifecycles can be asserted exactly, without hardware.
 */

export type LedWrite = { index: ButtonIndex; on: boolean; at: number };
export type CuePlay = { cue: AudioCue; at: number };
export type FilePlay = { path: string; at: number };

export class MockHal extends EventEmitter<HalEvents> implements Hal {
  readonly name = 'mock';

  #available = true;
  #disposed = false;
  #recordingCounter = 0;

  /** Current LED states, index-aligned. */
  readonly ledStates: [boolean, boolean, boolean] = [false, false, false];
  /** Every setLed call in order. */
  readonly ledWrites: LedWrite[] = [];
  readonly cuesPlayed: CuePlay[] = [];
  readonly filesPlayed: FilePlay[] = [];
  /** Paths handed to prepare()/release(), in order. */
  readonly prepared: string[] = [];
  readonly released: string[] = [];
  readonly volumeChanges: number[] = [];
  readonly activeRecordings = new Map<string, RecordingHandle>();
  readonly cancelledRecordings: string[] = [];
  readonly completedRecordings: RecordingResult[] = [];

  /** Set to make play()/playCue() reject, exercising error paths. */
  failPlayback = false;
  /**
   * Set to make `play()` hold the note open until a cue, `stopPlayback()` or another `play()`
   * interrupts it — or until {@link finishPlayback} lets it complete. Off by default, where
   * notes complete at once, which is what most tests want.
   *
   * With it on, the mock behaves like the real speaker: one output, and a cue cuts off a note.
   * The controller tests would otherwise be blind to anything that plays over a message.
   */
  holdPlayback = false;
  #playing: { path: string; settle: (outcome: PlaybackOutcome) => void } | null = null;
  /** Set to make recording fail. */
  failRecording = false;
  /** Simulated duration reported by stopRecording, when not derived from the clock. */
  fixedDurationMs: number | null = null;

  get available(): boolean {
    return this.#available;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  init(): Promise<void> {
    this.#disposed = false;
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    // Contract: dispose must leave every LED off.
    for (const index of [0, 1, 2] as const) this.setLed(index, false);
    this.#disposed = true;
    return Promise.resolve();
  }

  setLed(index: ButtonIndex, on: boolean): void {
    this.ledStates[index] = on;
    this.ledWrites.push({ index, on, at: Date.now() });
  }

  startRecording(index: ButtonIndex): Promise<RecordingHandle> {
    if (this.failRecording) return Promise.reject(new Error('mock: recording unavailable'));
    this.#recordingCounter += 1;
    const handle: RecordingHandle = {
      id: `mock-rec-${this.#recordingCounter}`,
      index,
      startedAt: Date.now(),
    };
    this.activeRecordings.set(handle.id, handle);
    return Promise.resolve(handle);
  }

  stopRecording(handle: RecordingHandle): Promise<RecordingResult> {
    this.activeRecordings.delete(handle.id);
    const result: RecordingResult = {
      path: `/tmp/${handle.id}.ogg`,
      durationMs: this.fixedDurationMs ?? Date.now() - handle.startedAt,
      byteLength: 2048,
    };
    this.completedRecordings.push(result);
    return Promise.resolve(result);
  }

  cancelRecording(handle: RecordingHandle): Promise<void> {
    this.activeRecordings.delete(handle.id);
    this.cancelledRecordings.push(handle.id);
    return Promise.resolve();
  }

  play(path: string): Promise<PlaybackOutcome> {
    if (this.failPlayback) return Promise.reject(new Error(`mock: cannot play ${path}`));
    this.#interrupt();
    this.filesPlayed.push({ path, at: Date.now() });
    if (!this.holdPlayback) return Promise.resolve('completed');
    return new Promise<PlaybackOutcome>((settle) => {
      this.#playing = { path, settle };
    });
  }

  /** The note `play()` is holding open, if any. */
  get nowPlaying(): string | null {
    return this.#playing?.path ?? null;
  }

  /** Lets a held note play to its end. */
  finishPlayback(): void {
    const playing = this.#playing;
    this.#playing = null;
    playing?.settle('completed');
  }

  /** One output, as on the device: anything new cuts off the note that is playing. */
  #interrupt(): void {
    const playing = this.#playing;
    this.#playing = null;
    playing?.settle('interrupted');
  }

  /** Records the request. Never rejects, per the contract — not even with `failPlayback`. */
  prepare(path: string): Promise<void> {
    this.prepared.push(path);
    return Promise.resolve();
  }

  release(path: string): Promise<void> {
    this.released.push(path);
    return Promise.resolve();
  }

  playCue(cue: AudioCue): Promise<void> {
    if (this.failPlayback) return Promise.reject(new Error(`mock: cannot play cue ${cue}`));
    this.#interrupt();
    this.cuesPlayed.push({ cue, at: Date.now() });
    return Promise.resolve();
  }

  stopPlayback(): Promise<void> {
    this.#interrupt();
    return Promise.resolve();
  }

  setVolume(percent: number): Promise<void> {
    this.volumeChanges.push(percent);
    return Promise.resolve();
  }

  /* ---- test helpers ---- */

  /** Simulates a physical press. */
  pressButton(index: ButtonIndex): void {
    this.emit('buttonDown', { index });
  }

  /** Simulates a physical release. */
  releaseButton(index: ButtonIndex): void {
    this.emit('buttonUp', { index });
  }

  /** Simulates the transport or hardware going away. */
  goUnavailable(reason = 'test'): void {
    this.#available = false;
    this.emit('unavailable', { reason });
  }

  goAvailable(): void {
    this.#available = true;
    this.emit('available');
  }

  /** Cue names in play order — convenient for asserting audio sequences. */
  cueSequence(): AudioCue[] {
    return this.cuesPlayed.map((entry) => entry.cue);
  }

  /** Files played in order. */
  playSequence(): string[] {
    return this.filesPlayed.map((entry) => entry.path);
  }

  /** Forget all recorded activity, keeping current LED states. */
  clearHistory(): void {
    this.ledWrites.length = 0;
    this.cuesPlayed.length = 0;
    this.filesPlayed.length = 0;
    this.volumeChanges.length = 0;
    this.cancelledRecordings.length = 0;
    this.completedRecordings.length = 0;
  }
}
