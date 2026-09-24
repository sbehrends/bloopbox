import { beforeEach, describe, expect, it } from 'vitest';
import { AudioCue } from '../audio/cues.ts';
import { AudioQueueManager, type QueuedNote } from '../audio/queueManager.ts';
import { MockHal } from '../hal/mockDriver.ts';
import type { ButtonIndex } from '../config/schema.ts';

/**
 * Sequential audio queue (PRODUCT.md §5): "Verifies FIFO playback ordering when multiple
 * voice notes arrive from the same contact."
 */

let hal: MockHal;
let silent: boolean;

beforeEach(() => {
  hal = new MockHal();
  silent = false;
});

function manager(): AudioQueueManager {
  return new AudioQueueManager({ hal, playCues: () => !silent });
}

let noteCounter = 0;
function note(overrides: Partial<QueuedNote> = {}): QueuedNote {
  noteCounter += 1;
  return {
    messageId: `msg-${noteCounter}`,
    path: `/tmp/note-${noteCounter}.ogg`,
    receivedAt: Date.now(),
    durationMs: 1500,
    ...overrides,
  };
}

describe('FIFO ordering', () => {
  it('plays every queued note from one contact in arrival order', async () => {
    const queue = manager();
    const first = note();
    const second = note();
    const third = note();

    queue.enqueue(1, first);
    queue.enqueue(1, second);
    queue.enqueue(1, third);

    await queue.playQueue(1);

    expect(hal.playSequence()).toEqual([first.path, second.path, third.path]);
  });

  it('separates consecutive notes with a chime, but does not lead with one', async () => {
    const queue = manager();
    queue.enqueue(0, note());
    queue.enqueue(0, note());
    queue.enqueue(0, note());

    await queue.playQueue(0);

    // Three notes -> two separators.
    expect(hal.cueSequence()).toEqual([AudioCue.Chime, AudioCue.Chime]);
  });

  it('plays a single note with no chime at all', async () => {
    const queue = manager();
    queue.enqueue(0, note());

    await queue.playQueue(0);

    expect(hal.cueSequence()).toEqual([]);
  });

  it('keeps each contact queue independent', async () => {
    const queue = manager();
    const forMom = note();
    const forDad = note();

    queue.enqueue(0, forMom);
    queue.enqueue(2, forDad);

    await queue.playQueue(2);

    expect(hal.playSequence()).toEqual([forDad.path]);
    expect(queue.count(0)).toBe(1);
    expect(queue.count(2)).toBe(0);
  });
});

describe('queue accounting', () => {
  it('tracks counts per contact and in total', () => {
    const queue = manager();
    queue.enqueue(0, note());
    queue.enqueue(0, note());
    queue.enqueue(1, note());

    expect(queue.count(0)).toBe(2);
    expect(queue.count(1)).toBe(1);
    expect(queue.count(2)).toBe(0);
    expect(queue.totalCount).toBe(3);
  });

  it('ignores a redelivered message id', () => {
    const queue = manager();
    const duplicate = note();

    queue.enqueue(0, duplicate);
    queue.enqueue(0, duplicate);

    // WhatsApp can redeliver; the child must not hear it twice.
    expect(queue.count(0)).toBe(1);
  });

  it('empties the queue as it plays', async () => {
    const queue = manager();
    queue.enqueue(1, note());
    queue.enqueue(1, note());

    await queue.playQueue(1);

    expect(queue.count(1)).toBe(0);
    expect(queue.playing).toBeNull();
  });

  it('does nothing when tapped with an empty queue', async () => {
    const queue = manager();
    await queue.playQueue(0);

    expect(hal.playSequence()).toEqual([]);
    expect(hal.cueSequence()).toEqual([]);
  });
});

describe('lifecycle events', () => {
  it('reports start, each note, and drain with the played ids', async () => {
    const queue = manager();
    const first = note();
    const second = note();
    queue.enqueue(0, first);
    queue.enqueue(0, second);

    const events: string[] = [];
    let drained: readonly string[] = [];
    queue.on('playbackStarted', ({ count }) => events.push(`started:${count}`));
    queue.on('noteStarted', ({ position, count }) => events.push(`note:${position}/${count}`));
    queue.on('noteFinished', ({ ok }) => events.push(`finished:${ok}`));
    queue.on('queueDrained', ({ messageIds }) => {
      events.push('drained');
      drained = messageIds;
    });

    await queue.playQueue(0);

    expect(events).toEqual([
      'started:2',
      'note:1/2',
      'finished:true',
      'note:2/2',
      'finished:true',
      'drained',
    ]);
    // The caller uses these to mark read upstream and delete the files.
    expect(drained).toEqual([first.messageId, second.messageId]);
  });
});

