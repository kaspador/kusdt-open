// kUSDT: the wallet's verified states, sends, merges and redemptions.
//
// A KCC-20 transfer takes 1 to 3 token inputs and makes 1 to 3 token outputs
// (bridge/kaspa/src/tx.rs). A send that needs more than 3 of the wallet's
// states first merges them (transfers to itself), 3 into 1 at a time, each
// merge confirmed before the next transaction spends its output.

import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@kusdt/kaspa';
import { buildFunded, checkBuilt, feeNeeded, InsufficientKas, kasCoins, toCoreUtxo, type FundingCoin } from './build';
import { fmtKas, fmtUsdt, quoted } from '../lib/format';
import { NodeRejected } from '../kaspa/node';
import { knownRecord, updateKnown } from './known';
import { pendingSet } from './pending';
import { submitBuilt, waitForOutput } from './submit';
import { MAX_LISTED, verifyTokenStates } from './verify';
import type { ApiLocated } from './api';
import { OWNER_P2SH, plainState, type Owner, type TokenState } from './owner';
import type { Built, Ctx, Located, Signer } from './types';

export const MAX_TOKEN_INPUTS = 3;
export const MAX_TOKEN_OUTPUTS = 3;

export interface Tokens {
  /** The wallet's spendable kUSDT states, each found on the node (kusdt/verify.ts), largest first. */
  states: Located<TokenState>[];
  /** What `states` hold: the balance. */
  total: bigint;
  rejected: number;
  /**
   * States the node could not show or deny, because it could not list their address (round 12, R12-WW-1), by the
   * wallet's own record or the coordinator's, largest first. Not in `states` or `total`, and spent only when the
   * user says so (planSend's `unchecked`).
   */
  unread: Located<TokenState>[];
  /** What `unread` hold by their records. */
  unreadTotal: bigint;
  /** Such states with no record to build on: counted, nothing else. */
  unreadNoRecord: number;
  /**
   * The coordinator did not answer for this owner, so only the states the wallet already knew of were looked for:
   * what was received since is missing until it answers. `apiError` is what the coordinator's failure said.
   */
  fromMemory: boolean;
  apiError?: string;
}

const largestFirst = <T extends { state: { amount: bigint } }>(a: T, b: T) => (a.state.amount === b.state.amount ? 0 : a.state.amount > b.state.amount ? -1 : 1);

/**
 * The wallet's kUSDT. The coordinator's list and the wallet's own record (kusdt/known.ts) say where to look; the
 * node says what is there. When the coordinator can't answer (an owner's list cannot be read while one of their
 * states sits at an address too full to list), the record alone is looked for, and the answer says so.
 */
export async function loadTokens(ctx: Ctx, signer: Signer): Promise<Tokens> {
  if (!ctx.api) throw new Error('No coordinator API is set for this network.');
  // With what the wallet's own transactions spent, looked for only to see it come back (kusdt/known.ts).
  const known = await knownRecord(ctx.network, signer.ownerHex).catch(() => []);
  let listed: ApiLocated[] = [], listedApart: ApiLocated[] = [], fromMemory = false, apiError: string | undefined;
  try { const answer = await ctx.api.tokens(signer.ownerHex); listed = answer.states; listedApart = Array.isArray(answer.unread) ? answer.unread : []; }
  catch (e) { if (!known.some(k => k.spentBy === undefined)) throw e; fromMemory = true; apiError = (e as Error)?.message || 'no answer'; }
  // The coordinator's records at an address it cannot read (round 13, R13-CL-1) are looked for like any it lists: where
  // the node cannot show them either, they are handed back apart as not checked, from the coordinator's record. An
  // answer with such records is not a full list, so it ages no record of the wallet's own.
  const { verified, rejected, unread, unreadNoRecord, missing } = await verifyTokenStates(ctx, [...listed, ...listedApart], signer.ownerHex, known, !fromMemory && listedApart.length === 0 && listed.length < MAX_LISTED);
  await updateKnown(ctx.network, signer.ownerHex, verified.map(s => ({ txid: s.utxo.transactionId, index: s.utxo.index, amount: s.state.amount, kas: s.utxo.amount, daa: s.utxo.blockDaaScore })), missing).catch(() => {});
  const pending = await pendingSet(ctx.network);
  const free = (s: Located<TokenState>) => !pending.has(`${s.utxo.transactionId}:${s.utxo.index}`);
  const states = verified.filter(free).sort(largestFirst);
  const apart = unread.filter(free).sort(largestFirst);
  return {
    states, total: states.reduce((s, x) => s + x.state.amount, 0n), rejected,
    unread: apart, unreadTotal: apart.reduce((s, x) => s + x.state.amount, 0n), unreadNoRecord, fromMemory, ...(apiError !== undefined && { apiError }),
  };
}

