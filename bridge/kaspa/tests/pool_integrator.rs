//! A contract-driven swapper (a launchpad's automated buyer/seller) against KasPool, and the two exact engine
//! questions the owner is answering for an integrator.
//!
//! Everything here runs the FRESHLY COMPILED pool.ag (not the checked-in
//! artifact) bundled with kUSDT, through the real script engine with covenants
//! (common::run, which also enforces the 15-sig-op relay cap). A pool UTXO and
//! its reserve are fabricated with the covenant's own ids, exactly as
//! tests/audit3_pool.rs does, so the covenant's `OpInputCovenantId`/`OpCov*`
//! observations see a real pool family.
//!
//!   tools/rust.sh bridge/kaspa cargo test --test pool_integrator -- --nocapture
//!   (with -v kusdt-target-pool:/target --cpus 12)
//!
//! (From the third review of the branch pool-clock, 2026-11-10, at 5921e93; kept as regression tests.)

#![allow(dead_code)]

mod common;

use std::sync::OnceLock;

use argent::artifact::Artifact;
use argent_runtime::{ArtifactBundle, EntryCall, TxBuilder, TxContext, args, state};
use common::{Rejected, State, funding, funding_sig, key, outpoint, xonly};
use kaspa_consensus_core::{
    Hash,
    tx::{CovenantBinding, ScriptPublicKey, Transaction, TransactionOutpoint, TransactionOutput, UtxoEntry},
};
use kaspa_txscript::standard::pay_to_script_hash_script;
use secp256k1::Keypair;

const BPS: i64 = 10_000;
const FEE_BPS: i64 = 50;
const PROTOCOL_BPS: i64 = 5;
const MIN_LIQUIDITY: i64 = 1_000;
const MAX_OPERAND: i64 = (1 << 61) - 1;

const KAS: i64 = 100_000_000;
const USDT: i64 = 1_000_000;
const BASE: i64 = KAS;
const TOKEN_SOMPI: u64 = 100_000_000; // the reserve output's KAS value (>= MIN_RESERVE_VALUE = 1 KAS)
const POSITION_SOMPI: u64 = 50_000_000;
const MAX_OUT_BPS: i64 = 1_000;
const WINDOW: i64 = 36_000;
const MIN_AGE: i64 = WINDOW / 720;

const KUSDT_ID: [u8; 32] = [0x11; 32];
const POOL_ID: [u8; 32] = [0x22; 32];
const FOREIGN_ID: [u8; 32] = [0x33; 32];

// --- breaker math, mirrored from pool.ag (for honest successors) ------------

fn advanced_ref(reference: i64, reserve: i64, elapsed: i64, length: i64) -> i64 {
    let mut next = reserve;
    if reserve > reference {
        let mut gap = reserve - reference;
        if gap > reference {
            gap = reference;
        }
        next = reference + gap;
        if elapsed < length {
            next = reference + elapsed * (gap / length) + elapsed * (gap % length) / length;
        }
    }
    next
}
fn share_of(base: i64, bps: i64) -> i64 {
    base / BPS * bps + base % BPS * bps / BPS
}
fn settled_out(used: i64, elapsed: i64, cap: i64, length: i64) -> i64 {
    let mut next = used;
    if next < -cap {
        next = -cap;
    }
    let decay = elapsed * (cap / length) + elapsed * (cap % length) / length;
    if next > 0 {
        next -= decay;
        if next < 0 {
            next = 0;
        }
    } else if next < 0 {
        next += decay;
        if next > 0 {
            next = 0;
        }
    }
    next
}
fn credit_left(credit: i64, stored: i64, settled: i64) -> i64 {
    if stored < 0 {
        let lapsed = settled - stored;
        if credit > lapsed { credit - lapsed } else { 0 }
    } else {
        credit
    }
}
fn min_age() -> i64 {
    (WINDOW / 720).max(1)
}

