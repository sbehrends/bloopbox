import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordingName } from '../ipc/noteFiles.ts';
import { fileReadKeys } from '../whatsapp/readKeys.ts';

/** Read-receipt keys on the card, beside the notes they belong to. */

let directory: string;
const KEY = { id: 'M1', remoteJid: '15551234567@s.whatsapp.net', fromMe: false };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bloopbox-readkeys-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('fileReadKeys', () => {
  it('keeps a key beside its note, and hands it back once', async () => {
    const store = fileReadKeys(directory);
    await store.save(2, 'M1', KEY);
    // Same stem as the note, so the two are obviously one thing and the purge treats them alike.
    expect(await readdir(directory)).toEqual([recordingName(2, 'M1').replace('.ogg', '.key')]);

    expect(await fileReadKeys(directory).take(2, 'M1')).toEqual(KEY);
    expect(await store.take(2, 'M1')).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });

  it('keeps a group participant, and nothing that is not part of a key', async () => {
    const store = fileReadKeys(directory);
    await writeFile(
      join(directory, 'wa-1-G1.key'),
      JSON.stringify({ ...KEY, id: 'G1', participant: '4915112345678@s.whatsapp.net', extra: 'x' }),
    );
    expect(await store.take(1, 'G1')).toEqual({
      ...KEY,
      id: 'G1',
      participant: '4915112345678@s.whatsapp.net',
    });
  });

  it('reads a damaged or foreign file as no key', async () => {
    const store = fileReadKeys(directory);
    await writeFile(join(directory, 'wa-0-A.key'), '{"id":');
    await writeFile(join(directory, 'wa-0-B.key'), JSON.stringify({ id: 7, remoteJid: null }));
    expect(await store.take(0, 'A')).toBeNull();
    expect(await store.take(0, 'B')).toBeNull();
  });

  it('forgets a key, and forgetting one that is not there is fine', async () => {
    const store = fileReadKeys(directory);
    await store.save(0, 'M1', KEY);
    await store.forget(0, 'M1');
    await store.forget(0, 'NEVER');
    expect(await readdir(directory)).toEqual([]);
  });

  it('never builds a path from an unsafe message id', async () => {
    await expect(fileReadKeys(directory).save(0, '../../etc/x', KEY)).rejects.toThrow(/unsafe/);
  });
});
