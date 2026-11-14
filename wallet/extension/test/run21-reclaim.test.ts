// Run 21 round 2, R21-COORD2-5 (the wallet's part), from reviewer "coord2": kUSDT Wallet sent a burn's claim (POST
// /redeems, the burn's own transaction) once, right after the burn. A coordinator that was away at that moment, or that
// was rebuilt or re-anchored later, never learns of a burn accepted before where it reads from: GET /redeems answers
// 404 "no such redemption seen" for good, and the burn is never paid, though one claim by hand pays it. The wallet only
// asked for the status afterwards. Now it keeps the claim, and while the coordinator answers 404 for the burn, or has
// not taken the claim (the burn shows as "Sent", unreported) and cannot say, it sends the same claim again, a bounded
// number of times, further apart each time; a burn paid (or found invalid) is forgotten.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/kusdt/api';
import { executeRedeem, planRedeem, RECLAIM, redeemStatus } from '@/kusdt/redeem';
import { plainState } from '@/kusdt/owner';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import { local, session } from '@/lib/storage';
import { COVENANT, FakeNode, NET, devKey, fakeApi, kasCoin, lastBuilt, signerFor, testCtx } from './helpers';

const A = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const USDT = 1_000_000n;
const rosyStatus = () => ({ chains: [1, 2].map((chain) => ({
  chain, name: chain === 1 ? 'ethereum-local' : 'bsc-local', chainId: 31336 + chain, paused: false,
  backing: 1_000_000_000_000, unreservedBacking: 1_000_000_000_000, reservedUnits: 0, releaseAvailable: 1_000_000_000_000,
  fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: 500000, minDeposit: 10000000, maxDeposit: 100000000000, releaseCapacity: 1_000_000_000_000, releaseRefillPerSecond: 2893518 },
})) });

beforeEach(async () => { await session.remove('kusdt.pending.simnet'); await local.remove('kusdt.claims.simnet'); lastBuilt.txid = ''; });
afterEach(() => { vi.useRealTimers(); });

/**
 * A wallet that burns 50 kUSDT on Ethereum, against a coordinator that takes no claim while `away`, and whose GET
 * /redeems answers 503 while not `reading`, else `record` (null: 404, "no such redemption seen").
 */
function wallet(tag: string) {
  const alice = devKey(`r21-reclaim-${tag}`);
  const node = new FakeNode();
  const state = plainState({ ownerScheme: 0, owner: alice.xonly }, 60n * USDT);
  const txid = tag.padEnd(64, '0');
  const posted: string[] = [];
  const coordinator = { away: false, reading: true, record: null as null | Record<string, unknown> };
  const ctx = testCtx(node, fakeApi({
    status: async () => rosyStatus(),
    tokens: async () => ({ states: [{ utxo: { transactionId: txid, index: 0 }, state: { ...state, amount: Number(state.amount) } }] }),
    postRedeem: async (body) => {
      posted.push(JSON.stringify(body));
      if (coordinator.away) throw new Error('Could not reach the coordinator API.');
      return { redeems: [] };
    },
    redeem: async () => {
      if (!coordinator.reading) throw new ApiError('The coordinator answered HTTP 503: "starting"', 503);
      if (!coordinator.record) throw new ApiError('The coordinator answered HTTP 404: "no such redemption seen"', 404);
      return coordinator.record;
    },
  }));
  const spk = scriptOf(ctx, 'KCC20', state);
  node.utxoSet.push({ address: p2shAddressOf(spk, NET.prefix), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
  node.utxoSet.push(kasCoin(alice, (tag + 'c').padEnd(64, '1'), 1_000_000_000n));
  return { ctx, node, signer: signerFor(alice), kas: [alice.address], posted, coordinator };
}
type W = ReturnType<typeof wallet>;
async function burn(w: W) {
  const p = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 50n * USDT });
  return executeRedeem(w.ctx, w.signer, w.kas, p);
}
const statusOf = (w: W, txid: string) => redeemStatus(w.ctx, txid, 0).catch((e: Error) => e);