// --- the pool state ---------------------------------------------------------

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
impl Ps {
    fn fresh(x: i64, y: i64) -> Self {
        Ps { x, y, s: x, pk: 0, pt: 0, credit: 0, rf: x, out: 0, paused: false }
    }
}

fn token_state(owner: [u8; 32], scheme: u8, amount: i64) -> State {
    state! {
        amount: amount,
        owner: owner.to_vec(),
        owner_scheme: scheme,
        borrow_scheme: 0u8,
        borrow_guard: vec![0u8; 32],
        extension_commitment: vec![0u8; 32]
    }
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
        token_covid: KUSDT_ID.to_vec(),
        kas_reserve: p.x,
        token_reserve: p.y,
        total_shares: p.s,
        protocol_kas: p.pk,
        protocol_tokens: p.pt,
        base_value: BASE,
        admin: admin.to_vec(),
        max_out_bps: MAX_OUT_BPS,
        window_len: WINDOW,
        window_credit: p.credit,
        window_ref: p.rf,
        window_out: p.out,
        paused: p.paused,
        guardian: guardian.to_vec()
    }
}
fn pool_value(p: &Ps) -> u64 {
    (BASE + p.x + p.pk) as u64
}

fn kusdt() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("kusdt.ag", "test-pool-integrator-kusdt").expect("kUSDT compiles"))
}
fn pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("pool.ag", "test-pool-integrator").expect("pool compiles"))
}
fn builder() -> TxBuilder<'static> {
    let bundle = ArtifactBundle::new(pool_artifact()).unwrap().with_artifact(kusdt()).unwrap();
    TxBuilder::from_bundle(&bundle).expect("bundle builder")
}

