//! Every minted token output carries at least MIN_MINTED_VALUE (1 KAS), in the script engine.
//!
//! The mint digest names who gets how much kUSDT. It does not name the KAS each minted output carries: whoever
//! submits the mint pays that. So anyone who saw a signed mint (the coordinator's, in the mempool) could land a
//! copy of it whose outputs carried next to no KAS, and a recipient who held no KAS could not move the kUSDT
//! until they got some. The minter now refuses a mint with any minted output under 1 KAS.
//!
//! A deposit may name a burn owner, in which case the mint itself is the burn. The coordinator gives that output
//! the same token value as any other (the lower burn value is for transfers only), and nobody ever spends it, so
//! the floor applies to it like to every other minted output.
//!
//!   cargo test --locked --test mint_value_floor -- --nocapture

mod common;
mod rev_minter_kit;

use kaspa_consensus_core::tx::Transaction;
use kusdt_kaspa::hex;
use rev_minter_kit::*;
use serde_json::json;

/// bridge_mint.ag MIN_MINTED_VALUE, and its mirror in the builders.
const FLOOR: u64 = 100_000_000;

fn harness() -> Harness {
    Harness::launch_with(|s| {
        s.capacity = MAX_LIMIT;
        s.bucket = 1_000_000_000;
        s.refill_per_daa = 0;
    })
}

fn recipients(n: usize) -> Vec<Recipient> {
    (0..n).map(|k| Recipient::schnorr(&key(0xa1 + k as u8), 1_000 * (k as i64 + 1))).collect()
}

/// An honest mint of `r` (the right nonce, signers 0, 1, 2, the model's successor) whose minted outputs carry `values`.
fn mint_carrying(h: &Harness, r: &[Recipient], values: &[u64]) -> Result<Transaction, Rejected> {
    let v = model_mint(&h.state, CHAIN_ETHEREUM, h.state.nonce_ethereum, 0, 0, r, h.minter.utxo.amount);
    assert!(v.accept.is_ok(), "everything but the values is in order: {:?}", v.accept);
    let q = Quorum::honest(&h.signers, &[0, 1, 2], &mint_digest_any(&cov(h), CHAIN_ETHEREUM, h.state.nonce_ethereum, 0, r));
    build_mint_valued(h, CHAIN_ETHEREUM, h.state.nonce_ethereum, 0, 0, r, &q, &v.next, v.value, r, values)
}

#[test]
fn the_constants_agree() {
    assert_eq!(kusdt_kaspa::protocol::MIN_MINTED_VALUE, FLOOR);
    assert_eq!(TOKEN_SOMPI, FLOOR, "the harness mints at the floor, so every other mint test runs at it");
}

#[test]
fn a_mint_with_every_output_at_the_floor_passes_and_one_sompi_under_is_refused_at_every_position() {
    let h = harness();
    let mut t = Tally::default();
    for n in 1..=3usize {
        let r = recipients(n);
        t.control(&format!("{n} output(s), each at the floor"), mint_carrying(&h, &r, &vec![FLOOR; n]));
        t.control(&format!("{n} output(s), each above the floor"), mint_carrying(&h, &r, &vec![150_000_000; n]));
        // One output one sompi under, the others at the floor or well above it: refused wherever it stands.
        for at in 0..n {
            for others in [FLOOR, 10 * FLOOR] {
                let mut values = vec![others; n];
                values[at] = FLOOR - 1;
                t.refused(&format!("{n} output(s), output {at} one sompi under the floor (others {others})"), mint_carrying(&h, &r, &values));
            }
        }
        // And far under it: what a copier would do.
        for low in [0u64, 1, 20_000_000] {
            for at in 0..n {
                let mut values = vec![150_000_000; n];
                values[at] = low;
                t.refused(&format!("{n} output(s), output {at} carrying {low} sompi"), mint_carrying(&h, &r, &values));
            }
            t.refused(&format!("{n} output(s), all carrying {low} sompi"), mint_carrying(&h, &r, &vec![low; n]));
        }
    }
    t.report("mint: the floor under every minted output");
    // Per n: 2n one-under cases, 3n low cases, 3 all-low cases. n = 1, 2, 3.
    assert_eq!((t.refused, t.controls), ((2 + 3 + 3) + (4 + 6 + 3) + (6 + 9 + 3), 6));
}

