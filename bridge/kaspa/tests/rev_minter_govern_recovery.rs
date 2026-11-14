//! Review r16/rev-minter, properties 4 (governance, the new pause rule), 5 (recovery), 6 (liveness) and
//! 8 (launch) of BridgeMint, in the script engine.
//!
//!   cargo test --locked --test rev_minter_govern_recovery -- --nocapture

mod common;
mod rev_minter_kit;

use kaspa_consensus_core::hashing::covenant_id::covenant_id;
use kaspa_consensus_core::tx::Transaction;
use secp256k1::Keypair;
use serde_json::json;
use rev_minter_kit::*;

fn one(amount: i64) -> Vec<Recipient> {
    vec![Recipient::schnorr(&key(0xa1), amount)]
}

fn limits(c: i64, r: i64) -> Vec<u8> {
    [le8(c), le8(r)].concat()
}

fn skip(chain: u8, nonce: i64) -> Vec<u8> {
    [vec![chain], le8(nonce).to_vec()].concat()
}

fn rotation(keys: &[Keypair], guardian: &Keypair) -> Vec<u8> {
    [signer_set_of(keys).to_vec(), xonly(guardian).to_vec()].concat()
}

fn new_keys() -> Vec<Keypair> {
    (0x30..0x35).map(key).collect()
}

/// The quorum for `action` signed now, for the state the harness holds, by the first signers.
fn sign_now(h: &Harness, action: u8, params: &[u8]) -> Quorum {
    let who: Vec<usize> = (0..quorum_of(action)).collect();
    Quorum::honest(&h.signers, &who, &digest_for(h, signed_nonce(&h.state, action), action, params))
}

/// The action with a quorum signed earlier (or by others), offering the model's successor for the present state.
fn govern_with(h: &Harness, action: u8, params: &[u8], q: &Quorum) -> Result<Transaction, Rejected> {
    let v = model_govern(&h.state, action, params, 0, 0, h.minter.utxo.amount);
    build_govern(h, action, params, 0, 0, q, &v.next, v.value)
}

/// The honest action with a bent successor.
fn govern_bent(h: &Harness, action: u8, params: &[u8], bend: impl Fn(&mut MinterState)) -> Result<Transaction, Rejected> {
    let v = model_govern(&h.state, action, params, 0, 0, h.minter.utxo.amount);
    let mut next = v.next.clone();
    bend(&mut next);
    build_govern(h, action, params, 0, 0, &sign_now(h, action, params), &next, v.value)
}

fn step(t: &mut Tally, h: &mut Harness, what: &str, action: u8, params: &[u8]) {
    let (r, v) = honest_govern(h, action, params, 0);
    let tx = t.control(what, r);
    adopt(h, &tx, v.next);
}

fn pause_step(t: &mut Tally, h: &mut Harness, by: &Keypair) {
    let v = model_pause(&h.state, 0, h.minter.utxo.amount);
    let tx = t.control("pause", build_pause(h, by, 0, &v.next, v.value));
    adopt(h, &tx, v.next);
}

fn try_pause(h: &Harness, by: &Keypair) -> Result<Transaction, Rejected> {
    let v = model_pause(&h.state, 0, h.minter.utxo.amount);
    build_pause(h, by, 0, &v.next, v.value)
}

fn try_execute(h: &Harness, sequence: u64) -> Result<Transaction, Rejected> {
    let v = model_execute(&h.state, sequence, h.minter.utxo.amount);
    build_execute(h, sequence, &v.next, v.value)
}

fn pending(delay: i64) -> impl FnOnce(&mut MinterState) {
    move |s| {
        s.recovery_pending = true;
        s.recovery_signer_set = signer_set_of(&new_keys());
        s.recovery_guardian = xonly(&key(0x36));
        s.recovery_delay = delay;
    }
}

// ---------------------------------------------------------------------------------------------
// Property 4: governance.

