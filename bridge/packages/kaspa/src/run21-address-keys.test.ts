// Run 21, round 2 (reviewer crypto2, R21-CRYPTO-5): an address whose payload is no key on secp256k1 decodes, names an
// owner and a script, and nothing can ever spend what is paid there (the script engine refuses such a key). The
// checksum stops typos, not an address made up to hold no key. addressKeyIsOnCurve is the check a form that takes a
// recipient's address makes after decoding it: a version-0 payload must be an x-only key, a version-1 payload a
// compressed one; a script hash has no point to check.
import { describe, expect, it } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { addressKeyIsOnCurve, decodeKaspaAddress, encodeKaspaAddress, type KaspaAddressVersion } from './address';

const decoded = (version: KaspaAddressVersion, payload: Uint8Array) => decodeKaspaAddress(encodeKaspaAddress('kaspa', version, payload))!;
const x = (n: bigint) => Uint8Array.from(Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * (31 - i))) & 0xffn)));
/** The first x from `from` up that is no x coordinate on the curve: x = 5 (the reviewer's). */
const offCurve = (from: bigint) => { for (let n = from; ; n++) if (!secp256k1.utils.isValidPublicKey(Uint8Array.from([2, ...x(n)]), true)) return x(n); };

describe('R21-CRYPTO-5: addressKeyIsOnCurve', () => {
  it('is false for a payload that is no key on the curve', () => {
    const cases: [string, KaspaAddressVersion, Uint8Array][] = [
      ['v0, x off the curve', 0, offCurve(5n)],
      ['v0, x past the field (all ff)', 0, new Uint8Array(32).fill(0xff)],
      ['v1, 04-prefixed 33 bytes', 1, Uint8Array.from([4, ...new Uint8Array(32).fill(0x5a)])],
      ['v1, 02-prefixed x off the curve', 1, Uint8Array.from([2, ...offCurve(5n)])],
    ];
    for (const [name, version, payload] of cases) expect(addressKeyIsOnCurve(decoded(version, payload)), name).toBe(false);
  });

  it('is true for every real key, either parity, and for any script hash', () => {
    for (let i = 0; i < 64; i++) {
      const secret = secp256k1.utils.randomSecretKey();
      expect(addressKeyIsOnCurve(decoded(0, schnorr.getPublicKey(secret)))).toBe(true);
      expect(addressKeyIsOnCurve(decoded(1, secp256k1.getPublicKey(secret, true)))).toBe(true);
    }
    expect(addressKeyIsOnCurve(decoded(8, new Uint8Array(32).fill(0xff)))).toBe(true);
    expect(addressKeyIsOnCurve(decoded(8, offCurve(5n)))).toBe(true);
  });
});
