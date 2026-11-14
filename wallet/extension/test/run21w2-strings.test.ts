// Run 21 round 2, R21-W2-5, after reviewer "wallet2"'s test of the same name: strings from servers the wallet does not
// trust were shown in its own windows as its own words. A coordinator's `error` (any length) was the approval window's
// error text, word for word, and an EVM RPC's refusal came back in the wallet's message; only GET /recipients' `reason`
// was cut (200 characters). Both can carry right-to-left override characters, which reorder how text reads. React
// escapes them, so no markup runs, but a coordinator or an RPC could put "SECURITY NOTICE from kUSDT Wallet: enter your
// recovery phrase" under the wallet's name in a window a site opened. Now a server's text is shown only as that
// server's: named, in quotes, cut to 200 characters, and without characters that change the direction text reads in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, fakeWindow, mount, until } from './fake-dom';
import { A, BOB, fixture, noNetwork, resetStores } from './screen-fixture';
import { CoordinatorClient } from '@/kusdt/api';
import { checkRecipientAnswer } from '@/kusdt/redeem';
import { signAndSend } from '@/evm/vault';
import { EthRpc, RpcError } from '@/evm/rpc';
import { session } from '@/lib/storage';
import { REQUEST_KEY, type PendingRequest } from '@/provider/protocol';
import { Approve } from '@/screens/Approve';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

const RLO = '‮', PDF = '‬', LRI = '⁦';
const PHISH = 'SECURITY NOTICE from kUSDT Wallet: this wallet must be verified before it can sign again. Open https://wallet-verify.example and enter your 24-word recovery phrase. '
  + `${RLO}elpmaxe.live${PDF} ${LRI}x` + 'x'.repeat(1_500);
/** No character that changes the direction text is shown in. */
const DIRECTION = /[؜‎‏‪-‮⁦-⁩]/;
/** The quoted part of a message: what is between its quotes. */
const quotedIn = (text: string) => (text.match(/"([^"]*)"/) ?? [])[1] ?? '';

beforeEach(async () => {
  await resetStores();
  vi.stubGlobal('fetch', noNetwork);
  vi.stubGlobal('chrome', { tabs: { sendMessage: (_t: number, _m: unknown, cb?: () => void) => cb?.() }, runtime: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('R21-W2-5: a server\'s text is shown as that server\'s, quoted, cut and without direction controls', () => {
  it('a coordinator\'s error in a site-opened approval window: named as the coordinator\'s, at most 200 of its characters', async () => {
    const fx = fixture('e1');
    fx.ctx.api = new CoordinatorClient('http://coordinator.example/api/v1', (async () => new Response(JSON.stringify({ error: PHISH }), { status: 503, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch);
    h.wallet = fx.wallet;
    const id = 'window-strings-1';
    const params = { method: 'kusdt_send', to: BOB, amount: '20000000' } as PendingRequest['params'];
    await session.set({ [REQUEST_KEY]: { id, method: params.method, params, origin: 'https://site.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest });
    fakeWindow.location.hash = `#request=${id}`;
    const { root } = await mount(createElement(Approve));
    await until('Reject', () => button(root, 'Reject'));
    await until('the error', () => root.textContent.includes('SECURITY NOTICE'), 10_000);
    const shown = root.textContent as string;
    expect(shown).not.toContain(PHISH);
    expect(shown).toMatch(/The coordinator answered HTTP 503: "SECURITY NOTICE from kUSDT Wallet/);
    expect(quotedIn(shown).length).toBeLessThanOrEqual(201);
    expect(shown).not.toMatch(DIRECTION);
  });

  it('an EVM RPC\'s refusal of a transaction: named as that chain\'s RPC\'s, quoted and cut', async () => {
    const rpc: any = { chainId: 1, name: 'Ethereum', assertChain: async () => {}, sendRaw: async () => { throw new RpcError(PHISH, -32000); }, knows: async () => false };
    const err = await signAndSend(rpc, { tx: { chainId: 1, nonce: 0, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 21_000n, to: '0x' + '11'.repeat(20), value: 0n, data: '0x' }, maxFee: 42_000n }, new Uint8Array(32).fill(7)).then(() => null, (e: Error) => e);
    const said = err?.message ?? '';
    expect(said).not.toContain(PHISH);
    expect(said).toMatch(/^Ethereum refused the transaction: its RPC said "SECURITY NOTICE/);
    expect(quotedIn(said).length).toBeLessThanOrEqual(201);
    expect(said).not.toMatch(DIRECTION);
  });

  it('an EVM RPC that answers only with an error: "Could not reach" names what an RPC said, quoted and cut', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: PHISH } }), { status: 200 })) as unknown as typeof fetch;
    const rpc = new EthRpc(['http://rpc.example'], 1, 'Ethereum', 'ETH', fetcher);
    const said = (await rpc.fees().then(() => null, (e: Error) => e))?.message ?? '';
    expect(said).not.toContain(PHISH);
    expect(said).toMatch(/Could not reach Ethereum \(an RPC said "SECURITY NOTICE/);
    expect(said).not.toMatch(DIRECTION);
  });

  it('the recipient check\'s reason: the coordinator\'s words, quoted, cut and without direction controls', () => {
    const r = checkRecipientAnswer({ chain: 1, address: A, payable: false, blocked: false, reason: PHISH }, 'ethereum', A, 'Ethereum');
    expect(r.problem).toMatch(/The Ethereum vault won't pay this address \(the bridge server says "SECURITY NOTICE/);
    expect(quotedIn(r.problem ?? '').length).toBeLessThanOrEqual(201);
    expect(r.problem).not.toMatch(DIRECTION);
  });
});