#[test]
fn p4_every_entry_moves_its_nonces_exactly_as_specified() {
    let mut t = Tally::default();
    let busy = Harness::launch_with(|s| {
        pending(10)(s);
        s.paused = true;
        s.admin_nonce = 4;
        s.recovery_nonce = 2;
    });
    let idle = Harness::launch_with(|s| {
        s.admin_nonce = 4;
        s.recovery_nonce = 2;
    });
    let rotate = rotation(&new_keys(), &key(0x36));
    // (state, action, params, admin nonce step, recovery nonce step)
    let table: Vec<(&Harness, u8, Vec<u8>, i64, i64)> = vec![
        (&busy, 0x01, vec![], 1, 0),
        (&busy, 0x02, limits(1_000, 1), 1, 0),
        (&busy, 0x03, rotate.clone(), 1, 1),
        (&busy, 0x04, skip(CHAIN_ETHEREUM, 0), 1, 0),
        (&busy, 0x05, le8(MINTER_SOMPI as i64 + 9).to_vec(), 1, 0),
        (&idle, 0x06, rotate.clone(), 0, 1),
        (&busy, 0x07, vec![], 0, 1),
    ];
    for (h, action, params, admin, recovery) in &table {
        let v = model_govern(&h.state, *action, params, 0, 0, MINTER_SOMPI);
        assert_eq!((v.next.admin_nonce - h.state.admin_nonce, v.next.recovery_nonce - h.state.recovery_nonce), (*admin, *recovery), "the model follows SPEC §6 for action {action}");
        t.control("the action", honest_govern(h, *action, params, 0).0);
        for d in [-1i64, 1, 2] {
            t.refused("the admin nonce off by one", govern_bent(h, *action, params, |s| s.admin_nonce += d));
            t.refused("the recovery nonce off by one", govern_bent(h, *action, params, |s| s.recovery_nonce += d));
        }
    }
    // What each recovery-touching action must leave in the recovery fields.
    t.refused("set_signers leaving the proposal pending", govern_bent(&busy, 0x03, &rotate, |s| s.recovery_pending = true));
    t.refused("set_signers leaving the proposed set", govern_bent(&busy, 0x03, &rotate, |s| s.recovery_signer_set = [3; 32]));
    t.refused("a veto leaving the proposal pending", govern_bent(&busy, 0x07, &[], |s| s.recovery_pending = true));
    t.refused("a veto leaving the proposed guardian", govern_bent(&busy, 0x07, &[], |s| s.recovery_guardian = [3; 32]));
    t.refused("a proposal not marked pending", govern_bent(&idle, 0x06, &rotate, |s| s.recovery_pending = false));
    t.refused("a proposal recording another set", govern_bent(&idle, 0x06, &rotate, |s| s.recovery_signer_set = [3; 32]));
    t.refused("a proposal replacing the signers at once", govern_bent(&idle, 0x06, &rotate, |s| s.signer_set = signer_set_of(&new_keys())));
    for action in [0x01u8, 0x02, 0x04, 0x05] {
        let params = table.iter().find(|r| r.1 == action).unwrap().2.clone();
        t.refused("a plain action dropping the proposal", govern_bent(&busy, action, &params, |s| {
            s.recovery_pending = false;
            s.recovery_signer_set = [0; 32];
            s.recovery_guardian = [0; 32];
        }));
        t.refused("a plain action replacing the signers", govern_bent(&busy, action, &params, |s| s.signer_set = [9; 32]));
        t.refused("a plain action replacing the guardian", govern_bent(&busy, action, &params, |s| s.guardian = [9; 32]));
        t.refused("a plain action changing the recovery delay", govern_bent(&busy, action, &params, |s| s.recovery_delay = 0));
    }
    // pause and execute_recovery.
    let v = model_pause(&idle.state, 0, MINTER_SOMPI);
    assert_eq!((v.next.admin_nonce, v.next.recovery_nonce), (5, 2), "a pause moves the admin nonce (9049f02)");
    t.control("pause", build_pause(&idle, &idle.guardian, 0, &v.next, v.value));
    for bend in [
        (|s: &mut MinterState| s.admin_nonce -= 1) as fn(&mut MinterState),
        |s| s.admin_nonce += 1,
        |s| s.recovery_nonce += 1,
        |s| s.paused = false,
        |s| s.bucket += 1,
        |s| s.guardian = [9; 32],
        |s| s.signer_set = [9; 32],
    ] {
        let mut next = v.next.clone();
        bend(&mut next);
        t.refused("a pause with another successor", build_pause(&idle, &idle.guardian, 0, &next, v.value));
    }
    t.refused("a pause changing the minter's value", build_pause(&idle, &idle.guardian, 0, &v.next, v.value - 1));
    let v = model_execute(&busy.state, 10, MINTER_SOMPI);
    assert_eq!((v.next.admin_nonce, v.next.recovery_nonce), (5, 3));
    t.control("execute_recovery", build_execute(&busy, 10, &v.next, v.value));
    for bend in [
        (|s: &mut MinterState| s.admin_nonce -= 1) as fn(&mut MinterState),
        |s| s.admin_nonce += 1,
        |s| s.recovery_nonce -= 1,
        |s| s.recovery_nonce += 1,
        |s| s.paused = false,
        |s| s.recovery_pending = true,
        |s| s.signer_set = [9; 32],
        |s| s.guardian = [9; 32],
        |s| s.recovery_signer_set = [9; 32],
        |s| s.bucket = 0,
        |s| s.nonce_ethereum += 1,
    ] {
        let mut next = v.next.clone();
        bend(&mut next);
        t.refused("execute_recovery with another successor", build_execute(&busy, 10, &next, v.value));
    }
    t.refused("execute_recovery changing the minter's value", build_execute(&busy, 10, &v.next, v.value + 1));
    t.report("p4 nonces and successors");
    assert_eq!((t.refused, t.controls), (42 + 7 + 16 + 8 + 12, 9));
}

#[test]
fn p4_what_a_pause_voids_and_what_it_leaves_standing() {
    let mut t = Tally::default();
    let mut h = Harness::launch_with(|s| {
        s.admin_nonce = 3;
        s.recovery_nonce = 2;
    });
    let rotate = rotation(&new_keys(), &key(0x36));
    // Signed before the pause, at admin nonce 3 (and, for the proposal, recovery nonce 2).
    let admin: Vec<(u8, Vec<u8>)> = vec![
        (0x02, limits(MAX_LIMIT, MAX_LIMIT)),
        (0x03, rotate.clone()),
        (0x04, skip(CHAIN_ETHEREUM, 0)),
        (0x05, le8(MINTER_SOMPI as i64 + 9).to_vec()),
    ];
    let signed_before: Vec<Quorum> = admin.iter().map(|(a, p)| sign_now(&h, *a, p)).collect();
    let unpause_before = sign_now(&h, 0x01, &[]);
    let proposal_before = sign_now(&h, 0x06, &rotate);
    let r = one(1_000);
    let mint_before = Quorum::honest(&h.signers, &[0, 1, 2], &mint_digest(&cov(&h), CHAIN_ETHEREUM, 0, 0, &r));
    let mint_with = |h: &Harness, q: &Quorum| {
        let v = model_mint(&h.state, CHAIN_ETHEREUM, 0, 0, 0, &r, h.minter.utxo.amount);
        build_mint(h, CHAIN_ETHEREUM, 0, 0, 0, &r, q, &v.next, v.value, &r)
    };
    for ((a, p), q) in admin.iter().zip(&signed_before) {
        t.control("signed and good before the pause", govern_with(&h, *a, p, q));
    }
    t.control("the mint before the pause", mint_with(&h, &mint_before));
    t.control("the proposal before the pause", govern_with(&h, 0x06, &rotate, &proposal_before));
    // An unpause signed while the minter is not paused is not usable now ...
    t.refused("an unpause of a minter that is not paused", govern_with(&h, 0x01, &[], &unpause_before));

    pause_step(&mut t, &mut h, &key(0x20));
    assert_eq!((h.state.admin_nonce, h.state.recovery_nonce, h.state.paused), (4, 2, true));
    // ... and not after the pause either: this is what 9049f02 is for.
    t.refused("the unpause signed before the pause", govern_with(&h, 0x01, &[], &unpause_before));
    for ((a, p), q) in admin.iter().zip(&signed_before) {
        t.refused("a 4-of-5 action signed before the pause", govern_with(&h, *a, p, q));
    }
    t.refused("a mint while paused", mint_with(&h, &mint_before));
    // NOT voided by the pause: a recovery proposal (its nonce is the recovery nonce).
    let standing = govern_with(&h, 0x06, &rotate, &proposal_before);
    println!("[p4 pause] a recovery proposal signed before the pause, sent while paused: {}", verdict_text(&standing));
    assert!(standing.is_ok());

    // The signers sign again at the new nonce: everything works while paused, the guardian cannot interfere.
    t.refused("a second pause", try_pause(&h, &key(0x20)));
    for (a, p) in &admin {
        t.control("signed again after the pause", honest_govern(&h, *a, p, 0).0);
    }
    step(&mut t, &mut h, "unpause, signed after the pause", 0x01, &[]);
    assert_eq!((h.state.admin_nonce, h.state.paused), (5, false));
    for ((a, p), q) in admin.iter().zip(&signed_before) {
        t.refused("a 4-of-5 action signed before the pause, after the unpause", govern_with(&h, *a, p, q));
    }
    t.refused("the old unpause after the unpause", govern_with(&h, 0x01, &[], &unpause_before));
    // NOT voided by the pause and the unpause: a mint signed before them, and the recovery proposal.
    let mint_after = mint_with(&h, &mint_before);
    println!("[p4 pause] a mint signed before the pause, sent after the unpause: {}", verdict_text(&mint_after));
    assert!(mint_after.is_ok());
    let proposal_after = govern_with(&h, 0x06, &rotate, &proposal_before);
    println!("[p4 pause] a recovery proposal signed before the pause, sent after the unpause: {}", verdict_text(&proposal_after));
    assert!(proposal_after.is_ok());

    // A veto signed for a pending proposal also survives a pause.
    let mut hv = Harness::launch_with(pending(1_000));
    let veto_before = sign_now(&hv, 0x07, &[]);
    pause_step(&mut t, &mut hv, &key(0x20));
    t.control("a veto signed before the pause", govern_with(&hv, 0x07, &[], &veto_before));
    t.report("p4 what a pause voids");
    assert_eq!((t.refused, t.controls), (1 + 1 + 4 + 1 + 1 + 4 + 1, 4 + 2 + 1 + 4 + 1 + 1 + 1));
}

