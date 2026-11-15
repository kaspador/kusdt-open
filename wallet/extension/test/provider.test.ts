import { describe, expect, it } from 'vitest';
import {
  cleanAmount, cooldownOf, ERR, invalidReason, nextDeclines, parseRequest, REQUEST_KEY, routeRequest, senderOrigin, SIGNING_METHODS, switchRoute,
  type PendingRequest, type ProviderMethod,
} from '@/provider/protocol';
import { finishRequest } from '@/provider/answer';
import { session } from '@/lib/storage';
import { networkLive } from '@/config/settings';
import { DEFAULTS } from '@/config/defaults';

describe('kaspa_switchNetwork (as the page asks it: bridge/web/src/kaspa/provider.ts)', () => {
  const ID2 = 'switch-request-1';
  it('takes { network }, one of the three presets, as an object or the first of an array', () => {
    for (const network of ['testnet-10', 'mainnet', 'simnet'] as const) {
      expect(parseRequest({ id: ID2, method: 'kaspa_switchNetwork', params: { network } })?.params).toEqual({ method: 'kaspa_switchNetwork', network });
    }
    expect(parseRequest({ id: ID2, method: 'kaspa_switchNetwork', params: [{ network: 'simnet' }] })?.params).toEqual({ method: 'kaspa_switchNetwork', network: 'simnet' });
  });

  it('refuses malformed params and names that are not presets (-32602), in words that say what it takes', () => {
    for (const params of [{}, { network: 'testnet-11' }, { network: 'Testnet' }, { network: 10 }, { network: 'simnet ' }, null]) {
      expect(parseRequest({ id: ID2, method: 'kaspa_switchNetwork', params })).toBeNull();
    }
    expect(invalidReason({ method: 'kaspa_switchNetwork', params: { network: 'devnet' } })).toMatch(/"testnet-10", "mainnet", "simnet"/);
    expect(invalidReason({ method: 'eth_sign' })).toMatch(/did not understand/);
  });

  it("needs a site connected on the wallet's network (4100), then the approval window; it signs nothing", () => {
    expect(routeRequest('kaspa_switchNetwork', false)).toMatchObject({ kind: 'refuse', error: { code: ERR.unauthorized } });
    expect(routeRequest('kaspa_switchNetwork', true)).toEqual({ kind: 'approve' });
    expect(SIGNING_METHODS.has('kaspa_switchNetwork' as ProviderMethod)).toBe(false);
  });

  it("answers the wallet's own network at once; a preset with nothing deployed is 4200, in clear words; any other needs the user", () => {
    expect(switchRoute('testnet-10', 'testnet-10', true)).toEqual({ kind: 'answer' });
    expect(switchRoute('testnet-10', 'testnet-10', false)).toEqual({ kind: 'answer' });
    const r = switchRoute('mainnet', 'testnet-10', false, 'Mainnet');
    expect(r).toMatchObject({ kind: 'refuse', error: { code: ERR.unsupported } });
    expect(r.kind === 'refuse' && r.error.message).toBe("Nothing is deployed on Mainnet yet, so kUSDT Wallet can't switch to it.");
    expect(switchRoute('simnet', 'testnet-10', true)).toEqual({ kind: 'approve' });
    // The codes the page reads (switchFailureOf); -32602 only ever means "a wallet that can't switch".
    expect([ERR.unauthorized, ERR.rejected, ERR.unsupported, ERR.busy, ERR.invalid]).toEqual([4100, 4001, 4200, -32002, -32602]);
  });

  it("live means a pinned deployment: Testnet always, Mainnet once the build pins it, Local once the stack's is pinned", () => {
    expect(networkLive('testnet-10')).toBe(true);
    expect(networkLive('mainnet')).toBe(DEFAULTS.mainnet.covenantId !== '');
    expect(networkLive('simnet')).toBe(false);
    expect(networkLive('simnet', { simnet: { covenantId: 'ab'.repeat(32) } })).toBe(true);
  });
});

describe('answering from the approval window', () => {
  const base: PendingRequest = { id: 'switch-request-2', method: 'kaspa_switchNetwork', params: { method: 'kaspa_switchNetwork', network: 'simnet' }, origin: 'https://app.example', tabId: 7, at: 1, expires: 300_001, network: 'testnet-10' };

  it('lets the request go before the tab hears the answer, so a request sent right then finds no window waiting', async () => {
    await session.set({ [REQUEST_KEY]: base });
    const seen: unknown[] = [];
    const g = globalThis as { chrome?: unknown };
    const before = g.chrome;
    g.chrome = { tabs: { sendMessage: (_tab: number, msg: unknown) => { seen.push(msg, session.get(REQUEST_KEY)); } }, runtime: {} };
    try { await finishRequest(base, { result: 'simnet' }); } finally { g.chrome = before; }
    expect(seen[0]).toMatchObject({ id: base.id, body: { result: 'simnet' } });
    expect(await seen[1]).toBeUndefined();
  });

  it('leaves a newer request alone', async () => {
    await session.set({ [REQUEST_KEY]: { ...base, id: 'newer-request-3' } });
    await finishRequest(base, { error: { code: ERR.rejected, message: 'no' } });
    expect((await session.get<PendingRequest>(REQUEST_KEY))?.id).toBe('newer-request-3');
    await session.remove(REQUEST_KEY);
  });
});

const ID = 'abcdefgh1234';
const ADDR = 'kaspatest:qqd6e65yefepe9wk0m9vuxdufxd80sphy67gwwd0vdaumzdt4tc9ssxd5s7gn';

