import type { ButtonIndex } from '../config/schema.ts';
import type { AudioCue } from '../audio/cues.ts';

/**
 * Typed transport contracts, shared by every participant so a rename cannot silently
 * desynchronise the two daemons or the browser.
 *
 * Two distinct channels ride the same Socket.io server:
 *
 *  - `/` (default)  — the browser: simulator device I/O and admin UI status.
 *  - `/bridge`      — the WhatsApp daemon, which connects as a client on localhost.
 */

/** Namespace the WhatsApp bridge connects to. */
export const BRIDGE_NAMESPACE = '/bridge';

/** Shared-secret header the bridge presents. Localhost-only, but defence in depth. */
export const BRIDGE_AUTH_HEADER = 'x-bridge-token';

/* ------------------------------------------------------------------ *
 * Simulator: browser <-> hardware server
 * ------------------------------------------------------------------ */

/** Sent by the browser, standing in for physical hardware. */
export type SimulatorToServerEvents = {
  /** A virtual button was pressed or released. */
  'sim:buttonDown': (payload: { index: ButtonIndex }) => void;
  'sim:buttonUp': (payload: { index: ButtonIndex }) => void;
  /** Captured microphone audio for an in-flight recording, as raw bytes. */
  'sim:audioChunk': (payload: { recordingId: string; chunk: ArrayBuffer }) => void;
  /** The browser finished flushing chunks for this recording. */
  'sim:audioComplete': (payload: { recordingId: string; mimeType: string }) => void;
  /** The browser could not capture audio (permission denied, no device). */
  'sim:audioError': (payload: { recordingId: string; reason: string }) => void;
  /** Playback of a file the server requested has finished. */
  'sim:playbackComplete': (payload: { token: string }) => void;
  'sim:playbackError': (payload: { token: string; reason: string }) => void;

  /* Event injector — exercises paths that are otherwise hard to reach. */
  'sim:injectIncoming': (payload: { index: ButtonIndex; count?: number }) => void;
  'sim:injectWifiFailure': (payload: { down: boolean }) => void;
  'sim:injectSessionExpiry': () => void;
};

/** Sent by the hardware server to the browser. */
export type ServerToSimulatorEvents = {
  /** Authoritative LED states, index-aligned. The browser renders these verbatim. */
  'sim:leds': (payload: { states: readonly [boolean, boolean, boolean] }) => void;
  /** Start capturing microphone audio under this id. */
  'sim:startCapture': (payload: { recordingId: string; index: ButtonIndex }) => void;
  /** Stop capturing and flush. */
  'sim:stopCapture': (payload: { recordingId: string }) => void;
  /** Discard a capture without delivering it. */
  'sim:cancelCapture': (payload: { recordingId: string }) => void;
  /** Play a file, served over HTTP at `url`. Reply with playbackComplete/Error. */
  'sim:play': (payload: { token: string; url: string; volumePercent: number }) => void;
  /** Play a built-in cue. */
  'sim:playCue': (payload: { token: string; cue: AudioCue; volumePercent: number }) => void;
  /** Interrupt any playback in progress. */
  'sim:stopPlayback': () => void;
  /** Current device state, for the on-screen readout. */
  'sim:status': (payload: DeviceStatusPayload) => void;
};

/* ------------------------------------------------------------------ *
 * Admin UI: browser <- hardware server
 * ------------------------------------------------------------------ */

export type DeviceStatusPayload = {
  readonly state: string;
  readonly silentMode: boolean;
  readonly silentFromSchedule: boolean;
  readonly whatsappConnected: boolean;
  readonly wifiConnected: boolean;
  readonly configured: boolean;
  readonly unreadCounts: readonly [number, number, number];
  readonly recording: ButtonIndex | null;
  readonly playing: ButtonIndex | null;
  readonly driver: string;
};

/* ------------------------------------------------------------------ *
 * IPC: WhatsApp bridge <-> hardware server
 * ------------------------------------------------------------------ */

export type WhatsAppConnectionState =
  /** Socket opening or reconnecting. */
  | 'connecting'
  /** Linked and usable. */
  | 'connected'
  /** Needs a QR scan. */
  | 'awaitingPairing'
  /** Logged out or credentials rejected — needs re-pairing. */
  | 'loggedOut'
  /** Transient failure; the bridge is backing off. */
  | 'disconnected';

/** Sent by the bridge to the hardware server. */
export type BridgeToServerEvents = {
  /** Connection state changed. Drives the WhatsApp error LED pattern. */
  'wa:status': (payload: {
    state: WhatsAppConnectionState;
    detail?: string;
    /** Present when state is awaitingPairing. */
    qr?: string;
  }) => void;
  /**
   * A whitelisted contact sent a voice note. The file already sits in the RAM disk;
   * the hardware server owns playback and the unread count from here.
   */
  'wa:incoming': (payload: {
    index: ButtonIndex;
    messageId: string;
    path: string;
    durationMs: number | null;
    receivedAt: number;
  }) => void;
  /** An outbound send finished. */
  'wa:sendResult': (payload: {
    requestId: string;
    index: ButtonIndex;
    ok: boolean;
    error?: string;
  }) => void;
};

/** Sent by the hardware server to the bridge. */
export type ServerToBridgeEvents = {
  /** Ship this recording to the contact on `index` as a PTT voice note. */
  'wa:send': (payload: { requestId: string; index: ButtonIndex; path: string }) => void;
  /** Contacts changed — refresh the whitelist. */
  'wa:contactsChanged': (payload: {
    contacts: readonly { index: ButtonIndex; jid: string }[];
  }) => void;
  /** Drop credentials and re-pair. */
  'wa:unlink': () => void;
  /** Mark messages read upstream once the queue has been played. */
  'wa:markRead': (payload: { index: ButtonIndex; messageIds: readonly string[] }) => void;
};

/** Generates a short correlation id for send requests and playback tokens. */
export function createRequestId(prefix: string, counter: number): string {
  return `${prefix}-${counter.toString(36)}`;
}
