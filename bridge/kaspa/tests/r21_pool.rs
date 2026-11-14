//! Run 21, R21-POOL-1: the pool's kUSDT reserve and the address it sits at, through the real builders (`api::run`), the
//! node's rules and the real script engine with covenants (the harness of tests/pool_slots.rs, copied), plus crafted
//! transactions built with the runtime's TxBuilder on synthetic states.
//!
//! - The reserve's address follows from its amount alone, and any trader can set that amount back exactly after every
//!   move of the operators, chained onto their unconfirmed move: once someone has filled that address, it can be
//!   returned to for as long as they like. So kUSDT Wallet and the web app no longer list it.
//! - What they rely on instead (bridge/packages/protocol/src/pool-follow.ts `reserveMadeBy`): kUSDT moves only beside a
//!   pool entry that observes it, so the reserve is spent only with the pool coin, and a transaction that made a pool
//!   coin and a kUSDT output made the reserve as its first one. Every entry that does not observe kUSDT refuses the
//!   reserve beside it.
//!
//! Written by the run 21 reviewer `pool`.
//!
//!   cargo test --locked --test r21_pool -- --nocapture --test-threads 1

#![allow(dead_code)]

mod common;

use argent::artifact::Artifact;
use argent_runtime::{ArtifactBundle, EntryCall, TxBuilder, TxContext, args, execute_transaction_with_covenants, state};
use common::{State, funding, funding_sig, key, outpoint, sign_digest, xonly};
use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::{
    Hash,
    config::params::MAINNET_PARAMS,
    constants::{LOCK_TIME_THRESHOLD, MAX_SOMPI, SEQUENCE_LOCK_TIME_DISABLED, SEQUENCE_LOCK_TIME_MASK},
    mass::MassCalculator,
    subnets::SubnetworkId,
    tx::{CovenantBinding, MutableTransaction, PopulatedTransaction, Transaction, TransactionId, TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry},
};
use kaspa_txscript::script_class::ScriptClass;
use kusdt_kaspa::{api, hex, model::Utxo, model::spk_from_hex};
use secp256k1::Keypair;
use serde_json::{Value, json};
use std::sync::OnceLock;

const KAS: u64 = 100_000_000;
const TOKEN_VALUE: u64 = 150_000_000;
const POSITION_VALUE: u64 = 2 * KAS;
const MINTER_VALUE: u64 = 5 * KAS;
const VIRTUAL_DAA: u64 = 600_000_000;
const MINTER_AGE: i64 = 90;
const MIN_AGE: u64 = 50;
/// rusty-kaspa's mark for a UTXO only in the mempool (UNACCEPTED_DAA_SCORE).
const IN_MEMPOOL: u64 = u64::MAX;

// --------------------------------------------------------------------------
// tests/pool_slots.rs's harness (copied): the transaction as JSON, and the node's rules.

