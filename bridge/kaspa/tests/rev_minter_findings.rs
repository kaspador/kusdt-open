//! Review r16/rev-minter: the review's findings as regression tests, in the script engine.
//!
//! M1 (a pause brought alive an unpause signed for the next nonce) is fixed on chain: an unpause signs
//! `BLAKE3("kUSDT/unpause/v2" ‖ covenant_id[32] ‖ admin_nonce[8] ‖ age_daa[8] ‖ outpoint_txid[32] ‖ outpoint_index[8])`, the
//! outpoint being the paused minter coin it spends (`age_daa`, the age of it the spend claims, is signed too:
//! govern_signed_age.rs; every spend in this file claims 0). `fixed_*` tests pass while the fix holds. `residual_*`
//! tests pass while a known, accepted limit stands (they say what the signing tool has to prevent).
//!
//!   cargo test --locked --test rev_minter_findings -- --nocapture

mod common;
mod rev_minter_kit;

use kaspa_consensus_core::tx::Transaction;
use rev_minter_kit::*;
use secp256k1::Keypair;

fn limits(c: i64, r: i64) -> Vec<u8> {
    [le8(c), le8(r)].concat()
}

/// `who` sign `action` for admin nonce `nonce` on the minter coin the harness holds NOW (an unpause names that coin).
fn sign_for(h: &Harness, who: &[usize], nonce: i64, action: u8, params: &[u8]) -> Quorum {
    Quorum::honest(&h.signers, who, &digest_for(h, nonce, action, params))
}

/// `who` sign an unpause for nonce `nonce` and any outpoint.
fn sign_unpause(h: &Harness, who: &[usize], nonce: i64, txid: &[u8; 32], index: u32) -> Quorum {
    Quorum::honest(&h.signers, who, &unpause_digest_any(&cov(h), nonce, txid, index))
}

/// `who` sign the message an unpause had before this change: the govern message with action 1 and no params.
fn sign_old_unpause(h: &Harness, who: &[usize], nonce: i64) -> Quorum {
    Quorum::honest(&h.signers, who, &govern_digest_any(&cov(h), nonce, 0x01, &[]))
}

fn govern_with(h: &Harness, action: u8, params: &[u8], q: &Quorum) -> Result<Transaction, Rejected> {
    let v = model_govern(&h.state, action, params, 0, 0, h.minter.utxo.amount);
    build_govern(h, action, params, 0, 0, q, &v.next, v.value)
}

fn apply(h: &mut Harness, tx: Transaction, action: u8, params: &[u8]) {
    let v = model_govern(&h.state, action, params, 0, 0, h.minter.utxo.amount);
    adopt(h, &tx, v.next);
}

fn step(t: &mut Tally, h: &mut Harness, what: &str, action: u8, params: &[u8]) {
    let (r, v) = honest_govern(h, action, params, 0);
    let tx = t.control(what, r);
    adopt(h, &tx, v.next);
}

fn pause(t: &mut Tally, h: &mut Harness, guardian: &Keypair) {
    let v = model_pause(&h.state, 0, h.minter.utxo.amount);
    let tx = t.control("the guardian pauses", build_pause(h, guardian, 0, &v.next, v.value));
    adopt(h, &tx, v.next);
}

fn txid(h: &Harness) -> [u8; 32] {
    h.minter.outpoint.transaction_id.as_bytes()
}

