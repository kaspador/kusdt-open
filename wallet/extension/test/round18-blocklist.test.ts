// Round 18, R18-CL-1: whether a burn's recipient is blocked by the chain's USDT was the coordinator's word alone
// (GET /recipients, served by the API process), though every other burn check reads the vault over the chain's own
// RPCs. A taken-over or stale API process answering "payable" for an address Tether blacklists had the wallet burn
// kUSDT that the signers then refuse to pay, for as long as the address stays blocked. Now, where the chain's USDT
// keeps a blocklist (Ethereum's isBlackListed), the wallet asks the token itself before the burn is built and again
// before it is sent, and refuses on "blocked" or on no answer.
//
// Since PR #22 the wallet's read is run 21's (Daybreak [24], kusdt/redeem.ts assertTokenPays: every RPC of the chain,
// in planRedeem and again right before the burn): these tests run on its messages and pass on its code.

import { beforeEach, describe, expect, it } from 'vitest';
import { selector } from '@/evm/abi';
import { executeRedeem, planRedeem, VAULT_READER } from '@/kusdt/redeem';
import { plainState } from '@/kusdt/owner';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import { mergeConfig } from '@/config/settings';
import { session } from '@/lib/storage';
import { COVENANT, FakeNode, NET, devKey, fakeApi, kasCoin, lastBuilt, recipientAnswer, signerFor, testCtx } from './helpers';

const A = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const USDT = 1_000_000n;
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const IS_BLACKLISTED = selector('isBlackListed(address)');

/** A healthy vault, and a token whose blocklist the test sets; every call is recorded with its target. */
function world(tag: string, token: { blocked: boolean; fail?: boolean }) {
  const alice = devKey(`r18-bl-${tag}`);
  const node = new FakeNode();
  const amount = 60_000n * USDT;
  const state = plainState({ ownerScheme: 0, owner: alice.xonly }, amount);
  const txid = tag.padEnd(64, '0');
  const status = () => ({ chains: [1, 2].map((chain) => ({
    chain, name: chain === 1 ? 'ethereum-local' : 'bsc-local', chainId: 31336 + chain, paused: false,
    backing: 1_000_000_000_000, unreservedBacking: 1_000_000_000_000, reservedUnits: 0, releaseAvailable: 1_000_000_000_000,
    fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: 500000, minDeposit: 10000000, maxDeposit: 100000000000, releaseCapacity: 1_000_000_000_000, releaseRefillPerSecond: 2893518 },
  })) });
  // The coordinator's API says every address is payable and none is blocked: a taken-over or stale API process.
  const ctx = testCtx(node, fakeApi({
    status: async () => status(),
    tokens: async () => ({ states: [{ utxo: { transactionId: txid, index: 0 }, state: { ...state, amount: Number(amount) } }] }),
    recipient: async (chain, address) => recipientAnswer(chain, address, { blocked: false, payable: true }),
  }));
  const spk = scriptOf(ctx, 'KCC20', state);
  node.utxoSet.push({ address: p2shAddressOf(spk, NET.prefix), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
  node.utxoSet.push(kasCoin(alice, (tag + 'c').padEnd(64, '1'), 1_000_000_000n));
  const calls: { to: string; data: string }[] = [];
  const reader = () => ({
    ethCall: async (to: string, data: string) => {
      calls.push({ to, data });
      if (data.startsWith(IS_BLACKLISTED)) {
        if (token.fail) throw new Error('execution reverted');
        return word(token.blocked ? 1n : 0n);
      }
      const view = data.slice(0, 10);
      if (view === selector('paused()') || view === selector('reservedUnits()')) return word(0n);
      if (view === selector('releaseFeeOf(uint256)')) return word(500_000n);
      return word(500_000n * USDT);
    },
  });
  return { ctx, node, signer: signerFor(alice), kas: [alice.address], calls, reader, token };
}
type W = ReturnType<typeof world>;
async function withReader<T>(w: W, run: () => Promise<T>): Promise<T> {
  const before = VAULT_READER.rpc;
  VAULT_READER.rpc = w.reader;
  try { return await run(); } finally { VAULT_READER.rpc = before; }
}
const plan = (w: W, chain: 'ethereum' | 'bsc' = 'ethereum') => withReader(w, () => planRedeem(w.ctx, w.signer, w.kas, { chain, address: A, amount: 50_000n * USDT }));

beforeEach(async () => { await session.remove('kusdt.pending.simnet'); lastBuilt.txid = ''; });

describe('R18-CL-1: the token\'s own blocklist is read before a burn', () => {
  it('an API that says "payable" for an address the USDT blocks: nothing is built, and the message says whose answer counts', async () => {
    const w = world('a1', { blocked: true });
    const e = await plan(w).then(() => null, (x: Error) => x);
    expect(e?.message).toMatch(/USDT on Ethereum \(local\) blocks this address/);
    expect(e?.message).toMatch(/The token says so itself; the bridge server said it would pay it/);
    expect(lastBuilt.txid).toBe('');
    expect(w.node.submitted).toEqual([]);
    // Asked of the token, not of the vault, for exactly this address.
    const asked = w.calls.filter((c) => c.data.startsWith(IS_BLACKLISTED));
    expect(asked).toHaveLength(1);
    expect(asked[0].to.toLowerCase()).toBe(w.ctx.config.chains.ethereum.token.toLowerCase());
    expect(asked[0].data.slice(-40).toLowerCase()).toBe(A.slice(2).toLowerCase());
  });

  it('a token that does not answer refuses the burn: no answer is a no', async () => {
    const w = world('a2', { blocked: false, fail: true });
    await expect(plan(w)).rejects.toThrow(/Couldn't read from USDT on Ethereum \(local\) whether it blocks this address, so nothing was burnt/);
    expect(w.node.submitted).toEqual([]);
  });

  it('read again right before the burn is sent: an address blocked since the review stops it', async () => {
    const w = world('a3', { blocked: false });
    const p = await plan(w);
    expect(p.built).not.toBeNull();
    w.token.blocked = true;
    await expect(withReader(w, () => executeRedeem(w.ctx, w.signer, w.kas, p))).rejects.toThrow(/blocks this address/);
    expect(w.node.submitted).toEqual([]);
  });

  it('an address the token does not block goes out as before, with one more read for the plan and one for the send', async () => {
    const w = world('a4', { blocked: false });
    const p = await plan(w);
    await withReader(w, () => executeRedeem(w.ctx, w.signer, w.kas, p));
    expect(w.node.submitted).toHaveLength(1);
    expect(w.calls.filter((c) => c.data.startsWith(IS_BLACKLISTED))).toHaveLength(2);
  });

  it('BNB Chain\'s USDT keeps no blocklist: nothing is asked of it', async () => {
    const w = world('a5', { blocked: true });
    const p = await plan(w, 'bsc');
    expect(p.built).not.toBeNull();
    expect(w.calls.filter((c) => c.data.startsWith(IS_BLACKLISTED))).toEqual([]);
  });

  it('the blocklist is the preset\'s: a stored edit cannot drop it', () => {
    for (const net of ['testnet-10', 'mainnet', 'simnet'] as const) {
      expect(mergeConfig(net, undefined).chains.ethereum.blocklist, net).toBe('isBlackListed');
      expect(mergeConfig(net, { chains: { ethereum: { blocklist: 'none' } as any } }).chains.ethereum.blocklist, net).toBe('isBlackListed');
      expect(mergeConfig(net, undefined).chains.bsc.blocklist, net).toBeNull();
    }
  });
});
