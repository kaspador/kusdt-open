// Run 21, Daybreak [38] (the wallet's part): the coordinator's and the node's integers arrive as decimal strings, and
// toBig ran its pattern and BigInt over a string of any length. The answers are capped at 8 MB, which still let one
// string of millions of digits through, and turning that into a BigInt held the wallet's page or background for
// seconds. The widest number the protocol has is a uint256 (78 digits): anything longer is refused before it is read.

import { describe, expect, it } from 'vitest';
import { toBig, toNat } from '@/lib/bigint';

const UINT256_MAX = (2n ** 256n - 1n).toString();

describe('Daybreak [38]: toBig and toNat', () => {
  it('refuse a numeric string longer than 80 characters, however it is padded', () => {
    expect(() => toBig('1'.repeat(81))).toThrow(/Unexpected/);
    expect(() => toNat('0'.repeat(81))).toThrow(/Unexpected/);
    expect(() => toBig('-' + '9'.repeat(80))).toThrow(/Unexpected/);
  });

  it('refuse a string of millions of digits at once, without reading it', () => {
    const huge = '7'.repeat(7_900_000);
    const t = performance.now();
    expect(() => toNat(huge, 'pool reserve')).toThrow('Unexpected pool reserve.');
    expect(performance.now() - t).toBeLessThan(100);
  });

  it('still read every honest width exactly: a uint256, a negative one, strings and safe numbers', () => {
    expect(toBig(UINT256_MAX)).toBe(2n ** 256n - 1n);
    expect(toBig('-' + UINT256_MAX)).toBe(-(2n ** 256n - 1n));
    expect(toNat('1'.repeat(80))).toBe(BigInt('1'.repeat(80)));
    expect(toNat('18446744073709551615')).toBe(2n ** 64n - 1n);
    expect(toNat(150_000_000)).toBe(150_000_000n);
    expect(toBig(-5n)).toBe(-5n);
    expect(() => toNat('-1')).toThrow(/negative/);
    expect(() => toBig('1.5')).toThrow(/Unexpected/);
  });
});
