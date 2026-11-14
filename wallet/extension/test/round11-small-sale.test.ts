// Round 11, R11-WW-4: a wallet with one kUSDT state and no plain KAS sold a
// part of it worth just over 0.2 KAS. After the network fee less than 0.2 KAS
// was left, the core leaves change under 0.2 KAS to the fee, and so the whole
// of what the sale brought went to the fee: the wallet's check (what comes
// back is at least the proceeds less the fee PAID) passed at zero, and the
// sale was reported as done. Such a sale is now refused before anything is
// signed, and a built sale that gives anything above the fee its size needs
// to the network is never sent.

import { beforeEach, describe, expect, it } from 'vitest';
import { FakeNode, COVENANT, POOL, devKey, fakeApi, testCtx, signerFor, kasCoin, lastBuilt } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { POOL_WAIT, SELL_FEE_MASS, SaleLeavesNothing, minimumFor, quoteSell, swap } from '@/kusdt/pool';
import { CORE_MIN_CHANGE, feeNeeded } from '@/kusdt/build';
import { plainState } from '@/kusdt/owner';
import { session } from '@/lib/storage';
import type { PoolState } from '@/kusdt/types';

const alice = devKey('r11-small-sale');
const KAS = 100_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };

let n = 0;
const uniq = (c: string) => (++n).toString(16).padStart(64, c);

