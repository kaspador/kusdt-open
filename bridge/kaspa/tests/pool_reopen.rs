//! The breaker-clock changes that touch money - the emptied-pool reopen re-seed, and the worst-case stack headroom of
//! the entries that now carry require_claim and the admin branch. Freshly compiled pool.ag through the real engine.
//!
//!   tools/rust.sh bridge/kaspa cargo test --test pool_reopen -- --nocapture
//!
//! (From the third review of the branch pool-clock, 2026-11-10, at 5921e93; kept as regression tests.)

#![allow(dead_code)]

mod common;

use std::sync::OnceLock;

use argent::artifact::Artifact;
use argent_runtime::{ArtifactBundle, EntryCall, TxBuilder, TxContext, args, state};
use common::{Rejected, State, funding, funding_sig, key, outpoint, sign_input, xonly};
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::mass::ScriptUnits;
use kaspa_consensus_core::{
    Hash,
    tx::{CovenantBinding, PopulatedTransaction, Transaction, TransactionOutpoint, UtxoEntry},
};
use kaspa_txscript::{EngineCtx, EngineFlags, SigCacheKey, TxScriptEngine, caches::Cache, covenants::CovenantsContext};
use secp256k1::Keypair;

const BPS: i64 = 10_000;
const PROTOCOL_BPS: i64 = 5;
const FEE_BPS: i64 = 50;
const MIN_LIQUIDITY: i64 = 1_000;
const MAX_OPERAND: i64 = (1 << 61) - 1;
const KAS: i64 = 100_000_000;
const USDT: i64 = 1_000_000;
const BASE: i64 = KAS;
const TOKEN_SOMPI: u64 = 100_000_000;
const POSITION_SOMPI: u64 = 50_000_000;
const MAX_OUT_BPS: i64 = 1_000;
const WINDOW: i64 = 36_000;
const MIN_AGE: i64 = WINDOW / 720;
const KUSDT_ID: [u8; 32] = [0x11; 32];
const POOL_ID: [u8; 32] = [0x22; 32];

fn share_of(base: i64, bps: i64) -> i64 {
    base / BPS * bps + base % BPS * bps / BPS
}

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
fn user_state(k: &Keypair, amount: i64) -> State {
    token_state(xonly(k), 0x00, amount)
}
fn reserve_state(amount: i64) -> State {
    token_state(POOL_ID, 0x04, amount)
}
fn position_state(shares: i64, owner: &Keypair) -> State {
    state! { token_covid: KUSDT_ID.to_vec(), shares: shares, owner: xonly(owner).to_vec() }
}
fn pool_state(p: &Ps, admin: [u8; 32], guardian: [u8; 32]) -> State {
    state! {
        token_covid: KUSDT_ID.to_vec(), kas_reserve: p.x, token_reserve: p.y, total_shares: p.s,
        protocol_kas: p.pk, protocol_tokens: p.pt, base_value: BASE, admin: admin.to_vec(),
        max_out_bps: MAX_OUT_BPS, window_len: WINDOW, window_credit: p.credit, window_ref: p.rf,
        window_out: p.out, paused: p.paused, guardian: guardian.to_vec()
    }
}
fn pool_value(p: &Ps) -> u64 {
    (BASE + p.x + p.pk) as u64
}

fn kusdt() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("kusdt.ag", "test-pool-reopen-kusdt").expect("kUSDT compiles"))
}
fn pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("pool.ag", "test-pool-reopen").expect("pool compiles"))
}
fn builder() -> TxBuilder<'static> {
    let bundle = ArtifactBundle::new(pool_artifact()).unwrap().with_artifact(kusdt()).unwrap();
    TxBuilder::from_bundle(&bundle).expect("bundle builder")
}
fn classify(e: argent_runtime::BuilderError) -> Rejected {
    match e {
        argent_runtime::BuilderError::InputScript { .. } | argent_runtime::BuilderError::TxScript(_) => Rejected::Script(e.to_string()),
        other => Rejected::Build(other.to_string()),
    }
}
#[track_caller]
fn script_refuses<T>(result: Result<T, Rejected>, what: &str) {
    match result {
        Err(Rejected::Script(_)) => {}
        Err(Rejected::Build(e)) => panic!("{what}: the builder failed before the script ran: {e}"),
        Ok(_) => panic!("{what}: accepted"),
    }
}

