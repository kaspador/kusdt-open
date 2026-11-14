//! Review r16/rev-minter, property 7: the three implementations agree.
//!
//! For random states and random entries (seeds below), this compares
//!   1. the script engine's verdict on the entry with the successor an independent model of bridge_mint.ag
//!      computes (rev_minter_kit: written from the contract text, not from tx.rs);
//!   2. the Rust builders (tx.rs through api::run): must build exactly when the model accepts, with the
//!      same successor state and value;
//! and writes every transaction the engine accepted, with the state it spends and the successor the script
//! demanded, to bridge/packages/protocol/src/rev-minter-corpus.json, where
//!   3. the TypeScript follower replays them (rev-minter-diff.test.ts): `followMinter` must adopt each one
//!      with the same successor.
//!
//!   cargo test --locked --test rev_minter_diff -- --nocapture
//!
//! The run compares its corpus with the committed file and fails when they differ; it writes the file only with
//! KUSDT_WRITE_CORPUS=1 in the environment (tools/rust.sh passes it through).

mod common;
mod rev_minter_kit;

use kaspa_consensus_core::tx::Transaction;
use secp256k1::Keypair;
use serde_json::{Value, json};
use rev_minter_kit::*;

const SEEDS: [u64; 3] = [0x5eed_0007_0000_0001, 0x5eed_0007_0000_0002, 0x5eed_0007_0000_0003];
const ROUNDS: usize = 170;
const TOP: i64 = (1i64 << 32) - 1;
const TOKEN_VALUE: u64 = 150_000_000;

fn alt_keys() -> Vec<Keypair> {
    (0x30..0x35).map(key).collect()
}

fn random_state(rng: &mut Rng, s: &mut MinterState) {
    s.capacity = match rng.below(6) {
        0 => 0,
        1 => rng.range(1, 1_000),
        2 => 500_000_000_000,
        3 => MAX_LIMIT,
        4 => rng.range(0, MAX_LIMIT),
        _ => rng.range(1, 1_000_000_000_000),
    };
    s.refill_per_daa = match rng.below(6) {
        0 => 0,
        1 => 1,
        2 => 578_703,
        3 => MAX_LIMIT,
        4 => rng.range(0, MAX_LIMIT),
        _ => rng.range(0, 10_000_000),
    };
    s.bucket = match rng.below(4) {
        0 => 0,
        1 => s.capacity,
        _ => rng.range(0, s.capacity),
    };
    s.remaining = match rng.below(5) {
        0 => CAP,
        1 => 0,
        2 => rng.range(0, 1_000),
        _ => rng.range(0, CAP),
    };
    let mut counter = |rng: &mut Rng| match rng.below(3) {
        0 => 0,
        1 => rng.range(0, 100),
        _ => rng.range(0, 1 << 40),
    };
    s.nonce_ethereum = counter(rng);
    s.nonce_bsc = counter(rng);
    s.admin_nonce = counter(rng);
    s.recovery_nonce = counter(rng);
    s.paused = rng.chance(30);
    if rng.chance(35) {
        s.recovery_pending = true;
        s.recovery_signer_set = signer_set_of(&alt_keys());
        s.recovery_guardian = xonly(&key(0x36));
    }
    s.recovery_delay = rng.pick(&[0i64, 1, 1_000, 2_592_000, TOP]);
}

fn random_age(rng: &mut Rng, s: &MinterState) -> (i64, u64) {
    let needed = if s.refill_per_daa > 0 && s.bucket < s.capacity { ((s.capacity - s.bucket + s.refill_per_daa - 1) / s.refill_per_daa).min(TOP) } else { 0 };
    let age = match rng.below(9) {
        0 => 0,
        1 => 1,
        2 => rng.range(0, 1_000),
        3 => TOP,
        4 => needed,
        5 => (needed - 1).max(0),
        6 => rng.range(0, TOP),
        7 => {
            if rng.chance(50) {
                1 << 32
            } else {
                -1
            }
        }
        _ => rng.range(0, 100_000),
    };
    let base = age.max(0) as u64;
    // Mostly the claim itself, which the minter demands since rc.22 (`require_settled_inputs`); now and then one below,
    // one above (refused now, taken before) or with the disable bit.
    let sequence = match rng.below(16) {
        0 => base.saturating_sub(1),
        1 => base + 1 + rng.below(1_000),
        2 => base | SEQ_DISABLED,
        _ => base,
    };
    (age, sequence)
}

