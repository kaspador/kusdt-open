//! The age a governance spend claims is signed (outside review, row F), in the script engine.
//!
//! Every governance action settles the mint allowance with the age of the minter UTXO it claims, and the spend
//! restarts that age. Before this, the claimed age was a free argument: anyone holding a signed action (it sits in
//! the mempool) could send a copy claiming less, 0 at the least, and the allowance refilled since the minter's last
//! spend was thrown away. Now the govern and unpause messages name the age ("kUSDT/govern/v2",
//! "kUSDT/unpause/v2"), as a mint's always did, so the signatures serve one age only.
//!
//! What the engine shows here: for each action kind, the signatures for age A pass at a claim of A and credit
//! exactly A of refill; the same signatures under any other claim are refused, each with its input's sequence at that
//! claim (the minter holds the sequence at exactly the age claimed, `require_settled_inputs`), so only the signatures
//! refuse it; and signatures over the old messages, which named no age, are refused at every claim. That the sequence
//! is at most the coin's real age is consensus's relative lock, which this harness does not run.
//!
//!   cargo test --locked --test govern_signed_age -- --nocapture

mod common;
mod rev_minter_kit;

use kaspa_consensus_core::tx::Transaction;
use rev_minter_kit::*;

/// The signed age. The coin is older (OLDER DAA), so its relative lock alone would let a spend claim anything up to that.
const A: i64 = 100;
const OLDER: i64 = 500;
const REFILL: i64 = 3;
const BUCKET: i64 = 7;

/// A paused minter with a recovery pending: an unpause and a veto are valid on it, and so is every 4-of-5 action.
fn paused_pending() -> Harness {
    Harness::launch_with(|s| {
        s.capacity = MAX_LIMIT;
        s.bucket = BUCKET;
        s.refill_per_daa = REFILL;
        s.paused = true;
        s.recovery_pending = true;
        s.recovery_signer_set = [3; 32];
    })
}

/// A running minter with no recovery pending: a proposal is valid on it.
fn running() -> Harness {
    Harness::launch_with(|s| {
        s.capacity = MAX_LIMIT;
        s.bucket = BUCKET;
        s.refill_per_daa = REFILL;
    })
}

/// Every action kind, with the minter it is valid on.
fn actions() -> Vec<(&'static str, Harness, u8, Vec<u8>)> {
    vec![
        ("unpause", paused_pending(), 0x01, vec![]),
        ("set_limits", paused_pending(), 0x02, [le8(MAX_LIMIT), le8(1)].concat()),
        ("set_signers", paused_pending(), 0x03, [[5u8; 32].to_vec(), [6u8; 32].to_vec()].concat()),
        ("skip_nonce", paused_pending(), 0x04, [vec![CHAIN_ETHEREUM], le8(0).to_vec()].concat()),
        ("set_value", paused_pending(), 0x05, le8(MINTER_SOMPI as i64 + 1).to_vec()),
        ("propose_recovery", running(), 0x06, [[5u8; 32].to_vec(), [6u8; 32].to_vec()].concat()),
        ("veto_recovery", paused_pending(), 0x07, vec![]),
    ]
}

/// The action's quorum (its first signers) over the current message for a spend claiming `signed_age`.
fn signed_for(h: &Harness, action: u8, params: &[u8], signed_age: i64) -> Quorum {
    let who: Vec<usize> = (0..quorum_of(action)).collect();
    Quorum::honest(&h.signers, &who, &digest_for_aged(h, signed_nonce(&h.state, action), signed_age, action, params))
}

/// The action's quorum over the message as it was before the age was signed.
fn signed_old_format(h: &Harness, action: u8, params: &[u8]) -> Quorum {
    let who: Vec<usize> = (0..quorum_of(action)).collect();
    let nonce = signed_nonce(&h.state, action);
    let digest = if action == 0x01 {
        unpause_digest_v1(&cov(h), nonce, &h.minter.outpoint.transaction_id.as_bytes(), h.minter.outpoint.index)
    } else {
        govern_digest_v1(&cov(h), nonce, action, params)
    };
    Quorum::honest(&h.signers, &who, &digest)
}

/// The spend a copier would send: the action under `q`, claiming `claimed`, with the successor the script computes
/// for that claim. The model takes the signatures as good, so its verdict says whether anything but them refuses.
fn claim(h: &Harness, action: u8, params: &[u8], q: &Quorum, claimed: i64) -> (Result<Transaction, Rejected>, Verdict) {
    let v = model_govern(&h.state, action, params, claimed, claimed as u64, h.minter.utxo.amount);
    (build_govern(h, action, params, claimed, claimed as u64, q, &v.next, v.value), v)
}

