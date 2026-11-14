// Run 21 fixes, Daybreak [9] (the rc.23 report, reproduced on rc.24 by run 21's wallet review). A site's kusdt_swap
// sale (and kusdt_addLiquidity) is approved in the window with one network fee row, at the feerate of the moment, and
// the note that nothing is sent above half as much again. With the kUSDT in several states the wallet first merges
// them, and each merge was built at whatever feerate the node named then: two merges went out at 20 times the
// feerate shown before the sale itself was refused for it. And when the pool moved while the merges waited, the
// window said "Nothing was sent" though the merges had gone out. Now every merge is held to the feerate shown, so a
// node naming more refuses the request before any merge is signed; and after merges went out the window never says
// nothing was sent: it says what was, that it only joined the user's own kUSDT, which is still theirs, and the merges
// are in Activity.
// Real core, the wallet's real pool and merge engine and its real approval window; a fake node and coordinator.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, click, fakeWindow, mount, until } from './fake-dom';
import { fixture, noNetwork, resetStores } from './screen-fixture';
import { FakeNode, COVENANT, POOL, devKey, fakeApi, testCtx, signerFor, kasCoin, lastBuilt } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { POOL_WAIT, PoolFeeAboveShown, addLiquidity, quoteAdd, quoteSell, swap } from '@/kusdt/pool';
import { plainState } from '@/kusdt/owner';
import { listActivity } from '@/activity/history';
import { session } from '@/lib/storage';
import { REQUEST_KEY, type PendingRequest } from '@/provider/protocol';
import { Approve, ARM_MS } from '@/screens/Approve';
import type { PoolState } from '@/kusdt/types';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };
const worse: PoolState = { ...base, kasReserve: base.kasReserve - 5n * KAS, tokenReserve: base.tokenReserve + 500_000n };

