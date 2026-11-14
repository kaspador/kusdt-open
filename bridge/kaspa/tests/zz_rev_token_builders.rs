//! Token review: the `transfer` builder (src/tx.rs) against the rule the services pay burns by.
//!
//! FINDING (low), fixed in run 21 (Daybreak [27]): the builder checked that a redemption output has borrowing off, but
//! not that its borrow guard is zero. The script accepts such a state; every service refuses to pay it (signer.ts
//! signRelease, coordinator plainBurn, monitor indexBurns all require a zero guard), and a burn can never be spent, so
//! the kUSDT was gone. The builder refuses it now (tests/run21_redeem_burns.rs has the rest of the rule).
//!
//!   cargo test --locked --test zz_rev_token_builders -- --nocapture

#[path = "zz_rev_token_support.rs"]
mod support;

use kaspa_addresses::{Address, Prefix, Version};
use kusdt_kaspa::{model::spk_to_hex, protocol::burn_owner, tx};
use serde_json::{Value, json};
use support::*;

const ADDRESS: [u8; 20] = [0x5a; 20];

fn request(guard: [u8; 32], borrow_scheme: u8) -> Value {
    let holder = key(0xa1);
    let held = Tok::schnorr(&holder, 5_000_000);
    let token = held.utxo(K, TOKEN_SOMPI);
    let payer = key(0xa9);
    let burn = json!({
        "amount": 5_000_000, "owner": hex(&burn_owner(1, &ADDRESS)), "ownerScheme": 3, "borrowScheme": borrow_scheme, "borrowGuard": hex(&guard),
    });
    json!({
        "network": "mainnet",
        "changeAddress": Address::new(Prefix::Mainnet, Version::PubKey, &xonly(&payer)).to_string(),
        "funding": [{
            "utxo": { "transactionId": "f1".repeat(32), "index": 0, "amount": 10_000_000_000u64, "scriptPublicKey": format!("000020{}ac", hex(&xonly(&payer))) },
            "secretKey": "a9".repeat(32),
        }],
        "inputs": [{
            "utxo": { "transactionId": "e1".repeat(32), "index": 0, "amount": TOKEN_SOMPI, "scriptPublicKey": spk_to_hex(&token.script_public_key), "covenantId": hex(&K) },
            "state": { "amount": 5_000_000, "owner": hex(&xonly(&holder)), "ownerScheme": 0 },
            "secretKey": "a1".repeat(32),
        }],
        "outputs": [{ "state": burn, "value": 30_000_000 }],
        "redeem": [{ "outputIndex": 0, "chain": 1, "address": hex(&ADDRESS) }],
    })
}

#[test]
fn the_transfer_builder_refuses_a_redemption_carrying_a_borrow_guard() {
    let build = |guard: [u8; 32], borrow: u8| tx::transfer(&serde_json::from_value(request(guard, borrow)).expect("a transfer request"));
    // The plain burn, and the check the builder does make (borrowing on).
    let plain = build([0; 32], 0).expect("a plain redemption builds");
    assert_eq!(plain.outputs[0].token.as_ref().unwrap().borrow_guard, "00".repeat(32));
    assert!(build([0; 32], 1).is_err(), "a redemption with borrowing on is refused by the builder");
    assert!(build([0x77; 32], 1).is_err());

    // Borrowing off, a guard that is not zero: the builder made it (the engine ran every input while building), payload
    // and all, as a redemption no signer pays. It refuses it now.
    let guarded = build([0x77; 32], 0);
    match &guarded {
        Ok(built) => println!(
            "REV-TOKEN FINDING (low): tx::transfer built redemption {} whose burn state has borrowGuard 77…77: accepted by the script, refused by every signer (signer.ts:575), never spendable",
            built.txid
        ),
        Err(e) => println!("REV-TOKEN: fixed: the builder refuses a guarded redemption: {e}"),
    }
    assert!(guarded.is_err(), "a redemption whose burn state carries a borrow guard is refused");
}
