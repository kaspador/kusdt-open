// Audit 3, Ethereum: the vault against the real rules of Ethereum mainnet and the real Tether USDT.
// Run: npx hardhat test test/audit3-eth.test.ts (in bridge/evm).
//
// Audit3TetherToken.sol is a line-by-line port of the verified TetherToken source (0xdAC1…1ec7, solc 0.4.18).
// Tests marked "// BUG:" fail on purpose: each proves a mismatch against the real rule. The others pin behaviour
// the real contract forces, so that an auditor can check it without reading a deployed 2017 contract.
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { KusdtVault } from "../typechain-types";
import { DEFAULTS, USDT, makeWallets, newRedeemId, revertName, signRelease, sortByAddress } from "./helpers";
import { ADMIN_DELAY, EMERGENCY_DELAY, GOVERNOR_DELAY, OZ_EXPIRATION, ROLES, setupCalls } from "../scripts/access-manager";

const WAIT = 600;
/** EIP-7825 (Fusaka, live on mainnet since 2025-12-03): no transaction gas limit above 2^24. */
const TX_GAS_CAP = 16_777_216n;
/** bridge/devnet/src/mainnet-deploy.ts: DEPLOY_GAS and MANAGER_GAS. */
const DEPLOY_GAS = 4_000_000n;
const MANAGER_GAS = 3_500_000n;

async function tether(): Promise<any> {
  const [deployer] = await ethers.getSigners();
  return (await ethers.getContractFactory("Audit3TetherToken")).deploy(10_000_000n * USDT);
}

async function world() {
  const [owner, guardian, alice, bob, carol, attacker] = await ethers.getSigners();
  const token: any = await tether();
  const signerWallets = makeWallets("signer", 5);
  const vault = (await (await ethers.getContractFactory("KusdtVault")).deploy(
    await token.getAddress(), 6, signerWallets.map((w) => w.address) as any, guardian.address, owner.address, DEFAULTS, WAIT, 0, 0
  )) as unknown as KusdtVault;
  const vaultAddr = await vault.getAddress();
  await token.transfer(alice.address, 1_000_000n * USDT);
  return { owner, guardian, alice, bob, carol, attacker, token, vault, vaultAddr, signerWallets };
}

async function deposit(w: Awaited<ReturnType<typeof world>>, units = 1_000n * USDT, from = w.alice) {
  await w.token.connect(from).approve(w.vaultAddr, units);
  return w.vault.connect(from).deposit(units, 0, ethers.id("kaspa-owner"));
}

async function queue(w: Awaited<ReturnType<typeof world>>, units = 500n * USDT, recipient = w.bob.address) {
  const r = { redeemId: newRedeemId(), recipient, units };
  await w.vault.release(r, await signRelease(w.vault as any, sortByAddress(w.signerWallets).slice(0, 3), r));
  return r;
}

/** The fee a Tether transfer of `value` would charge, as BasicToken.transfer computes it. */
const tetherFee = (value: bigint, bp: bigint, max: bigint) => { const f = (value * bp) / 10_000n; return f > max ? max : f; };

