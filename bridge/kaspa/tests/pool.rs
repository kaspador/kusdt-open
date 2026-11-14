//! KasPool in the Kaspa script engine: every transaction spends the pool and
//! its kUSDT reserve together (two covenant families), and is executed input
//! by input with the covenant-enabled engine.

mod common;

use std::sync::OnceLock;

use argent::artifact::Artifact;
use argent_runtime::{ArtifactBundle, ArtifactValue, CovenantOutput, EntryCall, TxBuilder, TxContext, args, state};
use common::{Rejected, State, funding, funding_sig, key, outpoint, rejects, sign_input, xonly};
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
// The circuit breaker: 10 % of the KAS reserve per hour at 10 BPS.
const MAX_OUT_BPS: i64 = 1_000;
const WINDOW: i64 = 36_000;
const START_DAA: i64 = 5_000_000;
/// While more than half of the cap is in use, every public entry claims at least window / 720: 50 DAA.
const MIN_AGE: i64 = WINDOW / 720;

const KUSDT_ID: [u8; 32] = [0x11; 32];
const POOL_ID: [u8; 32] = [0x22; 32];

fn kusdt() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("kusdt.ag", "test-pool-kusdt").expect("kUSDT compiles"))
}

fn pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("pool.ag", "test-pool").expect("pool compiles"))
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

// Quotes (what clients compute), in exact integers.
fn buy_quote(x: i64, y: i64, kas_in: i64) -> i64 {
    let eff = kas_in as i128 * (BPS - FEE_BPS) / BPS;
    (y as i128 * eff / (x as i128 + eff)) as i64
}
fn sell_quote(x: i64, y: i64, tokens_in: i64) -> i64 {
    let eff = tokens_in as i128 * (BPS - FEE_BPS) / BPS;
    (x as i128 * eff / (y as i128 + eff)) as i64
}

/// The covenant's breaker arithmetic, written again here so that the tests check
/// the script against an independent reading.
fn share(base: i64) -> i64 {
    (base as i128 * MAX_OUT_BPS as i128 / BPS) as i64
}
/// The minimum claim's condition: more than half of the stored cap in use.
fn in_regime(s: &PoolState) -> bool {
    s.window_out > share(s.window_ref) / 2
}
/// The reference after `elapsed` DAA: down to the reserve at once, up toward it
/// by elapsed / window of the gap.
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
/// (reference, used) a sell of `kas_out` leaves, `elapsed` DAA after the UTXO it
/// spends, and the cap it is checked against.
fn window_after(window_ref: i64, used: i64, x: i64, kas_out: i64, elapsed: i64) -> (i64, i64, i64) {
    let reference = advance(window_ref, x, elapsed);
    let cap = share(reference);
    (reference.min(x - kas_out), settle(used, elapsed, cap) + kas_out, cap)
}
/// KAS sells may take out `elapsed` DAA after the pool UTXO was accepted.
fn room_of(window_ref: i64, used: i64, x: i64, elapsed: i64) -> i64 {
    let (_, out, cap) = window_after(window_ref, used, x, 0, elapsed);
    (cap - out).max(0)
}
/// What is left of `credit` once `stored` has settled to `settled`.
fn credit_left(credit: i64, stored: i64, settled: i64) -> i64 {
    if stored < 0 { (credit - (settled - stored)).max(0) } else { credit }
}
/// (reference, used, credit) after a buy adding `added`, `elapsed` DAA after the UTXO it spends.
fn after_buy(window_ref: i64, used: i64, credit: i64, x: i64, added: i64, elapsed: i64) -> (i64, i64, i64) {
    let reference = advance(window_ref, x, elapsed);
    let cap = share(reference);
    let settled = settle(used, elapsed, cap);
    let next = (settled - added).max(-cap);
    (reference, next, credit_left(credit, used, settled) + (settled - next))
}

/// KAS sells may still take out, `elapsed` DAA after the pool UTXO was accepted.
fn cap_left(s: &PoolState, elapsed: i64) -> i64 {
    room_of(s.window_ref, s.window_out, s.kas_reserve, elapsed)
}
/// (reference, used, credit) after `elapsed` DAA of claimed time and nothing else: a tick, and the first step of add and remove.
fn settled_breaker(s: &PoolState, elapsed: i64) -> (i64, i64, i64) {
    let reference = advance(s.window_ref, s.kas_reserve, elapsed);
    let used = settle(s.window_out, elapsed, share(reference));
    (reference, used, credit_left(s.window_credit, s.window_out, used))
}
/// (reference, used, credit) a withdrawal of `kas_out` claiming `elapsed` leaves: settled, the credit back on the count, and
/// a pool shrunk below the reference cut to two of its caps.
fn after_remove(s: &PoolState, kas_out: i64, elapsed: i64) -> (i64, i64, i64) {
    // While paused nothing settles (the claim is 0).
    let (reference, used, credit) = if s.paused { (s.window_ref, s.window_out, s.window_credit) } else { settled_breaker(s, elapsed) };
    let reclaimed = kas_out.min(credit);
    let x = s.kas_reserve - kas_out;
    if x < reference { (x, (used + reclaimed).min(2 * share(x)), credit - reclaimed) } else { (reference, used + reclaimed, credit - reclaimed) }
}

struct Harness {
    builder: TxBuilder<'static>,
    admin: Keypair,
    state: PoolState,
    pool: (kaspa_consensus_core::tx::TransactionOutpoint, UtxoEntry),
    reserve: Option<(kaspa_consensus_core::tx::TransactionOutpoint, UtxoEntry, i64)>,
    next_outpoint: std::cell::Cell<u32>,
    guardian: Keypair,
    /// The DAA score the next transaction is accepted at.
    now: i64,
    /// The DAA score the current pool UTXO was accepted at.
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
        let admin = key(0x30);
        let guardian = key(0x32);
        let state = PoolState {
            kas_reserve: 0, token_reserve: 0, total_shares: 0, protocol_kas: 0, protocol_tokens: 0, admin: xonly(&admin),
            window_credit: 0, window_ref: 0, window_out: 0, paused: false, guardian: xonly(&guardian),
        };
        let utxo = builder.covenant_utxo("Pool", state.state(), state.value(), 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
        Self { builder, admin, state, pool: (outpoint(0x40, 0), utxo), reserve: None, next_outpoint: std::cell::Cell::new(0), guardian, now: START_DAA, pool_daa: START_DAA }
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

    /// The elapsed DAA an honest client claims: the pool UTXO's age, at most two windows.
    fn age(&self) -> i64 {
        (self.now - self.pool_daa).clamp(0, 2 * WINDOW)
    }

    /// An honest client waits until the pool UTXO is old enough for the least claim (the minimum while more than half the cap is in use).
    fn ready(&mut self) {
        if in_regime(&self.state) && self.age() < MIN_AGE {
            self.now = self.pool_daa + MIN_AGE;
        }
    }

    /// Consensus, before the scripts run: the input's sequence is a relative
    /// lock, met once the spent UTXO is that many DAA old. The script engine
    /// here does not run this check, so the harness does.
    fn sequence_met(&self, sequence: u64) -> Result<(), Rejected> {
        if sequence as i64 > self.now - self.pool_daa {
            return Err(Rejected::Script("input 0 script failed: sequence lock (consensus)".into()));
        }
        Ok(())
    }

    /// The first deposit, from `provider` holding `held` tokens.
    fn init(&mut self, provider: &Keypair, held: i64, kas_in: i64, tokens_in: i64) -> Result<Transaction, Rejected> {
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
        self.adopt(&tx, next, 2, tokens_in);
        Ok(tx)
    }

    fn reserve_input<'a>(&self, next_states: Vec<State>) -> (kaspa_consensus_core::tx::TransactionOutpoint, UtxoEntry, State, EntryCall<'a>) {
        let (out, utxo, amount) = self.reserve.clone().expect("pool initialized");
        // Covenant-id owner: the normal path with an empty authentication.
        (out, utxo, reserve_state(amount), EntryCall::new("transfer").args(args!(next_states, vec![0x00u8])))
    }

    /// KAS in, `out` tokens to `buyer`; `tamper` bends the pool's successor.
    fn try_buy(&self, buyer: &Keypair, kas_in: i64, out: i64, tamper: impl Fn(&mut PoolState, &mut i64)) -> Result<(Transaction, PoolState, i64), Rejected> {
        self.try_buy_keeping(buyer, kas_in, out, tamper, TOKEN_SOMPI)
    }

