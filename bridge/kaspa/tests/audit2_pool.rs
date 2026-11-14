//! Audit of KasPool: findings proved in the Kaspa script engine.
//!
//! Every transaction below is run input by input by the covenant-enabled engine
//! at a single DAA score, so the circuit breaker's clock (the pool UTXO's age)
//! never advances.

#![allow(dead_code)]

mod common;

use std::sync::OnceLock;

use argent::artifact::Artifact;
use argent_runtime::{ArtifactBundle, CovenantOutput, EntryCall, TxBuilder, TxContext, args, state};
use common::{Rejected, State, funding, funding_sig, key, outpoint, sign_input, xonly};
use kaspa_consensus_core::{
    Hash,
    tx::{CovenantBinding, Transaction, UtxoEntry},
};
use secp256k1::Keypair;

const BPS: i128 = 10_000;
const FEE_BPS: i128 = 50;
const PROTOCOL_BPS: i128 = 5;
const MIN_LIQUIDITY: i64 = 1_000;
const KAS: i64 = 100_000_000;
const USDT: i64 = 1_000_000;
const BASE: i64 = KAS;
const TOKEN_SOMPI: u64 = 100_000_000;
const POSITION_SOMPI: u64 = 50_000_000;
const MAX_OUT_BPS: i64 = 1_000;
const WINDOW: i64 = 36_000;
const START_DAA: i64 = 5_000_000;
/// While more than half of the cap is in use, every public entry claims at least window / 720: 50 DAA.
const MIN_AGE: i64 = WINDOW / 720;

const KUSDT_ID: [u8; 32] = [0x11; 32];
const POOL_ID: [u8; 32] = [0x22; 32];

fn kusdt() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("kusdt.ag", "test-audit2-pool-kusdt").expect("kUSDT compiles"))
}

fn pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("pool.ag", "test-audit2-pool").expect("pool compiles"))
}

fn builder() -> TxBuilder<'static> {
    let bundle = ArtifactBundle::new(pool_artifact()).unwrap().with_artifact(kusdt()).unwrap();
    TxBuilder::from_bundle(&bundle).expect("bundle builder")
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

fn user_state(key: &Keypair, amount: i64) -> State {
    token_state(xonly(key), 0x00, amount)
}

fn reserve_state(amount: i64) -> State {
    token_state(POOL_ID, 0x04, amount)
}

#[derive(Clone, Debug, PartialEq)]
struct PoolState {
    kas_reserve: i64,
    token_reserve: i64,
    total_shares: i64,
    protocol_kas: i64,
    protocol_tokens: i64,
    admin: [u8; 32],
    window_credit: i64,
    window_ref: i64,
    window_out: i64,
    paused: bool,
    guardian: [u8; 32],
}

impl PoolState {
    fn state(&self) -> State {
        state! {
            token_covid: KUSDT_ID.to_vec(),
            kas_reserve: self.kas_reserve,
            token_reserve: self.token_reserve,
            total_shares: self.total_shares,
            protocol_kas: self.protocol_kas,
            protocol_tokens: self.protocol_tokens,
            base_value: BASE,
            admin: self.admin.to_vec(),
            max_out_bps: MAX_OUT_BPS,
            window_len: WINDOW,
            window_credit: self.window_credit,
            window_ref: self.window_ref,
            window_out: self.window_out,
            paused: self.paused,
            guardian: self.guardian.to_vec()
        }
    }
    fn value(&self) -> u64 {
        (BASE + self.kas_reserve + self.protocol_kas) as u64
    }
}

fn position_state(shares: i64, owner: &Keypair) -> State {
    state! { token_covid: KUSDT_ID.to_vec(), shares: shares, owner: xonly(owner).to_vec() }
}

fn buy_quote(x: i64, y: i64, kas_in: i64) -> i64 {
    let eff = kas_in as i128 * (BPS - FEE_BPS) / BPS;
    (y as i128 * eff / (x as i128 + eff)) as i64
}

