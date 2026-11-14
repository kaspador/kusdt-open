//! Run 21, round 2 (reviewer crypto2): the core reads a Kaspa address it is given (a change, genesis or split address)
//! without panicking, and pays only an address something can spend from.
//!
//! R21-CRYPTO-3: rusty-kaspa's parser asserts that the payload has its version's length, and reads a version byte that
//! may not be there, so a checksum-valid address of another length panicked: the CLI died and the WebAssembly core
//! trapped. R21-CRYPTO-5: a version-0 payload that is no x-only key on secp256k1, or a version-1 payload that is no
//! compressed key, was paid to, though nothing can ever sign there. Both are errors now; every real key, and any script
//! hash, is paid as before. Through `api::run("split")`, as the reviewer reached the parser (A2, A4).
//!
//!   cargo test --locked --test run21_addresses -- --nocapture

use std::panic::{AssertUnwindSafe, catch_unwind};

use kaspa_addresses::{Address, Prefix, Version};
use kusdt_kaspa::{api, hex};
use secp256k1::{Keypair, Secp256k1, SecretKey};
use serde_json::{Value, json};

const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

fn key(seed: u8) -> Keypair {
    Keypair::from_secret_key(&Secp256k1::new(), &SecretKey::from_slice(&[seed; 32]).expect("a valid test key"))
}

/// `prefix:` and `data` (the version byte, then the payload) in Kaspa's bech32 with its 40-bit checksum, as
/// packages/kaspa/src/address.ts writes it, whatever the lengths: rusty-kaspa's own encoder asserts them.
fn encode(prefix: &str, data: &[u8]) -> String {
    let mut five = Vec::new();
    let (mut buff, mut bits) = (0u32, 0);
    for &b in data {
        buff = buff << 8 | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            five.push((buff >> bits & 31) as u8);
            buff &= (1 << bits) - 1;
        }
    }
    if bits > 0 {
        five.push((buff << (5 - bits) & 31) as u8);
    }
    let mut c = 1u64;
    for d in prefix.bytes().map(|b| b & 31).chain([0]).chain(five.iter().copied()).chain([0; 8]) {
        let c0 = c >> 35;
        c = (c & 0x07_ffff_ffff) << 5 ^ d as u64;
        for (i, g) in [0x98f2bc8e61u64, 0x79b76d99e2, 0xf33e5fb3c4, 0xae2eabe2a8, 0x1e4f43e470].into_iter().enumerate() {
            if c0 >> i & 1 == 1 {
                c ^= g;
            }
        }
    }
    let sum = c ^ 1;
    let checksum = (0..8).rev().map(|i| (sum >> (5 * i) & 31) as u8);
    format!("{prefix}:{}", five.into_iter().chain(checksum).map(|d| CHARSET[d as usize] as char).collect::<String>())
}

fn with_version(version: u8, payload: &[u8]) -> Vec<u8> {
    [&[version], payload].concat()
}

/// What `split` answers with `address` as its change address (the one it splits to): its answer or its error, or the
/// message of the panic that stopped it.
fn split_to(address: &str) -> Result<Result<Value, String>, String> {
    let payer = key(0x31);
    let request = json!({
        "network": "simnet", "changeAddress": address, "count": 1, "value": 50_000_000,
        "funding": [{
            "utxo": { "transactionId": "ab".repeat(32), "index": 0, "amount": 1_000_000_000u64, "scriptPublicKey": format!("000020{}ac", hex::encode(&payer.x_only_public_key().0.serialize())) },
            "secretKey": "31".repeat(32),
        }],
    })
    .to_string();
    catch_unwind(AssertUnwindSafe(|| api::run("split", &request))).map_err(|p| {
        p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
    })
}

/// The first x at or above `from` that is no x coordinate on secp256k1 (half of all x are not).
fn off_curve_x(from: u8) -> [u8; 32] {
    (from..=255).map(|b| { let mut x = [0u8; 32]; x[31] = b; x }).find(|x| secp256k1::XOnlyPublicKey::from_slice(x).is_err()).expect("an x off the curve")
}