    /// A buy whose new reserve output carries `reserve_value` sompi.
    fn try_buy_keeping(&self, buyer: &Keypair, kas_in: i64, out: i64, tamper: impl Fn(&mut PoolState, &mut i64), reserve_value: u64) -> Result<(Transaction, PoolState, i64), Rejected> {
        let s = &self.state;
        let cut = (kas_in as i128 * PROTOCOL_BPS / BPS) as i64;
        // The breaker counts the net flow: what the buy adds to the reserve gives sells that much room.
        let elapsed = self.age();
        let (window_ref, window_out, window_credit) = after_buy(s.window_ref, s.window_out, s.window_credit, s.kas_reserve, kas_in - cut, elapsed);
        let mut next = PoolState { kas_reserve: s.kas_reserve + kas_in - cut, token_reserve: s.token_reserve - out, protocol_kas: s.protocol_kas + cut, window_credit, window_ref, window_out, ..s.clone() };
        let mut reserve_out = next.token_reserve + next.protocol_tokens;
        tamper(&mut next, &mut reserve_out);
        let buyer_state = user_state(buyer, out);
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(vec![reserve_state(reserve_out), buyer_state.clone()]);
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new("buy").args(args!(kas_in, elapsed, buyer_state.clone())), self.pool.0, self.pool.1.clone(), elapsed as u64)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .input(self.fresh_outpoint(), funding(), funding_sig(), 0)
            .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), reserve_value)
            .actor_output("kusdt::KCC20", buyer_state, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), r_utxo, funding()])?;
        Ok((tx, next, reserve_out))
    }

    fn buy(&mut self, buyer: &Keypair, kas_in: i64, out: i64) -> Result<Transaction, Rejected> {
        let (tx, next, reserve_out) = self.try_buy(buyer, kas_in, out, |_, _| {})?;
        self.adopt(&tx, next, 1, reserve_out);
        Ok(tx)
    }

    /// `seller` pays `tokens_in` out of a state holding `held`; gets `kas_out`.
    fn try_sell(&self, seller: &Keypair, held: i64, tokens_in: i64, kas_out: i64) -> Result<(Transaction, PoolState, i64), Rejected> {
        let elapsed = self.age();
        self.try_sell_at(seller, held, tokens_in, kas_out, elapsed, elapsed as u64)
    }

    /// A sell claiming `elapsed` for the breaker, with the pool input's sequence
    /// at `sequence`. Consensus's relative-lock check comes first.
    fn try_sell_at(&self, seller: &Keypair, held: i64, tokens_in: i64, kas_out: i64, elapsed: i64, sequence: u64) -> Result<(Transaction, PoolState, i64), Rejected> {
        self.sequence_met(sequence)?;
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
            .actor_input("Pool", s.state(), EntryCall::new("sell").args(args!(kas_out, elapsed, change.clone())), self.pool.0, self.pool.1.clone(), sequence)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .actor_input("kusdt::KCC20", user_state(seller, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &seller_key))), p_out, p_utxo.clone(), 0)
            .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), r_utxo, p_utxo])?;
        Ok((tx, next, reserve_out))
    }

    fn sell(&mut self, seller: &Keypair, held: i64, tokens_in: i64, kas_out: i64) -> Result<Transaction, Rejected> {
        let (tx, next, reserve_out) = self.try_sell(seller, held, tokens_in, kas_out)?;
        self.adopt(&tx, next, 1, reserve_out);
        Ok(tx)
    }

    fn try_collect(&self, by: &Keypair, fees_to: &Keypair) -> Result<(Transaction, PoolState, i64), Rejected> {
        let s = &self.state;
        let next = PoolState { protocol_kas: 0, protocol_tokens: 0, ..s.clone() };
        let fee_state = user_state(fees_to, s.protocol_tokens);
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(vec![reserve_state(s.token_reserve), fee_state.clone()]);
        let by = *by;
        let fee_arg = fee_state.clone();
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new("collect").args_with(move |tx, i| args!(sign_input(tx, i, &by), fee_arg.clone())), self.pool.0, self.pool.1.clone(), 0)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
            .actor_output("kusdt::KCC20", reserve_state(s.token_reserve), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", fee_state, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), r_utxo])?;
        Ok((tx, next, s.token_reserve))
    }
}

#[track_caller]
fn rejects_at<T>(result: Result<T, Rejected>, input: usize) {
    match result {
        Err(Rejected::Script(e)) => assert!(e.contains(&format!("input {input} script failed")), "rejected, but not by input {input}: {e}"),
        Err(Rejected::Build(e)) => panic!("expected a script rejection, the builder failed first: {e}"),
        Ok(_) => panic!("expected a script rejection, the transaction was accepted"),
    }
}

fn seeded() -> (Harness, Keypair) {
    let mut h = Harness::new();
    let lp = key(0xa1);
    // 10 000 KAS against 1 000 kUSDT: 0.1 kUSDT per KAS.
    h.init(&lp, 5_000 * USDT, 10_000 * KAS, 1_000 * USDT).expect("init");
    (h, lp)
}

#[test]
fn init_sets_the_price_and_locks_minimum_liquidity() {
    let (h, _) = seeded();
    assert_eq!(h.state.kas_reserve, 10_000 * KAS);
    assert_eq!(h.state.token_reserve, 1_000 * USDT);
    assert_eq!(h.state.total_shares, 10_000 * KAS);
}

#[test]
fn init_only_once() {
    let (mut h, lp) = seeded();
    rejects(h.init(&lp, 100 * USDT, 10 * KAS, 10 * USDT));
}

#[test]
fn buy_pays_at_most_the_quote() {
    let (mut h, _) = seeded();
    let bob = key(0xb0);
    let kas_in = 100 * KAS;
    let quote = buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in);
    assert!(quote > 9 * USDT && quote < 10 * USDT, "≈9.87 kUSDT for 100 KAS, got {quote}");
    // One unit more than the quote breaks the invariant.
    rejects(h.try_buy(&bob, kas_in, quote + 1, |_, _| {}).map(|_| ()));
    let before = h.state.clone();
    h.buy(&bob, kas_in, quote).expect("buy at the quote");
    assert_eq!(h.state.token_reserve, before.token_reserve - quote);
    assert_eq!(h.state.protocol_kas, (kas_in as i128 * PROTOCOL_BPS / BPS) as i64);
    assert!(h.state.kas_reserve > before.kas_reserve);
}

#[test]
fn sell_pays_at_most_the_quote() {
    let (mut h, _) = seeded();
    let carol = key(0xc0);
    let tokens_in = 50 * USDT;
    let quote = sell_quote(h.state.kas_reserve, h.state.token_reserve, tokens_in);
    rejects(h.try_sell(&carol, 80 * USDT, tokens_in, quote + 1).map(|_| ()));
    h.sell(&carol, 80 * USDT, tokens_in, quote).expect("sell at the quote");
    assert_eq!(h.state.protocol_tokens, (tokens_in as i128 * PROTOCOL_BPS / BPS) as i64);
}

#[test]
fn round_trips_lose_the_fee() {
    let (mut h, _) = seeded();
    let bob = key(0xb0);
    let kas_in = 1_000 * KAS;
    let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in);
    h.buy(&bob, kas_in, got).unwrap();
    let back = sell_quote(h.state.kas_reserve, h.state.token_reserve, got);
    h.sell(&bob, got, got, back).unwrap();
    assert!(back < kas_in, "a round trip returns less than it put in");
    assert!(back > kas_in * 99 / 100, "but only about the 0.6 % in fees");
}

#[test]
fn the_reserve_successor_is_forced() {
    let (h, _) = seeded();
    let bob = key(0xb0);
    let kas_in = 100 * KAS;
    let quote = buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in);
    // The pool's successor claims more tokens than the reserve keeps.
    rejects(h.try_buy(&bob, kas_in, quote, |next, _| next.token_reserve += 1).map(|_| ()));
    // The reserve keeps fewer tokens than the pool records.
    rejects(h.try_buy(&bob, kas_in, quote, |_, reserve| *reserve -= 1).map(|_| ()));
    // The pool forgets the protocol's cut.
    rejects(h.try_buy(&bob, kas_in, quote, |next, _| next.protocol_kas = 0).map(|_| ()));
}

#[test]
fn only_the_admin_collects_protocol_fees() {
    let (mut h, _) = seeded();
    let bob = key(0xb0);
    let kas_in = 1_000 * KAS;
    let out = buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in);
    h.buy(&bob, kas_in, out).unwrap();
    h.sell(&bob, out, out, sell_quote(h.state.kas_reserve, h.state.token_reserve, out)).unwrap();
    assert!(h.state.protocol_kas > 0 && h.state.protocol_tokens > 0);
    rejects(h.try_collect(&key(0x31), &key(0x31)).map(|_| ()));
    let admin = h.admin;
    let (tx, next, reserve) = h.try_collect(&admin, &admin).expect("admin collects");
    h.adopt(&tx, next, 1, reserve);
    assert_eq!((h.state.protocol_kas, h.state.protocol_tokens), (0, 0));
}

