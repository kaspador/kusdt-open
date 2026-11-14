/**
 * Deploys a KusdtVault (and, on test networks only, a MockUSDT first).
 *
 *   DEPLOY_CONFIG=config/sepolia.json npx hardhat run scripts/deploy.ts --network sepolia
 *
 * Parameters come from the JSON file named by DEPLOY_CONFIG, and any KUSDT_* environment
 * variable overrides the file (see README.md). Amounts are integers in units (10^-6 USDT).
 * The deployer key comes from DEPLOYER_KEY via hardhat.config.ts; it is never read or
 * printed here. Addresses are written to deployments/<network>.json.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { isContractCode } from "./access-manager";
import { until } from "./until";

const MAINNET_USDT: Record<string, { address: string; decimals: number }> = {
  "1": { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  "56": { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
};
const TESTNETS = new Set(["11155111", "97", "31337"]);

interface Config {
  deployMockUsdt: boolean;
  mockDecimals?: number;
  token?: string;
  tokenDecimals?: number;
  signers: string[];
  guardian: string;
  owner: string;
  feeBps: number;
  minDepositFee: bigint;
  minReleaseFee: bigint;
  minDeposit: bigint;
  maxDeposit: bigint;
  releaseCapacity: bigint;
  releaseRefillPerSecond: bigint;
  /** Seconds a payout waits in the vault. */
  payoutDelay: number;
  /** The rising deposit fee: the rate at a full deposit meter (basis points) and the meter's size in units a day. 0 and 0: a flat fee. */
  surgeFeeBps: number;
  surgeCapacity: bigint;
}

const ENV: Record<string, string> = {
  deployMockUsdt: "KUSDT_DEPLOY_MOCK_USDT",
  mockDecimals: "KUSDT_MOCK_DECIMALS",
  token: "KUSDT_TOKEN",
  tokenDecimals: "KUSDT_TOKEN_DECIMALS",
  signers: "KUSDT_SIGNERS",
  guardian: "KUSDT_GUARDIAN",
  owner: "KUSDT_OWNER",
  feeBps: "KUSDT_FEE_BPS",
  minDepositFee: "KUSDT_MIN_DEPOSIT_FEE",
  minReleaseFee: "KUSDT_MIN_RELEASE_FEE",
  minDeposit: "KUSDT_MIN_DEPOSIT",
  maxDeposit: "KUSDT_MAX_DEPOSIT",
  releaseCapacity: "KUSDT_RELEASE_CAPACITY",
  releaseRefillPerSecond: "KUSDT_RELEASE_REFILL_PER_SECOND",
  payoutDelay: "KUSDT_PAYOUT_DELAY",
  surgeFeeBps: "KUSDT_SURGE_FEE_BPS",
  surgeCapacity: "KUSDT_SURGE_CAPACITY",
};

function fail(msg: string): never {
  throw new Error(`deploy: ${msg}`);
}

function units(name: string, v: unknown): bigint {
  const s = typeof v === "number" ? (Number.isSafeInteger(v) ? String(v) : "") : String(v ?? "");
  if (!/^\d+$/.test(s)) fail(`${name} must be a non-negative integer (units), got ${JSON.stringify(v)}`);
  return BigInt(s);
}

function smallInt(name: string, v: unknown): number {
  const n = Number(units(name, v));
  if (!Number.isSafeInteger(n)) fail(`${name} is too large`);
  return n;
}

function addr(name: string, v: unknown): string {
  if (typeof v !== "string" || !ethers.isAddress(v)) fail(`${name} must be an address, got ${JSON.stringify(v)}`);
  const a = ethers.getAddress(v);
  if (a === ethers.ZeroAddress) fail(`${name} is the zero address`);
  return a;
}

function bool(name: string, v: unknown): boolean {
  if (v === undefined || v === "" || v === false || v === "false" || v === "0") return false;
  if (v === true || v === "true" || v === "1") return true;
  fail(`${name} must be true or false`);
}

