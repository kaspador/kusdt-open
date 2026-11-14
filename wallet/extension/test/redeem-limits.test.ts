import { describe, expect, it } from 'vitest';
import { checkRedeemAmount, chainCapacity } from '@/kusdt/redeem';
import { loadPositions } from '@/kusdt/pool';
import { FakeNode, COVENANT, POOL, devKey, fakeApi, testCtx, signerFor } from './helpers';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import { local } from '@/lib/storage';

// The shape the coordinator answers (bridge/services/src/coordinator/api.ts /status).
const chainEntry = (chain: 1 | 2, over: Record<string, unknown> = {}, fees: Record<string, unknown> = {}) => ({
  chain, name: chain === 1 ? 'ethereum-local' : 'bsc-local', chainId: 31336 + chain, paused: false,
  backing: 1_000_000_000, releaseAvailable: 300_000_000,
  fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: 500000, minDeposit: 10000000, maxDeposit: 100000000000, releaseCapacity: 400_000_000, releaseRefillPerSecond: 2893518, ...fees },
  ...over,
});
const status = (one: Record<string, unknown> = {}, two: Record<string, unknown> = {}, fees1: Record<string, unknown> = {}) => ({ chains: [chainEntry(1, one, fees1), chainEntry(2, two)] });

describe('SPEC §9 checks before a burn', () => {
  it('lets an amount the vault can pay go ahead, with its fee', () => {
    const c = checkRedeemAmount(status(), 'ethereum', 100_000_000n);
    expect(c).toEqual({ fee: 500_000n, problem: null, other: null });
  });

  it('refuses an amount at or below the release fee', () => {
    expect(checkRedeemAmount(status(), 'ethereum', 500_000n).problem).toMatch(/above the ethereum-local release fee/);
    expect(checkRedeemAmount(status(), 'ethereum', 500_001n).problem).toBeNull();
  });

  it("refuses above the vault's release capacity", () => {
    const c = checkRedeemAmount(status({}, { fees: { ...chainEntry(2).fees, releaseCapacity: 100_000_000 } }), 'ethereum', 400_000_001n);
    expect(c.problem).toMatch(/release capacity of 400/);
    expect(c.other).toBeNull(); // bsc's own limits are lower still
  });

  it('refuses above what it can pay now, and names the chain that can', () => {
    const c = checkRedeemAmount(status({ releaseAvailable: 50_000_000 }), 'ethereum', 60_000_000n);
    expect(c.problem).toMatch(/at most 50 USDT right now/);
    expect(c.problem).toMatch(/bsc-local can pay it now/);
    expect(c.other).toBe('bsc');
  });

  it('refuses above the backing', () => {
    const c = checkRedeemAmount(status({ backing: 10_000_000 }, { backing: 5_000_000 }), 'ethereum', 20_000_000n);
    expect(c.problem).toMatch(/only 10 USDT of backing/);
    expect(c.other).toBeNull();
  });

  it('refuses a paused vault', () => {
    expect(checkRedeemAmount(status({ paused: true }), 'ethereum', 20_000_000n).problem).toMatch(/paused/);
  });

  it("refuses when /status doesn't say (no burn the wallet can't check)", () => {
    expect(checkRedeemAmount({}, 'bsc', 20_000_000n).problem).toMatch(/can't check/);
    expect(checkRedeemAmount({ chains: [{ chain: 2, fees: { feeBps: 20, minDepositFee: 1, minReleaseFee: 1 } }] }, 'bsc', 20_000_000n).problem).toMatch(/can't check/);
  });

  it('reads the limits by chain code or name', () => {
    const cap = chainCapacity({ chains: [{ ...chainEntry(2), chain: 'bsc' }] }, 'bsc');
    expect(cap).toMatchObject({ backing: 1_000_000_000n, releaseAvailable: 300_000_000n, releaseCapacity: 400_000_000n, paused: false });
  });
});

describe('a burn is checked the way KusdtVault.release checks it', () => {
  // 1 000 USDT of backing, 900 of it claimed by payouts in the queue; the capacity is 400 here, 2 000 where asked.
  const queued = { unreservedBacking: 100_000_000, reservedUnits: 900_000_000 };
  const roomy = (over: Record<string, unknown>) => ({ ...over, releaseAvailable: 2_000_000_000, fees: { ...chainEntry(1).fees, releaseCapacity: 2_000_000_000 } });

  it('refuses above the backing queued payouts have not claimed, however much the vault holds, and offers the other chain', () => {
    const c = checkRedeemAmount(status(roomy(queued), { fees: { ...chainEntry(2).fees, releaseCapacity: 2_000_000_000 }, releaseAvailable: 2_000_000_000 }), 'ethereum', 100_000_001n);
    expect(c.problem).toMatch(/holds only 100 USDT of backing that queued payouts have not claimed/);
    expect(c.problem).toMatch(/bsc-local can pay it now/);
    expect(c.other).toBe('bsc');
    expect(checkRedeemAmount(status(roomy(queued)), 'ethereum', 100_000_000n).problem).toBeNull();
  });

  it('refuses a burn the queue has no room for under the release capacity (reservedUnits + units), 1 % of it kept free', () => {
    // 400 of capacity, 350 queued, 4 kept for payouts queued first (run 21 round 2, R21-ECON-2): 46 left for one burn.
    const c = checkRedeemAmount(status({ unreservedBacking: 1_000_000_000, reservedUnits: 350_000_000, releaseAvailable: 400_000_000 }), 'ethereum', 46_000_001n);
    expect(c.problem).toMatch(/One burn can take at most 46 USDT of the ethereum-local vault's release capacity of 400 USDT right now: 350 USDT of payouts already wait in it/);
    expect(c.other).toBe('bsc');
    expect(checkRedeemAmount(status({ unreservedBacking: 1_000_000_000, reservedUnits: 350_000_000, releaseAvailable: 400_000_000 }), 'ethereum', 46_000_000n).problem).toBeNull();
  });

  it('counts a queue that fills the capacity as no room at all, with the other chain unable to help either', () => {
    const full = { unreservedBacking: 1_000_000_000, reservedUnits: 500_000_000 };
    const c = checkRedeemAmount(status(full, full), 'bsc', 20_000_000n);
    expect(c.problem).toMatch(/can take at most 0 USDT/);
    expect(c.other).toBeNull();
  });

  it("falls back to the backing, with nothing queued, for a coordinator that doesn't send the two amounts", () => {
    expect(checkRedeemAmount(status({ releaseAvailable: 2_000_000_000 }, {}, { releaseCapacity: 2_000_000_000 }), 'ethereum', 1_000_000_000n).problem).toBeNull();
    const c = checkRedeemAmount(status({ releaseAvailable: 2_000_000_000 }, {}, { releaseCapacity: 2_000_000_000 }), 'ethereum', 1_000_000_001n);
    expect(c.problem).toMatch(/holds only 1,000 USDT of backing\./);
  });

  it('reads the two amounts from the chain entry', () => {
    expect(chainCapacity(status(queued), 'ethereum')).toMatchObject({ backing: 1_000_000_000n, unreservedBacking: 100_000_000n, reservedUnits: 900_000_000n });
    expect(chainCapacity(status(), 'ethereum')).toMatchObject({ backing: 1_000_000_000n, unreservedBacking: 1_000_000_000n, reservedUnits: 0n });
    expect(chainCapacity(status({ unreservedBacking: 0, reservedUnits: 0 }), 'ethereum')).toMatchObject({ unreservedBacking: 0n, reservedUnits: 0n });
  });
});

describe('positions', () => {
  const me = devKey('lp');
  const TX = 'ab'.repeat(32), TY = 'cd'.repeat(32);
  const place = (node: FakeNode, ctx: ReturnType<typeof testCtx>, txid: string, shares: bigint) => {
    const spk = scriptOf(ctx, 'Position', { tokenCovid: COVENANT, shares, owner: me.xonly });
    node.utxoSet.push({ address: p2shAddressOf(spk, 'kaspasim'), transactionId: txid, index: 1, amount: 200_000_000n, scriptPublicKey: spk, blockDaaScore: 1n, isCoinbase: false, covenantId: POOL });
  };

  it('come from GET /positions, each verified on the node; a listed position that is not there is dropped', async () => {
    const node = new FakeNode();
    const ctx = testCtx(node, fakeApi({ positions: async () => ({ positions: [
      { utxo: { transactionId: TX, index: 1 }, state: { tokenCovid: COVENANT, shares: 5000, owner: me.xonly } },
      { utxo: { transactionId: TY, index: 1 }, state: { tokenCovid: COVENANT, shares: 9999, owner: me.xonly } },
    ] }) }));
    place(node, ctx, TX, 5000n);
    const list = await loadPositions(ctx, signerFor(me));
    expect(list.map(p => [p.id, p.located.state.shares])).toEqual([[`${TX}:1`, 5000n]]);
  });

  it('fall back to the local record when the coordinator is down', async () => {
    const node = new FakeNode();
    const ctx = testCtx(node, fakeApi({ positions: async () => { throw new Error('down'); } }));
    place(node, ctx, TY, 7000n);
    await local.set({ 'kusdt.positions.simnet': [{ txid: TY, index: 1, shares: '7000', owner: me.xonly, tokenCovid: COVENANT, at: 1 }] });
    const list = await loadPositions(ctx, signerFor(me));
    expect(list.map(p => p.id)).toEqual([`${TY}:1`]);
    await local.remove('kusdt.positions.simnet');
  });
});
