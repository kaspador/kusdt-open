// Every payout waits in the vault, so a watcher can stop a bad one before the money leaves.
// The scenario it exists for: 3 stolen signer keys, splitting the theft into small payouts.
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, setBalance, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { DEFAULTS, USDT, deployWorld, depositFrom, expectBooksBalance, feeOf, newRedeemId, signRefund, signRelease, sortByAddress, type World } from "./helpers";

const WAIT = 600;

async function funded() {
  const w = await deployWorld(6, DEFAULTS, WAIT);
  await depositFrom(w, w.alice, 10_000n * USDT);
  await depositFrom(w, w.alice, 10_000n * USDT);
  return w;
}

const quorum = (w: World) => sortByAddress(w.signerWallets).slice(0, 3);
const release = async (w: World, r: { redeemId: string; recipient: string; units: bigint }) => w.vault.release(r, await signRelease(w.vault, quorum(w), r));
const refund = async (w: World, r: { nonce: bigint; recipient: string; units: bigint }) => w.vault.refund(r, await signRefund(w.vault, quorum(w), r));
const balanceOf = (w: World, a: string) => w.token.balanceOf(a);
const fee = (units: bigint) => feeOf(units, DEFAULTS.feeBps, DEFAULTS.minReleaseFee);

describe("the queue holds at most one allowance", () => {
  // A review paid three daily allowances in three seconds: the allowance is drawn when a payout is queued,
  // and everything queued can be paid in one block once its wait is over.
  const CAP = 1_000n * USDT;
  const DAY = 86_400;

  async function small() {
    const w = await deployWorld(6, { ...DEFAULTS, releaseCapacity: CAP, releaseRefillPerSecond: CAP / BigInt(DAY) }, WAIT);
    await depositFrom(w, w.alice, 5_000n * USDT);
    return w;
  }
  const withId = (w: World, units: bigint) => ({ redeemId: newRedeemId(), recipient: w.bob.address, units });

  it("a full day later, with the allowance refilled, nothing more can join a full queue", async () => {
    const w = await loadFixture(small);
    await release(w, withId(w, CAP));
    await time.increase(DAY + 60); // CAP / DAY rounds down, so a day alone is a few units short of the whole bucket
    expect(await w.vault.releaseAvailable()).to.equal(CAP);
    await expect(release(w, withId(w, 100n * USDT))).to.be.revertedWithCustomError(w.vault, "ReleaseLimit").withArgs(100n * USDT, 0n);
  });

  it("three days of queueing can't add up: at most one allowance is ever paid at once", async () => {
    const w = await loadFixture(small);
    const queued = [withId(w, CAP)];
    await release(w, queued[0]);
    for (let day = 0; day < 3; day++) {
      await time.increase(DAY);
      const more = withId(w, CAP);
      await expect(release(w, more)).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");
    }
    expect(await w.vault.reservedUnits()).to.equal(CAP);
    const before = await balanceOf(w, w.bob.address);
    await w.vault.executeRelease(queued[0].redeemId);
    expect(await balanceOf(w, w.bob.address) - before).to.be.at.most(CAP);
  });

  it("room comes back as soon as what is queued is paid or cancelled", async () => {
    const w = await loadFixture(small);
    const first = withId(w, CAP);
    await release(w, first);
    await time.increase(DAY);
    await w.vault.executeRelease(first.redeemId);
    expect(await w.vault.reservedUnits()).to.equal(0n);
    const second = withId(w, CAP);
    await release(w, second);
    await time.increase(DAY);
    await w.vault.connect(w.owner).cancelRelease(second.redeemId);
    await release(w, withId(w, CAP));
    expect(await w.vault.reservedUnits()).to.equal(CAP);
  });

  it("counts refunds too", async () => {
    const w = await loadFixture(small);
    await release(w, withId(w, CAP));
    await time.increase(DAY);
    await depositFrom(w, w.alice, 100n * USDT);
    const units = await w.vault.depositMinted(1n);
    await expect(refund(w, { nonce: 1n, recipient: w.alice.address, units })).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");
  });

  it("a single payout of the whole allowance still fits an empty queue", async () => {
    const w = await loadFixture(small);
    await expect(release(w, withId(w, CAP))).to.emit(w.vault, "ReleaseQueued");
  });

  it("a burn of exactly the capacity, fee included, is queued and paid; one unit more never fits", async () => {
    const w = await loadFixture(small);
    await expect(release(w, withId(w, CAP + 1n))).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");
    const whole = withId(w, CAP);
    await expect(release(w, whole)).to.emit(w.vault, "ReleaseQueued");
    await time.increase(WAIT);
    const before = await balanceOf(w, w.bob.address);
    await w.vault.executeRelease(whole.redeemId);
    expect(await balanceOf(w, w.bob.address) - before).to.equal(CAP - fee(CAP));
    expect(await w.vault.reservedUnits()).to.equal(0n);
  });

  it("while the owner has lowered the capacity below what is queued, nothing joins, and what is queued still pays", async () => {
    const w = await loadFixture(small);
    const first = withId(w, CAP);
    await release(w, first);
    await w.vault.connect(w.owner).setReleaseLimits(100n * USDT, 1n);
    await expect(release(w, withId(w, 50n * USDT))).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");
    await time.increase(WAIT);
    await w.vault.executeRelease(first.redeemId);
    expect(await w.vault.reservedUnits()).to.equal(0n);
  });
});