/** The fewest states (largest first) that cover `amount`, and how many merges sending them needs. */
export function chooseStates<T extends { state: { amount: bigint } }>(states: T[], amount: bigint): { picked: T[]; merges: number } {
  if (amount <= 0n) throw new Error('Enter an amount above zero.');
  const sorted = [...states].sort((a, b) => (a.state.amount === b.state.amount ? 0 : a.state.amount > b.state.amount ? -1 : 1));
  const picked: T[] = [];
  let sum = 0n;
  for (const s of sorted) {
    if (sum >= amount) break;
    picked.push(s);
    sum += s.state.amount;
  }
  if (sum < amount) throw new Error('Not enough kUSDT.');
  return { picked, merges: mergesFor(picked.length) };
}

/** Merge transactions (3 → 1 each) needed to bring `n` states down to at most 3. */
export const mergesFor = (n: number): number => (n <= MAX_TOKEN_INPUTS ? 0 : Math.ceil((n - MAX_TOKEN_INPUTS) / (MAX_TOKEN_INPUTS - 1)));

// ── Burn owners (SPEC §9) ──────────────────────────────────────────────────

const TAG = new TextEncoder().encode('kUSDT/redeem/v1');

/** R(chain, address) = 6a ‖ 0f ‖ "kUSDT/redeem/v1" ‖ 01 ‖ chain ‖ 14 ‖ address[20]. */
export function burnScript(chain: number, address20: string): Uint8Array {
  const a = hexToBytes(address20);
  if (a.length !== 20) throw new Error('An EVM address has 20 bytes.');
  return Uint8Array.from([0x6a, TAG.length, ...TAG, 0x01, chain, 0x14, ...a]);
}

/** The burn owner computed here; must equal the core's (burnOwner checks both). */
export const burnOwnerLocal = (chain: number, address20: string): string => bytesToHex(blake2b(burnScript(chain, address20), { dkLen: 32 }));

/** The redemption payload the core writes: "KUSDT" ‖ 01 ‖ count ‖ (index ‖ chain ‖ address)*. */
export function redeemPayload(entries: { outputIndex: number; chain: number; address: string }[]): string {
  const out = [...new TextEncoder().encode('KUSDT'), 0x01, entries.length];
  for (const e of entries) out.push(e.outputIndex, e.chain, ...hexToBytes(e.address));
  return bytesToHex(Uint8Array.from(out));
}

/** 0x-prefixed EVM address → 20-byte lowercase hex. */
export const evmHex = (address: string): string => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('That is not an EVM address.');
  return address.slice(2).toLowerCase();
};

/** The p2sh owner that redeems to `address` on `chain` (1 Ethereum, 2 BNB Chain), from the core, checked. */
export function burnOwner(ctx: Pick<Ctx, 'core'>, chain: 1 | 2, address: string): Owner {
  const hex = evmHex(address);
  if (/^0{40}$/.test(hex)) throw new Error('Redeeming to the zero address is refused.');
  const r = ctx.core.call<{ ownerScheme: number; owner: string; script: string }>('burn-owner', { chain, address: hex }).value;
  if (r.ownerScheme !== OWNER_P2SH || r.owner !== burnOwnerLocal(chain, hex) || r.script !== bytesToHex(burnScript(chain, hex))) {
    throw new Error('The burn owner does not match SPEC §9. Nothing was built.');
  }
  return { ownerScheme: OWNER_P2SH, owner: r.owner };
}

