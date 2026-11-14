import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { KusdtAccessManager, KusdtVault } from "../typechain-types";
import { DEFAULTS, makeWallets } from "./helpers";
import { ADMIN_DELAY, HOUR, MANAGER_GUARDED_FUNCTIONS, ROLES, checkOwnerConfig, managerGuardedFunctions, selectorOf, setupCalls } from "../scripts/access-manager";

// Round 11 (R11-OWN-5). `revokeRole` was left out of GUARDED so that a canceller could not cancel its own removal.
// That left every revocation beyond the cancellers, the Safe's own roles too: whoever held a threshold of the Safe's
// keys could pause a vault, schedule the removal of the Safe's EMERGENCY, GOVERNOR, PAUSER and ADMIN roles, and 48
// hours later nobody could unpause, grant or schedule anything again, with no canceller able to stop it.
//
// Now `revokeRole` is guarded like the power-adding calls, and a canceller is removed through `revokeCanceller`, which
// is mapped to nothing: an ADMIN call of the Safe's 48 hours that only an ADMIN can cancel. So the one revocation no
// canceller can cancel is a canceller's, and making a freeze permanent takes two steps, as stealing does. (The freeze
// itself is immediate for a holder of the Safe's keys, and the two steps can overlap: safe-compromise-times.test.ts.)

const EMERGENCY = 6 * HOUR;
const SAFE_ROLES = ["EMERGENCY", "GOVERNOR", "PAUSER", "ADMIN"] as const;

async function managed() {
  const [deployer, safe, guardian, canceller, canceller2, outsider] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("MockUSDT")).deploy("Mock USDT", "USDT", 6);
  const manager = (await (await ethers.getContractFactory("KusdtAccessManager")).deploy(deployer.address)) as unknown as KusdtAccessManager;
  const vault = (await (await ethers.getContractFactory("KusdtVault")).deploy(
    await token.getAddress(), 6, makeWallets("signer", 5).map((w) => w.address) as any, guardian.address, await manager.getAddress(), DEFAULTS, 0, 0, 0
  )) as unknown as KusdtVault;
  const cfg = checkOwnerConfig({ safe: safe.address, emergencyDelay: EMERGENCY, cancellers: [canceller.address, canceller2.address] }, "test");
  const vaultAddr = await vault.getAddress(), managerAddr = await manager.getAddress();
  await manager.connect(deployer).multicall(setupCalls(cfg, vaultAddr, deployer.address, managerAddr));
  const i = new ethers.Interface(["function revokeRole(uint64 roleId, address account)", "function revokeCanceller(address account)"]);
  const revoke = (role: bigint, who: string) => i.encodeFunctionData("revokeRole", [role, who]);
  const revokeCanceller = (who: string) => i.encodeFunctionData("revokeCanceller", [who]);
  const pause = vault.interface.encodeFunctionData("pause"), unpause = vault.interface.encodeFunctionData("unpause");
  return { deployer, safe, guardian, canceller, canceller2, outsider, manager, vault, vaultAddr, managerAddr, revoke, revokeCanceller, pause, unpause };
}