struct Fx {
    builder: TxBuilder<'static>,
    admin: Keypair,
    guardian: Keypair,
    p: Ps,
    pool: (TransactionOutpoint, UtxoEntry),
    reserve: (TransactionOutpoint, UtxoEntry),
    counter: std::cell::Cell<u32>,
}
impl Fx {
    fn new(p: Ps) -> Self {
        let (admin, guardian) = (key(0x30), key(0x32));
        let b = builder();
        let pool_utxo = b.covenant_utxo("Pool", pool_state(&p, xonly(&admin), xonly(&guardian)), pool_value(&p), 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
        let reserve_utxo = b.covenant_utxo("kusdt::KCC20", reserve_state(p.y + p.pt), TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap();
        Fx { builder: b, admin, guardian, p, pool: (outpoint(0x40, 0), pool_utxo), reserve: (outpoint(0x40, 1), reserve_utxo), counter: std::cell::Cell::new(0) }
    }
    fn fresh(&self) -> TransactionOutpoint {
        let n = self.counter.get();
        self.counter.set(n + 1);
        outpoint(0x41, n)
    }
    fn token_utxo(&self, s: State) -> (TransactionOutpoint, UtxoEntry) {
        (self.fresh(), self.builder.covenant_utxo("kusdt::KCC20", s, TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap())
    }
}

fn buy_quote(x: i64, y: i64, kas_in: i64) -> i64 {
    let eff = kas_in as i128 * (BPS - FEE_BPS) as i128 / BPS as i128;
    (y as i128 * eff / (x as i128 + eff)) as i64
}

/// An honest buy successor: the state the covenant forces at `age`.
fn buy_next(p: &Ps, kas_in: i64, amount: i64, age: i64) -> Ps {
    let cut = kas_in * PROTOCOL_BPS / BPS;
    let next_x = p.x + kas_in - cut;
    let next_y = p.y - amount;
    let next_ref = advanced_ref(p.rf, p.x, age, WINDOW);
    let cap = share_of(next_ref, MAX_OUT_BPS);
    let settled = settled_out(p.out, age, cap, WINDOW);
    let mut next_out = settled - (next_x - p.x);
    if next_out < -cap {
        next_out = -cap;
    }
    let mut next_credit = credit_left(p.credit, p.out, settled) + (settled - next_out);
    if next_credit > MAX_OPERAND {
        next_credit = MAX_OPERAND;
    }
    Ps { x: next_x, y: next_y, s: p.s, pk: p.pk + cut, pt: p.pt, credit: next_credit, rf: next_ref, out: next_out, paused: p.paused }
}

/// A sell_all successor (whole payer state, no change).
fn sell_all_next(p: &Ps, tokens_in: i64, kas_out: i64, age: i64) -> Ps {
    let cut = tokens_in * PROTOCOL_BPS / BPS;
    let next_x = p.x - kas_out;
    let next_y = p.y + tokens_in - cut;
    let mut next_ref = advanced_ref(p.rf, p.x, age, WINDOW);
    let cap = share_of(next_ref, MAX_OUT_BPS);
    let settled = settled_out(p.out, age, cap, WINDOW);
    let next_out = settled + kas_out;
    let mut next_credit = credit_left(p.credit, p.out, settled) - kas_out;
    if next_credit < 0 {
        next_credit = 0;
    }
    if next_x < next_ref {
        next_ref = next_x;
    }
    Ps { x: next_x, y: next_y, s: p.s, pk: p.pk, pt: p.pt + cut, credit: next_credit, rf: next_ref, out: next_out, paused: p.paused }
}

fn tokens_for(x: i64, y: i64, kas_out: i64) -> i64 {
    // tokens_in that pays at least kas_out on a sell (mirrors audit3_pool::tokens_for).
    let (xi, yi, out) = (x as i128, y as i128, kas_out as i128);
    let eff = yi * out / (xi - out) + 1;
    (eff * BPS as i128 / (BPS - FEE_BPS) as i128 + 2) as i64
}

/// A description of one extra, non-pool, non-reserve/buyer output to append.
enum Extra {
    /// A plain KAS output to a schnorr address (the integrator's order coin).
    Plain(u64),
    /// A fresh covenant (a new Pool family) authorized by input 0: a genuine foreign-covenant output.
    ForeignCovenant(u64),
    /// A third kUSDT output (which the covenant must refuse).
    ThirdKusdt(i64),
}

fn script_true() -> ScriptPublicKey {
    ScriptPublicKey::from_vec(0, vec![0x51])
}

#[track_caller]
fn script_refuses<T>(result: Result<T, Rejected>, what: &str) {
    match result {
        Err(Rejected::Script(_)) => {}
        Err(Rejected::Build(e)) => panic!("{what}: the builder failed before the script ran: {e}"),
        Ok(_) => panic!("{what}: accepted"),
    }
}

/// Appends a kUSDT-family continuation output (authorized by input `auth`) to a raw transaction,
/// so an attacker-built transaction can carry one more kUSDT output than the honest builder would.
fn append_kusdt_output(mut tx: Transaction, value: u64, auth: u16) -> Transaction {
    tx.outputs.push(TransactionOutput::with_covenant(value, script_true(), Some(CovenantBinding::new(auth, Hash::from_bytes(KUSDT_ID)))));
    tx
}

fn classify(e: argent_runtime::BuilderError) -> Rejected {
    match e {
        argent_runtime::BuilderError::InputScript { .. } | argent_runtime::BuilderError::TxScript(_) => Rejected::Script(e.to_string()),
        other => Rejected::Build(other.to_string()),
    }
}

/// Builds a buy with the standard outputs (#0 pool, #1 reserve, #2 buyer) then the given extras.
fn build_buy(fx: &Fx, kas_in: i64, amount: i64, age: i64, extras: &[Extra]) -> Result<Transaction, Rejected> {
    let p = &fx.p;
    let next = buy_next(p, kas_in, amount, age);
    let buyer = key(0xb0);
    let buyer_state = user_state(&buyer, amount);
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out), buyer_state.clone()];

    let mut ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("buy").args(args!(kas_in, age, buyer_state.clone())), fx.pool.0, fx.pool.1.clone(), age.max(0) as u64)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", buyer_state, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    for e in extras {
        ctx = match e {
            Extra::Plain(v) => ctx.output(script_true(), None, *v),
            Extra::ForeignCovenant(v) => ctx.actor_genesis_output(0, "launch::order", "Pool", pool_state(&Ps::fresh(10_000 * KAS, 1_000 * USDT), xonly(&key(0x55)), xonly(&key(0x56))), *v),
            Extra::ThirdKusdt(a) => ctx.actor_output("kusdt::KCC20", user_state(&key(0xcc), *a), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI),
        };
    }
    let tx = fx.builder.build(&ctx).map_err(classify)?;
    common::run(tx, vec![fx.pool.1.clone(), fx.reserve.1.clone(), funding()])
}

