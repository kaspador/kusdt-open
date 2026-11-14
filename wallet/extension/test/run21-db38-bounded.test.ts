// Run 21, Daybreak [38] (the wallet's remainder): the coordinator's /status numbers that the wallet reads with its own
// small parsers (kusdt/api.ts chainFees, kusdt/redeem.ts chainCapacity) took any string of digits to BigInt. A
// coordinator answering a fee or a limit of millions of digits held the wallet in BigInt for over a second each time
// (7.9 M digits: 1.6 s in run 21's test). Now a string of more than 80 digits is no number, as the wallet's toBig takes
// none either: no amount comes near 80 digits.

import { describe, expect, it } from 'vitest';
import { chainFees } from '@/kusdt/api';
import { chainCapacity } from '@/kusdt/redeem';

const status = (fees: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ chains: [{
  chain: 1, name: 'ethereum-local', paused: false, backing: 1_000_000_000, releaseAvailable: 300_000_000,
  fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: 500000, releaseCapacity: 400_000_000, ...fees }, ...over,
}] });

describe('Daybreak [38]: the coordinator\'s numbers are read up to 80 digits, no further', () => {
  it('a fee of 7.9 million digits is no fee, read at once', () => {
    const at = Date.now();
    expect(chainFees(status({ minReleaseFee: '9'.repeat(7_900_000) }), 'ethereum')).toBeNull();
    expect(Date.now() - at).toBeLessThan(500);
  });

  it('a limit of more than 80 digits is not read; 80 digits still are', () => {
    expect(chainCapacity(status({}, { releaseAvailable: '9'.repeat(81) }), 'ethereum').releaseAvailable).toBeNull();
    expect(chainCapacity(status({}, { backing: '9'.repeat(5_000_000) }), 'ethereum').backing).toBeNull();
    expect(chainCapacity(status({}, { releaseAvailable: '9'.repeat(80) }), 'ethereum').releaseAvailable).toBe(10n ** 80n - 1n);
    expect(chainFees(status({ feeBps: '9'.repeat(80) }), 'ethereum')?.feeBps).toBe(10n ** 80n - 1n);
  });
});
