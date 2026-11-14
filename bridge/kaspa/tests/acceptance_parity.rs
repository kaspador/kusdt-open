//! A spend of the pool or of the minter that a node accepts is one a block can take: `require_settled_inputs`
//! (bridge_mint.ag), which every pool and minter entry calls. SPEC §15, "Parked spends".
//!
//! A node judges an input whose coin is an output of a transaction still in its mempool by the DAA score u64::MAX
//! (a script reads -1) and so checks no relative lock on it, where a block uses the coin's real score (the outside
//! review reproduced it on kaspad 2.1.0; rusty-kaspa mining/src/mempool/populate_entries_and_try_validate.rs, and
//! `check_sequence_lock` in consensus/src/processes/transaction_validator/tx_validation_in_utxo_context.rs).
//!
//! Each case builds a transaction with its coins as a node's mempool shows them (the builder runs every script, so a
//! refusal there is the mempool's), applies the node's relative-lock rule at the virtual DAA score, and, when that
//! view accepts, runs the same bytes with the coins as a block shows them once their unconfirmed parents are in one,
//! with the rule at that block's score. A spend the mempool takes and no block can is a parked spend: the test fails.
//!
//! What is run (round 17, R17-COV-1, made this list true; before it only tick, pause and buy on the pool, and mint,
//! pause and execute_recovery on the minter, were run):
//! - Every Pool entry: init, buy, sell, sell_all, add, remove (paused and not), tick, collect, pause, unpause and
//!   set_keys; every BridgeMint entry: mint, pause, execute_recovery, and govern with unpause, set_limits,
//!   propose_recovery and veto_recovery. Each at every age it may claim (0, and 50 DAA where a claim is allowed).
//! - On each: the eight inputs taken and nine refused, with the entry's own input first and after a plain coin; each
//!   parking shape refused by the entry's own input (a P2SH coin whose script passes only while unconfirmed, a plain
//!   coin of an unrelated unconfirmed transaction, a plain coin asking a lock of 1, one with the disable bit, an ECDSA
//!   coin with a valid signature, a P2SH coin, a coin of another covenant); the active input's sequence exactly its
//!   claim, and a positive claim only on a coin in a block; a user's kUSDT state or position taken only in a block or
//!   beside the covenant coin.
//! - `whatever_the_mempool_takes_a_block_takes`: an exhaustive grid of 120 shapes on tick and buy.
//! - `random_shapes_on_every_entry`: seeded random transactions over every entry above (the entry, its claim, the
//!   active input's place and sequence, where the covenant coin and the user's coin are, and up to nine inputs of
//!   every kind, place and sequence), each judged in both views and held to what the rule says of it: taken exactly
//!   when it should be.
//!
//!   cargo test --locked --test acceptance_parity -- --nocapture

mod common;

use std::sync::OnceLock;

use argent::artifact::Artifact;
use argent_runtime::{ArtifactBundle, ArtifactValue, BuilderError, EntryCall, InputSigScript, TxBuilder, TxContext, args, state};
use common::{
    CHAIN_ETHEREUM, FUNDING_SIG_HASH, Harness, MinterState, MintCase, Recipient, Rejected, State, funding_key, funding_sig, key,
    outpoint, p2pk_spk, sign_digest, sign_input, xonly,
};
use kaspa_consensus_core::{
    Hash,
    constants::{SEQUENCE_LOCK_TIME_DISABLED, SEQUENCE_LOCK_TIME_MASK, UNACCEPTED_DAA_SCORE},
    hashing::{
        sighash::{SigHashReusedValuesUnsync, calc_ecdsa_signature_hash},
        sighash_type::SigHashType,
    },
    tx::{CovenantBinding, ScriptPublicKey, Transaction, TransactionId, TransactionOutpoint, UtxoEntry},
};
use kaspa_txscript::standard::pay_to_script_hash_script;
use secp256k1::{Keypair, Message, Secp256k1};

/// The virtual DAA score when the transaction reaches the node.
const V: u64 = 10_000;
/// Where its unconfirmed parents are accepted, in the view of a block that takes it.
const MINED: u64 = V + 1;
/// The most inputs a pool or minter transaction may have (bridge_mint.ag `MAX_TX_INPUTS`).
const MAX_TX_INPUTS: usize = 8;

/// The node's relative-lock rule (rusty-kaspa `check_sequence_lock`): an input whose sequence asks a lock fails while
/// its coin's score plus the lock, less one, is at least the score it is judged at. A coin still in the mempool has
/// the score u64::MAX, which this reads as -1: such a lock never fails.
fn node_locks(tx: &Transaction, entries: &[UtxoEntry], pov: u64) -> Result<(), String> {
    for (i, (input, entry)) in tx.inputs.iter().zip(entries).enumerate() {
        if input.sequence & SEQUENCE_LOCK_TIME_DISABLED != 0 {
            continue;
        }
        let lock = (input.sequence & SEQUENCE_LOCK_TIME_MASK) as i64;
        if entry.block_daa_score as i64 + lock - 1 >= pov as i64 {
            return Err(format!("input {i} asks a relative lock not met at DAA {pov}"));
        }
    }
    Ok(())
}

/// The coins as a block that takes the transaction shows them: what was still in the mempool is in a block now.
fn in_a_block(entries: &[UtxoEntry]) -> Vec<UtxoEntry> {
    entries
        .iter()
        .map(|e| {
            let mut e = e.clone();
            if e.block_daa_score == UNACCEPTED_DAA_SCORE {
                e.block_daa_score = MINED;
            }
            e
        })
        .collect()
}

/// What the node's mempool makes of a transaction built with `mempool` coins.
#[derive(Debug)]
enum Seen {
    /// Taken, and a block takes it too.
    Taken,
    /// Refused, with the reason the engine or the lock rule gave.
    Refused(String),
}

/// Judges `built` (made with the coins as the mempool shows them) in both views. Panics on a parked spend: the mempool
/// takes it and the block view refuses it.
fn judge(what: &str, built: Result<Transaction, Rejected>, mempool: &[UtxoEntry]) -> Seen {
    let tx = match built {
        Ok(tx) => tx,
        Err(Rejected::Script(e)) => return Seen::Refused(e),
        Err(Rejected::Build(e)) => panic!("{what}: the builder failed before any script ran: {e}"),
    };
    if let Err(e) = common::run(tx.clone(), mempool.to_vec()) {
        return Seen::Refused(format!("{e:?}"));
    }
    if let Err(e) = node_locks(&tx, mempool, V) {
        return Seen::Refused(e);
    }
    let block = in_a_block(mempool);
    if let Err(e) = common::run(tx.clone(), block.clone()) {
        panic!("{what}: PARKED, the mempool takes it and a block's view of its scripts refuses it: {e:?}");
    }
    if let Err(e) = node_locks(&tx, &block, MINED) {
        panic!("{what}: PARKED, the mempool takes it and a block's lock rule refuses it: {e}");
    }
    Seen::Taken
}

#[track_caller]
fn taken(what: &str, built: Result<Transaction, Rejected>, mempool: &[UtxoEntry]) {
    match judge(what, built, mempool) {
        Seen::Taken => println!("taken by the mempool and by a block: {what}"),
        Seen::Refused(e) => panic!("{what}: an honest spend was refused: {e}"),
    }
}

/// Refused at the mempool, by the script of input `by` (0: the pool or the minter itself).
#[track_caller]
fn refused(what: &str, built: Result<Transaction, Rejected>, mempool: &[UtxoEntry], by: usize) {
    match judge(what, built, mempool) {
        Seen::Taken => panic!("{what}: taken, and it should be refused"),
        Seen::Refused(e) => {
            assert!(e.contains(&format!("input {by} ")), "{what}: refused, but not by input {by}: {e}");
            println!("refused by input {by}: {what}");
        }
    }
}