fn share(base: i64) -> i64 {
    (base as i128 * MAX_OUT_BPS as i128 / BPS) as i64
}
/// The minimum claim's condition: more than half of the stored cap in use.
fn in_regime(s: &PoolState) -> bool {
    s.window_out > share(s.window_ref) / 2
}
fn advance(window_ref: i64, x: i64, elapsed: i64) -> i64 {
    if x <= window_ref {
        return x;
    }
    let gap = (x - window_ref).min(window_ref);
    if elapsed < WINDOW { window_ref + (gap as i128 * elapsed as i128 / WINDOW as i128) as i64 } else { window_ref + gap }
}
fn settle(used: i64, elapsed: i64, cap: i64) -> i64 {
    let used = used.max(-cap);
    let decay = (elapsed as i128 * cap as i128 / WINDOW as i128) as i64;
    if used > 0 { (used - decay).max(0) } else { (used + decay).min(0) }
}
fn window_after(window_ref: i64, used: i64, x: i64, kas_out: i64, elapsed: i64) -> (i64, i64, i64) {
    let reference = advance(window_ref, x, elapsed);
    let cap = share(reference);
    (reference.min(x - kas_out), settle(used, elapsed, cap) + kas_out, cap)
}
fn credit_left(credit: i64, stored: i64, settled: i64) -> i64 {
    if stored < 0 { (credit - (settled - stored)).max(0) } else { credit }
}
fn after_buy(window_ref: i64, used: i64, credit: i64, x: i64, added: i64, elapsed: i64) -> (i64, i64, i64) {
    let reference = advance(window_ref, x, elapsed);
    let cap = share(reference);
    let settled = settle(used, elapsed, cap);
    let next = (settled - added).max(-cap);
    (reference, next, credit_left(credit, used, settled) + (settled - next))
}
fn cap_left(s: &PoolState, elapsed: i64) -> i64 {
    let (_, out, cap) = window_after(s.window_ref, s.window_out, s.kas_reserve, 0, elapsed);
    (cap - out).max(0)
}
/// (reference, used, credit) after `elapsed` DAA of claimed time and nothing else (a tick; the first step of add and remove).
fn settled_breaker(s: &PoolState, elapsed: i64) -> (i64, i64, i64) {
    let reference = advance(s.window_ref, s.kas_reserve, elapsed);
    let used = settle(s.window_out, elapsed, share(reference));
    (reference, used, credit_left(s.window_credit, s.window_out, used))
}

/// Least tokens whose sell quote pays at least `kas_out`.
fn tokens_for(x: i64, y: i64, kas_out: i64) -> i64 {
    let (x, y, out) = (x as i128, y as i128, kas_out as i128);
    let eff = y * out / (x - out) + 1;
    (eff * BPS / (BPS - FEE_BPS) + 2) as i64
}

/// The buy input that adds exactly `added` KAS to the reserve after the protocol's cut.
fn kas_in_for(added: i64) -> i64 {
    (added as i128 * BPS / (BPS - PROTOCOL_BPS) + 1) as i64
}

struct Harness {
    builder: TxBuilder<'static>,
    state: PoolState,
    pool: (kaspa_consensus_core::tx::TransactionOutpoint, UtxoEntry),
    reserve: Option<(kaspa_consensus_core::tx::TransactionOutpoint, UtxoEntry, i64)>,
    next_outpoint: std::cell::Cell<u32>,
    now: i64,
    pool_daa: i64,
}

fn rejected(e: argent_runtime::BuilderError) -> Rejected {
    match e {
        argent_runtime::BuilderError::InputScript { .. } | argent_runtime::BuilderError::TxScript(_) => Rejected::Script(e.to_string()),
        other => Rejected::Build(other.to_string()),
    }
}

fn run(tx: Transaction, entries: Vec<UtxoEntry>) -> Result<Transaction, Rejected> {
    common::run(tx, entries)
}