#[test]
fn a_governance_action_serves_the_one_age_its_signers_signed() {
    let mut t = Tally::default();
    for (name, h, action, params) in actions() {
        let q = signed_for(&h, action, &params, A);

        // At the signed age it passes, and the successor the script demanded holds exactly A of refill.
        let (r, v) = claim(&h, action, &params, &q, A);
        assert!(v.accept.is_ok(), "{name}: {:?}", v.accept);
        assert_eq!(v.next.bucket, BUCKET + A * REFILL, "{name}: the allowance for exactly the signed age");
        t.control(&format!("{name}: signed for {A}, claiming {A}"), r);

        // A successor crediting one unit more or less than the signed age refills is refused.
        for off in [-1i64, 1] {
            let mut bent = v.next.clone();
            bent.bucket += off;
            t.refused(&format!("{name}: a successor crediting {off} beside the signed age"), build_govern(&h, action, &params, A, A as u64, &q, &bent, v.value));
        }

        // The same signatures under another claim: nothing but the signatures refuses (the coin is old enough for
        // every one of these ages, the sequence is that claim, and the successor offered is the script's own for it).
        for claimed in [A - 1, 0, A + 1, 1, OLDER] {
            let (r, v) = claim(&h, action, &params, &q, claimed);
            assert!(v.accept.is_ok(), "{name}: only the signatures stand between a copier and a claim of {claimed}");
            t.refused(&format!("{name}: signed for {A}, claiming {claimed}"), r);
        }

        // Signatures over the old message, which named no age: refused at every claim, the signed one and 0 included.
        let old = signed_old_format(&h, action, &params);
        for claimed in [A, 0, A - 1, A + 1] {
            t.refused(&format!("{name}: the old message, claiming {claimed}"), claim(&h, action, &params, &old, claimed).0);
        }
    }
    t.report("govern: the signed age");
    assert_eq!((t.refused, t.controls), (7 * (2 + 5 + 4), 7));
}

#[test]
fn an_age_of_zero_is_signed_like_any_other_and_always_valid() {
    let mut t = Tally::default();
    for (name, h, action, params) in actions() {
        let q = signed_for(&h, action, &params, 0);
        // Sequence 0: the spend waits on no clock. It credits no refill.
        let v = model_govern(&h.state, action, &params, 0, 0, h.minter.utxo.amount);
        assert!(v.accept.is_ok(), "{name}: {:?}", v.accept);
        assert_eq!(v.next.bucket, BUCKET, "{name}: nothing refilled at age 0");
        t.control(&format!("{name}: signed for 0, claiming 0"), build_govern(&h, action, &params, 0, 0, &q, &v.next, v.value));
        // Signatures for 0 do not serve a claim of more, whatever the coin's age.
        for claimed in [1, A] {
            t.refused(&format!("{name}: signed for 0, claiming {claimed}"), claim(&h, action, &params, &q, claimed).0);
        }
    }
    t.report("govern: age 0");
    assert_eq!((t.refused, t.controls), (7 * 2, 7));
}

/// The age is one more field of the message: signatures for the right age still serve one nonce, one action, one
/// coin (an unpause) and one covenant only.
#[test]
fn the_signed_age_replaces_nothing_else_the_message_names() {
    let mut t = Tally::default();
    let h = paused_pending();
    let four = [0usize, 1, 2, 3];
    let limits = [le8(MAX_LIMIT), le8(1)].concat();
    let nonce = h.state.admin_nonce;
    let txid = h.minter.outpoint.transaction_id.as_bytes();
    let index = h.minter.outpoint.index;

    t.control("the limits, signed for this nonce and age", claim(&h, 0x02, &limits, &signed_for(&h, 0x02, &limits, A), A).0);
    for (what, digest) in [
        ("another nonce", govern_digest_aged(&cov(&h), nonce + 1, A, 0x02, &limits)),
        ("another covenant", govern_digest_aged(&[0x55; 32], nonce, A, 0x02, &limits)),
        ("another action", govern_digest_aged(&cov(&h), nonce, A, 0x05, &limits)),
        ("the age and the nonce swapped", govern_digest_aged(&cov(&h), A, nonce, 0x02, &limits)),
        ("the unpause message for this coin and age", unpause_digest_aged(&cov(&h), nonce, A, &txid, index)),
    ] {
        t.refused(&format!("limits under signatures for {what}"), claim(&h, 0x02, &limits, &Quorum::honest(&h.signers, &four, &digest), A).0);
    }

    t.control("the unpause, signed for this coin and age", claim(&h, 0x01, &[], &signed_for(&h, 0x01, &[], A), A).0);
    for (what, digest) in [
        ("another output index", unpause_digest_aged(&cov(&h), nonce, A, &txid, index + 1)),
        ("another transaction", unpause_digest_aged(&cov(&h), nonce, A, &[0x77; 32], index)),
        ("another nonce", unpause_digest_aged(&cov(&h), nonce + 1, A, &txid, index)),
        ("the age and the nonce swapped", unpause_digest_aged(&cov(&h), A, nonce, &txid, index)),
        ("the govern message for an unpause at this age", govern_digest_aged(&cov(&h), nonce, A, 0x01, &[])),
    ] {
        t.refused(&format!("an unpause under signatures for {what}"), claim(&h, 0x01, &[], &Quorum::honest(&h.signers, &four, &digest), A).0);
    }
    t.report("govern: the other fields");
    assert_eq!((t.refused, t.controls), (10, 2));
}