fn classify(error: BuilderError) -> Rejected {
    match error {
        BuilderError::InputScript { .. } | BuilderError::TxScript(_) => Rejected::Script(error.to_string()),
        other => Rejected::Build(other.to_string()),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Coins.

/// A plain P2PK coin of `funding_key` (spent with `funding_sig`) at `daa`.
fn p2pk_coin(daa: u64) -> UtxoEntry {
    UtxoEntry::new(10_000_000_000, p2pk_spk(&funding_key()), daa, false, None)
}

/// A P2SH coin whose script passes only while its coin is still in a node's mempool:
/// `OpTxInputIndex OpTxInputDaaScore OP_1NEGATE OP_NUMEQUAL`. No relative lock anywhere: the design review's shape.
const MEMPOOL_ONLY: [u8; 4] = [0xb9, 0xc0, 0x4f, 0x9c];

fn mempool_only_coin(daa: u64) -> UtxoEntry {
    UtxoEntry::new(10_000_000_000, pay_to_script_hash_script(&MEMPOOL_ONLY), daa, false, None)
}

fn mempool_only_sig() -> Vec<u8> {
    [vec![MEMPOOL_ONLY.len() as u8], MEMPOOL_ONLY.to_vec()].concat()
}

/// An ECDSA P2PK script (33-byte key, OP_CHECKSIGECDSA): a plain coin the covenants do not take.
fn ecdsa_coin(daa: u64) -> UtxoEntry {
    let mut script = vec![0x21];
    script.extend_from_slice(&funding_key().public_key().serialize());
    script.push(0xab);
    UtxoEntry::new(10_000_000_000, ScriptPublicKey::from_vec(0, script), daa, false, None)
}

/// A coin of another covenant, P2SH of OP_TRUE.
fn foreign_coin(daa: u64) -> UtxoEntry {
    UtxoEntry::new(10_000_000_000, pay_to_script_hash_script(&[0x51]), daa, false, Some(Hash::from_bytes([0x33; 32])))
}

// ---------------------------------------------------------------------------------------------------------------
// The pool.

const KAS: i64 = 100_000_000;
const USDT: i64 = 1_000_000;
const BASE: i64 = KAS;
const TOKEN_SOMPI: u64 = 100_000_000;
const MAX_OUT_BPS: i64 = 1_000;
const WINDOW: i64 = 36_000;
const MIN_AGE: i64 = WINDOW / 720;
const BPS: i64 = 10_000;
const FEE_BPS: i64 = 50;
const PROTOCOL_BPS: i64 = 5;
const KUSDT_ID: [u8; 32] = [0x11; 32];
const POOL_ID: [u8; 32] = [0x22; 32];

#[derive(Clone)]
struct Ps {
    x: i64,
    y: i64,
    s: i64,
    pk: i64,
    pt: i64,
    credit: i64,
    rf: i64,
    out: i64,
    paused: bool,
}

fn token_state(owner: [u8; 32], scheme: u8, amount: i64) -> State {
    state! { amount: amount, owner: owner.to_vec(), owner_scheme: scheme, borrow_scheme: 0u8, borrow_guard: vec![0u8; 32], extension_commitment: vec![0u8; 32] }
}
fn reserve_state(amount: i64) -> State {
    token_state(POOL_ID, 0x04, amount)
}
fn pool_state(p: &Ps) -> State {
    state! {
        token_covid: KUSDT_ID.to_vec(), kas_reserve: p.x, token_reserve: p.y, total_shares: p.s,
        protocol_kas: p.pk, protocol_tokens: p.pt, base_value: BASE, admin: xonly(&key(0x30)).to_vec(),
        max_out_bps: MAX_OUT_BPS, window_len: WINDOW, window_credit: p.credit, window_ref: p.rf,
        window_out: p.out, paused: p.paused, guardian: xonly(&key(0x32)).to_vec()
    }
}
fn pool_value(p: &Ps) -> u64 {
    (BASE + p.x + p.pk) as u64
}

fn pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("pool.ag", "test-acceptance-parity-pool").expect("pool compiles"))
}
fn kusdt_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("kusdt.ag", "test-acceptance-parity-kusdt").expect("kUSDT compiles"))
}
fn pool_builder() -> TxBuilder<'static> {
    let bundle = ArtifactBundle::new(pool_artifact()).unwrap().with_artifact(kusdt_artifact()).unwrap();
    TxBuilder::from_bundle(&bundle).expect("bundle builder")
}

/// An opened pool well below half of its cap, whose breaker a tick leaves as it is.
fn opened() -> Ps {
    Ps { x: 10_000 * KAS, y: 1_000 * USDT, s: 10_000 * KAS, pk: 0, pt: 0, credit: 0, rf: 10_000 * KAS, out: 0, paused: false }
}

/// The transaction that made the pool coin and its reserve.
const POOL_PARENT: u8 = 0x40;

/// How an extra input is signed.
#[derive(Clone)]
enum Sig {
    /// `funding_sig`, for a `funding_key` Schnorr P2PK coin.
    Funding,
    /// A valid ECDSA signature by `funding_key`, for `ecdsa_coin`: the coin's own script passes, so only the covenant
    /// can refuse it.
    Ecdsa,
    /// These bytes.
    Fixed(Vec<u8>),
}

/// One extra input of a pool transaction: where it is, the coin, its signature script, its sequence.
#[derive(Clone)]
struct Extra {
    at: TransactionOutpoint,
    coin: UtxoEntry,
    sig: Sig,
    sequence: u64,
}

impl Extra {
    /// A P2PK funding coin made by transaction `parent` (output `index`), at `daa`.
    fn p2pk(parent: u8, index: u32, daa: u64) -> Self {
        Extra { at: outpoint(parent, index), coin: p2pk_coin(daa), sig: Sig::Funding, sequence: 0 }
    }
    fn with_sequence(mut self, sequence: u64) -> Self {
        self.sequence = sequence;
        self
    }
    fn other(at: TransactionOutpoint, coin: UtxoEntry, sig: Vec<u8>) -> Self {
        Extra { at, coin, sig: Sig::Fixed(sig), sequence: 0 }
    }
}

/// The signature script of an `ecdsa_coin` input: a 64-byte ECDSA signature by `funding_key` and its sighash type.
fn ecdsa_sig<'a>() -> InputSigScript<'a> {
    InputSigScript::with_transaction(|tx, index| {
        let hash_type = SigHashType::from_u8(FUNDING_SIG_HASH).expect("a valid sighash type");
        let digest = calc_ecdsa_signature_hash(&tx.as_verifiable(), index, hash_type, &SigHashReusedValuesUnsync::new());
        let signature = Secp256k1::new().sign_ecdsa(&Message::from_digest(digest.as_bytes()), &funding_key().secret_key());
        let mut script = vec![0x41];
        script.extend_from_slice(&signature.serialize_compact());
        script.push(FUNDING_SIG_HASH);
        script
    })
}

/// The pool coin, made by POOL_PARENT, at `daa`.
fn pool_coin(p: &Ps, daa: u64) -> (TransactionOutpoint, UtxoEntry) {
    (outpoint(POOL_PARENT, 0), pool_builder().covenant_utxo("Pool", pool_state(p), pool_value(p), daa, false, Some(Hash::from_bytes(POOL_ID))).unwrap())
}

fn add_extras<'a>(mut ctx: TxContext<'a>, extras: &[Extra]) -> TxContext<'a> {
    for e in extras {
        ctx = match &e.sig {
            Sig::Funding => ctx.input(e.at, e.coin.clone(), funding_sig(), e.sequence),
            Sig::Ecdsa => ctx.input(e.at, e.coin.clone(), ecdsa_sig(), e.sequence),
            Sig::Fixed(sig) => ctx.input(e.at, e.coin.clone(), sig.clone(), e.sequence),
        };
    }
    ctx
}

/// A tick claiming `age` with the pool input's sequence `sequence`, on a pool coin at `pool_daa`, plus `extras`.
fn tick(age: i64, sequence: u64, pool_daa: u64, extras: &[Extra]) -> (Result<Transaction, Rejected>, Vec<UtxoEntry>) {
    let p = opened();
    let (at, coin) = pool_coin(&p, pool_daa);
    let ctx = TxContext::new().actor_input("Pool", pool_state(&p), EntryCall::new("tick").args(args!(age)), at, coin.clone(), sequence);
    let ctx = add_extras(ctx, extras).actor_output("Pool", pool_state(&p), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&p));
    let entries = std::iter::once(coin).chain(extras.iter().map(|e| e.coin.clone())).collect();
    (pool_builder().build(&ctx).map_err(classify), entries)
}

/// The guardian's pause (claims no age), with the pool input's sequence `sequence`, on a pool coin at `pool_daa`.
fn pause(sequence: u64, pool_daa: u64, extras: &[Extra]) -> (Result<Transaction, Rejected>, Vec<UtxoEntry>) {
    let p = opened();
    let (at, coin) = pool_coin(&p, pool_daa);
    let guardian = key(0x32);
    let call = EntryCall::new("pause").args_with(move |tx, i| args!(sign_input(tx, i, &guardian)));
    let next = Ps { paused: true, ..p.clone() };
    let ctx = TxContext::new().actor_input("Pool", pool_state(&p), call, at, coin.clone(), sequence);
    let ctx = add_extras(ctx, extras).actor_output("Pool", pool_state(&next), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next));
    let entries = std::iter::once(coin).chain(extras.iter().map(|e| e.coin.clone())).collect();
    (pool_builder().build(&ctx).map_err(classify), entries)
}

