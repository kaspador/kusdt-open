//! The engine's per-entry argument arity against the follower's decoder
//! (bridge/packages/protocol/src/pool-follow.ts), and the followability of a re-spelled age on a money path. An
//! unfollowable spend pauses the whole bridge, so the follower's `a.length` for every entry must equal what the
//! engine actually emits, and the age the covenant uses must be the one the follower decodes for every spelling the
//! engine accepts.
//!
//!   tools/rust.sh bridge/kaspa cargo test --test pool_follower_arity -- --nocapture
//!
//! (From the third review of the branch pool-clock, 2026-11-10, at 5921e93; kept as regression tests.)

#![allow(dead_code)]

mod common;

use std::sync::OnceLock;

use argent::artifact::Artifact;
use argent_runtime::{ArtifactBundle, CovenantOutput, EntryCall, TxBuilder, TxContext, args, state};
use common::{Rejected, State, funding, funding_sig, key, outpoint, sign_input, xonly};
use kaspa_consensus_core::{
    Hash,
    tx::{CovenantBinding, Transaction, TransactionOutpoint, UtxoEntry},
};
use secp256k1::Keypair;

const BPS: i64 = 10_000;
const FEE_BPS: i64 = 50;
const PROTOCOL_BPS: i64 = 5;
const MIN_LIQUIDITY: i64 = 1_000;
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
    A.get_or_init(|| kusdt_kaspa::build_contract("kusdt.ag", "test-pool-follower-arity-kusdt").expect("kUSDT compiles"))
}
fn pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("pool.ag", "test-pool-follower-arity").expect("pool compiles"))
}
fn builder() -> TxBuilder<'static> {
    let bundle = ArtifactBundle::new(pool_artifact()).unwrap().with_artifact(kusdt()).unwrap();
    TxBuilder::from_bundle(&bundle).expect("bundle builder")
}

/// Every data push in a push-only sig script (TS parsePushes equivalent).
fn pushes(script: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < script.len() {
        let op = script[i] as usize;
        i += 1;
        let n = if (1..=0x4b).contains(&op) {
            op
        } else if op == 0x4c {
            let n = script[i] as usize;
            i += 1;
            n
        } else if op == 0x4d {
            let n = script[i] as usize | ((script[i + 1] as usize) << 8);
            i += 2;
            n
        } else if op == 0x4e {
            let n = script[i] as usize | ((script[i + 1] as usize) << 8) | ((script[i + 2] as usize) << 16) | ((script[i + 3] as usize) << 24);
            i += 4;
            n
        } else {
            out.push(Vec::new());
            continue;
        };
        out.push(script[i..i + n].to_vec());
        i += n;
    }
    out
}

/// The follower's `a.length` for a pool input: total pushes minus the entry tag and the redeem script.
fn follower_arg_count(tx: &Transaction) -> usize {
    pushes(&tx.inputs[0].signature_script).len() - 2
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

fn tokens_for(x: i64, y: i64, kas_out: i64) -> i64 {
    let (xi, yi, out) = (x as i128, y as i128, kas_out as i128);
    let eff = yi * out / (xi - out) + 1;
    (eff * BPS as i128 / (BPS - FEE_BPS) as i128 + 2) as i64
}
fn buy_quote(x: i64, y: i64, kas_in: i64) -> i64 {
    let eff = kas_in as i128 * (BPS - FEE_BPS) as i128 / BPS as i128;
    (y as i128 * eff / (x as i128 + eff)) as i64
}

fn run(tx: Transaction, entries: Vec<UtxoEntry>) -> Result<Transaction, Rejected> {
    common::run(tx, entries)
}

/// buy at age 0 (count 0, below half).
fn buy(fx: &Fx) -> (Transaction, Vec<UtxoEntry>) {
    let p = &fx.p;
    let kas_in = 10 * KAS;
    let amount = buy_quote(p.x, p.y, kas_in);
    let cut = kas_in * PROTOCOL_BPS / BPS;
    // count was 0, below half, age 0: out = -(added), credit = added.
    let next = Ps { x: p.x + kas_in - cut, y: p.y - amount, s: p.s, pk: p.pk + cut, pt: p.pt, credit: kas_in - cut, rf: p.rf, out: -(kas_in - cut), paused: p.paused };
    let buyer = key(0xb0);
    let buyer_state = user_state(&buyer, amount);
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out), buyer_state.clone()];
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("buy").args(args!(kas_in, 0i64, buyer_state.clone())), fx.pool.0, fx.pool.1.clone(), 0)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", buyer_state, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    (fx.builder.build(&ctx).expect("buy builds"), vec![fx.pool.1.clone(), fx.reserve.1.clone(), funding()])
}

