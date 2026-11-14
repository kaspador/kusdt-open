// The deposit fee that rises with the day's deposits (rc.16), and the guard that goes with it.
//
// Why: the signers sign for a limited amount a day, so someone who deposits that much keeps everyone else's
// deposits waiting for the price of the plain fee. The fee now rises as a vault's deposits of the day approach
// `surgeCapacity`: feeBps under half of it, a straight line up to surgeFeeBps at all of it, surgeFeeBps beyond.
// Because the fee then depends on who deposited just before, `depositAtLeast` lets a depositor bound it.
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { DEFAULTS, USDT, deployWorld, depositFrom, expectBooksBalance, refundWith, type World } from "./helpers";

const BASE = 50n; // 0.50 %
const TOP = 250n; // 2.50 %
const CAP = 25_000n * USDT;
const P = { ...DEFAULTS, feeBps: Number(BASE), minDepositFee: 500_000n };

/** The fee as the contract computes it, written again here from its description. */
function feeAt(units: bigint, used: bigint, p: { base: bigint; top: bigint; cap: bigint; minFee: bigint }): bigint {
  let weighted = units * p.base;
  if (p.cap !== 0n && p.top > p.base) {
    const half = p.cap / 2n, span = p.cap - half, end = used + units;
    const clamp = (x: bigint) => (x < half ? half : x > p.cap ? p.cap : x);
    const lo = clamp(used), hi = clamp(end);
    if (hi > lo) weighted += ((p.top - p.base) * ((hi - half) ** 2n - (lo - half) ** 2n)) / (2n * span);
    if (end > p.cap) weighted += (end - (used > p.cap ? used : p.cap)) * (p.top - p.base);
  }
  const prop = (weighted + 9_999n) / 10_000n;
  return prop > p.minFee ? prop : p.minFee;
}

/** The same fee one unit at a time: each unit at the rate of the level it goes in at (its midpoint), in exact fractions. */
function feeUnitByUnit(units: bigint, used: bigint, p: { base: bigint; top: bigint; cap: bigint }): { num: bigint; den: bigint } {
  const half = p.cap / 2n, span = p.cap - half;
  // rate(x) × 2·span, for x = level + 1/2, in basis points.
  let num = 0n;
  for (let k = 0n; k < units; k++) {
    const twiceX = 2n * (used + k) + 1n; // 2x
    if (twiceX <= 2n * half) num += p.base * 2n * span;
    else if (twiceX >= 2n * p.cap) num += p.top * 2n * span;
    else num += p.base * 2n * span + (p.top - p.base) * (twiceX - 2n * half);
  }
  return { num, den: 2n * span * 10_000n };
}

async function surged(): Promise<World> {
  const w = await deployWorld(6, P as any);
  await w.vault.setDepositSurge(Number(TOP), CAP);
  return w;
}
const plain = () => deployWorld(6, P as any);