/// A buy of 10 KAS claiming no age, on a pool coin and reserve both made by POOL_PARENT at `pool_daa` (a buy chained
/// on another that is still in the mempool, when that is u64::MAX), plus `extras`.
fn buy(pool_daa: u64, extras: &[Extra]) -> (Result<Transaction, Rejected>, Vec<UtxoEntry>) {
    let p = opened();
    let kas_in = 10 * KAS;
    let effective = kas_in as i128 * (BPS - FEE_BPS) as i128 / BPS as i128;
    let amount = (p.y as i128 * effective / (p.x as i128 + effective)) as i64;
    let cut = kas_in * PROTOCOL_BPS / BPS;
    let next = Ps { x: p.x + kas_in - cut, y: p.y - amount, pk: p.pk + cut, credit: kas_in - cut, out: -(kas_in - cut), ..p.clone() };
    let buyer = token_state(xonly(&key(0xb0)), 0x00, amount);
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out), buyer.clone()];
    let (at, coin) = pool_coin(&p, pool_daa);
    let reserve = pool_builder().covenant_utxo("kusdt::KCC20", reserve_state(p.y + p.pt), TOKEN_SOMPI, pool_daa, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap();
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(&p), EntryCall::new("buy").args(args!(kas_in, 0i64, buyer.clone())), at, coin.clone(), 0)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), outpoint(POOL_PARENT, 1), reserve.clone(), 0);
    let ctx = add_extras(ctx, extras)
        .actor_output("Pool", pool_state(&next), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", buyer, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let entries = [coin, reserve].into_iter().chain(extras.iter().map(|e| e.coin.clone())).collect();
    (pool_builder().build(&ctx).map_err(classify), entries)
}

/// A pool coin already in a block, old enough for any claim here.
const IN_BLOCK: u64 = 1_000;
const UNACCEPTED: u64 = UNACCEPTED_DAA_SCORE;
/// An unrelated transaction still in the mempool.
const STRANGER: u8 = 0x77;

#[test]
fn the_pool_coin_claims_its_age_only_from_a_block_and_exactly() {
    let fund = || vec![Extra::p2pk(0x60, 0, IN_BLOCK)];
    let (b, e) = tick(MIN_AGE, MIN_AGE as u64, IN_BLOCK, &fund());
    taken("a tick claiming its age on a pool coin in a block", b, &e);
    // The hole: the node checks no lock on a coin still in its mempool, and no block takes the claim until the coin
    // is that old. The covenant refuses a positive claim on such a coin.
    let (b, e) = tick(MIN_AGE, MIN_AGE as u64, UNACCEPTED, &fund());
    refused("a tick claiming an age on a pool coin still in the mempool", b, &e, 0);
    // The sequence is exactly the claim: a larger lock than the script uses, or one consensus doesn't check, is refused.
    for (what, sequence) in [
        ("one more than the claim", MIN_AGE as u64 + 1),
        ("the highest lock", u32::MAX as u64),
        ("the claim with the disable bit", SEQUENCE_LOCK_TIME_DISABLED | MIN_AGE as u64),
        ("the claim with bits above the lock", (1 << 40) | MIN_AGE as u64),
        ("u64::MAX", u64::MAX),
    ] {
        let (b, e) = tick(MIN_AGE, sequence, IN_BLOCK, &fund());
        refused(&format!("a tick whose pool input's sequence is {what}"), b, &e, 0);
    }
    // A pool entry that claims no age keeps its input's sequence at 0, wherever the coin is.
    let (b, e) = pause(0, UNACCEPTED, &fund());
    taken("the guardian's pause on a pool coin still in the mempool", b, &e);
    let (b, e) = pause(1, IN_BLOCK, &fund());
    refused("the guardian's pause with a sequence of 1", b, &e, 0);
}

#[test]
fn every_other_input_asks_no_lock() {
    for (what, sequence) in [
        ("1", 1u64),
        ("the highest lock", u32::MAX as u64),
        ("the disable bit and a lock of 5", SEQUENCE_LOCK_TIME_DISABLED | 5),
        ("u64::MAX", u64::MAX),
    ] {
        for (place, daa) in [("in a block", IN_BLOCK), ("in the mempool", UNACCEPTED)] {
            // A sibling of the pool coin when unconfirmed, so that only the sequence is in question.
            let parent = if daa == UNACCEPTED { POOL_PARENT } else { 0x60 };
            let extra = Extra::p2pk(parent, 5, daa).with_sequence(sequence);
            let (b, e) = buy(daa, &[extra]);
            refused(&format!("a buy funded by a coin {place} whose sequence is {what}"), b, &e, 0);
        }
    }
}

#[test]
fn an_unconfirmed_coin_is_taken_only_beside_the_pool_coin() {
    // A buy chained on a buy still in the mempool: the pool coin, the reserve and the change coin all come from it.
    let (b, e) = buy(UNACCEPTED, &[Extra::p2pk(POOL_PARENT, 3, UNACCEPTED)]);
    taken("a buy at no claim, chained, funded by the change of the same parent", b, &e);
    let (b, e) = buy(UNACCEPTED, &[Extra::p2pk(0x60, 0, IN_BLOCK)]);
    taken("a buy at no claim, chained, funded by a coin in a block", b, &e);
    // A coin of another unconfirmed transaction: whatever that one is, no block may ever take it.
    let (b, e) = buy(UNACCEPTED, &[Extra::p2pk(STRANGER, 0, UNACCEPTED)]);
    refused("a buy funded by a coin of an unrelated transaction still in the mempool", b, &e, 0);
    let (b, e) = buy(IN_BLOCK, &[Extra::p2pk(STRANGER, 0, UNACCEPTED)]);
    refused("a buy on a pool coin in a block, funded by an unconfirmed coin", b, &e, 0);
    let (b, e) = tick(MIN_AGE, MIN_AGE as u64, IN_BLOCK, &[Extra::p2pk(STRANGER, 0, UNACCEPTED)]);
    refused("a tick funded by an unconfirmed coin", b, &e, 0);
}

#[test]
fn a_coin_whose_script_reads_its_own_score_parks_nothing() {
    let p2sh = |daa: u64, parent: u8| Extra::other(outpoint(parent, 7), mempool_only_coin(daa), mempool_only_sig());
    // The shape on its own, in a plain transaction: its script passes while its parent is unconfirmed, never in a
    // block. No relative lock is involved, which is why the old covenants' input check could not see it.
    let alone = |daa: u64| {
        let coin = mempool_only_coin(daa);
        let ctx = TxContext::new()
            .input(outpoint(STRANGER, 7), coin.clone(), mempool_only_sig(), 0)
            .output(p2pk_spk(&key(0x61)), None, 9_000_000_000);
        (pool_builder().build(&ctx).map_err(classify), vec![coin])
    };
    let (b, e) = alone(UNACCEPTED);
    let tx = b.expect("the mempool takes the plain transaction");
    common::run(tx.clone(), e).expect("its script passes on an unconfirmed coin");
    assert!(common::run(tx, in_a_block(&[mempool_only_coin(UNACCEPTED)])).is_err(), "and fails once the coin is in a block");
    let (b, _) = alone(IN_BLOCK);
    assert!(b.is_err(), "a block's view refuses it from the start");
    println!("the shape alone: taken by the mempool, refused by every block");

    // Funding a pool spend: refused, whether the coin is unconfirmed, beside the pool coin, or in a block.
    let (b, e) = buy(IN_BLOCK, &[p2sh(UNACCEPTED, STRANGER)]);
    refused("a buy funded by that coin, unconfirmed", b, &e, 0);
    let (b, e) = buy(UNACCEPTED, &[p2sh(UNACCEPTED, POOL_PARENT)]);
    refused("a chained buy funded by that coin, made beside the pool coin", b, &e, 0);
    let (b, e) = tick(MIN_AGE, MIN_AGE as u64, IN_BLOCK, &[p2sh(IN_BLOCK, 0x60)]);
    refused("a tick funded by a P2SH coin in a block (not a plain coin)", b, &e, 0);
}

#[test]
fn only_plain_schnorr_coins_and_the_two_families_join() {
    let (b, e) = tick(MIN_AGE, MIN_AGE as u64, IN_BLOCK, &[Extra::other(outpoint(0x60, 1), ecdsa_coin(IN_BLOCK), vec![0x00])]);
    refused("a tick funded by an ECDSA P2PK coin", b, &e, 0);
    let (b, e) = tick(MIN_AGE, MIN_AGE as u64, IN_BLOCK, &[Extra::other(outpoint(0x60, 2), foreign_coin(IN_BLOCK), vec![0x01, 0x51])]);
    refused("a tick with a coin of another covenant", b, &e, 0);
    // The reserve is a coin of the kUSDT family beside the pool coin (`buy` above): taken.
    let (b, e) = buy(IN_BLOCK, &[Extra::p2pk(0x60, 0, IN_BLOCK)]);
    taken("a buy whose reserve is a family coin", b, &e);
}

#[test]
fn at_most_eight_inputs() {
    let coins = |n: u32| (0..n).map(|i| Extra::p2pk(0x60, i, IN_BLOCK)).collect::<Vec<_>>();
    let (b, e) = tick(MIN_AGE, MIN_AGE as u64, IN_BLOCK, &coins(MAX_TX_INPUTS as u32 - 1));
    taken("a tick with eight inputs", b, &e);
    let (b, e) = tick(MIN_AGE, MIN_AGE as u64, IN_BLOCK, &coins(MAX_TX_INPUTS as u32));
    refused("a tick with nine inputs", b, &e, 0);
}