describe('R21-COORD2-5: the wallet claims its burn again while the coordinator has no record of it', () => {
  it('the coordinator was away when the burn went out: the next status read that answers 404 sends the same claim again', async () => {
    const w = wallet('a1');
    w.coordinator.away = true;
    const r = await burn(w);
    expect(r.reported).toBe(false);
    expect(w.posted).toHaveLength(1);
    w.coordinator.away = false;
    expect(await statusOf(w, r.txid)).toBeInstanceOf(ApiError);
    expect(w.posted).toHaveLength(2);
    expect(w.posted[1]).toBe(w.posted[0]);
    expect(JSON.parse(w.posted[1])).toMatchObject({ transactionId: r.txid });
  });

  it('a coordinator rebuilt after a claim went through (404 later): it is claimed again all the same', async () => {
    const w = wallet('a2');
    const r = await burn(w);
    expect(r.reported).toBe(true);
    await statusOf(w, r.txid);
    expect(w.posted).toHaveLength(2);
  });

  it('bounded, and further apart each time: never before its wait is over, never more than RECLAIM.tries times', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = wallet('a3');
    const r = await burn(w);
    let now = Date.now();
    const at = async (ms: number) => { now += ms; vi.setSystemTime(now); await statusOf(w, r.txid); return w.posted.length; };
    expect(await at(0)).toBe(2); // the first 404: sent again at once
    expect(await at(RECLAIM.firstMs - 1)).toBe(2); // then a minute's wait
    expect(await at(1)).toBe(3);
    expect(await at(2 * RECLAIM.firstMs - 1)).toBe(3); // then twice that
    expect(await at(1)).toBe(4);
    for (let i = 0; i < 200; i++) await at(RECLAIM.maxMs);
    expect(w.posted).toHaveLength(1 + RECLAIM.tries);
  });

  it('a burn the coordinator has a record of is not claimed again, and once paid its claim is forgotten', async () => {
    const w = wallet('a4');
    const r = await burn(w);
    w.coordinator.record = { status: 'queued' };
    expect((await redeemStatus(w.ctx, r.txid, 0)).status).toBe('queued');
    expect(w.posted).toHaveLength(1);
    w.coordinator.record = { status: 'released', evmTxHash: '0x' + 'ab'.repeat(32) };
    expect((await redeemStatus(w.ctx, r.txid, 0)).status).toBe('released');
    // Lost afterwards (an archive the coordinator no longer has): nothing is kept to send.
    w.coordinator.record = null;
    await statusOf(w, r.txid);
    expect(w.posted).toHaveLength(1);
    expect(await local.get<Record<string, unknown>>('kusdt.claims.simnet')).toEqual({});
  });

  it('a claim never taken (the burn shows as "Sent") is sent again when the coordinator cannot say either; once taken, only a 404 sends it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = wallet('a5');
    w.coordinator.away = true;
    const r = await burn(w);
    expect(r.reported).toBe(false);
    w.coordinator.reading = false; // GET /redeems answers 503
    await statusOf(w, r.txid);
    expect(w.posted).toHaveLength(2); // the coordinator is still away: not taken
    w.coordinator.away = false;
    vi.setSystemTime(Date.now() + RECLAIM.firstMs);
    await statusOf(w, r.txid);
    expect(w.posted).toHaveLength(3); // taken now
    vi.setSystemTime(Date.now() + RECLAIM.maxMs);
    await statusOf(w, r.txid);
    expect(w.posted).toHaveLength(3); // taken, and the coordinator cannot say: not sent again
    w.coordinator.reading = true; // it answers, with no record of the burn
    await statusOf(w, r.txid);
    expect(w.posted).toHaveLength(4);
    expect(new Set(w.posted).size).toBe(1);
  });
});
