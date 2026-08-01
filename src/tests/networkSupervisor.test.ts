import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NETWORK_TIMINGS,
  NetworkIntent,
  NetworkSupervisor,
  type NetworkObservation,
  type NetworkSupervisorOptions,
} from '../core/networkSupervisor.ts';

/**
 * The hotspot decision, with no radio and no clock: observations in, intents out.
 *
 * The behaviours worth protecting are the ones that would be miserable on a real device —
 * a hotspot appearing every time the router blinks, a hotspot that never steps aside, and
 * a request loop when bringing one up fails.
 */

const online: NetworkObservation = { available: true, online: true, apActive: false };
const offline: NetworkObservation = { available: true, online: false, apActive: false };
const hotspotUp: NetworkObservation = { available: true, online: false, apActive: true };
const unknown: NetworkObservation = { available: false, online: false, apActive: false };

const { unconfiguredGraceMs, configuredGraceMs, retryIntervalMs, joinWindowMs } =
  DEFAULT_NETWORK_TIMINGS;

function supervisor(options: Partial<NetworkSupervisorOptions> = {}): NetworkSupervisor {
  return new NetworkSupervisor({ configured: false, hasTargetNetwork: false, ...options });
}

describe('raising the hotspot', () => {
  it('waits out the grace period before offering setup', () => {
    const net = supervisor();

    expect(net.observe(offline, 0)).toBe(NetworkIntent.None);
    expect(net.observe(offline, unconfiguredGraceMs - 1)).toBe(NetworkIntent.None);
    expect(net.observe(offline, unconfiguredGraceMs)).toBe(NetworkIntent.ApUp);
  });

  it('gives a configured device far longer, so a router reboot is not an event', () => {
    const net = supervisor({ configured: true, hasTargetNetwork: true });

    // The unconfigured grace comes and goes with nothing happening.
    expect(net.observe(offline, 0)).toBe(NetworkIntent.None);
    expect(net.observe(offline, unconfiguredGraceMs)).toBe(NetworkIntent.None);
    expect(net.observe(offline, configuredGraceMs - 1)).toBe(NetworkIntent.None);
    expect(net.observe(offline, configuredGraceMs)).toBe(NetworkIntent.ApUp);
  });

  it('asks only once, however long it stays offline', () => {
    const net = supervisor();
    net.observe(offline, 0);
    expect(net.observe(offline, unconfiguredGraceMs)).toBe(NetworkIntent.ApUp);

    // The agent has not brought it up yet; asking again would queue work, not fix anything.
    expect(net.observe(offline, unconfiguredGraceMs + 1)).toBe(NetworkIntent.None);
    expect(net.observe(hotspotUp, unconfiguredGraceMs + 2)).toBe(NetworkIntent.None);
  });

  it('restarts the clock when the network comes back mid-grace', () => {
    const net = supervisor();
    net.observe(offline, 0);
    net.observe(online, 5_000);

    // A blip at t=5s must not count toward the grace that began at t=0.
    expect(net.observe(offline, 5_001)).toBe(NetworkIntent.None);
    expect(net.observe(offline, unconfiguredGraceMs)).toBe(NetworkIntent.None);
    expect(net.observe(offline, 5_001 + unconfiguredGraceMs)).toBe(NetworkIntent.ApUp);
  });
});

describe('an unknown reading is not an outage', () => {
  it('never raises a hotspot on silence from the agent', () => {
    const net = supervisor();

    // A dev machine, or an agent that died: no information at all, for a long time.
    for (let t = 0; t <= unconfiguredGraceMs * 3; t += 5_000) {
      expect(net.observe(unknown, t)).toBe(NetworkIntent.None);
    }
  });

  it('freezes the grace period rather than advancing it', () => {
    const net = supervisor();
    net.observe(offline, 0);
    net.observe(unknown, unconfiguredGraceMs);

    // The unknown reading told us nothing, so the pending decision stands on what we knew.
    expect(net.observe(offline, unconfiguredGraceMs)).toBe(NetworkIntent.ApUp);
  });
});