#[derive(Debug, Clone, Copy)]
struct NodeView {
    compute: u64,
    transient: u64,
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

fn node_rules(built: &Value, utxos: &[&Value], virtual_daa: u64, what: &str) -> Result<NodeView, String> {
    let tx = tx_from_json(&built["transaction"]);
    let entries: Vec<UtxoEntry> = utxos.iter().map(|u| entry_of(u)).collect();
    node_rules_tx(&tx, entries, virtual_daa, what)
}

/// The node's rules outside the script engine (sequence locks against `virtual_daa`, masses, relay fee), then the
/// script engine with covenants (pool_slots.rs `node_rules`, on a Transaction).
fn node_rules_tx(tx: &Transaction, entries: Vec<UtxoEntry>, virtual_daa: u64, what: &str) -> Result<NodeView, String> {
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
        total_in = total_in.checked_add(entry.amount).ok_or("inputs overflow")?;
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
    let masses = calculator.calc_non_contextual_masses(tx);
    let populated = PopulatedTransaction::new(tx, entries.clone());
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
    Ok(NodeView { compute: masses.compute_mass, transient: masses.transient_mass, storage, fee, min_relay_fee })
}

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

/// The same coin, as a node shows it while it is only in its mempool.
fn in_mempool(utxo: &Value) -> Value {
    let mut u = utxo.clone();
    u["blockDaaScore"] = json!(IN_MEMPOOL);
    u
}

fn num(v: &Value) -> i64 {
    v.as_i64().unwrap_or_else(|| v.as_str().unwrap_or_else(|| panic!("a number: {v}")).parse().unwrap())
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

/// pool_slots.rs `launch`: kUSDT, a pool with the deployment's breaker (10 %, 36 000 DAA), 10 000 KAS and 1 000 kUSDT
/// in it (its reserve carrying TOKEN_VALUE, 1.5 KAS, as deployed), and kUSDT for a bot (10) and a seller (100).
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
    num(&pool["state"]["windowOut"])
}
fn window_ref(pool: &Value) -> i64 {
    num(&pool["state"]["windowRef"])
}
fn above_half(pool: &Value) -> bool {
    window_out(pool) > window_ref(pool) / 10 / 2
}

fn adopt(l: &mut Launched, built: &Value, daa: u64) {
    l.pool = located_at(built, 0, &l.pool_id.clone(), "pool", daa);
    l.reserve = located_at(built, 1, &l.covenant_id.clone(), "token", daa);
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

fn token_state_of(owner: &str, scheme: u8, amount: i64) -> Value {
    json!({ "amount": amount, "owner": owner, "ownerScheme": scheme, "borrowScheme": 0, "borrowGuard": "00".repeat(32), "extensionCommitment": "00".repeat(32) })
}

fn reserve_amount(l: &Launched) -> i64 {
    num(&l.reserve["state"]["amount"])
}
fn reserve_spk(l: &Launched) -> String {
    l.reserve["utxo"]["scriptPublicKey"].as_str().unwrap().to_string()
}

/// A buy of `tokens_out` for `kas_in` by `buyer`, built at `now` (claiming the pool UTXO's age, if accepted).
fn build_buy(l: &mut Launched, buyer: &Keypair, kas_in: u64, tokens_out: i64, now: u64) -> (Value, Value) {
    let (common, c) = l.funding();
    let built = call("pool-buy", with(common, json!({
        "pool": l.pool, "reserve": l.reserve, "kasIn": kas_in, "tokensOut": tokens_out, "buyer": hex::encode(&xonly(buyer)),
        "tokenValue": TOKEN_VALUE, "nowDaa": now,
    })));
    (built, c)
}

/// A sell of `tokens_in` from `payer` for the whole quote, built at `now`.
fn build_sell(l: &mut Launched, payer: &Value, tokens_in: i64, now: u64) -> (Value, Value, i64) {
    let q = call("quote", json!({ "kind": "sell", "pool": l.pool["state"], "tokensIn": tokens_in }));
    let kas_out = num(&q["kasOut"]);
    let (common, c) = l.funding();
    let built = call("pool-sell", with(common, json!({
        "pool": l.pool, "reserve": l.reserve, "payer": payer, "tokensIn": tokens_in, "kasOut": kas_out,
        "tokenValue": TOKEN_VALUE, "nowDaa": now,
    })));
    (built, c, kas_out)
}

fn buy_quote(pool: &Value, kas_in: u64) -> i64 {
    num(&call("quote", json!({ "kind": "buy", "pool": pool["state"], "kasIn": kas_in }))["tokensOut"])
}

/// The least KAS in that buys at least `tokens`.
fn buy_cost(pool: &Value, tokens: i64) -> u64 {
    let (mut lo, mut hi) = (1u64, 1_000_000 * KAS);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if buy_quote(pool, mid) >= tokens { hi = mid } else { lo = mid + 1 }
    }
    lo
}

// ==========================================================================
// R21-POOL-1: the reserve's address follows from its amount alone, and any trader can set that amount back exactly.
// The runbook's way off a filled reserve address ("a small buy of an amount nobody can guess ... so the reserve gets an
// address nobody could fill in advance") is undone by one trade the other way: whoever filled the address does not
// need to guess the next one, they send the reserve back to the one they filled.

#[test]
fn r21_reserve_is_steered_back_to_a_filled_address_after_every_operator_move() {
    let d0 = VIRTUAL_DAA - 100_000;
    let mut l = launch(d0);
    let attacker = l.bot;
    let operator = key(40);
    // The attacker fills the address of the reserve as it stands (T0): that address is what the wallets read.
    let t0 = reserve_amount(&l);
    let filled = reserve_spk(&l);
    assert_eq!(filled, script_of("KCC20", &token_state_of(&l.pool_id, 4, t0)), "the reserve's script is the KCC20 script of (pool id, scheme 4, amount)");
    println!("R21-POOL-1 filled reserve address: amount {t0}, script {}..", &filled[..24]);

    let mut attacker_tokens = l.bot_tokens.clone();
    let mut seller_tokens = l.seller_tokens.clone();
    let (mut attacker_kas_paid, mut attacker_kas_got, mut attacker_fees) = (0i64, 0i64, 0u64);
    let mut d = d0 + 1_000;

    for cycle in 0..3 {
        // 1. The operator's way off, as the runbook says: a buy of an amount nobody could guess (or, in cycle 1, a small
        //    sell). The reserve moves to a new address.
        let operator_tx;
        let moved: i64;
        if cycle == 1 {
            let (built, c, _) = build_sell(&mut l, &seller_tokens, 777_777, d);
            node_rules(&built, &[&l.pool["utxo"], &l.reserve["utxo"], &seller_tokens["utxo"], &c["utxo"]], d, "operator sell").unwrap();
            seller_tokens = owned(located_at(&built, 2, &l.covenant_id.clone(), "token", d + 1), &key(22));
            operator_tx = built;
            moved = 777_777;
        } else {
            let kas_in = if cycle == 0 { 5_317 } else { 31 * KAS + 4_242_424 };
            let out = buy_quote(&l.pool, kas_in);
            let (built, c) = build_buy(&mut l, &operator, kas_in, out, d);
            node_rules(&built, &[&l.pool["utxo"], &l.reserve["utxo"], &c["utxo"]], d, "operator buy").unwrap();
            operator_tx = built;
            moved = -out;
        }
        // The operator's transaction, only in the mempool yet: the attacker chains onto it at once (age 0; the reserve
        // comes from the same transaction as the pool coin, which require_settled_inputs lets through).
        adopt(&mut l, &operator_tx, 0);
        let after_operator = reserve_amount(&l);
        assert_eq!(after_operator, t0 + moved);
        assert_ne!(reserve_spk(&l), filled, "the operator's move takes the reserve off the filled address");

        // 2. The attacker's trade the other way, of exactly that many units: the reserve's amount is T0 again.
        let (built, c, view, label) = if moved < 0 {
            let (built, c, kas_out) = build_sell(&mut l, &attacker_tokens, -moved, d);
            let utxos = [in_mempool(&l.pool["utxo"]), in_mempool(&l.reserve["utxo"]), attacker_tokens["utxo"].clone(), c["utxo"].clone()];
            let view = node_rules(&built, &utxos.iter().collect::<Vec<_>>(), d, "attacker sell chained on the operator's").unwrap();
            attacker_kas_got += kas_out;
            attacker_tokens = owned(located_at(&built, 2, &l.covenant_id.clone(), "token", d + 1), &attacker);
            (built, c, view, format!("sold {} units for {kas_out} sompi", -moved))
        } else {
            let kas_in = buy_cost(&l.pool, moved);
            let (built, c) = build_buy(&mut l, &attacker, kas_in, moved, d);
            let utxos = [in_mempool(&l.pool["utxo"]), in_mempool(&l.reserve["utxo"]), c["utxo"].clone()];
            let view = node_rules(&built, &utxos.iter().collect::<Vec<_>>(), d, "attacker buy chained on the operator's").unwrap();
            attacker_kas_paid += kas_in as i64;
            (built, c, view, format!("bought {moved} units for {kas_in} sompi"))
        };
        let _ = c;
        attacker_fees += view.fee;
        d += 1;
        adopt(&mut l, &built, d);
        assert_eq!(reserve_amount(&l), t0, "cycle {cycle}: the reserve's amount is T0 again");
        assert_eq!(reserve_spk(&l), filled, "cycle {cycle}: the reserve sits at the filled address again");
        let tx = tx_from_json(&built["transaction"]);
        assert_eq!(tx.inputs[0].sequence, 0, "chained, claiming no age");
        println!(
            "R21-POOL-1 cycle {cycle}: operator moved the reserve {t0} -> {after_operator}; attacker {label}, fee {} sompi, chained on the operator's unconfirmed tx; reserve {} at the filled address again: {}",
            view.fee, reserve_amount(&l), reserve_spk(&l) == filled
        );
        d += 100;
    }
    // A tick, the keeper's or an operator's, never moves the reserve (known: D6-2).
    let (common, c) = l.funding();
    let tick = api::run("pool-tick", &with(common, json!({ "pool": l.pool, "nowDaa": d + MIN_AGE })).to_string());
    if let Ok(t) = tick {
        node_rules(&t, &[&l.pool["utxo"], &c["utxo"]], d + MIN_AGE, "tick").unwrap();
        assert!(t["outputs"].as_array().unwrap().iter().all(|o| o["scriptPublicKey"].as_str() != Some(filled.as_str())));
    }
    println!(
        "R21-POOL-1 attacker over 3 cycles: paid {attacker_kas_paid} sompi in buys, got {attacker_kas_got} sompi from sells (kUSDT kept/returned), network fees {attacker_fees} sompi; reserve back at the filled address after every operator move"
    );
}

// ==========================================================================
// The pool's presence authorizes its reserve (owner scheme 0x04): every entry that does not observe kUSDT must refuse a
// kUSDT input. Crafted with the runtime's TxBuilder on synthetic states: the reserve's own KCC20 transfer, sending the
// whole reserve to a thief, beside a tick, a pause, an unpause, a set_keys and a Position transfer.

const KUSDT_ID: [u8; 32] = [0x11; 32];
const POOL_ID: [u8; 32] = [0x22; 32];

fn kusdt_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("kusdt.ag", "test-r21-pool-kusdt").expect("kUSDT compiles"))
}
fn pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("pool.ag", "test-r21-pool").expect("pool compiles"))
}
fn tx_builder() -> TxBuilder<'static> {
    let bundle = ArtifactBundle::new(pool_artifact()).unwrap().with_artifact(kusdt_artifact()).unwrap();
    TxBuilder::from_bundle(&bundle).expect("bundle builder")
}
fn sign_loose(tx: &MutableTransaction<Transaction>, index: usize, k: &Keypair) -> Vec<u8> {
    use kaspa_consensus_core::hashing::{sighash::{SigHashReusedValuesUnsync, calc_schnorr_signature_hash}, sighash_type::SigHashType};
    use secp256k1::{Message, Secp256k1};
    let hash_type = SigHashType::from_u8(0x82).unwrap();
    let digest = calc_schnorr_signature_hash(&tx.as_verifiable(), index, hash_type, &SigHashReusedValuesUnsync::new());
    let mut sig = Secp256k1::new().sign_schnorr_no_aux_rand(&Message::from_digest(digest.as_bytes()), k).as_ref().to_vec();
    sig.push(0x82);
    sig
}
fn tstate(owner: [u8; 32], scheme: u8, amount: i64) -> State {
    state! { amount: amount, owner: owner.to_vec(), owner_scheme: scheme, borrow_scheme: 0u8, borrow_guard: vec![0u8; 32], extension_commitment: vec![0u8; 32] }
}
fn pstate(paused: bool, admin: &Keypair, guardian: &Keypair) -> State {
    let x: i64 = 10_000 * KAS as i64;
    state! {
        token_covid: KUSDT_ID.to_vec(), kas_reserve: x, token_reserve: 1_000_000_000i64, total_shares: x, protocol_kas: 0i64,
        protocol_tokens: 0i64, base_value: KAS as i64, admin: xonly(admin).to_vec(), max_out_bps: 1_000i64, window_len: 36_000i64,
        window_credit: 0i64, window_ref: x, window_out: 0i64, paused: paused, guardian: xonly(guardian).to_vec()
    }
}