#[test]
fn p4_a_pause_is_the_guardians_alone_and_cannot_be_replayed() {
    let mut t = Tally::default();
    let mut h = Harness::launch();
    let guardian = key(0x20);
    let first = t.control("the guardian pauses", try_pause(&h, &guardian));
    let first_signature = argument(&first, 0);
    assert_eq!(first_signature.len(), 65);
    t.refused("a signer pauses", try_pause(&h, &h.signers[0]));
    t.refused("a stranger pauses", try_pause(&h, &key(0x77)));
    // The signature with another sighash type byte, or cut short.
    for bend in [0x02u8, 0x04, 0x81, 0x00] {
        let mut sig = first_signature.clone();
        sig[64] = bend;
        t.refused("the pause signature under another sighash type", run(with_argument(&first, 0, sig), vec![h.minter.utxo.clone()]));
    }
    t.refused("an empty pause signature", run(with_argument(&first, 0, vec![]), vec![h.minter.utxo.clone()]));

    let v = model_pause(&h.state, 0, MINTER_SOMPI);
    adopt(&mut h, &first, v.next);
    t.refused("the guardian pauses a paused minter", try_pause(&h, &guardian));
    step(&mut t, &mut h, "unpause", 0x01, &[]);
    // The minter is unpaused again, on a new coin. The first pause's signature is for the first transaction.
    let second = t.control("the guardian pauses again, with a new signature", try_pause(&h, &guardian));
    assert_ne!(argument(&second, 0), first_signature);
    t.refused("the first pause's signature on the second pause", run(with_argument(&second, 0, first_signature.clone()), vec![h.minter.utxo.clone()]));
    t.report("p4 pause authority and replay");
    assert_eq!((t.refused, t.controls), (9, 3));
}

#[test]
fn p4_a_guardian_can_void_one_batch_per_unpause_and_cannot_block_governance() {
    let mut t = Tally::default();
    let mut h = Harness::launch();
    let old_guardian = key(0x20);
    let new_guardian = key(0x36);
    let replace_guardian = rotation(&h.signers.clone(), &new_guardian);
    // The signers sign the guardian's replacement at nonce 0; the guardian sees it and pauses first.
    let signed = sign_now(&h, 0x03, &replace_guardian);
    t.control("the replacement would have passed", govern_with(&h, 0x03, &replace_guardian, &signed));
    pause_step(&mut t, &mut h, &old_guardian);
    t.refused("the replacement signed before the pause", govern_with(&h, 0x03, &replace_guardian, &signed));
    // Paused: the guardian has no second move, whatever the signers do next.
    t.refused("the guardian pauses again", try_pause(&h, &old_guardian));
    step(&mut t, &mut h, "the replacement, signed again", 0x03, &replace_guardian);
    assert_eq!(h.state.guardian, xonly(&new_guardian));
    t.refused("the old guardian on the paused minter", try_pause(&h, &old_guardian));
    step(&mut t, &mut h, "unpause", 0x01, &[]);
    t.refused("the old guardian after the unpause", try_pause(&h, &old_guardian));
    t.control("the new guardian can pause", try_pause(&h, &new_guardian));
    assert_eq!(h.state.admin_nonce, 3, "one pause, one replacement, one unpause");

    // A guardian that is NOT replaced: every unpause can be answered by a pause, each costing the signers a new
    // 4-of-5 unpause; while paused, the signers' other actions always pass.
    let mut h = Harness::launch();
    for round in 0..3 {
        pause_step(&mut t, &mut h, &old_guardian);
        t.refused("a second pause in the same round", try_pause(&h, &old_guardian));
        step(&mut t, &mut h, "limits while paused", 0x02, &limits(1_000 + round, 1));
        step(&mut t, &mut h, "unpause", 0x01, &[]);
    }
    assert_eq!(h.state.admin_nonce, 9);
    t.report("p4 guardian cycles");
    assert_eq!((t.refused, t.controls), (4 + 3, 1 + 1 + 1 + 1 + 1 + 9));
}

