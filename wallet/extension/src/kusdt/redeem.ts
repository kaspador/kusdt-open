// Redeeming kUSDT for USDT on Ethereum or BNB Chain (SPEC §9): a KCC-20
// transfer to the burn owner that commits to the chain and the address, with
// the preimage in the payload; then the coordinator is told (POST /redeems)
// and the release is followed (GET /redeems/:txid/:index).
//
// A redemption can't be undone: burnt tokens can never move again, and the KAS
// their state carries stays with them. So the wallet burns only to an address
// the coordinator says the vault would pay (GET /recipients) and the token
// itself, asked over the chain's RPCs, does not block, and refuses when it
// can't ask either.
//
// Whether the vault can pay the burn now is the vault's own answer (its pause,
// fee, capacity, allowance, queue and unclaimed backing, read over the chain's
// RPCs): the coordinator's /status is asked first, for the screen and for the
// other chain to offer, and is never enough on its own (round 12, R12-WW-2).

import { ApiError, chainFees, feeOf, type ChainFees, type CoordinatorApi } from './api';
import { burnOwner, executeSend, planSend, type SendPlan } from './tokens';
import { addressOfSpk } from './submit';
import type { Built, Ctx, Signer } from './types';
import { CHAIN_CODE, CHAIN_KEYS, type ChainKey, type EvmChainConfig } from '../config/defaults';
import { encodeCall } from '../evm/abi';
import { EthRpc } from '../evm/rpc';
import { MaybeSent } from '../kaspa/node';
import { vaultReleaseCapacity, vaultReleaseFee, vaultReleaseState } from '../evm/vault';
import { isEvmAddressStrict } from '../keys/derive';
import { fmtUsdt, quoted } from '../lib/format';
import { local } from '../lib/storage';

export interface RedeemQuote { fee: bigint; payout: bigint }

/** The release fee for `units` on `chain`, from the coordinator's /status. Null if it doesn't say. */
export async function releaseQuote(ctx: Ctx, chain: ChainKey, units: bigint): Promise<RedeemQuote | null> {
  if (!ctx.api) return null;
  const f = chainFees(await ctx.api.status(), chain);
  if (!f) return null;
  const fee = feeOf(units, f.feeBps, f.minReleaseFee);
  return { fee, payout: units > fee ? units - fee : 0n };
}

/** A release fee above this share of the burn is pointed out (the burn stays allowed). */
export const HIGH_FEE_BPS = 2_000n;

/**
 * The share of a vault's release capacity one burn leaves free (run 21 round 2, R21-ECON-2). KusdtVault.release queues
 * a payout only while reservedUnits + units ≤ releaseCapacity, so a burn of all the room left waits for as long as any
 * payout waits in the vault, and anyone can keep one tiny payout always waiting there. Leaving 1 % free costs a holder
 * no more than a second burn, and keeping a burn out then takes more than that 1 % of the capacity always queued. The
 * web app keeps the same (bridge/web/src/lib/bridge.ts).
 */
export const ROOM_KEPT_BPS = 100n;

/**
 * The warning for a payable burn whose release fee takes more than 20 % of it
 * (the minimum fee on a small burn), else null. The fee is then the minimum
 * fee, so five times it is the smallest burn that keeps the share at 20 %.
 */
export function highFeeText(units: bigint, fee: bigint): string | null {
  if (units <= fee || fee * 10_000n <= units * HIGH_FEE_BPS) return null;
  const pct = (Number((fee * 10_000n) / units) / 100).toFixed(2);
  return `The release fee takes ${pct} % of this redemption: ${fmtUsdt(fee)} USDT of it, so you receive only ${fmtUsdt(units - fee)} USDT. From ${fmtUsdt(fee * 5n)} kUSDT on, the fee is 20 % or less.`;
}

/**
 * What a redemption does to the KAS balance, when it is one transaction (no
 * merge first): the KAS in the burnt token states comes back, less what the
 * burn locks (burnValue), what stays in the change token (yours still) and the
 * network fee. Null while merges come first.
 */