describe("audit3: the real USDT (0xdAC1…1ec7) against the vault", () => {
  it("deposit and payout work with a token that returns nothing (SafeERC20 5.1.0 _callOptionalReturn)", async () => {
    const w = await loadFixture(world);
    await deposit(w);
    expect(await w.token.balanceOf(w.vaultAddr)).to.equal(1_000n * USDT);
    const r = await queue(w);
    await time.increase(WAIT);
    await w.vault.connect(w.attacker).executeRelease(r.redeemId); // anyone may
    expect(await w.token.balanceOf(w.bob.address)).to.equal(495n * USDT); // 500 − the 5 USDT minimum fee (Ethereum)
    expect(await w.vault.feesAccrued()).to.equal(7n * USDT); // the deposit fee (0.2 % of 1 000 = 2 USDT) and the release fee (5 USDT)
  });

  it("the real approve refuses a non-zero allowance over a non-zero one: the web app and the wallet must reset to 0 first", async () => {
    const w = await loadFixture(world);
    await w.token.connect(w.alice).approve(w.vaultAddr, 100n * USDT);
    await expect(w.token.connect(w.alice).approve(w.vaultAddr, 200n * USDT)).to.be.reverted;
    await w.token.connect(w.alice).approve(w.vaultAddr, 0n);
    await w.token.connect(w.alice).approve(w.vaultAddr, 200n * USDT);
    expect(await w.token.allowance(w.alice.address, w.vaultAddr)).to.equal(200n * USDT);
  });

  it("the fee switch on (setParams 19 bp, 49 USDT, the most the contract allows): deposits stop, queued payouts still pay, net of Tether's fee, and the books stay right", async () => {
    const w = await loadFixture(world);
    await deposit(w);
    const r = await queue(w);
    await w.token.setParams(19n, 49n); // the hard-coded maximum: < 20 bp, < 50 tokens
    // The vault checks what it received: no deposit can pass while the fee is on.
    const name = await revertName(w.vault, deposit(w));
    expect(name).to.equal("WrongAmountReceived");
    await time.increase(WAIT);
    const before = await w.token.balanceOf(w.bob.address);
    const vaultBefore = await w.token.balanceOf(w.vaultAddr);
    await w.vault.executeRelease(r.redeemId);
    const payout = r.units - 5n * USDT;
    const fee = tetherFee(payout, 19n, 49n * USDT);
    // The vault's balance falls by the gross payout: backing and feesAccrued stay exact.
    expect(vaultBefore - (await w.token.balanceOf(w.vaultAddr))).to.equal(payout);
    // The recipient bears Tether's fee: up to 49 USDT less than the wallet showed.
    expect((await w.token.balanceOf(w.bob.address)) - before).to.equal(payout - fee);
    expect(await w.vault.backing()).to.equal((await w.token.balanceOf(w.vaultAddr)) - (await w.vault.feesAccrued()));
  });

  it("a blacklisted depositor can't deposit, and nothing is recorded", async () => {
    const w = await loadFixture(world);
    await w.token.connect(w.alice).approve(w.vaultAddr, 100n * USDT);
    await w.token.addBlackList(w.alice.address);
    await expect(w.vault.connect(w.alice).deposit(100n * USDT, 0, ethers.id("o"))).to.be.reverted;
    expect(await w.vault.depositNonce()).to.equal(0n);
  });

  it("the vault blacklisted: deposits still go in (transferFrom checks only `from`), nothing can leave", async () => {
    const w = await loadFixture(world);
    await deposit(w);
    const r = await queue(w);
    await w.token.addBlackList(w.vaultAddr);
    // Deposits keep succeeding: the guardian's pause (SPEC §9, vault-blocked) is the only thing that stops them.
    await deposit(w, 200n * USDT);
    expect(await w.vault.depositNonce()).to.equal(2n);
    await time.increase(WAIT);
    await expect(w.vault.executeRelease(r.redeemId)).to.be.reverted;
    await expect(w.vault.connect(w.owner).withdrawFees(w.owner.address, 1n)).to.be.reverted;
  });

  it("destroyBlackFunds on the vault: its USDT is gone, backing reads 0, payouts refuse with InsufficientBacking (no arithmetic panic)", async () => {
    const w = await loadFixture(world);
    await deposit(w);
    const r = await queue(w);
    await w.token.addBlackList(w.vaultAddr);
    await w.token.destroyBlackFunds(w.vaultAddr);
    expect(await w.token.balanceOf(w.vaultAddr)).to.equal(0n);
    expect(await w.vault.backing()).to.equal(0n);
    expect(await w.vault.unreservedBacking()).to.equal(0n);
    await time.increase(WAIT);
    expect(await revertName(w.vault, w.vault.executeRelease(r.redeemId))).to.equal("InsufficientBacking");
    // Tether's blacklist still stands against the vault as a sender: a later unblock can't restore the backing.
    await w.token.removeBlackList(w.vaultAddr);
    expect(await revertName(w.vault, w.vault.executeRelease(r.redeemId))).to.equal("InsufficientBacking");
  });

  it("a USDT pause stops deposits and payouts, and the queue survives it", async () => {
    const w = await loadFixture(world);
    await deposit(w);
    const r = await queue(w);
    await w.token.pause();
    await expect(deposit(w, 100n * USDT)).to.be.reverted;
    await time.increase(WAIT);
    await expect(w.vault.executeRelease(r.redeemId)).to.be.reverted;
    await w.token.unpause();
    await w.vault.executeRelease(r.redeemId);
    expect(await w.token.balanceOf(w.bob.address)).to.equal(495n * USDT);
  });

  it("deprecate: an upgraded token that honours transferByLegacy keeps the vault working (balances move with it)", async () => {
    const w = await loadFixture(world);
    await deposit(w);
    const r = await queue(w);
    const upgraded: any = await (await ethers.getContractFactory("Audit3UpgradedTether")).deploy(await w.token.getAddress());
    await upgraded.credit(w.vaultAddr, await w.token.balanceOf(w.vaultAddr));
    await upgraded.credit(w.alice.address, 1_000n * USDT);
    await w.token.deprecate(await upgraded.getAddress());
    expect(await w.token.balanceOf(w.vaultAddr)).to.equal(1_000n * USDT);
    await time.increase(WAIT);
    await w.vault.executeRelease(r.redeemId);
    expect(await upgraded.balanceOf(w.bob.address)).to.equal(495n * USDT);
    // New deposits go through transferFromByLegacy.
    await w.token.connect(w.alice).approve(w.vaultAddr, 10n * USDT);
    await w.vault.connect(w.alice).deposit(10n * USDT, 0, ethers.id("o"));
    expect(await w.vault.depositNonce()).to.equal(2n);
  });

  // Known limit, in the docs (security/known-limits): the hold on a blocked recipient is off-chain only (the coordinator and the signers).
  // executeRelease is permissionless and USDT's blacklist stops senders only, so anyone can pay a recipient blacklisted during the wait,
  // and the USDT lands frozen there. No backing is lost. Refusing it on-chain would leave that payout holding the queue for good.
  it("known limit: a recipient blacklisted during the wait can still be paid by anyone, and no backing is lost", async () => {
    const w = await loadFixture(world);
    await deposit(w);
    const r = await queue(w);
    await w.token.addBlackList(w.bob.address);
    await time.increase(WAIT);
    await w.vault.connect(w.attacker).executeRelease(r.redeemId);
    expect(await w.token.balanceOf(w.bob.address)).to.be.greaterThan(0n);
    expect(await w.vault.reservedUnits()).to.equal(0n);
  });
});

