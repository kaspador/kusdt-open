import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { KusdtAccessManager, KusdtVault } from "../typechain-types";
import { DEFAULTS, makeWallets } from "./helpers";
import { ADMIN_DELAY, HOUR, ROLES, checkOwnerConfig, setupCalls } from "../scripts/access-manager";

// Round 12 (R12-OWN-3). The documents said that whoever holds a threshold of the Safe's keys "needs about 96 hours,
// not 48, to take a vault's money or to freeze it for good". Both figures overstate what the delays buy:
//
//  - A freeze takes one transaction. The Safe holds PAUSER with no delay, and it may cancel every unpause it has
//    scheduled itself (OpenZeppelin's AccessManager lets the caller of `schedule` cancel). So for as long as someone
//    holds the Safe's keys the vault stays paused, and no guardian or canceller can unpause it. The 96 hours are only
//    what it takes to make the freeze outlast the loss of the keys (the Safe's own roles revoked).
//  - A theft takes 48 hours from the cancellers' last cancel. The removals of the cancellers and the power-adding
//    call can be scheduled together, and a cancelled call can be scheduled again at once. It is 96 hours only when
//    a canceller cancels every re-schedule right up to its own removal.
//
// Nothing here changes a contract: these tests state what the deployed setup does, so the documents can say it.

const EMERGENCY = 6 * HOUR;

async function managed() {
  const [deployer, safe, guardian, canceller, canceller2, thief] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("MockUSDT")).deploy("Mock USDT", "USDT", 6);
  const manager = (await (await ethers.getContractFactory("KusdtAccessManager")).deploy(deployer.address)) as unknown as KusdtAccessManager;
  const vault = (await (await ethers.getContractFactory("KusdtVault")).deploy(
    await token.getAddress(), 6, makeWallets("signer", 5).map((w) => w.address) as any, guardian.address, await manager.getAddress(), DEFAULTS, 0, 0, 0
  )) as unknown as KusdtVault;
  const cfg = checkOwnerConfig({ safe: safe.address, emergencyDelay: EMERGENCY, cancellers: [canceller.address, canceller2.address] }, "test");
  const vaultAddr = await vault.getAddress(), managerAddr = await manager.getAddress();
  await manager.connect(deployer).multicall(setupCalls(cfg, vaultAddr, deployer.address, managerAddr));
  const pause = vault.interface.encodeFunctionData("pause"), unpause = vault.interface.encodeFunctionData("unpause");
  const revokeCanceller = (who: string) => manager.interface.encodeFunctionData("revokeCanceller" as any, [who]);
  const grant = manager.interface.encodeFunctionData("grantRole", [ROLES.GOVERNOR, thief.address, 0]);
  const thiefSigners = makeWallets("thief", 5).map((w) => w.address);
  const setSigners = vault.interface.encodeFunctionData("setSigners", [thiefSigners as any]);
  return { deployer, safe, guardian, canceller, canceller2, thief, manager, vault, vaultAddr, managerAddr, pause, unpause, revokeCanceller, grant, setSigners, thiefSigners };
}

