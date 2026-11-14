//! KasPool in the Kaspa script engine: every transaction spends the pool and
//! its kUSDT reserve together (two covenant families), and is executed input
//! by input with the covenant-enabled engine.

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
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
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


// ---- independent review: no-time drain through buy-then-sell cycles ----

/// Least tokens whose sell quote pays at least `kas_out`.
fn tokens_for(x: i64, y: i64, kas_out: i64) -> i64 {
    let (x, y, out) = (x as i128, y as i128, kas_out as i128);
    let eff = y * out / (x - out) + 1;
    (eff * BPS / (BPS - FEE_BPS) + 2) as i64
}

#[test]
fn review_buy_then_sell_cycles_no_longer_drain_at_the_shortest_claims() {
    // The review's cycle (buy two caps, sell all the room) with every spend at the shortest claim the pool allows:
    // none while at most half the cap is in use, MIN_AGE above that. Only the time those claims force passes.
    let (mut h, _) = seeded();
    let attacker = key(0xf0);
    let start = h.state.kas_reserve;
    let cap0 = share(start);
    // One honest-sized dump uses the whole allowance.
    let t = tokens_for(h.state.kas_reserve, h.state.token_reserve, cap0);
    h.sell(&attacker, t + 1, t, cap0).expect("first cap");
    rejects_at(h.try_sell(&attacker, 2 * USDT, USDT, 1).map(|_| ()), 0);
    let mut forged: i64 = t;
    let mut kas_paid: i64 = 0;
    let mut kas_got: i64 = cap0;
    let t0 = h.now;
    let wait = |h: &mut Harness| {
        if in_regime(&h.state) && h.age() < MIN_AGE {
            h.now = h.pool_daa + MIN_AGE;
        }
    };
    for cycle in 0..40 {
        // Buy two caps' worth: `used` goes to at most -cap.
        wait(&mut h);
        let cap = share(h.state.window_ref.min(h.state.kas_reserve));
        let kas_in = ((2 * cap) as i128 * BPS / (BPS - PROTOCOL_BPS) + 1) as i64;
        let got = buy_quote(h.state.kas_reserve, h.state.token_reserve, kas_in);
        h.buy(&attacker, kas_in, got).expect("buy");
        forged -= got;
        kas_paid += kas_in;
        // Sell everything the breaker now allows.
        wait(&mut h);
        let room = cap_left(&h.state, h.age());
        if room == 0 {
            continue;
        }
        let t = tokens_for(h.state.kas_reserve, h.state.token_reserve, room);
        h.sell(&attacker, t + 1, t, room).unwrap_or_else(|e| panic!("cycle {cycle}: {e:?}"));
        forged += t;
        kas_got += room;
        // One sompi more is refused, as soon as the pool UTXO allows another sell: the cycle gave nothing beyond
        // what the buy added and that wait refilled.
        let now = h.now;
        wait(&mut h);
        let probe = cap_left(&h.state, h.age()) + 1;
        let t2 = tokens_for(h.state.kas_reserve, h.state.token_reserve, probe);
        rejects_at(h.try_sell(&attacker, t2 + 1, t2, probe).map(|_| ()), 0);
        h.now = now;
    }
    let net = kas_got - kas_paid;
    let elapsed = h.now - t0;
    let bound = cap0 + (cap0 as i128 * elapsed as i128 / WINDOW as i128) as i64 + 40;
    println!("start {start} end {} net KAS to attacker {net} in {elapsed} DAA (one cap = {cap0}, bound {bound}) forged kUSDT spent {forged}", h.state.kas_reserve);
    assert!(net <= bound, "net outflow at the shortest claims is {net}, one cap and the refill of {elapsed} DAA is {bound}");
}
