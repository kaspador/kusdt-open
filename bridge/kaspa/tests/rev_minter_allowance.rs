//! Review r16/rev-minter, property 2 (the allowance) of BridgeMint, in the script engine.
//!
//! What the engine can show: the script never lets a spend claim more age than its input's sequence, and
//! never credits more than `min(capacity, bucket + age * refill)`. That the sequence is at most the coin's
//! real age is consensus's relative lock (tx_validation_in_utxo_context.rs, check_sequence_lock), which
//! this harness does not run: it was read, not executed.
//!
//!   cargo test --locked --test rev_minter_allowance -- --nocapture

mod common;
mod rev_minter_kit;

use kaspa_consensus_core::tx::Transaction;
use rev_minter_kit::*;

fn one(amount: i64) -> Vec<Recipient> {
    vec![Recipient::schnorr(&key(0xa1), amount)]
}

/// A mint of `amount` at the chain's nonce, claiming `age` under `sequence`, signed for exactly that by 0, 1, 2.
fn mint_at(h: &Harness, age: i64, sequence: u64, amount: i64) -> (Result<Transaction, Rejected>, Verdict) {
    let r = one(amount);
    let v = model_mint(&h.state, CHAIN_ETHEREUM, h.state.nonce_ethereum, age, sequence, &r, h.minter.utxo.amount);
    let q = Quorum::honest(&h.signers, &[0, 1, 2], &mint_digest_any(&cov(h), CHAIN_ETHEREUM, h.state.nonce_ethereum, age, &r));
    (build_mint(h, CHAIN_ETHEREUM, h.state.nonce_ethereum, age, sequence, &r, &q, &v.next, v.value, &r), v)
}

fn govern_at(h: &Harness, action: u8, params: &[u8], age: i64, sequence: u64) -> (Result<Transaction, Rejected>, Verdict) {
    let v = model_govern(&h.state, action, params, age, sequence, h.minter.utxo.amount);
    let who: Vec<usize> = (0..quorum_of(action)).collect();
    let q = Quorum::honest(&h.signers, &who, &digest_for_aged(h, signed_nonce(&h.state, action), age, action, params));
    (build_govern(h, action, params, age, sequence, &q, &v.next, v.value), v)
}

const TOP: i64 = (1i64 << 32) - 1;

