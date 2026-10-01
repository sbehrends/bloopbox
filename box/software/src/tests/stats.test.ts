import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatsStore } from '../stats/statsStore.ts';

/**
 * The running totals.
 *
 * The cases that matter are the ones with a consequence a parent would notice: a corrupt file
 * losing their contacts (it must not — this file is not the config), a restart inflating the
 * numbers, and a shutdown losing the last few presses. Everything else here is arithmetic.
 */

let workDir = '';
let statsPath = '';

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'bloopbox-stats-'));
  statsPath = join(workDir, 'stats.json');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A store that writes on the next tick rather than after a debounce, so no test waits. */
function store(now?: () => number): StatsStore {
  return new StatsStore({ path: statsPath, flushDelayMs: 0, ...(now ? { now } : {}) });
}

describe('StatsStore', () => {
  it('starts empty on a box that has never counted anything', async () => {
    const stats = store();
    await stats.load();
    const snapshot = stats.snapshot();
    expect(snapshot.contacts).toHaveLength(3);
    expect(snapshot.contacts[0]).toMatchObject({
      sentCount: 0,
      sentMs: 0,
      receivedCount: 0,
      playedCount: 0,
      lastSentAt: null,
      lastReceivedAt: null,
    });
  });

  it('counts sends, arrivals and playbacks against the right button', () => {
    const stats = store(() => 1_000);
    stats.recordSent(0, 2400);
    stats.recordSent(0, 1600);
    stats.recordReceived(1, 5000);
    stats.recordPlayed(1, 1);

    const [mom, dad, grandma] = stats.snapshot().contacts;
    expect(mom).toMatchObject({ sentCount: 2, sentMs: 4000, lastSentAt: 1000 });
    expect(dad).toMatchObject({
      receivedCount: 1,
      receivedMs: 5000,
      receivedTimedCount: 1,
      playedCount: 1,
      lastReceivedAt: 1000,
    });
    // The button nothing happened on must not have moved.
    expect(grandma).toMatchObject({ sentCount: 0, receivedCount: 0 });
  });

  /*
   * A note WhatsApp gave no duration for is a real case, and the tempting shortcut — treat it
   * as zero — makes the total quietly wrong in a way nothing on the page could explain.
   */
  it('keeps an untimed arrival out of the duration total but still counts it', () => {
    const stats = store();
    stats.recordReceived(0, null);
    stats.recordReceived(0, 3000);

    expect(stats.snapshot().contacts[0]).toMatchObject({
      receivedCount: 2,
      receivedTimedCount: 1,
      receivedMs: 3000,
    });
  });

  it('survives a restart', async () => {
    const first = store();
    first.recordSent(2, 1500);
    await first.flush();

    const second = store();
    await second.load();
    expect(second.snapshot().contacts[2]).toMatchObject({ sentCount: 1, sentMs: 1500 });
  });

  /*
   * The whole reason this is not a section of config.json: a stats file that will not parse
   * must cost the totals and nothing else. The same failure in the config drops the device
   * into onboarding and loses a parent's contacts.
   */
  it('starts again from zero when the file is unreadable, rather than throwing', async () => {
    await writeFile(statsPath, '{ this is not json', 'utf8');
    const stats = store();
    await expect(stats.load()).resolves.toBeUndefined();
    expect(stats.snapshot().contacts[0]?.sentCount).toBe(0);
  });

  it('keeps the readable half of a partly wrong file', async () => {
    await writeFile(
      statsPath,
      JSON.stringify({
        version: 1,
        since: 500,
        contacts: [{ sentCount: 'lots', sentMs: 4000, receivedCount: 2 }, {}, { playedCount: 3 }],
      }),
      'utf8',
    );
    const stats = store();
    await stats.load();
    const snapshot = stats.snapshot();
    expect(snapshot.since).toBe(500);
    // The bad field degrades; the good ones beside it come through.
    expect(snapshot.contacts[0]).toMatchObject({ sentCount: 0, sentMs: 4000, receivedCount: 2 });
    expect(snapshot.contacts[2]?.playedCount).toBe(3);
  });

  it('discards a document from a schema it does not know', async () => {
    await writeFile(statsPath, JSON.stringify({ version: 99, since: 1, contacts: [] }), 'utf8');
    const stats = store();
    await stats.load();
    expect(stats.snapshot().contacts[0]?.sentCount).toBe(0);
  });

  it('resets to zero and starts the clock again', async () => {
    let clock = 1000;
    const stats = store(() => clock);
    stats.recordSent(0, 2000);
    clock = 9000;
    await stats.reset();

    const snapshot = stats.snapshot();
    expect(snapshot.since).toBe(9000);
    expect(snapshot.contacts[0]).toMatchObject({ sentCount: 0, sentMs: 0, lastSentAt: null });
    // Persisted, not only forgotten in memory: the next boot must not resurrect the old totals.
    const raw: unknown = JSON.parse(await readFile(statsPath, 'utf8'));
    expect(raw).toMatchObject({ since: 9000 });
  });

  /*
   * The reason `flush()` exists at all. A reboot asked for from the admin panel calls it before
   * the machine goes away; without it the debounce window is simply lost.
   */
  it('writes a pending change on demand rather than waiting for the timer', async () => {
    const stats = new StatsStore({ path: statsPath, flushDelayMs: 60_000 });
    stats.recordSent(1, 1000);
    await stats.flush();
    stats.stop();

    const reloaded = new StatsStore({ path: statsPath });
    await reloaded.load();
    expect(reloaded.snapshot().contacts[1]?.sentCount).toBe(1);
  });

  it('never rejects when the path cannot be written', async () => {
    const stats = new StatsStore({
      // A file where a directory would have to be: mkdir fails, and so does everything after.
      path: join(statsPath, 'nested', 'stats.json'),
      flushDelayMs: 0,
    });
    await writeFile(statsPath, 'not a directory', 'utf8');
    stats.recordSent(0, 1000);
    await expect(stats.flush()).resolves.toBeUndefined();
    // The counter is still right in memory, which is what the panel reads.
    expect(stats.snapshot().contacts[0]?.sentCount).toBe(1);
  });
  it('makes a second flush wait for the write the first one started', async () => {
    /*
     * The shutdown path and the reboot route can both flush. The second used to see `dirty`
     * already cleared by the first and return before that write had landed, so the process
     * could exit mid-write.
     */
    const stats = new StatsStore({ path: statsPath, flushDelayMs: 60_000 });
    stats.recordSent(2, 1500);
    const first = stats.flush();
    const second = stats.flush();

    await second;
    const raw: unknown = JSON.parse(await readFile(statsPath, 'utf8'));
    expect(raw).toMatchObject({ contacts: [{}, {}, { sentCount: 1, sentMs: 1500 }] });
    await first;
    stats.stop();
  });

  it('writes the latest totals when a change lands during a write', async () => {
    const stats = new StatsStore({ path: statsPath, flushDelayMs: 60_000 });
    stats.recordSent(0, 1000);
    const first = stats.flush();
    stats.recordSent(0, 1000);
    await Promise.all([first, stats.flush()]);
    stats.stop();

    const reloaded = new StatsStore({ path: statsPath });
    await reloaded.load();
    expect(reloaded.snapshot().contacts[0]?.sentCount).toBe(2);
  });

  it('tries a failed write again at the next flush, and leaves no temp file behind', async () => {
    // A directory where the file should be: the rename fails, everything before it works.
    await mkdir(statsPath);
    await writeFile(join(statsPath, 'occupied'), '');
    const stats = new StatsStore({ path: statsPath, flushDelayMs: 60_000 });
    stats.recordSent(1, 800);

    await expect(stats.flush()).resolves.toBeUndefined();
    expect((await readdir(workDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    // The card recovers; the change was not forgotten just because the first attempt failed.
    await rm(statsPath, { recursive: true });
    await stats.flush();
    stats.stop();

    const reloaded = new StatsStore({ path: statsPath });
    await reloaded.load();
    expect(reloaded.snapshot().contacts[1]?.sentCount).toBe(1);
  });
});
