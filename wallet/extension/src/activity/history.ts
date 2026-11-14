// The wallet's activity, per network: what it sent itself (KAS, kUSDT, swaps,
// liquidity, redemptions, deposits) and what it saw arrive (new KAS coins and
// kUSDT states that none of its own transactions made). Kept locally; public
// data only. Amounts are decimal strings (sompi or base units).

import { MaybeSent } from '@/kaspa/node';
import { local } from '@/lib/storage';
import { TOKEN_SYMBOL } from '@/brand';

export type ActivityKind =
  | 'kas-send' | 'kas-receive' | 'kusdt-send' | 'kusdt-receive' | 'kusdt-merge'
  | 'swap-buy' | 'swap-sell' | 'lp-add' | 'lp-open' | 'lp-remove' | 'redeem' | 'deposit';

export interface Activity {
  id: string;
  kind: ActivityKind;
  at: number;
  /** Kaspa txid, or the EVM transaction hash for a deposit. */
  txid: string;
  kas?: string;
  kusdt?: string;
  counterparty?: string;
  fee?: string;
  /** Redemptions: chain and payout address; deposits: chain and nonce. */
  chain?: 'ethereum' | 'bsc';
  address?: string;
  outputIndex?: number;
  nonce?: string;
  /** The last status read from the coordinator. */
  status?: string;
  /** Deposits Kaspa skipped: the refund's status (`skipped`, `blocked` or `refunded`). */
  refund?: string;
  /** Redemptions: the payout transaction, once released. Deposits: the Kaspa mint. */
  doneTx?: string;
}

const KEY = (network: string) => `kusdt.activity.${network}`;
const SEEN_KEY = (network: string) => `kusdt.seen.${network}`;
const MAX = 300;

export async function listActivity(network: string): Promise<Activity[]> {
  return ((await local.get<Activity[]>(KEY(network))) ?? []).sort((a, b) => b.at - a.at);
}

export async function addActivity(network: string, a: Omit<Activity, 'id' | 'at'> & { at?: number }): Promise<Activity> {
  const list = await listActivity(network);
  const rec: Activity = { ...a, id: `${a.kind}:${a.txid}:${a.outputIndex ?? ''}`, at: a.at ?? Date.now() };
  const next = [rec, ...list.filter(x => x.id !== rec.id)].slice(0, MAX);
  await local.set({ [KEY(network)]: next });
  return rec;
}

export async function updateActivity(network: string, id: string, patch: Partial<Activity>): Promise<void> {
  const list = await listActivity(network);
  await local.set({ [KEY(network)]: list.map(x => (x.id === id ? { ...x, ...patch } : x)) });
}

/** The status of a transaction the node never answered about (MaybeSent). */
export const MAYBE_SENT = 'may-be-sent';
/**
 * A pool transaction (swap, liquidity) the node took and that was not seen accepted while the wallet waited; and one
 * that lost the race for the pool to another transaction, so nothing of it happened (kusdt/pool.ts sendToPool).
 */
export const UNCONFIRMED = 'unconfirmed';
export const LOST = 'lost';
/** What went out before an action stopped, when it needed merges first: only the user's own kUSDT, joined (Daybreak [9]). */
export const mergedFirst = (n: number): string =>
  `${n} merge transaction${n > 1 ? 's' : ''} went out first (in Activity): ${n > 1 ? 'they' : 'it'} only joined your ${TOKEN_SYMBOL} into fewer coins of yours, and that ${TOKEN_SYMBOL} is still yours.`;
/**
 * An action's error after `merged` merges went out first: "nothing was sent" is said of its own transaction (`what`:
 * "sale", "burn"), and what did go out is said. With no merge, the error as it is.
 */
export const afterMerges = (text: string, merged: number, what: string): string => (merged
  ? `${text.replace(/Nothing was sent/g, `The ${what} was not sent`).replace(/nothing was sent/g, `the ${what} was not sent`)} ${mergedFirst(merged)}`
  : text);

/** What a pool action's entry starts with: nothing once the node showed it accepted, else UNCONFIRMED. */
export const outcomeStatus = (confirmed: boolean): { status?: string } => (confirmed ? {} : { status: UNCONFIRMED });

/** What became of pool transactions that were still unconfirmed (kusdt/unconfirmed.ts): their entries say so. */
export async function markOutcomes(network: string, outcome: { confirmed: string[]; lost: string[] }): Promise<void> {
  if (outcome.confirmed.length + outcome.lost.length === 0) return;
  const done = new Set(outcome.confirmed), lost = new Set(outcome.lost);
  const list = await listActivity(network);
  await local.set({ [KEY(network)]: list.map(x => (x.status !== UNCONFIRMED ? x : lost.has(x.txid) ? { ...x, status: LOST } : done.has(x.txid) ? { ...x, status: undefined } : x)) });
}

/**
 * Runs a send. When it may have gone out with no answer from the node, `what`
 * goes in Activity under its txid (a merge before it, as the merge), so the
 * user can follow it; the error then goes on to say so.
 */
export async function followMaybeSent<T>(network: string, what: Omit<Activity, 'id' | 'at' | 'txid' | 'status'>, send: () => Promise<T>): Promise<T> {
  try { return await send(); }
  catch (e) {
    if (e instanceof MaybeSent) await addActivity(network, { ...(e.merge ? { kind: 'kusdt-merge' as const } : what), txid: e.txid, status: MAYBE_SENT }).catch(() => {});
    throw e;
  }
}

/**
 * Records what arrived: outpoints not seen before whose transaction is not one
 * of the wallet's own. The first look only learns what is there (no entries).
 */
export async function noteArrivals(network: string, kind: 'kas-receive' | 'kusdt-receive', items: { txid: string; index: number; amount: bigint }[]): Promise<void> {
  const seenAll = (await local.get<Record<string, string[]>>(SEEN_KEY(network))) ?? {};
  const first = !(kind in seenAll);
  const seen = new Set(seenAll[kind] ?? []);
  const own = new Set((await listActivity(network)).map(a => a.txid));
  const byTx = new Map<string, bigint>();
  for (const i of items) {
    const k = `${i.txid}:${i.index}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!first && !own.has(i.txid)) byTx.set(i.txid, (byTx.get(i.txid) ?? 0n) + i.amount);
  }
  for (const [txid, amount] of byTx) {
    await addActivity(network, kind === 'kas-receive' ? { kind, txid, kas: amount.toString() } : { kind, txid, kusdt: amount.toString() });
  }
  seenAll[kind] = [...seen].slice(-2_000);
  await local.set({ [SEEN_KEY(network)]: seenAll });
}
