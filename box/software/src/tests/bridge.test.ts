import { EventEmitter } from 'node:events';
import type { WAMessage } from 'baileys';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ButtonIndex } from '../config/schema.ts';
import {
  createBridge,
  MAX_NOTES_BEFORE_WHITELIST,
  MAX_TRACKED_REVOKES,
  type Bridge,
  type HardwareEvent,
} from '../whatsapp/bridge.ts';
import type { VoiceNote, WhatsAppClientEvents } from '../whatsapp/client.ts';
import { maskJid } from '../whatsapp/privacy.ts';
import type { ReadKey, ReadKeyStore } from '../whatsapp/readKeys.ts';

/**
 * The bridge's decisions, with WhatsApp and the hardware server both faked.
 *
 * `whitelist.test.ts` proves the rule; this proves the bridge applies it **before** anything
 * reaches the card. Until `createBridge` existed this code lived in the process file, which is
 * excluded from coverage, so nothing did.
 */

const MOM = '15551234567@s.whatsapp.net';
const STRANGER = '15550000001@s.whatsapp.net';
const FAMILY = '15551234567-1699999999@g.us';
const AUNT = '4915112345678@s.whatsapp.net';
const NOTES = '/data/notes';
const REVOKE = {
  messageId: 'M1',
  chatJid: MOM,
  chatJidAlt: undefined,
  participantJid: undefined,
  fromMe: false,
};
const RECORDINGS = '/run/bloopbox';

class FakeWhatsApp extends EventEmitter<WhatsAppClientEvents> {
  state: 'connected' | 'notLinked' = 'connected';
  readonly unlink = vi.fn<() => Promise<void>>(() => Promise.resolve());
  readonly beginLinking = vi.fn<() => Promise<void>>(() => Promise.resolve());
  readonly requestPairingCode = vi.fn<(phone: string) => Promise<string>>(() =>
    Promise.resolve('ABCD-1234'),
  );
  readonly listGroups = vi.fn<() => Promise<{ id: string; subject: string }[]>>(() =>
    Promise.resolve([{ id: FAMILY, subject: 'Family' }]),
  );
  readonly sendVoiceNote = vi.fn<(jid: string, path: string, ms: number) => Promise<void>>(() =>
    Promise.resolve(),
  );
  readonly markRead = vi.fn<(keys: readonly WAMessage['key'][]) => Promise<void>>(() =>
    Promise.resolve(),
  );
}

let client: FakeWhatsApp;
let sent: HardwareEvent[];
let removed: string[];
let logged: unknown[][];
let bridge: Bridge;
/** The card, as far as read keys go: survives a new bridge, as the files do a restart. */
let keys: Map<string, ReadKey>;

const slot = (index: number, id: string): string => `${String(index)}/${id}`;

function memoryReadKeys(): ReadKeyStore {
  return {
    save: (index, id, key) => {
      keys.set(slot(index, id), key);
      return Promise.resolve();
    },
    take: (index, id) => {
      const key = keys.get(slot(index, id)) ?? null;
      keys.delete(slot(index, id));
      return Promise.resolve(key);
    },
    forget: (index, id) => {
      keys.delete(slot(index, id));
      return Promise.resolve();
    },
  };
}

const record = (...args: unknown[]): void => {
  logged.push(args);
};

function newBridge(): Bridge {
  return createBridge({
    client,
    toHardware: (...event) => {
      sent.push(event);
    },
    notesDirectory: NOTES,
    recordingDirectory: RECORDINGS,
    probeDuration: () => Promise.resolve(2500),
    removeFile: (path) => {
      removed.push(path);
      return Promise.resolve();
    },
    readKeys: memoryReadKeys(),
    log: { debug: record, info: record, warn: record, error: record },
  });
}

beforeEach(() => {
  client = new FakeWhatsApp();
  sent = [];
  removed = [];
  logged = [];
  keys = new Map();
  bridge = newBridge();
});

/** The payloads sent to the hardware server under one event name, in order. */
function events(name: HardwareEvent[0]): unknown[] {
  return sent.flatMap(([event, payload]) => (event === name ? [payload] : []));
}

function assign(...contacts: { index: ButtonIndex; jid: string }[]): void {
  bridge.contactsChanged({ contacts });
}