#[test]
fn p2_a_claimed_age_never_exceeds_the_inputs_sequence() {
    // One unit refills per DAA, from nothing: a mint of x needs a claimed age of x.
    let h = Harness::launch_with(|s| {
        s.capacity = MAX_LIMIT;
        s.bucket = 0;
        s.refill_per_daa = 1;
    });
    let mut t = Tally::default();
    let junk = 0x7fff_ffffu64 << 32; // every bit above the 32-bit lock except the disabled bit
    // The sequence is exactly the claim (`require_settled_inputs`): a larger one, which consensus's lock alone would
    // take, is refused below.
    for (age, seq) in [(100i64, 100u64), (TOP, TOP as u64), (0, 0)] {
        let amount = age.max(1);
        let (r, v) = mint_at(&h, age, seq, amount);
        if age == 0 {
            // Nothing refilled at age 0: the control for "the claim is what counts" is the refusal of one unit.
            assert!(v.accept.is_err());
            t.refused("one unit at a claimed age of 0", r);
        } else {
            assert!(v.accept.is_ok());
            t.control("a claim equal to the sequence", r);
        }
    }
    for (what, age, seq) in [
        ("a sequence above the claim", 100i64, 500u64),
        ("the highest lock under a claim of 100", 100, u32::MAX as u64),
        ("junk above the lock, the low bits the claim", 100, junk | 100),
        ("junk above the highest lock", TOP, junk | TOP as u64),
        ("one more than the sequence", 101i64, 100u64),
        ("far more than the sequence", 1_000_000, 100),
        ("sequence 0", 1, 0),
        ("the disabled bit set (a lock consensus does not check)", 100, SEQ_DISABLED | 100),
        ("the disabled bit set, all lock bits set", 100, SEQ_DISABLED | u32::MAX as u64),
        ("u64::MAX", 100, u64::MAX),
        ("junk above the lock, the low bits one short", 101, junk | 100),
        ("2^32 under a sequence of 2^32 (whose low 32 bits are 0)", 1 << 32, 1 << 32),
        ("2^32 under the highest lock", 1 << 32, u32::MAX as u64),
        ("2^32 + 5 under a sequence of 5 (the same low 32 bits)", (1 << 32) + 5, 5),
        ("2^32 + 5 under 2^32 + 5", (1 << 32) + 5, (1 << 32) + 5),
        ("2^62", 1 << 62, u32::MAX as u64),
        ("i64::MAX", i64::MAX, u32::MAX as u64),
        ("a negative age", -1, 100),
        ("a negative age, the lowest", i64::MIN + 1, 100),
    ] {
        // Offer one unit only: the claim alone is what must fail.
        let (r, v) = mint_at(&h, age, seq, 1);
        assert!(v.accept.is_err(), "{what}");
        t.refused(what, r);
    }
    // The amount is bounded by the claim, not by the sequence.
    for (age, seq, amount) in [(100i64, 500u64, 101i64), (100, u32::MAX as u64, 500), (TOP, TOP as u64, TOP + 1)] {
        t.refused("more than the claimed age refills", mint_at(&h, age, seq, amount).0);
    }

    // The same lock on every governance action's age (which settles the allowance).
    let hp = Harness::launch_with(|s| {
        s.capacity = MAX_LIMIT;
        s.bucket = 0;
        s.refill_per_daa = 1;
        s.paused = true;
        s.recovery_pending = true;
        s.recovery_signer_set = [3; 32];
    });
    let actions: Vec<(u8, Vec<u8>)> = vec![
        (0x01, vec![]),
        (0x02, [le8(MAX_LIMIT), le8(1)].concat()),
        (0x03, [[5u8; 32].to_vec(), [6u8; 32].to_vec()].concat()),
        (0x04, [vec![CHAIN_ETHEREUM], le8(0).to_vec()].concat()),
        (0x05, le8(MINTER_SOMPI as i64 + 1).to_vec()),
        (0x07, vec![]),
    ];
    for (action, params) in &actions {
        let (r, v) = govern_at(&hp, *action, params, 100, 100);
        assert_eq!(v.next.bucket, 100);
        t.control("a governance age covered by the sequence", r);
        for (age, seq) in [(101i64, 100u64), (100, SEQ_DISABLED | 100), (1 << 32, u32::MAX as u64), ((1 << 32) + 5, 5), (-1, 100)] {
            let (r, v) = govern_at(&hp, *action, params, age, seq);
            assert!(v.accept.is_err());
            t.refused("a governance age the sequence does not cover", r);
        }
        // The age claimed is what is credited: a successor crediting the whole sequence is refused.
        let (_, v) = govern_at(&hp, *action, params, 100, 500);
        let mut generous = v.next.clone();
        generous.bucket = 500;
        let who: Vec<usize> = (0..quorum_of(*action)).collect();
        let q = Quorum::honest(&hp.signers, &who, &digest_for_aged(&hp, signed_nonce(&hp.state, *action), 100, *action, params));
        t.refused("a successor crediting the sequence instead of the claim", build_govern(&hp, *action, params, 100, 500, &q, &generous, v.value));
    }
    t.report("p2 claimed age and sequence");
    assert_eq!((t.refused, t.controls), (1 + 19 + 3 + 36, 2 + 6));
}

#[test]
fn p2_pause_and_execute_recovery_credit_no_time() {
    let mut t = Tally::default();
    let h = Harness::launch_with(|s| {
        s.capacity = 1_000_000;
        s.bucket = 10;
        s.refill_per_daa = 1;
        s.recovery_pending = true;
        s.recovery_signer_set = [3; 32];
        s.recovery_delay = 1_000;
    });
    // A pause on a coin that waited 1000 DAA claims none of it: the bucket stays where it was, and its input asks no
    // relative lock (`require_settled_inputs` holds the sequence at the age claimed, 0).
    let v = model_pause(&h.state, 0, MINTER_SOMPI);
    assert_eq!(v.next.bucket, 10);
    t.control("a pause with a sequence of 0", build_pause(&h, &h.guardian, 0, &v.next, v.value));
    let mut credited = v.next.clone();
    credited.bucket = 1_010;
    t.refused("a pause crediting its wait", build_pause(&h, &h.guardian, 0, &credited, v.value));
    t.refused("a pause with a sequence of 1000", build_pause(&h, &h.guardian, 1_000, &v.next, v.value));
    let v = model_execute(&h.state, 1_000, MINTER_SOMPI);
    assert_eq!(v.next.bucket, 10);
    t.control("execute_recovery after 1000", build_execute(&h, 1_000, &v.next, v.value));
    let mut credited = v.next.clone();
    credited.bucket = 1_010;
    t.refused("execute_recovery crediting its wait", build_execute(&h, 1_000, &credited, v.value));
    t.report("p2 pause and execute credit nothing");
    assert_eq!((t.refused, t.controls), (3, 2));
}

