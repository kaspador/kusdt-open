//! Audit 3: differential tests of the arithmetic the money paths depend on, run
//! through the real script engine.
//!
//! The functions under test are the ones in contracts/pool.ag and
//! contracts/bridge_mint.ag themselves: their source text is copied out of the
//! contract files at test time, compiled with the real compiler into a one-actor
//! probe contract, and each is compared with a straightforward i128 reference
//! model at edge values (0, 1, -1, the 8-byte script-number limits and the values
//! either side of the 2^31 limb boundary).
//!
//! `check_*` tests pass when the engine and the reference agree.

#![allow(dead_code)]

mod common;

use std::sync::OnceLock;

use argent::artifact::Artifact;
use argent_runtime::{EntryCall, TxBuilder, TxContext, args, state};
use common::{State, funding, funding_sig, outpoint};
use kaspa_consensus_core::{Hash, tx::CovenantBinding};

const LIMB: i64 = 1 << 31;
const MAX_OPERAND: i64 = (1 << 61) - 1;
const I64_MAX: i64 = i64::MAX;
// i64::MIN is not a representable script number (9 bytes): the largest negative is -(2^63 - 1).
const I64_MIN_REP: i64 = -i64::MAX;

/// Text of `fn name(...) ... { ... }` copied from a contract source.
fn extract_fn(source: &str, name: &str) -> String {
    let needle = format!("fn {name}(");
    let start = source.find(&needle).unwrap_or_else(|| panic!("no fn {name} in the contract"));
    let bytes = source.as_bytes();
    let mut depth = 0i32;
    let mut i = source[start..].find('{').expect("fn body") + start;
    loop {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return source[start..=i].to_string();
                }
            }
            _ => {}
        }
        i += 1;
    }
}

fn contract_text(file: &str) -> String {
    std::fs::read_to_string(kusdt_kaspa::crate_root().join("contracts").join(file)).expect("contract source")
}

fn probe_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| {
        let pool = contract_text("pool.ag");
        let minter = contract_text("bridge_mint.ag");
        let source = format!(
            r#"
const int BPS = 10000;
const int FEE_BPS = 30;
const int PROTOCOL_BPS = 5;
const int MIN_LIQUIDITY = 1000;
const int LIMB = 2147483648;
const int MAX_OPERAND = 2305843009213693951;

state ProbeState {{
    int nonce;
}}

{mul_ge}

{advanced_ref}

{share_of}

{settled_out}

{credit_left}

{refilled}

actor Probe owns ProbeState {{
    entry p_mul_ge(int a, int b, int c, int d, int want) emits {{ next: Probe }} {{
        bool got = mul_ge(a, b, c, d);
        int g = 0;
        if (got) {{
            g = 1;
        }}
        require(g == want);
        unrestricted(next.value);
        become next <- self;
    }}
    entry p_advanced_ref(int reference, int reserve, int elapsed, int window, int want) emits {{ next: Probe }} {{
        require(advanced_ref(reference, reserve, elapsed, window) == want);
        unrestricted(next.value);
        become next <- self;
    }}
    entry p_share_of(int base, int bps, int want) emits {{ next: Probe }} {{
        require(share_of(base, bps) == want);
        unrestricted(next.value);
        become next <- self;
    }}
    entry p_settled_out(int used, int elapsed, int cap, int window, int want) emits {{ next: Probe }} {{
        require(settled_out(used, elapsed, cap, window) == want);
        unrestricted(next.value);
        become next <- self;
    }}
    entry p_credit_left(int credit, int stored, int settled, int want) emits {{ next: Probe }} {{
        require(credit_left(credit, stored, settled) == want);
        unrestricted(next.value);
        become next <- self;
    }}
    entry p_refilled(int bucket, int age_daa, int capacity, int refill, int want) emits {{ next: Probe }} {{
        require(refilled(bucket, age_daa, capacity, refill) == want);
        unrestricted(next.value);
        become next <- self;
    }}
    entry p_divmod(int a, int b, int q, int r) emits {{ next: Probe }} {{
        require(a / b == q);
        require(a % b == r);
        unrestricted(next.value);
        become next <- self;
    }}
    entry p_add(int a, int b, int want) emits {{ next: Probe }} {{
        require(a + b == want);
        unrestricted(next.value);
        become next <- self;
    }}
    entry p_sub(int a, int b, int want) emits {{ next: Probe }} {{
        require(a - b == want);
        unrestricted(next.value);
        become next <- self;
    }}
    entry p_mul(int a, int b, int want) emits {{ next: Probe }} {{
        require(a * b == want);
        unrestricted(next.value);
        become next <- self;
    }}
    entry p_cast8(int x, byte[8] want) emits {{ next: Probe }} {{
        require((x as byte[8]) == want);
        unrestricted(next.value);
        become next <- self;
    }}
    entry p_byte8_to_int(byte[8] raw, int want) emits {{ next: Probe }} {{
        require(int(raw) == want);
        unrestricted(next.value);
        become next <- self;
    }}
    entry p_order(int a, int b, int lt, int le, int gt, int ge, int eq, int ne) emits {{ next: Probe }} {{
        int v = 0;
        if (a < b) {{ v = v + 1; }}
        if (a <= b) {{ v = v + 2; }}
        if (a > b) {{ v = v + 4; }}
        if (a >= b) {{ v = v + 8; }}
        if (a == b) {{ v = v + 16; }}
        if (a != b) {{ v = v + 32; }}
        require(v == lt + le * 2 + gt * 4 + ge * 8 + eq * 16 + ne * 32);
        unrestricted(next.value);
        become next <- self;
    }}
    // `if` without `else` assigning an outer variable, nested, both ways.
    entry p_if(int x, int want) emits {{ next: Probe }} {{
        int v = 1;
        if (x > 0) {{
            v = 2;
            if (x > 10) {{
                v = 3;
            }}
        }} else if (x < 0) {{
            v = 4;
        }}
        require(v == want);
        unrestricted(next.value);
        become next <- self;
    }}
}}

app ProbeApp {{
    actor Probe;
}}
"#,
            mul_ge = extract_fn(&pool, "mul_ge"),
            advanced_ref = extract_fn(&pool, "advanced_ref"),
            share_of = extract_fn(&pool, "share_of"),
            settled_out = extract_fn(&pool, "settled_out"),
            credit_left = extract_fn(&pool, "credit_left"),
            refilled = extract_fn(&minter, "refilled"),
        );
        argent::compile_inline("audit3_probe.ag", source).expect("the probe compiles")
    })
}

