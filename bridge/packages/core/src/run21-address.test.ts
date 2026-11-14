// Run 21, round 2 (reviewer crypto2, R21-CRYPTO-3 and R21-CRYPTO-5): the core answers an error for an address whose
// payload is not its version's length, or that holds no version byte, where rusty-kaspa's parser panicked (in
// WebAssembly a trap, `unreachable`); and it pays no address whose key is no point on secp256k1. Through `split`, as the
// reviewer reached the parser (A2, A4).
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { core, CoreError } from './index';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
/** `prefix:` and `data` (the version byte, then the payload) in Kaspa's bech32, whatever the lengths. */
function encode(prefix: string, data: number[]): string {
  const five: number[] = [];
  let buff = 0, bits = 0;
  for (const b of data) { buff = (buff << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; five.push((buff >> bits) & 31); buff &= (1 << bits) - 1; } }
  if (bits > 0) five.push((buff << (5 - bits)) & 31);
  let c = 1n;
  for (const d of [...Array.from(prefix, (ch) => ch.charCodeAt(0) & 31), 0, ...five, 0, 0, 0, 0, 0, 0, 0, 0]) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    GEN.forEach((g, i) => { if ((c0 >> BigInt(i)) & 1n) c ^= g; });
  }
  const sum = c ^ 1n;
  return `${prefix}:${[...five, ...Array.from({ length: 8 }, (_, i) => Number((sum >> BigInt(5 * (7 - i))) & 31n))].map((d) => CHARSET[d]).join('')}`;
}
const bytes = (n: number, b: number) => new Array<number>(n).fill(b);
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const secret = new Uint8Array(32).fill(0x31);
const split = (address: string) => core.call('split', {
  network: 'simnet', changeAddress: address, count: 1, value: 50_000_000,
  funding: [{ utxo: { transactionId: 'ab'.repeat(32), index: 0, amount: 1_000_000_000, scriptPublicKey: `000020${toHex(schnorr.getPublicKey(secret))}ac` }, secretKey: toHex(secret) }],
}).value;

describe('R21-CRYPTO-3 and -5: the core reads an address without trapping, and pays only a key on the curve', () => {
  const cases: [string, number[], RegExp][] = [
    ['v0, 20-byte payload', [0, ...bytes(20, 0x5a)], /20 bytes, not 32/],
    ['v0, 33-byte payload', [0, ...bytes(33, 0x5a)], /33 bytes, not 32/],
    ['v8, 31-byte payload', [8, ...bytes(31, 0x5a)], /31 bytes, not 32/],
    ['v1, 32-byte payload', [1, ...bytes(32, 0x5a)], /32 bytes, not 33/],
    ['no version byte', [], /no version byte/],
    ['v0, x = 5, off the curve', [0, ...bytes(31, 0), 5], /secp256k1/],
    ['v1, 04-prefixed 33 bytes', [1, 4, ...bytes(32, 0x5a)], /secp256k1/],
  ];
  for (const [name, data, why] of cases) {
    it(`${name}: an error, not a trap and not a payment`, () => {
      const address = encode('kaspa', data);
      expect(() => split(address)).toThrow(CoreError);
      expect(() => split(address)).toThrow(why);
    });
  }

  it('a real key is paid as before', () => {
    const key = schnorr.getPublicKey(new Uint8Array(32).fill(0x41));
    expect(split(encode('kaspa', [0, ...key])).outputs[0].scriptPublicKey).toBe(`000020${toHex(key)}ac`);
  });
});
