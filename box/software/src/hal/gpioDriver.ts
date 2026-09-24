import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Device, Output, Watch } from 'opengpio';
import type { AudioCue } from '../audio/cues.ts';
import {
  CAPTURE_FILTER_CHAIN,
  PLAYBACK_DECODING,
  PLAYBACK_FILTER_CHAIN,
  toPlayableWav,
  toVoiceNote,
} from '../audio/ffmpeg.ts';
import { runProcess } from '../audio/process.ts';
import { cuePath } from '../audio/soundFiles.ts';
import type { ButtonIndex } from '../config/schema.ts';
import type {
  AmpSettings,
  Hal,
  HalEvents,
  HalOptions,
  PlaybackOutcome,
  RecordingHandle,
  RecordingResult,
} from './types.ts';
import type { Logger } from 'pino';

/**
 * ============================ UNVERIFIED ON HARDWARE ============================
 *
 * TODO(hardware): written against opengpio@2.0.2's published API,
 * but never run on a real Pi Zero 2 W. Work through `docs/hardware-bringup.md` before
 * trusting it. Most likely first failures:
 *   - LEDs inverted -> set LED_ACTIVE_HIGH=false.
 *   - Buttons read backwards or float -> the firmware pull-ups are not applied (see below).
 *   - ALSA device names differ -> set ALSA_CAPTURE_DEVICE / ALSA_PLAYBACK_DEVICE.
 *   - Pin names resolve to the wrong lines on a non-Zero board -> set PI_BOARD.
 *
 * Nothing above the HAL depends on any detail here, so bring-up stays contained.
 * ===============================================================================
 */

/**
 * BCM pin assignments (PRODUCT.md §2). Chosen to avoid the I2C/SPI/UART defaults so those
 * buses stay available, and grouped for tidy ribbon wiring.
 *
 * These are the **defaults**. `BUTTON_PINS` / `LED_PINS` below override them per device,
 * which is what lets a reduced MVP board run the same driver — see `docs/hardware.md`.
 */
export const GPIO_PINS = {
  /** Buttons: switch to ground, so the line idles HIGH and reads LOW when pressed. */
  buttons: ['GPIO17', 'GPIO27', 'GPIO22'] as const,
  /** LED drive lines. The lamps are 3 V, so they hang directly off these pins. */
  leds: ['GPIO23', 'GPIO24', 'GPIO25'] as const,
} as const;

/** Upper bound on either pin list: the product has exactly three channels. */
const MAX_CHANNELS = 3;

/**
 * Which opengpio board map to resolve pin names like "GPIO17" through.
 *
 * Every BCM283x board maps a BCM name to the same gpiochip0 line, so the Zero 2 W map is
 * correct on a 3B+ too — observed on 2026-08-10, where `gpioinfo` on a real 3B+ showed all
 * six lines claimed with the intended directions (PENDING.md). The override stays because
 * opengpio ships per-board maps and a future board may not agree: `PI_BOARD` takes any
 * board name it exports, and a wrong one fails at startup listing the valid ones.
 */
export const PI_BOARD = process.env['PI_BOARD'] ?? 'RaspberryPi_Zero2W';

/**
 * The pins actually wired on *this* device, in channel order (left, centre, right).
 *
 * A shorter list means fewer physical channels: the remaining logical channels still
 * exist everywhere above the HAL, they simply have no hardware behind them. An empty
 * value (`LED_PINS=`) claims no lines at all, which is the MVP case — a board with the
 * audio HAT's single button and no lamps.
 */
export const BUTTON_PINS = parsePinList('BUTTON_PINS', GPIO_PINS.buttons);
export const LED_PINS = parsePinList('LED_PINS', GPIO_PINS.leds);

/**
 * The lamp sits between its pin and ground, so the pin sources and a HIGH lights it.
 * Flip via env if a lamp went to 3V3 instead and the pin has to sink.
 */
export const LED_ACTIVE_HIGH = process.env['LED_ACTIVE_HIGH'] !== 'false';

/**
 * Buttons idle HIGH via a pull-up and read LOW when pressed. Set BUTTON_ACTIVE_LOW=false
 * if the switches are wired to 3V3 instead of ground.
 */
export const BUTTON_ACTIVE_LOW = process.env['BUTTON_ACTIVE_LOW'] !== 'false';

