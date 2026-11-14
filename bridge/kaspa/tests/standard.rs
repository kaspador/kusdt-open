//! Relay standardness of the real builders (the ones the wallet and the
//! services call, through `api::run`): every transaction kind, at its largest
//! shape, must stay within the standard mass and the P2SH sig-op limit with the
//! deployment's values (SPEC §5: token states 1.5 KAS, positions 2 KAS).
//!
//!   cargo test --test standard -- --nocapture    (prints the masses)

mod common;

use common::{key, sign_digest, xonly};
use kaspa_addresses::{Address, Prefix, Version};
use kusdt_kaspa::{api, hex};
use secp256k1::Keypair;
use serde_json::{Value, json};

const KAS: u64 = 100_000_000;
const TOKEN_VALUE: u64 = 150_000_000;
const MINTER_VALUE: u64 = 5 * KAS;
/// What the builders allow (kusdt_kaspa::tx::MAX_STANDARD_MASS): no transaction takes most of a block.
const MAX_STANDARD_MASS: u64 = 300_000;
/// Compute mass stays at the old per-transaction cap: nothing here needs more.
const MAX_COMPUTE_MASS: u64 = 100_000;
/// Transient mass: the pre-Toccata standard cap of 100 000 is relaxed for good from
/// 30 minutes before Toccata activates (rusty-kaspa mining/src/mempool/
/// check_transaction_standard.rs), and covenant transactions only exist after it;
/// then the block limit (1 000 000 transient) is the ceiling. We keep a quarter of it.
const MAX_TRANSIENT_MASS: u64 = 250_000;

fn call(command: &str, request: Value) -> Value {
    api::run(command, &request.to_string()).unwrap_or_else(|e| panic!("{command}: {e}"))
}

fn p2pk(k: &Keypair) -> String {
    format!("000020{}ac", hex::encode(&xonly(k)))
}

fn address(k: &Keypair) -> String {
    Address::new(Prefix::Simnet, Version::PubKey, &xonly(k)).to_string()
}

fn secret(k: &Keypair) -> String {
    hex::encode(&k.secret_bytes())
}

fn coin(seed: u8, k: &Keypair) -> Value {
    json!({
        "utxo": { "transactionId": hex::encode(&[seed; 32]), "index": 0, "amount": 10_000 * KAS, "scriptPublicKey": p2pk(k) },
        "secretKey": secret(k),
    })
}

fn report(what: &str, built: &Value) -> u64 {
    let m = &built["mass"];
    println!("{what:<34} compute {:>6}  storage {:>6}  transient {:>6}  fee {:>9} sompi", m["compute"], m["storage"], m["transient"], built["fee"]);
    let fee_mass = m["feeMass"].as_u64().unwrap();
    assert!(fee_mass <= MAX_STANDARD_MASS, "{what}: mass {fee_mass}");
    assert!(m["compute"].as_u64().unwrap() <= MAX_COMPUTE_MASS, "{what}: compute mass {}", m["compute"]);
    assert!(m["storage"].as_u64().unwrap() <= MAX_STANDARD_MASS, "{what}: storage mass {}", m["storage"]);
    assert!(m["transient"].as_u64().unwrap() <= MAX_TRANSIENT_MASS, "{what}: transient mass {}", m["transient"]);
    fee_mass
}

struct Family {
    payer: Keypair,
    signers: Vec<Keypair>,
    covenant_id: String,
    minter: Value,
}

fn launch() -> Family {
    let payer = key(200);
    let signers: Vec<Keypair> = (1..=5).map(key).collect();
    let signer_keys: Vec<String> = signers.iter().map(|k| hex::encode(&xonly(k))).collect();
    let signer_set = call("signer-set", json!({ "signerKeys": signer_keys }))["signerSet"].clone();
    let state = json!({
        "remaining": "1000000000000000", "bucket": "500000000000", "capacity": "500000000000",
        "refillPerDaa": 578_703, "nonceEthereum": 0, "nonceBsc": 0, "adminNonce": 0, "paused": false,
        "signerSet": signer_set, "guardian": hex::encode(&xonly(&key(9))),
    });
    let genesis = call("genesis", json!({
        "network": "simnet", "changeAddress": address(&payer), "funding": [coin(1, &payer)],
        "minter": state, "minterValue": MINTER_VALUE, "seedOwner": hex::encode(&xonly(&payer)), "seedValue": 2 * KAS,
    }));
    report("genesis", &genesis);
    let covenant_id = genesis["covenantId"].as_str().unwrap().to_string();
    let minter = json!({
        "utxo": {
            "transactionId": genesis["txid"], "index": 0, "amount": MINTER_VALUE,
            "scriptPublicKey": genesis["outputs"][0]["scriptPublicKey"], "covenantId": covenant_id,
        },
        "state": genesis["outputs"][0]["minter"],
    });
    Family { payer, signers, covenant_id, minter }
}

