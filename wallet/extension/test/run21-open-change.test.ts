// Run 21 (after Daybreak [9]'s opening, bda1881): a sale, a deposit and a withdrawal are held to round 17's rule
// (R17-CL-1): change too small for the network to keep goes to the network fee, and more than 0.05 KAS of it is not
// paid unless the screen showed that fee (Max keeps FEE_KEEP for it and says so). The pool's opening was held to the
// feerate shown, not to that rule: an opening whose KAS left change of about 0.1 KAS paid it to the network unseen.
// Now it is held the same way, and its screen's Max says what it keeps for the fee. The wallet's real pool engine and
// core, and its real Pool screen; a fake node and coordinator.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, click, elements, field, mount, typeIn, until } from './fake-dom';
import { fixture, noNetwork, resetStores } from './screen-fixture';
import { COVENANT, FakeNode, POOL, devKey, fakeApi, kasCoin, lastBuilt, signerFor, testCtx } from './helpers';
import { p2shAddressOf, poolValue, scriptOf } from '@/kusdt/verify';
import { FEE_KEEP, POOL_WAIT, maxKasIn, openPool } from '@/kusdt/pool';
import { InsufficientKas, feeNeeded } from '@/kusdt/build';
import { plainState } from '@/kusdt/owner';
import { NavContext, type Nav } from '@/popup/nav';
import { PoolTab } from '@/screens/Pool';
import type { Built, PoolState } from '@/kusdt/types';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
/** The most of a transaction's change the wallet lets go to the network unasked (kusdt/build.ts ABSORB_LIMIT). */
const LIMIT = 5_000_000n;
const alice = devKey('run21-open-change');

