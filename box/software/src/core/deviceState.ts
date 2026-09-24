import { EventEmitter } from 'node:events';
import { BUTTON_KEYS, type ButtonIndex } from '../config/schema.ts';

/**
 * The device's observable state (PRODUCT.md §6), held in one place so the LED animator
 * has a single thing to render and the admin UI has a single thing to display.
 *
 * Pure data plus change notification — no timers, no I/O.
 */

/**
 * Mutually exclusive lifecycle states. `erasableSyntaxOnly` rules out enums, so this is
 * an `as const` object plus a derived union.
 */
export const DeviceStatus = {
  /** Services starting; LEDs chase left to right. */
  Booting: 'BOOTING',
  /** Joining Wi-Fi and linking WhatsApp; all three blink together. */
  Connecting: 'CONNECTING',
  /** Online and idle. */
  Ready: 'READY',
  /** Wi-Fi down and no setup hotspot up (yet); all three solid. */
  WifiError: 'WIFI_ERROR',
  /**
   * The open setup hotspot is up and the captive portal is waiting; all three double-pulse.
   *
   * Ranked above WifiError in `hardware-server.ts`: when the AP is up, "the network is gone"
   * is the cause, not the news a parent can act on.
   */
  SetupPortal: 'SETUP_PORTAL',
  /** Wi-Fi up but WhatsApp unlinked or awaiting a QR scan; LEDs 1 and 2 solid. */
  WhatsAppError: 'WHATSAPP_ERROR',
} as const;

export type DeviceStatus = (typeof DeviceStatus)[keyof typeof DeviceStatus];

export type DeviceSnapshot = {
  readonly status: DeviceStatus;
  /** Quiet hours or the manual chord — suppresses cues, not playback. */
  readonly silentMode: boolean;
  /** True when silentMode came from the schedule rather than the chord. */
  readonly silentFromSchedule: boolean;
  /** Which button is mid-recording, if any. */
  readonly recording: ButtonIndex | null;
  /** Which button is mid-playback, if any. */
  readonly playing: ButtonIndex | null;
  /** Unread message counts per button, index-aligned with BUTTON_KEYS. */
  readonly unreadCounts: readonly [number, number, number];
};

type DeviceStateEvents = {
  /** Any observable change. The LED animator re-renders on this. */
  change: [DeviceSnapshot];
  /** A recording was accepted and shipped — triggers the 3-flash confirmation. */
  messageSent: [{ index: ButtonIndex }];
  /** Silent mode flipped — triggers the single chasing pass. */
  silentModeChanged: [{ silentMode: boolean }];
};

export class DeviceState extends EventEmitter<DeviceStateEvents> {
  #status: DeviceStatus = DeviceStatus.Booting;
  #manualSilent = false;
  #scheduledSilent = false;
  #recording: ButtonIndex | null = null;
  #playing: ButtonIndex | null = null;
  readonly #unread: [number, number, number] = [0, 0, 0];

  snapshot(): DeviceSnapshot {
    return {
      status: this.#status,
      silentMode: this.silentMode,
      silentFromSchedule: this.#scheduledSilent && !this.#manualSilent,
      recording: this.#recording,
      playing: this.#playing,
      unreadCounts: [this.#unread[0], this.#unread[1], this.#unread[2]],
    };
  }

  get status(): DeviceStatus {
    return this.#status;
  }

  /** Silent when either the schedule or the manual chord says so. */
  get silentMode(): boolean {
    return this.#manualSilent || this.#scheduledSilent;
  }

  get recording(): ButtonIndex | null {
    return this.#recording;
  }

  get playing(): ButtonIndex | null {
    return this.#playing;
  }

  /** True when the device is online enough to send and receive. */
  get isOnline(): boolean {
    return this.#status === DeviceStatus.Ready;
  }

  setStatus(status: DeviceStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#emitChange();
  }

  /** Applies the quiet-hours schedule. Manual silent still wins while it is set. */
  setScheduledSilent(silent: boolean): void {
    if (this.#scheduledSilent === silent) return;
    const before = this.silentMode;
    this.#scheduledSilent = silent;
    this.#afterSilentChange(before);
  }

  setManualSilent(silent: boolean): void {
    if (this.#manualSilent === silent) return;
    const before = this.silentMode;
    this.#manualSilent = silent;
    this.#afterSilentChange(before);
  }

  /**
   * The chord toggles the *effective* state. During scheduled quiet hours this lets a
   * parent force audio back on without editing the schedule.
   */
  toggleSilent(): void {
    const before = this.silentMode;
    if (before) {
      this.#manualSilent = false;
      this.#scheduledSilent = false;
    } else {
      this.#manualSilent = true;
    }
    this.#afterSilentChange(before);
  }

  setRecording(index: ButtonIndex | null): void {
    if (this.#recording === index) return;
    this.#recording = index;
    this.#emitChange();
  }

  setPlaying(index: ButtonIndex | null): void {
    if (this.#playing === index) return;
    this.#playing = index;
    this.#emitChange();
  }

  unreadCount(index: ButtonIndex): number {
    return this.#unread[index];
  }

  hasUnread(index: ButtonIndex): boolean {
    return this.#unread[index] > 0;
  }

  get totalUnread(): number {
    return this.#unread[0] + this.#unread[1] + this.#unread[2];
  }

  /** A voice note arrived for this contact. */
  addUnread(index: ButtonIndex, count = 1): void {
    if (count <= 0) return;
    this.#unread[index] += count;
    this.#emitChange();
  }

  /** The queue for this contact drained — stop blinking. */
  clearUnread(index: ButtonIndex): void {
    this.setUnread(index, 0);
  }

  /**
   * Sets the count outright, to what the queue actually holds.
   *
   * What playback ends with, rather than a clear: a note that arrived while the others were
   * playing is still waiting, and zeroing the count put its lamp out — a tap then got the "oops"
   * and the note sat unheard until a restart or the purge.
   */
  setUnread(index: ButtonIndex, count: number): void {
    const next = Math.max(0, count);
    if (this.#unread[index] === next) return;
    this.#unread[index] = next;
    this.#emitChange();
  }

  /** Confirms an outbound send, driving the 3-flash cue. */
  reportMessageSent(index: ButtonIndex): void {
    this.emit('messageSent', { index });
  }

  /** Human-readable label for logs and the admin panel. */
  describe(): string {
    const parts: string[] = [this.#status];
    if (this.silentMode) parts.push('silent');
    if (this.#recording !== null) parts.push(`recording:${BUTTON_KEYS[this.#recording]}`);
    if (this.#playing !== null) parts.push(`playing:${BUTTON_KEYS[this.#playing]}`);
    if (this.totalUnread > 0) parts.push(`unread:${this.totalUnread}`);
    return parts.join(' ');
  }

  #afterSilentChange(before: boolean): void {
    const after = this.silentMode;
    if (before !== after) {
      this.emit('silentModeChanged', { silentMode: after });
    }
    this.#emitChange();
  }

  #emitChange(): void {
    this.emit('change', this.snapshot());
  }
}