#[test]
fn the_encoder_here_writes_what_rusty_kaspa_writes() {
    let k = key(0x41);
    let (xonly, compressed) = (k.x_only_public_key().0.serialize(), k.public_key().serialize());
    assert_eq!(encode("kaspa", &with_version(0, &xonly)), Address::new(Prefix::Mainnet, Version::PubKey, &xonly).to_string());
    assert_eq!(encode("kaspasim", &with_version(1, &compressed)), Address::new(Prefix::Simnet, Version::PubKeyECDSA, &compressed).to_string());
    assert_eq!(encode("kaspatest", &with_version(8, &[0x22; 32])), Address::new(Prefix::Testnet, Version::ScriptHash, &[0x22; 32]).to_string());
}

#[test]
fn an_address_of_the_wrong_length_or_with_no_key_on_the_curve_is_an_error_not_a_panic() {
    let x5 = off_curve_x(5);
    let cases: Vec<(&str, String, &str)> = vec![
        // R21-CRYPTO-3: the reviewer's four, and an address whose data holds no version byte at all.
        ("v0, 20-byte payload", encode("kaspa", &with_version(0, &[0x5a; 20])), "bytes"),
        ("v0, 33-byte payload", encode("kaspa", &with_version(0, &[0x5a; 33])), "bytes"),
        ("v8, 31-byte payload", encode("kaspa", &with_version(8, &[0x5a; 31])), "bytes"),
        ("v1, 32-byte payload", encode("kaspa", &with_version(1, &[0x5a; 32])), "bytes"),
        ("no version byte (checksum only)", encode("kaspa", &[]), "version"),
        // R21-CRYPTO-5: a payload that is no key on the curve.
        ("v0, x off the curve", encode("kaspa", &with_version(0, &x5)), "secp256k1"),
        ("v0, x past the field (all ff)", encode("kaspa", &with_version(0, &[0xff; 32])), "secp256k1"),
        ("v1, 04-prefixed 33 bytes", encode("kaspa", &with_version(1, &with_version(0x04, &[0x5a; 32]))), "secp256k1"),
        ("v1, 02-prefixed x off the curve", encode("kaspa", &with_version(1, &with_version(0x02, &x5))), "secp256k1"),
    ];
    let mut wrong = Vec::new();
    for (what, address, why) in &cases {
        match split_to(address) {
            Err(panic) => {
                println!("RUN21 CRYPTO {what} ({address}): PANIC ({panic})");
                wrong.push(*what);
            }
            Ok(Ok(built)) => {
                println!("RUN21 CRYPTO {what} ({address}): PAID TO, script {}", built["outputs"][0]["scriptPublicKey"]);
                wrong.push(*what);
            }
            Ok(Err(e)) if e.contains(why) => println!("RUN21 CRYPTO {what}: error: {e}"),
            Ok(Err(e)) => {
                println!("RUN21 CRYPTO {what}: an error, but not the one expected ({why}): {e}");
                wrong.push(*what);
            }
        }
    }
    assert!(wrong.is_empty(), "not refused with an error: {wrong:?}");
}

#[test]
fn real_keys_and_script_hashes_are_paid_as_before() {
    let k = key(0x41);
    let (xonly, compressed) = (k.x_only_public_key().0.serialize(), k.public_key().serialize());
    let odd_y = (1..=255).map(key).find(|k| k.public_key().serialize()[0] == 0x03).expect("a key with an odd y").public_key().serialize();
    let cases = [
        (with_version(0, &xonly), format!("20{}ac", hex::encode(&xonly))),
        (with_version(1, &compressed), format!("21{}ab", hex::encode(&compressed))),
        (with_version(1, &odd_y), format!("21{}ab", hex::encode(&odd_y))),
        // A script hash is a hash: no point to check, any 32 bytes.
        (with_version(8, &[0xff; 32]), format!("aa20{}87", "ff".repeat(32))),
    ];
    for (data, script) in cases {
        for prefix in ["kaspa", "kaspatest", "kaspasim"] {
            let address = encode(prefix, &data);
            let built = split_to(&address).expect("no panic").unwrap_or_else(|e| panic!("{address}: {e}"));
            assert_eq!(built["outputs"][0]["scriptPublicKey"], json!(format!("0000{script}")), "{address}");
        }
    }
}
