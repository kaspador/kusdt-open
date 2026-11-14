// Run 21, Daybreak [21] (the part the wallet can bind): a window shows one network and built what it signs on
// whichever network the settings named when it asked. The approval window (and every screen) took its network once,
// to show it and to check a site's request against it, and then opened a new context from the settings for each
// action: a switch made meanwhile elsewhere (the popup, another site's approved switch) had a request shown as a test
// network's built and signed on mainnet's node, coordinator and contracts. A window now builds on the network it shows.
// (That a test network's node can show mainnet coins, the keys being the same, is the documented limit, unchanged.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core', () => ({ getCore: async () => ({}) }));
// The balances the provider reads at once: none here (no node in these tests).
vi.mock('@/wallet/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/wallet/context')>()),
  balancesOf: async () => ({ kas: 0n, kasSpendable: 0n, kusdt: null, rejected: 0, emptyStates: 0, emptyKas: 0n }),
}));
vi.mock('@/kaspa/kas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/kaspa/kas')>()),
  kasBalance: async () => ({ total: 0n, spendable: 0n, utxos: [] }),
}));

import { createElement } from 'react';
import { cleanup, mount, until } from './fake-dom';
import { hdFromMnemonic } from '@/keys/derive';
import { saveSettings } from '@/config/settings';
import { WalletProvider, useWallet, type Wallet } from '@/popup/state';

const noNetwork = async (): Promise<never> => { throw new Error('no network in the tests'); };
const HD = hdFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');

beforeEach(() => { vi.stubGlobal('fetch', noNetwork); });
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await saveSettings({ network: 'testnet-10' }); });

describe('Daybreak [21]: a window builds on the network it shows', () => {
  it('the context a window\'s action gets is its own network\'s, after the wallet switched elsewhere', async () => {
    await saveSettings({ network: 'simnet' });
    let shown: Wallet | null = null;
    const Probe = () => { shown = useWallet(); return createElement('span', null, shown.active.network); };
    await mount(createElement(WalletProvider, { hd: HD, children: createElement(Probe) }));
    await until('the wallet', () => shown !== null);
    expect(shown!.active.network).toBe('simnet');
    // Another window switches the wallet to Testnet 10; this one still shows (and checks requests against) simnet.
    await saveSettings({ network: 'testnet-10' });
    const ctx = await shown!.ctx();
    expect(ctx.network).toBe('simnet');
    expect(ctx.config).toBe(shown!.active.config);
    expect(ctx.net.prefix).toBe('kaspasim');
  });
});
