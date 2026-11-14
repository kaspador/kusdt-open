//! The pool's slots: the minimum claim against a bot taking every slot, through the real builders.
//!
//! While more than half of the stored cap is in use, every public pool entry claims at least `min_age` (50 DAA), so a
//! pool UTXO can be spent once it is 50 DAA old: one slot per pool UTXO. Clients build at the first DAA the sequence lock
//! allows (their node's virtual DAA), the same DAA as a bot's, so which spend gets the slot is the network's call. Each
//! spend claims the minimum and refills it, so the count comes back to half of the cap at the stated rate, and below that
//! nothing a bot spends brings the minimum back (2026-11-10 review of branch `pool-clock`, finding H1).
//!
//! Every transaction is built with the real builders (`api::run`) and checked with the node's rules (sequence locks
//! against the virtual DAA, masses, relay fee) and the real script engine with covenants, as tests/audit3_kaspa_rules.rs
//! does (its `node_rules`, minus the independent mass cross-check).
//!
//!   cargo test --release --test pool_slots -- --nocapture

#![allow(dead_code)]

mod common;

use argent_runtime::execute_transaction_with_covenants;
use common::{key, sign_digest, xonly};
use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::{
    Hash,
    config::params::MAINNET_PARAMS,
    constants::{LOCK_TIME_THRESHOLD, MAX_SOMPI, SEQUENCE_LOCK_TIME_DISABLED, SEQUENCE_LOCK_TIME_MASK},
    mass::MassCalculator,
    subnets::SubnetworkId,
    tx::{CovenantBinding, PopulatedTransaction, Transaction, TransactionId, TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry},
};
use kaspa_txscript::script_class::ScriptClass;
use kusdt_kaspa::{api, hex, model::Utxo, model::spk_from_hex};
use secp256k1::Keypair;
use serde_json::{Value, json};

const KAS: u64 = 100_000_000;
const TOKEN_VALUE: u64 = 150_000_000;
const POSITION_VALUE: u64 = 2 * KAS;
const MINTER_VALUE: u64 = 5 * KAS;
const VIRTUAL_DAA: u64 = 600_000_000;
const MINTER_AGE: i64 = 90;
/// pool.ag: window_len / 720 at the deployed window of 36 000.
const MIN_AGE: u64 = 50;

// --------------------------------------------------------------------------
// Copied from tests/audit3_kaspa_rules.rs: the transaction as JSON, and the node's rules.

#[derive(Debug, Clone, Copy)]
struct NodeView {
    compute: u64,
    transient: u64,
    normalized_transient: u64,
    storage: u64,
    fee: u64,
    min_relay_fee: u64,
}

fn hex_bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().expect("a hex string")).expect("valid hex")
}

fn tx_from_json(j: &Value) -> Transaction {
    let inputs: Vec<TransactionInput> = j["inputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            let op = &i["previousOutpoint"];
            let id: [u8; 32] = hex_bytes(&op["transactionId"]).try_into().expect("32 bytes");
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint::new(TransactionId::from_bytes(id), op["index"].as_u64().unwrap() as u32),
                hex_bytes(&i["signatureScript"]),
                i["sequence"].as_u64().unwrap(),
                u16::try_from(i["computeBudget"].as_u64().unwrap()).expect("computeBudget fits u16"),
            )
        })
        .collect();
    let outputs: Vec<TransactionOutput> = j["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| {
            let spk = spk_from_hex(o["scriptPublicKey"].as_str().unwrap()).unwrap();
            let covenant = o.get("covenant").filter(|c| !c.is_null()).map(|c| {
                let id: [u8; 32] = hex_bytes(&c["covenantId"]).try_into().unwrap();
                CovenantBinding::new(u16::try_from(c["authorizingInput"].as_u64().unwrap()).unwrap(), Hash::from_bytes(id))
            });
            TransactionOutput::with_covenant(o["value"].as_u64().unwrap(), spk, covenant)
        })
        .collect();
    let subnet: [u8; 20] = hex_bytes(&j["subnetworkId"]).try_into().expect("20 bytes");
    Transaction::new(
        j["version"].as_u64().unwrap() as u16,
        inputs,
        outputs,
        j["lockTime"].as_u64().unwrap(),
        SubnetworkId::from_bytes(subnet),
        j["gas"].as_u64().unwrap(),
        hex_bytes(&j["payload"]),
    )
}

fn entry_of(utxo: &Value) -> UtxoEntry {
    serde_json::from_value::<Utxo>(utxo.clone()).expect("a UTXO").entry().expect("a UTXO entry")
}

/// The node's rules outside the script engine, then the script engine with covenants (audit3_kaspa_rules.rs `node_rules`,
/// minus its independent mass cross-check).
fn node_rules(built: &Value, utxos: &[&Value], virtual_daa: u64, what: &str) -> Result<NodeView, String> {
    let tx = tx_from_json(&built["transaction"]);
    let entries: Vec<UtxoEntry> = utxos.iter().map(|u| entry_of(u)).collect();
    if tx.inputs.len() != entries.len() {
        return Err(format!("{what}: the transaction has {} inputs, the case lists {} coins", tx.inputs.len(), entries.len()));
    }
    let mut total_out = 0u64;
    for o in &tx.outputs {
        total_out = total_out.checked_add(o.value).ok_or("outputs overflow")?;
    }
    if total_out > MAX_SOMPI {
        return Err(format!("{what}: outputs above MAX_SOMPI"));
    }
    if tx.lock_time != 0 {
        if tx.lock_time >= LOCK_TIME_THRESHOLD {
            return Err(format!("{what}: lock time is a timestamp"));
        }
        if tx.lock_time >= virtual_daa && tx.inputs.iter().any(|i| i.sequence != u64::MAX) {
            return Err(format!("{what}: not finalized"));
        }
    }
    let mut total_in = 0u64;
    for (i, (input, entry)) in tx.inputs.iter().zip(&entries).enumerate() {
        if entry.is_coinbase && entry.block_daa_score + 1_000 > virtual_daa {
            return Err(format!("{what}: input {i} spends an immature coinbase"));
        }
        total_in = total_in.checked_add(entry.amount).ok_or("inputs overflow")?;
        // tx_validation_in_utxo_context.rs check_sequence_lock (rusty-kaspa a41a333).
        if input.sequence & SEQUENCE_LOCK_TIME_DISABLED != SEQUENCE_LOCK_TIME_DISABLED {
            let relative = (input.sequence & SEQUENCE_LOCK_TIME_MASK) as i64;
            let lock = entry.block_daa_score as i64 + relative - 1;
            if lock >= virtual_daa as i64 {
                return Err(format!("{what}: input {i} sequence lock not met: UTXO DAA {} + {relative} > virtual {virtual_daa}", entry.block_daa_score));
            }
        }
    }
    if total_in < total_out {
        return Err(format!("{what}: spends {total_out} but holds {total_in}"));
    }
    let fee = total_in - total_out;
    let calculator = MassCalculator::new_with_consensus_params(&MAINNET_PARAMS);
    let masses = calculator.calc_non_contextual_masses(&tx);
    let populated = PopulatedTransaction::new(&tx, entries.clone());
    let storage = calculator.calc_contextual_masses(&populated).ok_or("storage mass incomputable")?.storage_mass;
    let limits = MAINNET_PARAMS.block_mass_limits().after();
    if masses.compute_mass > limits.compute || masses.transient_mass > limits.transient || storage > limits.storage {
        return Err(format!("{what}: above a block mass limit"));
    }
    for (i, o) in tx.outputs.iter().enumerate() {
        if ScriptClass::from_script(&o.script_public_key) == ScriptClass::NonStandard {
            return Err(format!("{what}: output {i} has a non-standard script class"));
        }
    }
    let normalized_transient = (masses.transient_mass as f64 * 0.5).ceil() as u64;
    let fee_mass = masses.compute_mass.max(normalized_transient);
    let min_relay_fee = match fee_mass * 100_000 / 1000 {
        0 => 100_000,
        m => m,
    };
    if fee < min_relay_fee {
        return Err(format!("{what}: fee {fee} below the relay minimum {min_relay_fee}"));
    }
    let mut run = tx.clone();
    execute_transaction_with_covenants(&mut run, entries.clone()).map_err(|e| format!("{what}: scripts: {e}"))?;
    for (i, (a, b)) in tx.inputs.iter().zip(&run.inputs).enumerate() {
        let (committed, used) = (a.compute_commit.compute_budget().unwrap(), b.compute_commit.compute_budget().unwrap());
        if used > committed {
            return Err(format!("{what}: input {i} needs compute budget {used} but commits {committed}"));
        }
    }
    Ok(NodeView { compute: masses.compute_mass, transient: masses.transient_mass, normalized_transient, storage, fee, min_relay_fee })
}