/// An exhaustive grid of the shapes this file's inputs can take (120: three coin kinds, three places, four sequences,
/// two places of the pool coin), on the tick (claims an age) and the buy (claims none): whatever the mempool takes, a
/// block takes. The other entries are run by the tests further down.
#[test]
fn whatever_the_mempool_takes_a_block_takes() {
    let kinds: Vec<(&str, Box<dyn Fn(u8, u64) -> Extra>)> = vec![
        ("a P2PK coin", Box::new(|parent, daa| Extra::p2pk(parent, 9, daa))),
        ("the mempool-only P2SH coin", Box::new(|parent, daa| Extra::other(outpoint(parent, 9), mempool_only_coin(daa), mempool_only_sig()))),
        ("a coin of another covenant", Box::new(|parent, daa| Extra::other(outpoint(parent, 9), foreign_coin(daa), vec![0x01, 0x51]))),
    ];
    let (mut taken_n, mut refused_n) = (0, 0);
    for (kind, make) in &kinds {
        for (place, parent, daa) in [("in a block", 0x60u8, IN_BLOCK), ("beside the pool coin", POOL_PARENT, UNACCEPTED), ("unconfirmed elsewhere", STRANGER, UNACCEPTED)] {
            for sequence in [0u64, 1, SEQUENCE_LOCK_TIME_DISABLED, u64::MAX] {
                for pool_daa in [IN_BLOCK, UNACCEPTED] {
                    // Beside the pool coin means the pool coin is unconfirmed too.
                    if parent == POOL_PARENT && pool_daa != UNACCEPTED {
                        continue;
                    }
                    let extra = make(parent, daa).with_sequence(sequence);
                    let what = format!("{kind} {place}, sequence {sequence:#x}, pool coin at {pool_daa:#x}");
                    for (entry, (b, e)) in [("tick", tick(MIN_AGE, MIN_AGE as u64, pool_daa, std::slice::from_ref(&extra))), ("buy", buy(pool_daa, std::slice::from_ref(&extra)))] {
                        match judge(&format!("{entry}: {what}"), b, &e) {
                            Seen::Taken => taken_n += 1,
                            Seen::Refused(_) => refused_n += 1,
                        }
                    }
                }
            }
        }
    }
    println!("{} shapes: {taken_n} taken by the mempool and by a block, {refused_n} refused at the mempool, none parked", taken_n + refused_n);
    // A P2PK coin with sequence 0: in a block, the tick and the buy on a pool coin in a block and the buy chained on an
    // unconfirmed one; beside an unconfirmed pool coin, the buy (a tick claims an age, so it needs the pool coin in a block).
    assert_eq!(taken_n, 4, "only the plain coin with no lock, in a block or beside the pool coin, joins");
}

// ---------------------------------------------------------------------------------------------------------------
// The minter.

fn one() -> Vec<Recipient> {
    vec![Recipient::schnorr(&key(0xa1), 1_000_000)]
}

#[test]
fn the_minter_coin_claims_its_age_only_from_a_block() {
    let h = Harness::launch();
    let fund = |at: TransactionOutpoint, daa: u64| (at, p2pk_coin(daa));
    let mint = |h: &Harness, age: i64, funding: (TransactionOutpoint, UtxoEntry)| {
        let entries = vec![h.minter.utxo.clone(), funding.1.clone()];
        (h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &one()).age(age).funded_by(funding.0, funding.1)).map(|(tx, _)| tx), entries)
    };
    let (b, e) = mint(&h, 1, fund(outpoint(0x60, 0), IN_BLOCK));
    taken("a mint claiming an age on a minter coin in a block", b, &e);

    let mut unconfirmed = Harness::launch();
    unconfirmed.minter.utxo.block_daa_score = UNACCEPTED;
    let (b, e) = mint(&unconfirmed, 1, fund(outpoint(0x60, 0), IN_BLOCK));
    refused("a mint claiming an age on a minter coin still in the mempool", b, &e, 0);
    let (b, e) = mint(&unconfirmed, 0, fund(outpoint(0x60, 0), IN_BLOCK));
    taken("a mint claiming no age, chained on an unconfirmed minter coin", b, &e);
    let sibling = TransactionOutpoint::new(unconfirmed.minter.outpoint.transaction_id, 9);
    let (b, e) = mint(&unconfirmed, 0, fund(sibling, UNACCEPTED));
    taken("a chained mint funded by a coin of the minter coin's own transaction", b, &e);
    // A copy of a signed mint, funded from an unrelated unconfirmed transaction: anyone can send one.
    let (b, e) = mint(&unconfirmed, 0, fund(outpoint(STRANGER, 0), UNACCEPTED));
    refused("a copied mint funded by an unconfirmed coin of another transaction", b, &e, 0);
    let (b, e) = mint(&h, 1, fund(outpoint(STRANGER, 0), UNACCEPTED));
    refused("a mint on a minter coin in a block, funded by an unconfirmed coin", b, &e, 0);
}

#[test]
fn a_recovery_waits_exactly_its_delay_on_a_coin_in_a_block() {
    let pending = || {
        Harness::launch_with(|s| {
            s.recovery_pending = true;
            s.recovery_signer_set = [3; 32];
            s.recovery_delay = 1_000;
        })
    };
    let h = pending();
    let entries = |h: &Harness| vec![h.minter.utxo.clone(), common::funding()];
    taken("execute_recovery with the delay as the sequence", h.try_execute_recovery(1_000, |_| {}).map(|(tx, _)| tx), &entries(&h));
    refused("execute_recovery with a lock longer than the delay", h.try_execute_recovery(1_001, |_| {}).map(|(tx, _)| tx), &entries(&h), 0);
    let mut unconfirmed = pending();
    unconfirmed.minter.utxo.block_daa_score = UNACCEPTED;
    refused("execute_recovery on a minter coin still in the mempool", unconfirmed.try_execute_recovery(1_000, |_| {}).map(|(tx, _)| tx), &entries(&unconfirmed), 0);
    // The node holds it back until the coin is old enough: a block's view at a score one short refuses it.
    let tx = h.try_execute_recovery(1_000, |_| {}).expect("built").0;
    let coin = h.minter.utxo.block_daa_score;
    assert!(node_locks(&tx, &entries(&h), coin + 1_000 - 1).is_err(), "one DAA short of the delay");
    node_locks(&tx, &entries(&h), coin + 1_000).expect("at the delay");
}

#[test]
fn the_minter_pause_asks_no_lock() {
    let h = Harness::launch();
    taken("the guardian's pause", h.try_pause(&h.guardian).map(|(tx, _)| tx), &[h.minter.utxo.clone()]);
}

// ---------------------------------------------------------------------------------------------------------------
// Every entry (round 17, R17-COV-1). The tests above run tick, pause and buy on the pool and mint, pause and
// execute_recovery on the minter; a later edit that dropped or weakened `require_settled_inputs` in any other entry
// left the suite green. Below, every Pool and BridgeMint entry is built through the same shapes.

const POSITION_SOMPI: u64 = 50_000_000;
const MIN_LIQUIDITY: i64 = 1_000;
/// The recovery delay of the minter `execute_recovery` runs on here.
const DELAY: i64 = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Entry {
    Init,
    Buy,
    Sell,
    SellAll,
    Add,
    Remove,
    RemovePaused,
    Tick,
    Collect,
    Pause,
    Unpause,
    SetKeys,
    Mint,
    MinterPause,
    GovernUnpause,
    GovernSetLimits,
    GovernPropose,
    GovernVeto,
    ExecuteRecovery,
}

const ENTRIES: [Entry; 19] = [
    Entry::Init,
    Entry::Buy,
    Entry::Sell,
    Entry::SellAll,
    Entry::Add,
    Entry::Remove,
    Entry::RemovePaused,
    Entry::Tick,
    Entry::Collect,
    Entry::Pause,
    Entry::Unpause,
    Entry::SetKeys,
    Entry::Mint,
    Entry::MinterPause,
    Entry::GovernUnpause,
    Entry::GovernSetLimits,
    Entry::GovernPropose,
    Entry::GovernVeto,
    Entry::ExecuteRecovery,
];

