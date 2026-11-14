//! BridgeMint in the Kaspa script engine.
//!
//! Every case builds a complete transaction with argent-runtime and executes
//! all of its inputs with the covenant-enabled engine, so the accepted and the
//! rejected shapes are the ones consensus would see.

mod common;

use common::*;
use secp256k1::Keypair;

#[test]
fn genesis_creates_the_minter_and_a_seed_in_one_family() {
    let h = Harness::launch();
    assert_eq!(h.minter.covenant_id, h.seed.covenant_id);
}

#[test]
fn mints_one_deposit_with_three_signatures() {
    let mut h = Harness::launch();
    let alice = key(0xa1);
    let recipients = vec![Recipient::schnorr(&alice, 250_000_000)];
    h.mint(CHAIN_ETHEREUM, 0, &recipients, &[0, 2, 4]).expect("mint");
    assert_eq!(h.state.nonce_ethereum, 1);
    assert_eq!(h.state.remaining, CAP - 250_000_000);
}

#[test]
fn minted_tokens_spend_through_the_standard_kcc20_transfer() {
    let mut h = Harness::launch();
    let alice = key(0xa1);
    let bob = key(0xb0);
    let tx = h
        .mint(CHAIN_BSC, 0, &[Recipient::schnorr(&alice, 1_000_000)], &[1, 2, 3])
        .expect("mint");
    let token = covenant_output(&tx, 1);
    transfer(&token, &alice, 1_000_000, &[(xonly(&bob), 600_000), (xonly(&alice), 400_000)])
        .expect("standard transfer");
}

#[test]
fn mints_a_batch_of_three_consecutive_deposits() {
    let mut h = Harness::launch();
    let recipients = vec![
        Recipient::schnorr(&key(0xa1), 10_000_000),
        Recipient::schnorr(&key(0xa2), 20_000_000),
        Recipient::schnorr(&key(0xa3), 30_000_000),
    ];
    h.mint(CHAIN_ETHEREUM, 0, &recipients, &[0, 1, 2]).expect("batch");
    assert_eq!(h.state.nonce_ethereum, 3);
    assert_eq!(h.state.nonce_bsc, 0);
}

#[test]
fn chains_count_their_nonces_separately() {
    let mut h = Harness::launch();
    h.mint(CHAIN_ETHEREUM, 0, &[Recipient::schnorr(&key(0xa1), 5)], &[0, 1, 2]).unwrap();
    h.mint(CHAIN_BSC, 0, &[Recipient::schnorr(&key(0xa2), 5)], &[0, 1, 2]).unwrap();
    h.mint(CHAIN_ETHEREUM, 1, &[Recipient::schnorr(&key(0xa3), 5)], &[0, 1, 2]).unwrap();
    assert_eq!((h.state.nonce_ethereum, h.state.nonce_bsc), (2, 1));
}

#[test]
fn a_deposit_can_not_be_minted_twice() {
    let mut h = Harness::launch();
    let r = vec![Recipient::schnorr(&key(0xa1), 7_000_000)];
    h.mint(CHAIN_ETHEREUM, 0, &r, &[0, 1, 2]).unwrap();
    // Same nonce again, signed again: the minter has moved past it.
    rejects(h.mint(CHAIN_ETHEREUM, 0, &r, &[0, 1, 2]));
    // Skipping ahead is refused too.
    rejects(h.mint(CHAIN_ETHEREUM, 2, &r, &[0, 1, 2]));
}

#[test]
fn quorum_rules() {
    let h = Harness::launch();
    let r = vec![Recipient::schnorr(&key(0xa1), 1_000)];
    // Two signatures are not enough.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1])));
    // The same signer twice.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[1, 1, 2])));
    // Signers out of order.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[2, 1, 3])));
    // An index past the set.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 5])));
    // A key set that isn't the committed one.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2]).foreign_keys()));
    // Four or five signatures where three are expected.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2, 3])));
    // The good case still passes.
    assert!(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2])).is_ok());
}

