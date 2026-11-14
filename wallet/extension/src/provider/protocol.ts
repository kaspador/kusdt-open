// window.kusdt (SPEC §14): what pages may ask, and the rules for answering.
//
//   page (inpage.ts) ⇄ content script (content.ts) ⇄ background (background/provider.ts)
//
// The page names an action; the wallet builds the transaction itself, shows
// it in its own window and signs only after the user approves. The page never
// sees a key and can't ask for a raw signature.
//
// Rules (routeRequest):
//   kaspa_getNetwork       answered to any page (public, like eth_chainId)
//   kaspa_requestAccounts  answered at once to a connected site; otherwise the
//                          user approves the site in the wallet's window
//   kaspa_switchNetwork    connected sites only: the wallet's network already
//                          answers at once; a preset with nothing deployed is
//                          refused (4200); any other the user approves in the
//                          wallet's window, and the site stays connected there
//   kusdt_getBalances      connected sites only, no prompt
//   kusdt_send, kusdt_redeem, kusdt_swap, kusdt_addLiquidity,
//   kusdt_removeLiquidity  connected sites only, and every one is approved
//                          by the user in the wallet's window
// Connections are per Kaspa network: a site connected on testnet-10 is not
// connected on mainnet. One approval window at a time; a site whose prompts
// are declined three times in two minutes waits a minute.

import { isEvmAddressStrict } from '@/keys/derive';

export type ProviderMethod =
  | 'kaspa_requestAccounts' | 'kaspa_getNetwork' | 'kaspa_switchNetwork' | 'kusdt_getBalances'
  | 'kusdt_send' | 'kusdt_redeem' | 'kusdt_swap' | 'kusdt_addLiquidity' | 'kusdt_removeLiquidity';

export const SIGNING_METHODS: ReadonlySet<ProviderMethod> = new Set(['kusdt_send', 'kusdt_redeem', 'kusdt_swap', 'kusdt_addLiquidity', 'kusdt_removeLiquidity']);
const METHODS: ReadonlySet<string> = new Set(['kaspa_requestAccounts', 'kaspa_getNetwork', 'kaspa_switchNetwork', 'kusdt_getBalances', ...SIGNING_METHODS]);

/** The wallet's built-in presets: the only networks a site may ask it to switch to. */
export const SWITCHABLE_NETWORKS = ['testnet-10', 'mainnet', 'simnet'] as const;
export type SwitchableNetwork = (typeof SWITCHABLE_NETWORKS)[number];
const isSwitchable = (v: unknown): v is SwitchableNetwork => typeof v === 'string' && (SWITCHABLE_NETWORKS as readonly string[]).includes(v);

export type ProviderParams =
  | { method: 'kaspa_requestAccounts' | 'kaspa_getNetwork' | 'kusdt_getBalances' }
  | { method: 'kaspa_switchNetwork'; network: SwitchableNetwork }
  | { method: 'kusdt_send'; to: string; amount: string }
  | { method: 'kusdt_redeem'; chain: 'ethereum' | 'bsc'; address: string; amount: string }
  | { method: 'kusdt_swap'; side: 'buy' | 'sell'; amountIn: string; minOut: string }
  | { method: 'kusdt_addLiquidity'; kasIn: string; tokensIn: string }
  | { method: 'kusdt_removeLiquidity'; position: string };

export interface ProviderRequest { id: string; method: ProviderMethod; params: ProviderParams }

/** EIP-1193 error codes. */
export const ERR = { rejected: 4001, unauthorized: 4100, unsupported: 4200, disconnected: 4900, invalid: -32602, internal: -32603, busy: -32002 } as const;
/** `data.locked`: refused because the wallet is locked, not because the site is not connected (since run 21). */
export interface ProviderError { code: number; message: string; data?: { locked: true } }

export const MAX_AMOUNT = 10n ** 18n;

/** A positive integer amount, as a decimal string or a safe integer. Null for anything else. */
export function cleanAmount(v: unknown): string | null {
  let s: string;
  if (typeof v === 'number') { if (!Number.isSafeInteger(v)) return null; s = String(v); }
  else if (typeof v === 'string') s = v.trim();
  else return null;
  if (!/^[1-9][0-9]{0,18}$/.test(s)) return null;
  return BigInt(s) <= MAX_AMOUNT ? s : null;
}