/// A plain buy as a raw transaction and its entries (before the engine runs), so a test can
/// mutate it the way an attacker would and re-run the engine itself.
fn raw_buy(fx: &Fx, kas_in: i64, amount: i64, age: i64) -> (Transaction, Vec<UtxoEntry>) {
    let p = &fx.p;
    let next = buy_next(p, kas_in, amount, age);
    let buyer = key(0xb0);
    let buyer_state = user_state(&buyer, amount);
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out), buyer_state.clone()];
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("buy").args(args!(kas_in, age, buyer_state.clone())), fx.pool.0, fx.pool.1.clone(), age.max(0) as u64)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", buyer_state, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let tx = fx.builder.build(&ctx).expect("plain buy builds");
    (tx, vec![fx.pool.1.clone(), fx.reserve.1.clone(), funding()])
}

/// Exact engine test #1: a buy with extra outputs after the pool/reserve/buyer.
/// The pool checks only its own single Pool output and its value, the kUSDT family
/// (reserve then buyer, exhaustively) and the reserve's minimum value, all located
/// by covenant (OpCovOutputIdx), not by absolute index. A plain extra output and a
/// foreign-covenant extra output are both accepted; a third kUSDT output is refused.
#[test]
fn buy_accepts_extra_non_kusdt_outputs_and_refuses_a_third_kusdt() {
    let fx = Fx::new(Ps::fresh(10_000 * KAS, 1_000 * USDT));
    let kas_in = 10 * KAS;
    let amount = buy_quote(fx.p.x, fx.p.y, kas_in);
    assert!(amount > 0);

    // a) one plain KAS output #4 (the integrator's order coin): accepted.
    build_buy(&fx, kas_in, amount, 0, &[Extra::Plain(5 * KAS as u64)]).expect("a buy with a plain extra output #4");
    // b) a foreign-covenant output #4 for the order coin: accepted.
    build_buy(&fx, kas_in, amount, 0, &[Extra::ForeignCovenant(BASE as u64 + 10_000 * KAS as u64)]).expect("a buy with a foreign-covenant extra output #4");
    // c) both a plain and a foreign-covenant extra output: accepted.
    build_buy(&fx, kas_in, amount, 0, &[Extra::Plain(3 * KAS as u64), Extra::ForeignCovenant(BASE as u64 + 10_000 * KAS as u64)]).expect("a buy with two extra outputs");
    // negative: a third kUSDT output in the same buy is refused (OpCovOutputCount(token) != 2).
    // The honest builder refuses to assemble it; an attacker who appends one to the raw tx is
    // refused by the script engine too.
    assert!(matches!(build_buy(&fx, kas_in, amount, 0, &[Extra::ThirdKusdt(0)]), Err(Rejected::Build(_))), "the honest builder refuses a third kUSDT output");
    let (tx, entries) = raw_buy(&fx, kas_in, amount, 0);
    script_refuses(common::run(append_kusdt_output(tx, TOKEN_SOMPI, 1), entries), "a buy with a third kUSDT output appended to the raw tx");
    // and the plain baseline (no extras) still works.
    build_buy(&fx, kas_in, amount, 0, &[]).expect("the plain buy");
    println!("buy: extra plain and foreign-covenant outputs accepted; a third kUSDT output refused by the engine");
}

// --- P2SH / covenant-owned payer sells (coordinator test #2) ----------------