#[test]
fn signatures_bind_every_field_they_cover() {
    let h = Harness::launch();
    let r = vec![Recipient::schnorr(&key(0xa1), 1_000)];
    let signed_for = |case: MintCase| h.try_mint(case.signers(&[0, 1, 2]));
    // Signed for another amount.
    rejects(signed_for(MintCase::new(CHAIN_ETHEREUM, 0, &r).signed_recipients(&[Recipient::schnorr(&key(0xa1), 1_001)])));
    // Signed for another owner.
    rejects(signed_for(MintCase::new(CHAIN_ETHEREUM, 0, &r).signed_recipients(&[Recipient::schnorr(&key(0xa2), 1_000)])));
    // Signed for the other chain.
    rejects(signed_for(MintCase::new(CHAIN_ETHEREUM, 0, &r).signed_chain(CHAIN_BSC)));
    // Signed for another covenant (another deployment).
    rejects(signed_for(MintCase::new(CHAIN_ETHEREUM, 0, &r).signed_covenant([0x55; 32])));
}

#[test]
fn unknown_chains_are_refused() {
    let h = Harness::launch();
    let r = vec![Recipient::schnorr(&key(0xa1), 1_000)];
    rejects(h.try_mint(MintCase::new(0x03, 0, &r).signers(&[0, 1, 2])));
    rejects(h.try_mint(MintCase::new(0x00, 0, &r).signers(&[0, 1, 2])));
}

#[test]
fn minted_states_must_be_plain_kusdt() {
    let h = Harness::launch();
    let ok = Recipient::schnorr(&key(0xa1), 1_000);
    let mut zero = ok.clone();
    zero.amount = 0;
    let mut borrowable = ok.clone();
    borrowable.borrow_scheme = 0x01;
    let mut guarded = ok.clone();
    guarded.borrow_guard = [0x01; 32];
    let mut foreign_extension = ok.clone();
    foreign_extension.extension_commitment = [0x09; 32];
    let mut bad_scheme = ok.clone();
    bad_scheme.owner_scheme = 0x05;
    for bad in [zero, borrowable, guarded, foreign_extension, bad_scheme] {
        rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &[bad]).signers(&[0, 1, 2])));
    }
    // Every standard owner scheme is accepted.
    for scheme in 0x00..=0x04u8 {
        let mut r = ok.clone();
        r.owner_scheme = scheme;
        assert!(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &[r]).signers(&[0, 1, 2])).is_ok(), "scheme {scheme}");
    }
}

#[test]
fn rate_limit_refills_over_daa_score() {
    let mut h = Harness::launch_with(|s| {
        s.capacity = 1_000;
        s.bucket = 1_000;
        s.refill_per_daa = 10;
    });
    let r = |amount| vec![Recipient::schnorr(&key(0xa1), amount)];
    // The full allowance can go at once, not a unit more.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r(1_001)).signers(&[0, 1, 2])));
    h.mint_at(CHAIN_ETHEREUM, 0, &r(1_000), &[0, 1, 2], 1).unwrap();
    assert_eq!(h.state.bucket, 0);
    // A minter UTXO 30 DAA old: 300 is back.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 1, &r(301)).signers(&[0, 1, 2]).age(30)));
    h.mint_at(CHAIN_ETHEREUM, 1, &r(300), &[0, 1, 2], 30).unwrap();
    // Refill stops at the ceiling.
    h.mint_at(CHAIN_ETHEREUM, 2, &r(1_000), &[0, 1, 2], 1_000_000).unwrap();
    assert_eq!(h.state.bucket, 0);
}

#[test]
fn a_claimed_age_must_be_covered_by_the_inputs_sequence() {
    let h = Harness::launch();
    let r = vec![Recipient::schnorr(&key(0xa1), 1_000)];
    // More age than the input's relative lock proves.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2]).age(100).sequence(99)));
    // A negative age, and one past a relative lock's 32 bits, whatever the sequence.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2]).age(-1).signed_age(0).sequence(u32::MAX as u64)));
    for age in [1i64 << 32, (1i64 << 32) + 5] {
        rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2]).age(age).sequence(u32::MAX as u64)));
    }
}

/// The finding: a clock the signers name could be advanced a little at a time, so that after a
/// quiet stretch three stolen keys drew many refill periods at once. The age is consumed by the
/// spend: however long the minter stood, one spend refills one ceiling, and the next starts at zero.
#[test]
fn idle_time_refills_the_allowance_only_once() {
    let mut h = Harness::launch_with(|s| {
        s.capacity = 1_000;
        s.bucket = 0;
        s.refill_per_daa = 10;
    });
    let r = |amount| vec![Recipient::schnorr(&key(0xa1), amount)];
    // 100 refill periods of idle time still give one ceiling.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r(1_001)).signers(&[0, 1, 2]).age(10_000)));
    h.mint_at(CHAIN_ETHEREUM, 0, &r(1_000), &[0, 1, 2], 10_000).unwrap();
    assert_eq!(h.state.bucket, 0);
    // The successor's age starts at zero: with no age to claim, nothing has refilled.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 1, &r(1)).signers(&[0, 1, 2]).age(0)));
    // A claim must be proved by the input's sequence, which consensus checks against the new UTXO's own age.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 1, &r(100)).signers(&[0, 1, 2]).age(10).sequence(9)));
}