const ALSA_CAPTURE_DEVICE = process.env['ALSA_CAPTURE_DEVICE'] ?? 'default';
const ALSA_PLAYBACK_DEVICE = process.env['ALSA_PLAYBACK_DEVICE'] ?? 'default';
const ALSA_MIXER_CONTROL = process.env['ALSA_MIXER_CONTROL'] ?? 'PCM';
/** Capture-side mixer control. `Mic` on a USB adapter, `Capture` on the WM8960 codec. */
const ALSA_CAPTURE_MIXER_CONTROL = process.env['ALSA_CAPTURE_MIXER_CONTROL'] ?? 'Mic';

/**
 * The output stages below the DAC, if this card has any.
 *
 * **Unset by default, and that is the safe reading.** A USB adapter exposes one volume and
 * nothing else, so naming a control that does not exist would spend three `amixer` calls per
 * boot failing silently. `install.sh --audio-hat wm8960` writes all three.
 *
 * Why they exist at all: measured on the real HAT 2026-08-17, `Playback` was already at 0 dB
 * while `Speaker` sat at **−20 dB** and both class-D boosts at 0. The box was 26 dB quieter
 * than the hardware allows and `speakerVolumePercent` could not reach any of it, because
 * every one of those stages is *downstream* of the control it sets.
 */
const ALSA_AMP_MIXER_CONTROL = process.env['ALSA_AMP_MIXER_CONTROL'] ?? '';
const ALSA_AMP_DC_MIXER_CONTROL = process.env['ALSA_AMP_DC_MIXER_CONTROL'] ?? '';
const ALSA_AMP_AC_MIXER_CONTROL = process.env['ALSA_AMP_AC_MIXER_CONTROL'] ?? '';

/**
 * Capture format. The rate defaults to the encode target so a slow CPU never resamples.
 *
 * `CAPTURE_RATE` exists for codecs that cannot run capture and playback at different rates
 * at the same time. The WM8960 HAT is one: it is the clock consumer on a shared I2S bit
 * clock, and the cues are 48 kHz (`scripts/generate-sounds.ts`). Setting 48000 makes both
 * directions agree and lets ffmpeg resample during encode, which it already does. Costs a
 * larger intermediate WAV in tmpfs.
 *
 * The overlap that forced it is **gone**: the "pop" used to fire at `recordThresholdMs` while
 * capture was open, and now finishes before the microphone opens, so no cue shares the clock
 * with a recording any more. The value stays until a real device says otherwise — it is set by
 * `install.sh --audio-hat wm8960` and cannot be re-measured here. See `PENDING.md`.
 */
const CAPTURE_RATE = parseRate('CAPTURE_RATE', 16_000);
export const CAPTURE_FORMAT = { rate: CAPTURE_RATE, channels: 1, format: 'S16_LE' } as const;

/** Bytes in the canonical PCM WAV header `arecord -t wav` writes ahead of the samples. */
const WAV_HEADER_BYTES = 44;

/** `S16_LE`: two bytes per sample per channel. */
const CAPTURE_BYTES_PER_SAMPLE = 2;

/**
 * How much audio a capture WAV of `sizeBytes` holds, in whole milliseconds.
 *
 * From the file size rather than the header's own length fields: a capture that had to be
 * SIGKILLed never got its header finalised, but every sample it wrote is still on disk.
 * Exported for tests.
 */
export function wavDurationMs(sizeBytes: number, format = CAPTURE_FORMAT): number {
  const bytesPerSecond = format.rate * format.channels * CAPTURE_BYTES_PER_SAMPLE;
  return Math.round((Math.max(0, sizeBytes - WAV_HEADER_BYTES) / bytesPerSecond) * 1000);
}

/** Grace period for arecord to finalise its WAV header before we SIGKILL. */
const CAPTURE_FLUSH_TIMEOUT_MS = 2000;

/**
 * How long a stopped aplay gets to exit before SIGKILL. It has nothing to finalise, so this only
 * bounds how long a hung player can hold the device the next sound needs. Exported for tests.
 */
export const PLAYBACK_STOP_TIMEOUT_MS = 500;