#[test]
fn p4_unpause_limits_skip_value_and_rotation() {
    let mut t = Tally::default();
    // unpause: only when paused.
    let idle = Harness::launch();
    let paused = Harness::launch_with(|s| s.paused = true);
    t.refused("an unpause of a minter that is not paused", honest_govern(&idle, 0x01, &[], 0).0);
    t.control("an unpause of a paused minter", honest_govern(&paused, 0x01, &[], 0).0);
    t.refused("an unpause that leaves it paused", govern_bent(&paused, 0x01, &[], |s| s.paused = true));

    // set_limits: within the ceiling, each value on its own.
    for (c, r) in [(MAX_LIMIT, MAX_LIMIT), (MAX_LIMIT, 0), (0, MAX_LIMIT), (0, 0), (1, 1), (500_000_000_000, 578_703)] {
        t.control("limits within the ceiling", honest_govern(&idle, 0x02, &limits(c, r), 0).0);
    }
    for (c, r) in [(MAX_LIMIT + 1, 1), (1, MAX_LIMIT + 1), (MAX_LIMIT + 1, MAX_LIMIT + 1), (i64::MAX, 1), (1, i64::MAX), (1 << 62, 1 << 62)] {
        t.refused("a limit above the ceiling", honest_govern(&idle, 0x02, &limits(c, r), 0).0);
    }
    for (c, r) in [(-1i64, 1i64), (1, -1), (-MAX_LIMIT, 1), (i64::MIN + 1, 1)] {
        let params = [sm8(c), sm8(r)].concat();
        let v = model_govern(&idle.state, 0x02, &params, 0, 0, MINTER_SOMPI);
        assert!(v.accept.is_err());
        t.refused("a negative limit, signed as such", build_govern(&idle, 0x02, &params, 0, 0, &sign_now(&idle, 0x02, &params), &v.next, v.value));
    }
    // A negative zero is zero to the script (four signers would have to sign that spelling).
    let neg_zero = [vec![0, 0, 0, 0, 0, 0, 0, 0x80], le8(1).to_vec()].concat();
    let v = model_govern(&idle.state, 0x02, &neg_zero, 0, 0, MINTER_SOMPI);
    let observed = build_govern(&idle, 0x02, &neg_zero, 0, 0, &sign_now(&idle, 0x02, &neg_zero), &v.next, v.value);
    println!("[p4 limits] a capacity spelled as negative zero, signed as such (successor capacity 0): {}", verdict_text(&observed));
    assert_eq!(observed.is_ok(), v.accept.is_ok());
    t.refused("limits that keep the old capacity", govern_bent(&idle, 0x02, &limits(1_000, 1), |s| s.capacity = 500_000_000_000));
    t.refused("limits that keep the bucket above the new ceiling", govern_bent(&idle, 0x02, &limits(1_000, 1), |s| s.bucket = 500_000_000_000));

    // skip_nonce: the current nonce of the chain named, once.
    let mut h = Harness::launch_with(|s| {
        s.nonce_ethereum = 5;
        s.nonce_bsc = 9;
    });
    for (chain, nonce) in [(CHAIN_ETHEREUM, 4i64), (CHAIN_ETHEREUM, 6), (CHAIN_ETHEREUM, 9), (CHAIN_BSC, 5), (CHAIN_BSC, 10), (0, 5), (3, 5), (0xff, 9)] {
        t.refused("a skip of another nonce or chain", honest_govern(&h, 0x04, &skip(chain, nonce), 0).0);
    }
    t.control("a skip of BSC's nonce", honest_govern(&h, 0x04, &skip(CHAIN_BSC, 9), 0).0);
    t.refused("a skip that moves the other chain", govern_bent(&h, 0x04, &skip(CHAIN_ETHEREUM, 5), |s| {
        s.nonce_ethereum = 5;
        s.nonce_bsc = 10;
    }));
    t.refused("a skip of two nonces", govern_bent(&h, 0x04, &skip(CHAIN_ETHEREUM, 5), |s| s.nonce_ethereum = 7));
    let mint_five = Quorum::honest(&h.signers, &[0, 1, 2], &mint_digest(&cov(&h), CHAIN_ETHEREUM, 5, 0, &one(1_000)));
    step(&mut t, &mut h, "skip Ethereum's nonce 5", 0x04, &skip(CHAIN_ETHEREUM, 5));
    assert_eq!(h.state.nonce_ethereum, 6);
    let v = model_mint(&h.state, CHAIN_ETHEREUM, 5, 0, 0, &one(1_000), MINTER_SOMPI);
    t.refused("a mint of the skipped nonce, signed before the skip", build_mint(&h, CHAIN_ETHEREUM, 5, 0, 0, &one(1_000), &mint_five, &v.next, v.value, &one(1_000)));
    t.control("a mint of the next nonce", honest_mint(&h, CHAIN_ETHEREUM, 6, 0, &one(1_000)).0);
    t.refused("the same skip again", honest_govern(&h, 0x04, &skip(CHAIN_ETHEREUM, 5), 0).0);

    // set_value: the minter's own KAS, and only by this action.
    for value in [1i64, MINTER_SOMPI as i64, MINTER_SOMPI as i64 * 50, 1] {
        t.control("a positive value", honest_govern(&idle, 0x05, &le8(value), 0).0);
    }
    for value in [0i64, -1, -(MINTER_SOMPI as i64)] {
        let params = sm8(value).to_vec();
        let v = model_govern(&idle.state, 0x05, &params, 0, 0, MINTER_SOMPI);
        t.refused("a value that is not positive", build_govern(&idle, 0x05, &params, 0, 0, &sign_now(&idle, 0x05, &params), &v.next, MINTER_SOMPI));
    }
    let params = le8(MINTER_SOMPI as i64 * 2).to_vec();
    let v = model_govern(&idle.state, 0x05, &params, 0, 0, MINTER_SOMPI);
    for offered in [MINTER_SOMPI, MINTER_SOMPI * 2 - 1, MINTER_SOMPI * 2 + 1] {
        t.refused("a successor holding another value than the one signed", build_govern(&idle, 0x05, &params, 0, 0, &sign_now(&idle, 0x05, &params), &v.next, offered));
    }
    for (action, params) in [(0x02u8, limits(1, 1)), (0x03, rotation(&new_keys(), &key(0x36))), (0x04, skip(CHAIN_ETHEREUM, 0)), (0x06, rotation(&new_keys(), &key(0x36)))] {
        let v = model_govern(&idle.state, action, &params, 0, 0, MINTER_SOMPI);
        t.refused("another action changing the minter's value", build_govern(&idle, action, &params, 0, 0, &sign_now(&idle, action, &params), &v.next, MINTER_SOMPI - 1));
    }

    // Rotation: the signers and the guardian change together, at once.
    let mut h = Harness::launch();
    let old = h.signers.clone();
    step(&mut t, &mut h, "rotation", 0x03, &rotation(&new_keys(), &key(0x36)));
    t.refused("the old signers after the rotation", honest_govern(&h, 0x02, &limits(1, 1), 0).0);
    h.signers = new_keys();
    t.control("the new signers govern", honest_govern(&h, 0x02, &limits(1, 1), 0).0);
    t.control("the new signers can rotate back", honest_govern(&h, 0x03, &rotation(&old, &key(0x20)), 0).0);
    t.report("p4 actions");
    assert_eq!((t.refused, t.controls), (2 + 6 + 4 + 2 + 8 + 2 + 2 + 3 + 3 + 4 + 1, 1 + 6 + 1 + 1 + 1 + 4 + 1 + 2));
}

