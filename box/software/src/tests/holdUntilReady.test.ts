import { describe, expect, it } from 'vitest';
import { HoldUntilReady } from '../whatsapp/holdUntilReady.ts';

/**
 * The bridge's buffer for voice notes that arrive before it knows who is allowed.
 *
 * WhatsApp flushes the offline backlog the moment the socket opens, already acknowledged, and
 * the contact list comes from the hardware server some time later. Judged against an empty
 * whitelist, every one of those notes is dropped and never delivered again.
 */
describe('HoldUntilReady', () => {
  it('holds items until opened, then hands them over oldest first', () => {
    const handled: string[] = [];
    const gate = new HoldUntilReady<string>({ handle: (item) => handled.push(item), capacity: 10 });

    gate.push('first');
    gate.push('second');
    expect(handled).toEqual([]);
    expect(gate.heldCount).toBe(2);

    gate.open();
    expect(handled).toEqual(['first', 'second']);
    expect(gate.heldCount).toBe(0);
  });

  it('passes items straight through once open', () => {
    const handled: string[] = [];
    const gate = new HoldUntilReady<string>({ handle: (item) => handled.push(item), capacity: 10 });
    gate.open();

    gate.push('live');
    expect(handled).toEqual(['live']);
  });

  it('opens once: a second open releases nothing twice', () => {
    // The contact list is re-sent on every hardware-server reconnect.
    const handled: string[] = [];
    const gate = new HoldUntilReady<string>({ handle: (item) => handled.push(item), capacity: 10 });
    gate.push('held');
    gate.open();
    gate.open();
    expect(handled).toEqual(['held']);
  });

  it('is bounded, dropping the oldest and saying so', () => {
    // A hardware server that never answers must not grow the bridge without limit.
    const handled: string[] = [];
    const dropped: string[] = [];
    const gate = new HoldUntilReady<string>({
      handle: (item) => handled.push(item),
      capacity: 2,
      onOverflow: (item) => dropped.push(item),
    });

    gate.push('a');
    gate.push('b');
    gate.push('c');
    gate.open();

    expect(dropped).toEqual(['a']);
    expect(handled).toEqual(['b', 'c']);
  });
});
