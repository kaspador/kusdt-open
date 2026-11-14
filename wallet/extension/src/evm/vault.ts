// Bridging in: USDT on Ethereum or BNB Chain into KusdtVault, which emits a
// Deposit the signers mint on Kaspa (SPEC §7). The recipient is the wallet's
// own Kaspa key (owner scheme 0x00, the x-only key), never typed by anyone.
//
//   1. approve the vault for exactly units × 10^(decimals − 6) (Ethereum's
//      USDT refuses to change a non-zero allowance: it is set to 0 first)
//   2. KusdtVault.deposit(units, ownerScheme, owner)
//   3. read the Deposit event of the receipt: its nonce is what /deposits tracks

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@kusdt/kaspa';
import { encodeCall, selector, wordAt } from './abi';
import { signTx, setSignableChains, type Eip1559Tx } from './tx';
import { RpcError, feeSpreadNote, type EthRpc } from './rpc';
import { quoted } from '../lib/format';

/** The deposit that reverts unless at least its last argument is minted: the vault's fee rises with the day's deposits (rc.16). */
export const DEPOSIT_SIGNATURE = 'depositAtLeast(uint256,uint8,bytes32,uint256)';
export const DEPOSIT_EVENT = 'Deposit(uint64,address,uint8,bytes32,uint256,uint256,uint256)';
export const DEPOSIT_TOPIC = '0x' + bytesToHex(keccak_256(new TextEncoder().encode(DEPOSIT_EVENT)));

export interface Call { to: string; data: string }

export const balanceOfData = (owner: string) => encodeCall('balanceOf(address)', ['address'], [owner]);
export const allowanceData = (owner: string, spender: string) => encodeCall('allowance(address,address)', ['address', 'address'], [owner, spender]);
export const approveData = (spender: string, amount: bigint) => encodeCall('approve(address,uint256)', ['address', 'uint'], [spender, amount]);
export const depositData = (units: bigint, ownerScheme: number, ownerHex: string, minMinted: bigint) => {
  if (!/^[0-9a-f]{64}$/.test(ownerHex) || /^0{64}$/.test(ownerHex)) throw new Error('Bad Kaspa owner.');
  if (ownerScheme < 0 || ownerScheme > 4) throw new Error('Bad owner scheme.');
  if (minMinted < 0n || minMinted >= units) throw new Error('Bad minimum to mint.');
  return encodeCall(DEPOSIT_SIGNATURE, ['uint', 'uint', 'bytes32', 'uint'], [units, ownerScheme, '0x' + ownerHex, minMinted]);
};

/** Token amount (smallest unit) of `units` base units (SPEC §3). */
export const tokenAmount = (units: bigint, decimals: number): bigint => units * 10n ** BigInt(decimals - 6);
/** Whole base units in a token amount (rounded down). */
export const unitsOf = (amount: bigint, decimals: number): bigint => amount / 10n ** BigInt(decimals - 6);

/**
 * The approvals before the vault may pull `amount`: none when the allowance is
 * enough; otherwise one for exactly `amount`, preceded by a reset to 0 when
 * `resetFirst` (Ethereum's USDT) and the current allowance is not 0.
 */
export function approvalSteps(token: string, vault: string, current: bigint, amount: bigint, resetFirst: boolean): Call[] {
  if (current >= amount) return [];
  const steps: Call[] = [];
  if (resetFirst && current > 0n) steps.push({ to: token, data: approveData(vault, 0n) });
  steps.push({ to: token, data: approveData(vault, amount) });
  return steps;
}

/**
 * The least a deposit may mint, given what the screen showed. The vault's fee rises with the day's deposits, so one
 * that lands just ahead moves it a little: a quarter of a percent of the deposit is let through, no more.
 */
export function minMintedOf(shownMinted: bigint, units: bigint): bigint {
  const slack = (units * 25n) / 10_000n;
  return shownMinted > slack ? shownMinted - slack : 0n;
}

export interface VaultInfo { paused: boolean; minDeposit: bigint; maxDeposit: bigint; fee: bigint; minted: bigint }

/** What the vault itself says about a deposit of `units`. */
export async function vaultQuote(rpc: EthRpc, vault: string, units: bigint): Promise<VaultInfo> {
  const [paused, minD, maxD, fee] = await Promise.all([
    rpc.ethCall(vault, selector('paused()')),
    rpc.ethCall(vault, selector('minDeposit()')),
    rpc.ethCall(vault, selector('maxDeposit()')),
    rpc.ethCall(vault, encodeCall('depositFeeOf(uint256)', ['uint'], [units])),
  ]);
  const f = wordAt(fee);
  return { paused: wordAt(paused) !== 0n, minDeposit: wordAt(minD), maxDeposit: wordAt(maxD), fee: f, minted: units > f ? units - f : 0n };
}