fn increasing(rng: &mut Rng, count: usize) -> Vec<usize> {
    let mut all: Vec<usize> = (0..5).collect();
    while all.len() > count {
        let drop = rng.below(all.len() as u64) as usize;
        all.remove(drop);
    }
    all
}

#[derive(Default)]
struct Stats {
    cases: usize,
    engine_accepted: usize,
    engine_refused: usize,
    builder_compared: usize,
    builder_built: usize,
    builder_refused: usize,
    respelled: usize,
    divergences: Vec<String>,
}

struct Run<'a> {
    name: String,
    h: &'a Harness,
    stats: &'a mut Stats,
    corpus: &'a mut Vec<Value>,
}

impl Run<'_> {
    /// The engine against the model. Returns the accepted transaction.
    fn engine(&mut self, verdict: &Verdict, result: Result<Transaction, Rejected>, minted: &[Recipient]) -> Option<Transaction> {
        match (&verdict.accept, result) {
            (Ok(()), Ok(tx)) => {
                self.stats.engine_accepted += 1;
                self.corpus.push(corpus_case(&format!("{} [engine]", self.name), self.h, &tx, &verdict.next, verdict.value, minted));
                Some(tx)
            }
            (Err(_), Err(Rejected::Script(_))) => {
                self.stats.engine_refused += 1;
                None
            }
            (Ok(()), Err(e)) => {
                self.stats.divergences.push(format!("{}: the model accepts, the engine does not: {e:?}", self.name));
                None
            }
            (Err(why), Ok(_)) => {
                self.stats.divergences.push(format!("{}: the model refuses ({why}), the engine ACCEPTED", self.name));
                None
            }
            (Err(why), Err(Rejected::Build(e))) => {
                self.stats.divergences.push(format!("{}: the model refuses ({why}); no engine verdict, the builder failed first: {e}", self.name));
                None
            }
        }
    }

    /// The Rust builder (tx.rs) against the model.
    fn builder(&mut self, verdict: &Verdict, built: Result<Value, String>, minted: &[Recipient], keep: bool) {
        self.stats.builder_compared += 1;
        match (&verdict.accept, built) {
            (Ok(()), Ok(b)) => {
                self.stats.builder_built += 1;
                let state = state_from_json(&b["outputs"][0]["minter"]);
                let value = b["outputs"][0]["value"].as_u64().unwrap();
                if state != verdict.next || value != verdict.value {
                    self.stats.divergences.push(format!("{}: tx.rs built another successor: {state:?} value {value}, the script demands {:?} value {}", self.name, verdict.next, verdict.value));
                } else if keep {
                    self.corpus.push(corpus_case_raw(&format!("{} [tx.rs]", self.name), self.h, b["txid"].clone(), b["transaction"].clone(), &verdict.next, verdict.value, minted));
                }
            }
            (Err(_), Err(_)) => self.stats.builder_refused += 1,
            (Ok(()), Err(e)) => self.stats.divergences.push(format!("{}: the script accepts, tx.rs refuses to build: {e}", self.name)),
            (Err(why), Ok(_)) => self.stats.divergences.push(format!("{}: the script refuses ({why}), tx.rs BUILT it", self.name)),
        }
    }

    /// Another spelling of one argument (not signed, not in the txid): when the engine takes it, the follower must too.
    fn respell(&mut self, verdict: &Verdict, tx: &Transaction, argument_index: usize, spelled: Vec<u8>, what: &str, minted: &[Recipient]) {
        let mut forged = with_argument(tx, argument_index, spelled);
        forged.finalize();
        assert_eq!(forged.id(), tx.id());
        let entries = entries_for(self.h, &forged);
        if let Ok(tx) = run(forged, entries) {
            self.stats.respelled += 1;
            self.corpus.push(corpus_case(&format!("{} [respelled: {what}]", self.name), self.h, &tx, &verdict.next, verdict.value, minted));
        }
    }
}