/// The allowance the specification states (SPEC §6, §8), in wide arithmetic.
fn spec_allowance(bucket: i64, age: i64, capacity: i64, refill: i64) -> i64 {
    let grown = bucket as i128 + age as i128 * refill as i128;
    grown.min(capacity as i128).max(bucket.min(capacity) as i128) as i64
}

fn probe(t: &mut Tally, bucket: i64, capacity: i64, refill: i64, age: i64) {
    let h = Harness::launch_with(|s| {
        s.remaining = 2 * MAX_LIMIT;
        s.capacity = capacity;
        s.bucket = bucket;
        s.refill_per_daa = refill;
    });
    let available = model_refilled(bucket, age, capacity, refill).expect("no overflow at any value up to the ceiling");
    assert_eq!(available, spec_allowance(bucket, age, capacity, refill), "the contract's formula is the specification's at bucket {bucket} capacity {capacity} refill {refill} age {age}");
    assert!(available <= capacity && available >= 0);
    let what = format!("bucket {bucket} capacity {capacity} refill {refill} age {age}");
    if available >= 1 {
        let (r, v) = mint_at(&h, age, age as u64, available);
        assert_eq!(v.next.bucket, 0);
        t.control(&format!("exactly the allowance: {what}"), r);
    }
    t.refused(&format!("one unit more than the allowance: {what}"), mint_at(&h, age, age as u64, available + 1).0);
}

#[test]
fn p2_the_allowance_is_exact_everywhere_up_to_the_ceiling() {
    let mut t = Tally::default();
    for capacity in [1i64, 1_000, 500_000_000_000, MAX_LIMIT] {
        for refill in [0i64, 1, 578_703, MAX_LIMIT] {
            for bucket in [0i64, capacity / 2, capacity - 1, capacity] {
                let needed = if refill > 0 && bucket < capacity { (capacity - bucket + refill - 1) / refill } else { 0 };
                let mut ages = vec![0i64, 1, TOP];
                for a in [needed - 1, needed, needed + 1] {
                    if (0..=TOP).contains(&a) && !ages.contains(&a) {
                        ages.push(a);
                    }
                }
                for age in ages {
                    probe(&mut t, bucket, capacity, refill, age);
                }
            }
        }
    }
    let grid = (t.refused, t.controls);
    let seed = 0x5eed_0002_a110_0001u64;
    println!("[p2 allowance] random probes, seed {seed:#x}");
    let mut rng = Rng(seed);
    for _ in 0..300 {
        let capacity = match rng.below(4) {
            0 => rng.range(0, 1_000),
            1 => rng.range(0, 1_000_000_000_000),
            2 => MAX_LIMIT - rng.range(0, 1_000),
            _ => rng.range(0, MAX_LIMIT),
        };
        let refill = match rng.below(4) {
            0 => rng.range(0, 3),
            1 => rng.range(0, 1_000_000),
            2 => MAX_LIMIT - rng.range(0, 1_000),
            _ => rng.range(0, MAX_LIMIT),
        };
        let bucket = if rng.chance(30) { capacity } else { rng.range(0, capacity) };
        let age = match rng.below(4) {
            0 => rng.range(0, 10),
            1 => TOP - rng.range(0, 10),
            2 if refill > 0 => ((capacity - bucket) / refill + rng.range(-2, 2)).clamp(0, TOP),
            _ => rng.range(0, TOP),
        };
        probe(&mut t, bucket, capacity, refill, age);
    }
    println!("[p2 allowance] grid: {} refusals, {} controls; with random probes:", grid.0, grid.1);
    t.report("p2 allowance exact");
    assert!(t.refused >= 500 && t.controls >= 400);
}

