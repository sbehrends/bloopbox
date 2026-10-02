import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BufferJSON, proto, useMultiFileAuthState } from 'baileys';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDurableAuthState } from '../whatsapp/authState.ts';

/**
 * WhatsApp's credentials on the card, which a power cut must not be able to destroy: losing them
 * unlinks the box, and only a parent with the admin panel can link it again.
 */

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bloopbox-auth-'));
});

afterEach(async () => {
  await chmod(directory, 0o700).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
});

const noiseKeyOf = (creds: { noiseKey: { public: Uint8Array } }): string =>
  Buffer.from(creds.noiseKey.public).toString('hex');

describe('useDurableAuthState', () => {
  it('reads back the credentials it saved', async () => {
    const first = await useDurableAuthState(directory);
    await first.saveCreds();

    const second = await useDurableAuthState(directory);
    expect(noiseKeyOf(second.state.creds)).toBe(noiseKeyOf(first.state.creds));
  });

  it('reads the files Baileys’ own store wrote, so a paired box stays paired', async () => {
    const baileys = await useMultiFileAuthState(directory);
    await baileys.saveCreds();
    await baileys.state.keys.set({
      'pre-key': { '1': { public: Buffer.from([1]), private: Buffer.from([2]) } },
    });

    const durable = await useDurableAuthState(directory);
    expect(noiseKeyOf(durable.state.creds)).toBe(noiseKeyOf(baileys.state.creds));
    const keys = await durable.state.keys.get('pre-key', ['1']);
    expect(Buffer.from(keys['1']?.private ?? []).toString('hex')).toBe('02');
  });

  // Root ignores directory permissions, so in a root container there is no way to make the write fail.
  it.skipIf(process.getuid?.() === 0)(
    'keeps the old credentials when a save fails partway, rather than leaving none',
    async () => {
      // Baileys truncates creds.json before writing it, so an interrupted save left an empty file,
      // which it reads as "never paired". Here a failed save cannot touch the file in place.
      const store = await useDurableAuthState(directory);
      await store.saveCreds();
      const before = await readFile(join(directory, 'creds.json'), 'utf8');

      await chmod(directory, 0o500); // the temp file cannot be created: the write fails before rename
      store.state.creds.registered = true;
      await expect(store.saveCreds()).rejects.toThrow(/EACCES/);
      await chmod(directory, 0o700);

      expect(await readFile(join(directory, 'creds.json'), 'utf8')).toBe(before);
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    },
  );

  it('applies quick successive saves in order', async () => {
    const store = await useDurableAuthState(directory);
    const saves = Array.from({ length: 20 }, (_, i) => {
      store.state.creds.accountSyncCounter = i;
      return store.saveCreds();
    });
    await Promise.all(saves);

    const saved: unknown = JSON.parse(
      await readFile(join(directory, 'creds.json'), 'utf8'),
      BufferJSON.reviver,
    );
    expect(saved).toMatchObject({ accountSyncCounter: 19 });
  });

  it('stores, decodes and removes signal keys', async () => {
    const store = await useDurableAuthState(directory);
    await store.state.keys.set({
      'app-state-sync-key': {
        AAAA: proto.Message.AppStateSyncKeyData.fromObject({ timestamp: 7 }),
      },
      session: { 'lid:1.0': Buffer.from('session') },
    });

    const synced = await store.state.keys.get('app-state-sync-key', ['AAAA', 'missing']);
    expect(synced['AAAA']).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
    expect(synced['missing']).toBeUndefined();
    // `:` and `/` are not safe in a file name; the same rewrite Baileys uses.
    expect(await readdir(directory)).toContain('session-lid-1.0.json');

    await store.state.keys.set({ session: { 'lid:1.0': null } });
    expect(await store.state.keys.get('session', ['lid:1.0'])).toEqual({});
  });

  it('refuses a path that is a file, rather than writing credentials beside it', async () => {
    const file = join(directory, 'not-a-directory');
    await writeFile(file, 'x');
    await expect(useDurableAuthState(file)).rejects.toThrow(/not a directory/);
  });
});