/// Other spellings of the number in `push` that a script number reader may take as the same number.
fn spellings(push: &[u8]) -> Vec<(Vec<u8>, &'static str)> {
    let mut out = Vec::new();
    if push.len() < 8 {
        out.push(([push.to_vec(), vec![0]].concat(), "one zero byte more"));
        let mut full = push.to_vec();
        full.resize(8, 0);
        out.push((full, "padded to eight bytes"));
    }
    if push.is_empty() {
        out.push((vec![0x80], "negative zero"));
    }
    out
}

fn one_case(rng: &mut Rng, seed: u64, index: usize, stats: &mut Stats, corpus: &mut Vec<Value>) {
    let mut configure = Rng(rng.next());
    let h = Harness::launch_with(|s| random_state(&mut configure, s));
    let s = h.state.clone();
    let value = h.minter.utxo.amount;
    stats.cases += 1;
    let coin = seed.wrapping_mul(1_000_003).wrapping_add(index as u64);
    match rng.below(20) {
        // ------------------------------------------------------------------ mint
        0..=8 => {
            let chain = if rng.chance(93) { rng.pick(&[CHAIN_ETHEREUM, CHAIN_BSC]) } else { rng.pick(&[0u8, 3]) };
            let held = if chain == CHAIN_BSC { s.nonce_bsc } else { s.nonce_ethereum };
            let first = if rng.chance(90) { held } else { held + rng.pick(&[-1i64, 1]) };
            let (age, sequence) = random_age(rng, &s);
            let available = model_refilled(s.bucket, age.clamp(0, TOP), s.capacity, s.refill_per_daa).unwrap_or(0);
            let room = available.min(s.remaining);
            let total = match rng.below(10) {
                0..=5 => rng.range(1, room.max(1)),
                6 | 7 => room.max(1),
                8 => room + 1,
                _ => rng.range(1, MAX_LIMIT),
            };
            let mut n = if rng.chance(4) { rng.pick(&[0usize, 4]) } else { rng.range(1, 3) as usize };
            if n > 0 && (total as usize) < n && total < 4 {
                n = total.max(1) as usize;
            }
            let mut left = total;
            let mut recipients = Vec::new();
            for k in 0..n {
                let amount = if k + 1 == n { left } else { rng.range(1, (left - (n - k - 1) as i64).max(1)) };
                left -= amount;
                let mut r = Recipient::owned(rng.bytes32(), if rng.chance(3) { 0 } else { amount });
                r.owner_scheme = if rng.chance(3) { 5 } else { rng.below(5) as u8 };
                recipients.push(r);
            }
            let who = increasing(rng, 3);
            let q = Quorum::honest(&h.signers, &who, &mint_digest_any(&cov(&h), chain, first, age, &recipients));
            let name = format!("seed {seed:#x} #{index} mint chain {chain} nonce {first} age {age} seq {sequence:#x} n {n}");
            let mut run = Run { name, h: &h, stats, corpus };
            let verdict = model_mint(&s, chain, first, age, sequence, &recipients, value);
            let accepted = run.engine(&verdict, build_mint(&h, chain, first, age, sequence, &recipients, &q, &verdict.next, verdict.value, &recipients), &recipients);
            if let Some(tx) = &accepted {
                if index % 3 == 0 {
                    for (argument_index, what) in [(1usize, "first_nonce"), (2, "age_daa")] {
                        for (spelled, how) in spellings(&argument(tx, argument_index)) {
                            run.respell(&verdict, tx, argument_index, spelled, &format!("{what}, {how}"), &recipients);
                        }
                    }
                }
            }
            // tx.rs: 1 to 3 recipients, plain states, and its own sequence (the claimed age).
            if (1..=3).contains(&n) {
                let verdict = model_mint(&s, chain, first, age, age.max(0) as u64, &recipients, value);
                let request = merge(
                    merge(api_common(coin), quorum_json(&q)),
                    json!({ "minter": located(&h), "chain": chain, "firstNonce": first.to_string(), "ageDaa": age.to_string(), "recipients": recipients_json(&recipients), "tokenValue": TOKEN_VALUE }),
                );
                run.builder(&verdict, api("mint", request), &recipients, index % 2 == 0);
            }
        }
        // ------------------------------------------------------------------ govern
        9..=16 => {
            let action = if rng.chance(97) { rng.range(1, 7) as u8 } else { rng.pick(&[0u8, 8]) };
            let fresh: Vec<Keypair> = (0..5).map(|_| key(rng.range(0x40, 0x7f) as u8)).collect();
            let fresh_guardian = key(rng.range(0x80, 0x8f) as u8);
            let limit = |rng: &mut Rng| match rng.below(8) {
                0 => 0,
                1 => MAX_LIMIT,
                2 => MAX_LIMIT + 1,
                3 => rng.range(0, 1_000),
                _ => rng.range(0, MAX_LIMIT),
            };
            let (params, kind): (Vec<u8>, Option<Value>) = match action {
                0x01 => (vec![], Some(json!({ "kind": "unpause" }))),
                0x02 => {
                    let (c, r) = (limit(rng), limit(rng));
                    ([le8(c), le8(r)].concat(), Some(json!({ "kind": "setLimits", "capacity": c.to_string(), "refillPerDaa": r.to_string() })))
                }
                0x03 | 0x06 => {
                    let keys: Vec<String> = fresh.iter().map(|k| hex32(&xonly(k))).collect();
                    let kind = if action == 0x03 { "setSigners" } else { "proposeRecovery" };
                    ([signer_set_of(&fresh).to_vec(), xonly(&fresh_guardian).to_vec()].concat(), Some(json!({ "kind": kind, "signerKeys": keys, "guardian": hex32(&xonly(&fresh_guardian)) })))
                }
                0x04 => {
                    let chain = if rng.chance(94) { rng.pick(&[CHAIN_ETHEREUM, CHAIN_BSC]) } else { 3 };
                    let held = if chain == CHAIN_BSC { s.nonce_bsc } else { s.nonce_ethereum };
                    let nonce = if rng.chance(88) { held } else { held + rng.pick(&[-1i64, 1]) };
                    ([vec![chain], sm8(nonce).to_vec()].concat(), Some(json!({ "kind": "skipNonce", "chain": chain, "nonce": nonce.to_string() })))
                }
                0x05 => {
                    let v = if rng.chance(6) { 0 } else { rng.range(50_000_000, 10_000_000_000) };
                    (le8(v).to_vec(), Some(json!({ "kind": "setValue", "value": v.to_string() })))
                }
                0x07 => (vec![], Some(json!({ "kind": "vetoRecovery" }))),
                _ => (vec![], None),
            };
            let (age, sequence) = random_age(rng, &s);
            let who = increasing(rng, quorum_of(action));
            let q = Quorum::honest(&h.signers, &who, &digest_for_aged(&h, signed_nonce(&s, action), age, action, &params));
            let name = format!("seed {seed:#x} #{index} govern action {action} age {age} seq {sequence:#x}");
            let mut run = Run { name, h: &h, stats, corpus };
            let verdict = model_govern(&s, action, &params, age, sequence, value);
            let accepted = run.engine(&verdict, build_govern(&h, action, &params, age, sequence, &q, &verdict.next, verdict.value), &[]);
            if let Some(tx) = &accepted {
                if index % 3 == 0 {
                    for (spelled, how) in spellings(&argument(tx, 2)) {
                        run.respell(&verdict, tx, 2, spelled, &format!("age_daa, {how}"), &[]);
                    }
                }
            }
            if let Some(kind) = kind {
                let verdict = model_govern(&s, action, &params, age, age.max(0) as u64, value);
                let request = merge(merge(api_common(coin), quorum_json(&q)), json!({ "minter": located(&h), "action": kind, "ageDaa": age.to_string() }));
                run.builder(&verdict, api("govern", request), &[], index % 2 == 0);
            }
        }
        // ------------------------------------------------------------------ pause
        17 => {
            let sequence = rng.pick(&[0u64, 1, 1_000, u32::MAX as u64, SEQ_DISABLED, u64::MAX]);
            let name = format!("seed {seed:#x} #{index} pause seq {sequence:#x}");
            let mut run = Run { name, h: &h, stats, corpus };
            let verdict = model_pause(&s, sequence, value);
            run.engine(&verdict, build_pause(&h, &h.guardian, sequence, &verdict.next, verdict.value), &[]);
            let verdict = model_pause(&s, 0, value);
            let request = merge(api_common(coin), json!({ "minter": located(&h), "guardianSecretKey": kusdt_kaspa::hex::encode(&h.guardian.secret_bytes()) }));
            run.builder(&verdict, api("pause", request), &[], true);
        }
        // ------------------------------------------------------------------ execute_recovery
        _ => {
            let delay = s.recovery_delay as u64;
            let sequence = match rng.below(6) {
                0 => delay.saturating_sub(1),
                1 => delay + rng.below(1_000).min(TOP as u64 - delay),
                2 => delay | SEQ_DISABLED,
                3 => rng.below(1 << 32),
                _ => delay,
            };
            let name = format!("seed {seed:#x} #{index} execute_recovery delay {delay} seq {sequence:#x}");
            let mut run = Run { name, h: &h, stats, corpus };
            let verdict = model_execute(&s, sequence, value);
            run.engine(&verdict, build_execute(&h, sequence, &verdict.next, verdict.value), &[]);
            let verdict = model_execute(&s, delay, value);
            run.builder(&verdict, api("execute-recovery", merge(api_common(coin), json!({ "minter": located(&h) }))), &[], true);
        }
    }
}

