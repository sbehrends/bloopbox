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

/*
 * How these maps are used: every endpoint passes them as Socket.io's generics (`Server<Listen,
 * Emit>` on the hardware server, `Socket<Listen, Emit>` — reversed — in a client), so an event
 * name that does not exist, or an emit with the wrong payload, fails the typecheck. Listeners
 * still take `payload: unknown` and narrow it with `ipc/payload.ts`: the types say what a peer
 * should send, not what arrives on the wire.
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
  'sim:injectApMode': (payload: { active: boolean }) => void;
  'sim:injectSessionExpiry': () => void;
  'sim:injectWhatsAppConnected': () => void;
  'sim:reboot': () => void;
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
  /**
   * Never paired, or just unlinked, and no socket is open. Deliberately inert: opening a
   * socket for an unregistered device is what makes Baileys start generating a QR, and
   * nothing should ask it to do that until a parent picks a method in the admin panel.
   */
  | 'notLinked'
  /** Socket opening or reconnecting. */
  | 'connecting'
  /** Linked and usable. */
  | 'connected'
  /** Needs a QR scan. */
  | 'awaitingPairing'
  /** Logged out or credentials rejected — needs re-pairing. Only ever set by the simulator's
   *  event injector, to demonstrate the LED pattern; the real client settles into
   *  `notLinked` instead so it does not reconnect on its own. */
  | 'loggedOut'
  /** Transient failure; the bridge is backing off. */
  | 'disconnected';

/**
 * How long the admin panel treats a pairing QR as scannable.
 *
 * Baileys rotates the code itself: the first one lives 60 s and every one after it 20 s
 * (`qrMs` in its `Socket/socket.js`). We count against the short figure for all of them —
 * understating the life of the first code costs one refresh, while overstating any of the
 * others means a parent scans a dead code and WhatsApp tells them, unhelpfully, that it
 * "cannot link a device right now".
 */
export const QR_LIFETIME_MS = 20_000;

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
  /**
   * The sender deleted a note for everyone. The hardware server drops it from that button's
   * queue and from disk — if it is still waiting there. Sent only for a chat the whitelist
   * resolves to `index`; an id no queue holds is ignored at the other end, and a note already
   * playing is left to finish.
   */
  'wa:revoked': (payload: { index: ButtonIndex; messageId: string }) => void;
  /** Answers `wa:requestPairingCode`. `code` is absent when pairing could not start. */
  'wa:pairingCode': (payload: { requestId: string; code?: string; error?: string }) => void;
  /** Groups the linked account belongs to, answering `wa:listGroups`. */
  'wa:groups': (payload: {
    requestId: string;
    groups: readonly { id: string; subject: string }[];
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
  /**
   * Open the socket for a first-time link, having a parent's method choice as the trigger.
   *
   * A no-op if a socket is already open. Only meaningful while `notLinked`.
   */
  'wa:beginLinking': () => void;
  /** Mark messages read upstream once the queue has been played. */
  'wa:markRead': (payload: { index: ButtonIndex; messageIds: readonly string[] }) => void;
  /**
   * Ask for the account's groups, so the admin panel can offer a picker.
   *
   * Group JIDs are opaque, so a parent cannot type one — they have to choose from a list.
   */
  'wa:listGroups': (payload: { requestId: string }) => void;
  /**
   * Start phone-number pairing, the alternative to scanning a QR.
   *
   * Easier on a screenless appliance: the parent already has their phone in hand, and typing
   * an 8-character code beats pointing a camera at a laptop.
   */
  'wa:requestPairingCode': (payload: { requestId: string; phone: string }) => void;
};

/**
 * Random per process, so a request id can never be reissued by a later boot.
 *
 * The counters behind these ids restart at 1 every time the hardware server does, and it
 * restarts on every config save — while the bridge, a separate process, stays up. Without this a
 * `wa:sendResult` for the previous boot's `send-1`, still in flight when the server exited, would
 * resolve this boot's `send-1`: a child's note reported delivered that never left the box.
 *
 * `crypto.randomUUID` is the web global rather than `node:crypto`, because the browser bundles
 * compile this file too.
 */
export const REQUEST_ID_BOOT = crypto.randomUUID().slice(0, 8);

/** Generates a short correlation id for send requests and playback tokens. */
export function createRequestId(prefix: string, counter: number): string {
  return `${prefix}-${REQUEST_ID_BOOT}-${counter.toString(36)}`;
}