function loadConfig(): Config {
  let raw: Record<string, unknown> = {};
  const file = process.env.DEPLOY_CONFIG;
  if (file) {
    const p = path.resolve(file);
    if (!fs.existsSync(p)) fail(`DEPLOY_CONFIG file not found: ${p}`);
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  }
  for (const [key, env] of Object.entries(ENV)) {
    const v = process.env[env];
    if (v !== undefined && v !== "") raw[key] = key === "signers" ? v.split(",").map((s) => s.trim()) : v;
  }

  const signers = raw.signers;
  if (!Array.isArray(signers) || signers.length !== 5) fail("signers must list exactly 5 addresses");
  const s = signers.map((x, i) => addr(`signers[${i}]`, x));
  if (new Set(s).size !== 5) fail("signers must be distinct");

  const cfg: Config = {
    deployMockUsdt: bool("deployMockUsdt", raw.deployMockUsdt),
    signers: s,
    guardian: addr("guardian", raw.guardian),
    owner: addr("owner", raw.owner),
    feeBps: smallInt("feeBps", raw.feeBps),
    minDepositFee: units("minDepositFee", raw.minDepositFee),
    minReleaseFee: units("minReleaseFee", raw.minReleaseFee),
    minDeposit: units("minDeposit", raw.minDeposit),
    maxDeposit: units("maxDeposit", raw.maxDeposit),
    releaseCapacity: units("releaseCapacity", raw.releaseCapacity),
    releaseRefillPerSecond: units("releaseRefillPerSecond", raw.releaseRefillPerSecond),
    payoutDelay: smallInt("payoutDelay", raw.payoutDelay),
    // Left out of a config: a flat fee, as before.
    surgeFeeBps: smallInt("surgeFeeBps", raw.surgeFeeBps ?? 0),
    surgeCapacity: units("surgeCapacity", raw.surgeCapacity ?? "0"),
  };
  // The vault's hard bounds, checked before anything is sent (the constructor checks them again).
  const MAX_AMOUNT = 10n ** 15n;
  if (cfg.feeBps > 100) fail("feeBps must be at most 100");
  if (cfg.minDepositFee > 50_000_000n || cfg.minReleaseFee > 50_000_000n) fail("minimum fees must be at most 50 USDT");
  if (cfg.minDeposit === 0n || cfg.minDeposit > cfg.maxDeposit || cfg.maxDeposit > MAX_AMOUNT) {
    fail("need 0 < minDeposit <= maxDeposit <= 10^15");
  }
  if (cfg.releaseCapacity > MAX_AMOUNT) fail("releaseCapacity must be at most 10^15");
  if (cfg.releaseRefillPerSecond > cfg.releaseCapacity / 86_400n) fail("the allowance may not refill in under a day");
  if (cfg.payoutDelay > 86_400) fail("payoutDelay must be at most a day (86400 seconds)");
  if (cfg.surgeFeeBps > 300) fail("surgeFeeBps must be at most 300");
  if (cfg.surgeCapacity === 1n || cfg.surgeCapacity > MAX_AMOUNT) fail("surgeCapacity must be 0 (off) or from 2 to 10^15");
  if ((cfg.surgeCapacity === 0n) !== (cfg.surgeFeeBps === 0)) fail("surgeFeeBps and surgeCapacity go together: both 0, or both set");
  if (cfg.surgeCapacity !== 0n && cfg.surgeFeeBps <= cfg.feeBps) fail("surgeFeeBps must be above feeBps: the fee would not rise");
  if (cfg.minDeposit <= cfg.minDepositFee) console.warn("warning: a minimum deposit would mint nothing");

  if (cfg.deployMockUsdt) {
    cfg.mockDecimals = smallInt("mockDecimals", raw.mockDecimals ?? 6);
    if (cfg.mockDecimals < 6 || cfg.mockDecimals > 18) fail("mockDecimals must be 6 to 18");
    if (raw.token) fail("give either token or deployMockUsdt, not both");
  } else {
    cfg.token = addr("token", raw.token);
    cfg.tokenDecimals = smallInt("tokenDecimals", raw.tokenDecimals);
  }
  return cfg;
}