fn mint(f: &Family, holders: &[Keypair], token_value: u64) -> Value {
    let recipients: Vec<Value> = holders
        .iter()
        .enumerate()
        .map(|(i, h)| json!({ "ownerScheme": 0, "owner": hex::encode(&xonly(h)), "amount": 1_000_000 * (i as u64 + 1) }))
        .collect();
    let digest = call("mint-digest", json!({ "covenantId": f.covenant_id, "chain": 1, "firstNonce": 0, "recipients": recipients }));
    let digest: [u8; 32] = hex::decode(digest["digest"].as_str().unwrap()).unwrap().try_into().unwrap();
    let signatures: Vec<String> = [0usize, 2, 4].iter().map(|&i| hex::encode(&sign_digest(&f.signers[i], &digest))).collect();
    call("mint", json!({
        "network": "simnet", "changeAddress": address(&f.payer), "funding": [coin(2, &f.payer)],
        "minter": f.minter, "chain": 1, "firstNonce": 0, "ageDaa": 0, "recipients": recipients,
        "signerKeys": f.signers.iter().map(|k| hex::encode(&xonly(k))).collect::<Vec<_>>(),
        "signerIndices": [0, 2, 4], "signatures": signatures, "tokenValue": token_value,
    }))
}

fn token_input(minted: &Value, index: usize, holder: &Keypair, covenant_id: &str) -> Value {
    let out = &minted["outputs"][index];
    json!({
        "utxo": {
            "transactionId": minted["txid"], "index": index, "amount": out["value"],
            "scriptPublicKey": out["scriptPublicKey"], "covenantId": covenant_id,
        },
        "state": out["token"],
        "secretKey": secret(holder),
    })
}

#[test]
fn mints_of_one_to_three_recipients_are_standard() {
    let f = launch();
    let holders: Vec<Keypair> = (20..23).map(key).collect();
    for n in 1..=3 {
        let built = mint(&f, &holders[..n], TOKEN_VALUE);
        report(&format!("mint, {n} recipient(s)"), &built);
    }
}

#[test]
fn transfers_and_redemptions_at_their_largest_are_standard() {
    let f = launch();
    let holder = key(20);
    let minted = mint(&f, &[holder, holder, holder], TOKEN_VALUE);
    let inputs: Vec<Value> = (1..=3).map(|i| token_input(&minted, i, &holder, &f.covenant_id)).collect();
    let state = |amount: u64, owner: &str, scheme: u8| json!({ "amount": amount, "owner": owner, "ownerScheme": scheme });
    let me = hex::encode(&xonly(&holder));

    // 3 inputs (6 kUSDT in all) into 3 outputs: the KCC-20 maximum.
    let transfer = call("transfer", json!({
        "network": "simnet", "changeAddress": address(&f.payer), "funding": [coin(3, &f.payer)],
        "inputs": inputs,
        "outputs": [
            { "state": state(1_000_000, &me, 0), "value": TOKEN_VALUE },
            { "state": state(2_000_000, &hex::encode(&xonly(&key(21))), 0), "value": TOKEN_VALUE },
            { "state": state(3_000_000, &hex::encode(&xonly(&key(22))), 0), "value": TOKEN_VALUE },
        ],
    }));
    report("transfer, 3 in, 3 out", &transfer);

    // A redemption with two burns (both chains) and change.
    let eth = "11".repeat(20);
    let bsc = "22".repeat(20);
    let burn_eth = call("burn-owner", json!({ "chain": 1, "address": eth }));
    let burn_bsc = call("burn-owner", json!({ "chain": 2, "address": bsc }));
    let redeem = call("transfer", json!({
        "network": "simnet", "changeAddress": address(&f.payer), "funding": [coin(4, &f.payer)],
        "inputs": (1..=3).map(|i| token_input(&minted, i, &holder, &f.covenant_id)).collect::<Vec<_>>(),
        "outputs": [
            { "state": state(2_000_000, burn_eth["owner"].as_str().unwrap(), 3), "value": TOKEN_VALUE },
            { "state": state(3_000_000, burn_bsc["owner"].as_str().unwrap(), 3), "value": TOKEN_VALUE },
            { "state": state(1_000_000, &me, 0), "value": TOKEN_VALUE },
        ],
        "redeem": [
            { "outputIndex": 0, "chain": 1, "address": eth },
            { "outputIndex": 1, "chain": 2, "address": bsc },
        ],
    }));
    report("redeem, 3 in, 2 burns + change", &redeem);
}

