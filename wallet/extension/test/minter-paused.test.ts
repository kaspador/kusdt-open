// With minting on Kaspa paused a deposit goes into the vault and waits, so the
// wallet says so before it does: the same answer the web app's banner reads.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, flush, mount, until } from './fake-dom';
import { chainEntry, fixture, noNetwork, resetStores } from './screen-fixture';
import { minterPaused } from '@/kusdt/api';
import { NavContext, type Nav } from '@/popup/nav';
import { Bridge } from '@/screens/Bridge';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

const WARNING = 'Minting on Kaspa is paused by the guardian. New deposits wait until it is unpaused.';
const nav: Nav = { tab: 'bridge', setTab() {}, push() {}, back() {}, lock() {} };
const status = (paused: unknown) => ({ kaspa: { minter: { state: { paused } } }, chains: [chainEntry(1), chainEntry(2)] });

beforeEach(async () => { await resetStores(); vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The Deposit form, once it has asked the coordinator. */
async function deposit(answer: () => Promise<unknown>) {
  let asked = 0;
  const fx = fixture('g1', { api: { status: async () => { asked++; return answer(); } } });
  h.wallet = fx.wallet;
  const { root } = await mount(createElement(NavContext.Provider, { value: nav }, createElement(Bridge)));
  await until('the Deposit form', () => button(root, 'Approve and deposit'));
  await until('the coordinator', () => asked > 0);
  await flush();
  return root;
}

describe('a deposit while the minter is paused', () => {
  it('reads what the web app reads', () => {
    expect(minterPaused(status(true))).toBe(true);
    expect(minterPaused(status(false))).toBe(false);
    expect(minterPaused({ kaspa: { minter: { state: { paused: 'yes' } } } })).toBe(false);
    expect(minterPaused({ kaspa: {} })).toBe(false);
    expect(minterPaused(null)).toBe(false);
  });

  it('is warned about', async () => {
    const root = await deposit(async () => status(true));
    expect(root.textContent).toContain(WARNING);
    // A warning, not a refusal: the deposit can still go in, and waits.
    expect(root.textContent).not.toContain('The vault is paused');
  });

  it('is not warned about when the minter runs, or when the coordinator is out of reach', async () => {
    expect((await deposit(async () => status(false))).textContent).not.toContain(WARNING);
    cleanup();
    expect((await deposit(async () => { throw new Error('down'); })).textContent).not.toContain(WARNING);
  });
});
