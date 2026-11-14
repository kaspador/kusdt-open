// Submitting core-built transactions, waiting for their outputs, and learning
// what became of one that raced others for a coin (the pool's).

import { MaybeSent, NoAnswer, NodeRejected } from '../kaspa/node';
import { inputsOf, markSpent } from './pending';
import { noteBuilt } from './known';
import { p2shAddressOf } from './verify';
import { addressForScript, hexToBytes, nodeHasTransaction } from '@kusdt/kaspa';
import type { Built, CoreUtxo, Ctx } from './types';

/**
 * Submits the transaction exactly as the core wrote it. The node must answer
 * with the id the core computed. A resubmission the node already has counts
 * as sent. Its inputs are kept out of selection from now on. No answer at all
 * is not a failure: the node may have it, so its inputs are kept out too and
 * MaybeSent says so, with the id (`merge`: a merge before a send).
 */
export async function submitBuilt(ctx: Ctx, built: Built, merge = false): Promise<string> {
  let txid: string;
  try { txid = await ctx.node.submit(built.transaction); }
  catch (e) {
    if (e instanceof NodeRejected && nodeHasTransaction(e.said, built.txid)) txid = built.txid;
    else if (e instanceof NoAnswer) {
      await markSpent(ctx.network, inputsOf(built.transaction)).catch(() => {});
      await noteBuilt(ctx, built, false).catch(() => {});
      throw new MaybeSent(built.txid, merge);
    }
    else throw e;
  }
  if (txid !== built.txid) throw new Error(`The node reports transaction ${txid}, the wallet built ${built.txid}.`);
  await markSpent(ctx.network, inputsOf(built.transaction));
  // The kUSDT states this transaction makes for the wallet's own key go into its record (kusdt/known.ts), so that
  // they are looked for on the node also when the coordinator cannot list them; the ones it spends leave it.
  await noteBuilt(ctx, built, true).catch(() => {});
  return txid;
}