impl Entry {
    fn name(self) -> &'static str {
        match self {
            Entry::Init => "pool init",
            Entry::Buy => "pool buy",
            Entry::Sell => "pool sell",
            Entry::SellAll => "pool sell_all",
            Entry::Add => "pool add",
            Entry::Remove => "pool remove",
            Entry::RemovePaused => "pool remove while paused",
            Entry::Tick => "pool tick",
            Entry::Collect => "pool collect",
            Entry::Pause => "pool pause",
            Entry::Unpause => "pool unpause",
            Entry::SetKeys => "pool set_keys",
            Entry::Mint => "minter mint",
            Entry::MinterPause => "minter pause",
            Entry::GovernUnpause => "minter govern unpause",
            Entry::GovernSetLimits => "minter govern set_limits",
            Entry::GovernPropose => "minter govern propose_recovery",
            Entry::GovernVeto => "minter govern veto_recovery",
            Entry::ExecuteRecovery => "minter execute_recovery",
        }
    }

    /// The ages it may claim on the state it is run on here: none for the admin's, the guardian's and a paused
    /// withdrawal; at least the minimum for a tick; exactly the delay for a recovery; 0 or the minimum otherwise.
    fn claims(self) -> &'static [i64] {
        match self {
            Entry::Init | Entry::Collect | Entry::Pause | Entry::Unpause | Entry::SetKeys | Entry::RemovePaused | Entry::MinterPause => &[0],
            Entry::Tick => &[MIN_AGE],
            Entry::ExecuteRecovery => &[DELAY],
            _ => &[0, MIN_AGE],
        }
    }

    /// The covenant coins its transaction spends: the pool or the minter, the reserve, the user's kUSDT or position.
    fn own_inputs(self) -> usize {
        match self {
            Entry::Init | Entry::Buy | Entry::Collect => 2,
            Entry::Sell | Entry::SellAll | Entry::Add | Entry::Remove | Entry::RemovePaused => 3,
            _ => 1,
        }
    }

    /// It spends a kUSDT state or a position of the user's, which may be anywhere.
    fn user_coin(self) -> bool {
        matches!(self, Entry::Init | Entry::Sell | Entry::SellAll | Entry::Add | Entry::Remove | Entry::RemovePaused)
    }

    fn minter(self) -> bool {
        matches!(
            self,
            Entry::Mint | Entry::MinterPause | Entry::GovernUnpause | Entry::GovernSetLimits | Entry::GovernPropose | Entry::GovernVeto | Entry::ExecuteRecovery
        )
    }
}

/// A coin's kind, as `require_settled_inputs` sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// A plain Schnorr P2PK coin: the one plain kind taken.
    P2pk,
    /// The P2SH coin whose script passes only while its parent is unconfirmed.
    MempoolOnly,
    /// An ECDSA P2PK coin, validly signed.
    Ecdsa,
    /// A P2SH coin of OP_TRUE, of no covenant.
    P2sh,
    /// A coin of another covenant.
    Foreign,
}

/// Where a coin is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place {
    InBlock,
    /// An output of the transaction that made the pool's or the minter's coin (in a block when that coin is).
    Beside,
    /// An output of an unrelated transaction still in the mempool.
    Elsewhere,
}

/// One input of a transaction besides the entry's own coins.
#[derive(Clone, Copy, Debug)]
struct Shape {
    kind: Kind,
    place: Place,
    sequence: u64,
}

impl Shape {
    fn of(kind: Kind, place: Place, sequence: u64) -> Self {
        Shape { kind, place, sequence }
    }
    /// A plain coin in a block that asks no lock: what an honest wallet funds with.
    fn honest() -> Self {
        Shape::of(Kind::P2pk, Place::InBlock, 0)
    }
    /// What the rule says of it: a plain Schnorr coin asking no lock, in a block or made beside the covenant coin.
    fn allowed(&self) -> bool {
        self.kind == Kind::P2pk && self.sequence == 0 && self.place != Place::Elsewhere
    }
    /// The input, numbered `n` in its transaction, for a covenant coin made by `parent` (still in the mempool when
    /// `unconfirmed`).
    fn extra(&self, n: u32, parent: TransactionId, unconfirmed: bool) -> Extra {
        let (at, daa) = match self.place {
            Place::InBlock => (outpoint(0x60, 100 + n), IN_BLOCK),
            Place::Beside => (TransactionOutpoint::new(parent, 100 + n), if unconfirmed { UNACCEPTED } else { IN_BLOCK }),
            Place::Elsewhere => (outpoint(STRANGER, 100 + n), UNACCEPTED),
        };
        let (coin, sig) = match self.kind {
            Kind::P2pk => (p2pk_coin(daa), Sig::Funding),
            Kind::MempoolOnly => (mempool_only_coin(daa), Sig::Fixed(mempool_only_sig())),
            Kind::Ecdsa => (ecdsa_coin(daa), Sig::Ecdsa),
            Kind::P2sh => (UtxoEntry::new(10_000_000_000, pay_to_script_hash_script(&[0x51]), daa, false, None), Sig::Fixed(vec![0x01, 0x51])),
            Kind::Foreign => (foreign_coin(daa), Sig::Fixed(vec![0x01, 0x51])),
        };
        Extra { at, coin, sig, sequence: self.sequence }
    }
}

/// One spend of an entry.
#[derive(Clone, Debug)]
struct Spend {
    entry: Entry,
    /// The age it claims.
    age: i64,
    /// Its own input's sequence: the claim, unless bent.
    sequence: u64,
    /// The pool's or the minter's coin (and the reserve, made with it) is still in the mempool.
    unconfirmed: bool,
    /// Where the user's kUSDT state or position is, for the entries that spend one.
    user: Place,
    /// Inputs before the entry's own: its own input is then at index `lead.len()`.
    lead: Vec<Shape>,
    /// Inputs after the entry's own.
    extras: Vec<Shape>,
}

impl Spend {
    /// The honest spend: claiming `age` on a coin in a block, its own input first, funded by one plain coin in a block.
    fn new(entry: Entry, age: i64) -> Self {
        Spend { entry, age, sequence: age as u64, unconfirmed: false, user: Place::InBlock, lead: vec![], extras: vec![Shape::honest()] }
    }
    fn unconfirmed(mut self) -> Self {
        self.unconfirmed = true;
        self
    }
    fn sequence(mut self, sequence: u64) -> Self {
        self.sequence = sequence;
        self
    }
    fn user(mut self, place: Place) -> Self {
        self.user = place;
        self
    }
    fn lead(mut self, shapes: Vec<Shape>) -> Self {
        self.lead = shapes;
        self
    }
    fn extras(mut self, shapes: Vec<Shape>) -> Self {
        self.extras = shapes;
        self
    }
    fn with(mut self, shape: Shape) -> Self {
        self.extras.push(shape);
        self
    }
    fn inputs(&self) -> usize {
        self.lead.len() + self.entry.own_inputs() + self.extras.len()
    }
    /// The entry's own input.
    fn active(&self) -> usize {
        self.lead.len()
    }
    /// What `require_settled_inputs` says of it: at most 8 inputs; its own input's sequence exactly the claim, and a
    /// positive claim only on a coin in a block; every other coin of the user's in a block or beside the covenant
    /// coin; every other input an allowed shape.
    fn allowed(&self) -> bool {
        self.inputs() <= MAX_TX_INPUTS
            && self.sequence == self.age as u64
            && (self.age == 0 || !self.unconfirmed)
            && (!self.entry.user_coin() || self.user != Place::Elsewhere)
            && self.lead.iter().chain(&self.extras).all(Shape::allowed)
    }
    fn what(&self) -> String {
        format!(
            "{} claiming {}, own sequence {:#x} at input {}, own coin {}, user's coin {:?}, {} inputs, before {:?}, after {:?}",
            self.entry.name(),
            self.age,
            self.sequence,
            self.active(),
            if self.unconfirmed { "in the mempool" } else { "in a block" },
            self.user,
            self.inputs(),
            self.lead,
            self.extras
        )
    }
    /// The inputs before and after the entry's own, for a covenant coin made by `parent`.
    fn resolve(&self, parent: TransactionId) -> (Vec<Extra>, Vec<Extra>) {
        let make = |shapes: &[Shape], from: u32| -> Vec<Extra> { shapes.iter().enumerate().map(|(n, x)| x.extra(from + n as u32, parent, self.unconfirmed)).collect() };
        (make(&self.lead, 0), make(&self.extras, 50))
    }
    /// The transaction, built with the coins as a node's mempool shows them, and those coins.
    fn build(&self) -> (Result<Transaction, Rejected>, Vec<UtxoEntry>) {
        if self.entry.minter() { minter_spend(self) } else { pool_spend(self) }
    }
}

fn position_state(shares: i64, owner: &Keypair) -> State {
    state! { token_covid: KUSDT_ID.to_vec(), shares: shares, owner: xonly(owner).to_vec() }
}

