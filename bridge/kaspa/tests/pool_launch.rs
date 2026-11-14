//! The never-opened pool stays where its genesis put it, and a paused pool takes no second pause (round 11,
//! R11-OWN-1 and COV-2). Freshly compiled pool.ag through the real engine, and the builders through `api::run`.
//!
//! Before the fix anyone could `tick` the pool between its genesis and the admin's `init`: with every counter at zero
//! the script accepted it, the pool moved to a new outpoint, the launch check ("the initial pool is on the node,
//! unspent") failed for every operator, and an `init` the admin had signed offline for the genesis outpoint no longer
//! landed. `tick` now requires an opened pool (`total_shares > 0`). An emptied pool (only the MIN_LIQUIDITY unowned
//! shares left) is an opened pool: its breaker can still be above half of the cap and the keeper must be able to tick.
//!
//!   tools/rust.sh bridge/kaspa cargo test --locked --test pool_launch -- --nocapture

#![allow(dead_code)]

mod common;

use std::sync::OnceLock;

use argent::artifact::Artifact;
use argent_runtime::{ArtifactBundle, EntryCall, TxBuilder, TxContext, args, state};
use common::{Rejected, State, funding, funding_sig, key, outpoint, sign_input, xonly};
use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::{
    Hash,
    tx::{CovenantBinding, Transaction, TransactionOutpoint, UtxoEntry},
};
use kusdt_kaspa::{api, hex};
use secp256k1::Keypair;
use serde_json::{Value, json};

const BPS: i64 = 10_000;
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

#[derive(Clone, Debug)]
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

/// What `pool-genesis` makes: every counter at zero.
const GENESIS: Ps = Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false };

