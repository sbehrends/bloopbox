import type { Namespace, Server, Socket } from 'socket.io';
import type { AudioCue } from '../audio/cues.ts';
import type { ButtonIndex } from '../config/schema.ts';
import type { SimulatorHal, SimulatorTransport } from '../hal/simulatorDriver.ts';
import type { DeviceStatusPayload } from '../ipc/events.ts';
import { readButtonIndex, readField, readString } from '../ipc/payload.ts';
import { toBuffer } from './binary.ts';

/**
 * Bridges the simulator HAL to Socket.io (PRODUCT.md §5).
 *
 * The driver knows nothing about Socket.io and this file knows nothing about device
 * behaviour — it only marshals events. Browser input is untrusted, so every payload is
 * validated before it reaches the driver.
 */

export type SimulatorInjector = {
  /** Fake an inbound voice note from a contact. */
  injectIncoming(index: ButtonIndex, count: number): void;
  /** Force the Wi-Fi error state on or off. */
  injectWifiFailure(down: boolean): void;
  /**
   * Force the setup-hotspot state on or off.
   *
   * A browser cannot produce AP mode any other way — it needs a radio and a root agent — and
   * an LED pattern nobody can look at is one nobody will notice is wrong.
   */
  injectApMode(active: boolean): void;
  /** Force the WhatsApp-unlinked state. */
  injectSessionExpiry(): void;
  /**
   * Force the linked/READY state.
   *
   * Without this the simulator could never reach READY — the state where the spec's
   * normal-operation patterns live (all off, unread blink) — because a real link needs the
   * WhatsApp bridge running.
   */
  injectWhatsAppConnected(): void;
  /** Replay the boot sequence. */
  reboot(): void;
};

/** Guards against a tab streaming unbounded audio into the RAM disk. */
const MAX_CHUNK_BYTES = 1024 * 1024;

export class SocketSimulatorTransport implements SimulatorTransport {
  readonly #io: Server;
  #hal: SimulatorHal | null = null;
  #injector: SimulatorInjector | null = null;
  #clients = 0;

  constructor(io: Server) {
    this.#io = io;
  }

  get connected(): boolean {
    return this.#clients > 0;
  }

  get clientCount(): number {
    return this.#clients;
  }

  /**
   * Attaches the driver and starts listening. Done after construction because the driver
   * needs the transport in its own constructor.
   */
  attach(hal: SimulatorHal, injector: SimulatorInjector): void {
    this.#hal = hal;
    this.#injector = injector;
    this.#io.on('connection', (socket) => {
      this.#handleConnection(socket);
    });
  }

  /* ---- outbound: server -> browser ---- */

  sendLeds(states: readonly [boolean, boolean, boolean]): void {
    this.#io.emit('sim:leds', { states });
  }

  sendStartCapture(recordingId: string, index: ButtonIndex): void {
    this.#io.emit('sim:startCapture', { recordingId, index });
  }

  sendStopCapture(recordingId: string): void {
    this.#io.emit('sim:stopCapture', { recordingId });
  }

  sendCancelCapture(recordingId: string): void {
    this.#io.emit('sim:cancelCapture', { recordingId });
  }

  sendPlay(token: string, url: string, volumePercent: number): void {
    this.#io.emit('sim:play', { token, url, volumePercent });
  }

  sendPlayCue(token: string, cue: AudioCue, volumePercent: number): void {
    this.#io.emit('sim:playCue', { token, cue, volumePercent });
  }

  sendStopPlayback(): void {
    this.#io.emit('sim:stopPlayback');
  }

  /** Pushes device status to every tab, for the on-screen readout and admin UI. */
  broadcastStatus(status: DeviceStatusPayload): void {
    this.#io.emit('sim:status', status);
  }

  /* ---- inbound: browser -> server ---- */

  #handleConnection(socket: Socket): void {
    const hal = this.#hal;
    const injector = this.#injector;
    if (!hal || !injector) return;

    this.#clients += 1;
    // Replay the current LED frame so a new tab renders immediately.
    hal.handleBrowserConnected();

    socket.on('disconnect', () => {
      this.#clients = Math.max(0, this.#clients - 1);
      if (this.#clients === 0) hal.handleBrowserDisconnected();
    });

    socket.on('sim:buttonDown', (payload: unknown) => {
      const index = readButtonIndex(payload);
      if (index !== null) hal.handleButtonDown(index);
    });

    socket.on('sim:buttonUp', (payload: unknown) => {
      const index = readButtonIndex(payload);
      if (index !== null) hal.handleButtonUp(index);
    });

    socket.on('sim:audioChunk', (payload: unknown) => {
      const recordingId = readString(payload, 'recordingId', 128);
      const chunk = readField(payload, 'chunk');
      if (recordingId === null) return;

      const buffer = toBuffer(chunk);
      if (!buffer || buffer.byteLength > MAX_CHUNK_BYTES) return;
      hal.handleAudioChunk(recordingId, buffer);
    });

    socket.on('sim:audioComplete', (payload: unknown) => {
      const recordingId = readString(payload, 'recordingId', 128);
      if (recordingId === null) return;
      const mimeType = readString(payload, 'mimeType', 128) ?? 'audio/webm';
      void hal.handleAudioComplete(recordingId, mimeType);
    });

    socket.on('sim:audioError', (payload: unknown) => {
      const recordingId = readString(payload, 'recordingId', 128);
      if (recordingId === null) return;
      hal.handleAudioError(recordingId, readString(payload, 'reason', 256) ?? 'unknown');
    });

    socket.on('sim:playbackComplete', (payload: unknown) => {
      const token = readString(payload, 'token', 128);
      if (token !== null) hal.handlePlaybackComplete(token);
    });

    socket.on('sim:playbackError', (payload: unknown) => {
      const token = readString(payload, 'token', 128);
      if (token !== null) {
        hal.handlePlaybackError(token, readString(payload, 'reason', 256) ?? 'unknown');
      }
    });

    /* Event injector — reaches states that are otherwise hard to reproduce. */

    socket.on('sim:injectIncoming', (payload: unknown) => {
      const index = readButtonIndex(payload);
      if (index === null) return;
      const raw = readField(payload, 'count');
      const count = typeof raw === 'number' && raw >= 1 && raw <= 10 ? Math.floor(raw) : 1;
      injector.injectIncoming(index, count);
    });

    socket.on('sim:injectWifiFailure', (payload: unknown) => {
      injector.injectWifiFailure(readField(payload, 'down') === true);
    });

    socket.on('sim:injectApMode', (payload: unknown) => {
      injector.injectApMode(readField(payload, 'active') === true);
    });

    socket.on('sim:injectSessionExpiry', () => {
      injector.injectSessionExpiry();
    });

    socket.on('sim:injectWhatsAppConnected', () => {
      injector.injectWhatsAppConnected();
    });

    socket.on('sim:reboot', () => {
      injector.reboot();
    });
  }
}

/** The bridge namespace, kept separate from browser traffic. */
export type BridgeNamespace = Namespace;