fn pool_spend(s: &Spend) -> (Result<Transaction, Rejected>, Vec<UtxoEntry>) {
    let daa = if s.unconfirmed { UNACCEPTED } else { IN_BLOCK };
    let (lead, extras) = s.resolve(outpoint(POOL_PARENT, 0).transaction_id);
    let p = match s.entry {
        Entry::Init => Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false },
        Entry::Unpause | Entry::RemovePaused => Ps { paused: true, ..opened() },
        Entry::Collect => Ps { pk: KAS, pt: USDT, ..opened() },
        _ => opened(),
    };
    let (at, coin) = pool_coin(&p, daa);
    let reserve_at = outpoint(POOL_PARENT, 1);
    let reserve = pool_builder().covenant_utxo("kusdt::KCC20", reserve_state(p.y + p.pt), TOKEN_SOMPI, daa, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap();
    let (user_at, user_daa) = match s.user {
        Place::InBlock => (outpoint(0x50, 0), IN_BLOCK),
        Place::Beside => (outpoint(POOL_PARENT, 2), daa),
        Place::Elsewhere => (outpoint(STRANGER, 2), UNACCEPTED),
    };
    let user_token = |owner: &Keypair, amount: i64| {
        pool_builder().covenant_utxo("kusdt::KCC20", token_state(xonly(owner), 0x00, amount), TOKEN_SOMPI, user_daa, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap()
    };
    let k = s.active() as u16;
    let pool_bind = CovenantBinding::new(k, Hash::from_bytes(POOL_ID));
    let token_bind = |by: u16| CovenantBinding::new(k + by, Hash::from_bytes(KUSDT_ID));
    let reserve_call = |next: Vec<State>| EntryCall::new("transfer").args(args!(next, vec![0x00u8]));
    let (age, sequence, admin) = (s.age, s.sequence, key(0x30));
    let mut own = vec![coin.clone()];
    let ctx = add_extras(TxContext::new(), &lead);
    let ctx = match s.entry {
        Entry::Init => {
            let provider = key(0xa1);
            let (held, tokens_in, kas_in) = (5 * USDT, USDT, 10 * KAS);
            let change = token_state(xonly(&provider), 0x00, held - tokens_in);
            let next = Ps { x: kas_in, y: tokens_in, s: kas_in, rf: kas_in, ..p.clone() };
            let next_states = vec![reserve_state(tokens_in), change.clone()];
            let user = user_token(&provider, held);
            own.push(user.clone());
            let (owner, change_arg) = (xonly(&provider).to_vec(), change.clone());
            let init = EntryCall::new("init").args_with(move |tx, i| args!(kas_in, owner.clone(), change_arg.clone(), sign_input(tx, i, &admin)));
            let transfer = EntryCall::new("transfer").args_with(move |tx, i| {
                let mut witness = vec![0x00];
                witness.extend(sign_input(tx, i, &provider));
                args!(next_states.clone(), witness)
            });
            ctx.actor_input("Pool", pool_state(&p), init, at, coin.clone(), sequence)
                .actor_input("kusdt::KCC20", token_state(xonly(&provider), 0x00, held), transfer, user_at, user, 0)
                .actor_output("Pool", pool_state(&next), pool_bind, pool_value(&next))
                .actor_output("Position", position_state(kas_in - MIN_LIQUIDITY, &provider), pool_bind, POSITION_SOMPI)
                .actor_output("kusdt::KCC20", reserve_state(tokens_in), token_bind(1), TOKEN_SOMPI)
                .actor_output("kusdt::KCC20", change, token_bind(1), TOKEN_SOMPI)
        }
        Entry::Buy => {
            let kas_in = 10 * KAS;
            let effective = kas_in as i128 * (BPS - FEE_BPS) as i128 / BPS as i128;
            let amount = (p.y as i128 * effective / (p.x as i128 + effective)) as i64;
            let cut = kas_in * PROTOCOL_BPS / BPS;
            // On `opened`, whose reference is its reserve and whose count is 0, any claim leaves the same successor.
            let next = Ps { x: p.x + kas_in - cut, y: p.y - amount, pk: p.pk + cut, credit: kas_in - cut, out: -(kas_in - cut), ..p.clone() };
            let buyer = token_state(xonly(&key(0xb0)), 0x00, amount);
            let reserve_out = next.y + next.pt;
            own.push(reserve.clone());
            ctx.actor_input("Pool", pool_state(&p), EntryCall::new("buy").args(args!(kas_in, age, buyer.clone())), at, coin.clone(), sequence)
                .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), reserve_call(vec![reserve_state(reserve_out), buyer.clone()]), reserve_at, reserve.clone(), 0)
                .actor_output("Pool", pool_state(&next), pool_bind, pool_value(&next))
                .actor_output("kusdt::KCC20", reserve_state(reserve_out), token_bind(1), TOKEN_SOMPI)
                .actor_output("kusdt::KCC20", buyer, token_bind(1), TOKEN_SOMPI)
        }
        Entry::Sell | Entry::SellAll => {
            let seller = key(0xc0);
            let all = s.entry == Entry::SellAll;
            let tokens_in = 10 * USDT;
            let held = if all { tokens_in } else { 2 * tokens_in };
            let cut = tokens_in * PROTOCOL_BPS / BPS;
            let effective = tokens_in as i128 * (BPS - FEE_BPS) as i128 / BPS as i128;
            let kas_out = (p.x as i128 * effective / (p.y as i128 + effective)) as i64;
            // Well inside the cap; the reference follows the reserve down.
            let next = Ps { x: p.x - kas_out, y: p.y + tokens_in - cut, pt: p.pt + cut, rf: p.x - kas_out, out: kas_out, credit: 0, ..p.clone() };
            let reserve_out = next.y + next.pt;
            let change = token_state(xonly(&seller), 0x00, held - tokens_in);
            let (call, next_states) = if all {
                (EntryCall::new("sell_all").args(args!(kas_out, age)), vec![reserve_state(reserve_out)])
            } else {
                (EntryCall::new("sell").args(args!(kas_out, age, change.clone())), vec![reserve_state(reserve_out), change.clone()])
            };
            let user = user_token(&seller, held);
            own.push(reserve.clone());
            own.push(user.clone());
            let ctx = ctx
                .actor_input("Pool", pool_state(&p), call, at, coin.clone(), sequence)
                .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), reserve_call(next_states), reserve_at, reserve.clone(), 0)
                .actor_input("kusdt::KCC20", token_state(xonly(&seller), 0x00, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &seller))), user_at, user, 0)
                .actor_output("Pool", pool_state(&next), pool_bind, pool_value(&next))
                .actor_output("kusdt::KCC20", reserve_state(reserve_out), token_bind(1), TOKEN_SOMPI);
            if all { ctx } else { ctx.actor_output("kusdt::KCC20", change, token_bind(1), TOKEN_SOMPI) }
        }
        Entry::Add => {
            let provider = key(0xd0);
            // 10 KAS and 1 kUSDT at the pool's ratio of 10 000 KAS to 1 000 kUSDT, with as many shares as KAS.
            let (held, tokens_in, kas_in) = (5 * USDT, USDT, 10 * KAS);
            let shares = kas_in;
            let change = token_state(xonly(&provider), 0x00, held - tokens_in);
            let next = Ps { x: p.x + kas_in, y: p.y + tokens_in, s: p.s + shares, ..p.clone() };
            let reserve_out = next.y + next.pt;
            let user = user_token(&provider, held);
            own.push(reserve.clone());
            own.push(user.clone());
            let call = EntryCall::new("add").args(args!(kas_in, shares, age, xonly(&provider).to_vec(), change.clone(), Vec::<u8>::new()));
            ctx.actor_input("Pool", pool_state(&p), call, at, coin.clone(), sequence)
                .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), reserve_call(vec![reserve_state(reserve_out), change.clone()]), reserve_at, reserve.clone(), 0)
                .actor_input("kusdt::KCC20", token_state(xonly(&provider), 0x00, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &provider))), user_at, user, 0)
                .actor_output("Pool", pool_state(&next), pool_bind, pool_value(&next))
                .actor_output("Position", position_state(shares, &provider), pool_bind, POSITION_SOMPI)
                .actor_output("kusdt::KCC20", reserve_state(reserve_out), token_bind(1), TOKEN_SOMPI)
                .actor_output("kusdt::KCC20", change, token_bind(1), TOKEN_SOMPI)
        }
        Entry::Remove | Entry::RemovePaused => {
            let owner = key(0xd1);
            let shares = 10 * KAS;
            let kas_out = (shares as i128 * p.x as i128 / p.s as i128) as i64;
            let tokens_out = (shares as i128 * p.y as i128 / p.s as i128) as i64;
            // Paused or not, nothing is settled on `opened`, and the reference follows the reserve down.
            let next = Ps { x: p.x - kas_out, y: p.y - tokens_out, s: p.s - shares, rf: p.x - kas_out, ..p.clone() };
            let receiver = token_state(xonly(&owner), 0x00, tokens_out);
            let reserve_out = next.y + next.pt;
            let position = pool_builder().covenant_utxo("Position", position_state(shares, &owner), POSITION_SOMPI, user_daa, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
            own.push(position.clone());
            own.push(reserve.clone());
            ctx.actor_input("Pool", pool_state(&p), EntryCall::new("remove").args(args!(kas_out, age, receiver.clone())), at, coin.clone(), sequence)
                .actor_input("Position", position_state(shares, &owner), EntryCall::new("redeem").args_with(move |tx, i| args!(sign_input(tx, i, &owner))), user_at, position, 0)
                .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), reserve_call(vec![reserve_state(reserve_out), receiver.clone()]), reserve_at, reserve.clone(), 0)
                .actor_output("Pool", pool_state(&next), pool_bind, pool_value(&next))
                .actor_output("kusdt::KCC20", reserve_state(reserve_out), token_bind(2), TOKEN_SOMPI)
                .actor_output("kusdt::KCC20", receiver, token_bind(2), TOKEN_SOMPI)
        }
        Entry::Tick => ctx
            .actor_input("Pool", pool_state(&p), EntryCall::new("tick").args(args!(age)), at, coin.clone(), sequence)
            .actor_output("Pool", pool_state(&p), pool_bind, pool_value(&p)),
        Entry::Collect => {
            let fee_state = token_state(xonly(&admin), 0x00, p.pt);
            let next = Ps { pk: 0, pt: 0, ..p.clone() };
            own.push(reserve.clone());
            let fee_arg = fee_state.clone();
            let call = EntryCall::new("collect").args_with(move |tx, i| args!(sign_input(tx, i, &admin), fee_arg.clone()));
            ctx.actor_input("Pool", pool_state(&p), call, at, coin.clone(), sequence)
                .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), reserve_call(vec![reserve_state(p.y), fee_state.clone()]), reserve_at, reserve.clone(), 0)
                .actor_output("Pool", pool_state(&next), pool_bind, pool_value(&next))
                .actor_output("kusdt::KCC20", reserve_state(p.y), token_bind(1), TOKEN_SOMPI)
                .actor_output("kusdt::KCC20", fee_state, token_bind(1), TOKEN_SOMPI)
        }
        Entry::Pause | Entry::Unpause | Entry::SetKeys => {
            let (signer, next) = match s.entry {
                Entry::Pause => (key(0x32), Ps { paused: true, ..p.clone() }),
                Entry::Unpause => (admin, Ps { paused: false, ..p.clone() }),
                _ => (admin, p.clone()),
            };
            let call = if s.entry == Entry::SetKeys {
                let (new_admin, new_guardian) = (xonly(&key(0x30)).to_vec(), xonly(&key(0x32)).to_vec());
                EntryCall::new("set_keys").args_with(move |tx, i| args!(new_admin.clone(), new_guardian.clone(), sign_input(tx, i, &signer)))
            } else {
                EntryCall::new(if s.entry == Entry::Pause { "pause" } else { "unpause" }).args_with(move |tx, i| args!(sign_input(tx, i, &signer)))
            };
            ctx.actor_input("Pool", pool_state(&p), call, at, coin.clone(), sequence)
                .actor_output("Pool", pool_state(&next), pool_bind, pool_value(&next))
        }
        _ => unreachable!("a minter entry"),
    };
    let ctx = add_extras(ctx, &extras);
    let entries = lead.iter().map(|e| e.coin.clone()).chain(own).chain(extras.iter().map(|e| e.coin.clone())).collect();
    (pool_builder().build(&ctx).map_err(classify), entries)
}