#[test]
fn r21_no_kusdt_entry_lets_the_reserve_move_beside_it() {
    let b = tx_builder();
    let (admin, guardian, thief, owner) = (key(0x30), key(0x32), key(0xee), key(0xd0));
    let x = 10_000 * KAS;
    let value = KAS + x;
    let reserve_amount = 1_000_000_000i64;
    let reserve_utxo = b.covenant_utxo("kusdt::KCC20", tstate(POOL_ID, 4, reserve_amount), TOKEN_VALUE, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap();
    let pos_utxo = b.covenant_utxo("Position", state! { token_covid: KUSDT_ID.to_vec(), shares: 7i64, owner: xonly(&owner).to_vec() }, POSITION_VALUE, 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
    let mut results = Vec::new();
    for (entry, paused) in [("tick", false), ("pause", false), ("unpause", true), ("set_keys", false), ("position_transfer", false), ("tick_alone", false)] {
        let current = pstate(paused, &admin, &guardian);
        let next = match entry {
            "pause" => pstate(true, &admin, &guardian),
            "unpause" => pstate(false, &admin, &guardian),
            _ => current.clone(),
        };
        let pool_utxo = b.covenant_utxo("Pool", current.clone(), value, 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
        let (a, g, o) = (admin, guardian, owner);
        let mut ctx = TxContext::new();
        let mut entries = Vec::new();
        if entry == "position_transfer" {
            let new_owner = xonly(&thief).to_vec();
            ctx = ctx.actor_input("Position", state! { token_covid: KUSDT_ID.to_vec(), shares: 7i64, owner: xonly(&owner).to_vec() },
                EntryCall::new("transfer").args_with(move |tx, i| args!(new_owner.clone(), sign_loose(tx, i, &o))), outpoint(0x90, 0), pos_utxo.clone(), 0);
            entries.push(pos_utxo.clone());
        } else {
            let call = match entry {
                "tick" | "tick_alone" => EntryCall::new("tick").args(args!(MIN_AGE as i64)),
                "pause" => EntryCall::new("pause").args_with(move |tx, i| args!(sign_loose(tx, i, &g))),
                "unpause" => EntryCall::new("unpause").args_with(move |tx, i| args!(sign_loose(tx, i, &a))),
                _ => EntryCall::new("set_keys").args_with(move |tx, i| args!(xonly(&a).to_vec(), xonly(&g).to_vec(), sign_loose(tx, i, &a))),
            };
            let seq = if entry.starts_with("tick") { MIN_AGE } else { 0 };
            ctx = ctx.actor_input("Pool", current.clone(), call, outpoint(0x91, 0), pool_utxo.clone(), seq);
            entries.push(pool_utxo.clone());
        }
        if entry != "tick_alone" {
            // The reserve's own transfer, leader, all of it to the thief; its owner (the pool's covenant ID) is satisfied by
            // the pool-family input above.
            ctx = ctx.actor_input("kusdt::KCC20", tstate(POOL_ID, 4, reserve_amount),
                EntryCall::new("transfer").args(args!(vec![tstate(xonly(&thief), 0, reserve_amount)], vec![0x00u8])), outpoint(0x92, 0), reserve_utxo.clone(), 0);
            entries.push(reserve_utxo.clone());
        }
        ctx = ctx.input(outpoint(0x93, 0), funding(), funding_sig(), 0);
        entries.push(funding());
        if entry == "position_transfer" {
            ctx = ctx.actor_output("Position", state! { token_covid: KUSDT_ID.to_vec(), shares: 7i64, owner: xonly(&thief).to_vec() }, CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_VALUE);
        } else {
            ctx = ctx.actor_output("Pool", next.clone(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), value);
        }
        if entry != "tick_alone" {
            ctx = ctx.actor_output("kusdt::KCC20", tstate(xonly(&thief), 0, reserve_amount), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_VALUE);
        }
        let verdict = match b.build(&ctx) {
            Ok(tx) => match execute_transaction_with_covenants(&mut tx.clone(), entries.clone()) {
                Ok(()) => "ACCEPTED".to_string(),
                Err(e) => format!("refused: {}", e.to_string().chars().take(150).collect::<String>()),
            },
            Err(e) => format!("refused at build: {}", e.to_string().chars().take(150).collect::<String>()),
        };
        println!("R21 reserve theft beside {entry}: {verdict}");
        results.push((entry, verdict));
    }
    for (entry, verdict) in &results {
        if *entry == "tick_alone" {
            assert_eq!(verdict, "ACCEPTED", "the control: a tick alone");
        } else {
            assert!(verdict.starts_with("refused"), "{entry}: {verdict}");
        }
    }
}