describe('resilience', () => {
  it('skips a broken clip so the rest of the queue still plays', async () => {
    const queue = manager();
    queue.enqueue(0, note());
    queue.enqueue(0, note());

    hal.failPlayback = true;
    const outcomes: boolean[] = [];
    queue.on('noteFinished', ({ ok }) => outcomes.push(ok));

    await queue.playQueue(0);

    // Both attempted, both failed, queue still drained rather than wedged.
    expect(outcomes).toEqual([false, false]);
    expect(queue.count(0)).toBe(0);
    expect(queue.playing).toBeNull();
  });

  it('still drains when every cue file is missing', async () => {
    const queue = manager();
    queue.enqueue(0, note());
    queue.enqueue(0, note());
    hal.failPlayback = true;

    await expect(queue.playQueue(0)).resolves.toBeUndefined();
  });

  it('refuses concurrent playback of a second contact', async () => {
    const queue = manager();
    queue.enqueue(0, note());
    queue.enqueue(1, note());

    const first = queue.playQueue(0);
    // While the first is in flight, a second tap must be ignored.
    await queue.playQueue(1);
    await first;

    expect(queue.count(1)).toBe(1);
  });
});

describe('interruption', () => {
  it('returns unplayed notes to the front of the queue, in order', async () => {
    const queue = manager();
    const first = note();
    const second = note();
    const third = note();
    queue.enqueue(0, first);
    queue.enqueue(0, second);
    queue.enqueue(0, third);

    // Abort as soon as the first note finishes.
    queue.on('noteFinished', () => {
      void queue.stop();
    });

    let aborted = 0;
    queue.on('playbackAborted', ({ remaining }) => (aborted = remaining));

    await queue.playQueue(0);

    expect(hal.playSequence()).toEqual([first.path]);
    expect(aborted).toBe(2);
    expect(queue.peek(0).map((n) => n.messageId)).toEqual([second.messageId, third.messageId]);
  });

  it('reports the notes heard before the stop, so they are not restored as unread', async () => {
    // Otherwise they are neither in the queue nor deleted, and the next restart — every
    // settings save — puts heard notes back on the lamp.
    const queue = manager();
    const first = note();
    const second = note();
    queue.enqueue(0, first);
    queue.enqueue(0, second);
    queue.on('noteFinished', () => {
      void queue.stop();
    });

    let heard: readonly string[] = [];
    queue.on('playbackAborted', ({ messageIds }) => (heard = messageIds));
    await queue.playQueue(0);

    expect(heard).toEqual([first.messageId]);
    expect(queue.peek(0).map((n) => n.messageId)).toEqual([second.messageId]);
  });

  it('puts a note that was cut off back at the front, unheard', async () => {
    // One speaker: a cue or a stop cuts a note off, and a cut-off note was never listened to.
    hal.holdPlayback = true;
    const queue = manager();
    const first = note();
    const second = note();
    queue.enqueue(0, first);
    queue.enqueue(0, second);

    let aborted: { messageIds: readonly string[]; remaining: number } | null = null;
    let drained = false;
    queue.on('playbackAborted', (event) => (aborted = event));
    queue.on('queueDrained', () => (drained = true));

    const playing = queue.playQueue(0);
    await Promise.resolve();
    await hal.playCue(AudioCue.Notify);
    await playing;

    expect(drained).toBe(false);
    expect(aborted).toEqual({ index: 0, messageIds: [], remaining: 2 });
    expect(queue.peek(0).map((n) => n.messageId)).toEqual([first.messageId, second.messageId]);
  });

  it('does not play the next note when the stop lands during the chime between two', async () => {
    const queue = manager();
    const first = note();
    const second = note();
    queue.enqueue(0, first);
    queue.enqueue(0, second);

    const playCue = hal.playCue.bind(hal);
    hal.playCue = async (cue) => {
      await playCue(cue);
      // The stop arrives while the separator is playing.
      if (cue === AudioCue.Chime) await queue.stop();
    };
    await queue.playQueue(0);

    expect(hal.playSequence()).toEqual([first.path]);
    expect(queue.peek(0).map((n) => n.messageId)).toEqual([second.messageId]);
  });

  it('stop() is a no-op when nothing is playing', async () => {
    const queue = manager();
    await expect(queue.stop()).resolves.toBeUndefined();
  });
});

