//! Authorization of the two new admin-signed deposits - `init` and the first `add` into an emptied pool - and the
//! sighash the covenant's checkSig covers. Freshly compiled pool.ag through the real engine.
//!
//!   tools/rust.sh bridge/kaspa cargo test --test pool_admin_deposits -- --nocapture
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
    tx::{CovenantBinding, MutableTransaction, Transaction, TransactionOutpoint, UtxoEntry},
};
use secp256k1::Keypair;

const MIN_LIQUIDITY: i64 = 1_000;
const MAX_OPERAND: i64 = (1 << 61) - 1;
const KAS: i64 = 100_000_000;
const USDT: i64 = 1_000_000;
const BASE: i64 = KAS;
const TOKEN_SOMPI: u64 = 100_000_000;
const POSITION_SOMPI: u64 = 50_000_000;
const MAX_OUT_BPS: i64 = 1_000;
const WINDOW: i64 = 36_000;
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
    A.get_or_init(|| kusdt_kaspa::build_contract("kusdt.ag", "test-pool-admin-deposits-kusdt").expect("kUSDT compiles"))
}
fn pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("pool.ag", "test-pool-admin-deposits").expect("pool compiles"))
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

/// An `add` into an emptied pool (total_shares == MIN_LIQUIDITY). `witness` builds the
/// admin_witness from the built tx and the pool input index. `position_owner` lets the caller
/// redirect the minted position (to test sighash coverage).
#[allow(clippy::too_many_arguments)]
fn build_emptied_add(
    fx: &Fx,
    kas_in: i64,
    tokens_in: i64,
    shares: i64,
    age: i64,
    position_owner: &Keypair,
    witness: impl Fn(&MutableTransaction<Transaction>, usize) -> Vec<u8> + 'static,
) -> Result<Transaction, Rejected> {
    let p = &fx.p;
    // Emptied add: reference := new reserve, breaker settled (here out stays, dust ref).
    let next_x = p.x + kas_in;
    let next = Ps { x: next_x, y: p.y + tokens_in, s: p.s + shares, pk: p.pk, pt: p.pt, credit: p.credit, rf: next_x, out: p.out, paused: p.paused };
    let held = tokens_in + 1;
    let provider = key(0xab);
    let change = user_state(&provider, held - tokens_in);
    let (p_out, p_utxo) = fx.token_utxo(user_state(&provider, held));
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out), change.clone()];
    let provider_key = provider;
    let owner = xonly(position_owner).to_vec();
    let change_arg = change.clone();
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("add").args_with(move |tx, i| args!(kas_in, shares, age, owner.clone(), change_arg.clone(), witness(tx, i))), fx.pool.0, fx.pool.1.clone(), age.max(0) as u64)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .actor_input("kusdt::KCC20", user_state(&provider, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &provider_key))), p_out, p_utxo.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("Position", position_state(shares, position_owner), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let tx = fx.builder.build(&ctx).map_err(classify)?;
    common::run(tx, vec![fx.pool.1.clone(), fx.reserve.1.clone(), p_utxo, funding()])
}

/// Like `build_emptied_add` but with a caller-supplied provider UTXO, so a test can re-run the raw
/// tx after tampering with an output.
#[allow(clippy::too_many_arguments)]
fn build_emptied_add_with_provider(
    fx: &Fx,
    kas_in: i64,
    tokens_in: i64,
    shares: i64,
    position_owner: &Keypair,
    provider: &Keypair,
    p_out: TransactionOutpoint,
    p_utxo: UtxoEntry,
    witness: impl Fn(&MutableTransaction<Transaction>, usize) -> Vec<u8> + 'static,
) -> Result<Transaction, Rejected> {
    let p = &fx.p;
    let next_x = p.x + kas_in;
    let next = Ps { x: next_x, y: p.y + tokens_in, s: p.s + shares, pk: p.pk, pt: p.pt, credit: p.credit, rf: next_x, out: p.out, paused: p.paused };
    let held = tokens_in + 1;
    let change = user_state(provider, held - tokens_in);
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out), change.clone()];
    let provider_key = *provider;
    let owner = xonly(position_owner).to_vec();
    let change_arg = change.clone();
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("add").args_with(move |tx, i| args!(kas_in, shares, 0i64, owner.clone(), change_arg.clone(), witness(tx, i))), fx.pool.0, fx.pool.1.clone(), 0)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .actor_input("kusdt::KCC20", user_state(provider, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &provider_key))), p_out, p_utxo.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("Position", position_state(shares, position_owner), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let tx = fx.builder.build(&ctx).map_err(classify)?;
    common::run(tx, vec![fx.pool.1.clone(), fx.reserve.1.clone(), p_utxo, funding()])
}