// ---------------------------------------------------------------------------------------------
// Property 5: recovery.

#[test]
fn p5_recovery_waits_is_vetoed_by_one_and_dies_with_a_rotation() {
    let mut t = Tally::default();
    let delay = 1_000i64;
    let fresh = || Harness::launch_with(|s| s.recovery_delay = delay);
    let rotate = rotation(&new_keys(), &key(0x36));
    let other = rotation(&(0x50..0x55).map(key).collect::<Vec<_>>(), &key(0x56));

    // No proposal: nothing to execute, nothing to veto.
    let mut h = fresh();
    t.refused("execute with no proposal", try_execute(&h, delay as u64));
    t.refused("execute with no proposal, the longest wait", try_execute(&h, u32::MAX as u64));
    t.refused("a veto with no proposal", honest_govern(&h, 0x07, &[], 0).0);

    let proposal_signatures = sign_now(&h, 0x06, &rotate);
    step(&mut t, &mut h, "three propose", 0x06, &rotate);
    assert!(h.state.recovery_pending && h.state.recovery_nonce == 1 && h.state.admin_nonce == 0);
    // The wait.
    for seq in [0u64, 1, 999, SEQ_DISABLED | 1_000, SEQ_DISABLED | u32::MAX as u64, u64::MAX, (1 << 32) + 999] {
        t.refused("execute before the wait is over (or with a lock consensus does not check)", try_execute(&h, seq));
    }
    // The input's sequence is exactly the delay (`require_settled_inputs`): a longer lock is refused.
    for seq in [1_001u64, u32::MAX as u64, (1 << 32) + 1_000] {
        t.refused("execute with a lock longer than the delay", try_execute(&h, seq));
    }
    t.control("execute once the wait is over", try_execute(&h, 1_000));
    // One proposal at a time, by any quorum; the proposal's own signatures do not replay.
    t.refused("the same proposal again", govern_with(&h, 0x06, &rotate, &proposal_signatures));
    t.refused("the same proposal again, signed at the new nonce", honest_govern(&h, 0x06, &rotate, 0).0);
    t.refused("another proposal while one is pending", honest_govern(&h, 0x06, &other, 0).0);

    // Any one signer vetoes; not a stranger, not a key of the proposed set.
    for outsider in [key(0x77), key(0x30), key(0x36), key(0x20)] {
        let d = digest_for(&h, 1, 0x07, &[]);
        let mut keys = h.signers.clone();
        keys[0] = outsider;
        t.refused("a veto by a key outside the set", govern_with(&h, 0x07, &[], &Quorum::honest(&keys, &[0], &d)));
        let q = Quorum { keys: keys_of(&h.signers), indices: vec![0], signatures: vec![sign_digest(&outsider, &d)] };
        t.refused("a veto by a key outside the set, under a signer's position", govern_with(&h, 0x07, &[], &q));
    }
    let veto_signature = sign_now(&h, 0x07, &[]);
    let mut vetoed = fresh();
    step(&mut t, &mut vetoed, "propose", 0x06, &rotate);
    step(&mut t, &mut vetoed, "one signer vetoes", 0x07, &[]);
    assert!(!vetoed.state.recovery_pending && vetoed.state.recovery_nonce == 2 && vetoed.state.recovery_signer_set == [0; 32]);
    for seq in [1_000u64, u32::MAX as u64] {
        t.refused("execute after a veto", try_execute(&vetoed, seq));
    }
    t.refused("the vetoed proposal's signatures again", govern_with(&vetoed, 0x06, &rotate, &proposal_signatures));
    t.refused("the veto again", govern_with(&vetoed, 0x07, &[], &veto_signature));
    step(&mut t, &mut vetoed, "a new proposal after the veto", 0x06, &other);
    t.refused("the first veto's signature against the second proposal", govern_with(&vetoed, 0x07, &[], &veto_signature));
    t.control("a new veto against the second proposal", honest_govern(&vetoed, 0x07, &[], 0).0);

    // Four signers rotating end it.
    let mut rotated = fresh();
    step(&mut t, &mut rotated, "propose", 0x06, &rotate);
    step(&mut t, &mut rotated, "four signers rotate to a third set", 0x03, &other);
    assert!(!rotated.state.recovery_pending && rotated.state.recovery_nonce == 2);
    for seq in [1_000u64, u32::MAX as u64] {
        t.refused("execute after a rotation", try_execute(&rotated, seq));
    }
    t.refused("the old proposal after a rotation", govern_with(&rotated, 0x06, &rotate, &proposal_signatures));

    // Any other spend carries the proposal along (and, on chain, starts a new coin whose age starts at zero).
    for which in 0..4 {
        let mut h = fresh();
        step(&mut t, &mut h, "propose", 0x06, &rotate);
        match which {
            0 => {
                let (r, v) = honest_mint(&h, CHAIN_ETHEREUM, 0, 0, &one(1_000));
                let tx = t.control("a mint during the wait", r);
                adopt(&mut h, &tx, v.next);
            }
            1 => pause_step(&mut t, &mut h, &key(0x20)),
            2 => step(&mut t, &mut h, "limits during the wait", 0x02, &limits(1, 1)),
            _ => step(&mut t, &mut h, "a skip during the wait", 0x04, &skip(CHAIN_BSC, 0)),
        }
        assert!(h.state.recovery_pending && h.state.recovery_signer_set == signer_set_of(&new_keys()));
        t.refused("execute on the new coin before its own wait", try_execute(&h, 999));
        t.control("execute on the new coin after its own wait", try_execute(&h, 1_000));
    }
    // A paused minter cannot be paused again, so the guardian cannot restart the wait a second time.
    let mut h = Harness::launch_with(|s| {
        s.recovery_delay = delay;
        s.paused = true;
    });
    step(&mut t, &mut h, "propose while paused", 0x06, &rotate);
    t.refused("the guardian touches the paused minter", try_pause(&h, &key(0x20)));
    let v = model_execute(&h.state, 1_000, MINTER_SOMPI);
    let tx = t.control("execute while paused", build_execute(&h, 1_000, &v.next, v.value));
    adopt(&mut h, &tx, v.next);
    assert!(h.state.paused && h.state.signer_set == signer_set_of(&new_keys()) && h.state.guardian == xonly(&key(0x36)));
    h.signers = new_keys();
    t.control("the recovered set lifts the pause", honest_govern(&h, 0x01, &[], 0).0);
    t.report("p5 recovery");
    assert_eq!((t.refused, t.controls), (3 + 7 + 3 + 3 + 8 + 2 + 2 + 1 + 2 + 1 + 4 + 1, 1 + 1 + 2 + 1 + 1 + 2 + 4 * 3 + 1 + 1 + 1));
}

