import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isStale,
  isWifiDown,
  NET_STATE_MAX_AGE_MS,
  NetStateWatcher,
  parseNetState,
  readNetState,
} from '../net/netState.ts';

/**
 * The reading published by `deploy/net-agent.sh` crosses a privilege boundary as a file
 * written by a shell script, so the posture under test is: anything malformed, missing or
 * old means *unknown*, and unknown never lights the Wi-Fi error pattern.
 */

const NOW = 1_800_000_000_000;

function reading(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    updatedAtMs: NOW,
    available: true,
    online: true,
    ssid: 'Home',
    signal: 71,
    apActive: false,
    ...overrides,
  });
}

describe('parseNetState', () => {
  it('reads a well-formed reading', () => {
    const state = parseNetState(reading());
    expect(state).toEqual({
      updatedAtMs: NOW,
      available: true,
      online: true,
      ssid: 'Home',
      signal: 71,
      apActive: false,
      apSsid: null,
      scan: [],
      scanAgeSeconds: 0,
      lastError: null,
    });
  });

  it('reads a scan list', () => {
    const state = parseNetState(
      reading({
        apSsid: 'bloopbox-A1B2',
        scanAgeSeconds: 12,
        scan: [
          { ssid: 'Home', signal: 71, secure: true },
          { ssid: 'Cafe', signal: 20, secure: false },
        ],
      }),
    );
    expect(state?.scan).toEqual([
      { ssid: 'Home', signal: 71, secure: true },
      { ssid: 'Cafe', signal: 20, secure: false },
    ]);
    expect(state?.apSsid).toBe('bloopbox-A1B2');
    expect(state?.scanAgeSeconds).toBe(12);
  });

  it('drops the whole scan list if any entry is malformed', () => {
    // A picker showing some of the networks is worse than one showing none: only the second
    // is obviously wrong, and the first sends a parent looking for a network that is there.
    const state = parseNetState(
      reading({ scan: [{ ssid: 'Home', signal: 71, secure: true }, { signal: 40 }] }),
    );
    expect(state?.scan).toEqual([]);
  });

  it("defaults a scanned network's missing fields to the cautious answer", () => {
    const state = parseNetState(reading({ scan: [{ ssid: 'Home' }] }));
    // Secure unless told otherwise: hiding a passphrase box that was needed is the worse
    // failure, and it happens on a phone with no way to go back.
    expect(state?.scan).toEqual([{ ssid: 'Home', signal: 0, secure: true }]);
  });

  it('keeps a join failure so the portal can explain it', () => {
    const state = parseNetState(reading({ lastError: 'could not join Home' }));
    expect(state?.lastError).toBe('could not join Home');
  });

  it('rejects anything that is not a JSON object', () => {
    expect(parseNetState('')).toBeNull();
    expect(parseNetState('not json')).toBeNull();
    expect(parseNetState('[]')).toBeNull();
    expect(parseNetState('null')).toBeNull();
    expect(parseNetState('"online"')).toBeNull();
  });

  it('rejects a version it does not know', () => {
    expect(parseNetState(reading({ version: 2 }))).toBeNull();
    expect(parseNetState(reading({ version: '1' }))).toBeNull();
  });

  it('rejects a reading with no usable timestamp', () => {
    expect(parseNetState(reading({ updatedAtMs: 'soon' }))).toBeNull();
    expect(parseNetState(reading({ updatedAtMs: null }))).toBeNull();
    expect(parseNetState(reading({ updatedAtMs: Number.NaN }))).toBeNull();
  });

  it('treats wrong-typed booleans as false rather than throwing', () => {
    // A shell script writing `"true"` must not read as online.
    const state = parseNetState(reading({ online: 'true', available: 1 }));
    expect(state?.online).toBe(false);
    expect(state?.available).toBe(false);
  });

  it('normalises an absent or empty ssid to null', () => {
    expect(parseNetState(reading({ ssid: '' }))?.ssid).toBeNull();
    expect(parseNetState(reading({ ssid: null }))?.ssid).toBeNull();
    expect(parseNetState(reading({ ssid: 42 }))?.ssid).toBeNull();
  });

  it('keeps an ssid containing quotes and backslashes intact', () => {
    // The agent escapes both by hand; this is the round trip.
    const awkward = 'the "wifi" \\ box';
    expect(parseNetState(reading({ ssid: awkward }))?.ssid).toBe(awkward);
  });
});