/// An ordinary `add` into a non-emptied pool, carrying `witness` as admin_witness (empty = honest).
fn build_ordinary_add(fx: &Fx, kas_in: i64, tokens_in: i64, shares: i64, age: i64, witness: Vec<u8>) -> Result<Transaction, Rejected> {
    let p = &fx.p;
    let next = Ps { x: p.x + kas_in, y: p.y + tokens_in, s: p.s + shares, pk: p.pk, pt: p.pt, credit: p.credit, rf: p.rf, out: p.out, paused: p.paused };
    let held = tokens_in + 1;
    let provider = key(0xac);
    let change = user_state(&provider, held - tokens_in);
    let (p_out, p_utxo) = fx.token_utxo(user_state(&provider, held));
    let reserve_out = next.y + next.pt;
    let next_states = vec![reserve_state(reserve_out), change.clone()];
    let provider_key = provider;
    let ctx = TxContext::new()
        .actor_input("Pool", pool_state(p, xonly(&fx.admin), xonly(&fx.guardian)), EntryCall::new("add").args(args!(kas_in, shares, age, xonly(&provider).to_vec(), change.clone(), witness.clone())), fx.pool.0, fx.pool.1.clone(), age.max(0) as u64)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(next_states.clone(), vec![0x00u8])), fx.reserve.0, fx.reserve.1.clone(), 0)
        .actor_input("kusdt::KCC20", user_state(&provider, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &provider_key))), p_out, p_utxo.clone(), 0)
        .input(fx.fresh(), funding(), funding_sig(), 0)
        .actor_output("Pool", pool_state(&next, xonly(&fx.admin), xonly(&fx.guardian)), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), pool_value(&next))
        .actor_output("Position", position_state(shares, &provider), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let tx = fx.builder.build(&ctx).map_err(classify)?;
    common::run(tx, vec![fx.pool.1.clone(), fx.reserve.1.clone(), p_utxo, funding()])
}

/// An emptied pool: dust reserve, only the unowned MIN_LIQUIDITY shares left.
fn emptied(tag: u8) -> Fx {
    Fx::new(Ps { x: 1_000, y: 1_000, s: MIN_LIQUIDITY, pk: 0, pt: 0, credit: 0, rf: 1_000, out: 0, paused: false }, tag)
}