/** A voice note whose download is a spy, landing where the real one would. */
function note(
  overrides: Partial<Omit<VoiceNote, 'download' | 'raw'>> & { messageId?: string } = {},
): VoiceNote & { download: Mock<VoiceNote['download']> } {
  const messageId = overrides.messageId ?? 'M1';
  const download = vi.fn<VoiceNote['download']>((directory, index) =>
    Promise.resolve({
      path: `${directory}/wa-${String(index)}-${messageId}.ogg`,
      byteLength: 4096,
    }),
  );
  return {
    messageId,
    chatJid: MOM,
    chatJidAlt: undefined,
    participantJid: undefined,
    fromMe: false,
    seconds: 3,
    ...overrides,
    download,
    raw: { key: { id: messageId, remoteJid: overrides.chatJid ?? MOM, fromMe: false } },
  };
}

async function settle(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Lets every pending handler run; for asserting that something did *not* happen. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('inbound voice notes', () => {
  it('downloads an assigned contact’s note to the card, under its button, and announces it', async () => {
    assign({ index: 0, jid: MOM });
    const voice = note();
    client.emit('voiceNote', voice);
    await settle(() => events('wa:incoming').length > 0, 'the note to be announced');

    expect(voice.download).toHaveBeenCalledWith(NOTES, 0);
    expect(events('wa:incoming')[0]).toMatchObject({
      index: 0,
      messageId: 'M1',
      path: `${NOTES}/wa-0-M1.ogg`,
      durationMs: 3000,
    });
  });

  it('never downloads a stranger’s note: the whitelist runs first', async () => {
    assign({ index: 0, jid: MOM });
    const voice = note({ chatJid: STRANGER });
    client.emit('voiceNote', voice);
    await drain();

    expect(voice.download).not.toHaveBeenCalled();
    expect(events('wa:incoming')).toEqual([]);
  });

  it('holds what arrives before the first contact list, then judges it against that list', async () => {
    // At boot WhatsApp delivers the offline backlog before the hardware server has said who
    // is assigned; judging it against an empty list dropped every one of those notes.
    const fromMom = note({ messageId: 'EARLY' });
    const fromStranger = note({ messageId: 'NOPE', chatJid: STRANGER });
    client.emit('voiceNote', fromMom);
    client.emit('voiceNote', fromStranger);
    await drain();
    expect(fromMom.download).not.toHaveBeenCalled();

    assign({ index: 0, jid: MOM });
    await settle(() => events('wa:incoming').length > 0, 'the held note');
    expect(events('wa:incoming')).toEqual([expect.objectContaining({ messageId: 'EARLY' })]);
    expect(fromStranger.download).not.toHaveBeenCalled();
  });

  it('drops what overflows the hold rather than growing without bound', async () => {
    for (let i = 0; i <= MAX_NOTES_BEFORE_WHITELIST; i++) {
      client.emit('voiceNote', note({ messageId: `N${String(i)}` }));
    }
    assign({ index: 0, jid: MOM });
    await settle(
      () => events('wa:incoming').length === MAX_NOTES_BEFORE_WHITELIST,
      'the held notes',
    );
    await drain();
    expect(events('wa:incoming')).toHaveLength(MAX_NOTES_BEFORE_WHITELIST);
  });

  it('treats a contact list it cannot read as nobody assigned', async () => {
    // Fails closed: garbage from the hardware server must never widen who reaches the child.
    for (const payload of [
      null,
      'mom',
      { contacts: 'mom' },
      { contacts: [{ index: 9, jid: MOM }] },
    ]) {
      bridge.contactsChanged(payload);
    }
    const voice = note();
    client.emit('voiceNote', voice);
    await drain();
    expect(voice.download).not.toHaveBeenCalled();
  });

  it('accepts anyone in an assigned group, under the group’s button', async () => {
    assign({ index: 2, jid: FAMILY });
    client.emit('voiceNote', note({ chatJid: FAMILY, participantJid: AUNT }));
    await settle(() => events('wa:incoming').length > 0, 'the group note');
    expect(events('wa:incoming')[0]).toMatchObject({ index: 2 });
  });

  it('measures a note that does not say how long it is', async () => {
    assign({ index: 0, jid: MOM });
    client.emit('voiceNote', note({ seconds: null }));
    await settle(() => events('wa:incoming').length > 0, 'the note');
    expect(events('wa:incoming')[0]).toMatchObject({ durationMs: 2500 });
  });

  it('reports a download that failed, and announces nothing', async () => {
    assign({ index: 0, jid: MOM });
    const voice = note();
    voice.download.mockRejectedValueOnce(new Error('media expired'));
    client.emit('voiceNote', voice);
    await settle(
      () => logged.some(([, message]) => message === 'failed to download a voice note'),
      'the failure',
    );
    expect(events('wa:incoming')).toEqual([]);
  });
});

describe('deleted for everyone', () => {
  it('passes on a revoke from an assigned chat', async () => {
    assign({ index: 0, jid: MOM });
    client.emit('revoked', {
      messageId: 'M1',
      chatJid: MOM,
      chatJidAlt: undefined,
      participantJid: undefined,
      fromMe: false,
    });
    await drain();
    expect(events('wa:revoked')).toEqual([{ index: 0, messageId: 'M1' }]);
  });

  it('ignores a revoke from anyone else', async () => {
    assign({ index: 0, jid: MOM });
    client.emit('revoked', {
      messageId: 'M1',
      chatJid: STRANGER,
      chatJidAlt: undefined,
      participantJid: undefined,
      fromMe: false,
    });
    await drain();
    expect(events('wa:revoked')).toEqual([]);
  });

  it('throws away a note whose revoke landed while it downloaded', async () => {
    assign({ index: 0, jid: MOM });
    const voice = note();
    let finish: (() => void) | undefined;
    voice.download.mockImplementationOnce(
      (directory: string, index: ButtonIndex) =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ path: `${directory}/wa-${String(index)}-M1.ogg`, byteLength: 1 });
        }),
    );
    client.emit('voiceNote', voice);
    await settle(() => finish !== undefined, 'the download to start');
    client.emit('revoked', {
      messageId: 'M1',
      chatJid: MOM,
      chatJidAlt: undefined,
      participantJid: undefined,
      fromMe: false,
    });
    finish?.();
    await settle(() => removed.length > 0, 'the file to be removed');

    expect(removed).toEqual([`${NOTES}/wa-0-M1.ogg`]);
    expect(events('wa:incoming')).toEqual([]);
  });

  it('never downloads a note whose revoke arrived first', async () => {
    assign({ index: 0, jid: MOM });
    client.emit('revoked', REVOKE);
    const voice = note();
    client.emit('voiceNote', voice);
    await drain();
    expect(voice.download).not.toHaveBeenCalled();
  });

  it('remembers only the most recent revokes', async () => {
    assign({ index: 0, jid: MOM });
    for (let i = 0; i <= MAX_TRACKED_REVOKES; i++) {
      client.emit('revoked', { ...REVOKE, messageId: `R${String(i)}` });
    }
    // The oldest has been forgotten, so its note — were it ever to arrive — is taken.
    const oldest = note({ messageId: 'R0' });
    const newest = note({ messageId: `R${String(MAX_TRACKED_REVOKES)}` });
    client.emit('voiceNote', oldest);
    client.emit('voiceNote', newest);
    await drain();
    expect(oldest.download).toHaveBeenCalled();
    expect(newest.download).not.toHaveBeenCalled();
  });

  it('does not mark a revoked note read', async () => {
    assign({ index: 0, jid: MOM });
    client.emit('voiceNote', note());
    await settle(() => events('wa:incoming').length > 0, 'the note');
    client.emit('revoked', {
      messageId: 'M1',
      chatJid: MOM,
      chatJidAlt: undefined,
      participantJid: undefined,
      fromMe: false,
    });
    await drain();
    await bridge.markRead({ index: 0, messageIds: ['M1'] });
    expect(client.markRead).not.toHaveBeenCalled();
  });
});