/// The standard P2SH authority input: a coin whose SPK is P2SH(redeem) and whose
/// sig script pushes `redeem` (OP_TRUE), so its presence authorizes a 0x03-owned payer.
fn p2sh_authority() -> ([u8; 32], ScriptPublicKey, UtxoEntry, Vec<u8>) {
    let redeem = vec![0x51u8]; // OP_TRUE
    let spk = pay_to_script_hash_script(&redeem);
    // The owner field is the 32-byte redeem-script hash inside the SPK: [OpBlake2b, OpData32, hash32, OpEqual].
    let script = spk.script();
    let hash: [u8; 32] = script[2..34].try_into().expect("32-byte p2sh hash");
    let utxo = UtxoEntry::new(10 * KAS as u64, spk.clone(), 0, false, None);
    // A push-only sig script that pushes the redeem script (pay_to_script_hash_signature_script with empty sig).
    let sig_script = vec![0x01u8, 0x51];
    (hash, spk, utxo, sig_script)
}

/// Builds a sell_all whose payer is owned by `scheme` (0x03 P2SH, authorized by a P2SH coin,
/// or 0x04 covenant-id = POOL_ID, authorized by the pool input). The freed KAS has no named
/// output: the builder may place the integrator's outputs wherever it likes. `kas_out_pos`
/// controls where an (optional) order output sits relative to the reserve.
fn build_sell_all_p2sh(fx: &Fx, tokens_in: i64, kas_out: i64, age: i64, covenant_owned: bool, order: &[Extra]) -> Result<Transaction, Rejected> {
    let (tx, entries) = assemble_sell_all(fx, tokens_in, kas_out, age, covenant_owned, order)?;
    common::run(tx, entries)
}

fn assemble_sell_all(fx: &Fx, tokens_in: i64, kas_out: i64, age: i64, covenant_owned: bool, order: &[Extra]) -> Result<(Transaction, Vec<UtxoEntry>), Rejected> {
    let p = &fx.p;
    let next = sell_all_next(p, tokens_in, kas_out, age);
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out)];

    let (authority, payer_state, payer_utxo, deleg_witness): (Option<(TransactionOutpoint, UtxoEntry, Vec<u8>)>, State, UtxoEntry, Vec<u8>);
    if covenant_owned {
        // Payer owned by the pool's own covenant id: the pool input satisfies OpCovInputCount(owner) > 0.
        let st = token_state(POOL_ID, 0x04, tokens_in);
        let (_o, u) = fx.token_utxo(st.clone());
        payer_state = st;
        payer_utxo = u;
        deleg_witness = Vec::new(); // covenant-id path: empty witness
        authority = None;
    } else {
        let (hash, _spk, auth_utxo, auth_sig) = p2sh_authority();
        let st = token_state(hash, 0x03, tokens_in);
        let (_o, u) = fx.token_utxo(st.clone());
        payer_state = st;
        payer_utxo = u;
        // The authority input index in the final input list: pool(0), reserve(1), payer(2), authority(3).
        deleg_witness = vec![0x03u8];
        authority = Some((fx.fresh(), auth_utxo, auth_sig));
    }
    let payer_out = fx.fresh();

    let deleg = deleg_witness.clone();
    let mut ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("sell_all").args(args!(kas_out, age)), fx.pool.0, fx.pool.1.clone(), age.max(0) as u64)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .actor_input("kusdt::KCC20", payer_state, EntryCall::new("transfer_delegator").args(args!(deleg.clone())), payer_out, payer_utxo.clone(), 0);
    let mut entries = vec![fx.pool.1.clone(), fx.reserve.1.clone(), payer_utxo];
    if let Some((o, u, sig)) = &authority {
        ctx = ctx.input(*o, u.clone(), sig.clone(), 0);
        entries.push(u.clone());
    }
    // funding for the fee.
    let fo = fx.fresh();
    ctx = ctx.input(fo, funding(), funding_sig(), 0);
    entries.push(funding());

    // outputs: pool (#0), reserve (#1), then the integrator's order outputs in whatever positions.
    ctx = ctx
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    for e in order {
        ctx = match e {
            Extra::Plain(v) => ctx.output(script_true(), None, *v),
            Extra::ForeignCovenant(v) => ctx.actor_genesis_output(0, "launch::order", "Pool", pool_state(&Ps::fresh(10_000 * KAS, 1_000 * USDT), xonly(&key(0x57)), xonly(&key(0x58))), *v),
            Extra::ThirdKusdt(a) => ctx.actor_output("kusdt::KCC20", user_state(&key(0xcd), *a), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI),
        };
    }
    let tx = fx.builder.build(&ctx).map_err(classify)?;
    Ok((tx, entries))
}