/** The vault's own release fee for `units` (SPEC §7), to cross-check /status. */
export async function vaultReleaseFee(rpc: Pick<EthRpc, 'ethCall'>, vault: string, units: bigint): Promise<bigint> {
  return wordAt(await rpc.ethCall(vault, encodeCall('releaseFeeOf(uint256)', ['uint'], [units])));
}

/** The vault's own release capacity: a burn above it can't be paid until the owner raises it. */
export async function vaultReleaseCapacity(rpc: Pick<EthRpc, 'ethCall'>, vault: string): Promise<bigint> {
  return wordAt(await rpc.ethCall(vault, selector('releaseCapacity()')));
}

/** What decides whether the vault can queue a payout right now (KusdtVault.release), from the vault itself. */
export interface VaultReleaseState {
  paused: boolean;
  /** The backing no queued payout has a claim on: a release must fit in it. */
  unreservedBacking: bigint;
  /** What the daily allowance lets the vault queue now. */
  releaseAvailable: bigint;
  /** What is queued already: with a new payout it must stay within the release capacity. */
  reservedUnits: bigint;
}

/** Four views of the vault, each one call. A vault that can't answer one of them throws: the caller refuses the burn. */
export async function vaultReleaseState(rpc: Pick<EthRpc, 'ethCall'>, vault: string): Promise<VaultReleaseState> {
  const [paused, unreservedBacking, releaseAvailable, reservedUnits] = await Promise.all(
    ['paused()', 'unreservedBacking()', 'releaseAvailable()', 'reservedUnits()'].map(async (view) => {
      const answer = await rpc.ethCall(vault, selector(view));
      // One 32-byte word each. Anything else (an empty answer from an address with no such view) is no answer.
      if (typeof answer !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(answer)) throw new Error(`The vault gave no answer to ${view}.`);
      return wordAt(answer);
    }),
  );
  if (paused > 1n) throw new Error('The vault gave no answer to paused().');
  return { paused: paused === 1n, unreservedBacking, releaseAvailable, reservedUnits };
}

export async function tokenBalance(rpc: EthRpc, token: string, owner: string): Promise<bigint> {
  return wordAt(await rpc.ethCall(token, balanceOfData(owner)));
}
export async function allowance(rpc: EthRpc, token: string, owner: string, spender: string): Promise<bigint> {
  return wordAt(await rpc.ethCall(token, allowanceData(owner, spender)));
}

export interface DepositEvent { nonce: bigint; sender: string; ownerScheme: number; owner: string; units: bigint; fee: bigint; minted: bigint }

/** The vault's Deposit event in a receipt's logs, or null. */
export function depositEventOf(logs: { address: string; topics: string[]; data: string }[], vault: string): DepositEvent | null {
  for (const l of logs) {
    if (l.address.toLowerCase() !== vault.toLowerCase() || l.topics[0]?.toLowerCase() !== DEPOSIT_TOPIC) continue;
    const words = (i: number) => wordAt(l.data, i);
    return {
      nonce: BigInt(l.topics[1]),
      sender: '0x' + l.topics[2].slice(-40),
      ownerScheme: Number(words(0)),
      owner: words(1).toString(16).padStart(64, '0'),
      units: words(2), fee: words(3), minted: words(4),
    };
  }
  return null;
}

const MAX_GAS = 1_000_000n;
/** How many more times, and how far apart, the step right after a mined one is estimated (prepareAfterMined). */
const ESTIMATE_RETRIES = 3;
const ESTIMATE_RETRY_MS = 1_500;

export interface PreparedTx { tx: Eip1559Tx; maxFee: bigint }