describe('sending', () => {
  const capture = `${RECORDINGS}/rec-1.ogg`;

  it('sends a capture to the button’s contact and deletes it once accepted', async () => {
    assign({ index: 0, jid: MOM });
    await bridge.send({ requestId: 'send-1', index: 0, path: capture });

    expect(client.sendVoiceNote).toHaveBeenCalledWith(MOM, capture, 2500);
    expect(events('wa:sendResult')).toEqual([{ requestId: 'send-1', index: 0, ok: true }]);
    expect(removed).toEqual([capture]);
  });

  it('refuses any file that is not an outbound capture', async () => {
    // The path arrives over IPC: anything holding the bridge token must not be able to post,
    // say, WhatsApp's own credentials to a family chat.
    assign({ index: 0, jid: MOM });
    for (const path of [
      '/data/auth_info/creds.json',
      `${RECORDINGS}/../data/x.ogg`,
      `${RECORDINGS}/sub/x.ogg`,
      `${RECORDINGS}/x.wav`,
    ]) {
      await bridge.send({ requestId: 'send-x', index: 0, path });
    }
    expect(client.sendVoiceNote).not.toHaveBeenCalled();
    expect(events('wa:sendResult')).toEqual(
      Array.from({ length: 4 }, () => expect.objectContaining({ ok: false })),
    );
  });

  it('refuses a button with no contact', async () => {
    assign({ index: 0, jid: MOM });
    await bridge.send({ requestId: 'send-2', index: 1, path: capture });
    expect(client.sendVoiceNote).not.toHaveBeenCalled();
    expect(events('wa:sendResult')[0]).toMatchObject({
      ok: false,
      error: 'no contact assigned to that button',
    });
  });

  it('keeps the file and reports why when WhatsApp refuses it', async () => {
    assign({ index: 0, jid: MOM });
    client.sendVoiceNote.mockRejectedValueOnce(new Error('not connected'));
    await bridge.send({ requestId: 'send-3', index: 0, path: capture });
    expect(events('wa:sendResult')[0]).toEqual({
      requestId: 'send-3',
      index: 0,
      ok: false,
      error: 'not connected',
    });
    expect(removed).toEqual([]);
  });

  it('ignores a malformed request without answering it', async () => {
    await bridge.send({ requestId: 'send-4', index: 7, path: capture });
    expect(sent).toEqual([]);
  });
});

