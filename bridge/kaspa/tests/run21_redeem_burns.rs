//! Run 21, outside review (Daybreak [27]): the `transfer` builder makes only redemptions the bridge pays.
//!
//! A burn owner's script starts with OP_RETURN, so kUSDT sent to one never moves again. The signers pay a burn only on
//! chain 1 (Ethereum) or 2 (BNB Chain), never to the zero address, and only when its state is plain: borrowing off, a
//! zero borrow guard and extension commitment, an amount above zero (signer.ts signRelease, coordinator.ts plainBurn,
//! SPEC §9). The builder checked the owner and the borrow scheme only, so it signed redemptions no signer would ever
//! pay, and the holder's kUSDT and the burn's KAS were gone. Through `api::run`, as the CLI and the WebAssembly core
//! call it: every such redemption is refused, and honest ones build as before.
//!
//!   cargo test --locked --test run21_redeem_burns -- --nocapture

use kaspa_addresses::{Address, Prefix, Version};
use kusdt_kaspa::{api, hex, protocol::burn_owner};
use secp256k1::{Keypair, Secp256k1, SecretKey};
use serde_json::{Value, json};

const ADDRESS: [u8; 20] = [0x5a; 20];
const HELD: i64 = 5_000_000;

fn key(seed: u8) -> Keypair {
    Keypair::from_secret_key(&Secp256k1::new(), &SecretKey::from_slice(&[seed; 32]).expect("a valid test key"))
}

fn xonly(k: &Keypair) -> String {
    hex::encode(&k.x_only_public_key().0.serialize())
}

/// A plain kUSDT state of `owner` under `scheme`.
fn token(owner: &str, scheme: u8, amount: i64) -> Value {
    json!({ "amount": amount, "owner": owner, "ownerScheme": scheme, "borrowScheme": 0, "borrowGuard": "00".repeat(32), "extensionCommitment": "00".repeat(32) })
}

/// A plain state of the burn owner of `chain` and `address`.
fn burn_to(chain: u8, address: &[u8; 20], amount: i64) -> Value {
    token(&hex::encode(&burn_owner(chain, address)), 3, amount)
}

fn burn(chain: u8, amount: i64) -> Value {
    burn_to(chain, &ADDRESS, amount)
}

