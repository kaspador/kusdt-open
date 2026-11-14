import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  USDT,
  World,
  depositFrom,
  expectBadSignatures,
  expectBooksBalance,
  newRedeemId,
  refundWith,
  releaseWith,
  signRefund,
  signRelease,
  sortByAddress,
  world6,
} from "./helpers";

/** Three deposits: 0 by alice (1 000 USDT), 1 by bob (50 USDT), 2 by alice (10 000 USDT). */
async function deposited(): Promise<World & { minted: bigint[] }> {
  const w = await world6();
  await depositFrom(w, w.alice, 1_000n * USDT);
  await depositFrom(w, w.bob, 50n * USDT);
  await depositFrom(w, w.alice, 10_000n * USDT);
  return { ...w, minted: [998n * USDT, 49_500_000n, 9_980n * USDT] };
}

describe("KusdtVault: refunds", () => {
  it("returns exactly what the deposit would have minted, once", async () => {
    const w = await loadFixture(deposited);
    const fees0 = await w.vault.feesAccrued();
    const backing0 = await w.vault.backing();
    const r = { nonce: 1n, recipient: w.bob.address, units: w.minted[1] };
    expect(await w.vault.isRefunded(1)).to.equal(false);
    await expect(refundWith(w, r)).to.emit(w.vault, "Refunded").withArgs(1n, w.bob.address, w.minted[1]);
    expect(await w.token.balanceOf(w.bob.address)).to.equal(w.minted[1]);
    // The deposit fee stays as fees; no release fee is taken.
    expect(await w.vault.feesAccrued()).to.equal(fees0);
    expect(await w.vault.backing()).to.equal(backing0 - w.minted[1]);
    expect(await w.vault.isRefunded(1)).to.equal(true);
    expect(await w.vault.depositMinted(1)).to.equal(0n);
    expect(await w.vault.isRefunded(0)).to.equal(false);
    await expectBooksBalance(w);
  });

  it("rejects a second refund of the same nonce, whatever the signatures", async () => {
    const w = await loadFixture(deposited);
    const r = { nonce: 0n, recipient: w.alice.address, units: w.minted[0] };
    const sigs = await signRefund(w.vault, sortByAddress(w.signerWallets).slice(0, 3), r);
    await w.vault.refund(r, sigs);
    await expect(w.vault.refund(r, sigs)).to.be.revertedWithCustomError(w.vault, "AlreadyRefunded").withArgs(0n);
    await expect(refundWith(w, { ...r, recipient: w.carol.address }, 5)).to.be.revertedWithCustomError(
      w.vault,
      "AlreadyRefunded",
    );
    await expect(refundWith(w, { ...r, units: 0n })).to.be.revertedWithCustomError(w.vault, "AlreadyRefunded");
  });

  it("rejects nonces at or beyond depositNonce", async () => {
    const w = await loadFixture(deposited);
    expect(await w.vault.depositNonce()).to.equal(3n);
    for (const nonce of [3n, 4n, 2n ** 64n - 1n]) {
      await expect(refundWith(w, { nonce, recipient: w.alice.address, units: 1n }))
        .to.be.revertedWithCustomError(w.vault, "UnknownDeposit")
        .withArgs(nonce);
    }
    // Once the deposit exists, a refund signed for it in advance becomes valid.
    const r = { nonce: 3n, recipient: w.carol.address, units: 19_500_000n };
    const sigs = await signRefund(w.vault, sortByAddress(w.signerWallets).slice(0, 3), r);
    await expect(w.vault.refund(r, sigs)).to.be.revertedWithCustomError(w.vault, "UnknownDeposit");
    await depositFrom(w, w.carol, 20n * USDT);
    await expect(w.vault.refund(r, sigs)).to.emit(w.vault, "RefundQueued");
  });

  it("must return exactly the minted amount: not the gross deposit, not more, not less", async () => {
    const w = await loadFixture(deposited);
    for (const units of [1_000n * USDT, w.minted[0] + 1n, w.minted[0] - 1n, 0n]) {
      await expect(refundWith(w, { nonce: 0n, recipient: w.alice.address, units }))
        .to.be.revertedWithCustomError(w.vault, "WrongRefundAmount")
        .withArgs(w.minted[0], units);
    }
  });

  it("needs the same quorum as a release, bound to the message", async () => {
    const w = await loadFixture(deposited);
    const r = { nonce: 2n, recipient: w.alice.address, units: w.minted[2] };
    const sorted = sortByAddress(w.signerWallets);
    await expect(w.vault.refund(r, await signRefund(w.vault, sorted.slice(0, 2), r))).to.be.revertedWithCustomError(
      w.vault,
      "NotEnoughSignatures",
    );
    await expect(
      w.vault.refund(r, await signRefund(w.vault, [sorted[1], sorted[0], sorted[2]], r)),
    ).to.be.revertedWithCustomError(w.vault, "SignaturesNotSorted");
    const sigs = await signRefund(w.vault, sorted.slice(2, 5), r);
    await expectBadSignatures(w.vault, w.vault.refund({ ...r, recipient: w.carol.address }, sigs));
    await expectBadSignatures(w.vault, w.vault.refund(r, await signRefund(w.vault, sorted.slice(0, 3), r, { chainId: 1n })));
    // Release signatures over look-alike fields can't pass as a Refund.
    const asRelease = { redeemId: ethers.zeroPadValue("0x02", 32), recipient: w.alice.address, units: w.minted[2] };
    await expectBadSignatures(w.vault, w.vault.refund(r, await signRelease(w.vault, sorted.slice(0, 3), asRelease)));
    await expect(w.vault.refund(r, sigs)).to.emit(w.vault, "RefundQueued");
  });

  it("shares the release allowance", async () => {
    const w = await loadFixture(deposited);
    await w.vault.setReleaseLimits(1_500n * USDT, 0);
    // A 1 005 USDT release draws its gross units (1 000 paid, 5 fee), leaving 495.
    await releaseWith(w, { redeemId: newRedeemId(), recipient: w.carol.address, units: 1_005n * USDT });
    expect(await w.vault.releaseAvailable()).to.equal(495n * USDT);
    // Refund 0 (998 USDT) doesn't fit; refund 1 (49.5 USDT) does.
    await expect(refundWith(w, { nonce: 0n, recipient: w.alice.address, units: w.minted[0] }))
      .to.be.revertedWithCustomError(w.vault, "ReleaseLimit")
      .withArgs(w.minted[0], 495n * USDT);
    await refundWith(w, { nonce: 1n, recipient: w.bob.address, units: w.minted[1] });
    expect(await w.vault.releaseAvailable()).to.equal(495n * USDT - w.minted[1]);
    // And a refund leaves less for releases.
    await expect(
      releaseWith(w, { redeemId: newRedeemId(), recipient: w.carol.address, units: 460n * USDT }),
    ).to.be.revertedWithCustomError(w.vault, "ReleaseLimit");
  });

  it("is stopped by pause", async () => {
    const w = await loadFixture(deposited);
    await w.vault.connect(w.guardian).pause();
    await expect(
      refundWith(w, { nonce: 0n, recipient: w.alice.address, units: w.minted[0] }),
    ).to.be.revertedWithCustomError(w.vault, "EnforcedPause");
  });

  it("rejects bad recipients", async () => {
    const w = await loadFixture(deposited);
    for (const recipient of [ethers.ZeroAddress, await w.vault.getAddress()]) {
      await expect(refundWith(w, { nonce: 0n, recipient, units: w.minted[0] })).to.be.revertedWithCustomError(
        w.vault,
        "BadRecipient",
      );
    }
  });

  it("can't pay out of the fees once the backing is gone", async () => {
    const w = await loadFixture(deposited);
    // Release all the backing (a misbehaving quorum, within the allowance)...
    const all = await w.vault.backing();
    await releaseWith(w, { redeemId: newRedeemId(), recipient: w.carol.address, units: all });
    expect(await w.vault.backing()).to.equal(0n);
    // ...then a refund has nothing to draw on, even though fees remain in the vault.
    await expect(
      refundWith(w, { nonce: 1n, recipient: w.bob.address, units: w.minted[1] }),
    ).to.be.revertedWithCustomError(w.vault, "InsufficientBacking");
    await expectBooksBalance(w);
  });
});