/// sell (with change) and sell_all share one assembler; `all` picks the entry.
fn sell(fx: &Fx, all: bool, age: i64) -> (Transaction, Vec<UtxoEntry>) {
    let p = &fx.p;
    let kas_out = KAS;
    let tokens_in = tokens_for(p.x, p.y, kas_out);
    let cut = tokens_in * PROTOCOL_BPS / BPS;
    let next_x = p.x - kas_out;
    let next_y = p.y + tokens_in - cut;
    let nref = p.rf.min(p.x).min(next_x);
    let cap = share_of(p.rf, MAX_OUT_BPS);
    let settled = if p.out > 0 { (p.out - (age * (cap / WINDOW) + age * (cap % WINDOW) / WINDOW)).max(0) } else { p.out };
    let next = Ps { x: next_x, y: next_y, s: p.s, pk: p.pk, pt: p.pt + cut, credit: (p.credit - kas_out).max(0), rf: nref, out: settled + kas_out, paused: p.paused };
    let held = if all { tokens_in } else { tokens_in + 5 };
    let seller = key(0xc0);
    let (po, pu) = fx.token_utxo(user_state(&seller, held));
    let reserve_out = next.y + next.pt;
    let change = user_state(&seller, held - tokens_in);
    let next_states: Vec<State> = if all { vec![reserve_state(reserve_out)] } else { vec![reserve_state(reserve_out), change.clone()] };
    let seller_key = seller;
    let call = if all {
        EntryCall::new("sell_all").args(args!(kas_out, age))
    } else {
        EntryCall::new("sell").args(args!(kas_out, age, change.clone()))
    };
    let mut ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), call, fx.pool.0, fx.pool.1.clone(), age.max(0) as u64)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .actor_input("kusdt::KCC20", user_state(&seller, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &seller_key))), po, pu.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    if !all {
        ctx = ctx.actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    }
    (fx.builder.build(&ctx).expect("sell builds"), vec![fx.pool.1.clone(), fx.reserve.1.clone(), pu, funding()])
}

/// add (ordinary, non-emptied) at age 0.
fn add_ordinary(fx: &Fx) -> (Transaction, Vec<UtxoEntry>) {
    let p = &fx.p;
    let kas_in = 100 * KAS;
    let tokens_in = ((kas_in as i128 * p.y as i128 + p.x as i128 - 1) / p.x as i128) as i64;
    let shares = ((kas_in as i128 * p.s as i128 / p.x as i128).min(tokens_in as i128 * p.s as i128 / p.y as i128)) as i64;
    let next = Ps { x: p.x + kas_in, y: p.y + tokens_in, s: p.s + shares, pk: p.pk, pt: p.pt, credit: p.credit, rf: p.rf, out: p.out, paused: p.paused };
    let held = tokens_in + 1;
    let provider = key(0xab);
    let change = user_state(&provider, held - tokens_in);
    let (po, pu) = fx.token_utxo(user_state(&provider, held));
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out), change.clone()];
    let provider_key = provider;
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("add").args(args!(kas_in, shares, 0i64, xonly(&provider).to_vec(), change.clone(), Vec::<u8>::new())), fx.pool.0, fx.pool.1.clone(), 0)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .actor_input("kusdt::KCC20", user_state(&provider, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &provider_key))), po, pu.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("Position", position_state(shares, &provider), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    (fx.builder.build(&ctx).expect("add builds"), vec![fx.pool.1.clone(), fx.reserve.1.clone(), pu, funding()])
}

/// remove at age 0 (below half).
fn remove(fx: &Fx) -> (Transaction, Vec<UtxoEntry>) {
    let p = &fx.p;
    let owner = key(0xd0);
    let shares = 1_000_000i64;
    let kas_out = (shares as i128 * p.x as i128 / p.s as i128) as i64;
    let tokens_out = (shares as i128 * p.y as i128 / p.s as i128) as i64;
    let next = Ps { x: p.x - kas_out, y: p.y - tokens_out, s: p.s - shares, pk: p.pk, pt: p.pt, credit: p.credit, rf: p.rf.min(p.x - kas_out), out: p.out, paused: p.paused };
    let pos = fx.builder.covenant_utxo("Position", position_state(shares, &owner), POSITION_SOMPI, 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
    let pos_out = fx.fresh();
    let receiver = user_state(&owner, tokens_out);
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out), receiver.clone()];
    let owner_key = owner;
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("remove").args(args!(kas_out, 0i64, receiver.clone())), fx.pool.0, fx.pool.1.clone(), 0)
        .actor_input("Position", position_state(shares, &owner), EntryCall::new("redeem").args_with(move |tx, i| args!(sign_input(tx, i, &owner_key))), pos_out, pos.clone(), 0)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(2, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", receiver, CovenantBinding::new(2, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    (fx.builder.build(&ctx).expect("remove builds"), vec![fx.pool.1.clone(), pos, fx.reserve.1.clone()])
}