/// The pool's presence authorizes spending its reserve (covenant-id owner),
/// so no other pool-family path may let the reserve move.
#[test]
fn the_reserve_cannot_ride_along_a_position_transfer() {
    let (h, lp) = seeded();
    let thief = key(0xee);
    // A position owned by the thief, in the pool's family.
    let position = h.builder.covenant_utxo("Position", position_state(5, &thief), POSITION_SOMPI, 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
    let (out, utxo, amount) = h.reserve.clone().unwrap();
    let thief_key = thief;
    let stolen = user_state(&thief, amount);
    let ctx = TxContext::new()
        .actor_input("Position", position_state(5, &thief), EntryCall::new("transfer").args_with(move |tx, i| args!(xonly(&thief_key).to_vec(), sign_input(tx, i, &thief_key))), outpoint(0x90, 0), position.clone(), 0)
        .actor_input("kusdt::KCC20", reserve_state(amount), EntryCall::new("transfer").args(args!(vec![stolen.clone()], vec![0x00u8])), out, utxo.clone(), 0)
        .actor_output("Position", position_state(5, &thief), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
        .actor_output("kusdt::KCC20", stolen, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let result = h.builder.build(&ctx).map_err(rejected).and_then(|tx| run(tx, vec![position, utxo]));
    // Input 0, the position, refuses: kUSDT may not move beside it.
    rejects_at(result, 0);
    let _ = lp;
}

#[test]
fn the_reserve_cannot_ride_along_an_admin_key_change() {
    let (h, _) = seeded();
    let admin = h.admin;
    let thief = key(0xee);
    let (out, utxo, amount) = h.reserve.clone().unwrap();
    let stolen = user_state(&thief, amount);
    let next = PoolState { admin: xonly(&thief), ..h.state.clone() };
    let guardian = h.state.guardian;
    let ctx = TxContext::new()
        .actor_input("Pool", h.state.state(), EntryCall::new("set_keys").args_with(move |tx, i| args!(xonly(&thief).to_vec(), guardian.to_vec(), sign_input(tx, i, &admin))), h.pool.0, h.pool.1.clone(), 0)
        .actor_input("kusdt::KCC20", reserve_state(amount), EntryCall::new("transfer").args(args!(vec![stolen.clone()], vec![0x00u8])), out, utxo.clone(), 0)
        .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
        .actor_output("kusdt::KCC20", stolen, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let result = h.builder.build(&ctx).map_err(rejected).and_then(|tx| run(tx, vec![h.pool.1.clone(), utxo]));
    // Input 0, the pool, refuses: kUSDT may not move beside an admin key change.
    rejects_at(result, 0);
}

#[test]
fn large_reserves_use_exact_128_bit_products() {
    // Reserves whose product is far above 2^63: 1 billion KAS against 100
    // million kUSDT (1e17 sompi × 1e14 units).
    let mut h = Harness::new();
    let lp = key(0xa1);
    h.init(&lp, 200_000_000 * USDT, 1_000_000_000 * KAS, 100_000_000 * USDT).expect("init with large reserves");
    let bob = key(0xb0);
    let kas_in = 2_000_000 * KAS;
    let quote = buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in);
    rejects(h.try_buy(&bob, kas_in, quote + 1, |_, _| {}).map(|_| ()));
    h.buy(&bob, kas_in, quote).expect("buy at the quote");
}

#[allow(dead_code)]
fn unused(_: ArtifactValue) {}

impl Harness {
    /// `provider` adds `kas_in` and `tokens_in` (from a state holding `held`) for `shares`.
    fn try_add(&self, provider: &Keypair, held: i64, kas_in: i64, tokens_in: i64, shares: i64) -> Result<(Transaction, PoolState, i64), Rejected> {
        let elapsed = self.age();
        self.try_add_at(provider, held, kas_in, tokens_in, shares, elapsed, elapsed as u64)
    }

    /// An add claiming `elapsed`, with the pool input's sequence at `sequence`; consensus's relative lock comes first.
    #[allow(clippy::too_many_arguments)]
    fn try_add_at(&self, provider: &Keypair, held: i64, kas_in: i64, tokens_in: i64, shares: i64, elapsed: i64, sequence: u64) -> Result<(Transaction, PoolState, i64), Rejected> {
        self.sequence_met(sequence)?;
        let s = &self.state;
        let (window_ref, window_out, window_credit) = settled_breaker(s, elapsed);
        let next = PoolState { kas_reserve: s.kas_reserve + kas_in, token_reserve: s.token_reserve + tokens_in, total_shares: s.total_shares + shares, window_ref, window_out, window_credit, ..s.clone() };
        let reserve_out = next.token_reserve + next.protocol_tokens;
        let change = user_state(provider, held - tokens_in);
        let (p_out, p_utxo) = self.token_utxo(user_state(provider, held));
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(vec![reserve_state(reserve_out), change.clone()]);
        let provider_key = *provider;
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new("add").args(args!(kas_in, shares, elapsed, xonly(provider).to_vec(), change.clone(), Vec::<u8>::new())), self.pool.0, self.pool.1.clone(), sequence)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .actor_input("kusdt::KCC20", user_state(provider, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &provider_key))), p_out, p_utxo.clone(), 0)
            .input(self.fresh_outpoint(), funding(), funding_sig(), 0)
            .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
            .actor_output("Position", position_state(shares, provider), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), r_utxo, p_utxo, funding()])?;
        Ok((tx, next, reserve_out))
    }

    /// Burns `position` (owned by `owner`, holding `shares`), signed by `signer`.
    #[allow(clippy::too_many_arguments)]
    fn try_remove(&self, position: &CovenantOutput, owner: &Keypair, signer: &Keypair, shares: i64, kas_out: i64, tokens_out: i64, to: &Keypair) -> Result<(Transaction, PoolState, i64), Rejected> {
        // While paused a withdrawal claims exactly 0.
        let elapsed = if self.state.paused { 0 } else { self.age() };
        self.try_remove_at(position, owner, signer, shares, kas_out, tokens_out, to, elapsed, elapsed as u64)
    }

    /// A withdrawal claiming `elapsed`, with the pool input's sequence at `sequence`; consensus's relative lock comes first.
    #[allow(clippy::too_many_arguments)]
    fn try_remove_at(&self, position: &CovenantOutput, owner: &Keypair, signer: &Keypair, shares: i64, kas_out: i64, tokens_out: i64, to: &Keypair, elapsed: i64, sequence: u64) -> Result<(Transaction, PoolState, i64), Rejected> {
        self.sequence_met(sequence)?;
        let s = &self.state;
        let (window_ref, window_out, window_credit) = after_remove(s, kas_out, elapsed);
        let next = PoolState { kas_reserve: s.kas_reserve - kas_out, token_reserve: s.token_reserve - tokens_out, total_shares: s.total_shares - shares, window_ref, window_credit, window_out, ..s.clone() };
        let reserve_out = next.token_reserve + next.protocol_tokens;
        let receiver = user_state(to, tokens_out);
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(vec![reserve_state(reserve_out), receiver.clone()]);
        let signer = *signer;
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new("remove").args(args!(kas_out, elapsed, receiver.clone())), self.pool.0, self.pool.1.clone(), sequence)
            .actor_input("Position", position_state(shares, owner), EntryCall::new("redeem").args_with(move |tx, i| args!(sign_input(tx, i, &signer))), position.outpoint, position.utxo.clone(), 0)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(2, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", receiver, CovenantBinding::new(2, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), position.utxo.clone(), r_utxo])?;
        Ok((tx, next, reserve_out))
    }
}

#[test]
fn liquidity_comes_in_proportion_and_leaves_with_its_share() {
    let (mut h, _) = seeded();
    let dan = key(0xd0);
    // Adding 10 % of the pool on both sides buys at most 10 % more shares.
    let (kas_in, tokens_in) = (1_000 * KAS, 100 * USDT);
    let shares = (kas_in as i128 * h.state.total_shares as i128 / h.state.kas_reserve as i128) as i64;
    rejects(h.try_add(&dan, 500 * USDT, kas_in, tokens_in, shares + 1).map(|_| ()));
    let (tx, next, reserve) = h.try_add(&dan, 500 * USDT, kas_in, tokens_in, shares).expect("add");
    let position = CovenantOutput::from_tx(&tx, 1).unwrap();
    h.adopt(&tx, next, 2, reserve);

    // Withdrawing takes at most the position's share of each side.
    let kas_out = (shares as i128 * h.state.kas_reserve as i128 / h.state.total_shares as i128) as i64;
    let tokens_out = (shares as i128 * h.state.token_reserve as i128 / h.state.total_shares as i128) as i64;
    rejects(h.try_remove(&position, &dan, &dan, shares, kas_out + 1, tokens_out, &dan).map(|_| ()));
    rejects(h.try_remove(&position, &dan, &dan, shares, kas_out, tokens_out + 1, &dan).map(|_| ()));
    // Only the position's owner can burn it.
    rejects(h.try_remove(&position, &dan, &key(0xee), shares, kas_out, tokens_out, &key(0xee)).map(|_| ()));
    let (tx, next, reserve) = h.try_remove(&position, &dan, &dan, shares, kas_out, tokens_out, &dan).expect("remove");
    h.adopt(&tx, next, 1, reserve);
    assert_eq!(kas_out, kas_in);
    assert_eq!(tokens_out, tokens_in);
}

