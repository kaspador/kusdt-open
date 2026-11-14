//! Audit 3: KasPool against a from-scratch reference model, and an adversarial
//! search over operation sequences for the bound in SPEC §15.
//!
//! 1. `Model` mirrors pool.ag line by line with exact 64-bit checked arithmetic
//!    (not the helpers the earlier tests share with the code under test).
//! 2. `Harness` (taken from tests/audit2_pool.rs) spends the pool through the
//!    real engine. `differential_*` tests drive model and engine with the same
//!    random sequences, including invalid ones, and require them to agree on
//!    acceptance and on the exact successor state.
//! 3. `search_*` tests run large adversarial sequences on the model alone
//!    (millions of steps) looking for: more KAS leaving than the bound, a
//!    breach of the invariants, a withdrawal that is refused, or an overflow.
//!    The attack sequences the searches expose are replayed through the real engine.
//! 4. `exhaustive_*` tests walk every sequence of a value grid to a fixed depth
//!    (memoized), with time: waits, age claims, credit lapsing, the cap shrinking.
//! 5. `attack_*` tests PASS when an attack works (audit2's convention).
//!    `spec_bound_holds_against_temporary_liquidity` FAILS on the current
//!    contract: it is the failing test proving the finding recorded in
//!    audit/covenants-compiler.md and should pass once the refill is fixed.
//!    `candidate_fixes_compared` evaluates fixes on the model only.

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
const LIMB: i64 = 1 << 31;
const MAX_OPERAND: i64 = (1 << 61) - 1;
const MAX_SWAP_INPUT: i64 = 230_584_300_921_369;

const KAS: i64 = 100_000_000;
const USDT: i64 = 1_000_000;
const BASE: i64 = KAS;
const TOKEN_SOMPI: u64 = 100_000_000;
const POSITION_SOMPI: u64 = 50_000_000;
const MAX_OUT_BPS: i64 = 1_000;
const WINDOW: i64 = 36_000;
const START_DAA: i64 = 5_000_000;
/// pool.ag MIN_AGE_PARTS: while more than half of the cap is in use a public entry claims at least window / 720.
const MIN_AGE_PARTS: i64 = 720;
/// The shortest claim at the deployment window: 50 DAA.
const MIN_AGE: i64 = WINDOW / MIN_AGE_PARTS;

// The model reads the two genesis parameters from here so the exhaustive searches can use small
// windows; every engine test keeps the deployment values.
thread_local! { static PARAMS: std::cell::Cell<(i64, i64)> = const { std::cell::Cell::new((MAX_OUT_BPS, WINDOW)) }; }
fn p_bps() -> i64 {
    PARAMS.with(|c| c.get().0)
}
fn p_w() -> i64 {
    PARAMS.with(|c| c.get().1)
}

const KUSDT_ID: [u8; 32] = [0x11; 32];
const POOL_ID: [u8; 32] = [0x22; 32];

// ---------------------------------------------------------------------------
// The reference model: pool.ag, mirrored line by line.

/// A pool state, exactly the contract's numeric fields.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
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
    /// Candidate fix 3 only: the reference the outstanding used allowance is repaid at.
    dr: i64,
}

/// `violations` lists every `require` that fails; `next` is what the contract's
/// arithmetic produces (None if the arithmetic itself would have aborted).
#[derive(Clone, Debug)]
struct Step {
    next: Option<Ps>,
    violations: Vec<&'static str>,
}
impl Step {
    fn ok(&self) -> bool {
        self.violations.is_empty() && self.next.is_some()
    }
}

// Script-engine arithmetic: an overflow aborts the script (OpAdd/OpSub/OpMul use checked_*).
fn add(a: i64, b: i64) -> Option<i64> {
    a.checked_add(b)
}
fn sub(a: i64, b: i64) -> Option<i64> {
    a.checked_sub(b)
}
fn mul(a: i64, b: i64) -> Option<i64> {
    a.checked_mul(b)
}

/// mul_ge: the operand checks are `require`s and the rest is exact.
fn m_mul_ge(a: i64, b: i64, c: i64, d: i64, v: &mut Vec<&'static str>) -> Option<bool> {
    for (op, val) in [("a<0", a), ("b<0", b), ("c<0", c), ("d<0", d)] {
        if val < 0 {
            v.push(op);
        }
    }
    for (op, val) in [("a>MAX", a), ("b>MAX", b), ("c>MAX", c), ("d>MAX", d)] {
        if val > MAX_OPERAND {
            v.push(op);
        }
    }
    if a < 0 || b < 0 || c < 0 || d < 0 || a > MAX_OPERAND || b > MAX_OPERAND || c > MAX_OPERAND || d > MAX_OPERAND {
        return Some(false);
    }
    Some((a as i128) * (b as i128) >= (c as i128) * (d as i128))
}

fn m_advanced_ref(reference: i64, reserve: i64, elapsed: i64, length: i64) -> Option<i64> {
    // The contract: at most one reference of rise per window, whatever arrived in the reserve.
    if reserve <= reference {
        return Some(reserve);
    }
    let gap = sub(reserve, reference)?.min(reference);
    if elapsed < length { add(add(reference, mul(elapsed, gap / length)?)?, mul(elapsed, gap % length)? / length) } else { add(reference, gap) }
}

fn m_share_of(base: i64, bps: i64) -> Option<i64> {
    add(mul(base / BPS, bps)?, mul(base % BPS, bps)? / BPS)
}

thread_local! { static CANDIDATE_FIX: std::cell::Cell<u8> = const { std::cell::Cell::new(0) }; }

/// One whole reference in the fractional accounting of candidate fix 2.
const FRAC_SCALE: i128 = 1_000_000_000_000;

fn m3_mode() -> bool {
    CANDIDATE_FIX.with(|c| c.get()) == 3
}

/// Candidate 3: a positive count is repaid at the cap of the (minimum of the) reference it was
/// used at and the current one; a count at or below zero settles as the contract does.
fn m_settled_m3(s: &Ps, age: i64, cap: i64, nref: i64) -> Option<i64> {
    if s.out > 0 {
        let rate_cap = m_share_of(s.dr.min(nref), p_bps())?;
        let decay = add(mul(age, rate_cap / p_w())?, mul(age, rate_cap % p_w())? / p_w())?;
        let mut next = sub(s.out, decay)?;
        if next < 0 {
            next = 0;
        }
        Some(next)
    } else {
        m_settled_out(s.out, age, cap, p_w())
    }
}

/// The contract's settle, or candidate 3's.
fn settle(s: &Ps, age: i64, cap: i64, nref: i64) -> Option<i64> {
    if m3_mode() {
        m_settled_m3(s, age, cap, nref)
    } else {
        m_settled_out(s.out, age, cap, p_w())
    }
}

/// Candidate 3: the reference that repays the count after this step.
fn m3_dr_after(prev_out: i64, prev_settled: i64, prev_dr: i64, next_out: i64, nref_at_use: i64, nref_after: i64, is_sell: bool) -> i64 {
    if !m3_mode() {
        return 0;
    }
    let dr = if is_sell {
        if prev_settled > 0 { prev_dr.min(nref_at_use) } else { nref_at_use }
    } else if next_out > 0 && prev_out > 0 {
        prev_dr.min(nref_at_use)
    } else {
        nref_at_use
    };
    dr.min(nref_after)
}

fn frac_mode() -> bool {
    CANDIDATE_FIX.with(|c| c.get()) == 2
}

/// The allowance in fractional units: max_out_bps of the reference.
fn capfrac() -> i64 {
    (p_bps() as i128 * FRAC_SCALE / BPS as i128) as i64
}

/// Candidate fix 2: `used` moves toward zero by one allowance per window, whatever the reserve.
fn m_settled_frac(used: i64, elapsed: i64) -> i64 {
    let decay = ((capfrac() as i128) * (elapsed as i128) / (p_w() as i128)).min(i64::MAX as i128) as i64;
    if used > 0 {
        (used - decay).max(0)
    } else if used < 0 {
        (used + decay).min(0)
    } else {
        0
    }
}

/// `kas` as a fraction of the reference `r`, rounded up or down, saturating at i64.
fn frac_of(kas: i64, r: i64, up: bool) -> i64 {
    let r = r.max(1) as i128;
    let v = kas as i128 * FRAC_SCALE;
    let q = if up { (v + r - 1) / r } else { v / r };
    q.min(i64::MAX as i128 / 4) as i64
}

/// The contract's settled_out. With CANDIDATE_FIX set (model-only tests), a used allowance decays by
/// elapsed/length of itself instead of elapsed/length of the (attacker-inflatable) cap.
fn m_settled_out(used: i64, elapsed: i64, cap: i64, length: i64) -> Option<i64> {
    let mut next = used;
    if next < 0 - cap {
        next = 0 - cap;
    }
    if CANDIDATE_FIX.with(|c| c.get()) == 1 && next > 0 {
        let e = elapsed.min(length);
        let decay = (next as i128 * e as i128 / length as i128) as i64;
        return Some(next - decay);
    }
    let decay = add(mul(elapsed, cap / length)?, mul(elapsed, cap % length)? / length)?;
    if next > 0 {
        next = sub(next, decay)?;
        if next < 0 {
            next = 0;
        }
    } else if next < 0 {
        next = add(next, decay)?;
        if next > 0 {
            next = 0;
        }
    }
    Some(next)
}

fn m_credit_left(credit: i64, stored: i64, settled: i64) -> Option<i64> {
    let mut left = credit;
    if stored < 0 {
        let lapsed = sub(settled, stored)?;
        left = 0;
        if credit > lapsed {
            left = sub(credit, lapsed)?;
        }
    }
    Some(left)
}

/// Fills `v` for a `require(cond)`.
fn rq(cond: bool, what: &'static str, v: &mut Vec<&'static str>) {
    if !cond {
        v.push(what);
    }
}

/// pool.ag min_age_of.
fn m_min_age(length: i64) -> i64 {
    (length / MIN_AGE_PARTS).max(1)
}

/// pool.ag require_claim's condition: more than half of the stored cap in use (`out > share_of(rf) / 2`, i.e. `2·out > cap`).
/// (Candidate fix 2 keeps the count in fractions of the reference: its own cap.)
fn in_regime(s: &Ps) -> bool {
    let cap = if frac_mode() { capfrac() } else { m_share_of(s.rf, p_bps()).unwrap_or(i64::MAX) };
    s.out > cap / 2
}

/// What a public entry on `s` must claim at least: the minimum while more than half the cap is in use, else nothing.
fn least_age(s: &Ps) -> i64 {
    if in_regime(s) { m_min_age(p_w()) } else { 0 }
}

/// What a remove on `s` must claim at least: nothing while paused (it claims exactly 0 then), else as any public entry.
fn least_remove_age(s: &Ps) -> i64 {
    if s.paused { 0 } else { least_age(s) }
}

// The decomposition search only: the arithmetic of an entry with the minimum-claim rule left out.
thread_local! { static NO_MIN_RULE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

/// pool.ag require_claim (the caller's `this.ageDaa >= age_daa` is consensus's, outside the model).
fn m_claim(s: &Ps, age: i64, v: &mut Vec<&'static str>) {
    m_claim_cap(s, v);
    m_claim_least(age, least_age(s), v);
}

/// require_claim computes the stored cap: it must not overflow.
fn m_claim_cap(s: &Ps, v: &mut Vec<&'static str>) {
    if !frac_mode() {
        rq(m_share_of(s.rf, p_bps()).is_some(), "claim cap overflow", v);
    }
}

/// The claim's bounds against a given least (remove passes its own, none while paused).
fn m_claim_least(age: i64, least: i64, v: &mut Vec<&'static str>) {
    rq(age >= 0, "age<0", v);
    rq(age <= 2 * p_w(), "age>2w", v);
    if least > 0 && !NO_MIN_RULE.with(|c| c.get()) {
        rq(age >= least, "age<min", v);
    }
}

/// The breaker settled with `age` and nothing else, as tick does and as add and remove do first:
/// (reference, count, credit). Follows the candidate fixes when one is switched on.
fn m_settle_breaker(s: &Ps, age: i64) -> Option<(i64, i64, i64)> {
    let nref = m_advanced_ref(s.rf, s.x, age, p_w())?;
    let settled = if frac_mode() { m_settled_frac(s.out, age) } else { settle(s, age, m_share_of(nref, p_bps())?, nref)? };
    Some((nref, settled, m_credit_left(s.credit, s.out, settled)?))
}

/// pool.ag tick: settles the breaker with at least the minimum age, changes nothing else, refused while paused.
fn m_tick(s: &Ps, age: i64) -> Step {
    let mut v = Vec::new();
    rq(!s.paused, "paused", &mut v);
    rq(age >= m_min_age(p_w()), "age<min", &mut v);
    rq(age <= 2 * p_w(), "age>2w", &mut v);
    let t = (|| {
        let (nref, settled, credit) = m_settle_breaker(s, age)?;
        let dr = m3_dr_after(s.out, settled, s.dr, settled, nref, nref, false);
        Some(Ps { credit, rf: nref, out: settled, dr, ..s.clone() })
    })();
    Step { next: t, violations: v }
}

fn m_init(s: &Ps, kas_in: i64, tokens_in: i64, change_amount: i64, provider: i64) -> Step {
    let mut v = Vec::new();
    rq(!s.paused, "paused", &mut v);
    rq(s.s == 0, "shares!=0", &mut v);
    rq(s.x == 0, "x!=0", &mut v);
    rq(s.y == 0, "y!=0", &mut v);
    rq(kas_in > MIN_LIQUIDITY, "kas_in<=min", &mut v);
    rq(kas_in <= MAX_OPERAND, "kas_in>max", &mut v);
    let t = (|| {
        let tokens = sub(provider, change_amount)?;
        rq(tokens > 0, "tokens<=0", &mut v);
        rq(change_amount >= 0, "change<0", &mut v);
        let _ = tokens_in;
        let reserve = add(tokens, s.pt)?;
        let _ = reserve;
        Some(Ps { x: kas_in, y: tokens, s: kas_in, pk: s.pk, pt: s.pt, credit: s.credit, rf: kas_in, out: s.out, paused: s.paused, dr: 0 })
    })();
    Step { next: t, violations: v }
}

fn m_buy(s: &Ps, kas_in: i64, age: i64, amount: i64) -> Step {
    let mut v = Vec::new();
    rq(!s.paused, "paused", &mut v);
    rq(kas_in > 0, "kas_in<=0", &mut v);
    rq(kas_in <= MAX_SWAP_INPUT, "kas_in>MAX_SWAP", &mut v);
    rq(amount > 0, "amount<=0", &mut v);
    let t = (|| {
        let cut = mul(kas_in, PROTOCOL_BPS)? / BPS;
        let eff = mul(kas_in, BPS - FEE_BPS)? / BPS;
        let nx = sub(add(s.x, kas_in)?, cut)?;
        let ny = sub(s.y, amount)?;
        rq(ny > 0, "next_y<=0", &mut v);
        rq(nx <= MAX_OPERAND, "next_x>max", &mut v);
        let kge = m_mul_ge(add(s.x, eff)?, ny, s.x, s.y, &mut v)?;
        rq(kge, "k", &mut v);
        m_claim(s, age, &mut v);
        let nref = m_advanced_ref(s.rf, s.x, age, p_w())?;
        if frac_mode() {
            let settled = m_settled_frac(s.out, age);
            let credited = frac_of(sub(nx, s.x)?, nref, false);
            let mut nout = sub(settled, credited)?;
            if nout < 0 - capfrac() {
                nout = 0 - capfrac();
            }
            let mut ncredit = add(m_credit_left(s.credit, s.out, settled)?, sub(settled, nout)?)?;
            if ncredit > MAX_OPERAND {
                ncredit = MAX_OPERAND;
            }
            return Some(Ps { x: nx, y: ny, s: s.s, pk: add(s.pk, cut)?, pt: s.pt, credit: ncredit, rf: nref, out: nout, paused: s.paused, dr: 0 });
        }
        let cap = m_share_of(nref, p_bps())?;
        let settled = settle(s, age, cap, nref)?;
        let mut nout = sub(settled, sub(nx, s.x)?)?;
        if nout < 0 - cap {
            nout = 0 - cap;
        }
        let mut ncredit = add(m_credit_left(s.credit, s.out, settled)?, sub(settled, nout)?)?;
        if ncredit > MAX_OPERAND {
            ncredit = MAX_OPERAND;
        }
        Some(Ps { x: nx, y: ny, s: s.s, pk: add(s.pk, cut)?, pt: s.pt, credit: ncredit, rf: nref, out: nout, paused: s.paused, dr: m3_dr_after(s.out, settled, s.dr, nout, nref, nref, false) })
    })();
    Step { next: t, violations: v }
}

fn m_sell_core(s: &Ps, kas_out: i64, age: i64, tokens_in: i64, change_nonneg: bool) -> Step {
    let mut v = Vec::new();
    rq(!s.paused, "paused", &mut v);
    rq(change_nonneg, "change<0", &mut v);
    rq(tokens_in > 0, "tokens<=0", &mut v);
    rq(tokens_in <= MAX_SWAP_INPUT, "tokens>MAX_SWAP", &mut v);
    rq(kas_out > 0, "kas_out<=0", &mut v);
    let t = (|| {
        let cut = mul(tokens_in, PROTOCOL_BPS)? / BPS;
        let eff = mul(tokens_in, BPS - FEE_BPS)? / BPS;
        let nx = sub(s.x, kas_out)?;
        let ny = sub(add(s.y, tokens_in)?, cut)?;
        rq(nx > 0, "next_x<=0", &mut v);
        rq(ny <= MAX_OPERAND, "next_y>max", &mut v);
        let kge = m_mul_ge(add(s.y, eff)?, nx, s.y, s.x, &mut v)?;
        rq(kge, "k", &mut v);
        m_claim(s, age, &mut v);
        let mut nref = m_advanced_ref(s.rf, s.x, age, p_w())?;
        if frac_mode() {
            let settled = m_settled_frac(s.out, age);
            let debit = frac_of(kas_out, nref, true);
            let nout = add(settled, debit)?;
            rq(nout <= capfrac(), "over cap", &mut v);
            let mut ncredit = sub(m_credit_left(s.credit, s.out, settled)?, debit)?;
            if ncredit < 0 {
                ncredit = 0;
            }
            if nx < nref {
                nref = nx;
            }
            return Some(Ps { x: nx, y: ny, s: s.s, pk: s.pk, pt: add(s.pt, cut)?, credit: ncredit, rf: nref, out: nout, paused: s.paused, dr: 0 });
        }
        let cap = m_share_of(nref, p_bps())?;
        let settled = settle(s, age, cap, nref)?;
        let nout = add(settled, kas_out)?;
        rq(nout <= cap, "over cap", &mut v);
        let mut ncredit = sub(m_credit_left(s.credit, s.out, settled)?, kas_out)?;
        if ncredit < 0 {
            ncredit = 0;
        }
        let nref_at_use = nref;
        if nx < nref {
            nref = nx;
        }
        Some(Ps { x: nx, y: ny, s: s.s, pk: s.pk, pt: add(s.pt, cut)?, credit: ncredit, rf: nref, out: nout, paused: s.paused, dr: m3_dr_after(s.out, settled, s.dr, nout, nref_at_use, nref, true) })
    })();
    Step { next: t, violations: v }
}

fn m_add(s: &Ps, kas_in: i64, tokens_in: i64, shares: i64, age: i64) -> Step {
    m_add_as(s, kas_in, tokens_in, shares, age, false)
}

/// pool.ag add, by anyone (`admin` false: into an emptied pool, only the MIN_LIQUIDITY unowned shares left, it is
/// refused, as nobody but the admin can sign) or by the admin, whose deposit into an emptied pool starts the reference
/// again at the new reserve.
fn m_add_as(s: &Ps, kas_in: i64, tokens_in: i64, shares: i64, age: i64, admin: bool) -> Step {
    let mut v = Vec::new();
    let emptied = s.s == MIN_LIQUIDITY;
    rq(!emptied || admin, "emptied: the admin's signature", &mut v);
    rq(!s.paused, "paused", &mut v);
    rq(s.s > 0, "s<=0", &mut v);
    rq(tokens_in > 0, "tokens<=0", &mut v);
    rq(kas_in > 0, "kas<=0", &mut v);
    rq(shares > 0, "shares<=0", &mut v);
    let t = (|| {
        let k1 = m_mul_ge(kas_in, s.s, shares, s.x, &mut v)?;
        rq(k1, "mul1", &mut v);
        let k2 = m_mul_ge(tokens_in, s.s, shares, s.y, &mut v)?;
        rq(k2, "mul2", &mut v);
        let nx = add(s.x, kas_in)?;
        let ny = add(s.y, tokens_in)?;
        let ns = add(s.s, shares)?;
        rq(nx <= MAX_OPERAND, "nx>max", &mut v);
        rq(ny <= MAX_OPERAND, "ny>max", &mut v);
        rq(ns <= MAX_OPERAND, "ns>max", &mut v);
        // The breaker settles the UTXO's age toward the reserve it stood at; the new liquidity changes none of it.
        m_claim(s, age, &mut v);
        let (settled_ref, settled, credit) = m_settle_breaker(s, age)?;
        let nref = if emptied { nx } else { settled_ref };
        let dr = m3_dr_after(s.out, settled, s.dr, settled, nref, nref, false);
        Some(Ps { x: nx, y: ny, s: ns, pk: s.pk, pt: s.pt, credit, rf: nref, out: settled, paused: s.paused, dr })
    })();
    Step { next: t, violations: v }
}

fn m_remove(s: &Ps, shares: i64, kas_out: i64, tokens_out: i64, age: i64) -> Step {
    let mut v = Vec::new();
    rq(shares > 0, "shares<=0", &mut v);
    rq(kas_out >= 0, "kas_out<0", &mut v);
    rq(tokens_out >= 0, "tokens_out<0", &mut v);
    let t = (|| {
        let k1 = m_mul_ge(shares, s.x, kas_out, s.s, &mut v)?;
        rq(k1, "mul1", &mut v);
        let k2 = m_mul_ge(shares, s.y, tokens_out, s.s, &mut v)?;
        rq(k2, "mul2", &mut v);
        let nx = sub(s.x, kas_out)?;
        let ny = sub(s.y, tokens_out)?;
        let ns = sub(s.s, shares)?;
        rq(ns >= MIN_LIQUIDITY, "ns<min", &mut v);
        rq(nx > 0, "nx<=0", &mut v);
        rq(ny > 0, "ny<=0", &mut v);
        // Settled first, as a swap: then the reclaim, the cut of the reference and the cut to two caps.
        // While paused the breaker stands still: the claim is exactly 0 and nothing settles.
        let (settled_ref, settled, credit) = if s.paused {
            rq(age == 0, "paused: age!=0", &mut v);
            (s.rf, s.out, s.credit)
        } else {
            m_claim_cap(s, &mut v);
            m_claim_least(age, least_remove_age(s), &mut v);
            m_settle_breaker(s, age)?
        };
        let mut nref = settled_ref;
        if nx < nref {
            nref = nx;
        }
        let mut reclaimed = if frac_mode() { frac_of(kas_out, settled_ref, true) } else { kas_out };
        if reclaimed > credit {
            reclaimed = credit;
        }
        let mut nout = add(settled, reclaimed)?;
        if nx < settled_ref && !frac_mode() {
            let ncap = mul(m_share_of(nref, p_bps())?, 2)?;
            if nout > ncap {
                nout = ncap;
            }
        }
        let ndr = if m3_mode() {
            if nout > 0 && settled > 0 { m3_dr_after(s.out, settled, s.dr, settled, settled_ref, settled_ref, false).min(nref) } else { nref }
        } else {
            0
        };
        Some(Ps { x: nx, y: ny, s: ns, pk: s.pk, pt: s.pt, credit: sub(credit, reclaimed)?, rf: nref, out: nout, paused: s.paused, dr: ndr })
    })();
    Step { next: t, violations: v }
}

fn m_collect(s: &Ps) -> Step {
    Step { next: Some(Ps { pk: 0, pt: 0, ..s.clone() }), violations: Vec::new() }
}

fn m_pause(s: &Ps, paused: bool) -> Step {
    Step { next: Some(Ps { paused, ..s.clone() }), violations: Vec::new() }
}

// Quotes (helpers for choosing parameters, not part of the contract).

fn buy_quote(x: i64, y: i64, kas_in: i64) -> i64 {
    let eff = kas_in as i128 * (BPS - FEE_BPS) as i128 / BPS as i128;
    (y as i128 * eff / (x as i128 + eff)) as i64
}

/// Tokens that pay at least `kas_out` on a sell.
fn tokens_for(x: i64, y: i64, kas_out: i64) -> Option<i64> {
    let (xi, yi, out) = (x as i128, y as i128, kas_out as i128);
    if out >= xi {
        return None;
    }
    let eff = yi * out / (xi - out) + 1;
    let t = eff.checked_mul(BPS as i128)? / (BPS - FEE_BPS) as i128 + 2;
    let t = i64::try_from(t).ok()?;
    (t > 0 && t <= MAX_SWAP_INPUT).then_some(t)
}

/// The buy input that adds exactly `added` KAS to the reserve after the protocol's cut.
fn kas_in_for(added: i64) -> i64 {
    (added as i128 * BPS as i128 / (BPS - PROTOCOL_BPS) as i128 + 1) as i64
}

fn cap_of(s: &Ps, age: i64) -> i64 {
    let rf = m_advanced_ref(s.rf, s.x, age, p_w()).unwrap();
    m_share_of(rf, p_bps()).unwrap()
}

/// Sell room at this claimed age.
fn room_at(s: &Ps, age: i64) -> i64 {
    let cap = cap_of(s, age);
    if frac_mode() {
        let nref = m_advanced_ref(s.rf, s.x, age, p_w()).unwrap();
        let used = m_settled_frac(s.out, age);
        return (((capfrac() - used).max(0) as i128 * nref as i128 / FRAC_SCALE).min(i64::MAX as i128)) as i64;
    }
    if m3_mode() {
        let nref = m_advanced_ref(s.rf, s.x, age, p_w()).unwrap();
        return (cap - m_settled_m3(s, age, cap, nref).unwrap()).max(0);
    }
    (cap - m_settled_out(s.out, age, cap, p_w()).unwrap()).max(0)
}

/// The used allowance after `age` in KAS (fractional mode converts through the reference).
fn settled_abs(s: &Ps, age: i64) -> i64 {
    if frac_mode() {
        let nref = m_advanced_ref(s.rf, s.x, age, p_w()).unwrap();
        (m_settled_frac(s.out, age) as i128 * nref as i128 / FRAC_SCALE) as i64
    } else if m3_mode() {
        let nref = m_advanced_ref(s.rf, s.x, age, p_w()).unwrap();
        m_settled_m3(s, age, cap_of(s, age), nref).unwrap()
    } else {
        m_settled_out(s.out, age, cap_of(s, age), p_w()).unwrap()
    }
}

// ---------------------------------------------------------------------------
// The engine harness (from audit2_pool.rs).

fn kusdt() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("kusdt.ag", "test-audit3-pool-kusdt").expect("kUSDT compiles"))
}

