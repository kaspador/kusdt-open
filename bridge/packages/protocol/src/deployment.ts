// A deployment: everything a part needs to know to act on one kUSDT
// (SPEC §2). Testnet and mainnet are separate deployments.

import type { Blocklist } from './evm';

export interface EvmChainDeployment {
  /** The protocol's chain code (SPEC §2): 1 Ethereum, 2 BNB Chain. */
  chain: 1 | 2;
  name: string;
  chainId: number;
  vault: string;
  token: string;
  decimals: number;
  /** First block to scan for Deposit events (the vault's deployment block). */
  fromBlock: number;
  /** "finalized" uses the chain's finalized tag; a number means that many confirmations. */
  finality: 'finalized' | number;
  /**
   * The token's blocklist, when it keeps one (SPEC §9): nothing is paid to an
   * address it reports blocked. Ethereum USDT: "isBlackListed"; BSC-USD keeps none.
   */
  blocklist?: Blocklist;
  /** The vault's owner when it is an OpenZeppelin AccessManager (mainnet): the monitors watch its OperationScheduled events. */
  accessManager?: string;
  /** The Safe that is that manager's only admin (and holds its GOVERNOR, EMERGENCY and PAUSER roles). */
  ownerSafe?: string;
  /**
   * The Safe's creation transaction and every transaction it has executed since: verify reads them (a hidden module shows in no present state).
   * An entry is a transaction hash, or, for executions relayed inside a transaction that was not sent to the Safe, the hash with the
   * fields of each Safe transaction (EIP-712 SafeTx) executed in it, from which verify recomputes the hash in the Safe's event.
   */
  ownerSafeHistory?: { creationTx?: string; txs?: (string | { hash: string; safeTxs: SafeTxFields[] })[] };
}

/** A Safe transaction as its owners signed it (numbers as decimal strings). */
export interface SafeTxFields { to: string; value: string; data: string; operation: number; safeTxGas: string; baseGas: string; gasPrice: string; gasToken: string; refundReceiver: string; nonce: string }

export interface KaspaDeployment {
  network: 'mainnet' | 'testnet-10' | 'simnet' | 'devnet';
  prefix: string;
  /** kUSDT's covenant ID (the BridgeMint/TokenSeed/KCC20 family). */
  covenantId: string;
  /** The KAS ⇄ kUSDT pool's covenant ID. */
  poolId: string;
  /** DAA score depth after which a burn counts as final (SPEC §10). */
  finalityDaa: number;
  /**
   * Deeper finality for larger burns (SPEC §10): a burn output of more than `above`
   * kUSDT base units waits at least `daa` DAA scores. A release can't be undone, so the
   * bigger the payout, the deeper a Kaspa reorg would have to reach before it is paid.
   * Read with burnFinalityDaa, for burns and for the skips behind refunds alike.
   */
  finalityTiers?: FinalityTier[];
  /** KAS (sompi) each new token state carries. */
  tokenValue: number;
  /**
   * KAS (sompi) a burn output carries (default DEFAULT_BURN_VALUE). A burn can never
   * be spent, so this KAS is lost with it: a smaller output costs storage mass, so fee,
   * instead. 0.3 KAS makes a redemption cost about 0.46 KAS, against 1.55 at 1.5 KAS.
   */
  burnValue?: number;
}

export interface FinalityTier {
  /** kUSDT base units (6 decimals), as a decimal string: the tier covers burns above it. */
  above: string;
  /** DAA scores such a burn must be below the virtual DAA score before it is final. */
  daa: number;
}

/**
 * The mainnet tiers (SPEC §10): up to 10 000 kUSDT, finalityDaa (1 000, about 100 s);
 * above 10 000, 6 000 DAA (about 10 minutes); above 100 000, 36 000 DAA (about an hour).
 */
export const MAINNET_FINALITY_TIERS: FinalityTier[] = [
  { above: '10000000000', daa: 6_000 },
  { above: '100000000000', daa: 36_000 },
];

/** How deep a burn output of `units` must be before it is final: the deepest tier it is above, at least finalityDaa. */
/**
 * Why the deployment's chains can't be trusted, or null: a chain listed twice is checked by one reader and followed by another
 * (`find` takes the first entry, a map built in order keeps the last), so a second entry could point every service at another vault.
 */