describe('silent mode', () => {
  it('still plays the voice notes — playback is never suppressed', async () => {
    silent = true;
    const queue = manager();
    const only = note();
    queue.enqueue(0, only);

    await queue.playQueue(0);

    // PRODUCT.md §7: tapping a blinking button plays audio normally in silent mode.
    expect(hal.playSequence()).toEqual([only.path]);
  });

  it('drops the separator chime, since that is a cue', async () => {
    silent = true;
    const queue = manager();
    queue.enqueue(0, note());
    queue.enqueue(0, note());

    await queue.playQueue(0);

    expect(hal.cueSequence()).toEqual([]);
  });
});

describe('clearing', () => {
  it('returns removed notes so their files can be deleted', () => {
    const queue = manager();
    const first = note();
    queue.enqueue(1, first);
    queue.enqueue(1, note());

    const removed = queue.clear(1);

    expect(removed).toHaveLength(2);
    expect(removed[0]?.path).toBe(first.path);
    expect(queue.count(1)).toBe(0);
  });

  it('clearAll empties every contact', () => {
    const queue = manager();
    for (const index of [0, 1, 2] as ButtonIndex[]) queue.enqueue(index, note());

    const removed = queue.clearAll();

    expect(removed).toHaveLength(3);
    expect(queue.totalCount).toBe(0);
  });
});

describe('remove — a note deleted for everyone', () => {
  /** Waits until the mock HAL is holding `path` open, i.e. that note is mid-playback. */
  async function untilPlaying(path: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (hal.nowPlaying === path) return;
      await Promise.resolve();
    }
    throw new Error(`never started playing ${path}`);
  }

  it('takes a waiting note out of its queue and hands it back', () => {
    const queue = manager();
    const first = note();
    const second = note();
    queue.enqueue(1, first);
    queue.enqueue(1, second);

    expect(queue.remove(1, first.messageId)).toEqual(first);

    expect(queue.peek(1)).toEqual([second]);
    expect(queue.count(1)).toBe(1);
  });

  it('finds nothing for an unknown id, or for a note on another button', () => {
    const queue = manager();
    const onOne = note();
    queue.enqueue(1, onOne);

    expect(queue.remove(1, 'never-queued')).toBeNull();
    expect(queue.remove(0, onOne.messageId)).toBeNull();
    expect(queue.count(1)).toBe(1);
  });

  it('skips a note later in the run that is playing, chime and all', async () => {
    hal.holdPlayback = true;
    const queue = manager();
    const first = note();
    const revoked = note();
    const third = note();
    for (const queued of [first, revoked, third]) queue.enqueue(0, queued);
    let drainedIds: readonly string[] = [];
    queue.on('queueDrained', ({ messageIds }) => (drainedIds = messageIds));

    const playing = queue.playQueue(0);
    await untilPlaying(first.path);
    expect(queue.remove(0, revoked.messageId)).toEqual(revoked);
    hal.finishPlayback();
    await untilPlaying(third.path);
    hal.finishPlayback();
    await playing;

    expect(hal.playSequence()).toEqual([first.path, third.path]);
    expect(hal.cueSequence()).toEqual([AudioCue.Chime]);
    expect(drainedIds).toEqual([first.messageId, third.messageId]);
  });

  it('leaves the note that is already playing alone', async () => {
    hal.holdPlayback = true;
    const queue = manager();
    const current = note();
    queue.enqueue(2, current);

    const playing = queue.playQueue(2);
    await untilPlaying(current.path);

    expect(queue.remove(2, current.messageId)).toBeNull();
    hal.finishPlayback();
    await playing;
    expect(hal.playSequence()).toEqual([current.path]);
  });

  it('does not put a removed note back when the run is stopped', async () => {
    hal.holdPlayback = true;
    const queue = manager();
    const first = note();
    const revoked = note();
    const kept = note();
    for (const queued of [first, revoked, kept]) queue.enqueue(0, queued);

    const playing = queue.playQueue(0);
    await untilPlaying(first.path);
    queue.remove(0, revoked.messageId);
    await queue.stop();
    await playing;

    expect(queue.peek(0).map((n) => n.messageId)).toEqual([first.messageId, kept.messageId]);
  });
});