describe('a hotspot nobody is using steps aside', () => {
  it('drops the hotspot periodically to retry the real network', () => {
    const net = supervisor({ configured: true, hasTargetNetwork: true });
    net.observe(offline, 0);
    net.observe(offline, configuredGraceMs);
    const raised = configuredGraceMs;

    expect(net.observe(hotspotUp, raised + retryIntervalMs - 1)).toBe(NetworkIntent.None);
    expect(net.observe(hotspotUp, raised + retryIntervalMs)).toBe(NetworkIntent.ApDown);
  });

  it('puts it back if the join window closes with nothing to show', () => {
    const net = supervisor({ configured: true, hasTargetNetwork: true });
    net.observe(offline, 0);
    net.observe(offline, configuredGraceMs);
    const droppedAt = configuredGraceMs + retryIntervalMs;
    net.observe(hotspotUp, droppedAt);

    expect(net.observe(offline, droppedAt + joinWindowMs - 1)).toBe(NetworkIntent.None);
    expect(net.observe(offline, droppedAt + joinWindowMs)).toBe(NetworkIntent.ApUp);
  });

  it('stays down for good once the retry actually works', () => {
    const net = supervisor({ configured: true, hasTargetNetwork: true });
    net.observe(offline, 0);
    net.observe(offline, configuredGraceMs);
    const droppedAt = configuredGraceMs + retryIntervalMs;
    net.observe(hotspotUp, droppedAt);

    expect(net.observe(online, droppedAt + 5_000)).toBe(NetworkIntent.None);
    // Back to a full grace period, not a join window.
    expect(net.observe(offline, droppedAt + 6_000)).toBe(NetworkIntent.None);
    expect(net.observe(offline, droppedAt + 6_000 + joinWindowMs)).toBe(NetworkIntent.None);
  });

  it('never steps aside on an unconfigured device: there is nothing to rejoin', () => {
    const net = supervisor({ configured: false, hasTargetNetwork: false });
    net.observe(offline, 0);
    net.observe(offline, unconfiguredGraceMs);

    // The parent may be halfway through typing their passphrase; dropping the AP under them
    // to try a network that does not exist would be pure vandalism.
    for (let t = unconfiguredGraceMs; t <= unconfiguredGraceMs + retryIntervalMs * 4; t += 5_000) {
      expect(net.observe(hotspotUp, t)).toBe(NetworkIntent.None);
    }
  });
});

describe('failure handling', () => {
  it('does not loop when the hotspot fails to come up', () => {
    const net = supervisor();
    net.observe(offline, 0);
    expect(net.observe(offline, unconfiguredGraceMs)).toBe(NetworkIntent.ApUp);

    // The agent tried and the AP is not there. A second request on the next poll would be a
    // request per poll for as long as it keeps failing.
    let asks = 0;
    for (let t = unconfiguredGraceMs + 1; t <= unconfiguredGraceMs * 2; t += 2_000) {
      if (net.observe(offline, t) === NetworkIntent.ApUp) asks += 1;
    }
    expect(asks).toBe(0);

    // It does ask again, but only after another full grace period.
    expect(net.observe(offline, unconfiguredGraceMs * 3)).toBe(NetworkIntent.ApUp);
  });

  it('adopts a hotspot it did not raise', () => {
    const net = supervisor({ configured: true, hasTargetNetwork: true });

    expect(net.observe(hotspotUp, 0)).toBe(NetworkIntent.None);
    expect(net.phase).toBe('hotspot');
    // And then manages it normally.
    expect(net.observe(hotspotUp, retryIntervalMs)).toBe(NetworkIntent.ApDown);
  });

  it('forgets everything on reset', () => {
    const net = supervisor();
    net.observe(offline, 0);
    net.reset();

    expect(net.observe(offline, unconfiguredGraceMs)).toBe(NetworkIntent.None);
    expect(net.observe(offline, unconfiguredGraceMs * 2)).toBe(NetworkIntent.ApUp);
  });
});

describe('timings', () => {
  it('takes overrides, so they can move into config later without touching the logic', () => {
    const net = supervisor({ timings: { unconfiguredGraceMs: 1_000 } });

    expect(net.graceMs).toBe(1_000);
    net.observe(offline, 0);
    expect(net.observe(offline, 1_000)).toBe(NetworkIntent.ApUp);
  });

  it('keeps the unconfigured grace well under the configured one', () => {
    // If these ever cross, a set-up device would offer setup sooner than a fresh one.
    expect(unconfiguredGraceMs).toBeLessThan(configuredGraceMs);
    // And a retry has to outlast the window it opens, or the two overlap.
    expect(joinWindowMs).toBeLessThan(retryIntervalMs);
  });
});
