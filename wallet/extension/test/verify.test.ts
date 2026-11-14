import { describe, expect, it } from 'vitest';
import { FakeNode, COVENANT, POOL, devKey, fakeApi, testCtx, signerFor, kasCoin } from './helpers';
import { p2shAddressOf, scriptOf, verifyTokenStates, verifyPool, reserveStateOf, poolValue } from '@/kusdt/verify';
import { plainState, type TokenState } from '@/kusdt/owner';
import { loadTokens, buildTransfer, burnOwner, redeemPayload, evmHex, payloadOf } from '@/kusdt/tokens';
import { kasCoins } from '@/kusdt/build';
import type { NodeUtxo } from '@/kaspa/node';
import type { Ctx, PoolState } from '@/kusdt/types';

const alice = devKey('alice');
const TXA = 'aa'.repeat(32), TXB = 'bb'.repeat(32), TXC = 'cc'.repeat(32);

export function tokenUtxo(ctx: Ctx, txid: string, state: TokenState, over: Partial<NodeUtxo> = {}): NodeUtxo {
  const spk = scriptOf(ctx, 'KCC20', state);
  return { address: p2shAddressOf(spk, 'kaspasim'), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT, ...over };
}
const listed = (txid: string, state: TokenState) => ({ utxo: { transactionId: txid, index: 0 }, state: { ...state, amount: Number(state.amount) } });

describe('token state verification', () => {
  it('keeps a state whose script and covenant ID the node confirms', async () => {
    const node = new FakeNode();
    const ctx = testCtx(node);
    const s = plainState({ ownerScheme: 0, owner: alice.xonly }, 5_000_000n);
    node.utxoSet.push(tokenUtxo(ctx, TXA, s));
    const r = await verifyTokenStates(ctx, [listed(TXA, s)], alice.xonly);
    expect(r.rejected).toBe(0);
    expect(r.verified[0].state).toEqual(s);
    expect(r.verified[0].utxo.amount).toBe(150_000_000n);
  });

  it("rejects a state whose script doesn't match (the coordinator lies about the amount)", async () => {
    const node = new FakeNode();
    const ctx = testCtx(node);
    const real = plainState({ ownerScheme: 0, owner: alice.xonly }, 5_000_000n);
    node.utxoSet.push(tokenUtxo(ctx, TXA, real));
    const claimed = { ...real, amount: 500_000_000n };
    const r = await verifyTokenStates(ctx, [listed(TXA, claimed)], alice.xonly);
    expect(r.verified).toHaveLength(0);
    expect(r.rejected).toBe(1);
  });

  it('rejects a state at the right script with another covenant ID (a look-alike token)', async () => {
    const node = new FakeNode();
    const ctx = testCtx(node);
    const s = plainState({ ownerScheme: 0, owner: alice.xonly }, 7n);
    node.utxoSet.push(tokenUtxo(ctx, TXB, s, { covenantId: 'ee'.repeat(32) }));
    expect((await verifyTokenStates(ctx, [listed(TXB, s)], alice.xonly)).verified).toHaveLength(0);
  });

  it('rejects states of another owner, missing outpoints and spent ones', async () => {
    const node = new FakeNode();
    const ctx = testCtx(node);
    const bob = devKey('bob');
    const theirs = plainState({ ownerScheme: 0, owner: bob.xonly }, 9n);
    node.utxoSet.push(tokenUtxo(ctx, TXA, theirs));
    const mine = plainState({ ownerScheme: 0, owner: alice.xonly }, 3n);
    node.utxoSet.push(tokenUtxo(ctx, TXC, mine));
    node.spent.add(`${TXC}:0`);
    const r = await verifyTokenStates(ctx, [listed(TXA, theirs), listed(TXB, mine), listed(TXC, mine)], alice.xonly);
    expect(r.verified).toHaveLength(0);
    expect(r.rejected).toBe(3);
  });

  it('loadTokens shows only verified states, largest first', async () => {
    const node = new FakeNode();
    const s1 = plainState({ ownerScheme: 0, owner: alice.xonly }, 1_000_000n);
    const s2 = plainState({ ownerScheme: 0, owner: alice.xonly }, 9_000_000n);
    const fake = plainState({ ownerScheme: 0, owner: alice.xonly }, 99_000_000n);
    const ctx = testCtx(node, fakeApi({ tokens: async () => ({ states: [listed(TXA, s1), listed(TXB, s2), listed(TXC, fake)] }) }));
    node.utxoSet.push(tokenUtxo(ctx, TXA, s1), tokenUtxo(ctx, TXB, s2));
    const r = await loadTokens(ctx, signerFor(alice));
    expect(r.total).toBe(10_000_000n);
    expect(r.states.map(s => s.state.amount)).toEqual([9_000_000n, 1_000_000n]);
    expect(r.rejected).toBe(1);
  });
});