// ── Transfers ───────────────────────────────────────────────────────────────

export interface TransferArgs {
  inputs: Located<TokenState>[];
  outputs: { state: TokenState; value: bigint }[];
  redeem?: { outputIndex: number; chain: number; address: string }[];
}

/** Builds (and signs) one KCC-20 transfer, checked against what it should do. */
export function buildTransfer(ctx: Ctx, signer: Signer, coins: FundingCoin[], args: TransferArgs, feerate: number): Built {
  if (args.inputs.length < 1 || args.inputs.length > MAX_TOKEN_INPUTS || args.outputs.length < 1 || args.outputs.length > MAX_TOKEN_OUTPUTS) {
    throw new Error('A kUSDT transfer has 1 to 3 inputs and 1 to 3 outputs.');
  }
  const inTotal = args.inputs.reduce((s, i) => s + i.state.amount, 0n);
  const outTotal = args.outputs.reduce((s, o) => s + o.state.amount, 0n);
  if (inTotal !== outTotal) throw new Error('Token inputs and outputs must hold the same amount.');
  const secret = signer.secretFor(signer.address);
  if (!secret) throw new Error('The wallet is locked.');
  const kasIn = args.inputs.reduce((s, i) => s + i.utxo.amount, 0n);
  const kasOut = args.outputs.reduce((s, o) => s + o.value, 0n);
  const built = buildFunded(ctx, signer, coins, 'transfer', kasOut - kasIn, (funding, feerate) => ({
    network: ctx.network, feerate, changeAddress: signer.address, funding,
    inputs: args.inputs.map(i => ({ utxo: toCoreUtxo(i.utxo), state: i.state, secretKey: secret })),
    outputs: args.outputs,
    redeem: args.redeem ?? [],
  }), feerate);
  checkBuilt(ctx, built, signer, { tokens: args.outputs.map((o, index) => ({ index, state: o.state, value: o.value })) });
  return built;
}

export interface SendPlan {
  to: Owner;
  amount: bigint;
  picked: Located<TokenState>[];
  merges: number;
  /** The final transfer, built now when no merge comes first. */
  built: Built | null;
  /** KAS (sompi) the recipient's new token state carries: for a redemption, the burn's (config burnValue, gone for good). */
  tokenValue: bigint;
  /** KAS (sompi) a change token carries (config tokenValue). */
  changeValue: bigint;
  /** KAS kept in the wallet's change token (0 when it all goes). */
  keptInToken: bigint;
  redeem?: { chain: 1 | 2; address: string };
  /**
   * The wallet holds no KAS to pay the network fee with, and all of the kUSDT goes: the fee is taken out of the KAS
   * that travels with the tokens, so `tokenValue` is what the states held less the fee, not the usual token value.
   */
  feeFromTokenKas?: boolean;
  /**
   * kUSDT among `picked` that the node could not show (its address cannot be listed): spent from a record, at the
   * user's word. 0 in every other plan. The node refuses the transaction unless those states are there as recorded.
   */
  unchecked: bigint;
}

/** The kUSDT among `inputs` that the node could not show. */
export const uncheckedIn = (inputs: Located<TokenState>[]): bigint => inputs.reduce((s, i) => (i.utxo.unchecked ? s + i.state.amount : s), 0n);

/**
 * States for `amount` when the user has said to use the ones the node could not show: those first (they are what
 * this is for: once spent, what they held sits at new addresses), largest first, then checked ones as far as needed.
 */
export function chooseUncheckedFirst<T extends { state: { amount: bigint } }>(unread: T[], states: T[], amount: bigint): { picked: T[]; merges: number } {
  if (amount <= 0n) throw new Error('Enter an amount above zero.');
  const picked: T[] = [];
  let sum = 0n;
  for (const s of [...[...unread].sort(largestFirst), ...[...states].sort(largestFirst)]) {
    if (sum >= amount) break;
    picked.push(s);
    sum += s.state.amount;
  }
  if (sum < amount) throw new Error('Not enough kUSDT.');
  return { picked, merges: mergesFor(picked.length) };
}

