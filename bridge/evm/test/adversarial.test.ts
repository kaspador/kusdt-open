// Adversarial tests for the vault and its AccessManager setup, and a stateful random-sequence
// fuzz with an exact model. Attackers: stolen signer keys (2 and 3), the token (Ethereum USDT
// with fees, blacklist; BSC-USD at 18 decimals), a depositor or recipient, the guardian, a
// canceller, reentrancy, and timing around pause, unpause and the settings.
//
// Tests proving a bug carry a comment starting "// BUG:". The others are regression tests.
//
// Run: npx hardhat test test/adversarial.test.ts
// More fuzz: ADV_STEPS=2000 ADV_SEED=7 npx hardhat test test/adversarial.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, setBalance, takeSnapshot, time } from "@nomicfoundation/hardhat-network-helpers";
import type { KusdtAccessManager, KusdtVault } from "../typechain-types";
import {
  DEFAULTS,
  USDT,
  deployWorld,
  depositFrom,
  expectBadSignatures,
  feeOf,
  makeWallets,
  newRedeemId,
  revertName,
  signRefund,
  signRelease,
  sortByAddress,
  type Params,
  type World,
} from "./helpers";
import { HOUR, ROLES, checkOwnerConfig, setupCalls } from "../scripts/access-manager";

const WAIT = 600;
const DAY = 86_400;

const quorum = (w: World, n = 3) => sortByAddress(w.signerWallets).slice(0, n);
const release = async (w: World, r: { redeemId: string; recipient: string; units: bigint }) => w.vault.release(r, await signRelease(w.vault, quorum(w), r));
const refund = async (w: World, r: { nonce: bigint; recipient: string; units: bigint }) => w.vault.refund(r, await signRefund(w.vault, quorum(w), r));
const addr = (w: World) => w.vault.getAddress();
const minFee = DEFAULTS.minReleaseFee;
/** The gross units of a release that pays out `net`, under the default fees (min fee 5 USDT applies below 2 500 USDT). */
const grossFor = (net: bigint) => net + minFee;

async function funded() {
  const w = await deployWorld(6, DEFAULTS, WAIT);
  await depositFrom(w, w.alice, 50_000n * USDT);
  return w;
}

const CAP = 1_000n * USDT;
async function tight() {
  const w = await deployWorld(6, { ...DEFAULTS, releaseCapacity: CAP, releaseRefillPerSecond: CAP / BigInt(DAY) }, WAIT);
  await depositFrom(w, w.alice, 20_000n * USDT);
  return w;
}

/** A vault on a token other than MockUSDT, with the same signers and parties as deployWorld. */
async function worldOn(tokenFactory: "FeeOnTransferToken" | "ReentrantToken", args: unknown[], delay = WAIT) {
  const base = await deployWorld(6, DEFAULTS, delay);
  const token: any = await (await ethers.getContractFactory(tokenFactory)).deploy(...(args as any));
  const vault = (await (await ethers.getContractFactory("KusdtVault")).deploy(
    await token.getAddress(),
    6,
    base.signerWallets.map((s) => s.address) as any,
    base.guardian.address,
    base.owner.address,
    DEFAULTS,
    delay, 0, 0
  )) as unknown as KusdtVault;
  return { ...base, vault, token: token as any } as unknown as World & { token: any };
}

describe("adversarial: 2 stolen signer keys", () => {
  it("can't reach a quorum: a short list, a repeated key, a non-signer, a malleated signature", async () => {
    const w = await loadFixture(funded);
    const r = { redeemId: newRedeemId(), recipient: w.carol.address, units: 1_000n * USDT };
    const [a, b] = quorum(w);
    const [sa, sb] = await signRelease(w.vault, [a, b], r);
    await expect(w.vault.release(r, [sa, sb])).to.be.revertedWithCustomError(w.vault, "NotEnoughSignatures");
    await expect(w.vault.release(r, [sa, sb, sb])).to.be.revertedWithCustomError(w.vault, "SignaturesNotSorted");
    await expect(w.vault.release(r, [sa, sa, sb])).to.be.revertedWithCustomError(w.vault, "SignaturesNotSorted");

    const outsider = makeWallets("adv-outsider", 1);
    const three = sortByAddress([a, b, ...outsider]);
    const sigs = await signRelease(w.vault, three, r);
    expect(await revertName(w.vault, w.vault.release(r, sigs))).to.equal("NotASigner");

    // The same key with its signature malleated (s -> n - s) must not count as another signer.
    const sig = ethers.Signature.from(sb);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const flipped = ethers.concat([sig.r, ethers.toBeHex(n - BigInt(sig.s), 32), sig.v === 27 ? "0x1c" : "0x1b"]);
    await expect(w.vault.release(r, [sa, sb, flipped])).to.be.reverted;
    expect(await w.vault.reservedUnits()).to.equal(0n);
  });

  it("the same refund and release can't be built from 2 signatures either, and no key is spent on another type, chain or vault", async () => {
    const w = await loadFixture(funded);
    const minted = await w.vault.depositMinted(0);
    const rf = { nonce: 0n, recipient: w.carol.address, units: minted };
    const [a, b, c] = quorum(w);
    await expect(w.vault.refund(rf, await signRefund(w.vault, [a, b], rf))).to.be.revertedWithCustomError(w.vault, "NotEnoughSignatures");

    const r = { redeemId: newRedeemId(), recipient: w.carol.address, units: 1_000n * USDT };
    // A quorum signed for another chain.
    await expectBadSignatures(w.vault, w.vault.release(r, await signRelease(w.vault, [a, b, c], r, { chainId: 999n })));
    // A quorum signed for another vault (same signers).
    const other = await deployWorld(6, DEFAULTS, WAIT);
    await expectBadSignatures(w.vault, w.vault.release(r, await signRelease(other.vault, [a, b, c], r)));
    // A refund signature replayed as a release (same fields, other type).
    const rfAsRelease = { nonce: 0n, recipient: r.recipient, units: r.units };
    await expectBadSignatures(w.vault, w.vault.release(r, await signRefund(w.vault, [a, b, c], rfAsRelease)));
  });
});

