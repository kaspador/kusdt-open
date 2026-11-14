// Planning and building a Kaspa send: which coins to spend, the fee, and
// whether a change output is worth keeping. Same choices as the official
// wallet SDK (rusty-kaspa wallet/core tx/generator):
//
//   fee = fee rate × the transaction's largest mass dimension
//   change that would cost more in fee than it is worth is left to the fee
//
// Change goes back to the wallet's own receive address (see KASPA.md: one
// address per account keeps funds visible in every Kaspa wallet).

import {
  TX_VERSION, NATIVE_SUBNET, MAX_STANDARD_MASS, transactionMass, signInput,
  type KaspaTx, type KaspaUtxo, type TxMass,
} from './tx';
import type { ScriptPublicKey } from './address';

/** The node's minimum relay fee rate (rusty-kaspa 2.x: 100,000 sompi per 1,000 grams). */
export const MIN_FEERATE = 100;
/** A fee-estimate answer above this is treated as wrong and capped. */
export const MAX_FEERATE = 2_000;
/** One transaction can spend about 88 coins before hitting the mass limit; stay well under. */
export const MAX_INPUTS = 80;
/** Never leave more than this to the fee as unkept change; spend another coin instead. */
export const MAX_ABSORBED_CHANGE = 50_000_000n;   // 0.5 KAS
/** Hard ceiling on any fee this wallet will sign. */
export const MAX_FEE = 300_000_000n;              // 3 KAS
/** Coinbase coins can be spent 1,000 DAA scores (~100 s) after the block; keep a margin. */
export const COINBASE_MATURITY = 1_100n;

// Change below this is never kept (rusty-kaspa wallet's dust rule: 3 × the
// relay cost of a standard input + output, about 0.0006 KAS).
const DUST_CHANGE = 60_600n;

export function clampFeerate(rate: number | null | undefined): number {
  if (rate == null || !Number.isFinite(rate)) return MIN_FEERATE;
  // Whole sompi per gram: the node's estimates are fractions, and the covenant builders take integers.
  return Math.ceil(Math.min(MAX_FEERATE, Math.max(MIN_FEERATE, rate)));
}

export function feeForMass(m: TxMass, feerate: number): bigint {
  // Fee rates are whole sompi per gram in practice; ceil keeps a fractional one safe.
  return BigInt(Math.ceil(clampFeerate(feerate) * Number(m.feeMass)));
}

const massOk = (m: TxMass) => m.storage != null && m.compute <= MAX_STANDARD_MASS && m.storage <= MAX_STANDARD_MASS && m.transient <= MAX_STANDARD_MASS;

/** Coins that may be spent now: not already being spent, and mature if from a coinbase. */
export function spendableUtxos(utxos: KaspaUtxo[], opts: { virtualDaaScore: bigint | null; pending?: ReadonlySet<string> }): KaspaUtxo[] {
  return utxos.filter(u => {
    if (opts.pending?.has(`${u.txid}:${u.index}`)) return false;
    if (u.isCoinbase) return opts.virtualDaaScore != null && u.blockDaaScore + COINBASE_MATURITY <= opts.virtualDaaScore;
    return true;
  });
}

// Largest first: fewest inputs, lowest fee. Ties broken by outpoint so the plan is deterministic.
function largestFirst(utxos: KaspaUtxo[]): KaspaUtxo[] {
  return [...utxos].sort((a, b) =>
    a.amount === b.amount ? (a.txid === b.txid ? a.index - b.index : a.txid < b.txid ? -1 : 1) : a.amount > b.amount ? -1 : 1);
}

function shape(inputs: KaspaUtxo[], outputs: { amount: bigint; script: ScriptPublicKey }[]): KaspaTx {
  return {
    version: TX_VERSION,
    inputs: inputs.map(u => ({
      txid: u.txid, index: u.index, sequence: 0n, sigOpCount: 1, signatureScript: new Uint8Array(0),
      utxo: { amount: u.amount, script: u.script },
    })),
    outputs: outputs.map(o => ({ amount: o.amount, script: o.script })),
    lockTime: 0n, subnetworkId: NATIVE_SUBNET, gas: 0n, payload: new Uint8Array(0),
  };
}

