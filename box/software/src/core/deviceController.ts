import { AudioCue, shouldPlayCue } from '../audio/cues.ts';
import { AudioQueueManager, type QueuedNote } from '../audio/queueManager.ts';
import { enabledContacts, type ButtonIndex, type DeviceConfig } from '../config/schema.ts';
import type { Hal, RecordingHandle } from '../hal/types.ts';
import { ButtonInterpreter } from './buttonInterpreter.ts';
import { DeviceState, type DeviceStatus } from './deviceState.ts';
import { LedAnimator } from './ledAnimator.ts';
import { isWithinQuietHours, msUntilNextTransition } from './quietHours.ts';

/**
 * Wires the device together: HAL events in, intents out, LEDs and audio as a result.
 *
 * This is the only place that knows how the pieces relate, which keeps every other module
 * independently testable. It owns no I/O of its own: the HAL, the config it is handed and
 * `deleteFile` do that, and the composition root decides what each of them is.
 *
 * Config is read when this is constructed and never re-read. Saving settings restarts the
 * daemon (see `requestRestart` in the hardware server), which is both simpler and safer than
 * reapplying values live: a partial live update — new timings but a stale volume, say — is a
 * state no test covers and no user can reason about.
 */

export type OutboundRequest = {
  readonly index: ButtonIndex;
  readonly path: string;
  readonly durationMs: number;
};

/**
 * Where the running totals go, as three synchronous calls this controller makes and nothing more.
 *
 * A structural type rather than an import of `StatsStore`, because `src/core/` may not do I/O and
 * must not acquire a dependency that does. The store satisfies this shape; a test passes an
 * array-pushing stub. Every method must return immediately and must never throw — these are
 * called on the interaction path, where a child is waiting for a lamp.
 */
export type StatsRecorder = {
  /** A voice note this box actually delivered. */
  recordSent(index: ButtonIndex, durationMs: number): void;
  /** A voice note that arrived and was queued. `durationMs` is null when WhatsApp gave none. */
  recordReceived(index: ButtonIndex, durationMs: number | null): void;
  /** Notes the child listened to, as a queue drains. */
  recordPlayed(index: ButtonIndex, count: number): void;
};

/**
 * Everything that can go wrong on the interaction path without the child noticing more than an
 * "oops" — or nothing at all.
 *
 * Each of these used to be caught and dropped here, which is the right answer for the child (one
 * failure must never break the next press) and the wrong one for whoever is debugging the box: the
 * journal said nothing. They are still caught; now they are also reported.
 */
export type DeviceFaultKind =
  /** `startRecording` rejected: no microphone, a busy device, a wrong ALSA name. */
  | 'capture-start'
  /** `stopRecording` rejected: the take could not be finalised or encoded. */
  | 'capture-finalise'
  /** The take finalised with essentially no audio — a microphone that delivered nothing. */
  | 'capture-empty'
  /** `cancelRecording` rejected. The purge collects whatever it left. */
  | 'capture-cancel'
  /** WhatsApp did not accept a finished take. */
  | 'send'
  /** A note could not be played, or playback itself threw. */
  | 'playback'
  /** A cue could not be played. Cues are courtesy, so this never reaches the child. */
  | 'cue'
  /** A played or revoked note's file, or its decoded copy, could not be removed. */
  | 'delete';

export type DeviceFault = {
  readonly kind: DeviceFaultKind;
  /** The button involved, where there is one. */
  readonly index: ButtonIndex | null;
  /** What was thrown, if anything was. */
  readonly error?: unknown;
  /** Small facts that explain it — a duration, a cue name, a path. */
  readonly detail?: Readonly<Record<string, string | number>>;
};

/** What the controller reads of the config. `ConfigManager` satisfies it; so does a literal. */
export type ConfigSnapshot = {
  readonly current: DeviceConfig;
};