/// Round 7: the claimed age was not signed, so anyone could take a mint's signatures from the mempool and
/// resubmit it claiming no age: the mint went through and the refill since the last spend was thrown away.
#[test]
fn a_mint_can_not_be_resubmitted_claiming_another_age() {
    let h = Harness::launch_with(|s| {
        s.capacity = 1_000;
        s.bucket = 500;
        s.refill_per_daa = 10;
    });
    let r = vec![Recipient::schnorr(&key(0xa1), 500)];
    // Signed for an age of 40. Claiming less (the refill forfeited) or more is not what was signed.
    for claimed in [0, 39, 41] {
        rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2]).age(claimed).sequence(41).signed_age(40)));
    }
    let (_, next) = h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2]).age(40)).unwrap();
    assert_eq!(next.bucket, 400);
}

/// A mint that claims no age is always valid, and spends what the bucket holds.
#[test]
fn claiming_no_age_only_refills_nothing() {
    let mut h = Harness::launch_with(|s| {
        s.capacity = 1_000;
        s.bucket = 700;
        s.refill_per_daa = 10;
    });
    let r = vec![Recipient::schnorr(&key(0xa1), 700)];
    h.mint_at(CHAIN_ETHEREUM, 0, &r, &[0, 1, 2], 0).unwrap();
    assert_eq!(h.state.bucket, 0);
}

/// Governance settles the allowance too, or a rotation would forget what had refilled.
#[test]
fn a_governance_spend_settles_the_allowance() {
    let mut h = Harness::launch_with(|s| {
        s.capacity = 1_000;
        s.bucket = 400;
        s.refill_per_daa = 10;
    });
    h.govern(Govern::SetValue { value: MINTER_SOMPI }, &[0, 1, 2, 3]).unwrap();
    assert_eq!(h.state.bucket, 410, "the harness's governance claims an age of 1");
}

#[test]
fn hard_cap_can_not_be_exceeded() {
    let mut h = Harness::launch_with(|s| {
        s.remaining = 5_000;
        s.capacity = i64::MAX / 4;
        s.bucket = i64::MAX / 4;
    });
    let r = |amount| vec![Recipient::schnorr(&key(0xa1), amount)];
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r(5_001)).signers(&[0, 1, 2])));
    h.mint(CHAIN_ETHEREUM, 0, &r(5_000), &[0, 1, 2]).unwrap();
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 1, &r(1)).signers(&[0, 1, 2])));
}

#[test]
fn the_minter_keeps_its_kas_deposit() {
    let h = Harness::launch();
    let r = vec![Recipient::schnorr(&key(0xa1), 1_000)];
    let case = MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2]).minter_value(MINTER_SOMPI - 1);
    rejects(h.try_mint(case));
}

#[test]
fn the_successor_state_is_forced() {
    let h = Harness::launch();
    let r = vec![Recipient::schnorr(&key(0xa1), 1_000)];
    // A successor that "forgets" the deposit was minted.
    let case = MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2]).tamper(|next| next.nonce_ethereum = 0);
    rejects(h.try_mint(case));
    // A successor with its cap restored.
    let case = MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2]).tamper(|next| next.remaining = CAP);
    rejects(h.try_mint(case));
    // A successor with another signer set.
    let case = MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2]).tamper(|next| next.signer_set = [0x77; 32]);
    rejects(h.try_mint(case));
}

#[test]
fn the_guardian_pauses_and_the_signers_resume() {
    let mut h = Harness::launch();
    let r = vec![Recipient::schnorr(&key(0xa1), 1_000)];
    // Only the guardian can pause.
    rejects(h.try_pause(&key(0x99)));
    h.pause().expect("guardian pause");
    assert!(h.state.paused);
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2])));
    // A minting quorum of three can't undo the pause; four signers can.
    rejects(h.try_govern(Govern::Unpause, &[0, 1, 2]));
    h.govern(Govern::Unpause, &[0, 1, 2, 3]).expect("unpause");
    assert!(!h.state.paused);
    h.mint(CHAIN_ETHEREUM, 0, &r, &[0, 1, 2]).expect("mint after unpause");
}