describe("round 11: the Safe's own roles can't be revoked past the cancellers", () => {
  it("the finding: a paused vault and the Safe's four roles scheduled for removal; a canceller cancels each, and the vault can be unpaused", async () => {
    const m = await loadFixture(managed);
    await m.manager.connect(m.safe).execute(m.vaultAddr, m.pause);
    expect(await m.vault.paused()).to.equal(true);
    const revokes = SAFE_ROLES.map((n) => m.revoke(ROLES[n], m.safe.address));
    for (const r of revokes) await m.manager.connect(m.safe).schedule(m.managerAddr, r, 0);
    // An outsider still can't cancel; either canceller can.
    await expect(m.manager.connect(m.outsider).cancel(m.safe.address, m.managerAddr, revokes[0])).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
    for (const [n, r] of revokes.entries()) {
      await expect(m.manager.connect(n % 2 ? m.canceller : m.canceller2).cancel(m.safe.address, m.managerAddr, r), SAFE_ROLES[n]).to.emit(m.manager, "OperationCanceled");
    }
    await time.increase(ADMIN_DELAY + 1);
    for (const r of revokes) await expect(m.manager.connect(m.safe).execute(m.managerAddr, r)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");
    for (const n of SAFE_ROLES) expect((await m.manager.hasRole(ROLES[n], m.safe.address))[0], n).to.equal(true);
    // The way back from the pause is whole.
    await m.manager.connect(m.safe).schedule(m.vaultAddr, m.unpause, 0);
    await time.increase(EMERGENCY + 1);
    await m.manager.connect(m.safe).execute(m.vaultAddr, m.unpause);
    expect(await m.vault.paused()).to.equal(false);
  });

  it("the setup maps revokeRole to GUARDED with the power-adding calls, and leaves revokeCanceller to ADMIN", async () => {
    const m = await loadFixture(managed);
    expect(MANAGER_GUARDED_FUNCTIONS).to.include("revokeRole(uint64,address)");
    expect(MANAGER_GUARDED_FUNCTIONS).to.not.include("revokeCanceller(address)");
    for (const f of managerGuardedFunctions()) expect(await m.manager.getTargetFunctionRole(m.managerAddr, f.selector), f.signature).to.equal(ROLES.GUARDED);
    const sel = selectorOf("revokeCanceller(address)");
    expect(m.manager.interface.getFunction("revokeCanceller" as any)!.selector).to.equal(sel);
    expect(await m.manager.getTargetFunctionRole(m.managerAddr, sel)).to.equal(ROLES.ADMIN);
    expect(await (m.manager as any).CANCELLER_ROLE()).to.equal(ROLES.CANCELLER);
    // The mapping changes who may cancel a revocation, not who may make one: the deployer's own, in the setup, went through.
    expect((await m.manager.hasRole(ROLES.ADMIN, m.deployer.address))[0]).to.equal(false);
  });

  it("a canceller can't cancel its own removal, nor the other one's: the Safe removes a rogue canceller in 48 hours", async () => {
    const m = await loadFixture(managed);
    const manager = m.manager as any;
    const out = m.revokeCanceller(m.canceller.address);
    // Not before the Safe's 48 hours, and not without a schedule.
    await expect(manager.connect(m.safe).revokeCanceller(m.canceller.address)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");
    await expect(m.manager.connect(m.safe).schedule(m.managerAddr, out, 0)).to.emit(m.manager, "OperationScheduled");
    for (const who of [m.canceller, m.canceller2, m.outsider]) {
      await expect(m.manager.connect(who).cancel(m.safe.address, m.managerAddr, out)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
    }
    await time.increase(ADMIN_DELAY - 60);
    await expect(m.manager.connect(m.safe).execute(m.managerAddr, out)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotReady");
    await time.increase(60);
    await expect(m.manager.connect(m.safe).execute(m.managerAddr, out)).to.emit(m.manager, "RoleRevoked").withArgs(ROLES.CANCELLER, m.canceller.address);
    expect((await m.manager.hasRole(ROLES.CANCELLER, m.canceller.address))[0]).to.equal(false);
    expect((await m.manager.hasRole(ROLES.CANCELLER, m.canceller2.address))[0]).to.equal(true);
    // The removed one cancels nothing any more.
    const again = m.revoke(ROLES.GOVERNOR, m.safe.address);
    await m.manager.connect(m.safe).schedule(m.managerAddr, again, 0);
    await expect(m.manager.connect(m.canceller).cancel(m.safe.address, m.managerAddr, again)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
    await expect(m.manager.connect(m.canceller2).cancel(m.safe.address, m.managerAddr, again)).to.emit(m.manager, "OperationCanceled");
    // The direct form works as well: scheduled, then called by the Safe itself.
    const out2 = m.revokeCanceller(m.canceller2.address);
    await m.manager.connect(m.safe).schedule(m.managerAddr, out2, 0);
    await time.increase(ADMIN_DELAY);
    await manager.connect(m.safe).revokeCanceller(m.canceller2.address);
    expect((await m.manager.hasRole(ROLES.CANCELLER, m.canceller2.address))[0]).to.equal(false);
  });

  it("a rogue canceller that cancels everything it can still can't keep itself in, and can't lock the Safe out", async () => {
    const m = await loadFixture(managed);
    const rogue = m.canceller;
    // It cancels the plain revocation of its role every time: that road is now one a canceller can block.
    const plain = m.revoke(ROLES.CANCELLER, rogue.address);
    for (let n = 0; n < 2; n++) {
      await m.manager.connect(m.safe).schedule(m.managerAddr, plain, 0);
      await expect(m.manager.connect(rogue).cancel(m.safe.address, m.managerAddr, plain)).to.emit(m.manager, "OperationCanceled");
    }
    // And every unpause, while the vault is paused.
    await m.manager.connect(m.safe).execute(m.vaultAddr, m.pause);
    await m.manager.connect(m.safe).schedule(m.vaultAddr, m.unpause, 0);
    await m.manager.connect(rogue).cancel(m.safe.address, m.vaultAddr, m.unpause);
    // revokeCanceller it can't cancel.
    const out = m.revokeCanceller(rogue.address);
    await m.manager.connect(m.safe).schedule(m.managerAddr, out, 0);
    await expect(m.manager.connect(rogue).cancel(m.safe.address, m.managerAddr, out)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
    await time.increase(ADMIN_DELAY);
    await m.manager.connect(m.safe).execute(m.managerAddr, out);
    // With it gone the Safe unpauses after its emergency delay.
    await m.manager.connect(m.safe).schedule(m.vaultAddr, m.unpause, 0);
    await expect(m.manager.connect(rogue).cancel(m.safe.address, m.vaultAddr, m.unpause)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
    await time.increase(EMERGENCY);
    await m.manager.connect(m.safe).execute(m.vaultAddr, m.unpause);
    expect(await m.vault.paused()).to.equal(false);
  });

  it("only the Safe can call revokeCanceller, and it removes cancellers only", async () => {
    const m = await loadFixture(managed);
    const manager = m.manager as any;
    const out = m.revokeCanceller(m.canceller.address);
    for (const who of [m.canceller, m.canceller2, m.outsider, m.deployer, m.guardian]) {
      await expect(manager.connect(who).revokeCanceller(m.canceller.address)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedAccount");
      await expect(m.manager.connect(who).schedule(m.managerAddr, out, 0)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
      await expect(m.manager.connect(who).execute(m.managerAddr, out)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
    }
    // Named with the Safe, or with someone who holds no role, it removes nothing: no other role is in its reach.
    for (const who of [m.safe.address, m.outsider.address]) await m.manager.connect(m.safe).schedule(m.managerAddr, m.revokeCanceller(who), 0);
    await time.increase(ADMIN_DELAY);
    for (const who of [m.safe.address, m.outsider.address]) await expect(m.manager.connect(m.safe).execute(m.managerAddr, m.revokeCanceller(who))).to.not.emit(m.manager, "RoleRevoked");
    for (const n of SAFE_ROLES) expect((await m.manager.hasRole(ROLES[n], m.safe.address))[0], n).to.equal(true);
    // A batch can't carry it past the schedule either.
    await expect(m.manager.connect(m.safe).multicall([out])).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");
    const batch = m.manager.interface.encodeFunctionData("multicall", [[out]]);
    await m.manager.connect(m.safe).schedule(m.managerAddr, batch, 0);
    await time.increase(ADMIN_DELAY);
    await expect(m.manager.connect(m.safe).execute(m.managerAddr, batch)).to.be.reverted;
    expect((await m.manager.hasRole(ROLES.CANCELLER, m.canceller.address))[0]).to.equal(true);
  });

  it("a freeze that outlasts the Safe's keys takes 96 hours while the cancellers cancel: both cancellers out first, then the Safe's roles (the pause itself is immediate)", async () => {
    const m = await loadFixture(managed);
    const start = await time.latest();
    await m.manager.connect(m.safe).execute(m.vaultAddr, m.pause);
    const roles = SAFE_ROLES.map((n) => m.revoke(ROLES[n], m.safe.address));
    // The direct road: cancelled.
    for (const r of roles) {
      await m.manager.connect(m.safe).schedule(m.managerAddr, r, 0);
      await m.manager.connect(m.canceller).cancel(m.safe.address, m.managerAddr, r);
    }
    // Going around the mapping is itself a guarded call.
    const unmap = m.manager.interface.encodeFunctionData("setTargetFunctionRole", [m.managerAddr, [selectorOf("revokeRole(uint64,address)")], 0]);
    await m.manager.connect(m.safe).schedule(m.managerAddr, unmap, 0);
    await m.manager.connect(m.canceller2).cancel(m.safe.address, m.managerAddr, unmap);
    // So: both cancellers out (48 h, in plain sight, which no canceller can cancel) ...
    const outs = [m.canceller, m.canceller2].map((c) => m.revokeCanceller(c.address));
    for (const o of outs) await m.manager.connect(m.safe).schedule(m.managerAddr, o, 0);
    await time.increase(ADMIN_DELAY);
    for (const o of outs) await m.manager.connect(m.safe).execute(m.managerAddr, o);
    // ... and only then the Safe's own roles, for 48 h more. ADMIN last: it is what executes the others.
    for (const r of roles) await m.manager.connect(m.safe).schedule(m.managerAddr, r, 0);
    await time.increase(ADMIN_DELAY - 60);
    await expect(m.manager.connect(m.safe).execute(m.managerAddr, roles[0])).to.be.revertedWithCustomError(m.manager, "AccessManagerNotReady");
    await time.increase(60);
    for (const r of roles) await m.manager.connect(m.safe).execute(m.managerAddr, r);
    expect((await time.latest()) - start).to.be.greaterThan(2 * ADMIN_DELAY);
    // It is a delay, not a stop: if nobody acted in those 96 hours the vault stays paused, with nobody left to unpause it.
    // The vault was paused from the first minute all the same, and stays so while the keys are held (round 12, R12-OWN-3).
    expect(await m.vault.paused()).to.equal(true);
    await expect(m.manager.connect(m.safe).schedule(m.vaultAddr, m.unpause, 0)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
  });
});
