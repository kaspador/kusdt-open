// Run 21, info I1 of round 2's reviewer chain2 (findings.md; evidence run-21/agents/chain2/logs/mempool1.out, a
// getMempoolEntries of the TN10 node on 13 November 2026, and logs/simnet-224115.log): feerateCeiling divided a
// mempool entry's fee by its compute mass, but the node compares a replacement per gram of the larger of the compute
// and storage masses ("fee rate per contextual mass gram"). On a mint on simnet (fee 3 323 700, compute mass 19 466,
// storage mass 33 237) it read 170.7 sompi a gram where the node counts 100: a pause at 100 a gram was refused as "not
// greater". On TN10's entries (storage masses of 266 626 to 412 855 against compute masses of 15 522 to 21 433) it
// read 17 to 19 times too high. An outbid built on it overpaid, or was given up as over its cap when it would have won.
import { describe, expect, it } from 'vitest';
import { feerateCeiling } from './minable';

/** Entries as kaspad 2.1.0 answers them: the fee beside the transaction, which carries mass, storageMass and verboseData.computeMass. */
const entry = (fee: number, computeMass: number, storageMass?: number) => ({
  fee: BigInt(fee),
  tx: { version: 1, mass: storageMass ?? 0, ...(storageMass === undefined ? {} : { storageMass }), verboseData: { transactionId: 'ab'.repeat(32), computeMass } },
});

describe('chain2 I1: feerateCeiling is the fee over the larger of the compute and storage masses, as the node counts it', () => {
  it('real-shaped entries: TN10\'s mempool and the simnet mint', () => {
    const read = {
      // TN10, getMempoolEntries: 2 inputs, 5 outputs (548ca392…) and 6 inputs, 9 outputs (82788405…).
      tn10Small: feerateCeiling(entry(26_662_600, 15_522, 266_626)),
      tn10Large: feerateCeiling(entry(5_619_326, 21_433, 412_855)),
      // The mint the node would not let a pause at 100 a gram replace.
      simnetMint: feerateCeiling(entry(3_323_700, 19_466, 33_237)),
    };
    console.info('R21-chain2-I1', JSON.stringify(read));
    expect(read.tn10Small).toBe(100);
    expect(read.tn10Large).toBeCloseTo(5_619_326 / 412_855, 9);
    expect(read.simnetMint).toBe(100);
  });

  it('a storage mass under the compute mass, or none said, leaves the compute mass: the figure then reads high, never low', () => {
    expect(feerateCeiling(entry(2_000_000, 4_000, 1_000))).toBe(500);
    expect(feerateCeiling(entry(2_000_000, 4_000))).toBe(500);
    expect(feerateCeiling({ fee: 2_000_000n, tx: { storageMass: 'not a number', verboseData: { computeMass: 4_000 } } })).toBe(500);
    // As before: no fee or no compute mass said, no figure.
    expect(feerateCeiling({ fee: null, tx: { storageMass: 8_000, verboseData: { computeMass: 4_000 } } })).toBeNull();
    expect(feerateCeiling({ fee: 2_000_000n, tx: { storageMass: 8_000, verboseData: {} } })).toBeNull();
  });
});