#[test]
fn positions_change_hands_with_the_owner_signature() {
    let (h, _) = seeded();
    let (owner, buyer) = (key(0xd0), key(0xd1));
    let utxo = h.builder.covenant_utxo("Position", position_state(7, &owner), POSITION_SOMPI, 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
    let try_transfer = |signer: Keypair| {
        let ctx = TxContext::new()
            .actor_input("Position", position_state(7, &owner), EntryCall::new("transfer").args_with(move |tx, i| args!(xonly(&buyer).to_vec(), sign_input(tx, i, &signer))), outpoint(0x91, 0), utxo.clone(), 0)
            .actor_output("Position", position_state(7, &buyer), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI);
        h.builder.build(&ctx).map_err(rejected).and_then(|tx| run(tx, vec![utxo.clone()]))
    };
    rejects(try_transfer(key(0xee)));
    try_transfer(owner).expect("owner transfers");
}

// ── The circuit breaker and the pause (SPEC §15) ───────────────────────────

impl Harness {
    /// The guardian's pause, the admin's unpause, or a key change, signed by `by`;
    /// `with_reserve` also tries to move the reserve beside it.
    fn try_key(&self, entry: &'static str, by: &Keypair, next: PoolState, with_reserve: Option<&Keypair>) -> Result<(Transaction, PoolState), Rejected> {
        let by = *by;
        let (admin, guardian) = (next.admin, next.guardian);
        let call = if entry == "set_keys" {
            EntryCall::new("set_keys").args_with(move |tx, i| args!(admin.to_vec(), guardian.to_vec(), sign_input(tx, i, &by)))
        } else {
            EntryCall::new(entry).args_with(move |tx, i| args!(sign_input(tx, i, &by)))
        };
        let mut ctx = TxContext::new().actor_input("Pool", self.state.state(), call, self.pool.0, self.pool.1.clone(), 0);
        let mut entries = vec![self.pool.1.clone()];
        if let Some(thief) = with_reserve {
            let (out, utxo, amount) = self.reserve.clone().unwrap();
            let stolen = user_state(thief, amount);
            ctx = ctx.actor_input("kusdt::KCC20", reserve_state(amount), EntryCall::new("transfer").args(args!(vec![stolen.clone()], vec![0x00u8])), out, utxo.clone(), 0);
            ctx = ctx.actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), self.state.value());
            ctx = ctx.actor_output("kusdt::KCC20", stolen, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
            entries.push(utxo);
        } else {
            ctx = ctx.actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), self.state.value());
        }
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, entries)?;
        Ok((tx, next))
    }

    fn key(&mut self, entry: &'static str, by: &Keypair, next: PoolState) -> Result<(), Rejected> {
        let (tx, next) = self.try_key(entry, by, next, None)?;
        let pool = CovenantOutput::from_tx(&tx, 0).unwrap();
        self.pool = (pool.outpoint, pool.utxo);
        self.state = next;
        self.pool_daa = self.now;
        Ok(())
    }

    /// Anyone's tick claiming `elapsed` with the pool input's sequence at `sequence`, paid by a plain coin. `tamper`
    /// bends the successor, `value` is the pool output's value (the pool's own by default), and `with_reserve` also tries to
    /// move the reserve beside it.
    fn try_tick_with(&self, elapsed: i64, sequence: u64, tamper: impl Fn(&mut PoolState), value: Option<u64>, with_reserve: Option<&Keypair>) -> Result<(Transaction, PoolState), Rejected> {
        self.sequence_met(sequence)?;
        let s = &self.state;
        let (window_ref, window_out, window_credit) = settled_breaker(s, elapsed);
        let mut next = PoolState { window_ref, window_out, window_credit, ..s.clone() };
        tamper(&mut next);
        let mut ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new("tick").args(args!(elapsed)), self.pool.0, self.pool.1.clone(), sequence)
            .input(self.fresh_outpoint(), funding(), funding_sig(), 0);
        let mut entries = vec![self.pool.1.clone(), funding()];
        if let Some(thief) = with_reserve {
            let (out, utxo, amount) = self.reserve.clone().unwrap();
            let stolen = user_state(thief, amount);
            ctx = ctx.actor_input("kusdt::KCC20", reserve_state(amount), EntryCall::new("transfer").args(args!(vec![stolen.clone()], vec![0x00u8])), out, utxo.clone(), 0);
            ctx = ctx.actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), value.unwrap_or(s.value()));
            ctx = ctx.actor_output("kusdt::KCC20", stolen, CovenantBinding::new(2, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
            entries.push(utxo);
        } else {
            ctx = ctx.actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), value.unwrap_or(s.value()));
        }
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, entries)?;
        Ok((tx, next))
    }

    fn try_tick(&self, elapsed: i64) -> Result<(Transaction, PoolState), Rejected> {
        self.try_tick_with(elapsed, elapsed as u64, |_| {}, None, None)
    }

    fn tick(&mut self) -> Result<(), Rejected> {
        let (tx, next) = self.try_tick(self.age())?;
        let pool = CovenantOutput::from_tx(&tx, 0).unwrap();
        self.pool = (pool.outpoint, pool.utxo);
        self.state = next;
        self.pool_daa = self.now;
        Ok(())
    }
}

#[test]
fn the_breaker_caps_the_kas_sells_take_at_one_moment() {
    let (mut h, _) = seeded();
    let whale = key(0xf0);
    // 10 % of 10 000 KAS may leave at once.
    assert_eq!(cap_left(&h.state, 0), 1_000 * KAS);
    let first = sell_quote(h.state.kas_reserve, h.state.token_reserve, 50 * USDT);
    h.sell(&whale, 500 * USDT, 50 * USDT, first).expect("a sell under the cap");
    assert_eq!((h.state.window_ref, h.state.window_out), (h.state.kas_reserve, first));
    // At most half of the cap is in use: the next spend may claim no age, at once.
    assert!(2 * first <= share(h.state.window_ref) && !in_regime(&h.state));
    let second = sell_quote(h.state.kas_reserve, h.state.token_reserve, 5 * USDT);
    h.sell(&whale, 500 * USDT, 5 * USDT, second).expect("a second sell in the same DAA");
    assert_eq!(h.state.window_out, first + second);
    // More than half of the cap is in use now: no public spend of this pool UTXO until it is MIN_AGE old.
    assert!(in_regime(&h.state));
    rejects_at(h.try_sell(&whale, 500 * USDT, USDT, 1).map(|_| ()), 0);
    rejects_at(h.try_sell_at(&whale, 500 * USDT, USDT, 1, 0, 0).map(|_| ()), 0);
    h.ready();
    assert_eq!(h.age(), MIN_AGE);
    // The cap counts the smaller of the reference and the reserve, and MIN_AGE of refill came with the wait.
    let cap = share(h.state.kas_reserve);
    let left = cap_left(&h.state, MIN_AGE);
    assert_eq!(left, cap - settle(first + second, MIN_AGE, cap));
    let tokens = 100 * USDT;
    assert!(sell_quote(h.state.kas_reserve, h.state.token_reserve, tokens) > left, "the quote alone would pass the cap");
    // One sompi past the cap: refused by the pool's own script.
    rejects_at(h.try_sell(&whale, 500 * USDT, tokens, left + 1).map(|_| ()), 0);
    // Exactly the cap: accepted, and then nothing more at this moment.
    h.sell(&whale, 500 * USDT, tokens, left).expect("a sell up to the cap");
    rejects_at(h.try_sell(&whale, 500 * USDT, USDT, 1).map(|_| ()), 0);
    // MIN_AGE later, only what MIN_AGE refills.
    h.ready();
    // (None here: the count, a cap of the larger reserve, is above the smaller cap by more than that.)
    let refill = cap_left(&h.state, MIN_AGE);
    let cap_now = share(h.state.kas_reserve);
    assert_eq!(refill, (cap_now - settle(h.state.window_out, MIN_AGE, cap_now)).max(0));
    assert!(refill <= cap_now * MIN_AGE / WINDOW);
    let t = tokens_for(h.state.kas_reserve, h.state.token_reserve, refill + 1);
    rejects_at(h.try_sell(&whale, t + 1, t, refill + 1).map(|_| ()), 0);
}

#[test]
fn a_full_cap_comes_back_after_idle_time() {
    let (mut h, _) = seeded();
    let whale = key(0xf0);
    let left = cap_left(&h.state, h.age());
    h.sell(&whale, 900 * USDT, 200 * USDT, left).expect("the whole cap");
    rejects_at(h.try_sell(&whale, 900 * USDT, USDT, 1).map(|_| ()), 0);
    // The cap is 10 % of the reserve now (900 KAS), and 1 000 KAS was used.
    // One window later 900 KAS of it has refilled.
    h.now += WINDOW;
    let cap_now = share(h.state.kas_reserve);
    assert_eq!(cap_left(&h.state, h.age()), cap_now - (left - cap_now));
    // Two windows: all of it back. Idle time beyond that is worth nothing more.
    h.now += WINDOW;
    let fresh = cap_left(&h.state, h.age());
    assert_eq!(fresh, cap_now);
    h.sell(&whale, 900 * USDT, 200 * USDT, fresh).expect("a fresh cap");
    assert_eq!(h.state.window_ref, h.state.kas_reserve);
    // A week of idle time adds nothing to a full bucket: one cap, no more.
    let reserve = h.state.kas_reserve;
    h.now += 7 * 24 * WINDOW;
    assert_eq!(cap_left(&h.state, h.age()), share(reserve));
    let (_, _, big) = window_after(h.state.window_ref, h.state.window_out, h.state.kas_reserve, 0, 2 * WINDOW);
    rejects_at(h.try_sell(&whale, 900 * USDT, 200 * USDT, big + 1).map(|_| ()), 0);
    h.sell(&whale, 900 * USDT, 200 * USDT, big).expect("exactly one cap");
    rejects_at(h.try_sell(&whale, 900 * USDT, USDT, 1).map(|_| ()), 0);
}

#[test]
fn half_a_window_refills_half_the_cap() {
    let (mut h, _) = seeded();
    let whale = key(0xf0);
    let cap = share(h.state.kas_reserve);
    h.sell(&whale, 900 * USDT, 200 * USDT, cap).expect("the whole cap");
    assert_eq!(cap_left(&h.state, 0), 0);
    h.now += WINDOW / 2;
    let elapsed = h.age();
    assert_eq!(elapsed, WINDOW / 2);
    // The cap is 10 % of the reserve now, and what was used decays at that rate.
    let cap_now = share(h.state.kas_reserve);
    let room = cap_left(&h.state, elapsed);
    assert_eq!(room, cap_now - (cap - cap_now / 2));
    let tokens = 100 * USDT;
    assert!(sell_quote(h.state.kas_reserve, h.state.token_reserve, tokens) > room);
    rejects_at(h.try_sell(&whale, 900 * USDT, tokens, room + 1).map(|_| ()), 0);
    h.sell(&whale, 900 * USDT, tokens, room).expect("the half that came back");
    // Nothing is left: the claimed time was spent with that sell.
    rejects_at(h.try_sell(&whale, 900 * USDT, USDT, 1).map(|_| ()), 0);
}