/// tick claiming min_age.
fn tick(fx: &Fx) -> (Transaction, Vec<UtxoEntry>) {
    let p = &fx.p;
    let age = MIN_AGE;
    // settled: here out small / 0; keep successor fields plausible for a below-half state.
    let next = p.clone();
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("tick").args(args!(age)), fx.pool.0, fx.pool.1.clone(), age as u64)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next));
    (fx.builder.build(&ctx).expect("tick builds"), vec![fx.pool.1.clone(), funding()])
}

/// The engine's per-entry argument count equals the follower's decoder (`a.length`), so every
/// pool spend the engine accepts is one the follower decodes rather than throwing (a throw pauses
/// the bridge). Values from pool-follow.ts: init 13, buy 10, sell 10, sell_all 4, add 15, remove 12, tick 1.
#[test]
fn engine_entry_arities_match_the_follower_decoder() {
    let fx = Fx::new(Ps { x: 10_000 * KAS, y: 1_000 * USDT, s: 10_000 * KAS, pk: 0, pt: 0, credit: 0, rf: 10_000 * KAS, out: 0, paused: false }, 0x40);

    let (b, e) = buy(&fx);
    run(b.clone(), e).expect("buy runs");
    assert_eq!(follower_arg_count(&b), 10, "buy arg count");

    let (s, e) = sell(&fx, false, 0);
    run(s.clone(), e).expect("sell runs");
    assert_eq!(follower_arg_count(&s), 10, "sell arg count");

    let (sa, e) = sell(&fx, true, 0);
    run(sa.clone(), e).expect("sell_all runs");
    assert_eq!(follower_arg_count(&sa), 4, "sell_all arg count");

    let (a, e) = add_ordinary(&fx);
    run(a.clone(), e).expect("add runs");
    assert_eq!(follower_arg_count(&a), 15, "add arg count");

    let (r, e) = remove(&fx);
    run(r.clone(), e).expect("remove runs");
    assert_eq!(follower_arg_count(&r), 12, "remove arg count");

    let (t, e) = tick(&fx);
    run(t.clone(), e).expect("tick runs");
    assert_eq!(follower_arg_count(&t), 1, "tick arg count");

    // init: a fresh pool (total_shares 0) that the first deposit opens.
    let (i, e) = init(&Fx::new(Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false }, 0x48));
    run(i.clone(), e).expect("init runs");
    assert_eq!(follower_arg_count(&i), 13, "init arg count");

    println!("engine arg counts match the follower decoder: init 13, buy 10, sell 10, sell_all 4, add 15, remove 12, tick 1");
}

/// A money-path spend whose `age_daa` is re-spelled by a relay/miner (post-Toccata the engine reads
/// script numbers without the minimal rule) stays followable: the engine accepts it and produces the
/// SAME successor, and a TS-style readScriptNum decodes the re-spelled bytes to the same age. (The
/// follower's spelling test covers tick; this covers a sell, a money path.)
#[test]
fn a_respelled_age_on_a_sell_is_accepted_and_yields_the_same_successor() {
    // A state above half of the cap, so the claim is min_age and the age actually drives the breaker.
    let x = 10_000 * KAS;
    let cap = share_of(x, MAX_OUT_BPS);
    let fx = Fx::new(Ps { x, y: 1_000 * USDT, s: x, pk: 0, pt: 0, credit: 0, rf: x, out: cap / 2 + 1, paused: false }, 0x50);
    let (canonical, entries) = sell(&fx, true, MIN_AGE);
    let base = run(canonical.clone(), entries.clone()).expect("the canonical sell runs");
    let base_pool = CovenantOutput::from_tx(&base, 0).unwrap();

    // The canonical age push (MIN_AGE = 50 = 0x32). Re-spell it with a trailing zero byte (0x32,0x00):
    // the engine deserializes the same value, and readScriptNum decodes the same number.
    let respellings: Vec<Vec<u8>> = vec![vec![0x32, 0x00], vec![0x32, 0x00, 0x00, 0x00]];
    for bytes in respellings {
        assert_eq!(read_script_num(&bytes), MIN_AGE as i128, "readScriptNum decodes the respelling to MIN_AGE");
        let mut tx = canonical.clone();
        respell_age_in_sell_all(&mut tx, &bytes);
        let out = run(tx, entries.clone()).unwrap_or_else(|e| panic!("the engine refused a respelled age {bytes:?}: {e:?}"));
        let pool = CovenantOutput::from_tx(&out, 0).unwrap();
        assert_eq!(pool.utxo.script_public_key, base_pool.utxo.script_public_key, "the successor is identical for the respelled age");
    }
    println!("a respelled age on a sell is accepted and yields the same successor: followable, no bridge pause");
}