/**
 * A send would put kUSDT of the wallet's own back at an address its node cannot list: it would be the wallet's, and
 * out of its balance again.
 */
export class LandsUnlisted extends Error {
  constructor(readonly amount: bigint) {
    super(`This would leave ${fmtUsdt(amount)} kUSDT of yours at an address the Kaspa node cannot list (it holds too many coins), where this wallet could not check it again. Change the amount a little, so that what you keep or send to yourself is another amount. Nothing was sent.`);
  }
}

/**
 * The least KAS the wallet lets a recipient's kUSDT carry when the fee comes out of it: enough for them to send all
 * of it on, or to redeem all of it (a burn's 0.3 KAS, 0.2 KAS of change and the fee), with no other coin.
 */
export const MIN_CARRIED = 60_000_000n; // 0.6 KAS

/**
 * A part of the wallet's kUSDT can't be sent (or redeemed) because the wallet lacks the KAS for it: what it keeps
 * goes into a token coin of its own, which holds KAS of its own. `all`: the kUSDT of the states this would spend;
 * sending or redeeming exactly that makes no second coin. `short`: about how much KAS is missing.
 */
export class PartNeedsKas extends InsufficientKas {
  constructor(readonly redeem: boolean, readonly all: bigint, readonly short: bigint, changeValue: bigint) {
    super(`${redeem ? 'Redeeming' : 'Sending'} a part of your kUSDT needs KAS this wallet does not have: the kUSDT you keep goes into a coin of its own, which must hold ${fmtKas(changeValue)} KAS (it stays yours), and the network fee comes on top. You can ${redeem ? 'redeem' : 'send'} all ${fmtUsdt(all)} kUSDT instead, which needs no other KAS, or get about ${fmtKas(short, 2)} KAS first. Nothing was sent.`);
  }
}

export async function walletCoins(ctx: Ctx, addresses: string[]): Promise<FundingCoin[]> {
  return kasCoins(ctx, addresses);
}

function transferArgsFor(plan: Pick<SendPlan, 'to' | 'amount' | 'redeem' | 'tokenValue' | 'changeValue'>, inputs: Located<TokenState>[], signer: Signer): TransferArgs {
  const sum = inputs.reduce((s, i) => s + i.state.amount, 0n);
  const outputs = [{ state: plainState(plan.to, plan.amount), value: plan.tokenValue }];
  if (sum > plan.amount) outputs.push({ state: plainState({ ownerScheme: 0, owner: signer.ownerHex }, sum - plan.amount), value: plan.changeValue });
  const redeem = plan.redeem ? [{ outputIndex: 0, chain: plan.redeem.chain, address: evmHex(plan.redeem.address) }] : undefined;
  return { inputs, outputs, redeem };
}

/**
 * Sends all of `inputs` to the plan's recipient with the network fee taken out of the KAS the states hold: one
 * output, carrying what they held less the fee the transaction's size needs, and no plain coin of the wallet's. The
 * size, and so the fee, moves a little with the value carried, so it is built until the two agree.
 */
function buildCarried(ctx: Ctx, signer: Signer, plan: Pick<SendPlan, 'to' | 'amount'>, inputs: Located<TokenState>[], feerate: number): { built: Built; value: bigint } | null {
  const held = inputs.reduce((s, i) => s + i.utxo.amount, 0n);
  const state = plainState(plan.to, plan.amount);
  // Half of it builds if anything does, and its size gives a first fee.
  let value = held / 2n;
  for (let i = 0; i < 5; i++) {
    let built: Built;
    try { built = buildTransfer(ctx, signer, [], { inputs, outputs: [{ state, value }] }, feerate); }
    catch (e) { if (e instanceof InsufficientKas) return null; throw e; }
    const next = held - feeNeeded(built, feerate);
    if (next === value) return built.fee === held - value && built.outputs.length === 1 ? { built, value } : null;
    if (next <= 0n) return null;
    value = next;
  }
  return null;
}