#[test]
fn the_clock_cannot_outrun_the_pool_utxos_age_and_claiming_less_only_costs() {
    let (mut h, _) = seeded();
    let whale = key(0xf0);
    let cap = share(h.state.kas_reserve);
    h.sell(&whale, 900 * USDT, 200 * USDT, cap).expect("the whole cap");
    h.now += WINDOW / 2;

    // Claiming more age than the UTXO has: the input's sequence must cover the
    // claim (script), and consensus holds the sequence to the UTXO's age.
    rejects_at(h.try_sell_at(&whale, 900 * USDT, USDT, 1, WINDOW, WINDOW as u64).map(|_| ()), 0);
    rejects_at(h.try_sell_at(&whale, 900 * USDT, USDT, 1, WINDOW, (WINDOW / 2) as u64).map(|_| ()), 0);
    // A sequence with the "disabled" bit would pass consensus, so the script refuses it.
    rejects_at(h.try_sell_at(&whale, 900 * USDT, USDT, 1, WINDOW / 2, 1u64 << 63).map(|_| ()), 0);
    // Never negative.
    rejects_at(h.try_sell_at(&whale, 900 * USDT, USDT, 1, -1, 0).map(|_| ()), 0);

    // Claiming less is allowed, and only gives less room.
    let claimed = WINDOW / 4;
    let less = cap_left(&h.state, claimed);
    assert!(less < cap_left(&h.state, h.age()));
    rejects_at(h.try_sell_at(&whale, 900 * USDT, USDT, less + 1, claimed, claimed as u64).map(|_| ()), 0);
    let (tx, next, reserve) = h.try_sell_at(&whale, 900 * USDT, 20 * USDT, less, claimed, claimed as u64).expect("a backdated claim");
    h.adopt(&tx, next, 1, reserve);
    // And the time given up is gone: this pool UTXO is new, so nothing is claimable now.
    assert_eq!(h.age(), 0);
    assert_eq!(cap_left(&h.state, 0), 0);
    rejects_at(h.try_sell(&whale, 900 * USDT, USDT, 1).map(|_| ()), 0);
    // However old the UTXO, a claim stops at two windows (the script's own check).
    h.now += 5 * WINDOW;
    rejects_at(h.try_sell_at(&whale, 900 * USDT, USDT, 1, 2 * WINDOW + 1, (2 * WINDOW + 1) as u64).map(|_| ()), 0);
}

#[test]
fn a_backdated_clock_cannot_replay_idle_windows() {
    let (mut h, _) = seeded();
    let whale = key(0xf0);
    let reserve = h.state.kas_reserve;
    let cap = share(reserve);
    h.sell(&whale, 900 * USDT, 200 * USDT, cap).expect("the whole cap");
    // A long idle stretch, then one moment in which the attacker tries every
    // claim in turn: the first spend is the only one with any age to claim.
    h.now += 30 * 24 * WINDOW;
    let mut taken = 0;
    for _ in 0..30 {
        let elapsed = h.age();
        let room = cap_left(&h.state, elapsed);
        if room == 0 {
            break;
        }
        let tokens = 200 * USDT;
        h.sell(&whale, 900 * USDT, tokens, room).expect("what is left");
        taken += room;
    }
    assert!(taken <= share(reserve - cap) + 1, "{taken}");
    assert_eq!(cap_left(&h.state, 0), 0, "one moment gives one cap, however long the idle time");
}

#[test]
fn round_trips_do_not_use_up_the_sell_room() {
    // The audit's griefing case: buy, then sell the same kUSDT back, over and
    // over. The breaker counts the net KAS that left, so the round trips cost
    // their fees and leave honest sellers their room.
    let (mut h, _) = seeded();
    let (griefer, seller) = (key(0xf1), key(0xf2));
    // A small sell starts the count.
    let q0 = sell_quote(h.state.kas_reserve, h.state.token_reserve, USDT);
    h.sell(&seller, 500 * USDT, USDT, q0).expect("the first sell");
    for _ in 0..5 {
        h.ready();
        let kas_in = 900 * KAS;
        let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in);
        h.buy(&griefer, kas_in, got).expect("the griefer buys");
        h.ready();
        let back = sell_quote(h.state.kas_reserve, h.state.token_reserve, got);
        h.sell(&griefer, got, got, back).expect("and sells it all back");
        assert!(back < kas_in, "a round trip loses its fees");
    }
    // 4 500 KAS went round, yet the net outflow is below the first small sell.
    assert!(h.state.window_out < q0, "{} >= {q0}", h.state.window_out);
    h.ready();
    let left = cap_left(&h.state, h.age());
    let cap = share(h.state.window_ref.min(h.state.kas_reserve));
    assert!(left > cap - q0, "{left} <= {}", cap - q0);
    let tokens = 2_000 * USDT;
    assert!(sell_quote(h.state.kas_reserve, h.state.token_reserve, tokens) > left);
    rejects_at(h.try_sell(&seller, 3_000 * USDT, tokens, left + 1).map(|_| ()), 0);
    h.sell(&seller, 3_000 * USDT, tokens, left).expect("an honest seller still has the room");
}

#[test]
fn buys_give_sells_room_but_the_net_stays_capped() {
    let (mut h, _) = seeded();
    let (whale, bob) = (key(0xf0), key(0xb0));
    let cap = share(h.state.kas_reserve);
    h.sell(&whale, 900 * USDT, 200 * USDT, cap).expect("the whole cap");
    rejects_at(h.try_sell(&whale, 900 * USDT, USDT, 1).map(|_| ()), 0);
    // A buy that adds 100 KAS (after the protocol's cut) reopens exactly that much, after the refill of
    // the MIN_AGE it claims. 1 000 KAS was used and the cap is now 900: the buy first has to pay that off.
    h.ready();
    let kas_in = 300 * KAS;
    let added = kas_in - (kas_in as i128 * PROTOCOL_BPS / BPS) as i64;
    let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in);
    let (_, settled, _) = settled_breaker(&h.state, MIN_AGE);
    h.buy(&bob, kas_in, got).expect("a buy");
    assert_eq!(h.state.window_out, settled - added);
    assert!(h.state.window_out > 0);
    h.ready();
    let room = cap_left(&h.state, MIN_AGE);
    // The reference rises toward the larger reserve by MIN_AGE of a window, and the cap with it.
    let reference = advance(h.state.window_ref, h.state.kas_reserve, MIN_AGE);
    assert_eq!(room, share(reference) - settle(h.state.window_out, MIN_AGE, share(reference)));
    assert!(room > 0, "the buy reopened the room");
    rejects_at(h.try_sell(&whale, 900 * USDT, 100 * USDT, room + 1).map(|_| ()), 0);
    h.sell(&whale, 900 * USDT, 100 * USDT, room).expect("the room the buy gave back");

    // After a full refill, net buying gives sells at most one cap of credit,
    // and the net outflow stays capped.
    h.now += 2 * WINDOW;
    let small = sell_quote(h.state.kas_reserve, h.state.token_reserve, USDT);
    h.sell(&whale, 900 * USDT, USDT, small).expect("settles");
    h.ready();
    let reference = advance(h.state.window_ref, h.state.kas_reserve, MIN_AGE);
    let big = 5_000 * KAS;
    let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, big);
    let cap = share(reference.min(h.state.kas_reserve));
    h.buy(&bob, big, got).expect("a big buy");
    assert_eq!(h.state.window_out, -cap, "a buy is worth at most one cap of credit");
    assert_eq!(h.state.window_ref, reference, "a buy adds nothing to the reference");
    // With the count below zero, a sell may claim nothing at all.
    assert_eq!(cap_left(&h.state, 0), 2 * cap, "the cap, plus the credit");
    let room = cap_left(&h.state, 0);
    let tokens = 3_000 * USDT;
    assert!(sell_quote(h.state.kas_reserve, h.state.token_reserve, tokens) > room);
    rejects_at(h.try_sell(&whale, 4_000 * USDT, tokens, room + 1).map(|_| ()), 0);
    h.sell(&whale, 4_000 * USDT, tokens, room).expect("up to the cap, net");
    assert_eq!(h.state.window_out, cap);
    rejects_at(h.try_sell(&whale, 900 * USDT, USDT, 1).map(|_| ()), 0);
}

#[test]
fn credit_from_buying_fades_after_a_window() {
    let (mut h, _) = seeded();
    let (whale, bob) = (key(0xf0), key(0xb0));
    let kas_in = 2_000 * KAS;
    let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in);
    h.buy(&bob, kas_in, got).expect("net buying");
    assert!(h.state.window_out < 0);
    let reserve = h.state.kas_reserve;
    // A window on, the credit has run out: exactly one cap of the reserve is left.
    h.now += WINDOW;
    assert_eq!(cap_left(&h.state, h.age()), share(reserve));
    let (_, _, cap) = window_after(h.state.window_ref, h.state.window_out, h.state.kas_reserve, 0, WINDOW);
    assert_eq!(cap, share(reserve));
    let tokens = 400 * USDT;
    assert!(sell_quote(h.state.kas_reserve, h.state.token_reserve, tokens) > cap);
    rejects_at(h.try_sell(&whale, 900 * USDT, tokens, cap + 1).map(|_| ()), 0);
    h.sell(&whale, 900 * USDT, tokens, cap).expect("one cap, no credit left");
}