// rc.16, from round 10 and the outside review of 10 November.

/// A governance signature never expires on its own. An unpause that four signers signed and never sent (a drill,
/// an incident where they decided to stay paused) was still good after a later pause: with three stolen keys and
/// that one file, a thief lifted the pause that was meant to stop them. A pause now moves the admin nonce.
#[test]
fn a_pause_voids_every_admin_signature_made_before_it() {
    let mut h = Harness::launch();
    h.pause().unwrap();
    let signed_at = h.state.admin_nonce;
    // Four signers sign an unpause, a raise of the limits and a rotation at this nonce, and send none of them.
    let raise = Govern::SetLimits { capacity: 900_000_000_000, refill_per_daa: 1_000_000 };
    let rotate = Govern::SetSigners { keys: (0x60..0x65).map(key).collect(), guardian: key(0x6f) };
    for action in [Govern::Unpause, raise.clone(), rotate.clone()] {
        assert!(h.try_govern_signed_at(action, &[0, 1, 2, 3], signed_at).is_ok(), "good while the nonce stands");
    }
    // The minter is unpaused by another action at that nonce... which already voids them; so take the other road:
    // a fresh harness where nothing is sent, the guardian pauses again later.
    let mut h = Harness::launch();
    let before_pause = h.state.admin_nonce;
    assert!(h.try_govern_signed_at(raise.clone(), &[0, 1, 2, 3], before_pause).is_ok());
    h.pause().unwrap();
    assert_eq!(h.state.admin_nonce, before_pause + 1, "the pause moved the admin nonce");
    for action in [Govern::Unpause, raise, rotate] {
        rejects(h.try_govern_signed_at(action, &[0, 1, 2, 3], before_pause));
    }
    // Signed anew, under this pause, the unpause works.
    h.govern(Govern::Unpause, &[0, 1, 2, 3]).expect("an unpause signed after the pause");
}

/// An unpause is for a paused minter only: one signed "in case" can't be spent on a running minter to burn a nonce.
#[test]
fn only_a_paused_minter_is_unpaused() {
    let mut h = Harness::launch();
    rejects(h.try_govern(Govern::Unpause, &[0, 1, 2, 3]));
    h.pause().unwrap();
    h.govern(Govern::Unpause, &[0, 1, 2, 3]).expect("unpause");
    rejects(h.try_govern(Govern::Unpause, &[0, 1, 2, 3]));
}

/// Four signers could set limits so large that every later step overflowed: no mint, no change, no recovery, for
/// good. The limits now have a ceiling, the lifetime cap.
#[test]
fn limits_above_the_lifetime_cap_are_refused() {
    const MAX: i64 = 1_000_000_000_000_000;
    let mut h = Harness::launch();
    rejects(h.try_govern(Govern::SetLimits { capacity: MAX + 1, refill_per_daa: 1 }, &[0, 1, 2, 3]));
    rejects(h.try_govern(Govern::SetLimits { capacity: 1, refill_per_daa: MAX + 1 }, &[0, 1, 2, 3]));
    rejects(h.try_govern(Govern::SetLimits { capacity: i64::MAX, refill_per_daa: 400_000_000_001 }, &[0, 1, 2, 3]));
    // At the ceiling itself the minter still works: limits can be changed back, and it mints.
    h.govern(Govern::SetLimits { capacity: MAX, refill_per_daa: MAX }, &[0, 1, 2, 3]).expect("the highest limits");
    h.govern(Govern::SetLimits { capacity: 500_000_000_000, refill_per_daa: 578_703 }, &[0, 1, 2, 3]).expect("and back");
    let r = [Recipient::schnorr(&key(0xa1), 1_000_000)];
    h.mint(CHAIN_ETHEREUM, 0, &r, &[0, 1, 2]).expect("a mint after both");
}

#[test]
fn governance_messages_are_single_use() {
    let mut h = Harness::launch();
    h.pause().unwrap();
    let signed_at = h.state.admin_nonce;
    h.govern(Govern::Unpause, &[0, 1, 2, 3]).unwrap();
    h.pause().unwrap();
    // The same unpause message, signed for the old admin nonce.
    rejects(h.try_govern_signed_at(Govern::Unpause, &[0, 1, 2, 3], signed_at));
}