impl Harness {
    fn new() -> Self {
        let builder = builder();
        let state = PoolState {
            kas_reserve: 0, token_reserve: 0, total_shares: 0, protocol_kas: 0, protocol_tokens: 0, admin: xonly(&key(0x30)),
            window_credit: 0, window_ref: 0, window_out: 0, paused: false, guardian: xonly(&key(0x32)),
        };
        let utxo = builder.covenant_utxo("Pool", state.state(), state.value(), 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
        Self { builder, state, pool: (outpoint(0x40, 0), utxo), reserve: None, next_outpoint: std::cell::Cell::new(0), now: START_DAA, pool_daa: START_DAA }
    }

    fn fresh_outpoint(&self) -> kaspa_consensus_core::tx::TransactionOutpoint {
        let n = self.next_outpoint.get();
        self.next_outpoint.set(n + 1);
        outpoint(0x41, n)
    }

    fn token_utxo(&self, state: State) -> (kaspa_consensus_core::tx::TransactionOutpoint, UtxoEntry) {
        let utxo = self.builder.covenant_utxo("kusdt::KCC20", state, TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap();
        (self.fresh_outpoint(), utxo)
    }

    fn adopt(&mut self, tx: &Transaction, next: PoolState, reserve_index: u32, reserve_amount: i64) {
        let pool = CovenantOutput::from_tx(tx, 0).unwrap();
        let reserve = CovenantOutput::from_tx(tx, reserve_index).unwrap();
        self.pool = (pool.outpoint, pool.utxo);
        self.reserve = Some((reserve.outpoint, reserve.utxo, reserve_amount));
        self.state = next;
        self.pool_daa = self.now;
    }

    fn age(&self) -> i64 {
        (self.now - self.pool_daa).clamp(0, 2 * WINDOW)
    }

    /// Every party waits until the pool UTXO is old enough for the least claim: MIN_AGE while more than half the cap is in use.
    fn ready(&mut self) {
        if in_regime(&self.state) && self.age() < MIN_AGE {
            self.now = self.pool_daa + MIN_AGE;
        }
    }

    fn init(&mut self, provider: &Keypair, held: i64, kas_in: i64, tokens_in: i64) -> Result<CovenantOutput, Rejected> {
        let (p_out, p_utxo) = self.token_utxo(user_state(provider, held));
        let change = user_state(provider, held - tokens_in);
        let next = PoolState { kas_reserve: kas_in, token_reserve: tokens_in, total_shares: kas_in, window_ref: kas_in, ..self.state.clone() };
        let provider_key = *provider;
        let next_states = vec![reserve_state(tokens_in), change.clone()];
        let ctx = TxContext::new()
            .actor_input("Pool", self.state.state(), { let (a0, a1, a2, admin) = (kas_in, xonly(provider).to_vec(), change.clone(), key(0x30)); EntryCall::new("init").args_with(move |tx, i| args!(a0, a1.clone(), a2.clone(), sign_input(tx, i, &admin))) }, self.pool.0, self.pool.1.clone(), 0)
            .actor_input("kusdt::KCC20", user_state(provider, held), EntryCall::new("transfer").args_with(move |tx, i| {
                let mut w = vec![0x00];
                w.extend(sign_input(tx, i, &provider_key));
                args!(next_states.clone(), w)
            }), p_out, p_utxo.clone(), 0)
            .input(self.fresh_outpoint(), funding(), funding_sig(), 0)
            .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
            .actor_output("Position", position_state(kas_in - MIN_LIQUIDITY, provider), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
            .actor_output("kusdt::KCC20", reserve_state(tokens_in), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), p_utxo, funding()])?;
        let position = CovenantOutput::from_tx(&tx, 1).unwrap();
        self.adopt(&tx, next, 2, tokens_in);
        Ok(position)
    }

    fn reserve_input<'a>(&self, next_states: Vec<State>) -> (kaspa_consensus_core::tx::TransactionOutpoint, UtxoEntry, State, EntryCall<'a>) {
        let (out, utxo, amount) = self.reserve.clone().expect("pool initialized");
        (out, utxo, reserve_state(amount), EntryCall::new("transfer").args(args!(next_states, vec![0x00u8])))
    }

