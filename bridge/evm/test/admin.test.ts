import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  DAY,
  DEFAULTS,
  USDT,
  World,
  depositFrom,
  expectBadSignatures,
  expectBooksBalance,
  makeWallets,
  newRedeemId,
  releaseWith,
  signRelease,
  sortByAddress,
  world6,
} from "./helpers";

async function funded(): Promise<World> {
  const w = await world6();
  await depositFrom(w, w.alice, 50_000n * USDT); // fee 100 USDT
  return w;
}

const MAX_AMOUNT = 10n ** 15n;

describe("KusdtVault: admin", () => {
  describe("constructor", () => {
    async function deploy(over: Partial<{ token: string; decimals: number; signers: string[]; guardian: string; owner: string; params: any }>) {
      const [owner, guardian] = await ethers.getSigners();
      const usdt = await (await ethers.getContractFactory("MockUSDT")).deploy("M", "M", 6);
      const f = await ethers.getContractFactory("KusdtVault");
      return f.deploy(
        over.token ?? (await usdt.getAddress()),
        over.decimals ?? 6,
        (over.signers ?? makeWallets("signer", 5).map((x) => x.address)) as any,
        over.guardian ?? guardian.address,
        over.owner ?? owner.address,
        over.params ?? DEFAULTS,
        0, 0, 0
      );
    }

    it("stores everything and emits the initial settings", async () => {
      const w = await loadFixture(world6);
      expect(await w.vault.token()).to.equal(await w.token.getAddress());
      expect(await w.vault.owner()).to.equal(w.owner.address);
      expect(await w.vault.guardian()).to.equal(w.guardian.address);
      expect(await w.vault.signers()).to.deep.equal(w.signerWallets.map((x) => x.address));
      for (const s of w.signerWallets) expect(await w.vault.isSigner(s.address)).to.equal(true);
      const p = await w.vault.params();
      expect(p.feeBps).to.equal(BigInt(DEFAULTS.feeBps));
      expect(p.minDepositFee).to.equal(DEFAULTS.minDepositFee);
      expect(p.minReleaseFee).to.equal(DEFAULTS.minReleaseFee);
      expect(p.minDeposit).to.equal(DEFAULTS.minDeposit);
      expect(p.maxDeposit).to.equal(DEFAULTS.maxDeposit);
      expect(p.releaseCapacity).to.equal(DEFAULTS.releaseCapacity);
      expect(p.releaseRefillPerSecond).to.equal(DEFAULTS.releaseRefillPerSecond);
      expect(await w.vault.releaseAvailable()).to.equal(DEFAULTS.releaseCapacity);
      expect(await w.vault.depositNonce()).to.equal(0n);
      expect(await w.vault.paused()).to.equal(false);
      const tx = w.vault.deploymentTransaction()!;
      await expect(tx).to.emit(w.vault, "SignersSet");
      await expect(tx).to.emit(w.vault, "GuardianSet").withArgs(w.guardian.address);
      await expect(tx).to.emit(w.vault, "FeesSet").withArgs(20, 500_000n, 5_000_000n);
      await expect(tx).to.emit(w.vault, "DepositLimitsSet").withArgs(DEFAULTS.minDeposit, DEFAULTS.maxDeposit);
      await expect(tx)
        .to.emit(w.vault, "ReleaseLimitsSet")
        .withArgs(DEFAULTS.releaseCapacity, DEFAULTS.releaseRefillPerSecond);
    });

    it("rejects bad tokens and decimals", async () => {
      const w = await loadFixture(world6);
      const [owner] = await ethers.getSigners();
      await expect(deploy({ token: ethers.ZeroAddress })).to.be.revertedWithCustomError(w.vault, "ZeroAddress");
      await expect(deploy({ token: owner.address })).to.be.revertedWithCustomError(w.vault, "ZeroAddress"); // no code
      for (const d of [0, 5, 19, 255]) {
        await expect(deploy({ decimals: d })).to.be.revertedWithCustomError(w.vault, "BadDecimals");
      }
      // The token says 6: claiming 18 is refused.
      await expect(deploy({ decimals: 18 })).to.be.revertedWithCustomError(w.vault, "BadDecimals").withArgs(18);
    });

    it("rejects bad signers, guardian and owner", async () => {
      const w = await loadFixture(world6);
      const s = makeWallets("signer", 5).map((x) => x.address);
      await expect(deploy({ signers: [s[0], s[1], s[2], s[3], s[0]] }))
        .to.be.revertedWithCustomError(w.vault, "BadSigner")
        .withArgs(s[0]);
      await expect(deploy({ signers: [s[0], s[1], ethers.ZeroAddress, s[3], s[4]] })).to.be.revertedWithCustomError(
        w.vault,
        "BadSigner",
      );
      await expect(deploy({ guardian: ethers.ZeroAddress })).to.be.revertedWithCustomError(w.vault, "ZeroAddress");
      await expect(deploy({ owner: ethers.ZeroAddress })).to.be.revertedWithCustomError(w.vault, "OwnableInvalidOwner");
    });

    it("rejects parameters outside the hard bounds", async () => {
      const w = await loadFixture(world6);
      const bad = [
        { feeBps: 101 },
        { minDepositFee: 50n * USDT + 1n },
        { minReleaseFee: 50n * USDT + 1n },
        { minDeposit: 0n },
        { minDeposit: 10n * USDT, maxDeposit: 10n * USDT - 1n },
        { maxDeposit: MAX_AMOUNT + 1n },
        { releaseCapacity: MAX_AMOUNT + 1n },
        { releaseRefillPerSecond: DEFAULTS.releaseCapacity / 86_400n + 1n },
      ];
      for (const b of bad) await expect(deploy({ params: { ...DEFAULTS, ...b } })).to.be.reverted;
    });
  });

  describe("setters: bounds, events, owner only", () => {
    it("setFees", async () => {
      const w = await loadFixture(world6);
      await expect(w.vault.setFees(100, 50n * USDT, 50n * USDT))
        .to.emit(w.vault, "FeesSet")
        .withArgs(100, 50n * USDT, 50n * USDT);
      await expect(w.vault.setFees(0, 0, 0)).to.emit(w.vault, "FeesSet");
      await expect(w.vault.setFees(101, 0, 0)).to.be.revertedWithCustomError(w.vault, "FeeTooHigh");
      await expect(w.vault.setFees(65_535, 0, 0)).to.be.revertedWithCustomError(w.vault, "FeeTooHigh");
      await expect(w.vault.setFees(0, 50n * USDT + 1n, 0)).to.be.revertedWithCustomError(w.vault, "FeeTooHigh");
      await expect(w.vault.setFees(0, 0, 50n * USDT + 1n)).to.be.revertedWithCustomError(w.vault, "FeeTooHigh");
      await expect(w.vault.setFees(0, 0, ethers.MaxUint256)).to.be.revertedWithCustomError(w.vault, "FeeTooHigh");
      await expect(w.vault.connect(w.guardian).setFees(1, 0, 0))
        .to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount")
        .withArgs(w.guardian.address);
      expect(await w.vault.feeBps()).to.equal(0n);
      expect(await w.vault.MAX_FEE_BPS()).to.equal(100n);
      expect(await w.vault.MAX_MIN_FEE()).to.equal(50_000_000n);
    });

    it("setDepositLimits", async () => {
      const w = await loadFixture(world6);
      await expect(w.vault.setDepositLimits(1n, MAX_AMOUNT)).to.emit(w.vault, "DepositLimitsSet").withArgs(1n, MAX_AMOUNT);
      await expect(w.vault.setDepositLimits(5n, 5n)).to.emit(w.vault, "DepositLimitsSet");
      await expect(w.vault.setDepositLimits(0n, 5n)).to.be.revertedWithCustomError(w.vault, "BadLimits");
      await expect(w.vault.setDepositLimits(6n, 5n)).to.be.revertedWithCustomError(w.vault, "BadLimits");
      await expect(w.vault.setDepositLimits(1n, MAX_AMOUNT + 1n)).to.be.revertedWithCustomError(w.vault, "BadLimits");
      await expect(w.vault.connect(w.alice).setDepositLimits(1n, 2n)).to.be.revertedWithCustomError(
        w.vault,
        "OwnableUnauthorizedAccount",
      );
      expect(await w.vault.minDeposit()).to.equal(5n);
      expect(await w.vault.maxDeposit()).to.equal(5n);
    });

    it("setReleaseLimits: bounds, and no instant jump in the allowance", async () => {
      const w = await loadFixture(funded);
      const cap = 1_000n * USDT;
      await expect(w.vault.setReleaseLimits(cap, cap / 86_400n))
        .to.emit(w.vault, "ReleaseLimitsSet")
        .withArgs(cap, cap / 86_400n);
      // Lowering the capacity cuts what is available now.
      expect(await w.vault.releaseAvailable()).to.equal(cap);
      // Use it up, then raise the capacity a lot: nothing more is available at once.
      await releaseWith(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT });
      const before = await w.vault.releaseAvailable();
      await w.vault.setReleaseLimits(MAX_AMOUNT, MAX_AMOUNT / 86_400n);
      expect(await w.vault.releaseAvailable()).to.be.lessThanOrEqual(before + 2n * (cap / 86_400n));
      // It then refills at the new rate.
      await time.increase(DAY);
      expect(await w.vault.releaseAvailable()).to.be.closeTo((MAX_AMOUNT / 86_400n) * 86_400n, MAX_AMOUNT / 1000n);

      await expect(w.vault.setReleaseLimits(MAX_AMOUNT + 1n, 0)).to.be.revertedWithCustomError(w.vault, "BadLimits");
      // Refilling the capacity in less than a day is refused.
      await expect(w.vault.setReleaseLimits(cap, cap / 86_400n + 1n)).to.be.revertedWithCustomError(w.vault, "BadLimits");
      await expect(w.vault.setReleaseLimits(cap, cap)).to.be.revertedWithCustomError(w.vault, "BadLimits");
      await expect(w.vault.setReleaseLimits(0, 1)).to.be.revertedWithCustomError(w.vault, "BadLimits");
      // Zero capacity is allowed: it stops releases and refunds.
      await w.vault.setReleaseLimits(0, 0);
      expect(await w.vault.releaseAvailable()).to.equal(0n);
      await expect(
        releaseWith(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: 10n * USDT }),
      ).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");
      await expect(w.vault.connect(w.guardian).setReleaseLimits(cap, 0)).to.be.revertedWithCustomError(
        w.vault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("setSigners: rotation takes effect at once", async () => {
      const w = await loadFixture(funded);
      const fresh = makeWallets("rotated", 5);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      const oldSigs = await signRelease(w.vault, sortByAddress(w.signerWallets).slice(0, 3), r);
      await expect(w.vault.setSigners(fresh.map((x) => x.address) as any)).to.emit(w.vault, "SignersSet");
      expect(await w.vault.signers()).to.deep.equal(fresh.map((x) => x.address));
      for (const s of w.signerWallets) expect(await w.vault.isSigner(s.address)).to.equal(false);
      for (const s of fresh) expect(await w.vault.isSigner(s.address)).to.equal(true);
      await expectBadSignatures(w.vault, w.vault.release(r, oldSigs));
      const newSigs = await signRelease(w.vault, sortByAddress(fresh).slice(0, 3), r);
      await expect(w.vault.release(r, newSigs)).to.emit(w.vault, "ReleaseQueued");
    });

    it("setSigners: a partial rotation keeps the overlapping signers", async () => {
      const w = await loadFixture(funded);
      const keep = w.signerWallets.slice(0, 3);
      const add = makeWallets("partial", 2);
      await w.vault.setSigners([...keep, ...add].map((x) => x.address) as any);
      const removed = w.signerWallets.slice(3);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      // Two removed signers plus one kept: fails.
      await expectBadSignatures(w.vault, w.vault.release(r, await signRelease(w.vault, sortByAddress([...removed, keep[0]]), r)));
      // One kept and the two added: passes.
      await expect(w.vault.release(r, await signRelease(w.vault, sortByAddress([keep[0], ...add]), r))).to.emit(
        w.vault,
        "ReleaseQueued",
      );
    });

    it("setSigners: distinct, non-zero, owner only", async () => {
      const w = await loadFixture(world6);
      const f = makeWallets("x", 5).map((x) => x.address);
      await expect(w.vault.setSigners([f[0], f[1], f[2], f[3], f[3]] as any)).to.be.revertedWithCustomError(
        w.vault,
        "BadSigner",
      );
      await expect(w.vault.setSigners([f[0], f[1], f[2], f[3], ethers.ZeroAddress] as any)).to.be.revertedWithCustomError(
        w.vault,
        "BadSigner",
      );
      await expect(w.vault.connect(w.guardian).setSigners(f as any)).to.be.revertedWithCustomError(
        w.vault,
        "OwnableUnauthorizedAccount",
      );
      // The same set again is fine (old flags are cleared first).
      await w.vault.setSigners(w.signerWallets.map((x) => x.address) as any);
      expect(await w.vault.signers()).to.deep.equal(w.signerWallets.map((x) => x.address));
    });

    it("setGuardian", async () => {
      const w = await loadFixture(world6);
      await expect(w.vault.setGuardian(w.carol.address)).to.emit(w.vault, "GuardianSet").withArgs(w.carol.address);
      await expect(w.vault.connect(w.guardian).pause()).to.be.revertedWithCustomError(w.vault, "NotGuardianOrOwner");
      await w.vault.connect(w.carol).pause();
      expect(await w.vault.paused()).to.equal(true);
      await expect(w.vault.setGuardian(ethers.ZeroAddress)).to.be.revertedWithCustomError(w.vault, "ZeroAddress");
      await expect(w.vault.connect(w.carol).setGuardian(w.carol.address)).to.be.revertedWithCustomError(
        w.vault,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("pause", () => {
    it("the guardian can pause but not unpause; the owner can do both", async () => {
      const w = await loadFixture(world6);
      await expect(w.vault.connect(w.guardian).pause()).to.emit(w.vault, "Paused").withArgs(w.guardian.address);
      await expect(w.vault.connect(w.guardian).unpause()).to.be.revertedWithCustomError(
        w.vault,
        "OwnableUnauthorizedAccount",
      );
      await expect(w.vault.unpause()).to.emit(w.vault, "Unpaused");
      await expect(w.vault.pause()).to.emit(w.vault, "Paused").withArgs(w.owner.address);
      await expect(w.vault.pause()).to.be.revertedWithCustomError(w.vault, "EnforcedPause");
      await w.vault.unpause();
      await expect(w.vault.unpause()).to.be.revertedWithCustomError(w.vault, "ExpectedPause");
    });

    it("nobody else can pause", async () => {
      const w = await loadFixture(world6);
      for (const who of [w.alice, w.bob, w.others[0]]) {
        await expect(w.vault.connect(who).pause()).to.be.revertedWithCustomError(w.vault, "NotGuardianOrOwner");
      }
    });

    it("the guardian can do nothing else", async () => {
      const w = await loadFixture(funded);
      const g = w.vault.connect(w.guardian);
      const calls = [
        () => g.setFees(0, 0, 0),
        () => g.setDepositLimits(1, 2),
        () => g.setReleaseLimits(0, 0),
        () => g.setSigners(makeWallets("g", 5).map((x) => x.address) as any),
        () => g.setGuardian(w.guardian.address),
        () => g.withdrawFees(w.guardian.address, 1),
        () => g.unpause(),
        () => g.transferOwnership(w.guardian.address),
        () => g.renounceOwnership(),
      ];
      for (const c of calls) await expect(c()).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
    });

    it("admin still works while paused, so a fix can be made before unpausing", async () => {
      const w = await loadFixture(funded);
      await w.vault.connect(w.guardian).pause();
      await w.vault.setSigners(makeWallets("fix", 5).map((x) => x.address) as any);
      await w.vault.setFees(10, 0, 0);
      await w.vault.withdrawFees(w.owner.address, 1n);
      await w.vault.unpause();
    });
  });

  describe("fees and backing", () => {
    it("withdrawFees refuses the token's and the vault's own address", async () => {
      const w = await loadFixture(funded);
      for (const to of [await w.vault.token(), await w.vault.getAddress()]) {
        await expect(w.vault.withdrawFees(to, 1n)).to.be.revertedWithCustomError(w.vault, "BadRecipient");
      }
    });

    it("withdrawFees is bounded by feesAccrued and leaves the backing alone", async () => {
      const w = await loadFixture(funded);
      const fees = await w.vault.feesAccrued();
      expect(fees).to.equal(100n * USDT);
      const backing = await w.vault.backing();
      await expect(w.vault.withdrawFees(w.carol.address, fees + 1n)).to.be.revertedWithCustomError(
        w.vault,
        "FeesExceeded",
      );
      await expect(w.vault.withdrawFees(w.carol.address, 40n * USDT))
        .to.emit(w.vault, "FeesWithdrawn")
        .withArgs(w.carol.address, 40n * USDT);
      await expect(w.vault.withdrawFees(w.carol.address, 60n * USDT + 1n)).to.be.revertedWithCustomError(
        w.vault,
        "FeesExceeded",
      );
      await w.vault.withdrawFees(w.carol.address, 60n * USDT);
      expect(await w.vault.feesAccrued()).to.equal(0n);
      expect(await w.vault.backing()).to.equal(backing);
      expect(await w.token.balanceOf(w.carol.address)).to.equal(100n * USDT);
      await expect(w.vault.withdrawFees(w.carol.address, 1n)).to.be.revertedWithCustomError(w.vault, "FeesExceeded");
      await expect(w.vault.withdrawFees(ethers.ZeroAddress, 0n)).to.be.revertedWithCustomError(w.vault, "ZeroAddress");
      await expect(w.vault.connect(w.alice).withdrawFees(w.alice.address, 1n)).to.be.revertedWithCustomError(
        w.vault,
        "OwnableUnauthorizedAccount",
      );
      await expectBooksBalance(w);
    });

    it("no function lets anyone take backing", async () => {
      const w = await loadFixture(funded);
      const v = await w.vault.getAddress();
      // 1. The complete list of state-changing functions. A new one fails this test and
      //    must be reviewed against INV-1 before it is added here.
      const mutating = w.vault.interface.fragments
        .filter((f): f is any => f.type === "function" && !["view", "pure"].includes((f as any).stateMutability))
        .map((f: any) => f.name)
        .sort();
      expect(mutating).to.deep.equal(
        [
          "acceptOwnership",
          "cancelRefund",
          "cancelRelease",
          "deposit",
          "depositAtLeast",
          "executeRefund",
          "executeRelease",
          "pause",
          "refund",
          "reinstateRefund",
          "reinstateRelease",
          "release",
          "setDepositLimits",
          "setDepositSurge",
          "setFees",
          "setGuardian",
          "setPayoutDelay",
          "setReleaseLimits",
          "setSigners",
          "transferOwnership",
          "unpause",
          "withdrawFees",
        ].sort(),
      );
      // renounceOwnership is a view that always reverts.
      await expect(w.vault.renounceOwnership()).to.be.revertedWithCustomError(w.vault, "RenounceDisabled");

      // 2. The vault never grants a token allowance.
      for (const who of [w.owner, w.guardian, w.alice]) {
        expect(await w.token.allowance(v, who.address)).to.equal(0n);
      }

      // 3. The owner (and everyone else) without signer keys: everything that moves funds fails.
      const backing = await w.vault.backing();
      const fees = await w.vault.feesAccrued();
      for (const who of [w.owner, w.guardian, w.alice]) {
        const c = w.vault.connect(who);
        const r = { redeemId: newRedeemId(), recipient: who.address, units: backing };
        await expect(c.release(r, [])).to.be.revertedWithCustomError(w.vault, "NotEnoughSignatures");
        await expect(c.refund({ nonce: 0n, recipient: who.address, units: backing }, [])).to.be.reverted;
      }
      await expect(w.vault.withdrawFees(w.owner.address, fees + backing)).to.be.revertedWithCustomError(
        w.vault,
        "FeesExceeded",
      );
      // Changing fees after the fact doesn't change what has accrued.
      await w.vault.setFees(100, 50n * USDT, 50n * USDT);
      expect(await w.vault.feesAccrued()).to.equal(fees);
      expect(await w.vault.backing()).to.equal(backing);

      // 4. Even an owner that installs its own signers is held to the release allowance.
      const own = makeWallets("owner-controlled", 5);
      await w.vault.setSigners(own.map((x) => x.address) as any);
      await w.vault.setReleaseLimits(1_000n * USDT, 0);
      const grab = { redeemId: newRedeemId(), recipient: w.owner.address, units: backing };
      await expect(w.vault.release(grab, await signRelease(w.vault, sortByAddress(own).slice(0, 3), grab))).to.be.revertedWithCustomError(
        w.vault,
        "ReleaseLimit",
      );
      await expectBooksBalance(w);
    });

    it("tokens sent straight to the vault count as backing, not fees", async () => {
      const w = await loadFixture(funded);
      const b = await w.vault.backing();
      const f = await w.vault.feesAccrued();
      await w.token.mint(await w.vault.getAddress(), 5n * USDT);
      expect(await w.vault.backing()).to.equal(b + 5n * USDT);
      expect(await w.vault.feesAccrued()).to.equal(f);
    });
  });

  describe("ownership", () => {
    it("is two-step", async () => {
      const w = await loadFixture(world6);
      await expect(w.vault.transferOwnership(w.carol.address))
        .to.emit(w.vault, "OwnershipTransferStarted")
        .withArgs(w.owner.address, w.carol.address);
      expect(await w.vault.owner()).to.equal(w.owner.address);
      expect(await w.vault.pendingOwner()).to.equal(w.carol.address);
      // Until accepted, the old owner keeps control and the new one has none.
      await expect(w.vault.connect(w.carol).setFees(0, 0, 0)).to.be.revertedWithCustomError(
        w.vault,
        "OwnableUnauthorizedAccount",
      );
      await w.vault.setFees(1, 0, 0);
      await expect(w.vault.connect(w.bob).acceptOwnership())
        .to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount")
        .withArgs(w.bob.address);
      await expect(w.vault.connect(w.carol).acceptOwnership())
        .to.emit(w.vault, "OwnershipTransferred")
        .withArgs(w.owner.address, w.carol.address);
      expect(await w.vault.owner()).to.equal(w.carol.address);
      expect(await w.vault.pendingOwner()).to.equal(ethers.ZeroAddress);
      await expect(w.vault.setFees(0, 0, 0)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
      await w.vault.connect(w.carol).setFees(0, 0, 0);
      await w.vault.connect(w.carol).pause();
      await w.vault.connect(w.carol).unpause();
    });

    it("a pending transfer can be replaced or cancelled", async () => {
      const w = await loadFixture(world6);
      await w.vault.transferOwnership(w.carol.address);
      await w.vault.transferOwnership(ethers.ZeroAddress);
      await expect(w.vault.connect(w.carol).acceptOwnership()).to.be.revertedWithCustomError(
        w.vault,
        "OwnableUnauthorizedAccount",
      );
      expect(await w.vault.owner()).to.equal(w.owner.address);
    });

    it("cannot be renounced", async () => {
      const w = await loadFixture(world6);
      await expect(w.vault.renounceOwnership()).to.be.revertedWithCustomError(w.vault, "RenounceDisabled");
      expect(await w.vault.owner()).to.equal(w.owner.address);
    });
  });
});