// --------------------------------------------------------------------------
// Builder plumbing.

fn call(command: &str, request: Value) -> Value {
    api::run(command, &request.to_string()).unwrap_or_else(|e| panic!("{command}: {e}"))
}

fn p2pk(k: &Keypair) -> String {
    format!("000020{}ac", hex::encode(&xonly(k)))
}

fn address(k: &Keypair) -> String {
    Address::new(Prefix::Mainnet, Version::PubKey, &xonly(k)).to_string()
}

fn secret(k: &Keypair) -> String {
    hex::encode(&k.secret_bytes())
}

/// A distinct funding coin per `n` (the shared fixtures only have 256).
fn coin(n: u32, k: &Keypair, amount: u64) -> Value {
    let mut id = [0xabu8; 32];
    id[..4].copy_from_slice(&n.to_be_bytes());
    json!({
        "utxo": { "transactionId": hex::encode(&id), "index": 0, "amount": amount, "scriptPublicKey": p2pk(k), "blockDaaScore": 1_000 },
        "secretKey": secret(k),
    })
}

fn common_for(payer: &Keypair, funding: &Value) -> Value {
    json!({ "network": "mainnet", "changeAddress": address(payer), "funding": [funding] })
}

fn with(mut base: Value, extra: Value) -> Value {
    base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    base
}

/// Output `index` of `built` as the next builder's input, accepted at DAA score `daa`.
fn located_at(built: &Value, index: usize, covenant_id: &str, kind: &str, daa: u64) -> Value {
    let out = &built["outputs"][index];
    json!({
        "utxo": {
            "transactionId": built["txid"], "index": index, "amount": out["value"],
            "scriptPublicKey": out["scriptPublicKey"], "covenantId": covenant_id, "blockDaaScore": daa,
        },
        "state": out[kind],
    })
}

fn owned(mut located: Value, holder: &Keypair) -> Value {
    located["secretKey"] = json!(secret(holder));
    located
}

struct Launched {
    payer: Keypair,
    covenant_id: String,
    pool_id: String,
    lp: Keypair,
    bot: Keypair,
    admin: Keypair,
    guardian: Keypair,
    pool: Value,
    reserve: Value,
    position: Value,
    bot_tokens: Value,
    seller_tokens: Value,
    coins: u32,
}

impl Launched {
    fn funding(&mut self) -> (Value, Value) {
        self.coins += 1;
        let c = coin(self.coins, &self.payer, 10_000 * KAS);
        (common_for(&self.payer, &c), c)
    }
}

/// kUSDT, a pool with the deployment's breaker (10 %, 36 000 DAA), 10 000 KAS and 1 000 kUSDT in it, and kUSDT for a
/// bot and an honest seller. Every state is accepted at `daa`.
fn launch(daa: u64) -> Launched {
    let payer = key(200);
    let signers: Vec<Keypair> = (1..=5).map(key).collect();
    let guardian = key(9);
    let signer_keys: Vec<String> = signers.iter().map(|k| hex::encode(&xonly(k))).collect();
    let signer_set = call("signer-set", json!({ "signerKeys": signer_keys }))["signerSet"].clone();
    let minter_state = json!({
        "remaining": "1000000000000000", "bucket": "500000000000", "capacity": "500000000000",
        "refillPerDaa": 578_703, "nonceEthereum": 0, "nonceBsc": 0, "adminNonce": 0, "paused": false,
        "signerSet": signer_set, "guardian": hex::encode(&xonly(&guardian)),
    });
    let mut n = 1_000_000u32;
    let mut fund = || {
        n += 1;
        coin(n, &payer, 50_000 * KAS)
    };
    let f = fund();
    let genesis = call("genesis", json!({
        "network": "mainnet", "changeAddress": address(&payer), "funding": [f],
        "minter": minter_state, "minterValue": MINTER_VALUE, "seedOwner": hex::encode(&xonly(&payer)), "seedValue": 2 * KAS,
    }));
    let covenant_id = genesis["covenantId"].as_str().unwrap().to_string();
    let minter = json!({
        "utxo": {
            "transactionId": genesis["txid"], "index": 0, "amount": MINTER_VALUE,
            "scriptPublicKey": genesis["outputs"][0]["scriptPublicKey"], "covenantId": covenant_id, "blockDaaScore": VIRTUAL_DAA - 100,
        },
        "state": genesis["outputs"][0]["minter"],
    });
    let (lp, bot, seller) = (key(20), key(21), key(22));
    let recipients: Vec<Value> = [(&lp, 1_000_000_000u64), (&bot, 10_000_000), (&seller, 100_000_000)]
        .iter()
        .map(|(k, amount)| json!({ "ownerScheme": 0, "owner": hex::encode(&xonly(k)), "amount": amount }))
        .collect();
    let digest = call("mint-digest", json!({ "covenantId": covenant_id, "chain": 1, "firstNonce": 0, "ageDaa": MINTER_AGE, "recipients": recipients }));
    let d: [u8; 32] = hex::decode(digest["digest"].as_str().unwrap()).unwrap().try_into().unwrap();
    let signatures: Vec<String> = [0usize, 2, 4].iter().map(|&i| hex::encode(&sign_digest(&signers[i], &d))).collect();
    let f = fund();
    let minted = call("mint", json!({
        "network": "mainnet", "changeAddress": address(&payer), "funding": [f],
        "minter": minter, "chain": 1, "firstNonce": 0, "ageDaa": MINTER_AGE, "recipients": recipients,
        "signerKeys": signer_keys, "signerIndices": [0, 2, 4], "signatures": signatures, "tokenValue": TOKEN_VALUE,
    }));
    let token = |i: usize, k: &Keypair| owned(located_at(&minted, i, &covenant_id, "token", daa), k);
    let (admin, pool_guardian) = (key(30), key(32));
    let f = fund();
    let pool_genesis = call("pool-genesis", with(common_for(&payer, &f), json!({
        "tokenCovid": covenant_id, "baseValue": KAS, "admin": hex::encode(&xonly(&admin)),
        "guardian": hex::encode(&xonly(&pool_guardian)), "maxOutBps": 1_000, "windowLen": 36_000,
    })));
    let pool_id = pool_genesis["covenantId"].as_str().unwrap().to_string();
    let f = fund();
    let init = call("pool-init", with(common_for(&payer, &f), json!({
        "pool": located_at(&pool_genesis, 0, &pool_id, "pool", daa), "provider": token(1, &lp), "kasIn": 10_000 * KAS, "tokensIn": 1_000_000_000u64,
        "positionOwner": hex::encode(&xonly(&lp)), "tokenValue": TOKEN_VALUE, "positionValue": POSITION_VALUE, "adminSecretKey": secret(&admin),
    })));
    let pool = located_at(&init, 0, &pool_id, "pool", daa);
    let position = located_at(&init, 1, &pool_id, "position", daa);
    let reserve = located_at(&init, 2, &covenant_id, "token", daa);
    let (bot_tokens, seller_tokens) = (token(2, &bot), token(3, &seller));
    Launched { payer, covenant_id, pool_id, lp, bot, admin, guardian: pool_guardian, pool, reserve, position, bot_tokens, seller_tokens, coins: 0 }
}

