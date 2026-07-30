import { describe, expect, it, vi } from 'vitest';
import { DeviceState, DeviceStatus } from '../core/deviceState.ts';

/** The state machine that the LED animator and admin UI both read from. */

describe('lifecycle status', () => {
  it('starts booting and only reports online once ready', () => {
    const state = new DeviceState();

    expect(state.status).toBe(DeviceStatus.Booting);
    expect(state.isOnline).toBe(false);

    state.setStatus(DeviceStatus.Connecting);
    expect(state.isOnline).toBe(false);

    state.setStatus(DeviceStatus.Ready);
    expect(state.isOnline).toBe(true);
  });

  it('emits change only when the status actually differs', () => {
    const state = new DeviceState();
    const onChange = vi.fn<() => void>();
    state.on('change', onChange);

    state.setStatus(DeviceStatus.Ready);
    state.setStatus(DeviceStatus.Ready);

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('silent mode', () => {
  it('is on when either the schedule or the manual chord says so', () => {
    const state = new DeviceState();

    state.setScheduledSilent(true);
    expect(state.silentMode).toBe(true);

    state.setScheduledSilent(false);
    expect(state.silentMode).toBe(false);

    state.setManualSilent(true);
    expect(state.silentMode).toBe(true);
  });

  it('distinguishes scheduled silence from a manual override for the admin UI', () => {
    const state = new DeviceState();

    state.setScheduledSilent(true);
    expect(state.snapshot().silentFromSchedule).toBe(true);

    state.setManualSilent(true);
    expect(state.snapshot().silentFromSchedule).toBe(false);
  });

  it('lets the chord force audio back on during scheduled quiet hours', () => {
    const state = new DeviceState();
    state.setScheduledSilent(true);

    state.toggleSilent();

    // A parent overriding the schedule must actually get sound.
    expect(state.silentMode).toBe(false);
  });

  it('lets the chord force silence outside quiet hours', () => {
    const state = new DeviceState();
    state.toggleSilent();
    expect(state.silentMode).toBe(true);
  });

  it('announces only real transitions, not redundant sets', () => {
    const state = new DeviceState();
    const onSilent = vi.fn<() => void>();
    state.on('silentModeChanged', onSilent);

    state.setManualSilent(true);
    state.setScheduledSilent(true); // already effectively silent
    state.setScheduledSilent(false);

    expect(onSilent).toHaveBeenCalledTimes(1);
    expect(onSilent).toHaveBeenCalledWith({ silentMode: true });
  });

  it('reports the transition when silence lifts', () => {
    const state = new DeviceState();
    state.setManualSilent(true);

    const onSilent = vi.fn<() => void>();
    state.on('silentModeChanged', onSilent);
    state.setManualSilent(false);

    expect(onSilent).toHaveBeenCalledWith({ silentMode: false });
  });
});

describe('unread tracking', () => {
  it('accumulates per contact and clears per contact', () => {
    const state = new DeviceState();

    state.addUnread(0);
    state.addUnread(0, 2);
    state.addUnread(2);

    expect(state.unreadCount(0)).toBe(3);
    expect(state.unreadCount(1)).toBe(0);
    expect(state.unreadCount(2)).toBe(1);
    expect(state.totalUnread).toBe(4);

    state.clearUnread(0);
    expect(state.hasUnread(0)).toBe(false);
    expect(state.hasUnread(2)).toBe(true);
  });

  it('ignores non-positive additions', () => {
    const state = new DeviceState();
    const onChange = vi.fn<() => void>();
    state.on('change', onChange);

    state.addUnread(1, 0);
    state.addUnread(1, -5);

    expect(state.totalUnread).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not emit when clearing an already-empty queue', () => {
    const state = new DeviceState();
    const onChange = vi.fn<() => void>();
    state.on('change', onChange);

    state.clearUnread(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('snapshots', () => {
  it('are immutable copies, not live views', () => {
    const state = new DeviceState();
    state.addUnread(0, 2);

    const before = state.snapshot();
    state.addUnread(0, 3);

    // The earlier snapshot must not have changed underneath the animator.
    expect(before.unreadCounts[0]).toBe(2);
    expect(state.snapshot().unreadCounts[0]).toBe(5);
  });

  it('carry recording and playback targets', () => {
    const state = new DeviceState();

    state.setRecording(1);
    state.setPlaying(2);

    expect(state.snapshot()).toMatchObject({ recording: 1, playing: 2 });
  });
});

describe('describe()', () => {
  it('summarises the state for logs', () => {
    const state = new DeviceState();
    state.setStatus(DeviceStatus.Ready);
    state.setManualSilent(true);
    state.setRecording(0);
    state.addUnread(2, 3);

    const text = state.describe();

    expect(text).toContain('READY');
    expect(text).toContain('silent');
    expect(text).toContain('recording:button1');
    expect(text).toContain('unread:3');
  });
});

describe('messageSent', () => {
  it('reports the button that sent, driving the 3-flash cue', () => {
    const state = new DeviceState();
    const onSent = vi.fn<() => void>();
    state.on('messageSent', onSent);

    state.reportMessageSent(1);

    expect(onSent).toHaveBeenCalledWith({ index: 1 });
  });
});