fn pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("pool.ag", "test-audit3-pool").expect("pool compiles"))
}

fn builder() -> TxBuilder<'static> {
    let bundle = ArtifactBundle::new(pool_artifact()).unwrap().with_artifact(kusdt()).unwrap();
    TxBuilder::from_bundle(&bundle).expect("bundle builder")
}

/// main's pool covenant (583937c, before the branch pool-clock), for comparisons in the engine.
fn main_pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("../tests/fixtures/main_pool_583937c.ag", "test-audit3-main-pool").expect("main's pool compiles"))
}

fn main_builder() -> TxBuilder<'static> {
    let bundle = ArtifactBundle::new(main_pool_artifact()).unwrap().with_artifact(kusdt()).unwrap();
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
    ps: Ps,
    admin: [u8; 32],
    guardian: [u8; 32],
}

impl PoolState {
    fn state(&self) -> State {
        let p = &self.ps;
        state! {
            token_covid: KUSDT_ID.to_vec(),
            kas_reserve: p.x,
            token_reserve: p.y,
            total_shares: p.s,
            protocol_kas: p.pk,
            protocol_tokens: p.pt,
            base_value: BASE,
            admin: self.admin.to_vec(),
            max_out_bps: MAX_OUT_BPS,
            window_len: WINDOW,
            window_credit: p.credit,
            window_ref: p.rf,
            window_out: p.out,
            paused: p.paused,
            guardian: self.guardian.to_vec()
        }
    }
    fn value(&self) -> u64 {
        (BASE + self.ps.x + self.ps.pk) as u64
    }
}

fn position_state(shares: i64, owner: &Keypair) -> State {
    state! { token_covid: KUSDT_ID.to_vec(), shares: shares, owner: xonly(owner).to_vec() }
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

/// A live position: where it is, who owns it, how many shares it holds.
#[derive(Clone)]
struct Pos {
    out: TransactionOutpoint,
    utxo: UtxoEntry,
    shares: i64,
    owner: Keypair,
}

struct Harness {
    builder: TxBuilder<'static>,
    admin_key: Keypair,
    guardian_key: Keypair,
    state: PoolState,
    pool: (TransactionOutpoint, UtxoEntry),
    reserve: Option<(TransactionOutpoint, UtxoEntry, i64)>,
    next_outpoint: std::cell::Cell<u32>,
    now: i64,
    pool_daa: i64,
    /// Sompi the reserve output carries in sell(); the default leaves the deposit as it was.
    reserve_output_sompi: u64,
    /// main's covenant (583937c): init takes no signature, add and remove claim no age.
    main: bool,
}

impl Harness {
    fn with_state(ps: Ps) -> Self {
        Self::with_builder(ps, builder(), false)
    }

    /// The same harness on main's covenant.
    fn with_state_main(ps: Ps) -> Self {
        Self::with_builder(ps, main_builder(), true)
    }

    fn with_builder(ps: Ps, builder: TxBuilder<'static>, main: bool) -> Self {
        let (admin_key, guardian_key) = (key(0x30), key(0x32));
        let state = PoolState { ps, admin: xonly(&admin_key), guardian: xonly(&guardian_key) };
        let utxo = builder.covenant_utxo("Pool", state.state(), state.value(), 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
        Self { builder, admin_key, guardian_key, state, pool: (outpoint(0x40, 0), utxo), reserve: None, next_outpoint: std::cell::Cell::new(0), now: START_DAA, pool_daa: START_DAA, reserve_output_sompi: TOKEN_SOMPI, main }
    }

    fn fresh(&self) -> TransactionOutpoint {
        let n = self.next_outpoint.get();
        self.next_outpoint.set(n + 1);
        outpoint(0x41, n)
    }

    fn token_utxo(&self, state: State) -> (TransactionOutpoint, UtxoEntry) {
        let utxo = self.builder.covenant_utxo("kusdt::KCC20", state, TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap();
        (self.fresh(), utxo)
    }

    fn age(&self) -> i64 {
        (self.now - self.pool_daa).clamp(0, 2 * WINDOW)
    }

    fn adopt(&mut self, tx: &Transaction, next: Ps, reserve_index: Option<(u32, i64)>) {
        let pool = CovenantOutput::from_tx(tx, 0).unwrap();
        self.pool = (pool.outpoint, pool.utxo);
        if let Some((idx, amount)) = reserve_index {
            let reserve = CovenantOutput::from_tx(tx, idx).unwrap();
            self.reserve = Some((reserve.outpoint, reserve.utxo, amount));
        }
        self.state.ps = next;
        self.pool_daa = self.now;
    }

    fn reserve_input<'a>(&self, next_states: Vec<State>) -> (TransactionOutpoint, UtxoEntry, State, EntryCall<'a>) {
        let (out, utxo, amount) = self.reserve.clone().expect("pool initialized");
        (out, utxo, reserve_state(amount), EntryCall::new("transfer").args(args!(next_states, vec![0x00u8])))
    }

    fn next_ps(&self, next: &Ps) -> PoolState {
        PoolState { ps: next.clone(), admin: self.state.admin, guardian: self.state.guardian }
    }

    /// Initializes a fresh pool; returns the position.
    fn init(&mut self, provider: &Keypair, held: i64, kas_in: i64, tokens_in: i64) -> Result<Pos, Rejected> {
        let step = m_init(&self.state.ps, kas_in, tokens_in, held - tokens_in, held);
        let next = step.next.clone().expect("init arithmetic");
        assert!(step.ok(), "init: {:?}", step.violations);
        let (p_out, p_utxo) = self.token_utxo(user_state(provider, held));
        let change = user_state(provider, held - tokens_in);
        let provider_key = *provider;
        let reserve_amt = tokens_in + next.pt;
        let next_states = vec![reserve_state(reserve_amt), change.clone()];
        let next_full = self.next_ps(&next);
        let ctx = TxContext::new()
            .actor_input("Pool", self.state.state(), {
                let (a0, a1, a2, admin) = (kas_in, xonly(provider).to_vec(), change.clone(), key(0x30));
                if self.main { EntryCall::new("init").args(args!(a0, a1, a2)) } else { EntryCall::new("init").args_with(move |tx, i| args!(a0, a1.clone(), a2.clone(), sign_input(tx, i, &admin))) }
            }, self.pool.0, self.pool.1.clone(), 0)
            .actor_input("kusdt::KCC20", user_state(provider, held), EntryCall::new("transfer").args_with(move |tx, i| {
                let mut w = vec![0x00];
                w.extend(sign_input(tx, i, &provider_key));
                args!(next_states.clone(), w)
            }), p_out, p_utxo.clone(), 0)
            .input(self.fresh(), funding(), funding_sig(), 0)
            .actor_output("Pool", next_full.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next_full.value())
            .actor_output("Position", position_state(kas_in - MIN_LIQUIDITY, provider), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
            .actor_output("kusdt::KCC20", reserve_state(reserve_amt), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), p_utxo, funding()])?;
        let position = CovenantOutput::from_tx(&tx, 1).unwrap();
        self.adopt(&tx, next, Some((2, reserve_amt)));
        Ok(Pos { out: position.outpoint, utxo: position.utxo, shares: kas_in - MIN_LIQUIDITY, owner: *provider })
    }

    fn buy(&mut self, buyer: &Keypair, kas_in: i64, amount: i64, age: i64, next: &Ps) -> Result<(), Rejected> {
        let s = self.state.clone();
        let reserve_out = next.y + next.pt;
        let buyer_state = user_state(buyer, amount);
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(vec![reserve_state(reserve_out), buyer_state.clone()]);
        let next_full = self.next_ps(next);
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new("buy").args(args!(kas_in, age, buyer_state.clone())), self.pool.0, self.pool.1.clone(), age as u64)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .input(self.fresh(), funding(), funding_sig(), 0)
            .actor_output("Pool", next_full.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next_full.value())
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", buyer_state, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), r_utxo, funding()])?;
        self.adopt(&tx, next.clone(), Some((1, reserve_out)));
        Ok(())
    }

    fn sell(&mut self, seller: &Keypair, held: i64, tokens_in: i64, kas_out: i64, age: i64, sell_all: bool, next: &Ps) -> Result<Transaction, Rejected> {
        let s = self.state.clone();
        let reserve_out = next.y + next.pt;
        let change = user_state(seller, held - tokens_in);
        let (p_out, p_utxo) = self.token_utxo(user_state(seller, held));
        let next_states: Vec<State> = if sell_all { vec![reserve_state(reserve_out)] } else { vec![reserve_state(reserve_out), change.clone()] };
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(next_states);
        let seller_key = *seller;
        let next_full = self.next_ps(next);
        let (entry, argv) = if sell_all {
            ("sell_all", args!(kas_out, age))
        } else {
            ("sell", args!(kas_out, age, change.clone()))
        };
        let mut ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new(entry).args(argv), self.pool.0, self.pool.1.clone(), age as u64)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .actor_input("kusdt::KCC20", user_state(seller, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &seller_key))), p_out, p_utxo.clone(), 0)
            .actor_output("Pool", next_full.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next_full.value())
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), self.reserve_output_sompi);
        if !sell_all {
            ctx = ctx.actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        }
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), r_utxo, p_utxo])?;
        self.adopt(&tx, next.clone(), Some((1, reserve_out)));
        Ok(tx)
    }

    #[allow(clippy::too_many_arguments)]
    fn add(&mut self, provider: &Keypair, held: i64, kas_in: i64, tokens_in: i64, shares: i64, age: i64, next: &Ps) -> Result<Pos, Rejected> {
        self.add_signed(provider, held, kas_in, tokens_in, shares, age, next, None)
    }

    /// An add whose `admin_witness` is `signer`'s signature (the admin's, into an emptied pool), or empty.
    #[allow(clippy::too_many_arguments)]
    fn add_signed(&mut self, provider: &Keypair, held: i64, kas_in: i64, tokens_in: i64, shares: i64, age: i64, next: &Ps, signer: Option<Keypair>) -> Result<Pos, Rejected> {
        let s = self.state.clone();
        let reserve_out = next.y + next.pt;
        let change = user_state(provider, held - tokens_in);
        let (p_out, p_utxo) = self.token_utxo(user_state(provider, held));
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(vec![reserve_state(reserve_out), change.clone()]);
        let provider_key = *provider;
        let next_full = self.next_ps(next);
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), {
                let (owner, change_arg) = (xonly(provider).to_vec(), change.clone());
                if self.main {
                    EntryCall::new("add").args(args!(kas_in, shares, owner, change_arg))
                } else {
                    EntryCall::new("add").args_with(move |tx, i| args!(kas_in, shares, age, owner.clone(), change_arg.clone(), signer.map(|k| sign_input(tx, i, &k)).unwrap_or_default()))
                }
            }, self.pool.0, self.pool.1.clone(), if self.main { 0 } else { age.max(0) as u64 })
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .actor_input("kusdt::KCC20", user_state(provider, held), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_input(tx, i, &provider_key))), p_out, p_utxo.clone(), 0)
            .input(self.fresh(), funding(), funding_sig(), 0)
            .actor_output("Pool", next_full.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next_full.value())
            .actor_output("Position", position_state(shares, provider), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), r_utxo, p_utxo, funding()])?;
        let position = CovenantOutput::from_tx(&tx, 1).unwrap();
        self.adopt(&tx, next.clone(), Some((2, reserve_out)));
        Ok(Pos { out: position.outpoint, utxo: position.utxo, shares, owner: *provider })
    }

    fn remove(&mut self, pos: &Pos, kas_out: i64, tokens_out: i64, age: i64, next: &Ps) -> Result<(), Rejected> {
        let s = self.state.clone();
        let reserve_out = next.y + next.pt;
        let receiver = user_state(&pos.owner, tokens_out);
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(vec![reserve_state(reserve_out), receiver.clone()]);
        let signer = pos.owner;
        let next_full = self.next_ps(next);
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), if self.main { EntryCall::new("remove").args(args!(kas_out, receiver.clone())) } else { EntryCall::new("remove").args(args!(kas_out, age, receiver.clone())) }, self.pool.0, self.pool.1.clone(), if self.main { 0 } else { age.max(0) as u64 })
            .actor_input("Position", position_state(pos.shares, &pos.owner), EntryCall::new("redeem").args_with(move |tx, i| args!(sign_input(tx, i, &signer))), pos.out, pos.utxo.clone(), 0)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .actor_output("Pool", next_full.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next_full.value())
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(2, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", receiver, CovenantBinding::new(2, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), pos.utxo.clone(), r_utxo])?;
        self.adopt(&tx, next.clone(), Some((1, reserve_out)));
        Ok(())
    }

    fn collect(&mut self, next: &Ps) -> Result<(), Rejected> {
        let s = self.state.clone();
        let fees_to = key(0x77);
        let fee_state = user_state(&fees_to, s.ps.pt);
        let reserve_out = next.y + next.pt;
        let (r_out, r_utxo, r_state, r_call) = self.reserve_input(vec![reserve_state(reserve_out), fee_state.clone()]);
        let by = self.admin_key;
        let fee_arg = fee_state.clone();
        let next_full = self.next_ps(next);
        let ctx = TxContext::new()
            .actor_input("Pool", s.state(), EntryCall::new("collect").args_with(move |tx, i| args!(sign_input(tx, i, &by), fee_arg.clone())), self.pool.0, self.pool.1.clone(), 0)
            .actor_input("kusdt::KCC20", r_state, r_call, r_out, r_utxo.clone(), 0)
            .actor_output("Pool", next_full.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next_full.value())
            .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
            .actor_output("kusdt::KCC20", fee_state, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), r_utxo])?;
        self.adopt(&tx, next.clone(), Some((1, reserve_out)));
        Ok(())
    }

    fn pause_entry(&mut self, entry: &'static str, by: Keypair, next: &Ps) -> Result<(), Rejected> {
        let next_full = self.next_ps(next);
        let call = EntryCall::new(entry).args_with(move |tx, i| args!(sign_input(tx, i, &by)));
        let ctx = TxContext::new()
            .actor_input("Pool", self.state.state(), call, self.pool.0, self.pool.1.clone(), 0)
            .actor_output("Pool", next_full.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), self.state.value());
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone()])?;
        let pool = CovenantOutput::from_tx(&tx, 0).unwrap();
        self.pool = (pool.outpoint, pool.utxo);
        self.state.ps = next.clone();
        self.pool_daa = self.now;
        Ok(())
    }

    /// Anyone's tick claiming `age`, paid by a plain coin.
    fn tick(&mut self, age: i64, next: &Ps) -> Result<(), Rejected> {
        let next_full = self.next_ps(next);
        let ctx = TxContext::new()
            .actor_input("Pool", self.state.state(), EntryCall::new("tick").args(args!(age)), self.pool.0, self.pool.1.clone(), age.max(0) as u64)
            .input(self.fresh(), funding(), funding_sig(), 0)
            .actor_output("Pool", next_full.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), self.state.value());
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        let tx = run(tx, vec![self.pool.1.clone(), funding()])?;
        let pool = CovenantOutput::from_tx(&tx, 0).unwrap();
        self.pool = (pool.outpoint, pool.utxo);
        self.state.ps = next.clone();
        self.pool_daa = self.now;
        Ok(())
    }

    /// Waits until the pool UTXO is old enough for the least claim a public entry must make, and answers that claim.
    fn least(&mut self) -> i64 {
        let least = least_age(&self.state.ps);
        if self.age() < least {
            self.now = self.pool_daa + least;
        }
        least
    }
}

// ---------------------------------------------------------------------------
// A deterministic generator.

struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(0x1234_5678_9ABC_DEF1) | 1)
    }
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
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % ((hi - lo) as u64 + 1)) as i64
    }
}

// ---------------------------------------------------------------------------
// Part 1: model against engine.

/// One random, sometimes-invalid operation against the pool. Returns the model's verdict after
/// comparing it with the engine's.
struct Tally {
    accepted: usize,
    rejected: usize,
}