/// M1, turned around. Nothing signed before a pause lifts it: not for the nonce the minter held, not for the nonce
/// the pause moves to, not in the message format unpauses had before, not with three keys and one signature an
/// honest signer gave too early. An unpause signed for the paused coin lifts it.
#[test]
fn fixed_m1_no_unpause_signed_before_a_pause_lifts_it() {
    let mut t = Tally::default();
    let guardian = key(0x20);
    let four = [0usize, 1, 2, 3];
    let mut h = Harness::launch_with(|s| s.admin_nonce = 6);
    assert!(!h.state.paused);
    let running_coin = (txid(&h), h.minter.outpoint.index);

    // Signed while the minter runs at nonce 6, for the coin that exists (nobody can name a coin that does not).
    let new_6 = sign_for(&h, &four, 6, 0x01, &[]);
    let new_7 = sign_for(&h, &four, 7, 0x01, &[]);
    let new_9 = sign_for(&h, &four, 9, 0x01, &[]);
    // The format before this change, for the same nonces.
    let old_6 = sign_old_unpause(&h, &four, 6);
    let old_7 = sign_old_unpause(&h, &four, 7);
    // Three keys of a thief, and one honest signer's signature over an unpause for the next nonce (in either format).
    let digest_new = unpause_digest_any(&cov(&h), 7, &running_coin.0, running_coin.1);
    let digest_old = govern_digest_any(&cov(&h), 7, 0x01, &[]);
    let signers = h.signers.clone();
    let three_and_one = |d: &[u8; 32]| Quorum { keys: keys_of(&signers), indices: vec![0, 1, 2, 4], signatures: vec![sign_digest(&signers[0], d), sign_digest(&signers[1], d), sign_digest(&signers[2], d), sign_digest(&signers[4], d)] };
    let (thief_new, thief_old) = (three_and_one(&digest_new), three_and_one(&digest_old));
    for (what, q) in [("the new message, this nonce", &new_6), ("the new message, the next nonce", &new_7), ("the old message, this nonce", &old_6), ("the old message, the next nonce", &old_7)] {
        t.refused(&format!("an unpause of a running minter: {what}"), govern_with(&h, 0x01, &[], q));
    }

    // An incident. The guardian pauses: admin nonce 7, paused, a new coin.
    pause(&mut t, &mut h, &guardian);
    assert_eq!((h.state.admin_nonce, h.state.paused), (7, true));
    assert_ne!(txid(&h), running_coin.0, "the paused minter is another coin than the one that ran");
    for (what, q) in [
        ("signed before the pause for the nonce before it", &new_6),
        ("signed before the pause for the nonce after it (M1)", &new_7),
        ("signed before the pause for a later nonce", &new_9),
        ("the old message for the nonce before it", &old_6),
        ("the old message for the nonce after it (M1 as it was)", &old_7),
        ("three keys and one early honest signature", &thief_new),
        ("three keys and one early honest signature, the old message", &thief_old),
    ] {
        t.refused(&format!("the pause is not lifted by an unpause {what}"), govern_with(&h, 0x01, &[], q));
    }
    // The old message signed NOW, at the right nonce, by four: the format is gone, not only its timing.
    t.refused("the old unpause message, signed after the pause", govern_with(&h, 0x01, &[], &sign_old_unpause(&h, &four, 7)));
    // The new message with one part wrong.
    let paused_coin = (txid(&h), h.minter.outpoint.index);
    let mut other_txid = paused_coin.0;
    other_txid[0] ^= 1;
    t.refused("another transaction ID", govern_with(&h, 0x01, &[], &sign_unpause(&h, &four, 7, &other_txid, paused_coin.1)));
    t.refused("another output index", govern_with(&h, 0x01, &[], &sign_unpause(&h, &four, 7, &paused_coin.0, paused_coin.1 + 1)));
    t.refused("another nonce (the one before)", govern_with(&h, 0x01, &[], &sign_unpause(&h, &four, 6, &paused_coin.0, paused_coin.1)));
    t.refused("another nonce (the one after)", govern_with(&h, 0x01, &[], &sign_unpause(&h, &four, 8, &paused_coin.0, paused_coin.1)));
    t.refused("another covenant ID", govern_with(&h, 0x01, &[], &Quorum::honest(&h.signers, &four, &unpause_digest_any(&[0x55; 32], 7, &paused_coin.0, paused_coin.1))));
    t.refused("three signers", govern_with(&h, 0x01, &[], &sign_unpause(&h, &[0, 1, 2], 7, &paused_coin.0, paused_coin.1)));
    // The unpause message is no other action's signature, and no other action's signature is an unpause.
    let raise = limits(MAX_LIMIT, MAX_LIMIT);
    let unpause_now = sign_unpause(&h, &four, 7, &paused_coin.0, paused_coin.1);
    t.refused("unpause signatures on a change of limits", govern_with(&h, 0x02, &raise, &unpause_now));
    t.refused("unpause signatures on a skip", govern_with(&h, 0x04, &[vec![CHAIN_ETHEREUM], le8(0).to_vec()].concat(), &unpause_now));

    // Signed for the paused coin, it lifts the pause.
    let lifted = t.control("an unpause signed for the paused coin", govern_with(&h, 0x01, &[], &unpause_now));
    apply(&mut h, lifted, 0x01, &[]);
    assert_eq!((h.state.admin_nonce, h.state.paused), (8, false));

    // The second pause: nonce 9. The unpause stored for nonce 9 is for a coin long spent; the one just used is spent too.
    pause(&mut t, &mut h, &guardian);
    assert_eq!((h.state.admin_nonce, h.state.paused), (9, true));
    t.refused("the second pause is not lifted by the unpause stored for nonce 9", govern_with(&h, 0x01, &[], &new_9));
    t.refused("nor by the unpause that lifted the first", govern_with(&h, 0x01, &[], &unpause_now));
    t.refused("nor by the first paused coin's outpoint at the new nonce", govern_with(&h, 0x01, &[], &sign_unpause(&h, &four, 9, &paused_coin.0, paused_coin.1)));
    t.control("a new unpause for the second paused coin", honest_govern(&h, 0x01, &[], 0).0);
    t.report("fixed M1");
    assert_eq!((t.refused, t.controls), (4 + 7 + 1 + 6 + 2 + 3, 4));
}