describe("adversarial: 3 stolen signer keys (the loss must be bounded)", () => {
  it("splitting small: queued payouts never add up to more than one allowance", async () => {
    const w = await loadFixture(tight);
    const each = grossFor(50n * USDT); // 50 paid, 5 fee
    let net = 0n;
    for (let i = 0; i < 30; i++) {
      const r = { redeemId: newRedeemId(), recipient: w.carol.address, units: each };
      const name = await revertName(w.vault, release(w, r)).catch(() => "ok");
      if (name === "ok") net += each - feeOf(each, DEFAULTS.feeBps, minFee);
      else {
        expect(name).to.equal("ReleaseLimit");
        break;
      }
    }
    expect(net).to.be.at.most(CAP);
    expect(net).to.be.greaterThan(CAP - 2n * each);
  });

  it("every payout route stops when the guardian pauses one second before it is ready, and the thief gets nothing", async () => {
    const w = await loadFixture(tight);
    const r = { redeemId: newRedeemId(), recipient: w.carol.address, units: grossFor(100n * USDT) };
    await release(w, r);
    await depositFrom(w, w.alice, 100n * USDT);
    const before = await w.token.balanceOf(await addr(w));
    const nonce = (await w.vault.depositNonce()) - 1n;
    const minted = await w.vault.depositMinted(nonce);
    await refund(w, { nonce, recipient: w.carol.address, units: minted });
    const readyAt = (await w.vault.pendingReleases(r.redeemId)).readyAt;
    await time.setNextBlockTimestamp(readyAt - 1n);
    await w.vault.connect(w.guardian).pause();
    await time.increaseTo(readyAt + 100n);
    await expect(w.vault.connect(w.carol).executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "EnforcedPause");
    await expect(w.vault.connect(w.carol).executeRefund(nonce)).to.be.revertedWithCustomError(w.vault, "EnforcedPause");
    await expect(release(w, { redeemId: newRedeemId(), recipient: w.carol.address, units: grossFor(10n * USDT) })).to.be.revertedWithCustomError(w.vault, "EnforcedPause");
    expect(await w.token.balanceOf(w.carol.address)).to.equal(0n);
    expect(await w.token.balanceOf(await addr(w))).to.equal(before);
  });

  it("a payout can't be paid a second before readyAt, nor a second before payoutsResumeAt", async () => {
    const w = await loadFixture(tight);
    const r = { redeemId: newRedeemId(), recipient: w.carol.address, units: grossFor(100n * USDT) };
    await release(w, r);
    const readyAt = (await w.vault.pendingReleases(r.redeemId)).readyAt;
    await time.setNextBlockTimestamp(readyAt - 1n);
    await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "PayoutNotReady").withArgs(readyAt);
    await w.vault.connect(w.guardian).pause();
    await time.increase(WAIT + 10);
    await w.vault.unpause();
    const resume = await w.vault.payoutsResumeAt();
    await time.setNextBlockTimestamp(resume - 1n);
    await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "PayoutNotReady").withArgs(resume);
    await time.setNextBlockTimestamp(resume);
    await expect(w.vault.executeRelease(r.redeemId)).to.emit(w.vault, "Released");
  });

  it("the most that leaves in a 24 h window: under one allowance + a day's refill + one queue (2.99x the ceiling reachable)", async () => {
    // Note: the bound asked for (capacity + refill*t + one queue) holds. SPEC §8's
    // "twice the ceiling" is about the allowance alone: with the queue it can reach almost 3x.
    const w = await loadFixture(tight);
    const refill = CAP / BigInt(DAY);
    const carol = w.carol.address;
    const queueAll = async () => {
      // The allowance is drawn in gross units, so the whole bucket is one burn of that many units.
      const units = await w.vault.releaseAvailable();
      const r = { redeemId: newRedeemId(), recipient: carol, units };
      await release(w, r);
      return r;
    };
    // The queue is filled, and sits unpaid for a day while the allowance refills.
    const a = await queueAll();
    await time.increase(DAY);
    // The window starts now: pay the old queue, queue the whole refilled allowance...
    const windowStart = BigInt(await time.latest());
    const backingAtStart = await w.vault.backing();
    await w.vault.executeRelease(a.redeemId);
    const b = await queueAll();
    await time.increase(WAIT);
    await w.vault.executeRelease(b.redeemId);
    // ...and just before the window ends, whatever refilled meanwhile.
    await time.increaseTo(windowStart + BigInt(DAY - WAIT - 5));
    const c = await queueAll();
    await time.increase(WAIT);
    await w.vault.executeRelease(c.redeemId);
    const end = BigInt(await time.latest());
    expect(end - windowStart).to.be.at.most(BigInt(DAY));

    const paid = await w.token.balanceOf(carol);
    expect(paid).to.be.at.most(CAP + refill * BigInt(DAY) + CAP);
    expect(paid).to.be.greaterThan(2n * CAP);
    // Fees included: what left the backing in the window is under the bound too.
    expect(backingAtStart - (await w.vault.backing())).to.be.at.most(CAP + refill * BigInt(DAY) + CAP);
  });

  it("refunds draw the same allowance and can only name real deposits for exactly what they minted", async () => {
    const w = await deployWorld(6, { ...DEFAULTS, releaseCapacity: 1_500n * USDT, releaseRefillPerSecond: 0n, maxDeposit: 2_000n * USDT }, WAIT);
    await depositFrom(w, w.alice, 1_000n * USDT);
    await depositFrom(w, w.alice, 1_000n * USDT);
    const minted = await w.vault.depositMinted(0);
    await expect(refund(w, { nonce: 0n, recipient: w.carol.address, units: minted + 1n })).to.be.revertedWithCustomError(w.vault, "WrongRefundAmount");
    await expect(refund(w, { nonce: 99n, recipient: w.carol.address, units: minted })).to.be.revertedWithCustomError(w.vault, "UnknownDeposit");
    await refund(w, { nonce: 0n, recipient: w.carol.address, units: minted });
    // The second would go over the 1 500 ceiling.
    await expect(refund(w, { nonce: 1n, recipient: w.carol.address, units: await w.vault.depositMinted(1) })).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");
  });

  it("the allowance counts the fee too: a release of fee + 1 unit draws its gross units, moving the fee from backing to feesAccrued (the Safe's, not the thief's)", async () => {
    // SPEC §7 draws the gross `units`: the fee leaves the backing as well, so moving fees out of the
    // backing is limited by the allowance too. The fee stays in the vault and only the owner can withdraw it.
    const w = await loadFixture(tight);
    const bucket = await w.vault.releaseAvailable();
    const backing = await w.vault.backing();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = { redeemId: newRedeemId(), recipient: w.carol.address, units: minFee + 1n };
      await release(w, r);
      ids.push(r.redeemId);
    }
    // Ten gross draws, less the seconds of refill the ten transactions took.
    expect(bucket - (await w.vault.releaseAvailable())).to.be.closeTo(10n * (minFee + 1n), (CAP / BigInt(DAY)) * 15n);
    await time.increase(WAIT);
    for (const id of ids) await w.vault.executeRelease(id);
    expect(await w.vault.backing()).to.equal(backing - 10n * (minFee + 1n));
    expect(await w.token.balanceOf(w.carol.address)).to.equal(10n); // all the thief got
  });

  it("the bucket and the queue survive pause and cancel games: no more paid than the allowance allowed", async () => {
    const w = await loadFixture(tight);
    const r = { redeemId: newRedeemId(), recipient: w.carol.address, units: CAP - 1_000n };
    await release(w, r);
    await w.vault.connect(w.guardian).pause();
    await w.vault.cancelRelease(r.redeemId); // the owner clears it
    await w.vault.unpause();
    // The stolen signatures are still those of current signers, and they no longer bring a cancelled payout back.
    await expect(release(w, r)).to.be.revertedWithCustomError(w.vault, "PayoutCancelled");
    // Reinstated by the owner (after the signers are replaced, in a real incident), it is under the wait and the allowance again.
    await w.vault.reinstateRelease(r.redeemId);
    await release(w, r);
    await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "PayoutNotReady");
    await expect(release(w, { redeemId: newRedeemId(), recipient: w.carol.address, units: grossFor(CAP) })).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");
  });
});