describe('pool verification', () => {
  const pool: PoolState = { tokenCovid: COVENANT, kasReserve: 20_000_000_000n, tokenReserve: 2_000_000_000n, totalShares: 20_000_000_000n, protocolKas: 5n, protocolTokens: 7n, baseValue: 100_000_000n, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 900_000n, windowRef: 20_000_000_000n, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };
  const setup = () => {
    const node = new FakeNode();
    const ctx = testCtx(node);
    const pspk = scriptOf(ctx, 'Pool', pool);
    const reserve = reserveStateOf(POOL, pool);
    const rspk = scriptOf(ctx, 'KCC20', reserve);
    node.utxoSet.push(
      { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: TXA, index: 0, amount: poolValue(pool), scriptPublicKey: pspk, blockDaaScore: 1n, isCoinbase: false, covenantId: POOL },
      { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: TXA, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT },
    );
    const answer = { pool: { utxo: { transactionId: TXA, index: 0 }, state: { ...pool, kasReserve: pool.kasReserve.toString() } }, reserve: { utxo: { transactionId: TXA, index: 1 }, state: reserve } };
    return { node, ctx, answer, reserve };
  };

  it('accepts the pool and reserve the node confirms', async () => {
    const { ctx, answer } = setup();
    const vp = await verifyPool(ctx, answer as any);
    expect(vp.pool.state.kasReserve).toBe(pool.kasReserve);
    expect(vp.reserve!.state.amount).toBe(pool.tokenReserve + pool.protocolTokens);
  });

  it('refuses a pool state that is not what the UTXO holds', async () => {
    const { ctx, answer } = setup();
    const lie = { ...answer, pool: { ...answer.pool, state: { ...answer.pool.state, tokenReserve: '9000000000' } } };
    await expect(verifyPool(ctx, lie as any)).rejects.toThrow();
  });

  it('refuses a reserve that does not belong to the pool', async () => {
    const { ctx, answer, reserve } = setup();
    await expect(verifyPool(ctx, { ...answer, reserve: { ...answer.reserve, state: { ...reserve, owner: 'cd'.repeat(32) } } } as any)).rejects.toThrow(/reserve/);
  });

  it('refuses a pool of another token', async () => {
    const { ctx, answer } = setup();
    await expect(verifyPool(ctx, { ...answer, pool: { ...answer.pool, state: { ...answer.pool.state, tokenCovid: 'cd'.repeat(32) } } } as any)).rejects.toThrow(/another token/);
  });
});

describe('a redemption built by the core', () => {
  it('sends to the burn owner with the payload, and the wallet checks every output', async () => {
    const node = new FakeNode();
    const ctx = testCtx(node);
    const signer = signerFor(alice);
    const s = plainState({ ownerScheme: 0, owner: alice.xonly }, 20_000_000n);
    node.utxoSet.push(tokenUtxo(ctx, TXA, s), kasCoin(alice, TXB, 1_000_000_000n));
    const [vs] = (await verifyTokenStates(ctx, [listed(TXA, s)], alice.xonly)).verified;
    const to = '0x' + '42'.repeat(20);
    const burn = burnOwner(ctx, 1, to);
    const built = buildTransfer(ctx, signer, await kasCoins(ctx, [alice.address]), {
      inputs: [vs],
      outputs: [{ state: plainState(burn, 15_000_000n), value: 150_000_000n }, { state: plainState({ ownerScheme: 0, owner: alice.xonly }, 5_000_000n), value: 150_000_000n }],
      redeem: [{ outputIndex: 0, chain: 1, address: evmHex(to) }],
    }, 100);
    expect(payloadOf(built)).toBe(redeemPayload([{ outputIndex: 0, chain: 1, address: evmHex(to) }]));
    expect(built.outputs[0].token.owner).toBe(burn.owner);
    expect(built.fee).toBeGreaterThan(0n);
  });

  it('refuses a redemption whose payload names another address than the burn owner', async () => {
    const node = new FakeNode();
    const ctx = testCtx(node);
    const s = plainState({ ownerScheme: 0, owner: alice.xonly }, 20_000_000n);
    node.utxoSet.push(tokenUtxo(ctx, TXA, s), kasCoin(alice, TXB, 1_000_000_000n));
    const [vs] = (await verifyTokenStates(ctx, [listed(TXA, s)], alice.xonly)).verified;
    const burn = burnOwner(ctx, 1, '0x' + '42'.repeat(20));
    expect(() => buildTransfer(ctx, signerFor(alice), [], {
      inputs: [vs], outputs: [{ state: plainState(burn, 20_000_000n), value: 150_000_000n }],
      redeem: [{ outputIndex: 0, chain: 1, address: '43'.repeat(20) }],
    }, 100)).toThrow(/burn owner/);
  });
});

import { checkBuilt } from '@/kusdt/build';
describe('the last check before submitting', () => {
  it('refuses a built transaction whose outputs are not what was approved', async () => {
    const node = new FakeNode();
    const ctx = testCtx(node);
    const signer = signerFor(alice);
    const s = plainState({ ownerScheme: 0, owner: alice.xonly }, 20_000_000n);
    node.utxoSet.push(tokenUtxo(ctx, TXA, s), kasCoin(alice, TXC, 1_000_000_000n));
    const [vs] = (await verifyTokenStates(ctx, [listed(TXA, s)], alice.xonly)).verified;
    const bob = devKey('bob');
    const out = { state: plainState({ ownerScheme: 0, owner: bob.xonly }, 20_000_000n), value: 150_000_000n };
    const built = buildTransfer(ctx, signer, await kasCoins(ctx, [alice.address]), { inputs: [vs], outputs: [out] }, 100);
    const expect0 = { tokens: [{ index: 0, state: out.state, value: out.value }] };
    expect(() => checkBuilt(ctx, built, signer, expect0)).not.toThrow();
    // Another recipient, another amount, KAS change to someone else: each refused.
    expect(() => checkBuilt(ctx, built, signer, { tokens: [{ index: 0, state: { ...out.state, owner: alice.xonly }, value: out.value }] })).toThrow(/approved/);
    expect(() => checkBuilt(ctx, built, signer, { tokens: [{ index: 0, state: out.state, value: 1n }] })).toThrow(/KAS/);
    const stolen = { ...built, outputs: built.outputs.map((o, i) => (i === 1 ? { ...o, scriptPublicKey: `000020${bob.xonly}ac` } : o)) };
    expect(() => checkBuilt(ctx, stolen, signer, expect0)).toThrow(/pays an address/);
  });
});