export function kasBalanceChange(plan: Pick<SendPlan, 'picked' | 'built' | 'tokenValue' | 'keptInToken'>): bigint | null {
  if (!plan.built) return null;
  const held = plan.picked.reduce((s, p) => s + p.utxo.amount, 0n);
  return held - plan.tokenValue - plan.keptInToken - plan.built.fee;
}

// ── What a vault can pay (SPEC §7, §8, §9) ──────────────────────────────────

// At most 80 digits, as kusdt/api.ts's (Daybreak [38]): no amount comes near that, and millions of them would hold the
// wallet in BigInt for seconds.
const nat = (v: unknown): bigint | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : typeof v === 'string' && /^\d{1,80}$/.test(v) ? BigInt(v) : null;

export interface ChainCapacity {
  chain: ChainKey;
  name: string;
  paused: boolean;
  fees: ChainFees | null;
  /** The vault's release capacity (the daily allowance ceiling). */
  releaseCapacity: bigint | null;
  /** What the vault's allowance lets it pay right now. */
  releaseAvailable: bigint | null;
  /** USDT backing kUSDT in that vault. */
  backing: bigint | null;
  /** The backing no queued payout has a claim on: what a release may draw (the whole backing, from a coordinator that doesn't say). */
  unreservedBacking: bigint | null;
  /** What is queued in the vault already: it counts against the release capacity (0, from a coordinator that doesn't say). */
  reservedUnits: bigint;
}

/**
 * A chain's limits from /status (`chains[i]`, matched by chain code or name).
 * `name` is what the wallet calls the chain in its messages (its pinned
 * config); without one, the coordinator's own name is used.
 */
export function chainCapacity(status: any, chain: ChainKey, name?: string): ChainCapacity {
  const code = CHAIN_CODE[chain];
  const e = (Array.isArray(status?.chains) ? status.chains : []).find((c: any) => c?.chain === code || c?.chain === chain) ?? null;
  return {
    chain, name: name || (typeof e?.name === 'string' ? e.name : chain),
    paused: e?.paused === true,
    fees: chainFees(status, chain),
    releaseCapacity: nat(e?.fees?.releaseCapacity ?? e?.releaseCapacity),
    releaseAvailable: nat(e?.releaseAvailable),
    backing: nat(e?.backing),
    unreservedBacking: nat(e?.unreservedBacking) ?? nat(e?.backing),
    reservedUnits: nat(e?.reservedUnits) ?? 0n,
  };
}

export interface RedeemCheck {
  /** The release fee for the amount on the chain (null when /status gives none). */
  fee: bigint | null;
  /** Why the burn is refused, or null when it may go ahead. */
  problem: string | null;
  /** Another chain that can pay this amount now, when the one named can't. */
  other: ChainKey | null;
}

/** A vault's limits, all known: from /status (chainCapacity), or from the vault itself (vaultReleaseTerms). */
interface Limits {
  name: string; paused: boolean; releaseCapacity: bigint; releaseAvailable: bigint; unreservedBacking: bigint; reservedUnits: bigint;
  /** The whole backing, where known: it only words the message (whether queued payouts hold a part of it). */
  backing: bigint | null;
}

/**
 * Why `chain` can't pay `units` now, or null (fee aside): what KusdtVault.release checks. The burn must fit the backing
 * queued payouts have not claimed, and the queue must stay within the capacity with it, ROOM_KEPT_BPS of it left free.
 * The vault's allowance and capacity count the gross burn, fee included (SPEC §7).
 */
function limitProblem(c: ChainCapacity, units: bigint): string | null {
  if (!c.fees || c.releaseCapacity == null || c.releaseAvailable == null || c.unreservedBacking == null) {
    return `The coordinator's /status does not give ${c.name}'s release limits, so the wallet can't check that the vault can pay. Nothing was burnt.`;
  }
  return cantPay({ ...c, releaseCapacity: c.releaseCapacity, releaseAvailable: c.releaseAvailable, unreservedBacking: c.unreservedBacking }, units);
}

