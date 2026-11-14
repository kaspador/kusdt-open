// Round 12, R12-WW-2: whether a vault can pay a burn now (its pause, the backing queued payouts have not claimed, the
// allowance, the queue) was taken from the coordinator's /status alone, though the vault answers all of it. A wrong
// /status (a compromised API, or one answering from a read made before its RPC failed) had the wallet burn kUSDT
// the vault could not queue a payout for: the burn commits to its chain, so it waits there with no bound of its own.
// Now the wallet reads those facts from the pinned vault over the chain's own RPCs before a burn is built, again
// before it is sent, and stops when the vault and the coordinator disagree.

import { beforeEach, describe, expect, it } from 'vitest';
import { selector } from '@/evm/abi';
import { executeRedeem, planRedeem, VAULT_READER } from '@/kusdt/redeem';
import { plainState } from '@/kusdt/owner';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import { session } from '@/lib/storage';
import { COVENANT, FakeNode, NET, devKey, fakeApi, kasCoin, lastBuilt, recipientAnswer, signerFor, testCtx } from './helpers';

const A = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const USDT = 1_000_000n;

/** /status as a coordinator that wants this burn made would give it: everything is fine, on both chains. */
const rosyStatus = () => ({ chains: [1, 2].map((chain) => ({
  chain, name: chain === 1 ? 'ethereum-local' : 'bsc-local', chainId: 31336 + chain, paused: false,
  backing: 1_000_000_000_000, unreservedBacking: 1_000_000_000_000, reservedUnits: 0, releaseAvailable: 1_000_000_000_000,
  fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: 500000, minDeposit: 10000000, maxDeposit: 100000000000, releaseCapacity: 1_000_000_000_000, releaseRefillPerSecond: 2893518 },
})) });

/** What the vault itself says, and every call made to it. */
interface Vault { paused: boolean; unreservedBacking: bigint; releaseAvailable: bigint; reservedUnits: bigint; releaseCapacity: bigint; fee: bigint; fail?: string }
const healthy = (): Vault => ({ paused: false, unreservedBacking: 500_000n * USDT, releaseAvailable: 400_000n * USDT, reservedUnits: 0n, releaseCapacity: 400_000n * USDT, fee: 500_000n });
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const SEL = Object.fromEntries(['paused()', 'unreservedBacking()', 'releaseAvailable()', 'reservedUnits()', 'releaseCapacity()', 'releaseFeeOf(uint256)'].map((s) => [selector(s), s]));
/** The token's own blocklist, which a burn also asks since run 21 (Daybreak [24]): it blocks nobody here, and is not one of the vault's reads. */
const BLOCKED = selector('isBlackListed(address)');

function wallet(tag: string, vault: Vault, amount = 60_000n * USDT) {
  const alice = devKey(`r12-vault-${tag}`);
  const node = new FakeNode();
  const state = plainState({ ownerScheme: 0, owner: alice.xonly }, amount);
  const txid = tag.padEnd(64, '0');
  const ctx = testCtx(node, fakeApi({
    status: async () => rosyStatus(),
    tokens: async () => ({ states: [{ utxo: { transactionId: txid, index: 0 }, state: { ...state, amount: Number(amount) } }] }),
    recipient: async (chain, address) => recipientAnswer(chain, address),
  }));
  const spk = scriptOf(ctx, 'KCC20', state);
  node.utxoSet.push({ address: p2shAddressOf(spk, NET.prefix), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
  node.utxoSet.push(kasCoin(alice, (tag + 'c').padEnd(64, '1'), 1_000_000_000n));
  const calls: string[] = [];
  const reader = () => ({
    ethCall: async (_to: string, data: string) => {
      if (data.startsWith(BLOCKED)) return word(0n);
      const name = SEL[data.slice(0, 10)];
      calls.push(name ?? data.slice(0, 10));
      if (!name || vault.fail === name) throw new Error('execution reverted');
      if (name === 'paused()') return word(vault.paused ? 1n : 0n);
      if (name === 'unreservedBacking()') return word(vault.unreservedBacking);
      if (name === 'releaseAvailable()') return word(vault.releaseAvailable);
      if (name === 'reservedUnits()') return word(vault.reservedUnits);
      if (name === 'releaseCapacity()') return word(vault.releaseCapacity);
      return word(vault.fee);
    },
  });
  return { ctx, node, signer: signerFor(alice), kas: [alice.address], calls, reader, vault };
}

type W = ReturnType<typeof wallet>;
const plan = (w: W, amount: bigint) => planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount });
async function withVault<T>(w: W, run: () => Promise<T>): Promise<T> {
  const before = VAULT_READER.rpc;
  VAULT_READER.rpc = w.reader;
  try { return await run(); } finally { VAULT_READER.rpc = before; }
}