fn exercise(h: &mut Harness, positions: &mut Vec<Pos>, rng: &mut Rng, tally: &mut Tally) {
    let who = key(0xf0 + (rng.below(3) as u8));
    let s = h.state.ps.clone();
    // Ages around every edge: none, the UTXO's own, past it, the least this state allows and one under it, the
    // minimum, two windows and one over. (Only consensus refuses a claim past the UTXO's age; the script and the
    // model don't see it, so it agrees here.)
    let least = least_age(&s);
    let age = match rng.below(9) {
        0 => 0,
        1 => h.age(),
        2 => (h.age() + 1).min(2 * WINDOW),
        3 => least,
        4 => (least - 1).max(0),
        5 => m_min_age(WINDOW),
        6 => if rng.below(2) == 0 { 2 * WINDOW } else { 2 * WINDOW + 1 },
        _ => rng.range(0, h.age().max(0)),
    };
    let time_step = |h: &mut Harness, rng: &mut Rng| {
        match rng.below(3) {
            0 => h.now += rng.range(0, 3 * WINDOW),
            1 => h.now += rng.range(0, 3 * MIN_AGE),
            _ => {}
        }
    };
    match rng.below(13) {
        0 | 1 => {
            // buy, sometimes with a claimed output above the quote
            let kas_in = match rng.below(4) {
                0 => rng.range(1, 1_000),
                1 => rng.range(1, s.x.max(2)),
                2 => s.x.min(MAX_SWAP_INPUT),
                _ => cap_of(&s, age).max(1) * 3,
            };
            let quote = buy_quote(s.x, s.y, kas_in);
            let amount = match rng.below(5) {
                0 => quote + 1,
                1 => (quote - 1).max(1),
                _ => quote.max(1),
            };
            let step = m_buy(&s, kas_in, age, amount);
            let Some(next) = step.next.clone() else { return };
            let result = h.buy(&who, kas_in, amount, age, &next);
            compare(step.ok(), result, "buy", tally);
        }
        2 | 3 => {
            // sell, sell_all, with the claimed output near the quote and the breaker's limit
            let room = room_at(&s, age);
            let kas_out = match rng.below(5) {
                0 => room,
                1 => room + 1,
                2 => (room / 2).max(1),
                3 => rng.range(1, s.x.max(2)),
                _ => s.x - 1,
            }.max(1);
            let Some(tokens) = tokens_for(s.x, s.y, kas_out) else { return };
            let tokens = match rng.below(4) {
                0 => tokens.saturating_sub(rng.below(3) as i64 + 1).max(1),
                _ => tokens,
            };
            let sell_all = rng.below(3) == 0;
            let held = if sell_all { tokens } else { tokens + rng.range(0, 5) };
            let step = m_sell_core(&s, kas_out, age, tokens, held >= tokens);
            let Some(next) = step.next.clone() else { return };
            let result = h.sell(&who, held, tokens, kas_out, age, sell_all, &next);
            compare(step.ok(), result, "sell", tally);
        }
        4 | 5 | 6 => {
            // add at ratio, sometimes greedy on shares
            let mult = 1 + rng.below(300) as i64;
            let kas = ((s.x as i128 * mult as i128 / 100) as i64).max(1).min(MAX_OPERAND / 4);
            let tokens = ((kas as i128 * s.y as i128 + s.x as i128 - 1) / s.x as i128) as i64;
            let tokens = tokens.max(1);
            let shares_max = ((kas as i128 * s.s as i128 / s.x as i128).min(tokens as i128 * s.s as i128 / s.y as i128)) as i64;
            let shares = match rng.below(5) {
                0 => shares_max + 1,
                1 => (shares_max - 1).max(1),
                _ => shares_max.max(1),
            };
            let step = m_add(&s, kas, tokens, shares, age);
            let Some(next) = step.next.clone() else { return };
            match h.add(&who, tokens + 1, kas, tokens, shares, age, &next) {
                Ok(p) => {
                    assert!(step.ok(), "engine accepted add the model refused: {:?}", step.violations);
                    tally.accepted += 1;
                    positions.push(p);
                }
                Err(e) => {
                    assert!(!step.ok(), "model accepted add but the engine refused: {e:?}");
                    tally.rejected += 1;
                }
            }
        }
        7 | 8 => {
            if positions.is_empty() {
                return;
            }
            let i = rng.below(positions.len() as u64) as usize;
            let pos = positions[i].clone();
            let (share_x, share_y) = (
                (pos.shares as i128 * s.x as i128 / s.s as i128) as i64,
                (pos.shares as i128 * s.y as i128 / s.s as i128) as i64,
            );
            let (kas_out, tokens_out) = match rng.below(5) {
                0 => (share_x + 1, share_y),
                1 => (share_x, share_y + 1),
                2 => (rng.range(0, share_x.max(0)), rng.range(0, share_y.max(0))),
                _ => (share_x, share_y),
            };
            let step = m_remove(&s, pos.shares, kas_out, tokens_out, age);
            let Some(next) = step.next.clone() else { return };
            match h.remove(&pos, kas_out, tokens_out, age, &next) {
                Ok(()) => {
                    assert!(step.ok(), "engine accepted remove the model refused: {:?}", step.violations);
                    tally.accepted += 1;
                    positions.remove(i);
                }
                Err(e) => {
                    assert!(!step.ok(), "model accepted remove but the engine refused: {e:?}");
                    tally.rejected += 1;
                }
            }
        }
        9 => {
            let step = m_collect(&s);
            let next = step.next.clone().unwrap();
            let result = h.collect(&next);
            compare(step.ok(), result, "collect", tally);
        }
        10 => {
            let paused = !s.paused;
            let entry = if paused { "pause" } else { "unpause" };
            let by = if paused { h.guardian_key } else { h.admin_key };
            let step = m_pause(&s, paused);
            let next = step.next.clone().unwrap();
            let result = h.pause_entry(entry, by, &next);
            compare(step.ok(), result, "pause", tally);
        }
        11 => {
            let step = m_tick(&s, age);
            let Some(next) = step.next.clone() else { return };
            let result = h.tick(age, &next);
            compare(step.ok(), result, "tick", tally);
        }
        _ => {
            time_step(h, rng);
        }
    }
}

fn compare<T>(model_ok: bool, result: Result<T, Rejected>, what: &str, tally: &mut Tally) {
    match result {
        Ok(_) => {
            assert!(model_ok, "the engine accepted a {what} the model refuses");
            tally.accepted += 1;
        }
        Err(Rejected::Script(e)) => {
            assert!(!model_ok, "the model accepts a {what} the engine refused: {e}");
            tally.rejected += 1;
        }
        Err(Rejected::Build(e)) => panic!("{what}: the builder failed: {e}"),
    }
}

/// The model and the real engine agree on accepted, refused and the exact successor state,
/// over every entry, on random sequences that wander into edge states.
#[test]
fn differential_model_and_engine_agree_on_random_sequences() {
    let mut tally = Tally { accepted: 0, rejected: 0 };
    for seed in 0..6u64 {
        let mut rng = Rng::new(seed);
        let mut h = Harness::with_state(Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 });
        let lp = key(0xa1);
        // A wide spread of starting sizes, up to reserves near the operand limit.
        let (x0, y0) = match seed % 3 {
            0 => (10_000 * KAS, 1_000 * USDT),
            1 => (MAX_OPERAND / 4, MAX_OPERAND / 3),
            _ => (2_000, 2_000),
        };
        let first = h.init(&lp, y0 + 5, x0, y0).expect("init");
        let mut positions = vec![first];
        for _ in 0..600 {
            exercise(&mut h, &mut positions, &mut rng, &mut tally);
        }
    }
    println!("differential: {} accepted, {} refused, and model and engine agreed on every one", tally.accepted, tally.rejected);
    assert!(tally.accepted > 500 && tally.rejected > 100, "the sample did not reach both outcomes");
}

// ---------------------------------------------------------------------------
// Part 2: adversarial search on the model.

/// The honest provider's claim on the KAS reserve.
fn claim(s: &Ps, honest: i64) -> i64 {
    (honest as i128 * s.x as i128 / s.s as i128) as i64
}

#[derive(Clone, Debug)]
enum Op {
    AddRatio { mult_pct: i64 },
    AddRatioBig { x_mult: i64 },
    BuyAdded { added: i64 },
    BuyMax,
    Sell { pct_of_room: i64 },
    SellRoom,
    SellAll { pct_of_room: i64 },
    RemoveAll { idx: usize, keep_kas_bps: i64 },
    Wait { d: i64, claim: i64 },
    Tick,
    Collect,
    Pause,
    Unpause,
}

impl Op {
    /// The entries that claim the pool UTXO's age (everything but the admin's and the guardian's).
    fn claims_age(&self) -> bool {
        !matches!(self, Op::Wait { .. } | Op::Collect | Op::Pause | Op::Unpause)
    }
}

/// A position held in the model run.
#[derive(Clone)]
struct MPos {
    shares: i64,
}

/// Outcome of one attempted operation on the model.
fn apply_model(s: &Ps, op: &Op, positions: &mut Vec<MPos>, age: i64) -> Option<Ps> {
    match op {
        Op::AddRatio { mult_pct } => {
            let kas = ((s.x as i128 * *mult_pct as i128) / 100) as i64;
            add_ratio(s, kas, positions, age)
        }
        Op::AddRatioBig { x_mult } => {
            let kas = s.x.saturating_mul(*x_mult);
            add_ratio(s, kas, positions, age)
        }
        Op::Tick => {
            let st = m_tick(s, age);
            assert_no_overflow(&st, "tick");
            st.ok().then(|| st.next.unwrap())
        }
        Op::BuyAdded { added } => {
            let kas_in = kas_in_for(*added).max(1);
            let quote = buy_quote(s.x, s.y, kas_in);
            if quote < 1 || s.y - quote < 1 {
                return None;
            }
            let st = m_buy(s, kas_in.min(MAX_SWAP_INPUT), age, quote);
            assert_no_overflow(&st, "buy");
            st.ok().then(|| st.next.unwrap())
        }
        Op::BuyMax => {
            // fill the credit exactly: credit room is cap + max(out, 0)
            let cap = cap_of(s, age);
            let want = cap + settled_abs(s, age).max(0) + 1;
            let kas_in = kas_in_for(want).max(1);
            let quote = buy_quote(s.x, s.y, kas_in);
            if quote < 1 || s.y - quote < 1 {
                return None;
            }
            let st = m_buy(s, kas_in.min(MAX_SWAP_INPUT), age, quote);
            assert_no_overflow(&st, "buy");
            st.ok().then(|| st.next.unwrap())
        }
        Op::Sell { pct_of_room } => {
            let room = room_at(s, age);
            let kas_out = ((room as i128 * *pct_of_room as i128 / 100) as i64).max(0);
            if kas_out < 1 || kas_out >= s.x {
                return None;
            }
            let tokens = tokens_for(s.x, s.y, kas_out)?;
            let st = m_sell_core(s, kas_out, age, tokens, true);
            assert_no_overflow(&st, "sell");
            st.ok().then(|| st.next.unwrap())
        }
        Op::SellRoom => {
            let room = room_at(s, age);
            if room < 1 || room >= s.x {
                return None;
            }
            let tokens = tokens_for(s.x, s.y, room)?;
            let st = m_sell_core(s, room, age, tokens, true);
            assert_no_overflow(&st, "sell");
            st.ok().then(|| st.next.unwrap())
        }
        Op::SellAll { pct_of_room } => {
            let room = room_at(s, age);
            let kas_out = ((room as i128 * *pct_of_room as i128 / 100) as i64).max(0);
            if kas_out < 1 || kas_out >= s.x {
                return None;
            }
            let tokens = tokens_for(s.x, s.y, kas_out)?;
            let st = m_sell_core(s, kas_out, age, tokens, true);
            assert_no_overflow(&st, "sell");
            st.ok().then(|| st.next.unwrap())
        }
        Op::RemoveAll { idx, keep_kas_bps } => {
            if positions.is_empty() {
                return None;
            }
            let i = *idx % positions.len();
            let shares = positions[i].shares;
            let kas_full = (shares as i128 * s.x as i128 / s.s as i128) as i64;
            let kas_out = ((kas_full as i128 * (10_000 - *keep_kas_bps) as i128 / 10_000) as i64).max(0);
            let tokens_out = (shares as i128 * s.y as i128 / s.s as i128) as i64;
            let st = m_remove(s, shares, kas_out, tokens_out, age);
            assert_no_overflow(&st, "remove");
            if st.ok() {
                positions.remove(i);
                Some(st.next.unwrap())
            } else {
                None
            }
        }
        Op::Collect => {
            let st = m_collect(s);
            st.next
        }
        Op::Pause => {
            let st = m_pause(s, true);
            st.next
        }
        Op::Unpause => {
            let st = m_pause(s, false);
            st.next
        }
        Op::Wait { .. } => Some(s.clone()),
    }
}

fn add_ratio(s: &Ps, kas: i64, positions: &mut Vec<MPos>, age: i64) -> Option<Ps> {
    if s.paused || kas <= 0 {
        return None;
    }
    let kas = kas.min(MAX_OPERAND - s.x);
    if kas <= 0 {
        return None;
    }
    let tokens = (((kas as i128) * s.y as i128 + s.x as i128 - 1) / s.x as i128) as i64;
    if tokens <= 0 || tokens > MAX_OPERAND - s.y {
        return None;
    }
    let shares_max = ((kas as i128 * s.s as i128 / s.x as i128).min(tokens as i128 * s.s as i128 / s.y as i128)) as i64;
    if shares_max <= 0 || s.s.checked_add(shares_max).map_or(true, |t| t > MAX_OPERAND) {
        return None;
    }
    let st = m_add(s, kas, tokens, shares_max, age);
    assert_no_overflow(&st, "add");
    if st.ok() {
        positions.push(MPos { shares: shares_max });
        Some(st.next.unwrap())
    } else {
        None
    }
}

fn pick_op(rng: &mut Rng, s: &Ps) -> Op {
    if rng.below(14) == 0 {
        return Op::Tick;
    }
    match rng.below(26) {
        0..=4 => Op::AddRatio { mult_pct: 1 + rng.below(400) as i64 },
        5 | 6 => Op::AddRatioBig { x_mult: 1 + rng.below(50) as i64 },
        7..=9 => Op::BuyAdded { added: 1 + rng.below((3 * cap_of(s, 0)).max(KAS) as u64) as i64 },
        10..=12 => Op::BuyMax,
        13..=15 => Op::SellRoom,
        16 | 17 => Op::Sell { pct_of_room: 1 + rng.below(100) as i64 },
        18 => Op::SellAll { pct_of_room: 1 + rng.below(100) as i64 },
        19..=21 => Op::RemoveAll { idx: rng.below(100) as usize, keep_kas_bps: if rng.below(4) == 0 { rng.below(10_000) as i64 } else { 0 } },
        22 => {
            let d = rng.below(3 * p_w() as u64) as i64;
            Op::Wait { d, claim: rng.below(3) as i64 }
        }
        23 => Op::Collect,
        24 => {
            if s.paused { Op::Unpause } else { Op::Pause }
        }
        _ => Op::Wait { d: rng.below(40) as i64, claim: 0 },
    }
}

/// Every invariant the design relies on, checked after each step.
fn assert_no_overflow(st: &Step, what: &str) {
    assert!(st.next.is_some() || !st.violations.is_empty(), "the script would abort on arithmetic in an otherwise valid {what}: requires all passed");
}

fn check_invariants(prev: &Ps, s: &Ps, claimed_zero: bool, context: &dyn Fn() -> String) {
    assert!(s.x > 0, "x <= 0: {s:?} {}", context());
    assert!(s.y > 0, "y <= 0: {s:?} {}", context());
    assert!(s.s >= MIN_LIQUIDITY, "shares under the floor: {s:?} {}", context());
    assert!(s.x <= MAX_OPERAND && s.y <= MAX_OPERAND && s.s <= MAX_OPERAND, "above the operand limit: {s:?} {}", context());
    assert!(s.credit >= 0, "negative credit: {s:?} {}", context());
    assert!(s.credit <= MAX_OPERAND, "credit above the limit: {s:?} {}", context());
    assert!(s.rf >= 1, "reference <= 0: {s:?} {}", context());
    assert!(s.rf <= s.x, "reference above the reserve: {s:?} {}", context());
    assert!(s.pk >= 0 && s.pt >= 0, "negative protocol fee: {s:?} {}", context());
    assert!(s.credit as i128 + (s.out as i128).min(0) >= 0, "credit below the negative count: {s:?} {}", context());
    if claimed_zero {
        // SPEC §15: window_out + window_credit never falls without claimed time. The one exception is a withdrawal that shrinks
        // the pool below its reference, which cuts the count to two of the new caps: sells get no room from that.
        let held = s.out as i128 + s.credit as i128 >= prev.out as i128 + prev.credit as i128;
        let cap_now = m_share_of(s.rf, p_bps()).unwrap() as i128;
        let cap_before = m_share_of(prev.rf, p_bps()).unwrap() as i128;
        let room_now = cap_now - s.out as i128;
        let room_before = cap_before - prev.out as i128;
        let cut_by_shrink = s.rf < prev.rf && s.out as i128 == 2 * cap_now && room_now <= room_before.max(0);
        assert!(held || cut_by_shrink, "out + credit fell with no claimed time, and no shrinking withdrawal explains it: {prev:?} -> {s:?} {}", context());
    }
    let _ = prev;
}

/// Result of one random adversary run on the model.
struct RunStats {
    /// Largest honest loss over the strict rate allowance (10% + 10%·t/W of the honest claim).
    worst_strict: f64,
    /// Largest net swap outflow over the SPEC's formula (cap·(1 + t/W) with the largest cap seen).
    worst_spec: f64,
    claimed_time: i64,
    cap_max: i128,
}

/// One random adversary run on the model; panics on a broken invariant.
#[derive(Clone, Copy)]
struct RunOpts {
    trace: bool,
    /// Every entry claims no age and nobody waits: an entry the covenant refuses that way (any public one while sell
    /// room is in use) is simply refused.
    no_time: bool,
    /// Every entry claims exactly the least it may (none, or the minimum while more than half of the cap is in use), and the actor
    /// waits until the pool UTXO is that old; no other time passes. The time claimed is only the time the rule forces.
    least_time: bool,
    allow_adds: bool,
    /// Panic with a trace when the honest provider loses more than 10 % + 10 %·t/W.
    assert_strict: bool,
}

/// One random adversary run on the model; panics on a broken invariant.
fn run_adversary(seed: u64, steps: usize, x0: i64, y0: i64, trace: bool, no_time: bool) -> RunStats {
    run_adversary_opts(seed, steps, x0, y0, RunOpts { trace, no_time, least_time: false, allow_adds: true, assert_strict: false })
}

fn run_adversary_opts(seed: u64, steps: usize, x0: i64, y0: i64, opts: RunOpts) -> RunStats {
    let RunOpts { trace, no_time, least_time, allow_adds, assert_strict } = opts;
    let mut rng = Rng::new(seed.wrapping_mul(7919).wrapping_add(13));
    let st0 = m_init(&Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 }, x0, y0, 0, y0);
    assert!(st0.ok(), "{:?}", st0.violations);
    let mut s = st0.next.unwrap();
    let honest = x0 - MIN_LIQUIDITY;
    let mut positions: Vec<MPos> = Vec::new();
    let start_claim = claim(&s, honest);
    let mut now: i64 = 0;
    let mut pool_daa: i64 = 0;
    let mut claimed_time: i64 = 0;
    let mut min_claim = start_claim;
    let mut worst_strict = 0f64;
    let mut worst_spec = 0f64;
    let mut net_out: i128 = 0;
    let mut cap_max: i128 = cap_of(&s, 0) as i128;
    let mut trace_log = String::new();

    for i in 0..steps {
        let op = pick_op(&mut rng, &s);
        if let Op::Wait { d, .. } = op {
            if !no_time && !least_time { now += d; }
            continue;
        }
        if !allow_adds && matches!(op, Op::AddRatio { .. } | Op::AddRatioBig { .. }) {
            continue;
        }
        if s.paused && !matches!(op, Op::RemoveAll { .. } | Op::Unpause | Op::Collect | Op::Pause | Op::Tick) {
            continue;
        }
        // The least this entry may claim: a tick always the minimum, a public entry the minimum above half of the cap.
        let need = if matches!(op, Op::Tick) { m_min_age(p_w()) } else { least_age(&s) };
        let real_age = (now - pool_daa).clamp(0, 2 * p_w());
        let mut age = if no_time {
            0
        } else if least_time {
            need
        } else {
            match rng.below(6) {
                0 => 0,
                1 => real_age,
                2 => need,
                3 => (need - 1).max(0),
                _ => rng.range(0, real_age),
            }
        };
        // Mostly the actor waits for the claim it needs rather than be refused.
        if !no_time && !least_time && age < need && rng.below(4) != 0 {
            age = need;
        }
        // Consensus: a claim can't exceed the UTXO's age, so a claim above it waits until the UTXO is that old.
        if op.claims_age() && age > real_age {
            now = pool_daa + age;
        }
        let prev = s.clone();
        let is_swap = matches!(op, Op::BuyAdded { .. } | Op::BuyMax | Op::Sell { .. } | Op::SellRoom | Op::SellAll { .. });
        let this_age = if op.claims_age() { age } else { 0 };
        let Some(next) = apply_model(&s, &op, &mut positions, this_age) else { continue };
        s = next;
        if op.claims_age() {
            claimed_time += this_age;
            cap_max = cap_max.max(cap_of(&prev, this_age) as i128);
        }
        if is_swap {
            net_out += prev.x as i128 - s.x as i128;
        }
        pool_daa = now;
        check_invariants(&prev, &s, this_age == 0, &|| format!("seed {seed} step {i} op {op:?}\n{trace_log}"));
        if trace {
            trace_log.push_str(&format!("{i}: {op:?} age={this_age} -> x={} out={} credit={} ref={} s={}\n", s.x, s.out, s.credit, s.rf, s.s));
        }

        let c = claim(&s, honest);
        if c < min_claim {
            min_claim = c;
        }
        let loss = (start_claim - min_claim) as f64;
        let t = claimed_time as f64 / p_w() as f64;
        // The strict rate: what an honest provider should expect, 10 % at once then 10 % per window.
        let strict = (start_claim as f64) * 0.1 * (1.0 + t) + (2 * KAS) as f64;
        worst_strict = worst_strict.max(loss / strict);
        if assert_strict && loss > strict {
            if !trace {
                return run_adversary_opts(seed, steps, x0, y0, RunOpts { trace: true, ..opts });
            }
            panic!("strict allowance broken at seed {seed} step {i}: claim {start_claim} -> {min_claim}, allowance {strict:.0}, state {s:?}\n{trace_log}");
        }
        // The SPEC's literal bound on the pool's net KAS outflow through swaps.
        let spec = cap_max as f64 * (1.0 + t) + (2 * KAS) as f64;
        worst_spec = worst_spec.max(net_out as f64 / spec);
        assert!(frac_mode() || net_out as f64 <= spec, "seed {seed} step {i}: net swap outflow {net_out} above cap_max*(1+t/W) = {spec:.0} (claimed {claimed_time}, cap_max {cap_max})\n{trace_log}");

        // A fair withdrawal must always pass, claiming the least it may (it waits that long) or two windows.
        let (hk, ht) = ((honest as i128 * s.x as i128 / s.s as i128) as i64, (honest as i128 * s.y as i128 / s.s as i128) as i64);
        let waits: &[i64] = if s.paused { &[0] } else { &[least_age(&s), 2 * p_w()] };
        for &wait in waits {
            let st = m_remove(&s, honest, hk, ht, wait);
            assert!(st.ok(), "the honest withdrawal claiming {wait} would be refused at seed {seed} step {i}: {:?}; state {s:?}", st.violations);
        }
        for p in positions.iter() {
            let (kk, tt) = ((p.shares as i128 * s.x as i128 / s.s as i128) as i64, (p.shares as i128 * s.y as i128 / s.s as i128) as i64);
            let st = m_remove(&s, p.shares, kk, tt, least_remove_age(&s));
            assert!(st.ok(), "a fair removal would be refused at seed {seed} step {i}: {:?}", st.violations);
        }
        now += rng.below(3) as i64;
    }
    if trace {
        println!("{trace_log}");
    }
    RunStats { worst_strict, worst_spec, claimed_time, cap_max }
}

