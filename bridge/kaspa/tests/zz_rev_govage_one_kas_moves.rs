//! Review of d921d2d (the 1 KAS floor under minted outputs): can a recipient who holds nothing but one kUSDT state
//! carrying exactly 1 KAS move it, paying the fee out of that 1 KAS?
//!
//! Through the real `transfer` builder (src/tx.rs), with NO funding coin: the builder runs every input's script in
//! the engine while it builds, prices the mass, and refuses above MAX_STANDARD_MASS. So "it builds" here means the
//! KCC20 script accepted the spend, the fee at the relay minimum (100 sompi per gram) came out of the state's own
//! KAS, and the mass is inside the builders' limit. What it does not show: a node's mempool taking it.
//!
//! It also prints, for information, the least KAS under a state at which each move still builds.
//!
//!   cargo test --locked --test zz_rev_govage_one_kas_moves -- --nocapture

#[path = "zz_rev_token_support.rs"]
mod support;

use kaspa_addresses::{Address, Prefix, Version};
use kusdt_kaspa::{model::Built, model::spk_to_hex, protocol::burn_owner, tx};
use serde_json::{Value, json};
use support::*;

const ADDRESS: [u8; 20] = [0x5a; 20];
const UNITS: i64 = 5_000_000;
const ONE_KAS: u64 = 100_000_000;

/// A transfer of the holder's one state, which carries `held` sompi, into `outputs` (state JSON, value). No funding.
fn request(held: u64, outputs: &[(Value, u64)], redeem_at: Option<usize>) -> Value {
    let holder = key(0xa1);
    let token = Tok::schnorr(&holder, UNITS).utxo(K, held);
    json!({
        "network": "mainnet",
        "changeAddress": Address::new(Prefix::Mainnet, Version::PubKey, &xonly(&holder)).to_string(),
        "funding": [],
        "inputs": [{
            "utxo": { "transactionId": "e1".repeat(32), "index": 0, "amount": held, "scriptPublicKey": spk_to_hex(&token.script_public_key), "covenantId": hex(&K) },
            "state": { "amount": UNITS, "owner": hex(&xonly(&holder)), "ownerScheme": 0 },
            "secretKey": "a1".repeat(32),
        }],
        "outputs": outputs.iter().map(|(state, value)| json!({ "state": state, "value": value })).collect::<Vec<_>>(),
        "redeem": redeem_at.map(|i| vec![json!({ "outputIndex": i, "chain": 1, "address": hex(&ADDRESS) })]).unwrap_or_default(),
    })
}

fn build(held: u64, outputs: &[(Value, u64)], redeem_at: Option<usize>) -> Result<Built, String> {
    tx::transfer(&serde_json::from_value(request(held, outputs, redeem_at)).expect("a transfer request"))
}

fn to(seed: u8, amount: i64) -> Value {
    json!({ "amount": amount, "owner": hex(&xonly(&key(seed))), "ownerScheme": 0 })
}

fn burn(amount: i64) -> Value {
    json!({ "amount": amount, "owner": hex(&burn_owner(1, &ADDRESS)), "ownerScheme": 3 })
}

fn say(what: &str, r: &Result<Built, String>) {
    match r {
        Ok(b) => println!(
            "[one-kas] {what}: BUILDS fee {} sompi, mass fee {} (compute {}, storage {}, transient {}), outputs {:?}",
            b.fee,
            b.mass.fee_mass,
            b.mass.compute,
            b.mass.storage,
            b.mass.transient,
            b.outputs.iter().map(|o| (o.kind.as_str(), o.value)).collect::<Vec<_>>()
        ),
        Err(e) => println!("[one-kas] {what}: REFUSED: {e}"),
    }
}

