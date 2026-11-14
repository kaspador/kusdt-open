// Run 21 (after R21-COORD2-5): a burn whose submission the Kaspa node never answered "may have been sent". The wallet
// sent no claim for it at all, so a coordinator that missed it (away, or rebuilt past it) never paid it. Claimed at
// once, it would be wrong the other way: the coordinator shows a claim as pending for an hour, and a burn that never
// landed would then show as pending in Activity instead of "May have been sent". Now its claim is kept and sent only
// once the wallet's node shows the burn accepted (its output in the UTXO set); until then nothing is sent and each look
// at the node waits as a re-sent claim does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/kusdt/api';
import { executeRedeem, planRedeem, RECLAIM, redeemStatus } from '@/kusdt/redeem';
import { plainState } from '@/kusdt/owner';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import { MaybeSent, NoAnswer } from '@/kaspa/node';
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

/** A wallet that burns 50 kUSDT on Ethereum; its node never answers the burn; the coordinator has no record of it. */
function wallet(tag: string) {
  const alice = devKey(`r21-maybe-${tag}`);
  const node = new FakeNode();
  const state = plainState({ ownerScheme: 0, owner: alice.xonly }, 60n * USDT);
  const txid = tag.padEnd(64, '0');
  const posted: string[] = [];
  const ctx = testCtx(node, fakeApi({
    status: async () => rosyStatus(),
    tokens: async () => ({ states: [{ utxo: { transactionId: txid, index: 0 }, state: { ...state, amount: Number(state.amount) } }] }),
    postRedeem: async (body) => { posted.push(JSON.stringify(body)); return { redeems: [] }; },
    redeem: async () => { throw new ApiError('The coordinator answered HTTP 404: "no such redemption seen"', 404); },
  }));
  const spk = scriptOf(ctx, 'KCC20', state);
  node.utxoSet.push({ address: p2shAddressOf(spk, NET.prefix), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
  node.utxoSet.push(kasCoin(alice, (tag + 'c').padEnd(64, '1'), 1_000_000_000n));
  node.submitImpl = async () => { throw new NoAnswer('timed out'); };
  return { ctx, node, signer: signerFor(alice), kas: [alice.address], posted };
}

describe('a burn that may have been sent is claimed once the node shows it, never before', () => {
  it('no claim while the node does not show the burn; the same transaction claimed once it does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = wallet('b1');
    const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 50n * USDT });
    const e = await executeRedeem(w.ctx, w.signer, w.kas, plan).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MaybeSent);
    const txid = (e as MaybeSent).txid;
    const burnt = lastBuilt.value;
    expect(w.posted).toEqual([]);
    const looks = vi.spyOn(w.node, 'utxos');
    const burnAddress = p2shAddressOf(burnt.outputs[0].scriptPublicKey, NET.prefix);
    const lookedForBurn = () => looks.mock.calls.filter(([a]) => a.includes(burnAddress)).length;
    // Not on the node: nothing is claimed, and the node is asked once per wait, not at every status read.
    await redeemStatus(w.ctx, txid, 0).catch(() => {});
    await redeemStatus(w.ctx, txid, 0).catch(() => {});
    expect(w.posted).toEqual([]);
    expect(lookedForBurn()).toBe(1);
    // It landed after all: its output is in the node's UTXO set.
    w.node.utxoSet.push({ address: burnAddress, transactionId: txid, index: 0, amount: BigInt(burnt.outputs[0].value), scriptPublicKey: burnt.outputs[0].scriptPublicKey, blockDaaScore: 7n, isCoinbase: false, covenantId: COVENANT });
    vi.setSystemTime(Date.now() + RECLAIM.firstMs);
    await redeemStatus(w.ctx, txid, 0).catch(() => {});
    expect(w.posted).toHaveLength(1);
    expect(JSON.parse(w.posted[0])).toMatchObject({ transactionId: txid });
    expect(JSON.parse(w.posted[0]).transaction).toBe(w.node.submitted[w.node.submitted.length - 1]);
  });

  it('a burn that never lands is never claimed, and the looks stop after RECLAIM.tries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = wallet('b2');
    const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 50n * USDT });
    const txid = ((await executeRedeem(w.ctx, w.signer, w.kas, plan).catch((x: unknown) => x)) as MaybeSent).txid;
    const looks = vi.spyOn(w.node, 'utxos');
    for (let i = 0; i < 100; i++) { vi.setSystemTime(Date.now() + RECLAIM.maxMs); await redeemStatus(w.ctx, txid, 0).catch(() => {}); }
    expect(w.posted).toEqual([]);
    expect(looks).toHaveBeenCalledTimes(RECLAIM.tries);
  });
});
