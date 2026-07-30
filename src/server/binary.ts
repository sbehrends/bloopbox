/**
 * Binary payload handling for the Socket.io transport.
 *
 * Kept out of src/ipc/ because that module is shared with the browser build, which has no
 * `Buffer` — importing it there breaks the web typecheck.
 */

/** Socket.io delivers binary as Buffer, ArrayBuffer or a typed array depending on client. */
export function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}