const KASPA_ADDRESS_SHAPE = /^(kaspa|kaspatest|kaspasim):[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{61,63}$/;
const OUTPOINT = /^[0-9a-f]{64}:\d{1,5}$/;

/** Checks a request from a page. Anything unexpected is refused, never repaired. */
export function parseRequest(msg: unknown): ProviderRequest | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof m.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(m.id)) return null;
  if (typeof m.method !== 'string' || !METHODS.has(m.method)) return null;
  const id = m.id, method = m.method as ProviderMethod;
  const p = (Array.isArray(m.params) ? m.params[0] : m.params) as Record<string, unknown> | undefined;
  const q = p && typeof p === 'object' ? p : {};
  switch (method) {
    case 'kaspa_requestAccounts': case 'kaspa_getNetwork': case 'kusdt_getBalances':
      return { id, method, params: { method } };
    case 'kaspa_switchNetwork': {
      if (!isSwitchable(q.network)) return null;
      return { id, method, params: { method, network: q.network } };
    }
    case 'kusdt_send': {
      const amount = cleanAmount(q.amount);
      if (!amount || typeof q.to !== 'string' || !KASPA_ADDRESS_SHAPE.test(q.to.trim())) return null;
      return { id, method, params: { method, to: q.to.trim(), amount } };
    }
    case 'kusdt_redeem': {
      const amount = cleanAmount(q.amount);
      const chain = q.chain === 'ethereum' || q.chain === 1 ? 'ethereum' : q.chain === 'bsc' || q.chain === 2 ? 'bsc' : null;
      if (!amount || !chain || typeof q.address !== 'string' || !isEvmAddressStrict(q.address) || /^0x0{40}$/.test(q.address)) return null;
      return { id, method, params: { method, chain, address: q.address, amount } };
    }
    case 'kusdt_swap': {
      const amountIn = cleanAmount(q.amountIn), minOut = cleanAmount(q.minOut);
      if (!amountIn || !minOut || (q.side !== 'buy' && q.side !== 'sell')) return null;
      return { id, method, params: { method, side: q.side, amountIn, minOut } };
    }
    case 'kusdt_addLiquidity': {
      const kasIn = cleanAmount(q.kasIn), tokensIn = cleanAmount(q.tokensIn);
      if (!kasIn || !tokensIn) return null;
      return { id, method, params: { method, kasIn, tokensIn } };
    }
    case 'kusdt_removeLiquidity': {
      if (typeof q.position !== 'string' || !OUTPOINT.test(q.position)) return null;
      return { id, method, params: { method, position: q.position } };
    }
  }
}

/**
 * Why a request parseRequest refused is invalid, in words a developer can act
 * on (the answer is always -32602).
 */
export function invalidReason(msg: unknown): string {
  const method = (msg as { method?: unknown } | null)?.method;
  if (method === 'kaspa_switchNetwork') return `kaspa_switchNetwork takes { network }: one of the wallet's presets, ${SWITCHABLE_NETWORKS.map(n => `"${n}"`).join(', ')}.`;
  return 'kUSDT Wallet did not understand that request.';
}

export type Route =
  | { kind: 'answer' }            // answered at once by the background
  | { kind: 'approve-connect' }   // opens the window to approve the site
  | { kind: 'approve' }           // opens the window to approve this action
  | { kind: 'refuse'; error: ProviderError };

/** What the background does with a request, given whether the site is connected on the wallet's network. */
export function routeRequest(method: ProviderMethod, connected: boolean): Route {
  if (method === 'kaspa_getNetwork') return { kind: 'answer' };
  if (method === 'kaspa_requestAccounts') return connected ? { kind: 'answer' } : { kind: 'approve-connect' };
  if (!connected) return { kind: 'refuse', error: { code: ERR.unauthorized, message: 'Connect this site to kUSDT Wallet first (kaspa_requestAccounts).' } };
  if (method === 'kusdt_getBalances') return { kind: 'answer' };
  if (SIGNING_METHODS.has(method) || method === 'kaspa_switchNetwork') return { kind: 'approve' };
  return { kind: 'refuse', error: { code: ERR.unsupported, message: 'Unsupported method.' } };
}

/**
 * A connected site's kaspa_switchNetwork, given the wallet's network and
 * whether the target has a deployment (config/settings.ts networkLive): the
 * wallet's own network answers at once, with no window; a preset with nothing
 * deployed is refused (4200, the page shows these words); any other opens the
 * wallet's window for the user to approve.
 */
export function switchRoute(target: SwitchableNetwork, current: string, targetLive: boolean, targetName: string = target): Route {
  if (target === current) return { kind: 'answer' };
  if (!targetLive) return { kind: 'refuse', error: { code: ERR.unsupported, message: `Nothing is deployed on ${targetName} yet, so kUSDT Wallet can't switch to it.` } };
  return { kind: 'approve' };
}

