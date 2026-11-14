/**
 * Deploys and configures the KusdtAccessManager that owns a vault (see scripts/access-manager.ts).
 * Two steps, run by the mainnet deployer around scripts/deploy.ts:
 *
 *   KUSDT_AM_STEP=deploy     deploys the manager, with the deployer as its first admin
 *   (scripts/deploy.ts, with owner = the manager)
 *   KUSDT_AM_STEP=configure  one multicall: the roles, the guardians, the vault's function
 *                            roles, and the deployer giving up ADMIN
 *
 *   KUSDT_AM_CONFIG=<file> KUSDT_AM_STEP=deploy npx hardhat run scripts/deploy-access-manager.ts --network ethereum
 *
 * KUSDT_AM_CONFIG names a JSON file: { "safe", "emergencyDelay", "cancellers", "vault" (configure) }.
 * What was sent is written to <KUSDT_DEPLOYMENTS_DIR>/<network>.access-manager.json before
 * waiting for it, so a run that stops halfway resumes and never deploys or configures twice.
 * The deployer key comes from DEPLOYER_KEY via hardhat.config.ts; it is never read or printed here.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { ADMIN_DELAY, ROLES, checkOwnerConfig, expectedRoles, isContractCode, setupCalls, vaultFunctionRoles } from "./access-manager";
import { until } from "./until";

const MAINNETS = new Set(["1", "56"]);
const TESTNETS = new Set(["11155111", "97", "31337"]);

function fail(msg: string): never {
  throw new Error(`deploy-access-manager: ${msg}`);
}

interface Record_ {
  chainId?: number;
  deployer?: string;
  deployTxSent?: string;
  manager?: string;
  deployTx?: string;
  deployBlock?: number;
  vault?: string;
  configureTxSent?: string;
  configureTx?: string;
  configureBlock?: number;
}

async function main() {
  const step = process.env.KUSDT_AM_STEP;
  if (step !== "deploy" && step !== "configure") fail("set KUSDT_AM_STEP=deploy or configure");
  const file = process.env.KUSDT_AM_CONFIG;
  if (!file || !fs.existsSync(file)) fail("KUSDT_AM_CONFIG must name the manager's config file");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const cfg = checkOwnerConfig({ safe: raw.safe, emergencyDelay: raw.emergencyDelay, cancellers: raw.cancellers }, "config");

  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const [deployer] = await ethers.getSigners();
  if (!deployer) fail(`no deployer account for ${network.name}: set DEPLOYER_KEY`);
  if (deployer.address === cfg.safe || cfg.cancellers.includes(deployer.address)) fail("the deployer can't be the Safe or a canceller");
  if (MAINNETS.has(chainId)) {
    // Any code was taken for a contract: an account delegated under EIP-7702 has code too, and is one key (Daybreak [36]).
    if (!isContractCode(await ethers.provider.getCode(cfg.safe))) fail("on a mainnet the Safe must be a contract, not an account with no code or one delegated under EIP-7702 (one key)");
    if (process.env.KUSDT_CONFIRM_MAINNET !== `deploy-to-${chainId}`) fail(`set KUSDT_CONFIRM_MAINNET=deploy-to-${chainId} to deploy to a mainnet`);
  } else if (!TESTNETS.has(chainId)) fail(`unknown chain ${chainId}`);
  console.log(`network ${network.name} (chain ${chainId}), deployer ${deployer.address}, step ${step}`);

  const dir = process.env.KUSDT_DEPLOYMENTS_DIR ?? path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const recPath = path.join(dir, `${network.name}.access-manager.json`);
  const rec: Record_ = fs.existsSync(recPath) ? JSON.parse(fs.readFileSync(recPath, "utf8")) : {};
  if (rec.chainId !== undefined && (rec.chainId !== Number(chainId) || rec.deployer !== deployer.address)) {
    fail(`${recPath} is from another chain or deployer: move it away first`);
  }
  const keep = (more: Record_) => {
    Object.assign(rec, { chainId: Number(chainId), deployer: deployer.address }, more);
    fs.writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
  };
  const receipt = (hash: string) => until(`the receipt of ${hash}`, () => ethers.provider.getTransactionReceipt(hash));

  if (step === "deploy") {
    if (!rec.manager) {
      if (!rec.deployTxSent) {
        const factory = await ethers.getContractFactory("KusdtAccessManager");
        const tx = await deployer.sendTransaction(await factory.getDeployTransaction(deployer.address));
        keep({ deployTxSent: tx.hash }); // before waiting: a rerun waits for this one instead of sending another
        console.log(`KusdtAccessManager deploy sent: ${tx.hash}`);
      } else console.log(`AccessManager deploy ${rec.deployTxSent} was sent by an earlier run: waiting for it`);
      const rc = await receipt(rec.deployTxSent!);
      if (rc.status !== 1 || !rc.contractAddress) fail(`the AccessManager deploy ${rc.hash} failed: look at it, then move ${recPath} away`);
      keep({ manager: rc.contractAddress, deployTx: rc.hash, deployBlock: rc.blockNumber });
    }
    const manager = rec.manager!;
    await until(`the manager's code at ${manager}`, async () => (await ethers.provider.getCode(manager)) !== "0x");
    const am = await ethers.getContractAt("KusdtAccessManager", manager);
    const [isAdmin, delay] = await until("the manager's first admin", () => am.hasRole(ROLES.ADMIN, deployer.address));
    if (!rec.configureTx && (!isAdmin || delay !== 0n)) fail(`the manager at ${manager} does not have the deployer as its admin`);
    console.log(`AccessManager: ${manager} (block ${rec.deployBlock})`);
    return;
  }

  // configure
  if (!rec.manager) fail("deploy the manager first (KUSDT_AM_STEP=deploy)");
  const manager = rec.manager;
  const vault = ethers.getAddress(String(raw.vault ?? ""));
  if (rec.vault && rec.vault !== vault) fail(`${recPath} configured the vault ${rec.vault}, not ${vault}`);
  const am = await ethers.getContractAt("KusdtAccessManager", manager);
  const v = await ethers.getContractAt("KusdtVault", vault);
  if ((await until("the vault's owner", () => v.owner())) !== manager) fail(`the vault ${vault} is not owned by the manager ${manager}`);
  if (!rec.configureTx) {
    if (!rec.configureTxSent) {
      const [isAdmin] = await am.hasRole(ROLES.ADMIN, deployer.address);
      if (!isAdmin) fail(`the deployer is no longer the manager's admin, and no configure was recorded in ${recPath}: look at the manager's events`);
      const tx = await am.connect(deployer).multicall(setupCalls(cfg, vault, deployer.address, await am.getAddress()));
      keep({ vault, configureTxSent: tx.hash });
      console.log(`configure sent: ${tx.hash}`);
    } else console.log(`configure ${rec.configureTxSent} was sent by an earlier run: waiting for it`);
    const rc = await receipt(rec.configureTxSent!);
    if (rc.status !== 1) fail(`the configure transaction ${rc.hash} failed: move configureTxSent out of ${recPath} to try again`);
    keep({ vault, configureTx: rc.hash, configureBlock: rc.blockNumber });
  }

  // Read back what the chain now says (a lagging RPC is waited for).
  const read = <T>(what: string, f: () => Promise<T>) => until(what, f);
  await read("the deployer's giving up ADMIN", async () => !(await am.hasRole(ROLES.ADMIN, deployer.address))[0]);
  for (const r of expectedRoles(cfg)) {
    for (const m of r.members) {
      const [isMember, delay] = await read(`role ${r.name}`, () => am.hasRole(r.id, m.account));
      if (!isMember || Number(delay) !== m.delay) fail(`${m.account} should hold ${r.name} with a ${m.delay} s delay, has ${isMember} / ${delay}`);
    }
    if ((await am.getRoleGuardian(r.id)) !== r.guardian) fail(`${r.name}'s guardian is not ${r.guardian}`);
  }
  for (const f of vaultFunctionRoles()) {
    if ((await am.getTargetFunctionRole(vault, f.selector)) !== f.roleId) fail(`the vault's ${f.signature} is not mapped to ${f.role}`);
  }
  for (const id of Object.values(ROLES)) if ((await am.hasRole(id, deployer.address))[0]) fail(`the deployer still holds role ${id}`);
  console.log(`AccessManager ${manager} configured (block ${rec.configureBlock}): the Safe ${cfg.safe} is the only admin (delay ${ADMIN_DELAY / 3600} h), the deployer holds no role`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
