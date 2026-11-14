// Run 21 fixes, Daybreak [2] and [19] (the rc.23 report, reproduced on rc.24 by run 21's wallet review). A
// redemption asked about the recipient and the vault once, before executeSend; executeSend then sent and waited for
// the merges a balance spread over more than three states needs, and built and sent the burn with no other look.
// A vault paused, its allowance used up, a recipient blocked or the release fee raised while a merge waited did not
// stop the burn. And the fee read right before the burn was not compared with the one the review showed, though the
// vault charges the fee of the moment it queues the payout, after the burn. Now the recipient and the vault are asked
// again after the last merge, right before the burn is sent, and a fee above the one approved stops it.
// Real core, the wallet's real redeem and send engine; a fake node, coordinator and vault.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selector } from '@/evm/abi';
import { executeRedeem, planRedeem, VAULT_READER } from '@/kusdt/redeem';
import { plainState } from '@/kusdt/owner';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import { session } from '@/lib/storage';
import { COVENANT, FakeNode, NET, devKey, fakeApi, kasCoin, lastBuilt, recipientAnswer, signerFor, testCtx } from './helpers';

const A = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const USDT = 1_000_000n;
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const SEL = Object.fromEntries(['paused()', 'unreservedBacking()', 'releaseAvailable()', 'reservedUnits()', 'releaseCapacity()', 'releaseFeeOf(uint256)', 'isBlackListed(address)'].map((s) => [selector(s), s]));
const rosyStatus = () => ({ chains: [1, 2].map((chain) => ({
  chain, name: chain === 1 ? 'ethereum-local' : 'bsc-local', chainId: 31336 + chain, paused: false,
  backing: 1_000_000_000_000, unreservedBacking: 1_000_000_000_000, reservedUnits: 0, releaseAvailable: 1_000_000_000_000,
  fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: 500000, minDeposit: 10000000, maxDeposit: 100000000000, releaseCapacity: 1_000_000_000_000, releaseRefillPerSecond: 2893518 },
})) });

interface Vault { paused: boolean; unreservedBacking: bigint; releaseAvailable: bigint; reservedUnits: bigint; releaseCapacity: bigint; fee: bigint; blocked: boolean }
const healthy = (): Vault => ({ paused: false, unreservedBacking: 500_000n * USDT, releaseAvailable: 400_000n * USDT, reservedUnits: 0n, releaseCapacity: 400_000n * USDT, fee: 500_000n, blocked: false });

const reader = VAULT_READER.rpc;
afterEach(() => { VAULT_READER.rpc = reader; });
beforeEach(async () => { await session.remove('kusdt.pending.simnet'); lastBuilt.txid = ''; });

