// Exact integers from untrusted JSON. Node and coordinator answers keep
// 16+ digit integers as strings (parseExactJson); smaller ones are numbers.

/**
 * The longest integer string read, its sign included (Daybreak [38]). The widest number in the protocol is a uint256,
 * 78 digits. A longer string is refused before the pattern or BigInt reads it: the answers these strings come in may be
 * megabytes long, and turning millions of digits into a BigInt held the popup or the background for seconds.
 */
const MAX_DIGITS = 80;

export function toBig(v: unknown, what = 'number'): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && v.length <= MAX_DIGITS && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new Error(`Unexpected ${what}.`);
}

export function toNat(v: unknown, what = 'number'): bigint {
  const b = toBig(v, what);
  if (b < 0n) throw new Error(`Unexpected negative ${what}.`);
  return b;
}

export const isHex = (s: unknown, len?: number): s is string =>
  typeof s === 'string' && /^[0-9a-f]*$/.test(s) && s.length % 2 === 0 && (len == null || s.length === len);

export const isHex32 = (s: unknown): s is string => isHex(s, 64);

export const ZERO32 = '00'.repeat(32);

export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