describe("adversarial: the token (real USDT and BSC-USD behaviour)", () => {
  it("USDT with fees switched on: deposits are refused cleanly; payouts debit the vault exactly, the recipient bears Tether's fee, the books still balance", async () => {
    const w = await worldOn("FeeOnTransferToken", [50n]); // 0.5 %, taken from the amount sent
    const vault = await addr(w);
    await w.token.mint(w.alice.address, 1_000n * USDT);
    await w.token.connect(w.alice).approve(vault, 1_000n * USDT);
    await expect(w.vault.connect(w.alice).deposit(1_000n * USDT, 0, ethers.id("o"))).to.be.revertedWithCustomError(w.vault, "WrongAmountReceived");
    expect(await w.vault.depositNonce()).to.equal(0n);

    await w.token.mint(vault, 10_000n * USDT); // the fee is switched on after deposits were made
    const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT };
    await release(w, r);
    await time.increase(WAIT);
    const before = await w.token.balanceOf(vault);
    await w.vault.executeRelease(r.redeemId);
    const fee = feeOf(r.units, DEFAULTS.feeBps, minFee);
    const payout = r.units - fee;
    expect(before - (await w.token.balanceOf(vault))).to.equal(payout);
    expect(await w.token.balanceOf(w.bob.address)).to.equal(payout - (payout * 50n) / 10_000n);
    expect(await w.vault.feesAccrued()).to.equal(fee);
    expect(await w.vault.backing()).to.equal(10_000n * USDT - r.units);
    expect(await w.vault.reservedUnits()).to.equal(0n);
  });

  it("a blacklisted depositor is refused with nothing recorded", async () => {
    const w = await loadFixture(funded);
    const nonce = await w.vault.depositNonce();
    await w.token.mint(w.bob.address, 100n * USDT);
    await w.token.connect(w.bob).approve(await addr(w), 100n * USDT);
    await w.token.addBlackList(w.bob.address);
    await expect(w.vault.connect(w.bob).deposit(100n * USDT, 0, ethers.id("o"))).to.be.reverted;
    expect(await w.vault.depositNonce()).to.equal(nonce);
  });

  it("the token takes funds: nothing new queues against what is gone, payouts stop cleanly at what is left, and cancel still works", async () => {
    const w = await loadFixture(funded);
    const vault = await addr(w);
    const a = { redeemId: newRedeemId(), recipient: w.bob.address, units: 10_000n * USDT };
    await release(w, a);
    const r1 = { redeemId: newRedeemId(), recipient: w.bob.address, units: 20_000n * USDT };
    await release(w, r1);
    const r2 = { redeemId: newRedeemId(), recipient: w.bob.address, units: 10_000n * USDT };
    await release(w, r2);
    await time.increase(WAIT);
    const signer = await ethers.getImpersonatedSigner(vault);
    await setBalance(vault, 10n ** 18n);
    const bal = await w.token.balanceOf(vault);
    await w.token.connect(signer).transfer(w.carol.address, bal - 25_000n * USDT); // keep 25 000
    const reserved = await w.vault.reservedUnits();
    expect(await w.vault.backing()).to.be.lessThan(reserved);
    await expect(release(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT })).to.be.revertedWithCustomError(w.vault, "InsufficientBacking");
    await expect(w.vault.executeRelease(r1.redeemId)).to.emit(w.vault, "Released");
    // What remains can't pay r2.
    await expect(w.vault.executeRelease(r2.redeemId)).to.be.revertedWithCustomError(w.vault, "InsufficientBacking");
    await w.vault.cancelRelease(r2.redeemId);
    await expect(w.vault.executeRelease(a.redeemId)).to.be.revertedWithCustomError(w.vault, "InsufficientBacking");
    await w.vault.cancelRelease(a.redeemId);
    expect(await w.vault.reservedUnits()).to.equal(0n);
  });

  it("the token blacklists the vault: payouts revert with the queue intact, and resume when it is lifted; the owner can always cancel", async () => {
    const w = await loadFixture(funded);
    const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT };
    await release(w, r);
    await time.increase(WAIT);
    await w.token.addBlackList(await addr(w));
    await expect(w.vault.executeRelease(r.redeemId)).to.be.reverted;
    expect((await w.vault.pendingReleases(r.redeemId)).units).to.equal(r.units);
    expect(await w.vault.reservedUnits()).to.equal(r.units);
    await w.token.removeBlackList(await addr(w));
    await expect(w.vault.executeRelease(r.redeemId)).to.emit(w.vault, "Released");
  });

  it("18 decimals: dust below one unit is ignored by the books, can't be paid out, and amounts stay exact", async () => {
    const w = await deployWorld(18, DEFAULTS, WAIT);
    const vault = await addr(w);
    await depositFrom(w, w.alice, 1_000n * USDT);
    const backing = await w.vault.backing();
    const fees = await w.vault.feesAccrued();
    await w.token.mint(vault, w.scale - 1n); // dust just under one unit
    expect(await w.vault.backing()).to.equal(backing);
    expect(await w.vault.feesAccrued()).to.equal(fees);
    const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: backing };
    await release(w, r);
    await time.increase(WAIT);
    await w.vault.executeRelease(r.redeemId);
    const fee = feeOf(backing, DEFAULTS.feeBps, minFee);
    expect(await w.token.balanceOf(w.bob.address)).to.equal((backing - fee) * w.scale);
    expect(await w.vault.backing()).to.equal(0n);
    // Fees are paid in whole units; the dust stays.
    const allFees = await w.vault.feesAccrued();
    await w.vault.withdrawFees(w.owner.address, allFees);
    expect(await w.token.balanceOf(vault)).to.equal(w.scale - 1n);
    expect(await w.vault.backing()).to.equal(0n);
    // Two lots of dust make one whole unit of unaccounted backing, never more.
    await w.token.mint(vault, w.scale - 1n);
    expect(await w.vault.backing()).to.equal(1n);
    expect(await w.vault.feesAccrued()).to.equal(0n);
  });

  it("18 decimals: the fee boundaries pay exactly what they should, in token wei", async () => {
    const w = await deployWorld(18, { ...DEFAULTS, minReleaseFee: 0n }, WAIT);
    await depositFrom(w, w.alice, 1_000n * USDT);
    // 1 unit: the fee rounds up to 1, so nothing would be paid: refused.
    await expect(release(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: 1n })).to.be.revertedWithCustomError(w.vault, "AmountNotAboveFee");
    const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 2n };
    await release(w, r); // fee 1, payout 1
    await time.increase(WAIT);
    await w.vault.executeRelease(r.redeemId);
    expect(await w.token.balanceOf(w.bob.address)).to.equal(1n * w.scale);
  });
});

describe("adversarial: reentrancy (a token that calls back into the vault)", () => {
  async function hooked() {
    const w = await worldOn("ReentrantToken", []);
    await w.token.mint(w.alice.address, 10_000n * USDT);
    await w.token.connect(w.alice).approve(await addr(w), 10_000n * USDT);
    await w.vault.connect(w.alice).deposit(5_000n * USDT, 0, ethers.id("o"));
    return w;
  }

  async function reenterName(w: World & { token: any }) {
    expect(await w.token.lastCallOk()).to.equal(false);
    return w.vault.interface.parseError(await w.token.lastReturn())?.name;
  }

  it("executeRelease, executeRefund, deposit, release, refund and withdrawFees can't be entered from a token transfer", async () => {
    const w = await hooked();
    const vault = await addr(w);
    const a = { redeemId: newRedeemId(), recipient: w.bob.address, units: 500n * USDT };
    const b = { redeemId: newRedeemId(), recipient: w.bob.address, units: 500n * USDT };
    await release(w, a);
    await release(w, b);
    await time.increase(WAIT);

    // executeRelease -> executeRelease(b)
    await w.token.arm(vault, w.vault.interface.encodeFunctionData("executeRelease", [b.redeemId]));
    await w.vault.executeRelease(a.redeemId);
    expect(await reenterName(w)).to.equal("ReentrancyGuardReentrantCall");
    expect((await w.vault.pendingReleases(b.redeemId)).units).to.equal(b.units);

    // deposit -> deposit, and deposit -> release with valid signatures
    await w.token.arm(vault, w.vault.interface.encodeFunctionData("deposit", [100n * USDT, 0, ethers.id("o")]));
    await w.vault.connect(w.alice).deposit(100n * USDT, 0, ethers.id("o"));
    expect(await reenterName(w)).to.equal("ReentrancyGuardReentrantCall");

    const c = { redeemId: newRedeemId(), recipient: w.carol.address, units: 100n * USDT };
    const sigs = await signRelease(w.vault, quorum(w), c);
    await w.token.arm(vault, w.vault.interface.encodeFunctionData("release", [c, sigs]));
    await w.vault.connect(w.alice).deposit(100n * USDT, 0, ethers.id("o"));
    expect(await reenterName(w)).to.equal("ReentrancyGuardReentrantCall");
    expect((await w.vault.pendingReleases(c.redeemId)).units).to.equal(0n);

    // withdrawFees -> executeRelease(b), and executeRelease -> refund
    await w.token.arm(vault, w.vault.interface.encodeFunctionData("executeRelease", [b.redeemId]));
    await w.vault.withdrawFees(w.owner.address, 1n);
    expect(await reenterName(w)).to.equal("ReentrancyGuardReentrantCall");

    const minted = await w.vault.depositMinted(0);
    const rf = { nonce: 0n, recipient: w.carol.address, units: minted };
    const rfSigs = await signRefund(w.vault, quorum(w), rf);
    await w.token.arm(vault, w.vault.interface.encodeFunctionData("refund", [rf, rfSigs]));
    await w.vault.executeRelease(b.redeemId);
    expect(await reenterName(w)).to.equal("ReentrancyGuardReentrantCall");
    expect(await w.vault.depositMinted(0)).to.equal(minted);
  });
});