/// Spellings of governance parameters that only the signers could produce (the digest covers the bytes): a negative
/// zero where the script reads a number. The script takes it as zero; the follower has to as well.
fn signed_spellings(stats: &mut Stats, corpus: &mut Vec<Value>) {
    let neg_zero = vec![0u8, 0, 0, 0, 0, 0, 0, 0x80];
    let h = Harness::launch();
    for (action, params, what) in [
        (0x02u8, [neg_zero.clone(), le8(7).to_vec()].concat(), "set_limits, capacity as negative zero"),
        (0x02, [le8(7).to_vec(), neg_zero.clone()].concat(), "set_limits, refill as negative zero"),
        (0x04, [vec![CHAIN_ETHEREUM], neg_zero.clone()].concat(), "skip_nonce of nonce 0 as negative zero"),
        (0x04, [vec![CHAIN_BSC], neg_zero.clone()].concat(), "skip_nonce of BSC nonce 0 as negative zero"),
    ] {
        let who: Vec<usize> = (0..4).collect();
        let q = Quorum::honest(&h.signers, &who, &digest_for(&h, 0, action, &params));
        let verdict = model_govern(&h.state, action, &params, 0, 0, MINTER_SOMPI);
        let name = format!("signed spelling: {what}");
        let mut run = Run { name, h: &h, stats, corpus };
        run.engine(&verdict, build_govern(&h, action, &params, 0, 0, &q, &verdict.next, verdict.value), &[]);
    }
}