beforeEach(async () => {
  await resetStores(); lastBuilt.txid = '';
  vi.stubGlobal('fetch', noNetwork);
  vi.stubGlobal('chrome', { tabs: { sendMessage: (_t: number, _m: unknown, cb?: () => void) => cb?.() }, runtime: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Puts the pool state (and its reserve) on `node` in place of the one before, and answers it from the coordinator. */
function pooled(node: FakeNode, ctx: ReturnType<typeof testCtx>, tag: string) {
  let answer: any = null, n = 0;
  const place = (pool: PoolState) => {
    const txid = `${tag}f${++n}`.padEnd(64, '0');
    node.utxoSet = node.utxoSet.filter(u => !u.transactionId.startsWith(`${tag}f`));
    const pspk = scriptOf(ctx, 'Pool', pool), reserve = reserveStateOf(POOL, pool), rspk = scriptOf(ctx, 'KCC20', reserve);
    node.utxoSet.push(
      { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(pool), scriptPublicKey: pspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: POOL },
      { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: COVENANT },
    );
    answer = { pool: { utxo: { transactionId: txid, index: 0 }, state: pool }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } };
  };
  place(base);
  return { place, answer: async () => answer };
}

/** Lands what the core just built (a merge): its token output and its KAS change. */
function lander(node: FakeNode, address: string) {
  return () => {
    const v = lastBuilt.value;
    for (const o of v.outputs) {
      const p2sh = /^0000aa20[0-9a-f]{64}87$/.test(o.scriptPublicKey);
      node.utxoSet.push({ address: p2sh ? p2shAddressOf(o.scriptPublicKey, 'kaspasim') : address, transactionId: v.txid, index: o.index, amount: BigInt(o.value), scriptPublicKey: o.scriptPublicKey, blockDaaScore: 999_100n, isCoinbase: false, covenantId: p2sh ? COVENANT : null });
    }
  };
}

/** A wallet beside the pool with four states of 0.3 kUSDT (selling or depositing 1 kUSDT merges twice: 4 → 2 → 1) and 100 KAS. */
function engine(tag: string) {
  const alice = devKey(`r21-merges-${tag}`);
  const node = new FakeNode();
  const listed: any[] = [];
  let pool: ReturnType<typeof pooled> | null = null;
  const ctx = testCtx(node, fakeApi({ pool: async () => pool!.answer(), tokens: async () => ({ states: listed }) }));
  pool = pooled(node, ctx, tag);
  node.utxoSet.push(kasCoin(alice, `${tag}e1`.padEnd(64, '3'), 50n * KAS), kasCoin(alice, `${tag}e2`.padEnd(64, '4'), 50n * KAS));
  for (let i = 0; i < 4; i++) {
    const state = plainState({ ownerScheme: 0, owner: alice.xonly }, 300_000n);
    const spk = scriptOf(ctx, 'KCC20', state);
    const txid = `${tag}d${i}`.padEnd(64, '5');
    node.utxoSet.push({ address: p2shAddressOf(spk, 'kaspasim'), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
    listed.push({ utxo: { transactionId: txid, index: 0 }, state: { ...state, amount: '300000' } });
  }
  const land = lander(node, alice.address);
  node.submitImpl = async () => { land(); return lastBuilt.txid; };
  return { node, ctx, signer: signerFor(alice), kas: [alice.address] };
}

describe('Daybreak [9]: the merges a pool request needs first are held to the feerate shown', () => {
  it('a sale whose node names 20 times the feerate shown: refused before any merge is signed or sent', async () => {
    const s = engine('a');
    const quoted = quoteSell(s.ctx, base, 1_000_000n);
    let reads = 0;
    s.node.feerate = async () => (++reads === 1 ? 100 : 2_000); // as the review had it: 2 000 from the first merge on
    const e = await swap(s.ctx, s.signer, s.kas, { side: 'sell', amountIn: 1_000_000n, minOut: quoted / 2n, quoted, shownFeerate: 100 }).catch(x => x);
    expect(e).toBeInstanceOf(PoolFeeAboveShown);
    expect(s.node.submitted).toEqual([]);
  });

  it('a feerate that rises after the first merge: the second merge is not sent, nor the sale', async () => {
    const s = engine('b');
    const quoted = quoteSell(s.ctx, base, 1_000_000n);
    s.node.feerate = async () => (s.node.submitted.length >= 1 ? 2_000 : 100);
    const e = await swap(s.ctx, s.signer, s.kas, { side: 'sell', amountIn: 1_000_000n, minOut: quoted / 2n, quoted, shownFeerate: 100 }).catch(x => x);
    expect(e).toBeInstanceOf(PoolFeeAboveShown);
    expect(s.node.submitted).toHaveLength(1);
  });

  it('a deposit\'s merges are held the same way', async () => {
    const s = engine('c');
    const shares = quoteAdd(s.ctx, base, 10n * KAS, 1_000_000n);
    s.node.feerate = async () => 2_000;
    const e = await addLiquidity(s.ctx, s.signer, s.kas, { kasIn: 10n * KAS, tokensIn: 1_000_000n, minShares: shares, quoted: shares, shownFeerate: 100 }).catch(x => x);
    expect(e).toBeInstanceOf(PoolFeeAboveShown);
    expect(s.node.submitted).toEqual([]);
  });

  it('merges at the feerate shown go ahead, and then the sale', async () => {
    const s = engine('d');
    const quoted = quoteSell(s.ctx, base, 1_000_000n);
    const r = await swap(s.ctx, s.signer, s.kas, { side: 'sell', amountIn: 1_000_000n, minOut: quoted / 2n, quoted, shownFeerate: 100 });
    expect(s.node.submitted).toHaveLength(3);
    expect(r.txid).toBe(lastBuilt.txid);
  });
});

/** The approval window for a site's sale of 1 kUSDT from four states of 0.3, the pool and the merges landing as they go. */
async function windowFor(tag: string) {
  const fx = fixture(tag, { tokens: [300_000n, 300_000n, 300_000n, 300_000n], api: { pool: async () => pool.answer() } });
  const pool = pooled(fx.node, fx.ctx, tag);
  const coin = fx.node.utxoSet.find(u => `${u.transactionId}:${u.index}` === fx.kasOutpoint)!;
  fx.node.utxoSet.push({ ...coin, transactionId: `${tag}a`.padEnd(64, '0'), amount: 100n * KAS });
  const land = lander(fx.node, fx.wallet.keys.main.address);
  fx.node.submitImpl = async () => { land(); return lastBuilt.txid; };
  h.wallet = fx.wallet;
  const id = `window-run21-sell-${tag}`;
  const quoted = quoteSell(fx.ctx, base, 1_000_000n);
  const params = { method: 'kusdt_swap', side: 'sell', amountIn: '1000000', minOut: (quoted / 2n).toString() } as PendingRequest['params'];
  await session.set({ [REQUEST_KEY]: { id, method: params.method, params, origin: 'https://page.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest });
  fakeWindow.location.hash = `#request=${id}`;
  const { root } = await mount(createElement(Approve));
  await until('Approve', () => button(root, 'Approve'));
  await until('Approve to arm', () => !button(root, 'Approve').disabled, ARM_MS + 3_000).catch((e) => { throw new Error(`${e.message}. Shown: ${root.textContent}`); });
  return { fx, pool, land, root };
}
const merges = async () => (await listActivity('simnet')).filter(a => a.kind === 'kusdt-merge');

describe('Daybreak [9]: after merges went out, the approval window never says that nothing was sent', () => {
  it('the pool moved while the merges waited: the window asks again, and says the merges went out and the kUSDT is still yours', async () => {
    const { fx, pool, land, root } = await windowFor('e1');
    fx.node.submitImpl = async () => { land(); if (fx.node.submitted.length === 2) pool.place(worse); return lastBuilt.txid; };
    await click(button(root, 'Approve'));
    await until('the new numbers', () => /New quote/.test(root.textContent));
    const shown = root.textContent as string;
    expect(fx.node.submitted).toHaveLength(2); // the two merges; no sale
    expect(shown).not.toMatch(/[Nn]othing was sent/);
    expect(shown).toMatch(/2 merge transactions went out first/);
    expect(shown).toMatch(/still yours/);
    expect(await merges()).toHaveLength(2);
  });

  it('the sale refused after its merges (the node\'s feerate rose): the message says what went out', async () => {
    const { fx, root } = await windowFor('e2');
    fx.node.feerate = async () => (fx.node.submitted.length >= 2 ? 2_000 : 100);
    await click(button(root, 'Approve'));
    await until('the refusal', () => /sompi a gram/.test(root.textContent));
    const shown = root.textContent as string;
    expect(fx.node.submitted).toHaveLength(2);
    expect(shown).not.toMatch(/[Nn]othing was sent/);
    expect(shown).toMatch(/the sale was not sent/);
    expect(shown).toMatch(/2 merge transactions went out first/);
    expect(shown).toMatch(/still yours/);
    expect(await merges()).toHaveLength(2);
  });

  it('refused before any merge (the node already names more than shown): that is said as it is, nothing sent', async () => {
    const { fx, root } = await windowFor('e3');
    fx.node.feerate = async () => 2_000;
    await click(button(root, 'Approve'));
    await until('the refusal', () => /sompi a gram/.test(root.textContent));
    expect(fx.node.submitted).toEqual([]);
    expect(root.textContent).toMatch(/nothing was sent/);
    expect(root.textContent).not.toMatch(/merge transactions? went out/);
  });
});
