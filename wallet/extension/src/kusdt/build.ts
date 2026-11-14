// Running the core's builders: choosing the KAS that pays for a covenant
// transaction, and checking what came back before it is submitted.
//
// The core signs as it builds (the keys go into the WebAssembly module and no
// further), so these checks run on a signed transaction that has not been
// submitted: if anything is off, it is dropped and nothing reaches the network.

import { CoreError } from '@kusdt/core/core';
import { rawJsonObject, scriptForAddress, bytesToHex } from '@kusdt/kaspa';
import { toBig, toNat } from '../lib/bigint';
import { pendingSet } from './pending';
import { scriptOf } from './verify';
import { MergeCoinsFirst, daaForCore, fundingCap, isSchnorrP2pk } from './inputs';
import type { Built, CoreUtxo, Ctx, Signer, TokenState } from './types';

/** Hard ceiling on any covenant transaction's fee the wallet submits. */
export const MAX_FEE = 300_000_000n; // 3 KAS
/** The core leaves change below 0.2 KAS to the fee (bridge/kaspa/src/tx.rs MIN_CHANGE). */
export const CORE_MIN_CHANGE = 20_000_000n;
/**
 * Unkept change above this: one more coin is added so the change can be kept, or within the input cap other coins
 * (R17-CL-1); and a pool transaction that would still leave more to the network is not sent unasked (pool.ts
 * assertChangeKept).
 */
export const ABSORB_LIMIT = 5_000_000n; // 0.05 KAS
/** How many other sets of coins are built when the input cap stops the coin that would keep the change (R17-CL-1). */
const CAP_TRIES = 4;
/** The core's fee went back and forth with every coin the wallet has in the build (R17-CL-1). */
const UNSETTLED = 'The network fee does not settle for this amount: what would come back as change is at the edge of what the network keeps. Change the amount a little and try again. Nothing was sent.';
/** Coinbase coins mature after 1,000 DAA; a margin on top. */
const COINBASE_MATURITY = 1_100n;

export interface FundingCoin { utxo: CoreUtxo; address: string }

/**
 * The fee a built transaction's size needs at `feerate`. What it pays above that is change the core could not keep
 * (under CORE_MIN_CHANGE) and left to the network.
 */
export const feeNeeded = (built: Pick<Built, 'mass'>, feerate: number): bigint => built.mass.feeMass * BigInt(Math.ceil(feerate));

/**
 * A coin as the core takes it. One the wallet found only in the mempool (`confirmed: false`) carries the node's mark
 * for it, UNACCEPTED_DAA_SCORE (kusdt/inputs.ts daaForCore): the pool's and the minter's scripts, which the core runs
 * as it builds, then judge it as the node will (rc.22 require_settled_inputs), and the pool claims no age on it.
 */
const coreUtxo = (u: CoreUtxo) => ({
  transactionId: u.transactionId, index: u.index, amount: u.amount, scriptPublicKey: u.scriptPublicKey,
  blockDaaScore: daaForCore(u), isCoinbase: u.isCoinbase, covenantId: u.covenantId,
});
export const toCoreUtxo = coreUtxo;

/**
 * Plain KAS coins the wallet may spend now, largest first: from the UTXO set only (never one still in the mempool),
 * and only plain Schnorr P2PK coins, the one kind of plain coin the core's builders fund with (rc.22).
 */
export async function kasCoins(ctx: Ctx, addresses: string[]): Promise<FundingCoin[]> {
  const [utxos, pending, inMempool] = await Promise.all([
    ctx.node.utxos(addresses), pendingSet(ctx.network), ctx.node.mempoolSpent(addresses).catch(() => new Set<string>()),
  ]);
  const needDaa = utxos.some(u => u.isCoinbase);
  const daa = needDaa ? await ctx.node.virtualDaa() : 0n;
  return utxos
    .filter(u => u.covenantId === null && isSchnorrP2pk(u.scriptPublicKey))
    .filter(u => !pending.has(`${u.transactionId}:${u.index}`) && !inMempool.has(`${u.transactionId}:${u.index}`))
    .filter(u => !u.isCoinbase || u.blockDaaScore + COINBASE_MATURITY <= daa)
    .sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1))
    .map(u => ({ address: u.address, utxo: { transactionId: u.transactionId, index: u.index, amount: u.amount, scriptPublicKey: u.scriptPublicKey, blockDaaScore: u.blockDaaScore, isCoinbase: u.isCoinbase, covenantId: null, confirmed: true } }));
}

/** Parses a core answer into a Built, keeping the raw transaction text. */
export function parseBuilt(value: any, raw: string): Built {
  if (!value || typeof value.txid !== 'string' || !Array.isArray(value.outputs)) throw new Error('The core gave an unexpected answer.');
  return {
    txid: value.txid,
    fee: toNat(value.fee, 'fee'),
    mass: { compute: toBig(value.mass.compute), storage: toBig(value.mass.storage), transient: toBig(value.mass.transient), feeMass: toBig(value.mass.feeMass) },
    covenantId: value.covenantId,
    outputs: value.outputs.map((o: any) => ({ ...o, value: toNat(o.value, 'output value') })),
    raw,
    transaction: rawJsonObject(raw, 'transaction'),
  };
}