#[test]
fn a_holder_of_one_state_carrying_exactly_one_kas_moves_it_with_no_other_coin() {
    // A plain transfer of everything: one output, carrying what is left after the fee.
    let mut best = None;
    for value in [ONE_KAS, 99_900_000, 99_500_000, 99_000_000, 98_000_000, 95_000_000, 90_000_000, 50_000_000] {
        let r = build(ONE_KAS, &[(to(0xb1, UNITS), value)], None);
        say(&format!("send all, the output carrying {value}"), &r);
        if r.is_ok() && best.is_none() {
            best = Some(value);
        }
    }
    assert!(best.is_some(), "a plain transfer of everything builds out of the state's own 1 KAS");
    assert!(build(ONE_KAS, &[(to(0xb1, UNITS), ONE_KAS)], None).is_err(), "not with the whole 1 KAS kept under the output: the fee needs some");

    // A plain transfer of a part: the recipient's state and the holder's change state share the 1 KAS.
    // Two covenant outputs cost storage mass, and the fee is paid on it: about 4e12 * (1/a + 1/b) - 40 000 grams at
    // 100 sompi each. So the two outputs must leave 0.12 to 0.2 KAS for the fee: not every split works.
    let mut part = Vec::new();
    for (a, b) in [
        (49_000_000u64, 49_000_000u64),
        (45_000_000, 45_000_000),
        (42_000_000, 42_000_000),
        (40_000_000, 40_000_000),
        (35_000_000, 35_000_000),
        (25_000_000, 25_000_000),
        (30_000_000, 60_000_000),
        (30_000_000, 50_000_000),
        (20_000_000, 70_000_000),
        (10_000_000, 80_000_000),
    ] {
        let r = build(ONE_KAS, &[(to(0xb1, 1_000_000), a), (to(0xa1, UNITS - 1_000_000), b)], None);
        say(&format!("send a part, recipient {a} and change {b}"), &r);
        if r.is_ok() {
            part.push((a, b));
        }
    }
    assert!(!part.is_empty(), "a plain transfer of a part builds out of the state's own 1 KAS");
    assert!(!part.contains(&(49_000_000, 49_000_000)), "but not with nearly all of the 1 KAS kept under the two outputs");

    // The same at twice the relay minimum feerate: the fee on the storage mass no longer fits in 1 KAS.
    let twice = |a: u64, b: u64| {
        let mut request = request(ONE_KAS, &[(to(0xb1, 1_000_000), a), (to(0xa1, UNITS - 1_000_000), b)], None);
        request["feerate"] = json!(200);
        tx::transfer(&serde_json::from_value(request).expect("a transfer request"))
    };
    let mut at_twice = Vec::new();
    for (a, b) in [(42_000_000u64, 42_000_000u64), (40_000_000, 40_000_000), (35_000_000, 35_000_000), (30_000_000, 30_000_000), (28_000_000, 28_000_000), (25_000_000, 25_000_000)] {
        let r = twice(a, b);
        say(&format!("send a part at feerate 200, recipient {a} and change {b}"), &r);
        if r.is_ok() {
            at_twice.push((a, b));
        }
    }
    println!("[one-kas] send a part at feerate 200: splits that build: {at_twice:?}");

    // A redemption of everything: the burn state carries the wallets' burn value (0.3 KAS), the rest comes back as KAS.
    let r = build(ONE_KAS, &[(burn(UNITS), 30_000_000)], Some(0));
    say("redeem all, the burn carrying 30000000", &r);
    assert!(r.is_ok(), "a redemption of everything builds out of the state's own 1 KAS");

    // A redemption of a part: the burn state and a change state.
    let mut part = false;
    for change in [65_000_000u64, 60_000_000, 50_000_000, 30_000_000] {
        let r = build(ONE_KAS, &[(burn(1_000_000), 30_000_000), (to(0xa1, UNITS - 1_000_000), change)], Some(0));
        say(&format!("redeem a part, the burn 30000000 and change {change}"), &r);
        part |= r.is_ok();
    }
    assert!(part, "a redemption of a part builds out of the state's own 1 KAS");

    // What the wallet asks for today (wallet/extension/src/kusdt/tokens.ts planSend): every token output carries the
    // configured tokenValue, 1.5 KAS. That needs more KAS than the state has, at the floor and at 1.5 KAS alike.
    for held in [ONE_KAS, 150_000_000] {
        let r = build(held, &[(to(0xb1, UNITS), 150_000_000)], None);
        say(&format!("the wallet's shape: a state carrying {held}, the output carrying 150000000"), &r);
        assert!(r.is_err(), "an output at 1.5 KAS cannot be paid from a state carrying {held} and nothing else");
    }
}

/// For information: the least KAS under the state at which each move still builds with no other coin.
#[test]
fn the_least_kas_under_a_state_that_still_moves() {
    for held in [100_000_000u64, 50_000_000, 40_000_000, 35_000_000, 30_000_000, 20_000_000, 10_000_000, 5_000_000, 2_000_000, 1_000_000] {
        // Send all: try keeping as much as possible under the output.
        let mut sent = None;
        for keep_per_mille in [999u64, 995, 990, 980, 950, 900, 800, 500] {
            let value = held / 1000 * keep_per_mille;
            if let Ok(b) = build(held, &[(to(0xb1, UNITS), value)], None) {
                sent = Some((value, b.fee, b.mass.fee_mass, b.mass.storage));
                break;
            }
        }
        match sent {
            Some((value, fee, mass, storage)) => println!("[least] a state carrying {held}: send all builds, output {value}, fee {fee}, mass {mass} (storage {storage})"),
            None => println!("[least] a state carrying {held}: send all does NOT build: {}", build(held, &[(to(0xb1, UNITS), held / 2)], None).err().unwrap_or_default()),
        }
        let redeemed = build(held, &[(burn(UNITS), 30_000_000)], Some(0));
        match &redeemed {
            Ok(b) => println!("[least] a state carrying {held}: redeem all (burn 30000000) builds, fee {}, mass {} (storage {})", b.fee, b.mass.fee_mass, b.mass.storage),
            Err(e) => println!("[least] a state carrying {held}: redeem all (burn 30000000) does NOT build: {e}"),
        }
    }
}