#[test]
fn the_first_sell_has_one_cap_however_old_the_chain_is() {
    let (mut h, _) = seeded();
    let whale = key(0xf0);
    // The first deposit set the reference: no history to claim.
    assert_eq!(h.state.window_ref, 10_000 * KAS);
    let cap = share(h.state.kas_reserve);
    assert_eq!(cap_left(&h.state, 0), cap);
    // A year of chain history before the first sell makes no difference.
    h.now += 365 * 24 * WINDOW;
    assert_eq!(cap_left(&h.state, h.age()), cap);
    rejects_at(h.try_sell(&whale, 900 * USDT, 200 * USDT, cap + 1).map(|_| ()), 0);
    h.sell(&whale, 900 * USDT, 200 * USDT, cap).expect("one cap");
    assert_eq!(h.state.window_ref, h.state.kas_reserve);
    rejects_at(h.try_sell(&whale, 900 * USDT, USDT, 1).map(|_| ()), 0);
}

#[test]
fn a_buy_cannot_forge_the_breakers_count() {
    let (mut h, _) = seeded();
    let (whale, bob) = (key(0xf0), key(0xb0));
    let left = cap_left(&h.state, h.age());
    h.sell(&whale, 900 * USDT, 200 * USDT, left).expect("the whole cap");
    h.ready();
    let kas_in = 100 * KAS;
    let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in);
    // Clearing the count, or not crediting it at all, is refused by the pool's script.
    rejects_at(h.try_buy(&bob, kas_in, got, |n, _| n.window_out = 0).map(|_| ()), 0);
    let unchanged = h.state.window_out;
    rejects_at(h.try_buy(&bob, kas_in, got, move |n, _| n.window_out = unchanged).map(|_| ()), 0);
    rejects_at(h.try_buy(&bob, kas_in, got, |n, _| n.window_ref += 1).map(|_| ()), 0);
    // Nor can a buyer leave the credit a withdrawal would hand back off the books.
    rejects_at(h.try_buy(&bob, kas_in, got, |n, _| n.window_credit = 0).map(|_| ()), 0);
    h.buy(&bob, kas_in, got).expect("the honest successor");
}

#[test]
fn withdrawals_shrink_the_cap() {
    let (mut h, _) = seeded();
    let (dan, whale) = (key(0xd0), key(0xf0));
    // Dan owns half the pool.
    let shares = h.state.total_shares;
    let (tx, next, reserve) = h.try_add(&dan, 2_000 * USDT, 10_000 * KAS, 1_000 * USDT, shares).expect("add");
    let position = CovenantOutput::from_tx(&tx, 1).unwrap();
    h.adopt(&tx, next, 2, reserve);
    // A small sell opens the window with 10 000 KAS as its reference (new liquidity lifts it only with time).
    let q = sell_quote(h.state.kas_reserve, h.state.token_reserve, USDT);
    h.sell(&whale, 500 * USDT, USDT, q).unwrap();
    // Dan leaves with half the reserve, MIN_AGE later, and claims that age (with the count far below half of the cap
    // he could claim none); the cap follows the reserve down.
    assert!(!in_regime(&h.state));
    h.now = h.pool_daa + MIN_AGE;
    let kas_out = (shares as i128 * h.state.kas_reserve as i128 / h.state.total_shares as i128) as i64;
    let tokens_out = (shares as i128 * h.state.token_reserve as i128 / h.state.total_shares as i128) as i64;
    let (tx, next, reserve) = h.try_remove(&position, &dan, &dan, shares, kas_out, tokens_out, &dan).expect("remove");
    h.adopt(&tx, next, 1, reserve);
    assert_eq!(h.state.window_ref, h.state.kas_reserve, "a withdrawal drops the reference at once");
    assert!(h.state.window_out > 0 && h.state.window_out < q, "the count kept, less the MIN_AGE refill: {}", h.state.window_out);
    h.ready();
    let left = cap_left(&h.state, h.age());
    assert_eq!(left, share(h.state.kas_reserve) - settle(h.state.window_out, h.age(), share(h.state.kas_reserve)));
    rejects_at(h.try_sell(&whale, 500 * USDT, 200 * USDT, left + 1).map(|_| ()), 0);
    h.sell(&whale, 500 * USDT, 200 * USDT, left).expect("up to the smaller cap");
}

#[test]
fn only_the_guardian_pauses_and_only_the_admin_resumes() {
    let (mut h, lp) = seeded();
    let (bob, stranger) = (key(0xb0), key(0xee));
    let paused = PoolState { paused: true, ..h.state.clone() };
    rejects_at(h.try_key("pause", &stranger, paused.clone(), None).map(|_| ()), 0);
    rejects_at(h.try_key("pause", &h.admin.clone(), paused.clone(), None).map(|_| ()), 0);
    let guardian = h.guardian;
    h.key("pause", &guardian, paused).expect("the guardian pauses");
    assert!(h.state.paused);

    // Swaps and new liquidity stop.
    let kas_in = 100 * KAS;
    rejects_at(h.try_buy(&bob, kas_in, buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in), |_, _| {}).map(|_| ()), 0);
    rejects_at(h.try_sell(&bob, 50 * USDT, 10 * USDT, sell_quote(h.state.kas_reserve, h.state.token_reserve, 10 * USDT)).map(|_| ()), 0);
    let shares = (1_000 * KAS as i128 * h.state.total_shares as i128 / h.state.kas_reserve as i128) as i64;
    rejects_at(h.try_add(&bob, 500 * USDT, 1_000 * KAS, 100 * USDT, shares).map(|_| ()), 0);

    // Resuming: not the guardian, not a stranger; the admin.
    let resumed = PoolState { paused: false, ..h.state.clone() };
    rejects_at(h.try_key("unpause", &guardian, resumed.clone(), None).map(|_| ()), 0);
    rejects_at(h.try_key("unpause", &stranger, resumed.clone(), None).map(|_| ()), 0);
    let admin = h.admin;
    h.key("unpause", &admin, resumed).expect("the admin resumes");
    h.buy(&bob, kas_in, buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in)).expect("swaps again");
    let _ = lp;
}

#[test]
fn withdrawals_stay_open_while_paused() {
    let (mut h, _) = seeded();
    let dan = key(0xd0);
    let (kas_in, tokens_in) = (1_000 * KAS, 100 * USDT);
    let shares = (kas_in as i128 * h.state.total_shares as i128 / h.state.kas_reserve as i128) as i64;
    let (tx, next, reserve) = h.try_add(&dan, 500 * USDT, kas_in, tokens_in, shares).expect("add");
    let position = CovenantOutput::from_tx(&tx, 1).unwrap();
    h.adopt(&tx, next, 2, reserve);
    let guardian = h.guardian;
    h.key("pause", &guardian, PoolState { paused: true, ..h.state.clone() }).unwrap();
    let kas_out = (shares as i128 * h.state.kas_reserve as i128 / h.state.total_shares as i128) as i64;
    let tokens_out = (shares as i128 * h.state.token_reserve as i128 / h.state.total_shares as i128) as i64;
    let (tx, next, reserve) = h.try_remove(&position, &dan, &dan, shares, kas_out, tokens_out, &dan).expect("a provider leaves a paused pool");
    h.adopt(&tx, next, 1, reserve);
    assert!(h.state.paused);
}

#[test]
fn the_reserve_cannot_ride_along_a_pause_or_a_key_change() {
    let (h, _) = seeded();
    let thief = key(0xee);
    let guardian = h.guardian;
    rejects_at(h.try_key("pause", &guardian, PoolState { paused: true, ..h.state.clone() }, Some(&thief)).map(|_| ()), 0);
    let admin = h.admin;
    rejects_at(h.try_key("set_keys", &admin, PoolState { guardian: xonly(&thief), ..h.state.clone() }, Some(&thief)).map(|_| ()), 0);
}

#[test]
fn the_admin_rotates_the_guardian() {
    let (mut h, _) = seeded();
    let (old, new) = (h.guardian, key(0x33));
    let stranger = key(0xee);
    let rotated = PoolState { guardian: xonly(&new), ..h.state.clone() };
    rejects_at(h.try_key("set_keys", &old, rotated.clone(), None).map(|_| ()), 0);
    rejects_at(h.try_key("set_keys", &stranger, rotated.clone(), None).map(|_| ()), 0);
    let admin = h.admin;
    h.key("set_keys", &admin, rotated).expect("the admin rotates the guardian");
    rejects_at(h.try_key("pause", &old, PoolState { paused: true, ..h.state.clone() }, None).map(|_| ()), 0);
    h.key("pause", &new, PoolState { paused: true, ..h.state.clone() }).expect("the new guardian pauses");
}

// ── The breaker at one moment, and over any span ───────────────────────────

/// Least tokens whose sell quote pays at least `kas_out`.
fn tokens_for(x: i64, y: i64, kas_out: i64) -> i64 {
    let (x, y, out) = (x as i128, y as i128, kas_out as i128);
    let eff = y * out / (x - out) + 1;
    (eff * BPS / (BPS - FEE_BPS) + 2) as i64
}

/// Liquidity in, as the covenant allows: the tokens rounded up, the shares down.
fn add_liquidity(h: &mut Harness, who: &Keypair, kas_in: i64) -> Option<(CovenantOutput, i64)> {
    let s = &h.state;
    let tokens_in = ((kas_in as i128 * s.token_reserve as i128 + s.kas_reserve as i128 - 1) / s.kas_reserve as i128) as i64;
    let shares = ((kas_in as i128 * s.total_shares as i128 / s.kas_reserve as i128).min(tokens_in as i128 * s.total_shares as i128 / s.token_reserve as i128)) as i64;
    if shares <= 0 {
        return None;
    }
    let (tx, next, reserve) = h.try_add(who, tokens_in + 1, kas_in, tokens_in, shares).expect("add");
    let position = CovenantOutput::from_tx(&tx, 1).unwrap();
    h.adopt(&tx, next, 2, reserve);
    Some((position, shares))
}