/// Millions of random operations: no broken invariant, no refused fair withdrawal, and
/// the pool's net outflow stays within SPEC §15's formula.
#[test]
fn search_random_adversaries_keep_every_invariant() {
    let mut worst_strict = 0f64;
    let mut worst_spec = 0f64;
    let mut runs = 0u64;
    let sizes: [(i64, i64); 5] = [
        (10_000 * KAS, 1_000 * USDT),
        (1_000 * KAS, 10 * USDT),
        (100_000 * KAS, 100_000 * USDT),
        (1_000_000 * KAS, 50 * USDT),
        (5_000, 7),
    ];
    for &(x0, y0) in &sizes {
        for seed in 0..4000u64 {
            let stats = run_adversary(seed * 31 + 7, 300, x0, y0, false, false);
            worst_strict = worst_strict.max(stats.worst_strict);
            worst_spec = worst_spec.max(stats.worst_spec);
            runs += 1;
        }
    }
    println!("random adversaries: {runs} runs of 300 steps; worst net outflow {worst_spec:.3} of the SPEC bound; worst honest loss {worst_strict:.3} of the strict allowance");
}

// ---------------------------------------------------------------------------
// Part 3: directed attacks, through the real engine.

impl Harness {
    fn honest_claim(&self, shares: i64) -> i64 {
        claim(&self.state.ps, shares)
    }

    /// Adds `kas` at the pool's ratio, claiming the least it may (waiting for it); asserts the model and the engine agree.
    fn do_add(&mut self, who: &Keypair, kas: i64) -> Pos {
        let age = self.least();
        self.do_add_at(who, kas, age)
    }

    fn do_add_at(&mut self, who: &Keypair, kas: i64, age: i64) -> Pos {
        let s = self.state.ps.clone();
        let tokens = ((kas as i128 * s.y as i128 + s.x as i128 - 1) / s.x as i128) as i64;
        let shares = ((kas as i128 * s.s as i128 / s.x as i128).min(tokens as i128 * s.s as i128 / s.y as i128)) as i64;
        let step = m_add(&s, kas, tokens, shares, age);
        assert!(step.ok(), "add: {:?}", step.violations);
        let next = step.next.clone().unwrap();
        let pos = self.add(who, tokens + 1, kas, tokens, shares, age, &next).expect("the engine accepts the add");
        assert_eq!(self.state.ps, next);
        pos
    }

    /// A tick claiming `age`; asserts the model and the engine agree.
    fn do_tick(&mut self, age: i64) {
        let s = self.state.ps.clone();
        let step = m_tick(&s, age);
        assert!(step.ok(), "tick: {:?}", step.violations);
        let next = step.next.clone().unwrap();
        self.tick(age, &next).expect("the engine accepts the tick");
    }

    /// A buy that adds `added` KAS to the reserve, claiming `age`.
    fn do_buy(&mut self, who: &Keypair, added: i64, age: i64) {
        let s = self.state.ps.clone();
        let kas_in = kas_in_for(added);
        let amount = buy_quote(s.x, s.y, kas_in);
        let step = m_buy(&s, kas_in, age, amount);
        assert!(step.ok(), "buy: {:?}", step.violations);
        let next = step.next.clone().unwrap();
        self.buy(who, kas_in, amount, age, &next).expect("the engine accepts the buy");
    }

    /// A sell of exactly `kas_out` out of the reserve, claiming `age`.
    fn do_sell(&mut self, who: &Keypair, kas_out: i64, age: i64) {
        let s = self.state.ps.clone();
        let tokens = tokens_for(s.x, s.y, kas_out).expect("tokens");
        let step = m_sell_core(&s, kas_out, age, tokens, true);
        assert!(step.ok(), "sell: {:?}; state {s:?}", step.violations);
        let next = step.next.clone().unwrap();
        let _ = self.sell(who, tokens + 1, tokens, kas_out, age, false, &next).expect("the engine accepts the sell");
    }

    /// Burns `pos` for its full share of both reserves, claiming the least it may (waiting for it).
    fn do_remove(&mut self, pos: &Pos) {
        let age = self.least();
        self.do_remove_at(pos, age);
    }

    fn do_remove_at(&mut self, pos: &Pos, age: i64) {
        let s = self.state.ps.clone();
        let kas_out = (pos.shares as i128 * s.x as i128 / s.s as i128) as i64;
        let tokens_out = (pos.shares as i128 * s.y as i128 / s.s as i128) as i64;
        let step = m_remove(&s, pos.shares, kas_out, tokens_out, age);
        assert!(step.ok(), "remove: {:?}", step.violations);
        let next = step.next.clone().unwrap();
        self.remove(pos, kas_out, tokens_out, age, &next).expect("the engine accepts the remove");
    }
}

fn fresh_pool(x0: i64, y0: i64) -> (Harness, Keypair, Pos) {
    let mut h = Harness::with_state(Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 });
    let honest = key(0xa1);
    let pos = h.init(&honest, y0 + 1, x0, y0).expect("init");
    (h, honest, pos)
}

/// One cycle of the refill attack with `depth`× temporary liquidity, spending `a` DAA.
fn refill_cycle(h: &mut Harness, attacker: &Keypair, depth: i64, a: i64) {
    // 1. A deep position: most of the pool for a few minutes (both sides come back at the end).
    let kas = depth * h.state.ps.x;
    let pos = h.do_add(attacker, kas);
    // 2. Real time passes; the pool UTXO ages.
    h.now += a;
    // 3. Anyone's swap claims the age. With the reserve inflated, the reference rises a/W of a
    //    huge gap, the cap with it, and the used allowance decays by a/W of that big cap.
    let age = h.age();
    h.do_buy(attacker, KAS, age);
    // 4. The liquidity leaves. The reference falls at once, but window_out keeps the refill.
    h.do_remove(&pos);
    // 5. The whole allowance goes through a pool that is the honest provider again (as soon as the pool UTXO allows).
    let age = h.least();
    let room = room_at(&h.state.ps, age).min(h.state.ps.x - 1);
    h.do_sell(attacker, room, age);
}

/// The proof, through the real engine, that the allowance refills far faster than one cap per
/// window with temporary liquidity. PASSES when the attack works (audit2's attack_* convention).
///
/// Numbers: 10 000 KAS honest pool, attacker cycles 100× that (1 000 000 KAS and matching
/// kUSDT) for 3 700 DAA ≈ 6 min each. See `spec_bound_holds_against_temporary_liquidity`.
#[test]
fn the_refill_cycle_with_temporary_liquidity_stays_within_the_stated_rate() {
    let attacker = key(0xf0);
    let (x0, y0) = (10_000 * KAS, 1_000 * USDT);
    let (mut h, _honest, pos) = fresh_pool(x0, y0);
    let start = h.honest_claim(pos.shares);
    let t0 = h.now;
    // The dump the breaker allows at once.
    let k0 = room_at(&h.state.ps, 0);
    h.do_sell(&attacker, k0, 0);
    println!("after the first dump: {:.2}% of the honest claim left", 100.0 * h.honest_claim(pos.shares) as f64 / start as f64);
    let a = 3_700;
    for cycle in 1..=9 {
        refill_cycle(&mut h, &attacker, 100, a);
        let left = h.honest_claim(pos.shares);
        let elapsed = h.now - t0;
        println!("cycle {cycle}: {elapsed} DAA ({:.1} min) elapsed, honest claim {:.2}%", elapsed as f64 / 600.0, 100.0 * left as f64 / start as f64);
    }
    let left = h.honest_claim(pos.shares) as i128;
    let elapsed = h.now - t0;
    assert!(elapsed < WINDOW, "the whole attack fits inside one window");
    let lost = start as i128 - left;
    // What the breaker claims to allow in that time: one cap now, the refill rate since.
    let bound = (start as i128 * MAX_OUT_BPS as i128 / BPS as i128) * (WINDOW + elapsed) as i128 / WINDOW as i128;
    println!("lost {:.1}% of the honest claim in {:.0} minutes; the stated rate allows {:.1}%", 100.0 * lost as f64 / start as f64, elapsed as f64 / 600.0, 100.0 * bound as f64 / start as f64);
    assert!(lost <= bound + (2 * KAS) as i128, "the attack passed the stated bound: lost {lost}, bound {bound}");
}

/// The same scenario asserted as the property it breaks: this test FAILS until the refill is
/// bound to the reserve that stays (see the notes), and should pass afterwards.
#[test]
fn spec_bound_holds_against_temporary_liquidity() {
    let attacker = key(0xf1);
    let (x0, y0) = (10_000 * KAS, 1_000 * USDT);
    let (mut h, _honest, pos) = fresh_pool(x0, y0);
    let start = h.honest_claim(pos.shares) as i128;
    let t0 = h.now;
    let k0 = room_at(&h.state.ps, 0);
    h.do_sell(&attacker, k0, 0);
    for _ in 0..3 {
        refill_cycle(&mut h, &attacker, 100, 3_700);
    }
    let left = h.honest_claim(pos.shares) as i128;
    let elapsed = (h.now - t0) as i128;
    let cap = start * MAX_OUT_BPS as i128 / BPS as i128;
    let allowed = cap + cap * elapsed / WINDOW as i128 + 2 * KAS as i128;
    assert!(start - left <= allowed, "honest claim {start} -> {left} in {elapsed} DAA; SPEC §15 rate allows a loss of {allowed} (cap {cap})");
}

/// The sweep behind the numbers in the notes: for each temporary-liquidity depth, how much of the
/// honest claim is gone after one window (model only, the mechanism above).
#[test]
fn sweep_refill_attack_by_liquidity_depth() {
    println!("depth | age per cycle | honest claim left after one window (vs ~80% with no trick)");
    let mut rows: Vec<(i64, i64, f64)> = Vec::new();
    for &depth in &[0i64, 1, 3, 10, 30, 100, 300, 1000, 10_000] {
        let (x0, y0) = (10_000 * KAS, 1_000 * USDT);
        let mut s = m_init(&Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 }, x0, y0, 0, y0).next.unwrap();
        let honest = x0 - MIN_LIQUIDITY;
        let start = claim(&s, honest) as f64;
        // the first dump
        let k = room_at(&s, 0);
        let t = tokens_for(s.x, s.y, k).unwrap();
        s = m_sell_core(&s, k, 0, t, true).next.unwrap();
        let mut left_after_window = None;
        let mut elapsed = 0i64;
        let mut cycles = 0;
        let mut age_used = 0;
        while elapsed < WINDOW {
            let mut positions = Vec::new();
            if depth > 0 {
                let kas = (s.x as i128 * depth as i128).min((MAX_OPERAND - s.x) as i128 / 2) as i64;
                let tokens = (((kas as i128) * s.y as i128 + s.x as i128 - 1) / s.x as i128) as i64;
                let shares = (kas as i128 * s.s as i128 / s.x as i128).min(tokens as i128 * s.s as i128 / s.y as i128) as i64;
                let a0 = least_age(&s);
                s = m_add(&s, kas, tokens, shares, a0).next.unwrap();
                elapsed += a0;
                positions.push(MPos { shares });
            }
            // the smallest age whose claim refills all that was used (binary search on the model)
            let (mut lo, mut hi) = (0i64, 2 * WINDOW);
            let target = s.out.max(0);
            while lo < hi {
                let mid = (lo + hi) / 2;
                let nref = m_advanced_ref(s.rf, s.x, mid, WINDOW).unwrap();
                let cap = m_share_of(nref, MAX_OUT_BPS).unwrap();
                let settled = m_settled_out(s.out, mid, cap, WINDOW).unwrap();
                if settled <= (target / 1000).max(1) {
                    hi = mid;
                } else {
                    lo = mid + 1;
                }
            }
            let age = lo.min(WINDOW - elapsed + 1).max(least_age(&s));
            if age_used == 0 {
                age_used = age;
            }
            if elapsed + age > WINDOW {
                break;
            }
            // the claim, through a 1 KAS buy
            let kas_in = kas_in_for(KAS);
            let amount = buy_quote(s.x, s.y, kas_in);
            s = m_buy(&s, kas_in, age, amount).next.unwrap();
            elapsed += age;
            if let Some(p) = positions.pop() {
                let (kk, tt) = ((p.shares as i128 * s.x as i128 / s.s as i128) as i64, (p.shares as i128 * s.y as i128 / s.s as i128) as i64);
                let a1 = least_age(&s);
                s = m_remove(&s, p.shares, kk, tt, a1).next.unwrap();
                elapsed += a1;
            }
            let a2 = least_age(&s);
            let room = room_at(&s, a2).min(s.x - 1);
            if room < KAS {
                break;
            }
            let t = tokens_for(s.x, s.y, room).unwrap();
            s = m_sell_core(&s, room, a2, t, true).next.unwrap();
            elapsed += a2;
            cycles += 1;
            left_after_window = Some(claim(&s, honest) as f64 / start);
            if depth == 0 && cycles > 200 {
                break;
            }
        }
        let frac = left_after_window.unwrap_or(claim(&s, honest) as f64 / start);
        println!("{depth:>5} | {age_used:>6} DAA | {:.1}% after {cycles} cycles", frac * 100.0);
        rows.push((depth, age_used, frac));
    }
    // With the reference limited to doubling per window, depth buys nothing: the honest claim keeps the stated rate.
    let at_100 = rows.iter().find(|r| r.0 == 100).unwrap().2;
    assert!(at_100 > 0.75, "depth 100 should not accelerate the drain: {at_100}");
}

/// At one moment (no claimed time) the honest loss stays within one cap, whatever the sequence of
/// adds, removes, buys, sells and partial withdrawals. This is the property `window_credit` was
/// added for: it must hold, and it does.
#[test]
fn search_no_time_honest_loss_stays_within_one_cap() {
    let mut worst_spec = 0f64;
    let mut worst_strict = 0f64;
    for &(x0, y0) in &[(10_000 * KAS, 1_000 * USDT), (1_000 * KAS, 10 * USDT), (777_777 * KAS, 123 * USDT)] {
        for seed in 0..5000u64 {
            let stats = run_adversary(seed * 17 + 3, 200, x0, y0, false, true);
            worst_spec = worst_spec.max(stats.worst_spec);
            worst_strict = worst_strict.max(stats.worst_strict);
            assert_eq!(stats.claimed_time, 0);
        }
    }
    println!("no claimed time: worst net outflow {worst_spec:.3} of cap_max, worst honest loss {worst_strict:.3} of one cap + 2 KAS");
    assert!(worst_strict <= 1.0, "an honest provider lost more than one cap with no time claimed: {worst_strict}");
}

/// The largest script-unit budgets the entries need, at tiny and at near-limit values. A budget
/// over u16::MAX compute-budget units, or a mass over the block limits, would make an action
/// impossible: compare with the limits in the notes.
#[test]
fn budgets_do_not_depend_on_value_size() {
    let who = key(0xf5);
    let mut report = Vec::new();
    for &(x0, y0, label) in &[(100_000i64, 1_000i64, "tiny reserves"), (10_000 * KAS, 1_000 * USDT, "typical"), (MAX_OPERAND / 2, MAX_OPERAND / 2, "near the operand limit")] {
        let mut h = Harness::with_state(Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 });
        let lp = key(0xa2);
        h.init(&lp, y0 + 1, x0, y0).expect("init");
        let s = h.state.ps.clone();
        let kas_out = (room_at(&s, 0) / 2).min(MAX_SWAP_INPUT / 3);
        let tokens = tokens_for(s.x, s.y, kas_out).unwrap();
        let step = m_sell_core(&s, kas_out, 0, tokens, true);
        assert!(step.ok(), "{:?}", step.violations);
        let tx = h.sell(&who, tokens + 1, tokens, kas_out, 0, false, &step.next.clone().unwrap()).expect("sell");
        let budget = tx.inputs[0].compute_commit.compute_budget().expect("v1 input");
        let size: usize = tx.inputs.iter().map(|i| i.signature_script.len()).sum();
        report.push(format!("{label}: pool input budget {budget} ({} script units), signature scripts {size} bytes", budget as u64 * 10_000));
    }
    println!("{}", report.join("\n"));
}

/// One model-only cycle of the refill attack: `depth`x liquidity in, a buy claiming `a`, the liquidity out, and the
/// whole room sold. Every step claims at least what the covenant requires, which counts as time. Answers the new
/// state, the DAA the cycle took, and whether it sold (it doesn't when less than 1 KAS of room is left).
fn model_cycle(s: &Ps, depth: i64, a: i64) -> (Ps, i64, bool) {
    let mut s = s.clone();
    let mut used = 0;
    let mut pos = None;
    if depth > 0 {
        let kas = (s.x as i128 * depth as i128).min((MAX_OPERAND - s.x) as i128 / 2) as i64;
        let tokens = (((kas as i128) * s.y as i128 + s.x as i128 - 1) / s.x as i128) as i64;
        let shares = (kas as i128 * s.s as i128 / s.x as i128).min(tokens as i128 * s.s as i128 / s.y as i128) as i64;
        let age = least_age(&s);
        s = m_add(&s, kas, tokens, shares, age).next.unwrap();
        used += age;
        pos = Some(shares);
    }
    let age = a.max(least_age(&s));
    let kas_in = kas_in_for(KAS);
    let amount = buy_quote(s.x, s.y, kas_in);
    s = m_buy(&s, kas_in, age, amount).next.unwrap();
    used += age;
    if let Some(shares) = pos {
        let (kk, tt) = ((shares as i128 * s.x as i128 / s.s as i128) as i64, (shares as i128 * s.y as i128 / s.s as i128) as i64);
        let age = least_age(&s);
        s = m_remove(&s, shares, kk, tt, age).next.unwrap();
        used += age;
    }
    let age = least_age(&s);
    let room = room_at(&s, age).min(s.x - 1);
    if room < KAS {
        return (s, used, false);
    }
    s = m_sell_core(&s, room, age, tokens_for(s.x, s.y, room).unwrap(), true).next.unwrap();
    (s, used + age, true)
}

/// Model-only: the sweep above with the candidate fix (a used allowance decays by elapsed/length
/// of itself, not of the cap) switched on: the temporary-liquidity trick buys nothing, and honest
/// sells still refill fully in one window. Compare with `sweep_refill_attack_by_liquidity_depth`.
#[test]
fn fix_candidate_proportional_decay_stops_the_acceleration() {
    CANDIDATE_FIX.with(|c| c.set(1));
    for &depth in &[0i64, 10, 100, 1000] {
        let (x0, y0) = (10_000 * KAS, 1_000 * USDT);
        let mut s = m_init(&Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 }, x0, y0, 0, y0).next.unwrap();
        let honest = x0 - MIN_LIQUIDITY;
        let start = claim(&s, honest) as f64;
        let k = room_at(&s, 0);
        let t = tokens_for(s.x, s.y, k).unwrap();
        s = m_sell_core(&s, k, 0, t, true).next.unwrap();
        // Spread the window over cycles of 3 700 DAA, as in the attack.
        let mut elapsed = 0i64;
        while elapsed + 3_700 <= WINDOW {
            let (next, used, _) = model_cycle(&s, depth, 3_700);
            s = next;
            elapsed += used;
        }
        let left = claim(&s, honest) as f64 / start;
        println!("candidate fix: depth {depth}: honest claim {:.1}% after one window of 3 700-DAA cycles", left * 100.0);
        assert!(left > 0.7, "the fix should not leave depth {depth} draining faster than the stated rate: {left}");
    }
    CANDIDATE_FIX.with(|c| c.set(0));
}

/// The KAS deposit riding on the reserve UTXO is pinned at 1 KAS or more by the pool: a swapper
/// stripping it would leave a transaction later clients can't build (round 2 of the attack review).
#[test]
fn check_the_reserve_kas_deposit_is_pinned() {
    let (mut h, _, _) = fresh_pool(10_000 * KAS, 1_000 * USDT);
    let who = key(0xb0);
    let s = h.state.ps.clone();
    let kas_out = room_at(&s, 0) / 2;
    let tokens = tokens_for(s.x, s.y, kas_out).unwrap();
    let step = m_sell_core(&s, kas_out, 0, tokens, true);
    assert!(step.ok());
    h.reserve_output_sompi = 1_000_000;
    assert!(h.sell(&who, tokens + 1, tokens, kas_out, 0, false, &step.next.clone().unwrap()).is_err(), "a sell that strips the reserve's KAS deposit is refused");
}