export type DeviceControllerOptions = {
  readonly hal: Hal;
  readonly config: ConfigSnapshot;
  /**
   * Deletes a note's file: a played or revoked note, or a take too short to send. Resolves once
   * the file is gone, including when it never existed. A rejection is reported as a `delete`
   * fault and otherwise ignored, because the purge collects whatever is left.
   */
  readonly deleteFile: (path: string) => Promise<void>;
  /** Ships a finished recording to WhatsApp. Resolves once accepted. */
  readonly send: (request: OutboundRequest) => Promise<void>;
  /** Tells the bridge a queue was played, so it can mark the messages read. */
  readonly markRead?: (index: ButtonIndex, messageIds: readonly string[]) => void;
  /** Counts what the box sent, received and played. Absent means nothing is counted. */
  readonly stats?: StatsRecorder;
  /**
   * Told about every failure this controller swallows (see {@link DeviceFault}).
   *
   * A callback rather than a logger for the same reason `stats` is a structural type: `src/core/`
   * does no I/O, and the composition root decides where faults go. Called synchronously on the
   * interaction path, so it must return at once; anything it throws is ignored.
   */
  readonly onFault?: (fault: DeviceFault) => void;
  /**
   * Holds scheduled quiet hours off until {@link DeviceController.markClockSynced} is called.
   *
   * A Pi has no real-time clock: until NTP answers it runs on the time its last shutdown saved,
   * and a schedule read off that clock can be hours wrong. So on a real device the box stays
   * audible until the time is known (PRODUCT.md §7). Off by default, for the simulator and the
   * tests, whose clocks are right.
   */
  readonly awaitClockSync?: boolean;
};

/** How often the quiet-hours schedule is re-evaluated when no transition is imminent. */
export const QUIET_HOURS_MAX_SLEEP_MS = 15 * 60 * 1000;

/**
 * Below this much audio, a committed take is a failed capture rather than a short message.
 *
 * Not in the config schema, unlike every press timing, because it is not a feel judgement a
 * parent could have an opinion about: it separates "the microphone produced something" from
 * "the microphone produced nothing". How long a press has to be to count as a message is
 * `buttons.minRecordingMs`, and the interpreter has already applied it to held time by the
 * time a commit arrives here.
 *
 * Deliberately far below that: the bip plays before capture opens and ALSA takes its own
 * moment after, so a take that just clears the interpreter's boundary legitimately arrives
 * shorter than `minRecordingMs`. Exported so tests assert against the same number.
 */
export const MIN_USABLE_AUDIO_MS = 150;

/**
 * One press's microphone, from the bip until it is committed or discarded.
 *
 * `token.cancelled` is what the bip checks before it opens anything. Awaiting the handle alone
 * was not enough: a discard during the bip waited for it, found no handle yet, and returned —
 * and then the bip finished and opened a microphone nobody would ever close, on top of the
 * "oops" the release had just played, or after `stop()`.
 */
type Capture = {
  readonly handle: Promise<RecordingHandle | null>;
  readonly token: { cancelled: boolean };
};

export class DeviceController {
  readonly state = new DeviceState();
  readonly queue: AudioQueueManager;

  readonly #hal: Hal;
  readonly #config: ConfigSnapshot;
  readonly #deleteFile: (path: string) => Promise<void>;
  readonly #interpreter: ButtonInterpreter;
  readonly #animator: LedAnimator;
  readonly #send: (request: OutboundRequest) => Promise<void>;
  readonly #markRead: ((index: ButtonIndex, ids: readonly string[]) => void) | undefined;
  readonly #stats: StatsRecorder | undefined;
  readonly #onFault: ((fault: DeviceFault) => void) | undefined;

