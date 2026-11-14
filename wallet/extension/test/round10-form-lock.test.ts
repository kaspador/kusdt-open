// Round 10, finding 3: forms were not locked while an action ran. A deposit
// (approve, then deposit, 30 to 60 s) and a swap or a liquidity deposit (a
// merge, then the action) kept signing the click's values under a form that
// could be edited, and Done named the chain or side of the current render.
// Now the inputs are disabled while busy, the form is compared with the click
// before every signature, and Done names what was sent.
// Also finding 7's deposit quote race: an older quote arriving last.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, click, elements, field, findButton, flush, forceClick, mount, typeIn, until } from './fake-dom';
import { fixture, resetStores } from './screen-fixture';
import { COVENANT, FakeNode, POOL, devKey, fakeApi, kasCoin, lastBuilt, signerFor, testCtx } from './helpers';
import { fakeEvm } from './fake-evm';
import { EthRpc } from '@/evm/rpc';
import { deposit } from '@/evm/vault';
import { NodeRejected } from '@/kaspa/node';
import { minimumFor, quoteBuy, swap } from '@/kusdt/pool';
import { p2shAddressOf, poolValue, reserveStateOf, scriptOf } from '@/kusdt/verify';
import type { PoolState } from '@/kusdt/types';
import { FORM_CHANGED, FormChanged, guardedSigner, sameForm } from '@/lib/formLock';
import { NavContext, type Nav } from '@/popup/nav';
import { Bridge } from '@/screens/Bridge';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

const ETH = 'Ethereum (local)', BSC = 'BNB Chain (local)';
const nav: Nav = { tab: 'bridge', setTab() {}, push() {}, back() {}, lock() {} };

beforeEach(async () => { await resetStores(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the check before each signature', () => {
  it('compares what the form shows with what was clicked', () => {
    expect(sameForm({ chain: 'ethereum', amountText: '25' }, { chain: 'ethereum', amountText: '25' })).toBe(true);
    expect(sameForm({ chain: 'ethereum', amountText: '25' }, { chain: 'bsc', amountText: '25' })).toBe(false);
    expect(sameForm({ chain: 'ethereum', amountText: '25' }, { chain: 'ethereum', amountText: '250' })).toBe(false);
    expect(sameForm({ a: 1 } as Record<string, unknown>, { a: 1, b: 2 })).toBe(false);
  });

  it('hands out no key once the form has changed', () => {
    const alice = devKey('lock-alice');
    let unchanged = true;
    const signer = guardedSigner(signerFor(alice), () => unchanged);
    expect(signer.address).toBe(alice.address);
    expect(signer.ownerHex).toBe(alice.xonly);
    expect(signer.secretFor(alice.address)).toBe(alice.secret);
    unchanged = false;
    expect(() => signer.secretFor(alice.address)).toThrow(FormChanged);
    expect(() => signer.secretFor(alice.address)).toThrow(FORM_CHANGED);
  });

  it('stops a swap between its signatures: the second transaction is never built or sent', async () => {
    const alice = devKey('lock-alice');
    const KAS = 100_000_000n;
    const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 0n, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };
    const better: PoolState = { ...base, tokenReserve: base.tokenReserve + 450_000n };
    const node = new FakeNode();
    const answers: any[] = [null, null]; // eslint-disable-line @typescript-eslint/no-explicit-any
    let current = 0;
    const ctx = testCtx(node, fakeApi({ pool: async () => answers[current], tokens: async () => ({ states: [] }) }));
    const txids = ['71'.repeat(32), '72'.repeat(32)];
    const show = (i: number, pool: PoolState) => {
      current = i;
      node.utxoSet = node.utxoSet.filter(u => !txids.includes(u.transactionId));
      const pspk = scriptOf(ctx, 'Pool', pool), reserve = reserveStateOf(POOL, pool), rspk = scriptOf(ctx, 'KCC20', reserve);
      node.utxoSet.push(
        { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txids[i], index: 0, amount: poolValue(pool), scriptPublicKey: pspk, blockDaaScore: 999_990n, isCoinbase: false, covenantId: POOL },
        { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txids[i], index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT },
      );
      answers[i] = { pool: { utxo: { transactionId: txids[i], index: 0 }, state: pool }, reserve: { utxo: { transactionId: txids[i], index: 1 }, state: reserve } };
    };
    show(0, base);
    node.utxoSet.push(kasCoin(alice, 'e1'.repeat(32), 1_000n * KAS));
    // The pool moves under the first transaction, as in pool.test.ts: the wallet builds a second one on the new state.
    let unchanged = true;
    node.submitImpl = async () => {
      if (node.submitted.length === 1) { show(1, better); unchanged = false; throw new NodeRejected('transaction is a double spend'); }
      return lastBuilt.txid;
    };
    const kasIn = 10n * KAS, seen = quoteBuy(ctx, base, kasIn);
    const args = { side: 'buy' as const, amountIn: kasIn, minOut: minimumFor(seen, 100), quoted: seen };
    // The form changed while the first one was out: nothing more is signed.
    await expect(swap(ctx, guardedSigner(signerFor(alice), () => unchanged), [alice.address], args)).rejects.toBeInstanceOf(FormChanged);
    expect(node.submitted).toHaveLength(1);
  });

  it('stops a deposit between its approval and its deposit', async () => {
    const evm = fakeEvm();
    const rpc = new EthRpc(['http://one.test'], 31337, 'Test chain', 'ETH', evm.fetch);
    let signatures = 0;
    await expect(deposit({
      rpc, vault: '0x' + 'bb'.repeat(20), token: '0x' + 'aa'.repeat(20), decimals: 6, resetAllowanceFirst: true,
      from: '0x' + 'cc'.repeat(20), key: new Uint8Array(32).fill(7), units: 100_000_000n, ownerScheme: 0, ownerHex: 'dd'.repeat(32), minMinted: 0n,
      maxNetworkFee: 10n ** 18n,
      beforeSign: () => { if (++signatures === 2) throw new FormChanged(); },
    })).rejects.toThrow(FORM_CHANGED);
    expect(signatures).toBe(2);
    expect(evm.sent).toHaveLength(1);
  });
});