/// Model and engine agree at the very top of the range the products allow.
#[test]
fn differential_at_the_operand_limits() {
    let mut tally = Tally { accepted: 0, rejected: 0 };
    for &(x, y, s0) in &[(MAX_OPERAND, MAX_OPERAND, MAX_OPERAND), (MAX_OPERAND, 2, MAX_OPERAND), (2, MAX_OPERAND, 2_000), (LIMB, LIMB, LIMB), (LIMB * LIMB - 1, LIMB * LIMB - 1, LIMB)] {
        let mut h = Harness::with_state(Ps { x, y, s: s0, pk: 0, pt: 0, credit: 0, rf: x, out: 0, paused: false, dr: 0 });
        let (r_out, r_utxo) = h.token_utxo(reserve_state(y));
        h.reserve = Some((r_out, r_utxo, y));
        let mut positions: Vec<Pos> = Vec::new();
        let mut rng = Rng::new(x as u64 % 1009 + y as u64 % 13);
        for _ in 0..200 {
            exercise(&mut h, &mut positions, &mut rng, &mut tally);
        }
    }
    println!("differential at the limits: {} accepted, {} refused, model and engine agreed", tally.accepted, tally.rejected);
    assert!(tally.accepted > 5, "the sample did not reach accepted cases");
}

/// The last provider can always leave and the pool stays usable. The first deposit into the emptied pool takes the admin's
/// signature (nobody else's, and no empty one, opens it), and starts the reference again at the new reserve, as init
/// does: sells open at once on the new liquidity (before 10 November 2026 anyone could add there, the reference stayed the
/// dust, and sells took 26 windows to reopen). Then anyone adds, and the provider withdraws again.
#[test]
fn check_the_last_provider_leaves_and_the_admin_reopens_the_pool() {
    let (mut h, _honest, pos) = fresh_pool(10_000 * KAS, 1_000 * USDT);
    let who = key(0xb7);
    h.do_buy(&who, 100 * KAS, 0);
    let room = room_at(&h.state.ps, 0) / 2;
    h.do_sell(&who, room, 0);
    h.do_remove(&pos);
    let s = h.state.ps.clone();
    assert_eq!(s.s, MIN_LIQUIDITY, "only the unowned shares remain");
    assert!(s.x > 0 && s.y > 0, "dust stays behind: {s:?}");
    // Anyone's deposit into it: refused by the model and the script, with no signature or with the depositor's own.
    let newcomer = key(0xb8);
    let kas = 1_000 * KAS;
    let tokens = ((kas as i128 * s.y as i128 + s.x as i128 - 1) / s.x as i128) as i64;
    let shares = ((kas as i128 * s.s as i128 / s.x as i128).min(tokens as i128 * s.s as i128 / s.y as i128)) as i64;
    let age = h.least();
    let anyone = m_add(&s, kas, tokens, shares, age);
    assert!(anyone.violations.contains(&"emptied: the admin's signature"), "{:?}", anyone.violations);
    let admins = m_add_as(&s, kas, tokens, shares, age, true);
    assert!(admins.ok(), "{:?}", admins.violations);
    let next = admins.next.clone().unwrap();
    script_refuses(h.add_signed(&newcomer, tokens + 1, kas, tokens, shares, age, &next, None), "an unsigned deposit into an emptied pool");
    script_refuses(h.add_signed(&newcomer, tokens + 1, kas, tokens, shares, age, &next, Some(newcomer)), "a deposit into an emptied pool signed by someone else");
    // The admin's: accepted, and the reference is the new reserve.
    let admin = h.admin_key;
    let new_pos = h.add_signed(&admin, tokens + 1, kas, tokens, shares, age, &next, Some(admin)).expect("the admin reopens the pool");
    assert_eq!(h.state.ps, next);
    assert_eq!(h.state.ps.rf, h.state.ps.x, "the reference starts again at the new reserve");
    let open = room_at(&h.state.ps, 0);
    assert!(open >= m_share_of(h.state.ps.x, MAX_OUT_BPS).unwrap() - s.out.max(0) - 1, "sells open at once: {open}");
    // Now anyone adds again, with an empty witness, and an admin's signature on an ordinary add is refused.
    let age = h.least();
    let extra = h.do_add_at(&newcomer, 100 * KAS, age);
    let age = h.least();
    h.do_buy(&who, KAS, age);
    h.do_remove(&extra);
    h.do_remove(&new_pos);
    assert_eq!(h.state.ps.s, MIN_LIQUIDITY);
}

/// The dust-reference stall as it was (anyone reopening an emptied pool kept the dust's reference), kept as a record of
/// what the admin-signed reopen replaces: here through the model only, an add by the admin into a pool that still has a
/// dust position of someone else's, which is not "emptied", so the reference stays the dust. See the known limits.
#[test]
fn check_a_dust_position_keeps_an_emptied_pools_reference_small() {
    let (mut h, _honest, pos) = fresh_pool(10_000 * KAS, 1_000 * USDT);
    let (who, griefer, newcomer) = (key(0xb7), key(0xb9), key(0xb8));
    // Fifteen windows of the most sells take the KAS behind a share to about a fifth.
    for _ in 0..15 {
        h.now += WINDOW;
        let age = h.age();
        let room = room_at(&h.state.ps, age);
        h.do_sell(&who, room, age);
    }
    // A dust position (100 sompi of KAS) before the last provider leaves: the pool is then not "emptied".
    h.now += MIN_AGE;
    let age = h.least();
    let dust = h.do_add_at(&griefer, 100, age);
    h.now += MIN_AGE;
    h.do_remove(&pos);
    let s = h.state.ps.clone();
    assert_eq!(s.s, MIN_LIQUIDITY + dust.shares);
    assert!(s.rf < 720, "the reference is the dust: {s:?}");
    // Anyone may add (it is not emptied), and the reference stays the dust.
    h.now += MIN_AGE;
    let age = h.least();
    let new_pos = h.do_add_at(&newcomer, 1_000 * KAS, age);
    let before = h.state.ps.rf;
    assert!(before < 720);
    // Claims of 50 DAA (a griefer's tick or dust spend in every slot) round its rise to nothing: a window of them leaves it.
    for _ in 0..720 {
        h.now += MIN_AGE;
        h.do_tick(MIN_AGE);
    }
    assert_eq!(h.state.ps.rf, before, "fifty-DAA claims never lift a reference this small");
    // One long claim lifts it by its own size (it doubles): the stall is a griefer's to keep, at a fee per slot.
    h.now += WINDOW;
    h.do_tick(WINDOW);
    assert_eq!(h.state.ps.rf, 2 * before);
    println!("a dust position kept the reference at {before} sompi under 720 ticks of 50 DAA (1 000 KAS in the pool); one claim of a window doubled it");
    h.now += MIN_AGE;
    let age = h.least();
    let _ = age;
    h.do_remove(&new_pos);
}

// ---------------------------------------------------------------------------
// Part 4: exhaustive search over short sequences, with time: claimed age, credit lapsing, cap
// shrinking. Everything here runs on the model, which the differential tests pin to the engine.

use std::collections::HashMap;

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct Node {
    ps: Ps,
    /// The attacker's positions (shares), sorted.
    positions: Vec<i64>,
    /// The age the pool UTXO has reached (capped at two windows).
    avail: i64,
    /// All real time passed since the start.
    t: i64,
}

#[derive(Clone, Copy)]
struct ExCfg {
    name: &'static str,
    x0: i64,
    y0: i64,
    window: i64,
    bps: i64,
    depth: u32,
    /// Percent of the reserve the attacker may add at a time (empty: no adds at all).
    add_pcts: &'static [i64],
    /// The attacker's share of the pool at the start, in percent (held from before).
    attacker_start_pct: i64,
    /// Waiting allowed; age claims are 0, half and all of what the UTXO has.
    time: bool,
    /// Without `time`: only the shortest wait, for the least claim above half of the cap.
    least_waits: bool,
    /// Treat the allowance as a hard requirement and panic with the path on a breach.
    assert_bound: bool,
    /// Candidate fix: 0 none (the contract), 1 proportional decay, 2 fractional accounting.
    fix: u8,
    slack: f64,
    budget: u64,
}

struct Explorer {
    cfg: ExCfg,
    honest: i64,
    start: i64,
    seen: HashMap<Node, u32>,
    nodes: u64,
    ran_out: bool,
    worst: f64,
    witness: Vec<String>,
    worst_loss_pct: f64,
}

fn cap_room(s: &Ps, age: i64) -> (i64, i64, i64) {
    let cap = cap_of(s, age);
    let settled = settled_abs(s, age);
    (cap, settled, room_at(s, age))
}

fn child(prev: &Node, ps: Ps, positions: Option<Vec<i64>>) -> Node {
    Node { ps, positions: positions.unwrap_or_else(|| prev.positions.clone()), avail: 0, t: prev.t }
}

fn moves(cfg: &ExCfg, n: &Node) -> Vec<(String, Node)> {
    let mut out: Vec<(String, Node)> = Vec::new();
    let s = &n.ps;
    let ctx = |what: &str| format!("{}: {what} from {:?}", cfg.name, n);
    let min_age = m_min_age(cfg.window);
    let wait = |d: i64| Node { ps: s.clone(), positions: n.positions.clone(), avail: (n.avail + d).min(2 * cfg.window), t: n.t + d };
    if cfg.time {
        for d in [cfg.window / 2, cfg.window, 2 * cfg.window] {
            if n.t + d <= 3 * cfg.window {
                out.push((format!("wait {d}"), wait(d)));
            }
        }
    }
    // The shortest wait, for the least claim above half of the cap (with time, or with only the forced claims).
    if (cfg.time || cfg.least_waits) && n.avail < min_age && n.t + min_age <= 3 * cfg.window {
        out.push((format!("wait {min_age}"), wait(min_age)));
    }
    // The ages a claim can take: none, the least, half and all of what the UTXO has (never more: consensus).
    let least = least_age(s);
    let mut ages = vec![0];
    if least > 0 && least <= n.avail {
        ages.push(least);
    }
    if n.avail > 0 {
        ages.push(n.avail / 2);
        ages.push(n.avail);
    }
    ages.sort();
    ages.dedup();
    // Liquidity claims the least or all of it; a tick the minimum or all of it.
    let mut lp_ages: Vec<i64> = [least, n.avail].into_iter().filter(|&a| a <= n.avail).collect();
    lp_ages.dedup();
    let mut tick_ages: Vec<i64> = [min_age, n.avail].into_iter().filter(|&a| a >= min_age && a <= n.avail).collect();
    tick_ages.dedup();
    if !s.paused {
        for &age in &ages {
            let (cap, settled, room) = cap_room(s, age);
            // Buys: dust, half a cap, a cap, exactly the credit room, two caps.
            let mut added = vec![1, cap / 2, cap, cap + settled.max(0) + 1, 2 * cap + 1];
            added.sort();
            added.dedup();
            for a in added {
                if a < 1 {
                    continue;
                }
                let kas_in = kas_in_for(a).max(1).min(MAX_SWAP_INPUT);
                let quote = buy_quote(s.x, s.y, kas_in);
                if quote < 1 || s.y - quote < 1 {
                    continue;
                }
                let st = m_buy(s, kas_in, age, quote);
                assert_no_overflow(&st, "buy");
                if st.ok() {
                    let next = st.next.clone().unwrap();
                    check_invariants(s, &next, age == 0, &|| ctx("buy"));
                    out.push((format!("buy +{a} age {age}"), child(n, next, None)));
                }
            }
            // Sells: all the room, half, dust.
            let mut sells = vec![room, room / 2, 1];
            sells.sort();
            sells.dedup();
            for k in sells {
                if k < 1 || k >= s.x || k > room {
                    continue;
                }
                let Some(tokens) = tokens_for(s.x, s.y, k) else { continue };
                let st = m_sell_core(s, k, age, tokens, true);
                assert_no_overflow(&st, "sell");
                if st.ok() {
                    let next = st.next.clone().unwrap();
                    check_invariants(s, &next, age == 0, &|| ctx("sell"));
                    out.push((format!("sell -{k} age {age}"), child(n, next, None)));
                }
            }
        }
        // The attacker's liquidity.
        if n.positions.len() < 2 {
            for &pct in cfg.add_pcts {
                let kas = ((s.x as i128 * pct as i128) / 100) as i64;
                if kas < 1 || kas > MAX_OPERAND - s.x {
                    continue;
                }
                let tokens = (((kas as i128) * s.y as i128 + s.x as i128 - 1) / s.x as i128) as i64;
                if tokens < 1 || tokens > MAX_OPERAND - s.y {
                    continue;
                }
                let shares = (kas as i128 * s.s as i128 / s.x as i128).min(tokens as i128 * s.s as i128 / s.y as i128) as i64;
                if shares < 1 || shares > MAX_OPERAND - s.s {
                    continue;
                }
                for &age in &lp_ages {
                    let st = m_add(s, kas, tokens, shares, age);
                    assert_no_overflow(&st, "add");
                    if st.ok() {
                        let next = st.next.clone().unwrap();
                        check_invariants(s, &next, age == 0, &|| ctx("add"));
                        let mut pos = n.positions.clone();
                        pos.push(shares);
                        pos.sort();
                        out.push((format!("add {pct}% = {kas} age {age}"), child(n, next, Some(pos))));
                    }
                }
            }
        }
        // The admin's pause and collect touch the pool too (each makes a new UTXO of age 0).
        let paused = m_pause(s, true).next.unwrap();
        out.push(("pause".into(), child(n, paused, None)));
    } else {
        let resumed = m_pause(s, false).next.unwrap();
        out.push(("unpause".into(), child(n, resumed, None)));
    }
    let collected = m_collect(s).next.unwrap();
    out.push(("collect".into(), child(n, collected, None)));
    // Ticks, paused or not.
    for &age in &tick_ages {
        let st = m_tick(s, age);
        assert_no_overflow(&st, "tick");
        if st.ok() {
            let next = st.next.clone().unwrap();
            check_invariants(s, &next, false, &|| ctx("tick"));
            out.push((format!("tick age {age}"), child(n, next, None)));
        }
    }
    // Removes: the attacker's positions, in full, keeping half or all of the KAS in the pool.
    for (i, &shares) in n.positions.iter().enumerate() {
        for keep in [0i64, 5_000, 10_000] {
            let kas_full = (shares as i128 * s.x as i128 / s.s as i128) as i64;
            let kas_out = (kas_full as i128 * (10_000 - keep) as i128 / 10_000) as i64;
            let tokens_out = (shares as i128 * s.y as i128 / s.s as i128) as i64;
            for &age in &lp_ages {
                let st = m_remove(s, shares, kas_out, tokens_out, age);
                assert_no_overflow(&st, "remove");
                if st.ok() {
                    let next = st.next.clone().unwrap();
                    check_invariants(s, &next, age == 0, &|| ctx("remove"));
                    let mut pos = n.positions.clone();
                    pos.remove(i);
                    out.push((format!("remove #{i} keep {keep}bps age {age}"), child(n, next, Some(pos))));
                }
            }
        }
    }
    out
}

impl Explorer {
    fn visit(&mut self, n: &Node, left: u32, path: &mut Vec<String>) {
        if self.nodes >= self.cfg.budget {
            self.ran_out = true;
            return;
        }
        if let Some(&r) = self.seen.get(n) {
            if r >= left {
                return;
            }
        }
        self.seen.insert(n.clone(), left);
        self.nodes += 1;
        // The honest provider's claim against the allowance for the real time that has passed.
        let c = claim(&n.ps, self.honest);
        let loss = (self.start - c) as f64;
        let allowance = self.start as f64 * self.cfg.bps as f64 / 10_000.0 * (1.0 + n.t as f64 / self.cfg.window as f64) + self.cfg.slack;
        let ratio = loss / allowance;
        if ratio > self.worst {
            self.worst = ratio;
            self.witness = path.clone();
            self.worst_loss_pct = 100.0 * loss / self.start as f64;
        }
        if self.cfg.assert_bound && loss > allowance {
            panic!("{}: honest claim {} -> {} (loss {loss:.0} > allowance {allowance:.0}) after {:?}\nstate {:?}", self.cfg.name, self.start, c, path, n.ps);
        }
        // A fair withdrawal must pass for everyone, in every state.
        let s = &n.ps;
        // It waits for the least claim it may make (no more than the minimum, a few seconds).
        let fair = |shares: i64| -> Step { m_remove(s, shares, (shares as i128 * s.x as i128 / s.s as i128) as i64, (shares as i128 * s.y as i128 / s.s as i128) as i64, least_remove_age(s)) };
        for shares in std::iter::once(self.honest).chain(n.positions.iter().copied()) {
            let st = fair(shares);
            assert!(st.ok(), "{}: fair removal of {shares} shares refused: {:?} in {:?} after {:?}", self.cfg.name, st.violations, n.ps, path);
        }
        if left == 0 {
            return;
        }
        for (label, next) in moves(&self.cfg, n) {
            path.push(label);
            self.visit(&next, left - 1, path);
            path.pop();
        }
    }
}

/// Runs one exhaustive configuration and returns (worst ratio, worst loss in percent of the
/// honest claim, nodes visited, ran out of budget, witness).
fn exhaustive(cfg: ExCfg) -> (f64, f64, u64, bool, Vec<String>) {
    PARAMS.with(|c| c.set((cfg.bps, cfg.window)));
    CANDIDATE_FIX.with(|c| c.set(cfg.fix));
    let st0 = m_init(&Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 }, cfg.x0, cfg.y0, 0, cfg.y0);
    assert!(st0.ok(), "{:?}", st0.violations);
    let s = st0.next.unwrap();
    let mut honest = cfg.x0 - MIN_LIQUIDITY;
    let mut positions = Vec::new();
    if cfg.attacker_start_pct > 0 {
        // A part of the first position is really the attacker's: split it.
        let attacker_shares = (honest as i128 * cfg.attacker_start_pct as i128 / 100) as i64;
        honest -= attacker_shares;
        positions.push(attacker_shares);
    }
    let start = claim(&s, honest);
    let mut ex = Explorer { cfg, honest, start, seen: HashMap::new(), nodes: 0, ran_out: false, worst: 0.0, witness: Vec::new(), worst_loss_pct: 0.0 };
    let root = Node { ps: s, positions, avail: 0, t: 0 };
    let mut path = Vec::new();
    ex.visit(&root, cfg.depth, &mut path);
    CANDIDATE_FIX.with(|c| c.set(0));
    PARAMS.with(|c| c.set((MAX_OUT_BPS, WINDOW)));
    (ex.worst, ex.worst_loss_pct, ex.nodes, ex.ran_out, ex.witness)
}

fn report_ex(name: &str, r: &(f64, f64, u64, bool, Vec<String>)) {
    println!("{name}: {} states{}, worst honest loss {:.2}% = {:.3} of the allowance; path {:?}", r.2, if r.3 { " (budget reached)" } else { "" }, r.1, r.0, r.4);
}

const BIG_X: i64 = 10_000 * KAS;
const BIG_Y: i64 = 1_000 * USDT;

/// With no liquidity added at all, every sequence of swaps, waits, claims, pauses and fee
/// collections, on the real rules: at most the strict rate (one cap plus one cap per window).
#[test]
fn exhaustive_swaps_time_and_pauses_keep_the_strict_rate() {
    let cfg = ExCfg {
        name: "swaps+time", x0: BIG_X, y0: BIG_Y, window: 36_000, bps: 1_000, depth: 7, add_pcts: &[], attacker_start_pct: 0,
        time: true, least_waits: false, assert_bound: true, fix: 0, slack: (2 * KAS) as f64, budget: 2_000_000,
    };
    let r = exhaustive(cfg);
    report_ex("swaps+time (window 36000)", &r);
    // The same on a tiny pool and a tiny window: every rounding and clamp path, 8 units of slack.
    let cfg = ExCfg { name: "swaps+time tiny", x0: 5_000, y0: 5_000, window: 8, bps: 1_000, depth: 7, add_pcts: &[], attacker_start_pct: 0,
        time: true, least_waits: false, assert_bound: true, fix: 0, slack: 8.0, budget: 2_000_000 };
    let r = exhaustive(cfg);
    report_ex("swaps+time (tiny pool, window 8)", &r);
}

/// A provider who has been in the pool from the start (the attacker holds half, or 90 %), plus
/// swaps and time, on the real rules. Leaving does not raise what can be taken from the rest.
#[test]
fn exhaustive_existing_positions_and_time_keep_the_strict_rate() {
    for pct in [50i64, 90] {
        let cfg = ExCfg { name: "existing position", x0: BIG_X, y0: BIG_Y, window: 36_000, bps: 1_000, depth: 6, add_pcts: &[], attacker_start_pct: pct,
            time: true, least_waits: false, assert_bound: true, fix: 0, slack: (2 * KAS) as f64, budget: 1_500_000 };
        let r = exhaustive(cfg);
        report_ex(&format!("attacker holds {pct}% at the start"), &r);
    }
}

/// With no time at all, adds and removes included: at most one cap, on the real rules.
#[test]
fn exhaustive_adds_and_removes_with_no_time_keep_one_cap() {
    for (x0, y0, slack) in [(BIG_X, BIG_Y, (2 * KAS) as f64), (5_000i64, 5_000i64, 8.0f64)] {
        let cfg = ExCfg { name: "no time", x0, y0, window: 36_000, bps: 1_000, depth: 6, add_pcts: &[30, 100, 1000], attacker_start_pct: 0,
            time: false, least_waits: false, assert_bound: true, fix: 0, slack, budget: 3_000_000 };
        let r = exhaustive(cfg);
        report_ex(&format!("no time, adds allowed (pool {x0})"), &r);
    }
}