/// A position out, at its share of each reserve.
fn remove_liquidity(h: &mut Harness, who: &Keypair, position: &CovenantOutput, shares: i64) {
    let s = &h.state;
    let kas_out = (shares as i128 * s.kas_reserve as i128 / s.total_shares as i128) as i64;
    let tokens_out = (shares as i128 * s.token_reserve as i128 / s.total_shares as i128) as i64;
    let (tx, next, reserve) = h.try_remove(position, who, who, shares, kas_out, tokens_out, who).expect("remove");
    h.adopt(&tx, next, 1, reserve);
}

/// The pool's buy of exactly `added` KAS into the reserve, whatever its protocol cut.
fn kas_in_for(added: i64) -> i64 {
    (added as i128 * BPS / (BPS - PROTOCOL_BPS) + 1) as i64
}

#[test]
fn buy_add_sell_remove_cycles_move_at_most_one_cap_and_the_forced_refill() {
    // Every step claims the least it may: nothing at or below half of the cap, MIN_AGE above. The only time
    // that passes is what the rule forces, and what leaves is one cap plus the refill of that time.
    let (mut h, _) = seeded();
    let attacker = key(0xf0);
    let start = h.state.kas_reserve;
    let cap0 = share(start);
    let t0 = h.now;
    let mut peak = h.state.window_ref;
    let mut net = 0i64;
    for cycle in 0..25 {
        // Buy two caps of KAS in: credit, at most one cap of it.
        h.ready();
        let reference = h.state.window_ref;
        let buy = 2 * share(reference);
        let kas_in = kas_in_for(buy);
        let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in);
        let before = h.state.kas_reserve;
        peak = peak.max(advance(h.state.window_ref, h.state.kas_reserve, h.age()));
        h.buy(&attacker, kas_in, got).expect("buy");
        net -= h.state.kas_reserve - before;
        // Add a lot of liquidity: the reserve grows, the cap does not.
        h.ready();
        let add = 5 * h.state.kas_reserve;
        peak = peak.max(advance(h.state.window_ref, h.state.kas_reserve, h.age()));
        let (position, shares) = add_liquidity(&mut h, &attacker, add).expect("position");
        assert!(h.state.window_ref <= reference + reference * h.age().max(MIN_AGE) / WINDOW + 1, "new liquidity moves the reference only with time");
        // Sell every sompi the breaker lets out, and one more is refused.
        h.ready();
        let age = h.age();
        peak = peak.max(advance(h.state.window_ref, h.state.kas_reserve, age));
        let room = cap_left(&h.state, age);
        assert!(room > 0, "cycle {cycle}");
        let t = tokens_for(h.state.kas_reserve, h.state.token_reserve, room);
        h.sell(&attacker, t + 1, t, room).unwrap_or_else(|e| panic!("cycle {cycle}: {e:?}"));
        net += room;
        let t2 = tokens_for(h.state.kas_reserve, h.state.token_reserve, 1);
        rejects_at(h.try_sell(&attacker, t2 + 1, t2, 1).map(|_| ()), 0);
        // Take the liquidity back out.
        h.ready();
        peak = peak.max(advance(h.state.window_ref, h.state.kas_reserve, h.age()));
        remove_liquidity(&mut h, &attacker, &position, shares);
        assert!(h.state.window_ref <= h.state.kas_reserve);
    }
    let elapsed = h.now - t0;
    let cap = share(peak);
    let bound = cap + (cap as i128 * elapsed as i128 / WINDOW as i128) as i64 + 25;
    println!("25 buy-add-sell-remove cycles at the shortest claims: net {net} sompi out in {elapsed} DAA; one cap is {cap0}, the bound {bound}");
    assert!(net <= bound, "net outflow {net} over one cap of the largest reference plus the refill of {elapsed} DAA: {bound}");
    assert!(h.state.kas_reserve >= start - bound, "the reserve fell past the bound: {}", h.state.kas_reserve);
}

#[test]
fn a_large_sell_then_a_large_exit_shuts_sells_for_two_windows_at_most() {
    // Liquidity held for some windows lifts the reference; a sell of its cap, and the liquidity leaves.
    let (mut h, _) = seeded();
    let whale = key(0xf0);
    let start = h.state.kas_reserve;
    let (position, shares) = add_liquidity(&mut h, &whale, 31 * start).expect("position");
    for _ in 0..5 {
        h.now += WINDOW;
        let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, KAS);
        h.buy(&whale, KAS, got).expect("a buy claiming the window");
    }
    let room = cap_left(&h.state, 0);
    let t = tokens_for(h.state.kas_reserve, h.state.token_reserve, room);
    h.sell(&whale, t + 1, t, room).expect("the sell of the cap");
    let count = h.state.window_out;
    h.ready();
    remove_liquidity(&mut h, &whale, &position, shares);
    let cap = share(h.state.window_ref);
    assert!(count > 3 * cap, "the sell counted {count}, the small pool's cap is {cap}");
    assert_eq!(h.state.window_out, 2 * cap, "cut down to two caps of the smaller pool");
    assert_eq!(cap_left(&h.state, 0), 0, "and no room comes of it");
    let t2 = tokens_for(h.state.kas_reserve, h.state.token_reserve, 1);
    rejects_at(h.try_sell(&whale, t2 + 1, t2, 1).map(|_| ()), 0);
    // Two windows later a whole cap is back.
    h.now += 2 * WINDOW;
    assert_eq!(cap_left(&h.state, h.age()), share(h.state.window_ref.min(h.state.kas_reserve)));
    let t3 = tokens_for(h.state.kas_reserve, h.state.token_reserve, KAS);
    h.sell(&whale, t3 + 1, t3, KAS).expect("sells open again after two windows");
}

#[test]
fn an_exit_that_leaves_the_reference_alone_cuts_nothing() {
    let (mut h, _) = seeded();
    let whale = key(0xf0);
    let more = 3 * h.state.kas_reserve;
    add_liquidity(&mut h, &whale, more).expect("a large position");
    let little = h.state.kas_reserve / 100;
    let (small, small_shares) = add_liquidity(&mut h, &whale, little).expect("a small position");
    let room = cap_left(&h.state, 0);
    let t = tokens_for(h.state.kas_reserve, h.state.token_reserve, room);
    h.sell(&whale, t + 1, t, room).expect("the sell of the cap");
    // The small position leaves MIN_AGE later: the reserve stays far above the reference, so the
    // count is only settled by the MIN_AGE the withdrawal claims, never cut.
    h.ready();
    let before = h.state.clone();
    let (reference, settled, _) = settled_breaker(&before, MIN_AGE);
    remove_liquidity(&mut h, &whale, &small, small_shares);
    assert!(h.state.kas_reserve > reference);
    assert_eq!(h.state.window_ref, reference);
    assert_eq!(h.state.window_out, settled);
    assert!(settled < before.window_out && settled > 0);
}

#[test]
fn the_reserve_keeps_its_kas_deposit() {
    let (h, _) = seeded();
    let bob = key(0xb0);
    let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, KAS);
    // Stripping the deposit is refused by the pool's own script.
    rejects_at(h.try_buy_keeping(&bob, KAS, got, |_, _| {}, 10_000_000).map(|_| ()), 0);
    rejects_at(h.try_buy_keeping(&bob, KAS, got, |_, _| {}, 99_999_999).map(|_| ()), 0);
    h.try_buy_keeping(&bob, KAS, got, |_, _| {}, 100_000_000).expect("exactly the minimum");
    h.try_buy_keeping(&bob, KAS, got, |_, _| {}, TOKEN_SOMPI).expect("the usual deposit");
}

#[test]
fn the_reference_rises_only_with_claimed_time() {
    let (mut h, _) = seeded();
    let (whale, dan) = (key(0xf0), key(0xd0));
    let reference = h.state.window_ref;
    let x = h.state.kas_reserve;
    // A large buy and new liquidity at one moment: the reference stays.
    let got = buy_quote(x, h.state.token_reserve, 3_000 * KAS);
    h.buy(&whale, 3_000 * KAS, got).expect("buy");
    assert_eq!(h.state.window_ref, reference);
    add_liquidity(&mut h, &dan, 10_000 * KAS).expect("add");
    assert_eq!(h.state.window_ref, reference);
    // A quarter of a window later (claimed by the next swap) it moves a quarter of the way.
    h.now += WINDOW / 4;
    let gap = (h.state.kas_reserve - reference).min(reference); // at most its own size per window, however much arrived
    let t = sell_quote(h.state.kas_reserve, h.state.token_reserve, 1) + 1;
    let (tx, next, reserve) = h.try_sell(&whale, 2 * USDT, USDT, t).expect("a sell claiming the age");
    h.adopt(&tx, next, 1, reserve);
    assert_eq!(h.state.window_ref, reference + gap / 4);
    // A swap that claims nothing (age 0) leaves it where it is, and a full window at most doubles it.
    let settled = h.state.window_ref;
    let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, KAS);
    h.buy(&whale, KAS, got).expect("buy at age 0");
    assert_eq!(h.state.window_ref, settled);
    h.now += WINDOW;
    let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, KAS);
    let before = h.state.kas_reserve;
    h.buy(&whale, KAS, got).expect("buy after a window");
    assert_eq!(h.state.window_ref, settled + (before - settled).min(settled));
}