describe('isWifiDown', () => {
  it('is false when there is no reading at all', () => {
    // The dev-machine case: the agent only runs on the device.
    expect(isWifiDown(null, NOW)).toBe(false);
  });

  it('is false when the agent has nothing to report', () => {
    const state = parseNetState(reading({ available: false, online: false }));
    expect(isWifiDown(state, NOW)).toBe(false);
  });

  it('is false when the reading is stale, however bad it says things are', () => {
    const state = parseNetState(reading({ online: false }));
    expect(isWifiDown(state, NOW + NET_STATE_MAX_AGE_MS + 1)).toBe(false);
  });

  it('is true only for a fresh reading that says the network is gone', () => {
    const state = parseNetState(reading({ online: false, ssid: null, signal: null }));
    expect(isWifiDown(state, NOW)).toBe(true);
    expect(isWifiDown(state, NOW + NET_STATE_MAX_AGE_MS)).toBe(true);
  });

  it('is false while associated', () => {
    expect(isWifiDown(parseNetState(reading()), NOW)).toBe(false);
  });

  it('counts the setup hotspot as down: hosting a network is not being on one', () => {
    const state = parseNetState(reading({ online: false, apActive: true, ssid: null }));
    expect(isWifiDown(state, NOW)).toBe(true);
  });
});

describe('isStale', () => {
  it('turns over exactly at the max age', () => {
    const state = parseNetState(reading());
    if (state === null) throw new Error('unreachable');
    expect(isStale(state, NOW + NET_STATE_MAX_AGE_MS)).toBe(false);
    expect(isStale(state, NOW + NET_STATE_MAX_AGE_MS + 1)).toBe(true);
  });
});

describe('readNetState', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bloopbox-net-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('returns null for a file that is not there', async () => {
    expect(await readNetState(join(directory, 'absent.json'))).toBeNull();
  });

  it('returns null for a truncated file rather than throwing', async () => {
    // What a reader would see mid-write, if the agent did not write atomically.
    const path = join(directory, 'net-state.json');
    await writeFile(path, '{"version":1,"updatedAtMs":180000000');
    expect(await readNetState(path)).toBeNull();
  });

  it('reads a published reading', async () => {
    const path = join(directory, 'net-state.json');
    await writeFile(path, reading());
    expect((await readNetState(path))?.ssid).toBe('Home');
  });
});

describe('NetStateWatcher', () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bloopbox-net-'));
    path = join(directory, 'net-state.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reports nothing while there is no reading, and stays quiet', async () => {
    const changes: boolean[] = [];
    const watcher = new NetStateWatcher({
      path,
      now: () => NOW,
      onWifiDownChange: (down) => changes.push(down),
    });

    await watcher.poll();
    await watcher.poll();

    expect(changes).toEqual([]);
    expect(watcher.wifiDown).toBe(false);
    watcher.stop();
  });

  it('fires once per transition, not once per poll', async () => {
    const changes: boolean[] = [];
    const watcher = new NetStateWatcher({
      path,
      now: () => NOW,
      onWifiDownChange: (down) => changes.push(down),
    });

    await writeFile(path, reading());
    await watcher.poll();
    await watcher.poll();
    expect(changes).toEqual([]);

    await writeFile(path, reading({ online: false }));
    await watcher.poll();
    await watcher.poll();
    expect(changes).toEqual([true]);

    await writeFile(path, reading());
    await watcher.poll();
    expect(changes).toEqual([true, false]);
    watcher.stop();
  });

  it('recovers to "not down" when the agent stops publishing', async () => {
    // The agent dying must not leave the device stuck showing an outage.
    let clock = NOW;
    const changes: boolean[] = [];
    const health: boolean[] = [];
    const watcher = new NetStateWatcher({
      path,
      now: () => clock,
      onWifiDownChange: (down) => changes.push(down),
      onAgentHealthChange: (healthy) => health.push(healthy),
    });

    await writeFile(path, reading({ online: false }));
    await watcher.poll();
    expect(changes).toEqual([true]);
    expect(health).toEqual([true]);

    clock = NOW + NET_STATE_MAX_AGE_MS + 1;
    await watcher.poll();
    expect(changes).toEqual([true, false]);
    expect(health).toEqual([true, false]);
    watcher.stop();
  });

  it('exposes the last reading for the status payload', async () => {
    const watcher = new NetStateWatcher({
      path,
      now: () => NOW,
      onWifiDownChange: () => {},
    });
    await writeFile(path, reading({ ssid: 'Kitchen', signal: 44 }));
    await watcher.poll();
    expect(watcher.last?.ssid).toBe('Kitchen');
    expect(watcher.last?.signal).toBe(44);
    watcher.stop();
  });
});