/// The largest sum the floor leaves alone, and the comparison is not signed-number trouble: values up to the most
/// KAS there is pass.
#[test]
fn the_floor_is_a_floor_only() {
    let h = harness();
    let mut t = Tally::default();
    let r = recipients(3);
    for values in [[FLOOR, FLOOR + 1, 2 * FLOOR], [FLOOR, 1_000_000_000_000, FLOOR], [2_900_000_000_000_000, FLOOR, FLOOR]] {
        t.control(&format!("values {values:?}"), mint_carrying(&h, &r, &values));
    }
    t.report("mint: values above the floor");
    assert_eq!(t.controls, 3);
}

/// A deposit that names a burn owner: the mint itself is the burn (a p2sh owner whose script can never be
/// satisfied). Its output is a minted output like any other, and carries the floor like any other.
#[test]
fn a_mint_to_a_burn_owner_carries_the_floor_too() {
    let h = harness();
    let mut t = Tally::default();
    let burn = api("burn-owner", json!({ "chain": 1, "address": "11".repeat(20) })).expect("a burn owner");
    let owner: [u8; 32] = hex::decode(burn["owner"].as_str().unwrap()).unwrap().try_into().unwrap();
    let burned = Recipient { owner_scheme: burn["ownerScheme"].as_u64().unwrap() as u8, ..Recipient::owned(owner, 5_000) };
    assert_eq!(burned.owner_scheme, 0x03);

    t.control("a burn by mint, at the floor", mint_carrying(&h, std::slice::from_ref(&burned), &[FLOOR]));
    t.refused("a burn by mint, one sompi under", mint_carrying(&h, std::slice::from_ref(&burned), &[FLOOR - 1]));
    t.refused("a burn by mint at the burn value of a transfer (0.3 KAS)", mint_carrying(&h, std::slice::from_ref(&burned), &[30_000_000]));
    // In a batch, in every position.
    for at in 0..3usize {
        let mut r = recipients(3);
        r[at] = burned.clone();
        t.control(&format!("a batch with the burn at {at}, all at the floor"), mint_carrying(&h, &r, &[FLOOR; 3]));
        let mut values = [150_000_000u64; 3];
        values[at] = FLOOR - 1;
        t.refused(&format!("a batch with the burn at {at}, the burn one sompi under"), mint_carrying(&h, &r, &values));
    }
    t.report("mint: a burn owner");
    assert_eq!((t.refused, t.controls), (2 + 3, 1 + 3));
}

/// The builders say it in words before the script says it as a failure, and build at the floor.
#[test]
fn the_builder_refuses_a_token_value_under_the_floor() {
    let h = harness();
    let r = recipients(3);
    let q = Quorum::honest(&h.signers, &[0, 1, 2], &mint_digest_any(&cov(&h), CHAIN_ETHEREUM, 0, 0, &r));
    let request = |token_value: u64| {
        merge(
            merge(api_common(7), quorum_json(&q)),
            json!({ "minter": located(&h), "chain": 1, "firstNonce": "0", "ageDaa": "0", "recipients": recipients_json(&r), "tokenValue": token_value }),
        )
    };
    for low in [0u64, 1, 30_000_000, FLOOR - 1] {
        let refused = api("mint", request(low)).expect_err("a token value under the floor");
        assert!(refused.contains("is below 100000000 sompi (1 KAS): the minter refuses a minted output that carries less"), "{low}: {refused}");
    }
    for ok in [FLOOR, 150_000_000] {
        let built = api("mint", request(ok)).unwrap_or_else(|e| panic!("token value {ok}: {e}"));
        for k in 1..=3 {
            assert_eq!(built["outputs"][k]["value"].as_u64().or_else(|| built["outputs"][k]["value"].as_str().and_then(|s| s.parse().ok())), Some(ok), "output {k}");
        }
    }
}