export type PlanFailure = 'no-coins' | 'insufficient' | 'too-small' | 'too-many-coins';

export interface KaspaSendPlan {
  ok:          boolean;
  failure?:    PlanFailure;
  inputs:      KaspaUtxo[];
  amount:      bigint;      // reaches the recipient
  change:      bigint;      // back to the wallet (0 = no change output)
  fee:         bigint;      // everything else, including change too small to keep
  absorbed:    bigint;      // part of `fee` that is unkept change
  mass:        TxMass | null;
  shortfall:   bigint;      // when insufficient: how much more is needed
  leftover:    number;      // MAX only: coins left out because of the per-transaction limit
}

const fail = (failure: PlanFailure, extra: Partial<KaspaSendPlan> = {}): KaspaSendPlan =>
  ({ ok: false, failure, inputs: [], amount: 0n, change: 0n, fee: 0n, absorbed: 0n, mass: null, shortfall: 0n, leftover: 0, ...extra });

// Fee for a given set of coins and outputs. The fee depends on the output
// amounts (storage mass) and an output amount can depend on the fee, so
// settle it by iterating; it converges in two or three rounds.
function settle(inputs: KaspaUtxo[], outputs: { amount: bigint; script: ScriptPublicKey }[], adjust: number | null, feerate: number) {
  const total = inputs.reduce((s, u) => s + u.amount, 0n);
  const outs = outputs.map(o => ({ ...o }));
  const fixed = outs.reduce((s, o, i) => (i === adjust ? s : s + o.amount), 0n);
  let fee = 0n;
  for (let round = 0; round < 8; round++) {
    if (adjust != null) {
      const v = total - fixed - fee;
      if (v <= 0n) return null;
      outs[adjust].amount = v;
    }
    const mass = transactionMass(shape(inputs, outs));
    if (mass.storage == null) return null;
    const next = feeForMass(mass, feerate);
    if (next <= fee) return { outs, fee, mass: transactionMass(shape(inputs, outs)) };
    fee = next;
  }
  return null;
}

/**
 * Plan a payment of `amount` to `recipient`, or of everything (`sendMax`).
 * Pure: no network, no keys.
 */
export function planKaspaSend(args: {
  utxos: KaspaUtxo[];            // spendable coins (see spendableUtxos)
  recipient: ScriptPublicKey;
  change: ScriptPublicKey;
  amount: bigint;                // ignored with sendMax
  sendMax?: boolean;
  feerate: number;               // sompi per gram
}): KaspaSendPlan {
  const { recipient, change: changeScript, feerate } = args;
  const coins = largestFirst(args.utxos.filter(u => u.amount > 0n));
  if (coins.length === 0) return fail('no-coins');

  if (args.sendMax) {
    const inputs = coins.slice(0, MAX_INPUTS);
    const s = settle(inputs, [{ amount: 0n, script: recipient }], 0, feerate);
    if (!s) return fail('insufficient', { leftover: coins.length - inputs.length });
    if (!massOk(s.mass)) return fail('too-small', { leftover: coins.length - inputs.length });
    return {
      ok: true, inputs, amount: s.outs[0].amount, change: 0n, fee: s.fee, absorbed: 0n, mass: s.mass,
      shortfall: 0n, leftover: coins.length - inputs.length,
    };
  }

  const amount = args.amount;
  if (amount <= 0n) return fail('insufficient');
  const available = coins.reduce((s, u) => s + u.amount, 0n);
  let sawStorageLimit = false;
  let lastFee = 0n;

  for (let k = 1; k <= Math.min(coins.length, MAX_INPUTS); k++) {
    const inputs = coins.slice(0, k);
    const total  = inputs.reduce((s, u) => s + u.amount, 0n);
    if (total < amount) continue;

    // Without change: the recipient output alone; whatever is left over is fee.
    const nc = settle(inputs, [{ amount, script: recipient }], null, feerate);
    const ncOk = !!nc && massOk(nc.mass) && total - amount >= nc.fee;
    if (nc && nc.mass.storage != null && nc.mass.storage > MAX_STANDARD_MASS) sawStorageLimit = true;
    if (nc) lastFee = nc.fee;

    // With change back to the wallet.
    const wc = total - amount > DUST_CHANGE
      ? settle(inputs, [{ amount, script: recipient }, { amount: 0n, script: changeScript }], 1, feerate)
      : null;
    const wcOk = !!wc && massOk(wc.mass) && wc.outs[1].amount > DUST_CHANGE;

    // Keep change unless it costs more in extra fee than it is worth (the SDK's rule).
    if (wcOk && (!ncOk || wc!.fee - nc!.fee <= wc!.outs[1].amount)) {
      return { ok: true, inputs, amount, change: wc!.outs[1].amount, fee: wc!.fee, absorbed: 0n, mass: wc!.mass, shortfall: 0n, leftover: 0 };
    }
    if (ncOk) {
      const absorbed = total - amount - nc!.fee;
      if (absorbed <= MAX_ABSORBED_CHANGE) {
        return { ok: true, inputs, amount, change: 0n, fee: nc!.fee + absorbed, absorbed, mass: nc!.mass, shortfall: 0n, leftover: 0 };
      }
    }
    // Otherwise add the next coin: a larger total gives change worth keeping.
  }

  if (sawStorageLimit) return fail('too-small');
  if (coins.length > MAX_INPUTS && available >= amount) return fail('too-many-coins');
  const need = amount + (lastFee || BigInt(MIN_FEERATE) * 2_100n);
  return fail('insufficient', { shortfall: need > available ? need - available : 0n });
}

