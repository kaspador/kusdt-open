//! Attacks on the covenants, run in the script engine. Each test states the
//! attack and passes when the attack FAILS.

mod common;

use std::sync::OnceLock;

use argent::artifact::Artifact;
use argent_runtime::{ArtifactBundle, BuilderError, CovenantOutput, EntryCall, TxBuilder, TxContext, args, state};
use common::{
    Govern, Harness, MINTER_SOMPI, Rejected, State, funding, funding_sig, key, outpoint, rejects, run, sign_input, xonly,
};
use kaspa_consensus_core::{
    Hash,
    tx::{CovenantBinding, Transaction, TransactionOutpoint, UtxoEntry},
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
const T0: i64 = 5_000_000;
const KUSDT_ID: [u8; 32] = [0x11; 32];
const POOL_ID: [u8; 32] = [0x22; 32];

fn kusdt() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("kusdt.ag", "test-adv-pool-kusdt").expect("kUSDT compiles"))
}

fn pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("pool.ag", "test-adv-pool").expect("pool compiles"))
}

fn pool_builder() -> TxBuilder<'static> {
    let bundle = ArtifactBundle::new(pool_artifact()).unwrap().with_artifact(kusdt()).unwrap();
    TxBuilder::from_bundle(&bundle).expect("bundle builder")
}