/// Exact engine test #2: a sell_all whose payer is covenant-id-owned (0x04, authorized by the pool input itself),
/// with the freed KAS going to an output the builder chooses (a plain coin, a foreign-covenant coin, at different
/// positions). Accepted, with no pool constraint on that output's index, amount or owner beyond pool.value falling
/// by kas_out. A script-owned payer (0x03) needs a P2SH authority input, which the pool refuses since every input of
/// a pool transaction must be one a block judges as the mempool does (`require_settled_inputs`): such kUSDT moves to
/// a plain owner first (the documented limit).
#[test]
fn sell_all_accepts_a_covenant_owned_payer_and_pays_kas_anywhere() {
    let fx = Fx::new(Ps::fresh(10_000 * KAS, 1_000 * USDT));
    // A modest sell well under the cap at age 0 (count starts at 0, so claiming nothing is fine below half).
    let kas_out = 50 * KAS;
    let tokens_in = tokens_for(fx.p.x, fx.p.y, kas_out);

    // 0x04 covenant-id payer (owned by the pool's family, authorized by the pool input itself), order coin as a plain output at #2.
    build_sell_all_p2sh(&fx, tokens_in, kas_out, 0, true, &[Extra::Plain(kas_out as u64 - KAS as u64)]).expect("sell_all with a covenant-id payer, plain order output at #2");
    // Order coin as a foreign-covenant output at #2.
    build_sell_all_p2sh(&fx, tokens_in, kas_out, 0, true, &[Extra::ForeignCovenant(BASE as u64 + 10_000 * KAS as u64)]).expect("sell_all with a covenant-id payer, foreign-covenant order output");
    // Two order coins (#2 plain, #3 plain): the pool fixes no index for them.
    build_sell_all_p2sh(&fx, tokens_in, kas_out, 0, true, &[Extra::Plain(10 * KAS as u64), Extra::Plain(10 * KAS as u64)]).expect("sell_all with a covenant-id payer, two order outputs");
    // 0x03 P2SH payer: its P2SH authority input is refused.
    script_refuses(build_sell_all_p2sh(&fx, tokens_in, kas_out, 0, false, &[Extra::Plain(kas_out as u64 - KAS as u64)]), "sell_all with a P2SH payer (its authority input is a P2SH coin)");
    // negative: a second kUSDT OUTPUT (OpCovOutputCount(token) must be 1) is refused by the engine
    // when appended to the raw tx (the honest builder refuses to assemble it at all).
    assert!(matches!(build_sell_all_p2sh(&fx, tokens_in, kas_out, 0, true, &[Extra::ThirdKusdt(0)]), Err(Rejected::Build(_))), "the honest builder refuses an extra kUSDT output on sell_all");
    let (tx, entries) = assemble_sell_all(&fx, tokens_in, kas_out, 0, true, &[]).expect("plain sell_all assembles");
    script_refuses(common::run(append_kusdt_output(tx, TOKEN_SOMPI, 1), entries), "sell_all with an extra kUSDT output appended to the raw tx");
    println!("sell_all: a covenant-id (0x04) payer accepted, a P2SH (0x03) payer refused; freed KAS placed at any index/owner; an extra kUSDT output refused by the engine");
}

