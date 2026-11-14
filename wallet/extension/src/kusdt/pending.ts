// Outpoints the wallet's own submitted transactions spend, kept out of coin
// and state selection until the node has caught up (or 10 minutes pass), so
// two quick transactions never pick the same coin. A mark is taken off early
// only for a transaction the chain shows can never be accepted: a pool
// transaction that lost the race for the pool (kusdt/submit.ts awaitOutcome).

import { session } from '../lib/storage';

const KEY = (network: string) => `kusdt.pending.${network}`;
const TTL_MS = 10 * 60_000;

type Store = Record<string, number>; // outpoint → expiry

async function load(network: string): Promise<Store> {
  const s = (await session.get<Store>(KEY(network))) ?? {};
  const now = Date.now();
  for (const [k, t] of Object.entries(s)) if (t <= now) delete s[k];
  return s;
}

export async function markSpent(network: string, outpoints: string[]): Promise<void> {
  const s = await load(network);
  const until = Date.now() + TTL_MS;
  for (const o of outpoints) s[o] = until;
  await session.set({ [KEY(network)]: s });
}

/**
 * Lets `outpoints` be picked again. Only for the inputs of a transaction that is void for good. "Unspent on this node
 * and nothing in its mempool" is not proof of that (another node may hold the transaction), so nothing releases on it.
 */
export async function releaseSpent(network: string, outpoints: string[]): Promise<void> {
  const s = await load(network);
  for (const o of outpoints) delete s[o];
  await session.set({ [KEY(network)]: s });
}

export async function pendingSet(network: string): Promise<Set<string>> {
  return new Set(Object.keys(await load(network)));
}

/** The outpoints a core-built transaction spends, from its node JSON. */
export function inputsOf(transactionJson: string): string[] {
  const tx = JSON.parse(transactionJson) as { inputs?: { previousOutpoint?: { transactionId?: string; index?: number } }[] };
  return (tx.inputs ?? []).map(i => `${i.previousOutpoint?.transactionId}:${i.previousOutpoint?.index}`);
}