function cantPay(c: Limits, units: bigint): string | null {
  if (c.paused) return `The ${c.name} vault is paused.`;
  if (units > c.releaseCapacity) return `That is above the ${c.name} vault's release capacity of ${fmtUsdt(c.releaseCapacity)} USDT. Redeem less at a time.`;
  const kept = (c.releaseCapacity * ROOM_KEPT_BPS) / 10_000n;
  const room = c.releaseCapacity > c.reservedUnits + kept ? c.releaseCapacity - c.reservedUnits - kept : 0n;
  if (units > room) {
    return `One burn can take at most ${fmtUsdt(room)} USDT of the ${c.name} vault's release capacity of ${fmtUsdt(c.releaseCapacity)} USDT right now: ${c.reservedUnits > 0n ? `${fmtUsdt(c.reservedUnits)} USDT of payouts already wait in it, and ` : ''}${fmtUsdt(kept)} USDT of it is kept for payouts that may be queued first, so that a burn never waits on them. Redeem less at a time.`;
  }
  if (units > c.unreservedBacking) return `The ${c.name} vault holds only ${fmtUsdt(c.unreservedBacking)} USDT of backing${c.unreservedBacking !== c.backing ? ' that queued payouts have not claimed' : ''}.`;
  if (units > c.releaseAvailable) return `The ${c.name} vault can pay at most ${fmtUsdt(c.releaseAvailable)} USDT right now (its daily allowance refills over 24 h).`;
  return null;
}

/**
 * The SPEC §9 checks before any burn, on the coordinator's /status: the named
 * chain's vault must not be paused, and the amount must be within its release
 * capacity with what is queued, what it can pay now, and the backing queued
 * payouts have not claimed, and above its release fee.
 * A burn the vault can't pay would sit unpaid, and can't be undone. Another
 * chain is offered only among those `offer` allows. `names` only words the
 * messages.
 */
export function checkRedeemAmount(status: any, chain: ChainKey, units: bigint, offer: (k: ChainKey) => boolean = () => true, names: Partial<Record<ChainKey, string>> = {}): RedeemCheck {
  const here = chainCapacity(status, chain, names[chain]);
  const fee = here.fees ? feeOf(units, here.fees.feeBps, here.fees.minReleaseFee) : null;
  let problem = limitProblem(here, units);
  if (!problem && fee != null && units <= fee) problem = `The amount must be above the ${here.name} release fee of ${fmtUsdt(fee)} USDT, or nothing would be paid out.`;
  if (!problem) return { fee, problem: null, other: null };
  const other = CHAIN_KEYS.find(k => {
    if (k === chain || !offer(k)) return false;
    const c = chainCapacity(status, k, names[k]);
    return !limitProblem(c, units) && !!c.fees && units > feeOf(units, c.fees.feeBps, c.fees.minReleaseFee);
  }) ?? null;
  if (other) problem += ` ${chainCapacity(status, other, names[other]).name} can pay it now.`;
  return { fee, problem, other };
}

/**
 * The checks on the newest /status. With `address`, another chain is offered
 * only when its vault would pay that address too (GET /recipients).
 */
export async function redeemCheck(ctx: Ctx, chain: ChainKey, units: bigint, address?: string): Promise<RedeemCheck> {
  if (!ctx.api) return { fee: null, problem: 'No coordinator API is set: the wallet can\'t check that the vault can pay. Nothing was burnt.', other: null };
  const status = await ctx.api.status();
  // The messages name the chains as the wallet pinned them, not as the (untrusted) coordinator does.
  const names = { ethereum: ctx.config.chains.ethereum?.name, bsc: ctx.config.chains.bsc?.name };
  const check = checkRedeemAmount(status, chain, units, undefined, names);
  const other = check.other;
  if (!other || address === undefined) return check;
  return (await recipientCheck(ctx, other, address)).payable ? check : checkRedeemAmount(status, chain, units, k => k !== other, names);
}

