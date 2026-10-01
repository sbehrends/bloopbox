import { describe, expect, it } from 'vitest';
import { toBuffer } from '../server/binary.ts';

/** What the simulator's microphone arrives as, depending on the browser and Socket.io's parser. */
describe('toBuffer', () => {
  it('passes a Buffer through untouched', () => {
    const buffer = Buffer.from([1, 2, 3]);
    expect(toBuffer(buffer)).toBe(buffer);
  });

  it('wraps an ArrayBuffer', () => {
    expect(toBuffer(new Uint8Array([4, 5, 6]).buffer)).toEqual(Buffer.from([4, 5, 6]));
  });

  it('takes only the viewed slice of a typed array, not its whole backing store', () => {
    // A view into a larger pool: copying `.buffer` whole would ship the neighbours too.
    const pool = new Uint8Array([9, 9, 7, 8, 9, 9]);
    expect(toBuffer(pool.subarray(2, 4))).toEqual(Buffer.from([7, 8]));
    expect(toBuffer(new Int16Array([258]))).toEqual(Buffer.from(new Int16Array([258]).buffer));
  });

  it('refuses anything that is not binary', () => {
    for (const value of ['audio', 42, null, undefined, { length: 3 }, [1, 2, 3]]) {
      expect(toBuffer(value)).toBeNull();
    }
  });
});