beforeEach(async () => { await session.remove('kusdt.pending.simnet'); lastBuilt.txid = ''; });

describe('a burn is built only when the vault itself says it can pay it now', () => {
  it('a /status that says a million is there does not get 50,000 kUSDT burnt against a vault that holds 10', async () => {
    const w = wallet('a1', { ...healthy(), unreservedBacking: 10n * USDT });
    const e = await withVault(w, () => plan(w, 50_000n * USDT)).then(() => null, (x: Error) => x);
    expect(e?.message).toMatch(/Ethereum \(local\) vault holds only 10 USDT of backing/);
    // The vault and the coordinator disagree: said, and nothing was built, signed or sent.
    expect(e?.message).toMatch(/bridge server says this vault can pay it/);
    expect(e?.message).toMatch(/Nothing was burnt/);
    expect(lastBuilt.txid).toBe('');
    expect(w.node.submitted).toEqual([]);
    expect(new Set(w.calls)).toEqual(new Set(Object.values(SEL)));
  });

  it('refuses a vault that is paused, an allowance that is used up and a full queue, each from the vault\'s own answer', async () => {
    const paused = wallet('a2', { ...healthy(), paused: true });
    await expect(withVault(paused, () => plan(paused, 50_000n * USDT))).rejects.toThrow(/Ethereum \(local\) vault is paused/);
    const allowance = wallet('a3', { ...healthy(), releaseAvailable: 49_999n * USDT });
    await expect(withVault(allowance, () => plan(allowance, 50_000n * USDT))).rejects.toThrow(/can pay at most 49,999 USDT right now/);
    const queue = wallet('a4', { ...healthy(), reservedUnits: 350_001n * USDT });
    // 400,000 of capacity, 350,001 queued and 4,000 kept free (run 21 round 2, R21-ECON-2).
    await expect(withVault(queue, () => plan(queue, 50_000n * USDT))).rejects.toThrow(/can take at most 45,999 USDT/);
    for (const w of [paused, allowance, queue]) expect(w.node.submitted).toEqual([]);
    expect(lastBuilt.txid).toBe('');
  });

  it('takes the exact edge: all of the unclaimed backing, the whole allowance, the last room in the queue (less the 1 % kept free)', async () => {
    const w = wallet('a5', { ...healthy(), unreservedBacking: 50_000n * USDT, releaseAvailable: 50_000n * USDT, reservedUnits: 346_000n * USDT });
    const p = await withVault(w, () => plan(w, 50_000n * USDT));
    expect(p.releaseFee).toBe(500_000n);
    expect(p.built).not.toBeNull();
  });

  it('fails closed: one of the reads failing refuses the burn, whichever it is', async () => {
    for (const name of Object.values(SEL)) {
      const w = wallet(`b${Object.values(SEL).indexOf(name)}`, { ...healthy(), fail: name });
      const e = await withVault(w, () => plan(w, 50_000n * USDT)).then(() => null, (x: Error) => x);
      expect(e?.message, name).toMatch(/Couldn't read .* from the Ethereum \(local\) vault, so nothing was burnt/);
      expect(w.node.submitted).toEqual([]);
    }
    expect(lastBuilt.txid).toBe('');
  });

  it('reads the vault again right before the burn is sent: a pause or a drained allowance since the review stops it', async () => {
    const changes: Partial<Vault>[] = [{ paused: true }, { releaseAvailable: 1n * USDT }, { unreservedBacking: 1n * USDT }, { fail: 'reservedUnits()' }];
    for (const [i, change] of changes.entries()) {
      const w = wallet(`c${i}`, healthy());
      const p = await withVault(w, () => plan(w, 50_000n * USDT));
      expect(p.built).not.toBeNull();
      Object.assign(w.vault, change);
      await expect(withVault(w, () => executeRedeem(w.ctx, w.signer, w.kas, p))).rejects.toThrow(/Nothing was burnt|nothing was burnt/);
      expect(w.node.submitted).toEqual([]);
    }
  });

  it('a burn the vault can pay goes out as before', async () => {
    const w = wallet('d1', healthy());
    const p = await withVault(w, () => plan(w, 50_000n * USDT));
    const r = await withVault(w, () => executeRedeem(w.ctx, w.signer, w.kas, p));
    expect(w.node.submitted).toHaveLength(1);
    expect(r.txid).toBe(lastBuilt.txid);
    // Six reads for the plan and six before the send: a fixed number, whatever the coordinator says.
    expect(w.calls).toHaveLength(12);
  });
});