describe('the Deposit form', () => {
  /** The form with 25 USDT typed and everything read: the button can be pressed. */
  async function depositForm(evm: ReturnType<typeof fakeEvm>, tag: string) {
    vi.stubGlobal('fetch', evm.fetch);
    h.wallet = fixture(tag).wallet;
    const mounted = await mount(createElement(NavContext.Provider, { value: nav }, createElement(Bridge)));
    const root = mounted.root;
    await until('the Deposit form', () => findButton(root, 'Approve and deposit'));
    await typeIn(field(root, 'USDT to bridge'), '25');
    await until('the quote and the fee', () => !button(root, 'Approve and deposit').disabled);
    return mounted;
  }
  const sends = (evm: ReturnType<typeof fakeEvm>) => evm.asked.filter(a => a.method === 'eth_sendRawTransaction').length;

  it('shows the maximum network fee before anything is signed', async () => {
    const evm = fakeEvm();
    const { root } = await depositForm(evm, 'c1');
    // An approval (60 000 × 1.25) and the deposit's allowance (400 000) at 3 gwei, with half as much again.
    const shown = elements(root).find(e => e.getAttribute('data-testid') === 'deposit-fee-max')!;
    expect(shown.textContent).toBe('at most 0.002138 ETH');
    expect(root.textContent).toContain('Network fee');
    expect(evm.sent).toHaveLength(0);
  });

  it('is locked while the deposit runs, and a change that slips past the lock stops it before the next signature', async () => {
    const evm = fakeEvm();
    const { root } = await depositForm(evm, 'c2');
    const open = evm.holdSends();
    await click(button(root, 'Approve and deposit'));
    await until('the approval on its way', () => sends(evm) === 1);
    await until('Bridging', () => findButton(root, 'Bridging…'));
    expect(field(root, 'USDT to bridge').disabled).toBe(true);
    expect(button(root, 'Max').disabled).toBe(true);
    expect(button(root, ETH).disabled).toBe(true);
    expect(button(root, BSC).disabled).toBe(true);
    expect(button(root, /^USDT →/).disabled).toBe(true);
    expect(button(root, /→ USDT$/).disabled).toBe(true);
    const faucet = findButton(root, /test USDT$/);
    if (faucet) expect(faucet.disabled).toBe(true);
    // The chain changes all the same (the handler run past `disabled`): the deposit after the approval is not signed.
    await forceClick(button(root, BSC));
    open();
    await until('the refusal', () => root.textContent.includes(FORM_CHANGED));
    expect(evm.sent).toHaveLength(1);
    expect(root.textContent).not.toContain('Deposit sent');
  });

  it('stops signing when its screen is left', async () => {
    const evm = fakeEvm();
    const { root, unmount } = await depositForm(evm, 'c3');
    const open = evm.holdSends();
    await click(button(root, 'Approve and deposit'));
    await until('the approval on its way', () => sends(evm) === 1);
    unmount();
    open();
    await until('the approval mined', () => evm.asked.some(a => a.method === 'eth_getTransactionReceipt'));
    await flush(200);
    expect(evm.sent).toHaveLength(1);
  });

  it('says on Done what was sent, on the chain it was sent on', async () => {
    const evm = fakeEvm();
    const { root } = await depositForm(evm, 'c4');
    await click(button(root, 'Approve and deposit'));
    await until('Done', () => root.textContent.includes('Deposit sent'));
    expect(evm.sent).toHaveLength(2);
    expect(evm.sent.every(s => s.url.endsWith('8545'))).toBe(true);
    expect(root.textContent).toContain(`Deposit #7 on ${ETH}.`);
    expect(root.textContent).toContain('24.5');
  });

  it('never shows the quote of an amount typed before (an older answer arriving last)', async () => {
    // The vault's answer about 25 USDT takes 600 ms; the one about 50 USDT comes at once.
    let asked25 = false;
    const evm = fakeEvm({ quoteDelay: (units) => { if (units !== 25_000_000n) return 0; asked25 = true; return 600; } });
    vi.stubGlobal('fetch', evm.fetch);
    h.wallet = fixture('c5').wallet;
    const { root } = await mount(createElement(NavContext.Provider, { value: nav }, createElement(Bridge)));
    await until('the Deposit form', () => findButton(root, 'Approve and deposit'));
    const received = () => elements(root).find(e => e.getAttribute('aria-label') === 'You receive')!.textContent;
    await typeIn(field(root, 'USDT to bridge'), '25');
    await until('the first quote asked for', () => asked25);
    await typeIn(field(root, 'USDT to bridge'), '50');
    await until('the quote for 50', () => received().startsWith('49.5'));
    await new Promise(r => setTimeout(r, 800));
    await flush();
    expect(received().startsWith('49.5')).toBe(true);
    expect(root.textContent).not.toContain('24.5');
  });
});