describe("the payout wait", () => {
  describe("a release", () => {
    it("is only queued: no USDT moves, and it says when it can be paid", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT };
      const before = await w.vault.backing();
      await expect(await release(w, r)).to.emit(w.vault, "ReleaseQueued");
      expect(await balanceOf(w, w.bob.address)).to.equal(0n);
      expect(await w.vault.backing()).to.equal(before);
      expect(await w.vault.reservedUnits()).to.equal(r.units);
      expect(await w.vault.unreservedBacking()).to.equal(before - r.units);
      expect(await w.vault.redeemed(r.redeemId)).to.equal(true);
      const p = await w.vault.pendingReleases(r.redeemId);
      expect(p.recipient).to.equal(w.bob.address);
      expect(p.units).to.equal(r.units);
      expect(p.fee).to.equal(fee(r.units));
      expect(p.readyAt).to.equal(BigInt(await time.latest()) + BigInt(WAIT));
      await expectBooksBalance(w);
    });

    it("can't be paid a second early, and can be paid by anyone after that", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT };
      await release(w, r);
      const { readyAt } = await w.vault.pendingReleases(r.redeemId);
      await time.setNextBlockTimestamp(readyAt - 1n);
      await expect(w.vault.connect(w.carol).executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "PayoutNotReady").withArgs(readyAt);
      await time.setNextBlockTimestamp(readyAt);
      const f = fee(r.units);
      await expect(w.vault.connect(w.carol).executeRelease(r.redeemId)).to.emit(w.vault, "Released").withArgs(r.redeemId, w.bob.address, r.units, f, r.units - f);
      expect(await balanceOf(w, w.bob.address)).to.equal(r.units - f);
      expect(await w.vault.reservedUnits()).to.equal(0n);
      await expectBooksBalance(w);
    });

    it("is paid once", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT };
      await release(w, r);
      await expect(release(w, r)).to.be.revertedWithCustomError(w.vault, "AlreadyRedeemed");
      await time.increase(WAIT);
      await w.vault.executeRelease(r.redeemId);
      await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
      await expect(release(w, r)).to.be.revertedWithCustomError(w.vault, "AlreadyRedeemed");
    });

    it("keeps the fee it was queued with, whatever the owner sets meanwhile", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT };
      await release(w, r);
      await w.vault.setFees(100, 50_000_000n, 50_000_000n);
      await time.increase(WAIT);
      await w.vault.executeRelease(r.redeemId);
      expect(await balanceOf(w, w.bob.address)).to.equal(r.units - fee(r.units));
    });

    it("keeps its time when the delay changes, and later ones take the new delay", async () => {
      const w = await loadFixture(funded);
      const a = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      await release(w, a);
      const readyA = (await w.vault.pendingReleases(a.redeemId)).readyAt;
      await w.vault.setPayoutDelay(3_600);
      expect((await w.vault.pendingReleases(a.redeemId)).readyAt).to.equal(readyA);
      const b = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      await release(w, b);
      expect((await w.vault.pendingReleases(b.redeemId)).readyAt).to.equal(BigInt(await time.latest()) + 3_600n);
    });
  });

  describe("a refund", () => {
    it("waits too: the same theft can't go out through refunds", async () => {
      const w = await loadFixture(funded);
      const minted = await w.vault.depositMinted(0);
      const r = { nonce: 0n, recipient: w.bob.address, units: minted };
      await expect(await refund(w, r)).to.emit(w.vault, "RefundQueued");
      expect(await balanceOf(w, w.bob.address)).to.equal(0n);
      expect(await w.vault.depositMinted(0)).to.equal(0n); // a signer now refuses to mint it
      expect(await w.vault.isRefunded(0)).to.equal(true);
      await expect(w.vault.executeRefund(0)).to.be.revertedWithCustomError(w.vault, "PayoutNotReady");
      await time.increase(WAIT);
      await expect(w.vault.connect(w.carol).executeRefund(0)).to.emit(w.vault, "Refunded").withArgs(0n, w.bob.address, minted);
      expect(await balanceOf(w, w.bob.address)).to.equal(minted);
      await expect(w.vault.executeRefund(0)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
      await expect(refund(w, r)).to.be.revertedWithCustomError(w.vault, "AlreadyRefunded");
      await expectBooksBalance(w);
    });
  });

  describe("a pause", () => {
    it("stops what is queued from being paid, for as long as it lasts", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT };
      await release(w, r);
      const minted = await w.vault.depositMinted(0);
      await refund(w, { nonce: 0n, recipient: w.bob.address, units: minted });
      await w.vault.connect(w.guardian).pause();
      await time.increase(30 * 86_400);
      await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "EnforcedPause");
      await expect(w.vault.executeRefund(0)).to.be.revertedWithCustomError(w.vault, "EnforcedPause");
      expect(await balanceOf(w, w.bob.address)).to.equal(0n);
    });

    it("3 stolen keys, the theft split small: the guardian pauses within the wait, and nothing leaves", async () => {
      const w = await loadFixture(funded);
      const held = await w.token.balanceOf(await w.vault.getAddress());
      const thefts = [];
      for (let i = 0; i < 12; i++) {
        const r = { redeemId: newRedeemId(), recipient: w.carol.address, units: 100n * USDT };
        await release(w, r);
        thefts.push(r.redeemId);
      }
      await w.vault.connect(w.guardian).pause();
      await time.increase(WAIT);
      for (const id of thefts) await expect(w.vault.connect(w.carol).executeRelease(id)).to.be.revertedWithCustomError(w.vault, "EnforcedPause");
      expect(await balanceOf(w, w.carol.address)).to.equal(0n);
      expect(await w.token.balanceOf(await w.vault.getAddress())).to.equal(held);

      // The owner clears them, then resumes: the queue holds no theft any more.
      for (const id of thefts) await w.vault.cancelRelease(id);
      expect(await w.vault.reservedUnits()).to.equal(0n);
      await w.vault.unpause();
      for (const id of thefts) await expect(w.vault.executeRelease(id)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
      expect(await balanceOf(w, w.carol.address)).to.equal(0n);
    });
  });

  describe("an unpause", () => {
    it("starts a full wait again for everything queued, so a missed bad payout can still be stopped", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.carol.address, units: 100n * USDT };
      await release(w, r);
      await w.vault.connect(w.guardian).pause();
      await time.increase(WAIT + 1);
      await w.vault.unpause();
      const resume = await w.vault.payoutsResumeAt();
      expect(resume).to.equal(BigInt(await time.latest()) + BigInt(WAIT));
      await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "PayoutNotReady").withArgs(resume);
      // The guardian pauses again in time: still nothing leaves.
      await w.vault.connect(w.guardian).pause();
      await time.increaseTo(resume + 1n);
      await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "EnforcedPause");
      await w.vault.unpause();
      await time.increase(WAIT);
      await w.vault.executeRelease(r.redeemId);
      expect(await w.token.balanceOf(w.carol.address)).to.be.greaterThan(0n);
      await expectBooksBalance(w);
    });
  });

  describe("cancelling", () => {
    it("a release: nothing is paid, its allowance comes back, and the burn stays cancelled until the owner reinstates it", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT };
      const before = await w.vault.releaseAvailable();
      await release(w, r);
      expect(await w.vault.releaseAvailable()).to.be.lessThan(before);
      await expect(w.vault.cancelRelease(r.redeemId)).to.emit(w.vault, "ReleaseCancelled").withArgs(r.redeemId);
      expect(await w.vault.releaseAvailable()).to.be.closeTo(before, DEFAULTS.releaseRefillPerSecond * 5n);
      expect(await w.vault.redeemed(r.redeemId)).to.equal(false);
      expect(await w.vault.reservedUnits()).to.equal(0n);
      await time.increase(WAIT);
      await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
      // The signatures it was queued with are still good, and anyone holds them: they must not bring it back.
      expect(await w.vault.releaseCancelled(r.redeemId)).to.equal(true);
      await expect(release(w, r)).to.be.revertedWithCustomError(w.vault, "PayoutCancelled");
      await expect(w.vault.connect(w.bob).reinstateRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
      await expect(w.vault.reinstateRelease(r.redeemId)).to.emit(w.vault, "ReleaseReinstated").withArgs(r.redeemId);
      await expect(release(w, r)).to.emit(w.vault, "ReleaseQueued");
    });

    it("a refund: the deposit counts as not refunded again", async () => {
      const w = await loadFixture(funded);
      const minted = await w.vault.depositMinted(0);
      await refund(w, { nonce: 0n, recipient: w.bob.address, units: minted });
      await expect(w.vault.cancelRefund(0)).to.emit(w.vault, "RefundCancelled").withArgs(0n);
      expect(await w.vault.depositMinted(0)).to.equal(minted);
      expect(await w.vault.isRefunded(0)).to.equal(false);
      expect(await w.vault.reservedUnits()).to.equal(0n);
      await expect(w.vault.cancelRefund(0)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
      // It stays cancelled: the signatures it was queued with must not bring it back.
      await expect(refund(w, { nonce: 0n, recipient: w.bob.address, units: minted })).to.be.revertedWithCustomError(w.vault, "PayoutCancelled");
      await expect(w.vault.reinstateRefund(0)).to.emit(w.vault, "RefundReinstated").withArgs(0n);
      await expect(refund(w, { nonce: 0n, recipient: w.bob.address, units: minted })).to.emit(w.vault, "RefundQueued");
    });

    it("never gives more allowance than the capacity", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT };
      await release(w, r);
      await time.increase(2 * 86_400);
      await w.vault.cancelRelease(r.redeemId);
      expect(await w.vault.releaseAvailable()).to.equal(DEFAULTS.releaseCapacity);
    });

    it("is the owner's alone: not the guardian's, a signer's or anyone else's", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT };
      await release(w, r);
      await refund(w, { nonce: 0n, recipient: w.bob.address, units: await w.vault.depositMinted(0) });
      for (const who of [w.guardian, w.alice, w.bob]) {
        await expect(w.vault.connect(who).cancelRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
        await expect(w.vault.connect(who).cancelRefund(0)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
      }
    });

    it("something not queued is refused", async () => {
      const w = await loadFixture(funded);
      await expect(w.vault.cancelRelease(ethers.id("nothing"))).to.be.revertedWithCustomError(w.vault, "NothingQueued");
      await expect(w.vault.cancelRefund(0)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
      await expect(w.vault.executeRelease(ethers.id("nothing"))).to.be.revertedWithCustomError(w.vault, "NothingQueued");
      await expect(w.vault.executeRefund(0)).to.be.revertedWithCustomError(w.vault, "NothingQueued");
    });
  });

  describe("the books", () => {
    it("queued payouts can't promise the same backing twice", async () => {
      const w = await loadFixture(funded);
      const all = await w.vault.backing();
      await release(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: all - 5n * USDT });
      await expect(release(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: 10n * USDT })).to.be.revertedWithCustomError(w.vault, "InsufficientBacking");
      const minted = await w.vault.depositMinted(0);
      await expect(refund(w, { nonce: 0n, recipient: w.bob.address, units: minted })).to.be.revertedWithCustomError(w.vault, "InsufficientBacking");
    });

    it("the allowance is drawn when queued, so splitting doesn't get round it", async () => {
      const w = await deployWorld(6, { ...DEFAULTS, releaseCapacity: 500n * USDT, releaseRefillPerSecond: 0n }, WAIT);
      await depositFrom(w, w.alice, 10_000n * USDT);
      const each = 205n * USDT; // 200 paid, 5 fee
      await release(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: each });
      await release(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: each });
      await expect(release(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: each })).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");
    });

    it("a payout the token has made unpayable is refused, not half paid", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT };
      await release(w, r);
      await time.increase(WAIT);
      // Only the token itself could do this: USDT leaves the vault with no call of ours.
      const vault = await w.vault.getAddress();
      const taken = await ethers.getImpersonatedSigner(vault);
      await setBalance(vault, 10n ** 18n);
      await w.token.connect(taken).transfer(w.carol.address, await w.token.balanceOf(vault));
      await expect(w.vault.executeRelease(r.redeemId)).to.be.revertedWithCustomError(w.vault, "InsufficientBacking");
      expect((await w.vault.pendingReleases(r.redeemId)).recipient).to.equal(w.bob.address);
    });
  });

  describe("the setting", () => {
    it("is the owner's, within its hard bounds", async () => {
      const w = await loadFixture(funded);
      const min = await w.vault.MIN_PAYOUT_DELAY(), max = await w.vault.MAX_PAYOUT_DELAY();
      expect(min).to.equal(300n);
      expect(max).to.equal(86_400n);
      await expect(w.vault.setPayoutDelay(min - 1n)).to.be.revertedWithCustomError(w.vault, "BadPayoutDelay");
      await expect(w.vault.setPayoutDelay(max + 1n)).to.be.revertedWithCustomError(w.vault, "BadPayoutDelay");
      await expect(w.vault.setPayoutDelay(min)).to.emit(w.vault, "PayoutDelaySet").withArgs(min);
      await expect(w.vault.setPayoutDelay(max)).to.emit(w.vault, "PayoutDelaySet").withArgs(max);
      expect(await w.vault.payoutDelay()).to.equal(max);
      for (const who of [w.guardian, w.alice]) await expect(w.vault.connect(who).setPayoutDelay(min)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
    });

    it("the constructor refuses more than the maximum, and reports what it set", async () => {
      await expect(deployWorld(6, DEFAULTS, 86_401)).to.be.reverted;
      const w = await deployWorld(6, DEFAULTS, 86_400);
      expect(await w.vault.payoutDelay()).to.equal(86_400n);
    });
  });
});