describe("audit3: EIP-7702, an EOA can have code (Pectra, live on mainnet since 2025-05-07)", () => {
  /** A funded EOA that delegates to `target` (real type-4 transaction). */
  async function delegated(target: string, seed: string) {
    const [funder] = await ethers.getSigners();
    const eoa = new ethers.Wallet(ethers.id(seed), ethers.provider);
    await (await funder.sendTransaction({ to: eoa.address, value: ethers.parseEther("1") })).wait();
    const auth = await eoa.authorize({ address: target, nonce: (await eoa.getNonce()) + 1, chainId: (await ethers.provider.getNetwork()).chainId });
    await (await eoa.sendTransaction({ type: 4, to: funder.address, authorizationList: [auth] })).wait();
    return eoa;
  }

  it("a delegated EOA deposits and is paid like any account: nothing in the vault looks at code", async () => {
    const w = await loadFixture(world);
    const eoa = await delegated(w.vaultAddr, "audit3-7702-a");
    expect(await ethers.provider.getCode(eoa.address)).to.equal("0xef0100" + w.vaultAddr.slice(2).toLowerCase());
    await w.token.connect(w.alice).transfer(eoa.address, 100n * USDT);
    await w.token.connect(eoa as any).approve(w.vaultAddr, 100n * USDT);
    await w.vault.connect(eoa as any).deposit(100n * USDT, 0, ethers.id("o"));
    expect(await w.vault.depositNonce()).to.equal(1n);
    await deposit(w);
    const r = await queue(w, 500n * USDT, eoa.address);
    await time.increase(WAIT);
    await w.vault.executeRelease(r.redeemId);
    expect(await w.token.balanceOf(eoa.address)).to.equal(495n * USDT);
  });

  // The rule (EIP-7702 §Delegation): an EOA's code is 0xef0100‖address, 23 bytes. mainnet-deploy.ts (:352 live check, :740 verify),
  // deploy.ts (:157) and deploy-access-manager.ts (:65) treat getCode() !== '0x' as "the Safe / the owner is a contract".
  // A plain key delegating to anything passes, and getOwners()/getThreshold() can answer whatever the delegate returns.
  it("the deployer's `is a contract` check passes for a plain EOA with a 7702 delegation (it proves nothing about being a Safe)", async () => {
    const w = await loadFixture(world);
    const eoa = await delegated(w.vaultAddr, "audit3-7702-b");
    const code = await ethers.provider.getCode(eoa.address);
    expect(code !== "0x").to.equal(true);
    expect(code.length).to.equal(2 + 23 * 2);
    expect(code.startsWith("0xef0100")).to.equal(true);
  });
});