async function main() {
  const cfg = loadConfig();
  const { chainId: cid } = await ethers.provider.getNetwork();
  const chainId = cid.toString();
  const [deployer] = await ethers.getSigners();
  if (!deployer) fail(`no deployer account for ${network.name}: set DEPLOYER_KEY`);

  // Guard rails for mainnets.
  const canonical = MAINNET_USDT[chainId];
  if (canonical) {
    if (cfg.deployMockUsdt) fail("MockUSDT is for test networks only");
    if (cfg.token !== ethers.getAddress(canonical.address) || cfg.tokenDecimals !== canonical.decimals) {
      fail(`on chain ${chainId} the token must be ${canonical.address} with ${canonical.decimals} decimals (SPEC §2)`);
    }
    if (cfg.payoutDelay < 300) fail("on a mainnet payoutDelay must be at least 5 minutes (300 seconds): it is the guardian's time to pause");
    // Any code was taken for a contract: an account delegated under EIP-7702 has code too, and is one key (Daybreak [36]).
    if (!isContractCode(await ethers.provider.getCode(cfg.owner))) {
      fail("on a mainnet the owner must be a contract (an AccessManager under a Safe, SPEC §12), not an account with no code or one delegated under EIP-7702 (one key)");
    }
    if (process.env.KUSDT_CONFIRM_MAINNET !== `deploy-to-${chainId}`) {
      fail(`set KUSDT_CONFIRM_MAINNET=deploy-to-${chainId} to deploy to a mainnet`);
    }
  } else if (!TESTNETS.has(chainId)) {
    fail(`unknown chain ${chainId}`);
  }
  if (cfg.signers.includes(deployer.address)) console.warn("warning: the deployer is one of the signers");

  console.log(`network ${network.name} (chain ${chainId}), deployer ${deployer.address}`);

  // What this network got so far, written after each contract: a run that fails later
  // (an RPC that lags behind the block it just reported) resumes instead of deploying twice.
  // KUSDT_DEPLOYMENTS_DIR keeps a run's records apart (the mainnet deployer gives each run its own folder).
  const dir = process.env.KUSDT_DEPLOYMENTS_DIR ?? path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const partialPath = path.join(dir, `${network.name}.partial.json`);
  const partial: { chainId?: number; deployer?: string; token?: string; vault?: string; deployTx?: string; deployBlock?: number; deployTxSent?: string } =
    fs.existsSync(partialPath) ? JSON.parse(fs.readFileSync(partialPath, "utf8")) : {};
  if (partial.chainId !== undefined && (partial.chainId !== Number(chainId) || partial.deployer !== deployer.address)) {
    fail(`${partialPath} is from another chain or deployer: move it away first`);
  }
  const keep = (more: typeof partial) => {
    Object.assign(partial, { chainId: Number(chainId), deployer: deployer.address }, more);
    fs.writeFileSync(partialPath, JSON.stringify(partial, null, 2) + "\n");
  };

  let tokenAddress: string;
  let decimals: number;
  let mockDeployed = false;
  if (cfg.deployMockUsdt) {
    decimals = cfg.mockDecimals!;
    if (partial.token) {
      tokenAddress = partial.token;
      await until(`MockUSDT's code at ${tokenAddress}`, async () => (await ethers.provider.getCode(tokenAddress)) !== "0x");
      console.log(`MockUSDT (${decimals} decimals): ${tokenAddress} (deployed by an earlier run)`);
    } else {
      const mock = await (await ethers.getContractFactory("MockUSDT")).deploy("Mock USDT (kUSDT testnet)", "USDT", decimals);
      await mock.waitForDeployment();
      tokenAddress = await mock.getAddress();
      keep({ token: tokenAddress });
      console.log(`MockUSDT (${decimals} decimals): ${tokenAddress}`);
    }
    mockDeployed = true;
  } else {
    tokenAddress = cfg.token!;
    decimals = cfg.tokenDecimals!;
  }

  const params = {
    feeBps: cfg.feeBps,
    minDepositFee: cfg.minDepositFee,
    minReleaseFee: cfg.minReleaseFee,
    minDeposit: cfg.minDeposit,
    maxDeposit: cfg.maxDeposit,
    releaseCapacity: cfg.releaseCapacity,
    releaseRefillPerSecond: cfg.releaseRefillPerSecond,
  };
  let vaultAddress: string;
  let deployTx: string;
  let deployBlock: number;
  if (partial.vault && partial.deployTx && partial.deployBlock !== undefined) {
    ({ vault: vaultAddress, deployTx, deployBlock } = partial as Required<typeof partial>);
    console.log(`KusdtVault: ${vaultAddress} (block ${deployBlock}, deployed by an earlier run)`);
  } else {
    if (!partial.deployTxSent) {
      const factory = await ethers.getContractFactory("KusdtVault");
      const unsigned = await factory.getDeployTransaction(
        tokenAddress,
        decimals,
        cfg.signers as [string, string, string, string, string],
        cfg.guardian,
        cfg.owner,
        params,
        cfg.payoutDelay,
        cfg.surgeFeeBps,
        cfg.surgeCapacity,
      );
      const tx = await deployer.sendTransaction(unsigned);
      keep({ deployTxSent: tx.hash }); // before waiting: a rerun waits for this one instead of sending a second vault
      console.log(`KusdtVault deploy sent: ${tx.hash}`);
    } else console.log(`KusdtVault deploy ${partial.deployTxSent} was sent by an earlier run: waiting for it`);
    const rc = await until(`the receipt of ${partial.deployTxSent}`, () => ethers.provider.getTransactionReceipt(partial.deployTxSent!));
    if (rc.status !== 1 || !rc.contractAddress) fail(`the vault deploy ${rc.hash} failed, so there is no vault: look at why. A mainnet run then starts again in a new run folder (its manager must be the deployer's transaction just before its vault); elsewhere, move ${partialPath} away to try again`);
    vaultAddress = rc.contractAddress!;
    deployTx = rc.hash;
    deployBlock = rc.blockNumber;
    keep({ vault: vaultAddress, deployTx, deployBlock });
    console.log(`KusdtVault: ${vaultAddress} (block ${deployBlock})`);
  }
  const vault = await ethers.getContractAt("KusdtVault", vaultAddress);

  // Read back what was deployed, so the record reflects the chain, not the config.
  // A load-balanced RPC may answer from a node that hasn't seen the block yet ("0x"):
  // every read waits until the contract is there.
  await until(`the vault's code at ${vaultAddress}`, async () => (await ethers.provider.getCode(vaultAddress)) !== "0x");
  const read = <T>(what: string, f: () => Promise<T>) => until(what, async () => { try { return await f(); } catch { return undefined; } });
  if ((await read("the vault's token", () => vault.token())).toLowerCase() !== tokenAddress.toLowerCase()) {
    fail(`the vault at ${vaultAddress} holds another token`);
  }
  const p = await read("the vault's parameters", () => vault.params());
  const out = {
    network: network.name,
    chainId: Number(chainId),
    vault: vaultAddress,
    token: tokenAddress,
    tokenDecimals: decimals,
    mockUsdt: mockDeployed,
    owner: await read("the vault's owner", () => vault.owner()),
    guardian: await read("the vault's guardian", () => vault.guardian()),
    signers: [...(await read("the vault's signers", () => vault.signers()))],
    params: {
      feeBps: Number(p.feeBps),
      minDepositFee: p.minDepositFee.toString(),
      minReleaseFee: p.minReleaseFee.toString(),
      minDeposit: p.minDeposit.toString(),
      maxDeposit: p.maxDeposit.toString(),
      releaseCapacity: p.releaseCapacity.toString(),
      releaseRefillPerSecond: p.releaseRefillPerSecond.toString(),
      payoutDelay: Number(await read("the vault's payout wait", () => vault.payoutDelay())),
      surgeFeeBps: Number(await read("the vault's rising fee", () => vault.surgeFeeBps())),
      surgeCapacity: (await read("the vault's deposit meter size", () => vault.surgeCapacity())).toString(),
    },
    deployer: deployer.address,
    deployTx,
    deployBlock,
    deployedAt: new Date().toISOString(),
  };
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  fs.rmSync(partialPath, { force: true });
  console.log(`written ${path.relative(process.cwd(), file)}`);
  console.log(JSON.stringify({ vault: out.vault, token: out.token }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
