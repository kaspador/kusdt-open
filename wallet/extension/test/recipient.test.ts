// SPEC §9, "a blocked recipient is never paid": before every burn the wallet
// asks GET /recipients/:chain/:address, refuses an address the vault wouldn't
// pay, and refuses too when it can't ask (a burn can't be undone).

import { describe, expect, it, vi } from 'vitest';
import { ApiError, CoordinatorClient } from '@/kusdt/api';
import { checkRecipientAnswer, executeRedeem, planRedeem, recipientCheck, redeemCheck, redeemStatus } from '@/kusdt/redeem';
import { plainState, type TokenState } from '@/kusdt/owner';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import type { NodeUtxo } from '@/kaspa/node';
import type { Ctx } from '@/kusdt/types';
import { COVENANT, FakeNode, devKey, fakeApi, kasCoin, recipientAnswer, signerFor, testCtx } from './helpers';

const A = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const VAULT = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512'; // the simnet defaults' vault on both chains
// Any mention of another chain: by the coordinator's names or by the wallet's own (the local preset's).
const OTHER_CHAIN = /bsc-local|ethereum-local can pay|BNB Chain \(local\)|Ethereum \(local\) can pay|instead|can pay it now/;

// /status as the coordinator answers it; `releaseAvailable` per chain decides who can pay now.
const chainEntry = (chain: 1 | 2, releaseAvailable: number) => ({
  chain, name: chain === 1 ? 'ethereum-local' : 'bsc-local', paused: false, backing: 1_000_000_000, releaseAvailable,
  fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: 500000, minDeposit: 10000000, maxDeposit: 100000000000, releaseCapacity: 400_000_000, releaseRefillPerSecond: 2893518 },
  blocklist: chain === 1 ? 'isBlackListed' : null,
});
const status = (eth = 300_000_000, bsc = 300_000_000) => ({ chains: [chainEntry(1, eth), chainEntry(2, bsc)] });