/** A pool, and a wallet holding one kUSDT state of `held` units on 1.5 KAS. */
function scene(held: bigint) {
  const node = new FakeNode();
  const pspk = scriptOf({ core: testCtx(node).core }, 'Pool', base), reserve = reserveStateOf(POOL, base);
  const ctx0 = testCtx(node);
  const rspk = scriptOf(ctx0, 'KCC20', reserve), ptx = uniq('7');
  node.utxoSet.push(
    { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: ptx, index: 0, amount: poolValue(base), scriptPublicKey: pspk, blockDaaScore: 999_990n, isCoinbase: false, covenantId: POOL },
    { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: ptx, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT },
  );
  const state = plainState({ ownerScheme: 0, owner: alice.xonly }, held), spk = scriptOf(ctx0, 'KCC20', state), ttx = uniq('e');
  node.utxoSet.push({ address: p2shAddressOf(spk, 'kaspasim'), transactionId: ttx, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
  const api = fakeApi({
    pool: async () => ({ pool: { utxo: { transactionId: ptx, index: 0 }, state: base }, reserve: { utxo: { transactionId: ptx, index: 1 }, state: reserve } }),
    tokens: async () => ({ states: [{ utxo: { transactionId: ttx, index: 0 }, state: { ...state, amount: held.toString() } }] }),
  });
  return { node, ctx: testCtx(node, api) };
}

/** The finding's sale: 0.020130 kUSDT of the pool above brings just over 0.2 KAS. */
const SMALL = 20_130n;

beforeEach(async () => {
  POOL_WAIT.ms = 0; POOL_WAIT.perDaaMs = 0;
  await session.remove('kusdt.pending.simnet', `kusdt.poolHint.simnet.${POOL}`);
});

describe('a partial sale by a wallet with no plain KAS, worth just over 0.2 KAS', () => {
  it('is refused before anything is signed or sent: all it brings would go to the network fee', async () => {
    const s = scene(5_000_000n);
    const kasOut = quoteSell(s.ctx, base, SMALL);
    expect(kasOut).toBeGreaterThanOrEqual(CORE_MIN_CHANGE);
    expect(kasOut).toBeLessThan(CORE_MIN_CHANGE + 100_000n);
    let keys = 0;
    const signer = signerFor(alice);
    const counting = { ...signer, secretFor: (a: string) => { keys++; return signer.secretFor(a); } };
    const e = await swap(s.ctx, counting, [alice.address], { side: 'sell', amountIn: SMALL, minOut: CORE_MIN_CHANGE, quoted: kasOut }).catch(x => x);
    // Before the fix this resolved with amountOut = kasOut and a transaction whose fee was all of kasOut.
    expect(e).toBeInstanceOf(SaleLeavesNothing);
    expect(e.message).toMatch(/all of it would go to the network fee/);
    expect(e.message).toMatch(/Nothing was sent/);
    expect(s.node.submitted).toHaveLength(0);
    expect(keys).toBe(0);
  });

  it('goes through once the wallet holds some KAS: the proceeds come back, less only the fee the transaction needs', async () => {
    const s = scene(5_000_000n);
    s.node.utxoSet.push(kasCoin(alice, uniq('c'), 1n * KAS));
    const kasOut = quoteSell(s.ctx, base, SMALL);
    const r = await swap(s.ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: SMALL, minOut: CORE_MIN_CHANGE, quoted: kasOut });
    expect(r.built.fee).toBe(feeNeeded(r.built, 100));
    const back = r.built.outputs.filter(o => o.scriptPublicKey === `000020${alice.xonly}ac`).reduce((t, o) => t + o.value, 0n);
    expect(back).toBe(1n * KAS + kasOut - r.built.fee);
    // The wallet's allowance for a sale's size covers what the core really charges for it.
    expect(r.built.mass.feeMass).toBeLessThanOrEqual(SELL_FEE_MASS);
  });

  it('selling all of the state needs no other KAS: its own 1.5 KAS comes back with the proceeds', async () => {
    const s = scene(SMALL);
    const kasOut = quoteSell(s.ctx, base, SMALL);
    const r = await swap(s.ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: SMALL, minOut: CORE_MIN_CHANGE, quoted: kasOut });
    const back = r.built.outputs.filter(o => o.scriptPublicKey === `000020${alice.xonly}ac`).reduce((t, o) => t + o.value, 0n);
    expect(back).toBe(150_000_000n + kasOut - r.built.fee);
    expect(r.built.fee).toBe(feeNeeded(r.built, 100));
  });

  it('a larger partial sale with no plain KAS goes through: what is left after the fee is kept as change', async () => {
    const s = scene(5_000_000n);
    const kasOut = quoteSell(s.ctx, base, 100_000n); // about 1 KAS
    const r = await swap(s.ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: 100_000n, minOut: minimumFor(kasOut, 100), quoted: kasOut });
    const back = r.built.outputs.filter(o => o.scriptPublicKey === `000020${alice.xonly}ac`).reduce((t, o) => t + o.value, 0n);
    expect(back).toBe(kasOut - r.built.fee);
    expect(back).toBeGreaterThanOrEqual(CORE_MIN_CHANGE);
  });

  it('a feerate that rises between the check and the build is caught at the build: a sale that would feed the fee is never sent', async () => {
    const s = scene(5_000_000n);
    // 0.0260 kUSDT brings about 0.258 KAS: fine at 100 sompi per gram (0.2 KAS and more is left), not at 300.
    const amountIn = 26_000n, kasOut = quoteSell(s.ctx, base, amountIn);
    let asked = 0;
    s.node.feerate = async () => (++asked === 1 ? 100 : 300);
    const e = await swap(s.ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn, minOut: CORE_MIN_CHANGE, quoted: kasOut }).catch(x => x);
    expect(e).toBeInstanceOf(SaleLeavesNothing);
    expect(s.node.submitted).toHaveLength(0);
    expect(lastBuilt.command).toBe('pool-sell');
  });

  it('a network fee as large as the proceeds is refused too, whatever else the wallet holds', async () => {
    const s = scene(5_000_000n);
    s.node.utxoSet.push(kasCoin(alice, uniq('c'), 50n * KAS));
    const kasOut = quoteSell(s.ctx, base, SMALL);
    s.node.feerate = async () => 2_000; // the wallet's highest: about 1.2 KAS for this transaction
    const e = await swap(s.ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: SMALL, minOut: CORE_MIN_CHANGE, quoted: kasOut }).catch(x => x);
    expect(e).toBeInstanceOf(SaleLeavesNothing);
    expect(e.message).toMatch(/network fee .* is more than .* this sale brings/);
    expect(s.node.submitted).toHaveLength(0);
  });
});
