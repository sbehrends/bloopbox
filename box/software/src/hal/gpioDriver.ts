import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Output, Watch } from 'opengpio';
import type { AudioCue } from '../audio/cues.ts';
import { toVoiceNote } from '../audio/ffmpeg.ts';
import { cuePath } from '../audio/soundFiles.ts';
import type { ButtonIndex } from '../config/schema.ts';
import type { Hal, HalEvents, HalOptions, RecordingHandle, RecordingResult } from './types.ts';

/**
 * ============================ UNVERIFIED ON HARDWARE ============================
 *
 * TODO(hardware): written against opengpio@2.0.2's published API and the ULN2003 datasheet,
 * but never run on a real Pi Zero 2 W. Work through `docs/hardware-bringup.md` before
 * trusting it. Most likely first failures:
 *   - LEDs inverted -> set LED_ACTIVE_HIGH=false.
 *   - Buttons read backwards or float -> the firmware pull-ups are not applied (see below).
 *   - ALSA device names differ -> set ALSA_CAPTURE_DEVICE / ALSA_PLAYBACK_DEVICE.
 *
 * Nothing above the HAL depends on any detail here, so bring-up stays contained.
 * ===============================================================================
 */

/**
 * BCM pin assignments (PRODUCT.md §2). Chosen to avoid the I2C/SPI/UART defaults so those
 * buses stay available, and grouped for tidy ribbon wiring.
 */
export const GPIO_PINS = {
  /** Buttons: switch to ground, so the line idles HIGH and reads LOW when pressed. */
  buttons: ['GPIO17', 'GPIO27', 'GPIO22'] as const,
  /** LED drive lines into the ULN2003 inputs. */
  leds: ['GPIO23', 'GPIO24', 'GPIO25'] as const,
} as const;

/**
 * The ULN2003 sinks current: the LED cathode ties to the chip output, so a HIGH input
 * lights the LED. Flip via env if bring-up shows them inverted.
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

/** Capture format matching the encode target, avoiding a resample on a slow CPU. */
const CAPTURE_FORMAT = { rate: 16_000, channels: 1, format: 'S16_LE' } as const;

/** Grace period for arecord to finalise its WAV header before we SIGKILL. */
const CAPTURE_FLUSH_TIMEOUT_MS = 2000;

export class GpioHal extends EventEmitter<HalEvents> implements Hal {
  readonly name = 'gpio';

  readonly #recordingDirectory: string;
  #volumePercent: number;
  #micGainPercent: number;
  #available = false;
  #counter = 0;

  readonly #ledLines: (Output | null)[] = [null, null, null];
  readonly #buttonWatches: (Watch | null)[] = [null, null, null];

  #captureProcess: ChildProcess | null = null;
  #captureId: string | null = null;
  #playbackProcess: ChildProcess | null = null;

  constructor(options: HalOptions) {
    super();
    this.#recordingDirectory = options.recordingDirectory;
    this.#volumePercent = options.volumePercent;
    this.#micGainPercent = options.micGainPercent;
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

    const { Edge, RaspberryPi_Zero2W } = await import('opengpio').catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        'opengpio unavailable — this driver needs a Pi with libgpiod v2 installed ' +
          `(apt install libgpiod3 on Trixie; the addon links -lgpiodcxx and will not ` +
          `build or load against libgpiod 1.x). Underlying error: ${detail}`,
      );
    });

    for (const [index, pin] of GPIO_PINS.leds.entries()) {
      this.#ledLines[index] = RaspberryPi_Zero2W.output(pin);
    }

    for (const [index, pin] of GPIO_PINS.buttons.entries()) {
      /*
       * No options passed on purpose. opengpio@2.0.2 transposes `bias` and `debounce`
       * when calling its native binding, so requesting a pull-up here would instead set a
       * 4ms debounce and leave the line floating. Both concerns are handled properly
       * elsewhere: pull-ups come from the firmware (`gpio=17,27,22=ip,pu` in
       * /boot/firmware/config.txt, applied by scripts/provision.sh) and debouncing is
       * software-side in core/buttonInterpreter.ts.
       */
      const watch = RaspberryPi_Zero2W.watch(pin, Edge.Both);
      this.#buttonWatches[index] = watch;
      this.#attachButton(watch, toButtonIndex(index));
    }

    this.#available = true;
    await this.setVolume(this.#volumePercent);
    await this.#applyMicGain();
    this.emit('available');
  }

  async dispose(): Promise<void> {
    await this.stopPlayback();
    await this.#stopCapture();

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
      await toVoiceNote(wavPath, outputPath);
      const { size } = await stat(outputPath);
      return { path: outputPath, durationMs: Date.now() - handle.startedAt, byteLength: size };
    } finally {
      // The intermediate WAV is several times larger than the Opus output.
      await rm(wavPath, { force: true });
    }
  }

  async cancelRecording(handle: RecordingHandle): Promise<void> {
    if (this.#captureId === handle.id) await this.#stopCapture();
    await rm(this.#wavPath(handle.id), { force: true });
  }

  async play(path: string): Promise<void> {
    await this.stopPlayback();
    await this.#spawnPlayback(path);
  }

  async playCue(cue: AudioCue): Promise<void> {
    // Cues are short; letting them interrupt each other beats queueing them.
    await this.stopPlayback();
    await this.#spawnPlayback(cuePath(cue));
  }

  async stopPlayback(): Promise<void> {
    const child = this.#playbackProcess;
    if (!child) return;
    this.#playbackProcess = null;
    child.kill('SIGTERM');
    await Promise.resolve();
  }

  /** Sets the ALSA mixer volume. Callers must clamp to the config cap first. */
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

  async #spawnPlayback(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = spawn('aplay', ['-D', ALSA_PLAYBACK_DEVICE, '-q', path], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.#playbackProcess = child;

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        this.#playbackProcess = null;
        reject(new Error(`aplay failed: ${error.message}`));
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        this.#playbackProcess = null;
        // A deliberate stopPlayback() arrives as a signal, which is not a failure.
        if (code === 0 || signal !== null) resolve();
        else reject(new Error(`aplay exited with code ${code}`));
      });
    });
  }

  async #applyMicGain(): Promise<void> {
    // Capture control names vary by USB adapter; failure here is not fatal.
    await runQuiet('amixer', ['-M', 'sset', 'Mic', `${this.#micGainPercent}%`, 'cap']);
  }

  #wavPath(recordingId: string): string {
    return join(this.#recordingDirectory, `${recordingId}.wav`);
  }
}

/** Runs a command, ignoring failure. Mixer controls differ across audio adapters. */
async function runQuiet(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(command, [...args], { stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
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