#[test]
fn limits_need_four_signers() {
    let mut h = Harness::launch();
    let change = Govern::SetLimits { capacity: 42, refill_per_daa: 3 };
    rejects(h.try_govern(change.clone(), &[0, 1, 2]));
    h.govern(change, &[0, 1, 2, 4]).expect("set limits");
    assert_eq!((h.state.capacity, h.state.refill_per_daa), (42, 3));
    // The allowance was clamped to the new ceiling.
    assert_eq!(h.state.bucket, 42);
}

#[test]
fn signer_rotation_needs_four_and_takes_effect_at_once() {
    let mut h = Harness::launch();
    let new_keys: Vec<_> = (0x60..0x65).map(key).collect();
    let rotate = Govern::SetSigners { keys: new_keys.clone(), guardian: key(0x6f) };
    rejects(h.try_govern(rotate.clone(), &[0, 1, 2]));
    h.govern(rotate, &[1, 2, 3, 4]).expect("rotate");
    let r = vec![Recipient::schnorr(&key(0xa1), 1_000)];
    // The old set can no longer mint; the new one can.
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2])));
    h.signers = new_keys;
    h.guardian = key(0x6f);
    h.mint(CHAIN_ETHEREUM, 0, &r, &[0, 1, 2]).expect("mint with the new set");
    h.pause().expect("the new guardian pauses");
}

#[test]
fn a_nonce_can_be_skipped_by_four_signers() {
    let mut h = Harness::launch();
    let skip = Govern::SkipNonce { chain: CHAIN_BSC, nonce: 0 };
    rejects(h.try_govern(skip.clone(), &[0, 1, 2]));
    h.govern(skip, &[0, 1, 2, 3]).expect("skip");
    assert_eq!(h.state.nonce_bsc, 1);
    // Skipping again must name the current nonce.
    rejects(h.try_govern(Govern::SkipNonce { chain: CHAIN_BSC, nonce: 0 }, &[0, 1, 2, 3]));
    let r = vec![Recipient::schnorr(&key(0xa1), 1_000)];
    rejects(h.try_mint(MintCase::new(CHAIN_BSC, 0, &r).signers(&[0, 1, 2])));
    h.mint(CHAIN_BSC, 1, &r, &[0, 1, 2]).expect("next nonce");
}

#[test]
fn the_kas_deposit_changes_only_by_quorum() {
    let mut h = Harness::launch();
    rejects(h.try_govern(Govern::SetValue { value: MINTER_SOMPI * 2 }, &[0, 1]));
    rejects(h.try_govern(Govern::SetValue { value: MINTER_SOMPI * 2 }, &[0, 1, 2]));
    h.govern(Govern::SetValue { value: MINTER_SOMPI * 2 }, &[0, 1, 2, 3]).expect("raise deposit");
    assert_eq!(h.minter.utxo.amount, MINTER_SOMPI * 2);
}

/// Prints the compute budget each covenant input commits (nodes relay at most
/// 15 per input). Run with `--ignored --nocapture`.
#[test]
#[ignore]
fn report_compute_budgets() {
    fn budgets(tx: &kaspa_consensus_core::tx::Transaction) -> Vec<u16> {
        tx.inputs.iter().map(|i| i.compute_commit.compute_budget().unwrap_or(0)).collect()
    }
    for n in 1..=3 {
        let h = Harness::launch();
        let r: Vec<_> = (0..n).map(|i| Recipient::schnorr(&key(0xa0 + i as u8), 1_000)).collect();
        let (tx, _) = h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2])).unwrap();
        println!("mint with {n} recipient(s): budgets {:?}", budgets(&tx));
    }
    let mut h = Harness::launch();
    let alice = key(0xa1);
    let tx = h.mint(CHAIN_ETHEREUM, 0, &[Recipient::schnorr(&alice, 1_000)], &[0, 1, 2]).unwrap();
    let token = covenant_output(&tx, 1);
    let t1 = transfer(&token, &alice, 1_000, &[(xonly(&key(0xb0)), 1_000)]).unwrap();
    println!("KCC20 transfer 1->1: budgets {:?}", budgets(&t1));
    let t2 = transfer(&token, &alice, 1_000, &[(xonly(&key(0xb0)), 600), (xonly(&alice), 400)]).unwrap();
    println!("KCC20 transfer 1->2: budgets {:?}", budgets(&t2));
    let t3 = transfer(&token, &alice, 1_000, &[(xonly(&key(0xb0)), 300), (xonly(&alice), 300), (xonly(&key(0xb1)), 400)]).unwrap();
    println!("KCC20 transfer 1->3: budgets {:?}", budgets(&t3));
    let (p, _) = h.try_pause(&h.guardian.clone()).unwrap();
    println!("pause: budgets {:?}", budgets(&p));
    let (g, _) = h.try_govern(Govern::SetLimits { capacity: 10, refill_per_daa: 1 }, &[0, 1, 2, 3]).unwrap();
    println!("set_limits (4 signatures): budgets {:?}", budgets(&g));
}