struct Fx {
    builder: TxBuilder<'static>,
    admin: Keypair,
    guardian: Keypair,
    p: Ps,
    pool: (TransactionOutpoint, UtxoEntry),
    reserve: (TransactionOutpoint, UtxoEntry),
    counter: std::cell::Cell<u32>,
    tag: u8,
}
impl Fx {
    fn new(p: Ps, tag: u8) -> Self {
        let (admin, guardian) = (key(0x30), key(0x32));
        let b = builder();
        let pool = b.covenant_utxo("Pool", pool_state(&p, xonly(&admin), xonly(&guardian)), pool_value(&p), 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
        let reserve = b.covenant_utxo("kusdt::KCC20", reserve_state(p.y + p.pt), TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap();
        Fx { builder: b, admin, guardian, p, pool: (outpoint(tag, 0), pool), reserve: (outpoint(tag, 1), reserve), counter: std::cell::Cell::new(0), tag }
    }
    fn fresh(&self) -> TransactionOutpoint {
        let n = self.counter.get();
        self.counter.set(n + 1);
        outpoint(self.tag + 1, n)
    }
    fn token_utxo(&self, s: State) -> (TransactionOutpoint, UtxoEntry) {
        (self.fresh(), self.builder.covenant_utxo("kusdt::KCC20", s, TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap())
    }
}

/// An emptied pool with a dust reserve (`x` sompi), only the MIN_LIQUIDITY unowned shares left.
fn emptied(x: i64, y: i64, tag: u8) -> Fx {
    Fx::new(Ps { x, y, s: MIN_LIQUIDITY, pk: 0, pt: 0, credit: 0, rf: x, out: 0, paused: false }, tag)
}

/// An admin reopen whose successor claims `rf` for window_ref (honest = next reserve).
fn reopen_with_rf(fx: &Fx, kas_in: i64, tokens_in: i64, shares: i64, rf: i64) -> Result<Transaction, Rejected> {
    let p = &fx.p;
    let next_x = p.x + kas_in;
    let next = Ps { x: next_x, y: p.y + tokens_in, s: p.s + shares, pk: p.pk, pt: p.pt, credit: p.credit, rf, out: p.out, paused: p.paused };
    let held = tokens_in + 1;
    let provider = key(0xab);
    let change = user_state(&provider, held - tokens_in);
    let (p_out, p_utxo) = fx.token_utxo(user_state(&provider, held));
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out), change.clone()];
    let provider_key = provider;
    let admin = fx.admin;
    let owner = xonly(&key(0xb8)).to_vec();
    let change_arg = change.clone();
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("add").args_with(move |tx, i| args!(kas_in, shares, 0i64, owner.clone(), change_arg.clone(), sign_input(tx, i, &admin))), fx.pool.0, fx.pool.1.clone(), 0)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .actor_input("kusdt::KCC20", user_state(&provider, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &provider_key))), p_out, p_utxo.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("Position", position_state(shares, &key(0xb8)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let tx = fx.builder.build(&ctx).map_err(classify)?;
    common::run(tx, vec![fx.pool.1.clone(), fx.reserve.1.clone(), p_utxo, funding()])
}

/// The reopen re-seeds window_ref to EXACTLY the new reserve - the covenant forces it; an attacker
/// (even the admin) cannot claim a higher reference and so cannot grant sells more than one cap of
/// the real, deposited liquidity. A reference above or below the new reserve is refused.
#[test]
fn reopen_forces_reference_equal_to_the_new_reserve() {
    let fx = emptied(1_000, 1_000, 0x40);
    let (kas_in, tokens_in, shares) = (10_000 * KAS, 1_000 * USDT, 500);
    let next_x = fx.p.x + kas_in;
    // Honest: rf == next reserve.
    reopen_with_rf(&fx, kas_in, tokens_in, shares, next_x).expect("the admin reopens with rf = new reserve");
    // A reference ABOVE the new reserve (would inflate the cap beyond real liquidity): refused.
    script_refuses(reopen_with_rf(&fx, kas_in, tokens_in, shares, next_x + 1), "a reopen whose reference exceeds the new reserve");
    script_refuses(reopen_with_rf(&fx, kas_in, tokens_in, shares, next_x * 2), "a reopen with a doubled reference");
    script_refuses(reopen_with_rf(&fx, kas_in, tokens_in, shares, MAX_OPERAND), "a reopen with a maxed reference");
    // A reference BELOW it (not the forced value) is refused too: the covenant pins rf = next_x.
    script_refuses(reopen_with_rf(&fx, kas_in, tokens_in, shares, next_x - 1), "a reopen whose reference is below the new reserve");
    script_refuses(reopen_with_rf(&fx, kas_in, tokens_in, shares, fx.p.x), "a reopen that keeps the dust reference");
    println!("reopen: window_ref is pinned to the new reserve ({next_x} sompi); no higher or lower reference is accepted, so the cap tracks real liquidity only");
}

fn tokens_for(x: i64, y: i64, kas_out: i64) -> i64 {
    let (xi, yi, out) = (x as i128, y as i128, kas_out as i128);
    let eff = yi * out / (xi - out) + 1;
    (eff * BPS as i128 / (BPS - FEE_BPS) as i128 + 2) as i64
}

/// Right after a reopen the pool grants sells at most one cap of the real reserve: a sell of the cap
/// is accepted, a sell of cap + 1 is refused (over cap). No banked or windfall allowance survives the
/// re-seed (window_out starts at the settled emptied count, here 0).
#[test]
fn reopen_grants_no_more_than_one_real_cap() {
    // Fabricate the post-reopen pool directly: a real reserve, rf = reserve, out = 0 (the settled count).
    let x = 10_000 * KAS;
    let fx = Fx::new(Ps { x, y: 1_000 * USDT, s: x, pk: 0, pt: 0, credit: 0, rf: x, out: 0, paused: false }, 0x48);
    let cap = share_of(x, MAX_OUT_BPS);
    // A sell of the whole cap, claiming nothing (out = 0 is below half): accepted.
    sell_all(&fx, cap, 0).expect("a sell of exactly one cap right after reopen");
    // A sell of cap + 1: refused (next_out > cap).
    script_refuses(sell_all(&fx, cap + 1, 0), "a sell of one more than the cap right after reopen");
    println!("reopen grants at most one real cap ({cap} sompi); one sompi more is refused");
}

/// A sell_all of `kas_out` claiming `age`, payer = a schnorr user holding exactly the needed tokens.
fn sell_all(fx: &Fx, kas_out: i64, age: i64) -> Result<Transaction, Rejected> {
    let p = &fx.p;
    let tokens_in = tokens_for(p.x, p.y, kas_out);
    let cut = tokens_in * PROTOCOL_BPS / BPS;
    let next_x = p.x - kas_out;
    let next_y = p.y + tokens_in - cut;
    let nref = {
        // advanced_ref with reserve == reference (reopen state): stays at reserve, then min(next_x).
        let r = p.rf.min(p.x);
        if next_x < r { next_x } else { r }
    };
    let cap = share_of(p.rf, MAX_OUT_BPS);
    let settled = if p.out > 0 {
        let decay = age * (cap / WINDOW) + age * (cap % WINDOW) / WINDOW;
        (p.out - decay).max(0)
    } else {
        p.out
    };
    let next_out = settled + kas_out;
    let next = Ps { x: next_x, y: next_y, s: p.s, pk: p.pk, pt: p.pt + cut, credit: (p.credit - kas_out).max(0), rf: nref, out: next_out, paused: p.paused };
    let seller = key(0xc0);
    let (p_out, p_utxo) = fx.token_utxo(user_state(&seller, tokens_in));
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out)];
    let seller_key = seller;
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("sell_all").args(args!(kas_out, age)), fx.pool.0, fx.pool.1.clone(), age.max(0) as u64)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .actor_input("kusdt::KCC20", user_state(&seller, tokens_in), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &seller_key))), p_out, p_utxo.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let tx = fx.builder.build(&ctx).map_err(classify)?;
    common::run(tx, vec![fx.pool.1.clone(), fx.reserve.1.clone(), p_utxo, funding()])
}

