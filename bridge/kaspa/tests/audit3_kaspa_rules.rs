//! Audit 3: every transaction our builders make, checked against a
//! re-implementation of the rules a Kaspa node applies OUTSIDE the script
//! engine (rusty-kaspa v2.1.0, the node we run; source paths below are in
//! that tree, `consensus/...`, `mining/...`).
//!
//! The usual test helper (`common::run`) runs the scripts, recomputes the
//! compute budgets, and applies the compute and transient mass limits and
//! the P2SH sig-op scan. Everything else below is what `run` never checks;
//! `node_rules` checks it for real transactions built by the real builders
//! (`api::run`), at their largest and smallest shapes.
//!
//! Tests named `proof_*` assert the behaviour we WANT and fail on purpose
//! while the finding is open (see audit/kaspa-transactions.md).
//!
//!   cargo test --test audit3_kaspa_rules -- --nocapture

mod common;

use argent_runtime::execute_transaction_with_covenants;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::mass::ScriptUnits;
use kaspa_consensus_core::tx::VerifiableTransaction;
use kaspa_txscript::{EngineCtx, EngineFlags, SigCacheKey, TxScriptEngine, caches::Cache, covenants::CovenantsContext};
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
/// Deployment values (SPEC §9, deploy plan): token states carry 1.5 KAS, burns 0.3 KAS, positions 2 KAS, the minter 5 KAS.
const TOKEN_VALUE: u64 = 150_000_000;
const BURN_VALUE: u64 = 30_000_000;
const POSITION_VALUE: u64 = 2 * KAS;
const MINTER_VALUE: u64 = 5 * KAS;
/// A DAA score of the mainnet era (Toccata activated at 474 165 565; ~587 M on 2026-11-08).
const VIRTUAL_DAA: u64 = 600_000_000;
const NOW_DAA: i64 = VIRTUAL_DAA as i64 - 10;
/// The fixture's minter UTXO is 100 DAA old: a builder claims less than it read.
const MINTER_AGE: i64 = 90;
const MIN_FEERATE_SOMPI_PER_GRAM: u64 = 100;

/// One built transaction next to the coins it spends, in input order.
struct Case<'a> {
    what: String,
    built: Value,
    utxos: Vec<&'a Value>,
}

/// What the node would compute for a transaction.
#[derive(Debug, Clone, Copy)]
struct NodeView {
    compute: u64,
    transient: u64,
    normalized_transient: u64,
    storage: u64,
    fee: u64,
    min_relay_fee: u64,
    size_bytes: u64,
    compute_budget_total: u64,
    max_signature_script: usize,
}

// --------------------------------------------------------------------------
// The transaction as JSON → the consensus type.

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
            assert_eq!(i["sigOpCount"].as_u64().unwrap(), 0, "version 1 inputs carry a compute budget, sigOpCount must be 0 (rpc/core/src/convert/tx.rs:26)");
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
    assert_eq!(j["mass"], json!(0), "submitted transactions carry no storage mass commitment");
    assert_eq!(j["storageMass"], json!(0));
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

// --------------------------------------------------------------------------
// An independent reading of the mass rules (consensus/core/src/mass/mod.rs).

fn utxo_plurality(spk_len: u64, has_covenant_id: bool) -> u64 {
    // mass/mod.rs:83-100
    (63 + spk_len + if has_covenant_id { 32 } else { 0 }).div_ceil(100)
}

fn independent_masses(tx: &Transaction, entries: &[UtxoEntry]) -> (u64, u64, u64) {
    // mass/mod.rs:21-78: the estimated serialized size of a version-1 transaction.
    let mut size: u64 = 2 + 8 + 8 + 8 + 20 + 8 + 32 + 8 + tx.payload.len() as u64;
    for i in &tx.inputs {
        size += 36 + 8 + i.signature_script.len() as u64 + 8 + 2;
    }
    for o in &tx.outputs {
        size += 8 + 2 + 8 + o.script_public_key.script().len() as u64 + if o.covenant.is_some() { 2 + 32 } else { 0 };
    }
    // mass/mod.rs:335-370.
    let spk_bytes: u64 = tx.outputs.iter().map(|o| 2 + o.script_public_key.script().len() as u64).sum();
    let budget: u64 = tx.inputs.iter().map(|i| i.compute_commit.compute_budget().unwrap() as u64).sum();
    let compute = size + spk_bytes * 10 + budget * 100;
    let transient = size * 4;

    // mass/mod.rs:439-513: storage mass (KIP-9 generalized with plurality).
    const C: u64 = 1_000_000_000_000;
    let mut outs_plurality = 0u64;
    let mut harmonic_outs = 0u64;
    for o in &tx.outputs {
        let p = utxo_plurality(o.script_public_key.script().len() as u64, o.covenant.is_some());
        outs_plurality += p;
        harmonic_outs += C * p * p / o.value;
    }
    let ins_len = entries.len();
    let relaxed = if outs_plurality == 1 {
        true
    } else if ins_len > 2 {
        false
    } else {
        let ins_p: u64 = entries.iter().map(|e| utxo_plurality(e.script_public_key.script().len() as u64, e.covenant_id.is_some())).sum();
        ins_p == 1 || (outs_plurality == 2 && ins_p == 2)
    };
    let storage = if relaxed {
        let harmonic_ins: u64 = entries
            .iter()
            .map(|e| {
                let p = utxo_plurality(e.script_public_key.script().len() as u64, e.covenant_id.is_some());
                C * p * p / e.amount
            })
            .sum();
        harmonic_outs.saturating_sub(harmonic_ins)
    } else {
        let ins_p: u64 = entries.iter().map(|e| utxo_plurality(e.script_public_key.script().len() as u64, e.covenant_id.is_some())).sum();
        let sum_ins: u64 = entries.iter().map(|e| e.amount).sum();
        let mean = (sum_ins / ins_p).max(1);
        harmonic_outs.saturating_sub(ins_p * (C / mean))
    };
    (compute, transient, storage)
}

// --------------------------------------------------------------------------
// The node's rules outside the script engine.

