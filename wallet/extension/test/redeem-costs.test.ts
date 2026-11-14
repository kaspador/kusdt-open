import { describe, expect, it } from 'vitest';
import { highFeeText, kasBalanceChange } from '@/kusdt/redeem';

const KAS = 100_000_000n;
const state = (amount: bigint) => ({ utxo: { transactionId: 'aa'.repeat(32), index: 0, amount, scriptPublicKey: '', blockDaaScore: 0n, isCoinbase: false, covenantId: null } as any, state: {} as any });
const built = (fee: bigint) => ({ txid: 'bb'.repeat(32), fee, mass: { compute: 0n, storage: 0n, transient: 0n, feeMass: 0n }, outputs: [] }) as any;

describe('what a redemption costs', () => {
  it('a whole token state: its 1.5 KAS comes back less the 0.3 burn and the fee (testnet, 2026-11-04)', () => {
    // A tester's burn of 0.583132 kUSDT: in 1.5 KAS, burn 0.3, back 1.084109, network fee 0.115891.
    expect(kasBalanceChange({ picked: [state(150_000_000n)], built: built(11_589_100n), tokenValue: 30_000_000n, keptInToken: 0n })).toBe(108_410_900n);
  });

  it('part of a state: the change keeps 1.5 KAS (still yours), so the balance pays the burn and the fee', () => {
    expect(kasBalanceChange({ picked: [state(150_000_000n)], built: built(5_000_000n), tokenValue: 30_000_000n, keptInToken: 150_000_000n })).toBe(-35_000_000n);
  });

  it('says nothing while merges come first', () => {
    expect(kasBalanceChange({ picked: [state(KAS)], built: null, tokenValue: 30_000_000n, keptInToken: 0n })).toBeNull();
  });

  it('points out a release fee above 20 % of the burn', () => {
    const t = highFeeText(583_132n, 500_000n) ?? '';
    expect(t).toMatch(/^The release fee takes 85\.74 % of this redemption: 0\.5\d* USDT of it, so you receive only 0\.08\d* USDT\. From 2\.5\d* kUSDT on, the fee is 20 % or less\.$/);
    expect(highFeeText(1_000_000n, 500_000n)).toMatch(/takes 50\.00 %/);
    expect(highFeeText(2_500_000n, 500_000n)).toBeNull(); // exactly 20 %
    expect(highFeeText(14_500_000n, 500_000n)).toBeNull();
    expect(highFeeText(500_000n, 500_000n)).toBeNull(); // not payable: refused elsewhere
  });
});