#[test]
fn p5_what_three_signers_can_force_when_nobody_vetoes() {
    // Three signers propose a set nobody holds the keys of. Nobody vetoes for the whole wait. Anyone executes.
    let mut t = Tally::default();
    let mut h = Harness::launch_with(|s| s.recovery_delay = 1_000);
    let dead = [[0u8; 32].to_vec(), [0u8; 32].to_vec()].concat();
    step(&mut t, &mut h, "three propose a set of zeros", 0x06, &dead);
    let v = model_execute(&h.state, 1_000, MINTER_SOMPI);
    let tx = t.control("anyone executes after the wait", build_execute(&h, 1_000, &v.next, v.value));
    adopt(&mut h, &tx, v.next);
    assert_eq!((h.state.signer_set, h.state.guardian), ([0; 32], [0; 32]));
    // The minter is now out of everyone's reach: the old signers' keys do not hash to the set.
    t.refused("a mint by the former signers", honest_mint(&h, CHAIN_ETHEREUM, 0, 0, &one(1)).0);
    for (action, params) in [(0x03u8, rotation(&h.signers.clone(), &key(0x20))), (0x06, rotation(&h.signers.clone(), &key(0x20))), (0x02, limits(1, 1))] {
        t.refused("governance by the former signers", honest_govern(&h, action, &params, 0).0);
    }
    t.refused("a pause by the former guardian", try_pause(&h, &key(0x20)));
    t.refused("execute again", try_execute(&h, u32::MAX as u64));
    t.report("p5 three signers and no veto");
    assert_eq!((t.refused, t.controls), (6, 2));
}

#[test]
fn p5_a_genesis_fixes_the_wait_for_good() {
    let mut t = Tally::default();
    let rotate = rotation(&new_keys(), &key(0x36));
    // A wait of zero: three signers take the set in two transactions.
    let mut h = Harness::launch_with(|s| s.recovery_delay = 0);
    step(&mut t, &mut h, "propose", 0x06, &rotate);
    t.control("execute at once under a wait of zero", try_execute(&h, 0));
    // A wait that no relative lock can express: the proposal can never be carried out.
    for delay in [1i64 << 32, i64::MAX, -1] {
        let mut h = Harness::launch_with(|s| s.recovery_delay = delay);
        step(&mut t, &mut h, "propose", 0x06, &rotate);
        for seq in [0u64, u32::MAX as u64, u64::MAX >> 1] {
            t.refused("execute under a wait outside 0..2^32", try_execute(&h, seq));
        }
    }
    // No entry changes the wait (each offered with a shorter one).
    let h = Harness::launch_with(|s| {
        pending(1_000)(s);
        s.paused = true;
    });
    for (action, params) in [(0x01u8, vec![]), (0x02, limits(1, 1)), (0x03, rotate.clone()), (0x04, skip(CHAIN_BSC, 0)), (0x05, le8(7).to_vec()), (0x07, vec![])] {
        t.refused("a governance action shortening the wait", govern_bent(&h, action, &params, |s| s.recovery_delay = 1));
    }
    let v = model_execute(&h.state, 1_000, MINTER_SOMPI);
    let mut shorter = v.next.clone();
    shorter.recovery_delay = 1;
    t.refused("execute_recovery shortening the next wait", build_execute(&h, 1_000, &shorter, v.value));
    t.control("execute_recovery keeping it", build_execute(&h, 1_000, &v.next, v.value));
    t.report("p5 the wait is fixed at genesis");
    assert_eq!((t.refused, t.controls), (9 + 6 + 1, 1 + 1 + 3 + 1));
}

// ---------------------------------------------------------------------------------------------
// Property 6: liveness.