/**
 * Builds a plan's final transfer on `inputs`. When the wallet's KAS does not pay for it: a part is refused with the
 * reason and the way out (PartNeedsKas); all of it, in a plain send, goes with the fee taken out of the KAS under the
 * tokens (the plan then says so, and names what the recipient's tokens carry), unless that would leave them under
 * MIN_CARRIED.
 */
function buildPlanned(ctx: Ctx, signer: Signer, coins: FundingCoin[], plan: SendPlan, inputs: Located<TokenState>[], feerate: number): Built {
  const args = transferArgsFor(plan, inputs, signer);
  try { return buildTransfer(ctx, signer, coins, args, feerate); }
  catch (e) {
    if (!(e instanceof InsufficientKas)) throw e;
    const sum = inputs.reduce((s, i) => s + i.state.amount, 0n);
    if (sum > plan.amount) {
      const out = args.outputs.reduce((s, o) => s + o.value, 0n), held = inputs.reduce((s, i) => s + i.utxo.amount, 0n), have = coins.reduce((s, c) => s + c.utxo.amount, 0n);
      // What the outputs hold above what the inputs and the wallet's coins do, and a little for the fee.
      const short = out - held - have + 5_000_000n;
      throw new PartNeedsKas(!!plan.redeem, sum, short > 5_000_000n ? short : 5_000_000n, plan.changeValue);
    }
    if (plan.redeem) throw e;
    const carried = buildCarried(ctx, signer, plan, inputs, feerate);
    if (!carried) throw e;
    if (carried.value < MIN_CARRIED) {
      throw new InsufficientKas(`This wallet holds no KAS to pay the network fee, and the ${fmtKas(inputs.reduce((s, i) => s + i.utxo.amount, 0n))} KAS under your kUSDT is too little to take it from: the recipient's kUSDT would be left with ${fmtKas(carried.value, 4)} KAS, under the ${fmtKas(MIN_CARRIED)} KAS it needs to be moved again. Get a little KAS first. Nothing was sent.`);
    }
    plan.tokenValue = carried.value;
    plan.feeFromTokenKas = true;
    return carried.built;
  }
}

/**
 * Plans sending `amount` to `to` (or redeeming it: `redeem`). When no merge is
 * needed the final transaction is built now, so its exact fee can be shown.
 *
 * `unchecked`: the user's word to spend states the node could not show (Tokens.unread), which are otherwise never
 * chosen. The transaction is built on their records. A record that is wrong in any field (the state, its outpoint,
 * the KAS it carries, its covenant) makes a transaction the node refuses: every output is still built here from
 * what the user approved, and a signature commits to the spent output's script and amount.
 */
export async function planSend(ctx: Ctx, signer: Signer, kasAddresses: string[], args: { to: Owner; amount: bigint; redeem?: { chain: 1 | 2; address: string }; unchecked?: boolean }): Promise<SendPlan> {
  const { states, unread, fromMemory, apiError } = await loadTokens(ctx, signer);
  let chosen: { picked: Located<TokenState>[]; merges: number };
  try { chosen = args.unchecked ? chooseUncheckedFirst(unread, states, args.amount) : chooseStates(states, args.amount); }
  catch (e) {
    // Not enough among what the wallet already knew of, while the coordinator did not answer: the reason is that, not the balance.
    if (fromMemory) throw new Error(`The bridge server did not answer (${apiError}), so this wallet could only look for the kUSDT it already knew of, and that is not enough for this. Try again in a moment. Nothing was sent.`);
    throw e;
  }
  const { picked, merges } = chosen;
  const changeValue = BigInt(ctx.config.tokenValue);
  // A burn is never spent again, so it carries only the small burn value (SPEC §9).
  const tokenValue = args.redeem ? BigInt(ctx.config.burnValue) : changeValue;
  const sum = picked.reduce((s, i) => s + i.state.amount, 0n);
  // A state's address follows from its owner and amount: one of the wallet's own of an amount that sits at an
  // unlistable address would land there too.
  const unlisted = new Set(unread.map(s => s.state.amount));
  const toSelf = !args.redeem && args.to.ownerScheme === 0 && args.to.owner === signer.ownerHex;
  if (toSelf && unlisted.has(args.amount)) throw new LandsUnlisted(args.amount);
  if (sum > args.amount && unlisted.has(sum - args.amount)) throw new LandsUnlisted(sum - args.amount);
  const plan: SendPlan = { to: args.to, amount: args.amount, picked, merges, built: null, tokenValue, changeValue, keptInToken: sum > args.amount ? changeValue : 0n, redeem: args.redeem, unchecked: uncheckedIn(picked) };
  if (merges === 0) {
    const [coins, feerate] = await Promise.all([walletCoins(ctx, kasAddresses), ctx.node.feerate()]);
    plan.built = buildPlanned(ctx, signer, coins, plan, picked, feerate);
  }
  return plan;
}