export class InsufficientKas extends Error {}

/**
 * Builds with the fewest of `coins` that pay for it. `request(funding)` makes
 * the core request; `need` is the KAS the transaction takes beyond its own
 * covenant inputs (new state values, KAS paid in), before the fee.
 *
 * A pool transaction has at most MAX_TX_INPUTS inputs, its own covenant coins
 * among them (rc.22, kusdt/inputs.ts fundingCap): it takes no more funding coins
 * than fit. When those are not enough and all of the wallet's coins would be,
 * MergeCoinsFirst says so, before the core is asked for a transaction it refuses.
 * When they are enough but leave change too small to keep, other coins within the
 * cap are tried, and then MergeCoinsFirst says so too (R17-CL-1). `pinned`: coins
 * (`txid:index`) that trying other coins must keep (one a lost try spent).
 */
export function buildFunded(ctx: Ctx, signer: Signer, coins: FundingCoin[], command: string, need: bigint,
  request: (funding: { utxo: ReturnType<typeof coreUtxo>; secretKey: string }[], feerate: number) => object, feerate: number,
  pinned?: ReadonlySet<string>): Built {
  feerate = Math.ceil(feerate); // whole sompi per gram: a node's estimate is a fraction when its mempool has a backlog, and the builders take integers
  // Only plain Schnorr P2PK coins fund a covenant transaction (kasCoins chooses no other; a caller's list is held to it too).
  coins = coins.filter(c => isSchnorrP2pk(c.utxo.scriptPublicKey));
  const cap = fundingCap(command) ?? coins.length;
  const most = Math.min(coins.length, cap);
  let n = 0, sum = 0n;
  const margin = 50_000_000n; // a first guess at the fee; the core settles the exact one
  while (n < most && sum < need + margin) sum += coins[n++].utxo.amount;
  if (n === 0 && need > 0n) throw new InsufficientKas('There is no KAS to pay for this transaction.');
  /** Why no coin can be added: too little KAS in all, or more coins than the transaction takes. */
  const tooFew = (): Error => {
    const all = coins.reduce((t, c) => t + c.utxo.amount, 0n);
    if (coins.length > cap && all > need) return new MergeCoinsFirst(cap, coins.length);
    return new InsufficientKas('Not enough KAS for this transaction and its network fee.');
  };
  let lastError: unknown = null;
  /** The core's build on `used`: 'more' when it asks for more funding, 'unsettled' when its fee goes back and forth. */
  const buildOn = (used: FundingCoin[]): Built | 'more' | 'unsettled' => {
    const funding = used.map(c => {
      const secretKey = signer.secretFor(c.address);
      if (!secretKey) throw new Error('A coin does not belong to this wallet.');
      return { utxo: coreUtxo(c.utxo), secretKey };
    });
    try {
      const { value, raw } = ctx.core.call(command, request(funding, feerate));
      return parseBuilt(value, raw);
    } catch (e) {
      lastError = e;
      const msg = e instanceof CoreError ? e.message : String((e as Error)?.message ?? e);
      if (/add funding/.test(msg)) return 'more';
      // bridge/kaspa/src/tx.rs finish(): with the change at the edge of what it keeps, its fee goes back and forth.
      if (/fee did not settle/.test(msg)) return 'unsettled';
      throw e instanceof CoreError ? new Error(msg.replace(/^[a-z-]+: /, '')) : e;
    } finally {
      for (const f of funding) f.secretKey = '';
    }
  };
  /** Change the core could not keep (under CORE_MIN_CHANGE once its storage is paid), left to the fee. */
  const absorbedOf = (built: Built) => built.fee - built.mass.feeMass * BigInt(feerate);
  /**
   * R17-CL-1: the cap, not the wallet, stops the coin that would let the change be kept (rc.21 added it). Other sets
   * of at most `most` coins are built: one coin of `used` swapped for an unused one, or left out, so that the change
   * is kept or no more than ABSORB_LIMIT is left over; `pinned` coins stay. A larger unused coin goes first (in the
   * largest-first order there is none; after a lost race, whose coins come first, there may be), then the sets that
   * leave about half of ABSORB_LIMIT over. At most CAP_TRIES builds, one per sum. None does: MergeCoinsFirst, which
   * says the change would be lost and that one coin keeps it. Nothing is paid away unasked.
   */
  const withinCap = (used: FundingCoin[], absorbed: bigint): Built => {
    const unused = coins.filter(c => !used.includes(c));
    const sets = new Map<bigint, FundingCoin[]>();
    const offer = (d: bigint, set: FundingCoin[]) => {
      const left = absorbed + d;
      if ((d > 0n || (left >= 0n && left <= ABSORB_LIMIT)) && !sets.has(d)) sets.set(d, set);
    };
    used.forEach((out, i) => {
      if (pinned?.has(`${out.utxo.transactionId}:${out.utxo.index}`)) return;
      const rest = used.filter((_, j) => j !== i);
      offer(-out.utxo.amount, rest);
      for (const into of unused) offer(into.utxo.amount - out.utxo.amount, [...rest, into]);
    });
    const half = ABSORB_LIMIT / 2n;
    const away = (d: bigint) => { const x = absorbed + d - half; return x < 0n ? -x : x; };
    const order = [...sets.keys()].sort((a, b) => (a > 0n || b > 0n ? (a > b ? -1 : a < b ? 1 : 0) : (away(a) < away(b) ? -1 : away(a) > away(b) ? 1 : 0)));
    for (const d of order.slice(0, CAP_TRIES)) {
      const built = buildOn(sets.get(d)!);
      if (typeof built === 'object' && absorbedOf(built) <= ABSORB_LIMIT && built.fee <= MAX_FEE) return built;
    }
    throw new MergeCoinsFirst(cap, coins.length, absorbed);
  };
  for (let tries = 0; tries < 12; tries++) {
    const used = coins.slice(0, n);
    const built = buildOn(used);
    if (built === 'more') {
      if (n < most) { n++; continue; }
      throw tooFew();
    }
    if (built === 'unsettled') {
      // One more coin makes the change large enough to keep (rc.22 stopped here in the core's words).
      if (n < most) { n++; continue; }
      // At the cap: about CORE_MIN_CHANGE is at stake, as the core's change is at its edge.
      if (coins.length > most) return withinCap(used, CORE_MIN_CHANGE);
      throw new Error(UNSETTLED);
    }
    const absorbed = absorbedOf(built);
    if (absorbed > ABSORB_LIMIT && n < most) { n++; continue; }
    if (absorbed > ABSORB_LIMIT && coins.length > most) return withinCap(used, absorbed);
    if (built.fee > MAX_FEE) throw new Error('The network fee is above the wallet\'s safety limit. Nothing was sent.');
    return built;
  }
  throw lastError instanceof Error ? lastError : new Error('Could not build the transaction.');
}