describe('provider permission rules (SPEC §14)', () => {
  it('kaspa_getNetwork is public', () => {
    expect(routeRequest('kaspa_getNetwork', false)).toEqual({ kind: 'answer' });
  });

  it('kaspa_requestAccounts asks the user once, then answers a connected site at once', () => {
    expect(routeRequest('kaspa_requestAccounts', false)).toEqual({ kind: 'approve-connect' });
    expect(routeRequest('kaspa_requestAccounts', true)).toEqual({ kind: 'answer' });
  });

  it('balances need a connection; no prompt', () => {
    expect(routeRequest('kusdt_getBalances', false)).toMatchObject({ kind: 'refuse', error: { code: ERR.unauthorized } });
    expect(routeRequest('kusdt_getBalances', true)).toEqual({ kind: 'answer' });
  });

  it('every signing method needs a connection AND an approval each time', () => {
    for (const m of SIGNING_METHODS) {
      expect(routeRequest(m, false)).toMatchObject({ kind: 'refuse', error: { code: ERR.unauthorized } });
      expect(routeRequest(m, true)).toEqual({ kind: 'approve' });
    }
    expect([...SIGNING_METHODS].sort()).toEqual(['kusdt_addLiquidity', 'kusdt_redeem', 'kusdt_removeLiquidity', 'kusdt_send', 'kusdt_swap'] satisfies ProviderMethod[]);
  });

  it('only top frames of HTTPS pages (and localhost) from this extension count, by the browser\'s origin', () => {
    const tab = { id: 1 };
    expect(senderOrigin({ id: 'ext', origin: 'https://app.example', tab, frameId: 0 }, 'ext')).toBe('https://app.example');
    expect(senderOrigin({ id: 'ext', url: 'http://localhost:5173/x', tab }, 'ext')).toBe('http://localhost:5173');
    expect(senderOrigin({ id: 'ext', origin: 'http://evil.example', tab }, 'ext')).toBeNull();
    expect(senderOrigin({ id: 'other', origin: 'https://app.example', tab }, 'ext')).toBeNull();
    expect(senderOrigin({ id: 'ext', origin: 'https://app.example' }, 'ext')).toBeNull();
    expect(senderOrigin({ id: 'ext', origin: 'https://app.example', tab, frameId: 3 }, 'ext')).toBeNull();
  });

  it('three declines in two minutes make a site wait a minute; an approval clears it', () => {
    let d = {};
    for (let i = 0; i < 2; i++) d = nextDeclines(d, 'https://a', false, 1_000 + i);
    expect(cooldownOf(d, 'https://a', 2_000)).toBe(0);
    d = nextDeclines(d, 'https://a', false, 3_000);
    expect(cooldownOf(d, 'https://a', 3_000)).toBe(60_000);
    expect(cooldownOf(d, 'https://b', 3_000)).toBe(0);
    d = nextDeclines(d, 'https://a', true, 4_000);
    expect(cooldownOf(d, 'https://a', 4_000)).toBe(0);
  });
});

describe('request parsing', () => {
  it('accepts well-formed requests, amounts as strings or safe integers', () => {
    expect(parseRequest({ id: ID, method: 'kusdt_send', params: { to: ADDR, amount: '1000000' } })?.params).toEqual({ method: 'kusdt_send', to: ADDR, amount: '1000000' });
    expect(parseRequest({ id: ID, method: 'kusdt_swap', params: [{ side: 'sell', amountIn: 5, minOut: '7' }] })?.params).toEqual({ method: 'kusdt_swap', side: 'sell', amountIn: '5', minOut: '7' });
    expect(parseRequest({ id: ID, method: 'kusdt_redeem', params: { chain: 2, address: '0x' + 'ab'.repeat(20), amount: '1' } })?.params).toMatchObject({ chain: 'bsc' });
    expect(parseRequest({ id: ID, method: 'kusdt_removeLiquidity', params: { position: 'ab'.repeat(32) + ':1' } })).not.toBeNull();
  });

  it('refuses anything unexpected rather than repairing it', () => {
    expect(parseRequest({ id: 'short', method: 'kaspa_getNetwork' })).toBeNull();
    expect(parseRequest({ id: ID, method: 'eth_sign', params: {} })).toBeNull();
    expect(parseRequest({ id: ID, method: 'kusdt_send', params: { to: ADDR, amount: '1.5' } })).toBeNull();
    expect(parseRequest({ id: ID, method: 'kusdt_send', params: { to: ADDR, amount: '0' } })).toBeNull();
    expect(parseRequest({ id: ID, method: 'kusdt_send', params: { to: 'kaspatest:xyz', amount: '1' } })).toBeNull();
    expect(parseRequest({ id: ID, method: 'kusdt_redeem', params: { chain: 'ethereum', address: '0x' + '00'.repeat(20), amount: '1' } })).toBeNull();
    expect(parseRequest({ id: ID, method: 'kusdt_redeem', params: { chain: 'polygon', address: '0x' + 'ab'.repeat(20), amount: '1' } })).toBeNull();
    expect(parseRequest({ id: ID, method: 'kusdt_swap', params: { side: 'both', amountIn: '1', minOut: '1' } })).toBeNull();
    expect(parseRequest({ id: ID, method: 'kusdt_swap', params: { side: 'buy', amountIn: '1' } })).toBeNull();
  });

  it('amounts: positive integers up to 10^18, unsafe numbers refused', () => {
    expect(cleanAmount('1000000000000000000')).toBe('1000000000000000000');
    expect(cleanAmount('1000000000000000001')).toBeNull();
    expect(cleanAmount(2 ** 53)).toBeNull();
    expect(cleanAmount('-5')).toBeNull();
    expect(cleanAmount('007')).toBeNull();
  });
});
