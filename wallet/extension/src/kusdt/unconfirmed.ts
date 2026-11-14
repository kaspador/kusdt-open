// Pool transactions the node took whose outcome the wallet had not seen when
// it stopped waiting (kusdt/submit.ts awaitOutcome answered `unknown`). They
// are looked at again whenever the wallet refreshes: one that confirmed is
// said to have, and one that lost the race for the pool gives back the coins
// and the kUSDT it held, at once instead of when their 10 minute mark runs out.

import { local } from '../lib/storage';
import { restoreSpent } from './known';
import { inputsOf, releaseSpent } from './pending';
import { lookAt, outputAddresses, type Raced } from './submit';
import type { Built, Ctx } from './types';

interface Waiting { txid: string; inputs: string[]; addresses: string[]; raced: Raced; at: number; gone: number }

const KEY = (network: string) => `kusdt.unconfirmed.${network}`;
/** After a day nothing is asked about any more: the marks ran out long before, and the pool has moved on. */
const KEEP_MS = 24 * 3_600_000;

const load = async (network: string): Promise<Waiting[]> => ((await local.get<Waiting[]>(KEY(network))) ?? []).filter(w => Date.now() - w.at < KEEP_MS);

/** Remembers a pool transaction that was sent and not seen confirmed. */
export async function noteUnconfirmed(ctx: Pick<Ctx, 'network' | 'net'>, built: Built, raced: Raced): Promise<void> {
  const list = (await load(ctx.network)).filter(w => w.txid !== built.txid);
  list.push({ txid: built.txid, inputs: inputsOf(built.transaction), addresses: outputAddresses(built, ctx.net.prefix), raced: { ...raced }, at: Date.now(), gone: 0 });
  await local.set({ [KEY(ctx.network)]: list.slice(-50) });
}

/** The transactions still waited for (their ids). */
export const unconfirmedTxids = async (network: string): Promise<string[]> => (await load(network)).map(w => w.txid);

/**
 * Looks at each waiting transaction once. Confirmed: no longer waited for. Lost (seen so on two looks in a row, as in
 * awaitOutcome): its inputs are freed for selection, and it is no longer waited for. Answers both lists.
 */
export async function settleUnconfirmed(ctx: Pick<Ctx, 'node' | 'network'>): Promise<{ confirmed: string[]; lost: string[] }> {
  const list = await load(ctx.network);
  const confirmed: string[] = [], lost: string[] = [], left: Waiting[] = [];
  for (const w of list) {
    const seen = await lookAt(ctx, w.txid, w.addresses, w.raced);
    // Confirmed: what it spent stays in the wallet's record, marked, until the node shows it spent (kusdt/known.ts, D4-1).
    if (seen === 'confirmed') { confirmed.push(w.txid); continue; }
    const gone = seen === 'gone' ? w.gone + 1 : 0;
    if (gone >= 2) { await releaseSpent(ctx.network, w.inputs); await restoreSpent(ctx.network, w.txid).catch(() => {}); lost.push(w.txid); continue; }
    left.push({ ...w, gone });
  }
  if (list.length) await local.set({ [KEY(ctx.network)]: left });
  return { confirmed, lost };
}