describe("audit3: gas against the limits of the live forks (EIP-7825, EIP-7623)", () => {
  /** tokens_in_calldata as EIP-7623 counts them. */
  function tokens(data: string): bigint {
    const b = ethers.getBytes(data);
    const zero = b.filter((x) => x === 0).length;
    return BigInt(zero) + 4n * BigInt(b.length - zero);
  }
  const floor = (data: string) => 21_000n + 10n * tokens(data);

  it("every transaction the launch and the bridge send fits the 16 777 216 gas cap and the deployer's estimates; the calldata floor never binds", async () => {
    const [deployer, guardian, safe, canceller, alice, bob] = await ethers.getSigners();
    const token: any = await tether();
    const managerF = await ethers.getContractFactory("KusdtAccessManager");
    const manager: any = await managerF.deploy(deployer.address);
    const managerRc = await manager.deploymentTransaction()!.wait();
    const vaultF = await ethers.getContractFactory("KusdtVault");
    const signerWallets = makeWallets("signer", 5);
    const vault = (await vaultF.deploy(await token.getAddress(), 6, signerWallets.map((s) => s.address) as any, guardian.address, await manager.getAddress(), DEFAULTS, WAIT, 0, 0)) as unknown as KusdtVault;
    const vaultRc = await vault.deploymentTransaction()!.wait();
    const setup = await (await manager.multicall(setupCalls({ safe: safe.address, emergencyDelay: 6 * 3_600, cancellers: [canceller.address] }, await vault.getAddress(), deployer.address, await manager.getAddress()))).wait();

    await token.transfer(alice.address, 200_000n * USDT);
    const units = 100_000n * USDT;
    await token.connect(alice).approve(await vault.getAddress(), units);
    const dep = await (await vault.connect(alice).deposit(units, 0, ethers.id("o"))).wait();
    const depSecond = await (async () => { await token.connect(alice).approve(await vault.getAddress(), units); return (await vault.connect(alice).deposit(units, 0, ethers.id("o"))).wait(); })();
    const sorted = sortByAddress(signerWallets);
    const r = { redeemId: newRedeemId(), recipient: bob.address, units: 50_000n * USDT };
    const sigs3 = await signRelease(vault as any, sorted.slice(0, 3), r);
    const rel = await (await vault.release(r, sigs3)).wait();
    const r5 = { redeemId: newRedeemId(), recipient: bob.address, units: 50_000n * USDT };
    const sigs5 = await signRelease(vault as any, sorted, r5);
    const rel5 = await (await vault.release(r5, sigs5)).wait();
    await time.increase(WAIT);
    const pay = await (await vault.executeRelease(r.redeemId)).wait();
    const pauseRc = await (await vault.connect(guardian).pause()).wait();

    const line = (name: string, rc: any, data?: string) => `      ${name}: gas ${rc.gasUsed}${data ? `, 7623 floor ${floor(data)}` : ""}`;
    console.log(line("AccessManager deploy", managerRc, manager.deploymentTransaction()!.data));
    console.log(line("KusdtVault deploy", vaultRc, vault.deploymentTransaction()!.data));
    console.log(line("setup multicall", setup));
    console.log(line("deposit (first)", dep));
    console.log(line("deposit (later)", depSecond));
    console.log(line("release (3 sigs)", rel));
    console.log(line("release (5 sigs)", rel5));
    console.log(line("executeRelease", pay));
    console.log(line("pause (guardian)", pauseRc));

    for (const rc of [managerRc, vaultRc, setup, dep, depSecond, rel, rel5, pay, pauseRc]) expect(rc!.gasUsed).to.be.lessThan(TX_GAS_CAP);
    expect(vaultRc!.gasUsed).to.be.lessThan(DEPLOY_GAS);
    expect(managerRc!.gasUsed + setup!.gasUsed).to.be.lessThan(MANAGER_GAS);
    // EIP-7623: the calldata floor is charged only above execution gas. Ours is far below for every call.
    const tx = await ethers.provider.getTransaction(rel!.hash);
    expect(floor(tx!.data)).to.be.lessThan(rel!.gasUsed);
    const tx5 = await ethers.provider.getTransaction(rel5!.hash);
    expect(floor(tx5!.data)).to.be.lessThan(rel5!.gasUsed);
  });
});