/// Shapes a third party can give a signed mint or governance action (the signatures do not bind the transaction):
/// the minter at another input position, plain outputs around the family's, the genesis of an unrelated family
/// riding along, another push opcode for an argument. Whatever the engine accepts, the follower must follow.
fn shapes(stats: &mut Stats, corpus: &mut Vec<Value>) {
    use argent_runtime::{EntryCall, TxContext, args};
    use kaspa_consensus_core::hashing::covenant_id::covenant_id;
    use kaspa_consensus_core::tx::{CovenantBinding, TransactionOutput};
    let h = Harness::launch();
    let recipients = vec![Recipient::schnorr(&key(0xa1), 1_000), Recipient::schnorr(&key(0xa2), 2_000)];
    let verdict = model_mint(&h.state, CHAIN_ETHEREUM, 0, 1, 1, &recipients, MINTER_SOMPI);
    let q = Quorum::honest(&h.signers, &[1, 3, 4], &mint_digest(&cov(&h), CHAIN_ETHEREUM, 0, 1, &recipients));
    let id = h.minter.covenant_id;
    let mut observed = Vec::new();

    // 1. The minter as input 1, after a plain coin.
    let states: Vec<State> = recipients.iter().map(Recipient::state).collect();
    let call = EntryCall::new("mint").args(args!(CHAIN_ETHEREUM, 0i64, 1i64, states, bytes_array(q.keys.iter().map(|k| k.to_vec())), q.indices.clone(), bytes_array(q.signatures.iter().cloned())));
    let mut context = TxContext::new()
        .input(fresh_funding(), funding(), funding_sig(), 0)
        .actor_input("BridgeMint", h.state.state(), call, h.minter.outpoint, h.minter.utxo.clone(), 1)
        .actor_output("BridgeMint", verdict.next.state(), CovenantBinding::new(1, id), MINTER_SOMPI);
    for r in &recipients {
        context = context.actor_output("KCC20", r.state(), CovenantBinding::new(1, id), TOKEN_SOMPI);
    }
    let second = builder().build(&context).map_err(|e| e.to_string()).and_then(|tx| run(tx, vec![funding(), h.minter.utxo.clone()]).map_err(|e| format!("{e:?}")));
    observed.push(("the minter as input 1", second.is_ok()));
    if let Ok(tx) = &second {
        stats.respelled += 1;
        corpus.push(corpus_case("shape: a mint with the minter as input 1 [engine]", &h, tx, &verdict.next, verdict.value, &recipients));
    }

    let base = build_mint(&h, CHAIN_ETHEREUM, 0, 1, 1, &recipients, &q, &verdict.next, verdict.value, &recipients).expect("the plain mint");
    let entries = entries_for(&h, &base);
    let mut keep = |what: &'static str, mut tx: Transaction, corpus: &mut Vec<Value>, stats: &mut Stats| {
        tx.finalize();
        let ok = run(tx.clone(), entries.clone()).is_ok();
        observed.push((what, ok));
        if ok {
            stats.respelled += 1;
            corpus.push(corpus_case(&format!("shape: {what} [engine]"), &h, &tx, &verdict.next, verdict.value, &recipients));
        }
    };
    // 2. Plain outputs before, between and after the family's, two of them with the very scripts of family outputs.
    let mut tx = base.clone();
    let decoy_minter = TransactionOutput::new(MINTER_SOMPI, tx.outputs[0].script_public_key.clone());
    let decoy_token = TransactionOutput::new(TOKEN_SOMPI, tx.outputs[2].script_public_key.clone());
    let plain = TransactionOutput::new(TOKEN_SOMPI, funding().script_public_key);
    tx.outputs.insert(0, decoy_minter);
    tx.outputs.insert(2, decoy_token);
    tx.outputs.insert(4, plain.clone());
    tx.outputs.push(plain.clone());
    keep("plain outputs and decoys around the family's outputs", tx, corpus, stats);
    // 3. The genesis of an unrelated family, authorized by the minter input.
    let mut tx = base.clone();
    let index = tx.outputs.len() as u32;
    let foreign = covenant_id(h.minter.outpoint, [(index, &plain)].into_iter());
    tx.outputs.push(TransactionOutput::with_covenant(TOKEN_SOMPI, plain.script_public_key.clone(), Some(CovenantBinding::new(0, foreign))));
    keep("an unrelated family's genesis authorized by the minter input", tx, corpus, stats);
    // 4. One argument under another push opcode (PUSHDATA1 for the one-byte chain, and for the 32-byte owners' array).
    for (argument_index, what) in [(0usize, "the chain under PUSHDATA1"), (9, "the signer keys under PUSHDATA2")] {
        let items = pushes(&base.inputs[0].signature_script);
        let mut script = Vec::new();
        for (k, item) in items.iter().enumerate() {
            if k == argument_index && argument_index == 0 {
                script.extend_from_slice(&[0x4c, item.len() as u8]);
                script.extend_from_slice(item);
            } else if k == argument_index {
                script.push(0x4d);
                script.extend_from_slice(&(item.len() as u16).to_le_bytes());
                script.extend_from_slice(item);
            } else {
                script.extend_from_slice(&push_script(std::slice::from_ref(item)));
            }
        }
        let mut tx = base.clone();
        tx.inputs[0].signature_script = script;
        keep(what, tx, corpus, stats);
    }
    // 5. A non-push opcode (OP_NOP) in front of the arguments.
    let mut tx = base.clone();
    tx.inputs[0].signature_script.insert(0, 0x61);
    keep("an OP_NOP in front of the arguments", tx, corpus, stats);
    for (what, ok) in observed {
        println!("[p7 shapes] {what}: {}", if ok { "ACCEPTED by the engine (in the corpus for the follower)" } else { "refused by the engine" });
    }
}

