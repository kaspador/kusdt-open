import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  DEFAULTS,
  USDT,
  World,
  deployWorld,
  depositFrom,
  feeOf,
  newRedeemId,
  refundWith,
  releaseWith,
  revertName,
} from "./helpers";

/** Small deterministic PRNG (mulberry32), so a failure can be replayed with the same seed. */
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
  const big = (lo: bigint, hi: bigint) => lo + (BigInt(Math.floor(next() * 2 ** 52)) * (hi - lo + 1n)) / 2n ** 52n;
  return { next, int, big };
}

const SEED = Number(process.env.INVARIANT_SEED ?? 20261103);
const STEPS = Number(process.env.INVARIANT_STEPS ?? 250);

/**
 * Model of the bridge as the vault sees it:
 *  - each deposit is either minted on Kaspa (adds to kUSDT circulation) or skipped
 *    (refundable once, for exactly what it would have minted);
 *  - releases burn circulation;
 *  - fees accrue and are withdrawn.
 * After every step: balance (units) == backing + feesAccrued, backing ≥ 0, the vault
 * matches the model exactly, and INV-1 holds: circulation ≤ backing.
 */
async function run(decimals: number, seed: number) {
  const w: World = await deployWorld(decimals, {
    ...DEFAULTS,
    minDeposit: 1n * USDT,
    maxDeposit: 20_000n * USDT,
    // A tight allowance so the limit is hit often.
    releaseCapacity: 20_000n * USDT,
    releaseRefillPerSecond: (20_000n * USDT) / 86_400n,
  });
  const rnd = prng(seed);
  const users = [w.alice, w.bob, w.carol, ...w.others.slice(0, 3)];
  const vaultAddr = await w.vault.getAddress();

  let fees = 0n;
  let backing = 0n;
  let circulation = 0n; // kUSDT on Kaspa
  const skipped = new Map<bigint, bigint>(); // nonce -> minted, not yet refunded
  const refunded = new Set<bigint>();
  let nonce = 0n;
  let feeBps = BigInt(DEFAULTS.feeBps);
  let minDepFee = DEFAULTS.minDepositFee;
  let minRelFee = DEFAULTS.minReleaseFee;
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  for (let step = 0; step < STEPS; step++) {
    const roll = rnd.next();
    if (roll < 0.35) {
      // Deposit, sometimes out of range.
      const who = users[rnd.int(0, users.length - 1)];
      const units = rnd.next() < 0.1 ? rnd.big(0n, 2n * USDT) : rnd.big(1n * USDT, rnd.next() < 0.1 ? 21_000n * USDT : 3_000n * USDT);
      const fee = feeOf(units, feeBps, minDepFee);
      const ok = units >= 1n * USDT && units <= 20_000n * USDT && units > fee;
      if (ok) {
        await depositFrom(w, who, units, rnd.int(0, 4));
        fees += fee;
        const minted = units - fee;
        backing += minted;
        if (rnd.next() < 0.2) skipped.set(nonce, minted);
        else circulation += minted;
        nonce++;
        bump("deposit");
      } else {
        await expect(depositFrom(w, who, units)).to.be.reverted;
        bump("deposit-rejected");
      }
    } else if (roll < 0.65) {
      // Release a burn of up to the circulation (sometimes more than the backing, which must fail).
      if (circulation === 0n) continue;
      const r0 = rnd.next();
      const small = circulation < 8_000n * USDT ? circulation : 8_000n * USDT;
      const units =
        r0 < 0.1 ? backing + rnd.big(1n, 100n * USDT) : r0 < 0.85 ? rnd.big(1n, small) : rnd.big(1n, circulation);
      const r = { redeemId: newRedeemId(), recipient: users[rnd.int(0, users.length - 1)].address, units };
      const fee = feeOf(units, feeBps, minRelFee);
      const avail = await w.vault.releaseAvailable();
      const name = await revertName(w.vault, releaseWith(w, r, rnd.int(3, 5))).catch(() => "ok");
      if (name === "ok") {
        expect(units).to.be.greaterThan(fee);
        expect(units).to.be.lessThanOrEqual(backing);
        circulation -= units;
        backing -= units;
        fees += fee;
        bump("release");
        if (rnd.next() < 0.3) {
          await expect(releaseWith(w, r)).to.be.revertedWithCustomError(w.vault, "AlreadyRedeemed");
          bump("replay-rejected");
        }
      } else {
        expect(["AmountNotAboveFee", "ReleaseLimit", "InsufficientBacking"]).to.include(name);
        if (name === "ReleaseLimit") expect(units).to.be.greaterThan(avail);
        if (name === "InsufficientBacking") expect(units).to.be.greaterThan(backing);
        bump(`release-${name}`);
      }
    } else if (roll < 0.78) {
      // Refund a skipped deposit, or try a bad one.
      const keys = [...skipped.keys()];
      const pickRefunded = rnd.next() < 0.2 && refunded.size > 0;
      if (pickRefunded) {
        const n = [...refunded][rnd.int(0, refunded.size - 1)];
        await expect(refundWith(w, { nonce: n, recipient: w.alice.address, units: 1n })).to.be.revertedWithCustomError(
          w.vault,
          "AlreadyRefunded",
        );
        bump("double-refund-rejected");
      } else if (rnd.next() < 0.1) {
        await expect(
          refundWith(w, { nonce: nonce + BigInt(rnd.int(0, 3)), recipient: w.alice.address, units: 1n }),
        ).to.be.revertedWithCustomError(w.vault, "UnknownDeposit");
        bump("future-refund-rejected");
      } else if (keys.length > 0) {
        const n = keys[rnd.int(0, keys.length - 1)];
        const units = skipped.get(n)!;
        const name = await revertName(
          w.vault,
          refundWith(w, { nonce: n, recipient: users[rnd.int(0, users.length - 1)].address, units }),
        ).catch(() => "ok");
        if (name === "ok") {
          skipped.delete(n);
          refunded.add(n);
          backing -= units;
          bump("refund");
        } else {
          expect(name).to.equal("ReleaseLimit");
          bump("refund-ReleaseLimit");
        }
      }
    } else if (roll < 0.86) {
      // Time passes.
      await time.increase(rnd.int(1, 12 * 3600));
      bump("time");
    } else if (roll < 0.93) {
      // Owner withdraws some fees (sometimes too much, which must fail).
      const want = rnd.next() < 0.15 ? fees + 1n : rnd.big(0n, fees);
      if (want > fees) {
        await expect(w.vault.withdrawFees(w.owner.address, want)).to.be.revertedWithCustomError(w.vault, "FeesExceeded");
        bump("withdraw-rejected");
      } else {
        await w.vault.withdrawFees(w.owner.address, want);
        fees -= want;
        bump("withdraw");
      }
    } else if (roll < 0.97) {
      // Owner changes fees within bounds.
      feeBps = BigInt(rnd.int(0, 100));
      minDepFee = rnd.big(0n, 2n * USDT);
      minRelFee = rnd.big(0n, 10n * USDT);
      await w.vault.setFees(Number(feeBps), minDepFee, minRelFee);
      bump("setFees");
    } else {
      // Someone donates tokens directly: backing goes up, fees don't.
      const units = rnd.big(1n, 10n * USDT);
      await w.token.mint(vaultAddr, units * w.scale);
      backing += units;
      bump("donation");
    }

    const bal = await w.token.balanceOf(vaultAddr);
    const vFees = await w.vault.feesAccrued();
    const vBacking = await w.vault.backing();
    expect(bal % w.scale, `step ${step}: dust`).to.equal(0n);
    expect(bal / w.scale, `step ${step}: balance == backing + fees`).to.equal(vBacking + vFees);
    expect(bal / w.scale >= vFees, `step ${step}: backing >= 0`).to.equal(true);
    expect(vFees, `step ${step}: fees model`).to.equal(fees);
    expect(vBacking, `step ${step}: backing model`).to.equal(backing);
    expect(circulation <= vBacking, `step ${step}: INV-1`).to.equal(true);
    expect(await w.vault.depositNonce()).to.equal(nonce);
    expect(await w.vault.releaseAvailable()).to.be.lessThanOrEqual(20_000n * USDT);
  }
  // Every deposit is accounted for exactly once (INV-2 from the vault's side).
  for (let n = 0n; n < nonce; n++) {
    expect(await w.vault.isRefunded(n)).to.equal(refunded.has(n));
  }
  return counts;
}

describe("KusdtVault: randomized invariants", () => {
  for (const decimals of [6, 18]) {
    it(`${STEPS} random steps, ${decimals} decimals (seed ${SEED})`, async function () {
      this.timeout(600_000);
      const counts = await run(decimals, SEED + decimals);
      // The run must have exercised the interesting paths.
      for (const k of ["deposit", "release", "release-ReleaseLimit", "refund", "withdraw", "time"]) {
        expect(counts[k] ?? 0, `no ${k} in the run: ${JSON.stringify(counts)}`).to.be.greaterThan(0);
      }
      console.log(`      ${JSON.stringify(counts)}`);
    });
  }
});