fn window_out(pool: &Value) -> i64 {
    pool["state"]["windowOut"].as_i64().unwrap_or_else(|| pool["state"]["windowOut"].as_str().unwrap().parse().unwrap())
}

/// A sell of `tokens_in` from `payer` (with change), claiming the age `now_daa - poolDaa`.
fn sell(l: &mut Launched, payer: &Value, tokens_in: u64, now_daa: u64) -> (Value, Value) {
    let q = call("quote", json!({ "kind": "sell", "pool": l.pool["state"], "tokensIn": tokens_in }));
    let (common, c) = l.funding();
    let req = with(common, json!({
        "pool": l.pool, "reserve": l.reserve, "payer": payer, "tokensIn": tokens_in, "kasOut": q["kasOut"],
        "tokenValue": TOKEN_VALUE, "nowDaa": now_daa,
    }));
    (api::run("pool-sell", &req.to_string()).unwrap_or_else(|e| panic!("pool-sell: {e}")), c)
}

/// A whole withdrawal of the LP's position, as the wallet builds it at `now_daa` (its node's virtual DAA).
fn honest_remove(l: &mut Launched, now_daa: u64) -> Result<Value, String> {
    let q = call("quote", json!({ "kind": "remove", "pool": l.pool["state"], "shares": l.position["state"]["shares"] }));
    let (common, _) = l.funding();
    let req = with(common, json!({
        "pool": l.pool, "reserve": l.reserve, "position": l.position, "positionSecretKey": secret(&l.lp),
        "kasOut": q["kasOut"], "tokensOut": q["tokensOut"], "receiver": hex::encode(&xonly(&l.lp)), "tokenValue": TOKEN_VALUE, "nowDaa": now_daa,
    }));
    api::run("pool-remove", &req.to_string())
}

fn window_ref(pool: &Value) -> i64 {
    pool["state"]["windowRef"].as_i64().unwrap_or_else(|| pool["state"]["windowRef"].as_str().unwrap().parse().unwrap())
}

/// pool.ag require_claim's condition on the stored values: more than half of the cap (10 % of the reference) in use.
fn above_half(pool: &Value) -> bool {
    window_out(pool) > window_ref(pool) / 10 / 2
}

/// The LP's whole withdrawal built at `now_daa`, checked against the node's rules at that virtual DAA.
fn checked_remove(l: &mut Launched, now_daa: u64, what: &str) -> Value {
    let q = call("quote", json!({ "kind": "remove", "pool": l.pool["state"], "shares": l.position["state"]["shares"] }));
    let (common, c) = l.funding();
    let req = with(common, json!({
        "pool": l.pool, "reserve": l.reserve, "position": l.position, "positionSecretKey": secret(&l.lp),
        "kasOut": q["kasOut"], "tokensOut": q["tokensOut"], "receiver": hex::encode(&xonly(&l.lp)), "tokenValue": TOKEN_VALUE, "nowDaa": now_daa,
    }));
    let removed = call("pool-remove", req);
    node_rules(&removed, &[&l.pool["utxo"], &l.position["utxo"], &l.reserve["utxo"], &c["utxo"]], now_daa, what).unwrap_or_else(|e| panic!("{e}"));
    removed
}

/// Adopts output 0 (pool) and 1 (reserve) of `built`, accepted at `daa`.
fn adopt(l: &mut Launched, built: &Value, daa: u64) {
    l.pool = located_at(built, 0, &l.pool_id.clone(), "pool", daa);
    l.reserve = located_at(built, 1, &l.covenant_id.clone(), "token", daa);
}

/// The review's bot (a dust sell the moment each slot opens, claiming exactly MIN_AGE) against the fix. From more than
/// half of the cap in use: every slot opens at `d + 50` to the bot and to an honest client alike (the wallet builds at its
/// node's virtual DAA, so it claims 50 there, and its withdrawal passes the node's rules at that same DAA: who gets the
/// slot is the network's call). Each dust sell claims the minimum and refills it, so the count falls to half of the cap at
/// the stated rate, and from there the minimum claim is gone: the client builds at once, claiming whatever age the UTXO
/// has, and nothing a dust sell does brings the minimum back.
#[test]
fn a_dust_bot_holds_the_slots_only_until_half_of_the_cap_is_back() {
    let start = VIRTUAL_DAA - 100_000;
    let mut l = launch(start);
    // An honest sell of 90 kUSDT (about 830 KAS of a 1 000 KAS cap), claiming nothing: the count was zero.
    let seller = l.seller_tokens.clone();
    let (built, _) = sell(&mut l, &seller, 90_000_000, start);
    let mut d = start + 1;
    adopt(&mut l, &built, d);
    assert!(above_half(&l.pool), "more than half of the cap in use: {}", l.pool["state"]);
    let cap = window_ref(&l.pool) / 10;
    let stated_slots = ((window_out(&l.pool) - cap / 2) as f64 / (cap as f64 * MIN_AGE as f64 / 36_000.0)).ceil() as u64;

    let mut bot_tokens = l.bot_tokens.clone();
    let (mut fees, mut slots) = (0u64, 0u64);
    while above_half(&l.pool) {
        // The wallet's withdrawal: refused before d + 50, built at d + 50 claiming 50, and valid there.
        let refused = honest_remove(&mut l, d + MIN_AGE - 1).expect_err("the wallet's withdrawal one DAA before the lock opens");
        assert!(refused.contains("at least 50") && refused.contains(&format!("DAA score {}", d + MIN_AGE)), "{refused}");
        let honest = honest_remove(&mut l, d + MIN_AGE).expect("the wallet builds at the first DAA the lock allows");
        let ht = tx_from_json(&honest["transaction"]);
        assert_eq!(ht.inputs[0].sequence, MIN_AGE);
        // The bot's dust sell (0.0001 kUSDT, about 1 000 sompi out), claiming exactly MIN_AGE.
        let (built, c) = sell(&mut l, &bot_tokens, 100, d + MIN_AGE);
        let tx = tx_from_json(&built["transaction"]);
        assert_eq!(tx.inputs[0].sequence, MIN_AGE, "the bot's sell claims exactly the minimum");
        assert_eq!(ht.inputs[0].previous_outpoint, tx.inputs[0].previous_outpoint, "the same slot");
        let utxos = [&l.pool["utxo"], &l.reserve["utxo"], &bot_tokens["utxo"], &c["utxo"]];
        let early = node_rules(&built, &utxos, d + MIN_AGE - 1, "bot sell one DAA early").expect_err("consensus holds it until d + 50");
        assert!(early.contains("sequence lock not met"), "{early}");
        let view = node_rules(&built, &utxos, d + MIN_AGE, "bot sell at d + 50").unwrap_or_else(|e| panic!("slot {slots}: {e}"));
        fees += view.fee;
        // Accepted a DAA later: the next slot.
        d += MIN_AGE + 1;
        adopt(&mut l, &built, d);
        bot_tokens = owned(located_at(&built, 2, &l.covenant_id.clone(), "token", d), &l.bot);
        slots += 1;
        assert!(slots <= stated_slots + stated_slots / 20 + 2, "the bot kept the count above half for {slots} slots, the stated rate takes {stated_slots}");
    }
    println!(
        "the dust bot held {slots} slots ({:.2} of the {stated_slots} the stated rate takes); then half of the cap was back; its fees {:.2} KAS ({:.1} KAS an hour at the relay floor, {:.4} KAS a spend)",
        slots as f64 / stated_slots as f64,
        fees as f64 / KAS as f64,
        fees as f64 / KAS as f64 * 36_000.0 / (slots * (MIN_AGE + 1)) as f64,
        fees as f64 / KAS as f64 / slots as f64,
    );
    // At half: the wallet builds at once, claiming the UTXO's age (here 0), and it passes the node's rules at once.
    for age in [0u64, 1, 49] {
        let honest = honest_remove(&mut l, d + age).unwrap_or_else(|e| panic!("the wallet's withdrawal claiming {age} at half of the cap: {e}"));
        assert_eq!(tx_from_json(&honest["transaction"]).inputs[0].sequence, age);
    }
    // And dust sells claiming nothing can't bring the minimum back.
    for _ in 0..20 {
        let (built, _) = sell(&mut l, &bot_tokens, 100, d);
        adopt(&mut l, &built, d);
        bot_tokens = owned(located_at(&built, 2, &l.covenant_id.clone(), "token", d), &l.bot);
        assert!(!above_half(&l.pool));
    }
    let removed = checked_remove(&mut l, d, "a withdrawal claiming nothing at half of the cap");
    assert_eq!(tx_from_json(&removed["transaction"]).inputs[0].sequence, 0);
}