/**
 * The container formats `aplay` can read by itself: WAV, AU/SND and VOC. It is not a
 * decoder — it hands PCM to ALSA.
 *
 * Anything else has to go through ffmpeg first, and **must**: given a file whose header it
 * does not recognise, `aplay` does not fail, it plays the bytes as raw PCM. An inbound
 * WhatsApp voice note is Ogg/Opus, so on the first real device every received message came
 * out as full-volume noise while `aplay` exited 0 and nothing was logged.
 */
const APLAY_CONTAINERS = new Set(['.wav', '.au', '.snd', '.voc']);

export class GpioHal extends EventEmitter<HalEvents> implements Hal {
  readonly name = 'gpio';

  readonly #recordingDirectory: string;
  readonly #amp: AmpSettings | null;
  readonly #captureFilter: string | null;
  readonly #playbackFilter: string | null;
  #volumePercent: number;
  #micGainPercent: number;
  #available = false;
  #counter = 0;

  readonly #ledLines: (Output | null)[] = [null, null, null];
  readonly #buttonWatches: (Watch | null)[] = [null, null, null];

  /** Note path -> the WAV `prepare()` decoded it into, both in the RAM disk. */
  readonly #decoded = new Map<string, string>();
  /** Serialises `prepare()`, so a boot's worth of notes is one decode at a time. */
  #prepareQueue: Promise<void> = Promise.resolve();

  #captureProcess: ChildProcess | null = null;
  #captureId: string | null = null;
  #playbackProcess: ChildProcess | null = null;
  /** Settles when {@link #playbackProcess} has exited, so a stop can wait for the device. */
  #playbackExited: Promise<void> | null = null;
  /** Bumped by every `stopPlayback()`, so a decode still in flight knows it was cancelled. */
  #playbackEpoch = 0;

  constructor(options: HalOptions) {
    super();
    this.#recordingDirectory = options.recordingDirectory;
    this.#volumePercent = options.volumePercent;
    this.#micGainPercent = options.micGainPercent;
    this.#amp = options.amp ?? null;
    // `undefined` means "not specified" and takes the shipped chain; `null` means "no filter".
    this.#captureFilter =
      options.captureFilter === undefined ? CAPTURE_FILTER_CHAIN : options.captureFilter;
    this.#playbackFilter =
      options.playbackFilter === undefined ? PLAYBACK_FILTER_CHAIN : options.playbackFilter;
  }

  get available(): boolean {
    return this.#available;
  }