// ── Who a vault pays (SPEC §9: a blocked recipient is never paid) ───────────

export interface RecipientCheck {
  /** True only when the coordinator says the named vault would pay exactly this address. */
  payable: boolean;
  /** Why a burn to it is refused, or null when it may go ahead. */
  problem: string | null;
  /** False when the coordinator couldn't be asked or gave no clear answer: refused all the same, and asking again may help. */
  checked: boolean;
  /** The token blocks the address: the vault pays nothing to it while it does. */
  blocked: boolean;
}

/** No answer is a no: a burn can't be undone. */
const CANT_CHECK = "Couldn't check the recipient with the coordinator, so nothing was burnt: a burn can't be undone. Try again in a moment.";
const uncheckedRecipient = (problem = CANT_CHECK): RecipientCheck =>
  ({ payable: false, problem, checked: false, blocked: false });
const refusedRecipient = (name: string, reason: string | null): RecipientCheck =>
  ({ payable: false, problem: `The ${name} vault won't pay this address${reason ? ` (${reason})` : ''}. Use another address.`, checked: true, blocked: false });
const blockedRecipient = (name: string): RecipientCheck =>
  ({ payable: false, problem: `USDT on ${name} blocks this address: a payout there would be frozen, so the vault pays nothing to it. Use another address.`, checked: true, blocked: true });

/**
 * GET /recipients/:chain/:address's answer (SPEC §13). It must be about
 * exactly this chain and address, and only `payable: true` with `blocked:
 * false` lets a burn go ahead: anything else refuses it.
 */
export function checkRecipientAnswer(answer: any, chain: ChainKey, address: string, name: string = chain): RecipientCheck {
  const about = !!answer && typeof answer === 'object' && (answer.chain === CHAIN_CODE[chain] || answer.chain === chain)
    && typeof answer.address === 'string' && answer.address.toLowerCase() === address.toLowerCase();
  if (!about || typeof answer.payable !== 'boolean' || typeof answer.blocked !== 'boolean') return uncheckedRecipient();
  if (answer.blocked) return blockedRecipient(name);
  // The coordinator's own reason, said as its own, quoted and cut (run 21 round 2, R21-W2-5).
  if (!answer.payable) return refusedRecipient(name, typeof answer.reason === 'string' && answer.reason.trim() ? `the bridge server says ${quoted(answer.reason)}` : null);
  return { payable: true, problem: null, checked: true, blocked: false };
}

/**
 * Whether the vault on `chain` would pay `address`, asked of the coordinator
 * before every burn (SPEC §9). The zero address and the pinned vault's own are
 * refused without asking. When the wallet can't ask (no API, a network error,
 * a 503, a 404 from an older coordinator), it refuses too.
 */
export async function recipientCheck(ctx: Ctx, chain: ChainKey, address: string): Promise<RecipientCheck> {
  const ch = ctx.config.chains[chain];
  const name = ch?.name || chain;
  if (!isEvmAddressStrict(address)) return { payable: false, problem: "That is not a valid EVM address: its letters don't match its checksum, so it may be mistyped. Nothing was burnt.", checked: true, blocked: false };
  if (/^0x0{40}$/i.test(address)) return refusedRecipient(name, 'the zero address');
  if (ch?.vault && address.toLowerCase() === ch.vault.toLowerCase()) return refusedRecipient(name, "the vault's own address");
  // Any network's vault or token: the other chain's contract address pasted by mistake would take the payout for good.
  for (const other of Object.values(ctx.config.chains)) {
    if ([other?.vault, other?.token].some((a) => !!a && a.toLowerCase() === address.toLowerCase())) return refusedRecipient(name, "a vault's or token contract's own address");
  }
  if (!ctx.api) return uncheckedRecipient('No coordinator API is set: the wallet can\'t check that the vault would pay this address. Nothing was burnt.');
  try { return checkRecipientAnswer(await ctx.api.recipient(chain, address), chain, address, name); }
  catch { return uncheckedRecipient(); }
}