// pool.ag's breaker helpers, to state the successor a tick must leave.
fn share_of(base: i64, bps: i64) -> i64 {
    base / BPS * bps + base % BPS * bps / BPS
}
fn advanced_ref(reference: i64, reserve: i64, elapsed: i64) -> i64 {
    if reserve <= reference {
        return reserve;
    }
    let gap = (reserve - reference).min(reference);
    if elapsed < WINDOW { reference + elapsed * (gap / WINDOW) + elapsed * (gap % WINDOW) / WINDOW } else { reference + gap }
}
fn settled_out(used: i64, elapsed: i64, cap: i64) -> i64 {
    let next = used.max(-cap);
    let decay = elapsed * (cap / WINDOW) + elapsed * (cap % WINDOW) / WINDOW;
    if next > 0 { (next - decay).max(0) } else if next < 0 { (next + decay).min(0) } else { next }
}
fn credit_left(credit: i64, stored: i64, settled: i64) -> i64 {
    if stored < 0 { (credit - (settled - stored)).max(0) } else { credit }
}
fn after_tick(p: &Ps, age: i64) -> Ps {
    let rf = advanced_ref(p.rf, p.x, age);
    let out = settled_out(p.out, age, share_of(rf, MAX_OUT_BPS));
    Ps { rf, out, credit: credit_left(p.credit, p.out, out), ..p.clone() }
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
    A.get_or_init(|| kusdt_kaspa::build_contract("kusdt.ag", "test-pool-launch-kusdt").expect("kUSDT compiles"))
}
fn pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("pool.ag", "test-pool-launch").expect("pool compiles"))
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
    counter: std::cell::Cell<u32>,
    tag: u8,
}
impl Fx {
    fn new(p: Ps, tag: u8) -> Self {
        let (admin, guardian) = (key(0x30), key(0x32));
        let b = builder();
        let pool = b.covenant_utxo("Pool", pool_state(&p, xonly(&admin), xonly(&guardian)), pool_value(&p), 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
        Fx { builder: b, admin, guardian, p, pool: (outpoint(tag, 0), pool), counter: std::cell::Cell::new(0), tag }
    }
    fn fresh(&self) -> TransactionOutpoint {
        let n = self.counter.get();
        self.counter.set(n + 1);
        outpoint(self.tag + 1, n)
    }
    fn state_of(&self, p: &Ps) -> State {
        pool_state(p, xonly(&self.admin), xonly(&self.guardian))
    }
}

/// Anyone's tick claiming `age` (the input's sequence is the claim), leaving `next`. No signature, no kUSDT.
fn tick(fx: &Fx, age: i64, next: &Ps) -> Result<Transaction, Rejected> {
    let ctx = TxContext::new()
        .actor_input("Pool", fx.state_of(&fx.p), EntryCall::new("tick").args(args!(age)), fx.pool.0, fx.pool.1.clone(), age as u64)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", fx.state_of(next), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(next));
    let tx = fx.builder.build(&ctx).map_err(classify)?;
    common::run(tx, vec![fx.pool.1.clone(), funding()])
}

/// A pause signed by `by`, leaving the same state with `paused` set.
fn pause(fx: &Fx, by: &Keypair) -> Result<Transaction, Rejected> {
    let next = Ps { paused: true, ..fx.p.clone() };
    let signer = *by;
    let ctx = TxContext::new()
        .actor_input("Pool", fx.state_of(&fx.p), EntryCall::new("pause").args_with(move |tx, i| args!(sign_input(tx, i, &signer))), fx.pool.0, fx.pool.1.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", fx.state_of(&next), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next));
    let tx = fx.builder.build(&ctx).map_err(classify)?;
    common::run(tx, vec![fx.pool.1.clone(), funding()])
}

/// The admin's (or `signer`'s) key transaction `entry` (unpause), leaving `next`.
fn unpause(fx: &Fx) -> Result<Transaction, Rejected> {
    let next = Ps { paused: false, ..fx.p.clone() };
    let admin = fx.admin;
    let ctx = TxContext::new()
        .actor_input("Pool", fx.state_of(&fx.p), EntryCall::new("unpause").args_with(move |tx, i| args!(sign_input(tx, i, &admin))), fx.pool.0, fx.pool.1.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", fx.state_of(&next), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next));
    let tx = fx.builder.build(&ctx).map_err(classify)?;
    common::run(tx, vec![fx.pool.1.clone(), funding()])
}

/// The admin's first deposit into the pool of `fx` (as tests/pool.rs builds it).
fn init(fx: &Fx, kas_in: i64, tokens_in: i64) -> Result<Transaction, Rejected> {
    let provider = key(0xab);
    let held = tokens_in + 1;
    let provider_utxo = fx.builder.covenant_utxo("kusdt::KCC20", user_state(&provider, held), TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap();
    let change = user_state(&provider, held - tokens_in);
    let next = Ps { x: kas_in, y: tokens_in, s: kas_in, rf: kas_in, ..fx.p.clone() };
    let next_states = vec![reserve_state(tokens_in), change.clone()];
    let (admin, owner, change_arg) = (fx.admin, xonly(&provider).to_vec(), change.clone());
    let ctx = TxContext::new()
        .actor_input("Pool", fx.state_of(&fx.p), EntryCall::new("init").args_with(move |tx, i| args!(kas_in, owner.clone(), change_arg.clone(), sign_input(tx, i, &admin))), fx.pool.0, fx.pool.1.clone(), 0)
        .actor_input(
            "kusdt::KCC20",
            user_state(&provider, held),
            EntryCall::new("transfer").args_with(move |tx, i| {
                let mut w = vec![0x00];
                w.extend(sign_input(tx, i, &provider));
                args!(next_states.clone(), w)
            }),
            fx.fresh(),
            provider_utxo.clone(),
            0,
        )
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", fx.state_of(&next), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("Position", position_state(kas_in - MIN_LIQUIDITY, &provider), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
        .actor_output("kusdt::KCC20", reserve_state(tokens_in), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let tx = fx.builder.build(&ctx).map_err(classify)?;
    common::run(tx, vec![fx.pool.1.clone(), provider_utxo, funding()])
}

/// R11-OWN-1. The pool between its genesis and the admin's first deposit: nobody's tick spends it, at any age the
/// entry takes, so it stays at its genesis outpoint; the admin's init signed for that outpoint is accepted.
#[test]
fn a_tick_of_a_never_opened_pool_is_refused_and_the_init_still_lands() {
    let fx = Fx::new(GENESIS, 0x40);
    // With every counter at zero the successor a tick would leave is the same state.
    assert_eq!(format!("{:?}", after_tick(&GENESIS, MIN_AGE)), format!("{GENESIS:?}"));
    for age in [MIN_AGE, MIN_AGE + 1, WINDOW, 2 * WINDOW] {
        script_refuses(tick(&fx, age, &GENESIS), &format!("a tick of the never-opened pool claiming {age}"));
    }
    // Paused by the guardian right after genesis it takes no tick either (as before).
    let paused = Fx::new(Ps { paused: true, ..GENESIS }, 0x44);
    script_refuses(tick(&paused, MIN_AGE, &paused.p), "a tick of the never-opened pool while paused");
    // The admin's first deposit on the genesis outpoint: accepted, as before.
    init(&fx, 10_000 * KAS, 1_000 * USDT).expect("the admin's init on the genesis pool");
    println!("never-opened pool: ticks claiming {MIN_AGE} to {} DAA are refused by the script; the admin's init is accepted", 2 * WINDOW);
}

/// What the fix must not break: a tick of an opened pool, and of an emptied one (total_shares == MIN_LIQUIDITY), whose
/// breaker can still be above half of the cap and needs the keeper. Under the minimum age and above two windows it is
/// refused as before.
#[test]
fn a_tick_of_an_opened_pool_and_of_an_emptied_pool_is_accepted_as_before() {
    // Opened: 10 000 KAS, three quarters of the cap in use.
    let x = 10_000 * KAS;
    let cap = share_of(x, MAX_OUT_BPS);
    let opened = Ps { x, y: 1_000 * USDT, s: x, pk: 7, pt: 3, credit: 0, rf: x, out: cap / 4 * 3, paused: false };
    // Emptied: every provider has left, only the unowned shares and dust remain; 60 of a cap of 100 in use.
    let emptied = Ps { x: MIN_LIQUIDITY, y: MIN_LIQUIDITY, s: MIN_LIQUIDITY, pk: 0, pt: 0, credit: 0, rf: MIN_LIQUIDITY, out: 60, paused: false };
    assert!(emptied.out > share_of(emptied.rf, MAX_OUT_BPS) / 2, "the emptied pool is above half of its cap");
    // One share: the smallest opened pool the condition `total_shares > 0` lets through (no chain state has it, since
    // init leaves more than MIN_LIQUIDITY; it pins the condition to `> 0`, not `> MIN_LIQUIDITY`).
    let one_share = Ps { s: 1, ..emptied.clone() };
    for (name, p, tag) in [("opened", &opened, 0x50u8), ("emptied", &emptied, 0x54), ("one share", &one_share, 0x58)] {
        let fx = Fx::new(p.clone(), tag);
        for age in [MIN_AGE, WINDOW, 2 * WINDOW] {
            let next = after_tick(p, age);
            tick(&fx, age, &next).unwrap_or_else(|e| panic!("a tick of the {name} pool claiming {age}: {e:?}"));
            assert!(next.out < p.out || age == MIN_AGE, "{name}: a tick of {age} DAA settles the count");
        }
        script_refuses(tick(&fx, MIN_AGE - 1, &after_tick(p, MIN_AGE - 1)), &format!("a tick of the {name} pool under the minimum age"));
        script_refuses(tick(&fx, 2 * WINDOW + 1, &after_tick(p, 2 * WINDOW + 1)), &format!("a tick of the {name} pool above two windows"));
        let paused = Fx::new(Ps { paused: true, ..p.clone() }, tag + 2);
        script_refuses(tick(&paused, MIN_AGE, &paused.p), &format!("a tick of the paused {name} pool"));
    }
    // The emptied pool's count really comes down with a tick of a whole window.
    assert_eq!(after_tick(&emptied, WINDOW).out, 0);
    println!("opened, emptied (total_shares == {MIN_LIQUIDITY}) and one-share pools: ticks accepted at {MIN_AGE}, {WINDOW} and {} DAA", 2 * WINDOW);
}

/// COV-2. The guardian's pause is taken once: on a paused pool it is refused, as the minter's is, so a holder of the
/// guardian key cannot keep moving a paused pool's outpoint under a withdrawal or under the admin's unpause or key
/// change. The first pause, and a pause after the admin's unpause, pass as before; so does a pause of the never-opened pool.
#[test]
fn a_pause_of_a_paused_pool_is_refused() {
    let x = 10_000 * KAS;
    let open = Ps { x, y: 1_000 * USDT, s: x, pk: 0, pt: 0, credit: 0, rf: x, out: 0, paused: false };
    let fx = Fx::new(open.clone(), 0x60);
    let guardian = fx.guardian;
    pause(&fx, &guardian).expect("the guardian pauses an open pool");
    script_refuses(pause(&fx, &key(0x77)), "a stranger's pause");
    let paused = Fx::new(Ps { paused: true, ..open.clone() }, 0x64);
    script_refuses(pause(&paused, &guardian), "the guardian's pause of a paused pool");
    script_refuses(pause(&paused, &paused.admin.clone()), "the admin's pause of a paused pool");
    // The admin's unpause of the paused pool passes, and the pool it leaves takes a pause again.
    unpause(&paused).expect("the admin unpauses");
    // Between genesis and init the guardian can still pause (the documented way to hold a pool still), once.
    let genesis = Fx::new(GENESIS, 0x68);
    pause(&genesis, &guardian).expect("the guardian pauses the never-opened pool");
    script_refuses(pause(&Fx::new(Ps { paused: true, ..GENESIS }, 0x6c), &guardian), "a second pause of the never-opened pool");
    println!("pause: accepted on an open pool, refused on a paused one");
}

// --------------------------------------------------------------------------
// The builders (`api::run`): they refuse what the script refuses, in plain words, before anything is sent.

fn call(command: &str, request: Value) -> Value {
    api::run(command, &request.to_string()).unwrap_or_else(|e| panic!("{command}: {e}"))
}
fn secret(k: &Keypair) -> String {
    hex::encode(&k.secret_bytes())
}
fn common_json(payer: &Keypair, n: u8) -> Value {
    let coin = json!({
        "utxo": { "transactionId": hex::encode(&[n; 32]), "index": 0, "amount": 1_000 * KAS, "scriptPublicKey": format!("000020{}ac", hex::encode(&xonly(payer))), "blockDaaScore": 1_000 },
        "secretKey": secret(payer),
    });
    json!({ "network": "mainnet", "changeAddress": Address::new(Prefix::Mainnet, Version::PubKey, &xonly(payer)).to_string(), "funding": [coin] })
}
fn with(mut base: Value, extra: Value) -> Value {
    base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    base
}
/// A pool UTXO holding `state`, accepted at `daa`.
fn pool_at(state: &Value, pool_id: &str, value: i64, daa: u64, n: u8) -> Value {
    let script = call("script", json!({ "actor": "Pool", "state": state }))["scriptPublicKey"].clone();
    json!({ "utxo": { "transactionId": hex::encode(&[n; 32]), "index": 0, "amount": value, "scriptPublicKey": script, "covenantId": pool_id, "blockDaaScore": daa }, "state": state })
}

#[test]
fn the_builders_refuse_a_tick_of_a_never_opened_pool_and_a_second_pause() {
    let (payer, admin, guardian) = (key(200), key(30), key(32));
    let daa = 600_000_000u64;
    let genesis = call("pool-genesis", with(common_json(&payer, 1), json!({
        "tokenCovid": hex::encode(&KUSDT_ID), "baseValue": KAS, "admin": hex::encode(&xonly(&admin)),
        "guardian": hex::encode(&xonly(&guardian)), "maxOutBps": MAX_OUT_BPS, "windowLen": WINDOW,
    })));
    let pool_id = genesis["covenantId"].as_str().unwrap().to_string();
    let state = genesis["outputs"][0]["pool"].clone();
    let pool = json!({
        "utxo": { "transactionId": genesis["txid"], "index": 0, "amount": genesis["outputs"][0]["value"], "scriptPublicKey": genesis["outputs"][0]["scriptPublicKey"], "covenantId": pool_id, "blockDaaScore": daa },
        "state": state,
    });
    // The genesis pool: no tick, at the first DAA the lock would allow or long after.
    for now in [daa + MIN_AGE as u64, daa + WINDOW as u64] {
        let refused = api::run("pool-tick", &with(common_json(&payer, 2), json!({ "pool": pool, "nowDaa": now })).to_string()).expect_err("a tick of the never-opened pool");
        assert!(refused.contains("has not been opened"), "{refused}");
    }
    // An opened and an emptied pool: the tick builds, as before.
    for (shares, reserve) in [(10_000 * KAS, 10_000 * KAS), (MIN_LIQUIDITY, MIN_LIQUIDITY)] {
        let mut s = state.clone();
        for (k, v) in [("kasReserve", reserve), ("tokenReserve", 1_000 * USDT), ("totalShares", shares), ("windowRef", reserve)] {
            s[k] = json!(v);
        }
        let opened = pool_at(&s, &pool_id, KAS + reserve, daa, 3);
        let built = call("pool-tick", with(common_json(&payer, 4), json!({ "pool": opened, "nowDaa": daa + MIN_AGE as u64 })));
        assert_eq!(built["outputs"][0]["pool"]["totalShares"], s["totalShares"]);
    }
    // The guardian's pause: built on the open pool (the never-opened one here), refused on the paused one it leaves.
    let paused = call("pool-pause", with(common_json(&payer, 5), json!({ "pool": pool, "secretKey": secret(&guardian) })));
    let paused_pool = json!({
        "utxo": { "transactionId": paused["txid"], "index": 0, "amount": paused["outputs"][0]["value"], "scriptPublicKey": paused["outputs"][0]["scriptPublicKey"], "covenantId": pool_id, "blockDaaScore": daa + 1 },
        "state": paused["outputs"][0]["pool"],
    });
    assert_eq!(paused_pool["state"]["paused"], json!(true));
    let again = api::run("pool-pause", &with(common_json(&payer, 6), json!({ "pool": paused_pool, "secretKey": secret(&guardian) })).to_string()).expect_err("a pause of a paused pool");
    assert!(again.contains("already paused"), "{again}");
    // The admin's unpause of it still builds.
    call("pool-unpause", with(common_json(&payer, 7), json!({ "pool": paused_pool, "secretKey": secret(&admin) })));
}
