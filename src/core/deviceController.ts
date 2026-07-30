import { rm } from 'node:fs/promises';
import { AudioCue, shouldPlayCue } from '../audio/cues.ts';
import { AudioQueueManager, type QueuedNote } from '../audio/queueManager.ts';
import type { ConfigManager } from '../config/configManager.ts';
import { clampVolume, type ButtonIndex, type DeviceConfig } from '../config/schema.ts';
import type { Hal, RecordingHandle } from '../hal/types.ts';
import { ButtonInterpreter } from './buttonInterpreter.ts';
import { DeviceState, type DeviceStatus } from './deviceState.ts';
import { LedAnimator } from './ledAnimator.ts';
import { isWithinQuietHours, minutesUntilNextTransition } from './quietHours.ts';

/**
 * Wires the device together: HAL events in, intents out, LEDs and audio as a result.
 *
 * This is the only place that knows how the pieces relate, which keeps every other module
 * independently testable. It owns no I/O of its own — the HAL and ConfigManager do that.
 */

export type OutboundRequest = {
  readonly index: ButtonIndex;
  readonly path: string;
  readonly durationMs: number;
};

export type DeviceControllerOptions = {
  readonly hal: Hal;
  readonly config: ConfigManager;
  /** Ships a finished recording to WhatsApp. Resolves once accepted. */
  readonly send: (request: OutboundRequest) => Promise<void>;
  /** Tells the bridge a queue was played, so it can mark the messages read. */
  readonly markRead?: (index: ButtonIndex, messageIds: readonly string[]) => void;
};

/** How often the quiet-hours schedule is re-evaluated when no transition is imminent. */
const QUIET_HOURS_MAX_SLEEP_MS = 15 * 60 * 1000;

export class DeviceController {
  readonly state = new DeviceState();
  readonly queue: AudioQueueManager;

  readonly #hal: Hal;
  readonly #config: ConfigManager;
  readonly #interpreter: ButtonInterpreter;
  readonly #animator: LedAnimator;
  readonly #send: (request: OutboundRequest) => Promise<void>;
  readonly #markRead: ((index: ButtonIndex, ids: readonly string[]) => void) | undefined;

  /** In-flight captures, keyed by button. */
  readonly #captures = new Map<ButtonIndex, RecordingHandle>();
  /** messageId -> file path, so played notes can be deleted ahead of the TTL. */
  readonly #pathsByMessageId = new Map<string, string>();
  #quietHoursTimer: NodeJS.Timeout | null = null;
  #started = false;