/** A wallet whose kUSDT is in a state per amount (4 or more: a burn of all of it merges first), with two KAS coins. */
function wallet(tag: string, amounts: bigint[]) {
  const alice = devKey(`r21-recheck-${tag}`);
  const node = new FakeNode();
  const states = amounts.map((a, i) => ({ txid: `${tag}${i}`.padEnd(64, '0'), state: plainState({ ownerScheme: 0, owner: alice.xonly }, a) }));
  const recipient = { blocked: false, calls: 0 };
  const ctx = testCtx(node, fakeApi({
    status: async () => rosyStatus(),
    tokens: async () => ({ states: states.map(s => ({ utxo: { transactionId: s.txid, index: 0 }, state: { ...s.state, amount: Number(s.state.amount) } })) }),
    recipient: async (chain, addr) => { recipient.calls++; return recipientAnswer(chain, addr, recipient.blocked ? { blocked: true, payable: false } : {}); },
  }));
  for (const s of states) {
    const spk = scriptOf(ctx, 'KCC20', s.state);
    node.utxoSet.push({ address: p2shAddressOf(spk, NET.prefix), transactionId: s.txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
  }
  node.utxoSet.push(kasCoin(alice, `${tag}c`.padEnd(64, '1'), 1_000_000_000n), kasCoin(alice, `${tag}d`.padEnd(64, '2'), 1_000_000_000n));
  const vault = healthy();
  const calls: string[] = [];
  VAULT_READER.rpc = () => ({
    ethCall: async (_to: string, data: string) => {
      const name = SEL[data.slice(0, 10)];
      calls.push(name);
      if (name === 'paused()') return word(vault.paused ? 1n : 0n);
      if (name === 'unreservedBacking()') return word(vault.unreservedBacking);
      if (name === 'releaseAvailable()') return word(vault.releaseAvailable);
      if (name === 'reservedUnits()') return word(vault.reservedUnits);
      if (name === 'releaseCapacity()') return word(vault.releaseCapacity);
      if (name === 'isBlackListed(address)') return word(vault.blocked ? 1n : 0n);
      return word(vault.fee);
    },
  });
  return { ctx, node, signer: signerFor(alice), kas: [alice.address], vault, calls, recipient };
}
type W = ReturnType<typeof wallet>;

/** Puts every output of the transaction the core just built on the node (what its acceptance does). */
function landLast(w: W) {
  const v = lastBuilt.value;
  for (const o of v.outputs) {
    const p2sh = /^0000aa20[0-9a-f]{64}87$/.test(o.scriptPublicKey);
    w.node.utxoSet.push({ address: p2sh ? p2shAddressOf(o.scriptPublicKey, NET.prefix) : w.kas[0], transactionId: v.txid, index: o.index, amount: BigInt(o.value), scriptPublicKey: o.scriptPublicKey, blockDaaScore: 7n, isCoinbase: false, covenantId: p2sh ? COVENANT : null });
  }
}

const isBurn = (json: string) => (JSON.parse(json).payload ?? '').startsWith('4b55534454'); // "KUSDT"
const four = () => [20_000n * USDT, 20_000n * USDT, 20_000n * USDT, 20_000n * USDT];

describe('Daybreak [2]: a burn after merges goes out only on what is true after them', () => {
  const changes: [string, (w: W) => void, RegExp][] = [
    ['the vault is paused', (w) => { w.vault.paused = true; }, /The Ethereum \(local\) vault is paused/],
    ['its allowance is used up', (w) => { w.vault.releaseAvailable = 0n; }, /can pay at most 0 USDT right now/],
    ['its backing is claimed', (w) => { w.vault.unreservedBacking = 1n * USDT; }, /holds only 1 USDT of backing/],
    ['the coordinator now says the token blocks the recipient', (w) => { w.recipient.blocked = true; }, /USDT on Ethereum \(local\) blocks this address/],
    ['its release fee is raised to 40,000 USDT', (w) => { w.vault.fee = 40_000n * USDT; }, /release fee of 40,000 USDT, more than the 0\.5 USDT you approved/],
  ];
  for (const [what, change, says] of changes) {
    it(`${what} while the merge waits: the merge went out, the burn does not`, async () => {
      const w = wallet(`a${changes.findIndex(c => c[0] === what)}`, four());
      const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 80_000n * USDT });
      expect(plan.merges).toBe(1);
      expect(plan.built).toBeNull();
      w.node.submitImpl = async (json) => {
        if (!isBurn(json)) { landLast(w); change(w); }
        return lastBuilt.txid;
      };
      const e = await executeRedeem(w.ctx, w.signer, w.kas, plan).then(() => null, (x: Error) => x);
      expect(e?.message).toMatch(says);
      // The merge only: it joined the wallet's own states, which stay the wallet's.
      expect(w.node.submitted).toHaveLength(1);
      expect(isBurn(w.node.submitted[0])).toBe(false);
    });
  }

  it('nothing changed while the merge waited: the burn goes out after it, on the recipient and the vault asked after it', async () => {
    const w = wallet('b1', four());
    const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 80_000n * USDT });
    let readsAtMerge = -1, askedAtMerge = -1;
    w.node.submitImpl = async (json) => {
      if (!isBurn(json)) { landLast(w); readsAtMerge = w.calls.length; askedAtMerge = w.recipient.calls; }
      return lastBuilt.txid;
    };
    const r = await executeRedeem(w.ctx, w.signer, w.kas, plan);
    expect(w.node.submitted).toHaveLength(2);
    expect(isBurn(w.node.submitted[1])).toBe(true);
    expect(r.txid).toBe(lastBuilt.txid);
    // After the merge: the vault's six views (fee, capacity, pause, backing, allowance, queue) and the coordinator once more.
    expect(w.calls.slice(readsAtMerge).filter(c => c !== 'isBlackListed(address)')).toHaveLength(6);
    expect(w.recipient.calls - askedAtMerge).toBe(1);
  });

  it('a vault that can\'t pay when the click comes: not even the merge is sent', async () => {
    const w = wallet('b2', four());
    const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 80_000n * USDT });
    w.vault.paused = true;
    await expect(executeRedeem(w.ctx, w.signer, w.kas, plan)).rejects.toThrow(/vault is paused/);
    expect(w.node.submitted).toEqual([]);
  });
});

describe('Daybreak [19]: the burn goes out at no higher release fee than the review showed', () => {
  it('a fee raised between the review and the click: nothing is burnt, and the message gives both fees', async () => {
    const w = wallet('c1', [60_000n * USDT]);
    const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 50_000n * USDT });
    expect(plan.merges).toBe(0);
    expect(plan.releaseFee).toBe(500_000n); // the review's "Release fee"; "You receive" is the amount less this
    w.vault.fee = 49_999n * USDT; // the vault would now keep all but 1 USDT
    const e = await executeRedeem(w.ctx, w.signer, w.kas, plan).then(() => null, (x: Error) => x);
    expect(e?.message).toMatch(/The Ethereum \(local\) vault now takes a release fee of 49,999 USDT, more than the 0\.5 USDT you approved/);
    expect(e?.message).toMatch(/you would receive 1 USDT, not 49,999\.5/);
    expect(e?.message).toMatch(/Nothing was burnt/);
    expect(w.node.submitted).toEqual([]);
  });

  it('one base unit above the fee shown is refused too', async () => {
    const w = wallet('c2', [60_000n * USDT]);
    const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 50_000n * USDT });
    w.vault.fee = plan.releaseFee + 1n;
    await expect(executeRedeem(w.ctx, w.signer, w.kas, plan)).rejects.toThrow(/more than the 0\.5 USDT you approved/);
    expect(w.node.submitted).toEqual([]);
  });

  it('the same fee, or a lower one, goes ahead: the payout is never below what was shown', async () => {
    for (const [tag, fee] of [['c3', 500_000n], ['c4', 400_000n]] as const) {
      const w = wallet(tag, [60_000n * USDT]);
      const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 50_000n * USDT });
      w.vault.fee = fee;
      await executeRedeem(w.ctx, w.signer, w.kas, plan);
      expect(w.node.submitted).toHaveLength(1);
      expect(isBurn(w.node.submitted[0])).toBe(true);
    }
  });
});