describe('marking read', () => {
  it('marks only notes it accepted, and each only once', async () => {
    assign({ index: 0, jid: MOM });
    client.emit('voiceNote', note());
    await settle(() => events('wa:incoming').length > 0, 'the note');

    await bridge.markRead({ index: 0, messageIds: ['M1', 'NEVER-SEEN'] });
    await bridge.markRead({ index: 0, messageIds: ['M1'] });
    expect(client.markRead).toHaveBeenCalledTimes(1);
    expect(client.markRead.mock.calls[0]?.[0]).toEqual([
      { id: 'M1', remoteJid: MOM, fromMe: false },
    ]);
  });
});

describe('marking read, bounded and best-effort', () => {
  it('marks a note read after a bridge restart, from the key kept beside it', async () => {
    // The visible half of the promise: two ticks for the sender, even across an update or a reboot.
    assign({ index: 0, jid: MOM });
    client.emit('voiceNote', note());
    await settle(() => events('wa:incoming').length > 0, 'the note');

    client = new FakeWhatsApp();
    const restarted = newBridge();
    await restarted.markRead({ index: 0, messageIds: ['M1'] });
    expect(client.markRead).toHaveBeenCalledWith([{ id: 'M1', remoteJid: MOM, fromMe: false }]);
    expect(keys.size).toBe(0);
  });

  it('keeps the key per button, so the same id on another button is not marked', async () => {
    assign({ index: 0, jid: MOM });
    client.emit('voiceNote', note());
    await settle(() => events('wa:incoming').length > 0, 'the note');
    await bridge.markRead({ index: 1, messageIds: ['M1'] });
    expect(client.markRead).not.toHaveBeenCalled();
  });

  it('still announces a note whose key it could not keep', async () => {
    assign({ index: 0, jid: MOM });
    const failing = memoryReadKeys();
    bridge = createBridge({
      client,
      toHardware: (...event) => {
        sent.push(event);
      },
      notesDirectory: NOTES,
      recordingDirectory: RECORDINGS,
      probeDuration: () => Promise.resolve(2500),
      removeFile: () => Promise.resolve(),
      readKeys: { ...failing, save: () => Promise.reject(new Error('ENOSPC')) },
      log: { debug: record, info: record, warn: record, error: record },
    });
    assign({ index: 0, jid: MOM });
    client.emit('voiceNote', note());
    await settle(() => events('wa:incoming').length > 0, 'the note');
    expect(logged.some(([, message]) => message === 'could not keep the read key of a note')).toBe(
      true,
    );
  });

  it('shrugs off a failure: the child has already heard it', async () => {
    assign({ index: 0, jid: MOM });
    client.emit('voiceNote', note());
    await settle(() => events('wa:incoming').length > 0, 'the note');
    client.markRead.mockRejectedValueOnce(new Error('offline'));
    await bridge.markRead({ index: 0, messageIds: ['M1'] });
    expect(logged.some(([, message]) => message === 'could not mark messages read')).toBe(true);
  });

  it('ignores a malformed request', async () => {
    await bridge.markRead({ index: 0, messageIds: 'M1' });
    await bridge.markRead(null);
    expect(client.markRead).not.toHaveBeenCalled();
  });
});