/// The builders' digest (`govern-digest` of api.rs, which the signers' tool calls) is the script's, age included.
#[test]
fn the_builders_digest_names_the_age() {
    let h = paused_pending();
    let cov_hex = h.minter.covenant_id.to_string();
    let outpoint = serde_json::json!({ "transactionId": h.minter.outpoint.transaction_id.to_string(), "index": h.minter.outpoint.index });
    let new_keys: Vec<String> = (0x60u8..0x65).map(|k| hex32(&xonly(&key(k)))).collect();
    let guardian = hex32(&xonly(&key(0x6f)));
    let set = signer_set_of(&(0x60u8..0x65).map(key).collect::<Vec<_>>());
    let keys_params = [set.to_vec(), xonly(&key(0x6f)).to_vec()].concat();
    let cases: Vec<(u8, Vec<u8>, serde_json::Value, i64)> = vec![
        (0x01, vec![], serde_json::json!({ "kind": "unpause" }), h.state.admin_nonce),
        (0x02, [le8(42), le8(3)].concat(), serde_json::json!({ "kind": "setLimits", "capacity": "42", "refillPerDaa": "3" }), h.state.admin_nonce),
        (0x03, keys_params.clone(), serde_json::json!({ "kind": "setSigners", "signerKeys": new_keys, "guardian": guardian }), h.state.admin_nonce),
        (0x04, [vec![CHAIN_BSC], le8(9).to_vec()].concat(), serde_json::json!({ "kind": "skipNonce", "chain": 2, "nonce": "9" }), h.state.admin_nonce),
        (0x05, le8(77).to_vec(), serde_json::json!({ "kind": "setValue", "value": "77" }), h.state.admin_nonce),
        (0x06, keys_params, serde_json::json!({ "kind": "proposeRecovery", "signerKeys": new_keys, "guardian": guardian }), h.state.recovery_nonce),
        (0x07, vec![], serde_json::json!({ "kind": "vetoRecovery" }), h.state.recovery_nonce),
    ];
    for (action, params, json, nonce) in cases {
        let mut seen = Vec::new();
        for age in [0i64, 1, A, (1 << 32) - 1] {
            let built = api("govern-digest", serde_json::json!({ "covenantId": cov_hex, "adminNonce": nonce, "ageDaa": age.to_string(), "action": json, "outpoint": outpoint })).expect("a digest");
            assert_eq!(built["digest"].as_str().unwrap(), hex32(&digest_for_aged(&h, nonce, age, action, &params)), "action {action} age {age}");
            assert_eq!(built["ageDaa"].as_str().unwrap(), age.to_string(), "the answer names the age signed");
            seen.push(built["digest"].as_str().unwrap().to_string());
        }
        seen.dedup();
        assert_eq!(seen.len(), 4, "action {action}: every age has its own digest");
        // No age given is age 0: always valid, credits nothing.
        let absent = api("govern-digest", serde_json::json!({ "covenantId": cov_hex, "adminNonce": nonce, "action": json, "outpoint": outpoint })).expect("a digest");
        assert_eq!(absent["digest"].as_str().unwrap(), hex32(&digest_for_aged(&h, nonce, 0, action, &params)));
        assert_eq!(absent["ageDaa"].as_str().unwrap(), "0");
        // An age no spend can claim has no digest.
        for age in ["-1", "4294967296"] {
            assert!(api("govern-digest", serde_json::json!({ "covenantId": cov_hex, "adminNonce": nonce, "ageDaa": age, "action": json, "outpoint": outpoint })).is_err(), "age {age}");
        }
        // The old messages are not what the builders sign.
        let old = if action == 0x01 {
            unpause_digest_v1(&cov(&h), nonce, &h.minter.outpoint.transaction_id.as_bytes(), h.minter.outpoint.index)
        } else {
            govern_digest_v1(&cov(&h), nonce, action, &params)
        };
        assert!(!seen.contains(&hex32(&old)));
    }
}
