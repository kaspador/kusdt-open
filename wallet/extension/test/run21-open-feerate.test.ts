// Run 21, Daybreak [9] for the pool's opening: a sale, a deposit and a withdrawal are held to the network fee their
// screen showed (a build, or a merge they need first, at more than half as much again is not sent), but the opening
// was not. The Open the pool screen showed no network fee, and openPool merged the admin's kUSDT and built the
// opening at whatever feerate the node named then: 20 times the usual went out unseen. Now the screen shows the fee
// and the opening and its merges are held to it, as the others are. The wallet's real Pool screen, pool and merge
// engine and core; a fake node and coordinator.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, click, elements, field, mount, typeIn, until } from './fake-dom';
import { fixture, noNetwork, resetStores } from './screen-fixture';
import { COVENANT, POOL, lastBuilt, type FakeNode } from './helpers';
import { p2shAddressOf, poolValue, scriptOf } from '@/kusdt/verify';
import { POOL_WAIT } from '@/kusdt/pool';
import { NavContext, type Nav } from '@/popup/nav';
import { PoolTab } from '@/screens/Pool';
import type { PoolState } from '@/kusdt/types';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;

beforeEach(async () => { await resetStores(); lastBuilt.txid = ''; vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Lands what the core just built: its outputs, the pool's and position's under the pool's covenant. */
function lander(node: FakeNode, address: string) {
  return () => {
    const v = lastBuilt.value;
    for (const o of v.outputs) {
      const p2sh = /^0000aa20[0-9a-f]{64}87$/.test(o.scriptPublicKey);
      node.utxoSet.push({ address: p2sh ? p2shAddressOf(o.scriptPublicKey, 'kaspasim') : address, transactionId: v.txid, index: o.index, amount: BigInt(o.value), scriptPublicKey: o.scriptPublicKey, blockDaaScore: 999_100n, isCoinbase: false, covenantId: !p2sh ? null : o.kind === 'pool' || o.kind === 'position' ? POOL : COVENANT });
    }
  };
}

/** The Open the pool screen of the pool's admin, 1 KAS and 5 kUSDT typed in, the kUSDT in two states of 3 (one merge first). */
async function opening(tag: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let answer: any = null;
  const fx = fixture(tag, { tokens: [3_000_000n, 3_000_000n], api: { pool: async () => answer } });
  const unopened: PoolState = { tokenCovid: COVENANT, kasReserve: 0n, tokenReserve: 0n, totalShares: 0n, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: fx.wallet.signer.ownerHex, maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 0n, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };
  const pspk = scriptOf(fx.ctx, 'Pool', unopened), txid = `${tag}f`.padEnd(64, '0');
  fx.node.utxoSet.push({ address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(unopened), scriptPublicKey: pspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: POOL });
  answer = { pool: { utxo: { transactionId: txid, index: 0 }, state: unopened }, reserve: null };
  const land = lander(fx.node, fx.wallet.keys.main.address);
  fx.node.submitImpl = async () => { land(); return lastBuilt.txid; };
  h.wallet = fx.wallet;
  const nav: Nav = { tab: 'pool', setTab() {}, push() {}, back() {}, lock() {} };
  const { root } = await mount(createElement(NavContext.Provider, { value: nav }, createElement(PoolTab)));
  await until('the empty pool', () => root.textContent.includes('No liquidity yet'));
  await click(button(root, 'Open the pool'));
  await typeIn(field(root, 'KAS'), '1');
  await typeIn(field(root, 'kUSDT'), '5');
  return { fx, root };
}
const feeShown = (root: Parameters<typeof elements>[0]) => elements(root).find(e => e.getAttribute('data-testid') === 'pool-fee')?.textContent ?? '';

describe('Daybreak [9]: the pool\'s opening is held to the network fee its screen shows', () => {
  it('the screen shows the fee; a node naming 20 times as much is refused before the merge is signed', async () => {
    const { fx, root } = await opening('d1');
    await until('the fee and the button', () => /^about /.test(feeShown(root)) && !button(root, 'Open the pool').disabled);
    fx.node.feerate = async () => 2_000;
    await click(button(root, 'Open the pool'));
    await until('the answer', () => /sompi a gram|Pool opened|Opening sent/.test(root.textContent), 20_000);
    expect(root.textContent).toMatch(/now asks 2000 sompi a gram for the network fee/);
    expect(fx.node.submitted).toEqual([]);
  });

  it('a feerate that rises after the merge: the opening itself is not sent, and the message says the merge went out', async () => {
    const { fx, root } = await opening('d2');
    await until('the fee and the button', () => /^about /.test(feeShown(root)) && !button(root, 'Open the pool').disabled);
    fx.node.feerate = async () => (fx.node.submitted.length >= 1 ? 2_000 : 100);
    await click(button(root, 'Open the pool'));
    await until('the answer', () => /sompi a gram|Pool opened|Opening sent/.test(root.textContent), 20_000);
    expect(fx.node.submitted).toHaveLength(1); // the merge only
    expect(root.textContent).toMatch(/the opening was not sent/);
    expect(root.textContent).toMatch(/1 merge transaction went out first/);
  });

  it('at the fee shown it opens: the merge, then the opening', async () => {
    const { fx, root } = await opening('d3');
    await until('the fee and the button', () => /^about /.test(feeShown(root)) && !button(root, 'Open the pool').disabled);
    await click(button(root, 'Open the pool'));
    await until('the answer', () => /sompi a gram|Pool opened|Opening sent|Nothing was sent|not sent/.test(root.textContent), 20_000);
    expect(fx.node.submitted).toHaveLength(2);
    expect(lastBuilt.command).toBe('pool-init');
  });
});