/** How the wallet reaches the pinned vault: over the chain's own RPCs, never through the coordinator (tests replace it). */
export const VAULT_READER = {
  rpc: (ch: EvmChainConfig): Pick<EthRpc, 'ethCall'> => new EthRpc(ch.rpcUrls, ch.chainId, ch.name, ch.gasSymbol),
};

/**
 * Whether the pinned vault can pay a burn of `units` now, asked of the vault itself (SPEC §7, §9): its fee and
 * capacity, which decide whether the burn can ever be paid, and its pause, its allowance, its queue and the backing
 * queued payouts have not claimed, which decide whether it can be paid now. /status is only the coordinator's word,
 * and a burn the vault can't queue a payout for waits on its chain with no way back (round 12, R12-WW-2: these four
 * were taken from /status alone). Six reads, a fixed number. Answers the fee, or throws: no answer is a no.
 *
 * `told`: the coordinator's /status has just said this vault can pay the burn. A vault that says otherwise is then
 * a disagreement, and the message says so: the coordinator's figures are not to be gone by elsewhere either.
 * Another burn or a pause can still land between this read and the burn; such a burn waits (SPEC §9).
 */
async function vaultReleaseTerms(ctx: Ctx, chain: ChainKey, units: bigint, told: boolean): Promise<bigint> {
  const ch = ctx.config.chains[chain];
  const name = ch?.name || chain;
  let fee: bigint, capacity: bigint, state: Awaited<ReturnType<typeof vaultReleaseState>>;
  try {
    const rpc = VAULT_READER.rpc(ch);
    [fee, capacity, state] = await Promise.all([vaultReleaseFee(rpc, ch.vault, units), vaultReleaseCapacity(rpc, ch.vault), vaultReleaseState(rpc, ch.vault)]);
  } catch {
    throw new Error(`Couldn't read the release fee and limits from the ${name} vault, so nothing was burnt: a burn can't be undone. Try again in a moment.`);
  }
  const problem = cantPay({
    name, paused: state.paused, releaseCapacity: capacity, releaseAvailable: state.releaseAvailable, unreservedBacking: state.unreservedBacking, reservedUnits: state.reservedUnits,
    backing: state.reservedUnits === 0n ? state.unreservedBacking : null,
  }, units);
  if (problem) throw new Error(`${problem}${told ? " The bridge server says this vault can pay it, so its figures are behind or wrong: the vault's own answer is the one that counts." : ''} Nothing was burnt.`);
  if (units <= fee) throw new Error(`The amount must be above the ${name} release fee of ${fmtUsdt(fee)} USDT, or nothing would be paid out. Nothing was burnt.`);
  return fee;
}

/**
 * Whether the token blocks `address`, asked of the token itself (SPEC §9, Daybreak [24]): through the view the pinned
 * deployment names (Ethereum's USDT: isBlackListed), on each of the chain's RPCs, the ones the vault is read over. The
 * coordinator's "payable" is only its word: one that says it for an address the token blocks would have kUSDT burnt
 * that every honest signer then refuses to pay, held for as long as the token blocks the address. One RPC saying
 * blocked is a no, and so is none answering; a token that keeps no blocklist (BSC-USD) is not asked. Asked after the
 * coordinator has said yes. Throws, or answers nothing.
 */
async function assertTokenPays(ctx: Ctx, chain: ChainKey, address: string): Promise<void> {
  const ch = ctx.config.chains[chain];
  if (!ch.blocklist) return;
  const name = ch.name || chain;
  const data = encodeCall(`${ch.blocklist}(address)`, ['address'], [address]);
  const answers = await Promise.all(ch.rpcUrls.map(url => VAULT_READER.rpc({ ...ch, rpcUrls: [url] }).ethCall(ch.token, data).then(
    // One 32-byte word, 0 or 1: anything else is no answer.
    (word) => (/^0x0{63}[01]$/.test(word) ? word.endsWith('1') : null),
    () => null,
  )));
  if (answers.includes(true)) throw new Error(`${blockedRecipient(name).problem} The token says so itself; the bridge server said it would pay it, so its answer is behind or wrong. Nothing was burnt.`);
  if (!answers.includes(false)) throw new Error(`Couldn't read from USDT on ${name} whether it blocks this address, so nothing was burnt: a burn can't be undone. Try again in a moment.`);
}