#[test]
fn p2_at_the_ceiling_and_at_the_lifetime_cap() {
    let mut t = Tally::default();
    // Both limits at MAX_LIMIT, nothing in the bucket, the whole lifetime cap left.
    let mut h = Harness::launch_with(|s| {
        s.remaining = CAP;
        s.capacity = MAX_LIMIT;
        s.bucket = 0;
        s.refill_per_daa = MAX_LIMIT;
    });
    t.refused("one unit before any time passed", mint_at(&h, 0, 0, 1).0);
    // The whole cap, in three recipients, one DAA later.
    let parts = vec![Recipient::schnorr(&key(0xa1), CAP - 2), Recipient::schnorr(&key(0xa2), 1), Recipient::schnorr(&key(0xa3), 1)];
    let (r, v) = honest_mint(&h, CHAIN_ETHEREUM, 0, 1, &parts);
    let tx = t.control("the whole lifetime cap in one mint at the ceiling", r);
    adopt(&mut h, &tx, v.next);
    assert_eq!((h.state.remaining, h.state.bucket), (0, 0));
    t.refused("one unit past the lifetime cap, with a full allowance and the longest age", mint_at(&h, TOP, TOP as u64, 1).0);
    // Governance still works from here (the allowance settles at the longest age without overflow).
    for (action, params) in [(0x02u8, [le8(MAX_LIMIT), le8(MAX_LIMIT)].concat()), (0x04, [vec![CHAIN_BSC], le8(0).to_vec()].concat()), (0x06, [[5u8; 32].to_vec(), [6u8; 32].to_vec()].concat())] {
        let (r, v) = govern_at(&h, action, &params, TOP, TOP as u64);
        assert_eq!(v.next.bucket, MAX_LIMIT);
        t.control("governance at the ceiling, the longest age", r);
    }
    // Three recipients whose sum would wrap a 64-bit number: refused, not wrapped.
    let h = Harness::launch_with(|s| {
        s.remaining = i64::MAX;
        s.capacity = i64::MAX;
        s.bucket = i64::MAX;
        s.refill_per_daa = 0;
    });
    let wrap = vec![Recipient::schnorr(&key(0xa1), 1 << 62), Recipient::schnorr(&key(0xa2), 1 << 62), Recipient::schnorr(&key(0xa3), 5)];
    let v = model_mint(&h.state, CHAIN_ETHEREUM, 0, 1, 1, &wrap, MINTER_SOMPI);
    assert!(v.accept.is_err());
    let q = Quorum::honest(&h.signers, &[0, 1, 2], &mint_digest_any(&cov(&h), CHAIN_ETHEREUM, 0, 1, &wrap));
    t.refused("a total that wraps", build_mint(&h, CHAIN_ETHEREUM, 0, 1, 1, &wrap, &q, &v.next, v.value, &wrap));
    let fits = vec![Recipient::schnorr(&key(0xa1), 1 << 62), Recipient::schnorr(&key(0xa2), (1 << 62) - 1)];
    let v = model_mint(&h.state, CHAIN_ETHEREUM, 0, 1, 1, &fits, MINTER_SOMPI);
    let q = Quorum::honest(&h.signers, &[0, 1, 2], &mint_digest_any(&cov(&h), CHAIN_ETHEREUM, 0, 1, &fits));
    t.control("the largest total that fits (a genesis-only state)", build_mint(&h, CHAIN_ETHEREUM, 0, 1, 1, &fits, &q, &v.next, v.value, &fits));
    t.report("p2 ceiling and cap");
    assert_eq!((t.refused, t.controls), (3, 5));
}