/// While paused the breaker stands still and a withdrawal needs no minimum: the pool UTXO of a pause the guardian just
/// sent, with more than half of the cap in use, is spendable at once by a provider leaving, whose withdrawal claims
/// exactly 0 (even built long after) and settles nothing. A tick is refused while paused, and once the admin unpauses the
/// minimum is back for withdrawals too.
#[test]
fn a_paused_pool_lets_providers_withdraw_at_once() {
    let start = VIRTUAL_DAA - 100_000;
    let mut l = launch(start);
    let seller = l.seller_tokens.clone();
    let (built, _) = sell(&mut l, &seller, 90_000_000, start);
    let d = start + 1;
    adopt(&mut l, &built, d);
    assert!(above_half(&l.pool));
    // The guardian's pause (claims no age), accepted at d + 1.
    let (common, c) = l.funding();
    let paused = call("pool-pause", with(common, json!({ "pool": l.pool, "secretKey": secret(&l.guardian) })));
    node_rules(&paused, &[&l.pool["utxo"], &c["utxo"]], d, "pause").unwrap();
    let d = d + 1;
    l.pool = located_at(&paused, 0, &l.pool_id.clone(), "pool", d);
    assert!(l.pool["state"]["paused"].as_bool().unwrap() && above_half(&l.pool));
    // A tick, at any age: refused by the builder (and by the script).
    let (common, _) = l.funding();
    let refused = api::run("pool-tick", &with(common, json!({ "pool": l.pool, "nowDaa": d + 10 * MIN_AGE })).to_string()).expect_err("a tick while paused");
    assert!(refused.contains("paused"), "{refused}");
    // The provider's withdrawal at once, claiming nothing: built at d and valid at d; built 1 000 DAA later it still
    // claims nothing, and the count it leaves is the stored one (plus no credit). (Not adopted: the unpause below spends
    // the paused pool UTXO instead.)
    let removed = checked_remove(&mut l, d, "a withdrawal claiming nothing while paused");
    assert_eq!(tx_from_json(&removed["transaction"]).inputs[0].sequence, 0);
    let late = checked_remove(&mut l, d + 1_000, "a withdrawal while paused, built late");
    assert_eq!(tx_from_json(&late["transaction"]).inputs[0].sequence, 0);
    assert_eq!(late["outputs"][0]["pool"], removed["outputs"][0]["pool"], "nothing settled while paused: the same successor 1 000 DAA later");
    // Unpaused by the admin: the minimum is back for withdrawals.
    let (common, c) = l.funding();
    let unpaused = call("pool-unpause", with(common, json!({ "pool": l.pool, "secretKey": secret(&l.admin) })));
    node_rules(&unpaused, &[&l.pool["utxo"], &c["utxo"]], d, "unpause").unwrap();
    let d = d + 1;
    l.pool = located_at(&unpaused, 0, &l.pool_id.clone(), "pool", d);
    assert!(!l.pool["state"]["paused"].as_bool().unwrap() && above_half(&l.pool));
    let refused = honest_remove(&mut l, d).expect_err("a withdrawal claiming nothing once unpaused");
    assert!(refused.contains("at least 50"), "{refused}");
    honest_remove(&mut l, d + MIN_AGE).expect("at the minimum");
}

// --------------------------------------------------------------------------
// The builders against the script engine on random breaker states.

struct Xs(u64);
impl Xs {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: i64) -> i64 {
        if n <= 0 { 0 } else { (self.next() % n as u64) as i64 }
    }
    fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[(self.next() % xs.len() as u64) as usize]
    }
}

fn script_of(actor: &str, state: &Value) -> String {
    call("script", json!({ "actor": actor, "state": state }))["scriptPublicKey"].as_str().unwrap().to_string()
}

fn utxo_of(actor: &str, state: &Value, amount: u64, covenant_id: &str, daa: u64, n: u32) -> Value {
    let mut id = [0xcdu8; 32];
    id[..4].copy_from_slice(&n.to_be_bytes());
    json!({
        "utxo": { "transactionId": hex::encode(&id), "index": 0, "amount": amount, "scriptPublicKey": script_of(actor, state), "covenantId": covenant_id, "blockDaaScore": daa },
        "state": state,
    })
}