/// An unpause is for one paused coin. Whatever else spends the paused minter makes a new coin, and the unpause
/// signed for the old one is dead even when the admin nonce did not move (a recovery proposal, a veto).
#[test]
fn fixed_m1_an_unpause_dies_with_any_other_spend_of_the_paused_minter() {
    let mut t = Tally::default();
    let four = [0usize, 1, 2, 3];
    let rotate = [[5u8; 32].to_vec(), [6u8; 32].to_vec()].concat();
    let paused = || {
        Harness::launch_with(|s| {
            s.paused = true;
            s.admin_nonce = 3;
            s.recovery_delay = 1_000;
        })
    };

    // Spends that leave the admin nonce where it was: only the outpoint tells the coins apart.
    let mut h = paused();
    let for_first = sign_for(&h, &four, 3, 0x01, &[]);
    t.control("the unpause for the paused coin", govern_with(&h, 0x01, &[], &for_first));
    step(&mut t, &mut h, "three signers propose a recovery", 0x06, &rotate);
    assert_eq!(h.state.admin_nonce, 3, "a proposal leaves the admin nonce");
    t.refused("the unpause after a recovery proposal", govern_with(&h, 0x01, &[], &for_first));
    let for_second = sign_for(&h, &four, 3, 0x01, &[]);
    t.control("an unpause signed for the coin the proposal made", govern_with(&h, 0x01, &[], &for_second));
    step(&mut t, &mut h, "one signer vetoes", 0x07, &[]);
    assert_eq!(h.state.admin_nonce, 3, "a veto leaves the admin nonce");
    t.refused("the first unpause after the veto", govern_with(&h, 0x01, &[], &for_first));
    t.refused("the second unpause after the veto", govern_with(&h, 0x01, &[], &for_second));
    t.control("an unpause signed for the coin the veto made", honest_govern(&h, 0x01, &[], 0).0);

    // Spends that move the admin nonce void it as before (by the nonce, and by the outpoint).
    for (action, params) in [(0x02u8, limits(1_000, 1)), (0x04, [vec![CHAIN_BSC], le8(0).to_vec()].concat()), (0x05, le8(MINTER_SOMPI as i64 + 5).to_vec())] {
        let mut h = paused();
        let before = sign_for(&h, &four, 3, 0x01, &[]);
        let before_next = sign_for(&h, &four, 4, 0x01, &[]);
        step(&mut t, &mut h, "another governance action while paused", action, &params);
        t.refused("the unpause signed before it", govern_with(&h, 0x01, &[], &before));
        t.refused("the unpause signed before it for the nonce after it", govern_with(&h, 0x01, &[], &before_next));
        t.control("an unpause signed after it", honest_govern(&h, 0x01, &[], 0).0);
    }
    // execute_recovery: the new set unpauses, for the coin the execution made.
    let new_keys: Vec<Keypair> = (0x30..0x35).map(key).collect();
    let recover = [signer_set_of(&new_keys).to_vec(), xonly(&key(0x36)).to_vec()].concat();
    let mut h = paused();
    step(&mut t, &mut h, "propose", 0x06, &recover);
    // The new set signing ahead, for the coin that waits and the nonce the execution moves to: dead on arrival.
    let early = Quorum::honest(&new_keys, &four, &unpause_digest_any(&cov(&h), 4, &txid(&h), h.minter.outpoint.index));
    let v = model_execute(&h.state, 1_000, MINTER_SOMPI);
    let tx = t.control("execute_recovery", build_execute(&h, 1_000, &v.next, v.value));
    adopt(&mut h, &tx, v.next);
    h.signers = new_keys;
    t.refused("an unpause the new set signed before the execution", govern_with(&h, 0x01, &[], &early));
    t.control("the new set's unpause for the coin the execution made", honest_govern(&h, 0x01, &[], 0).0);

    // Rotation is signed at the nonce, not at a coin: a proposal and a veto between signing and sending do not void it.
    let mut h = paused();
    let rotation = sign_for(&h, &four, 3, 0x03, &recover);
    step(&mut t, &mut h, "three keys propose", 0x06, &rotate);
    step(&mut t, &mut h, "one key vetoes", 0x07, &[]);
    step(&mut t, &mut h, "three keys propose again", 0x06, &rotate);
    t.control("the rotation signed before all three spends", govern_with(&h, 0x03, &recover, &rotation));
    t.report("fixed M1, other spends");
    assert_eq!((t.refused, t.controls), (3 + 6 + 1, 5 + 6 + 3 + 4));
}

