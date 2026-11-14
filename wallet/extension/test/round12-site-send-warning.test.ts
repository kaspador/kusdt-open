// Round 12, R12-WW-6: a site's kusdt_send to an ECDSA address (kaspa:qyp...) was approved with no warning, though the
// Send screen warns about the same address. No wallet here spends kUSDT from an ECDSA owner, so the approval window
// must say what the Send screen says, and keep its own warning for a script address.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, fakeWindow, mount, until } from './fake-dom';
import { BOB, SCRIPT_ADDRESS, fixture, noNetwork, resetStores, type Fixture } from './screen-fixture';
import { NET } from './helpers';
import { encodeKaspaAddress } from '@kusdt/kaspa';
import { OWNER_P2PKH_ECDSA, OWNER_P2SH, ownerOfAddress, ownerWarningOf, siteSendWarningOf } from '@/kusdt/owner';
import { session } from '@/lib/storage';
import { REQUEST_KEY, type PendingRequest } from '@/provider/protocol';
import { Approve } from '@/screens/Approve';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

/** An ECDSA address: version 1, a 33-byte compressed key. */
const ECDSA = encodeKaspaAddress(NET.prefix, 1, Uint8Array.from([2, ...new Uint8Array(32).fill(9)]));

beforeEach(async () => {
  await resetStores();
  vi.stubGlobal('fetch', noNetwork);
  vi.stubGlobal('chrome', { tabs: { sendMessage: (_t: number, _m: unknown, cb?: () => void) => cb?.() }, runtime: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function windowFor(fx: Fixture, to: string) {
  h.wallet = fx.wallet;
  const id = 'window-r12ww6';
  const params = { method: 'kusdt_send', to, amount: '5000000' } as PendingRequest['params'];
  await session.set({ [REQUEST_KEY]: { id, method: params.method, params, origin: 'https://page.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest });
  fakeWindow.location.hash = `#request=${id}`;
  const { root } = await mount(createElement(Approve));
  await until('the request to be prepared', () => root.textContent.includes('Network fee') && button(root, 'Approve'));
  return root;
}

describe('a site asks to send kUSDT', () => {
  it('to an ECDSA address: the approval window warns as the Send screen does', async () => {
    expect(ownerOfAddress(ECDSA, NET.prefix).ownerScheme).toBe(OWNER_P2PKH_ECDSA);
    const root = await windowFor(fixture('c6a'), ECDSA);
    expect(root.textContent).toContain(ECDSA);
    expect(root.textContent).toContain('This is an ECDSA address.');
    expect(root.textContent).toContain(ownerWarningOf(ownerOfAddress(ECDSA, NET.prefix))!);
  });

  it('to a script address: the window keeps its own warning', async () => {
    expect(ownerOfAddress(SCRIPT_ADDRESS, NET.prefix).ownerScheme).toBe(OWNER_P2SH);
    const root = await windowFor(fixture('c6b'), SCRIPT_ADDRESS);
    expect(root.textContent).toContain('This is a script address, not a wallet.');
  });

  it('to an ordinary address: no warning', async () => {
    const root = await windowFor(fixture('c6c'), BOB);
    expect(root.textContent).not.toMatch(/ECDSA|script address/);
    expect(siteSendWarningOf(ownerOfAddress(BOB, NET.prefix))).toBeNull();
  });
});
