// What every kUSDT operation works with.

import type { KaspaNetworkParams } from '@kusdt/kaspa';
import type { Core } from '../lib/core';
import type { NetworkConfig, KaspaNetworkName } from '../config/defaults';
import type { KaspaNodeApi } from '../kaspa/node';
import type { CoordinatorApi } from './api';
import type { TokenState } from './owner';

/** A UTXO in the form the core takes (bridge/kaspa/src/model.rs Utxo). */
export interface CoreUtxo {
  transactionId: string;
  index: number;
  amount: bigint;
  scriptPublicKey: string;
  blockDaaScore: bigint;
  isCoinbase: boolean;
  covenantId: string | null;
  /** In the UTXO set (false: an output of a transaction still in the mempool). Not sent to the core. */
  confirmed?: boolean;
  /**
   * The id of a transaction in the node's mempool that spends this output and that no block can take (round 11,
   * COV-1): the output is unspent, and this node refuses every other spend of it while it holds that transaction.
   * Not sent to the core.
   */
  heldBy?: string;
  /**
   * The node could not list this output's address (it holds too many coins, or the read timed out), so the output
   * was not found there and is not known to be gone (round 12, R12-WW-1). Its fields are a record's: the wallet's
   * own of what its node once showed, or the coordinator's. Never counted in a balance and never chosen by itself;
   * a transaction built on it is one the node refuses unless the output is there exactly as recorded, since a
   * signature commits to the spent output's script and amount. Not sent to the core.
   */
  unchecked?: boolean;
}

export interface Located<S> { utxo: CoreUtxo; state: S }

export interface PoolState {
  tokenCovid: string;
  kasReserve: bigint;
  tokenReserve: bigint;
  totalShares: bigint;
  protocolKas: bigint;
  protocolTokens: bigint;
  baseValue: bigint;
  admin: string;
  /** The circuit breaker (SPEC §15): the cap is this share (bps) of the KAS reserve, refilling over windowLen DAA. */
  maxOutBps: bigint;
  windowLen: bigint;
  /** The room recent buys gave sells that is still KAS those buys left in the reserve (SPEC §15); a withdrawal moves that much back onto windowOut. Only claimed time or a sell or a withdrawal takes it back, never time alone: after a quiet period a sell claiming age 0 still has all of it on top of a whole cap. */
  windowCredit: bigint;
  /** The KAS reserve the cap is measured on: set by the first deposit, then down with the reserve at once and up with claimed time. */
  windowRef: bigint;
  /** The allowance used, in net KAS (negative after net buying, at most one cap). */
  windowOut: bigint;
  /** Swaps and new liquidity stop while paused; withdrawals don't. */
  paused: boolean;
  /** May pause, nothing else. */
  guardian: string;
}

export interface PositionState { tokenCovid: string; shares: bigint; owner: string }

/** The keys the wallet signs with, by address. Hex, wiped by nobody: callers keep them only for one build. */
export interface Signer {
  /** The main address: change, receiving and the kUSDT owner. */
  address: string;
  /** Its x-only key, hex (the owner of every token state the wallet spends). */
  ownerHex: string;
  /** The private key (hex) of one of the wallet's addresses, or null. */
  secretFor(address: string): string | null;
}

export interface Ctx {
  core: Core;
  node: KaspaNodeApi;
  api: CoordinatorApi | null;
  network: KaspaNetworkName;
  net: KaspaNetworkParams;
  config: NetworkConfig;
}

export type { TokenState };

/** What the core answers for a build (bridge/kaspa/src/model.rs Built). */
export interface BuiltOutput {
  index: number;
  kind: string;
  value: bigint;
  scriptPublicKey: string;
  token?: any;
  pool?: any;
  position?: any;
  minter?: any;
}
export interface Built {
  txid: string;
  fee: bigint;
  mass: { compute: bigint; storage: bigint; transient: bigint; feeMass: bigint };
  covenantId?: string;
  outputs: BuiltOutput[];
  /** The raw answer text: the transaction is submitted from it untouched. */
  raw: string;
  /** The transaction's node JSON, cut from `raw`. */
  transaction: string;
}