/// A burn output can never be spent, so the KAS it carries is lost with it. A smaller
/// one costs storage mass (C / value, doubled for covenant outputs) and so fee instead:
/// the KAS a redemption costs is about value + fee. Prints both for a range of values.
#[test]
fn burn_outputs_can_carry_less_kas() {
    let f = launch();
    let holder = key(20);
    let minted = mint(&f, &[holder], TOKEN_VALUE);
    let me = hex::encode(&xonly(&holder));
    let eth = "11".repeat(20);
    let burn = call("burn-owner", json!({ "chain": 1, "address": eth }));
    let state = |amount: u64, owner: &str, scheme: u8| json!({ "amount": amount, "owner": owner, "ownerScheme": scheme });
    let mut costs = Vec::new();
    for burn_value in [TOKEN_VALUE, 50_000_000, 30_000_000, 20_000_000, 15_000_000] {
        let redeem = call("transfer", json!({
            "network": "simnet", "changeAddress": address(&f.payer), "funding": [coin(5, &f.payer)],
            "inputs": [token_input(&minted, 1, &holder, &f.covenant_id)],
            "outputs": [
                { "state": state(600_000, burn["owner"].as_str().unwrap(), 3), "value": burn_value },
                { "state": state(400_000, &me, 0), "value": TOKEN_VALUE },
            ],
            "redeem": [{ "outputIndex": 0, "chain": 1, "address": eth }],
        }));
        let fee = redeem["fee"].as_u64().unwrap();
        report(&format!("redeem, burn {:.2} KAS", burn_value as f64 / KAS as f64), &redeem);
        println!("    the redemption costs {:.4} KAS: {:.2} locked + {:.4} fee", (burn_value + fee) as f64 / KAS as f64, burn_value as f64 / KAS as f64, fee as f64 / KAS as f64);
        costs.push((burn_value, burn_value + fee));
    }
    // The deployments' burn value (0.3 KAS) costs under a third of a 1.5 KAS burn.
    let at = |v: u64| costs.iter().find(|(b, _)| *b == v).unwrap().1;
    assert!(at(30_000_000) * 3 < at(TOKEN_VALUE), "0.3 KAS: {} sompi, 1.5 KAS: {}", at(30_000_000), at(TOKEN_VALUE));
}

/// A pool output of `built` at `index` (the pool's successor is output 0).
fn located(built: &Value, index: usize, covenant_id: &str, kind: &str) -> Value {
    let out = &built["outputs"][index];
    json!({
        "utxo": {
            "transactionId": built["txid"], "index": index, "amount": out["value"],
            "scriptPublicKey": out["scriptPublicKey"], "covenantId": covenant_id, "blockDaaScore": 4_000,
        },
        "state": out[kind],
    })
}