#[test]
fn a_busy_pool_still_converges() {
    // A busy pool: a swap every 200 DAA, each claiming its age. The reserve is 10 x the
    // reference; the reference grows by at most its own size per window, compounding.
    let (mut h, _) = seeded();
    let (bob, dan) = (key(0xb0), key(0xd0));
    add_liquidity(&mut h, &dan, 90_000 * KAS).expect("add");
    let start = h.state.window_ref;
    for _ in 0..180 {
        h.now += 200;
        let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, KAS);
        h.buy(&bob, KAS, got).expect("a small buy");
    }
    println!("reference after one window of 180 swaps: {} from {start}, reserve {}", h.state.window_ref, h.state.kas_reserve);
    assert!(h.state.window_ref > start * 5 / 2 && h.state.window_ref < start * 3, "{} from {start}", h.state.window_ref);
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// One point of the run: after this step, the net KAS sells took out so far, the
/// clock, the allowance used and the largest reference any step up to here relied on.
#[derive(Clone, Copy)]
struct Point {
    net: i64,
    now: i64,
    used: i64,
    reference: i64,
    /// Age the pool UTXO already has here: a later swap may claim it.
    pending: i64,
}

fn random_sequence(seed: u64, steps: usize) {
    let mut rng = Rng(seed);
    let (mut h, _) = seeded();
    let whale = key(0xf0);
    let mut positions: Vec<(CovenantOutput, i64)> = Vec::new();
    let mut net = 0i64;
    let mut log = vec![Point { net, now: h.now, used: h.state.window_out, reference: h.state.window_ref, pending: 0 }];
    let (mut buys, mut sells, mut adds, mut removes, mut refused) = (0, 0, 0, 0, 0);
    for _ in 0..steps {
        let op = rng.below(12);
        // An honest client waits for the least claim the pool allows (MIN_AGE while more than half of the cap is in use).
        if op <= 9 {
            h.ready();
        }
        let s = h.state.clone();
        let elapsed = h.age();
        let cap = share(s.window_ref.min(s.kas_reserve).max(1));
        // The reference the next swap reaches with the age it claims.
        let peak = advance(s.window_ref, s.kas_reserve, elapsed);
        match op {
            0..=2 => {
                let mut added = 1 + (rng.below(3 * cap as u64 + 1) as i64);
                added = added.min(s.kas_reserve);
                let kas_in = kas_in_for(added);
                let got = buy_quote(s.kas_reserve, s.token_reserve, kas_in);
                if got <= 0 || got >= s.token_reserve {
                    continue;
                }
                h.buy(&whale, kas_in, got).expect("a buy");
                net -= h.state.kas_reserve - s.kas_reserve;
                buys += 1;
            }
            3..=6 => {
                let room = cap_left(&s, elapsed);
                if room <= 0 {
                    let t = tokens_for(s.kas_reserve, s.token_reserve, 1);
                    rejects_at(h.try_sell(&whale, t + 1, t, 1).map(|_| ()), 0);
                    refused += 1;
                    continue;
                }
                let out = if rng.below(2) == 0 { room } else { 1 + rng.below(room as u64) as i64 };
                let t = tokens_for(s.kas_reserve, s.token_reserve, out);
                if t > 200_000_000_000_000 {
                    continue;
                }
                h.sell(&whale, t + 1, t, out).expect("a sell inside the room");
                net += out;
                sells += 1;
                // Every sompi past the room is refused, as soon as the pool UTXO allows another sell.
                let now = h.now;
                h.ready();
                let age = h.age();
                let probe = cap_left(&h.state, age) + 1;
                let t2 = tokens_for(h.state.kas_reserve, h.state.token_reserve, probe);
                rejects_at(h.try_sell(&whale, t2 + 1, t2, probe).map(|_| ()), 0);
                h.now = now;
            }
            7..=8 => {
                let kas_in = 1 + rng.below(s.kas_reserve as u64 / 2 + 1) as i64;
                if let Some(p) = add_liquidity(&mut h, &whale, kas_in) {
                    positions.push(p);
                    adds += 1;
                }
            }
            9 => {
                if let Some(i) = (!positions.is_empty()).then(|| rng.below(positions.len() as u64) as usize) {
                    let (position, shares) = positions.swap_remove(i);
                    remove_liquidity(&mut h, &whale, &position, shares);
                    removes += 1;
                }
            }
            _ => {
                h.now += [0, 1, 10, 100, 1_000, WINDOW / 4, WINDOW, 3 * WINDOW][rng.below(8) as usize];
            }
        }
        let peak = peak.max(h.state.window_ref);
        log.push(Point { net, now: h.now, used: h.state.window_out, reference: peak, pending: h.now - h.pool_daa });
    }
    println!("seed {seed}: {buys} buys, {sells} sells, {adds} adds, {removes} removes, {refused} refused sells; reserve {} ref {}", h.state.kas_reserve, h.state.window_ref);

    // Over every span [i, j]: net KAS out <= one cap of the largest reference
    // in the span, plus the credit the span starts with, plus the refill for
    // its time (counting the age the pool UTXO already had when the span
    // began, which a swap in it may claim), plus one sompi of rounding per step.
    for i in 0..log.len() {
        let credit = (-log[i].used).max(0);
        let mut peak = log[i].reference;
        for j in i + 1..log.len() {
            peak = peak.max(log[j].reference);
            let t = log[j].now - log[i].now + log[i].pending;
            let cap = share(peak);
            let refill = (cap as i128 * t as i128 / WINDOW as i128) as i64;
            let bound = cap + credit + refill + (j - i) as i64;
            let moved = log[j].net - log[i].net;
            assert!(moved <= bound, "seed {seed}: span {i}..{j} moved {moved}, bound {bound} (cap {cap} credit {credit} refill {refill} t {t})");
            if t == 0 {
                assert!(moved <= share(log[i].reference) + credit + (j - i) as i64, "seed {seed}: frozen span {i}..{j} moved {moved}");
            }
        }
    }
}

#[test]
fn random_sequences_of_every_entry_stay_within_the_bound() {
    for seed in [0x1234_5678_9abc_def1u64, 0xdead_beef_cafe_f00d, 0x0fed_cba9_8765_4321] {
        random_sequence(seed, 160);
    }
}

// ── The tick (SPEC §15, the clock fix of 10 November 2026) ─────────────────

#[test]
fn a_tick_banks_the_age_so_a_later_short_claim_takes_nothing_back() {
    let (mut h, _) = seeded();
    let (whale, bot) = (key(0xf0), key(0xf3));
    let cap = share(h.state.kas_reserve);
    h.sell(&whale, 900 * USDT, 200 * USDT, cap).expect("the whole cap");
    // Half a window passes and a keeper's tick claims it: only the breaker moves.
    h.now += WINDOW / 2;
    let before = h.state.clone();
    h.tick().expect("anyone's tick");
    assert_eq!((h.state.window_ref, h.state.window_out, h.state.window_credit), settled_breaker(&before, WINDOW / 2));
    assert_eq!((h.state.kas_reserve, h.state.token_reserve, h.state.total_shares, h.state.protocol_kas, h.state.protocol_tokens, h.state.paused),
        (before.kas_reserve, before.token_reserve, before.total_shares, before.protocol_kas, before.protocol_tokens, before.paused));
    let banked = cap_left(&h.state, 0);
    assert!(banked > 0 && banked >= cap_left(&before, WINDOW / 2) - 1, "the tick kept the half window's room: {banked}");
    // A bot's dust buy claiming only the minimum can't take that back: the room only grows.
    h.now += MIN_AGE;
    let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, 2_000);
    assert!(got >= 1);
    h.buy(&bot, 2_000, got).expect("a dust buy at the minimum claim");
    h.ready();
    let room = cap_left(&h.state, h.age());
    assert!(room >= banked, "{room} < {banked}");
    let t = tokens_for(h.state.kas_reserve, h.state.token_reserve, room);
    h.sell(&whale, t + 1, t, room).expect("the seller gets the banked room");
}

#[test]
fn a_tick_is_held_to_its_pool_utxos_age_and_moves_nothing_but_the_breaker() {
    let (mut h, _) = seeded();
    let (whale, thief) = (key(0xf0), key(0xee));
    let cap = share(h.state.kas_reserve);
    h.sell(&whale, 900 * USDT, 200 * USDT, cap).expect("the whole cap");
    h.now += MIN_AGE;
    // Consensus: a sequence past the UTXO's age; the script: a claim past the sequence, or under the minimum.
    rejects_at(h.try_tick_with(MIN_AGE + 1, (MIN_AGE + 1) as u64, |_| {}, None, None).map(|_| ()), 0);
    rejects_at(h.try_tick_with(MIN_AGE, (MIN_AGE - 1) as u64, |_| {}, None, None).map(|_| ()), 0);
    rejects_at(h.try_tick_with(MIN_AGE - 1, (MIN_AGE - 1) as u64, |_| {}, None, None).map(|_| ()), 0);
    // The pool's value, the reserve beside it, and a successor that forgives more.
    let value = h.state.value();
    rejects_at(h.try_tick_with(MIN_AGE, MIN_AGE as u64, |_| {}, Some(value + 1), None).map(|_| ()), 0);
    rejects_at(h.try_tick_with(MIN_AGE, MIN_AGE as u64, |_| {}, Some(value - 1), None).map(|_| ()), 0);
    rejects_at(h.try_tick_with(MIN_AGE, MIN_AGE as u64, |_| {}, None, Some(&thief)).map(|_| ()), 0);
    rejects_at(h.try_tick_with(MIN_AGE, MIN_AGE as u64, |n| n.window_out = 0, None, None).map(|_| ()), 0);
    rejects_at(h.try_tick_with(MIN_AGE, MIN_AGE as u64, |n| n.kas_reserve -= 1, None, None).map(|_| ()), 0);
    h.tick().expect("the honest tick");
}