/**
 * Plans a redemption, after the SPEC §9 checks: the recipient (GET
 * /recipients), the amount on the newest /status, then the vault itself: its
 * fee and capacity, and whether it can pay the amount now (vaultReleaseTerms),
 * and the token itself, whether it blocks the recipient (assertTokenPays).
 * They run again here, whatever the screen showed. A refusal by /status stops
 * the burn as before (the coordinator is what carries the payout); its yes is
 * not enough without the vault's and the token's. A recipient the vault
 * wouldn't pay is refused first, so no other chain is offered for it. Answers
 * the plan and the vault's fee.
 */
export async function planRedeem(ctx: Ctx, signer: Signer, kasAddresses: string[], args: { chain: ChainKey; address: string; amount: bigint }): Promise<SendPlan & { releaseFee: bigint }> {
  const recipient = await recipientCheck(ctx, args.chain, args.address);
  if (!recipient.payable) throw new Error(recipient.problem ?? CANT_CHECK);
  const check = await redeemCheck(ctx, args.chain, args.amount, args.address);
  if (check.problem || check.fee == null) throw new Error(check.problem ?? 'The release fee could not be read. Nothing was burnt.');
  const releaseFee = await vaultReleaseTerms(ctx, args.chain, args.amount, true);
  await assertTokenPays(ctx, args.chain, args.address);
  const code = CHAIN_CODE[args.chain];
  const owner = burnOwner(ctx, code, args.address);
  const plan = await planSend(ctx, signer, kasAddresses, { to: owner, amount: args.amount, redeem: { chain: code, address: args.address } });
  return { ...plan, releaseFee };
}

/** Where a planned burn pays: the chain and address it commits to, and so what is shown and recorded for it. */
export function burnTarget(plan: Pick<SendPlan, 'redeem'>): { chain: ChainKey; address: string } {
  if (!plan.redeem) throw new Error('Not a redemption.');
  const chain = CHAIN_KEYS.find(k => CHAIN_CODE[k] === plan.redeem!.chain);
  if (!chain) throw new Error('Not a redemption to a known chain.');
  return { chain, address: plan.redeem.address };
}

/**
 * Submits the redemption and hands the coordinator the burn. The recipient is
 * asked about once more (the coordinator and the token), and so is the vault
 * (its fee, pause, allowance, queue and backing), right before the burn is
 * sent, after any merge it needed first (Daybreak [2]): the answers may have
 * changed while the review was open or a merge waited. A release fee above the
 * one the review showed stops the burn too (Daybreak [19]): the vault takes the
 * fee of the moment it queues the payout, after the burn, so a higher one would
 * pay out less than the user approved. With merges first, the same is asked
 * before them as well, so a burn that can't go out costs no merge. The
 * coordinator being down afterwards does not undo anything.
 */