#[test]
fn p6_four_signers_can_always_bring_a_reachable_state_back_to_minting() {
    let mut t = Tally::default();
    let big = 1i64 << 40;
    let states: Vec<(&str, Box<dyn Fn(&mut MinterState)>)> = vec![
        ("paused", Box::new(|s| s.paused = true)),
        ("a recovery pending", Box::new(|s| pending(1_000)(s))),
        ("paused with a recovery pending", Box::new(|s| {
            pending(1_000)(s);
            s.paused = true;
        })),
        ("limits of zero, an empty bucket", Box::new(|s| {
            s.capacity = 0;
            s.refill_per_daa = 0;
            s.bucket = 0;
        })),
        ("limits at the ceiling, paused", Box::new(|s| {
            s.capacity = MAX_LIMIT;
            s.refill_per_daa = MAX_LIMIT;
            s.bucket = MAX_LIMIT;
            s.paused = true;
        })),
        ("no refill, an empty bucket", Box::new(|s| {
            s.refill_per_daa = 0;
            s.bucket = 0;
        })),
        ("large nonces everywhere, paused, pending", Box::new(move |s| {
            pending(1_000)(s);
            s.paused = true;
            s.nonce_ethereum = big;
            s.nonce_bsc = big + 1;
            s.admin_nonce = big + 2;
            s.recovery_nonce = big + 3;
        })),
        ("one unit left under the lifetime cap", Box::new(|s| s.remaining = 3)),
    ];
    for (what, configure) in &states {
        let mut h = Harness::launch_with(|s| configure(s));
        // No mint of 3 units is possible in three of these states as they stand; four signers repair each.
        if h.state.recovery_pending {
            step(&mut t, &mut h, "veto", 0x07, &[]);
        }
        step(&mut t, &mut h, "limits", 0x02, &limits(500_000_000_000, 578_703));
        if h.state.paused {
            step(&mut t, &mut h, "unpause", 0x01, &[]);
        }
        step(&mut t, &mut h, "rotation (the largest governance message)", 0x03, &rotation(&new_keys(), &key(0x36)));
        h.signers = new_keys();
        let three = vec![Recipient::schnorr(&key(0xa1), 1), Recipient::schnorr(&key(0xa2), 1), Recipient::schnorr(&key(0xa3), 1)];
        let (r, v) = honest_mint(&h, CHAIN_ETHEREUM, h.state.nonce_ethereum, 1, &three);
        assert!(v.accept.is_ok(), "{what}");
        t.control(&format!("a mint of three recipients from: {what}"), r);
    }
    // Every number at its largest (a genesis-only state): the program's size and stack use do not depend on the
    // values, so the largest shapes still run.
    let top = (1i64 << 62) + 12_345;
    let mut h = Harness::launch_with(|s| {
        s.remaining = i64::MAX;
        s.capacity = MAX_LIMIT;
        s.bucket = MAX_LIMIT;
        s.refill_per_daa = MAX_LIMIT;
        s.nonce_ethereum = top;
        s.nonce_bsc = top;
        s.admin_nonce = top;
        s.recovery_nonce = top;
        s.recovery_delay = u32::MAX as i64;
    });
    let three = vec![Recipient::schnorr(&key(0xa1), MAX_LIMIT / 3), Recipient::schnorr(&key(0xa2), MAX_LIMIT / 3), Recipient::schnorr(&key(0xa3), MAX_LIMIT / 3)];
    t.control("the largest mint at the largest numbers", honest_mint(&h, CHAIN_BSC, top, u32::MAX as i64, &three).0);
    t.control("the largest governance message at the largest numbers", honest_govern(&h, 0x03, &rotation(&new_keys(), &key(0x36)), u32::MAX as i64).0);
    step(&mut t, &mut h, "a proposal at the largest numbers", 0x06, &rotation(&new_keys(), &key(0x36)));
    t.control("execute_recovery at the longest wait a lock can express", try_execute(&h, u32::MAX as u64));

    // Counters at the very top of a 64-bit number stop their entries (2^63 transactions away: not reachable).
    let h = Harness::launch_with(|s| {
        s.admin_nonce = i64::MAX;
        s.nonce_ethereum = i64::MAX;
    });
    // The successor offered keeps the counter (a wrapped one cannot even be written as a state).
    let mut next = model_pause(&h.state, 0, MINTER_SOMPI).next;
    next.admin_nonce = i64::MAX;
    t.refused("a pause at the last admin nonce", build_pause(&h, &key(0x20), 0, &next, MINTER_SOMPI));
    let mut next = model_govern(&h.state, 0x02, &limits(1, 1), 0, 0, MINTER_SOMPI).next;
    next.admin_nonce = i64::MAX;
    t.refused("governance at the last admin nonce", build_govern(&h, 0x02, &limits(1, 1), 0, 0, &sign_now(&h, 0x02, &limits(1, 1)), &next, MINTER_SOMPI));
    let mut next = model_mint(&h.state, CHAIN_ETHEREUM, i64::MAX, 0, 0, &one(1), MINTER_SOMPI).next;
    next.nonce_ethereum = i64::MAX;
    let q = Quorum::honest(&h.signers, &[0, 1, 2], &mint_digest(&cov(&h), CHAIN_ETHEREUM, i64::MAX, 0, &one(1)));
    t.refused("a mint at the last deposit nonce", build_mint(&h, CHAIN_ETHEREUM, i64::MAX, 0, 0, &one(1), &q, &next, MINTER_SOMPI, &one(1)));
    t.control("a mint on the other chain", honest_mint(&h, CHAIN_BSC, 0, 0, &one(1)).0);
    t.report("p6 liveness");
    assert!(t.refused == 3 && t.controls >= 8 * 3 + 5);
}

#[test]
fn p6_a_signer_set_with_one_key_five_times_is_one_signer() {
    // The script takes the new set as a hash: it cannot see whether its five keys differ. Four signers (or three,
    // by a recovery nobody vetoes) who install a set that repeats a key hand the quorum to that key's holder.
    // Whoever signs a rotation or a proposal has to check the five keys, not only their hash.
    let mut t = Tally::default();
    let mut h = Harness::launch();
    let lone = key(0x66);
    let same: Vec<Keypair> = vec![lone; 5];
    step(&mut t, &mut h, "four signers install a set of one key five times", 0x03, &rotation(&same, &key(0x20)));
    h.signers = same;
    t.control("one key mints alone", honest_mint(&h, CHAIN_ETHEREUM, 0, 0, &one(1_000)).0);
    t.control("one key governs alone", honest_govern(&h, 0x02, &limits(MAX_LIMIT, MAX_LIMIT), 0).0);
    // What the builders say to such a set (protocol.rs signer_set_of, used by `govern` and `signer-set`).
    let keys: Vec<String> = (0..5).map(|_| hex32(&xonly(&lone))).collect();
    let answer = api("signer-set", json!({ "signerKeys": keys }));
    println!("[p6 repeated key] the builders' signer-set for five equal keys: {}", match &answer {
        Ok(v) => format!("ACCEPTED, {}", v["signerSet"]),
        Err(e) => format!("refused: {e}"),
    });
    t.report("p6 a repeated key");
    assert_eq!(t.controls, 3);
}

// ---------------------------------------------------------------------------------------------
// Property 8: launch.