/**
 * Merges `group` (2 or 3 states) into one state of the wallet, and waits for it. `holdFeerate` is shown the feerate
 * the merge would be built at, before anything is signed, and what it throws stops it: a pool request holds its merges
 * to the feerate its approval showed (Daybreak [9]).
 */
export async function mergeStates(ctx: Ctx, signer: Signer, kasAddresses: string[], group: Located<TokenState>[], onStep?: (txid: string, built: Built) => void, holdFeerate?: (feerate: number) => void): Promise<Located<TokenState>> {
  const total = group.reduce((s, i) => s + i.state.amount, 0n);
  const state = plainState({ ownerScheme: 0, owner: signer.ownerHex }, total);
  const [coins, feerate] = await Promise.all([walletCoins(ctx, kasAddresses), ctx.node.feerate()]);
  holdFeerate?.(feerate);
  const built = buildTransfer(ctx, signer, coins, { inputs: group, outputs: [{ state, value: BigInt(ctx.config.tokenValue) }] }, feerate);
  const txid = await submitBuilt(ctx, built, true);
  onStep?.(txid, built);
  return { utxo: await waitForOutput(ctx, built, 0), state };
}

/** Brings `picked` down to at most 3 states, merging the smallest first (each merge held by `holdFeerate`, as mergeStates says). */
export async function mergeDown(ctx: Ctx, signer: Signer, kasAddresses: string[], picked: Located<TokenState>[], onStep?: (txid: string, built: Built) => void, holdFeerate?: (feerate: number) => void): Promise<Located<TokenState>[]> {
  let list = [...picked];
  while (list.length > MAX_TOKEN_INPUTS) {
    list.sort((a, b) => (a.state.amount === b.state.amount ? 0 : a.state.amount > b.state.amount ? -1 : 1));
    const group = list.slice(-MAX_TOKEN_INPUTS);
    const merged = await mergeStates(ctx, signer, kasAddresses, group, onStep, holdFeerate);
    list = [...list.slice(0, list.length - MAX_TOKEN_INPUTS), merged];
  }
  return list;
}

/**
 * The wallet's empty kUSDT states: amount 0, each still holding its KAS (1.5 KAS). The pool's `init` and `add` always
 * leave a change state, so a deposit that uses a whole state leaves one of these; nothing else spends them.
 */
export function emptyStatesOf<T extends { state: { amount: bigint } }>(states: T[]): T[] {
  return states.filter((s) => s.state.amount === 0n);
}

/**
 * Frees the KAS of empty kUSDT states: up to two of them in one transfer with the wallet's smallest state that holds
 * kUSDT (or, with none, up to three empty ones into one empty state), so that only one state's KAS stays locked and the
 * rest comes back as KAS change. Answers the KAS freed (less the network fee).
 */