fn pbuilder() -> TxBuilder<'static> {
    TxBuilder::new(probe_artifact()).expect("builder")
}

const COVENANT: [u8; 32] = [0x77; 32];

fn probe_state() -> State {
    state! { nonce: 0i64 }
}

/// Runs entry `name` with the given arguments and returns whether the engine accepted.
fn run_probe(builder: &TxBuilder<'static>, name: &str, argv: Vec<argent_runtime::ArgValue>) -> Result<(), String> {
    let covenant = Hash::from_bytes(COVENANT);
    let utxo = builder.covenant_utxo("Probe", probe_state(), 1_000_000, 0, false, Some(covenant)).map_err(|e| e.to_string())?;
    let ctx = TxContext::new()
        .actor_input("Probe", probe_state(), EntryCall::new(name.to_string()).args(argv), outpoint(0x50, 0), utxo.clone(), 0)
        .input(outpoint(0x51, 0), funding(), funding_sig(), 0)
        .actor_output("Probe", probe_state(), CovenantBinding::new(0, covenant), 1_000_000);
    builder.build(&ctx).map(|_| ()).map_err(|e| e.to_string())
}

fn expect_ok(builder: &TxBuilder<'static>, name: &str, argv: Vec<argent_runtime::ArgValue>, ctx: String) {
    if let Err(e) = run_probe(builder, name, argv) {
        panic!("{name} rejected for {ctx}: {e}");
    }
}

fn expect_err(builder: &TxBuilder<'static>, name: &str, argv: Vec<argent_runtime::ArgValue>, ctx: String) {
    if run_probe(builder, name, argv).is_ok() {
        panic!("{name} accepted for {ctx}");
    }
}

/// A small deterministic generator (xorshift64*).
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1)
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
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len() as u64) as usize]
    }
}

/// Values either side of the limb boundary and the operand limit.
fn limb_edges() -> Vec<i64> {
    vec![
        0,
        1,
        2,
        LIMB - 1,
        LIMB,
        LIMB + 1,
        2 * LIMB - 1,
        2 * LIMB,
        (LIMB - 1) * (LIMB - 1),
        LIMB * (LIMB - 1),
        (1 << 60) - 1,
        1 << 60,
        MAX_OPERAND - 1,
        MAX_OPERAND,
    ]
}

/// Reference: a·b ≥ c·d, or None for operands the contract must refuse.
fn ref_mul_ge(a: i64, b: i64, c: i64, d: i64) -> Option<bool> {
    let (a2, b2, c2, d2) = (a as i128, b as i128, c as i128, d as i128);
    let max = MAX_OPERAND as i128;
    if a2 < 0 || b2 < 0 || c2 < 0 || d2 < 0 || a2 > max || b2 > max || c2 > max || d2 > max {
        return None;
    }
    Some(a2 * b2 >= c2 * d2)
}

