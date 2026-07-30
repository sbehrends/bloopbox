import type { EventEmitter } from 'node:events';
import type { AudioCue } from '../audio/cues.ts';
import type { ButtonIndex } from '../config/schema.ts';

/**
 * The Hardware Abstraction Layer contract (PRODUCT.md §4).
 *
 * Every physical interaction goes through here: buttons, LEDs **and audio**. Audio is part
 * of the HAL because the simulator captures and plays it in the browser while the real
 * device uses ALSA — the pipeline above must not know which.
 *
 * Implementations: `gpioDriver` (Pi), `simulatorDriver` (browser), `mockDriver` (tests).
 */

/* Cue vocabulary lives in audio/cues.ts so the browser can share it. */
export { AudioCue } from '../audio/cues.ts';
export type { AudioCue as AudioCueName } from '../audio/cues.ts';

/** An in-progress recording. Opaque to callers; only the driver interprets it. */
export type RecordingHandle = {
  readonly id: string;
  readonly index: ButtonIndex;
  readonly startedAt: number;
};

export type HalEvents = {
  /** A button was physically pressed. Debouncing happens above, in the interpreter. */
  buttonDown: [{ index: ButtonIndex }];
  buttonUp: [{ index: ButtonIndex }];
  /** The driver lost its hardware or transport (simulator browser disconnected, etc.). */
  unavailable: [{ reason: string }];
  /** The driver is usable again. */
  available: [];
};

/**
 * What the audio pipeline needs from a recording once it stops.
 * `path` is an .ogg/Opus file suitable for WhatsApp with `ptt: true`.
 */
export type RecordingResult = {
  readonly path: string;
  readonly durationMs: number;
  readonly byteLength: number;
};

/** The driver's own surface, without the event-emitter plumbing. */
export type HalCore = {
  /** Human-readable driver name for logs and the admin panel. */
  readonly name: string;

  /** True when the underlying hardware or transport is currently usable. */
  readonly available: boolean;

  /** Acquire pins / open devices. Safe to call once. */
  init(): Promise<void>;

  /** Release everything. Must leave all LEDs off. */
  dispose(): Promise<void>;

  /** Drive one LED. Called up to 20x/second by the animator, so keep it cheap. */
  setLed(index: ButtonIndex, on: boolean): void;

  /** Begin capturing microphone audio. */
  startRecording(index: ButtonIndex): Promise<RecordingHandle>;

  /** Stop capturing and finalise to .ogg/Opus. */
  stopRecording(handle: RecordingHandle): Promise<RecordingResult>;

  /** Abandon a recording and delete any partial file. */
  cancelRecording(handle: RecordingHandle): Promise<void>;

  /** Play an audio file to completion. Rejects if playback fails. */
  play(path: string): Promise<void>;

  /** Play a built-in cue to completion. */
  playCue(cue: AudioCue): Promise<void>;

  /** Stop any in-progress playback immediately. */
  stopPlayback(): Promise<void>;

  /** Set output volume as a percentage. Callers must clamp to the config cap first. */
  setVolume(percent: number): Promise<void>;
};

/**
 * A hardware driver: the core surface plus event subscription.
 *
 * The listener methods are borrowed from `EventEmitter<HalEvents>` rather than redeclared,
 * so any driver extending that class satisfies this type exactly — a hand-written
 * signature drifts from Node's and fails to match.
 */
export type Hal = HalCore &
  Pick<EventEmitter<HalEvents>, 'on' | 'off' | 'once' | 'removeAllListeners'>;

/** Options common to every driver. */
export type HalOptions = {
  /** Where recordings are written. Should be tmpfs on the device. */
  readonly recordingDirectory: string;
  /** Microphone gain, 0-100. */
  readonly micGainPercent: number;
  /** Initial output volume, 0-100, already clamped to the cap. */
  readonly volumePercent: number;
};
