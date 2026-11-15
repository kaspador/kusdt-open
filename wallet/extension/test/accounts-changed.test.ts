// The second review of the wallet: the handler and the broadcast answered the wallet's own address, and the
// accounts-changed event still sent whatever the stored connection named. A write to storage then told an open page
// "your account is <the attacker's address>", and the web app's deposit form filled it in.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session, local } from '@/lib/storage';
import { OWN_KEY } from '@/keys/session';
import { accountsChangedFor } from '@/background/provider';

const ORIGIN = 'https://app.example';
const own = { address: 'kaspatest:qmine', ownerHex: 'aa'.repeat(32), kasAddresses: ['kaspatest:qmine'] };
const conn = (address: string) => ({ [ORIGIN]: { origin: ORIGIN, address, ownerHex: 'aa'.repeat(32), kasAddresses: [address], at: 1 } });

afterEach(async () => { vi.unstubAllGlobals(); await session.remove(OWN_KEY); await local.remove('kusdt.settings'); });

async function events(before: any, after: any): Promise<unknown[]> {
  const sent: unknown[] = [];
  vi.stubGlobal('chrome', {
    runtime: { lastError: undefined },
    tabs: { query: (_q: unknown, cb: (t: unknown[]) => void) => cb([{ id: 7, url: `${ORIGIN}/#/bridge` }]), sendMessage: (_id: number, m: any, cb: () => void) => { sent.push(m.data); cb(); } },
  });
  // The wallet is on the testnet, where these connections are (a new install starts on DEFAULT_NETWORK).
  await local.set({ 'kusdt.settings': { network: 'testnet-10' } });
  await accountsChangedFor('testnet-10', before, after);
  return sent;
}

describe('the accounts-changed event', () => {
  it('never carries an address the stored connection names and the wallet does not have', async () => {
    await session.set({ [OWN_KEY]: { 'testnet-10': own } });
    // The address swapped in storage: the page is told it has no account, not the attacker's.
    expect(await events(conn('kaspatest:qmine'), conn('kaspatest:qattacker'))).toEqual([[]]);
    // A connection forged from nothing with another address: no event at all (nothing was connected, nothing is).
    expect(await events({}, conn('kaspatest:qattacker'))).toEqual([]);
    // The honest ones: connected, disconnected.
    expect(await events({}, conn('kaspatest:qmine'))).toEqual([['kaspatest:qmine']]);
    expect(await events(conn('kaspatest:qmine'), {})).toEqual([[]]);
  });

  it('a wallet not unlocked since the browser started vouches for no address', async () => {
    expect(await events({}, conn('kaspatest:qattacker'))).toEqual([]);
    expect(await events({}, conn('kaspatest:qmine'))).toEqual([]);
  });
});