/// Assembles a sell_all (a covenant-id payer, owned by the pool's family) with an explicit pool-input sequence, and
/// no order outputs.
fn assemble_sell_all_seq(fx: &Fx, tokens_in: i64, kas_out: i64, age: i64, sequence: u64) -> Result<(Transaction, Vec<UtxoEntry>), Rejected> {
    let p = &fx.p;
    let next = sell_all_next(p, tokens_in, kas_out, age);
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out)];
    let payer_state = token_state(POOL_ID, 0x04, tokens_in);
    let (payer_out, payer_utxo) = fx.token_utxo(payer_state.clone());
    let fund_o = fx.fresh();
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("sell_all").args(args!(kas_out, age)), fx.pool.0, fx.pool.1.clone(), sequence)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .actor_input("kusdt::KCC20", payer_state, EntryCall::new("transfer_delegator").args(args!(Vec::<u8>::new())), payer_out, payer_utxo.clone(), 0)
        .input(fund_o, funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let tx = fx.builder.build(&ctx).map_err(classify)?;
    Ok((tx, vec![fx.pool.1.clone(), fx.reserve.1.clone(), payer_utxo, funding()]))
}

/// A contract-driven swapper obeys the SAME breaker rules as a wallet: above half of the cap it
/// must claim at least min_age (the claim is a property of the POOL input, not of who owns the
/// payer), the pool input's relative-lock sequence must be exactly the claim, and the pool's value must
/// fall by exactly kas_out. None of these can be sidestepped by owning the payer with a covenant.
#[test]
fn a_contract_swapper_obeys_the_same_claim_and_value_rules() {
    // A state with more than half of the cap in use (out = cap/2 + 1), so require_claim bites.
    let x = 10_000 * KAS;
    let cap = share_of(x, MAX_OUT_BPS); // = x/10
    let mut p = Ps::fresh(x, 1_000 * USDT);
    p.out = cap / 2 + 1;
    p.credit = p.out; // a plausible credit (<= out)
    let fx = Fx::new(p);
    assert!(fx.p.out > share_of(fx.p.rf, MAX_OUT_BPS) / 2, "above half of the cap");

    let kas_out = KAS; // 1 KAS, well within the room at min_age
    let tokens_in = tokens_for(fx.p.x, fx.p.y, kas_out);

    // Claiming nothing above half of the cap: refused (require_claim), even for a covenant-owned payer.
    script_refuses(build_sell_all_p2sh(&fx, tokens_in, kas_out, 0, true, &[]), "a contract sell_all claiming nothing above half of the cap");
    // At min_age with a sequence that does not cover it: refused by CSV (this.ageDaa >= age_daa).
    script_refuses(assemble_sell_all_seq(&fx, tokens_in, kas_out, MIN_AGE, (MIN_AGE - 1) as u64).map(|(t, e)| common::run(t, e)).and_then(|r| r), "a contract sell_all whose sequence is one below the claim");
    // At min_age with a sequence above it: refused too (the sequence is exactly the claim, `require_settled_inputs`).
    script_refuses(assemble_sell_all_seq(&fx, tokens_in, kas_out, MIN_AGE, (MIN_AGE + 1) as u64).map(|(t, e)| common::run(t, e)).and_then(|r| r), "a contract sell_all whose sequence is one above the claim");
    // At min_age with the matching sequence: accepted (same as a wallet).
    let (tx, entries) = assemble_sell_all_seq(&fx, tokens_in, kas_out, MIN_AGE, MIN_AGE as u64).expect("assembles");
    common::run(tx, entries).expect("a contract sell_all at min_age with a matching sequence");

    // The pool value rule: a pool output value off by one (KAS kept back or skimmed) is refused.
    let (mut tx, entries) = assemble_sell_all_seq(&fx, tokens_in, kas_out, MIN_AGE, MIN_AGE as u64).expect("assembles");
    tx.outputs[0].value += 1;
    script_refuses(common::run(tx, entries), "a contract sell_all whose pool output keeps one extra sompi");
    println!("a contract swapper obeys the same min_age claim, sequence lock and pool-value rule as a wallet");
}
