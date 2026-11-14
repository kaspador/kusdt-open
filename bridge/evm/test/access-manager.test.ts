import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { KusdtAccessManager, KusdtVault } from "../typechain-types";
import { DEFAULTS, USDT, depositFrom, makeWallets } from "./helpers";
import {
  ADMIN_DELAY,
  EMERGENCY_DELAY,
  GOVERNOR_DELAY,
  HOUR,
  OZ_EXPIRATION,
  ROLES,
  ROLE_NAMES,
  VAULT_FUNCTIONS,
  checkOwnerConfig,
  expectedRoles,
  selectorOf,
  setupCalls,
  vaultFunctionRoles,
  MANAGER_GUARDED_FUNCTIONS,
} from "../scripts/access-manager";
import { until } from "../scripts/until";

const EMERGENCY = 6 * HOUR;

/**
 * The mainnet owner setup: a vault owned by an AccessManager whose only admin is the Safe
 * (an EOA stands in for it: only the manager's rules are under test here).
 */
async function managed() {
  const [deployer, safe, guardian, canceller, canceller2, outsider, alice] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("MockUSDT")).deploy("Mock USDT", "USDT", 6);
  const manager = (await (await ethers.getContractFactory("KusdtAccessManager")).deploy(deployer.address)) as unknown as KusdtAccessManager;
  const signerWallets = makeWallets("signer", 5);
  const vault = (await (await ethers.getContractFactory("KusdtVault")).deploy(
    await token.getAddress(), 6, signerWallets.map((w) => w.address) as any, guardian.address, await manager.getAddress(), DEFAULTS, 0, 0, 0
  )) as unknown as KusdtVault;
  const cfg = checkOwnerConfig({ safe: safe.address, emergencyDelay: EMERGENCY, cancellers: [canceller.address, canceller2.address] }, "test");
  const setupTx = await manager.connect(deployer).multicall(setupCalls(cfg, await vault.getAddress(), deployer.address, await manager.getAddress()));
  const vaultAddr = await vault.getAddress();
  const managerAddr = await manager.getAddress();
  const w = { vault, token, decimals: 6, scale: 1n, alice } as any;
  return { deployer, safe, guardian, canceller, canceller2, outsider, alice, token, manager, vault, vaultAddr, managerAddr, cfg, setupTx, signerWallets, w };
}

const newSigners = () => makeWallets("new-signer", 5).map((x) => x.address) as [string, string, string, string, string];
const vaultCall = (vault: KusdtVault, fn: string, args: unknown[] = []) => vault.interface.encodeFunctionData(fn as any, args as any);

describe("the deploy scripts' wait", () => {
  it("waits for a receipt that isn't there yet, and doesn't take null for one", async () => {
    let n = 0;
    const rc = await until("a receipt", async () => (++n < 3 ? null : { status: 1 }), { everyMs: 1 });
    expect(n).to.equal(3);
    expect(rc.status).to.equal(1);
  });
  it("counts a failed read as no answer yet, and says what it waited for when it gives up", async () => {
    let n = 0;
    expect(await until("a read", async () => { if (++n < 2) throw new Error("lagging RPC"); return 7; }, { everyMs: 1 })).to.equal(7);
    let message = "";
    try { await until("the vault's code", async () => false, { tries: 2, everyMs: 1 }); } catch (e) { message = (e as Error).message; }
    expect(message).to.equal("timed out waiting for the vault's code");
  });
});

