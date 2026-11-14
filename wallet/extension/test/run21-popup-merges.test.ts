// Run 21, Daybreak [9] in the wallet's own screens: the approval window stopped saying "Nothing was sent" once a
// request's merges had gone out, but the popup did not. Its Swap and Add liquidity screens showed the pool's new quote
// with "Nothing was sent." under it, and their errors, Send's, the Pool opening's and a redemption's, said nothing of
// the merges that went out before the action itself stopped. Now, after merges, the popup says that the action's own
// transaction was not sent, how many merges went out first, that they only joined the user's kUSDT, which is still
// theirs, and that they are in Activity. Real core, the wallet's real pool and merge engine and its real screens; a
// fake node and coordinator.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, checkbox, cleanup, click, field, mount, toggle, typeIn, until } from './fake-dom';
import { A, fixture, noNetwork, resetStores } from './screen-fixture';
import { COVENANT, POOL, FakeNode, lastBuilt, recipientAnswer } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { POOL_WAIT } from '@/kusdt/pool';
import { listActivity } from '@/activity/history';
import { NavContext, type Nav } from '@/popup/nav';
import { Swap } from '@/screens/Swap';
import { Bridge } from '@/screens/Bridge';
import type { PoolState } from '@/kusdt/types';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };
/** A pool a little worse for a sale: below the quote shown, above the minimum the slippage leaves. */
const worse: PoolState = { ...base, kasReserve: base.kasReserve - KAS / 100n };

beforeEach(async () => { await resetStores(); lastBuilt.txid = ''; vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Puts the pool state (and its reserve) on `node` in place of the one before, and answers it from the coordinator. */
function pooled(node: FakeNode, ctx: Parameters<typeof scriptOf>[0], tag: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

/** Lands what the core just built (a merge): its token outputs and its KAS change. */
function lander(node: FakeNode, address: string) {
  return () => {
    const v = lastBuilt.value;
    for (const o of v.outputs) {
      const p2sh = /^0000aa20[0-9a-f]{64}87$/.test(o.scriptPublicKey);
      node.utxoSet.push({ address: p2sh ? p2shAddressOf(o.scriptPublicKey, 'kaspasim') : address, transactionId: v.txid, index: o.index, amount: BigInt(o.value), scriptPublicKey: o.scriptPublicKey, blockDaaScore: 999_100n, isCoinbase: false, covenantId: p2sh ? COVENANT : null });
    }
  };
}
const merges = async () => (await listActivity('simnet')).filter(a => a.kind === 'kusdt-merge');
const nav = (tab: Nav['tab']): Nav => ({ tab, setTab() {}, push() {}, back() {}, lock() {} });

/** The popup's Swap screen, set to sell 1 kUSDT held in four states of 0.3 (two merges first: 4 → 2 → 1). */
async function sale(tag: string) {
  const fx = fixture(tag, { tokens: [300_000n, 300_000n, 300_000n, 300_000n], api: { pool: async () => pool.answer() } });
  const pool = pooled(fx.node, fx.ctx, tag);
  const coin = fx.node.utxoSet.find(u => `${u.transactionId}:${u.index}` === fx.kasOutpoint)!;
  fx.node.utxoSet.push({ ...coin, transactionId: `${tag}a`.padEnd(64, '0'), amount: 100n * KAS });
  const land = lander(fx.node, fx.wallet.keys.main.address);
  fx.node.submitImpl = async () => { land(); return lastBuilt.txid; };
  h.wallet = fx.wallet;
  const { root } = await mount(createElement(NavContext.Provider, { value: nav('swap') }, createElement(Swap)));
  await until('the pool', () => root.textContent.includes('1 kUSDT ='));
  await click(button(root, /^Switch to/));
  await typeIn(field(root, 'You pay'), '1');
  await until('the swap button', () => !button(root, 'Swap kUSDT for KAS').disabled);
  return { fx, pool, land, root };
}

describe('Daybreak [9] in the popup: after merges went out, it never says that nothing was sent', () => {
  it('Swap: the pool moved while the merges waited; the new quote says the sale was not sent and the merges went out', async () => {
    const { fx, pool, land, root } = await sale('c1');
    fx.node.submitImpl = async () => { land(); if (fx.node.submitted.length === 2) pool.place(worse); return lastBuilt.txid; };
    await click(button(root, 'Swap kUSDT for KAS'));
    await until('the new quote', () => root.textContent.includes('The pool moved before this went in')).catch((e) => { throw new Error(`${e.message}. Shown: ${root.textContent}`); });
    const shown = root.textContent as string;
    expect(fx.node.submitted).toHaveLength(2); // the two merges; no sale
    expect(shown).not.toMatch(/[Nn]othing was sent/);
    expect(shown).toMatch(/The sale was not sent; 2 merge transactions went out first \(in Activity\)/);
    expect(shown).toMatch(/still yours/);
    expect(await merges()).toHaveLength(2);
  });

  it('Swap: the sale refused after its merges (the node\'s feerate rose): the error says what went out', async () => {
    const { fx, root } = await sale('c2');
    fx.node.feerate = async () => (fx.node.submitted.length >= 2 ? 2_000 : 100);
    await click(button(root, 'Swap kUSDT for KAS'));
    await until('the refusal', () => /sompi a gram/.test(root.textContent));
    const shown = root.textContent as string;
    expect(fx.node.submitted).toHaveLength(2);
    expect(shown).not.toMatch(/[Nn]othing was sent/);
    expect(shown).toMatch(/the sale was not sent/);
    expect(shown).toMatch(/2 merge transactions went out first/);
  });

  it('a redemption stopped after its merges (the address is refused right before the burn): it says the merges went out', async () => {
    let refuse = false;
    const fx = fixture('c3', {
      tokens: [10_000_000n, 10_000_000n, 10_000_000n, 10_000_000n], // four states: one merge before the burn (a transfer takes three)
      api: { recipient: async (chain, address) => recipientAnswer(chain, address, refuse ? { payable: false, reason: 'not this address' } : {}) },
    });
    const land = lander(fx.node, fx.wallet.keys.main.address);
    fx.node.submitImpl = async () => { land(); refuse = true; return lastBuilt.txid; };
    h.wallet = fx.wallet;
    const { root } = await mount(createElement(NavContext.Provider, { value: nav('bridge') }, createElement(Bridge)));
    await until('the Bridge screen', () => root.textContent.includes('Bridge'));
    await click(button(root, /→ USDT$/));
    await until('the Redeem form', () => root.textContent.includes('Paid') || root.textContent.includes('Your account'));
    await click(button(root, 'Pay another address'));
    await typeIn(field(root, /Pay USDT to/), A);
    await typeIn(field(root, 'kUSDT to redeem'), '35');
    await until('the checks', () => !button(root, 'Review').disabled);
    await click(button(root, 'Review'));
    await until('the Review', () => root.textContent.includes('You burn'));
    await toggle(checkbox(root));
    await until('Redeem to be enabled', () => !button(root, 'Redeem').disabled);
    await click(button(root, 'Redeem'));
    await until('the refusal', () => /went out first|not this address/.test(root.textContent)).catch((e) => { throw new Error(`${e.message}. Shown: ${root.textContent}`); });
    const shown = root.textContent as string;
    expect(fx.node.submitted.length).toBeGreaterThan(0); // merges only
    expect(shown).toMatch(/not this address/);
    expect(shown).toMatch(/1 merge transaction went out first \(in Activity\)/);
    expect(shown).not.toMatch(/[Nn]othing was sent/);
  });
});