describe('linking and the admin panel', () => {
  it('unlinks and begins linking on request, and logs rather than throws on failure', async () => {
    await bridge.unlink();
    await bridge.beginLinking();
    client.unlink.mockRejectedValueOnce(new Error('logout failed'));
    client.beginLinking.mockRejectedValueOnce(new Error('no socket'));
    await bridge.unlink();
    await bridge.beginLinking();

    expect(client.unlink).toHaveBeenCalledTimes(2);
    expect(client.beginLinking).toHaveBeenCalledTimes(2);
    const messages = logged.map(([, message]) => message);
    expect(messages).toEqual(expect.arrayContaining(['unlink failed', 'beginLinking failed']));
  });

  it('passes on why a pairing code could not be issued', async () => {
    client.requestPairingCode.mockRejectedValueOnce(new Error('rate limited'));
    await bridge.requestPairingCode({ requestId: 'p-3', phone: '+4915112345678' });
    expect(events('wa:pairingCode')).toEqual([{ requestId: 'p-3', error: 'rate limited' }]);
  });

  it('answers nothing to a request it cannot reply to', async () => {
    await bridge.requestPairingCode({ phone: '+4915112345678' });
    await bridge.listGroups({});
    expect(sent).toEqual([]);
  });

  it('carries a status detail through', () => {
    client.emit('status', { state: 'disconnected', detail: 'connection lost' });
    expect(events('wa:status')).toEqual([{ state: 'disconnected', detail: 'connection lost' }]);
  });

  it('re-announces the connection state to a hardware server that reconnected', () => {
    client.state = 'notLinked';
    bridge.connected();
    expect(events('wa:status')).toEqual([{ state: 'notLinked' }]);
  });

  it('forwards the client’s status changes', () => {
    client.emit('status', { state: 'awaitingPairing', qr: 'QR-DATA' });
    expect(events('wa:status')).toEqual([{ state: 'awaitingPairing', qr: 'QR-DATA' }]);
  });

  it('answers a pairing-code request, with the error when there is no phone', async () => {
    await bridge.requestPairingCode({ requestId: 'p-1', phone: '+4915112345678' });
    await bridge.requestPairingCode({ requestId: 'p-2' });
    expect(events('wa:pairingCode')).toEqual([
      { requestId: 'p-1', code: 'ABCD-1234' },
      { requestId: 'p-2', error: 'a phone number is required' },
    ]);
  });

  it('answers a group listing with an empty list rather than nothing', async () => {
    client.listGroups.mockRejectedValueOnce(new Error('offline'));
    await bridge.listGroups({ requestId: 'g-1' });
    expect(events('wa:groups')).toEqual([{ requestId: 'g-1', groups: [] }]);
  });
});

describe('what reaches the log', () => {
  it('never carries a whole WhatsApp address', async () => {
    assign({ index: 0, jid: MOM }, { index: 2, jid: FAMILY });
    client.emit('voiceNote', note({ messageId: 'A' }));
    client.emit('voiceNote', note({ messageId: 'B', chatJid: FAMILY, participantJid: AUNT }));
    client.emit('voiceNote', note({ messageId: 'C', chatJid: STRANGER }));
    await settle(() => events('wa:incoming').length === 2, 'both notes');
    await drain();

    const journal = JSON.stringify(logged);
    for (const address of [MOM, FAMILY, AUNT, STRANGER]) {
      expect(journal).not.toContain(address.split('@')[0]);
    }
    expect(journal).toContain(maskJid(MOM));
  });
});

describe('maskJid', () => {
  it('keeps the country code and the last four digits of a number', () => {
    expect(maskJid('4915112345678@s.whatsapp.net')).toBe('+49•••5678');
    expect(maskJid('4915112345678:12@s.whatsapp.net')).toBe('+49•••5678');
  });

  it('masks LIDs and groups the same way, and anything short entirely', () => {
    expect(maskJid('44581961883857@lid')).toBe('lid•••3857');
    expect(maskJid('15551234567-1699999999@g.us')).toBe('group•••9999');
    expect(maskJid('123@s.whatsapp.net')).toBe('+•••');
    expect(maskJid(undefined)).toBeNull();
    expect(maskJid('')).toBeNull();
    expect(maskJid('status@broadcast')).toBe('•••@broadcast');
    expect(maskJid('alice.example')).toBe('•••mple');
    expect(maskJid('notanumber99@s.whatsapp.net')).toBe('+•••');
  });
});
