import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WAMessage } from 'baileys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEND_TIMEOUT_MS } from '../server/bridgeLink.ts';
import {
  MEDIA_UPLOAD_TIMEOUT_MS,
  voiceNoteContent,
  WhatsAppClient,
  type VoiceNote,
} from '../whatsapp/client.ts';
import { MAX_INBOUND_BYTES } from '../whatsapp/mediaDownload.ts';
import { fakeBaileys } from './support/fakeWASocket.ts';

/**
 * What the client makes of an inbound message: which shapes count as a voice note, and what
 * reaches the bridge. The whitelist decides who may be heard; this decides what can be.
 */

const silentLogger = pino({ level: 'silent' });

const PTT = { ptt: true, seconds: 3, fileLength: 4_000 };

function message(content: NonNullable<WAMessage['message']>, id = 'ABC123'): WAMessage {
  return {
    key: { id, remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
    message: content,
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

async function settle(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`settle timed out waiting for: ${label}`);
}

describe('voiceNoteContent', () => {
  it('accepts a plain voice note', () => {
    expect(voiceNoteContent({ audioMessage: PTT })).toMatchObject({ ptt: true });
  });

  it('accepts one from a chat with disappearing messages on', () => {
    // The regression: every note from such a chat was ignored without a word in the log.
    expect(
      voiceNoteContent({ ephemeralMessage: { message: { audioMessage: PTT } } }),
    ).toMatchObject({ ptt: true });
  });

  it('ignores a view-once note, which is an open product question rather than an oversight', () => {
    expect(voiceNoteContent({ viewOnceMessage: { message: { audioMessage: PTT } } })).toBeNull();
    expect(voiceNoteContent({ viewOnceMessageV2: { message: { audioMessage: PTT } } })).toBeNull();
    expect(
      voiceNoteContent({
        ephemeralMessage: { message: { viewOnceMessage: { message: { audioMessage: PTT } } } },
      }),
    ).toBeNull();
  });

  it('ignores audio that is not a voice note, wrapped or not', () => {
    expect(voiceNoteContent({ audioMessage: { ptt: false } })).toBeNull();
    expect(voiceNoteContent({ ephemeralMessage: { message: { audioMessage: {} } } })).toBeNull();
    expect(voiceNoteContent({ conversation: 'hello' })).toBeNull();
    expect(voiceNoteContent(null)).toBeNull();
    expect(voiceNoteContent(undefined)).toBeNull();
  });
});

describe('WhatsAppClient inbound', () => {
  let authDirectory: string;

  beforeEach(async () => {
    authDirectory = await mkdtemp(join(tmpdir(), 'bloopbox-wa-in-'));
  });

  afterEach(async () => {
    await rm(authDirectory, { recursive: true, force: true });
  });

  async function connected(): Promise<{
    baileys: ReturnType<typeof fakeBaileys>;
    client: WhatsAppClient;
    notes: VoiceNote[];
  }> {
    const baileys = fakeBaileys({ paired: true });
    const client = new WhatsAppClient({
      authDirectory,
      logger: silentLogger,
      socketFactory: baileys.socketFactory,
      authStateFactory: baileys.authStateFactory,
      versionProvider: baileys.versionProvider,
      download: baileys.download,
    });
    const notes: VoiceNote[] = [];
    client.on('voiceNote', (note) => notes.push(note));
    await client.start();
    baileys.sockets[0]?.open();
    return { baileys, client, notes };
  }

  it('hands a disappearing-chat voice note to the bridge', async () => {
    const { baileys, notes } = await connected();

    baileys.sockets[0]?.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [message({ ephemeralMessage: { message: { audioMessage: PTT } } })],
    });

    await settle(() => notes.length === 1, 'the note to be emitted');
    expect(notes[0]).toMatchObject({ messageId: 'ABC123', seconds: 3 });
  });

  it('does not hand over a view-once note', async () => {
    const { baileys, notes } = await connected();

    baileys.sockets[0]?.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        message({ viewOnceMessage: { message: { audioMessage: PTT } } }, 'VIEWONCE'),
        message({ audioMessage: PTT }, 'PLAIN'),
      ],
    });

    await settle(() => notes.length === 1, 'the plain note to be emitted');
    expect(notes.map((note) => note.messageId)).toEqual(['PLAIN']);
  });

  it('refuses a note whose declared size is over the cap, before downloading anything', async () => {
    const { baileys, notes } = await connected();

    baileys.sockets[0]?.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        message({ audioMessage: { ...PTT, fileLength: MAX_INBOUND_BYTES + 1 } }, 'HUGE'),
        message({ audioMessage: PTT }, 'SMALL'),
      ],
    });

    await settle(() => notes.length === 1, 'the small note to be emitted');
    expect(notes.map((note) => note.messageId)).toEqual(['SMALL']);
    expect(baileys.download).not.toHaveBeenCalled();
  });

  it('downloads to the name recovery reads, through the injected downloader', async () => {
    const { baileys, notes } = await connected();
    baileys.sockets[0]?.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [message({ audioMessage: PTT }, 'DL01')],
    });
    await settle(() => notes.length === 1, 'the note to be emitted');
    const notesDir = join(authDirectory, 'notes');

    const result = await notes[0]!.download(notesDir, 2);

    expect(result).toEqual({ path: join(notesDir, 'wa-2-DL01.ogg'), byteLength: 3 });
    expect(await readdir(notesDir)).toEqual(['wa-2-DL01.ogg']);
    expect(baileys.download).toHaveBeenCalledTimes(1);
  });

  it('bounds the upload so a slow one fails before the hardware side gives up', async () => {
    const { baileys, client } = await connected();

    await client.sendVoiceNote('15551234567@s.whatsapp.net', '/run/bloopbox/rec.ogg', 2_400);

    expect(baileys.sockets[0]?.sendMessage).toHaveBeenCalledWith(
      '15551234567@s.whatsapp.net',
      expect.objectContaining({ ptt: true, seconds: 2 }),
      { mediaUploadTimeoutMs: MEDIA_UPLOAD_TIMEOUT_MS },
    );
    // Per host, and Baileys tries each in turn: two stalled hosts must still answer in time.
    expect(2 * MEDIA_UPLOAD_TIMEOUT_MS).toBeLessThan(SEND_TIMEOUT_MS);
  });

  it('logs a failed credentials write instead of leaving it unhandled', async () => {
    const { baileys } = await connected();
    const logged = vi.spyOn(silentLogger, 'error');
    baileys.saveCreds.mockRejectedValueOnce(new Error('EROFS'));

    baileys.sockets[0]?.ev.emit('creds.update', {});

    await settle(() => logged.mock.calls.length === 1, 'the failure to be logged');
    expect(logged.mock.calls[0]?.[1]).toBe('could not save WhatsApp credentials');
  });
});
