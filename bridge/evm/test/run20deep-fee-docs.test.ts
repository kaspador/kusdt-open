// Second outside review of rc.22, deep round, D9-2: the bridge-in page promised 0.50 % "on a quiet day" for deposits
// the vault charges more for, and some rows of its table were wrong at the launch values. Every deposit fee the docs
// give as an example is checked here against the vault itself, at the mainnet launch values: feeBps 50 (0.50 %), a
// 0.50 USDT minimum fee, deposits of 10 to 8 000 USDT, and each vault's deposit meter of 12 500 USDT (a quarter of
// the signers' 50 000 daily limit, the owner's decision of 14 November 2026 on run 21, R21-ECON-1) rising to 2.50 %
// when full. The meter is filled to the level an example names by
// deposits mined in the same block as the example's own, so nothing drains between them.
//
// The figures are those of docs/src/content/docs/getting-started/bridge-in.mdx, protocol/fees.md and
// security/known-limits.md ("The daily limit can be used up by one party"). A change of them there is made here too.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { USDT, deployWorld, type World } from "./helpers";

const LAUNCH = {
  feeBps: 50,
  minDepositFee: USDT / 2n,
  minReleaseFee: 5n * USDT,
  minDeposit: 10n * USDT,
  maxDeposit: 8_000n * USDT,
  releaseCapacity: 50_000n * USDT,
  releaseRefillPerSecond: 578_703n,
};
const SURGE_BPS = 250;
const METER = 12_500n * USDT;

async function launchVault(surge = true): Promise<World> {
  const w = await deployWorld(6, LAUNCH as any);
  if (surge) await w.vault.setDepositSurge(SURGE_BPS, METER);
  await w.token.mint(w.alice.address, 200_000n * USDT);
  await w.token.connect(w.alice).approve(await w.vault.getAddress(), 200_000n * USDT);
  return w;
}