export async function prepareTx(rpc: EthRpc, from: string, call: Call, opts: { gas?: bigint; nonce?: number } = {}): Promise<PreparedTx> {
  const [fees, nonce, est, balance] = await Promise.all([
    rpc.fees(), opts.nonce ?? rpc.nonce(from),
    opts.gas ?? rpc.estimateGas({ from, to: call.to, data: call.data }).then(g => (g * 125n) / 100n),
    rpc.balance(from),
  ]);
  const gas = est > MAX_GAS ? MAX_GAS : est;
  const tx: Eip1559Tx = { chainId: rpc.chainId, nonce, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, gas, to: call.to, value: 0n, data: call.data };
  const maxFee = gas * fees.maxFeePerGas;
  if (balance < maxFee) {
    // The highest base fee is signed (R15-CL-1): when one RPC names a far higher one, say which, as that may be the cause.
    const spread = feeSpreadNote(rpc.name, fees.spread);
    throw new Error(`Not enough ${rpc.gasSymbol} on ${rpc.name} for the network fee.${spread ? ` ${spread}` : ''}`);
  }
  return { tx, maxFee };
}

/**
 * Gas counted, in the fee shown before a deposit, for a step that can only be estimated once the step before it is
 * mined (the approval after a reset, the deposit after an approval). Above today's real limits (about 60 000 and
 * 175 000) and above the ones EIP-8037 brings. They only size the figure shown: every step is still sent with its own estimate.
 */
export const APPROVE_GAS_ALLOWANCE = 250_000n;
export const DEPOSIT_GAS_ALLOWANCE = 400_000n;

/** The network fee of a deposit's next step would pass the maximum the screen showed. */
export class FeeAboveShown extends Error {
  constructor() { super('The network fee rose above the maximum shown, so nothing more was signed. Check the new figure and try again.'); }
}

/**
 * The most a deposit's transactions may cost in network fees, shown before the first signature and then held to by
 * deposit(): the steps it needs now, at the fees of now (EthRpc.fees), with half as much again for the base fee moving
 * while it runs. The first step's gas is its real estimate; a later step's is its allowance above.
 */
export async function depositFeeMax(a: Pick<DepositArgs, 'rpc' | 'vault' | 'token' | 'decimals' | 'resetAllowanceFirst' | 'from' | 'units' | 'ownerScheme' | 'ownerHex' | 'minMinted'>): Promise<bigint> {
  return (await depositFeeQuote(a)).max;
}

/** depositFeeMax, with what the screen says beside it when the chain's RPCs disagree about the base fee (R15-CL-1). */
export async function depositFeeQuote(a: Pick<DepositArgs, 'rpc' | 'vault' | 'token' | 'decimals' | 'resetAllowanceFirst' | 'from' | 'units' | 'ownerScheme' | 'ownerHex' | 'minMinted'>): Promise<{ max: bigint; note: string | null }> {
  const [fees, current] = await Promise.all([a.rpc.fees(), allowance(a.rpc, a.token, a.from, a.vault)]);
  const approvals = approvalSteps(a.token, a.vault, current, tokenAmount(a.units, a.decimals), a.resetAllowanceFirst);
  const steps = [
    ...approvals.map(call => ({ call, allowed: APPROVE_GAS_ALLOWANCE })),
    { call: { to: a.vault, data: depositData(a.units, a.ownerScheme, a.ownerHex, a.minMinted) }, allowed: DEPOSIT_GAS_ALLOWANCE },
  ];
  const first = await a.rpc.estimateGas({ from: a.from, to: steps[0].call.to, data: steps[0].call.data })
    .then(g => { const limit = (g * 125n) / 100n; return limit > MAX_GAS ? MAX_GAS : limit; }, () => steps[0].allowed);
  const gas = steps.slice(1).reduce((sum, s) => sum + s.allowed, first);
  return { max: (gas * fees.maxFeePerGas * 3n) / 2n, note: feeSpreadNote(a.rpc.name, fees.spread) };
}