export async function executeRedeem(ctx: Ctx, signer: Signer, kasAddresses: string[], plan: SendPlan & { releaseFee: bigint }, onStep?: (txid: string, built: Built) => void): Promise<{ txid: string; outputIndex: number; redeemIds: string[]; reported: boolean }> {
  const { chain, address } = burnTarget(plan);
  const name = ctx.config.chains[chain]?.name || chain;
  const recheck = async () => {
    const recipient = await recipientCheck(ctx, chain, address);
    if (!recipient.payable) throw new Error(recipient.problem ?? CANT_CHECK);
    const fee = await vaultReleaseTerms(ctx, chain, plan.amount, false);
    if (fee > plan.releaseFee) {
      throw new Error(`The ${name} vault now takes a release fee of ${fmtUsdt(fee)} USDT, more than the ${fmtUsdt(plan.releaseFee)} USDT you approved: you would receive ${fmtUsdt(plan.amount - fee)} USDT, not ${fmtUsdt(plan.amount - plan.releaseFee)}. Nothing was burnt. Look at the new fee and redeem again.`);
    }
    await assertTokenPays(ctx, chain, address);
  };
  if (plan.merges > 0) await recheck();
  let burn: Built | undefined;
  const { txid, built } = await executeSend(ctx, signer, kasAddresses, plan, onStep, async (b) => { await recheck(); burn = b; })
    .catch(async (e: unknown) => {
      // The node did not answer the burn itself, so it may be out: its claim is kept, and sent only once the node shows
      // the burn accepted (reclaim). Until then the wallet says it may have been sent, never that it is pending.
      if (e instanceof MaybeSent && !e.merge && burn?.txid === e.txid) {
        await keepClaim(ctx.network, e.txid, burn.transaction, false, addressOfSpk(burn.outputs[0].scriptPublicKey, ctx.net.prefix)).catch(() => {});
      }
      throw e;
    });
  let redeemIds: string[] = [], reported = false;
  try {
    const r = await ctx.api?.postRedeem({ transaction: built.transaction, transactionId: txid });
    redeemIds = (r?.redeems ?? []).map(x => x.redeemId).filter((x): x is string => typeof x === 'string');
    reported = true;
  } catch { /* not taken: sent again (redeemStatus); the coordinator also finds the burn on the chain */ }
  // Kept, to be sent again while the coordinator has no record of this burn or never took its claim (redeemStatus);
  // never in the way of the burn, which is out by now.
  await keepClaim(ctx.network, txid, built.transaction, reported).catch(() => {});
  return { txid, outputIndex: 0, redeemIds, reported };
}

/**
 * SPEC §13. `queued`: in the vault, waiting (SPEC §7). `blocked`: held while the token blocks the recipient, checked again
 * and paid once it doesn't (back to `final`, then `released`). `unpayable`: not
 * paid (at or below the fee, back to `final` if the fee falls; or the zero or the vault's address, for good).
 */
export type RedeemStatus = 'seen' | 'final' | 'signing' | 'queued' | 'released' | 'invalid' | 'unpayable' | 'blocked' | 'unknown';
const REDEEM_STATUSES: readonly string[] = ['seen', 'final', 'signing', 'queued', 'released', 'invalid', 'unpayable', 'blocked'];

/**
 * A burn's status from the coordinator (GET /redeems/:txid/:index). No record of the burn (404), or no answer while its
 * claim was never taken, has the claim sent again when the wallet keeps it and its wait is over (reclaim); a burn paid,
 * or found invalid, is no longer kept.
 */
export async function redeemStatus(ctx: Ctx, txid: string, outputIndex: number): Promise<{ status: RedeemStatus; evmTxHash?: string; fee?: string }> {
  if (!ctx.api) return { status: 'unknown' };
  const api = ctx.api;
  const r = await api.redeem(txid, outputIndex).catch(async (e: unknown) => {
    await reclaim(ctx, api, txid, e instanceof ApiError && e.status === 404);
    throw e;
  });
  const s = typeof r?.status === 'string' && REDEEM_STATUSES.includes(r.status) ? r.status as RedeemStatus : 'unknown';
  if (s === 'released' || s === 'invalid') {
    const claims = await claimsOf(ctx.network);
    if (txid in claims) { delete claims[txid]; await local.set({ [CLAIMS_KEY(ctx.network)]: claims }); }
  }
  return { status: s, evmTxHash: typeof r?.evmTxHash === 'string' ? r.evmTxHash : undefined, fee: r?.fee != null ? String(r.fee) : undefined };
}