export async function sweepEmptyStates(ctx: Ctx, signer: Signer, kasAddresses: string[]): Promise<{ txid: string; freed: bigint; built: Built }> {
  const { states } = await loadTokens(ctx, signer);
  const empty = emptyStatesOf(states);
  if (empty.length === 0) throw new Error('There is no empty kUSDT state to free.');
  const holding = states.filter((s) => s.state.amount > 0n).sort((a, b) => (a.state.amount < b.state.amount ? -1 : a.state.amount > b.state.amount ? 1 : 0))[0];
  const group = holding ? [holding, ...empty.slice(0, MAX_TOKEN_INPUTS - 1)] : empty.slice(0, MAX_TOKEN_INPUTS);
  if (group.length < 2) throw new Error('One empty kUSDT state is freed together with another kUSDT state of this wallet: receive some kUSDT first.');
  const total = group.reduce((s, i) => s + i.state.amount, 0n);
  const value = BigInt(ctx.config.tokenValue);
  const state = plainState({ ownerScheme: 0, owner: signer.ownerHex }, total);
  const [coins, feerate] = await Promise.all([walletCoins(ctx, kasAddresses), ctx.node.feerate()]);
  const built = buildTransfer(ctx, signer, coins, { inputs: group, outputs: [{ state, value }] }, feerate);
  const txid = await submitBuilt(ctx, built, true);
  const freed = group.reduce((s, i) => s + i.utxo.amount, 0n) - value - built.fee;
  return { txid, freed: freed > 0n ? freed : 0n, built };
}

/** The state a pool sell or deposit of `amount` spends as it is: the smallest single one that is enough, if any. */
export const singleStateOf = <T extends { state: { amount: bigint } }>(states: T[], amount: bigint): T | undefined =>
  states.filter(s => s.state.amount >= amount).sort((a, b) => (a.state.amount < b.state.amount ? -1 : 1))[0];

/** One state holding at least `amount` (merging as needed, each merge held by `holdFeerate`): what a pool sell or deposit spends. */
export async function singleStateFor(ctx: Ctx, signer: Signer, kasAddresses: string[], amount: bigint, onStep?: (txid: string, built: Built) => void, holdFeerate?: (feerate: number) => void): Promise<Located<TokenState>> {
  const { states } = await loadTokens(ctx, signer);
  const one = singleStateOf(states, amount);
  if (one) return one;
  let { picked } = chooseStates(states, amount);
  picked = await mergeDown(ctx, signer, kasAddresses, picked, onStep, holdFeerate);
  return picked.length === 1 ? picked[0] : mergeStates(ctx, signer, kasAddresses, picked, onStep, holdFeerate);
}

/**
 * Carries out a plan: the merges, then the final transfer (rebuilt if merges
 * came first, and checked against the plan's recipient and amount).
 * `beforeSend` is asked right before the final transfer is sent, after the
 * merges, with the transfer as built, and what it throws stops it: a redemption
 * asks the recipient and the vault again there (Daybreak [2]), and keeps the
 * burn it is about to send.
 */
export async function executeSend(ctx: Ctx, signer: Signer, kasAddresses: string[], plan: SendPlan, onStep?: (txid: string, built: Built) => void, beforeSend?: (built: Built) => Promise<void>): Promise<{ txid: string; built: Built }> {
  try {
    let built = plan.built;
    if (!built || plan.merges > 0) {
      const inputs = await mergeDown(ctx, signer, kasAddresses, plan.picked, onStep);
      const [coins, feerate] = await Promise.all([walletCoins(ctx, kasAddresses), ctx.node.feerate()]);
      // Never with the fee out of the tokens' KAS here: that was not what the review showed (merges leave KAS change anyway).
      built = buildTransfer(ctx, signer, coins, transferArgsFor(plan, inputs, signer), feerate);
    }
    await beforeSend?.(built);
    const txid = await submitBuilt(ctx, built);
    return { txid, built };
  } catch (e) {
    // The node is the judge of a state it could not show: its refusal is the answer, said as what it means.
    if (e instanceof NodeRejected && uncheckedIn(plan.picked) > 0n) {
      throw new NodeRejected(e.said, `The Kaspa node refused this transaction: it said ${quoted(e.said)}. It spends kUSDT this wallet could not check on the node: that kUSDT is not there as recorded, or was spent already. Nothing was sent.`);
    }
    throw e;
  }
}

/** Whether a built transfer carries the redemption payload for its output 0. */
export function payloadOf(built: Built): string {
  return (JSON.parse(built.transaction) as { payload?: string }).payload ?? '';
}