    fn buy(&mut self, buyer: &Keypair, kas_in: i64, out: i64) -> Result<(), Rejected> {
        self.ready();
        let s = self.state.clone();
        let cut = (kas_in as i128 * PROTOCOL_BPS / BPS) as i64;
        let elapsed = self.age();
        let (window_ref, window_out, window_credit) = after_buy(s.window_ref, s.window_out, s.window_credit, s.kas_reserve, kas_in - cut, elapsed);
        let next = PoolState { kas_reserve: s.kas_reserve + kas_in - cut, token_reserve: s.token_reserve - out, protocol_kas: s.protocol_kas + cut, window_credit, window_ref, window_out, ..s.clone() };
        let reserve_out = next.token_reserve + next.protocol_tokens;
        let buyer_state = user_state(buyer, out);
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(vec![reserve_state(reserve_out), buyer_state.clone()]);
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new("buy").args(args!(kas_in, elapsed, buyer_state.clone())), self.pool.0, self.pool.1.clone(), elapsed as u64)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .input(self.fresh_outpoint(), funding(), funding_sig(), 0)
            .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", buyer_state, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), r_utxo, funding()])?;
        self.adopt(&tx, next, 1, reserve_out);
        Ok(())
    }

    fn try_sell(&self, seller: &Keypair, held: i64, tokens_in: i64, kas_out: i64) -> Result<(Transaction, PoolState, i64), Rejected> {
        let elapsed = self.age();
        let s = &self.state;
        let cut = (tokens_in as i128 * PROTOCOL_BPS / BPS) as i64;
        let (window_ref, window_out, cap) = window_after(s.window_ref, s.window_out, s.kas_reserve, kas_out, elapsed);
        let window_credit = (credit_left(s.window_credit, s.window_out, settle(s.window_out, elapsed, cap)) - kas_out).max(0);
        let next = PoolState {
            kas_reserve: s.kas_reserve - kas_out,
            token_reserve: s.token_reserve + tokens_in - cut,
            protocol_tokens: s.protocol_tokens + cut,
            window_credit,
            window_ref,
            window_out,
            ..s.clone()
        };
        let reserve_out = next.token_reserve + next.protocol_tokens;
        let change = user_state(seller, held - tokens_in);
        let (p_out, p_utxo) = self.token_utxo(user_state(seller, held));
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(vec![reserve_state(reserve_out), change.clone()]);
        let seller_key = *seller;
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new("sell").args(args!(kas_out, elapsed, change.clone())), self.pool.0, self.pool.1.clone(), elapsed as u64)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .actor_input("kusdt::KCC20", user_state(seller, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &seller_key))), p_out, p_utxo.clone(), 0)
            .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), r_utxo, p_utxo])?;
        Ok((tx, next, reserve_out))
    }

    fn sell(&mut self, seller: &Keypair, held: i64, tokens_in: i64, kas_out: i64) -> Result<(), Rejected> {
        self.ready();
        let (tx, next, reserve_out) = self.try_sell(seller, held, tokens_in, kas_out)?;
        self.adopt(&tx, next, 1, reserve_out);
        Ok(())
    }

    fn add(&mut self, provider: &Keypair, held: i64, kas_in: i64, tokens_in: i64, shares: i64) -> Result<CovenantOutput, Rejected> {
        self.ready();
        let s = self.state.clone();
        let elapsed = self.age();
        let (window_ref, window_out, window_credit) = settled_breaker(&s, elapsed);
        let next = PoolState { kas_reserve: s.kas_reserve + kas_in, token_reserve: s.token_reserve + tokens_in, total_shares: s.total_shares + shares, window_ref, window_out, window_credit, ..s.clone() };
        let reserve_out = next.token_reserve + next.protocol_tokens;
        let change = user_state(provider, held - tokens_in);
        let (p_out, p_utxo) = self.token_utxo(user_state(provider, held));
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(vec![reserve_state(reserve_out), change.clone()]);
        let provider_key = *provider;
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new("add").args(args!(kas_in, shares, elapsed, xonly(provider).to_vec(), change.clone(), Vec::<u8>::new())), self.pool.0, self.pool.1.clone(), elapsed as u64)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .actor_input("kusdt::KCC20", user_state(provider, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &provider_key))), p_out, p_utxo.clone(), 0)
            .input(self.fresh_outpoint(), funding(), funding_sig(), 0)
            .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
            .actor_output("Position", position_state(shares, provider), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), r_utxo, p_utxo, funding()])?;
        let position = CovenantOutput::from_tx(&tx, 1).unwrap();
        self.adopt(&tx, next, 2, reserve_out);
        Ok(position)
    }

    /// Burns `position` for its full share of both reserves; returns (kas_out, tokens_out).
    fn remove(&mut self, position: &CovenantOutput, owner: &Keypair, shares: i64) -> Result<(i64, i64), Rejected> {
        self.ready();
        let s = self.state.clone();
        // While paused a withdrawal claims exactly 0 and nothing settles.
        let elapsed = if s.paused { 0 } else { self.age() };
        let kas_out = (shares as i128 * s.kas_reserve as i128 / s.total_shares as i128) as i64;
        let tokens_out = (shares as i128 * s.token_reserve as i128 / s.total_shares as i128) as i64;
        // Settled first, as a swap: then the reclaim, and a pool shrunk below the reference cut to two of its caps.
        let (reference, used, credit) = if s.paused { (s.window_ref, s.window_out, s.window_credit) } else { settled_breaker(&s, elapsed) };
        let reclaimed = kas_out.min(credit);
        let x = s.kas_reserve - kas_out;
        let (next_ref, next_out) = if x < reference { (x, (used + reclaimed).min(2 * share(x))) } else { (reference, used + reclaimed) };
        let next = PoolState { kas_reserve: x, token_reserve: s.token_reserve - tokens_out, total_shares: s.total_shares - shares, window_ref: next_ref, window_credit: credit - reclaimed, window_out: next_out, ..s.clone() };
        let reserve_out = next.token_reserve + next.protocol_tokens;
        let receiver = user_state(owner, tokens_out);
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(vec![reserve_state(reserve_out), receiver.clone()]);
        let signer = *owner;
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new("remove").args(args!(kas_out, elapsed, receiver.clone())), self.pool.0, self.pool.1.clone(), elapsed as u64)
            .actor_input("Position", position_state(shares, owner), EntryCall::new("redeem").args_with(move |tx, i| args!(sign_input(tx, i, &signer))), position.outpoint, position.utxo.clone(), 0)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(2, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", receiver, CovenantBinding::new(2, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), position.utxo.clone(), r_utxo])?;
        self.adopt(&tx, next, 1, reserve_out);
        Ok((kas_out, tokens_out))
    }
}