/// Random breaker states (counts below and above zero and on both sides of half of the cap, credit, a reference under
/// the reserve, paused or not), every claim from the least to two windows: each tick, withdrawal and deposit the builders
/// make passes the node's rules and the script engine at exactly the DAA its claim needs. (With the follower test in
/// packages/protocol/src/pool-follow-random.test.ts: engine = builders = follower on these.)
#[test]
fn builders_meet_the_engine_on_random_breaker_states() {
    let start = VIRTUAL_DAA - 100_000;
    let mut l = launch(start);
    let base = l.pool["state"].clone();
    let lp = l.lp;
    let mut r = Xs(0x9e37_79b9_7f4a_7c15);
    let (mut ticks, mut removes, mut adds, mut n) = (0, 0, 0, 0u32);
    let (mut zero_refused, mut short_refused, mut paused_removes, mut zero_claims, mut paused_ticks) = (0, 0, 0, 0, 0);
    for _ in 0..240 {
        let x: i64 = r.pick(&[10 * KAS as i64, 1_000 * KAS as i64, 100_000 * KAS as i64, 50_000_000 * KAS as i64]) + r.below(KAS as i64);
        let y: i64 = r.pick(&[1_000_000i64, 1_000_000_000, 5_000_000_000_000]) + r.below(1_000);
        let cap = x / 10;
        let rr = 1 + r.below(x);
        let rf = r.pick(&[x, x, x / 2, x / 3 + 1, rr]);
        let ro = r.below(3 * cap) - cap;
        let out = r.pick(&[-cap, -(cap / 2), -1, 0, 1, cap / 3, cap / 2, cap / 2 + 1, cap, 2 * cap, 3 * cap, ro]);
        let paused = r.below(4) == 0;
        let rc = if out < 0 { -out } else { r.below(cap) };
        let credit = r.pick(&[0, 0, cap / 2, cap, 2 * cap + 7, rc]);
        let shares_total = x + r.below(x);
        let (pk, pt) = (r.below(KAS as i64), r.below(1_000));
        let mut state = base.clone();
        for (k, v) in [("kasReserve", x), ("tokenReserve", y), ("totalShares", shares_total), ("protocolKas", pk), ("protocolTokens", pt), ("windowRef", rf), ("windowOut", out), ("windowCredit", credit)] {
            state[k] = json!(v);
        }
        state["paused"] = json!(paused);
        // pool.ag require_claim: the minimum while more than half of the stored cap is in use, none for a paused withdrawal.
        let above = out > (rf / 10) / 2;
        let least: u64 = if above { MIN_AGE } else { 0 };
        let least_remove: u64 = if above && !paused { MIN_AGE } else { 0 };
        let ra = MIN_AGE + r.below(72_000 - MIN_AGE as i64) as u64;
        let age: u64 = r.pick(&[least, least_remove, 0, MIN_AGE, MIN_AGE + 1, 18_000, 35_999, 36_000, 72_000, ra]);
        if age < least_remove {
            zero_refused += 1;
        }
        let d = start;
        let value = KAS + x as u64 + pk as u64;
        n += 1;
        let pool = utxo_of("Pool", &state, value, &l.pool_id.clone(), d, n);
        let reserve_state = json!({ "amount": y + pt, "owner": l.pool_id, "ownerScheme": 4, "borrowScheme": 0, "borrowGuard": "00".repeat(32), "extensionCommitment": "00".repeat(32) });
        n += 1;
        let reserve = utxo_of("KCC20", &reserve_state, TOKEN_VALUE, &l.covenant_id.clone(), d, n);

        // A tick (refused while paused).
        let tick_age = age.max(MIN_AGE);
        let (common, c) = l.funding();
        let tick = api::run("pool-tick", &with(common, json!({ "pool": pool, "nowDaa": d + tick_age })).to_string());
        if paused {
            assert!(tick.expect_err("a tick while paused").contains("paused"));
            paused_ticks += 1;
        } else {
            node_rules(&tick.unwrap(), &[&pool["utxo"], &c["utxo"]], d + tick_age, "tick").unwrap_or_else(|e| panic!("{e}\nstate {state}"));
            ticks += 1;
        }

        // A withdrawal of a random position, all of its share or less KAS.
        let shares = 1 + r.below(shares_total - 1_000);
        let pos_state = json!({ "tokenCovid": l.covenant_id, "shares": shares, "owner": hex::encode(&xonly(&lp)) });
        n += 1;
        let position = utxo_of("Position", &pos_state, POSITION_VALUE, &l.pool_id.clone(), d, n);
        let q = call("quote", json!({ "kind": "remove", "pool": state, "shares": shares }));
        let kas_full = q["kasOut"].as_i64().unwrap_or_else(|| q["kasOut"].as_str().unwrap().parse().unwrap());
        let kas_out = r.pick(&[kas_full, kas_full / 2, 0]);
        let (common, c) = l.funding();
        let req = with(common, json!({
            "pool": pool, "reserve": reserve, "position": position, "positionSecretKey": secret(&lp),
            "kasOut": kas_out, "tokensOut": q["tokensOut"], "receiver": hex::encode(&xonly(&lp)), "tokenValue": TOKEN_VALUE, "nowDaa": d + age,
        }));
        match api::run("pool-remove", &req.to_string()) {
            Ok(removed) => {
                assert!(age >= least_remove, "a withdrawal claiming {age} under the least {least_remove} was built: {state}");
                if paused {
                    assert_eq!(tx_from_json(&removed["transaction"]).inputs[0].sequence, 0, "a paused withdrawal claims 0");
                }
                node_rules(&removed, &[&pool["utxo"], &position["utxo"], &reserve["utxo"], &c["utxo"]], d + age, "remove").unwrap_or_else(|e| panic!("{e}\nstate {state} shares {shares} kasOut {kas_out} age {age}"));
                removes += 1;
                if paused && above && age < MIN_AGE {
                    paused_removes += 1;
                }
                if age == 0 {
                    zero_claims += 1;
                }
            }
            Err(e) if age < least_remove => {
                assert!(e.contains("at least 50"), "{e}");
                short_refused += 1;
            }
            Err(_) => {}
        }

        // A deposit (at most 1 000 KAS).
        let kas_in = (x / 10).min(1_000 * KAS as i64) + 1;
        let tokens_in = ((kas_in as i128 * y as i128 + x as i128 - 1) / x as i128) as i64;
        let add_shares = call("quote", json!({ "kind": "add", "pool": state, "kasIn": kas_in, "tokensIn": tokens_in }))["shares"].clone();
        let provider_state = json!({ "amount": tokens_in + 5, "owner": hex::encode(&xonly(&lp)), "ownerScheme": 0, "borrowScheme": 0, "borrowGuard": "00".repeat(32), "extensionCommitment": "00".repeat(32) });
        n += 1;
        let provider = owned(utxo_of("KCC20", &provider_state, TOKEN_VALUE, &l.covenant_id.clone(), d, n), &lp);
        let (common, c) = l.funding();
        let req = with(common, json!({
            "pool": pool, "reserve": reserve, "provider": provider, "kasIn": kas_in, "tokensIn": tokens_in, "shares": add_shares,
            "positionOwner": hex::encode(&xonly(&lp)), "tokenValue": TOKEN_VALUE, "positionValue": POSITION_VALUE, "nowDaa": d + age,
        }));
        match api::run("pool-add", &req.to_string()) {
            Ok(added) => {
                assert!(age >= least && !paused, "a deposit claiming {age} (least {least}, paused {paused}) was built: {state}");
                node_rules(&added, &[&pool["utxo"], &reserve["utxo"], &provider["utxo"], &c["utxo"]], d + age, "add").unwrap_or_else(|e| panic!("{e}\nstate {state} age {age}"));
                adds += 1;
            }
            Err(e) if age < least => {
                assert!(e.contains("at least 50") || paused, "{e}");
                short_refused += 1;
            }
            Err(_) => {}
        }
    }
    println!("random breaker states: {ticks} ticks ({paused_ticks} refused while paused), {removes} withdrawals ({paused_removes} paused above half under the minimum, {zero_claims} claiming nothing) and {adds} deposits built and accepted by the engine at exactly their claim; {short_refused} claims under the least refused ({zero_refused} withdrawals drawn under it)");
    assert!(ticks + paused_ticks == 240 && paused_ticks > 20 && removes > 120 && adds > 100 && paused_removes > 3 && zero_claims > 10 && short_refused > 10, "{ticks} {removes} {adds} {paused_removes} {zero_claims} {short_refused}");
}

// --------------------------------------------------------------------------
// Round 11 (R11-OWN-1): the admin's deposits signed offline, through the real builders and the node's rules.

fn token_state_of(owner: &str, scheme: u8, amount: i64) -> Value {
    json!({ "amount": amount, "owner": owner, "ownerScheme": scheme, "borrowScheme": 0, "borrowGuard": "00".repeat(32), "extensionCommitment": "00".repeat(32) })
}

/// A key transaction (`pool-pause`, `pool-unpause`) on `pool`, signed by `signer`, and the coin that paid for it.
fn key_tx(l: &mut Launched, command: &str, pool: &Value, signer: &Keypair) -> (Result<Value, String>, Value) {
    let (common, c) = l.funding();
    (api::run(command, &with(common, json!({ "pool": pool, "secretKey": secret(signer) })).to_string()), c)
}