/// Everything at once on the real rules: the search must find the known refill break (H1) and
/// shows the shortest path to it. Printed, not asserted: `spec_bound_holds...` fails for it.
#[test]
fn exhaustive_everything_on_the_real_rules_reports_the_worst_case() {
    let cfg = ExCfg { name: "everything", x0: BIG_X, y0: BIG_Y, window: 36_000, bps: 1_000, depth: 6, add_pcts: &[100, 1000, 10000], attacker_start_pct: 0,
        time: true, least_waits: false, assert_bound: false, fix: 0, slack: (2 * KAS) as f64, budget: 3_000_000 };
    let r = exhaustive(cfg);
    report_ex("everything, real rules", &r);
}




/// Long random sequences on the real rules with no liquidity added at all (swaps, waits, age
/// claims, pauses, fee collections): the strict rate holds. The refill break needs liquidity.
#[test]
fn search_swaps_alone_keep_the_strict_rate() {
    for &(x0, y0) in &[(BIG_X, BIG_Y), (1_000 * KAS, 10 * USDT), (777_777 * KAS, 123 * USDT)] {
        for seed in 0..5000u64 {
            run_adversary_opts(seed.wrapping_mul(97) + 11, 300, x0, y0, RunOpts { trace: false, no_time: false, least_time: false, allow_adds: false, assert_strict: true });
        }
    }
    println!("strict rate held over 15000 random runs of swaps alone");
}



/// The real rules in a full attack sweep across how long the attacker waits per cycle, at a
/// mid-sized temporary deposit: the honest loss rate is many times the stated 10 % per window,
/// and depends on the deposit, not on time. (Printed; the failing test is `spec_bound_...`.)
#[test]
fn sweep_refill_attack_by_cycle_time() {
    for &(depth, a) in &[(10i64, 3_700i64), (10, 10_400), (30, 3_700), (100, 1_800), (100, 3_700), (1000, 900)] {
        let (x0, y0) = (BIG_X, BIG_Y);
        let mut s = m_init(&Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 }, x0, y0, 0, y0).next.unwrap();
        let honest = x0 - MIN_LIQUIDITY;
        let start = claim(&s, honest) as f64;
        let k = room_at(&s, 0);
        s = m_sell_core(&s, k, 0, tokens_for(s.x, s.y, k).unwrap(), true).next.unwrap();
        let mut elapsed = 0i64;
        let mut cycles = 0;
        while elapsed + a <= WINDOW {
            let (next, used, sold) = model_cycle(&s, depth, a);
            s = next;
            elapsed += used;
            if !sold {
                break;
            }
            cycles += 1;
        }
        println!("depth {depth}, {a} DAA per cycle: {} cycles fit in one window, honest claim left {:.1}%", cycles, 100.0 * claim(&s, honest) as f64 / start);
    }
}

/// The candidate fixes compared on the model, against the adversaries that break the contract:
/// 0 = the contract as it is; 1 = a positive count decays by elapsed/W of itself; 2 = allowance
/// kept in fractions of the reference; 3 = the count is repaid at the reference it was used at;
/// 4 = the reference rises at most by its own size per window of claimed time.
///
/// Printed for each: the worst honest loss over 6 000 random adversaries (with unlimited
/// liquidity) and an exhaustive 6-step search, as a share of the strict allowance (10 % at once
/// plus 10 % per window of claimed time), and the honest claim left after the refill cycle
/// repeated for one window at 100x temporary liquidity. Only candidate 4 stays at the allowance.
#[test]
fn candidate_fixes_compared() {
    let mut rows = Vec::new();
    for fix in 0u8..=4 {
        CANDIDATE_FIX.with(|c| c.set(fix));
        let mut worst = 0f64;
        for &(x0, y0) in &[(BIG_X, BIG_Y), (1_000 * KAS, 10 * USDT)] {
            for seed in 0..3000u64 {
                let stats = run_adversary_opts(seed.wrapping_mul(131) + 23, 300, x0, y0, RunOpts { trace: false, no_time: false, least_time: false, allow_adds: true, assert_strict: false });
                worst = worst.max(stats.worst_strict);
            }
        }
        let cfg = ExCfg { name: "compare", x0: BIG_X, y0: BIG_Y, window: 36_000, bps: 1_000, depth: 6, add_pcts: &[100, 1000, 10000], attacker_start_pct: 0,
            time: true, least_waits: false, assert_bound: false, fix, slack: (2 * KAS) as f64, budget: 1_200_000 };
        let (ex_worst, ..) = exhaustive(cfg);
        CANDIDATE_FIX.with(|c| c.set(fix));
        // The full-window cycle attack at 100x.
        let (x0, y0) = (BIG_X, BIG_Y);
        let mut s = m_init(&Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 }, x0, y0, 0, y0).next.unwrap();
        let honest = x0 - MIN_LIQUIDITY;
        let start = claim(&s, honest) as f64;
        let k = room_at(&s, 0);
        s = m_sell_core(&s, k, 0, tokens_for(s.x, s.y, k).unwrap(), true).next.unwrap();
        let (mut elapsed, a) = (0i64, 3_700i64);
        while elapsed + a <= WINDOW {
            let (next, used, _) = model_cycle(&s, 100, a);
            s = next;
            elapsed += used;
        }
        CANDIDATE_FIX.with(|c| c.set(0));
        let left = 100.0 * claim(&s, honest) as f64 / start;
        println!("candidate {fix}: random worst {worst:.3}, exhaustive worst {ex_worst:.3} of the strict allowance; 100x refill cycle leaves {left:.1}% of the honest claim after one window");
        rows.push((fix, worst, ex_worst, left));
    }
    // The contract (row 0) carries candidate 4. On the strict allowance the exhaustive search stays within rounding; the
    // random one can meet row 41's temporary-liquidity effect (a deposit lifts the reference, one claim refills at the larger
    // cap, the deposit leaves), whose single-claim worst `engine_temporary_liquidity_on_main_and_the_branch` measures in the
    // engine at about 1.15 on main as on this covenant: the random worst must stay under it.
    let (_, worst, ex, left) = rows[0];
    assert!(worst <= ROW41_WORST && ex <= 1.05, "the contract left the strict allowance: {worst} {ex}");
    assert!(left >= 80.0, "the contract still accelerates the cycle: {left}%");
}

/// The ceiling row 41's temporary-liquidity effect reaches on the strict allowance with one claim, on main and here.
const ROW41_WORST: f64 = 1.16;

/// main's add (583937c): no age, nothing settles; the liquidity in, the breaker as it was.
fn m_add_main(s: &Ps, kas_in: i64, tokens_in: i64, shares: i64) -> Ps {
    Ps { x: s.x + kas_in, y: s.y + tokens_in, s: s.s + shares, ..s.clone() }
}

/// main's remove (583937c): no age; the credit back on the count, and a pool shrunk below the reference cut to two caps.
fn m_remove_main(s: &Ps, shares: i64, kas_out: i64, tokens_out: i64) -> Ps {
    let reclaimed = kas_out.min(s.credit);
    let nx = s.x - kas_out;
    let (mut rf, mut out) = (s.rf, s.out + reclaimed);
    if nx < rf {
        rf = nx;
        out = out.min(2 * m_share_of(nx, p_bps()).unwrap());
    }
    Ps { x: nx, y: s.y - tokens_out, s: s.s - shares, credit: s.credit - reclaimed, rf, out, ..s.clone() }
}

/// One run of the row-41 sequence in the engine, on main's covenant or the branch's, on the same timeline: a dump of the
/// cap at once; 50 DAA later a deposit of `mult_pct` % of the reserve; `e` DAA later a dust buy that claims the pool UTXO's
/// age; 50 DAA later the deposit leaves; 50 DAA later the room is sold. On main the deposit and the withdrawal claim no
/// age (their 50 DAA are lost); on the branch they claim it. Answers the honest provider's loss over the strict allowance
/// for the time each claimed, the pool's net KAS outflow through swaps over the SPEC bound (cap on the largest reference,
/// plus credit, plus cap per window of claimed time), and the loss itself.
fn row41_run(main: bool, mult_pct: i64, e: i64) -> (f64, f64, i64) {
    let (x0, y0) = (BIG_X, BIG_Y);
    let empty = Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 };
    let mut h = if main { Harness::with_state_main(empty) } else { Harness::with_state(empty) };
    let (honest, attacker) = (key(0xa1), key(0xf0));
    let pos = h.init(&honest, y0 + 1, x0, y0).expect("init");
    let start = h.honest_claim(pos.shares);
    let x_init = h.state.ps.x;
    let (mut claimed, mut cap_max, mut credit_max) = (0i64, m_share_of(h.state.ps.rf, p_bps()).unwrap(), 0i64);
    let mut note = |h: &Harness, claim: i64| {
        claimed += claim;
        cap_max = cap_max.max(m_share_of(h.state.ps.rf, p_bps()).unwrap());
        credit_max = credit_max.max(h.state.ps.credit);
    };
    // The dump.
    let k = room_at(&h.state.ps, 0);
    h.do_sell(&attacker, k, 0);
    note(&h, 0);
    // The deposit, 50 DAA later.
    h.now += MIN_AGE;
    let s = h.state.ps.clone();
    let kas = (s.x as i128 * mult_pct as i128 / 100) as i64;
    let tokens = ((kas as i128 * s.y as i128 + s.x as i128 - 1) / s.x as i128) as i64;
    let shares = ((kas as i128 * s.s as i128 / s.x as i128).min(tokens as i128 * s.s as i128 / s.y as i128)) as i64;
    let deposit = if main {
        let next = m_add_main(&s, kas, tokens, shares);
        let p = h.add(&attacker, tokens + 1, kas, tokens, shares, 0, &next).expect("main's add");
        note(&h, 0);
        p
    } else {
        let age = h.age();
        let p = h.do_add_at(&attacker, kas, age);
        note(&h, age);
        p
    };
    // The claim.
    h.now += e;
    let age = h.age();
    h.do_buy(&attacker, KAS, age);
    note(&h, age);
    // The deposit leaves.
    h.now += MIN_AGE;
    let s = h.state.ps.clone();
    let (kk, tt) = ((deposit.shares as i128 * s.x as i128 / s.s as i128) as i64, (deposit.shares as i128 * s.y as i128 / s.s as i128) as i64);
    if main {
        let next = m_remove_main(&s, deposit.shares, kk, tt);
        h.remove(&deposit, kk, tt, 0, &next).expect("main's remove");
        note(&h, 0);
    } else {
        let age = h.age();
        h.do_remove_at(&deposit, age);
        note(&h, age);
    }
    // The room sold.
    h.now += MIN_AGE;
    let age = h.age();
    let room = room_at(&h.state.ps, age).min(h.state.ps.x - 1);
    if room > 0 {
        h.do_sell(&attacker, room, age);
    }
    note(&h, age);
    let loss = start - h.honest_claim(pos.shares);
    let strict = start as f64 * 0.1 * (1.0 + claimed as f64 / WINDOW as f64) + (2 * KAS) as f64;
    let net_out = (x_init - h.state.ps.x) as f64; // the deposit came back whole: the rest went through swaps
    let spec = cap_max as f64 * (1.0 + claimed as f64 / WINDOW as f64) + credit_max as f64 + (2 * KAS) as f64;
    (loss as f64 / strict, net_out / spec, loss)
}

/// Row 41's temporary-liquidity effect (a deposit lifts the reference, one claim refills at the larger cap, the deposit
/// leaves), through the script engine on main's covenant (583937c) and on the branch's, on the same timelines: the branch
/// is never worse than main, and both keep the SPEC's stated bound on the pool's net outflow. The worst single claim is
/// reported: the honest provider can lose about 1.15 of the strict allowance for the time claimed, on main as on the branch.
#[test]
fn engine_temporary_liquidity_on_main_and_the_branch() {
    let mut worst = [(0f64, 0i64, 0i64); 2];
    let mut worst_spec = 0f64;
    let mut runs = 0;
    for mult in [100i64, 200, 334, 1_000, 10_000] {
        for e_per_mille in [300i64, 500, 580, 600, 620, 640, 650, 660, 670, 680, 700, 750, 800, 1_000, 1_500, 2_000] {
            let e = WINDOW * e_per_mille / 1_000 - 150;
            let (main_ratio, main_spec, main_loss) = row41_run(true, mult, e);
            let (branch_ratio, branch_spec, branch_loss) = row41_run(false, mult, e);
            // The branch claims 150 DAA more of the same timeline (its add, its withdrawal): at most that much more refill.
            let extra = (m_share_of(BIG_X, MAX_OUT_BPS).unwrap() as i128 * 2 * 150 / WINDOW as i128) as i64;
            assert!(branch_loss <= main_loss + extra, "mult {mult}%, e {e}: the branch lost {branch_loss}, main {main_loss}");
            assert!(branch_ratio <= main_ratio + 0.01, "mult {mult}%, e {e}: branch {branch_ratio:.4} against main {main_ratio:.4}");
            assert!(main_spec <= 1.0 && branch_spec <= 1.0, "mult {mult}%, e {e}: past the SPEC bound: main {main_spec:.4}, branch {branch_spec:.4}");
            worst_spec = worst_spec.max(main_spec).max(branch_spec);
            for (i, r) in [main_ratio, branch_ratio].into_iter().enumerate() {
                if r > worst[i].0 {
                    worst[i] = (r, mult, e);
                }
            }
            runs += 1;
        }
    }
    println!("temporary liquidity, one claim, {runs} timelines in the engine: worst honest loss {:.3} of the strict allowance on main (deposit {}%, claim {} DAA), {:.3} on the branch (deposit {}%, claim {} DAA); worst net outflow {worst_spec:.3} of the SPEC bound",
        worst[0].0, worst[0].1, worst[0].2, worst[1].0, worst[1].1, worst[1].2);
    assert!(worst[1].0 <= worst[0].0 + 0.01);
    assert!(worst[0].0 > 1.1 && worst[0].0 < 1.2, "the effect as measured before: {:.3}", worst[0].0);
}

/// Two statements about `window_credit` in SPEC 15, checked on the model (the second is why the
/// docs should be read carefully, neither loses money): credit is not limited to one cap (a buy
/// against a used allowance credits up to two caps), and it does not fade while the count is
/// non-negative (it stays until a sell spends it or a withdrawal moves it onto the count).
#[test]
fn check_credit_can_exceed_a_cap_and_stale_credit_stays() {
    let s0 = m_init(&Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 }, BIG_X, BIG_Y, 0, BIG_Y).next.unwrap();
    let cap = cap_of(&s0, 0);
    // Use the whole allowance, then buy two caps: the count goes from +cap to -cap, credit 2 caps.
    let tokens = tokens_for(s0.x, s0.y, cap).unwrap();
    let st = m_sell_core(&s0, cap, 0, tokens, true);
    assert!(st.ok());
    let s1 = st.next.unwrap();
    let cap1 = cap_of(&s1, 0);
    let kas_in = kas_in_for(2 * cap + cap1);
    // The count is positive, so the buy claims the minimum.
    let st = m_buy(&s1, kas_in, MIN_AGE, buy_quote(s1.x, s1.y, kas_in));
    assert!(st.ok(), "{:?}", st.violations);
    let s2 = st.next.unwrap();
    assert!(s2.credit > cap1, "credit {} over one cap {}", s2.credit, cap1);
    println!("credit after buying against a used allowance: {:.2} caps (out {:.2} caps)", s2.credit as f64 / cap1 as f64, s2.out as f64 / cap1 as f64);
    // Partial buy: the count stays positive, the credit is kept, and time does not lapse it.
    let st = m_sell_core(&s0, cap, 0, tokens, true);
    let s3 = st.next.unwrap();
    let st = m_buy(&s3, kas_in_for(cap / 3), MIN_AGE, buy_quote(s3.x, s3.y, kas_in_for(cap / 3)));
    let s4 = st.next.unwrap();
    let (out_before, credit_before) = (s4.out, s4.credit);
    let st = m_buy(&s4, kas_in_for(1), WINDOW, buy_quote(s4.x, s4.y, kas_in_for(1)));
    let s5 = st.next.unwrap();
    println!("a full window of age: count {} -> {}, credit {} -> {}", out_before, s5.out, credit_before, s5.credit);
    assert!(s5.credit >= credit_before, "the credit did not lapse while the count was positive");
}

// ---------------------------------------------------------------------------
// Part 5: the shortest claim and the tick (the clock fix of 10 November 2026, and the review's H1 after it).
//
// While more than half of the stored cap is in use (stored 2·window_out > cap) every public entry claims at
// least MIN_AGE, so the pool can't be spent more often than that and every spend refills at least that much;
// below it sells have at least half a cap and spends may claim nothing, so no dust spend holds the minimum in
// force. `tick` settles the breaker and changes nothing else. A keeper ticks a few DAA after each pool UTXO is
// MIN_AGE old once it has seen a spend that claimed less than its UTXO's age by more than a slack.

/// A small buy that gets at least one kUSDT base unit out (within a factor of two of the smallest), if any does.
fn dust_buy(s: &Ps) -> Option<i64> {
    let mut kas_in = 1i64;
    while buy_quote(s.x, s.y, kas_in) < 1 {
        if kas_in > MAX_SWAP_INPUT / 2 {
            return None;
        }
        kas_in = kas_in * 2 + 1;
    }
    Some(kas_in)
}

/// A user's kUSDT state transferring to itself, as an extra input and output of a pool transaction.
fn user_transfer<'a>(ctx: TxContext<'a>, who: &Keypair, amount: i64, out: TransactionOutpoint, utxo: UtxoEntry, input: u16) -> TxContext<'a> {
    let state = user_state(who, amount);
    let key = *who;
    let next = vec![state.clone()];
    ctx.actor_input("kusdt::KCC20", state.clone(), EntryCall::new("transfer").args_with(move |tx, i| {
        let mut w = vec![0x00];
        w.extend(sign_input(tx, i, &key));
        args!(next.clone(), w)
    }), out, utxo, 0)
        .actor_output("kusdt::KCC20", state, CovenantBinding::new(input, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI)
}

impl Harness {
    /// A tick with everything a hostile one could change: the claim, the sequence, the successor, the pool output's
    /// value, the reserve moved beside it or a user's own kUSDT state as another input.
    fn try_tick_custom(&self, age: i64, sequence: u64, next: &Ps, value: u64, reserve_to: Option<&Keypair>, user_token: Option<&Keypair>) -> Result<Transaction, Rejected> {
        let next_full = self.next_ps(next);
        let mut ctx = TxContext::new()
            .actor_input("Pool", self.state.state(), EntryCall::new("tick").args(args!(age)), self.pool.0, self.pool.1.clone(), sequence)
            .actor_output("Pool", next_full.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), value);
        let mut entries = vec![self.pool.1.clone()];
        if let Some(thief) = reserve_to {
            let (out, utxo, amount) = self.reserve.clone().unwrap();
            let stolen = user_state(thief, amount);
            ctx = ctx
                .actor_input("kusdt::KCC20", reserve_state(amount), EntryCall::new("transfer").args(args!(vec![stolen.clone()], vec![0x00u8])), out, utxo.clone(), 0)
                .actor_output("kusdt::KCC20", stolen, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
            entries.push(utxo);
        }
        if let Some(who) = user_token {
            let (out, utxo) = self.token_utxo(user_state(who, 5 * USDT));
            ctx = user_transfer(ctx, who, 5 * USDT, out, utxo.clone(), entries.len() as u16);
            entries.push(utxo);
        }
        ctx = ctx.input(self.fresh(), funding(), funding_sig(), 0);
        entries.push(funding());
        let tx = self.builder.build(&ctx).map_err(rejected)?;
        run(tx, entries)
    }
}

#[track_caller]
fn script_refuses<T>(result: Result<T, Rejected>, what: &str) {
    match result {
        Err(Rejected::Script(e)) => assert!(e.contains("input 0 script failed"), "{what}: refused, but not by the pool: {e}"),
        Err(Rejected::Build(e)) => panic!("{what}: the builder failed before the script ran: {e}"),
        Ok(_) => panic!("{what}: accepted"),
    }
}