/// The honest provider's claim on the KAS reserve.
fn claim(h: &Harness, shares: i64) -> i64 {
    (shares as i128 * h.state.kas_reserve as i128 / h.state.total_shares as i128) as i64
}

/// Adds `kas_add` at the pool's own ratio; returns the position and its shares.
fn add_at_ratio(h: &mut Harness, who: &Keypair, kas_add: i64) -> (CovenantOutput, i64) {
    let s = h.state.clone();
    let tokens_add = ((kas_add as i128 * s.token_reserve as i128 + s.kas_reserve as i128 - 1) / s.kas_reserve as i128) as i64;
    let shares = ((kas_add as i128 * s.total_shares as i128 / s.kas_reserve as i128).min(tokens_add as i128 * s.total_shares as i128 / s.token_reserve as i128)) as i64;
    (h.add(who, tokens_add + 1, kas_add, tokens_add, shares).expect("add"), shares)
}

fn buy_adding(h: &mut Harness, who: &Keypair, added: i64) {
    let kas_in = kas_in_for(added);
    let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in);
    h.buy(who, kas_in, got).expect("buy");
}

fn sell_kas(h: &mut Harness, who: &Keypair, kas_out: i64) {
    let tokens = tokens_for(h.state.kas_reserve, h.state.token_reserve, kas_out);
    h.sell(who, tokens + 1, tokens, kas_out).expect("sell");
}

const HONEST_SHARES: i64 = 10_000 * KAS - MIN_LIQUIDITY;

fn seeded() -> (Harness, Keypair, Keypair) {
    let mut h = Harness::new();
    let (honest, attacker) = (key(0xa1), key(0xf0));
    h.init(&honest, 5_000 * USDT, 10_000 * KAS, 1_000 * USDT).expect("init");
    (h, honest, attacker)
}