/// The admin-signed reopen of an emptied pool is accepted only with the admin's own signature over
/// THIS transaction. Wrong length, a non-admin key, a signature taken from another input of the same
/// tx, and a signature lifted from a different (earlier) reopen are all refused. An ordinary add that
/// carries any non-empty witness is refused too.
#[test]
fn the_emptied_reopen_needs_the_admins_signature_over_this_tx() {
    let fx = emptied(0x40);
    let admin = fx.admin;
    let outsider = key(0x99);
    let (kas_in, tokens_in, shares) = (1_000 * KAS, 1_000 * USDT, 500);
    let newcomer = key(0xb8);

    // Honest: the admin's signature over this tx's pool input (index 0) - accepted, ref := new reserve.
    let ok = build_emptied_add(&fx, kas_in, tokens_in, shares, 0, &newcomer, move |tx, i| sign_input(tx, i, &admin)).expect("the admin reopens");
    let next = CovenantOutput::from_tx(&ok, 0).unwrap();
    let rf = next.utxo.covenant_id; // sanity: it built; reference checked via engine acceptance of rf = x in pool_state
    let _ = rf;

    // Wrong length: 64 bytes (missing the sighash byte) - byte[65] cast fails.
    script_refuses(build_emptied_add(&fx, kas_in, tokens_in, shares, 0, &newcomer, move |tx, i| { let mut w = sign_input(tx, i, &admin); w.truncate(64); w }), "a reopen witness of 64 bytes");
    // Wrong length: 66 bytes.
    script_refuses(build_emptied_add(&fx, kas_in, tokens_in, shares, 0, &newcomer, move |tx, i| { let mut w = sign_input(tx, i, &admin); w.push(0x00); w }), "a reopen witness of 66 bytes");
    // Empty witness: refused (checkSig over an empty sig).
    script_refuses(build_emptied_add(&fx, kas_in, tokens_in, shares, 0, &newcomer, |_tx, _i| Vec::new()), "a reopen with an empty witness");
    // A non-admin key's valid-length signature.
    script_refuses(build_emptied_add(&fx, kas_in, tokens_in, shares, 0, &newcomer, move |tx, i| sign_input(tx, i, &outsider)), "a reopen signed by a non-admin");
    // The admin's signature, but computed for a DIFFERENT input of the same tx (the provider input, index 2).
    script_refuses(build_emptied_add(&fx, kas_in, tokens_in, shares, 0, &newcomer, move |tx, _i| sign_input(tx, 2, &admin)), "a reopen witness signed for another input index");

    // Replay: the admin's witness from one reopen tx reused in a different reopen tx. Capture the
    // signature the honest build produced (for the pool input of `ok`), then try it verbatim in a
    // fresh reopen (different funding outpoint => different sighash).
    let ok_sig = ok.inputs[0].signature_script.clone();
    // The admin_witness is the only 65-byte push in the pool input's sig script (a sig: 64 + sighash).
    let witness = pushes(&ok_sig).into_iter().find(|p| p.len() == 65).expect("a 65-byte admin_witness push");
    let fx2 = emptied(0x44); // a different pool/outpoints => different sighash
    let reused = witness.clone();
    script_refuses(build_emptied_add(&fx2, kas_in, tokens_in, shares, 0, &newcomer, move |_tx, _i| reused.clone()), "an admin witness replayed from an earlier reopen");

    // An ordinary add (non-emptied pool) that carries a non-empty witness is refused (require length == 0).
    let fx3 = Fx::new(Ps { x: 10_000 * KAS, y: 1_000 * USDT, s: 10_000 * KAS, pk: 0, pt: 0, credit: 0, rf: 10_000 * KAS, out: 0, paused: false }, 0x48);
    let admin3 = fx3.admin;
    let (k2, t2) = (100 * KAS, 10 * USDT);
    let s2 = ((k2 as i128 * fx3.p.s as i128 / fx3.p.x as i128).min(t2 as i128 * fx3.p.s as i128 / fx3.p.y as i128)) as i64;
    build_ordinary_add(&fx3, k2, t2, s2, 0, Vec::new()).expect("an ordinary add with an empty witness");
    let _ = admin3;
    // Any non-empty witness on an ordinary add is refused (require admin_witness.length == 0).
    script_refuses(build_ordinary_add(&fx3, k2, t2, s2, 0, vec![0x07u8]), "an ordinary add carrying a 1-byte witness");
    script_refuses(build_ordinary_add(&fx3, k2, t2, s2, 0, vec![0x00u8; 65]), "an ordinary add carrying a 65-byte witness");
    println!("emptied reopen: only the admin's 65-byte signature over this tx is accepted; wrong length, non-admin, cross-input, replayed, and any ordinary-add witness are refused");
}

/// The admin signature covers this transaction's outputs (SIGHASH_ALL): an attacker cannot take an
/// admin-signed reopen and redirect the minted position to themselves - changing the position owner
/// invalidates the signature.
#[test]
fn the_reopen_signature_covers_the_outputs() {
    let fx = emptied(0x50);
    let attacker = key(0xaa);
    let intended = key(0xb8);
    let (kas_in, tokens_in, shares) = (1_000 * KAS, 1_000 * USDT, 500);
    // Honest admin reopen whose position goes to `intended`; capture the UTXOs it spent so the raw
    // tx can be re-run after a tamper. We rebuild the inputs here to know the provider utxo.
    let provider = key(0xad);
    let held = tokens_in + 1;
    let (p_out, p_utxo) = fx.token_utxo(user_state(&provider, held));
    let admin2 = fx.admin;
    let honest = build_emptied_add_with_provider(&fx, kas_in, tokens_in, shares, &intended, &provider, p_out, p_utxo.clone(), move |tx, i| sign_input(tx, i, &admin2)).expect("honest reopen to the intended owner");
    // Output #1 is the position; replace its script with the attacker-owned position script, keeping
    // the admin signature the honest build committed. SIGHASH_ALL commits to that output, so it fails.
    let mut mutated = honest.clone();
    let attacker_pos_spk = fx.builder.covenant_utxo("Position", position_state(shares, &attacker), POSITION_SOMPI, 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap().script_public_key.clone();
    mutated.outputs[1].script_public_key = attacker_pos_spk;
    script_refuses(common::run(mutated, vec![fx.pool.1.clone(), fx.reserve.1.clone(), p_utxo.clone(), funding()]), "a reopen with the position redirected after signing");
    println!("the reopen signature covers the outputs (SIGHASH_ALL): redirecting the position after signing is refused");
}

/// Every data push in a push-only sig script (opcode stripped).
fn pushes(script: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < script.len() {
        let op = script[i] as usize;
        i += 1;
        let n = if op >= 1 && op <= 0x4b {
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
            // OP_0, OP_1..OP_16, OP_1NEGATE and the like: a one-value push with no inline data.
            out.push(Vec::new());
            continue;
        };
        out.push(script[i..i + n].to_vec());
        i += n;
    }
    out
}
