import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudioRouter } from '../server/routes.ts';

/**
 * `/audio` serves the browser simulator its audio, and since 2026-09-06 it has had two places
 * to look: outbound captures stay in the tmpfs, inbound notes live on the card so they survive
 * a power cut (`audio/directories.ts`). The simulator asks for a bare filename and is not told
 * which directory answered, so the route has to try both.
 *
 * A real Express app on an ephemeral port, like the other server-layer tests — the containment
 * guard and the fall-through both live in the wiring rather than in a handler.
 */

let captures: string;
let notes: string;
let server: Server;
let base: string;

beforeEach(async () => {
  captures = await mkdtemp(join(tmpdir(), 'bloopbox-captures-'));
  notes = await mkdtemp(join(tmpdir(), 'bloopbox-notes-'));

  const app = express();
  app.use('/audio', createAudioRouter([captures, notes]));
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  // Narrowed rather than asserted: `address()` is typed `string | AddressInfo | null`, and
  // `no-unsafe-type-assertion` is on for exactly this shape.
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address from an ephemeral-port listen');
  }
  base = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await rm(captures, { recursive: true, force: true });
  await rm(notes, { recursive: true, force: true });
});

describe('the audio route with two roots', () => {
  it('serves an outbound capture from the tmpfs directory', async () => {
    await writeFile(join(captures, 'take.ogg'), 'capture-bytes', 'utf8');

    const response = await fetch(`${base}/audio/take.ogg`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('capture-bytes');
  });

  it('serves an inbound note from the persistent directory', async () => {
    // The case the second root exists for: after the split, every note a child taps to hear
    // is in this directory and none of them are in the first one.
    await writeFile(join(notes, 'wa-0-abc.ogg'), 'note-bytes', 'utf8');

    const response = await fetch(`${base}/audio/wa-0-abc.ogg`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('note-bytes');
  });

  it('does not answer 404 for a file the second directory holds', async () => {
    /*
     * The bug a naive implementation ships: the first `sendFile` fails, its callback reports
     * "not found", and the note sitting in the next directory is never tried. Asserted as its
     * own case because the happy path above passes either way once the file is found.
     */
    await writeFile(join(notes, 'only-here.ogg'), 'second-root', 'utf8');
    const response = await fetch(`${base}/audio/only-here.ogg`);
    expect(response.status).not.toBe(404);
    expect(await response.text()).toBe('second-root');
  });

  it('prefers the first root when both hold the same name', async () => {
    await writeFile(join(captures, 'same.ogg'), 'from-captures', 'utf8');
    await writeFile(join(notes, 'same.ogg'), 'from-notes', 'utf8');

    expect(await (await fetch(`${base}/audio/same.ogg`)).text()).toBe('from-captures');
  });

  it('is 404 when neither directory has it', async () => {
    const response = await fetch(`${base}/audio/missing.ogg`);
    expect(response.status).toBe(404);
  });

  it('cannot be walked out of either directory', async () => {
    // `basename` reduces a traversal to a plain name, so this ends as a miss rather than a
    // read of somebody else's file. Asserted on the body too: a 404 that still leaked bytes
    // would satisfy a status-only check.
    const outside = join(tmpdir(), 'bloopbox-outside-secret.txt');
    await writeFile(outside, 'secret', 'utf8');
    try {
      const response = await fetch(
        `${base}/audio/${encodeURIComponent('../bloopbox-outside-secret.txt')}`,
      );
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('secret');
    } finally {
      await rm(outside, { force: true });
    }
  });
});