/// The pool between its genesis and the admin's `init`: nobody's tick moves it (the builder says why), so an `init`
/// signed offline for the genesis outpoint lands. If the guardian paused it in between, the admin's unpause and the
/// `init` on the unpause's output, before it is accepted, go out together.
#[test]
fn a_never_opened_pool_takes_no_tick_and_the_admins_init_follows_an_unpause_at_once() {
    let d = VIRTUAL_DAA - 100_000;
    let mut l = launch(d);
    let (lp, admin, guardian) = (l.lp, l.admin, l.guardian);
    let (pool_id, covenant_id) = (l.pool_id.clone(), l.covenant_id.clone());
    let mut state = l.pool["state"].clone();
    for k in ["kasReserve", "tokenReserve", "totalShares", "protocolKas", "protocolTokens", "windowRef", "windowOut", "windowCredit"] {
        state[k] = json!(0);
    }
    state["paused"] = json!(false);
    let genesis = utxo_of("Pool", &state, KAS, &pool_id, d, 1);
    let (kas_in, tokens_in) = (5_000 * KAS as i64, 500_000_000i64);
    let provider = owned(utxo_of("KCC20", &token_state_of(&hex::encode(&xonly(&lp)), 0, tokens_in + 5), TOKEN_VALUE, &covenant_id, d, 2), &lp);
    let init = |l: &mut Launched, pool: &Value| {
        let (common, c) = l.funding();
        let built = api::run("pool-init", &with(common, json!({
            "pool": pool, "provider": provider, "kasIn": kas_in, "tokensIn": tokens_in, "positionOwner": hex::encode(&xonly(&lp)),
            "tokenValue": TOKEN_VALUE, "positionValue": POSITION_VALUE, "adminSecretKey": secret(&admin),
        })).to_string());
        (built, c)
    };

    // No tick, at the first DAA the lock would allow or long after.
    for now in [d + MIN_AGE, d + 36_000, d + 72_000] {
        let (common, _) = l.funding();
        let refused = api::run("pool-tick", &with(common, json!({ "pool": genesis, "nowDaa": now })).to_string()).expect_err("a tick of the never-opened pool");
        assert!(refused.contains("has not been opened"), "{refused}");
    }
    // The init signed for the genesis outpoint: accepted, whenever it is carried to a node.
    let (opened, c) = init(&mut l, &genesis);
    let opened = opened.expect("the admin's init on the genesis pool");
    for at in [d, d + 600_000] {
        node_rules(&opened, &[&genesis["utxo"], &provider["utxo"], &c["utxo"]], at, "init").unwrap();
    }

    // The guardian pauses the never-opened pool: once, and then only the admin can spend it.
    let (paused, c) = key_tx(&mut l, "pool-pause", &genesis, &guardian);
    let paused = paused.expect("the guardian's pause");
    node_rules(&paused, &[&genesis["utxo"], &c["utxo"]], d, "pause").unwrap();
    let held = located_at(&paused, 0, &pool_id, "pool", d + 1);
    let again = key_tx(&mut l, "pool-pause", &held, &guardian).0.expect_err("a second pause");
    assert!(again.contains("already paused"), "{again}");
    let refused = init(&mut l, &held).0.expect_err("an init while paused");
    assert!(refused.contains("paused"), "{refused}");
    // The admin's chain: the unpause, and the init on its output before it is accepted.
    let (unpaused, c) = key_tx(&mut l, "pool-unpause", &held, &admin);
    let unpaused = unpaused.expect("the admin's unpause");
    node_rules(&unpaused, &[&held["utxo"], &c["utxo"]], d + 1, "unpause").unwrap();
    let in_mempool = located_at(&unpaused, 0, &pool_id, "pool", 0);
    let (opened, c) = init(&mut l, &in_mempool);
    let opened = opened.expect("the admin's init on the unpause's output");
    assert_eq!(tx_from_json(&opened["transaction"]).inputs[0].sequence, 0, "an init claims no age");
    let landed = located_at(&unpaused, 0, &pool_id, "pool", d + 1);
    node_rules(&opened, &[&landed["utxo"], &provider["utxo"], &c["utxo"]], d + 1, "the chained init").unwrap();
    // And nobody's tick gets between them: the unpause's output is still a never-opened pool.
    let (common, _) = l.funding();
    let refused = api::run("pool-tick", &with(common, json!({ "pool": landed, "nowDaa": d + 1 + MIN_AGE })).to_string()).expect_err("a tick of the unpaused, never-opened pool");
    assert!(refused.contains("has not been opened"), "{refused}");
    println!("a never-opened pool: no tick builds; the admin's init lands on the genesis outpoint, and on the output of an unpause in the same block");
}

/// What `tick`'s new rule does not cover. A pool that every provider has left (only the unowned shares) is an opened
/// pool: anyone's tick, or a dust swap, still moves its outpoint, and the admin's first deposit into it is signed for
/// one outpoint (offline, when the admin key is kept as the launch list says). The way through: the guardian pauses
/// (a paused pool takes no tick, swap, deposit or second pause, and with no position left no withdrawal, so only the
/// admin can spend it), then the admin signs the unpause and, on its output before it is accepted, the deposit, and
/// sends both together. That needs the pool at or below half of its cap, where a deposit may claim no age. Above half
/// the count has to come down first, and the keeper's short ticks do not do that on a dust cap (round 12, R12-COV-2):
/// see `an_emptied_pool_above_half_of_its_cap_comes_down_by_one_long_tick_or_by_a_dust_buy_with_the_pause_behind_it`.
#[test]
fn an_emptied_pool_is_held_still_by_a_pause_for_the_admins_chained_unpause_and_deposit() {
    let d = VIRTUAL_DAA - 100_000;
    let mut l = launch(d);
    let (lp, admin, guardian) = (l.lp, l.admin, l.guardian);
    let (pool_id, covenant_id) = (l.pool_id.clone(), l.covenant_id.clone());
    let base = l.pool["state"].clone();
    let emptied = |window_out: i64| {
        let mut state = base.clone();
        for (k, v) in [("kasReserve", 1_000i64), ("tokenReserve", 1_000), ("totalShares", 1_000), ("protocolKas", 0), ("protocolTokens", 0), ("windowRef", 1_000), ("windowOut", window_out), ("windowCredit", 0)] {
            state[k] = json!(v);
        }
        state["paused"] = json!(false);
        state
    };
    let reserve = utxo_of("KCC20", &token_state_of(&pool_id, 4, 1_000), TOKEN_VALUE, &covenant_id, d, 2);
    let (kas_in, tokens_in) = (5_000 * KAS as i64, 500_000_000i64);
    let provider = owned(utxo_of("KCC20", &token_state_of(&hex::encode(&xonly(&lp)), 0, tokens_in + 5), TOKEN_VALUE, &covenant_id, d, 3), &lp);
    // The first deposit into `pool`, built at `now`, with the admin's key or without.
    let deposit = |l: &mut Launched, pool: &Value, now: u64, with_admin: bool| {
        let shares = call("quote", json!({ "kind": "add", "pool": pool["state"], "kasIn": kas_in, "tokensIn": tokens_in }))["shares"].clone();
        let (common, c) = l.funding();
        let mut req = with(common, json!({
            "pool": pool, "reserve": reserve, "provider": provider, "kasIn": kas_in, "tokensIn": tokens_in, "shares": shares,
            "positionOwner": hex::encode(&xonly(&lp)), "tokenValue": TOKEN_VALUE, "positionValue": POSITION_VALUE, "nowDaa": now,
        }));
        if with_admin {
            req["adminSecretKey"] = json!(secret(&admin));
        }
        (api::run("pool-add", &req.to_string()), c)
    };

    // 40 of a cap of 100 in use: at most half.
    let pool = utxo_of("Pool", &emptied(40), KAS + 1_000, &pool_id, d, 1);

    // Left open, anyone's tick moves it every 50 DAA: a deposit signed for this outpoint would no longer land.
    let (common, c) = l.funding();
    let tick = call("pool-tick", with(common, json!({ "pool": pool, "nowDaa": d + MIN_AGE })));
    node_rules(&tick, &[&pool["utxo"], &c["utxo"]], d + MIN_AGE, "a tick of the emptied pool").unwrap();

    // The guardian pauses it.
    let (paused, c) = key_tx(&mut l, "pool-pause", &pool, &guardian);
    let paused = paused.expect("the guardian's pause");
    node_rules(&paused, &[&pool["utxo"], &c["utxo"]], d, "pause").unwrap();
    let held = located_at(&paused, 0, &pool_id, "pool", d + 1);
    assert_eq!(held["state"]["paused"], json!(true));

    // Paused, nothing public spends it, long after too: no tick, no second pause, no deposit even with the admin's key.
    for now in [d + 1 + MIN_AGE, d + 1 + 36_000] {
        let (common, _) = l.funding();
        let refused = api::run("pool-tick", &with(common, json!({ "pool": held, "nowDaa": now })).to_string()).expect_err("a tick while paused");
        assert!(refused.contains("paused"), "{refused}");
        let refused = deposit(&mut l, &held, now, true).0.expect_err("a deposit while paused");
        assert!(refused.contains("paused"), "{refused}");
    }
    let again = key_tx(&mut l, "pool-pause", &held, &guardian).0.expect_err("a second pause");
    assert!(again.contains("already paused"), "{again}");

    // The admin's chain: the unpause on the paused pool, and the deposit on the unpause's output before it is accepted
    // (no acceptance DAA: `blockDaaScore` 0), claiming no age.
    let (unpaused, c) = key_tx(&mut l, "pool-unpause", &held, &admin);
    let unpaused = unpaused.expect("the admin's unpause");
    node_rules(&unpaused, &[&held["utxo"], &c["utxo"]], d + 1, "unpause").unwrap();
    let in_mempool = located_at(&unpaused, 0, &pool_id, "pool", 0);
    let stranger = deposit(&mut l, &in_mempool, d + 1, false).0.expect_err("a first deposit without the admin");
    assert!(stranger.contains("only its admin"), "{stranger}");
    let (added, c) = deposit(&mut l, &in_mempool, d + 1, true);
    let added = added.expect("the admin's deposit on the unpause's output");
    assert_eq!(tx_from_json(&added["transaction"]).inputs[0].sequence, 0, "the chained deposit claims no age");
    // The node takes it in the block that accepts the unpause, or any later one.
    for accepted in [d + 1, d + 2] {
        let landed = located_at(&unpaused, 0, &pool_id, "pool", accepted);
        node_rules(&added, &[&landed["utxo"], &reserve["utxo"], &provider["utxo"], &c["utxo"]], accepted, "the chained deposit").unwrap();
    }
    let after = &added["outputs"][0]["pool"];
    let number = |v: &Value| v.as_i64().unwrap_or_else(|| v.as_str().unwrap().parse().unwrap());
    assert_eq!(number(&after["kasReserve"]), 1_000 + kas_in);
    assert_eq!(number(&after["windowRef"]), 1_000 + kas_in, "the reference starts again at the new reserve");

    // Above half of the cap (60 of 100) the deposit must claim 50 DAA, so it can't ride on the unpause: the builder says so.
    let busy = utxo_of("Pool", &emptied(60), KAS + 1_000, &pool_id, d, 4);
    let (paused, _) = key_tx(&mut l, "pool-pause", &busy, &guardian);
    let held = located_at(&paused.unwrap(), 0, &pool_id, "pool", d + 1);
    let (unpaused, _) = key_tx(&mut l, "pool-unpause", &held, &admin);
    let in_mempool = located_at(&unpaused.unwrap(), 0, &pool_id, "pool", 0);
    let refused = deposit(&mut l, &in_mempool, d + 1, true).0.expect_err("a chained deposit above half of the cap");
    assert!(refused.contains("not accepted yet") && refused.contains("at least 50"), "{refused}");
    // One tick that claims a whole window brings the count to zero, and then the chain works as above. It needs a pool
    // UTXO that nobody has spent for that long: every tick in between, the keeper's too, starts its age again, and a
    // tick under 360 DAA refills nothing of a 100-sompi cap (the test below).
    let (common, c) = l.funding();
    let tick = call("pool-tick", with(common, json!({ "pool": busy, "nowDaa": d + 36_000 })));
    node_rules(&tick, &[&busy["utxo"], &c["utxo"]], d + 36_000, "the tick that settles the emptied pool").unwrap();
    let settled = located_at(&tick, 0, &pool_id, "pool", d + 36_000);
    assert_eq!(window_out(&settled), 0);
    let (paused, _) = key_tx(&mut l, "pool-pause", &settled, &guardian);
    let held = located_at(&paused.unwrap(), 0, &pool_id, "pool", d + 36_001);
    let (unpaused, _) = key_tx(&mut l, "pool-unpause", &held, &admin);
    let in_mempool = located_at(&unpaused.unwrap(), 0, &pool_id, "pool", 0);
    deposit(&mut l, &in_mempool, d + 36_001, true).0.expect("after the tick, the chained deposit");
    println!("an emptied pool: a pause holds it for the admin; the unpause and the admin's deposit chain with no age at or below half of the cap, and after a tick above it");
}

