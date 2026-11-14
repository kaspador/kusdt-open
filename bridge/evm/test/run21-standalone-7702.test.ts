// Run 21, Daybreak [36]: the standalone scripts scripts/deploy.ts and scripts/deploy-access-manager.ts took any code
// at the owner's (or the Safe's) address as proof of a contract on a mainnet (getCode() !== "0x"). An account delegated
// under EIP-7702 has code too (0xef0100 + the delegate's address) and is still one key. The mainnet deployer refused it
// already (isContractCode); the scripts run alone did not. Here both scripts run as an operator runs them, against a
// local node that answers chain ID 1, with a delegated account and with a real contract.
import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RPC = "http://127.0.0.1:8545"; // Hardhat's built-in `localhost` network
const USDT_ETHEREUM = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const random = () => ethers.Wallet.createRandom().address;

describe("run21 [36]: the standalone deploy scripts against an EIP-7702 delegated account", function () {
  this.timeout(600_000);
  let node: ChildProcess;
  let dir: string;
  let delegated: string;
  let contract: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "r21-36-"));
    node = spawn("npx", ["hardhat", "node", "--port", "8545"], { cwd: process.cwd(), env: { ...process.env, HARDHAT_CHAIN_ID: "1" }, shell: true, stdio: "ignore", detached: true });
    const provider = new ethers.JsonRpcProvider(RPC, 1, { staticNetwork: true });
    for (let i = 0; ; i++) {
      try { if ((await provider.send("eth_chainId", [])) === "0x1") break; } catch { /* not up yet */ }
      if (i > 120) throw new Error("the local node did not start");
      await new Promise((r) => setTimeout(r, 1_000));
    }
    const funder = await provider.getSigner(0);
    const art = await artifacts.readArtifact("MockUSDT");
    const mock = await new ethers.ContractFactory(art.abi, art.bytecode, funder).deploy("x", "x", 6);
    await mock.waitForDeployment();
    contract = await mock.getAddress();
    // The vault's constructor wants code at the token's address: Ethereum's USDT, here a 6-decimal stand-in.
    await provider.send("hardhat_setCode", [USDT_ETHEREUM, await provider.getCode(contract)]);
    // One key, delegated to that contract (a real type-4 transaction).
    const eoa = new ethers.Wallet(ethers.id("run21-36-delegated"), provider);
    await (await funder.sendTransaction({ to: eoa.address, value: ethers.parseEther("1") })).wait();
    const auth = await eoa.authorize({ address: contract, nonce: (await eoa.getNonce()) + 1, chainId: 1n });
    await (await eoa.sendTransaction({ type: 4, to: await funder.getAddress(), authorizationList: [auth] })).wait();
    delegated = eoa.address;
    expect(await provider.getCode(delegated)).to.equal("0xef0100" + contract.slice(2).toLowerCase());
    provider.destroy();
  });

  after(() => {
    if (node?.pid) { try { process.kill(-node.pid); } catch { /* already gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (script: string, env: Record<string, string>) => spawnSync("npx", ["hardhat", "run", script, "--network", "localhost", "--no-compile"], {
    cwd: process.cwd(), shell: true, encoding: "utf8", env: { ...process.env, KUSDT_CONFIRM_MAINNET: "deploy-to-1", ...env },
  });

  const vaultConfig = (owner: string, name: string) => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify({
      deployMockUsdt: false, token: USDT_ETHEREUM, tokenDecimals: 6, signers: [random(), random(), random(), random(), random()], guardian: random(), owner,
      feeBps: 50, minDepositFee: "500000", minReleaseFee: "5000000", minDeposit: "10000000", maxDeposit: "100000000000",
      releaseCapacity: "250000000000", releaseRefillPerSecond: "2893518", payoutDelay: 600, surgeFeeBps: 250, surgeCapacity: "125000000000",
    }));
    return path;
  };
  const managerConfig = (safe: string, name: string) => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify({ safe, emergencyDelay: 21_600, cancellers: [random()] }));
    return path;
  };

  it("deploy.ts refuses a delegated account as the vault's owner on a mainnet, and nothing is sent", () => {
    const r = run("scripts/deploy.ts", { DEPLOY_CONFIG: vaultConfig(delegated, "vault-delegated"), KUSDT_DEPLOYMENTS_DIR: join(dir, "delegated") });
    console.log(`      deploy.ts, owner a delegated account: exit ${r.status}; ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
    expect(r.status).to.equal(1);
    expect(r.stderr).to.match(/the owner must be a contract/);
    expect(r.stdout).not.to.match(/KusdtVault deploy sent/);
  });

  it("deploy-access-manager.ts refuses a delegated account as the Safe on a mainnet, and nothing is sent", () => {
    const r = run("scripts/deploy-access-manager.ts", { KUSDT_AM_STEP: "deploy", KUSDT_AM_CONFIG: managerConfig(delegated, "am-delegated"), KUSDT_DEPLOYMENTS_DIR: join(dir, "delegated") });
    console.log(`      deploy-access-manager.ts, Safe a delegated account: exit ${r.status}; ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
    expect(r.status).to.equal(1);
    expect(r.stderr).to.match(/the Safe must be a contract/);
    expect(r.stdout).not.to.match(/deploy sent/);
  });

  it("both still deploy for a real contract (the honest path)", () => {
    const am = run("scripts/deploy-access-manager.ts", { KUSDT_AM_STEP: "deploy", KUSDT_AM_CONFIG: managerConfig(contract, "am-contract"), KUSDT_DEPLOYMENTS_DIR: join(dir, "contract") });
    expect(am.status, am.stderr).to.equal(0);
    const vault = run("scripts/deploy.ts", { DEPLOY_CONFIG: vaultConfig(contract, "vault-contract"), KUSDT_DEPLOYMENTS_DIR: join(dir, "contract") });
    expect(vault.status, vault.stderr).to.equal(0);
    expect(vault.stdout).to.match(/KusdtVault deploy sent/);
  });
});