export function chainsProblem(dep: Pick<Deployment, 'chains'>): string | null {
  const codes: unknown[] = (Array.isArray(dep.chains) ? dep.chains : []).map((c) => c.chain);
  // Numbers, exactly: "1" is another key to a Map and the same chain to a reader that coerces it.
  if (codes.some((c) => c !== 1 && c !== 2)) return `a chain code is not 1 or 2: ${codes.map((c) => JSON.stringify(c)).join(', ')}`;
  return new Set(codes).size === codes.length ? null : `chain codes repeat: ${codes.join(', ')}`;
}

export function burnFinalityDaa(k: Pick<KaspaDeployment, 'finalityDaa' | 'finalityTiers'>, units: bigint): number {
  let daa = k.finalityDaa;
  for (const t of k.finalityTiers ?? []) if (units > BigInt(t.above) && t.daa > daa) daa = t.daa;
  return daa;
}

/** Why the tiers are malformed, or null: each `above` a whole number of units, each `daa` a whole number, both rising. */
export function finalityTiersProblem(k: Pick<KaspaDeployment, 'finalityDaa' | 'finalityTiers'>): string | null {
  if (!Number.isSafeInteger(k.finalityDaa) || k.finalityDaa < 0) return 'finalityDaa must be a whole number';
  if (k.finalityTiers === undefined) return null;
  if (!Array.isArray(k.finalityTiers)) return 'finalityTiers must be a list';
  let above = -1n;
  let daa = k.finalityDaa;
  for (const [i, t] of k.finalityTiers.entries()) {
    if (typeof t?.above !== 'string' || !/^(0|[1-9]\d*)$/.test(t.above)) return `finalityTiers[${i}].above must be a whole number of base units, as a string`;
    if (!Number.isSafeInteger(t.daa)) return `finalityTiers[${i}].daa must be a whole number`;
    if (BigInt(t.above) <= above) return `finalityTiers[${i}].above must rise`;
    if (t.daa <= daa) return `finalityTiers[${i}].daa must be deeper than the tier before it (${daa})`;
    above = BigInt(t.above);
    daa = t.daa;
  }
  return null;
}

/** 0.3 KAS: what a burn output carries unless the deployment says otherwise (SPEC §9). */
export const DEFAULT_BURN_VALUE = 30_000_000;

export interface Deployment {
  name: string;
  kaspa: KaspaDeployment;
  chains: EvmChainDeployment[];
  /** The five signers: their Kaspa x-only keys and EVM addresses, in signer order. */
  signers: { kaspa: string; evm: string }[];
  /**
   * The daily limit every signer agreed to (each signer's `dailyLimit`, kUSDT base units per 24 h, as a string), when
   * the deployment names it: the coordinator checks a signer's refusal for its limit against it (R21-COORD2-1).
   * Otherwise the coordinator's config names it.
   */
  signerDailyLimit?: string;
  /**
   * The launch, as the deploy recorded it: where every follower starts. The
   * services take initialMinter, initialPool and scanFrom from here when their
   * own config leaves them out, so an operator's config needs no copy.
   */
  launch?: DeploymentLaunch;
}

export interface DeploymentLaunch {
  prepareTxid?: string;
  genesisTxid?: string;
  poolGenesisTxid?: string;
  /** The minter's first UTXO and state (the genesis output). */
  initialMinter: { utxo: any; state: any };
  /** The pool's first UTXO and state (its genesis output). */
  initialPool?: { utxo: any; state: any };
  /** A chain block hash from before the genesis: the followers read from there. */
  scanFrom: string;
  /** The minter's guardian, once a rotation has changed it from the genesis one. Signers compare a new plan against it. */
  guardian?: string;
  /**
   * The five signers at genesis, once a rotation has replaced any (SPEC §12): the
   * initial minter's signer set hashes from these, the deployment's `signers` are
   * today's. The followers apply each rotation from the chain itself.
   */
  signers?: { kaspa: string; evm: string }[];
}

export function chainOf(dep: Deployment, chain: number): EvmChainDeployment {
  const c = dep.chains.find((x) => x.chain === chain);
  if (!c) throw new Error(`the deployment has no chain ${chain}`);
  return c;
}