/// The audit's attack: add `depth`× the reserve, buy to reset the breaker, take the
/// liquidity and the bought KAS back out, sell all the room. Every step claims the least it
/// may, so the only time that passes is what the rule forces. Returns the honest claim before
/// and after, and the DAA that passed.
fn recycle(depth: i64, cycles: usize) -> (i64, i64, i64) {
    let (mut h, _, attacker) = seeded();
    let start = claim(&h, HONEST_SHARES);
    let t0 = h.now;
    for cycle in 0..cycles {
        let (position, shares) = { let kas = depth * h.state.kas_reserve; add_at_ratio(&mut h, &attacker, kas) };
        let need = h.state.window_out.max(0) + 2 * share(h.state.window_ref);
        buy_adding(&mut h, &attacker, need);
        assert_eq!(h.state.window_out, -share(h.state.window_ref), "cycle {cycle}: the buy fills the credit");
        h.remove(&position, &attacker, shares).expect("remove always goes through");
        assert_eq!(h.state.window_credit, 0, "cycle {cycle}: the withdrawal took the buy's credit back");
        h.ready();
        let room = cap_left(&h.state, h.age());
        if room > 0 {
            sell_kas(&mut h, &attacker, room);
        }
    }
    (start, claim(&h, HONEST_SHARES), h.now - t0)
}

/// One cap of the honest pool plus the refill of `elapsed` DAA, and 1 KAS of rounding.
fn bound_for(elapsed: i64) -> i64 {
    let cap = share(10_000 * KAS);
    cap + (cap as i128 * elapsed as i128 / WINDOW as i128) as i64 + KAS
}

/// Withdrawing liquidity takes back the credit a buy paid for with it: the cycle that
/// drained 94 % of a pool at one DAA score now stops at one cap.
#[test]
fn recycled_liquidity_leaves_no_room() {
    for depth in [1, 5] {
        let (start, end, elapsed) = recycle(depth, 16);
        println!("depth {depth}: honest claim {} -> {} KAS in {elapsed} DAA of forced claims", start / KAS, end / KAS);
        assert!(start - end <= bound_for(elapsed), "depth {depth}: honest provider lost {} (bound {})", start - end, bound_for(elapsed));
    }
}

/// The order that keeps the credit alive past the sell: add, buy, sell, then remove.
/// The sell lands on a pool the attacker mostly owns, so the attacker pays for most of it.
#[test]
fn selling_before_the_withdrawal_gains_nothing() {
    let (mut h, _, attacker) = seeded();
    let start = claim(&h, HONEST_SHARES);
    let t0 = h.now;
    for _ in 0..16 {
        let (position, shares) = { let kas = 5 * h.state.kas_reserve; add_at_ratio(&mut h, &attacker, kas) };
        let need = h.state.window_out.max(0) + 2 * share(h.state.window_ref);
        buy_adding(&mut h, &attacker, need);
        h.ready();
        let room = cap_left(&h.state, h.age());
        sell_kas(&mut h, &attacker, room);
        h.remove(&position, &attacker, shares).expect("remove");
    }
    let lost = start - claim(&h, HONEST_SHARES);
    assert!(lost <= bound_for(h.now - t0), "lost {lost}, bound {}", bound_for(h.now - t0));
}

/// Taking the liquidity out in pieces must reclaim as much as taking it out at once.
#[test]
fn withdrawing_in_pieces_reclaims_the_same() {
    let (mut h, _, attacker) = seeded();
    let cap = share(10_000 * KAS);
    let (a, a_shares) = add_at_ratio(&mut h, &attacker, 10_000 * KAS);
    let (b, b_shares) = add_at_ratio(&mut h, &attacker, 10_000 * KAS);
    buy_adding(&mut h, &attacker, cap);
    assert_eq!(h.state.window_credit, cap);
    h.remove(&a, &attacker, a_shares).expect("remove");
    h.remove(&b, &attacker, b_shares).expect("remove");
    assert_eq!(h.state.window_credit, 0);
    assert_eq!(h.state.window_out, 0, "credit and count are back where the buy found them");
}