#[test]
fn check_mul_ge_matches_128_bit_arithmetic_across_limb_boundaries() {
    let b = pbuilder();
    let edges = limb_edges();
    let mut rng = Rng::new(1);
    let mut cases = 0usize;
    // Every edge against every edge on the (a, b) side with a fixed comparison side, and random
    // four-tuples of edges with small perturbations.
    for &a in &edges {
        for &bb in &edges {
            let c = *rng.pick(&edges);
            let d = *rng.pick(&edges);
            let want = ref_mul_ge(a, bb, c, d);
            match want {
                Some(w) => expect_ok(&b, "p_mul_ge", args!(a, bb, c, d, w as i64), format!("{a}*{bb} >= {c}*{d}")),
                None => expect_err(&b, "p_mul_ge", args!(a, bb, c, d, 0i64), format!("{a}*{bb} >= {c}*{d}")),
            }
            cases += 1;
        }
    }
    for _ in 0..1200 {
        let edge_pick = |rng: &mut Rng, delta: bool| -> i64 {
            let v = edges[rng.below(14) as usize];
            if !delta { return v; }
            let d = rng.below(5) as i64 - 2;
            (v.saturating_add(d)).clamp(0, MAX_OPERAND)
        };
        let a = edge_pick(&mut rng, true);
        let bb = edge_pick(&mut rng, true);
        // Often make the two products nearly equal: the comparison boundary is the interesting case.
        let (c, d) = match rng.below(3) {
            0 => (a, bb),
            1 => (bb, a),
            _ => {
                let c = edge_pick(&mut rng, true);
                let d = edge_pick(&mut rng, true);
                (c, d)
            }
        };
        let want = ref_mul_ge(a, bb, c, d).expect("in range");
        expect_ok(&b, "p_mul_ge", args!(a, bb, c, d, want as i64), format!("{a}*{bb} >= {c}*{d}"));
        cases += 1;
    }
    println!("mul_ge: {cases} cases agreed");
    // Out-of-range operands are refused rather than wrapped.
    for bad in [-1i64, MAX_OPERAND + 1, I64_MAX] {
        expect_err(&b, "p_mul_ge", args!(bad, 1i64, 1i64, 1i64, 0i64), format!("a={bad}"));
        expect_err(&b, "p_mul_ge", args!(1i64, 1i64, bad, 1i64, 0i64), format!("c={bad}"));
    }
}

fn ref_advanced(reference: i64, reserve: i64, elapsed: i64, length: i64) -> i128 {
    if reserve <= reference {
        return reserve as i128;
    }
    let gap = ((reserve - reference) as i128).min(reference as i128);
    if elapsed < length { reference as i128 + gap * elapsed as i128 / length as i128 } else { reference as i128 + gap }
}

#[test]
fn check_advanced_ref_matches_the_formula_up_to_the_operand_limit() {
    let b = pbuilder();
    let values = [0i64, 1, 10, 100, 9_999, 10_000, 35_999, 36_000, 123_456_789, LIMB, LIMB + 1, MAX_OPERAND / 2, MAX_OPERAND - 1, MAX_OPERAND];
    let elapsed = [0i64, 1, 2, 17_999, 18_000, 35_999, 36_000, 71_999, 72_000];
    let mut cases = 0;
    for &r in &values {
        for &x in &values {
            for &e in &elapsed {
                let want = ref_advanced(r, x, e, 36_000);
                expect_ok(&b, "p_advanced_ref", args!(r, x, e, 36_000i64, want as i64), format!("ref={r} reserve={x} elapsed={e}"));
                cases += 1;
            }
        }
    }
    println!("advanced_ref: {cases} cases agreed");
}

fn ref_share_of(base: i64, bps: i64) -> i64 {
    (base as i128 * bps as i128 / 10_000) as i64
}

#[test]
fn check_share_of_rounds_down_exactly_up_to_the_operand_limit() {
    let b = pbuilder();
    let bases = [0i64, 1, 9, 10, 99, 100, 9_999, 10_000, 10_001, 12_345_678_901, LIMB, MAX_OPERAND - 1, MAX_OPERAND];
    let bps = [0i64, 1, 500, 999, 1_000, 1_001, 5_000, 9_999, 10_000];
    for &base in &bases {
        for &p in &bps {
            let want = ref_share_of(base, p);
            expect_ok(&b, "p_share_of", args!(base, p, want), format!("base={base} bps={p}"));
        }
    }
    println!("share_of agreed on {} cases", bases.len() * bps.len());
}

