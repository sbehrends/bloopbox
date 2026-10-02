/**
 * Process 2 — WhatsApp bridge daemon (PRODUCT.md §4).
 *
 * Owns the Baileys socket and nothing else. It connects to the hardware server as a Socket.io
 * client on localhost and speaks only the contract in `src/ipc/events.ts`, so it never touches
 * GPIO, LEDs or audio devices — and the hardware server never imports Baileys.
 *
 * The two are deliberately separate processes: WhatsApp is an unofficial API on a release
 * candidate, and a crash here must not take the buttons and lights with it.
 *
 * This file only opens the two connections and wires them together. Every decision — the
 * whitelist before a download, which files may be sent — is in `whatsapp/bridge.ts`, under test.
 */
import { rm } from 'node:fs/promises';
import { io, type Socket } from 'socket.io-client';
import { notesDirectory, recordingDirectory } from '../audio/directories.ts';
import { probeDurationMs } from '../audio/ffmpeg.ts';
import {
  BRIDGE_AUTH_HEADER,
  BRIDGE_NAMESPACE,
  type BridgeToServerEvents,
  type ServerToBridgeEvents,
} from '../ipc/events.ts';
import { childLogger } from '../logger.ts';
import { createBridge } from '../whatsapp/bridge.ts';
import { WhatsAppClient } from '../whatsapp/client.ts';
import { Shutdown } from './shutdown.ts';

const log = childLogger('whatsapp');

/** Where Baileys keeps its credentials. Must be on the writable volume, and is gitignored. */
const AUTH_DIRECTORY = process.env['WA_AUTH_DIR'] ?? '/data/auth_info';
/** Inbound voice notes land here — on the card, apart from the captures (`audio/directories.ts`). */
const NOTES_DIRECTORY = notesDirectory();
/**
 * Where outbound captures are. The only directory `wa:send` may upload from: the path arrives over
 * IPC, and uploading whatever it names would let anything holding the bridge token post any file
 * this daemon can read — WhatsApp credentials included — to a family's chat.
 */
const RECORDING_DIRECTORY = recordingDirectory();
/** The hardware server's Socket.io endpoint. */
const HARDWARE_URL = process.env['HARDWARE_URL'] ?? 'http://localhost:3000';

/**
 * Owns the way out. A crash here used to be whatever Node did by default; now it closes the
 * WhatsApp socket first, so Baileys is not killed mid-write to `creds.json`.
 */
const lifecycle = new Shutdown({ log });

async function main(): Promise<void> {
  lifecycle.installHandlers();
  // A child each, so the journal says whether a line is the connection's or a decision's.
  const client = new WhatsAppClient({
    authDirectory: AUTH_DIRECTORY,
    logger: log.child({ mod: 'client' }),
  });

  const socket: Socket<ServerToBridgeEvents, BridgeToServerEvents> = io(
    `${HARDWARE_URL}${BRIDGE_NAMESPACE}`,
    {
      transports: ['websocket'],
      extraHeaders: { [BRIDGE_AUTH_HEADER]: process.env['BRIDGE_TOKEN'] ?? '' },
      // The hardware server restarts when config is saved, so reconnecting is the normal case.
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    },
  );

  const bridge = createBridge({
    client,
    toHardware: (...[event, ...args]) => {
      socket.emit(event, ...args);
    },
    notesDirectory: NOTES_DIRECTORY,
    recordingDirectory: RECORDING_DIRECTORY,
    probeDuration: probeDurationMs,
    removeFile: (path) => rm(path, { force: true }),
    log: log.child({ mod: 'bridge' }),
  });

  socket.on('connect', () => {
    log.info('connected to hardware server');
    bridge.connected();
  });
  socket.on('disconnect', (reason: string) => {
    log.warn({ reason }, 'lost the hardware server; buffering nothing until it returns');
  });
  socket.on('wa:contactsChanged', bridge.contactsChanged);
  socket.on('wa:send', (payload: unknown) => void bridge.send(payload));
  socket.on('wa:markRead', (payload: unknown) => void bridge.markRead(payload));
  socket.on('wa:unlink', () => void bridge.unlink());
  socket.on('wa:beginLinking', () => void bridge.beginLinking());
  socket.on('wa:requestPairingCode', (payload: unknown) => void bridge.requestPairingCode(payload));
  socket.on('wa:listGroups', (payload: unknown) => void bridge.listGroups(payload));

  /*
   * Registered before the client starts, so a crash while it connects still ends the socket and
   * closes the link. Separate steps: a Baileys that fails to stop must not keep the IPC open.
   */
  lifecycle.setSteps([
    { name: 'whatsapp client', run: async () => client.stop() },
    { name: 'hardware link', run: () => socket.close() },
  ]);

  log.info({ authDirectory: AUTH_DIRECTORY, hardware: HARDWARE_URL }, 'WhatsApp bridge starting');
  await client.start();
}

await main().catch((error: unknown) => {
  log.error({ err: error }, 'WhatsApp bridge failed to start');
  lifecycle.begin('startup failed', 1);
});