// ── Recovery: two keys lost for good ───────────────────────────────────────────

const DELAY: i64 = 2_592_000;

fn new_signers() -> (Vec<Keypair>, Keypair) {
    ((0x60..0x65).map(key).collect(), key(0x6f))
}

fn proposal() -> Govern {
    let (keys, guardian) = new_signers();
    Govern::ProposeRecovery { keys, guardian }
}

#[test]
fn recovery_takes_three_signers_and_leaves_governance_alone() {
    let mut h = Harness::launch();
    rejects(h.try_govern(proposal(), &[0, 1]));
    rejects(h.try_govern(proposal(), &[0, 1, 2, 3]));
    h.govern(proposal(), &[0, 2, 4]).expect("three signers propose");
    assert!(h.state.recovery_pending);
    assert_eq!(h.state.recovery_nonce, 1);
    assert_eq!(h.state.admin_nonce, 0, "three keys must not move what four signers signed");
    // A governance action four signers signed at this admin nonce still goes through.
    h.govern(Govern::SetLimits { capacity: 42, refill_per_daa: 3 }, &[0, 1, 2, 3]).expect("still valid");
}

#[test]
fn recovery_waits_for_the_minter_to_stand_untouched() {
    let mut h = Harness::launch();
    h.govern(proposal(), &[0, 1, 2]).unwrap();
    rejects(h.try_execute_recovery(0, |_| {}));
    rejects(h.try_execute_recovery(DELAY as u64 - 1, |_| {}));
    h.execute_recovery(DELAY as u64).expect("after the wait");
    let (keys, guardian) = new_signers();
    assert!(!h.state.recovery_pending);
    assert_eq!(h.state.signer_set, signer_set_of(&keys));
    assert_eq!(h.state.guardian, xonly(&guardian));
    assert_eq!(h.state.admin_nonce, 1);
    assert_eq!(h.state.recovery_signer_set, [0; 32]);
}

#[test]
fn a_recovered_set_can_lift_a_pause_nothing_else_could() {
    let mut h = Harness::launch();
    h.pause().unwrap();
    // Two keys lost: three left can't reach four.
    rejects(h.try_govern(Govern::Unpause, &[0, 1, 2]));
    h.govern(proposal(), &[0, 1, 2]).expect("a paused minter can still recover");
    h.execute_recovery(DELAY as u64).expect("execute");
    let r = vec![Recipient::schnorr(&key(0xa1), 1_000)];
    rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r).signers(&[0, 1, 2])));
    let (keys, guardian) = new_signers();
    h.signers = keys;
    h.guardian = guardian;
    assert!(h.state.paused, "execution doesn't resume anything by itself");
    h.govern(Govern::Unpause, &[0, 1, 2, 3]).expect("the new set resumes");
    h.mint(CHAIN_ETHEREUM, 0, &r, &[0, 1, 2]).expect("and mints");
}

#[test]
fn one_signer_vetoes_a_recovery() {
    let mut h = Harness::launch();
    h.govern(proposal(), &[0, 1, 2]).unwrap();
    rejects(h.try_govern(Govern::VetoRecovery, &[]));
    h.govern(Govern::VetoRecovery, &[3]).expect("one signer is enough");
    assert!(!h.state.recovery_pending);
    assert_eq!(h.state.signer_set, signer_set_of(&h.signers));
    assert_eq!(h.state.admin_nonce, 0);
    rejects(h.try_execute_recovery(DELAY as u64, |_| {}));
    rejects(h.try_govern(Govern::VetoRecovery, &[4]));
}