#[test]
fn pool_transactions_are_standard() {
    let f = launch();
    let lp = key(20);
    let minted = mint(&f, &[lp, lp, lp], TOKEN_VALUE);
    let (admin, guardian) = (key(30), key(32));
    let common = |seed: u8| json!({ "network": "simnet", "changeAddress": address(&f.payer), "funding": [coin(seed, &f.payer)] });
    let with = |seed: u8, extra: Value| {
        let mut v = common(seed);
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    };

    let genesis = call("pool-genesis", with(10, json!({
        "tokenCovid": f.covenant_id, "baseValue": KAS, "admin": hex::encode(&xonly(&admin)),
        "guardian": hex::encode(&xonly(&guardian)), "maxOutBps": 1_000, "windowLen": 36_000,
    })));
    report("pool genesis", &genesis);
    let pool_id = genesis["covenantId"].as_str().unwrap().to_string();
    let pool = located(&genesis, 0, &pool_id, "pool");

    // 100 KAS against 2 kUSDT from the 3 kUSDT state; the change stays with the provider.
    let init = call("pool-init", with(11, json!({
        "pool": pool, "provider": token_input(&minted, 3, &lp, &f.covenant_id),
        "kasIn": 100 * KAS, "tokensIn": 2_000_000, "positionOwner": hex::encode(&xonly(&lp)),
        "tokenValue": TOKEN_VALUE, "positionValue": 2 * KAS, "adminSecretKey": secret(&admin),
    })));
    report("pool init", &init);
    let (pool, reserve) = (located(&init, 0, &pool_id, "pool"), located(&init, 2, &f.covenant_id, "token"));

    let quote = call("quote", json!({ "kind": "buy", "pool": pool["state"], "kasIn": KAS }));
    let buy = call("pool-buy", with(12, json!({
        "pool": pool, "reserve": reserve, "kasIn": KAS, "tokensOut": quote["tokensOut"],
        "buyer": hex::encode(&xonly(&lp)), "tokenValue": TOKEN_VALUE,
    })));
    report("pool buy", &buy);
    let (pool, reserve) = (located(&buy, 0, &pool_id, "pool"), located(&buy, 1, &f.covenant_id, "token"));

    // Sell 0.1 of the 1 kUSDT init change (≈ 5 % of the KAS side): under the breaker, locked to nowDaa.
    let mut payer = located(&init, 3, &f.covenant_id, "token");
    payer["secretKey"] = json!(secret(&lp));
    let quote = call("quote", json!({ "kind": "sell", "pool": pool["state"], "tokensIn": 100_000, "nowDaa": 5_000 }));
    assert_eq!(quote["breaker"]["allowed"], json!(true), "a small sell is under the breaker: {quote}");
    let sell = call("pool-sell", with(13, json!({
        "pool": pool, "reserve": reserve, "payer": payer, "tokensIn": 100_000, "kasOut": quote["kasOut"],
        "tokenValue": TOKEN_VALUE, "nowDaa": 5_000,
    })));
    report("pool sell (breaker, lock time)", &sell);
    assert_eq!(sell["outputs"][0]["pool"]["windowRef"], sell["outputs"][0]["pool"]["kasReserve"]);
    let (pool, reserve) = (located(&sell, 0, &pool_id, "pool"), located(&sell, 1, &f.covenant_id, "token"));

    // More than the breaker's 10 % is refused before anything is signed.
    let big = call("quote", json!({ "kind": "sell", "pool": pool["state"], "tokensIn": 2_000_000, "nowDaa": 5_001 }));
    assert_eq!(big["breaker"]["allowed"], json!(false), "{big}");

    let shares = call("quote", json!({ "kind": "add", "pool": pool["state"], "kasIn": 10 * KAS, "tokensIn": 200_000 }));
    let add = call("pool-add", with(14, json!({
        "pool": pool, "reserve": reserve, "provider": token_input(&minted, 2, &lp, &f.covenant_id),
        "kasIn": 10 * KAS, "tokensIn": 200_000, "shares": shares["shares"], "positionOwner": hex::encode(&xonly(&lp)),
        "tokenValue": TOKEN_VALUE, "positionValue": 2 * KAS, "nowDaa": 5_000,
    })));
    report("pool add", &add);
    let pool = located(&add, 0, &pool_id, "pool");

    let tick = call("pool-tick", with(18, json!({ "pool": pool, "nowDaa": 5_000 })));
    report("pool tick (anyone)", &tick);
    let pool = located(&tick, 0, &pool_id, "pool");

    let pause = call("pool-pause", with(15, json!({ "pool": pool, "secretKey": secret(&guardian) })));
    report("pool pause (guardian)", &pause);
    let pool = located(&pause, 0, &pool_id, "pool");
    assert_eq!(pool["state"]["paused"], json!(true));
    let unpause = call("pool-unpause", with(16, json!({ "pool": pool, "secretKey": secret(&admin) })));
    report("pool unpause (admin)", &unpause);
    let pool = located(&unpause, 0, &pool_id, "pool");
    let keys = call("pool-set-keys", with(17, json!({ "pool": pool, "secretKey": secret(&admin), "newGuardian": hex::encode(&xonly(&key(33))) })));
    report("pool set-keys (admin)", &keys);
}