// --------------------------------------------------------------------------
// Round 12 (R12-COV-2): an emptied pool with more than half of its dust cap in use.

/// An emptied pool holds about 1 000 sompi, so its cap is 100 sompi, and the last withdrawal after net selling leaves
/// the count at up to two caps (anyone can also put it above half with a 51-sompi sell). Above half every public entry
/// claims at least 50 DAA, the admin's deposit included, so the pause, unpause and deposit of the runbook cannot chain.
/// The runbook's first step used to say "wait for the keeper's ticks to bring it down, at most an hour". They never
/// do: the cap refills by floor(age x 100 / 36 000) sompi, which is nothing for any claim under 360 DAA, and every
/// tick starts the pool UTXO's age again.
///
/// What does bring the count to half, through the real builders and the node's rules:
///   - with nobody spending the pool: one tick on a UTXO left alone, claiming 360 DAA for each sompi to remove
///     (54 000 DAA, 90 minutes, from two caps), within the two windows a claim may span;
///   - with someone spending every slot: a dust buy that claims the minimum and pays in the count above half, with
///     the guardian's pause on its output before it is accepted. It has to win one slot.
/// After either, the pool is at or below half, and the admin's unpause and deposit chain with no age, as before.
#[test]
fn an_emptied_pool_above_half_of_its_cap_comes_down_by_one_long_tick_or_by_a_dust_buy_with_the_pause_behind_it() {
    let d = VIRTUAL_DAA - 200_000;
    let mut l = launch(d);
    let (lp, admin, guardian, payer) = (l.lp, l.admin, l.guardian, l.payer);
    let (pool_id, covenant_id) = (l.pool_id.clone(), l.covenant_id.clone());
    let base = l.pool["state"].clone();
    // Every provider has left after net selling: 1 000 sompi and 1 000 base units stay with the unowned shares, and
    // the count stands at two caps of the 100-sompi cap.
    let mut state = base.clone();
    for (k, v) in [("kasReserve", 1_000i64), ("tokenReserve", 1_000), ("totalShares", 1_000), ("protocolKas", 0), ("protocolTokens", 0), ("windowRef", 1_000), ("windowOut", 200), ("windowCredit", 0)] {
        state[k] = json!(v);
    }
    state["paused"] = json!(false);
    let emptied = utxo_of("Pool", &state, KAS + 1_000, &pool_id, d, 41);
    let reserve = utxo_of("KCC20", &token_state_of(&pool_id, 4, 1_000), TOKEN_VALUE, &covenant_id, d, 42);
    assert!(above_half(&emptied));
    let (kas_in, tokens_in) = (5_000 * KAS as i64, 500_000_000i64);
    let provider = owned(utxo_of("KCC20", &token_state_of(&hex::encode(&xonly(&lp)), 0, tokens_in + 5), TOKEN_VALUE, &covenant_id, d, 43), &lp);
    // The admin's first deposit into `pool` (with `reserve` beside it), built at `now`.
    let deposit = |l: &mut Launched, pool: &Value, reserve: &Value, now: u64| {
        let shares = call("quote", json!({ "kind": "add", "pool": pool["state"], "kasIn": kas_in, "tokensIn": tokens_in }))["shares"].clone();
        let (common, c) = l.funding();
        let req = with(common, json!({
            "pool": pool, "reserve": reserve, "provider": provider, "kasIn": kas_in, "tokensIn": tokens_in, "shares": shares,
            "positionOwner": hex::encode(&xonly(&lp)), "tokenValue": TOKEN_VALUE, "positionValue": POSITION_VALUE, "nowDaa": now,
            "adminSecretKey": secret(&admin),
        }));
        (api::run("pool-add", &req.to_string()), c)
    };
    let tick = |l: &mut Launched, pool: &Value, now: u64| {
        let (common, c) = l.funding();
        (call("pool-tick", with(common, json!({ "pool": pool, "nowDaa": now }))), c)
    };
    // The guardian's pause on `pool`, then the admin's unpause, and the admin's deposit on the unpause's output before
    // it is accepted: the runbook's steps 2 to 4. `at` is the DAA the pause is accepted at.
    let pause_unpause_deposit = |l: &mut Launched, pool: &Value, reserve: &Value, at: u64, what: &str| -> Value {
        let (paused, c) = key_tx(l, "pool-pause", pool, &guardian);
        let paused = paused.unwrap_or_else(|e| panic!("{what}: the guardian's pause: {e}"));
        let mut landed = pool.clone();
        landed["utxo"]["blockDaaScore"] = json!(at);
        node_rules(&paused, &[&landed["utxo"], &c["utxo"]], at, "the pause").unwrap_or_else(|e| panic!("{what}: {e}"));
        let held = located_at(&paused, 0, &pool_id, "pool", at);
        let (unpaused, c) = key_tx(l, "pool-unpause", &held, &admin);
        let unpaused = unpaused.unwrap_or_else(|e| panic!("{what}: the admin's unpause: {e}"));
        node_rules(&unpaused, &[&held["utxo"], &c["utxo"]], at, "the unpause").unwrap_or_else(|e| panic!("{what}: {e}"));
        let in_mempool = located_at(&unpaused, 0, &pool_id, "pool", 0);
        let (added, c) = deposit(l, &in_mempool, reserve, at);
        let added = added.unwrap_or_else(|e| panic!("{what}: the admin's deposit on the unpause's output: {e}"));
        assert_eq!(tx_from_json(&added["transaction"]).inputs[0].sequence, 0, "{what}: the chained deposit claims no age");
        let opened = located_at(&unpaused, 0, &pool_id, "pool", at);
        node_rules(&added, &[&opened["utxo"], &reserve["utxo"], &provider["utxo"], &c["utxo"]], at, "the chained deposit").unwrap_or_else(|e| panic!("{what}: {e}"));
        added["outputs"][0]["pool"].clone()
    };
    let number = |v: &Value| v.as_i64().unwrap_or_else(|| v.as_str().unwrap().parse().unwrap());

    // The finding. Above half, the documented chain does not build: the deposit must claim 50 DAA of a pool that is
    // not accepted yet.
    {
        let (paused, _) = key_tx(&mut l, "pool-pause", &emptied, &guardian);
        let held = located_at(&paused.unwrap(), 0, &pool_id, "pool", d + 1);
        assert_eq!(window_out(&held), 200, "a pause keeps the count");
        let (unpaused, _) = key_tx(&mut l, "pool-unpause", &held, &admin);
        let in_mempool = located_at(&unpaused.unwrap(), 0, &pool_id, "pool", 0);
        assert_eq!(window_out(&in_mempool), 200, "an unpause keeps the count");
        let refused = deposit(&mut l, &in_mempool, &reserve, d + 1).0.expect_err("the chained deposit above half of the cap");
        assert!(refused.contains("not accepted yet") && refused.contains("at least 50"), "{refused}");
    }
    // And "the keeper's ticks bring it down" is not so. A tick claiming anything under 360 DAA is accepted and changes
    // nothing: the pool is the same state at a new outpoint, its age starting again. (The keeper claims 65 to 70.)
    for claim in [MIN_AGE, 65, 70, 75, 100, 359] {
        let (ticked, c) = tick(&mut l, &emptied, d + claim);
        node_rules(&ticked, &[&emptied["utxo"], &c["utxo"]], d + claim, "a short tick").unwrap();
        let after = located_at(&ticked, 0, &pool_id, "pool", d + claim);
        assert_eq!(window_out(&after), 200, "a tick claiming {claim} DAA refills nothing of a 100-sompi cap");
        assert_eq!(after["state"], emptied["state"], "the same state, at a new outpoint");
    }
    // A chain of them, one per slot for an hour, leaves the count where it was.
    {
        let (mut pool, mut at) = (emptied.clone(), d);
        for _ in 0..720 {
            let (ticked, _) = tick(&mut l, &pool, at + MIN_AGE);
            at += MIN_AGE;
            pool = located_at(&ticked, 0, &pool_id, "pool", at);
        }
        assert_eq!(window_out(&pool), 200, "720 ticks of 50 DAA, an hour of slots");
    }
    // The first claim that removes anything is 360 DAA, for one sompi.
    let (ticked, _) = tick(&mut l, &emptied, d + 360);
    assert_eq!(window_out(&located_at(&ticked, 0, &pool_id, "pool", d + 360)), 199);

    // Way 1, with nobody spending the pool: the UTXO left alone for 54 000 DAA, then one tick that claims it all.
    {
        let short = tick(&mut l, &emptied, d + 53_999).0;
        assert!(above_half(&located_at(&short, 0, &pool_id, "pool", d + 53_999)), "one DAA short of 54 000 is still above half");
        let (ticked, c) = tick(&mut l, &emptied, d + 54_000);
        assert_eq!(tx_from_json(&ticked["transaction"]).inputs[0].sequence, 54_000, "the tick claims the whole age");
        let early = node_rules(&ticked, &[&emptied["utxo"], &c["utxo"]], d + 53_999, "the long tick one DAA early").expect_err("the UTXO must be that old");
        assert!(early.contains("sequence lock not met"), "{early}");
        node_rules(&ticked, &[&emptied["utxo"], &c["utxo"]], d + 54_000, "the long tick").unwrap();
        let settled = located_at(&ticked, 0, &pool_id, "pool", d + 54_000);
        assert_eq!(window_out(&settled), 50);
        assert!(!above_half(&settled), "at half of the cap: no claim is needed any more");
        let opened = pause_unpause_deposit(&mut l, &settled, &reserve, d + 54_001, "after the long tick");
        assert_eq!(number(&opened["kasReserve"]), 1_000 + kas_in);
        assert_eq!(number(&opened["windowRef"]), 1_000 + kas_in, "the reference starts again at the new reserve");
    }

    // Way 2, with someone spending every slot: a dust buy that pays in what the count is above half (150 sompi; 151
    // covers the rounding of the fee), claiming the minimum, and the guardian's pause on its output right behind it.
    {
        let buyer = payer;
        let quote = call("quote", json!({ "kind": "buy", "pool": emptied["state"], "kasIn": 151 }));
        let (common, c) = l.funding();
        let buy = call("pool-buy", with(common, json!({
            "pool": emptied, "reserve": reserve, "kasIn": 151, "tokensOut": quote["tokensOut"], "buyer": hex::encode(&xonly(&buyer)),
            "tokenValue": TOKEN_VALUE, "nowDaa": d + MIN_AGE,
        })));
        assert_eq!(tx_from_json(&buy["transaction"]).inputs[0].sequence, MIN_AGE, "the buy claims the minimum, as every entry above half must");
        // It competes for the slot with whoever else spends the pool: valid from the same DAA as their tick, not before.
        let utxos = [&emptied["utxo"], &reserve["utxo"], &c["utxo"]];
        let early = node_rules(&buy, &utxos, d + MIN_AGE - 1, "the buy one DAA early").expect_err("consensus holds it until d + 50");
        assert!(early.contains("sequence lock not met"), "{early}");
        node_rules(&buy, &utxos, d + MIN_AGE, "the dust buy").unwrap();
        // The pause is built on the buy's output before any block has it, and so are the admin's two transactions.
        let bought = located_at(&buy, 0, &pool_id, "pool", 0);
        assert!(window_out(&bought) <= 50 && !above_half(&bought), "the buy brought the count to half: {}", bought["state"]);
        let reserve_after = located_at(&buy, 1, &covenant_id, "token", d + MIN_AGE);
        let opened = pause_unpause_deposit(&mut l, &bought, &reserve_after, d + MIN_AGE, "after the dust buy");
        assert_eq!(number(&opened["kasReserve"]), number(&bought["state"]["kasReserve"]) + kas_in);
        // A buy one sompi short of that leaves the pool above half, where the chain still does not build.
        let (common, _) = l.funding();
        let quote = call("quote", json!({ "kind": "buy", "pool": emptied["state"], "kasIn": 149 }));
        let short = call("pool-buy", with(common, json!({
            "pool": emptied, "reserve": reserve, "kasIn": 149, "tokensOut": quote["tokensOut"], "buyer": hex::encode(&xonly(&buyer)),
            "tokenValue": TOKEN_VALUE, "nowDaa": d + MIN_AGE,
        })));
        assert!(above_half(&located_at(&short, 0, &pool_id, "pool", 0)));
    }
    println!("an emptied pool at two caps: short ticks change nothing; one tick of 54 000 DAA on an untouched UTXO, or a 151-sompi buy with the pause behind it, brings it to half, and then the admin's unpause and deposit chain");
}