/**
 * The origin of a message sender, if it is a web page's top frame the wallet may talk to. A page with an opaque
 * origin ("null": a sandboxed page, say user-supplied HTML served with CSP sandbox) is nobody's site, whatever
 * its URL says: it is never taken for the site at that URL.
 */
export function senderOrigin(sender: { id?: string; url?: string; origin?: string; tab?: unknown; frameId?: number }, extensionId: string): string | null {
  if (sender.id !== extensionId || !sender.tab || (sender.frameId != null && sender.frameId !== 0)) return null;
  let origin = sender.origin;
  if (origin === 'null') return null;
  if (!origin) { try { origin = new URL(sender.url ?? '').origin; } catch { return null; } }
  return /^https:\/\/[^/]+$/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null;
}

export interface Connection { origin: string; address: string; ownerHex: string; kasAddresses: string[]; at: number }

export const connectionsKey = (network: string) => `kusdt.connections.${network}`;
export const REQUEST_KEY = 'kusdt.provider.request';

/** The request the approval window is open for (chrome.storage.session). */
export interface PendingRequest extends ProviderRequest {
  origin: string; tabId: number; windowId?: number; at: number; network: string;
  /** Until when the window may act for it (requestExpired): `at` + REQUEST_MAX_MS. */
  expires: number;
  /** Set just before the window submits: from then on it may be on the network. */
  sending?: boolean;
}

/**
 * How long a site's request may wait for the user in the approval window (Daybreak [28]). Past it, the next site's
 * request takes its place (the first is answered 4001) and the window can no longer act for it, so a window left
 * open holds nobody for longer.
 */
export const REQUEST_MAX_MS = 5 * 60_000;

/** Whether a request is past its time; one dated more than REQUEST_MAX_MS ahead (the clock was set back since) is too. */
export const requestExpired = (p: Pick<PendingRequest, 'expires'>, now: number): boolean => now > p.expires || p.expires - now > REQUEST_MAX_MS;

// Declines: three within two minutes and the site waits a minute before its next prompt.
export const DECLINE_WINDOW_MS = 120_000, DECLINE_LIMIT = 3, COOLDOWN_MS = 60_000;
export type Declines = Record<string, { at: number[]; until: number }>;

/**
 * The key a tab's declines are counted under, beside its origin's (run 20, PUB20-2): a page that moves to a new name of
 * its own after each decline (n0.evil.example, n1.evil.example) in the same tab waits its minute all the same, as the
 * queue cap of R14-CL-1 counts a tab's places. Origins are "https://..." keys, so the two never meet.
 */
export const tabDeclineKey = (tabId: number) => `tab:${tabId}`;

// A decline counts while it is under two minutes old and not dated ahead of the clock (one set back since).
const recent = (t: number, now: number) => t <= now && now - t < DECLINE_WINDOW_MS;

/** The declines after one more decision on a request from `origin` (in tab `tabId`): counted for both, an approval clears both. */
export function nextDeclines(all: Declines, origin: string, approved: boolean, now: number, tabId?: number): Declines {
  const keys = tabId == null ? [origin] : [origin, tabDeclineKey(tabId)];
  // What is over is dropped, so the names a page moves through do not pile up in session storage.
  const out: Declines = {};
  for (const [k, d] of Object.entries(all)) if (d.at.some(t => recent(t, now)) || cooldownOf(all, k, now) > 0) out[k] = d;
  for (const key of keys) {
    if (approved) { delete out[key]; continue; }
    const d = { at: (out[key]?.at ?? []).filter(t => recent(t, now)), until: out[key]?.until ?? 0 };
    d.at.push(now);
    if (d.at.length >= DECLINE_LIMIT) { d.until = now + COOLDOWN_MS; d.at = []; }
    out[key] = d;
  }
  return out;
}

/** How long `key` (an origin, or a tab's tabDeclineKey) still waits. A hold ending more than a minute from now (the clock was set back since) holds nothing. */
export const cooldownOf = (all: Declines, key: string, now: number): number => {
  const left = (all[key]?.until ?? 0) - now;
  return left > 0 && left <= COOLDOWN_MS ? left : 0;
};

/** Message kinds between the parts. */
export const MSG_REQUEST = 'kusdt-provider';
export const MSG_ANSWER = 'kusdt-provider-answer';
export const MSG_EVENT = 'kusdt-provider-event';
/** From the content script as its page goes away: `{ ids }`, the requests it was still waiting for. */
export const MSG_GONE = 'kusdt-provider-gone';