/** The address an output script pays (P2PK or P2SH). */
export function addressOfSpk(spkHex: string, prefix: string): string {
  if (/^0000aa20[0-9a-f]{64}87$/.test(spkHex)) return p2shAddressOf(spkHex, prefix);
  const a = addressForScript({ version: parseInt(spkHex.slice(0, 4), 16), script: hexToBytes(spkHex.slice(4)) }, prefix);
  if (!a) throw new Error('An output has no address.');
  return a;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Waits until output `index` of a submitted transaction is in the node's UTXO
 * set, and answers it as the node reports it.
 */
export async function waitForOutput(ctx: Ctx, built: Built, index: number, timeoutMs = 90_000): Promise<CoreUtxo> {
  const o = built.outputs[index];
  if (!o) throw new Error('No such output.');
  const address = addressOfSpk(o.scriptPublicKey, ctx.net.prefix);
  const end = Date.now() + timeoutMs;
  for (;;) {
    const u = (await ctx.node.utxos([address]).catch(() => [])).find(x => x.transactionId === built.txid && x.index === index);
    if (u) {
      if (u.scriptPublicKey !== o.scriptPublicKey || u.amount !== o.value) throw new Error('The node reports a different output than the one built.');
      return { transactionId: u.transactionId, index: u.index, amount: u.amount, scriptPublicKey: u.scriptPublicKey, blockDaaScore: u.blockDaaScore, isCoinbase: false, covenantId: u.covenantId, confirmed: true };
    }
    if (Date.now() > end) throw new Error('The transaction was sent but has not been confirmed yet. Check again in a minute.');
    await sleep(1_000);
  }
}

/** How long the wallet waits to learn what became of a pool transaction, and how often it asks its node (tests shorten both). */
export const CONFIRM_WAIT = { ms: 30_000, everyMs: 1_000 };

/**
 * What became of a submitted transaction. `confirmed`: one of its outputs is in the node's UTXO set (accepted; as final
 * as any accepted transaction). `lost`: another transaction spent the coin it raced for, so it can never be accepted.
 * `unknown`: neither is shown yet.
 */
export type Outcome = 'confirmed' | 'lost' | 'unknown';

/**
 * The coin a transaction races others for (the pool UTXO it spends): its outpoint ("txid:index") and the address it
 * sits at. `seen`: the node has shown it in its UTXO set (at the build, or at a look since), and `daa` is the highest
 * virtual DAA score at which it did. A pool UTXO that was only in the mempool when it was built on is missing from the
 * UTXO set because it is not accepted yet, not because it was spent: until it has been seen there, its absence proves
 * nothing. Nor does its absence on a node that is behind the one that showed it (a new connection can be to another
 * node): only a look at a later DAA score counts.
 */
export interface Raced { outpoint: string; address: string; seen: boolean; daa: string }

/** The addresses a built transaction's outputs pay: where it shows once it is accepted. */
export const outputAddresses = (built: Pick<Built, 'outputs'>, prefix: string): string[] =>
  [...new Set(built.outputs.map(o => addressOfSpk(o.scriptPublicKey, prefix)))];

/**
 * One look at the node. The mempool is read first: a transaction that leaves it for a block between the two reads is
 * then in the UTXO set at the second. `gone` is the picture of a lost race: the raced coin is spent (by a transaction
 * that was accepted) and this one's outputs are nowhere. A UTXO read that fails says nothing.
 *
 * The mempool is asked for this transaction by its id (round 15, R15-CL-4): listed by address, the answer held every
 * transaction paying the wallet's own address, which anyone can fill past what a node answers, and every look was
 * then "unknown". A mempool read that fails is taken as "not seen there": what decides a lost race is the raced coin
 * spent at a later DAA with this transaction's outputs nowhere, on two looks in a row (awaitOutcome), and a transaction
 * still waiting leaves that coin unspent in the UTXO set, so it is never taken for lost by that.
 */
export async function lookAt(ctx: Pick<Ctx, 'node'>, txid: string, addresses: string[], raced: Raced): Promise<'confirmed' | 'gone' | 'unknown'> {
  let utxos: Awaited<ReturnType<Ctx['node']['utxos']>>, daa: bigint;
  const inMempool = await ctx.node.inMempool(txid).catch(() => false);
  try {
    utxos = await ctx.node.utxos([...new Set([...addresses, raced.address])]);
    daa = await ctx.node.virtualDaa();
  } catch { return 'unknown'; }
  if (utxos.some(u => u.transactionId === txid)) return 'confirmed';
  if (inMempool) return 'unknown';
  // The raced coin is still there: nobody has won it yet (this transaction may be on another node, or on its way).
  if (utxos.some(u => `${u.transactionId}:${u.index}` === raced.outpoint)) {
    raced.seen = true;
    if (daa > BigInt(raced.daa)) raced.daa = daa.toString();
    return 'unknown';
  }
  return raced.seen && daa > BigInt(raced.daa) ? 'gone' : 'unknown';
}

/**
 * Waits until the node shows what became of a submitted transaction that spends `raced`, for at most `wait.ms`.
 * A lost race is believed only when two looks in a row show it, so a node between two states is never taken at its
 * word. The caller frees what a lost transaction held; an unknown outcome is reported as sent, never as done.
 */
export async function awaitOutcome(ctx: Pick<Ctx, 'node' | 'net'>, built: Built, raced: Raced, wait = CONFIRM_WAIT): Promise<Outcome> {
  const addresses = outputAddresses(built, ctx.net.prefix);
  const end = Date.now() + wait.ms;
  let gone = 0;
  for (;;) {
    const seen = await lookAt(ctx, built.txid, addresses, raced);
    if (seen === 'confirmed') return 'confirmed';
    gone = seen === 'gone' ? gone + 1 : 0;
    if (gone >= 2) return 'lost';
    if (Date.now() >= end) return 'unknown';
    await sleep(wait.everyMs);
  }
}