/** A network fee as the screen shows a maximum: in the chain's coin, 6 decimals, rounded up (never under what is held to). */
export function feeMaxText(wei: bigint): string {
  const step = 10n ** 12n;
  const up = ((wei + step - 1n) / step).toString().padStart(7, '0');
  return `${up.slice(0, -6)}.${up.slice(-6)}`.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Prepares the step after one that was just mined. A load-balanced RPC can answer the estimate from a node a block behind,
 * where the allowance is still the old one, so USDT's approve or the deposit would revert. Nothing is signed until an estimate succeeds.
 */
async function prepareAfterMined(rpc: EthRpc, from: string, call: Call): Promise<PreparedTx> {
  for (let tries = 0; ; tries++) {
    try { return await prepareTx(rpc, from, call); } catch (e) {
      if (tries >= ESTIMATE_RETRIES) throw e;
      await new Promise(res => setTimeout(res, ESTIMATE_RETRY_MS));
    }
  }
}

/** Signs for this chain only, sends, and answers the hash (a lost answer is checked against the network). */
export async function signAndSend(rpc: EthRpc, p: PreparedTx, key: Uint8Array): Promise<string> {
  if (p.tx.chainId !== rpc.chainId) throw new Error('This transaction is for another chain. Nothing was signed.');
  await rpc.assertChain();
  setSignableChains([rpc.chainId]);
  const { raw, hash } = signTx(p.tx, key);
  try {
    const got = await rpc.sendRaw(raw);
    if (typeof got === 'string' && got.toLowerCase() !== hash.toLowerCase()) throw new Error('The network answered with another transaction hash.');
    return hash;
  } catch (e) {
    if (await rpc.knows(hash).catch(() => false)) return hash;
    // The RPC's own words, said as its own (run 21 round 2, R21-W2-5).
    if (e instanceof RpcError) throw new Error(`${rpc.name} refused the transaction: its RPC said ${quoted(e.message)}.`);
    throw e;
  }
}

export async function waitMined(rpc: EthRpc, hash: string, timeoutMs = 10 * 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await rpc.receipt(hash).catch(() => null);
    if (r) return r;
    if (Date.now() > end) throw new Error(`Still waiting for ${rpc.name} to confirm ${hash}.`);
    await new Promise(res => setTimeout(res, 3_000));
  }
}

export interface DepositArgs {
  rpc: EthRpc; vault: string; token: string; decimals: number; resetAllowanceFirst: boolean;
  from: string; key: Uint8Array; units: bigint; ownerScheme: number; ownerHex: string;
  /** The least this deposit may mint: what the screen showed, less minMintedOf's slack. The vault reverts under it. */
  minMinted: bigint;
  /** The most all of this deposit's transactions may cost in network fees: what the screen showed (depositFeeMax). A step that would pass it is not signed. */
  maxNetworkFee: bigint;
  /** Called right before every signature; it throws to stop there (the form no longer shows what was clicked). */
  beforeSign?: () => void;
  onStep?: (step: 'reset' | 'approve' | 'deposit', hash: string) => void;
}

/** The whole deposit: approvals, then the deposit, then its event checked against what was asked. */
export async function deposit(a: DepositArgs): Promise<{ hash: string; event: DepositEvent }> {
  const amount = tokenAmount(a.units, a.decimals);
  const bal = await tokenBalance(a.rpc, a.token, a.from);
  if (bal < amount) throw new Error('Not enough USDT.');
  const steps = approvalSteps(a.token, a.vault, await allowance(a.rpc, a.token, a.from, a.vault), amount, a.resetAllowanceFirst);
  // The fee ceilings of what was signed so far: the next step is signed only while their sum stays within what was shown.
  let fees = 0n;
  const sign = async (p: PreparedTx): Promise<string> => {
    if (fees + p.maxFee > a.maxNetworkFee) throw new FeeAboveShown();
    a.beforeSign?.();
    fees += p.maxFee;
    return signAndSend(a.rpc, p, a.key);
  };
  for (const [i, call] of steps.entries()) {
    // An estimate like every other transaction: gas schedules change with forks (EIP-8037 takes a new allowance past 100 000).
    const p = await (i > 0 ? prepareAfterMined : prepareTx)(a.rpc, a.from, call);
    const hash = await sign(p);
    a.onStep?.(steps.length === 2 && i === 0 ? 'reset' : 'approve', hash);
    const r = await waitMined(a.rpc, hash);
    if (!r.ok) throw new Error('The approval failed on chain.');
  }
  const p = await (steps.length ? prepareAfterMined : prepareTx)(a.rpc, a.from, { to: a.vault, data: depositData(a.units, a.ownerScheme, a.ownerHex, a.minMinted) });
  const hash = await sign(p);
  a.onStep?.('deposit', hash);
  const r = await waitMined(a.rpc, hash);
  if (!r.ok) throw new Error('The deposit failed on chain; no USDT was taken.');
  const event = depositEventOf(r.logs, a.vault);
  if (!event || event.owner !== a.ownerHex || event.ownerScheme !== a.ownerScheme || event.units !== a.units) {
    throw new Error('The deposit went through but its event does not match. Check its status before trying again.');
  }
  return { hash, event };
}

/** The address of a secp256k1 key (for a check that the key is the account's). */
export const addressOfKey = (priv: Uint8Array): string => '0x' + bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(12));