// ── A burn's claim, sent again while the coordinator has no record of it ───────
//
// The wallet tells the coordinator of a burn once it is out (POST /redeems, the burn's own transaction). A coordinator
// that was away then, or that was rebuilt or re-anchored since, has no record of the burn and no read of its own will
// find it again: GET /redeems answers 404 for good, and the burn is never paid, though one claim pays it (run 21 round
// 2, R21-COORD2-5). So the claim is kept, by network, and sent again while the coordinator answers 404 for the burn, or
// while it has not taken the claim (the burn shows as "Sent", unreported) and cannot say. A burn the node did not answer
// about when it was sent ("May have been sent") is claimed only once the node shows it accepted: a claim makes the
// coordinator show the burn as pending, and one that never landed must not be.

const CLAIMS_KEY = (network: string) => `kusdt.claims.${network}`;
/**
 * A burn's claim: its transaction as the core wrote it; whether the coordinator took it (`taken`); sent again `tries`
 * times so far, and not again before `next`. `unseenAt`: for a burn the node did not answer about, the address its
 * output 0 is looked for at; until the node shows it there, the claim is not sent and each look counts as a try.
 */
interface KeptClaim { transaction: string; at: number; taken: boolean; tries: number; next: number; unseenAt?: string }
/**
 * A claim is sent again at most `tries` times: at the first 404, then a minute later (`firstMs`), each wait twice the
 * one before and never more than `maxMs`: about three days in all. The claims of the newest `kept` burns are kept.
 */
export const RECLAIM = { tries: 20, firstMs: 60_000, maxMs: 6 * 3_600_000, kept: 50 };

const claimsOf = async (network: string): Promise<Record<string, KeptClaim>> => (await local.get<Record<string, KeptClaim>>(CLAIMS_KEY(network))) ?? {};

async function keepClaim(network: string, txid: string, transaction: string, taken: boolean, unseenAt?: string): Promise<void> {
  const claims = await claimsOf(network);
  claims[txid] = { transaction, at: Date.now(), taken, tries: 0, next: 0, ...(unseenAt ? { unseenAt } : {}) };
  const newest = Object.entries(claims).sort(([, a], [, b]) => b.at - a.at).slice(0, RECLAIM.kept);
  await local.set({ [CLAIMS_KEY(network)]: Object.fromEntries(newest) });
}

/**
 * Sends a kept claim again, the same claim (the burn's own transaction): when the coordinator has no record of the burn
 * (`noRecord`) or never took the claim, its wait is over and it has tries left. A burn not seen accepted yet is looked
 * for on the node first, and claimed only once it is there; from then on its tries count afresh.
 */
async function reclaim(ctx: Ctx, api: CoordinatorApi, txid: string, noRecord: boolean): Promise<void> {
  const claims = await claimsOf(ctx.network);
  const kept = claims[txid];
  if (!kept || (kept.taken && !noRecord) || kept.tries >= RECLAIM.tries || Date.now() < kept.next) return;
  const landed = kept.unseenAt === undefined
    || (await ctx.node.utxos([kept.unseenAt]).catch(() => [])).some(u => u.transactionId === txid && u.index === 0);
  const c: KeptClaim = landed && kept.unseenAt !== undefined ? { transaction: kept.transaction, at: kept.at, taken: false, tries: 0, next: 0 } : kept;
  claims[txid] = { ...c, tries: c.tries + 1, next: Date.now() + Math.min(RECLAIM.firstMs * 2 ** c.tries, RECLAIM.maxMs) };
  await local.set({ [CLAIMS_KEY(ctx.network)]: claims });
  if (!landed) return;
  // A coordinator still away is asked again once the next wait is over.
  const taken = await api.postRedeem({ transaction: c.transaction, transactionId: txid }).then(() => true, () => false);
  if (!taken || c.taken) return;
  const now = await claimsOf(ctx.network);
  if (txid in now) await local.set({ [CLAIMS_KEY(ctx.network)]: { ...now, [txid]: { ...now[txid], taken } } });
}