fn ref_settled(used: i64, elapsed: i64, cap: i64, length: i64) -> i64 {
    let mut next = used.max(-cap);
    let decay = (elapsed as i128 * cap as i128 / length as i128) as i64;
    if next > 0 {
        next = (next - decay).max(0);
    } else if next < 0 {
        next = (next + decay).min(0);
    }
    next
}

#[test]
fn check_settled_out_moves_toward_zero_without_crossing() {
    let b = pbuilder();
    let caps = [0i64, 1, 3, 35_999, 36_000, 36_001, 1_000 * 100_000_000, MAX_OPERAND / 10, MAX_OPERAND];
    let mut cases = 0;
    for &cap in &caps {
        for &used in &[0i64, 1, -1, cap, -cap, cap - 1, cap.saturating_add(1), -cap.saturating_add(1), MAX_OPERAND, -MAX_OPERAND, 2 * MAX_OPERAND, -(2 * MAX_OPERAND)] {
            for &elapsed in &[0i64, 1, 35_999, 36_000, 36_001, 72_000] {
                let want = ref_settled(used, elapsed, cap, 36_000);
                expect_ok(&b, "p_settled_out", args!(used, elapsed, cap, 36_000i64, want), format!("used={used} elapsed={elapsed} cap={cap}"));
                cases += 1;
            }
        }
    }
    println!("settled_out: {cases} cases agreed");
}

fn ref_credit_left(credit: i64, stored: i64, settled: i64) -> i64 {
    if stored < 0 {
        let lapsed = settled - stored;
        if credit > lapsed { credit - lapsed } else { 0 }
    } else {
        credit
    }
}

#[test]
fn check_credit_left_matches_the_formula() {
    let b = pbuilder();
    for &credit in &[0i64, 1, 5, 100, MAX_OPERAND, MAX_OPERAND - 1] {
        for &stored in &[0i64, 1, -1, -5, -100, -MAX_OPERAND, 100] {
            for &settled in &[0i64, 1, -1, -5, -100, stored, -MAX_OPERAND] {
                if stored < 0 && settled < stored {
                    continue; // settled_out never moves a negative count further from zero
                }
                let want = ref_credit_left(credit, stored, settled);
                expect_ok(&b, "p_credit_left", args!(credit, stored, settled, want), format!("credit={credit} stored={stored} settled={settled}"));
            }
        }
    }
}

fn ref_refilled(bucket: i64, age_daa: i64, capacity: i64, refill: i64) -> Option<i64> {
    if age_daa < 0 || refill < 0 {
        return None;
    }
    let mut filled = bucket as i128;
    if refill > 0 && (bucket as i128) < capacity as i128 {
        let elapsed = age_daa as i128;
        let needed = (capacity as i128 - bucket as i128 + refill as i128 - 1) / refill as i128;
        if elapsed >= needed {
            filled = capacity as i128;
        } else {
            filled = bucket as i128 + elapsed * refill as i128;
        }
    }
    Some(filled.min(capacity as i128) as i64)
}

#[test]
fn check_refilled_matches_the_formula_with_sane_limits() {
    let b = pbuilder();
    let mut rng = Rng::new(7);
    let capacities = [0i64, 1, 500_000_000_000, 1_000_000_000_000_000];
    let refills = [0i64, 1, 578_703, 1_000_000_000];
    for _ in 0..600 {
        let capacity = *rng.pick(&capacities);
        let refill = *rng.pick(&refills);
        let bucket = if capacity == 0 { 0 } else { rng.below(capacity as u64 + 1) as i64 };
        let age = *rng.pick(&[0i64, 1, 10, 864_000, 864_001, 50_000_000]);
        let want = ref_refilled(bucket, age, capacity, refill).expect("valid");
        expect_ok(&b, "p_refilled", args!(bucket, age, capacity, refill, want), format!("{bucket} {age} {capacity} {refill}"));
    }
}

/// The hazard is limited to absurd limits: only then can the `needed` numerator pass 2^63 and
/// make `refilled` revert, which would also block `set_limits` (the only way to repair limits).
#[test]
fn check_refilled_only_reverts_at_absurd_limits() {
    let b = pbuilder();
    // capacity - bucket + refill - 1 overflows 2^63 - 1 only when capacity + refill exceeds it.
    expect_ok(&b, "p_refilled", args!(0i64, 1i64, I64_MAX / 2, I64_MAX / 2, I64_MAX / 2), "at half max each".to_string());
    expect_err(&b, "p_refilled", args!(0i64, 1i64, I64_MAX, 2i64, 2i64), "capacity i64 max".to_string());
}

