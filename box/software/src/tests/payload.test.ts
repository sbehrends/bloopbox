import { describe, expect, it } from 'vitest';
import {
  optionalString,
  readRevoked,
  readBoolean,
  readButtonIndex,
  readField,
  readNumber,
  readString,
} from '../ipc/payload.ts';

/**
 * Narrowing for untrusted transport payloads.
 *
 * Everything crossing Socket.io — from a browser tab, or from the bridge across a version
 * skew — arrives as `unknown`. These helpers are the only thing between that and the device's
 * state, so the cases that matter are the hostile and the merely wrong: a prototype-polluting
 * key, a number where a string belongs, a button index of 7.
 */

describe('readField', () => {
  it('reads a present property', () => {
    expect(readField({ a: 1 }, 'a')).toBe(1);
  });

  it('returns undefined rather than throwing on a non-object', () => {
    const nonObjects = [null, undefined, 'string', 42, true, Symbol('s')];
    expect(nonObjects.map((value) => readField(value, 'a'))).toEqual(
      nonObjects.map(() => undefined),
    );
  });

  it('does not invent a value from the prototype chain', () => {
    // `'toString' in {}` is true, so a naive `in` check would hand back Object.prototype's
    // method and a caller expecting a string would get a function.
    expect(readField({}, 'toString')).toBeUndefined();
    expect(readField({}, 'constructor')).toBeUndefined();
    expect(readField({}, '__proto__')).toBeUndefined();
  });

  it('reads an own property that shadows a prototype one', () => {
    expect(readField({ toString: 'shadowed' }, 'toString')).toBe('shadowed');
  });

  it('reads from an array, which is an object too', () => {
    expect(readField(['zero'], '0')).toBe('zero');
  });
});

describe('readString', () => {
  it('accepts a non-empty string', () => {
    expect(readString({ ssid: 'Casa' }, 'ssid')).toBe('Casa');
  });

  it('rejects an empty string, because no caller wants one', () => {
    // Every caller of this treats "" as absent — a blank SSID or phone number is not an answer.
    // `/wifi/join` reads its passphrase with `readField` precisely because "" *is* valid there.
    expect(readString({ ssid: '' }, 'ssid')).toBeNull();
  });

  it('rejects a value that is not a string, including a number that looks like one', () => {
    expect(readString({ phone: 15551234567 }, 'phone')).toBeNull();
    expect(readString({ phone: null }, 'phone')).toBeNull();
    expect(readString({ phone: ['15551234567'] }, 'phone')).toBeNull();
  });

  it('rejects an absent key', () => {
    expect(readString({}, 'ssid')).toBeNull();
  });

  it('caps length, so a hostile client cannot hand us a megabyte to store', () => {
    expect(readString({ v: 'x'.repeat(512) }, 'v')?.length).toBe(512);
    expect(readString({ v: 'x'.repeat(513) }, 'v')).toBeNull();
    expect(readString({ v: 'xxxx' }, 'v', 3)).toBeNull();
    expect(readString({ v: 'xxx' }, 'v', 3)).toBe('xxx');
  });
});

describe('readBoolean', () => {
  it('accepts a real boolean and nothing else', () => {
    expect(readBoolean({ silent: true }, 'silent')).toBe(true);
    expect(readBoolean({ silent: false }, 'silent')).toBe(false);
    // Truthiness is not the question: `/api/silent` toggles on null and sets on a boolean, so
    // coercing 'true' or 1 here would turn a malformed request into a state change.
    const wrong = ['true', 1, 0, '', null, {}];
    expect(wrong.map((value) => readBoolean({ silent: value }, 'silent'))).toEqual(
      wrong.map(() => null),
    );
  });
});

describe('readNumber', () => {
  it('accepts a finite number', () => {
    expect(readNumber({ v: 0 }, 'v')).toBe(0);
    expect(readNumber({ v: -12.5 }, 'v')).toBe(-12.5);
  });

  it('rejects the numbers that are not usable as numbers', () => {
    // NaN and Infinity survive JSON.parse via arithmetic on the far side and would poison any
    // duration or volume they reached.
    const wrong = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5', null];
    expect(wrong.map((value) => readNumber({ v: value }, 'v'))).toEqual(wrong.map(() => null));
  });
});

describe('readButtonIndex', () => {
  it('accepts only the three buttons that exist', () => {
    expect([0, 1, 2].map((index) => readButtonIndex({ index }))).toEqual([0, 1, 2]);
  });

  it('rejects anything else, including a fourth button and a stringified one', () => {
    // A tampered or stale client. An out-of-range index reaching the controller would index
    // past the LED and unread arrays.
    const wrong = [3, -1, 0.5, '0', null, undefined, true];
    expect(wrong.map((index) => readButtonIndex({ index }))).toEqual(wrong.map(() => null));
  });

  it('reads a differently named key', () => {
    expect(readButtonIndex({ button: 2 }, 'button')).toBe(2);
  });
});

describe('optionalString', () => {
  it('builds nothing at all when the value is missing', () => {
    // Not `{ key: undefined }`: under exactOptionalPropertyTypes an explicit undefined is a
    // different thing from an absent property, and the config schemas reject it.
    expect(optionalString({}, 'name')).toEqual({});
    expect(Object.keys(optionalString({ name: '' }, 'name'))).toEqual([]);
  });

  it('builds a single-key object when the value is there', () => {
    expect(optionalString({ name: 'Mom' }, 'name')).toEqual({ name: 'Mom' });
  });

  it('renames the key when asked', () => {
    expect(optionalString({ psk: 'secret' }, 'psk', 'password')).toEqual({ password: 'secret' });
  });
});

describe('readRevoked', () => {
  it('reads a button and a message id', () => {
    expect(readRevoked({ index: 1, messageId: '3A77C7FB' })).toEqual({
      index: 1,
      messageId: '3A77C7FB',
    });
  });

  it('refuses anything without both, or with an index that is not a button', () => {
    for (const payload of [
      { messageId: 'X' },
      { index: 1 },
      { index: 3, messageId: 'X' },
      { index: 0, messageId: '' },
      { index: 0, messageId: 'x'.repeat(129) },
      null,
      'wa:revoked',
    ]) {
      expect(readRevoked(payload)).toBeNull();
    }
  });
});