#[test]
fn p2_changing_the_limits_grants_nothing_at_once() {
    let mut t = Tally::default();
    let mut h = Harness::launch_with(|s| {
        s.capacity = 1_000;
        s.bucket = 400;
        s.refill_per_daa = 1;
    });
    // Raise both limits to the ceiling, claiming 100 DAA: the bucket is 500 (the old rate), not the new ceiling.
    let (r, v) = govern_at(&h, 0x02, &[le8(MAX_LIMIT), le8(MAX_LIMIT)].concat(), 100, 100);
    let tx = t.control("raise the limits", r);
    assert_eq!(v.next.bucket, 500);
    adopt(&mut h, &tx, v.next);
    t.refused("the new ceiling in the same instant", mint_at(&h, 0, 0, 501).0);
    t.control("what the old limits had refilled", mint_at(&h, 0, 0, 500).0);
    t.control("the new ceiling one DAA later (four signers chose that rate)", mint_at(&h, 1, 1, MAX_LIMIT).0);
    // Lower the ceiling under the bucket: the bucket comes down with it.
    let (r, v) = govern_at(&h, 0x02, &[le8(100), le8(0)].concat(), 0, 0);
    let tx = t.control("lower the limits", r);
    assert_eq!((v.next.bucket, v.next.capacity, v.next.refill_per_daa), (100, 100, 0));
    adopt(&mut h, &tx, v.next);
    t.refused("above the lowered ceiling", mint_at(&h, TOP, TOP as u64, 101).0);
    t.control("the lowered ceiling", mint_at(&h, 0, 0, 100).0);
    // Zero limits: nothing mints, and four signers can still set limits again.
    let (r, v) = govern_at(&h, 0x02, &[le8(0), le8(0)].concat(), 0, 0);
    let tx = t.control("limits of zero", r);
    adopt(&mut h, &tx, v.next);
    t.refused("anything under limits of zero", mint_at(&h, TOP, TOP as u64, 1).0);
    let (r, _) = govern_at(&h, 0x02, &[le8(1_000), le8(1)].concat(), TOP, TOP as u64);
    t.control("limits set again from zero", r);
    t.report("p2 changing the limits");
    assert_eq!((t.refused, t.controls), (3, 7));
}

/// One run of spends on a simulated clock. Every claim is at most the coin's age (what consensus enforces), and the
/// input's sequence is the claim (`require_settled_inputs`);
/// at every mint the engine is first offered one unit too many, and a claim one DAA too old.
fn trajectory(seed: u64, t: &mut Tally) {
    let mut rng = Rng(seed);
    let capacity = rng.pick(&[1_000i64, 1_000_000, 500_000_000_000]);
    let refill = rng.pick(&[1i64, 7, 578_703]);
    let start = rng.pick(&[0, capacity / 2, capacity]);
    let mut h = Harness::launch_with(|s| {
        s.capacity = capacity;
        s.bucket = start;
        s.refill_per_daa = refill;
    });
    let (mut now, mut born) = (0i64, 0i64);
    let mut mints: Vec<(i64, i64)> = Vec::new();
    for _ in 0..36 {
        now += match rng.below(4) {
            0 => 0,
            1 => rng.range(1, 20),
            2 => rng.range(1, (capacity / refill / 3).clamp(2, TOP / 64)),
            _ => rng.range(1, (2 * capacity / refill).clamp(2, TOP / 64)),
        };
        let real = now - born;
        let claimed = if rng.chance(65) { real } else { rng.range(0, real) };
        match rng.below(10) {
            0..=5 => {
                if h.state.paused {
                    t.refused("a mint while paused", mint_at(&h, claimed, claimed as u64, 1).0);
                    continue;
                }
                let available = model_refilled(h.state.bucket, claimed, capacity, refill).unwrap();
                t.refused("one unit more than the allowance", mint_at(&h, claimed, claimed as u64, available + 1).0);
                // A claim one DAA older than the coin, with what that extra DAA would refill (when it would refill any).
                let older = model_refilled(h.state.bucket, real + 1, capacity, refill).unwrap();
                t.refused("a claim older than the coin", mint_at(&h, real + 1, real as u64, older.max(1)).0);
                if available >= 1 {
                    let amount = if rng.chance(50) { available } else { rng.range(1, available) };
                    let (r, v) = mint_at(&h, claimed, claimed as u64, amount);
                    let tx = t.control("a mint within the allowance", r);
                    adopt(&mut h, &tx, v.next);
                    mints.push((now, amount));
                    born = now;
                }
            }
            6 => {
                if !h.state.paused {
                    let v = model_pause(&h.state, 0, h.minter.utxo.amount);
                    let tx = t.control("pause", build_pause(&h, &h.guardian, 0, &v.next, v.value));
                    adopt(&mut h, &tx, v.next);
                    born = now;
                }
            }
            7 => {
                if h.state.paused {
                    let (r, v) = govern_at(&h, 0x01, &[], claimed, claimed as u64);
                    let tx = t.control("unpause", r);
                    adopt(&mut h, &tx, v.next);
                    born = now;
                }
            }
            8 => {
                let (r, v) = govern_at(&h, 0x04, &[vec![CHAIN_BSC], le8(h.state.nonce_bsc).to_vec()].concat(), claimed, claimed as u64);
                let tx = t.control("skip a BSC nonce", r);
                adopt(&mut h, &tx, v.next);
                born = now;
            }
            _ => {
                let value = if h.minter.utxo.amount == MINTER_SOMPI { MINTER_SOMPI + 7 } else { MINTER_SOMPI };
                let (r, v) = govern_at(&h, 0x05, &le8(value as i64), claimed, claimed as u64);
                let tx = t.control("set the minter's value", r);
                adopt(&mut h, &tx, v.next);
                born = now;
            }
        }
    }
    // SPEC §8: over any window of length t at most capacity + refill * t is minted; from the start, start + refill * t.
    let mut total: i128 = 0;
    for (i, &(at, amount)) in mints.iter().enumerate() {
        total += amount as i128;
        assert!(total <= start as i128 + refill as i128 * at as i128, "seed {seed:#x}: minted {total} by DAA {at}, the bucket started at {start}");
        let mut window: i128 = 0;
        for &(later, more) in &mints[i..] {
            window += more as i128;
            assert!(window <= capacity as i128 + refill as i128 * (later - at) as i128, "seed {seed:#x}: {window} minted between DAA {at} and {later}");
        }
    }
    println!("[p2 trajectory] seed {seed:#x}: capacity {capacity}, refill {refill}, start {start}: {} mints, {} units, over {now} DAA", mints.len(), total);
}