/** "0000" + the P2PK script of an address. */
export function spkOfAddress(address: string, prefix: string): string {
  const s = scriptForAddress(address, prefix);
  return s.version.toString(16).padStart(4, '0') + bytesToHex(s.script);
}

const sameState = (a: any, b: TokenState) =>
  a && toBig(a.amount) === b.amount && a.owner === b.owner && a.ownerScheme === b.ownerScheme &&
  (a.borrowScheme ?? 0) === b.borrowScheme && a.borrowGuard === b.borrowGuard && a.extensionCommitment === b.extensionCommitment;

export interface Expect {
  /** Token outputs in order: their states and KAS values. */
  tokens: { index: number; state: TokenState; value: bigint }[];
  /** Other covenant outputs (pool, reserve, position) by index: the covenants check them; kinds must match. */
  covenant?: { index: number; kind: string }[];
  /** At least this much KAS must come back to the wallet's address as change. */
  minChange?: bigint;
}

/**
 * The last check before submitting: every token output is the state the user
 * approved (script recomputed by the core), every other plain output pays the
 * wallet's own address, and the fee is within bounds.
 */
export function checkBuilt(ctx: Ctx, built: Built, signer: Signer, expect: Expect): void {
  const mine = spkOfAddress(signer.address, ctx.net.prefix);
  const claimed = new Set<number>();
  for (const t of expect.tokens) {
    const o = built.outputs[t.index];
    if (!o || !o.token || !sameState(o.token, t.state)) throw new Error('The built transaction does not send what was approved. Nothing was sent.');
    if (o.value !== t.value) throw new Error('A token output carries an unexpected amount of KAS. Nothing was sent.');
    if (o.scriptPublicKey !== scriptOf(ctx, 'KCC20', t.state)) throw new Error('A token output has an unexpected script. Nothing was sent.');
    claimed.add(t.index);
  }
  for (const c of expect.covenant ?? []) {
    const o = built.outputs[c.index];
    if (!o || o.kind !== c.kind) throw new Error('The built transaction has unexpected outputs. Nothing was sent.');
    claimed.add(c.index);
  }
  let change = 0n;
  built.outputs.forEach((o, i) => {
    if (claimed.has(i)) return;
    if (o.scriptPublicKey !== mine) throw new Error('The built transaction pays an address it should not. Nothing was sent.');
    change += o.value;
  });
  if (expect.minChange != null && change < expect.minChange) throw new Error('Less KAS would come back than expected. Nothing was sent.');
  if (built.fee > MAX_FEE) throw new Error('The network fee is above the wallet\'s safety limit. Nothing was sent.');
}

export const isCoreError = (e: unknown): e is CoreError => e instanceof CoreError;