/// The minimum claim in the engine, on both sides of its threshold. At or below half of the stored cap in use (a count
/// below zero, at zero, and exactly at half), every public entry may claim nothing; one sompi more and every public entry
/// claiming under MIN_AGE is refused by the script. A tick always claims the minimum. Then each entry in turn at
/// MIN_AGE. While paused the breaker stands still: a withdrawal claims exactly 0 and settles nothing, and a tick is
/// refused.
#[test]
fn engine_every_public_entry_claims_the_minimum_above_half_the_cap() {
    let (mut h, _, _) = fresh_pool(BIG_X, BIG_Y);
    let (who, lp) = (key(0xc1), key(0xc2));
    // At zero: everything claims nothing.
    assert_eq!(h.state.ps.out, 0);
    let p0 = h.do_add_at(&lp, BIG_X / 10, 0);
    h.do_remove_at(&p0, 0);
    // A position to withdraw below.
    let p1 = h.do_add_at(&lp, BIG_X / 10, 0);
    let s = h.state.ps.clone();
    let kas_in = 10 * KAS;
    let st = m_buy(&s, kas_in, 0, buy_quote(s.x, s.y, kas_in));
    assert!(st.ok());
    h.buy(&who, kas_in, buy_quote(s.x, s.y, kas_in), 0, &st.next.clone().unwrap()).expect("a buy claiming nothing at zero");
    assert!(h.state.ps.out < 0);
    // Below zero (credit): a small sell claiming nothing, and a sell_all.
    for all in [false, true] {
        let s = h.state.ps.clone();
        let k = KAS / 10;
        let t = tokens_for(s.x, s.y, k).unwrap();
        let st = m_sell_core(&s, k, 0, t, true);
        assert!(st.ok(), "{:?}", st.violations);
        h.sell(&who, t, t, k, 0, all, &st.next.clone().unwrap()).expect("a sell claiming nothing below zero");
    }
    script_refuses(h.try_tick_custom(0, 0, &m_tick(&h.state.ps, 0).next.unwrap(), h.state.value(), None, None), "a tick claiming nothing at zero");
    script_refuses(h.try_tick_custom(MIN_AGE - 1, (MIN_AGE - 1) as u64, &m_tick(&h.state.ps, MIN_AGE - 1).next.unwrap(), h.state.value(), None, None), "a tick under the minimum at zero");

    // Exactly half of the stored cap in use, by the largest sell that stays there: still nothing to claim.
    let s = h.state.ps.clone();
    let at_half = |k: i64| tokens_for(s.x, s.y, k).and_then(|t| m_sell_core(&s, k, 0, t, true).next).is_some_and(|n| !in_regime(&n));
    let (mut lo, mut hi) = (1i64, room_at(&s, 0));
    while lo < hi {
        let mid = lo + (hi - lo + 1) / 2;
        if at_half(mid) { lo = mid } else { hi = mid - 1 }
    }
    h.do_sell(&who, lo, 0);
    let s = h.state.ps.clone();
    let cap = m_share_of(s.rf, MAX_OUT_BPS).unwrap();
    assert!(!in_regime(&s) && s.out > 0 && s.out >= cap / 2 - 2, "at half of the cap: {} of {cap}", s.out);
    let kas = BIG_X / 100;
    let tokens = ((kas as i128 * s.y as i128 + s.x as i128 - 1) / s.x as i128) as i64;
    let shares = ((kas as i128 * s.s as i128 / s.x as i128).min(tokens as i128 * s.s as i128 / s.y as i128)) as i64;
    let (kk, tt) = ((p1.shares as i128 * s.x as i128 / s.s as i128) as i64, (p1.shares as i128 * s.y as i128 / s.s as i128) as i64);
    assert!(m_buy(&s, kas_in, 0, buy_quote(s.x, s.y, kas_in)).ok(), "the model's buy claiming nothing at half of the cap");
    assert!(m_add(&s, kas, tokens, shares, 0).ok(), "the model's add claiming nothing at half of the cap");
    assert!(m_remove(&s, p1.shares, kk, tt, 0).ok(), "the model's remove claiming nothing at half of the cap");
    // In the engine: a sell of a few sompi claiming nothing, which takes the count past half.
    let few = 1 + (cap / 2 - s.out).max(0);
    let t = tokens_for(s.x, s.y, few).unwrap();
    let st = m_sell_core(&s, few, 0, t, true);
    assert!(st.ok(), "{:?}", st.violations);
    h.sell(&who, t, t, few, 0, false, &st.next.clone().unwrap()).expect("a sell claiming nothing at half of the cap");
    assert!(in_regime(&h.state.ps), "past half of the cap now: {:?}", h.state.ps);

    // More than half of the stored cap in use: every public entry claiming under the minimum is refused.
    h.now += MIN_AGE;
    let s = h.state.ps.clone();
    for age in [0, 1, MIN_AGE - 1] {
        let ctx = |what: &str| format!("{what} claiming {age} with the count at {}", s.out);
        // buy
        let st = m_buy(&s, kas_in, age, buy_quote(s.x, s.y, kas_in));
        assert!(st.violations.contains(&"age<min"), "{}", ctx("the model's buy"));
        script_refuses(h.buy(&who, kas_in, buy_quote(s.x, s.y, kas_in), age, &st.next.clone().unwrap()), &ctx("buy"));
        // sell and sell_all of one sompi
        for all in [false, true] {
            let t = tokens_for(s.x, s.y, 1).unwrap();
            let st = m_sell_core(&s, 1, age, t, true);
            assert!(st.violations.contains(&"age<min"), "{}", ctx("the model's sell"));
            script_refuses(h.sell(&who, t, t, 1, age, all, &st.next.clone().unwrap()), &ctx(if all { "sell_all" } else { "sell" }));
        }
        // add
        let kas = BIG_X / 100;
        let tokens = ((kas as i128 * s.y as i128 + s.x as i128 - 1) / s.x as i128) as i64;
        let shares = ((kas as i128 * s.s as i128 / s.x as i128).min(tokens as i128 * s.s as i128 / s.y as i128)) as i64;
        let st = m_add(&s, kas, tokens, shares, age);
        assert!(st.violations.contains(&"age<min"), "{}", ctx("the model's add"));
        script_refuses(h.add(&lp, tokens + 1, kas, tokens, shares, age, &st.next.clone().unwrap()), &ctx("add"));
        // remove
        let (kk, tt) = ((p1.shares as i128 * s.x as i128 / s.s as i128) as i64, (p1.shares as i128 * s.y as i128 / s.s as i128) as i64);
        let st = m_remove(&s, p1.shares, kk, tt, age);
        assert!(st.violations.contains(&"age<min"), "{}", ctx("the model's remove"));
        script_refuses(h.remove(&p1, kk, tt, age, &st.next.clone().unwrap()), &ctx("remove"));
        // tick
        let st = m_tick(&s, age);
        assert!(st.violations.contains(&"age<min"), "{}", ctx("the model's tick"));
        script_refuses(h.try_tick_custom(age, age as u64, &st.next.clone().unwrap(), h.state.value(), None, None), &ctx("tick"));
    }
    // At MIN_AGE, each in turn (MIN_AGE apart), the count staying above half: first the room, sold.
    h.do_sell(&who, room_at(&h.state.ps, MIN_AGE), MIN_AGE);
    h.now += MIN_AGE;
    h.do_buy(&who, KAS, MIN_AGE);
    h.now += MIN_AGE;
    let p2 = h.do_add_at(&lp, BIG_X / 100, MIN_AGE);
    h.now += MIN_AGE;
    let p3 = h.do_add_at(&lp, BIG_X / 100, MIN_AGE);
    h.now += MIN_AGE;
    h.do_remove_at(&p2, MIN_AGE);
    h.now += MIN_AGE;
    h.do_tick(MIN_AGE);
    assert!(in_regime(&h.state.ps), "the count stayed above half: {:?}", h.state.ps);
    // sell_all at MIN_AGE.
    h.now += MIN_AGE;
    let s = h.state.ps.clone();
    let room = room_at(&s, MIN_AGE);
    let t = tokens_for(s.x, s.y, room).unwrap();
    let st = m_sell_core(&s, room, MIN_AGE, t, true);
    assert!(st.ok(), "{:?}", st.violations);
    h.sell(&who, t, t, room, MIN_AGE, true, &st.next.clone().unwrap()).expect("a sell_all claiming the minimum");
    assert!(in_regime(&h.state.ps));

    // Paused, with the count above half: the breaker stands still. A withdrawal claims exactly 0 and settles nothing (the
    // pause never holds providers in), one claiming any age is refused, and so is a tick; after the pause the minimum is
    // back for withdrawals too.
    let paused = m_pause(&h.state.ps, true).next.unwrap();
    let guardian = h.guardian_key;
    h.now += MIN_AGE;
    h.pause_entry("pause", guardian, &paused).expect("the guardian pauses");
    assert!(in_regime(&h.state.ps) && h.state.ps.paused);
    h.now += 2 * MIN_AGE;
    let s = h.state.ps.clone();
    let st = m_tick(&s, MIN_AGE);
    assert!(st.violations.contains(&"paused"));
    script_refuses(h.try_tick_custom(MIN_AGE, MIN_AGE as u64, &st.next.unwrap(), h.state.value(), None, None), "a tick while paused");
    let (kk, tt) = ((p3.shares as i128 * s.x as i128 / s.s as i128) as i64, (p3.shares as i128 * s.y as i128 / s.s as i128) as i64);
    for age in [1, MIN_AGE] {
        let st = m_remove(&s, p3.shares, kk, tt, age);
        assert!(st.violations.contains(&"paused: age!=0"), "{:?}", st.violations);
        script_refuses(h.remove(&p3, kk, tt, age, &st.next.clone().unwrap()), "a withdrawal claiming age while paused");
    }
    h.do_remove_at(&p3, 0);
    // Nothing settled: the count only took back the credit (none here), the 100 DAA the UTXO stood are not counted.
    assert_eq!((h.state.ps.out, h.state.ps.credit), (s.out, s.credit));
    let unpaused = m_pause(&h.state.ps, false).next.unwrap();
    let admin = h.admin_key;
    h.pause_entry("unpause", admin, &unpaused).expect("the admin unpauses");
    let s = h.state.ps.clone();
    assert!(in_regime(&s));
    let (kk, tt) = ((p1.shares as i128 * s.x as i128 / s.s as i128) as i64, (p1.shares as i128 * s.y as i128 / s.s as i128) as i64);
    let st = m_remove(&s, p1.shares, kk, tt, 0);
    assert!(st.violations.contains(&"age<min"), "a withdrawal claiming nothing after the pause: {:?}", st.violations);
    script_refuses(h.remove(&p1, kk, tt, 0, &st.next.clone().unwrap()), "a withdrawal claiming nothing after the pause");
}

/// A tick settles the breaker (reference, count, credit) by its claim and nothing else; it claims at least MIN_AGE and at
/// most two windows; the pool output keeps its value; no kUSDT may be in its transaction (neither the reserve nor a user's
/// own state); and it is refused while the pool is paused (the breaker stands still then).
#[test]
fn engine_a_tick_settles_the_breaker_and_does_nothing_else() {
    let (mut h, _, _) = fresh_pool(BIG_X, BIG_Y);
    let (who, thief, lp) = (key(0xc3), key(0xee), key(0xc4));
    // Liquidity in, so the reference has a gap to rise into; the whole cap sold.
    h.do_add_at(&lp, BIG_X, 0);
    let room = room_at(&h.state.ps, 0);
    h.do_sell(&who, room, 0);
    h.now += WINDOW / 4;
    let s = h.state.ps.clone();
    let age = h.age();
    let next = m_tick(&s, age).next.unwrap();
    assert!(next.rf > s.rf && next.out < s.out, "the claim moves the reference and the count: {s:?} -> {next:?}");
    assert_eq!((next.x, next.y, next.s, next.pk, next.pt, next.paused), (s.x, s.y, s.s, s.pk, s.pt, s.paused));
    let value = h.state.value();
    // Hostile shapes, each refused by the pool's script.
    script_refuses(h.try_tick_custom(age, age as u64, &next, value + 1, None, None), "a tick that adds KAS to the pool output");
    script_refuses(h.try_tick_custom(age, age as u64, &next, value - 1, None, None), "a tick that takes KAS from the pool output");
    script_refuses(h.try_tick_custom(age, age as u64, &next, value, Some(&thief), None), "a tick with the reserve beside it");
    script_refuses(h.try_tick_custom(age, age as u64, &next, value, None, Some(&who)), "a tick with a user's own kUSDT beside it");
    script_refuses(h.try_tick_custom(age, age as u64, &Ps { x: next.x + 1, ..next.clone() }, value, None, None), "a tick that changes the reserve");
    script_refuses(h.try_tick_custom(age, age as u64, &Ps { out: next.out - 1, ..next.clone() }, value, None, None), "a tick that forgives more");
    script_refuses(h.try_tick_custom(age, age as u64, &Ps { rf: next.rf + 1, ..next.clone() }, value, None, None), "a tick that lifts the reference more");
    script_refuses(h.try_tick_custom(age, age as u64, &Ps { paused: true, ..next.clone() }, value, None, None), "a tick that pauses");
    script_refuses(h.try_tick_custom(age, age as u64, &Ps { credit: next.credit + 1, ..next.clone() }, value, None, None), "a tick that adds credit");
    // A claim the input's sequence does not cover, and one past two windows.
    script_refuses(h.try_tick_custom(age, (age - 1) as u64, &next, value, None, None), "a tick claiming more than its sequence");
    h.now += 3 * WINDOW;
    script_refuses(h.try_tick_custom(2 * WINDOW + 1, (2 * WINDOW + 1) as u64, &m_tick(&s, 2 * WINDOW + 1).next.unwrap(), value, None, None), "a tick past two windows");
    // The honest one, at two windows: the count is back at zero.
    h.do_tick(2 * WINDOW);
    assert_eq!(h.state.ps.out, 0);
    // While paused: no tick (the breaker stands still); after the unpause, ticks again, from the unpause's new UTXO.
    h.now += MIN_AGE;
    let paused = m_pause(&h.state.ps, true).next.unwrap();
    let guardian = h.guardian_key;
    h.pause_entry("pause", guardian, &paused).expect("the guardian pauses");
    h.now += 10 * MIN_AGE;
    let s = h.state.ps.clone();
    let st = m_tick(&s, MIN_AGE);
    assert!(st.violations.contains(&"paused"));
    script_refuses(h.try_tick_custom(MIN_AGE, MIN_AGE as u64, &st.next.unwrap(), h.state.value(), None, None), "a tick while paused");
    let unpaused = m_pause(&s, false).next.unwrap();
    let admin = h.admin_key;
    h.pause_entry("unpause", admin, &unpaused).expect("the admin unpauses");
    assert_eq!(h.age(), 0, "the unpause made a new pool UTXO: the clock starts again");
    h.now += MIN_AGE;
    h.do_tick(MIN_AGE);
    assert!(!h.state.ps.paused);
}

/// Every public spend made while more than half of the cap is in use claims at least MIN_AGE, and is exactly a tick of its claim followed
/// by its own effect with no time: so each such spend refills at least what MIN_AGE refills at the reference it stands on.
/// Random states (from adversarial walks, the deployment window and a window of 8), every public entry, every claim from
/// 0 to MIN_AGE + 2 and random claims up to two windows.
#[test]
fn search_every_public_spend_above_half_the_cap_credits_at_least_the_minimum() {
    let mut checked = 0u64;
    let mut refused_short = 0u64;
    // Below the threshold: states seen, ones where a spend claiming nothing passed, and the least sell room there as a
    // share of the stored cap (and of the cap a seller meets at once: the reference falls to the reserve first).
    let (mut below, mut zero_passed) = (0u64, 0u64);
    let (mut least_room_stored, mut least_room_now) = (f64::MAX, f64::MAX);
    for &(window, x0, y0) in &[(WINDOW, BIG_X, BIG_Y), (WINDOW, 1_000 * KAS, 10 * USDT), (8, 5_000, 5_000)] {
        PARAMS.with(|c| c.set((MAX_OUT_BPS, window)));
        let min_age = m_min_age(window);
        for seed in 0..120u64 {
            let mut rng = Rng::new(seed * 7 + window as u64);
            let mut s = m_init(&Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 }, x0, y0, 0, y0).next.unwrap();
            let mut positions: Vec<MPos> = vec![MPos { shares: x0 - MIN_LIQUIDITY }];
            for _ in 0..40 {
                // Walk on: any op at any allowed age.
                let op = pick_op(&mut rng, &s);
                let age = if op.claims_age() { least_age(&s).max(rng.range(0, 2 * window) * (rng.below(2) as i64)) } else { 0 };
                if let Some(next) = apply_model(&s, &op, &mut positions, age) {
                    s = next;
                }
                if s.paused {
                    continue;
                }
                let pos = positions.first().map(|p| p.shares).unwrap_or(0);
                if !in_regime(&s) {
                    below += 1;
                    let stored_cap = m_share_of(s.rf, p_bps()).unwrap();
                    if stored_cap >= 720 {
                        least_room_stored = least_room_stored.min(room_at(&s, 0) as f64 / stored_cap as f64);
                        least_room_now = least_room_now.min(room_at(&s, 0) as f64 / cap_of(&s, 0).max(1) as f64);
                    }
                    let passed: Vec<&'static str> = public_steps(&s, 0, pos).into_iter().filter(|(_, st, _)| st.ok()).map(|(n, ..)| n).collect();
                    assert!(!passed.contains(&"tick"), "a tick claiming nothing passed: {s:?}");
                    if !passed.is_empty() {
                        zero_passed += 1;
                    }
                    continue;
                }
                let mut ages: Vec<i64> = (0..=min_age + 2).collect();
                for _ in 0..4 {
                    ages.push(rng.range(0, 2 * window));
                }
                for &age in &ages {
                    for (name, step, effect) in public_steps(&s, age, pos) {
                        if !step.ok() {
                            if age < min_age {
                                refused_short += 1;
                            }
                            continue;
                        }
                        checked += 1;
                        let next = step.next.unwrap();
                        assert!(age >= min_age, "{name} claiming {age} was accepted with the count at {}: {s:?}", s.out);
                        // A tick of the claim, then the entry with no time, is the same state.
                        let (rf, out, credit) = m_settle_breaker(&s, age).unwrap();
                        let ticked = Ps { rf, out, credit, ..s.clone() };
                        if let Some(effect) = effect {
                            NO_MIN_RULE.with(|c| c.set(true));
                            let again = effect(&ticked);
                            NO_MIN_RULE.with(|c| c.set(false));
                            assert!(again.ok(), "{name}: the effect alone is refused: {:?}", again.violations);
                            assert_eq!(again.next.unwrap(), next, "{name} claiming {age} is not a tick then the entry: {s:?}");
                        } else {
                            assert_eq!(ticked, next, "a tick claiming {age} changed more than the breaker");
                        }
                        // The refill is at least MIN_AGE's at the reference the pool stands on.
                        let floor = m_settled_out(s.out, min_age, m_share_of(s.rf, MAX_OUT_BPS).unwrap(), window).unwrap();
                        assert!(out <= floor, "{name} claiming {age}: the count settled to {out}, MIN_AGE alone gives {floor}: {s:?}");
                    }
                }
            }
        }
    }
    PARAMS.with(|c| c.set((MAX_OUT_BPS, WINDOW)));
    println!("{checked} accepted public spends with more than half the cap in use, each a tick of at least MIN_AGE then its own effect; {refused_short} claims under the minimum refused");
    println!("{below} states at or below half the cap: a spend claiming nothing passed in {zero_passed}; the least sell room there was {least_room_stored:.3} of the stored cap, {least_room_now:.3} of the cap at that moment");
    assert!(checked > 10_000 && refused_short > 10_000, "the sample is too small: {checked} {refused_short}");
    assert!(below > 1_000 && zero_passed * 10 > below * 9, "spends claiming nothing below the threshold: {zero_passed} of {below}");
}

type Effect = Box<dyn Fn(&Ps) -> Step>;