#[test]
fn p2_no_sequence_of_spends_mints_more_than_capacity_plus_refill() {
    let mut t = Tally::default();
    for seed in [0x5eed_0002_0000_0001u64, 0x5eed_0002_0000_0002, 0x5eed_0002_0000_0003, 0x5eed_0002_0000_0004, 0x5eed_0002_0000_0005, 0x5eed_0002_0000_0006, 0x5eed_0002_0000_0007, 0x5eed_0002_0000_0008] {
        trajectory(seed, &mut t);
    }
    t.report("p2 trajectories");
    assert!(t.refused >= 100 && t.controls >= 100);
}

#[test]
fn p2_genesis_limits_far_above_the_ceiling_stop_everything_but_pause() {
    // Not reachable after genesis (set_limits is bounded since 9049f02). A genesis is not bounded by the script:
    // this is what the deploy plan's own check has to prevent (see the report, "Launch").
    let h = Harness::launch_with(|s| {
        s.capacity = i64::MAX;
        s.bucket = 0;
        s.refill_per_daa = 2;
    });
    let mut t = Tally::default();
    t.refused("a mint", mint_at(&h, 1, 1, 1).0);
    t.refused("a mint claiming no age", mint_at(&h, 0, 0, 1).0);
    for (action, params) in [(0x02u8, [le8(1_000), le8(1)].concat()), (0x04, [vec![CHAIN_BSC], le8(0).to_vec()].concat()), (0x06, [[5u8; 32].to_vec(), [6u8; 32].to_vec()].concat())] {
        let v = model_govern(&h.state, action, &params, 0, 0, MINTER_SOMPI);
        assert!(v.accept.is_err());
        let who: Vec<usize> = (0..quorum_of(action)).collect();
        let q = Quorum::honest(&h.signers, &who, &digest_for(&h, signed_nonce(&h.state, action), action, &params));
        // The successor a builder would offer: nothing refilled at age 0.
        let mut next = v.next.clone();
        next.bucket = if action == 0x02 { 0 } else { h.state.bucket };
        t.refused("a governance action (it settles the allowance first, and that overflows)", build_govern(&h, action, &params, 0, 0, &q, &next, v.value));
    }
    let v = model_pause(&h.state, 0, MINTER_SOMPI);
    t.control("pause (it settles nothing)", build_pause(&h, &h.guardian, 0, &v.next, v.value));
    // The same state under the ceiling: the control for the shape.
    let ok = Harness::launch_with(|s| {
        s.capacity = MAX_LIMIT;
        s.bucket = 0;
        s.refill_per_daa = 2;
    });
    t.control("the same mint under the ceiling", mint_at(&ok, 1, 1, 1).0);
    t.control("the same set_limits under the ceiling", govern_at(&ok, 0x02, &[le8(1_000), le8(1)].concat(), 0, 0).0);
    t.report("p2 genesis beyond the ceiling");
    assert_eq!((t.refused, t.controls), (5, 3));
}
