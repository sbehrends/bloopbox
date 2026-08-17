/**
 * System feedback cues (PRODUCT.md §7).
 *
 * Kept free of any Node imports because the browser simulator plays these too — it shares
 * this vocabulary over the IPC contract without pulling in hardware types.
 */

export const AudioCue = {
  /**
   * The device has come up. Beyond the spec's cue list: §6 defines a boot LED pattern but
   * names no sound, and a screenless box that makes no noise when it powers on is
   * indistinguishable from one that did not power on at all.
   */
  Boot: 'boot',
  /** Recording confirmed — short, high "pop". */
  Pop: 'pop',
  /** Recording finished — upward "whoosh". */
  Whoosh: 'whoosh',
  /** Delivered to WhatsApp — success "swoosh". */
  Swoosh: 'swoosh',
  /** Nothing sent — low double-beep. */
  Oops: 'oops',
  /** Separator between queued voice notes. */
  Chime: 'chime',
  /**
   * A voice note arrived. Beyond the spec's cue list, but §7 implies inbound notification
   * exists in audible mode by stating that silent mode suppresses it.
   */
  Notify: 'notify',
} as const;

export type AudioCue = (typeof AudioCue)[keyof typeof AudioCue];

/** Every cue, for iteration (generating the WAVs, preloading in the browser). */
export const ALL_AUDIO_CUES: readonly AudioCue[] = Object.values(AudioCue);

/**
 * Cues suppressed in silent mode. Playback of actual voice notes is never suppressed —
 * tapping a blinking button always plays at the configured volume (PRODUCT.md §7).
 */
const SILENCED_IN_SILENT_MODE: ReadonlySet<AudioCue> = new Set<AudioCue>([
  /*
   * Silenced like every other courtesy sound. Power is restored at whatever hour the grid
   * decides, so a boot chime is exactly the kind of noise quiet hours exist to stop — and
   * the boot LED chase still says the same thing to anyone awake to see it.
   */
  AudioCue.Boot,
  AudioCue.Pop,
  AudioCue.Whoosh,
  AudioCue.Swoosh,
  AudioCue.Oops,
  AudioCue.Notify,
]);

/** Whether this cue should be heard given the current silent-mode state. */
export function shouldPlayCue(cue: AudioCue, silentMode: boolean): boolean {
  if (!silentMode) return true;
  return !SILENCED_IN_SILENT_MODE.has(cue);
}
