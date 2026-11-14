import { ethers } from "hardhat";
import { expect } from "chai";
import type { BaseContract, ContractTransactionResponse, Wallet } from "ethers";
import type { KusdtVault, MockUSDT } from "../typechain-types";

/** SPEC §8 mainnet defaults for the Ethereum vault, in units (10^-6 USDT). */
export const USDT = 1_000_000n;
export const DEFAULTS = {
  feeBps: 20,
  minDepositFee: 500_000n, // 0.50 USDT
  minReleaseFee: 5_000_000n, // 5 USDT
  minDeposit: 10n * USDT,
  maxDeposit: 100_000n * USDT,
  releaseCapacity: 250_000n * USDT,
  releaseRefillPerSecond: (250_000n * USDT) / 86_400n,
};
export type Params = typeof DEFAULTS;

export const DAY = 86_400;

/** Five deterministic signer keys (tests only), and some outsiders. */
export function makeWallets(tag: string, n: number): Wallet[] {
  return Array.from({ length: n }, (_, i) => new ethers.Wallet(ethers.id(`kusdt-test-${tag}-${i}`)));
}

export function sortByAddress<T extends { address: string }>(ws: T[]): T[] {
  return [...ws].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : BigInt(a.address) > BigInt(b.address) ? 1 : 0));
}

export const RELEASE_TYPES = {
  Release: [
    { name: "redeemId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "units", type: "uint256" },
  ],
};
export const REFUND_TYPES = {
  Refund: [
    { name: "nonce", type: "uint64" },
    { name: "recipient", type: "address" },
    { name: "units", type: "uint256" },
  ],
};

export interface ReleaseMsg {
  redeemId: string;
  recipient: string;
  units: bigint;
}
export interface RefundMsg {
  nonce: bigint;
  recipient: string;
  units: bigint;
}

export interface Domain {
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: string;
}

export async function domainOf(vault: BaseContract, over: Partial<Domain> = {}): Promise<Domain> {
  const { chainId } = await ethers.provider.getNetwork();
  return { name: "kUSDT Vault", version: "1", chainId, verifyingContract: await vault.getAddress(), ...over };
}

/** Signatures by `ws`, in the order given (sort them first for a valid set). */
export async function signRelease(vault: BaseContract, ws: Wallet[], r: ReleaseMsg, over: Partial<Domain> = {}) {
  const d = await domainOf(vault, over);
  return Promise.all(ws.map((w) => w.signTypedData(d, RELEASE_TYPES, r)));
}

export async function signRefund(vault: BaseContract, ws: Wallet[], r: RefundMsg, over: Partial<Domain> = {}) {
  const d = await domainOf(vault, over);
  return Promise.all(ws.map((w) => w.signTypedData(d, REFUND_TYPES, r)));
}

let redeemCounter = 0;
/** A fresh redeemId, derived as SPEC §7 says from a made-up Kaspa outpoint. */
export function newRedeemId(): string {
  redeemCounter++;
  return ethers.solidityPackedKeccak256(
    ["string", "bytes32", "uint32"],
    ["kusdt/redeem/v1", ethers.id(`kaspa-tx-${redeemCounter}`), redeemCounter % 7],
  );
}

/** Reference fee model (SPEC §7). */
export function feeOf(units: bigint, feeBps: bigint | number, minFee: bigint): bigint {
  const prop = (units * BigInt(feeBps) + 9_999n) / 10_000n;
  return prop > minFee ? prop : minFee;
}

/** The custom error a reverted call failed with, decoded with the vault's ABI. */
export async function revertName(vault: KusdtVault, p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e: any) {
    const data: string | undefined = e?.data ?? e?.error?.data ?? e?.info?.error?.data;
    if (typeof data === "string" && data.length >= 10) {
      const parsed = vault.interface.parseError(data);
      if (parsed) return parsed.name;
    }
    const m = /reverted with custom error '(\w+)\(/.exec(String(e?.message));
    if (m) return m[1];
    return `unknown: ${String(e?.message).slice(0, 200)}`;
  }
  throw new Error("expected a revert");
}

/** A signature check that must fail: garbage recovers to a random address, which is either
 *  out of order or not a signer. */
export async function expectBadSignatures(vault: KusdtVault, p: Promise<unknown>) {
  const name = await revertName(vault, p);
  expect(["NotASigner", "SignaturesNotSorted"]).to.include(name);
}

export async function gasOf(tx: Promise<ContractTransactionResponse>): Promise<bigint> {
  const rc = await (await tx).wait();
  return rc!.gasUsed;
}

export interface World {
  vault: KusdtVault;
  token: MockUSDT;
  decimals: number;
  scale: bigint;
  signerWallets: Wallet[];
  outsiders: Wallet[];
  owner: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  guardian: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  alice: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  bob: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  carol: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  others: Awaited<ReturnType<typeof ethers.getSigners>>;
}

export async function deployWorld(decimals = 6, params: Params = DEFAULTS, payoutDelay = 0): Promise<World> {
  const [owner, guardian, alice, bob, carol, ...others] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("MockUSDT")).deploy("Mock USDT", "USDT", decimals);
  const signerWallets = makeWallets("signer", 5);
  const outsiders = makeWallets("outsider", 5);
  const vault = await (await ethers.getContractFactory("KusdtVault")).deploy(
    await token.getAddress(),
    decimals,
    signerWallets.map((w) => w.address) as any,
    guardian.address,
    owner.address,
    params,
    payoutDelay, 0, 0
  );
  return {
    vault,
    token,
    decimals,
    scale: 10n ** BigInt(decimals - 6),
    signerWallets,
    outsiders,
    owner,
    guardian,
    alice,
    bob,
    carol,
    others,
  };
}

export async function world6() {
  return deployWorld(6);
}
export async function world18() {
  return deployWorld(18);
}

/** Mints, approves and deposits `units` from `who`. */
export async function depositFrom(w: World, who: World["alice"], units: bigint, scheme = 0, owner = ethers.id("kaspa-owner")) {
  await w.token.mint(who.address, units * w.scale);
  await w.token.connect(who).approve(await w.vault.getAddress(), units * w.scale);
  return w.vault.connect(who).deposit(units, scheme, owner);
}

/** A valid 3-of-5 release (first three signers by address), queued then paid (these worlds have no wait; payout-delay.test.ts covers it). */
export async function releaseWith(w: World, r: ReleaseMsg, n = 3) {
  const sigs = await signRelease(w.vault, sortByAddress(w.signerWallets).slice(0, n), r);
  await w.vault.release(r, sigs);
  return w.vault.executeRelease(r.redeemId);
}

export async function refundWith(w: World, r: RefundMsg, n = 3) {
  const sigs = await signRefund(w.vault, sortByAddress(w.signerWallets).slice(0, n), r);
  await w.vault.refund(r, sigs);
  return w.vault.executeRefund(r.nonce);
}

/** Vault balance in units, which must equal backing + feesAccrued (SPEC §11 accounting). */
export async function expectBooksBalance(w: World) {
  const bal = await w.token.balanceOf(await w.vault.getAddress());
  const fees = await w.vault.feesAccrued();
  const backing = await w.vault.backing();
  expect(bal % w.scale).to.equal(0n);
  expect(bal / w.scale).to.equal(backing + fees);
  expect(bal / w.scale >= fees).to.equal(true);
}