/** The fees the vault charges for `deposits`, made one after another in one block (so the meter does not drain between them). */
async function feesInOneBlock(w: World, deposits: bigint[]): Promise<bigint[]> {
  await network.provider.send("evm_setAutomine", [false]);
  try {
    const sent = [];
    for (const units of deposits) sent.push(await w.vault.connect(w.alice).deposit(units, 0, ethers.id("kaspa-owner")));
    await network.provider.send("evm_mine", []);
    const fees: bigint[] = [];
    for (const tx of sent) {
      const receipt = (await tx.wait())!;
      const log = receipt.logs.map((l) => { try { return w.vault.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "Deposit")!;
      fees.push(log.args.fee as bigint);
    }
    expect(new Set(await Promise.all(sent.map(async (t) => (await t.wait())!.blockNumber))).size).to.equal(1);
    return fees;
  } finally {
    await network.provider.send("evm_setAutomine", [true]);
  }
}

/** Deposits that bring an empty meter to `level`, each at most the maximum deposit. */
function fillTo(level: bigint): bigint[] {
  const out: bigint[] = [];
  for (let left = level; left > 0n; left -= left > LAUNCH.maxDeposit ? LAUNCH.maxDeposit : left) out.push(left > LAUNCH.maxDeposit ? LAUNCH.maxDeposit : left);
  return out;
}

/** The fee of one deposit of `units` with the meter at `meter` (from empty, in the same block). */
async function feeOf(units: bigint, meter: bigint, surge = true): Promise<bigint> {
  const w = await launchVault(surge);
  const fees = await feesInOneBlock(w, [...fillTo(meter), units]);
  return fees.at(-1)!;
}

const usdt = (units: bigint) => `${units / USDT}.${String((units % USDT) / 10_000n).padStart(2, "0")}`;

describe("the deposit fee examples in the docs, against the vault at the launch values (D9-2)", () => {
  it("bridge-in.mdx, What you receive: an empty meter, 10 to 8 000 USDT: 0.50 %, at least 0.50 USDT, up to 6 250", async () => {
    const rows: [bigint, string, string][] = [
      [10n, "0.50", "9.50"],
      [100n, "0.50", "99.50"],
      [250n, "1.25", "248.75"],
      [1_000n, "5.00", "995.00"],
      // The report's figure (run 21, R21-ECON-1): 6 250 at 0.50 %, the last 1 750 on the line.
      [8_000n, "44.90", "7955.10"],
    ];
    for (const [deposit, fee, minted] of rows) {
      const got = await feeOf(deposit * USDT, 0n);
      expect(usdt(got), `${deposit} USDT`).to.equal(fee);
      expect(usdt(deposit * USDT - got), `${deposit} USDT minted`).to.equal(minted);
    }
  });

  it("bridge-in.mdx: on the testnet's flat fee, 10 000 USDT pays 50.00 and 100 000 USDT 500.00", async () => {
    const w = await deployWorld(6, { ...LAUNCH, maxDeposit: 100_000n * USDT } as any);
    await w.token.mint(w.alice.address, 200_000n * USDT);
    await w.token.connect(w.alice).approve(await w.vault.getAddress(), 200_000n * USDT);
    const [a, b] = await feesInOneBlock(w, [10_000n * USDT, 100_000n * USDT]);
    expect([usdt(a), usdt(b)]).to.deep.equal(["50.00", "500.00"]);
  });

  it("bridge-in.mdx: the 0.50 % holds only while the deposit fits under half the meter (6 250)", async () => {
    // 6 250 on an empty meter fits; 1 000 on a meter at 5 250 fits too; with 100 more, 100 of it is on the line.
    expect(usdt(await feeOf(6_250n * USDT, 0n))).to.equal("31.25");
    expect(usdt(await feeOf(1_000n * USDT, 5_250n * USDT))).to.equal("5.00");
    expect(await feeOf(1_000n * USDT, 5_350n * USDT)).to.equal(5_016_000n);
    // 8 000 on a meter at 2 500: 3 750 of it under half, 4 250 on the line; at 6 250, 6 250 on the line and 1 750 at the top.
    expect(usdt(await feeOf(8_000n * USDT, 2_500n * USDT))).to.equal("68.90");
    expect(usdt(await feeOf(8_000n * USDT, 6_250n * USDT))).to.equal("137.50");
  });

  it("fees.md, The rising deposit fee: the table at a 12 500 USDT meter", async () => {
    const rows: [bigint, bigint, string][] = [
      [1_000n, 0n, "5.00"],
      [8_000n, 0n, "44.90"],
      [8_000n, 6_250n, "137.50"],
      [1_000n, 9_375n, "16.60"],
      [1_000n, 12_500n, "25.00"],
    ];
    for (const [deposit, meter, fee] of rows) expect(usdt(await feeOf(deposit * USDT, meter * USDT)), `${deposit} at ${meter}`).to.equal(fee);
  });

  it("known-limits.md: filling a meter from empty costs 125 USDT on 12 500 (250 on both vaults' 25 000), against 62.50 flat", async () => {
    const w = await launchVault();
    const fees = await feesInOneBlock(w, fillTo(METER));
    const total = fees.reduce((a, b) => a + b, 0n);
    // Each deposit's fee rounds up once: a unit or so a deposit above the exact 125.
    expect(total >= 125n * USDT && total <= 125n * USDT + BigInt(fees.length)).to.equal(true);
    const flat = await launchVault(false);
    const flatFees = await feesInOneBlock(flat, fillTo(METER));
    expect(flatFees.reduce((a, b) => a + b, 0n)).to.equal(62_500_000n);
  });

  it("known-limits.md: the whole 50 000 of a day's limit at once, 25 000 per vault, costs about 875 USDT, against 250 flat", async () => {
    // Per vault: the meter filled from empty (125), then 12 500 more at the full 2.50 % (312.50).
    const w = await launchVault();
    const fees = await feesInOneBlock(w, fillTo(2n * METER));
    const total = fees.reduce((a, b) => a + b, 0n);
    expect(total >= 437_500_000n && total <= 437_500_000n + BigInt(fees.length)).to.equal(true);
    expect(await w.vault.depositMeterNow()).to.equal(METER);
  });
});