/// Replaces the `age_daa` push (the 2nd push: kas_out, age_daa, tag..., redeem) in a sell_all sig script.
fn respell_age_in_sell_all(tx: &mut Transaction, new_age: &[u8]) {
    let script = &tx.inputs[0].signature_script;
    // Rebuild the sig script: push kas_out (unchanged), then the new age push, then the rest unchanged.
    let ps = pushes(script);
    // sell_all args: a[0]=kas_out, a[1]=age; then tag, redeem. Keep all but a[1].
    let mut rebuilt: Vec<u8> = Vec::new();
    for (idx, p) in ps.iter().enumerate() {
        let data = if idx == 1 { new_age.to_vec() } else { p.clone() };
        push_data(&mut rebuilt, &data);
    }
    tx.inputs[0].signature_script = rebuilt;
}

fn push_data(out: &mut Vec<u8>, data: &[u8]) {
    let n = data.len();
    if n == 0 {
        out.push(0x00);
    } else if n <= 0x4b {
        out.push(n as u8);
        out.extend_from_slice(data);
    } else if n <= 0xff {
        out.push(0x4c);
        out.push(n as u8);
        out.extend_from_slice(data);
    } else {
        out.push(0x4d);
        out.push((n & 0xff) as u8);
        out.push((n >> 8) as u8);
        out.extend_from_slice(data);
    }
}

/// A TS-style readScriptNum (little-endian sign-magnitude), mirroring pool-follow's script.ts.
fn read_script_num(bytes: &[u8]) -> i128 {
    if bytes.is_empty() {
        return 0;
    }
    let last = bytes[bytes.len() - 1];
    let mut v: i128 = 0;
    for k in (0..bytes.len()).rev() {
        let b = if k == bytes.len() - 1 { (bytes[k] & 0x7f) as i128 } else { bytes[k] as i128 };
        v = (v << 8) | b;
    }
    if last & 0x80 != 0 { -v } else { v }
}

/// init: the first deposit of a fresh pool (total_shares 0), admin-signed.
fn init(fx: &Fx) -> (Transaction, Vec<UtxoEntry>) {
    let p = &fx.p;
    let kas_in = 10_000 * KAS;
    let provider = key(0xe0);
    let held = 1_000 * USDT;
    let tokens_in = held; // all provided
    let change = user_state(&provider, held - tokens_in);
    let (po, pu) = fx.token_utxo(user_state(&provider, held));
    let next = Ps { x: kas_in, y: tokens_in, s: kas_in, pk: 0, pt: 0, credit: 0, rf: kas_in, out: 0, paused: false };
    let reserve_out = tokens_in + p.pt;
    let next_states = vec![reserve_state(reserve_out), change.clone()];
    let provider_key = provider;
    let admin = fx.admin;
    let owner = xonly(&provider).to_vec();
    let change_arg = change.clone();
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("init").args_with(move |tx, i| args!(kas_in, owner.clone(), change_arg.clone(), sign_input(tx, i, &admin))), fx.pool.0, fx.pool.1.clone(), 0)
        .actor_input("kusdt::KCC20", user_state(&provider, held), EntryCall::new("transfer").args_with(move |tx, i| { let mut w = vec![0x00u8]; w.extend(sign_input(tx, i, &provider_key)); args!(next_states.clone(), w) }), po, pu.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("Position", position_state(kas_in - MIN_LIQUIDITY, &provider), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    (fx.builder.build(&ctx).expect("init builds"), vec![fx.pool.1.clone(), pu, funding()])
}
