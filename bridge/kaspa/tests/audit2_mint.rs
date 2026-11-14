//! Audit 2: BridgeMint in the script engine.
//!
//! `attack_*` tests pass when the attack WORKS: they prove a finding.
//! `held_*` tests pass when the covenant held against the probe.
//!
//! The finding: `first_nonce` and `age_daa` are consumed numerically, and the
//! covenant accepts a value padded with zero bytes (up to 8 bytes) or a
//! negative zero. Those bytes are not signed, not part of the transaction id,
//! and not minimal, and readScriptNum (bridge/packages/protocol/src/script.ts)
//! refuses them. The other half of the proof is
//! bridge/packages/protocol/src/audit2.test.ts.

mod common;

use argent_runtime::{ArtifactValue, EntryCall, TxContext, args};
use common::*;
use kaspa_consensus_core::tx::{CovenantBinding, Transaction};

const THRESHOLD: i64 = 500_000_000_000;

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

/// Rewrites one argument of input 0, leaving every signature untouched.
fn with_argument(tx: &Transaction, argument: usize, value: Vec<u8>) -> Transaction {
    let mut forged = tx.clone();
    let mut items = pushes(&forged.inputs[0].signature_script);
    items[argument] = value;
    forged.inputs[0].signature_script = push_script(&items);
    forged
}

fn r(amount: i64) -> Vec<Recipient> {
    vec![Recipient::schnorr(&key(0xa1), amount)]
}

#[test]
fn attack_a_signed_mint_takes_numbers_the_followers_refuse() {
    let mut h = Harness::launch();
    h.mint(CHAIN_ETHEREUM, 0, &r(1_000), &[0, 1, 2]).unwrap();
    let (tx, _) = h.try_mint(MintCase::new(CHAIN_ETHEREUM, 1, &r(1_000))).unwrap();
    let utxos = vec![h.minter.utxo.clone(), funding()];

    let mut now = pushes(&tx.inputs[0].signature_script)[2].clone();
    now.push(0);
    for (argument, value) in [
        (1usize, vec![1u8, 0]),
        (1, vec![1, 0, 0, 0, 0, 0, 0, 0]),
        (2, now),
    ] {
        let forged = with_argument(&tx, argument, value);
        assert_eq!(forged.id(), tx.id(), "the transaction id does not cover the rewrite");
        run(forged, utxos.clone()).expect("consensus accepts the padded number");
    }
    // Nine bytes is where the covenant stops.
    rejects(run(with_argument(&tx, 1, [vec![1u8], vec![0; 8]].concat()), utxos));
}

#[test]
fn attack_nonce_zero_takes_a_negative_zero() {
    let h = Harness::launch();
    let (tx, _) = h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r(1_000))).unwrap();
    let utxos = vec![h.minter.utxo.clone(), funding()];
    for value in [vec![0x80u8], vec![0x00], vec![0x00; 8]] {
        run(with_argument(&tx, 1, value), utxos.clone()).expect("consensus accepts another spelling of zero");
    }
}

#[test]
fn attack_set_limits_takes_a_padded_clock() {
    let h = Harness::launch();
    let (limits, _) = h.try_govern(Govern::SetLimits { capacity: 42, refill_per_daa: 3 }, &[0, 1, 2, 3]).unwrap();
    let mut now = pushes(&limits.inputs[0].signature_script)[2].clone();
    now.push(0);
    let forged = with_argument(&limits, 2, now);
    assert_eq!(forged.id(), limits.id());
    run(forged, vec![h.minter.utxo.clone(), funding()]).expect("consensus accepts the padded clock");
}

// -- Probes that held ---------------------------------------------------------

#[test]
fn held_the_clock_stays_in_the_daa_domain() {
    let h = Harness::launch_with(|s| {
        s.capacity = 1_000;
        s.bucket = 0;
        s.refill_per_daa = 1;
    });
    // A relative lock has 32 bits: nothing larger can be claimed, whatever the input's sequence.
    for age in [THRESHOLD, 1_800_000_000_000, 1i64 << 32] {
        rejects(h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r(1_000)).age(age).sequence(u32::MAX as u64)));
    }
}

#[test]
fn held_no_extra_pushes_and_no_multi_byte_chain() {
    let h = Harness::launch();
    let (tx, _) = h.try_mint(MintCase::new(CHAIN_ETHEREUM, 0, &r(1_000))).unwrap();
    let utxos = vec![h.minter.utxo.clone(), funding()];
    rejects(run(with_argument(&tx, 0, vec![1, 0]), utxos.clone()));
    let mut extra = pushes(&tx.inputs[0].signature_script);
    extra.insert(0, vec![7]);
    let mut forged = tx.clone();
    forged.inputs[0].signature_script = push_script(&extra);
    rejects(run(forged, utxos));
}

/// Built by hand: the harness would overflow in Rust before the script runs.
#[test]
fn held_a_mint_total_can_not_wrap() {
    let h = Harness::launch();
    let recipients = vec![Recipient::schnorr(&key(0xa1), 1i64 << 62), Recipient::schnorr(&key(0xa2), 1i64 << 62)];
    let covenant: [u8; 32] = h.minter.covenant_id.as_bytes();
    let digest = mint_digest(&covenant, CHAIN_ETHEREUM, 0, 1, &recipients);
    let keys = ArtifactValue::Array(h.signers.iter().map(|k| ArtifactValue::Bytes(xonly(k).to_vec())).collect());
    let signatures = ArtifactValue::Array((0..3).map(|i| ArtifactValue::Bytes(sign_digest(&h.signers[i], &digest))).collect());
    let age = 1i64;
    let call = EntryCall::new("mint").args(args!(
        CHAIN_ETHEREUM,
        0i64,
        age,
        recipients.iter().map(Recipient::state).collect::<Vec<_>>(),
        keys,
        vec![0u8, 1, 2],
        signatures
    ));
    let wrapped = (1i64 << 62).wrapping_add(1i64 << 62);
    let mut next = h.state.clone();
    next.nonce_ethereum = 2;
    next.remaining = h.state.remaining.wrapping_sub(wrapped);
    next.bucket = h.state.bucket.wrapping_sub(wrapped);
    let cov = h.minter.covenant_id;
    let mut context = TxContext::new()
        .actor_input("BridgeMint", h.state.state(), call, h.minter.outpoint, h.minter.utxo.clone(), age as u64)
        .input(outpoint(0xfa, 0), funding(), funding_sig(), 0)
        .actor_output("BridgeMint", next.state(), CovenantBinding::new(0, cov), h.minter.utxo.amount);
    for recipient in &recipients {
        context = context.actor_output("KCC20", recipient.state(), CovenantBinding::new(0, cov), TOKEN_SOMPI);
    }
    let error = builder().build(&context).expect_err("the sum overflows in the script");
    assert!(error.to_string().contains("Number too big"), "{error}");
}