fn with(mut base: Value, changes: Value) -> Value {
    for (k, v) in changes.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

/// The holder's HELD kUSDT (carrying the extension commitment `held_extension`), spent whole into `outputs`, naming `redeem`.
fn transfer(held_extension: &str, outputs: Value, redeem: Value) -> Result<Value, String> {
    let (holder, payer) = (key(0xa1), key(0xa9));
    let held = with(token(&xonly(&holder), 0, HELD), json!({ "extensionCommitment": held_extension }));
    let script = api::run("script", &json!({ "actor": "KCC20", "state": held }).to_string())?["scriptPublicKey"].clone();
    let request = json!({
        "network": "mainnet",
        "changeAddress": Address::new(Prefix::Mainnet, Version::PubKey, &payer.x_only_public_key().0.serialize()).to_string(),
        "funding": [{
            "utxo": { "transactionId": "f1".repeat(32), "index": 0, "amount": 10_000_000_000u64, "scriptPublicKey": format!("000020{}ac", xonly(&payer)) },
            "secretKey": "a9".repeat(32),
        }],
        "inputs": [{
            "utxo": { "transactionId": "e1".repeat(32), "index": 0, "amount": 150_000_000, "scriptPublicKey": script, "covenantId": "cd".repeat(32) },
            "state": held,
            "secretKey": "a1".repeat(32),
        }],
        "outputs": outputs,
        "redeem": redeem,
    });
    api::run("transfer", &request.to_string())
}

/// Everything held burned into `state` (0.3 KAS with it), named for `chain` and `address`.
fn redeem_all(state: Value, chain: u8, address: &str) -> Result<Value, String> {
    transfer(&"00".repeat(32), json!([{ "state": state, "value": 30_000_000 }]), json!([{ "outputIndex": 0, "chain": chain, "address": address }]))
}

#[test]
fn a_redemption_the_signers_would_never_pay_is_not_built() {
    let address = hex::encode(&ADDRESS);
    let named = json!([{ "outputIndex": 0, "chain": 1, "address": address }]);
    let guarded = with(burn(1, HELD), json!({ "borrowGuard": "77".repeat(32) }));
    let cases: Vec<(&str, Result<Value, String>, &str)> = vec![
        ("chain 3, which has no vault", redeem_all(burn(3, HELD), 3, &address), "chain 3"),
        ("chain 0", redeem_all(burn(0, HELD), 0, &address), "chain 0"),
        ("chain 255", redeem_all(burn(255, HELD), 255, &address), "chain 255"),
        ("chain 1, borrow guard 77..77", redeem_all(guarded.clone(), 1, &address), "no signer would pay"),
        ("chain 1, borrow scheme 1", redeem_all(with(burn(1, HELD), json!({ "borrowScheme": 1 })), 1, &address), "no signer would pay"),
        // The script takes an extension only when the spent state carries the same one: the held state does here.
        (
            "chain 1, extension 77..77 carried over from the spent state",
            transfer(&"77".repeat(32), json!([{ "state": with(burn(1, HELD), json!({ "extensionCommitment": "77".repeat(32) })), "value": 30_000_000 }]), named.clone()),
            "no signer would pay",
        ),
        (
            "chain 1, a burn of nothing beside change of everything",
            transfer(&"00".repeat(32), json!([{ "state": burn(1, 0), "value": 30_000_000 }, { "state": token(&xonly(&key(0xa1)), 0, HELD), "value": 150_000_000 }]), named.clone()),
            "no signer would pay",
        ),
        (
            "a second output to the named burn owner, with a borrow guard and not named itself",
            transfer(&"00".repeat(32), json!([{ "state": burn(1, 3_000_000), "value": 30_000_000 }, { "state": with(guarded, json!({ "amount": 2_000_000 })), "value": 30_000_000 }]), named),
            "output 1",
        ),
        ("chain 1, the zero address", redeem_all(burn_to(1, &[0; 20], HELD), 1, &"00".repeat(20)), "zero address"),
    ];
    let mut wrong = Vec::new();
    for (what, result, why) in &cases {
        match result {
            Ok(b) => {
                println!("RUN21 [27] {what}: BUILT {}, payload {}", b["txid"], b["transaction"]["payload"]);
                wrong.push(*what);
            }
            Err(e) if e.contains(why) => println!("RUN21 [27] {what}: refused: {e}"),
            Err(e) => {
                println!("RUN21 [27] {what}: refused, but not for the reason expected ({why}): {e}");
                wrong.push(*what);
            }
        }
    }
    assert!(wrong.is_empty(), "redemptions no signer would pay, built or not refused as such: {wrong:?}");
}

#[test]
fn honest_redemptions_build_as_before() {
    let address = hex::encode(&ADDRESS);
    for chain in [1u8, 2] {
        let built = redeem_all(burn(chain, HELD), chain, &address).unwrap_or_else(|e| panic!("chain {chain}: {e}"));
        // "KUSDT" ‖ 01 ‖ one entry: output 0, the chain, the address.
        assert_eq!(built["transaction"]["payload"], json!(format!("4b55534454010100{chain:02x}{address}")));
        assert_eq!(built["outputs"][0]["token"], burn(chain, HELD));
    }
    // A part redeemed and the rest kept, the address spelled 0x and in capitals: the same burn owner.
    let kept = transfer(
        &"00".repeat(32),
        json!([{ "state": burn(2, 1_000_000), "value": 30_000_000 }, { "state": token(&xonly(&key(0xa1)), 0, HELD - 1_000_000), "value": 150_000_000 }]),
        json!([{ "outputIndex": 0, "chain": 2, "address": format!("0x{}", address.to_uppercase()) }]),
    )
    .expect("a burn and change");
    assert_eq!(kept["outputs"][1]["token"]["amount"], json!(HELD - 1_000_000));
    // A transfer that names no redemption is not looked at.
    let sent = transfer(&"00".repeat(32), json!([{ "state": token(&xonly(&key(0xb2)), 0, HELD), "value": 150_000_000 }]), json!([])).expect("a transfer");
    assert_eq!(sent["transaction"]["payload"], json!(""));
}