/// The index of the outpoint, at every width. The engine's OpOutpointIndex pushes the index as a script number (as
/// short as the value allows, not a fixed width); the script widens it to 8 bytes (`as byte[8]`), and the builders
/// and the follower write 8 little-endian bytes. They must agree for an index of 0 (an empty push), one byte, a byte
/// with its top bit set (two bytes as a script number), and up to the largest index there is (five bytes).
#[test]
fn fixed_m1_the_outpoint_index_is_signed_the_same_at_every_width() {
    use kaspa_consensus_core::tx::TransactionOutpoint;
    use serde_json::json;
    let mut t = Tally::default();
    let four = [0usize, 1, 2, 3];
    for index in [0u32, 1, 16, 17, 127, 128, 255, 256, 32_767, 32_768, 65_536, 0x7fff_ffff, 0x8000_0000, u32::MAX] {
        let mut h = Harness::launch_with(|s| {
            s.paused = true;
            s.admin_nonce = 3;
        });
        // The same paused coin, as output `index` of its transaction (the engine takes the outpoint from the input).
        h.minter.outpoint = TransactionOutpoint::new(h.minter.outpoint.transaction_id, index);
        let digest = unpause_digest_any(&cov(&h), 3, &txid(&h), index);
        // The builders' digest (govern-digest of tx.rs / api.rs) is the same bytes.
        let built = api("govern-digest", json!({ "covenantId": h.minter.covenant_id.to_string(), "adminNonce": 3, "action": { "kind": "unpause" }, "outpoint": { "transactionId": h.minter.outpoint.transaction_id.to_string(), "index": index } })).unwrap();
        assert_eq!(built["digest"].as_str().unwrap(), kusdt_kaspa::hex::encode(&digest), "index {index}");
        let q = Quorum::honest(&h.signers, &four, &digest);
        t.control(&format!("an unpause of the coin at output {index}"), govern_with(&h, 0x01, &[], &q));
        // The real builder builds it with those signatures too (and runs the script while it builds).
        let request = merge(merge(api_common(index as u64 + 7), quorum_json(&q)), json!({ "minter": located(&h), "action": { "kind": "unpause" }, "ageDaa": 0 }));
        api("govern", request).unwrap_or_else(|e| panic!("the builder's unpause at output {index}: {e}"));
        // One off in the index is another coin.
        let off = Quorum::honest(&h.signers, &four, &unpause_digest_any(&cov(&h), 3, &txid(&h), index ^ 1));
        t.refused(&format!("an unpause signed for output {}", index ^ 1), govern_with(&h, 0x01, &[], &off));
    }
    // The builders refuse an unpause digest without the coin.
    let none = api("govern-digest", json!({ "covenantId": "ab".repeat(32), "adminNonce": 3, "action": { "kind": "unpause" } }));
    assert!(none.unwrap_err().contains("outpoint"));
    t.report("fixed M1, the index at every width");
    assert_eq!((t.refused, t.controls), (14, 14));
}