beforeEach(async () => { await resetStores(); lastBuilt.txid = ''; vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const unopened = (admin: string): PoolState => ({ tokenCovid: COVENANT, kasReserve: 0n, tokenReserve: 0n, totalShares: 0n, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin, maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 0n, windowOut: 0n, paused: false, guardian: '22'.repeat(32) });

/** Lands what the core just built: its covenant outputs (the pool's and the position's under the pool's covenant) and its KAS change. */
function lander(node: FakeNode, address: string) {
  return () => {
    const v = lastBuilt.value;
    for (const o of v.outputs) {
      const p2sh = /^0000aa20[0-9a-f]{64}87$/.test(o.scriptPublicKey);
      node.utxoSet.push({ address: p2sh ? p2shAddressOf(o.scriptPublicKey, 'kaspasim') : address, transactionId: v.txid, index: o.index, amount: BigInt(o.value), scriptPublicKey: o.scriptPublicKey, blockDaaScore: 999_100n, isCoinbase: false, covenantId: !p2sh ? null : o.kind === 'pool' || o.kind === 'position' ? POOL : COVENANT });
    }
  };
}

let no = 0;
const uniq = (c: string) => (++no).toString(16).padStart(8, '0').padStart(64, c);

/** Alice, the pool's admin, opens it with `kasIn` and 1 kUSDT of a 3 kUSDT state, her KAS in one coin of 10 KAS. */
async function open(kasIn: bigint, acceptedFee?: bigint): Promise<{ sent: number; built?: Built; lost?: bigint; error?: any }> {
  const node = new FakeNode();
  let answer: any = null;
  const listed: any[] = [];
  const ctx = testCtx(node, fakeApi({ pool: async () => answer, tokens: async () => ({ states: listed }) }));
  const pool = unopened(alice.xonly), pspk = scriptOf(ctx, 'Pool', pool), ptx = uniq('f');
  node.utxoSet.push({ address: p2shAddressOf(pspk, 'kaspasim'), transactionId: ptx, index: 0, amount: poolValue(pool), scriptPublicKey: pspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: POOL });
  answer = { pool: { utxo: { transactionId: ptx, index: 0 }, state: pool }, reserve: null };
  const state = plainState({ ownerScheme: 0, owner: alice.xonly }, 3_000_000n), spk = scriptOf(ctx, 'KCC20', state), t = uniq('d');
  node.utxoSet.push({ address: p2shAddressOf(spk, 'kaspasim'), transactionId: t, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
  listed.push({ utxo: { transactionId: t, index: 0 }, state: { ...state, amount: '3000000' } });
  node.utxoSet.push(kasCoin(alice, uniq('e'), 10n * KAS));
  const land = lander(node, alice.address);
  node.submitImpl = async () => { land(); return lastBuilt.txid; };
  try {
    const r = await openPool(ctx, signerFor(alice), [alice.address], { kasIn, tokensIn: 1_000_000n, shownFeerate: 100, acceptedFee });
    return { sent: node.submitted.length, built: r.built, lost: r.built.fee - feeNeeded(r.built, 100) };
  } catch (error) {
    return { sent: node.submitted.length, error };
  }
}

describe('R17-CL-1 for the pool\'s opening: change the network does not keep is not paid unseen', () => {
  it('an opening that would give the network more than 0.05 KAS of change is not sent, and the fee is named; less change comes back', async () => {
    let refused = 0;
    for (let k = 600n; k <= 640n; k += 4n) {
      const r = await open(k * 1_000_000n);
      if (r.error instanceof InsufficientKas) continue;
      if (r.error) {
        expect(r.error.kind, `${k}: ${r.error.message}`).toBe('fee-takes-change');
        expect(r.error.lost).toBeGreaterThan(LIMIT);
        expect(r.error.message).toMatch(/^This would pay 0\.\d+ KAS to the network, not the about 0\.\d+ KAS shown: 0\.\d+ KAS of it is change too small for the network to keep\. Nothing was sent\./);
        expect(r.sent).toBe(0);
        refused++;
      } else {
        expect(r.lost, `an opening of ${k} hundredths of a KAS`).toBeLessThanOrEqual(LIMIT);
        expect(r.sent).toBe(1);
      }
    }
    expect(refused).toBeGreaterThan(0);
  });

  it('Max, whose screen says it keeps FEE_KEEP for the network fee, is sent with that fee', async () => {
    const ctx = { config: { tokenValue: '150000000', positionValue: '200000000' } } as Parameters<typeof maxKasIn>[0];
    const r = await open(maxKasIn(ctx, 'open', 10n * KAS), FEE_KEEP);
    expect(r.error).toBeUndefined();
    expect(r.sent).toBe(1);
    expect(r.built!.fee).toBeLessThanOrEqual(FEE_KEEP);
  });

  it('the Open the pool screen: Max shows the fee it keeps ("up to"), and the opening at Max goes through', async () => {
    let answer: any = null;
    const fx = fixture('a7', { tokens: [3_000_000n], api: { pool: async () => answer } });
    const pool = unopened(fx.wallet.signer.ownerHex), pspk = scriptOf(fx.ctx, 'Pool', pool), ptx = 'a7f'.padEnd(64, '0');
    fx.node.utxoSet.push({ address: p2shAddressOf(pspk, 'kaspasim'), transactionId: ptx, index: 0, amount: poolValue(pool), scriptPublicKey: pspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: POOL });
    answer = { pool: { utxo: { transactionId: ptx, index: 0 }, state: pool }, reserve: null };
    const land = lander(fx.node, fx.wallet.keys.main.address);
    fx.node.submitImpl = async () => { land(); return lastBuilt.txid; };
    h.wallet = fx.wallet;
    const nav: Nav = { tab: 'pool', setTab() {}, push() {}, back() {}, lock() {} };
    const { root } = await mount(createElement(NavContext.Provider, { value: nav }, createElement(PoolTab)));
    await until('the empty pool', () => root.textContent.includes('No liquidity yet'));
    await click(button(root, 'Open the pool'));
    await click(button(root, 'Max'));
    await typeIn(field(root, 'kUSDT'), '1');
    const fee = () => elements(root).find(e => e.getAttribute('data-testid') === 'pool-fee')?.textContent ?? '';
    await until('the fee Max keeps', () => /^up to 0\.3 KAS \(Max keeps it for the fee\)$/.test(fee()) && !button(root, 'Open the pool').disabled)
      .catch((e) => { throw new Error(`${e.message}. Fee shown: ${fee()}`); });
    await click(button(root, 'Open the pool'));
    await until('the answer', () => /Pool opened|Opening sent|Nothing was sent|not sent/.test(root.textContent), 20_000);
    expect(root.textContent).toMatch(/Pool opened|Opening sent/);
    expect(lastBuilt.command).toBe('pool-init');
  });
});