#[test]
fn p7_the_script_the_model_and_the_rust_builders_agree() {
    let mut stats = Stats::default();
    let mut corpus = Vec::new();
    shapes(&mut stats, &mut corpus);
    for seed in SEEDS {
        let mut rng = Rng(seed);
        for index in 0..ROUNDS {
            one_case(&mut rng, seed, index, &mut stats, &mut corpus);
        }
    }
    signed_spellings(&mut stats, &mut corpus);
    println!("[p7] seeds {SEEDS:#x?}, {ROUNDS} rounds each");
    println!("[p7] cases {}: the engine accepted {}, refused {}", stats.cases, stats.engine_accepted, stats.engine_refused);
    println!("[p7] tx.rs compared on {}: built {}, refused {}", stats.builder_compared, stats.builder_built, stats.builder_refused);
    println!("[p7] respelled bodies the engine accepted: {}", stats.respelled);
    println!("[p7] divergences: {}", stats.divergences.len());
    for d in &stats.divergences {
        println!("[p7]   {d}");
    }

    // The corpus for the TypeScript follower. The two long constants of every signature script (the BridgeMint
    // program after its state, the KCC20 template's second part) are written once.
    let layout = api("layout", json!({})).unwrap();
    let minter_suffix = layout["contracts"]["BridgeMint"]["suffix"].as_str().unwrap().to_string();
    let minter_prefix = layout["contracts"]["BridgeMint"]["prefix"].as_str().unwrap().to_string();
    let kcc20_suffix = api("template", json!({})).unwrap()["suffix"].as_str().unwrap().to_string();
    let count = corpus.len();
    let mut cases = serde_json::to_string(&corpus).unwrap();
    for (constant, token) in [(&minter_suffix, "<MINTER_SUFFIX>"), (&kcc20_suffix, "<KCC20_SUFFIX>"), (&minter_prefix, "<MINTER_PREFIX>")] {
        if constant.len() > 64 {
            cases = cases.replace(constant.as_str(), token);
        }
    }
    let cases = cases.replace("},{\"name\"", "},\n{\"name\"");
    let constants = json!({ "<MINTER_SUFFIX>": minter_suffix, "<KCC20_SUFFIX>": kcc20_suffix, "<MINTER_PREFIX>": minter_prefix });
    let file = format!("{{\"seeds\":{},\"rounds\":{ROUNDS},\"constants\":{constants},\n\"cases\":{cases}}}\n", json!(SEEDS.iter().map(|s| format!("{s:#x}")).collect::<Vec<_>>()));
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../packages/protocol/src/rev-minter-corpus.json");
    // A test run leaves the tree as it was: the tracked corpus is rewritten only when asked (KUSDT_WRITE_CORPUS=1,
    // after a change to the covenant or to this test), and otherwise it must already be what this run produced. The
    // signatures carry no randomness (common::sign_digest), so the same sources give the same bytes every time.
    if std::env::var("KUSDT_WRITE_CORPUS").is_ok_and(|v| v == "1") {
        std::fs::write(path, &file).expect("the corpus is written");
        println!("[p7] corpus: {count} accepted transactions, {} bytes, written to {path}", file.len());
    } else {
        let committed = std::fs::read_to_string(path).expect("the committed corpus is read").replace("\r\n", "\n");
        assert!(committed == file, "the committed corpus at {path} is not what this run produces ({count} transactions, {} bytes): run this test once with KUSDT_WRITE_CORPUS=1 and commit the file", file.len());
        println!("[p7] corpus: {count} accepted transactions, {} bytes, equal to the committed {path}", file.len());
    }

    assert!(stats.divergences.is_empty(), "{} divergences (listed above)", stats.divergences.len());
    assert!(stats.engine_accepted >= 150 && stats.engine_refused >= 150, "the run exercised both verdicts");
    assert!(stats.builder_built >= 120 && stats.builder_refused >= 120);
}