/// A remove is never refused, even with the allowance already exhausted.
#[test]
fn a_withdrawal_still_works_with_the_breaker_full() {
    let (mut h, _, attacker) = seeded();
    let cap = share(10_000 * KAS);
    let (position, shares) = add_at_ratio(&mut h, &attacker, 10_000 * KAS);
    buy_adding(&mut h, &attacker, cap);
    sell_kas(&mut h, &attacker, 2 * cap);
    assert_eq!(h.state.window_out, cap);
    h.remove(&position, &attacker, shares).expect("remove with no room left");
    h.ready();
    assert!(cap_left(&h.state, h.age()) == 0, "sells stay shut");
}

/// Random add, buy, remove and sell against the real script engine, with some real
/// time passing: an honest provider's KAS claim never falls by more than one cap plus
/// the refill for the time elapsed.
#[test]
fn random_sequences_keep_the_honest_provider_within_the_bound() {
    let mut worst = 0i128;
    for seed in 0..24u64 {
        let mut rng = seed.wrapping_mul(0x9E3779B97F4A7C15) | 1;
        let mut next = move |n: u64| { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; rng % n };
        let (mut h, _, attacker) = seeded();
        let start = claim(&h, HONEST_SHARES);
        let cap = share(10_000 * KAS);
        let first = h.now;
        let mut held: Vec<(CovenantOutput, i64)> = Vec::new();
        for _ in 0..40 {
            if next(4) == 0 {
                h.now += next(600) as i64;
            }
            match next(4) {
                0 => {
                    let mult = 1 + next(600) as i64;
                    let kas = 10_000 * KAS * mult / 100;
                    held.push(add_at_ratio(&mut h, &attacker, kas));
                }
                1 => {
                    let s_cap = share(h.state.window_ref);
                    let want = 1 + next(3 * s_cap.max(KAS) as u64) as i64;
                    buy_adding(&mut h, &attacker, want);
                }
                2 if !held.is_empty() => {
                    let i = next(held.len() as u64) as usize;
                    let (position, shares) = held.remove(i);
                    h.remove(&position, &attacker, shares).expect("remove always goes through");
                }
                _ => {
                    h.ready();
                    let age = h.age();
                    let room = cap_left(&h.state, age);
                    if room > KAS {
                        let kas = 1 + next(room as u64) as i64;
                        if kas < h.state.kas_reserve / 2 {
                            sell_kas(&mut h, &attacker, kas);
                        }
                    }
                }
            }
            // Refill is per DAA of claimed age, at most the elapsed time.
            let allowed = cap as i128 + cap as i128 * (h.now - first) as i128 / WINDOW as i128 + KAS as i128;
            let lost = start as i128 - claim(&h, HONEST_SHARES) as i128;
            worst = worst.max(lost);
            assert!(lost <= allowed, "seed {seed}: lost {lost}, allowed {allowed}");
        }
    }
    println!("worst honest loss {} KAS", worst / KAS as i128);
}

/// Check, not a finding: a Position's `redeem` needs a Pool leader in the
/// transaction, so it cannot stand in for the pool to free the reserve.
#[test]
fn check_a_position_redeem_cannot_move_the_reserve_without_the_pool() {
    let mut h = Harness::new();
    let thief = key(0xee);
    h.init(&key(0xa1), 5_000 * USDT, 10_000 * KAS, 1_000 * USDT).expect("init");
    let position = h.builder.covenant_utxo("Position", position_state(5, &thief), POSITION_SOMPI, 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
    let (out, utxo, amount) = h.reserve.clone().unwrap();
    let stolen = user_state(&thief, amount);
    let signer = thief;
    let ctx = TxContext::new()
        .actor_input("Position", position_state(5, &thief), EntryCall::new("redeem").args_with(move |tx, i| args!(sign_input(tx, i, &signer))), outpoint(0x90, 0), position.clone(), 0)
        .actor_input("kusdt::KCC20", reserve_state(amount), EntryCall::new("transfer").args(args!(vec![stolen.clone()], vec![0x00u8])), out, utxo.clone(), 0)
        .actor_output("kusdt::KCC20", stolen, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let result = h.builder.build(&ctx).map_err(rejected).and_then(|tx| run(tx, vec![position, utxo]));
    match result {
        Err(Rejected::Script(e)) => println!("refused by script: {e}"),
        Err(Rejected::Build(e)) => panic!("inconclusive, the builder failed first: {e}"),
        Ok(_) => panic!("the reserve moved without the pool"),
    }
}