describe('reading the answer of GET /recipients', () => {
  it('lets a burn go ahead only on a clear "payable" about exactly this chain and address', () => {
    expect(checkRecipientAnswer(recipientAnswer('ethereum', A), 'ethereum', A)).toEqual({ payable: true, problem: null, checked: true, blocked: false });
    // The coordinator answers the checksummed form; the wallet may have asked in lowercase.
    expect(checkRecipientAnswer(recipientAnswer('bsc', A), 'bsc', A.toLowerCase()).payable).toBe(true);
    for (const answer of [
      recipientAnswer('bsc', A),                                   // about the other chain
      recipientAnswer('ethereum', '0x' + '42'.repeat(20)),         // about another address
      { ...recipientAnswer('ethereum', A), payable: 'true' },      // not a boolean
      { ...recipientAnswer('ethereum', A), blocked: undefined },
      { chain: 1, address: A }, null, [], 'payable',
    ]) {
      const c = checkRecipientAnswer(answer, 'ethereum', A, 'ethereum-local');
      expect(c).toMatchObject({ payable: false, checked: false });
      expect(c.problem).toMatch(/Couldn't check the recipient/);
    }
  });

  it('refuses an address the token blocks, says why, and offers no other chain', () => {
    const c = checkRecipientAnswer(recipientAnswer('ethereum', A, { blocked: true, payable: false, reason: 'the token blocks this address' }), 'ethereum', A, 'ethereum-local');
    expect(c).toMatchObject({ payable: false, checked: true, blocked: true });
    expect(c.problem).toMatch(/USDT on ethereum-local blocks this address/);
    expect(c.problem).toMatch(/frozen/);
    expect(c.problem).not.toMatch(OTHER_CHAIN);
    // "blocked" wins over a contradictory "payable".
    expect(checkRecipientAnswer(recipientAnswer('ethereum', A, { blocked: true }), 'ethereum', A).payable).toBe(false);
  });

  it("refuses what the vault never pays, with the coordinator's reason", () => {
    const c = checkRecipientAnswer(recipientAnswer('bsc', A, { payable: false, reason: "the vault's own address" }), 'bsc', A, 'bsc-local');
    expect(c).toMatchObject({ payable: false, checked: true, blocked: false });
    // The coordinator's reason, said as its own (run 21 round 2, R21-W2-5).
    expect(c.problem).toBe("The bsc-local vault won't pay this address (the bridge server says \"the vault's own address\"). Use another address.");
    expect(checkRecipientAnswer(recipientAnswer('bsc', A, { payable: false, reason: null }), 'bsc', A, 'bsc-local').problem).toBe("The bsc-local vault won't pay this address. Use another address.");
  });
});

describe('asking the coordinator (recipientCheck)', () => {
  it('asks by chain code, the one the burn owner commits to', async () => {
    const urls: string[] = [];
    const client = new CoordinatorClient('http://coord/api/v1/', (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(recipientAnswer(url.includes('/recipients/1/') ? 'ethereum' : 'bsc', A)), { status: 200 });
    }) as unknown as typeof fetch);
    const ctx = testCtx(new FakeNode(), client);
    expect((await recipientCheck(ctx, 'ethereum', A)).payable).toBe(true);
    expect((await recipientCheck(ctx, 'bsc', A)).payable).toBe(true);
    expect(urls).toEqual([`http://coord/api/v1/recipients/1/${A}`, `http://coord/api/v1/recipients/2/${A}`]);
  });

  it("fails closed: a 503, a 404 from an older coordinator, a network error or no API at all refuse the burn", async () => {
    const answers: (() => Response)[] = [
      () => new Response(JSON.stringify({ error: "can't read the token's blocklist: timeout" }), { status: 503 }),
      () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
      () => { throw new TypeError('fetch failed'); },
      () => new Response('not json', { status: 200 }),
    ];
    for (const answer of answers) {
      const client = new CoordinatorClient('http://coord/api/v1', (async () => answer()) as unknown as typeof fetch);
      const c = await recipientCheck(testCtx(new FakeNode(), client), 'ethereum', A);
      expect(c).toMatchObject({ payable: false, checked: false, blocked: false });
      expect(c.problem).toMatch(/Couldn't check the recipient with the coordinator/);
      expect(c.problem).toMatch(/can't be undone/);
      expect(c.problem).toMatch(/Try again/);
    }
    const thrown = await recipientCheck(testCtx(new FakeNode(), fakeApi({ recipient: async () => { throw new ApiError('down', 503); } })), 'bsc', A);
    expect(thrown).toMatchObject({ payable: false, checked: false });
    const none = await recipientCheck(testCtx(new FakeNode(), null), 'bsc', A);
    expect(none).toMatchObject({ payable: false, checked: false });
    expect(none.problem).toMatch(/No coordinator API/);
  });

  it("refuses the zero address and the pinned vault's own without asking", async () => {
    const recipient = vi.fn(async (chain: 'ethereum' | 'bsc', address: string) => recipientAnswer(chain, address));
    const ctx = testCtx(new FakeNode(), fakeApi({ recipient }));
    expect((await recipientCheck(ctx, 'ethereum', '0x' + '00'.repeat(20))).problem).toMatch(/\(the zero address\)/);
    expect((await recipientCheck(ctx, 'bsc', VAULT.toLowerCase())).problem).toMatch(/\(the vault's own address\)/);
    expect((await recipientCheck(ctx, 'bsc', '0x1234')).payable).toBe(false);
    expect(recipient).not.toHaveBeenCalled();
  });
});

describe('the other chain is offered only to an address its vault would pay', () => {
  it('offers Ethereum for an amount BNB Chain cannot pay now, unless Ethereum USDT blocks the address', async () => {
    const units = 60_000_000n;
    const ask = (eth: Record<string, unknown>) => testCtx(new FakeNode(), fakeApi({ status: async () => status(300_000_000, 50_000_000), recipient: async (chain, address) => recipientAnswer(chain, address, chain === 'ethereum' ? eth : {}) }));

    const fine = await redeemCheck(ask({}), 'bsc', units, A);
    expect(fine.other).toBe('ethereum');
    // Named as the wallet pinned the chains (the local preset), not as the coordinator's /status does ("ethereum-local").
    expect(fine.problem).toMatch(/The BNB Chain \(local\) vault can pay at most 50 USDT right now/);
    expect(fine.problem).toMatch(/Ethereum \(local\) can pay it now/);
    expect(fine.problem).not.toMatch(/ethereum-local|bsc-local/);

    const blocked = await redeemCheck(ask({ blocked: true, payable: false }), 'bsc', units, A);
    expect(blocked.other).toBeNull();
    expect(blocked.problem).toMatch(/at most 50 USDT right now/);
    expect(blocked.problem).not.toMatch(/can pay it now/);

    const failing = testCtx(new FakeNode(), fakeApi({ status: async () => status(300_000_000, 50_000_000), recipient: async () => { throw new ApiError('down', 503); } }));
    expect((await redeemCheck(failing, 'bsc', units, A)).other).toBeNull();
    // Without an address (none typed yet) the amount alone decides, as before.
    expect((await redeemCheck(failing, 'bsc', units)).other).toBe('ethereum');
  });
});

// ── planRedeem / executeRedeem on a fake node ──────────────────────────────

const alice = devKey('recipient-alice');
function tokenUtxo(ctx: Ctx, txid: string, state: TokenState): NodeUtxo {
  const spk = scriptOf(ctx, 'KCC20', state);
  return { address: p2shAddressOf(spk, 'kaspasim'), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT };
}

/** A wallet holding one 20 kUSDT state and 10 KAS, and a coordinator whose /recipients answer the test sets. */
function wallet(tag: string, statusNow = status()) {
  const node = new FakeNode();
  const state = plainState({ ownerScheme: 0, owner: alice.xonly }, 20_000_000n);
  const tx = (n: number) => `${tag}${n}`.padEnd(64, '0');
  const asked: string[] = [];
  const answer = { now: (chain: 'ethereum' | 'bsc', address: string): unknown => recipientAnswer(chain, address) };
  const tokens = vi.fn(async () => ({ states: [{ utxo: { transactionId: tx(1), index: 0 }, state: { ...state, amount: Number(state.amount) } }] }));
  const api = fakeApi({
    status: async () => statusNow, tokens,
    recipient: async (chain, address) => { asked.push(`${chain}:${address}`); return answer.now(chain, address); },
  });
  const ctx = testCtx(node, api);
  node.utxoSet.push(tokenUtxo(ctx, tx(1), state), kasCoin(alice, tx(2), 1_000_000_000n));
  return { node, ctx, asked, answer, tokens, signer: signerFor(alice), kas: [alice.address] };
}

describe('planRedeem and executeRedeem', () => {
  it('refuse a blocked recipient before anything is built, and name no other chain', async () => {
    // Ethereum can't pay 20 now, BNB Chain could: still, no other chain for a blocked address.
    const w = wallet('a1', status(1_000_000, 300_000_000));
    w.answer.now = (chain, address) => recipientAnswer(chain, address, { blocked: true, payable: false, reason: 'the token blocks this address' });
    const err = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 20_000_000n }).then(() => new Error('a burn was planned'), (e: Error) => e);
    expect(err.message).toMatch(/USDT on Ethereum \(local\) blocks this address/);
    expect(err.message).not.toMatch(OTHER_CHAIN);
    expect(w.tokens).not.toHaveBeenCalled();
    expect(w.node.submitted).toHaveLength(0);
  });

  it("refuse when the coordinator can't say (fail closed)", async () => {
    const w = wallet('a2');
    w.answer.now = () => { throw new ApiError('not found', 404); };
    await expect(planRedeem(w.ctx, w.signer, w.kas, { chain: 'bsc', address: A, amount: 20_000_000n })).rejects.toThrow(/Couldn't check the recipient/);
    w.answer.now = (chain) => recipientAnswer(chain, '0x' + '42'.repeat(20)); // an answer about someone else
    await expect(planRedeem(w.ctx, w.signer, w.kas, { chain: 'bsc', address: A, amount: 20_000_000n })).rejects.toThrow(/Couldn't check the recipient/);
    expect(w.tokens).not.toHaveBeenCalled();
    expect(w.node.submitted).toHaveLength(0);
  });

  it('build for a payable recipient; executeRedeem asks again and sends nothing once the address is blocked', async () => {
    const w = wallet('a3');
    const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 20_000_000n });
    expect(plan.built).not.toBeNull();
    expect(plan.releaseFee).toBe(5_000_000n); // the vault's own fee (test/helpers.ts), not the 0.50 this /status names
    expect(w.asked).toEqual([`ethereum:${A}`]);

    w.answer.now = (chain, address) => recipientAnswer(chain, address, { blocked: true, payable: false });
    await expect(executeRedeem(w.ctx, w.signer, w.kas, plan)).rejects.toThrow(/blocks this address/);
    w.answer.now = () => { throw new ApiError("can't read the token's blocklist", 503); };
    await expect(executeRedeem(w.ctx, w.signer, w.kas, plan)).rejects.toThrow(/Couldn't check the recipient/);
    expect(w.node.submitted).toHaveLength(0);

    w.answer.now = (chain, address) => recipientAnswer(chain, address);
    const r = await executeRedeem(w.ctx, w.signer, w.kas, plan);
    expect(r.txid).toBe(plan.built!.txid);
    expect(w.node.submitted).toHaveLength(1);
    expect(w.asked).toEqual(Array(4).fill(`ethereum:${A}`));
  });

  it('lock only the small burn value with the burn; the change token keeps the full token value', async () => {
    const w = wallet('a4');
    const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 15_000_000n });
    expect(plan.tokenValue).toBe(30_000_000n);
    expect(plan.keptInToken).toBe(150_000_000n);
    const [burn, change] = plan.built!.outputs;
    expect(burn.token.amount.toString()).toBe('15000000');
    expect(burn.value).toBe(30_000_000n);
    expect(change.token.owner).toBe(alice.xonly);
    expect(change.value).toBe(150_000_000n);
  });
});

describe('redemption status', () => {
  it('knows blocked (held, paid once unblocked) and unpayable', async () => {
    const answers: Record<string, unknown> = {
      b: { status: 'blocked', lastError: 'the token blocks 0x…; nothing is paid to it while it does (SPEC §9)', nextTry: Date.now() + 3_600_000 },
      u: { status: 'unpayable', note: '400000 does not cover the release fee of 500000' },
      r: { status: 'released', evmTxHash: '0x' + 'ab'.repeat(32), fee: 500000 },
      x: { status: 'something-new' },
    };
    const ctx = testCtx(new FakeNode(), fakeApi({ redeem: async (txid) => answers[txid] }));
    expect((await redeemStatus(ctx, 'b', 0)).status).toBe('blocked');
    expect((await redeemStatus(ctx, 'u', 0)).status).toBe('unpayable');
    expect(await redeemStatus(ctx, 'r', 0)).toEqual({ status: 'released', evmTxHash: '0x' + 'ab'.repeat(32), fee: '500000' });
    expect((await redeemStatus(ctx, 'x', 0)).status).toBe('unknown');
  });
});