#[test]
fn a_key_outside_the_set_can_not_veto() {
    let mut h = Harness::launch();
    h.govern(proposal(), &[0, 1, 2]).unwrap();
    let digest_key = key(0x99);
    let mut outsider = h.signers.clone();
    outsider[3] = digest_key;
    let saved = std::mem::replace(&mut h.signers, outsider);
    rejects(h.try_govern(Govern::VetoRecovery, &[3]));
    h.signers = saved;
}

#[test]
fn one_recovery_at_a_time_and_nothing_replays() {
    let mut h = Harness::launch();
    let signed_at = h.state.recovery_nonce;
    h.govern(proposal(), &[0, 1, 2]).unwrap();
    // A second proposal while one stands is refused: a veto comes first.
    rejects(h.try_govern(proposal(), &[0, 1, 2]));
    let veto_at = h.state.recovery_nonce;
    h.govern(Govern::VetoRecovery, &[4]).unwrap();
    // The old proposal's signatures, and the old veto's, are dead.
    rejects(h.try_govern_signed_at(proposal(), &[0, 1, 2], signed_at));
    h.govern(proposal(), &[0, 1, 2]).expect("a fresh proposal, at the new nonce");
    rejects(h.try_govern_signed_at(Govern::VetoRecovery, &[4], veto_at));
    h.govern(Govern::VetoRecovery, &[4]).expect("a fresh veto");
}

#[test]
fn a_proposal_signature_is_not_a_governance_signature() {
    let mut h = Harness::launch();
    // Three signatures over action 3 (set_signers) at the recovery nonce: not a proposal.
    let (keys, guardian) = new_signers();
    rejects(h.try_govern(Govern::SetSigners { keys, guardian }, &[0, 1, 2]));
    assert_eq!(h.state.recovery_nonce, 0);
    h.govern(proposal(), &[0, 1, 2]).unwrap();
}

#[test]
fn execute_needs_a_proposal_and_changes_only_what_it_says() {
    let mut h = Harness::launch();
    rejects(h.try_execute_recovery(DELAY as u64, |_| {}));
    h.govern(proposal(), &[0, 1, 2]).unwrap();
    rejects(h.try_execute_recovery(DELAY as u64, |n| n.signer_set = [0x55; 32]));
    rejects(h.try_execute_recovery(DELAY as u64, |n| n.guardian = [0x55; 32]));
    rejects(h.try_execute_recovery(DELAY as u64, |n| n.remaining += 1));
    rejects(h.try_execute_recovery(DELAY as u64, |n| n.nonce_ethereum += 1));
    rejects(h.try_execute_recovery(DELAY as u64, |n| n.paused = true));
    rejects(h.try_execute_recovery(DELAY as u64, |n| n.recovery_pending = true));
    rejects(h.try_execute_recovery(DELAY as u64, |n| n.recovery_delay = 1));
    h.execute_recovery(DELAY as u64).expect("the honest successor");
}

#[test]
fn four_signers_rotating_ends_a_recovery() {
    let mut h = Harness::launch();
    h.govern(proposal(), &[0, 1, 2]).unwrap();
    let (keys, guardian) = new_signers();
    h.govern(Govern::SetSigners { keys, guardian }, &[0, 1, 2, 3]).expect("four can rotate at once");
    assert!(!h.state.recovery_pending);
    assert_eq!(h.state.recovery_signer_set, [0; 32]);
    rejects(h.try_execute_recovery(DELAY as u64, |_| {}));
}

#[test]
fn a_mint_carries_the_proposal_and_restarts_the_wait() {
    let mut h = Harness::launch();
    h.govern(proposal(), &[0, 1, 2]).unwrap();
    let r = vec![Recipient::schnorr(&key(0xa1), 1_000)];
    h.mint(CHAIN_ETHEREUM, 0, &r, &[0, 1, 2]).expect("mints go on");
    assert!(h.state.recovery_pending, "the proposal stands");
    // The new minter UTXO has its own age: consensus will hold the execution back from now.
    h.execute_recovery(DELAY as u64).expect("the script asks only for the sequence");
}

#[test]
fn the_guardian_can_not_restart_the_wait_on_a_paused_minter() {
    let mut h = Harness::launch();
    h.pause().unwrap();
    rejects(h.try_pause(&h.guardian.clone()));
}