  /**
   * In-flight captures, keyed by button.
   *
   * The *promise* rather than the handle, because a capture is routinely cancelled before the
   * HAL has finished opening it. Two ways that happens: the silent-mode chord makes
   * `ButtonInterpreter` emit `captureCancel` synchronously, and the bip now runs *inside* this
   * promise, so any release during those 90 ms lands on a capture that has not opened yet.
   * Storing the handle only once it resolves let that cancel find nothing and return, which
   * left the microphone open for the life of the process — and the next press on that button
   * reused the stale handle, shipping every second recorded since as one voice note.
   */
  readonly #captures = new Map<ButtonIndex, Capture>();
  /** messageId -> file path, so played notes can be deleted ahead of the TTL. */
  readonly #pathsByMessageId = new Map<string, string>();
  /** The most recent capture teardown, awaited before playback. See `#playQueue`. */
  #teardown: Promise<void> | undefined;
  /**
   * The button whose queue a tap asked for, from that tap until playback ends.
   *
   * Not `state.playing`, which is only set once the first note starts: between the two sits
   * the capture teardown `#playQueue` waits on, and a press on another button in that gap
   * would open a microphone just as the note begins.
   */
  #listeningTo: ButtonIndex | null = null;
  #quietHoursTimer: NodeJS.Timeout | null = null;
  /**
   * What the schedule said at the last evaluation, or null before the first.
   *
   * The schedule is applied only when this *changes*. Re-asserting it on every wake — every
   * 15 minutes at most — silently undid a parent's chord: they forced sound back on at 21:00
   * and the box went quiet again by 21:15. An override now lasts until the next boundary.
   */
  #scheduleInWindow: boolean | null = null;
  /** Whether the wall clock can be trusted for the schedule. Latches; see `markClockSynced`. */
  #clockSynced: boolean;
  #started = false;

