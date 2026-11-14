// What the pool and the minter take as inputs since rc.22 (bridge_mint.ag
// `require_settled_inputs`; SPEC §15, "Parked spends"; the developers' page
// "Inputs of a pool or minter transaction"): at most MAX_TX_INPUTS inputs in
// all, funding coins that are plain Schnorr P2PK coins, and no coin still in the
// mempool unless the transaction that made the pool coin made it too. The core's
// builders refuse anything else; this is what the wallet chooses by, and what it
// tells the user, before it asks them.
//
// No imports but the protocol's constants, so the web app can tell these errors
// apart without loading the wallet's engine.

import { MAX_TX_INPUTS, UNACCEPTED_DAA_SCORE } from '@kusdt/protocol';

export { MAX_TX_INPUTS, UNACCEPTED_DAA_SCORE };

/** The covenant coins each pool command of the wallet spends besides its funding coins (the pool's, the reserve, a kUSDT state, a position). */
export const COVENANT_INPUTS: Readonly<Record<string, number>> = {
  'pool-buy': 2, // pool, reserve
  'pool-init': 2, // pool, provider
  'pool-sell': 3, // pool, reserve, payer
  'pool-add': 3, // pool, reserve, provider
  'pool-remove': 3, // pool, position, reserve
};

/** The most funding coins `command` may take, or null for a transaction the pool's input rule does not cover (a transfer). */
export function fundingCap(command: string): number | null {
  const covenant = COVENANT_INPUTS[command];
  return covenant === undefined ? null : MAX_TX_INPUTS - covenant;
}

/** A plain Schnorr P2PK script as the core takes it: version 0000, then 20 ‖ key[32] ‖ ac. The only plain coin the builders fund with. */
export const isSchnorrP2pk = (spkHex: string): boolean => /^000020[0-9a-f]{64}ac$/.test(spkHex);

/**
 * The KAS this needs is spread over more coins than one pool transaction can take: its `cap` largest are not enough,
 * all `coins` would be. Nothing was built or sent; merging the coins (a plain send of all of it to the wallet's own
 * address) is the way. `coins`: how many plain coins the wallet holds.
 *
 * With `lost` (round 17, R17-CL-1): the `cap` coins are enough, but no set of them leaves change the network keeps,
 * so about `lost` sompi would go to the network fee; rc.21 added a coin to keep it, and the cap does not let it. One
 * coin keeps it, so merging is the way here too (or another amount).
 */
export class MergeCoinsFirst extends Error {
  readonly kind = 'merge-coins' as const;
  constructor(readonly cap: number, readonly coins: number, readonly lost?: bigint) {
    super(lost == null
      ? `Your KAS is in ${coins} coins, and the ${cap} largest are not enough for this: a pool transaction takes at most ${MAX_TX_INPUTS} inputs, ${MAX_TX_INPUTS - cap} of them the pool's own. Merge your KAS first: send all of it to your own address (Send, KAS, Max), and once it is back as one coin, try again. Nothing was sent.`
      : `Your KAS is in ${coins} coins, and a pool transaction takes at most ${MAX_TX_INPUTS} inputs, ${MAX_TX_INPUTS - cap} of them the pool's own: the ${cap} it can take would leave about ${kasText(lost)} KAS of change, too little for the network to keep, and it would go to the network fee. Merge your KAS first: send all of it to your own address (Send, KAS, Max), and once it is back as one coin, try again; or change the amount a little. Nothing was sent.`);
  }
}

/** Sompi as KAS with two decimals, rounded down (this module imports no formatter, see above). */
const kasText = (sompi: bigint): string => `${sompi / 100_000_000n}.${((sompi % 100_000_000n) / 1_000_000n).toString().padStart(2, '0')}`;

/** Whether `e` is MergeCoinsFirst (also from a copy of this module in another bundle). */
export const isMergeCoinsFirst = (e: unknown): e is MergeCoinsFirst =>
  e instanceof MergeCoinsFirst || (typeof e === 'object' && e !== null && (e as { kind?: unknown }).kind === 'merge-coins' && typeof (e as { cap?: unknown }).cap === 'number');

/**
 * A coin this pool transaction spends is still in the mempool and was not made by the transaction that made the pool
 * coin, so the pool takes it only once it is in a block (a few seconds). Nothing was built or sent. `what`: which coin.
 */
export class NotInBlockYet extends Error {
  readonly kind = 'not-in-block' as const;
  constructor(readonly what: 'position' | 'token' | 'coin') {
    super(what === 'position'
      ? 'The deposit that made this position is not in a block yet, and the pool has moved since: the pool takes the position once it is (a few seconds). Nothing was sent; try again in a moment.'
      : what === 'token'
        ? 'The kUSDT this spends is in a transaction that is not in a block yet: the pool takes it once it is (a few seconds). Nothing was sent; try again in a moment.'
        : 'A coin this spends is in a transaction that is not in a block yet: the pool takes it once it is (a few seconds). Nothing was sent; try again in a moment.');
  }
}

/** Whether `e` is NotInBlockYet (also from a copy of this module in another bundle). */
export const isNotInBlockYet = (e: unknown): e is NotInBlockYet =>
  e instanceof NotInBlockYet || (typeof e === 'object' && e !== null && (e as { kind?: unknown }).kind === 'not-in-block');

/** A coin as the wallet knows it: where it was found (the UTXO set or only the mempool) and the DAA score it holds then. */
interface Placed { transactionId: string; blockDaaScore: bigint; confirmed?: boolean }

/**
 * The DAA score a coin is handed to the core with: a node's mark for an output still in its mempool
 * (UNACCEPTED_DAA_SCORE, which the covenants read as -1) for a coin found only there, so that the scripts the core
 * runs judge the transaction as the node will; the score the node gave it otherwise. A coin the wallet could not place
 * (one whose address the node could not list) keeps the score of its record: the node judges it.
 */
export const daaForCore = (u: Placed): bigint => (u.confirmed === false ? UNACCEPTED_DAA_SCORE : u.blockDaaScore);

/**
 * Refuses (NotInBlockYet) a pool transaction whose other covenant coins include one still in the mempool that the
 * transaction which made the pool coin did not make, as `require_settled_inputs` and the core's builders do. Funding
 * coins are never in the mempool (the wallet takes them from the UTXO set only).
 */
export function assertSettled(pool: Placed, others: { coin: Placed; what: NotInBlockYet['what'] }[]): void {
  for (const o of others) {
    if (o.coin.confirmed === false && o.coin.transactionId !== pool.transactionId) throw new NotInBlockYet(o.what);
  }
}