/// Checks `built` the way a v2.1.0 node would, with the coins `utxos` in input
/// order and the virtual DAA score `virtual_daa`.
fn node_rules(built: &Value, utxos: &[&Value], virtual_daa: u64, what: &str) -> Result<NodeView, String> {
    let tx = tx_from_json(&built["transaction"]);
    let entries: Vec<UtxoEntry> = utxos.iter().map(|u| entry_of(u)).collect();
    if tx.inputs.len() != entries.len() {
        return Err(format!("{what}: the transaction has {} inputs, the case lists {} coins", tx.inputs.len(), entries.len()));
    }

    // Consensus, validate_tx_in_isolation (tx_validation_in_isolation.rs).
    if tx.inputs.is_empty() {
        return Err(format!("{what}: no inputs (:79)"));
    }
    if tx.inputs.len() > 1000 || tx.outputs.len() > 1000 {
        return Err(format!("{what}: too many inputs or outputs (:71, :83; params.rs:615)"));
    }
    for (i, input) in tx.inputs.iter().enumerate() {
        if input.signature_script.len() > 250_000 {
            return Err(format!("{what}: signature script {i} too long (params.rs:25)"));
        }
    }
    let mut total_out = 0u64;
    for (i, o) in tx.outputs.iter().enumerate() {
        if o.script_public_key.script().len() > 10_000 {
            return Err(format!("{what}: script public key {i} too long (params.rs:621)"));
        }
        if o.value == 0 {
            return Err(format!("{what}: output {i} is zero (:150)"));
        }
        if o.value > MAX_SOMPI {
            return Err(format!("{what}: output {i} above MAX_SOMPI (:154)"));
        }
        total_out = total_out.checked_add(o.value).ok_or_else(|| format!("{what}: outputs overflow (:158)"))?;
        if total_out > MAX_SOMPI {
            return Err(format!("{what}: outputs above MAX_SOMPI (:164)"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    for input in &tx.inputs {
        if !seen.insert(input.previous_outpoint) {
            return Err(format!("{what}: duplicate input (:110)"));
        }
    }
    if tx.gas != 0 {
        return Err(format!("{what}: gas on a native transaction (:122-137)"));
    }
    if tx.subnetwork_id.as_ref() != [0u8; 20] {
        return Err(format!("{what}: not the native subnetwork (:172-191)"));
    }
    if tx.version != 1 {
        return Err(format!("{what}: covenant transactions are version 1 (:140-145)"));
    }
    for (i, input) in tx.inputs.iter().enumerate() {
        if input.compute_commit.sig_op_count().is_some() {
            return Err(format!("{what}: input {i} carries a sigop count in a version-1 transaction (:193-199)"));
        }
    }

    // Header context, validate_tx_in_header_context (lock time).
    if tx.lock_time != 0 {
        let finalized = if tx.lock_time < LOCK_TIME_THRESHOLD {
            tx.lock_time < virtual_daa
        } else {
            return Err(format!("{what}: lock time {} is a timestamp, the builders only use DAA scores", tx.lock_time));
        };
        if !finalized && tx.inputs.iter().any(|i| i.sequence != u64::MAX) {
            return Err(format!("{what}: not finalized: lock time {} ≥ virtual DAA {virtual_daa} (tx_validation_in_header_context.rs:61-82)", tx.lock_time));
        }
    }

    // UTXO context, check_transaction_coinbase_maturity / amounts / sequence
    // locks (tx_validation_in_utxo_context.rs:81-161).
    let mut total_in = 0u64;
    for (i, (input, entry)) in tx.inputs.iter().zip(&entries).enumerate() {
        if entry.is_coinbase && entry.block_daa_score + 1_000 > virtual_daa {
            return Err(format!("{what}: input {i} spends an immature coinbase (:81-97)"));
        }
        total_in = total_in.checked_add(entry.amount).ok_or_else(|| format!("{what}: inputs overflow"))?;
        if total_in > MAX_SOMPI {
            return Err(format!("{what}: inputs above MAX_SOMPI"));
        }
        if input.sequence & SEQUENCE_LOCK_TIME_DISABLED != SEQUENCE_LOCK_TIME_DISABLED {
            // relative_lock = sequence & mask; lock_daa = entry.daa + relative - 1;
            // refused when lock_daa >= pov DAA (:136-161).
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

    // Masses, computed by the same code the node uses, cross-checked against
    // an independent reading of the formulas.
    let calculator = MassCalculator::new_with_consensus_params(&MAINNET_PARAMS);
    let masses = calculator.calc_non_contextual_masses(&tx);
    let populated = PopulatedTransaction::new(&tx, entries.clone());
    let storage = calculator.calc_contextual_masses(&populated).ok_or_else(|| format!("{what}: storage mass incomputable"))?.storage_mass;
    let (compute_i, transient_i, storage_i) = independent_masses(&tx, &entries);
    assert_eq!((masses.compute_mass, masses.transient_mass, storage), (compute_i, transient_i, storage_i), "{what}: the independent mass reading disagrees");
    let report = &built["mass"];
    assert_eq!(report["compute"].as_u64().unwrap(), masses.compute_mass, "{what}: reported compute");
    assert_eq!(report["storage"].as_u64().unwrap(), storage, "{what}: reported storage");
    assert_eq!(report["transient"].as_u64().unwrap(), masses.transient_mass, "{what}: reported transient");

    // Mempool, check_transaction_limits.rs: the block-fit limits (params.rs:626).
    let limits = MAINNET_PARAMS.block_mass_limits().after();
    assert_eq!((limits.compute, limits.storage, limits.transient), (500_000, 500_000, 1_000_000));
    if masses.compute_mass > limits.compute {
        return Err(format!("{what}: compute mass {} above the block limit (check_transaction_limits.rs:21)", masses.compute_mass));
    }
    if masses.transient_mass > limits.transient {
        return Err(format!("{what}: transient mass {} above the block limit (:24)", masses.transient_mass));
    }
    if storage > limits.storage {
        return Err(format!("{what}: storage mass {storage} above the block limit (:39)"));
    }

    // Mempool, check_transaction_standard.rs (standardness in isolation and in context).
    for (i, o) in tx.outputs.iter().enumerate() {
        if o.script_public_key.version() != 0 {
            return Err(format!("{what}: output {i} has a non-zero script version (:25)"));
        }
        if ScriptClass::from_script(&o.script_public_key) == ScriptClass::NonStandard {
            return Err(format!("{what}: output {i} has a non-standard script class (:29)"));
        }
    }
    for (i, (input, entry)) in tx.inputs.iter().zip(&entries).enumerate() {
        match ScriptClass::from_script(&entry.script_public_key) {
            ScriptClass::NonStandard => return Err(format!("{what}: input {i} spends a non-standard script (:53)")),
            ScriptClass::ScriptHash => {
                let n = kaspa_txscript::post_toccata_p2sh_sig_scanner(&input.signature_script, &entry.script_public_key);
                if n > 15 {
                    return Err(format!("{what}: input {i} has {n} sig ops (:58-63, MAX_STANDARD_P2SH_SIG_OPS 15)"));
                }
            }
            _ => {}
        }
    }
    // Relay fee (:67-85): floor of max(compute, ⌈transient/2⌉) × 100 000 / 1000.
    let normalized_transient = (masses.transient_mass as f64 * 0.5).ceil() as u64;
    let fee_mass = masses.compute_mass.max(normalized_transient);
    // (:97-100) A floor of the rate itself applies only when the product rounds to zero.
    let min_relay_fee = match fee_mass * 100_000 / 1000 {
        0 => 100_000,
        m => m,
    };
    if fee < min_relay_fee {
        return Err(format!("{what}: fee {fee} below the relay minimum {min_relay_fee} (:76-85)"));
    }

    // Everything the script engine checks, with the covenant context
    // (validate_populated_transaction_and_get_fee → check_covenant_info, check_scripts).
    let mut run = tx.clone();
    execute_transaction_with_covenants(&mut run, entries.clone()).map_err(|e| format!("{what}: scripts: {e}"))?;
    // execute_transaction_with_covenants overwrites the compute budget with
    // what the scripts used: the committed budget must already cover it.
    for (i, (a, b)) in tx.inputs.iter().zip(&run.inputs).enumerate() {
        let (committed, used) = (a.compute_commit.compute_budget().unwrap(), b.compute_commit.compute_budget().unwrap());
        if used > committed {
            return Err(format!("{what}: input {i} needs compute budget {used} but commits {committed}"));
        }
    }

    Ok(NodeView {
        compute: masses.compute_mass,
        transient: masses.transient_mass,
        normalized_transient,
        storage,
        fee,
        min_relay_fee,
        size_bytes: masses.transient_mass / 4,
        compute_budget_total: tx.inputs.iter().map(|i| i.compute_commit.compute_budget().unwrap() as u64).sum(),
        max_signature_script: tx.inputs.iter().map(|i| i.signature_script.len()).max().unwrap_or(0),
    })
}

fn check(case: Case<'_>) -> NodeView {
    let v = node_rules(&case.built, &case.utxos, VIRTUAL_DAA, &case.what).unwrap_or_else(|e| panic!("{e}"));
    println!(
        "{:<44} compute {:>6}  storage {:>7}  transient {:>6} (norm {:>6})  size {:>6}B  sigscript {:>6}  budget {:>4}  fee {:>10}  min relay {:>9}  {}",
        case.what, v.compute, v.storage, v.transient, v.normalized_transient, v.size_bytes, v.max_signature_script, v.compute_budget_total, v.fee, v.min_relay_fee,
        if v.fee >= v.storage * MIN_FEERATE_SOMPI_PER_GRAM { "fee covers storage at min feerate" } else { "storage > feerate-paid mass" }
    );
    v
}

// --------------------------------------------------------------------------
// Builder plumbing (the same as tests/standard.rs).

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

fn coin(seed: u8, k: &Keypair, amount: u64) -> Value {
    json!({
        "utxo": {
            "transactionId": hex::encode(&[seed; 32]), "index": 0, "amount": amount, "scriptPublicKey": p2pk(k),
            "blockDaaScore": VIRTUAL_DAA - 50_000,
        },
        "secretKey": secret(k),
    })
}

struct Family {
    payer: Keypair,
    signers: Vec<Keypair>,
    guardian: Keypair,
    covenant_id: String,
    minter: Value,
}

fn launch() -> Family {
    let payer = key(200);
    let signers: Vec<Keypair> = (1..=5).map(key).collect();
    let guardian = key(9);
    let signer_keys: Vec<String> = signers.iter().map(|k| hex::encode(&xonly(k))).collect();
    let signer_set = call("signer-set", json!({ "signerKeys": signer_keys }))["signerSet"].clone();
    let state = json!({
        "remaining": "1000000000000000", "bucket": "500000000000", "capacity": "500000000000",
        "refillPerDaa": 578_703, "nonceEthereum": 0, "nonceBsc": 0, "adminNonce": 0, "paused": false,
        "signerSet": signer_set, "guardian": hex::encode(&xonly(&guardian)),
    });
    let funding = coin(1, &payer, 10_000 * KAS);
    let genesis = call("genesis", json!({
        "network": "mainnet", "changeAddress": address(&payer), "funding": [funding.clone()],
        "minter": state, "minterValue": MINTER_VALUE, "seedOwner": hex::encode(&xonly(&payer)), "seedValue": 2 * KAS,
    }));
    check(Case { what: "genesis".into(), built: genesis.clone(), utxos: vec![&funding["utxo"]] });
    let covenant_id = genesis["covenantId"].as_str().unwrap().to_string();
    let minter = json!({
        "utxo": {
            "transactionId": genesis["txid"], "index": 0, "amount": MINTER_VALUE,
            "scriptPublicKey": genesis["outputs"][0]["scriptPublicKey"], "covenantId": covenant_id,
            "blockDaaScore": VIRTUAL_DAA - 100,
        },
        "state": genesis["outputs"][0]["minter"],
    });
    Family { payer, signers, guardian, covenant_id, minter }
}

impl Family {
    fn signer_keys(&self) -> Vec<String> {
        self.signers.iter().map(|k| hex::encode(&xonly(k))).collect()
    }

    /// A mint of `recipients` (owner scheme, owner hex, amount) signed by signers 0, 2 and 4.
    fn mint(&self, recipients: &[(u8, String, u64)], token_value: u64, funding: &Value) -> Value {
        let recipients: Vec<Value> = recipients
            .iter()
            .map(|(scheme, owner, amount)| json!({ "ownerScheme": *scheme, "owner": owner, "amount": amount }))
            .collect();
        let digest = call("mint-digest", json!({ "covenantId": self.covenant_id, "chain": 1, "firstNonce": 0, "ageDaa": MINTER_AGE, "recipients": recipients }));
        let digest: [u8; 32] = hex::decode(digest["digest"].as_str().unwrap()).unwrap().try_into().unwrap();
        let signatures: Vec<String> = [0usize, 2, 4].iter().map(|&i| hex::encode(&sign_digest(&self.signers[i], &digest))).collect();
        call("mint", json!({
            "network": "mainnet", "changeAddress": address(&self.payer), "funding": [funding],
            "minter": self.minter, "chain": 1, "firstNonce": 0, "ageDaa": MINTER_AGE, "recipients": recipients,
            "signerKeys": self.signer_keys(), "signerIndices": [0, 2, 4], "signatures": signatures, "tokenValue": token_value,
        }))
    }

    fn sign_govern(&self, action: Value, indices: &[usize], age_daa: u64) -> (Vec<String>, Vec<usize>) {
        self.sign_govern_at(action, indices, 0, None, age_daa)
    }

    /// `minter` is the located minter the action spends: an unpause signs its outpoint. `age_daa` is the age the
    /// spend will claim: every governance message signs it.
    fn sign_govern_at(&self, action: Value, indices: &[usize], admin_nonce: i64, minter: Option<&Value>, age_daa: u64) -> (Vec<String>, Vec<usize>) {
        let mut request = json!({ "covenantId": self.covenant_id, "adminNonce": admin_nonce, "action": action, "ageDaa": age_daa });
        if let Some(m) = minter {
            request["outpoint"] = json!({ "transactionId": m["utxo"]["transactionId"], "index": m["utxo"]["index"] });
        }
        let digest = call("govern-digest", request);
        let d: [u8; 32] = hex::decode(digest["digest"].as_str().unwrap()).unwrap().try_into().unwrap();
        let sigs = indices.iter().map(|&i| hex::encode(&sign_digest(&self.signers[i], &d))).collect();
        (sigs, indices.to_vec())
    }
}

fn token_input(built: &Value, index: usize, holder: &Keypair, covenant_id: &str) -> Value {
    let out = &built["outputs"][index];
    json!({
        "utxo": {
            "transactionId": built["txid"], "index": index, "amount": out["value"],
            "scriptPublicKey": out["scriptPublicKey"], "covenantId": covenant_id, "blockDaaScore": VIRTUAL_DAA - 1_000,
        },
        "state": out["token"],
        "secretKey": secret(holder),
    })
}

fn located(built: &Value, index: usize, covenant_id: &str, kind: &str) -> Value {
    let out = &built["outputs"][index];
    json!({
        "utxo": {
            "transactionId": built["txid"], "index": index, "amount": out["value"],
            "scriptPublicKey": out["scriptPublicKey"], "covenantId": covenant_id, "blockDaaScore": VIRTUAL_DAA - 1_000,
        },
        "state": out[kind],
    })
}

fn common_for(f: &Family, funding: &Value) -> Value {
    json!({ "network": "mainnet", "changeAddress": address(&f.payer), "funding": [funding] })
}

fn with(mut base: Value, extra: Value) -> Value {
    base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    base
}

// --------------------------------------------------------------------------
// The tests.

/// Every builder against the node's rules, at the shapes the wallet and the
/// services really build, with mainnet parameters.
#[test]
fn every_builder_meets_the_node_rules() {
    let f = launch();
    let holders: Vec<Keypair> = (20..24).map(key).collect();
    let payer = coin(2, &f.payer, 10_000 * KAS);
    let me = hex::encode(&xonly(&holders[0]));

    // ── Mint: 1, 2 and 3 recipients, smallest amounts, every owner scheme mixed.
    for (n, recipients) in [
        vec![(0x00u8, me.clone(), 1u64)],
        vec![(0x01, hex::encode(&[0x11; 32]), 1), (0x02, hex::encode(&[0x22; 32]), 499_999_999_999)],
        vec![
            (0x03, hex::encode(&[0x33; 32]), 1),
            (0x04, hex::encode(&[0x44; 32]), 1),
            (0x00, me.clone(), 499_999_999_998),
        ],
    ]
    .into_iter()
    .enumerate()
    {
        let built = f.mint(&recipients, TOKEN_VALUE, &payer);
        check(Case { what: format!("mint, {} recipients, mixed schemes", n + 1), built, utxos: vec![&f.minter["utxo"], &payer["utxo"]] });
    }

    // ── KCC-23 preparation, the deployer's first transaction.
    let metadata = json!({ "name": "kUSDT", "symbol": "kUSDT", "decimals": 6, "description": "x".repeat(400) });
    let prep = call("prepare", with(common_for(&f, &payer), json!({ "metadata": metadata, "genesisAddress": address(&f.payer), "genesisValue": 20 * KAS })));
    check(Case { what: "KCC-23 prepare".into(), built: prep, utxos: vec![&payer["utxo"]] });

    // ── Transfers: 1→1, 3→3, and a redemption with burns.
    let mint3 = f.mint(
        &[(0, me.clone(), 2_000_000), (0, me.clone(), 2_000_000), (0, me.clone(), 2_000_000)],
        TOKEN_VALUE,
        &coin(3, &f.payer, 10_000 * KAS),
    );
    let token_utxos: Vec<Value> = (1..=3).map(|i| token_input(&mint3, i, &holders[0], &f.covenant_id)).collect();
    let state = |amount: u64, owner: &str, scheme: u8| json!({ "amount": amount, "owner": owner, "ownerScheme": scheme });
    let c1 = coin(4, &f.payer, 10_000 * KAS);
    let one_to_one = call("transfer", with(common_for(&f, &c1), json!({
        "inputs": [token_utxos[0]], "outputs": [{ "state": state(2_000_000, &hex::encode(&xonly(&holders[1])), 0), "value": TOKEN_VALUE }],
    })));
    check(Case { what: "transfer, 1 in 1 out".into(), built: one_to_one, utxos: vec![&token_utxos[0]["utxo"], &c1["utxo"]] });

    let c2 = coin(5, &f.payer, 10_000 * KAS);
    let three_three = call("transfer", with(common_for(&f, &c2), json!({
        "inputs": token_utxos,
        "outputs": [
            { "state": state(2_000_000, &me, 0), "value": TOKEN_VALUE },
            { "state": state(2_000_000, &hex::encode(&xonly(&holders[1])), 0), "value": TOKEN_VALUE },
            { "state": state(2_000_000, &hex::encode(&xonly(&holders[2])), 0), "value": TOKEN_VALUE },
        ],
    })));
    check(Case {
        what: "transfer, 3 in 3 out (KCC-20 maximum)".into(),
        built: three_three,
        utxos: vec![&token_utxos[0]["utxo"], &token_utxos[1]["utxo"], &token_utxos[2]["utxo"], &c2["utxo"]],
    });

    // A redemption with three burn outputs on 0.3 KAS each, payload for all three: the costliest storage mass.
    let (eth, bsc) = ("11".repeat(20), "22".repeat(20));
    let burn_eth = call("burn-owner", json!({ "chain": 1, "address": eth }));
    let burn_bsc = call("burn-owner", json!({ "chain": 2, "address": bsc }));
    let burn = |o: &Value, amt: u64| json!({ "state": state(amt, o["owner"].as_str().unwrap(), 3), "value": BURN_VALUE });
    let c3 = coin(6, &f.payer, 10_000 * KAS);
    let redeem = api::run("transfer", &with(common_for(&f, &c3), json!({
        "inputs": token_utxos,
        "outputs": [burn(&burn_eth, 2_000_000), burn(&burn_bsc, 2_000_000), burn(&burn_eth, 2_000_000)],
        "redeem": [
            { "outputIndex": 0, "chain": 1, "address": eth },
            { "outputIndex": 1, "chain": 2, "address": bsc },
            { "outputIndex": 2, "chain": 1, "address": eth },
        ],
    })).to_string());
    // Three 4·10¹²/3·10⁷ burn outputs alone are 400 000 of storage mass, under the
    // node's 500 000 but over the builder's own 300 000 cap (tx.rs:80): the wallet
    // only ever makes one burn per transaction, so this shape is refused by design.
    match redeem {
        Err(e) => {
            assert!(e.contains("above the standard limit"), "{e}");
            println!("    three burns at 0.3 KAS in one transaction: refused by the builder's 300 000 cap ({e})");
        }
        Ok(built) => {
            let v = check(Case {
                what: "redeem, 3 in, 3 burn outputs at 0.3 KAS".into(),
                built,
                utxos: vec![&token_utxos[0]["utxo"], &token_utxos[1]["utxo"], &token_utxos[2]["utxo"], &c3["utxo"]],
            });
            println!("    three burns at 0.3 KAS in one transaction: storage {}", v.storage);
        }
    }

    // A one-burn redemption, the wallet's usual shape, at the deployment burn value.
    let c4 = coin(7, &f.payer, 10_000 * KAS);
    let one_burn = call("transfer", with(common_for(&f, &c4), json!({
        "inputs": [token_utxos[0]],
        "outputs": [ { "state": state(1_000_000, burn_eth["owner"].as_str().unwrap(), 3), "value": BURN_VALUE },
                     { "state": state(1_000_000, &me, 0), "value": TOKEN_VALUE } ],
        "redeem": [ { "outputIndex": 0, "chain": 1, "address": eth } ],
    })));
    check(Case { what: "redeem, 1 in, 1 burn + token change".into(), built: one_burn, utxos: vec![&token_utxos[0]["utxo"], &c4["utxo"]] });

    // ── Guardian pause and every governance action.
    let c5 = coin(8, &f.guardian, 100 * KAS);
    let pause = call("pause", json!({
        "network": "mainnet", "changeAddress": address(&f.guardian), "funding": [c5.clone()],
        "minter": f.minter, "guardianSecretKey": secret(&f.guardian),
    }));
    check(Case { what: "pause (guardian)".into(), built: pause.clone(), utxos: vec![&f.minter["utxo"], &c5["utxo"]] });
    // The paused minter that pause made: an unpause is built only for one, signed at the nonce the pause moved to.
    let paused_minter = located(&pause, 0, &f.covenant_id, "minter");

    let new_keys: Vec<String> = (10..15).map(key).map(|k| hex::encode(&xonly(&k))).collect();
    let actions = vec![
        ("unpause", json!({ "kind": "unpause" }), None),
        ("setLimits", json!({ "kind": "setLimits", "capacity": 500_000_000_000u64, "refillPerDaa": 578_703 }), Some(MINTER_AGE)),
        ("setSigners", json!({ "kind": "setSigners", "signerKeys": new_keys, "guardian": hex::encode(&[0x77; 32]) }), None),
        ("skipNonce", json!({ "kind": "skipNonce", "chain": 1, "nonce": 0 }), None),
        ("setValue", json!({ "kind": "setValue", "value": 6 * KAS }), None),
    ];
    for (i, (name, action, age_daa)) in actions.into_iter().enumerate() {
        let unpausing = name == "unpause";
        let signed_age = age_daa.unwrap_or(0) as u64;
        let (signatures, indices) = if unpausing { f.sign_govern_at(action.clone(), &[0, 1, 2, 3], 1, Some(&paused_minter), signed_age) } else { f.sign_govern(action.clone(), &[0, 1, 2, 3], signed_age) };
        let minter = if unpausing { &paused_minter } else { &f.minter };
        let c = coin(30 + i as u8, &f.payer, 100 * KAS);
        let mut request = json!({
            "network": "mainnet", "changeAddress": address(&f.payer), "funding": [c.clone()],
            "minter": minter, "action": action, "signerKeys": f.signer_keys(), "signerIndices": indices, "signatures": signatures,
        });
        if let Some(n) = age_daa {
            request["ageDaa"] = json!(n);
        }
        let built = call("govern", request);
        check(Case { what: format!("govern {name} (4 of 5)"), built, utxos: vec![&minter["utxo"], &c["utxo"]] });
    }
}

/// The pool's life at the deployment values: every entry, with the breaker's
/// sequence-lock clock (a sell that claims the UTXO's whole age), plus the
/// outcome if the funding coin is the smallest that pays.
#[test]
fn every_pool_builder_meets_the_node_rules() {
    let f = launch();
    let lp = key(20);
    let payer_coin = coin(40, &f.payer, 10_000 * KAS);
    let minted = f.mint(
        &[(0, hex::encode(&xonly(&lp)), 3_000_000), (0, hex::encode(&xonly(&lp)), 3_000_000), (0, hex::encode(&xonly(&lp)), 10_000)],
        TOKEN_VALUE,
        &payer_coin,
    );
    let (admin, guardian) = (key(30), key(32));
    let with_funding = |seed: u8, extra: Value| {
        let c = coin(seed, &f.payer, 10_000 * KAS);
        (with(common_for(&f, &c), extra), c)
    };

    let (req, c) = with_funding(41, json!({
        "tokenCovid": f.covenant_id, "baseValue": KAS, "admin": hex::encode(&xonly(&admin)),
        "guardian": hex::encode(&xonly(&guardian)), "maxOutBps": 1_000, "windowLen": 36_000,
    }));
    let genesis = call("pool-genesis", req);
    check(Case { what: "pool genesis".into(), built: genesis.clone(), utxos: vec![&c["utxo"]] });
    let pool_id = genesis["covenantId"].as_str().unwrap().to_string();
    let pool = located(&genesis, 0, &pool_id, "pool");

    let provider = token_input(&minted, 1, &lp, &f.covenant_id);
    let (req, c) = with_funding(42, json!({
        "pool": pool, "provider": provider, "kasIn": 100 * KAS, "tokensIn": 2_000_000,
        "positionOwner": hex::encode(&xonly(&lp)), "tokenValue": TOKEN_VALUE, "positionValue": POSITION_VALUE, "adminSecretKey": secret(&admin),
    }));
    let init = call("pool-init", req);
    check(Case { what: "pool init".into(), built: init.clone(), utxos: vec![&pool["utxo"], &provider["utxo"], &c["utxo"]] });
    let (mut pool, mut reserve) = (located(&init, 0, &pool_id, "pool"), located(&init, 2, &f.covenant_id, "token"));

    // A buy: claims the pool UTXO's age through its input's sequence.
    let quote = call("quote", json!({ "kind": "buy", "pool": pool["state"], "kasIn": KAS }));
    let (req, c) = with_funding(43, json!({
        "pool": pool, "reserve": reserve, "kasIn": KAS, "tokensOut": quote["tokensOut"],
        "buyer": hex::encode(&xonly(&lp)), "tokenValue": TOKEN_VALUE, "nowDaa": NOW_DAA,
    }));
    let buy = call("pool-buy", req);
    let tx = tx_from_json(&buy["transaction"]);
    println!("    buy: pool input sequence {} (claims the UTXO age up to its DAA 1000 deep)", tx.inputs[0].sequence);
    check(Case { what: "pool buy (age claimed)".into(), built: buy.clone(), utxos: vec![&pool["utxo"], &reserve["utxo"], &c["utxo"]] });
    (pool, reserve) = (located(&buy, 0, &pool_id, "pool"), located(&buy, 1, &f.covenant_id, "token"));

    // A pool UTXO accepted so recently that the claimed age is zero (it may also sit in the mempool): with the
    // count below zero (the buy's credit), sequence 0, no relative lock. Part of the small minted state.
    let mut fresh_pool = pool.clone();
    fresh_pool["utxo"]["blockDaaScore"] = json!(NOW_DAA + 5);
    let seller2 = token_input(&minted, 3, &lp, &f.covenant_id);
    let q2 = call("quote", json!({ "kind": "sell", "pool": fresh_pool["state"], "tokensIn": 1_000, "nowDaa": NOW_DAA, "poolDaa": NOW_DAA as u64 + 5 }));
    assert_eq!(q2["breaker"]["minAgeDaa"], json!(0), "at most half of the cap in use: {q2}");
    let (req, c) = with_funding(45, json!({
        "pool": fresh_pool, "reserve": reserve, "payer": seller2, "tokensIn": 1_000, "kasOut": q2["kasOut"],
        "tokenValue": TOKEN_VALUE, "nowDaa": NOW_DAA,
    }));
    let sell2 = call("pool-sell", req);
    let t2 = tx_from_json(&sell2["transaction"]);
    assert_eq!(t2.inputs[0].sequence, 0, "a pool UTXO younger than the clock claims no age");
    assert!(sell2["outputs"][0]["pool"]["windowOut"].as_i64().unwrap() < 0, "the count stays below zero");
    check(Case { what: "pool sell, fresh pool (sequence 0)".into(), built: sell2.clone(), utxos: vec![&fresh_pool["utxo"], &reserve["utxo"], &seller2["utxo"], &c["utxo"]] });
    (pool, reserve) = (located(&sell2, 0, &pool_id, "pool"), located(&sell2, 1, &f.covenant_id, "token"));

    // A sell with change: claims age; the relative lock must hold at the virtual DAA. It uses more than half of the
    // cap, so the minimum claim is in force after it.
    let mut payer_token = located(&init, 3, &f.covenant_id, "token");
    payer_token["secretKey"] = json!(secret(&lp));
    let q = call("quote", json!({ "kind": "sell", "pool": pool["state"], "tokensIn": 160_000, "nowDaa": NOW_DAA, "poolDaa": VIRTUAL_DAA - 1_000 }));
    let (req, c) = with_funding(44, json!({
        "pool": pool, "reserve": reserve, "payer": payer_token, "tokensIn": 160_000, "kasOut": q["kasOut"],
        "tokenValue": TOKEN_VALUE, "nowDaa": NOW_DAA,
    }));
    let sell = call("pool-sell", req);
    check(Case { what: "pool sell with change".into(), built: sell.clone(), utxos: vec![&pool["utxo"], &reserve["utxo"], &payer_token["utxo"], &c["utxo"]] });
    report_stack("pool sell", &sell, &[&pool["utxo"], &reserve["utxo"], &payer_token["utxo"], &c["utxo"]]);
    (pool, reserve) = (located(&sell, 0, &pool_id, "pool"), located(&sell, 1, &f.covenant_id, "token"));
    let (out, reference) = (pool["state"]["windowOut"].as_i64().unwrap(), pool["state"]["windowRef"].as_i64().unwrap());
    assert!(2 * out > reference / 10, "more than half of the cap in use now: {out} of {}", reference / 10);

    // With more than half of the cap in use, a pool UTXO younger than the minimum (or only in the mempool) can't be spent by a public
    // entry: the builder says when it can be, and builds nothing.
    let mut young = pool.clone();
    young["utxo"]["blockDaaScore"] = json!(NOW_DAA - 49);
    let mut seller_young = located(&sell2, 2, &f.covenant_id, "token");
    seller_young["secretKey"] = json!(secret(&lp));
    let q_young = call("quote", json!({ "kind": "sell", "pool": young["state"], "tokensIn": 1_000, "nowDaa": NOW_DAA, "poolDaa": NOW_DAA as u64 - 49 }));
    assert_eq!(q_young["breaker"]["minAgeDaa"], json!(50), "{q_young}");
    assert_eq!(q_young["breaker"]["readyAtDaa"], json!(NOW_DAA + 1), "{q_young}");
    let (req, _) = with_funding(54, json!({
        "pool": young, "reserve": reserve, "payer": seller_young, "tokensIn": 1_000, "kasOut": q_young["kasOut"],
        "tokenValue": TOKEN_VALUE, "nowDaa": NOW_DAA,
    }));
    let refused = api::run("pool-sell", &req.to_string()).expect_err("a sell on a pool UTXO 49 DAA old");
    assert!(refused.contains("at least 50"), "{refused}");
    young["utxo"]["blockDaaScore"] = json!(0);
    let (req, _) = with_funding(55, json!({ "pool": young, "nowDaa": NOW_DAA }));
    let refused = api::run("pool-tick", &req.to_string()).expect_err("a tick on a pool UTXO only in the mempool");
    assert!(refused.contains("not accepted yet"), "{refused}");

    // Sell a whole state (no change output): what is left of the small minted state.
    let mut seller3 = located(&sell2, 2, &f.covenant_id, "token");
    seller3["secretKey"] = json!(secret(&lp));
    let amount3 = seller3["state"]["amount"].as_u64().unwrap();
    let q3 = call("quote", json!({ "kind": "sell", "pool": pool["state"], "tokensIn": amount3, "nowDaa": NOW_DAA, "poolDaa": VIRTUAL_DAA - 1_000 }));
    let (req, c) = with_funding(46, json!({
        "pool": pool, "reserve": reserve, "payer": seller3, "tokensIn": amount3, "kasOut": q3["kasOut"],
        "tokenValue": TOKEN_VALUE, "nowDaa": NOW_DAA,
    }));
    let sell_all = call("pool-sell", req);
    check(Case { what: "pool sell_all".into(), built: sell_all.clone(), utxos: vec![&pool["utxo"], &reserve["utxo"], &seller3["utxo"], &c["utxo"]] });
    (pool, reserve) = (located(&sell_all, 0, &pool_id, "pool"), located(&sell_all, 1, &f.covenant_id, "token"));

    // Add, remove, tick, collect: the first three claim the pool UTXO's age (at least the minimum now).
    let provider2 = token_input(&minted, 2, &lp, &f.covenant_id);
    let shares = call("quote", json!({ "kind": "add", "pool": pool["state"], "kasIn": 10 * KAS, "tokensIn": 200_000 }));
    let (req, c) = with_funding(47, json!({
        "pool": pool, "reserve": reserve, "provider": provider2, "kasIn": 10 * KAS, "tokensIn": 200_000, "shares": shares["shares"],
        "positionOwner": hex::encode(&xonly(&lp)), "tokenValue": TOKEN_VALUE, "positionValue": POSITION_VALUE, "nowDaa": NOW_DAA,
    }));
    let add = call("pool-add", req);
    assert!(tx_from_json(&add["transaction"]).inputs[0].sequence >= 50, "the add claims the pool UTXO's age");
    check(Case { what: "pool add (4 inputs, 5 outputs)".into(), built: add.clone(), utxos: vec![&pool["utxo"], &reserve["utxo"], &provider2["utxo"], &c["utxo"]] });
    report_stack("pool add", &add, &[&pool["utxo"], &reserve["utxo"], &provider2["utxo"], &c["utxo"]]);
    let position = located(&add, 1, &pool_id, "position");
    (pool, reserve) = (located(&add, 0, &pool_id, "pool"), located(&add, 2, &f.covenant_id, "token"));

    let remove_quote = call("quote", json!({ "kind": "remove", "pool": pool["state"], "shares": position["state"]["shares"] }));
    let (req, c) = with_funding(48, json!({
        "pool": pool, "reserve": reserve, "position": position, "positionSecretKey": secret(&lp),
        "kasOut": remove_quote["kasOut"], "tokensOut": remove_quote["tokensOut"], "receiver": hex::encode(&xonly(&lp)), "tokenValue": TOKEN_VALUE,
        "nowDaa": NOW_DAA,
    }));
    let remove = call("pool-remove", req);
    check(Case { what: "pool remove".into(), built: remove.clone(), utxos: vec![&pool["utxo"], &position["utxo"], &reserve["utxo"], &c["utxo"]] });
    report_stack("pool remove", &remove, &[&pool["utxo"], &position["utxo"], &reserve["utxo"], &c["utxo"]]);
    (pool, reserve) = (located(&remove, 0, &pool_id, "pool"), located(&remove, 1, &f.covenant_id, "token"));

    let (req, c) = with_funding(56, json!({ "pool": pool, "nowDaa": NOW_DAA }));
    let tick = call("pool-tick", req);
    assert_eq!(tx_from_json(&tick["transaction"]).inputs[0].sequence, 990, "a tick claims the pool UTXO's age");
    check(Case { what: "pool tick (anyone)".into(), built: tick.clone(), utxos: vec![&pool["utxo"], &c["utxo"]] });
    report_stack("pool tick", &tick, &[&pool["utxo"], &c["utxo"]]);
    pool = located(&tick, 0, &pool_id, "pool");

    let (req, c) = with_funding(49, json!({
        "pool": pool, "reserve": reserve, "adminSecretKey": secret(&admin), "feesTo": hex::encode(&xonly(&lp)), "tokenValue": TOKEN_VALUE,
    }));
    let collect = call("pool-collect", req);
    check(Case { what: "pool collect (admin)".into(), built: collect.clone(), utxos: vec![&pool["utxo"], &reserve["utxo"], &c["utxo"]] });
    (pool, reserve) = (located(&collect, 0, &pool_id, "pool"), located(&collect, 1, &f.covenant_id, "token"));
    let _ = reserve;

    // Pause, unpause, set-keys, position transfer.
    let (req, c) = with_funding(50, json!({ "pool": pool, "secretKey": secret(&guardian) }));
    let pause = call("pool-pause", req);
    check(Case { what: "pool pause (guardian)".into(), built: pause.clone(), utxos: vec![&pool["utxo"], &c["utxo"]] });
    pool = located(&pause, 0, &pool_id, "pool");
    let (req, c) = with_funding(51, json!({ "pool": pool, "secretKey": secret(&admin) }));
    let unpause = call("pool-unpause", req);
    check(Case { what: "pool unpause (admin)".into(), built: unpause.clone(), utxos: vec![&pool["utxo"], &c["utxo"]] });
    pool = located(&unpause, 0, &pool_id, "pool");
    let (req, c) = with_funding(52, json!({ "pool": pool, "secretKey": secret(&admin), "newGuardian": hex::encode(&xonly(&key(33))) }));
    let set_keys = call("pool-set-keys", req);
    check(Case { what: "pool set-keys (admin)".into(), built: set_keys.clone(), utxos: vec![&pool["utxo"], &c["utxo"]] });

    // A position transfer spends only the Position state.
    let (req, c) = with_funding(53, json!({ "position": position, "secretKey": secret(&lp), "newOwner": hex::encode(&xonly(&key(34))) }));
    let transfer = call("position-transfer", req);
    check(Case { what: "position transfer".into(), built: transfer, utxos: vec![&position["utxo"], &c["utxo"]] });
}

/// The pool keeper's coin split (`split`): one coin into several of one value, each to the payer, change last.
#[test]
fn the_keeper_coin_split_meets_the_node_rules() {
    let f = launch();
    for (count, value) in [(1u32, 5 * KAS), (4, 5 * KAS), (8, KAS), (16, 2 * KAS)] {
        let c = coin(70, &f.payer, 100 * KAS);
        let built = call("split", with(common_for(&f, &c), json!({ "count": count, "value": value })));
        let outputs = built["outputs"].as_array().unwrap();
        assert_eq!(outputs.iter().filter(|o| o["kind"] == "coin" && o["value"].as_u64() == Some(value)).count(), count as usize);
        assert!(outputs.iter().all(|o| o["scriptPublicKey"] == json!(p2pk(&f.payer))));
        check(Case { what: format!("keeper split into {count} of {value}"), built, utxos: vec![&c["utxo"]] });
    }
    // A remainder under the change threshold goes to the last coin, not to the fee; the fee is then what is due.
    let c = coin(72, &f.payer, 5 * KAS + 15_000_000);
    let built = call("split", with(common_for(&f, &c), json!({ "count": 1, "value": 5 * KAS, "feerate": 100 })));
    let outputs = built["outputs"].as_array().unwrap();
    assert_eq!(outputs.len(), 1);
    let fee = built["fee"].as_u64().unwrap();
    assert_eq!(outputs[0]["value"].as_u64().unwrap() + fee, 5 * KAS + 15_000_000);
    assert_eq!(fee, built["mass"]["feeMass"].as_u64().unwrap() * 100, "the fee is what is due, the rest is in the coin");
    check(Case { what: "keeper split, remainder in the coin".into(), built, utxos: vec![&c["utxo"]] });
    // Refused: a feerate above the ceiling.
    let c = coin(73, &f.payer, 100 * KAS);
    assert!(api::run("split", &with(common_for(&f, &c), json!({ "count": 1, "value": 5 * KAS, "feerate": 1_001 })).to_string()).is_err());
    // Refused: no coins, too many, dust, and small coins whose storage mass passes the standard limit.
    for bad in [json!({ "count": 0, "value": KAS }), json!({ "count": 17, "value": KAS }), json!({ "count": 2, "value": 1_000 }), json!({ "count": 16, "value": KAS / 2 })] {
        let c = coin(71, &f.payer, 100 * KAS);
        assert!(api::run("split", &with(common_for(&f, &c), bad.clone()).to_string()).is_err(), "{bad}");
    }
}

/// The funding shape that gives the most storage mass: one coin whose change
/// lands just above the builder's MIN_CHANGE (0.2 KAS, tx.rs:83). The change
/// output then costs C / 2·10⁷ = 50 000 mass (plurality 1).
#[test]
fn worst_change_keeps_every_builder_under_the_limit() {
    let f = launch();
    let holders: Vec<Keypair> = (20..23).map(key).collect();
    let me = hex::encode(&xonly(&holders[0]));
    let recipients = [(0x00u8, me.clone(), 2_000_000u64), (0x01, me.clone(), 2_000_000), (0x02, me.clone(), 2_000_000)];
    // A mint needs the token values (4.5 KAS) plus the fee; the minter input pays nothing.
    for margin in [0u64, 5_000_000, 8_000_000, 10_000_000, 12_000_000, 15_000_000, 20_000_000, 30_000_000] {
        let amount = 3 * TOKEN_VALUE + 12_000_000 + margin;
        let c = coin(60, &f.payer, amount);
        let recipients2: Vec<Value> = recipients.iter().map(|(s, o, a)| json!({ "ownerScheme": *s, "owner": o, "amount": a })).collect();
        let digest = call("mint-digest", json!({ "covenantId": f.covenant_id, "chain": 1, "firstNonce": 0, "ageDaa": MINTER_AGE, "recipients": recipients2 }));
        let d: [u8; 32] = hex::decode(digest["digest"].as_str().unwrap()).unwrap().try_into().unwrap();
        let signatures: Vec<String> = [0usize, 2, 4].iter().map(|&i| hex::encode(&sign_digest(&f.signers[i], &d))).collect();
        let built = api::run("mint", &json!({
            "network": "mainnet", "changeAddress": address(&f.payer), "funding": [c.clone()],
            "minter": f.minter, "chain": 1, "firstNonce": 0, "ageDaa": MINTER_AGE, "recipients": recipients2,
            "signerKeys": f.signer_keys(), "signerIndices": [0, 2, 4], "signatures": signatures, "tokenValue": TOKEN_VALUE,
        }).to_string()).unwrap_or_else(|e| panic!("mint with funding margin {margin}: {e}"));
        let outputs = built["outputs"].as_array().unwrap();
        let change = outputs.iter().find(|o| o["kind"] == "change").map(|o| o["value"].as_u64().unwrap()).unwrap_or(0);
        let v = check(Case { what: format!("mint funding margin {margin}"), built: built.clone(), utxos: vec![&f.minter["utxo"], &c["utxo"]] });
        println!("      change output {change} sompi");
        assert!(v.storage <= 300_000, "storage {}", v.storage);
    }
}

/// The relay limit counts sig ops statically over the whole redeem script
/// (`p2sh_sig_scanner`); every actor must stay at 15 or below whatever entry a
/// transaction runs.
#[test]
fn every_actor_stays_within_the_sig_op_limit() {
    for (name, json_text) in [("kusdt", include_str!("../artifacts/kusdt.json")), ("pool", include_str!("../artifacts/pool.json"))] {
        let artifact: Value = serde_json::from_str(json_text).unwrap();
        for (actor, contract) in artifact["sil_abi"]["contracts"].as_object().unwrap() {
            let code = contract["compiled"]["bytecode"].as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect::<Vec<u8>>();
            let spk = kaspa_txscript::standard::pay_to_script_hash_script(&code);
            let mut push = Vec::new();
            // OP_PUSHDATA2 / OP_PUSHDATA4 of the redeem script (the scanner parses the sig script).
            if code.len() < 256 {
                push.push(0x4c);
                push.push(code.len() as u8);
            } else {
                push.push(0x4d);
                push.extend_from_slice(&(code.len() as u16).to_le_bytes());
            }
            push.extend_from_slice(&code);
            let n = kaspa_txscript::post_toccata_p2sh_sig_scanner(&push, &spk);
            println!("{name}/{actor}: {n} static sig ops, {} script bytes, redeem {} bytes", code.len(), code.len());
            assert!(n <= 15, "{name}/{actor} has {n} sig ops: not relayed");
        }
    }
}

/// `MIN_FEERATE` (tx.rs:73) is the node's relay floor: 100 sompi per gram.
#[test]
fn the_fee_floor_is_the_nodes() {
    // mining/src/mempool/config.rs: DEFAULT_MINIMUM_RELAY_TRANSACTION_FEE = 100 000 sompi/kg; `/1000` in check_transaction_standard.rs:97.
    assert_eq!(kusdt_kaspa::tx::MIN_FEERATE, 100);
    let f = launch();
    let c = coin(70, &f.guardian, 100 * KAS);
    let pause = call("pause", json!({
        "network": "mainnet", "changeAddress": address(&f.guardian), "funding": [c.clone()],
        "minter": f.minter, "guardianSecretKey": secret(&f.guardian),
    }));
    let view = check(Case { what: "pause at the floor".into(), built: pause.clone(), utxos: vec![&f.minter["utxo"], &c["utxo"]] });
    assert!(view.fee >= view.min_relay_fee);
    // The builder's fee mass also pays for storage mass (above what relay asks):
    // a transaction priced only on the relay floor can be evicted first (mining/src/mempool/model/tx.rs:28 feerate).
    assert_eq!(view.fee, pause["mass"]["feeMass"].as_u64().unwrap() * 100, "fee = fee mass × 100 at the floor");
}

/// FINDING (proof, fails while open): the node's `getFeeEstimate` answers
/// `feerate` as an f64 (rusty-kaspa mining/src/feerate/mod.rs: `high = time_to_feerate(..).max(min)`,
/// `normal = time_to_feerate(60).max(quantile(..))` and so on: whole numbers only
/// when the mempool is empty). The wallet passes that number straight into
/// every covenant builder (wallet/extension/src/kusdt/pool.ts:357, build.ts:84;
/// clampFeerate keeps fractions), and `Common.feerate` is an integer deserializer
/// (src/tx.rs:92, model.rs:30-61) that refuses a float. So every covenant
/// transaction of the wallet (swap, burn, transfer, add, remove) fails to
/// build at any non-whole fee estimate, i.e. whenever the mempool has a backlog.
#[test]
fn a_fractional_fee_estimate_is_rounded_before_it_reaches_the_core() {
    let f = launch();
    let holder = key(20);
    let token_me = hex::encode(&xonly(&holder));
    let c1 = coin(80, &f.payer, 10_000 * KAS);
    let mint = f.mint(&[(0, token_me.clone(), 2_000_000)], TOKEN_VALUE, &coin(81, &f.payer, 10_000 * KAS));
    let token = token_input(&mint, 1, &holder, &f.covenant_id);
    let mut request = with(common_for(&f, &c1), json!({
        "inputs": [token],
        "outputs": [{ "state": { "amount": 2_000_000, "owner": token_me, "ownerScheme": 0 }, "value": TOKEN_VALUE }],
    }));
    // The core takes whole numbers only: the node's fractional estimates are rounded up before they get here
    // (clampFeerate in bridge/packages/kaspa and the wallet's builder).
    request["feerate"] = json!(104.37_f64);
    assert!(api::run("transfer", &request.to_string()).is_err(), "a feerate is a whole number");
    request["feerate"] = json!(105);
    let answer = api::run("transfer", &request.to_string());
    assert!(answer.is_ok(), "a rounded fee estimate builds: {}", answer.err().unwrap());
}

/// Deepest stack (data + alt) an input reaches while its scripts run
/// (MAX_STACK_SIZE is 244 on both versions): counted from the engine's own
/// execution log, opcode by opcode.
fn max_stack_depth(tx: &Transaction, entries: &[UtxoEntry], index: usize) -> usize {
    let reused = SigHashReusedValuesUnsync::new();
    let sig_cache: Cache<SigCacheKey, bool> = Cache::new(100);
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    let covenants = CovenantsContext::from_tx(&populated).expect("covenant context");
    let input = populated.tx.inputs[index].clone();
    let utxo = populated.utxo(index).expect("input utxo");
    let mut log = Vec::new();
    {
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &populated,
            &input,
            index,
            utxo,
            EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&covenants),
            EngineFlags { covenants_enabled: true, ..Default::default() },
            ScriptUnits(u64::MAX),
        )
        .with_opcode_execution_log_buffer(&mut log);
        vm.execute().expect("the script runs");
    }
    let log = String::from_utf8_lossy(&log);
    let ops = log.lines().count();
    OPS.with(|o| o.set(o.get().max(ops)));
    log.lines().map(|line| line.matches("\"0x").count()).max().unwrap_or(0)
}

/// The deepest stack over every input of a built transaction.
std::thread_local!(static OPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) });

fn report_stack(what: &str, built: &Value, utxos: &[&Value]) {
    OPS.with(|o| o.set(0));
    let tx = tx_from_json(&built["transaction"]);
    let entries: Vec<UtxoEntry> = utxos.iter().map(|u| entry_of(u)).collect();
    let deepest = (0..tx.inputs.len()).map(|i| max_stack_depth(&tx, &entries, i)).max().unwrap();
    println!("{what}: deepest stack over all inputs: {deepest} of 244; most opcodes in one script: {} of 1000000", OPS.with(|o| o.get()));
    assert!(deepest < 200, "{what}: {deepest}");
}

/// The script engine limits the combined stack to 244 elements. Report the
/// deepest any of our programs goes, on the entries that push the most.
#[test]
fn programs_stay_far_under_the_stack_limit() {
    let f = launch();
    let lp = key(20);
    let me = hex::encode(&xonly(&lp));
    let c = coin(90, &f.payer, 10_000 * KAS);
    let mint = f.mint(&[(0, me.clone(), 3_000_000), (2, hex::encode(&[0x22; 32]), 3_000_000), (4, hex::encode(&[0x44; 32]), 10_000)], TOKEN_VALUE, &c);
    let tx = tx_from_json(&mint["transaction"]);
    let entries = vec![entry_of(&f.minter["utxo"]), entry_of(&c["utxo"])];
    let depth = max_stack_depth(&tx, &entries, 0);
    println!("BridgeMint.mint (3 recipients, 3 signatures): deepest stack {depth} of 244; opcodes {}", OPS.with(|o| o.get()));
    assert!(depth < 200, "{depth}");
}
