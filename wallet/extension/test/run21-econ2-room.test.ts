// Run 21 round 2, R21-ECON-2 (the wallet's part), from reviewer "econ2": KusdtVault.release queues a payout only while
// reservedUnits + units ≤ releaseCapacity. A burn of the whole capacity of an idle vault therefore needs the queue empty
// at the moment its payout is queued, and anyone can keep one tiny payout always waiting there (on BNB Chain, one
// 0.500001 kUSDT burn every five minutes): the large burn then waits for as long as they keep it up, 72 h in the
// reviewer's run. The wallet offered up to the whole capacity. Now one burn leaves 1 % of the capacity free, beside
// what is queued, for payouts that may be queued first, and the wallet says so; the vault's own answer, read right
// before the burn, is held to the same rule.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selector } from '@/evm/abi';
import { checkRedeemAmount, planRedeem, ROOM_KEPT_BPS, VAULT_READER } from '@/kusdt/redeem';
import { session } from '@/lib/storage';
import { FakeNode, devKey, fakeApi, signerFor, testCtx } from './helpers';

const USDT = 1_000_000n;
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
/** /status for the Ethereum vault: a 50,000 USDT capacity, everything else plenty. */
const status = (over: Record<string, unknown> = {}) => ({ chains: [{
  chain: 1, name: 'ethereum-local', chainId: 31337, paused: false, backing: 10 ** 12, unreservedBacking: 10 ** 12, reservedUnits: 0, releaseAvailable: 10 ** 12,
  fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: 500000, minDeposit: 10000000, maxDeposit: 100000000000, releaseCapacity: 50_000_000_000, releaseRefillPerSecond: 2893518 }, ...over,
}] });

const reader = VAULT_READER.rpc;
afterEach(() => { VAULT_READER.rpc = reader; });
beforeEach(async () => { await session.remove('kusdt.pending.simnet'); });

describe('R21-ECON-2: one burn leaves room under the release capacity for payouts queued first', () => {
  it('keeps 1 % of the capacity', () => {
    expect(ROOM_KEPT_BPS).toBe(100n);
  });

  it('on an idle vault of 50,000 USDT capacity, takes at most 49,500 USDT, and says why', () => {
    expect(checkRedeemAmount(status(), 'ethereum', 49_500n * USDT).problem).toBeNull();
    const p = checkRedeemAmount(status(), 'ethereum', 50_000n * USDT).problem;
    expect(p).toMatch(/One burn can take at most 49,500 USDT of the ethereum-local vault's release capacity of 50,000 USDT right now/);
    expect(p).toMatch(/500 USDT of it is kept for payouts that may be queued first/);
    expect(checkRedeemAmount(status(), 'ethereum', 49_500n * USDT + 1n).problem).toMatch(/at most 49,500 USDT/);
  });

  it('payouts already waiting count as before, beside the room kept', () => {
    const queued = status({ reservedUnits: 10_000_000_000 });
    expect(checkRedeemAmount(queued, 'ethereum', 39_500n * USDT).problem).toBeNull();
    const p = checkRedeemAmount(queued, 'ethereum', 39_500n * USDT + 1n).problem;
    expect(p).toMatch(/at most 39,500 USDT/);
    expect(p).toMatch(/10,000 USDT of payouts already wait in it/);
  });

  it('the vault\'s own answer is held to the same rule: a 50,000 USDT burn on a 50,000 USDT vault is not built', async () => {
    const alice = devKey('r21-econ2-a');
    const node = new FakeNode();
    const ctx = testCtx(node, fakeApi({ status: async () => status({ fees: { ...status().chains[0].fees, releaseCapacity: 10 ** 12 } }) }));
    const views: Record<string, bigint> = {
      [selector('paused()')]: 0n, [selector('unreservedBacking()')]: 10n ** 12n, [selector('releaseAvailable()')]: 10n ** 12n,
      [selector('reservedUnits()')]: 0n, [selector('releaseCapacity()')]: 50_000n * USDT,
    };
    VAULT_READER.rpc = () => ({ ethCall: async (_to: string, data: string) => word(views[data.slice(0, 10)] ?? 500_000n) });
    const e = await planRedeem(ctx, signerFor(alice), [alice.address], { chain: 'ethereum', address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', amount: 50_000n * USDT }).then(() => null, (x: Error) => x);
    expect(e?.message).toMatch(/One burn can take at most 49,500 USDT of the Ethereum \(local\) vault's release capacity of 50,000 USDT/);
    expect(e?.message).toMatch(/Nothing was burnt/);
    expect(node.submitted).toEqual([]);
  });
});