describe("round 12: what stolen Safe keys can do, and how long it takes", () => {
  it("a freeze takes one transaction: the Safe pauses with no delay, and cancels every unpause scheduled through it", async () => {
    const m = await loadFixture(managed);
    const start = await time.latest();
    // Minute 0: the pause. No schedule, no wait.
    await m.manager.connect(m.safe).execute(m.vaultAddr, m.pause);
    expect(await m.vault.paused()).to.equal(true);
    expect((await time.latest()) - start).to.be.lessThan(60);
    // Three rounds of the owners' way back: an unpause is scheduled through the Safe (6 hours), and the same keys
    // cancel it before it is due. The scheduler may always cancel its own operation.
    for (let round = 0; round < 3; round++) {
      await m.manager.connect(m.safe).schedule(m.vaultAddr, m.unpause, 0);
      await time.increase(EMERGENCY - 60);
      await expect(m.manager.connect(m.safe).cancel(m.safe.address, m.vaultAddr, m.unpause)).to.emit(m.manager, "OperationCanceled");
      await time.increase(120);
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, m.unpause)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");
      expect(await m.vault.paused()).to.equal(true);
    }
    expect((await time.latest()) - start).to.be.greaterThan(18 * HOUR);
    // Nobody else has a way back: not the guardian (it only pauses), not a canceller, not an outsider.
    for (const who of [m.guardian, m.canceller, m.canceller2, m.thief]) {
      await expect(m.manager.connect(who).schedule(m.vaultAddr, m.unpause, 0)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
      await expect(m.manager.connect(who).execute(m.vaultAddr, m.unpause)).to.be.reverted;
      await expect(m.vault.connect(who).unpause()).to.be.reverted;
    }
    expect(await m.vault.paused()).to.equal(true);
  });

  it("a theft takes 48 hours from the cancellers' last cancel: the removals and the grant are scheduled together, and a cancelled grant is scheduled again at once", async () => {
    const m = await loadFixture(managed);
    const start = await time.latest();
    // Minute 0: both cancellers' removals (which no canceller can cancel) and the power-adding grant, together.
    const removals = [m.canceller, m.canceller2].map((c) => m.revokeCanceller(c.address));
    for (const r of removals) await m.manager.connect(m.safe).schedule(m.managerAddr, r, 0);
    await m.manager.connect(m.safe).schedule(m.managerAddr, m.grant, 0);
    // Hour 1: a canceller cancels the grant. The thief schedules it again in the next block.
    await time.increase(HOUR);
    await m.manager.connect(m.canceller).cancel(m.safe.address, m.managerAddr, m.grant);
    await m.manager.connect(m.safe).schedule(m.managerAddr, m.grant, 0);
    // Hour 48: the cancellers are out. Nobody is left who can cancel the grant that is still waiting.
    await time.increaseTo(start + ADMIN_DELAY + 10);
    for (const r of removals) await m.manager.connect(m.safe).execute(m.managerAddr, r);
    for (const c of [m.canceller, m.canceller2]) {
      expect((await m.manager.hasRole(ROLES.CANCELLER, c.address))[0]).to.equal(false);
      await expect(m.manager.connect(c).cancel(m.safe.address, m.managerAddr, m.grant)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
    }
    // Hour 49: the grant runs, and with GOVERNOR and no delay the thief replaces the signers at once.
    await time.increaseTo(start + ADMIN_DELAY + HOUR + 60);
    await m.manager.connect(m.safe).execute(m.managerAddr, m.grant);
    await m.manager.connect(m.thief).execute(m.vaultAddr, m.setSigners);
    for (const s of m.thiefSigners) expect(await m.vault.isSigner(s)).to.equal(true);
    const hours = ((await time.latest()) - start) / HOUR;
    expect(hours).to.be.greaterThan(48);
    expect(hours).to.be.lessThan(49.2);
  });

  it("it is 96 hours only when a canceller cancels every re-schedule right up to its own removal", async () => {
    const m = await loadFixture(managed);
    const start = await time.latest();
    const removals = [m.canceller, m.canceller2].map((c) => m.revokeCanceller(c.address));
    for (const r of removals) await m.manager.connect(m.safe).schedule(m.managerAddr, r, 0);
    await m.manager.connect(m.safe).schedule(m.managerAddr, m.grant, 0);
    // The cancellers cancel the grant every time it is scheduled again, the last time a minute before they are out.
    for (const at of [HOUR, 12 * HOUR, 30 * HOUR, ADMIN_DELAY - 60]) {
      await time.increaseTo(start + at);
      await m.manager.connect(m.canceller2).cancel(m.safe.address, m.managerAddr, m.grant);
      await m.manager.connect(m.safe).schedule(m.managerAddr, m.grant, 0);
    }
    await time.increaseTo(start + ADMIN_DELAY + 10);
    for (const r of removals) await m.manager.connect(m.safe).execute(m.managerAddr, r);
    // The grant scheduled a minute before hour 48 waits its own 48 hours: not due at hour 95, due just before hour 96.
    await time.increaseTo(start + 2 * ADMIN_DELAY - 2 * HOUR);
    await expect(m.manager.connect(m.safe).execute(m.managerAddr, m.grant)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotReady");
    await time.increaseTo(start + 2 * ADMIN_DELAY);
    await m.manager.connect(m.safe).execute(m.managerAddr, m.grant);
    expect((await m.manager.hasRole(ROLES.GOVERNOR, m.thief.address))[0]).to.equal(true);
  });

  it("one transaction can queue many operations, and a canceller pays for each cancel: the cancels must outlast the removal", async () => {
    const m = await loadFixture(managed);
    // Forty grants to forty addresses in one multicall of the Safe's.
    const grants = Array.from({ length: 40 }, (_, n) => m.manager.interface.encodeFunctionData("grantRole", [ROLES.GOVERNOR, ethers.getAddress("0x" + (n + 1).toString(16).padStart(40, "0")), 0]));
    const batch = grants.map((g) => m.manager.interface.encodeFunctionData("schedule", [m.managerAddr, g, 0]));
    await m.manager.connect(m.safe).multicall(batch);
    // Each is cancelled on its own: forty transactions for the canceller, against one for the Safe.
    let gas = 0n;
    for (const g of grants) {
      const receipt = await (await m.manager.connect(m.canceller).cancel(m.safe.address, m.managerAddr, g)).wait();
      gas += receipt!.gasUsed;
    }
    expect(gas).to.be.greaterThan(40n * 21_000n);
    await time.increase(ADMIN_DELAY + 1);
    for (const g of grants.slice(0, 3)) await expect(m.manager.connect(m.safe).execute(m.managerAddr, g)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");
  });
});