describe("adversarial: settings, timing, cancel", () => {
  it("setPayoutDelay never moves a queued payout's time; lowering it can't let the queue out sooner", async () => {
    const w = await loadFixture(funded);
    const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
    await release(w, r);
    const readyAt = (await w.vault.pendingReleases(r.redeemId)).readyAt;
    await w.vault.setPayoutDelay(300);
    await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "PayoutNotReady").withArgs(readyAt);
    await w.vault.setPayoutDelay(86_400);
    await time.increaseTo(readyAt);
    await w.vault.executeRelease(r.redeemId);
  });

  it("setReleaseLimits: raising gives nothing at once; lowering below the queue stops new payouts, keeps the queue payable, and a raise back gives no windfall", async () => {
    const w = await loadFixture(tight);
    const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: CAP - 1_000n };
    await release(w, r);
    await w.vault.setReleaseLimits(10n * CAP, 0n);
    const avail = await w.vault.releaseAvailable();
    expect(avail).to.be.lessThan(2_000_000n); // nothing earned: only the ~1 000 units left and a few seconds of refill
    await w.vault.setReleaseLimits(100n * USDT, 0n);
    await expect(release(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: grossFor(10n * USDT) })).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");
    await w.vault.setReleaseLimits(CAP, CAP / BigInt(DAY));
    expect(await w.vault.releaseAvailable()).to.be.lessThan(2_000_000n);
    await time.increase(WAIT);
    await w.vault.executeRelease(r.redeemId);
    expect(await w.vault.reservedUnits()).to.equal(0n);
  });

  it("rotating the signers doesn't touch what is queued: it must be cancelled too; old signatures stop counting at once", async () => {
    const w = await loadFixture(funded);
    const r = { redeemId: newRedeemId(), recipient: w.carol.address, units: 100n * USDT };
    await release(w, r);
    const fresh = makeWallets("adv-rotation", 5);
    await w.vault.setSigners(fresh.map((x) => x.address) as any);
    const r2 = { redeemId: newRedeemId(), recipient: w.carol.address, units: 100n * USDT };
    expect(await revertName(w.vault, release(w, r2))).to.equal("NotASigner");
    await w.vault.cancelRelease(r.redeemId);
    await time.increase(WAIT);
    await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
    expect(await revertName(w.vault, release(w, r))).to.equal("PayoutCancelled"); // cancelled: nobody re-queues it
    await w.vault.reinstateRelease(r.redeemId);
    expect(await revertName(w.vault, release(w, r))).to.equal("NotASigner"); // and reinstated, the old quorum still can't
  });

  it("cancelling is idempotent and returns the allowance once", async () => {
    const w = await loadFixture(tight);
    const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: grossFor(100n * USDT) };
    await release(w, r);
    await w.vault.cancelRelease(r.redeemId);
    const bucket = await w.vault.releaseBucket();
    await expect(w.vault.cancelRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
    expect(await w.vault.releaseBucket()).to.equal(bucket);
    await time.increase(WAIT);
    await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
    expect(await w.token.balanceOf(w.bob.address)).to.equal(0n);
  });

  it("a paid payout can't be cancelled for a second allowance, and a redeemId or nonce pays once, across a cancel too", async () => {
    const w = await loadFixture(funded);
    const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
    await release(w, r);
    await w.vault.cancelRelease(r.redeemId);
    await expect(release(w, r)).to.be.revertedWithCustomError(w.vault, "PayoutCancelled");
    await expect(w.vault.reinstateRelease(r.redeemId)).to.emit(w.vault, "ReleaseReinstated").withArgs(r.redeemId);
    await expect(w.vault.reinstateRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "NotCancelled");
    await release(w, r);
    await expect(release(w, r)).to.be.revertedWithCustomError(w.vault, "AlreadyRedeemed");
    await time.increase(WAIT);
    await w.vault.executeRelease(r.redeemId);
    await expect(w.vault.cancelRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
    await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
    await expect(release(w, r)).to.be.revertedWithCustomError(w.vault, "AlreadyRedeemed");
    expect(await w.token.balanceOf(w.bob.address)).to.equal(r.units - feeOf(r.units, DEFAULTS.feeBps, minFee));

    await depositFrom(w, w.alice, 1_000n * USDT);
    const nonce = (await w.vault.depositNonce()) - 1n;
    const units = await w.vault.depositMinted(nonce);
    const rf = { nonce, recipient: w.bob.address, units };
    await refund(w, rf);
    await w.vault.cancelRefund(nonce);
    expect(await w.vault.depositMinted(nonce)).to.equal(units);
    await expect(refund(w, rf)).to.be.revertedWithCustomError(w.vault, "PayoutCancelled");
    await expect(w.vault.reinstateRefund(nonce)).to.emit(w.vault, "RefundReinstated").withArgs(nonce);
    await expect(w.vault.reinstateRefund(nonce)).to.be.revertedWithCustomError(w.vault, "NotCancelled");
    await refund(w, rf);
    await time.increase(WAIT);
    await w.vault.executeRefund(nonce);
    await expect(refund(w, rf)).to.be.revertedWithCustomError(w.vault, "AlreadyRefunded");
    await expect(w.vault.cancelRefund(nonce)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
  });

  it("a depositor or recipient can't queue anything, redirect a payout, or block it by racing the coordinator's public signatures", async () => {
    const w = await loadFixture(funded);
    const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
    const sigs = await signRelease(w.vault, quorum(w), r);
    // A stranger front-runs with the coordinator's own signed message: the same payout is queued, once.
    await w.vault.connect(w.carol).release(r, sigs);
    await expect(w.vault.release(r, sigs)).to.be.revertedWithCustomError(w.vault, "AlreadyRedeemed");
    // Changing the recipient breaks the signatures.
    await expectBadSignatures(w.vault, w.vault.connect(w.carol).release({ ...r, redeemId: newRedeemId(), recipient: w.carol.address }, sigs));
    await time.increase(WAIT);
    await w.vault.connect(w.carol).executeRelease(r.redeemId);
    expect(await w.token.balanceOf(w.bob.address)).to.equal(r.units - feeOf(r.units, DEFAULTS.feeBps, minFee));
    expect(await w.token.balanceOf(w.carol.address)).to.equal(0n);

    // Zero, the vault and a too-small amount are refused before anything is drawn.
    await expect(release(w, { redeemId: newRedeemId(), recipient: ethers.ZeroAddress, units: 100n * USDT })).to.be.revertedWithCustomError(w.vault, "BadRecipient");
    await expect(release(w, { redeemId: newRedeemId(), recipient: await addr(w), units: 100n * USDT })).to.be.revertedWithCustomError(w.vault, "BadRecipient");
    // The token contract's own address: a payout there would be stuck in the token for good.
    await expect(release(w, { redeemId: newRedeemId(), recipient: await w.vault.token(), units: 100n * USDT })).to.be.revertedWithCustomError(w.vault, "BadRecipient");
    await expect(release(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: minFee })).to.be.revertedWithCustomError(w.vault, "AmountNotAboveFee");
  });

  it("the guardian can pause and nothing else; a rogue guardian's pauses cost time, never money", async () => {
    const w = await loadFixture(funded);
    const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
    await release(w, r);
    const g = w.vault.connect(w.guardian);
    await expect(g.setSigners(makeWallets("x", 5).map((x) => x.address) as any)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
    await expect(g.setGuardian(w.alice.address)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
    await expect(g.withdrawFees(w.guardian.address, 1n)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
    await expect(g.setPayoutDelay(300)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
    await g.pause();
    await expect(g.unpause()).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
    await expect(g.cancelRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
    await expect(g.pause()).to.be.revertedWithCustomError(w.vault, "EnforcedPause");

    await w.vault.unpause();
    await g.pause(); // again, right after: the wait restarts each time, and only the owner resumes
    await w.vault.setGuardian(w.alice.address);
    await w.vault.unpause();
    await expect(g.pause()).to.be.revertedWithCustomError(w.vault, "NotGuardianOrOwner");
    await time.increase(WAIT);
    await w.vault.executeRelease(r.redeemId);
  });

  it("an empty queue and capacity-0 freeze: nothing can leave, and it can be undone", async () => {
    const w = await loadFixture(funded);
    await w.vault.setReleaseLimits(0n, 0n);
    await expect(release(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT })).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");
    await w.vault.setReleaseLimits(CAP, CAP / BigInt(DAY));
    await time.increase(DAY);
    await release(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT });
  });
});

describe("adversarial: the AccessManager setup", () => {
  const SIX = 6 * HOUR;
  const FORTY_EIGHT = 48 * HOUR;

  async function managed() {
    const [deployer, safe, guardian, rogue, honest, alice, thief] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockUSDT")).deploy("Mock USDT", "USDT", 6);
    const manager = (await (await ethers.getContractFactory("KusdtAccessManager")).deploy(deployer.address)) as unknown as KusdtAccessManager;
    const signerWallets = makeWallets("signer", 5);
    const vault = (await (await ethers.getContractFactory("KusdtVault")).deploy(
      await token.getAddress(),
      6,
      signerWallets.map((x) => x.address) as any,
      guardian.address,
      await manager.getAddress(),
      DEFAULTS,
      WAIT, 0, 0
    )) as unknown as KusdtVault;
    const cfg = checkOwnerConfig({ safe: safe.address, emergencyDelay: SIX, cancellers: [rogue.address, honest.address] }, "adv");
    await manager.connect(deployer).multicall(setupCalls(cfg, await vault.getAddress(), deployer.address, await manager.getAddress()));
    const w = { vault, token, decimals: 6, scale: 1n, signerWallets, alice } as unknown as World;
    await depositFrom(w, alice, 50_000n * USDT);
    return { deployer, safe, guardian, rogue, honest, alice, thief, token, manager, vault, w, vaultAddr: await vault.getAddress(), managerAddr: await manager.getAddress() };
  }
  const data = (m: Awaited<ReturnType<typeof managed>>, fn: string, args: unknown[] = []) => m.vault.interface.encodeFunctionData(fn as any, args as any);

  it("the whole incident: 3 keys queue a theft, the guardian pauses, the Safe rotates, cancels and resumes; nothing leaves, and the thief can't re-queue", async () => {
    const m = await loadFixture(managed);
    const held = await m.token.balanceOf(m.vaultAddr);
    const thefts = [];
    for (let i = 0; i < 3; i++) {
      const r = { redeemId: newRedeemId(), recipient: m.thief.address, units: 1_000n * USDT };
      await release(m.w, r);
      thefts.push(r);
    }
    await m.vault.connect(m.guardian).pause();
    await time.increase(WAIT + 1);
    for (const t of thefts) await expect(m.vault.connect(m.thief).executeRelease(t.redeemId)).to.be.revertedWithCustomError(m.vault, "EnforcedPause");

    const newOnes = makeWallets("adv-new", 5);
    const set = data(m, "setSigners", [newOnes.map((x) => x.address)]);
    await m.manager.connect(m.safe).schedule(m.vaultAddr, set, 0);
    const cancels = thefts.map((t) => data(m, "cancelRelease", [t.redeemId]));
    for (const c of cancels) await m.manager.connect(m.safe).schedule(m.vaultAddr, c, 0);
    const unpause = data(m, "unpause");
    await m.manager.connect(m.safe).schedule(m.vaultAddr, unpause, 0);

    await time.increase(SIX);
    for (const c of cancels) await m.manager.connect(m.safe).execute(m.vaultAddr, c);
    await time.increase(FORTY_EIGHT - SIX);
    await m.manager.connect(m.safe).execute(m.vaultAddr, set);
    await m.manager.connect(m.safe).execute(m.vaultAddr, unpause);

    expect(await m.vault.paused()).to.equal(false);
    expect(await m.vault.reservedUnits()).to.equal(0n);
    expect(await m.token.balanceOf(m.thief.address)).to.equal(0n);
    expect(await m.token.balanceOf(m.vaultAddr)).to.equal(held);
    // The stolen quorum is dead twice over: its payouts are cancelled, and its signatures no longer count.
    await expect(release(m.w, thefts[0])).to.be.revertedWithCustomError(m.vault, "PayoutCancelled");
    const honest = { redeemId: newRedeemId(), recipient: m.alice.address, units: 1_000n * USDT };
    await m.vault.release(honest, await signRelease(m.vault, sortByAddress(newOnes).slice(0, 3), honest));
    expect(await m.vault.reservedUnits()).to.equal(honest.units);
  });

  it("a rogue canceller cancels the Safe's recovery but can't make money leave; the Safe's revocation can't be cancelled, and recovery then works", async () => {
    const m = await loadFixture(managed);
    const r = { redeemId: newRedeemId(), recipient: m.thief.address, units: 1_000n * USDT };
    await release(m.w, r);
    await m.vault.connect(m.guardian).pause();
    const cancel = data(m, "cancelRelease", [r.redeemId]);
    const unpause = data(m, "unpause");
    await m.manager.connect(m.safe).schedule(m.vaultAddr, cancel, 0);
    await m.manager.connect(m.safe).schedule(m.vaultAddr, unpause, 0);
    await m.manager.connect(m.rogue).cancel(m.safe.address, m.vaultAddr, cancel);
    await m.manager.connect(m.rogue).cancel(m.safe.address, m.vaultAddr, unpause);
    expect(await m.vault.paused()).to.equal(true);
    // Pausing is never schedulable, so it can't be cancelled.
    await expect(m.manager.connect(m.rogue).cancel(m.safe.address, m.vaultAddr, data(m, "pause"))).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");

    // Through revokeCanceller: since round 11 revokeRole is guarded, and a canceller could cancel that (test/revoke-guard.test.ts).
    const revoke = m.manager.interface.encodeFunctionData("revokeCanceller", [m.rogue.address]);
    await m.manager.connect(m.safe).schedule(m.managerAddr, revoke, 0);
    await expect(m.manager.connect(m.rogue).cancel(m.safe.address, m.managerAddr, revoke)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
    await time.increase(FORTY_EIGHT);
    await m.manager.connect(m.safe).execute(m.managerAddr, revoke);

    await m.manager.connect(m.safe).schedule(m.vaultAddr, cancel, 0);
    await m.manager.connect(m.safe).schedule(m.vaultAddr, unpause, 0);
    await expect(m.manager.connect(m.rogue).cancel(m.safe.address, m.vaultAddr, cancel)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
    await time.increase(SIX);
    await m.manager.connect(m.safe).execute(m.vaultAddr, cancel);
    await m.manager.connect(m.safe).execute(m.vaultAddr, unpause);
    expect(await m.token.balanceOf(m.thief.address)).to.equal(0n);
    expect(await m.vault.paused()).to.equal(false);
  });

  it("the unmapped functions stay behind ADMIN's 48 h: renounceOwnership is refused even then, and acceptOwnership needs the pending owner", async () => {
    const m = await loadFixture(managed);
    const renounce = data(m, "renounceOwnership");
    await m.manager.connect(m.safe).schedule(m.vaultAddr, renounce, 0);
    await expect(m.manager.connect(m.safe).execute(m.vaultAddr, renounce)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotReady");
    await time.increase(FORTY_EIGHT);
    await expect(m.manager.connect(m.safe).execute(m.vaultAddr, renounce)).to.be.revertedWithCustomError(m.vault, "RenounceDisabled");
    await expect(m.vault.connect(m.thief).acceptOwnership()).to.be.revertedWithCustomError(m.vault, "OwnableUnauthorizedAccount");
    expect(await m.vault.owner()).to.equal(m.managerAddr);
  });

  it("a canceller can't touch the vault directly, and a pause through the manager still needs the PAUSER's Safe", async () => {
    const m = await loadFixture(managed);
    await expect(m.manager.connect(m.rogue).execute(m.vaultAddr, data(m, "pause"))).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
    await expect(m.vault.connect(m.rogue).pause()).to.be.revertedWithCustomError(m.vault, "NotGuardianOrOwner");
    await m.manager.connect(m.safe).execute(m.vaultAddr, data(m, "pause"));
    expect(await m.vault.paused()).to.equal(true);
  });
});

// ── Stateful random-sequence fuzz ─────────────────────────────────────────────────────────
//
// Every call's outcome is predicted exactly by a model (the same order of checks as the
// contract, with the block timestamp fixed beforehand), so any divergence fails the run.

function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const big = (lo: bigint, hi: bigint) => (hi <= lo ? lo : lo + (BigInt(Math.floor(next() * 2 ** 52)) * (hi - lo + 1n)) / 2n ** 52n);
  return { next, int, big };
}

const ADV_STEPS = Number(process.env.ADV_STEPS ?? 500);
const ADV_SEED = Number(process.env.ADV_SEED ?? 20261108);

interface QP {
  recipient: string;
  units: bigint;
  fee: bigint;
  readyAt: bigint;
}

interface Mode {
  varyLimits: boolean;
  tokenAttacks: boolean;
}

async function fuzz(decimals: number, seed: number, mode: Mode) {
  const FCAP = 20_000n * USDT;
  const params: Params = {
    ...DEFAULTS,
    minDeposit: 1n * USDT,
    maxDeposit: 8_000n * USDT,
    releaseCapacity: FCAP,
    releaseRefillPerSecond: FCAP / BigInt(DAY),
  };
  const w = await deployWorld(decimals, params, WAIT);
  const rnd = prng(seed);
  const vaultAddr = await w.vault.getAddress();
  const users = [w.alice, w.bob, w.carol];
  const recipients = w.others.slice(3, 7).map((s) => s.address);
  const signerPool = [w.signerWallets, makeWallets("fuzz-a", 5), makeWallets("fuzz-b", 5)];
  let signersNow = w.signerWallets;
  let signersOld: typeof w.signerWallets | null = null;

  // ─ the model ─
  const m = {
    bal: 0n,
    fees: 0n,
    feeBps: BigInt(params.feeBps),
    minDep: params.minDepositFee,
    minRel: params.minReleaseFee,
    cap: params.releaseCapacity,
    refill: params.releaseRefillPerSecond,
    bucket: params.releaseCapacity,
    updated: BigInt((await ethers.provider.getBlock((await w.vault.deploymentTransaction()!.wait())!.blockNumber))!.timestamp),
    delay: BigInt(WAIT),
    resume: 0n,
    paused: false,
    nonce: 0n,
    reserved: 0n,
    took: false, // the token has taken funds at some point
    black: false, // the vault is blacklisted right now
  };
  m.updated = await w.vault.releaseUpdatedAt();
  const deposits = new Map<bigint, bigint>(); // nonce -> depositMinted
  const rels = new Map<string, QP>();
  const refs = new Map<bigint, QP>();
  const redeemed = new Set<string>();
  /** Cancelled by the owner and not reinstated: release and refund refuse these whatever signatures come with them. */
  const cancelledRels = new Set<string>();
  const cancelledRefs = new Set<bigint>();
  const paidIds = new Set<string>();
  const paidNonces = new Set<bigint>();
  const recipientBal = new Map<string, bigint>(recipients.map((r) => [r, 0n]));
  const paidLog: { t: bigint; net: bigint }[] = [];
  let capPeak = m.cap; // the largest cap since the queue was last empty
  let capEver = m.cap;
  let refillEver = m.refill;
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  const tick = async () => {
    const t = BigInt(await time.latest()) + 1n;
    await time.setNextBlockTimestamp(t);
    return t;
  };
  const jump = async (seconds: number) => time.increaseTo(BigInt(await time.latest()) + BigInt(seconds));
  const attempt = (p: Promise<unknown>) => revertName(w.vault, p).catch(() => "ok");
  const avail = (t: bigint) => {
    const a = m.bucket + (t - m.updated) * m.refill;
    return a > m.cap ? m.cap : a;
  };
  const backing = () => {
    const b = m.bal / w.scale;
    return b > m.fees ? b - m.fees : 0n;
  };
  const unreserved = () => {
    const b = backing();
    return b > m.reserved ? b - m.reserved : 0n;
  };
  const queueGross = () => {
    let s = 0n;
    for (const p of [...rels.values(), ...refs.values()]) s += p.units;
    return s;
  };
  const sign = async (msg: "rel" | "ref", r: any, who: typeof w.signerWallets) => {
    const n = rnd.int(3, 5);
    const picked = sortByAddress(who).slice(0, n);
    return msg === "rel" ? signRelease(w.vault, picked, r) : signRefund(w.vault, picked, r);
  };
  const checkOutcome = (where: string, expected: string, actual: string) => {
    const tokenFail = expected === "TOKEN" && (actual === "Error" || /blacklisted/.test(actual));
    if (expected !== actual && !tokenFail) throw new Error(`step ${where}: expected "${expected}", got "${actual}"`);
  };
  const spendAllowance = (t: bigint, units: bigint) => {
    m.bucket = avail(t) - units;
    m.updated = t;
  };
  const returnAllowance = (t: bigint, units: bigint) => {
    const b = avail(t) + units;
    m.bucket = b > m.cap ? m.cap : b;
    m.updated = t;
  };
  const windowCheck = (where: string, t: bigint) => {
    let sum = 0n;
    for (let i = paidLog.length - 1; i >= 0; i--) {
      sum += paidLog[i].net;
      const bound = 2n * capEver + refillEver * (t - paidLog[i].t);
      if (sum > bound) throw new Error(`step ${where}: ${sum} paid in ${t - paidLog[i].t}s exceeds the bound ${bound}`);
    }
  };

  // ─ the actions ─
  const doDeposit = async (where: string) => {
    const who = users[rnd.int(0, users.length - 1)];
    const r0 = rnd.next();
    const units = r0 < 0.1 ? rnd.big(0n, 2n * USDT) : r0 < 0.15 ? rnd.big(params.maxDeposit, 9_000n * USDT) : rnd.big(1n * USDT, 6_000n * USDT);
    await w.token.mint(who.address, units * w.scale);
    await w.token.connect(who).approve(vaultAddr, units * w.scale);
    const fee = feeOf(units, m.feeBps, m.minDep);
    const exp = m.paused ? "EnforcedPause" : units < params.minDeposit || units > params.maxDeposit ? "DepositOutOfRange" : units <= fee ? "NothingToMint" : "ok";
    await tick();
    const got = await attempt(w.vault.connect(who).deposit(units, rnd.int(0, 4), ethers.id(`owner-${where}`)));
    checkOutcome(where, exp, got);
    bump(`deposit-${got}`);
    if (got === "ok") {
      m.bal += units * w.scale;
      m.fees += fee;
      deposits.set(m.nonce, units - fee);
      m.nonce++;
    }
  };

  const doRelease = async (where: string) => {
    const recipient = recipients[rnd.int(0, recipients.length - 1)];
    const known = [...redeemed];
    const replay = known.length > 0 && rnd.next() < 0.1;
    const id = replay ? known[rnd.int(0, known.length - 1)] : newRedeemId();
    const r0 = rnd.next();
    const units = r0 < 0.1 ? rnd.big(0n, m.minRel + 2n) : r0 < 0.9 ? rnd.big(1n * USDT, 5_000n * USDT) : backing() + rnd.big(1n, 1_000n * USDT);
    const r = { redeemId: id, recipient, units };
    const fee = feeOf(units, m.feeBps, m.minRel);
    const net = units > fee ? units - fee : 0n;
    const bad = rnd.next();
    const useOld = signersOld && bad < 0.04;
    const tooFew = bad >= 0.04 && bad < 0.08;
    const sigs = tooFew
      ? await signRelease(w.vault, sortByAddress(signersNow).slice(0, 2), r)
      : await sign("rel", r, useOld ? signersOld! : signersNow);
    const t = await tick();
    let exp: string;
    if (m.paused) exp = "EnforcedPause";
    else if (redeemed.has(id)) exp = "AlreadyRedeemed";
    else if (cancelledRels.has(id)) exp = "PayoutCancelled";
    else if (units <= fee) exp = "AmountNotAboveFee";
    else if (tooFew) exp = "NotEnoughSignatures";
    else if (useOld) exp = "NotASigner";
    else if (units > unreserved()) exp = "InsufficientBacking";
    else if (m.reserved + units > m.cap || units > avail(t)) exp = "ReleaseLimit";
    else exp = "ok";
    const got = await attempt(w.vault.release(r, sigs));
    checkOutcome(where, exp, got);
    bump(`release-${got}`);
    if (got === "ok") {
      spendAllowance(t, units);
      m.reserved += units;
      redeemed.add(id);
      rels.set(id, { recipient, units, fee, readyAt: t + m.delay });
    }
  };

  const doRefund = async (where: string) => {
    const open = [...deposits.entries()].filter(([, v]) => v > 0n);
    if (open.length === 0 && m.nonce === 0n) return;
    const roll = rnd.next();
    let nonce: bigint;
    let units: bigint;
    if (roll < 0.1) {
      nonce = m.nonce + BigInt(rnd.int(0, 3));
      units = 1n;
    } else if (roll < 0.2 || open.length === 0) {
      nonce = BigInt(rnd.int(0, Number(m.nonce) - 1 < 0 ? 0 : Number(m.nonce) - 1));
      units = deposits.get(nonce) ?? 1n;
    } else {
      [nonce, units] = open[rnd.int(0, open.length - 1)];
      if (roll < 0.25) units += 1n;
    }
    const recipient = recipients[rnd.int(0, recipients.length - 1)];
    const r = { nonce, recipient, units };
    const sigs = await sign("ref", r, signersNow);
    const t = await tick();
    const minted = deposits.get(nonce) ?? 0n;
    let exp: string;
    if (m.paused) exp = "EnforcedPause";
    else if (nonce >= m.nonce) exp = "UnknownDeposit";
    else if (minted === 0n) exp = "AlreadyRefunded";
    else if (cancelledRefs.has(nonce)) exp = "PayoutCancelled";
    else if (units !== minted) exp = "WrongRefundAmount";
    else if (units > unreserved()) exp = "InsufficientBacking";
    else if (m.reserved + units > m.cap || units > avail(t)) exp = "ReleaseLimit";
    else exp = "ok";
    const got = await attempt(w.vault.refund(r, sigs));
    checkOutcome(where, exp, got);
    bump(`refund-${got}`);
    if (got === "ok") {
      spendAllowance(t, units);
      m.reserved += units;
      deposits.set(nonce, 0n);
      refs.set(nonce, { recipient, units, fee: 0n, readyAt: t + m.delay });
    }
  };

  const expectDue = (p: QP | undefined, t: bigint) => {
    if (m.paused) return "EnforcedPause";
    if (!p) return "NothingQueued";
    if (t < p.readyAt) return "PayoutNotReady";
    if (t < m.resume) return "PayoutNotReady";
    if (p.units > backing()) return "InsufficientBacking";
    return m.black ? "TOKEN" : "ok";
  };

  const payOut = (where: string, t: bigint, p: QP, net: bigint) => {
    m.bal -= net * w.scale;
    m.fees += p.fee;
    m.reserved -= p.units;
    recipientBal.set(p.recipient, recipientBal.get(p.recipient)! + net * w.scale);
    paidLog.push({ t, net });
    windowCheck(where, t);
  };

  const doExecuteRelease = async (where: string) => {
    const keys = [...rels.keys()].sort((a, b) => Number(rels.get(a)!.readyAt - rels.get(b)!.readyAt));
    const replay = paidIds.size > 0 && rnd.next() < 0.1;
    const id = replay ? [...paidIds][rnd.int(0, paidIds.size - 1)] : keys.length ? keys[rnd.next() < 0.6 ? 0 : rnd.int(0, keys.length - 1)] : newRedeemId();
    const t = await tick();
    const p = rels.get(id);
    const exp = expectDue(p, t);
    const got = await attempt(w.vault.connect(w.carol).executeRelease(id));
    checkOutcome(where, exp, got);
    bump(`executeRelease-${got}`);
    if (got === "ok") {
      if (paidIds.has(id)) throw new Error(`step ${where}: redeemId paid twice`);
      paidIds.add(id);
      rels.delete(id);
      payOut(where, t, p!, p!.units - p!.fee);
    }
  };

  const doExecuteRefund = async (where: string) => {
    const keys = [...refs.keys()].sort((a, b) => Number(refs.get(a)!.readyAt - refs.get(b)!.readyAt));
    const replay = paidNonces.size > 0 && rnd.next() < 0.1;
    const n = replay ? [...paidNonces][rnd.int(0, paidNonces.size - 1)] : keys.length ? keys[rnd.next() < 0.6 ? 0 : rnd.int(0, keys.length - 1)] : m.nonce + 7n;
    const t = await tick();
    const p = refs.get(n);
    const exp = expectDue(p, t);
    const got = await attempt(w.vault.connect(w.carol).executeRefund(n));
    checkOutcome(where, exp, got);
    bump(`executeRefund-${got}`);
    if (got === "ok") {
      if (paidNonces.has(n)) throw new Error(`step ${where}: nonce paid twice`);
      paidNonces.add(n);
      refs.delete(n);
      payOut(where, t, p!, p!.units);
    }
  };

  const doCancelRelease = async (where: string) => {
    const keys = [...rels.keys()];
    const id = keys.length && rnd.next() > 0.1 ? keys[rnd.int(0, keys.length - 1)] : newRedeemId();
    const t = await tick();
    const p = rels.get(id);
    const got = await attempt(w.vault.connect(w.owner).cancelRelease(id));
    checkOutcome(where, p ? "ok" : "NothingQueued", got);
    bump(`cancelRelease-${got}`);
    if (got === "ok") {
      rels.delete(id);
      redeemed.delete(id);
      cancelledRels.add(id);
      m.reserved -= p!.units;
      returnAllowance(t, p!.units);
    }
    // Sometimes the owner lets it be queued again; reinstating what is not cancelled is refused.
    if (rnd.next() < 0.5) {
      const again = await attempt(w.vault.connect(w.owner).reinstateRelease(id));
      checkOutcome(where, cancelledRels.has(id) ? "ok" : "NotCancelled", again);
      bump(`reinstateRelease-${again}`);
      if (again === "ok") cancelledRels.delete(id);
    }
  };

  const doCancelRefund = async (where: string) => {
    const keys = [...refs.keys()];
    const n = keys.length && rnd.next() > 0.1 ? keys[rnd.int(0, keys.length - 1)] : m.nonce + 9n;
    const t = await tick();
    const p = refs.get(n);
    const got = await attempt(w.vault.connect(w.owner).cancelRefund(n));
    checkOutcome(where, p ? "ok" : "NothingQueued", got);
    bump(`cancelRefund-${got}`);
    if (got === "ok") cancelledRefs.add(n);
    if (got === "ok") {
      refs.delete(n);
      deposits.set(n, p!.units);
      m.reserved -= p!.units;
      returnAllowance(t, p!.units);
    }
    if (rnd.next() < 0.5) {
      const again = await attempt(w.vault.connect(w.owner).reinstateRefund(n));
      checkOutcome(where, cancelledRefs.has(n) ? "ok" : "NotCancelled", again);
      bump(`reinstateRefund-${again}`);
      if (again === "ok") cancelledRefs.delete(n);
    }
  };

  const doPause = async (where: string) => {
    await tick();
    const got = await attempt(w.vault.connect(rnd.next() < 0.7 ? w.guardian : w.owner).pause());
    checkOutcome(where, m.paused ? "EnforcedPause" : "ok", got);
    bump(`pause-${got}`);
    if (got === "ok") m.paused = true;
  };

  const doUnpause = async (where: string) => {
    const t = await tick();
    const got = await attempt(w.vault.connect(w.owner).unpause());
    checkOutcome(where, m.paused ? "ok" : "ExpectedPause", got);
    bump(`unpause-${got}`);
    if (got === "ok") {
      m.paused = false;
      m.resume = t + m.delay;
    }
  };

  const doSetLimits = async (where: string) => {
    const caps = [m.cap / 2n, m.cap, (m.cap * 3n) / 2n, 5_000n * USDT, FCAP, 40_000n * USDT, 0n];
    const cap = caps[rnd.int(0, caps.length - 1)];
    const r0 = rnd.next();
    const max = cap / BigInt(DAY);
    const refill = r0 < 0.1 ? max + 1n : r0 < 0.5 ? max : rnd.big(0n, max);
    const t = await tick();
    const a = avail(t);
    const got = await attempt(w.vault.connect(w.owner).setReleaseLimits(cap, refill));
    checkOutcome(where, refill > max ? "BadLimits" : "ok", got);
    bump(`setLimits-${got}`);
    if (got === "ok") {
      if (m.cap > capPeak) capPeak = m.cap;
      m.cap = cap;
      m.refill = refill;
      m.bucket = a > cap ? cap : a;
      m.updated = t;
      if (cap > capEver) capEver = cap;
      if (refill > refillEver) refillEver = refill;
    }
  };

  const doSetDelay = async (where: string) => {
    const d = rnd.next() < 0.1 ? rnd.int(0, 299) : rnd.int(300, 3_600);
    await tick();
    const got = await attempt(w.vault.connect(w.owner).setPayoutDelay(d));
    checkOutcome(where, d < 300 ? "BadPayoutDelay" : "ok", got);
    bump(`setDelay-${got}`);
    if (got === "ok") m.delay = BigInt(d);
  };

  const doSetFees = async (where: string) => {
    const bps = rnd.int(0, 100);
    const dep = rnd.big(0n, 2n * USDT);
    const rel = rnd.big(0n, 10n * USDT);
    await tick();
    await w.vault.connect(w.owner).setFees(bps, dep, rel);
    m.feeBps = BigInt(bps);
    m.minDep = dep;
    m.minRel = rel;
    bump(`setFees-${where ? "ok" : ""}`);
  };

  const doWithdraw = async (where: string) => {
    const want = rnd.next() < 0.15 ? m.fees + 1n : rnd.big(0n, m.fees);
    await tick();
    const backingBefore = backing();
    const exp = want > m.fees ? "FeesExceeded" : m.black ? "TOKEN" : "ok";
    const got = await attempt(w.vault.connect(w.owner).withdrawFees(w.owner.address, want));
    checkOutcome(where, exp, got);
    bump(`withdraw-${got}`);
    if (got === "ok") {
      m.bal -= want * w.scale;
      m.fees -= want;
      if (!m.took && backing() !== backingBefore) throw new Error(`step ${where}: withdrawFees changed the backing`);
    }
  };

  const doDonate = async () => {
    // Dust below one unit (18 decimals) or a few whole units.
    const amt = rnd.next() < 0.5 ? rnd.big(1n, w.scale > 1n ? w.scale - 1n : 1n) : rnd.big(1n, 50n * USDT) * w.scale;
    await w.token.mint(vaultAddr, amt);
    m.bal += amt;
    bump("donate");
  };

  const doRotate = async (where: string) => {
    const set = signerPool[rnd.int(0, signerPool.length - 1)];
    if (set === signersNow) return;
    await tick();
    const got = await attempt(w.vault.connect(w.owner).setSigners(set.map((x) => x.address) as any));
    checkOutcome(where, "ok", got);
    signersOld = signersNow;
    signersNow = set;
    bump("rotate");
  };

  const doTokenAttack = async () => {
    const r0 = rnd.next();
    if (r0 < 0.5) {
      if (m.black) {
        await w.token.connect(w.owner).removeBlackList(vaultAddr);
        m.black = false;
      } else {
        await w.token.connect(w.owner).addBlackList(vaultAddr);
        m.black = true;
      }
      bump("toggle-blacklist");
    } else if (!m.black && m.bal > 0n && r0 < 0.75) {
      const signer = await ethers.getImpersonatedSigner(vaultAddr);
      await setBalance(vaultAddr, 10n ** 18n);
      const amt = rnd.big(1n, m.bal / 3n > 0n ? m.bal / 3n : 1n);
      await w.token.connect(signer).transfer(w.owner.address, amt);
      m.bal -= amt;
      m.took = true;
      bump("token-took");
    }
  };

  // ─ the invariants, after every step ─
  const check = async (step: number, deep: boolean) => {
    const where = `step ${step}`;
    const v = w.vault;
    const bal = await w.token.balanceOf(vaultAddr);
    expect(bal, `${where}: balance`).to.equal(m.bal);
    expect(await v.feesAccrued(), `${where}: feesAccrued`).to.equal(m.fees);
    const vBacking = await v.backing();
    expect(vBacking, `${where}: backing`).to.equal(backing());
    expect(await v.reservedUnits(), `${where}: reservedUnits`).to.equal(m.reserved);
    let sum = 0n;
    for (const p of [...rels.values(), ...refs.values()]) sum += p.units;
    expect(m.reserved, `${where}: reserved = sum of the queue`).to.equal(sum);
    expect(await v.unreservedBacking(), `${where}: unreserved`).to.equal(unreserved());
    expect(bal / w.scale >= vBacking, `${where}: balance >= backing`).to.equal(true);
    expect(bal >= m.fees * w.scale || m.took, `${where}: the fees are held`).to.equal(true);
    if (!m.took) {
      expect(vBacking >= m.reserved, `${where}: backing >= reserved (${vBacking} < ${m.reserved})`).to.equal(true);
      expect(bal / w.scale, `${where}: balance = backing + fees`).to.equal(vBacking + m.fees);
    }
    // The queue: payouts in it fit one allowance, unless the capacity was lowered since they joined.
    const gross = queueGross();
    if (gross === 0n) capPeak = m.cap;
    if (m.cap > capPeak) capPeak = m.cap;
    expect(gross <= capPeak, `${where}: queue ${gross} over the capacity ${capPeak}`).to.equal(true);
    expect(await v.releaseCapacity(), `${where}: capacity`).to.equal(m.cap);
    expect(await v.releaseRefillPerSecond(), `${where}: refill`).to.equal(m.refill);
    expect(await v.releaseBucket(), `${where}: bucket`).to.equal(m.bucket);
    expect(await v.releaseUpdatedAt(), `${where}: bucket time`).to.equal(m.updated);
    expect(await v.paused(), `${where}: paused`).to.equal(m.paused);
    expect(await v.payoutsResumeAt(), `${where}: resume`).to.equal(m.resume);
    expect(await v.payoutDelay(), `${where}: delay`).to.equal(m.delay);
    expect(await v.depositNonce(), `${where}: nonce`).to.equal(m.nonce);
    if (m.bucket > m.cap) throw new Error(`${where}: the bucket holds more than the capacity`);

    if (deep) {
      for (const [id, p] of rels) {
        const q = await v.pendingReleases(id);
        expect([q.recipient, q.units, q.fee, q.readyAt], `${where}: queued release`).to.deep.equal([p.recipient, p.units, p.fee, p.readyAt]);
        expect(await v.redeemed(id), `${where}: redeemed`).to.equal(true);
      }
      for (const [n, p] of refs) {
        const q = await v.pendingRefunds(n);
        expect([q.recipient, q.units, q.fee, q.readyAt], `${where}: queued refund`).to.deep.equal([p.recipient, p.units, p.fee, p.readyAt]);
      }
      for (const [n, minted] of deposits) {
        expect(await v.depositMinted(n), `${where}: depositMinted ${n}`).to.equal(minted);
        expect(await v.isRefunded(n), `${where}: isRefunded ${n}`).to.equal(minted === 0n);
      }
      for (const id of paidIds) expect(await v.redeemed(id), `${where}: paid id stays redeemed`).to.equal(true);
      for (const [a, b] of recipientBal) expect(await w.token.balanceOf(a), `${where}: recipient`).to.equal(b);
    }
  };

  /** From a snapshot: everything queued can be paid or cancelled (the owner pays; what the token blocks, cancels). */
  const eventually = async (where: string) => {
    const snap = await takeSnapshot();
    try {
      if (m.paused) await w.vault.connect(w.owner).unpause();
      const resume = await w.vault.payoutsResumeAt();
      let latest = resume;
      for (const p of [...rels.values(), ...refs.values()]) if (p.readyAt > latest) latest = p.readyAt;
      const now = BigInt(await time.latest());
      if (latest > now) await time.increaseTo(latest + 1n);
      else await time.increase(1);

      for (const [id, p] of rels) {
        const name = await attempt(w.vault.connect(w.carol).executeRelease(id));
        if (name !== "ok") {
          if (!["InsufficientBacking", "Error"].includes(name) && !/blacklisted/.test(name)) throw new Error(`${where}: release ${p.units} can't be paid: ${name}`);
          const cancelled = await attempt(w.vault.connect(w.owner).cancelRelease(id));
          if (cancelled !== "ok") throw new Error(`${where}: release can't be paid or cancelled: ${cancelled}`);
        }
      }
      for (const [n, p] of refs) {
        const name = await attempt(w.vault.connect(w.carol).executeRefund(n));
        if (name !== "ok") {
          if (!["InsufficientBacking", "Error"].includes(name) && !/blacklisted/.test(name)) throw new Error(`${where}: refund ${p.units} can't be paid: ${name}`);
          const cancelled = await attempt(w.vault.connect(w.owner).cancelRefund(n));
          if (cancelled !== "ok") throw new Error(`${where}: refund can't be paid or cancelled: ${cancelled}`);
        }
      }
      expect(await w.vault.reservedUnits(), `${where}: all paid or cancelled`).to.equal(0n);
    } finally {
      await snap.restore();
    }
    // Second try from the same state: while paused, the owner can always clear the whole queue.
    const snap2 = await takeSnapshot();
    try {
      if (!m.paused) await w.vault.connect(w.owner).pause();
      for (const id of rels.keys()) await w.vault.connect(w.owner).cancelRelease(id);
      for (const n of refs.keys()) await w.vault.connect(w.owner).cancelRefund(n);
      expect(await w.vault.reservedUnits(), `${where}: all cancelled`).to.equal(0n);
      expect(await w.vault.releaseBucket() <= (await w.vault.releaseCapacity()), `${where}: bucket under the capacity`).to.equal(true);
    } finally {
      await snap2.restore();
    }
  };

  // ─ the run ─
  for (let step = 0; step < ADV_STEPS; step++) {
    const roll = rnd.next();
    const where = `${decimals}d-${seed}:${step}`;
    const queueOpen = rels.size + refs.size > 0;
    if (m.paused && rnd.next() < 0.35) await doUnpause(where);
    else if (queueOpen && rnd.next() < 0.12) {
      await jump(rnd.int(300, 1_500));
      bump("time");
    } else if (roll < 0.22) await doDeposit(where);
    else if (roll < 0.42) await doRelease(where);
    else if (roll < 0.49) await doRefund(where);
    else if (roll < 0.6) await doExecuteRelease(where);
    else if (roll < 0.65) await doExecuteRefund(where);
    else if (roll < 0.69) await doCancelRelease(where);
    else if (roll < 0.71) await doCancelRefund(where);
    else if (roll < 0.74) await doPause(where);
    else if (roll < 0.78) await doUnpause(where);
    else if (roll < 0.81) {
      if (mode.varyLimits) await doSetLimits(where);
    } else if (roll < 0.83) await doSetDelay(where);
    else if (roll < 0.85) await doSetFees(where);
    else if (roll < 0.88) await doWithdraw(where);
    else if (roll < 0.9) await doDonate();
    else if (roll < 0.91) await doRotate(where);
    else if (roll < 0.93) {
      if (mode.tokenAttacks) await doTokenAttack();
    } else {
      const r = rnd.next();
      await jump(r < 0.4 ? rnd.int(1, 60) : r < 0.8 ? rnd.int(200, 1_200) : rnd.int(3_600, 12 * 3_600));
      bump("time");
    }
    await check(step, step % 7 === 0 || step === ADV_STEPS - 1);
    if (step % 60 === 59) await eventually(where);
  }
  await check(ADV_STEPS, true);
  await eventually(`final-${decimals}d-${seed}`);
  return counts;
}

describe("adversarial: stateful random sequences (exact model)", () => {
  const modes: { name: string; mode: Mode }[] = [
    { name: "fixed limits", mode: { varyLimits: false, tokenAttacks: false } },
    { name: "changing limits", mode: { varyLimits: true, tokenAttacks: false } },
    { name: "a token that takes funds and blacklists the vault", mode: { varyLimits: true, tokenAttacks: true } },
  ];
  for (const decimals of [6, 18]) {
    modes.forEach(({ name, mode }, i) => {
      it(`${ADV_STEPS} random steps, ${decimals} decimals, ${name} (seed ${ADV_SEED + decimals + i})`, async function () {
        this.timeout(1_800_000);
        const counts = await fuzz(decimals, ADV_SEED + decimals + i, mode);
        for (const k of ["deposit-ok", "release-ok", "refund-ok", "executeRelease-ok", "cancelRelease-ok", "pause-ok", "unpause-ok", "time"]) {
          expect(counts[k] ?? 0, `no ${k} in the run: ${JSON.stringify(counts)}`).to.be.greaterThan(0);
        }
        console.log(`      ${JSON.stringify(counts)}`);
      });
    });
  }
});