/// RESIDUAL (known, accepted with the fix): only the unpause names its coin. Every other governance message is
/// still good for whichever coin holds its nonce, so one signed for admin_nonce + 1 comes alive when the guardian
/// pauses, and the second step of a sequence signed for N and N + 1 runs without the first. Neither lifts a
/// pause. Binding them to a coin would void an action that operators sign over hours whenever a mint lands first,
/// so the signing tool is what prevents it: govern-sign takes the nonce from the signer's own state.
#[test]
fn residual_a_pause_still_brings_alive_other_actions_signed_for_the_next_nonce() {
    let mut t = Tally::default();
    let four = [0usize, 1, 2, 3];
    let mut h = Harness::launch_with(|s| s.admin_nonce = 6);
    let raise = limits(MAX_LIMIT, MAX_LIMIT);
    let raise_7 = sign_for(&h, &four, 7, 0x02, &raise);
    t.refused("the raise for nonce 7, at nonce 6", govern_with(&h, 0x02, &raise, &raise_7));
    pause(&mut t, &mut h, &key(0x20));
    let raised = govern_with(&h, 0x02, &raise, &raise_7);
    println!("[residual] limits raised by signatures made before the pause for the nonce after it: {}", verdict_text(&raised));
    let raised = raised.expect("RESIDUAL: still accepted; the minter stays paused");
    apply(&mut h, raised, 0x02, &raise);
    assert!(h.state.paused, "and it lifts nothing");

    // A sequence signed for nonces 0 and 1: after a pause, step 2 alone.
    let mut h = Harness::launch();
    let lower = limits(1_000, 1);
    let value = le8(MINTER_SOMPI as i64 * 3).to_vec();
    let step_1 = sign_for(&h, &four, 0, 0x02, &lower);
    let step_2 = sign_for(&h, &four, 1, 0x05, &value);
    t.refused("step 2 before step 1", govern_with(&h, 0x05, &value, &step_2));
    t.control("step 1 as planned", govern_with(&h, 0x02, &lower, &step_1));
    pause(&mut t, &mut h, &key(0x20));
    t.refused("step 1 after the pause", govern_with(&h, 0x02, &lower, &step_1));
    let second = govern_with(&h, 0x05, &value, &step_2);
    println!("[residual] of a sequence signed for nonces 0 and 1, the second step alone after a pause: {}", verdict_text(&second));
    assert!(second.is_ok(), "RESIDUAL: the pause stands in for the first step's nonce");
    t.report("residual");
    assert_eq!((t.refused, t.controls), (3, 3));
}

/// L3, turned around: amounts that sum past 2^63 are an error from the mint builder, not a panic.
#[test]
fn fixed_l3_the_mint_builder_refuses_amounts_that_sum_past_a_64_bit_number() {
    use serde_json::json;
    let h = Harness::launch();
    let request = |recipients: &[Recipient]| {
        let q = Quorum::honest(&h.signers, &[0, 1, 2], &mint_digest_any(&cov(&h), CHAIN_ETHEREUM, 0, 0, recipients));
        merge(
            merge(api_common(1), quorum_json(&q)),
            json!({ "minter": located(&h), "chain": 1, "firstNonce": 0, "ageDaa": 0, "recipients": recipients_json(recipients), "tokenValue": 150_000_000u64 }),
        )
    };
    let wrap = vec![Recipient::schnorr(&key(0xa1), 1 << 62), Recipient::schnorr(&key(0xa2), 1 << 62)];
    let wrapped = request(&wrap);
    let outcome = std::panic::catch_unwind(move || api("mint", wrapped));
    let error = outcome.expect("no panic").expect_err("no transaction");
    println!("[fixed L3] the mint builder on amounts that sum past 2^63: {error}");
    assert!(error.contains("sum past"), "{error}");
    // Control: the same request with amounts that fit is built.
    api("mint", request(&[Recipient::schnorr(&key(0xa1), 1_000), Recipient::schnorr(&key(0xa2), 2_000)])).expect("the builder builds an ordinary mint");
}
