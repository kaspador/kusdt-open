import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  DAY,
  DEFAULTS,
  RELEASE_TYPES,
  USDT,
  World,
  depositFrom,
  deployWorld,
  domainOf,
  expectBadSignatures,
  expectBooksBalance,
  makeWallets,
  newRedeemId,
  releaseWith,
  signRefund,
  signRelease,
  sortByAddress,
  world6,
} from "./helpers";

/** A vault holding 200 000 USDT of deposits. */
async function funded(): Promise<World> {
  const w = await world6();
  await depositFrom(w, w.alice, 100_000n * USDT);
  await depositFrom(w, w.alice, 100_000n * USDT);
  return w;
}

const N = 115792089237316195423570985008687907852837564279074904382605163141518161494337n; // secp256k1 order

describe("KusdtVault: releases", () => {
  describe("EIP-712 encoding", () => {
    it("uses exactly the SPEC §7 domain, types and redeemId", async () => {
      const w = await loadFixture(world6);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 123n };
      const d = await domainOf(w.vault);
      expect(await w.vault.releaseDigest(r)).to.equal(ethers.TypedDataEncoder.hash(d, RELEASE_TYPES, r));
      expect(await w.vault.domainSeparator()).to.equal(ethers.TypedDataEncoder.hashDomain(d));
      expect(await w.vault.RELEASE_TYPEHASH()).to.equal(
        ethers.id("Release(bytes32 redeemId,address recipient,uint256 units)"),
      );
      expect(await w.vault.REFUND_TYPEHASH()).to.equal(ethers.id("Refund(uint64 nonce,address recipient,uint256 units)"));
      const [, name, version, chainId, vc] = await w.vault.eip712Domain();
      expect([name, version, chainId, vc]).to.deep.equal(["kUSDT Vault", "1", d.chainId, d.verifyingContract]);

      const txid = ethers.id("some kaspa tx");
      const expected = ethers.keccak256(
        ethers.concat([ethers.toUtf8Bytes("kusdt/redeem/v1"), txid, ethers.toBeHex(258, 4)]),
      );
      expect(await w.vault.redeemIdOf(txid, 258)).to.equal(expected);
    });
  });

  describe("quorum", () => {
    for (const n of [3, 4, 5]) {
      it(`pays with ${n} of 5 signatures`, async () => {
        const w = await loadFixture(funded);
        const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT };
        await expect(releaseWith(w, r, n))
          .to.emit(w.vault, "Released")
          .withArgs(r.redeemId, w.bob.address, r.units, 5n * USDT, 995n * USDT);
        expect(await w.token.balanceOf(w.bob.address)).to.equal(995n * USDT);
        expect(await w.vault.redeemed(r.redeemId)).to.equal(true);
      });
    }

    it("pays with any 3 of the 5 signers", async () => {
      const w = await loadFixture(funded);
      const sorted = sortByAddress(w.signerWallets);
      for (let a = 0; a < 5; a++)
        for (let b = a + 1; b < 5; b++)
          for (let c = b + 1; c < 5; c++) {
            const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 10n * USDT };
            await w.vault.release(r, await signRelease(w.vault, [sorted[a], sorted[b], sorted[c]], r));
            await w.vault.executeRelease(r.redeemId);
          }
      expect(await w.token.balanceOf(w.bob.address)).to.equal(10n * 5n * USDT);
    });

    it("rejects 2 signatures, and none", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      await expect(releaseWith(w, r, 2)).to.be.revertedWithCustomError(w.vault, "NotEnoughSignatures");
      await expect(w.vault.release(r, [])).to.be.revertedWithCustomError(w.vault, "NotEnoughSignatures");
    });

    it("rejects a duplicate signer", async () => {
      const w = await loadFixture(funded);
      const [a, b] = sortByAddress(w.signerWallets);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      await expect(w.vault.release(r, await signRelease(w.vault, [a, a, b], r))).to.be.revertedWithCustomError(
        w.vault,
        "SignaturesNotSorted",
      );
      await expect(w.vault.release(r, await signRelease(w.vault, [a, b, b], r))).to.be.revertedWithCustomError(
        w.vault,
        "SignaturesNotSorted",
      );
    });

    it("rejects 6 signatures (5 plus a repeat)", async () => {
      const w = await loadFixture(funded);
      const s = sortByAddress(w.signerWallets);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      await expect(w.vault.release(r, await signRelease(w.vault, [...s, s[4]], r))).to.be.revertedWithCustomError(
        w.vault,
        "SignaturesNotSorted",
      );
    });

    it("rejects signers out of order", async () => {
      const w = await loadFixture(funded);
      const [a, b, c] = sortByAddress(w.signerWallets);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      for (const order of [
        [b, a, c],
        [a, c, b],
        [c, b, a],
      ]) {
        await expect(w.vault.release(r, await signRelease(w.vault, order, r))).to.be.revertedWithCustomError(
          w.vault,
          "SignaturesNotSorted",
        );
      }
    });

    it("rejects a non-signer, even alongside three valid signers' worth of order", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      const mixed = sortByAddress([...sortByAddress(w.signerWallets).slice(0, 2), w.outsiders[0]]);
      await expect(w.vault.release(r, await signRelease(w.vault, mixed, r)))
        .to.be.revertedWithCustomError(w.vault, "NotASigner")
        .withArgs(w.outsiders[0].address);
      const outsiders = sortByAddress(w.outsiders);
      await expect(w.vault.release(r, await signRelease(w.vault, outsiders, r))).to.be.revertedWithCustomError(
        w.vault,
        "NotASigner",
      );
      // Three good ones plus an outsider still fails: every signature must be a signer's.
      const four = sortByAddress([...sortByAddress(w.signerWallets).slice(0, 3), w.outsiders[1]]);
      await expect(w.vault.release(r, await signRelease(w.vault, four, r))).to.be.revertedWithCustomError(
        w.vault,
        "NotASigner",
      );
    });

    it("rejects the guardian, the owner and the recipient as signers", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      const d = await domainOf(w.vault);
      const extra = await Promise.all([w.owner, w.guardian, w.bob].map((s) => s.signTypedData(d, RELEASE_TYPES, r)));
      const two = await signRelease(w.vault, sortByAddress(w.signerWallets).slice(0, 2), r);
      for (const x of extra) {
        const sigs = [...two, x];
        await expectBadSignatures(w.vault, w.vault.release(r, sigs));
      }
    });
  });

  describe("what the signatures bind", () => {
    it("rejects a signature for another chainId", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      const signers = sortByAddress(w.signerWallets).slice(0, 3);
      for (const chainId of [1n, 56n, 11155111n, 97n]) {
        await expectBadSignatures(w.vault, w.vault.release(r, await signRelease(w.vault, signers, r, { chainId })));
      }
    });

    it("rejects a signature for another vault, name or version", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      const signers = sortByAddress(w.signerWallets).slice(0, 3);
      for (const over of [
        { verifyingContract: w.bob.address },
        { verifyingContract: await w.token.getAddress() },
        { name: "kUSDT vault" },
        { version: "2" },
      ]) {
        await expectBadSignatures(w.vault, w.vault.release(r, await signRelease(w.vault, signers, r, over)));
      }
    });

    it("can't be replayed on a second vault with the same signers", async () => {
      const w = await loadFixture(funded);
      const other = await deployWorld(6); // same deterministic signer keys
      await depositFrom(other, other.alice, 1_000n * USDT);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      const sigs = await signRelease(w.vault, sortByAddress(w.signerWallets).slice(0, 3), r);
      await expectBadSignatures(other.vault, other.vault.release(r, sigs));
      await expect(w.vault.release(r, sigs)).to.emit(w.vault, "ReleaseQueued");
    });

    it("rejects a changed recipient, amount or redeemId", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      const sigs = await signRelease(w.vault, sortByAddress(w.signerWallets).slice(0, 3), r);
      await expectBadSignatures(w.vault, w.vault.release({ ...r, recipient: w.carol.address }, sigs));
      await expectBadSignatures(w.vault, w.vault.release({ ...r, units: r.units + 1n }, sigs));
      await expectBadSignatures(w.vault, w.vault.release({ ...r, units: r.units - 1n }, sigs));
      await expectBadSignatures(w.vault, w.vault.release({ ...r, redeemId: newRedeemId() }, sigs));
      await expect(w.vault.release(r, sigs)).to.emit(w.vault, "ReleaseQueued");
    });

    it("rejects Refund signatures presented as a Release (no type confusion)", async () => {
      const w = await loadFixture(funded);
      const units = 100n * USDT;
      const rf = { nonce: 0n, recipient: w.bob.address, units };
      const sigs = await signRefund(w.vault, sortByAddress(w.signerWallets).slice(0, 3), rf);
      const asRelease = { redeemId: ethers.zeroPadValue("0x00", 32), recipient: w.bob.address, units };
      await expectBadSignatures(w.vault, w.vault.release(asRelease, sigs));
    });

    it("rejects malleable (high-s) and malformed signatures", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      const sigs = await signRelease(w.vault, sortByAddress(w.signerWallets).slice(0, 3), r);
      const s0 = ethers.Signature.from(sigs[0]);
      const highS = ethers.concat([s0.r, ethers.toBeHex(N - BigInt(s0.s), 32), s0.v === 27 ? "0x1c" : "0x1b"]);
      await expect(w.vault.release(r, [highS, sigs[1], sigs[2]])).to.be.revertedWithCustomError(
        w.vault,
        "ECDSAInvalidSignatureS",
      );
      const compact = ethers.Signature.from(sigs[0]).compactSerialized; // 64 bytes (EIP-2098)
      await expect(w.vault.release(r, [compact, sigs[1], sigs[2]])).to.be.revertedWithCustomError(
        w.vault,
        "ECDSAInvalidSignatureLength",
      );
      await expect(w.vault.release(r, ["0x", sigs[1], sigs[2]])).to.be.revertedWithCustomError(
        w.vault,
        "ECDSAInvalidSignatureLength",
      );
      const zero = ethers.concat([ethers.ZeroHash, ethers.ZeroHash, "0x1b"]);
      await expect(w.vault.release(r, [zero, sigs[1], sigs[2]])).to.be.revertedWithCustomError(
        w.vault,
        "ECDSAInvalidSignature",
      );
      await expect(w.vault.release(r, sigs)).to.emit(w.vault, "ReleaseQueued");
    });
  });

  describe("replay, fee and payout", () => {
    it("pays each redeemId once", async () => {
      const w = await loadFixture(funded);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      const sigs = await signRelease(w.vault, sortByAddress(w.signerWallets).slice(0, 3), r);
      await w.vault.release(r, sigs);
      await w.vault.executeRelease(r.redeemId);
      await expect(w.vault.release(r, sigs))
        .to.be.revertedWithCustomError(w.vault, "AlreadyRedeemed")
        .withArgs(r.redeemId);
      // A fresh signature set over the same redeemId is refused too.
      await expect(releaseWith(w, r, 5)).to.be.revertedWithCustomError(w.vault, "AlreadyRedeemed");
      await expect(releaseWith(w, { ...r, units: 200n * USDT })).to.be.revertedWithCustomError(
        w.vault,
        "AlreadyRedeemed",
      );
      expect(await w.token.balanceOf(w.bob.address)).to.equal(95n * USDT);
    });

    it("pays units - fee and accrues the fee", async () => {
      const w = await loadFixture(funded);
      const backing0 = await w.vault.backing();
      const fees0 = await w.vault.feesAccrued();
      // 10 000 USDT: 0.2 % = 20 USDT > 5 USDT minimum.
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 10_000n * USDT + 1n };
      const fee = (r.units * 20n + 9_999n) / 10_000n;
      expect(fee).to.equal(20n * USDT + 1n);
      const avail0 = await w.vault.releaseAvailable();
      await expect(releaseWith(w, r))
        .to.emit(w.vault, "Released")
        .withArgs(r.redeemId, w.bob.address, r.units, fee, r.units - fee);
      expect(await w.token.balanceOf(w.bob.address)).to.equal(r.units - fee);
      expect(await w.vault.feesAccrued()).to.equal(fees0 + fee);
      expect(await w.vault.backing()).to.equal(backing0 - r.units);
      // The allowance is drawn by the gross units, the fee too (SPEC §7), allowing for one second of refill.
      const avail1 = await w.vault.releaseAvailable();
      expect(avail0 - avail1).to.be.closeTo(r.units, DEFAULTS.releaseRefillPerSecond * 2n);
      await expectBooksBalance(w);
    });

    it("rejects amounts at or below the fee; pays 1 unit just above it", async () => {
      const w = await loadFixture(funded);
      const at = { redeemId: newRedeemId(), recipient: w.bob.address, units: 5n * USDT };
      await expect(releaseWith(w, at)).to.be.revertedWithCustomError(w.vault, "AmountNotAboveFee");
      await expect(releaseWith(w, { ...at, units: 0n })).to.be.revertedWithCustomError(w.vault, "AmountNotAboveFee");
      await expect(releaseWith(w, { ...at, units: 1n })).to.be.revertedWithCustomError(w.vault, "AmountNotAboveFee");
      const above = { redeemId: newRedeemId(), recipient: w.bob.address, units: 5n * USDT + 1n };
      await expect(releaseWith(w, above))
        .to.emit(w.vault, "Released")
        .withArgs(above.redeemId, w.bob.address, above.units, 5n * USDT, 1n);
    });

    it("rejects the zero address and the vault itself as recipients", async () => {
      const w = await loadFixture(funded);
      for (const recipient of [ethers.ZeroAddress, await w.vault.getAddress()]) {
        const r = { redeemId: newRedeemId(), recipient, units: 100n * USDT };
        await expect(releaseWith(w, r)).to.be.revertedWithCustomError(w.vault, "BadRecipient");
      }
    });

    it("pays a recipient the token blacklists, where it is frozen: only the signers can refuse it", async () => {
      // USDT's blacklist checks senders, never recipients, so the vault can't tell;
      // the signers refuse such a release off-chain (SPEC §9).
      const w = await loadFixture(funded);
      await w.token.addBlackList(w.bob.address);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      await expect(releaseWith(w, r)).to.emit(w.vault, "Released");
      expect(await w.token.balanceOf(w.bob.address)).to.equal(95n * USDT);
      await expect(w.token.connect(w.bob).transfer(w.carol.address, 1n)).to.be.revertedWith("blacklisted");
    });

    it("can pay nothing once the token blacklists the vault, while deposits still go in", async () => {
      // Why the monitor pauses everything when the token reports the vault blocked (SPEC §11).
      const w = await loadFixture(funded);
      await w.token.addBlackList(await w.vault.getAddress());
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      await expect(releaseWith(w, r)).to.be.revertedWith("blacklisted");
      await expect(depositFrom(w, w.carol, 100n * USDT)).to.emit(w.vault, "Deposit");
    });

    it("never pays more than the backing, and never out of the fees", async () => {
      const w = await world6();
      await depositFrom(w, w.alice, 1_000n * USDT); // backing 998, fees 2
      expect(await w.vault.backing()).to.equal(998n * USDT);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 998n * USDT + 1n };
      await expect(releaseWith(w, r)).to.be.revertedWithCustomError(w.vault, "InsufficientBacking");
      await expect(releaseWith(w, { ...r, units: 998n * USDT })).to.emit(w.vault, "Released");
      expect(await w.vault.backing()).to.equal(0n);
      // Exactly the deposit and release fees are left, and they can still be withdrawn.
      expect(await w.vault.feesAccrued()).to.equal(2n * USDT + 5n * USDT);
      await w.vault.withdrawFees(w.carol.address, 7n * USDT);
      expect(await w.token.balanceOf(await w.vault.getAddress())).to.equal(0n);
    });

    it("blocks reentry from the token during the payout", async () => {
      const [owner, guardian, alice, bob] = await ethers.getSigners();
      const re = await (await ethers.getContractFactory("ReentrantToken")).deploy();
      const signerWallets = makeWallets("signer", 5);
      const vault = await (await ethers.getContractFactory("KusdtVault")).deploy(
        await re.getAddress(),
        6,
        signerWallets.map((x) => x.address) as any,
        guardian.address,
        owner.address,
        DEFAULTS,
        0, 0, 0
      );
      const v = await vault.getAddress();
      await re.mint(alice.address, 10_000n * USDT);
      await re.connect(alice).approve(v, 10_000n * USDT);
      await vault.connect(alice).deposit(10_000n * USDT, 0, ethers.id("o"));
      const sorted = sortByAddress(signerWallets).slice(0, 3);
      const r1 = { redeemId: newRedeemId(), recipient: bob.address, units: 100n * USDT };
      const r2 = { redeemId: newRedeemId(), recipient: bob.address, units: 100n * USDT };
      const sigs1 = await signRelease(vault, sorted, r1);
      const sigs2 = await signRelease(vault, sorted, r2);
      await vault.release(r1, sigs1);
      await vault.release(r2, sigs2);
      // The payout is what touches the token: from inside it, the other queued payout can't be paid too.
      await re.arm(v, vault.interface.encodeFunctionData("executeRelease", [r2.redeemId]));
      await vault.executeRelease(r1.redeemId);
      expect(await re.lastCallOk()).to.equal(false);
      expect((await re.lastReturn()).slice(0, 10)).to.equal(
        vault.interface.getError("ReentrancyGuardReentrantCall")!.selector,
      );
      expect((await vault.pendingReleases(r2.redeemId)).recipient).to.equal(bob.address);
    });
  });

  describe("release allowance", () => {
    async function limited(): Promise<World> {
      const w = await funded();
      // 1 000 USDT capacity, refilled in a day.
      await w.vault.setReleaseLimits(1_000n * USDT, (1_000n * USDT) / 86_400n);
      return w;
    }

    it("is exhausted, then refills over time, capped at capacity", async () => {
      const w = await loadFixture(limited);
      const cap = 1_000n * USDT;
      const refill = cap / 86_400n;
      expect(await w.vault.releaseAvailable()).to.equal(cap);

      // Gross burns 600 + 400 = 1 000: the allowance counts the fee too.
      await releaseWith(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: 600n * USDT });
      await releaseWith(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: 400n * USDT - refill });
      const left = await w.vault.releaseAvailable();
      expect(left).to.be.lessThanOrEqual(4n * refill); // a few seconds' refill: each payout is two transactions

      const big = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      await expect(releaseWith(w, big)).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");

      // Half a day later, about half the capacity is back.
      await time.increase(DAY / 2);
      const half = await w.vault.releaseAvailable();
      expect(half).to.be.closeTo(cap / 2n, 6n * refill);
      await expect(releaseWith(w, big)).to.emit(w.vault, "Released");

      // A burn one unit above what is available fails with the exact numbers.
      const avail = await w.vault.releaseAvailable();
      const over = { redeemId: newRedeemId(), recipient: w.bob.address, units: avail + refill + 1n };
      await expect(releaseWith(w, over)).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");

      // Long after, it is capped at capacity, never more.
      await time.increase(10 * DAY);
      expect(await w.vault.releaseAvailable()).to.equal(cap);
      await expect(
        releaseWith(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: cap + 1n }),
      ).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");
      await expect(
        releaseWith(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: cap }),
      ).to.emit(w.vault, "Released");
    });

    it("refills linearly: bucket + elapsed x refill", async () => {
      const w = await loadFixture(limited);
      const refill = (1_000n * USDT) / 86_400n;
      await releaseWith(w, { redeemId: newRedeemId(), recipient: w.bob.address, units: 1_000n * USDT });
      const t0 = await w.vault.releaseUpdatedAt(); // the allowance was drawn when it was queued
      const b0 = await w.vault.releaseBucket();
      for (const dt of [5, 60, 3_600, 40_000]) {
        await time.increaseTo(t0 + BigInt(dt));
        expect(await w.vault.releaseAvailable()).to.equal(b0 + BigInt(dt) * refill);
      }
    });

    it("limits the total a quorum can take in a day", async () => {
      const w = await loadFixture(limited);
      const cap = 1_000n * USDT;
      let paid = 0n;
      const start = await time.latest();
      // Keep releasing 50 USDT every 30 minutes for a day.
      for (let i = 0; i < 48; i++) {
        const r = { redeemId: newRedeemId(), recipient: w.carol.address, units: 55n * USDT };
        try {
          await releaseWith(w, r);
          paid += 50n * USDT;
        } catch {
          /* over the limit */
        }
        await time.increase(1_800);
      }
      expect((await time.latest()) - start).to.be.closeTo(DAY, 3_600);
      expect(paid).to.be.lessThanOrEqual(2n * cap);
      expect(await w.token.balanceOf(w.carol.address)).to.equal(paid);
    });
  });

  it("is stopped by pause, and resumes on unpause", async () => {
    const w = await loadFixture(funded);
    const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
    const sigs = await signRelease(w.vault, sortByAddress(w.signerWallets).slice(0, 3), r);
    await w.vault.connect(w.guardian).pause();
    await expect(w.vault.release(r, sigs)).to.be.revertedWithCustomError(w.vault, "EnforcedPause");
    await w.vault.unpause();
    await expect(w.vault.release(r, sigs)).to.emit(w.vault, "ReleaseQueued");
  });

  it("anyone may submit a valid release (the coordinator isn't trusted)", async () => {
    const w = await loadFixture(funded);
    const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
    const sigs = await signRelease(w.vault, sortByAddress(w.signerWallets).slice(0, 3), r);
    await expect(w.vault.connect(w.others[0]).release(r, sigs)).to.emit(w.vault, "ReleaseQueued");
    await expect(w.vault.connect(w.others[1]).executeRelease(r.redeemId)).to.emit(w.vault, "Released");
    expect(await w.token.balanceOf(w.bob.address)).to.equal(95n * USDT);
    expect(await w.token.balanceOf(w.others[0].address)).to.equal(0n);
  });
});