/** The unsigned transaction a plan describes. */
export function buildFromPlan(plan: KaspaSendPlan, recipient: ScriptPublicKey, changeScript: ScriptPublicKey): KaspaTx {
  if (!plan.ok) throw new Error('Nothing to build.');
  const outputs = [{ amount: plan.amount, script: recipient }];
  if (plan.change > 0n) outputs.push({ amount: plan.change, script: changeScript });
  const tx = shape(plan.inputs, outputs);
  checkTransaction(tx, plan);
  return tx;
}

/**
 * Last line of defence before signing: the transaction must pay exactly the
 * planned amount to the recipient, any change to the wallet, nothing else, and
 * a fee within bounds.
 */
export function checkTransaction(tx: KaspaTx, plan: KaspaSendPlan): void {
  const ins  = tx.inputs.reduce((s, i) => s + i.utxo.amount, 0n);
  const outs = tx.outputs.reduce((s, o) => s + o.amount, 0n);
  const fee  = ins - outs;
  if (tx.version !== TX_VERSION || tx.lockTime !== 0n || tx.gas !== 0n || tx.payload.length !== 0 || tx.subnetworkId.some(b => b !== 0)) {
    throw new Error('Unexpected transaction fields.');
  }
  if (tx.inputs.some(i => i.sigOpCount !== 1)) throw new Error('Unexpected signature count.');
  if (tx.outputs.length !== (plan.change > 0n ? 2 : 1)) throw new Error('Unexpected outputs.');
  if (tx.outputs[0].amount !== plan.amount) throw new Error('Recipient amount mismatch.');
  if (tx.outputs.some(o => o.amount <= 0n)) throw new Error('Zero-value output.');
  if (fee !== plan.fee || fee < 0n) throw new Error('Fee mismatch.');
  if (fee > MAX_FEE) throw new Error('Fee is above the safety limit; nothing was sent.');
  const m = transactionMass(tx);
  if (!massOk(m)) throw new Error('Transaction is larger than the network allows.');
  const minFee = BigInt(MIN_FEERATE) * (m.compute > m.transient ? m.compute : m.transient);
  if (fee < minFee) throw new Error('Fee is below the network minimum.');
}

/**
 * Sign every input. `keyFor` returns the private key for a coin's address;
 * every coin must belong to the wallet.
 */
export function signAll(tx: KaspaTx, plan: KaspaSendPlan, keyFor: (address: string) => Uint8Array | null): void {
  tx.inputs.forEach((_, i) => {
    const key = keyFor(plan.inputs[i].address);
    if (!key) throw new Error('A coin in this payment does not belong to this account.');
    try { signInput(tx, i, key); } finally { key.fill(0); }
  });
}