describe("KusdtAccessManager: renounceRole is closed", () => {
  it("nobody can give up a role at once", async () => {
    const m = await loadFixture(managed);
    for (const name of ["ADMIN", "GOVERNOR", "EMERGENCY", "PAUSER"] as const) {
      await expect(m.manager.connect(m.safe).renounceRole(ROLES[name], m.safe.address), name).to.be.revertedWithCustomError(m.manager, "RenounceDisabled");
      expect((await m.manager.hasRole(ROLES[name], m.safe.address))[0], name).to.equal(true);
    }
    await expect(m.manager.connect(m.canceller).renounceRole(ROLES.CANCELLER, m.canceller.address)).to.be.revertedWithCustomError(m.manager, "RenounceDisabled");
  });

  it("a pause can't be made permanent in one transaction, and the Safe's unpause path stays whole", async () => {
    const m = await loadFixture(managed);
    const i = m.manager.interface;
    const pause = vaultCall(m.vault, "pause");
    const freeze = [i.encodeFunctionData("execute", [m.vaultAddr, pause]), ...(["EMERGENCY", "GOVERNOR", "ADMIN"] as const).map((n) => i.encodeFunctionData("renounceRole", [ROLES[n], m.safe.address]))];
    await expect(m.manager.connect(m.safe).multicall(freeze)).to.be.revertedWithCustomError(m.manager, "RenounceDisabled");
    expect(await m.vault.paused()).to.equal(false);
    await m.manager.connect(m.safe).execute(m.vaultAddr, pause);
    expect(await m.vault.paused()).to.equal(true);
    const unpause = vaultCall(m.vault, "unpause");
    await m.manager.connect(m.safe).schedule(m.vaultAddr, unpause, 0);
    await time.increase(EMERGENCY + 1);
    await m.manager.connect(m.safe).execute(m.vaultAddr, unpause);
    expect(await m.vault.paused()).to.equal(false);
  });

  it("a role still ends through revokeRole, after the Safe's 48 h", async () => {
    const m = await loadFixture(managed);
    const revoke = m.manager.interface.encodeFunctionData("revokeRole", [ROLES.CANCELLER, m.canceller.address]);
    await m.manager.connect(m.safe).schedule(m.managerAddr, revoke, 0);
    await expect(m.manager.connect(m.safe).execute(m.managerAddr, revoke)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotReady");
    await time.increase(ADMIN_DELAY + 1);
    await m.manager.connect(m.safe).execute(m.managerAddr, revoke);
    expect((await m.manager.hasRole(ROLES.CANCELLER, m.canceller.address))[0]).to.equal(false);
  });
});

describe("KusdtVault owned by an AccessManager", () => {
  describe("setup", () => {
    it("gives the Safe every role with its delay, the cancellers CANCELLER, and the deployer nothing", async () => {
      const m = await loadFixture(managed);
      for (const r of expectedRoles(m.cfg)) {
        for (const member of r.members) {
          const [isMember, delay] = await m.manager.hasRole(r.id, member.account);
          expect(isMember, `${r.name} ${member.account}`).to.equal(true);
          expect(Number(delay)).to.equal(member.delay);
        }
        expect(await m.manager.getRoleGuardian(r.id)).to.equal(r.guardian);
        expect(await m.manager.getRoleAdmin(r.id)).to.equal(ROLES.ADMIN);
        expect(await m.manager.getRoleGrantDelay(r.id)).to.equal(0n);
      }
      expect((await m.manager.hasRole(ROLES.ADMIN, m.safe.address))[1]).to.equal(BigInt(ADMIN_DELAY));
      expect((await m.manager.hasRole(ROLES.GOVERNOR, m.safe.address))[1]).to.equal(BigInt(GOVERNOR_DELAY));
      expect((await m.manager.hasRole(ROLES.EMERGENCY, m.safe.address))[1]).to.equal(BigInt(EMERGENCY));
      expect((await m.manager.hasRole(ROLES.PAUSER, m.safe.address))[1]).to.equal(0n);
      for (const name of ROLE_NAMES) {
        expect((await m.manager.hasRole(ROLES[name], m.deployer.address))[0], `deployer ${name}`).to.equal(false);
        expect((await m.manager.getAccess(ROLES[name], m.deployer.address))[0], `deployer ${name} since`).to.equal(0n);
      }
      // The cancellers hold nothing but CANCELLER.
      for (const name of ["ADMIN", "GOVERNOR", "EMERGENCY", "PAUSER"] as const) {
        expect((await m.manager.hasRole(ROLES[name], m.canceller.address))[0]).to.equal(false);
      }
      for (const f of vaultFunctionRoles()) expect(await m.manager.getTargetFunctionRole(m.vaultAddr, f.selector), f.signature).to.equal(f.roleId);
      // Every one of the vault's onlyOwner functions is mapped (renounceOwnership reverts anyway).
      expect(VAULT_FUNCTIONS.map((f) => f.signature.split("(")[0]).sort()).to.deep.equal(
        ["cancelRefund", "cancelRelease", "pause", "reinstateRefund", "reinstateRelease", "setDepositLimits", "setDepositSurge", "setFees", "setGuardian", "setPayoutDelay", "setReleaseLimits", "setSigners", "transferOwnership", "unpause", "withdrawFees"],
      );
      for (const f of vaultFunctionRoles()) expect(m.vault.interface.getFunction(f.signature as any)!.selector).to.equal(f.selector);
      expect(await m.vault.owner()).to.equal(m.managerAddr);
      await expect(m.setupTx).to.emit(m.manager, "RoleRevoked").withArgs(ROLES.ADMIN, m.deployer.address);
      await expect(m.setupTx).to.emit(m.manager, "RoleLabel").withArgs(ROLES.GOVERNOR, "GOVERNOR");
    });

    it("the manager's deploy and its one setup transaction fit the deployer's gas budget", async () => {
      const m = await loadFixture(managed);
      const deployGas = (await m.manager.deploymentTransaction()!.wait())!.gasUsed;
      const setupGas = (await m.setupTx.wait())!.gasUsed;
      expect(Number(deployGas)).to.be.lessThan(3_000_000);
      expect(Number(setupGas)).to.be.lessThan(1_000_000);
      console.log(`      gas: AccessManager deploy ${deployGas}, setup multicall ${setupGas}`);
    });

    it("the config check refuses a bad emergency delay, no canceller, a duplicate, and the Safe as a canceller", async () => {
      const [, safe, c] = await ethers.getSigners();
      const ok = { safe: safe.address, cancellers: [c.address] };
      expect(checkOwnerConfig(ok, "x").emergencyDelay).to.equal(EMERGENCY_DELAY.default);
      expect(() => checkOwnerConfig({ ...ok, emergencyDelay: HOUR - 1 }, "x")).to.throw(/emergencyDelay/);
      expect(() => checkOwnerConfig({ ...ok, emergencyDelay: 48 * HOUR + 1 }, "x")).to.throw(/emergencyDelay/);
      expect(() => checkOwnerConfig({ ...ok, emergencyDelay: "21600" }, "x")).to.throw(/emergencyDelay/);
      expect(() => checkOwnerConfig({ ...ok, cancellers: [] }, "x")).to.throw(/at least one canceller/);
      expect(() => checkOwnerConfig({ ...ok, cancellers: [c.address, c.address] }, "x")).to.throw(/appears twice/);
      expect(() => checkOwnerConfig({ ...ok, cancellers: [safe.address] }, "x")).to.throw(/Safe can't also be a canceller/);
      expect(() => checkOwnerConfig({ ...ok, extra: 1 }, "x")).to.throw(/unknown field/);
      expect(() => setupCalls(checkOwnerConfig(ok, "x"), safe.address, safe.address, safe.address)).to.throw(/deployer can't be the Safe/);
    });
  });

  describe("GOVERNOR (48 h)", () => {
    it("setSigners: scheduled, refused before 48 h, executed after", async () => {
      const m = await loadFixture(managed);
      const data = vaultCall(m.vault, "setSigners", [newSigners()]);
      // Nothing runs without the schedule.
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, data)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");
      await expect(m.manager.connect(m.safe).schedule(m.vaultAddr, data, 0)).to.emit(m.manager, "OperationScheduled");
      const op = await m.manager.hashOperation(m.safe.address, m.vaultAddr, data);
      await time.increase(GOVERNOR_DELAY - 10);
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, data)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotReady");
      await time.increase(10);
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, data)).to.emit(m.vault, "SignersSet").and.to.emit(m.manager, "OperationExecuted");
      expect(await m.vault.signers()).to.deep.equal(newSigners());
      expect(await m.manager.getSchedule(op)).to.equal(0n);
      // Once only.
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, data)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");
    });

    it("a schedule shorter than the delay is refused, and a call expires a week after it is ready", async () => {
      const m = await loadFixture(managed);
      const data = vaultCall(m.vault, "setFees", [10, 0, 0]);
      const soon = (await time.latest()) + HOUR;
      await expect(m.manager.connect(m.safe).schedule(m.vaultAddr, data, soon)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
      await m.manager.connect(m.safe).schedule(m.vaultAddr, data, 0);
      await time.increase(GOVERNOR_DELAY + OZ_EXPIRATION);
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, data)).to.be.revertedWithCustomError(m.manager, "AccessManagerExpired");
    });

    it("withdrawFees and transferOwnership go through the same 48 h", async () => {
      const m = await loadFixture(managed);
      await depositFrom(m.w, m.alice, 1_000n * USDT); // a 2 USDT fee
      const fee = await m.vault.feesAccrued();
      const withdraw = vaultCall(m.vault, "withdrawFees", [m.safe.address, fee]);
      const move = vaultCall(m.vault, "transferOwnership", [m.safe.address]);
      await m.manager.connect(m.safe).schedule(m.vaultAddr, withdraw, 0);
      await m.manager.connect(m.safe).schedule(m.vaultAddr, move, 0);
      await time.increase(GOVERNOR_DELAY);
      await m.manager.connect(m.safe).execute(m.vaultAddr, withdraw);
      expect(await m.token.balanceOf(m.safe.address)).to.equal(fee);
      await m.manager.connect(m.safe).execute(m.vaultAddr, move);
      expect(await m.vault.pendingOwner()).to.equal(m.safe.address); // Ownable2Step: the new owner still accepts
      expect(await m.vault.owner()).to.equal(m.managerAddr);
    });
  });

  describe("CANCELLER", () => {
    it("cancels a scheduled setSigners and a scheduled unpause", async () => {
      const m = await loadFixture(managed);
      const set = vaultCall(m.vault, "setSigners", [newSigners()]);
      await m.manager.connect(m.safe).schedule(m.vaultAddr, set, 0);
      const op = await m.manager.hashOperation(m.safe.address, m.vaultAddr, set);
      await expect(m.manager.connect(m.canceller).cancel(m.safe.address, m.vaultAddr, set)).to.emit(m.manager, "OperationCanceled");
      expect(await m.manager.getSchedule(op)).to.equal(0n);
      await time.increase(GOVERNOR_DELAY);
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, set)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");

      await m.vault.connect(m.guardian).pause();
      const unpause = vaultCall(m.vault, "unpause");
      await m.manager.connect(m.safe).schedule(m.vaultAddr, unpause, 0);
      await expect(m.manager.connect(m.canceller2).cancel(m.safe.address, m.vaultAddr, unpause)).to.emit(m.manager, "OperationCanceled");
      await time.increase(EMERGENCY);
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, unpause)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");
      expect(await m.vault.paused()).to.equal(true);
    });

    it("can't cancel its own removal, so the Safe can revoke a rogue canceller; a power-adding call it can cancel", async () => {
      const m = await loadFixture(managed);
      // Since round 11 a canceller is removed through revokeCanceller: revokeRole is guarded now (test/revoke-guard.test.ts).
      const revoke = m.manager.interface.encodeFunctionData("revokeCanceller", [m.canceller.address]);
      const remap = m.manager.interface.encodeFunctionData("setTargetFunctionRole", [m.vaultAddr, [selectorOf("setFees(uint16,uint256,uint256)")], ROLES.PAUSER]);
      for (const data of [revoke, remap]) await m.manager.connect(m.safe).schedule(m.managerAddr, data, 0);
      // The removal of a canceller: not guarded, or a rogue canceller would cancel it every time.
      await expect(m.manager.connect(m.canceller).cancel(m.safe.address, m.managerAddr, revoke))
        .to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
      await expect(m.manager.connect(m.canceller2).cancel(m.safe.address, m.managerAddr, revoke))
        .to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
      await time.increase(ADMIN_DELAY);
      await m.manager.connect(m.safe).revokeCanceller(m.canceller.address); // the scheduled call, consumed
      expect((await m.manager.hasRole(ROLES.CANCELLER, m.canceller.address))[0]).to.equal(false);
      // The revoked canceller cancels nothing any more; the other one still does.
      const set = vaultCall(m.vault, "setSigners", [newSigners()]);
      await m.manager.connect(m.safe).schedule(m.vaultAddr, set, 0);
      await expect(m.manager.connect(m.canceller).cancel(m.safe.address, m.vaultAddr, set)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
      await expect(m.manager.connect(m.canceller2).cancel(m.safe.address, m.vaultAddr, set)).to.emit(m.manager, "OperationCanceled");
      // The remap of a vault function adds power: the canceller that is left cancels it, the revoked one can't.
      await expect(m.manager.connect(m.canceller).cancel(m.safe.address, m.managerAddr, remap)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
      await expect(m.manager.connect(m.canceller2).cancel(m.safe.address, m.managerAddr, remap)).to.emit(m.manager, "OperationCanceled");
      await expect(m.manager.connect(m.safe).execute(m.managerAddr, remap)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");
    });

    it("an outsider can't cancel, and a canceller can't schedule or execute anything", async () => {
      const m = await loadFixture(managed);
      const set = vaultCall(m.vault, "setSigners", [newSigners()]);
      await m.manager.connect(m.safe).schedule(m.vaultAddr, set, 0);
      await expect(m.manager.connect(m.outsider).cancel(m.safe.address, m.vaultAddr, set)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
      for (const data of [set, vaultCall(m.vault, "pause"), vaultCall(m.vault, "unpause")]) {
        await expect(m.manager.connect(m.canceller).schedule(m.vaultAddr, data, 0)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
        await expect(m.manager.connect(m.canceller).execute(m.vaultAddr, data)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
      }
    });
  });

  describe("EMERGENCY and PAUSER", () => {
    it("the Safe pauses at once, through the manager; the guardian still pauses directly", async () => {
      const m = await loadFixture(managed);
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, vaultCall(m.vault, "pause"))).to.emit(m.vault, "Paused");
      expect(await m.vault.paused()).to.equal(true);
      // Pausing has no delay, so it can't be scheduled.
      await expect(m.manager.connect(m.safe).schedule(m.vaultAddr, vaultCall(m.vault, "pause"), 0)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
      const m2 = await loadFixture(managed);
      await expect(m2.vault.connect(m2.guardian).pause()).to.emit(m2.vault, "Paused");
    });

    it("unpause and setGuardian run after the emergency delay, not before (a stolen guardian key costs hours, not days)", async () => {
      const m = await loadFixture(managed);
      await m.vault.connect(m.guardian).pause(); // say the guardian key was stolen and used
      const newGuardian = m.outsider.address;
      const setG = vaultCall(m.vault, "setGuardian", [newGuardian]);
      const unpause = vaultCall(m.vault, "unpause");
      await m.manager.connect(m.safe).schedule(m.vaultAddr, setG, 0);
      await m.manager.connect(m.safe).schedule(m.vaultAddr, unpause, 0);
      await time.increase(EMERGENCY - 10);
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, setG)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotReady");
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, unpause)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotReady");
      await time.increase(10);
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, setG)).to.emit(m.vault, "GuardianSet").withArgs(newGuardian);
      await expect(m.manager.connect(m.safe).execute(m.vaultAddr, unpause)).to.emit(m.vault, "Unpaused");
      expect(await m.vault.guardian()).to.equal(newGuardian);
      expect(await m.vault.paused()).to.equal(false);
      await expect(m.vault.connect(m.guardian).pause()).to.be.revertedWithCustomError(m.vault, "NotGuardianOrOwner");
    });
  });

  describe("everyone else", () => {
    it("an outsider and the deployer can't schedule or execute any vault call", async () => {
      const m = await loadFixture(managed);
      for (const who of [m.outsider, m.deployer]) {
        for (const f of VAULT_FUNCTIONS) {
          const data = f.signature === "pause()" || f.signature === "unpause()" ? vaultCall(m.vault, f.signature.slice(0, -2))
            : f.signature === "setSigners(address[5])" ? vaultCall(m.vault, "setSigners", [newSigners()])
            : f.signature.startsWith("setFees") ? vaultCall(m.vault, "setFees", [1, 1, 1])
            : f.signature.includes("(uint256,uint256)") ? vaultCall(m.vault, f.signature.split("(")[0], [1, 2])
            : f.signature.startsWith("withdrawFees") ? vaultCall(m.vault, "withdrawFees", [who.address, 1])
            : f.signature.startsWith("setPayoutDelay") ? vaultCall(m.vault, "setPayoutDelay", [600])
            : f.signature.startsWith("cancelRelease") ? vaultCall(m.vault, "cancelRelease", [ethers.id("x")])
            : f.signature.startsWith("cancelRefund") ? vaultCall(m.vault, "cancelRefund", [0])
            : f.signature.startsWith("reinstateRelease") ? vaultCall(m.vault, "reinstateRelease", [ethers.id("x")])
            : f.signature.startsWith("reinstateRefund") ? vaultCall(m.vault, "reinstateRefund", [0])
            : f.signature.startsWith("setDepositSurge") ? vaultCall(m.vault, "setDepositSurge", [250, 1000])
            : vaultCall(m.vault, f.signature.split("(")[0], [who.address]);
          await expect(m.manager.connect(who).schedule(m.vaultAddr, data, 0), f.signature).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
          await expect(m.manager.connect(who).execute(m.vaultAddr, data), f.signature).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
        }
        // Nor change the manager's rules.
        await expect(m.manager.connect(who).grantRole(ROLES.GOVERNOR, who.address, 0)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedAccount");
        await expect(m.manager.connect(who).schedule(m.managerAddr, m.manager.interface.encodeFunctionData("grantRole", [ROLES.ADMIN, who.address, 0]), 0))
          .to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
      }
    });

    it("an outsider can't execute a call the Safe scheduled, even when it is ready", async () => {
      const m = await loadFixture(managed);
      const set = vaultCall(m.vault, "setSigners", [newSigners()]);
      await m.manager.connect(m.safe).schedule(m.vaultAddr, set, 0);
      await time.increase(GOVERNOR_DELAY);
      await expect(m.manager.connect(m.outsider).execute(m.vaultAddr, set)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
    });

    it("the Safe's direct calls to the vault's owner functions revert: they must go through the manager", async () => {
      const m = await loadFixture(managed);
      const v = m.vault.connect(m.safe);
      const calls = [() => v.setSigners(newSigners()), () => v.setFees(1, 1, 1), () => v.setDepositLimits(1, 2), () => v.setReleaseLimits(1, 0), () => v.setGuardian(m.safe.address), () => v.withdrawFees(m.safe.address, 0), () => v.transferOwnership(m.safe.address), () => v.unpause()];
      for (const call of calls) await expect(call()).to.be.revertedWithCustomError(m.vault, "OwnableUnauthorizedAccount");
      await expect(v.pause()).to.be.revertedWithCustomError(m.vault, "NotGuardianOrOwner");
    });
  });

  describe("changing the rules (ADMIN, 48 h)", () => {
    it("granting a role is delayed 48 h", async () => {
      const m = await loadFixture(managed);
      const grant = m.manager.interface.encodeFunctionData("grantRole", [ROLES.GOVERNOR, m.outsider.address, 0]);
      await expect(m.manager.connect(m.safe).grantRole(ROLES.GOVERNOR, m.outsider.address, 0)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");
      await m.manager.connect(m.safe).schedule(m.managerAddr, grant, 0);
      await time.increase(ADMIN_DELAY - 10);
      await expect(m.manager.connect(m.safe).execute(m.managerAddr, grant)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotReady");
      await time.increase(10);
      await m.manager.connect(m.safe).execute(m.managerAddr, grant);
      expect((await m.manager.hasRole(ROLES.GOVERNOR, m.outsider.address))[0]).to.equal(true);
    });

    it("lowering a role's delay is delayed 48 h, then the difference again; remapping a vault function is delayed 48 h", async () => {
      const m = await loadFixture(managed);
      const lower = m.manager.interface.encodeFunctionData("grantRole", [ROLES.GOVERNOR, m.safe.address, 0]);
      await m.manager.connect(m.safe).schedule(m.managerAddr, lower, 0);
      await time.increase(ADMIN_DELAY);
      await m.manager.connect(m.safe).execute(m.managerAddr, lower);
      // OpenZeppelin's setback: the old 48 h still applies for another 48 h.
      const [, current, pending, effect] = await m.manager.getAccess(ROLES.GOVERNOR, m.safe.address);
      expect([current, pending]).to.deep.equal([BigInt(GOVERNOR_DELAY), 0n]);
      expect(effect).to.equal(BigInt((await time.latest()) + GOVERNOR_DELAY));
      await time.increase(GOVERNOR_DELAY);
      expect((await m.manager.getAccess(ROLES.GOVERNOR, m.safe.address))[1]).to.equal(0n);

      const remap = m.manager.interface.encodeFunctionData("setTargetFunctionRole", [m.vaultAddr, [selectorOf("setSigners(address[5])")], ROLES.PAUSER]);
      await expect(m.manager.connect(m.safe).setTargetFunctionRole(m.vaultAddr, [selectorOf("setSigners(address[5])")], ROLES.PAUSER))
        .to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");
      await m.manager.connect(m.safe).schedule(m.managerAddr, remap, 0);
      await time.increase(ADMIN_DELAY);
      await m.manager.connect(m.safe).execute(m.managerAddr, remap);
      expect(await m.manager.getTargetFunctionRole(m.vaultAddr, selectorOf("setSigners(address[5])"))).to.equal(ROLES.PAUSER);
    });

    // Owner's decision of 10 November 2026, after the outside review's run 13: the cancellers get a say over the
    // Safe's own power-adding calls. Before, a stolen Safe scheduled grantRole(GOVERNOR, thief, 0) and nobody could
    // stop it for the 48 hours it waited.
    it("a canceller cancels every power-adding call the Safe schedules on the manager", async () => {
      const m = await loadFixture(managed);
      const i = new ethers.Interface([
        "function revokeRole(uint64,address)",
        "function grantRole(uint64,address,uint32)", "function setRoleAdmin(uint64,uint64)", "function setRoleGuardian(uint64,uint64)",
        "function setGrantDelay(uint64,uint32)", "function setTargetAdminDelay(address,uint32)", "function setTargetFunctionRole(address,bytes4[],uint64)",
        "function setTargetClosed(address,bool)", "function updateAuthority(address,address)",
      ]);
      const calls: [string, unknown[]][] = [
        ["grantRole", [ROLES.ADMIN, m.outsider.address, 0]],
        ["grantRole", [ROLES.GOVERNOR, m.outsider.address, 0]],
        ["setRoleAdmin", [ROLES.GOVERNOR, 77]],
        ["setRoleGuardian", [ROLES.GOVERNOR, 77]],
        ["setRoleGuardian", [ROLES.GUARDED, 0]],
        ["setGrantDelay", [ROLES.CANCELLER, 30 * 86_400]],
        ["setTargetAdminDelay", [m.vaultAddr, 30 * 86_400]],
        ["setTargetFunctionRole", [m.vaultAddr, [selectorOf("setSigners(address[5])")], (1n << 64n) - 1n]],
        ["setTargetFunctionRole", [m.managerAddr, [selectorOf("grantRole(uint64,address,uint32)")], 0]],
        ["setTargetClosed", [m.vaultAddr, true]],
        ["updateAuthority", [m.vaultAddr, m.outsider.address]],
        // Round 11: a revocation too (the Safe's own roles, or anyone's). Only a canceller's removal has a road no canceller can cancel.
        ["revokeRole", [ROLES.EMERGENCY, m.safe.address]],
        ["revokeRole", [ROLES.CANCELLER, m.canceller2.address]],
      ];
      expect(new Set(calls.map((c) => c[0])).size).to.equal(MANAGER_GUARDED_FUNCTIONS.length);
      for (const [fn, args] of calls) {
        const data = i.encodeFunctionData(fn, args);
        await m.manager.connect(m.safe).schedule(m.managerAddr, data, 0);
        await expect(m.manager.connect(m.outsider).cancel(m.safe.address, m.managerAddr, data), fn).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
        await expect(m.manager.connect(m.canceller).cancel(m.safe.address, m.managerAddr, data), fn).to.emit(m.manager, "OperationCanceled");
        await time.increase(ADMIN_DELAY);
        await expect(m.manager.connect(m.safe).execute(m.managerAddr, data), fn).to.be.revertedWithCustomError(m.manager, "AccessManagerNotScheduled");
      }
      expect((await m.manager.hasRole(ROLES.GOVERNOR, m.outsider.address))[0]).to.equal(false);
    });

    it("the mapping changes who may cancel, not who may call: only the Safe, with its 48 h, makes these calls", async () => {
      const m = await loadFixture(managed);
      const grant = m.manager.interface.encodeFunctionData("grantRole", [ROLES.GOVERNOR, m.outsider.address, 0]);
      // Nobody is in GUARDED, and being a canceller gives no right to call.
      for (const who of [m.canceller, m.outsider, m.deployer]) {
        await expect(m.manager.connect(who).grantRole(ROLES.GOVERNOR, m.outsider.address, 0)).to.be.reverted;
        await expect(m.manager.connect(who).schedule(m.managerAddr, grant, 0)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCall");
      }
      // The Safe still can, after its delay and with no canceller objecting.
      await expect(m.manager.connect(m.safe).grantRole(ROLES.GOVERNOR, m.outsider.address, 0)).to.be.reverted;
      await m.manager.connect(m.safe).schedule(m.managerAddr, grant, 0);
      await time.increase(ADMIN_DELAY);
      await m.manager.connect(m.safe).execute(m.managerAddr, grant);
      expect((await m.manager.hasRole(ROLES.GOVERNOR, m.outsider.address))[0]).to.equal(true);
    });

    it("while the cancellers cancel every try, a stolen Safe needs 96 hours: every canceller out first, then the grant (48 hours from their last cancel: safe-compromise-times.test.ts)", async () => {
      const m = await loadFixture(managed);
      const thief = m.outsider;
      const grant = m.manager.interface.encodeFunctionData("grantRole", [ROLES.GOVERNOR, thief.address, 0]);
      const start = await time.latest();
      // First try: the direct road. A canceller stops it, and stops it again.
      for (let n = 0; n < 2; n++) {
        await m.manager.connect(m.safe).schedule(m.managerAddr, grant, 0);
        await m.manager.connect(m.canceller2).cancel(m.safe.address, m.managerAddr, grant);
      }
      // Going around the mapping is itself a guarded call.
      const unmap = m.manager.interface.encodeFunctionData("setTargetFunctionRole", [m.managerAddr, [selectorOf("grantRole(uint64,address,uint32)")], 0]);
      await m.manager.connect(m.safe).schedule(m.managerAddr, unmap, 0);
      await m.manager.connect(m.canceller).cancel(m.safe.address, m.managerAddr, unmap);
      // So: both cancellers out first (48 h, which they can't cancel but everyone sees) ...
      const revokes = [m.canceller, m.canceller2].map((c) => m.manager.interface.encodeFunctionData("revokeCanceller", [c.address]));
      for (const r of revokes) await m.manager.connect(m.safe).schedule(m.managerAddr, r, 0);
      for (const r of revokes) await expect(m.manager.connect(m.canceller).cancel(m.safe.address, m.managerAddr, r)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
      await time.increase(ADMIN_DELAY);
      for (const r of revokes) await m.manager.connect(m.safe).execute(m.managerAddr, r);
      // ... and only then the grant, for 48 h more.
      await m.manager.connect(m.safe).schedule(m.managerAddr, grant, 0);
      await expect(m.manager.connect(m.canceller).cancel(m.safe.address, m.managerAddr, grant)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
      await time.increase(ADMIN_DELAY - 60);
      await expect(m.manager.connect(m.safe).execute(m.managerAddr, grant)).to.be.revertedWithCustomError(m.manager, "AccessManagerNotReady");
      await time.increase(60);
      await m.manager.connect(m.safe).execute(m.managerAddr, grant);
      expect((await time.latest()) - start).to.be.greaterThan(2 * ADMIN_DELAY);
      // With GOVERNOR and no delay the thief replaces the signers at once. The 96 hours were the time to act, and they
      // were 96 only because a canceller cancelled each try until both were removed.
      await m.manager.connect(thief).execute(m.vaultAddr, vaultCall(m.vault, "setSigners", [newSigners()]));
    });

    it("an honest Safe that still holds its keys can remove one rogue canceller, which can't stop that", async () => {
      const m = await loadFixture(managed);
      const revoke = m.manager.interface.encodeFunctionData("revokeCanceller", [m.canceller.address]);
      await m.manager.connect(m.safe).schedule(m.managerAddr, revoke, 0);
      await expect(m.manager.connect(m.canceller).cancel(m.safe.address, m.managerAddr, revoke)).to.be.revertedWithCustomError(m.manager, "AccessManagerUnauthorizedCancel");
      await time.increase(ADMIN_DELAY);
      await m.manager.connect(m.safe).execute(m.managerAddr, revoke);
      expect((await m.manager.hasRole(ROLES.CANCELLER, m.canceller.address))[0]).to.equal(false);
      // A canceller put back in its place is a grant: guarded, so the one that is left has a say in it.
      const regrant = m.manager.interface.encodeFunctionData("grantRole", [ROLES.CANCELLER, m.outsider.address, 0]);
      await m.manager.connect(m.safe).schedule(m.managerAddr, regrant, 0);
      await expect(m.manager.connect(m.canceller2).cancel(m.safe.address, m.managerAddr, regrant)).to.emit(m.manager, "OperationCanceled");
    });
  });
});
