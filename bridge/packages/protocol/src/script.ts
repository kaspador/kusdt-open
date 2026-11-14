// Kaspa script data pushes, as KCC-1 §3.4.2 defines them (PushMinimal for
// arguments, PushExplicit for state). Only push-only scripts are parsed: a
// signature script of a covenant input is push-only by KCC-1 §3.6.

export class ScriptError extends Error {}

/** Every push of a push-only script, as byte strings (OP_1..OP_16 and OP_1NEGATE become one byte). */
export function parsePushes(script: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  const take = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0 || i + n > script.length) throw new ScriptError('a push runs past the end of the script');
    const data = script.slice(i, i + n);
    i += n;
    return data;
  };
  while (i < script.length) {
    const op = script[i++];
    if (op === 0x00) out.push(new Uint8Array(0));
    else if (op >= 0x01 && op <= 0x4b) out.push(take(op));
    else if (op === 0x4c) out.push(take(take(1)[0]));
    else if (op === 0x4d) { const n = take(2); out.push(take(n[0] | (n[1] << 8))); }
    // Added, not ORed: a bitwise OR is a signed 32-bit integer, and a negative length would walk the parser backward for ever.
    else if (op === 0x4e) { const n = take(4); out.push(take(n[0] + n[1] * 2 ** 8 + n[2] * 2 ** 16 + n[3] * 2 ** 24)); }
    else if (op === 0x4f) out.push(Uint8Array.of(0x81));
    else if (op >= 0x51 && op <= 0x60) out.push(Uint8Array.of(op - 0x50));
    else throw new ScriptError(`opcode 0x${op.toString(16)} is not a push`);
  }
  return out;
}

/** An eight-byte little-endian signed-magnitude integer (KCC-1 §3.4.3). */
export function readInt8(bytes: Uint8Array, at = 0): bigint {
  if (at + 8 > bytes.length) throw new ScriptError('an int field needs 8 bytes');
  let v = 0n;
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(bytes[at + k] & (k === 7 ? 0x7f : 0xff));
  return bytes[at + 7] & 0x80 ? -v : v;
}

/**
 * A script number as consensus reads an argument: little-endian magnitude with
 * the sign in the top bit of the last byte, at most 8 bytes; empty is zero.
 * Argument bytes aren't signed and a txid doesn't cover them, so anyone can
 * respell one: padding and a negative zero are the same number to the script,
 * and they have to be the same number here.
 */
export function readScriptNum(bytes: Uint8Array, maxLength = 8): bigint {
  if (bytes.length > maxLength) throw new ScriptError(`a script number of ${bytes.length} bytes is too long`);
  if (bytes.length === 0) return 0n;
  const last = bytes[bytes.length - 1];
  let v = 0n;
  for (let k = bytes.length - 1; k >= 0; k--) v = (v << 8n) | BigInt(k === bytes.length - 1 ? bytes[k] & 0x7f : bytes[k]);
  return last & 0x80 ? -v : v;
}

export function writeInt8(v: bigint): Uint8Array {
  const neg = v < 0n;
  let m = neg ? -v : v;
  if (m >= 1n << 63n) throw new ScriptError('out of range for an 8-byte int');
  const out = new Uint8Array(8);
  for (let k = 0; k < 8; k++) { out[k] = Number(m & 0xffn); m >>= 8n; }
  if (neg) out[7] |= 0x80;
  return out;
}
