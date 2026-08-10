import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_AUDIO_CUES, AudioCue } from '../audio/cues.ts';
import {
  CUE_SAMPLES,
  cuePath,
  missingSamples,
  sampledCues,
  samplePath,
  SAMPLES_DIRECTORY,
  SOUNDS_DIRECTORY,
} from '../audio/soundFiles.ts';

/**
 * The cue asset contract.
 *
 * The WAVs are generated and gitignored, so nothing here may assert they exist. The **source
 * recordings** are committed, and that is the part worth locking: a rename or a lost file
 * makes `npm run sounds` fail, and the failure surfaces during a release build rather than
 * next to the change that caused it.
 */
describe('cue sample sources', () => {
  it('ships every recording a sampled cue is built from', () => {
    expect(missingSamples()).toEqual([]);
  });

  it('names a real cue for every sample', () => {
    for (const cue of sampledCues()) {
      expect(ALL_AUDIO_CUES).toContain(cue);
    }
  });

  it('resolves a sampled cue to a file inside the samples directory', () => {
    const boot = samplePath(AudioCue.Boot);
    expect(boot).not.toBeNull();
    expect(dirname(boot!)).toBe(SAMPLES_DIRECTORY);
    expect(basename(boot!)).toBe(CUE_SAMPLES[AudioCue.Boot]);
    expect(existsSync(boot!)).toBe(true);
  });

  it('resolves a synthesised cue to no sample at all', () => {
    // `pop` is tones in scripts/generate-sounds.ts; nothing should claim a recording for it.
    expect(samplePath(AudioCue.Pop)).toBeNull();
  });

  /*
   * Both halves of the pipeline write into the same directory under the cue's own name, so a
   * sampled cue and a synthesised one are indistinguishable to everything downstream — the
   * HAL, the static route, the simulator. That is the property that keeps `playCue` from ever
   * needing to know where a sound came from.
   */
  it('places every cue WAV in the sounds directory regardless of how it was made', () => {
    for (const cue of ALL_AUDIO_CUES) {
      expect(dirname(cuePath(cue))).toBe(SOUNDS_DIRECTORY);
      expect(basename(cuePath(cue))).toBe(`${cue}.wav`);
    }
    expect(SAMPLES_DIRECTORY).not.toBe(SOUNDS_DIRECTORY);
  });
});