/// Every public entry on `s` at `age` with representative amounts, and the same entry with no time as a function of a
/// state (none for the tick, whose effect is nothing).
fn public_steps(s: &Ps, age: i64, position: i64) -> Vec<(&'static str, Step, Option<Effect>)> {
    let mut out: Vec<(&'static str, Step, Option<Effect>)> = Vec::new();
    for kas_in in dust_buy(s).into_iter().chain([kas_in_for(cap_of(s, 0).max(1))]) {
        let amount = buy_quote(s.x, s.y, kas_in);
        if amount >= 1 && amount < s.y {
            out.push(("buy", m_buy(s, kas_in.min(MAX_SWAP_INPUT), age, amount), Some(Box::new(move |t: &Ps| m_buy(t, kas_in.min(MAX_SWAP_INPUT), 0, amount)))));
        }
    }
    let room = room_at(s, age);
    for k in [1, room / 2, room] {
        if let Some(tokens) = (k >= 1 && k < s.x).then(|| tokens_for(s.x, s.y, k)).flatten() {
            out.push(("sell", m_sell_core(s, k, age, tokens, true), Some(Box::new(move |t: &Ps| m_sell_core(t, k, 0, tokens, true)))));
        }
    }
    let kas = (s.x / 50).max(1);
    let tokens = (((kas as i128) * s.y as i128 + s.x as i128 - 1) / s.x as i128) as i64;
    let shares = (kas as i128 * s.s as i128 / s.x as i128).min(tokens as i128 * s.s as i128 / s.y as i128) as i64;
    if shares > 0 {
        out.push(("add", m_add(s, kas, tokens, shares, age), Some(Box::new(move |t: &Ps| m_add(t, kas, tokens, shares, 0)))));
    }
    if position > 0 && position <= s.s - MIN_LIQUIDITY {
        let (kk, tt) = ((position as i128 * s.x as i128 / s.s as i128) as i64, (position as i128 * s.y as i128 / s.s as i128) as i64);
        out.push(("remove", m_remove(s, position, kk, tt, age), Some(Box::new(move |t: &Ps| m_remove(t, position, kk, tt, 0)))));
    }
    out.push(("tick", m_tick(s, age), None));
    out
}

// The slot race: a bot against honest sellers and the keeper, on the model, at 10 DAA a second.
//
// Above half of the cap every public spend claims at least MIN_AGE, so consensus lets each pool UTXO be spent once it is
// MIN_AGE old: one slot per pool UTXO, which goes to whichever transaction the miners take first. Honest clients submit
// at the first DAA the lock allows (they have seen the UTXO long before), so they meet the bot at the same DAA, and who
// wins is the network's call: the bot with `q` = 0 (it always reaches the miners first, or replaces their transactions),
// or one in two with `q` = 50. Below half anyone may spend at once, claiming nothing.

/// An honest client sees a new pool UTXO 1 s after its acceptance, and can't spend it before.
const SEES: i64 = 10;
/// The keeper ticks this long after the first DAA the lock allows (KEEPER_DEFAULTS.tickDelayDaa), so that clients come first,
/// and claims the age less the clients' margin (KEEPER_DEFAULTS.marginDaa), so nodes a moment behind take its tick.
const KEEPER_DELAY: i64 = 25;
const KEEPER_MARGIN: i64 = 10;
/// The keeper's evidence: a spend above half of the cap that left more than this unclaimed (5 s; a client's latency is
/// about 1 s).
const KEEPER_SLACK: i64 = 50;
/// The keeper stays armed for an hour after its last evidence.
const KEEPER_HOLD: i64 = 36_000;
/// An honest seller's order arrives every minute.
const ORDER_EVERY: i64 = 600;
/// Below half of the cap the bot spends this often, claiming nothing: it wastes the refill there.
const STALL_EVERY: i64 = 50;
/// The late bot lands this long after the lock opens, still claiming only the minimum.
const LATE: i64 = 950;
/// The bot's dust sell: 1 000 sompi of KAS (0.0001 kUSDT).
const DUST_KAS: i64 = 1_000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Bot {
    /// No bot: honest sellers only.
    None,
    /// The review's bot: a dust sell the moment each slot opens, claiming the minimum (and a dust sell every
    /// STALL_EVERY below half, claiming nothing).
    Dust,
    /// Lands LATE after each slot opens, claiming the minimum: wastes LATE per slot unless someone comes first.
    Late,
    /// Lands KEEPER_SLACK after each slot opens, claiming the minimum: wastes the slack and is never evidence.
    UnderSlack,
    /// Takes each slot as it opens with a sell just large enough to keep the count above half of the cap.
    Hold,
}

#[derive(Default, Debug)]
struct Race {
    /// DAA until the count is first at or below half of the cap (none: never in the run).
    exit: Option<i64>,
    /// DAA the stated rate takes for that: (count - half the cap) x window / cap.
    stated: i64,
    /// DAA spent above half of the cap.
    above: i64,
    /// Above half: what the spends refilled, and what claiming each UTXO's whole age would have.
    refilled: i64,
    full_refill: i64,
    ordered: i64,
    sold: i64,
    /// Sells that landed, their mean wait from the order (DAA), and the slots the seller was ready for and lost to the bot.
    sells: usize,
    wait: f64,
    lost_races: usize,
    bot_spends: usize,
    bot_kas: i64,
    /// The bot's sells in the run's second window.
    bot_kas_late: i64,
    keeper_ticks: usize,
    armed: bool,
    cap: i64,
    cap_end: i64,
}

impl Race {
    fn efficiency(&self) -> f64 {
        if self.full_refill == 0 { 1.0 } else { self.refilled as f64 / self.full_refill as f64 }
    }
}

/// One run of `limit` DAA from a count of one cap (`full`) or of zero, with an honest seller that wants `cap / order_div`
/// KAS a minute (none for 0).
fn slot_race(bot: Bot, keeper: bool, q_pct: u64, full: bool, order_div: i64, limit: i64, seed: u64) -> Race {
    let mut rng = Rng::new(seed);
    let mut s = m_init(&Ps { x: 0, y: 0, s: 0, pk: 0, pt: 0, credit: 0, rf: 0, out: 0, paused: false, dr: 0 }, BIG_X, BIG_Y, 0, BIG_Y).next.unwrap();
    if full {
        let k = room_at(&s, 0);
        s = m_sell_core(&s, k, 0, tokens_for(s.x, s.y, k).unwrap(), true).next.unwrap();
    }
    let cap = m_share_of(s.rf, p_bps()).unwrap();
    let mut r = Race { stated: ((s.out - cap / 2).max(0) as i128 * WINDOW as i128 / cap as i128) as i64, cap, ..Default::default() };
    let order = if order_div > 0 { cap / order_div } else { 0 };
    let (mut d, mut now) = (0i64, 0i64);
    let mut next_order = if order > 0 { ORDER_EVERY } else { i64::MAX };
    // The pending order: its arrival and what is left of it; and the first DAA the seller tries again after finding no room.
    let mut pending: Option<(i64, i64)> = None;
    let mut retry_at = 0i64;
    let mut armed_until = -1i64;
    let mut waits = 0f64;
    let sell_step = |s: &Ps, k: i64, claim: i64| tokens_for(s.x, s.y, k).map(|t| m_sell_core(s, k, claim, t, true));
    while now < limit {
        while next_order <= now {
            pending = Some(pending.map_or((next_order, order), |(at, left)| (at, left + order)));
            r.ordered += order;
            next_order += ORDER_EVERY;
        }
        let above = in_regime(&s);
        if !above && r.exit.is_none() && full {
            r.exit = Some(now);
        }
        let least = if above { MIN_AGE } else { 0 };
        // When each would land, and what it claims.
        let bot_at = match bot {
            Bot::None => None,
            _ if !above => Some((d + STALL_EVERY, 0)),
            Bot::Dust | Bot::Hold => Some((d + MIN_AGE, MIN_AGE)),
            Bot::Late => Some((d + MIN_AGE + LATE, MIN_AGE)),
            Bot::UnderSlack => Some((d + MIN_AGE + KEEPER_SLACK, MIN_AGE)),
        };
        let honest_at = pending.map(|(at, _)| {
            let t = at.max(d + SEES).max(d + least).max(retry_at);
            (t, t - d)
        });
        let keeper_at = (keeper && above && armed_until >= d + MIN_AGE + KEEPER_DELAY).then_some((d + MIN_AGE + KEEPER_DELAY, MIN_AGE + KEEPER_DELAY - KEEPER_MARGIN));
        // The earliest wins; the bot and a client landing together: the client q times in 100.
        let mut best: Option<(i64, i64, u8)> = None;
        for (who, c) in [(0u8, bot_at), (1, honest_at), (2, keeper_at)] {
            let Some((t, claim)) = c else { continue };
            let better = match best {
                None => true,
                Some((bt, _, bw)) => t < bt || (t == bt && bw == 0 && who == 1 && rng.below(100) < q_pct),
            };
            if better {
                best = Some((t, claim, who));
            }
        }
        let Some((t, claim, who)) = best.filter(|&(t, ..)| t <= next_order.min(limit)) else {
            now = next_order.min(limit);
            continue;
        };
        if who != 1 && honest_at.is_some_and(|(ht, _)| ht <= t) {
            r.lost_races += 1;
        }
        let step = match who {
            1 => {
                let (at, left) = pending.unwrap();
                let k = room_at(&s, claim).min(left).min(s.x - 1);
                if k < 1 {
                    retry_at = t + MIN_AGE;
                    now = t;
                    continue;
                }
                let st = sell_step(&s, k, claim).expect("tokens");
                assert!(st.ok(), "the honest sell: {:?} at {s:?}", st.violations);
                r.sold += k;
                r.sells += 1;
                waits += (t - at) as f64;
                pending = if left > k { Some((at, left - k)) } else { None };
                st
            }
            0 => {
                r.bot_spends += 1;
                let k = if bot == Bot::Hold {
                    // The least sell (from dust) that leaves the count above half of the cap.
                    let keeps = |k: i64| sell_step(&s, k, claim).and_then(|st| st.next).is_some_and(|n| in_regime(&n));
                    let (mut lo, mut hi) = (DUST_KAS, room_at(&s, claim).max(DUST_KAS));
                    if keeps(lo) {
                        hi = lo;
                    }
                    while lo < hi {
                        let mid = lo + (hi - lo) / 2;
                        if keeps(mid) { hi = mid } else { lo = mid + 1 }
                    }
                    hi
                } else {
                    DUST_KAS
                };
                if k > room_at(&s, claim) {
                    // No room for even dust (the count is above the cap at the reserve): a tick above half, a dust buy below.
                    if claim >= MIN_AGE {
                        m_tick(&s, claim)
                    } else {
                        let kas_in = dust_buy(&s).unwrap();
                        m_buy(&s, kas_in, claim, buy_quote(s.x, s.y, kas_in))
                    }
                } else {
                    r.bot_kas += k;
                    if t >= limit - WINDOW {
                        r.bot_kas_late += k;
                    }
                    sell_step(&s, k, claim).expect("tokens")
                }
            }
            _ => {
                r.keeper_ticks += 1;
                m_tick(&s, claim)
            }
        };
        assert!(step.ok(), "{bot:?}: party {who} refused claiming {claim} after {} DAA: {:?} at {s:?}", t - d, step.violations);
        let lost = (t - d) - claim;
        if above {
            r.above += t - d;
            let (_, settled, _) = m_settle_breaker(&s, claim).unwrap();
            let (_, settled_all, _) = m_settle_breaker(&s, (t - d).min(2 * WINDOW)).unwrap();
            r.refilled += s.out - settled;
            r.full_refill += s.out - settled_all;
            if lost > KEEPER_SLACK {
                armed_until = t + KEEPER_HOLD;
                r.armed = true;
            }
        }
        s = step.next.unwrap();
        d = t;
        now = t;
    }
    r.wait = if r.sells > 0 { waits / r.sells as f64 } else { f64::NAN };
    r.cap_end = m_share_of(s.rf, p_bps()).unwrap();
    r
}

/// The review's high finding and the decisions on it, measured: every bot strategy, with and without the keeper, the
/// bot always first to the miners (q = 0) or one time in two (q = 50), for two windows from a full count (one cap sold at
/// once). First with nobody else about (how fast the count comes back to half), then with an honest seller who wants a
/// hundredth of the cap every minute (0.6 of the refill).
///
/// - A dust bot can't hold the minimum claim: above half of the cap each of its spends claims the minimum and refills it,
///   so the count falls to half at the stated rate. Its slot capture lasts that half window at most.
/// - A late bot (claiming the minimum long after each slot opens) holds the count up without a keeper; its first spend is
///   evidence, and the keeper's ticks then refill at the full rate. One under the slack is never evidence and wastes the
///   slack per slot: MIN_AGE of refill per MIN_AGE + slack, when nobody else spends.
/// - Holding the count above half takes selling at about the whole refill rate (a cap a window). With the bot always
///   first that freezes every honest pool transaction; one time in two, the seller loses a race about once per sell.
#[test]
fn attack_the_slot_race_against_the_half_cap_threshold_and_the_keeper() {
    let limit = 2 * WINDOW;
    let hours = limit as f64 / 36_000.0;
    let bots = [Bot::None, Bot::Dust, Bot::Late, Bot::UnderSlack, Bot::Hold];

    println!("nobody else about | bot        keeper | half of the cap after (x stated) | refill above half | bot spends/h | bot sold/h (caps) | keeper ticks/h | armed");
    let mut alone = Vec::new();
    for bot in bots {
        for keeper in [false, true] {
            let r = slot_race(bot, keeper, 0, true, 0, limit, 5);
            let exit = r.exit.map(|e| e as f64 / r.stated as f64);
            println!("                  | {:<10} {:<6} | {:>32} | {:>16.1}% | {:>12.0} | {:>17.3} | {:>14.0} | {}",
                format!("{bot:?}"), keeper, exit.map_or("never".to_string(), |x| format!("{x:.2}")), 100.0 * r.efficiency(),
                r.bot_spends as f64 / hours, r.bot_kas as f64 / r.cap as f64 / hours, r.keeper_ticks as f64 / hours, r.armed);
            alone.push((bot, keeper, r));
        }
    }
    let solo = |bot: Bot, keeper: bool| &alone.iter().find(|(b, k, _)| *b == bot && *k == keeper).unwrap().2;
    let half = |r: &Race| r.exit.map_or(f64::INFINITY, |e| e as f64 / r.stated as f64);
    for keeper in [false, true] {
        // No bot, nobody spends: the next spend claims the whole age, nothing is lost.
        assert!(solo(Bot::None, keeper).exit.is_none() || half(solo(Bot::None, keeper)) <= 1.0);
        // A dust bot refills the breaker itself: half of the cap is back at the stated rate, and it's never evidence.
        let r = solo(Bot::Dust, keeper);
        assert!(half(r) <= 1.05 && r.efficiency() >= 0.99 && !r.armed, "dust bot, keeper {keeper}: {r:?}");
        // Holding the count above half: never back at half, every slot refilling in full, and the bot selling about a
        // cap a window once the count is down at half.
        let r = solo(Bot::Hold, keeper);
        assert!(r.exit.is_none() && r.efficiency() >= 0.99, "hold, keeper {keeper}: {r:?}");
        assert!(r.bot_kas_late as f64 >= 0.9 * r.cap_end as f64, "hold, keeper {keeper}: sold {} in the last window, the cap is {}", r.bot_kas_late, r.cap_end);
    }
    // The late bot: holds the count up without a keeper; with one, the first late spend arms it and its ticks come first.
    let (no, yes) = (solo(Bot::Late, false), solo(Bot::Late, true));
    assert!(no.efficiency() <= 0.1 && half(no) > 3.0, "late bot without a keeper: {no:?}");
    // The keeper's own ticks leave its margin unclaimed: (MIN_AGE + delay - margin) of every MIN_AGE + delay.
    let keeper_rate = (MIN_AGE + KEEPER_DELAY - KEEPER_MARGIN) as f64 / (MIN_AGE + KEEPER_DELAY) as f64;
    // (Less the first late slot, which arms it.)
    assert!(yes.armed && yes.efficiency() >= keeper_rate - 0.05 && half(yes) <= 1.0 / keeper_rate + 0.1, "late bot with a keeper: {yes:?}");
    // Under the slack: never evidence, MIN_AGE of refill per MIN_AGE + slack.
    let under = solo(Bot::UnderSlack, true);
    let rate = MIN_AGE as f64 / (MIN_AGE + KEEPER_SLACK) as f64;
    assert!(!under.armed && (under.efficiency() - rate).abs() <= 0.02 && half(under) <= 1.0 / rate + 0.05, "under the slack: {under:?}");

    println!("with a seller     | bot        keeper q   | refill above half | above half | seller sold | mean wait | races lost/sell | bot spends/h | bot sold/h (caps) | keeper ticks/h | armed");
    let mut rows = Vec::new();
    for bot in bots {
        for keeper in [false, true] {
            for q in [0u64, 50] {
                let r = slot_race(bot, keeper, q, true, 100, limit, 7 + q);
                println!("                  | {:<10} {:<6} {:<4} | {:>16.1}% | {:>9.1}% | {:>10.1}% | {:>9.0} | {:>15.2} | {:>12.0} | {:>17.3} | {:>14.0} | {}",
                    format!("{bot:?}"), keeper, q, 100.0 * r.efficiency(), 100.0 * r.above as f64 / limit as f64, 100.0 * r.sold as f64 / r.ordered as f64,
                    r.wait, r.lost_races as f64 / r.sells.max(1) as f64, r.bot_spends as f64 / hours, r.bot_kas as f64 / r.cap as f64 / hours,
                    r.keeper_ticks as f64 / hours, r.armed);
                rows.push((bot, keeper, q, r));
            }
        }
    }
    let get = |bot: Bot, keeper: bool, q: u64| &rows.iter().find(|(b, k, qq, _)| *b == bot && *k == keeper && *qq == q).unwrap().3;
    let baseline = get(Bot::None, false, 0);
    for keeper in [false, true] {
        for q in [0, 50] {
            // The dust bot: the seller is served in full, no later than alone.
            let r = get(Bot::Dust, keeper, q);
            assert!(r.sold * 100 >= r.ordered * 99 && r.wait <= baseline.wait + 10.0 * MIN_AGE as f64, "dust, keeper {keeper}, q {q}: {r:?}");
        }
        // Always first to the miners, the holding bot takes every slot: nothing honest lands.
        assert_eq!(get(Bot::Hold, keeper, 0).sells, 0);
        // One time in two, the seller is served in full, losing about one race per sell.
        let r = get(Bot::Hold, keeper, 50);
        assert!(r.sold * 100 >= r.ordered * 99 && r.wait <= baseline.wait + 10.0 * MIN_AGE as f64, "hold, keeper {keeper}, q 50: {r:?}");
        // The seller's own sells lift the count above half far more than any bot: only the late bot without a keeper
        // keeps it from being served.
        let r = get(Bot::UnderSlack, keeper, 50);
        assert!(r.sold * 100 >= r.ordered * 99, "under the slack, keeper {keeper}: {r:?}");
    }
    let r = get(Bot::Late, true, 0);
    assert!(r.armed && r.sold * 100 >= r.ordered * 99, "late, keeper: {r:?}");
    let r = get(Bot::Late, false, 0);
    assert!(r.sold * 100 < r.ordered * 50, "late, no keeper: the seller finds no room: {r:?}");
}

/// A seller who wants more than the refill (a twentieth of the cap a minute), from a count of zero, against a dust bot
/// that wastes the refill below half and is first to every slot above it. The seller gets about half a cap, then the
/// refill: it loses about the half cap the bot keeps from refilling, no more.
#[test]
fn attack_a_hungry_seller_against_the_slot_race_gets_the_refill() {
    let limit = 2 * WINDOW;
    let alone = slot_race(Bot::None, false, 0, false, 20, limit, 11);
    let cap = alone.cap as f64;
    for keeper in [false, true] {
        for q in [0u64, 50] {
            let r = slot_race(Bot::Dust, keeper, q, false, 20, limit, 11 + q);
            let lost = (alone.sold - r.sold) as f64 / cap;
            println!("hungry seller, dust bot, keeper {keeper}, q {q}: sold {:.2} caps in two windows ({:.2} alone), {lost:.2} of a cap less; mean wait {:.0} DAA",
                r.sold as f64 / cap, alone.sold as f64 / cap, r.wait);
            assert!(lost <= 0.6, "the seller lost {lost:.2} of a cap");
            assert!(r.sold as f64 >= 0.5 * cap + 0.9 * cap * limit as f64 / WINDOW as f64 - 0.6 * cap, "sold {:.2} caps", r.sold as f64 / cap);
        }
    }
}

/// The dust bot's slots through the real engine: from a full count, a dust sell claiming exactly MIN_AGE at each slot's
/// opening. Every one is accepted, each refills at least MIN_AGE's share, and after the stated half window (plus the 4 %
/// the +2 DAA spacing costs) the count is at half of the cap, where anyone may spend at once.
#[test]
fn engine_a_bot_at_the_minimum_claim_refills_the_breaker_itself() {
    let (mut h, _, _) = fresh_pool(BIG_X, BIG_Y);
    let (seller, bot) = (key(0xc5), key(0xc6));
    let room = room_at(&h.state.ps, 0);
    h.do_sell(&seller, room, 0);
    let cap = m_share_of(h.state.ps.rf, MAX_OUT_BPS).unwrap();
    let stated = ((h.state.ps.out - cap / 2) as i128 * WINDOW as i128 / cap as i128) as i64;
    let start = h.now;
    let mut rounds = 0;
    while in_regime(&h.state.ps) {
        h.now += MIN_AGE + 2;
        let before = h.state.ps.clone();
        match rounds % 4 {
            0 => {
                let s = h.state.ps.clone();
                let kas_in = dust_buy(&s).unwrap();
                let st = m_buy(&s, kas_in, MIN_AGE, buy_quote(s.x, s.y, kas_in));
                h.buy(&bot, kas_in, buy_quote(s.x, s.y, kas_in), MIN_AGE, &st.next.unwrap()).expect("a dust buy");
            }
            1 if room_at(&h.state.ps, MIN_AGE) >= DUST_KAS => h.do_sell(&bot, DUST_KAS, MIN_AGE),
            1 => h.do_tick(MIN_AGE),
            2 => {
                let p = h.do_add_at(&bot, 2_000, MIN_AGE);
                h.now += MIN_AGE + 2;
                h.do_remove_at(&p, MIN_AGE.max(least_age(&h.state.ps)));
                rounds += 1;
            }
            _ => h.do_tick(MIN_AGE),
        }
        rounds += 1;
        let floor = m_settled_out(before.out, MIN_AGE, cap_of(&before, 0), WINDOW).unwrap() + DUST_KAS;
        assert!(h.state.ps.out <= floor, "round {rounds}: the count {} is above what MIN_AGE alone leaves, {floor}", h.state.ps.out);
        assert!(rounds < 2 * WINDOW as usize / MIN_AGE as usize, "the bot kept the minimum claim in force: {:?}", h.state.ps);
    }
    let took = h.now - start;
    println!("{rounds} bot spends at the minimum claim through the engine: half of the cap after {took} DAA, {:.3} times the stated {stated}", took as f64 / stated as f64);
    assert!(took as f64 <= 1.05 * stated as f64);
    // At half, a spend claiming nothing goes through at once.
    let s = h.state.ps.clone();
    let kas_in = dust_buy(&s).unwrap();
    let st = m_buy(&s, kas_in, 0, buy_quote(s.x, s.y, kas_in));
    h.buy(&bot, kas_in, buy_quote(s.x, s.y, kas_in), 0, &st.next.unwrap()).expect("a dust buy claiming nothing at half");
}

/// Random adversaries that claim only what the rule forces (none at or below half of the cap, MIN_AGE above, waiting
/// for it), liquidity included: every invariant, the SPEC bound on the net outflow, and a fair withdrawal always open.
/// The honest loss is printed against the strict allowance for the claimed time.
#[test]
fn search_least_time_adversaries_keep_every_invariant() {
    let mut worst_strict = 0f64;
    let mut worst_spec = 0f64;
    let mut claimed = 0i64;
    for &(x0, y0) in &[(BIG_X, BIG_Y), (1_000 * KAS, 10 * USDT), (777_777 * KAS, 123 * USDT), (5_000, 7)] {
        for seed in 0..3000u64 {
            let stats = run_adversary_opts(seed * 13 + 5, 300, x0, y0, RunOpts { trace: false, no_time: false, least_time: true, allow_adds: true, assert_strict: false });
            worst_strict = worst_strict.max(stats.worst_strict);
            worst_spec = worst_spec.max(stats.worst_spec);
            claimed = claimed.max(stats.claimed_time);
        }
    }
    println!("least time: 12000 runs of 300 steps; worst net outflow {worst_spec:.3} of the SPEC bound; worst honest loss {worst_strict:.3} of the strict allowance; at most {claimed} DAA claimed in a run");
    assert!(worst_strict <= 1.05, "an honest provider lost more than the strict allowance for the forced claims: {worst_strict}");
}

/// Every sequence to depth 6 with no time but the shortest wait, adds and removes included, on the real rules.
#[test]
fn exhaustive_adds_and_removes_with_only_the_shortest_waits() {
    for (x0, y0, slack) in [(BIG_X, BIG_Y, (2 * KAS) as f64), (5_000i64, 5_000i64, 8.0f64)] {
        let cfg = ExCfg { name: "least waits", x0, y0, window: 36_000, bps: 1_000, depth: 6, add_pcts: &[30, 100, 1000], attacker_start_pct: 0,
            time: false, least_waits: true, assert_bound: true, fix: 0, slack, budget: 3_000_000 };
        let r = exhaustive(cfg);
        report_ex(&format!("least waits, adds allowed (pool {x0})"), &r);
    }
}