  /**
   * Loads `opengpio` dynamically — it is an optionalDependency that only builds on Linux,
   * so a static import would break module load on every dev machine.
   */
  async init(): Promise<void> {
    await mkdir(this.#recordingDirectory, { recursive: true });

    const opengpio = await import('opengpio').catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        'opengpio unavailable — this driver needs a Pi with libgpiod v2 installed ' +
          `(apt install libgpiod3 on Trixie; the addon links -lgpiodcxx and will not ` +
          `build or load against libgpiod 1.x). Underlying error: ${detail}`,
      );
    });
    const { Edge } = opengpio;
    const board = resolveBoard(opengpio, PI_BOARD);

    for (const [index, pin] of LED_PINS.entries()) {
      this.#ledLines[index] = board.output(pin);
    }

    for (const [index, pin] of BUTTON_PINS.entries()) {
      /*
       * No options passed on purpose. opengpio@2.0.2 transposes `bias` and `debounce`
       * when calling its native binding, so requesting a pull-up here would instead set a
       * 4ms debounce and leave the line floating. Both concerns are handled properly
       * elsewhere: pull-ups come from the firmware (`gpio=17,27,22=ip,pu` in
       * /boot/firmware/config.txt, applied by scripts/provision.sh) and debouncing is
       * software-side in core/buttonInterpreter.ts.
       */
      const watch = board.watch(pin, Edge.Both);
      this.#buttonWatches[index] = watch;
      this.#attachButton(watch, toButtonIndex(index));
    }

    this.#available = true;
    // Amp stages first: they are downstream of the DAC, so setting them after would briefly
    // play the boot cue through whatever gain the card powered up with.
    await this.#applyAmpSettings();
    await this.setVolume(this.#volumePercent);
    await this.#applyMicGain();
    this.emit('available');
  }

  async dispose(): Promise<void> {
    await this.stopPlayback();
    await this.#stopCapture();

    // Prepared decodes are derived data, and a restart re-derives them from the notes.
    await Promise.all([...this.#decoded.keys()].map(async (path) => this.release(path)));

    // Contract: dispose leaves every LED off — before releasing the lines.
    for (const index of [0, 1, 2] as const) this.setLed(index, false);

    for (const line of [...this.#ledLines, ...this.#buttonWatches]) {
      line?.stop();
    }
    this.#ledLines.fill(null);
    this.#buttonWatches.fill(null);
    this.#available = false;
  }

  setLed(index: ButtonIndex, on: boolean): void {
    const line = this.#ledLines[index];
    if (!line) return;
    line.value = LED_ACTIVE_HIGH ? on : !on;
  }

  /**
   * Starts `arecord` writing WAV into the RAM disk. Opus encoding happens on stop so a Pi
   * Zero is never capturing and encoding at the same time.
   */
  startRecording(index: ButtonIndex): Promise<RecordingHandle> {
    if (this.#captureProcess) {
      return Promise.reject(new Error('gpio: a recording is already in progress'));
    }

    this.#counter += 1;
    const handle: RecordingHandle = {
      id: `rec-${this.#counter.toString(36)}`,
      index,
      startedAt: Date.now(),
    };

    const child = spawn(
      'arecord',
      [
        '-D',
        ALSA_CAPTURE_DEVICE,
        '-f',
        CAPTURE_FORMAT.format,
        '-r',
        String(CAPTURE_FORMAT.rate),
        '-c',
        String(CAPTURE_FORMAT.channels),
        '-t',
        'wav',
        this.#wavPath(handle.id),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    child.on('error', (error) => {
      this.#captureProcess = null;
      this.#captureId = null;
      this.emit('unavailable', { reason: `arecord failed: ${error.message}` });
    });

    this.#captureProcess = child;
    this.#captureId = handle.id;
    return Promise.resolve(handle);
  }

  async stopRecording(handle: RecordingHandle): Promise<RecordingResult> {
    if (this.#captureId !== handle.id) {
      throw new Error(`gpio: ${handle.id} is not the active recording`);
    }

    await this.#stopCapture();

    const wavPath = this.#wavPath(handle.id);
    const outputPath = join(this.#recordingDirectory, `${handle.id}.ogg`);

    try {
      /*
       * Measured from the audio, not the clock. `Date.now() - startedAt` here would include the
       * resume grace and — worse — the time `stopCapture` spent waiting, so a microphone that
       * delivered nothing still reported seconds and `MIN_USABLE_AUDIO_MS` could never catch it.
       */
      const durationMs = wavDurationMs((await stat(wavPath)).size);
      await toVoiceNote(wavPath, outputPath, this.#captureFilter, durationMs);
      const { size } = await stat(outputPath);
      return { path: outputPath, durationMs, byteLength: size };
    } finally {
      // The intermediate WAV is several times larger than the Opus output.
      await rm(wavPath, { force: true });
    }
  }

  async cancelRecording(handle: RecordingHandle): Promise<void> {
    if (this.#captureId === handle.id) await this.#stopCapture();
    await rm(this.#wavPath(handle.id), { force: true });
  }

  /**
   * Decodes a note ahead of the tap that plays it. Never rejects (HAL contract).
   *
   * This is the whole latency fix: a tap used to pay for an ffmpeg spawn and a full decode
   * before the first sample reached the speaker, on a machine where spawning anything is not
   * free. Doing it on arrival spends the same CPU while the child is not waiting.
   */
  async prepare(path: string): Promise<void> {
    if (APLAY_CONTAINERS.has(extname(path).toLowerCase())) return;
    if (this.#decoded.has(path)) return;

    /*
     * One at a time. Boot recovery restores every unread note at once, and a dozen concurrent
     * ffmpeg processes on a Pi Zero — to get ahead of a tap that may never come — would be
     * competing with the daemon coming up. Nobody awaits this, so the queue costs nothing.
     */
    this.#prepareQueue = this.#prepareQueue.then(async () => this.#decodeAhead(path));
    await this.#prepareQueue;
  }

  /** Drops a prepared decode. Never rejects (HAL contract). */
  async release(path: string): Promise<void> {
    const decodedPath = this.#decoded.get(path);
    if (decodedPath === undefined) return;
    this.#decoded.delete(path);
    await rm(decodedPath, { force: true }).catch(() => undefined);
  }

  /**
   * Plays a voice note. Decoded to WAV first unless it already is one — see
   * `APLAY_CONTAINERS`. `prepare()` will usually have done that already; when it has not, the
   * decode happens here and the file is cleaned up straight after.
   */
  async play(path: string): Promise<PlaybackOutcome> {
    await this.stopPlayback();

    if (APLAY_CONTAINERS.has(extname(path).toLowerCase())) {
      return this.#spawnPlayback(path);
    }

    /*
     * Checked on disk, not just in the map: these live in a RAM disk the purge also sweeps,
     * so a note old enough to outlive its own decode still has to play.
     */
    const prepared = this.#decoded.get(path);
    if (prepared !== undefined && (await exists(prepared))) {
      return this.#spawnPlayback(prepared);
    }
    this.#decoded.delete(path);

    /*
     * Decoded beside the note, in the same tmpfs: the RAM disk is the only writable path
     * either daemon has. The `play-` prefix keeps it out of `audio/recovery.ts`'s
     * `wa-<index>-<id>.ogg` pattern, so a leftover from a power cut is never mistaken for
     * an unread message — and `audio/purge.ts` already sweeps `.wav` here.
     */
    const decodedPath = this.#decodedPath(path);
    const epoch = this.#playbackEpoch;
    try {
      await toPlayableWav(path, decodedPath, PLAYBACK_DECODING, this.#playbackFilter);
      /*
       * A `stopPlayback()` that lands mid-decode has no process to kill, so it is honoured
       * here instead. Without this, a button pressed to interrupt the queue would start the
       * note playing a moment *after* the microphone opened. And it is an interruption, not a
       * success: the note was never heard, so it must not be counted as played.
       */
      if (epoch !== this.#playbackEpoch) return 'interrupted';
      return await this.#spawnPlayback(decodedPath);
    } finally {
      await rm(decodedPath, { force: true });
    }
  }

  async playCue(cue: AudioCue): Promise<void> {
    // Cues are short; letting them interrupt each other beats queueing them. That includes a
    // note — see the contract in types.ts. Always WAV (scripts/generate-sounds.ts), so they
    // never need decoding.
    await this.stopPlayback();
    await this.#spawnPlayback(cuePath(cue));
  }

  /**
   * Stops the player and waits until it has exited.
   *
   * Waiting is the point. The device is `plughw`, which only one process can open, so spawning
   * the next `aplay` while the last is still dying makes the new one fail with "device busy" —
   * and a failed note used to be counted as played and deleted. SIGKILL if it will not go.
   */
  async stopPlayback(): Promise<void> {
    this.#playbackEpoch += 1;
    const child = this.#playbackProcess;
    const exited = this.#playbackExited;
    this.#playbackProcess = null;
    this.#playbackExited = null;
    if (!child || !exited) return;

    child.kill('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    const escalated = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, PLAYBACK_STOP_TIMEOUT_MS);
      timer.unref();
    });
    await Promise.race([exited, escalated]);
    clearTimeout(timer);
  }

  /** Sets the ALSA mixer volume, 0-100. The schema bounds it; there is no other cap. */
  async setVolume(percent: number): Promise<void> {
    this.#volumePercent = percent;
    await runQuiet('amixer', ['-M', 'sset', ALSA_MIXER_CONTROL, `${percent}%`]);
  }

  /* ---- internals ---- */

  #attachButton(watch: Watch, index: ButtonIndex): void {
    watch.on('change', (value: boolean) => {
      const pressed = BUTTON_ACTIVE_LOW ? !value : value;
      this.emit(pressed ? 'buttonDown' : 'buttonUp', { index });
    });
  }

  /** SIGTERM first so arecord writes a valid WAV header; SIGKILL only as a fallback. */
  async #stopCapture(): Promise<void> {
    const child = this.#captureProcess;
    this.#captureProcess = null;
    this.#captureId = null;
    if (!child) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish();
      }, CAPTURE_FLUSH_TIMEOUT_MS);
      timer.unref();

      child.once('close', () => {
        clearTimeout(timer);
        finish();
      });

      child.kill('SIGTERM');
    });
  }

  async #spawnPlayback(path: string): Promise<PlaybackOutcome> {
    const child = spawn('aplay', ['-D', ALSA_PLAYBACK_DEVICE, '-q', path], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let markExited: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    this.#playbackProcess = child;
    this.#playbackExited = exited;

    /*
     * Only ever clears its *own* child. The old code nulled the field unconditionally, so a
     * note killed by a cue closed a moment after the cue's aplay had been spawned and wiped the
     * reference to it — the next stop then killed nothing, and the device stayed busy.
     */
    const forget = (): void => {
      if (this.#playbackProcess === child) {
        this.#playbackProcess = null;
        this.#playbackExited = null;
      }
      markExited?.();
    };

    return new Promise<PlaybackOutcome>((resolve, reject) => {
      let settled = false;

      child.on('error', (error) => {
        forget();
        if (settled) return;
        settled = true;
        reject(new Error(`aplay failed: ${error.message}`));
      });

      child.on('close', (code, signal) => {
        forget();
        if (settled) return;
        settled = true;
        // A stop arrives as a signal: not a failure, but not heard to the end either.
        if (signal !== null) resolve('interrupted');
        else if (code === 0) resolve('completed');
        else reject(new Error(`aplay exited with code ${String(code)}`));
      });
    });
  }

  /**
   * Sets the output stages below the DAC, skipping any this card does not name.
   *
   * Each is its own `amixer` call rather than one batched invocation: a control name that
   * does not exist fails the whole line, and batching would mean one wrong name silently
   * costing the others. Failures are non-fatal by the same rule as every other mixer call
   * here — a card without these stages is a supported configuration, not an error.
   */
  async #applyAmpSettings(): Promise<void> {
    if (!this.#amp) return;
    const stages: readonly [string, string][] = [
      [ALSA_AMP_MIXER_CONTROL, `${this.#amp.volumePercent}%`],
      // The boosts are 0-5 registers, not percentages; `-M` would rescale them into nonsense.
      [ALSA_AMP_DC_MIXER_CONTROL, String(this.#amp.boostDc)],
      [ALSA_AMP_AC_MIXER_CONTROL, String(this.#amp.boostAc)],
    ];
    for (const [control, value] of stages) {
      if (control.length === 0) continue;
      const mapped = control === ALSA_AMP_MIXER_CONTROL ? ['-M'] : [];
      await runQuiet('amixer', [...mapped, 'sset', control, value]);
    }
  }

  async #applyMicGain(): Promise<void> {
    // Capture control names vary by adapter and codec; failure here is not fatal.
    await runQuiet('amixer', [
      '-M',
      'sset',
      ALSA_CAPTURE_MIXER_CONTROL,
      `${this.#micGainPercent}%`,
      'cap',
    ]);
    /*
     * Unmuting is a separate call, not another word on the one above: a parameter the
     * adapter's control does not have would fail the whole line and take the gain with it.
     *
     * It has to happen at all because the WM8960's input PGAs power up muted (LINMUTE /
     * RINMUTE default to 1) and nothing else clears it — setting a percentage moves the
     * volume register and leaves the mute bit alone. The symptom is a recording of exactly
     * the right length containing pure silence.
     */
    await runQuiet('amixer', ['-q', 'sset', ALSA_CAPTURE_MIXER_CONTROL, 'cap', 'unmute']);
  }

  #wavPath(recordingId: string): string {
    return join(this.#recordingDirectory, `${recordingId}.wav`);
  }

  /** One `prepare()`'s worth of work. Never throws: it is the tail of a shared chain. */
  async #decodeAhead(path: string): Promise<void> {
    // Re-checked here, not only in `prepare()`: two calls for the same note can queue before
    // either has run.
    if (this.#decoded.has(path)) return;

    const decodedPath = this.#decodedPath(path);
    try {
      await toPlayableWav(path, decodedPath, PLAYBACK_DECODING, this.#playbackFilter);
      this.#decoded.set(path, decodedPath);
    } catch {
      // `play()` falls back to decoding on demand, exactly as it did before.
      await rm(decodedPath, { force: true }).catch(() => undefined);
    }
  }

  #decodedPath(path: string): string {
    return join(this.#recordingDirectory, `play-${stem(path)}.wav`);
  }
}

/** Whether a path is still on disk. The purge may have taken it. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A file's name without its directory or extension, for naming a derived file after it. */
function stem(path: string): string {
  return basename(path, extname(path));
}

/**
 * How long one `amixer` call may take. It writes a register and exits in milliseconds; one
 * that has not finished in five seconds is stuck on the card, and `init()` awaits these.
 */
export const AMIXER_TIMEOUT_MS = 5000;

/**
 * Runs a mixer command whose failure is not fatal. Mixer controls differ across audio adapters,
 * so a name this card lacks is a supported configuration, not an error.
 *
 * Non-fatal is not the same as silent. This used to discard stderr, which is why naming a
 * control the card does not have — `Master` on the WM8960, which has none — logged nothing at
 * all while the volume quietly stayed wherever the card powered up.
 */
async function runQuiet(command: string, args: readonly string[]): Promise<void> {
  try {
    await runProcess({ command, args, timeoutMs: AMIXER_TIMEOUT_MS });
  } catch (error: unknown) {
    const log = await halLogger();
    log.warn(
      { command, args, err: error instanceof Error ? error.message : String(error) },
      'mixer command failed; continuing without it',
    );
  }
}

let cachedLogger: Logger | undefined;

/**
 * The driver's logger, loaded on first use rather than at import. Importing the logger starts
 * pino's transport, and this module is imported — sometimes repeatedly, under
 * `vi.resetModules()` — by tests that never log anything.
 */
async function halLogger(): Promise<Logger> {
  if (cachedLogger) return cachedLogger;
  const { childLogger } = await import('../logger.ts');
  cachedLogger = childLogger('hal');
  return cachedLogger;
}

/**
 * Reads a comma-separated pin list from the environment.
 *
 * Unset falls back to the compiled-in default; **set but empty means none**, which is how a
 * board with no LEDs is expressed. Too many entries throws rather than truncating: a
 * silently dropped channel is a button that does nothing for no visible reason.
 */
function parsePinList(variable: string, fallback: readonly string[]): readonly string[] {
  const raw = process.env[variable];
  if (raw === undefined) return fallback;

  const pins = raw
    .split(',')
    .map((pin) => pin.trim())
    .filter((pin) => pin.length > 0);

  if (pins.length > MAX_CHANNELS) {
    throw new RangeError(
      `${variable} lists ${pins.length} pins but the device has ${MAX_CHANNELS} channels: ${raw}`,
    );
  }
  return pins;
}

/**
 * Reads a sample rate from the environment.
 *
 * Validated here rather than passed through, because `Number('')` is 0 and `Number('abc')` is
 * NaN — both would reach `arecord -r` and fail at the first recording with an ALSA error
 * nobody would trace back to a typo in the environment file.
 */
function parseRate(variable: string, fallback: number): number {
  const raw = process.env[variable];
  if (raw === undefined || raw === '') return fallback;

  const rate = Number(raw);
  if (!Number.isInteger(rate) || rate <= 0) {
    throw new RangeError(`${variable} must be a positive whole number of Hz, got: ${raw}`);
  }
  return rate;
}

/** The slice of an opengpio board map this driver uses. */
type BoardMap = Pick<typeof Device, 'output' | 'watch'>;

function isBoardMap(value: unknown): value is BoardMap {
  return typeof value === 'function' && 'output' in value && 'watch' in value;
}

/**
 * Finds a board map on the opengpio module by name.
 *
 * Resolved by string rather than destructured so `PI_BOARD` can name any board the
 * installed version ships, and so a wrong name reports the valid ones instead of failing
 * as an undefined pin lookup deep inside the addon.
 *
 * Exported because it is the only part of this driver that can be tested without a Pi.
 */
export function resolveBoard(module: object, name: string): BoardMap {
  const entries: [string, unknown][] = Object.entries(module);
  const found = entries.find(([key]) => key === name)?.[1];
  if (isBoardMap(found)) return found;

  const available = entries.filter(([, value]) => isBoardMap(value)).map(([key]) => key);
  throw new Error(
    `PI_BOARD=${name} is not a board this opengpio exports. Available: ${available.join(', ')}`,
  );
}

/** Narrows an iteration index over the fixed 3-pin arrays. */
function toButtonIndex(index: number): ButtonIndex {
  switch (index) {
    case 0:
      return 0;
    case 1:
      return 1;
    case 2:
      return 2;
    default:
      throw new RangeError(`button index out of range: ${index}`);
  }
}