  constructor(options: DeviceControllerOptions) {
    this.#hal = options.hal;
    this.#config = options.config;
    this.#send = options.send;
    this.#markRead = options.markRead;

    this.queue = new AudioQueueManager({
      hal: options.hal,
      // Silent mode gates cues only; playback itself always happens.
      playCues: () => !this.state.silentMode,
    });

    this.#interpreter = new ButtonInterpreter({
      maxRecordingSeconds: this.#audio().maxRecordingSeconds,
      hasUnread: (index) => this.state.hasUnread(index),
    });

    this.#animator = new LedAnimator(options.hal, this.state.snapshot());

    this.#wireState();
    this.#wireButtons();
    this.#wireInterpreter();
    this.#wireQueue();
    this.#wireConfig();
  }

  /** Begins LED animation and quiet-hours scheduling. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    await this.#hal.setVolume(this.volumePercent());
    this.#animator.start();
    this.#evaluateQuietHours();
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#quietHoursTimer) {
      clearTimeout(this.#quietHoursTimer);
      this.#quietHoursTimer = null;
    }
    this.#interpreter.reset();
    await this.queue.stop();
    this.#animator.stop();
    this.#animator.blank();
  }

  /** Which HAL driver is active, for the admin panel and logs. */
  get driverName(): string {
    return this.#hal.name;
  }

  /** Current output volume, always clamped to the configured safety cap. */
  volumePercent(): number {
    const audio = this.#audio();
    return clampVolume(audio.speakerVolumePercent, audio);
  }

  /** Lifecycle status, driven by the process layer as Wi-Fi and WhatsApp come up. */
  setStatus(status: DeviceStatus): void {
    this.state.setStatus(status);
  }

  /**
   * A voice note arrived for a contact.
   *
   * Synchronous on purpose. The blinking LED is the signal that matters, so queue and
   * state are updated immediately; the notify chime is fired without awaiting. Awaiting it
   * would serialise a burst of arrivals behind ~400ms of audio each, delaying the very
   * indication the child relies on. Overlapping chimes interrupt each other, so a burst
   * produces one sound rather than a pile-up.
   */
  handleIncoming(index: ButtonIndex, note: QueuedNote): void {
    this.queue.enqueue(index, note);
    this.#pathsByMessageId.set(note.messageId, note.path);
    this.state.addUnread(index);

    // A courtesy, and silenced at night.
    if (shouldPlayCue(AudioCue.Notify, this.state.silentMode)) {
      void this.#safeCue(AudioCue.Notify);
    }
  }

  /** Files still queued for playback, which the purge must not delete. */
  protectedFiles(): Set<string> {
    const paths = new Set<string>();
    for (const index of [0, 1, 2] as const) {
      for (const note of this.queue.peek(index)) paths.add(note.path);
    }
    return paths;
  }

  /* ---- wiring ---- */

  #wireState(): void {
    this.state.on('change', (snapshot) => {
      this.#animator.update(snapshot);
    });

    this.state.on('messageSent', ({ index }) => {
      this.#animator.flashSent(index);
    });

    this.state.on('silentModeChanged', () => {
      // A single chasing pass confirms the change without needing sound.
      this.#animator.playSilentTransition();
    });
  }

  #wireButtons(): void {
    this.#hal.on('buttonDown', ({ index }) => {
      this.#interpreter.handleButtonDown(index);
    });
    this.#hal.on('buttonUp', ({ index }) => {
      this.#interpreter.handleButtonUp(index);
    });
  }

  #wireInterpreter(): void {
    // Instant visual acknowledgement, before we know tap from hold.
    this.#interpreter.on('pressVisualOn', ({ index }) => {
      this.#animator.setPressed(index, true);
    });
    this.#interpreter.on('pressVisualOff', ({ index }) => {
      this.#animator.setPressed(index, false);
    });

    this.#interpreter.on('captureStart', ({ index }) => {
      void this.#beginCapture(index);
    });

    // Now certainly a recording: light it solid and play the pop.
    this.#interpreter.on('captureConfirmed', ({ index }) => {
      this.state.setRecording(index);
      if (shouldPlayCue(AudioCue.Pop, this.state.silentMode)) {
        void this.#safeCue(AudioCue.Pop);
      }
    });

    this.#interpreter.on('captureCommit', ({ index }) => {
      void this.#commitCapture(index);
    });

    this.#interpreter.on('captureCancel', ({ index }) => {
      void this.#discardCapture(index);
    });

    this.#interpreter.on('playQueue', ({ index }) => {
      void this.#playQueue(index);
    });

    this.#interpreter.on('cancelBeep', () => {
      if (shouldPlayCue(AudioCue.Oops, this.state.silentMode)) {
        void this.#safeCue(AudioCue.Oops);
      }
    });

    this.#interpreter.on('toggleSilent', () => {
      this.state.toggleSilent();
    });
  }

  #wireQueue(): void {
    this.queue.on('playbackStarted', ({ index }) => {
      this.state.setPlaying(index);
    });

    this.queue.on('queueDrained', ({ index, messageIds }) => {
      // Spec §1: the light goes out once the queue finishes.
      this.state.clearUnread(index);
      this.state.setPlaying(null);
      this.#markRead?.(index, messageIds);
      void this.#deletePlayed(messageIds, index);
    });

    this.queue.on('playbackAborted', () => {
      this.state.setPlaying(null);
    });
  }

  #wireConfig(): void {
    this.#config.on('change', (next) => {
      this.#interpreter.setMaxRecordingSeconds(next.audio.maxRecordingSeconds);
      void this.#hal.setVolume(clampVolume(next.audio.speakerVolumePercent, next.audio));
      // Quiet hours may have moved.
      this.#evaluateQuietHours();
    });
  }

  /* ---- capture lifecycle ---- */

  async #beginCapture(index: ButtonIndex): Promise<void> {
    if (this.#captures.has(index)) return;
    try {
      const handle = await this.#hal.startRecording(index);
      this.#captures.set(index, handle);
    } catch {
      // No microphone, or no browser attached. The press simply produces nothing.
      this.#captures.delete(index);
    }
  }

  async #commitCapture(index: ButtonIndex): Promise<void> {
    const handle = this.#captures.get(index);
    this.#captures.delete(index);
    this.state.setRecording(null);

    if (!handle) return;

    if (shouldPlayCue(AudioCue.Whoosh, this.state.silentMode)) {
      await this.#safeCue(AudioCue.Whoosh);
    }

    let path: string;
    let durationMs: number;
    try {
      const result = await this.#hal.stopRecording(handle);
      path = result.path;
      durationMs = result.durationMs;
    } catch {
      // Capture failed after the fact — tell the child nothing was sent.
      if (shouldPlayCue(AudioCue.Oops, this.state.silentMode)) {
        await this.#safeCue(AudioCue.Oops);
      }
      return;
    }

    try {
      await this.#send({ index, path, durationMs });
      this.state.reportMessageSent(index);
      if (shouldPlayCue(AudioCue.Swoosh, this.state.silentMode)) {
        await this.#safeCue(AudioCue.Swoosh);
      }
    } catch {
      // Delivery failed. The file stays for the purge to collect.
      if (shouldPlayCue(AudioCue.Oops, this.state.silentMode)) {
        await this.#safeCue(AudioCue.Oops);
      }
    }
  }

  async #discardCapture(index: ButtonIndex): Promise<void> {
    const handle = this.#captures.get(index);
    this.#captures.delete(index);
    if (this.state.recording === index) this.state.setRecording(null);
    if (!handle) return;

    try {
      await this.#hal.cancelRecording(handle);
    } catch {
      // Nothing more to do; the purge will collect any partial file.
    }
  }

  async #playQueue(index: ButtonIndex): Promise<void> {
    try {
      await this.queue.playQueue(index);
    } catch {
      this.state.setPlaying(null);
    }
  }

  /** Removes files for notes that have been heard, ahead of the 48h TTL. */
  async #deletePlayed(messageIds: readonly string[], index: ButtonIndex): Promise<void> {
    if (messageIds.length === 0) return;
    const stillQueued = new Set(this.queue.peek(index).map((note) => note.path));
    await Promise.all(
      this.#playedPaths(messageIds)
        .filter((path) => !stillQueued.has(path))
        .map((path) => rm(path, { force: true }).catch(() => undefined)),
    );
  }

  #playedPaths(messageIds: readonly string[]): string[] {
    const paths: string[] = [];
    for (const id of messageIds) {
      const path = this.#pathsByMessageId.get(id);
      if (path !== undefined) {
        paths.push(path);
        this.#pathsByMessageId.delete(id);
      }
    }
    return paths;
  }

  /* ---- quiet hours ---- */

  /**
   * Applies the schedule and sleeps exactly until the next boundary, rather than polling
   * every minute — on a device that runs for months, that adds up.
   */
  #evaluateQuietHours(): void {
    if (this.#quietHoursTimer) {
      clearTimeout(this.#quietHoursTimer);
      this.#quietHoursTimer = null;
    }
    if (!this.#started) return;

    const { quietHours } = this.#config.current;
    const now = new Date();
    this.state.setScheduledSilent(isWithinQuietHours(quietHours, now));

    const minutes = minutesUntilNextTransition(quietHours, now);
    if (minutes === null) return;

    // Cap the sleep so clock changes and DST shifts self-correct.
    const delay = Math.min(minutes * 60 * 1000, QUIET_HOURS_MAX_SLEEP_MS);
    this.#quietHoursTimer = setTimeout(() => {
      this.#evaluateQuietHours();
    }, delay);
    this.#quietHoursTimer.unref();
  }

  #audio(): DeviceConfig['audio'] {
    return this.#config.current.audio;
  }

  async #safeCue(cue: AudioCue): Promise<void> {
    try {
      await this.#hal.playCue(cue);
    } catch {
      // Cues are non-essential; never let one break the interaction.
    }
  }
}