/** Deposits and returns the fee the vault charged (from its event) and the block's time. */
async function depositFee(w: World, units: bigint, who = w.alice) {
  const tx = await depositFrom(w, who, units);
  const receipt = await tx.wait();
  const log = receipt!.logs.map((l) => { try { return w.vault.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "Deposit")!;
  return { fee: log.args.fee as bigint, minted: log.args.minted as bigint, at: BigInt((await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp) };
}
/** What the meter holds at time `at`, from the vault's stored values. */
async function meterAt(w: World, at: bigint): Promise<bigint> {
  const [meter, since, cap] = [await w.vault.depositMeter(), await w.vault.depositMeterAt(), await w.vault.surgeCapacity()];
  if (cap === 0n) return 0n;
  const drained = ((at - since) * cap) / 86_400n;
  return meter > drained ? meter - drained : 0n;
}
const params = { base: BASE, top: TOP, cap: CAP, minFee: P.minDepositFee };

describe("the rising deposit fee", () => {
  describe("the formula", () => {
    it("equals the unit-by-unit sum, for every level and size of a small meter", () => {
      const p = { base: 50n, top: 250n, cap: 400n, minFee: 0n };
      for (let used = 0n; used <= 420n; used += 7n) {
        for (const units of [1n, 2n, 3n, 10n, 57n, 199n, 200n, 201n, 399n, 400n, 401n, 900n]) {
          const exact = feeUnitByUnit(units, used > p.cap ? p.cap : used, p);
          const ceil = (exact.num + exact.den - 1n) / exact.den;
          const got = feeAt(units, used > p.cap ? p.cap : used, p);
          // The line's part is rounded down once before the whole is rounded up: never above the exact fee's ceiling, at most one unit under.
          expect(got <= ceil && ceil - got <= 1n, `used ${used}, units ${units}: ${got} against ${ceil}`).to.equal(true);
        }
      }
    });

    it("splitting a deposit never makes it cheaper by more than the rounding", () => {
      const p = { base: 50n, top: 250n, cap: 25_000n * USDT, minFee: 0n };
      for (const used of [0n, 10_000n * USDT, 12_499n * USDT, 20_000n * USDT, 24_999n * USDT]) {
        const whole = feeAt(8_000n * USDT, used, p);
        let parts = 0n, level = used;
        for (let i = 0; i < 80; i++) { parts += feeAt(100n * USDT, level, p); level += 100n * USDT; }
        expect(parts >= whole, `from ${used}`).to.equal(true);
        expect(parts - whole <= 80n, `from ${used}`).to.equal(true);
      }
    });

    it("is never above the top rate, and never under the plain rate", () => {
      const p = { base: 50n, top: 250n, cap: 25_000n * USDT, minFee: 0n };
      for (const used of [0n, 1n, 12_500n * USDT, 24_000n * USDT, 25_000n * USDT]) {
        for (const units of [1n, 10n * USDT, 8_000n * USDT, 100_000n * USDT]) {
          const fee = feeAt(units, used, p);
          expect(fee <= (units * p.top + 9_999n) / 10_000n).to.equal(true);
          expect(fee >= (units * p.base + 9_999n) / 10_000n).to.equal(true);
        }
      }
    });
  });

  describe("off until the owner sets it", () => {
    it("a new vault charges the plain fee whatever is deposited", async () => {
      const w = await loadFixture(plain);
      expect(await w.vault.surgeCapacity()).to.equal(0n);
      for (let i = 0; i < 4; i++) {
        const { fee } = await depositFee(w, 20_000n * USDT);
        expect(fee).to.equal(100n * USDT);
      }
      expect(await w.vault.depositMeterNow()).to.equal(0n);
      expect(await w.vault.depositMeter()).to.equal(0n);
    });

    it("only the owner sets it, within the hard limits", async () => {
      const w = await loadFixture(plain);
      await expect(w.vault.connect(w.alice).setDepositSurge(250, CAP)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
      await expect(w.vault.connect(w.guardian).setDepositSurge(250, CAP)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
      await expect(w.vault.setDepositSurge(301, CAP)).to.be.revertedWithCustomError(w.vault, "FeeTooHigh");
      await expect(w.vault.setDepositSurge(250, 1)).to.be.revertedWithCustomError(w.vault, "BadLimits");
      await expect(w.vault.setDepositSurge(250, (await w.vault.MAX_AMOUNT()) + 1n)).to.be.revertedWithCustomError(w.vault, "BadLimits");
      await expect(w.vault.setDepositSurge(300, CAP)).to.emit(w.vault, "DepositSurgeSet").withArgs(300, CAP);
      expect(await w.vault.MAX_SURGE_FEE_BPS()).to.equal(300n);
      // The plain fee's own limit is untouched.
      await expect(w.vault.setFees(101, 0, 0)).to.be.revertedWithCustomError(w.vault, "FeeTooHigh");
    });

    it("a top rate that is not above the plain rate changes nothing", async () => {
      const w = await loadFixture(plain);
      await w.vault.setDepositSurge(Number(BASE), CAP);
      for (let i = 0; i < 3; i++) expect((await depositFee(w, 20_000n * USDT)).fee).to.equal(100n * USDT);
    });
  });

  describe("on", () => {
    it("charges the plain fee under half the capacity, a rising one up to it, and the top rate beyond", async () => {
      const w = await loadFixture(surged);
      // 0 → 10 000: all under half (12 500).
      const a = await depositFee(w, 10_000n * USDT);
      expect(a.fee).to.equal(50n * USDT);
      // 10 000 → 15 000: 2 500 plain, 2 500 on the first fifth of the line (0.10 % more on average): about 25 + 5.
      const b = await depositFee(w, 5_000n * USDT);
      expect(b.fee).to.be.closeTo(30n * USDT, USDT / 20n);
      // 15 000 → 25 000: the rest of the line, 1.20 % more on average: about 50 + 120.
      const c = await depositFee(w, 10_000n * USDT);
      expect(c.fee).to.be.closeTo(170n * USDT, USDT / 10n);
      // Beyond the capacity: 2.50 %.
      const d = await depositFee(w, 1_000n * USDT);
      expect(d.fee).to.be.closeTo(25n * USDT, USDT / 50n);
      // Filling the whole capacity cost about twice the plain fee on it.
      expect(a.fee + b.fee + c.fee).to.be.closeTo(250n * USDT, USDT / 5n);
      await expectBooksBalance(w);
    });

    it("every deposit pays exactly what the formula gives for the meter at its block", async () => {
      const w = await loadFixture(surged);
      let seed = 20261110n;
      const next = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n));
      for (let i = 0; i < 40; i++) {
        const units = 10n * USDT + (next() % (9_000n * USDT));
        if (next() % 4n === 0n) await time.increase(Number(next() % 20_000n));
        const stored = { meter: await w.vault.depositMeter(), since: await w.vault.depositMeterAt() };
        const { fee, minted, at } = await depositFee(w, units);
        const drained = ((at - stored.since) * CAP) / 86_400n;
        const used = stored.meter > drained ? stored.meter - drained : 0n;
        expect(fee, `deposit ${i}`).to.equal(feeAt(units, used, params));
        expect(minted).to.equal(units - fee);
        const filled = used + units;
        expect(await w.vault.depositMeter()).to.equal(filled > CAP ? CAP : filled);
      }
      await expectBooksBalance(w);
    });

    it("the view says what the next deposit would pay", async () => {
      const w = await loadFixture(surged);
      await depositFee(w, 14_000n * USDT);
      const quoted = await w.vault.depositFeeOf(6_000n * USDT);
      const now = BigInt(await time.latest());
      expect(quoted).to.equal(feeAt(6_000n * USDT, await meterAt(w, now), params));
      // One block later the meter has drained a little: the deposit pays that or a touch less, never more.
      const { fee } = await depositFee(w, 6_000n * USDT);
      expect(fee <= quoted).to.equal(true);
      expect(quoted - fee < USDT).to.equal(true);
    });

    it("the meter drains over a day, and the fee comes back down with it", async () => {
      const w = await loadFixture(surged);
      await depositFee(w, 25_000n * USDT);
      expect(await w.vault.depositMeterNow()).to.be.closeTo(CAP, USDT);
      await time.increase(43_200);
      expect(await w.vault.depositMeterNow()).to.be.closeTo(CAP / 2n, USDT);
      await time.increase(43_200);
      expect(await w.vault.depositMeterNow()).to.equal(0n);
      expect((await depositFee(w, 10_000n * USDT)).fee).to.equal(50n * USDT);
    });

    it("the meter never holds more than the capacity: a flood pays the top rate and is over in a day", async () => {
      const w = await loadFixture(surged);
      for (let i = 0; i < 3; i++) await depositFee(w, 100_000n * USDT);
      expect(await w.vault.depositMeter()).to.equal(CAP);
      expect((await depositFee(w, 1_000n * USDT)).fee).to.be.closeTo(25n * USDT, USDT / 50n);
      await time.increase(86_400);
      expect((await depositFee(w, 1_000n * USDT)).fee).to.equal(5n * USDT);
    });

    it("the minimum fee still applies", async () => {
      const w = await loadFixture(surged);
      expect((await depositFee(w, 10n * USDT)).fee).to.equal(P.minDepositFee);
    });

    it("a new capacity keeps what the meter holds, up to the new capacity; off clears it", async () => {
      const w = await loadFixture(surged);
      await depositFee(w, 20_000n * USDT);
      await w.vault.setDepositSurge(Number(TOP), 10_000n * USDT);
      expect(await w.vault.depositMeter()).to.equal(10_000n * USDT);
      await w.vault.setDepositSurge(Number(TOP), 50_000n * USDT);
      expect(await w.vault.depositMeter()).to.be.closeTo(10_000n * USDT, USDT);
      await w.vault.setDepositSurge(0, 0);
      expect(await w.vault.depositMeter()).to.equal(0n);
      expect((await depositFee(w, 20_000n * USDT)).fee).to.equal(100n * USDT);
    });

    it("a refund returns what was minted, and the higher fee stays in the fees", async () => {
      const w = await loadFixture(surged);
      await depositFee(w, 24_000n * USDT);
      const { minted, fee } = await depositFee(w, 5_000n * USDT, w.bob);
      expect(fee > 25n * USDT * 2n).to.equal(true);
      const nonce = (await w.vault.depositNonce()) - 1n;
      const fees = await w.vault.feesAccrued();
      await refundWith(w, { nonce, recipient: w.bob.address, units: minted });
      expect(await w.token.balanceOf(w.bob.address)).to.equal(minted * w.scale);
      expect(await w.vault.feesAccrued()).to.equal(fees);
      await expectBooksBalance(w);
    });

    it("on a token of 18 decimals the fee is counted in the same units", async () => {
      const w = await deployWorld(18, P as any);
      await w.vault.setDepositSurge(Number(TOP), CAP);
      expect((await depositFee(w, 10_000n * USDT)).fee).to.equal(50n * USDT);
      expect((await depositFee(w, 15_000n * USDT)).fee).to.be.closeTo(200n * USDT, USDT / 5n);
      await expectBooksBalance(w);
    });
  });

  describe("depositAtLeast", () => {
    const owner = ethers.id("kaspa-owner");
    async function ready(w: World, who: World["alice"], units: bigint) {
      await w.token.mint(who.address, units * w.scale);
      await w.token.connect(who).approve(await w.vault.getAddress(), units * w.scale);
    }

    it("goes through when at least that much is minted, and is the same deposit", async () => {
      const w = await loadFixture(surged);
      await ready(w, w.alice, 1_000n * USDT);
      await expect(w.vault.connect(w.alice).depositAtLeast(1_000n * USDT, 0, owner, 995n * USDT))
        .to.emit(w.vault, "Deposit").withArgs(0n, w.alice.address, 0, owner, 1_000n * USDT, 5n * USDT, 995n * USDT);
      expect(await w.vault.depositMinted(0)).to.equal(995n * USDT);
      await expectBooksBalance(w);
    });

    it("reverts, taking nothing, when a deposit that landed first raised the fee", async () => {
      const w = await loadFixture(surged);
      // Bob sees 0.50 % and will accept nothing less.
      const quote = 5_000n * USDT - (await w.vault.depositFeeOf(5_000n * USDT));
      expect(quote).to.equal(4_975n * USDT);
      // Someone fills the day just ahead of him.
      await depositFee(w, 24_000n * USDT, w.alice);
      await ready(w, w.bob, 5_000n * USDT);
      const meter = await w.vault.depositMeter();
      await expect(w.vault.connect(w.bob).depositAtLeast(5_000n * USDT, 0, owner, quote)).to.be.revertedWithCustomError(w.vault, "MintedBelowMinimum");
      expect(await w.token.balanceOf(w.bob.address)).to.equal(5_000n * USDT * w.scale);
      expect(await w.vault.depositMeter()).to.equal(meter); // a refused deposit does not move the meter
      // The plain `deposit` takes whatever the fee is.
      const paid = await w.vault.connect(w.bob).deposit(5_000n * USDT, 0, owner);
      await expect(paid).to.emit(w.vault, "Deposit");
    });

    it("has every other rule of deposit", async () => {
      const w = await loadFixture(surged);
      await ready(w, w.alice, 1_000n * USDT);
      await expect(w.vault.connect(w.alice).depositAtLeast(1n, 0, owner, 0)).to.be.revertedWithCustomError(w.vault, "DepositOutOfRange");
      await expect(w.vault.connect(w.alice).depositAtLeast(1_000n * USDT, 9, owner, 0)).to.be.revertedWithCustomError(w.vault, "BadOwnerScheme");
      await expect(w.vault.connect(w.alice).depositAtLeast(1_000n * USDT, 0, ethers.ZeroHash, 0)).to.be.revertedWithCustomError(w.vault, "ZeroOwner");
      await w.vault.connect(w.guardian).pause();
      await expect(w.vault.connect(w.alice).depositAtLeast(1_000n * USDT, 0, owner, 0)).to.be.revertedWithCustomError(w.vault, "EnforcedPause");
    });
  });

  describe("what using up a day costs", () => {
    it("depositing the whole capacity costs about twice the plain fee, however it is split", async () => {
      const w = await loadFixture(surged);
      let total = 0n;
      for (let i = 0; i < 25; i++) total += (await depositFee(w, 1_000n * USDT)).fee;
      // 125 at the plain rate, 125 more from the line (a little less: the meter drains a few units between blocks).
      expect(total).to.be.closeTo(250n * USDT, USDT);
      expect(total > 240n * USDT).to.equal(true);
    });
  });
});

describe("the rising deposit fee set at creation", () => {
  it("a vault can be born with it on, as a mainnet vault is (its owner is the role manager from the first block)", async () => {
    const [owner, guardian, alice] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockUSDT")).deploy("M", "M", 6);
    const signers = Array.from({ length: 5 }, (_, i) => ethers.Wallet.createRandom().address);
    const f = await ethers.getContractFactory("KusdtVault");
    const vault: any = await f.deploy(await token.getAddress(), 6, signers as any, guardian.address, owner.address, P as any, 600, 250, CAP);
    expect(await vault.surgeFeeBps()).to.equal(250n);
    expect(await vault.surgeCapacity()).to.equal(CAP);
    expect(await vault.depositMeterNow()).to.equal(0n);
    await token.mint(alice.address, 30_000n * USDT);
    await token.connect(alice).approve(await vault.getAddress(), 30_000n * USDT);
    await vault.connect(alice).deposit(20_000n * USDT, 0, ethers.id("o"));
    expect(await vault.depositFeeOf(1_000n * USDT) > 5n * USDT).to.equal(true);
    // The same hard limits as the setter's.
    await expect(f.deploy(await token.getAddress(), 6, signers as any, guardian.address, owner.address, P as any, 600, 301, CAP)).to.be.revertedWithCustomError(vault, "FeeTooHigh");
    await expect(f.deploy(await token.getAddress(), 6, signers as any, guardian.address, owner.address, P as any, 600, 250, 1)).to.be.revertedWithCustomError(vault, "BadLimits");
  });
});