// --- stack-depth margins (copied from tests/audit3_kaspa_rules.rs) ----------

use kaspa_consensus_core::tx::VerifiableTransaction;

fn max_stack_depth(tx: &Transaction, entries: &[UtxoEntry], index: usize) -> usize {
    let reused = SigHashReusedValuesUnsync::new();
    let sig_cache: Cache<SigCacheKey, bool> = Cache::new(100);
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    let covenants = CovenantsContext::from_tx(&populated).expect("covenant context");
    let input = populated.tx.inputs[index].clone();
    let utxo = populated.utxo(index).expect("input utxo");
    let mut log = Vec::new();
    {
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &populated,
            &input,
            index,
            utxo,
            EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&covenants),
            EngineFlags { covenants_enabled: true, ..Default::default() },
            ScriptUnits(u64::MAX),
        )
        .with_opcode_execution_log_buffer(&mut log);
        vm.execute().expect("the script runs");
    }
    let log = String::from_utf8_lossy(&log);
    log.lines().map(|line| line.matches("\"0x").count()).max().unwrap_or(0)
}

/// The pool's heaviest entry over worst-case arguments stays well under the 244-element stack limit.
/// `remove` (position read + reserve observe + breaker settle + reclaim + two-cap cut) and the
/// reopen `add` (admin checkSig + breaker settle + re-seed) are the deepest. Every tx that `common::run`
/// accepts is already within the compute/transient mass limits and the 15-sig-op relay cap (both
/// enforced in the build/run path), so this reports the remaining dimension: stack depth.
#[test]
fn pool_entries_stay_far_under_the_stack_limit() {
    // Reopen add: the admin branch, into an emptied pool, large deposit (operands near their scale).
    let fx = emptied(1_000, 1_000, 0x60);
    let (kas_in, tokens_in, shares) = (1_000_000 * KAS, 500_000 * USDT, 1);
    let next_x = fx.p.x + kas_in;
    let tx = {
        let p = &fx.p;
        let next = Ps { x: next_x, y: p.y + tokens_in, s: p.s + shares, pk: p.pk, pt: p.pt, credit: p.credit, rf: next_x, out: p.out, paused: p.paused };
        let held = tokens_in + 1;
        let provider = key(0xab);
        let change = user_state(&provider, held - tokens_in);
        let (p_out, p_utxo) = fx.token_utxo(user_state(&provider, held));
        let reserve_out = next.y + next.pt;
        let next_states = vec![reserve_state(reserve_out), change.clone()];
        let provider_key = provider;
        let admin = fx.admin;
        let owner = xonly(&key(0xb8)).to_vec();
        let change_arg = change.clone();
        let ctx = TxContext::new()
            .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("add").args_with(move |tx, i| args!(kas_in, shares, 0i64, owner.clone(), change_arg.clone(), sign_input(tx, i, &admin))), fx.pool.0, fx.pool.1.clone(), 0)
            .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
            .actor_input("kusdt::KCC20", user_state(&provider, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &provider_key))), p_out, p_utxo.clone(), 0)
            .input(fx.fresh(), funding(), funding_sig(), 0)
            .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
            .actor_output("Position", position_state(shares, &key(0xb8)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = fx.builder.build(&ctx).expect("reopen add builds");
        let entries = vec![fx.pool.1.clone(), fx.reserve.1.clone(), p_utxo, funding()];
        let run = common::run(tx, entries).expect("the reopen add runs");
        run
    };
    let entries = vec![fx.pool.1.clone(), fx.reserve.1.clone(), fx.builder.covenant_utxo("kusdt::KCC20", user_state(&key(0xab), tokens_in + 1), TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap(), funding()];
    let depth = max_stack_depth(&tx, &entries, 0);
    println!("reopen add (admin checkSig + re-seed): deepest pool-input stack {depth} of 244");
    assert!(depth < 200, "reopen add stack {depth}");
}