/// The minter each minter entry runs on: paused for an unpause, with a recovery pending for a veto or a recovery,
/// running otherwise.
fn minter_for(entry: Entry) -> Harness {
    match entry {
        Entry::GovernUnpause => Harness::launch_with(|s| s.paused = true),
        Entry::GovernVeto => Harness::launch_with(|s| {
            s.recovery_pending = true;
            s.recovery_signer_set = [3; 32];
        }),
        Entry::ExecuteRecovery => Harness::launch_with(|s| {
            s.recovery_pending = true;
            s.recovery_signer_set = [3; 32];
            s.recovery_delay = DELAY;
        }),
        _ => Harness::launch(),
    }
}

/// The first `q` signers' signatures over `digest`, with the five keys.
fn quorum(h: &Harness, digest: &[u8; 32], q: usize) -> (ArtifactValue, Vec<u8>, ArtifactValue) {
    (
        ArtifactValue::Array(h.signers.iter().map(|k| ArtifactValue::Bytes(xonly(k).to_vec())).collect()),
        (0..q as u8).collect(),
        ArtifactValue::Array((0..q).map(|i| ArtifactValue::Bytes(sign_digest(&h.signers[i], digest))).collect()),
    )
}

fn minter_spend(s: &Spend) -> (Result<Transaction, Rejected>, Vec<UtxoEntry>) {
    let h = minter_for(s.entry);
    let mut coin = h.minter.utxo.clone();
    coin.block_daa_score = if s.unconfirmed { UNACCEPTED } else { IN_BLOCK };
    let (lead, extras) = s.resolve(h.minter.outpoint.transaction_id);
    let covenant = h.minter.covenant_id;
    let id = covenant.as_bytes();
    let age = s.age;
    let mut next: MinterState = h.state.clone();
    let settled = common::refilled(h.state.bucket, age, h.state.capacity, h.state.refill_per_daa);
    let mut minted: Vec<State> = vec![];
    let call = match s.entry {
        Entry::Mint => {
            let recipients = one();
            next.remaining -= 1_000_000;
            next.bucket = settled - 1_000_000;
            next.nonce_ethereum += 1;
            let digest = common::mint_digest(&id, CHAIN_ETHEREUM, h.state.nonce_ethereum, age, &recipients);
            let (keys, indices, signatures) = quorum(&h, &digest, 3);
            minted = recipients.iter().map(Recipient::state).collect();
            EntryCall::new("mint").args(args!(CHAIN_ETHEREUM, h.state.nonce_ethereum, age, minted.clone(), keys, indices, signatures))
        }
        Entry::MinterPause => {
            next.paused = true;
            next.admin_nonce += 1;
            let guardian = h.guardian;
            EntryCall::new("pause").args_with(move |tx, i| args!(sign_input(tx, i, &guardian)))
        }
        Entry::ExecuteRecovery => {
            next.signer_set = h.state.recovery_signer_set;
            next.guardian = h.state.recovery_guardian;
            next.admin_nonce += 1;
            next.recovery_nonce += 1;
            next.recovery_pending = false;
            next.recovery_signer_set = [0; 32];
            next.recovery_guardian = [0; 32];
            EntryCall::new("execute_recovery")
        }
        _ => {
            next.bucket = settled;
            let (code, params, q, nonce) = match s.entry {
                Entry::GovernUnpause => {
                    next.paused = false;
                    next.admin_nonce += 1;
                    (0x01u8, vec![], 4, h.state.admin_nonce)
                }
                Entry::GovernSetLimits => {
                    let (capacity, refill) = (400_000_000_000i64, 1i64);
                    next.bucket = next.bucket.min(capacity);
                    next.capacity = capacity;
                    next.refill_per_daa = refill;
                    next.admin_nonce += 1;
                    (0x02, [capacity.to_le_bytes(), refill.to_le_bytes()].concat(), 4, h.state.admin_nonce)
                }
                Entry::GovernPropose => {
                    next.recovery_nonce += 1;
                    next.recovery_pending = true;
                    next.recovery_signer_set = [5; 32];
                    next.recovery_guardian = [6; 32];
                    (0x06, [[5u8; 32], [6u8; 32]].concat(), 3, h.state.recovery_nonce)
                }
                Entry::GovernVeto => {
                    next.recovery_nonce += 1;
                    next.recovery_pending = false;
                    next.recovery_signer_set = [0; 32];
                    next.recovery_guardian = [0; 32];
                    (0x07, vec![], 1, h.state.recovery_nonce)
                }
                _ => unreachable!("a pool entry"),
            };
            let digest = if code == 0x01 { common::unpause_digest(&id, nonce, age, &h.minter.outpoint) } else { common::govern_digest(&id, nonce, age, code, &params) };
            let (keys, indices, signatures) = quorum(&h, &digest, q);
            EntryCall::new("govern").args(args!(code, params, age, keys, indices, signatures))
        }
    };
    let bind = CovenantBinding::new(s.active() as u16, covenant);
    let mut ctx = add_extras(TxContext::new(), &lead)
        .actor_input("BridgeMint", h.state.state(), call, h.minter.outpoint, coin.clone(), s.sequence)
        .actor_output("BridgeMint", next.state(), bind, h.minter.utxo.amount);
    for m in minted {
        ctx = ctx.actor_output("KCC20", m, bind, TOKEN_SOMPI);
    }
    let ctx = add_extras(ctx, &extras);
    let entries = lead.iter().map(|e| e.coin.clone()).chain(std::iter::once(coin)).chain(extras.iter().map(|e| e.coin.clone())).collect();
    (common::builder().build(&ctx).map_err(classify), entries)
}

/// Builds `s`, judges it in both views (a parked spend panics), and holds it to what the rule says of it; a refusal
/// must come from the entry's own input when `own` (the shapes that are refused are then after it).
#[track_caller]
fn expect(s: &Spend, own: bool) -> bool {
    let what = s.what();
    let (b, e) = s.build();
    match (judge(&what, b, &e), s.allowed()) {
        (Seen::Taken, true) => true,
        (Seen::Refused(e), false) => {
            assert!(!own || e.contains(&format!("input {} ", s.active())), "{what}: refused, but not by its own input: {e}");
            false
        }
        (Seen::Taken, false) => panic!("{what}: taken, and the rule refuses it"),
        (Seen::Refused(e), true) => panic!("{what}: an honest spend was refused: {e}"),
    }
}

