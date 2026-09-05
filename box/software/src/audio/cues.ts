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
  /** Start talking — short, high "pop". Plays *before* the microphone opens. */
  Pop: 'pop',
  /**
   * Message sent — upward "whoosh". The only sound a successful send makes.
   *
   * There was a second cue here once, `swoosh`, played when WhatsApp accepted the message.
   * Retired 2026-08-17: back to back the two read as one confused noise to a small child
   * rather than as two facts, and delivery is already reported by the lamp flashing. Its
   * source recording is still in `samples/`, unreferenced, if a delivery sound is ever wanted
   * back somewhere it can stand alone.
   */
  Whoosh: 'whoosh',
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
  AudioCue.Oops,
  AudioCue.Notify,
]);

/** Whether this cue should be heard given the current silent-mode state. */
export function shouldPlayCue(cue: AudioCue, silentMode: boolean): boolean {
  if (!silentMode) return true;
  return !SILENCED_IN_SILENT_MODE.has(cue);
}