fn share(base: i64) -> i64 {
    (base as i128 * MAX_OUT_BPS as i128 / BPS) as i64
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

fn rejected(e: BuilderError) -> Rejected {
    match e {
        BuilderError::InputScript { .. } | BuilderError::TxScript(_) => Rejected::Script(e.to_string()),
        other => Rejected::Build(other.to_string()),
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

fn user_state(key: &Keypair, amount: i64) -> State {
    token_state(xonly(key), 0x00, amount)
}

fn reserve_state(amount: i64) -> State {
    token_state(POOL_ID, 0x04, amount)
}

#[derive(Clone, Debug)]
struct Pool {
    x: i64,
    y: i64,
    s: i64,
    pt: i64,
    /// The breaker's reference and the allowance used.
    window: (i64, i64),
}

impl Pool {
    fn state(&self) -> State {
        state! {
            token_covid: KUSDT_ID.to_vec(),
            kas_reserve: self.x,
            token_reserve: self.y,
            total_shares: self.s,
            protocol_kas: 0i64,
            protocol_tokens: self.pt,
            base_value: BASE,
            admin: xonly(&key(0x30)).to_vec(),
            max_out_bps: MAX_OUT_BPS,
            window_len: WINDOW,
            window_credit: 0i64,
            window_ref: self.window.0,
            window_out: self.window.1,
            paused: false,
            guardian: xonly(&key(0x32)).to_vec()
        }
    }
    fn value(&self) -> u64 {
        (BASE + self.x) as u64
    }
}

struct PoolHarness {
    b: TxBuilder<'static>,
    p: Pool,
    pool: (TransactionOutpoint, UtxoEntry),
    reserve: (TransactionOutpoint, UtxoEntry),
    next: std::cell::Cell<u32>,
    /// The DAA score the next transaction is accepted at.
    now: i64,
    /// The DAA score the current pool UTXO was accepted at.
    pool_daa: i64,
}

/// A pool whose breaker has never run, holding `x` KAS and `y` kUSDT.
fn seeded(x: i64, y: i64) -> PoolHarness {
    let b = pool_builder();
    let lp = key(0xa1);
    let genesis = Pool { x: 0, y: 0, s: 0, pt: 0, window: (0, 0) };
    let pool_utxo = b.covenant_utxo("Pool", genesis.state(), genesis.value(), 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
    let held = y * 2;
    let provider = user_state(&lp, held);
    let provider_utxo = b.covenant_utxo("kusdt::KCC20", provider.clone(), TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap();
    let change = user_state(&lp, held - y);
    let next = Pool { x, y, s: x, window: (x, 0), ..genesis.clone() };
    let next_states = vec![reserve_state(y), change.clone()];
    let ctx = TxContext::new()
        .actor_input("Pool", genesis.state(), { let (a0, a1, a2, admin) = (x, xonly(&lp).to_vec(), change.clone(), key(0x30)); EntryCall::new("init").args_with(move |tx, i| args!(a0, a1.clone(), a2.clone(), sign_input(tx, i, &admin))) }, outpoint(0x40, 0), pool_utxo.clone(), 0)
        .actor_input("kusdt::KCC20", provider, EntryCall::new("transfer").args_with(move |tx, i| {
            let mut w = vec![0x00];
            w.extend(sign_input(tx, i, &lp));
            args!(next_states.clone(), w)
        }), outpoint(0x41, 0), provider_utxo.clone(), 0)
        .input(outpoint(0x42, 0), funding(), funding_sig(), 0)
        .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
        .actor_output("Position", state! { token_covid: KUSDT_ID.to_vec(), shares: x - MIN_LIQUIDITY, owner: xonly(&key(0xa1)).to_vec() }, CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
        .actor_output("kusdt::KCC20", reserve_state(y), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
        .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let tx = b.build(&ctx).expect("init builds");
    let tx = run(tx, vec![pool_utxo, provider_utxo, funding()]).expect("init runs");
    let pool = CovenantOutput::from_tx(&tx, 0).unwrap();
    let reserve = CovenantOutput::from_tx(&tx, 2).unwrap();
    PoolHarness { b, p: next, pool: (pool.outpoint, pool.utxo), reserve: (reserve.outpoint, reserve.utxo), next: std::cell::Cell::new(0), now: T0, pool_daa: T0 }
}

impl PoolHarness {
    fn fresh(&self) -> TransactionOutpoint {
        let n = self.next.get();
        self.next.set(n + 1);
        outpoint(0x50, n)
    }

    /// The age this pool UTXO has, at most two windows: what an honest client claims.
    fn age(&self) -> i64 {
        (self.now - self.pool_daa).clamp(0, 2 * WINDOW)
    }

    /// Builds a sell without running the whole-transaction check twice: returns
    /// the transaction, its UTXOs and the successor. `elapsed` is the sell's
    /// clock, `sequence` the pool input's relative lock.
    fn build_sell(&self, seller: &Keypair, held: i64, tokens_in: i64, kas_out: i64, elapsed: i64, sequence: u64) -> Result<(Transaction, Vec<UtxoEntry>, Pool), Rejected> {
        // Consensus, before the scripts run: the input's relative lock must be met.
        if sequence as i64 > self.now - self.pool_daa {
            return Err(Rejected::Script("input 0 script failed: sequence lock (consensus)".into()));
        }
        let s = &self.p;
        let cut = (tokens_in as i128 * PROTOCOL_BPS / BPS) as i64;
        let (reference, used, _) = window_after(s.window.0, s.window.1, s.x, kas_out, elapsed);
        let next = Pool { x: s.x - kas_out, y: s.y + tokens_in - cut, pt: s.pt + cut, window: (reference, used), ..s.clone() };
        let reserve_out = next.y + next.pt;
        let change = user_state(seller, held - tokens_in);
        let payer_out = self.fresh();
        let payer_utxo = self.b.covenant_utxo("kusdt::KCC20", user_state(seller, held), TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap();
        let seller_key = *seller;
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new("sell").args(args!(kas_out, elapsed, change.clone())), self.pool.0, self.pool.1.clone(), sequence)
            .actor_input("kusdt::KCC20", reserve_state(s.y + s.pt), EntryCall::new("transfer").args(args!(vec![reserve_state(reserve_out), change.clone()], vec![0x00u8])), self.reserve.0, self.reserve.1.clone(), 0)
            .actor_input("kusdt::KCC20", user_state(seller, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &seller_key))), payer_out, payer_utxo.clone(), 0)
            .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.b.build(&ctx).map_err(rejected)?;
        Ok((tx, vec![self.pool.1.clone(), self.reserve.1.clone(), payer_utxo], next))
    }

    fn sell(&mut self, seller: &Keypair, held: i64, tokens_in: i64, kas_out: i64, elapsed: i64, sequence: u64) -> Result<(), Rejected> {
        let (tx, utxos, next) = self.build_sell(seller, held, tokens_in, kas_out, elapsed, sequence)?;
        let tx = run(tx, utxos)?;
        let pool = CovenantOutput::from_tx(&tx, 0).unwrap();
        let reserve = CovenantOutput::from_tx(&tx, 1).unwrap();
        self.pool = (pool.outpoint, pool.utxo);
        self.reserve = (reserve.outpoint, reserve.utxo);
        self.p = next;
        self.pool_daa = self.now;
        Ok(())
    }

    /// What sells may take out now (an honest clock).
    fn room(&self) -> i64 {
        let (_, out, cap) = window_after(self.p.window.0, self.p.window.1, self.p.x, 0, self.age());
        (cap - out).max(0)
    }

    /// As much of the breaker's room as there is, paid for with forged kUSDT. None when there is no room.
    fn dump(&mut self, forger: &Keypair) -> Option<i64> {
        let room = self.room();
        if room <= 0 {
            return None;
        }
        let (x, y) = (self.p.x, self.p.y);
        let kas_out = room;
        let eff = y as i128 * kas_out as i128 / (x - kas_out) as i128 + 2;
        let tokens_in = (eff * BPS / (BPS - FEE_BPS) + 2) as i64;
        assert!(sell_quote(x, y, tokens_in) >= kas_out, "enough forged kUSDT for the room");
        let elapsed = self.age();
        self.sell(forger, FORGED, tokens_in, kas_out, elapsed, elapsed as u64).expect("the dump within the room is accepted");
        Some(kas_out)
    }
}

/// What one state of forged kUSDT holds; the sells spend part of it.
const FORGED: i64 = 200_000_000_000_000;

fn sell_quote(x: i64, y: i64, tokens_in: i64) -> i64 {
    let eff = tokens_in as i128 * (BPS - FEE_BPS) / BPS;
    (x as i128 * eff / (y as i128 + eff)) as i64
}

fn pct(part: i64, whole: i64) -> f64 {
    part as f64 * 100.0 / whole as f64
}

// -- Finding 1: the breaker's windows accumulated behind a backdated clock -----

/// Before the fix the clock was the sell's own claim, with only an upper bound
/// (the lock time), so a seller could claim old times one window apart and open
/// a fresh window each time: a day without sells gave 24 windows at once (92 %
/// of the reserve). The clock is now the pool UTXO's age, which consensus
/// proves: however long the pool stood, one moment gives one cap.
#[test]
fn attack_a_day_without_sells_gives_no_more_than_one_cap() {
    let mut h = seeded(10_000 * KAS, 1_000 * USDT);
    let (honest, forger) = (key(0xc0), key(0xee));

    // The last honest sell, then 24 hours with no sell.
    let q = sell_quote(h.p.x, h.p.y, USDT);
    h.sell(&honest, 100 * USDT, USDT, q, 0, 0).expect("an honest sell");
    assert_eq!(h.p.window.1, q);
    h.now += 24 * WINDOW;
    let start = h.p.x;

    // The first dump gets one cap, even claiming every bit of age it may.
    let first = h.dump(&forger).expect("the first dump");
    assert_eq!(first, start / 10, "one cap");

    // The dump is over: at this moment there is no age left to claim, in any form.
    assert_eq!(h.room(), 0);
    rejects(h.build_sell(&forger, FORGED, 100 * USDT, 1, 0, 0).and_then(|(t, u, _)| run(t, u)));
    // Claiming the old idle time needs a sequence the fresh UTXO does not meet.
    for claim in [1, WINDOW / 24, WINDOW] {
        rejects(h.build_sell(&forger, FORGED, 100 * USDT, 1, claim, claim as u64).and_then(|(t, u, _)| run(t, u)));
    }
    assert!(h.p.x * 100 >= start * 89, "one cap and no more: {:.1} % gone", 100.0 - pct(h.p.x, start));
}

/// The same attack with the sell clock walked forward a window at a time, the way
/// the old rule allowed it: every later step needs a pool UTXO older than the one it finds.
#[test]
fn attack_claims_spaced_a_window_apart_get_nowhere() {
    let mut h = seeded(10_000 * KAS, 1_000 * USDT);
    let forger = key(0xee);
    h.now += 24 * WINDOW;
    let first = h.dump(&forger).expect("the one cap this moment has");
    assert_eq!(first, h.p.x * 1_000 / 9_000);
    for k in 2..=24 {
        let claimed = WINDOW * k;
        rejects(h.build_sell(&forger, FORGED, 100 * USDT, 1, WINDOW, claimed as u64).and_then(|(t, u, _)| run(t, u)));
    }
}

/// Genesis no longer leaves history to claim: the reference is zero and nothing
/// is used, so the first sell ever gets exactly one cap, however old the chain is.
#[test]
fn attack_the_first_sell_ever_gets_one_cap_whatever_the_clock() {
    let mut h = seeded(10_000 * KAS, 1_000 * USDT);
    let forger = key(0xee);
    let start = h.p.x;
    h.now = T0 + 100 * WINDOW;
    let first = h.dump(&forger).expect("the first dump");
    assert_eq!(first, start / 10, "one cap");
    assert_eq!(h.room(), 0, "nothing more at this moment");
    for claim in [1, WINDOW] {
        rejects(h.build_sell(&forger, FORGED, 100 * USDT, 1, claim, claim as u64).and_then(|(t, u, _)| run(t, u)));
    }
}

/// Over any stretch of time, what leaves is at most about one cap plus one cap
/// per window: an attacker emptying the breaker at every step gets no more.
#[test]
fn attack_draining_the_breaker_step_by_step_stays_within_the_refill() {
    let mut h = seeded(10_000 * KAS, 1_000 * USDT);
    let forger = key(0xee);
    let start = h.p.x;
    let mut taken = 0i64;
    let step = WINDOW / 4;
    for i in 0..40 {
        h.dump(&forger).map(|out| taken += out);
        h.now += step;
        let elapsed = (i + 1) as i64 * step;
        // Every cap taken is 10 % of a reserve no bigger than the start's.
        let bound = (start as i128 * MAX_OUT_BPS as i128 / BPS) as i64;
        assert!(taken <= bound + (bound as i128 * elapsed as i128 / WINDOW as i128) as i64, "after {i} steps: {taken}");
    }
    println!("step by step over 10 windows: {:.1} % of the KAS reserve", pct(taken, start));
    assert!(pct(taken, start) < 75.0, "bound holds: {taken}");
}

// -- Finding 2: the age_daa of a governance message was not signed (it is since rc.16) --

fn pushes(script: &[u8]) -> Vec<Vec<u8>> {
    let (mut out, mut i) = (Vec::new(), 0usize);
    while i < script.len() {
        let op = script[i];
        i += 1;
        match op {
            0x00 => out.push(vec![]),
            0x01..=0x4b => {
                out.push(script[i..i + op as usize].to_vec());
                i += op as usize;
            }
            0x4c => {
                let n = script[i] as usize;
                out.push(script[i + 1..i + 1 + n].to_vec());
                i += 1 + n;
            }
            0x4d => {
                let n = u16::from_le_bytes([script[i], script[i + 1]]) as usize;
                out.push(script[i + 2..i + 2 + n].to_vec());
                i += 2 + n;
            }
            0x4f => out.push(vec![0x81]),
            0x51..=0x60 => out.push(vec![op - 0x50]),
            _ => panic!("not a push-only script: {op:#x}"),
        }
    }
    out
}

fn push_script(items: &[Vec<u8>]) -> Vec<u8> {
    let mut s = Vec::new();
    for d in items {
        match d.len() {
            0 => s.push(0x00),
            1 if (1..=16).contains(&d[0]) => s.push(0x50 + d[0]),
            1 if d[0] == 0x81 => s.push(0x4f),
            n if n <= 75 => {
                s.push(n as u8);
                s.extend_from_slice(d);
            }
            n if n <= 255 => {
                s.push(0x4c);
                s.push(n as u8);
                s.extend_from_slice(d);
            }
            n => {
                s.push(0x4d);
                s.extend_from_slice(&(n as u16).to_le_bytes());
                s.extend_from_slice(d);
            }
        }
    }
    s
}

/// Rewrites one argument of an input, leaving every signature untouched.
fn with_argument(tx: &Transaction, input: usize, argument: usize, value: Vec<u8>) -> Transaction {
    let mut forged = tx.clone();
    let mut items = pushes(&forged.inputs[input].signature_script);
    items[argument] = value;
    forged.inputs[input].signature_script = push_script(&items);
    forged
}

/// `age_daa` is argument 2 of `govern`. Since rc.16 the digest covers it as a number (govern_signed_age.rs), so
/// anyone who sees a governance transaction can resend it only with the same number spelled differently, and
/// the followers read the same one. (When this finding was written the digest did not cover it at all.)
#[test]
fn probe_which_age_values_an_unpause_accepts() {
    let mut h = Harness::launch();
    h.pause().unwrap();
    let (unpause, _) = h.try_govern(Govern::Unpause, &[0, 1, 2, 3]).expect("unpause");
    let items = pushes(&unpause.inputs[0].signature_script);
    println!("PROBE args: {:?}", items.iter().map(|p| p.len()).collect::<Vec<_>>());
    println!("PROBE honest age_daa push: {:02x?}", items[2]);
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("same", items[2].clone()),
        ("other valid number", vec![0x39, 0x30]),
        ("empty (0)", vec![]),
        ("negative", vec![0x05, 0x80]),
        ("eight bytes", vec![0x7f; 8]),
        ("non-minimal", vec![0x05, 0x00]),
        ("nine bytes", vec![0xff; 9]),
        ("all zero", vec![0x00; 4]),
    ];
    for (name, value) in cases {
        let r = run(with_argument(&unpause, 0, 2, value), vec![h.minter.utxo.clone(), funding()]);
        println!("PROBE {name}: {:?}", r.map(|_| "ACCEPTED"));
    }
}

/// Every governance action reads its clock as a number: another spelling of the same number passes
/// (and reads the same to the followers: the digest signs the number, not its spelling), a higher or a lower one
/// fails (the signatures are for the age signed), and bytes that are no number fail.
#[test]
fn held_a_watcher_can_only_respell_the_clock_of_a_governance_transaction() {
    let same = vec![0x01u8, 0x00]; // the harness's age of 1, padded
    let higher = vec![0x05u8, 0x00];
    let lower: Vec<u8> = vec![]; // 0
    let no_number = vec![0xffu8; 9];

    let mut paused = Harness::launch();
    paused.pause().unwrap();
    let (unpause, _) = paused.try_govern(Govern::Unpause, &[0, 1, 2, 3]).expect("the signers' unpause");

    let h = Harness::launch();
    let (skip, _) = h.try_govern(Govern::SkipNonce { chain: common::CHAIN_ETHEREUM, nonce: 0 }, &[0, 1, 2, 3]).expect("the signers' skip");
    let (rotate, _) = h.try_govern(Govern::SetSigners { keys: (0x60..0x65).map(key).collect(), guardian: key(0x6f) }, &[0, 1, 2, 3]).expect("rotation");
    let (value, _) = h.try_govern(Govern::SetValue { value: MINTER_SOMPI }, &[0, 1, 2, 3]).expect("set_value");
    let (limits, _) = h.try_govern(Govern::SetLimits { capacity: 42, refill_per_daa: 3 }, &[0, 1, 2, 3]).expect("limits");

    for (tx, minter) in [(unpause, paused.minter.utxo.clone()), (skip, h.minter.utxo.clone()), (rotate, h.minter.utxo.clone()), (value, h.minter.utxo.clone()), (limits, h.minter.utxo.clone())] {
        let utxos = vec![minter, funding()];
        run(with_argument(&tx, 0, 2, same.clone()), utxos.clone()).expect("another spelling of the same number");
        rejects(run(with_argument(&tx, 0, 2, higher.clone()), utxos.clone()));
        rejects(run(with_argument(&tx, 0, 2, lower.clone()), utxos.clone()));
        rejects(run(with_argument(&tx, 0, 2, no_number.clone()), utxos));
    }
}

// -- Finding 3: the 3-of-5 action shares the 4-of-5 nonce ---------------------

/// set_value used to need only the minting quorum while moving admin_nonce, so
/// three stolen keys could void any signed rotation or unpause for the price
/// of a transaction. It now takes four like every governance action, and three
/// keys can't move the nonce any more.
#[test]
fn attack_three_keys_can_no_longer_void_a_signed_rotation() {
    let mut h = Harness::launch();
    let rotate = Govern::SetSigners { keys: (0x60..0x65).map(key).collect(), guardian: key(0x6f) };
    let signed_at = h.state.admin_nonce;
    assert!(h.try_govern_signed_at(rotate.clone(), &[0, 1, 2, 3], signed_at).is_ok(), "four signers' rotation is ready");

    // The attacker, with keys 0, 1, 2, tries to burn the nonce with the same value.
    let before = h.minter.utxo.amount;
    rejects(h.try_govern(Govern::SetValue { value: before }, &[0, 1, 2]));
    assert_eq!(h.state.admin_nonce, signed_at, "the nonce did not move");

    // The rotation still works, and still needs its four signers.
    rejects(h.try_govern(rotate.clone(), &[0, 1, 2]));
    h.try_govern_signed_at(rotate.clone(), &[0, 1, 2, 3], signed_at).expect("the signed rotation is still good");
    // Three keys can't undo a pause either.
    h.pause().unwrap();
    rejects(h.try_govern(Govern::Unpause, &[0, 1, 2]));
    h.govern(Govern::SetValue { value: before }, &[0, 1, 2, 3]).expect("set_value still works with four");
    // The pause moved the nonce once (it voids what was signed before it), set_value once more.
    assert_eq!(h.state.admin_nonce, signed_at + 2);
}

// -- Probes that held --------------------------------------------------------

/// Held: a permissionless sell can't use a zero-length byte for a scheme, which
/// would make followPool's stateArg refuse it.
#[test]
fn held_a_sell_cannot_encode_a_scheme_as_an_empty_push() {
    let h = seeded(10_000 * KAS, 1_000 * USDT);
    let seller = key(0xc0);
    let (tx, utxos, _) = h.build_sell(&seller, 100 * USDT, USDT, sell_quote(h.p.x, h.p.y, USDT), 0, 0).unwrap();
    run(tx.clone(), utxos.clone()).expect("the plain sell runs");
    // kas_out, now_daa, then change_state: amount, owner, owner_scheme, borrow_scheme.
    rejects(run(with_argument(&tx, 0, 4, vec![]), utxos.clone()));
    rejects(run(with_argument(&tx, 0, 5, vec![]), utxos));
}