#[test]
fn p8_the_covenant_id_commits_to_exactly_the_genesis_outputs() {
    use argent_runtime::{TxContext, state};
    let signers: Vec<Keypair> = (0x10..0x15).map(key).collect();
    let guardian = key(0x20);
    let minter = MinterState {
        remaining: CAP,
        bucket: 500_000_000_000,
        capacity: 500_000_000_000,
        refill_per_daa: 578_703,
        nonce_ethereum: 0,
        nonce_bsc: 0,
        admin_nonce: 0,
        paused: false,
        signer_set: signer_set_of(&signers),
        guardian: xonly(&guardian),
        recovery_delay: 2_592_000,
        recovery_nonce: 0,
        recovery_pending: false,
        recovery_signer_set: [0; 32],
        recovery_guardian: [0; 32],
    };
    let seed = |owner: &Keypair| state! { owner: xonly(owner).to_vec(), extension_commitment: vec![0u8; 32] };
    // A genesis from `from`, with the minter, the seed, and optionally more family outputs.
    let launch = |from: u8, minter: &MinterState, minter_value: u64, seed_owner: &Keypair, extra: &[(&str, State)]| {
        let mut context = TxContext::new()
            .input(outpoint(from, 0), funding(), funding_sig(), 0)
            .actor_genesis_output(0, "launch::kusdt", "BridgeMint", minter.state(), minter_value)
            .actor_genesis_output(0, "launch::kusdt", "TokenSeed", seed(seed_owner), SEED_SOMPI);
        for (actor, state) in extra {
            context = context.actor_genesis_output(0, "launch::kusdt", *actor, state.clone(), TOKEN_SOMPI);
        }
        let tx = builder().build(&context).expect("a genesis builds");
        run(tx, vec![funding()]).expect("a genesis runs")
    };
    let id_of = |tx: &Transaction| tx.outputs[0].covenant.expect("bound").covenant_id;
    let honest = launch(0xf0, &minter, MINTER_SOMPI, &guardian, &[]);
    let honest_id = id_of(&honest);
    // The ID is consensus's hash of the authorizing outpoint and of every output bound to it: index, value, script.
    let recomputed = covenant_id(outpoint(0xf0, 0), [(0u32, &honest.outputs[0]), (1u32, &honest.outputs[1])].into_iter());
    assert_eq!(recomputed, honest_id);
    assert_eq!(honest.outputs.iter().filter(|o| o.covenant.is_some()).count(), 2);

    // The engine lets a genesis make anything, a token balance or a second minter included ...
    let rich = Recipient::schnorr(&key(0xee), 1_000_000_000_000);
    let mut other_minter = minter.clone();
    other_minter.signer_set = [9; 32];
    let mut different = Vec::new();
    for (what, extra) in [
        ("a pre-mined token balance", vec![("KCC20", rich.state())]),
        ("a second minter", vec![("BridgeMint", other_minter.state())]),
        ("a zero token state", vec![("KCC20", Recipient::schnorr(&key(0xee), 0).state())]),
    ] {
        let tx = launch(0xf0, &minter, MINTER_SOMPI, &guardian, &extra);
        assert_eq!(tx.outputs.iter().filter(|o| o.covenant.is_some()).count(), 3, "the engine accepted a genesis with {what}");
        // ... but its ID is another one: the ID recomputed from the minter and the seed alone does not match it.
        assert_ne!(id_of(&tx), honest_id, "{what}");
        assert_ne!(covenant_id(outpoint(0xf0, 0), [(0u32, &tx.outputs[0]), (1u32, &tx.outputs[1])].into_iter()), id_of(&tx), "{what}");
        different.push(id_of(&tx));
    }
    // Any change to what the two outputs carry, or to the coin the genesis spends, is another ID as well.
    let mut bent: Vec<(&str, Transaction)> = Vec::new();
    for (what, bend) in [
        ("other signers", (|s: &mut MinterState| s.signer_set = [9; 32]) as fn(&mut MinterState)),
        ("another guardian", |s| s.guardian = [9; 32]),
        ("a larger lifetime cap", |s| s.remaining += 1),
        ("a larger allowance ceiling", |s| s.capacity += 1),
        ("a faster refill", |s| s.refill_per_daa += 1),
        ("a fuller bucket", |s| s.bucket += 1),
        ("a later Ethereum nonce", |s| s.nonce_ethereum = 1),
        ("a later BSC nonce", |s| s.nonce_bsc = 1),
        ("a used admin nonce", |s| s.admin_nonce = 1),
        ("paused", |s| s.paused = true),
        ("a shorter recovery wait", |s| s.recovery_delay -= 1),
        ("a used recovery nonce", |s| s.recovery_nonce = 1),
        ("a recovery planted", |s| {
            s.recovery_pending = true;
            s.recovery_signer_set = [9; 32];
            s.recovery_guardian = [9; 32];
        }),
    ] {
        let mut m = minter.clone();
        bend(&mut m);
        bent.push((what, launch(0xf0, &m, MINTER_SOMPI, &guardian, &[])));
    }
    bent.push(("another minter value", launch(0xf0, &minter, MINTER_SOMPI + 1, &guardian, &[])));
    bent.push(("another seed owner", launch(0xf0, &minter, MINTER_SOMPI, &key(0x21), &[])));
    bent.push(("another coin spent", launch(0xf1, &minter, MINTER_SOMPI, &guardian, &[])));
    for (what, tx) in &bent {
        assert_ne!(id_of(tx), honest_id, "{what}");
        different.push(id_of(tx));
    }
    let different: std::collections::HashSet<_> = different.into_iter().collect();
    assert_eq!(different.len(), 3 + 16, "every variant has an ID of its own");
    println!("[p8 launch] the two-output genesis has its own covenant ID; 3 genesis transactions with a third family output and 16 with one changed field, value or coin each have another");

    // The real genesis builder (tx.rs, the one mainnet-deploy.ts verify calls) makes the minter at output 0 and the
    // seed at output 1, nothing else in the family, and reports the ID consensus computes.
    let built = api("genesis", merge(api_common(1), json!({
        "minter": state_json(&minter), "minterValue": 500_000_000u64, "seedOwner": hex32(&xonly(&guardian)), "seedValue": 200_000_000u64,
    })))
    .expect("the builder's genesis");
    let outputs = built["transaction"]["outputs"].as_array().unwrap();
    let bound: Vec<usize> = outputs.iter().enumerate().filter(|(_, o)| !o["covenant"].is_null()).map(|(i, _)| i).collect();
    assert_eq!(bound, vec![0, 1], "the builder binds the minter and the seed only");
    assert!(outputs.iter().filter(|o| !o["covenant"].is_null()).all(|o| o["covenant"]["covenantId"] == built["covenantId"] && o["covenant"]["authorizingInput"] == 0));
    assert_eq!(built["outputs"][0]["scriptPublicKey"].as_str().unwrap(), spk_hex(&script_of("BridgeMint", minter.state())));
    assert_eq!(state_from_json(&built["outputs"][0]["minter"]), minter);
}