/// Every entry at every claim it may make.
fn every_claim() -> impl Iterator<Item = (Entry, i64)> {
    ENTRIES.into_iter().flat_map(|entry| entry.claims().iter().map(move |&age| (entry, age)))
}

#[test]
fn every_entry_takes_eight_inputs_and_refuses_nine() {
    let honest = |n: usize| vec![Shape::honest(); n];
    for (entry, age) in every_claim() {
        let room = MAX_TX_INPUTS - entry.own_inputs();
        // Its own input first, and after a plain coin.
        for lead in [0, 1] {
            assert!(expect(&Spend::new(entry, age).lead(honest(lead)).extras(honest(room - lead)), true), "eight inputs");
            assert!(!expect(&Spend::new(entry, age).lead(honest(lead)).extras(honest(room - lead + 1)), true), "nine inputs");
        }
    }
}

/// Every way this file knows to park a spend, beside an honest funding coin.
fn parking_shapes() -> Vec<Shape> {
    vec![
        Shape::of(Kind::MempoolOnly, Place::Elsewhere, 0),
        Shape::of(Kind::MempoolOnly, Place::Beside, 0),
        Shape::of(Kind::MempoolOnly, Place::InBlock, 0),
        Shape::of(Kind::P2pk, Place::Elsewhere, 0),
        Shape::of(Kind::P2pk, Place::InBlock, 1),
        Shape::of(Kind::P2pk, Place::InBlock, SEQUENCE_LOCK_TIME_DISABLED),
        Shape::of(Kind::P2pk, Place::InBlock, SEQUENCE_LOCK_TIME_DISABLED | 5),
        Shape::of(Kind::P2pk, Place::InBlock, u32::MAX as u64),
        Shape::of(Kind::P2pk, Place::InBlock, u64::MAX),
        Shape::of(Kind::Ecdsa, Place::InBlock, 0),
        Shape::of(Kind::P2sh, Place::InBlock, 0),
        Shape::of(Kind::Foreign, Place::InBlock, 0),
    ]
}

#[test]
fn every_entry_refuses_each_parking_shape() {
    // The ECDSA coin is signed validly: alone, in a plain transaction, its own script passes, so where it is refused
    // below the covenant refused it.
    let alone = TxContext::new().input(outpoint(0x60, 7), ecdsa_coin(IN_BLOCK), ecdsa_sig(), 0).output(p2pk_spk(&key(0x61)), None, 9_000_000_000);
    common::run(pool_builder().build(&alone).expect("the ECDSA coin's own script passes"), vec![ecdsa_coin(IN_BLOCK)]).expect("and runs");
    for (entry, age) in every_claim() {
        for shape in parking_shapes() {
            assert!(!shape.allowed());
            assert!(!expect(&Spend::new(entry, age).with(shape), true));
            // With its own input after a plain coin.
            assert!(!expect(&Spend::new(entry, age).lead(vec![Shape::honest()]).with(shape), true));
            // Chained on a covenant coin still in the mempool (no claim), where a coin made beside it is unconfirmed too.
            if age == 0 {
                assert!(!expect(&Spend::new(entry, age).unconfirmed().with(shape), true));
            }
        }
    }
}

#[test]
fn every_entry_claims_exactly_its_age_and_an_age_only_on_a_coin_in_a_block() {
    for (entry, age) in every_claim() {
        assert!(expect(&Spend::new(entry, age), true), "the honest spend");
        let claim = age as u64;
        let mut bent = vec![claim + 1, SEQUENCE_LOCK_TIME_DISABLED | claim, (1 << 40) | claim, u32::MAX as u64, u64::MAX];
        if claim > 0 {
            bent.push(claim - 1);
            bent.push(0);
        }
        for sequence in bent {
            assert!(!expect(&Spend::new(entry, age).sequence(sequence), true));
            assert!(!expect(&Spend::new(entry, age).lead(vec![Shape::honest()]).sequence(sequence), true));
        }
        if age > 0 {
            // The node checks no lock on a coin still in its mempool, and no block takes the claim before the coin is
            // that old.
            assert!(!expect(&Spend::new(entry, age).unconfirmed(), true), "a claim on a coin in the mempool");
        } else {
            // Chained on a spend still in the mempool, funded by a coin in a block or one made beside the covenant coin.
            assert!(expect(&Spend::new(entry, age).unconfirmed(), true));
            assert!(expect(&Spend::new(entry, age).unconfirmed().extras(vec![Shape::of(Kind::P2pk, Place::Beside, 0)]), true));
            assert!(expect(&Spend::new(entry, age).unconfirmed().lead(vec![Shape::of(Kind::P2pk, Place::Beside, 0)]), true));
        }
    }
}

#[test]
fn every_entry_takes_a_users_coin_only_from_a_block_or_beside_the_pool_coin() {
    for (entry, age) in every_claim().filter(|(entry, _)| entry.user_coin()) {
        assert!(expect(&Spend::new(entry, age).user(Place::InBlock), true));
        assert!(expect(&Spend::new(entry, age).user(Place::Beside), true), "beside a pool coin in a block: in a block too");
        assert!(!expect(&Spend::new(entry, age).user(Place::Elsewhere), true), "a state or position of an unrelated unconfirmed transaction");
        assert!(!expect(&Spend::new(entry, age).lead(vec![Shape::honest()]).user(Place::Elsewhere), true));
        if age == 0 {
            assert!(expect(&Spend::new(entry, age).unconfirmed().user(Place::Beside), true), "chained, with what the same transaction made");
            assert!(!expect(&Spend::new(entry, age).unconfirmed().user(Place::Elsewhere), true));
        }
    }
}

/// xorshift64*: the same shapes in every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len())]
    }
}

/// Random transactions over every entry: the claim, where the covenant coin and the user's coin are, the active
/// input's place and sequence, and up to nine inputs in all of every kind, place and sequence. Each is judged in both
/// views and must be taken exactly when the rule takes it. Each entry runs until it has seen both, at least 16 times.
#[test]
fn random_shapes_on_every_entry() {
    let mut rng = Rng(0x5eed_0017_c0de_0022);
    let kinds = [Kind::P2pk, Kind::MempoolOnly, Kind::Ecdsa, Kind::P2sh, Kind::Foreign];
    let places = [Place::InBlock, Place::Beside, Place::Elsewhere];
    let sequences = [1, SEQUENCE_LOCK_TIME_DISABLED, SEQUENCE_LOCK_TIME_DISABLED | 5, u32::MAX as u64, 1 << 40, u64::MAX];
    let shape = |rng: &mut Rng| {
        if rng.chance(70) {
            return if rng.chance(25) { Shape::of(Kind::P2pk, Place::Beside, 0) } else { Shape::honest() };
        }
        Shape::of(rng.pick(&kinds), rng.pick(&places), if rng.chance(50) { 0 } else { rng.pick(&sequences) })
    };
    let (mut all_taken, mut all_refused) = (0, 0);
    for entry in ENTRIES {
        let (mut taken_n, mut refused_n, mut cases) = (0, 0, 0);
        while (cases < 16 || taken_n < 3 || refused_n < 3) && cases < 80 {
            cases += 1;
            let age = rng.pick(entry.claims());
            let mut s = Spend::new(entry, age);
            s.unconfirmed = rng.chance(30);
            if rng.chance(10) {
                let claim = age as u64;
                s.sequence = rng.pick(&[claim + 1, claim.saturating_sub(1), SEQUENCE_LOCK_TIME_DISABLED | claim, (1 << 40) | claim, u64::MAX]);
            }
            s.user = if rng.chance(15) { Place::Elsewhere } else { rng.pick(&[Place::InBlock, Place::Beside]) };
            let room = MAX_TX_INPUTS + 1 - entry.own_inputs();
            let lead = rng.below(3).min(room);
            s.lead = (0..lead).map(|_| shape(&mut rng)).collect();
            s.extras = (0..rng.below(room - lead + 1)).map(|_| shape(&mut rng)).collect();
            // A plain coin in a block that pays, somewhere, so that only the shapes decide.
            if !s.lead.iter().chain(&s.extras).any(|x| x.allowed()) {
                s.extras.push(Shape::honest());
            }
            if expect(&s, false) { taken_n += 1 } else { refused_n += 1 }
        }
        println!("{}: {cases} random shapes, {taken_n} taken by the mempool and by a block, {refused_n} refused, none parked", entry.name());
        assert!(taken_n >= 3 && refused_n >= 3, "{}: the random shapes did not reach both outcomes", entry.name());
        all_taken += taken_n;
        all_refused += refused_n;
    }
    println!("{} random shapes on {} entries: {all_taken} taken, {all_refused} refused, none parked", all_taken + all_refused, ENTRIES.len());
}