#[test]
fn check_division_truncates_and_modulo_follows_the_dividend() {
    let b = pbuilder();
    for &(a, d) in &[(7i64, 3i64), (-7, 3), (7, -3), (-7, -3), (0, 3), (1, 1), (I64_MAX, 1), (I64_MAX, 2), (I64_MIN_REP, 2), (I64_MAX, I64_MAX), (I64_MIN_REP, I64_MAX)] {
        let q = (a as i128 / d as i128) as i64;
        let r = (a as i128 % d as i128) as i64;
        expect_ok(&b, "p_divmod", args!(a, d, q, r), format!("{a} / {d}"));
    }
    // Division by zero fails; i64::MIN does not exist as a script number at all.
    expect_err(&b, "p_divmod", args!(1i64, 0i64, 0i64, 0i64), "division by zero".to_string());
}

#[test]
fn check_integer_overflow_reverts_and_does_not_wrap() {
    let b = pbuilder();
    expect_ok(&b, "p_add", args!(I64_MAX - 1, 1i64, I64_MAX), "max".to_string());
    expect_err(&b, "p_add", args!(I64_MAX, 1i64, I64_MIN_REP), "add overflow".to_string());
    expect_ok(&b, "p_sub", args!(I64_MIN_REP + 1, 1i64, I64_MIN_REP), "min".to_string());
    expect_err(&b, "p_sub", args!(I64_MIN_REP, 1i64, I64_MAX), "sub overflow".to_string());
    expect_ok(&b, "p_mul", args!(MAX_OPERAND, 4i64, I64_MAX - 3), "2^63-4".to_string());
    expect_err(&b, "p_mul", args!(MAX_OPERAND, 5i64, 0i64), "mul overflow".to_string());
    expect_err(&b, "p_mul", args!(I64_MAX, I64_MAX, 1i64), "mul overflow 2".to_string());
}

fn le8_sign_magnitude(x: i64) -> Vec<u8> {
    let mut bytes = x.unsigned_abs().to_le_bytes().to_vec();
    if x < 0 {
        bytes[7] |= 0x80;
    }
    bytes
}

#[test]
fn check_as_byte8_is_8_byte_little_endian_sign_magnitude() {
    let b = pbuilder();
    for &x in &[0i64, 1, -1, 127, -127, 128, -128, 255, 256, 1 << 31, -(1 << 31), (1 << 55) - 1, 1 << 55, -(1 << 55), I64_MAX, I64_MIN_REP] {
        let want = le8_sign_magnitude(x);
        expect_ok(&b, "p_cast8", args!(x, want.clone()), format!("x={x}"));
    }
}

#[test]
fn check_int_from_byte8_reads_sign_magnitude_and_accepts_negative_zero() {
    let b = pbuilder();
    let cases: Vec<(Vec<u8>, i64)> = vec![
        (vec![1, 0, 0, 0, 0, 0, 0, 0], 1),
        (vec![1, 0, 0, 0, 0, 0, 0, 0x80], -1),
        (vec![0, 0, 0, 0, 0, 0, 0, 0x80], 0), // negative zero reads as zero
        (vec![0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f], I64_MAX),
        (vec![0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], I64_MIN_REP),
    ];
    for (raw, want) in cases {
        expect_ok(&b, "p_byte8_to_int", args!(raw.clone(), want), format!("raw={raw:02x?}"));
    }
}

#[test]
fn check_comparisons_are_numeric_with_negatives_and_limits() {
    let b = pbuilder();
    let values = [0i64, 1, -1, 2, -2, I64_MAX, I64_MIN_REP, I64_MAX - 1, I64_MIN_REP + 1];
    for &x in &values {
        for &y in &values {
            let (lt, le, gt, ge, eq, ne) = (x < y, x <= y, x > y, x >= y, x == y, x != y);
            expect_ok(&b, "p_order", args!(x, y, lt as i64, le as i64, gt as i64, ge as i64, eq as i64, ne as i64), format!("{x} vs {y}"));
        }
    }
}

#[test]
fn check_if_without_else_assigns_outer_variables_correctly() {
    let b = pbuilder();
    for (x, want) in [(0i64, 1i64), (1, 2), (5, 2), (10, 2), (11, 3), (100, 3), (-1, 4), (-100, 4)] {
        expect_ok(&b, "p_if", args!(x, want), format!("x={x}"));
    }
}