  constructor(options: DeviceControllerOptions) {
    this.#hal = options.hal;
    this.#config = options.config;
    this.#deleteFile = options.deleteFile;
    this.#send = options.send;
    this.#markRead = options.markRead;
    this.#stats = options.stats;
    this.#onFault = options.onFault;
    this.#clockSynced = options.awaitClockSync !== true;

    this.queue = new AudioQueueManager({
      hal: options.hal,
      // Silent mode gates cues only; playback itself always happens.
      playCues: () => !this.state.silentMode,
      onPlaybackError: (index, path, error) => {
        this.#fault('playback', index, error, { path });
      },
    });

    // Buttons with a contact to send to: enabled, with a target that resolves.
    const sendable = new Set(enabledContacts(this.#config.current).map(({ index }) => index));
    this.#interpreter = new ButtonInterpreter({
      timings: this.#config.current.buttons,
      maxRecordingSeconds: this.#audio().maxRecordingSeconds,
      hasUnread: (index) => this.state.hasUnread(index),
      // Receive-only: no hold ever opens a microphone. Snapshot like every other setting.
      readOnly: this.#config.current.mode.readOnly,
      // A button with no contact takes no message. Snapshot, like every other setting.
      canSend: (index) => sendable.has(index),
      // While notes play, the other buttons wait for them to finish.
      listeningTo: () => this.#listeningTo,
    });

    this.#animator = new LedAnimator(options.hal, this.state.snapshot());

    this.#wireState();
    this.#wireButtons();
    this.#wireInterpreter();
    this.#wireQueue();
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
    /*
     * `reset()` drops the presses without emitting a cancel, so the captures they opened are
     * closed here — including one still behind its bip, which the token keeps from opening a
     * microphone after the process has been told to stop.
     */
    await Promise.all([...this.#captures.keys()].map((index) => this.#discardCapture(index)));
    await this.queue.stop();
    this.#animator.stop();
    this.#animator.blank();
  }

  /**
   * Stops, then lets go of the HAL for good: its button listeners are removed, so a press
   * reaches nothing here any more.
   *
   * Separate from `stop()` because the listeners are attached at construction, not at
   * `start()` — a stopped controller cannot get them back. Anything that builds a second
   * controller on the same HAL must dispose of the first, or both answer every press: two bips,
   * two microphones, two sends. The daemon never does, since a config save restarts the process.
   */
  async dispose(): Promise<void> {
    this.#hal.off('buttonDown', this.#onButtonDown);
    this.#hal.off('buttonUp', this.#onButtonUp);
    await this.stop();
  }

  /** Which HAL driver is active, for the admin panel and logs. */
  get driverName(): string {
    return this.#hal.name;
  }

  /** Current output volume. The schema bounds it to 0-100; there is nothing else to apply. */
  volumePercent(): number {
    return this.#audio().speakerVolumePercent;
  }

  /** Lifecycle status, driven by the process layer as Wi-Fi and WhatsApp come up. */
  setStatus(status: DeviceStatus): void {
    this.state.setStatus(status);
  }

  /**
   * Says hello, once, as the boot window opens.
   *
   * The LED chase already announces a boot, but only to someone looking at the box. This is
   * the sound that tells a parent across the room that the power cut is over and the device
   * came back on its own — the one piece of feedback a screenless appliance cannot express
   * any other way. Silenced at night like every other courtesy cue.
   */
  announceBoot(): void {
    // Not awaited: nothing about coming up should wait on a speaker.
    void this.#courtesyCue(AudioCue.Boot);
  }

  /**
   * Plays the boot cue on demand, so the admin panel can prove the speaker works.
   *
   * **Deliberately ignores silent mode**, which is the whole difference between this and
   * `announceBoot()`. Someone tuning the amplifier stages is standing at the box asking a
   * direct question; a test button that silently does nothing because quiet hours started an
   * hour ago answers it wrongly, and on a device with no screen there is nothing to say so.
   *
   * Awaited, unlike every other cue here, because the caller is an HTTP request that should
   * not report success before the sound has actually come out.
   */
  async playTestCue(): Promise<void> {
    await this.#hal.playCue(AudioCue.Boot);
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
    // A redelivery, or one the boot scan already restored: nothing new to announce.
    if (!this.restoreUnread(index, note)) return;

    /*
     * Counted here rather than in `restoreUnread`, which is the whole reason the two are
     * separate methods: the boot scan calls that one directly to put yesterday's unheard notes
     * back, and a total that grew by three every time the box restarted would be worthless.
     * This path is only ever a note that has genuinely just arrived.
     */
    this.#stats?.recordReceived(index, note.durationMs);

    /*
     * A courtesy, silenced at night, held back while a note is playing (the speaker is one
     * output, and the chime would cut the note off) and while a microphone is open, from the bip
     * to the end of the carry-on window: the speaker sits centimetres from the microphone, so a
     * chime then is recorded into the child's message. Either way the lamp already says something
     * new is waiting. Dropped, not deferred: a chime after the child lets go would announce a note
     * they can already see blinking.
     */
    if (this.#captures.size > 0) return;
    void this.#courtesyCue(AudioCue.Notify);
  }

  /**
   * Puts a note back on a button without announcing it.
   *
   * Used at boot to rebuild a queue a restart would otherwise have dropped. Deliberately
   * silent: nothing has *arrived*, and a box that chimed its way through the backlog every
   * time it restarted would teach a parent to distrust the sound. The blinking LED is the
   * right signal — it says "there is something waiting", which is exactly true.
   *
   * Returns false if the note was already queued, so the unread count follows the queue rather
   * than counting arrivals. Both can happen to one note: the boot scan restores it from disk,
   * and then the bridge reconnects and flushes the delivery it buffered while the daemon was
   * down. The queue holds one; the count must say one.
   */
  restoreUnread(index: ButtonIndex, note: QueuedNote): boolean {
    if (!this.queue.enqueue(index, note)) return false;
    this.#pathsByMessageId.set(note.messageId, note.path);
    this.state.addUnread(index);
    /*
     * Decode it now rather than when the button is tapped. Arrival is the one moment nobody
     * is waiting — the lamp is already blinking and the child may not come for minutes —
     * whereas a tap is the moment they are least able to wait. Not awaited, and it never
     * rejects; `hal.play()` still copes if it has not finished, or never ran.
     */
    void this.#hal.prepare(note.path);
    return true;
  }

  /**
   * The sender deleted a note for everyone (PRODUCT.md §1): take it off the button and the card.
   *
   * Only a note this box is still holding for that button — an id it never queued, or queued on
   * a different button, does nothing, so a revoke can only ever remove what its own chat sent.
   * A note already playing is left to finish (see `AudioQueueManager.remove`) and is then deleted
   * as heard, like any other. Never marked read: nothing was heard.
   *
   * Returns whether anything was removed.
   */
  revokeNote(index: ButtonIndex, messageId: string): boolean {
    const note = this.queue.remove(index, messageId);
    if (note === null) return false;
    this.#pathsByMessageId.delete(messageId);
    // The count follows the queue, as it does after playback: the lamp goes out if that was all.
    this.state.setUnread(index, this.queue.count(index));
    void this.#discard(note.path);
    return true;
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

  // Fields rather than inline closures, so `dispose()` can hand the same functions to `off`.
  readonly #onButtonDown = ({ index }: { index: ButtonIndex }): void => {
    this.#interpreter.handleButtonDown(index);
  };
  readonly #onButtonUp = ({ index }: { index: ButtonIndex }): void => {
    this.#interpreter.handleButtonUp(index);
  };

  #wireButtons(): void {
    this.#hal.on('buttonDown', this.#onButtonDown);
    this.#hal.on('buttonUp', this.#onButtonUp);
  }

  #wireInterpreter(): void {
    // Instant visual acknowledgement, before we know tap from hold.
    this.#interpreter.on('pressVisualOn', ({ index }) => {
      this.#animator.setPressed(index, true);
    });
    this.#interpreter.on('pressVisualOff', ({ index }) => {
      this.#animator.setPressed(index, false);
    });

    // Now certainly a recording: light it solid, bip, and open the microphone behind the bip.
    this.#interpreter.on('captureConfirmed', ({ index }) => {
      this.state.setRecording(index);
      this.#beginCapture(index);
    });

    /*
     * Back inside the resume window. The capture was never stopped, so there is nothing to
     * restart and deliberately no cue: the child hears silence and sees the same solid LED,
     * which is exactly what "keep talking" should look like. Re-asserting the recording
     * state is belt and braces — nothing clears it until the take commits.
     */
    this.#interpreter.on('captureResumed', ({ index }) => {
      this.state.setRecording(index);
    });

    /*
     * A hold refused at the threshold — a read-only box, or notes still waiting on that
     * button. The "oops" rather than a cue of its own: to a child both are the same fact the
     * double-beep already carries — *that did not send* — and a second negative sound would
     * be one more thing to learn for no extra information. The blinking lamp is what says
     * why, and it is already lit. Silenced during quiet hours exactly like the rest of them.
     */
    this.#interpreter.on('recordBlocked', () => {
      /*
       * Except while one of those notes is actually playing, which `#courtesyCue` holds back.
       * The child is being told to listen; an "oops" over the top would cut the message off.
       * The lamp under their finger is the whole answer.
       */
      void this.#courtesyCue(AudioCue.Oops);
    });

    this.#interpreter.on('captureCommit', ({ index }) => {
      void this.#commitCapture(index);
    });

    this.#interpreter.on('captureCancel', ({ index }) => {
      // Kept so `#playQueue` can wait for the microphone to actually be closed — a tap past
      // `recordThresholdMs` opens one before it turns out to be a tap, and `playQueue`
      // follows this event in the very same tick.
      this.#teardown = this.#discardCapture(index);
    });

    this.#interpreter.on('playQueue', ({ index }) => {
      void this.#playQueue(index);
    });

    this.#interpreter.on('cancelBeep', () => {
      void this.#courtesyCue(AudioCue.Oops);
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
      /*
       * Spec §1: the light goes out once the queue finishes — unless a note arrived while it
       * played. The count follows the queue rather than being zeroed: clearing it put that
       * note's lamp out, and a tap on the dark button then got the "oops".
       */
      this.state.setUnread(index, this.queue.count(index));
      this.state.setPlaying(null);
      this.#notesHeard(index, messageIds);
    });

    /*
     * Stopped part-way. What was heard to the end is handled exactly like a drain; the rest,
     * the cut-off note included, is back in the queue and still blinking.
     */
    this.queue.on('playbackAborted', ({ index, messageIds }) => {
      this.state.setUnread(index, this.queue.count(index));
      this.state.setPlaying(null);
      this.#notesHeard(index, messageIds);
    });
  }

  /** Notes the child listened to the end of: receipt, count, and delete. */
  #notesHeard(index: ButtonIndex, messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    /*
     * The receipt is the only way the sender learns a child heard them, and a parent can turn
     * it off — playing a message should never depend on whether we are willing to report it,
     * so the local half happens either way.
     */
    if (this.#config.current.whatsapp.markPlayedAsRead) {
      this.#markRead?.(index, messageIds);
    }
    // Local and unconditional, unlike the receipt above: what the child heard is this box's
    // own business, and a parent who turned receipts off has not asked to stop counting.
    this.#stats?.recordPlayed(index, messageIds.length);
    void this.#deletePlayed(messageIds, index);
  }

  /* ---- capture lifecycle ---- */

  /**
   * Plays the "pop" and *then* opens the microphone.
   *
   * The order is the whole point: the speaker is centimetres from the microphone, so a cue
   * played while capture is open is recorded into the message — and this one fires 150 ms in,
   * where it landed on top of the child's first word. Waiting for it costs the 90 ms the bip
   * takes, and buys a message that starts where the child was actually invited to start.
   *
   * Both steps live inside the stored promise rather than being awaited here, because
   * `#commitCapture` and `#discardCapture` already await it (see `#captures`): a button
   * released during the bip finds a capture that is still opening and tears it down properly,
   * which is exactly the case the promise was introduced for. What it finds is the token, not
   * yet a microphone: the discard marks it cancelled, and the bip, once it ends, opens nothing.
   */
  #beginCapture(index: ButtonIndex): void {
    if (this.#captures.has(index)) return;
    const silent = this.state.silentMode;
    const token = { cancelled: false };
    // No microphone, or no browser attached: the press simply produces nothing, and the
    // null is what commit and discard below check for.
    const handle = (async (): Promise<RecordingHandle | null> => {
      if (shouldPlayCue(AudioCue.Pop, silent)) await this.#safeCue(AudioCue.Pop);
      if (token.cancelled) return null;
      return await this.#hal.startRecording(index).catch((error: unknown) => {
        this.#fault('capture-start', index, error);
        return null;
      });
    })();
    this.#captures.set(index, { handle, token });
  }

  async #commitCapture(index: ButtonIndex): Promise<void> {
    const pending = this.#captures.get(index);
    this.#captures.delete(index);
    this.state.setRecording(null);

    const handle = pending ? await pending.handle : null;
    if (!handle) return;

    /*
     * Finalise the capture *before* the "whoosh". The cue comes out of a speaker sitting
     * next to the microphone, so playing it first records it into the tail of every
     * message. It also means a take rejected below for being too short now gets only the
     * "oops" rather than a send sound followed by a failure sound.
     */
    let path: string;
    let durationMs: number;
    try {
      const result = await this.#hal.stopRecording(handle);
      path = result.path;
      durationMs = result.durationMs;
    } catch (error: unknown) {
      // Capture failed after the fact — tell the child nothing was sent.
      this.#fault('capture-finalise', index, error);
      await this.#courtesyCue(AudioCue.Oops);
      return;
    }

    /*
     * The interpreter has already ruled on length — it only commits a press that held the
     * microphone open long enough to carry a message. What it cannot see is whether the
     * microphone actually delivered, so this is the one thing left to check: a file with
     * essentially nothing in it is a failed capture, and answering "oops" is more honest than
     * sending a click.
     */
    if (durationMs < MIN_USABLE_AUDIO_MS) {
      // Not an exception, but the one signal that a microphone is delivering nothing at all.
      this.#fault('capture-empty', index, undefined, { durationMs });
      await this.#deleteFile(path).catch((error: unknown) => {
        this.#fault('delete', index, error, { path });
      });
      await this.#courtesyCue(AudioCue.Oops);
      return;
    }

    /*
     * One sound for a send, played once the take is safely finalised.
     *
     * There used to be a second — a "delivered" cue after WhatsApp accepted it — and back to
     * back the two read as one confused noise rather than two facts. Delivery is still
     * reported, visually: `reportMessageSent` flashes the lamp. Only a *failure* now adds a
     * second sound, which is the case actually worth interrupting a child for.
     */
    /*
     * Held back if the child has already moved on to listening — finalising takes seconds on
     * the Pi, and a whoosh then would cut off the note they tapped for. The lamp still flashes
     * on delivery.
     */
    await this.#courtesyCue(AudioCue.Whoosh);

    try {
      await this.#send({ index, path, durationMs });
      this.state.reportMessageSent(index);
      // Only a send WhatsApp accepted. A failed one already told the child "oops"; counting it
      // would make the panel disagree with what the box actually did.
      this.#stats?.recordSent(index, durationMs);
    } catch (error: unknown) {
      this.#fault('send', index, error);
      // Delivery failed. The file stays for the purge to collect. The "oops" can arrive up to a
      // minute later, which is exactly when the child may be listening to something else.
      await this.#courtesyCue(AudioCue.Oops);
    }
  }

  async #discardCapture(index: ButtonIndex): Promise<void> {
    const pending = this.#captures.get(index);
    this.#captures.delete(index);
    if (this.state.recording === index) this.state.setRecording(null);
    if (!pending) return;

    // Set before the await: a capture still behind its bip then never opens at all.
    pending.token.cancelled = true;
    // Waits for a capture that is still opening, rather than walking away from it.
    const handle = await pending.handle;
    if (!handle) return;

    try {
      await this.#hal.cancelRecording(handle);
    } catch (error: unknown) {
      // Nothing more to do; the purge will collect any partial file.
      this.#fault('capture-cancel', index, error);
    }
  }

  async #playQueue(index: ButtonIndex): Promise<void> {
    // A second tap on the playing button asks for what is already playing. Returning here
    // also keeps its `finally` from releasing the lock while the first run is still going.
    if (this.#listeningTo !== null) return;
    // Set before the first await, in the same tick as the tap's release.
    this.#listeningTo = index;

    /*
     * Let any microphone this press opened close first. On the WM8960 both directions hang
     * off one I2S clock, so starting a note while `arecord` is still being torn down asks the
     * codec for two things at once. `#discardCapture` swallows its own errors, so this only
     * ever waits — and it is a SIGTERM and a process exit, not audio.
     */
    try {
      await this.#teardown;
      await this.queue.playQueue(index);
    } catch (error: unknown) {
      this.#fault('playback', index, error);
      this.state.setPlaying(null);
    } finally {
      this.#listeningTo = null;
    }
  }

  /** Removes files for notes that have been heard, ahead of the 48h TTL. */
  async #deletePlayed(messageIds: readonly string[], index: ButtonIndex): Promise<void> {
    if (messageIds.length === 0) return;
    const stillQueued = new Set(this.queue.peek(index).map((note) => note.path));
    await Promise.all(
      this.#playedPaths(messageIds)
        .filter((path) => !stillQueued.has(path))
        .map(async (path) => {
          await this.#deleteFile(path).catch((error: unknown) => {
            this.#fault('delete', index, error, { path });
          });
          // The decode `prepare()` made is derived from a file that no longer exists.
          await this.#hal.release(path);
        }),
    );
  }

  /** Deletes one note's file and the decode `prepare()` made of it. Never rejects. */
  async #discard(path: string): Promise<void> {
    await this.#deleteFile(path).catch((error: unknown) => {
      this.#fault('delete', null, error, { path });
    });
    await this.#hal.release(path).catch((error: unknown) => {
      this.#fault('delete', null, error, { path });
    });
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
   * The wall clock has been set from the network, so the schedule can be read off it.
   *
   * One-way for the life of the process: a clock that was right once stays right when NTP later
   * loses its server, and dropping quiet hours mid-night over that would wake the room.
   */
  markClockSynced(): void {
    if (this.#clockSynced) return;
    this.#clockSynced = true;
    this.#evaluateQuietHours();
  }

  /**
   * Applies the schedule on its edges and sleeps exactly until the next boundary, rather than
   * polling every minute — on a device that runs for months, that adds up.
   *
   * Only an edge applies it (see `#scheduleInWindow`): the capped wake-ups in between exist to
   * catch clock changes, not to overrule the chord.
   */
  #evaluateQuietHours(): void {
    if (this.#quietHoursTimer) {
      clearTimeout(this.#quietHoursTimer);
      this.#quietHoursTimer = null;
    }
    if (!this.#started) return;

    // An unsynced clock applies no schedule and needs no timer: `markClockSynced` wakes this.
    if (!this.#clockSynced) return;

    const { quietHours } = this.#config.current;
    const now = new Date();
    const inWindow = isWithinQuietHours(quietHours, now);
    if (inWindow !== this.#scheduleInWindow) {
      this.#scheduleInWindow = inWindow;
      this.state.setScheduledSilent(inWindow);
    }

    const untilBoundary = msUntilNextTransition(quietHours, now);
    if (untilBoundary === null) return;

    // Cap the sleep so clock changes and DST shifts self-correct.
    const delay = Math.min(untilBoundary, QUIET_HOURS_MAX_SLEEP_MS);
    this.#quietHoursTimer = setTimeout(() => {
      this.#evaluateQuietHours();
    }, delay);
    this.#quietHoursTimer.unref();
  }

  #audio(): DeviceConfig['audio'] {
    return this.#config.current.audio;
  }

  /**
   * Every cue that tells the child something, through one gate.
   *
   * Two rules, and this is the only place either is applied. Silent mode suppresses it
   * (`shouldPlayCue`). And **nothing plays over a note**: the speaker is one output, a cue cuts
   * off whatever is playing (`HalCore.playCue`), and a note cut off by a chime used to be counted
   * as heard, deleted and reported read to its sender. While a queue plays, the lamp says
   * everything these would. The bip, which the lockout keeps from ever coinciding with
   * playback, and the admin panel's speaker test are the only cues that do not come through here.
   */
  async #courtesyCue(cue: AudioCue): Promise<void> {
    if (!shouldPlayCue(cue, this.state.silentMode)) return;
    if (this.#listeningTo !== null) return;
    await this.#safeCue(cue);
  }

  async #safeCue(cue: AudioCue): Promise<void> {
    try {
      await this.#hal.playCue(cue);
    } catch (error: unknown) {
      // Cues are non-essential; never let one break the interaction.
      this.#fault('cue', null, error, { cue });
    }
  }

  /** Reports a swallowed failure. A reporter that throws must not break the press either. */
  #fault(
    kind: DeviceFaultKind,
    index: ButtonIndex | null,
    error?: unknown,
    detail?: Readonly<Record<string, string | number>>,
  ): void {
    try {
      this.#onFault?.({
        kind,
        index,
        ...(error === undefined ? {} : { error }),
        ...(detail === undefined ? {} : { detail }),
      });
    } catch {
      // Deliberately silent: reporting is the one thing here that is allowed to fail quietly.
    }
  }
}
