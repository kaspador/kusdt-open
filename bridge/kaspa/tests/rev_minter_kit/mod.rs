//! Review kit for the BridgeMint pre-launch review (branch r16/rev-minter).
//!
//! - an independent model of bridge_mint.ag, written from the contract text (checked i64 arithmetic,
//!   as the script engine's numbers are), that answers "accept or refuse" and the successor state;
//! - builders that put ANY entry arguments next to ANY successor state, so the engine is the judge;
//! - helpers to respell a signature script, and to call the real Rust builders (tx.rs through api::run).
#![allow(dead_code)]

pub use crate::common::*;

use argent_runtime::{ArtifactValue, EntryCall, TxContext, args};
use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::tx::{CovenantBinding, ScriptPublicKey, Transaction, TransactionOutpoint, UtxoEntry};
use kusdt_kaspa::hex;
use secp256k1::Keypair;
use serde_json::{Value, json};
use std::cell::Cell;

pub const MAX_LIMIT: i64 = 1_000_000_000_000_000;
pub const SEQ_DISABLED: u64 = 1 << 63;
pub const SEQ_MASK: u64 = 0xffff_ffff;

// ---------------------------------------------------------------------------------------------
// A small deterministic generator (splitmix64): seeds are printed by the tests that use it.

pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    /// Uniform in 0..n (n > 0).
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    /// Uniform in lo..=hi.
    pub fn range(&mut self, lo: i64, hi: i64) -> i64 {
        assert!(lo <= hi);
        let span = (hi as i128 - lo as i128 + 1) as u128;
        (lo as i128 + (self.next() as u128 % span) as i128) as i64
    }
    pub fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
    pub fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize]
    }
    pub fn bytes32(&mut self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for chunk in out.chunks_mut(8) {
            chunk.copy_from_slice(&self.next().to_le_bytes());
        }
        out
    }
}

// ---------------------------------------------------------------------------------------------
// The model of bridge_mint.ag.

/// `refilled` of bridge_mint.ag, statement for statement, with the engine's checked 64-bit numbers.
pub fn model_refilled(bucket: i64, age: i64, capacity: i64, refill: i64) -> Result<i64, String> {
    if age < 0 {
        return Err("age_daa < 0".into());
    }
    if refill < 0 {
        return Err("refill_per_daa < 0".into());
    }
    let over = || "arithmetic overflow in refilled".to_string();
    let mut filled = bucket;
    if refill > 0 && bucket < capacity {
        let needed = capacity.checked_sub(bucket).ok_or_else(over)?.checked_add(refill).ok_or_else(over)?.checked_sub(1).ok_or_else(over)? / refill;
        if age >= needed {
            filled = capacity;
        } else {
            filled = bucket.checked_add(age.checked_mul(refill).ok_or_else(over)?).ok_or_else(over)?;
        }
    }
    if filled > capacity {
        filled = capacity;
    }
    Ok(filled)
}

/// `require(this.ageDaa >= age)` (the compiler's `DUP 0 2^32 WITHIN VERIFY CHECKSEQUENCEVERIFY`), and
/// `require_settled_inputs`: the input's sequence is exactly the age claimed.
pub fn model_age_lock(age: i64, sequence: u64) -> Result<(), String> {
    if !(0..(1i64 << 32)).contains(&age) {
        return Err("claimed age outside 0..2^32".into());
    }
    if sequence & SEQ_DISABLED != 0 {
        return Err("the input's sequence has the disabled bit".into());
    }
    if (age as u64 & SEQ_MASK) > (sequence & SEQ_MASK) {
        return Err("claimed age above the input's sequence".into());
    }
    if sequence != age as u64 {
        return Err("the input's sequence is not exactly the claimed age".into());
    }
    Ok(())
}

/// `int(byte[8](..))`: an 8-byte little-endian sign-magnitude script number.
pub fn int8(bytes: &[u8]) -> i64 {
    assert_eq!(bytes.len(), 8);
    let mut magnitude = [0u8; 8];
    magnitude.copy_from_slice(bytes);
    let negative = magnitude[7] & 0x80 != 0;
    magnitude[7] &= 0x7f;
    let m = i64::from_le_bytes(magnitude);
    if negative { -m } else { m }
}

pub fn le8(x: i64) -> [u8; 8] {
    assert!(x >= 0);
    x.to_le_bytes()
}

pub struct Verdict {
    /// Ok when the contract accepts; otherwise the first require that fails (in the model's order).
    pub accept: Result<(), String>,
    /// The successor the contract would demand (when refused: the successor a naive builder would offer).
    pub next: MinterState,
    /// The KAS value the successor must hold.
    pub value: u64,
}

fn first_err(checks: Vec<Result<(), String>>) -> Result<(), String> {
    for c in checks {
        c?;
    }
    Ok(())
}

fn need(ok: bool, why: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(why.to_string()) }
}

pub fn model_mint(s: &MinterState, chain: u8, first_nonce: i64, age: i64, sequence: u64, recipients: &[Recipient], value: u64) -> Verdict {
    let mut checks = vec![need(!s.paused, "paused"), need((1..=3).contains(&recipients.len()), "1 to 3 recipients")];
    let mut total: Option<i64> = Some(0);
    for r in recipients {
        checks.push(need(r.amount > 0, "amount > 0"));
        checks.push(need(r.owner_scheme <= 4, "owner scheme"));
        checks.push(need(r.borrow_scheme == 0, "borrow scheme"));
        checks.push(need(r.borrow_guard == [0; 32], "borrow guard"));
        checks.push(need(r.extension_commitment == [0; 32], "extension"));
        total = total.and_then(|t| t.checked_add(r.amount));
    }
    checks.push(need(total.is_some(), "the total overflows"));
    let total_w = recipients.iter().fold(0i64, |t, r| t.wrapping_add(r.amount));
    let n = recipients.len() as i64;
    let mut next = s.clone();
    match chain {
        CHAIN_ETHEREUM => {
            checks.push(need(first_nonce == s.nonce_ethereum, "first_nonce is not the Ethereum nonce"));
            checks.push(need(first_nonce.checked_add(n).is_some(), "nonce overflow"));
            next.nonce_ethereum = first_nonce.wrapping_add(n);
        }
        CHAIN_BSC => {
            checks.push(need(first_nonce == s.nonce_bsc, "first_nonce is not the BSC nonce"));
            checks.push(need(first_nonce.checked_add(n).is_some(), "nonce overflow"));
            next.nonce_bsc = first_nonce.wrapping_add(n);
        }
        _ => checks.push(Err("unknown chain".into())),
    }
    checks.push(model_age_lock(age, sequence));
    let available = model_refilled(s.bucket, age, s.capacity, s.refill_per_daa);
    let avail = match &available {
        Ok(a) => *a,
        Err(_) => refilled(s.bucket, age.max(0), s.capacity, s.refill_per_daa.max(0)),
    };
    checks.push(available.map(|_| ()));
    checks.push(need(total.is_some_and(|t| t <= avail), "total above the allowance"));
    checks.push(need(total.is_some_and(|t| t <= s.remaining), "total above remaining"));
    checks.push(need(total.is_some_and(|t| s.remaining.checked_sub(t).is_some() && avail.checked_sub(t).is_some()), "subtraction overflow"));
    next.remaining = s.remaining.wrapping_sub(total_w);
    next.bucket = avail.wrapping_sub(total_w);
    Verdict { accept: first_err(checks), next, value }
}

/// A pause claims no age: `require_settled_inputs` holds its input's sequence at 0.
pub fn model_pause(s: &MinterState, sequence: u64, value: u64) -> Verdict {
    let mut next = s.clone();
    next.paused = true;
    next.admin_nonce = s.admin_nonce.wrapping_add(1);
    let checks = vec![
        need(!s.paused, "already paused"),
        need(s.admin_nonce.checked_add(1).is_some(), "nonce overflow"),
        need(sequence == 0, "a pause's input asks a relative lock"),
    ];
    Verdict { accept: first_err(checks), next, value }
}

pub fn model_execute(s: &MinterState, sequence: u64, value: u64) -> Verdict {
    let mut next = s.clone();
    next.signer_set = s.recovery_signer_set;
    next.guardian = s.recovery_guardian;
    next.admin_nonce = s.admin_nonce.wrapping_add(1);
    next.recovery_nonce = s.recovery_nonce.wrapping_add(1);
    next.recovery_pending = false;
    next.recovery_signer_set = [0; 32];
    next.recovery_guardian = [0; 32];
    let checks = vec![
        need(s.recovery_pending, "no recovery pending"),
        model_age_lock(s.recovery_delay, sequence),
        need(s.admin_nonce.checked_add(1).is_some() && s.recovery_nonce.checked_add(1).is_some(), "nonce overflow"),
    ];
    Verdict { accept: first_err(checks), next, value }
}

/// `govern`, given that the quorum's signatures are good (the tests of signatures are separate).
pub fn model_govern(s: &MinterState, action: u8, params: &[u8], age: i64, sequence: u64, value: u64) -> Verdict {
    let mut checks = vec![model_age_lock(age, sequence)];
    let settled = model_refilled(s.bucket, age, s.capacity, s.refill_per_daa);
    let mut next = s.clone();
    next.bucket = match &settled {
        Ok(b) => *b,
        Err(_) => refilled(s.bucket, age.max(0), s.capacity, s.refill_per_daa.max(0)),
    };
    checks.push(settled.map(|_| ()));
    next.admin_nonce = s.admin_nonce.wrapping_add(1);
    let mut next_value = value;
    let clear = |n: &mut MinterState| {
        n.recovery_nonce = s.recovery_nonce.wrapping_add(1);
        n.recovery_pending = false;
        n.recovery_signer_set = [0; 32];
        n.recovery_guardian = [0; 32];
    };
    match action {
        0x01 => {
            checks.push(need(params.is_empty(), "unpause params"));
            checks.push(need(s.paused, "not paused"));
            next.paused = false;
        }
        0x02 => {
            checks.push(need(params.len() == 16, "set_limits params"));
            if params.len() == 16 {
                let (c, r) = (int8(&params[..8]), int8(&params[8..]));
                checks.push(need(c >= 0 && r >= 0, "negative limit"));
                checks.push(need(c <= MAX_LIMIT && r <= MAX_LIMIT, "limit above MAX_LIMIT"));
                next.capacity = c;
                next.refill_per_daa = r;
                if next.bucket > c {
                    next.bucket = c;
                }
            }
        }
        0x03 => {
            checks.push(need(params.len() == 64, "set_signers params"));
            if params.len() == 64 {
                next.signer_set.copy_from_slice(&params[..32]);
                next.guardian.copy_from_slice(&params[32..]);
                clear(&mut next);
            }
        }
        0x04 => {
            checks.push(need(params.len() == 9, "skip_nonce params"));
            if params.len() == 9 {
                let nonce = int8(&params[1..]);
                match params[0] {
                    CHAIN_ETHEREUM => {
                        checks.push(need(nonce == s.nonce_ethereum, "not the Ethereum nonce"));
                        next.nonce_ethereum = nonce.wrapping_add(1);
                    }
                    CHAIN_BSC => {
                        checks.push(need(nonce == s.nonce_bsc, "not the BSC nonce"));
                        next.nonce_bsc = nonce.wrapping_add(1);
                    }
                    _ => checks.push(Err("unknown chain".into())),
                }
                checks.push(need(nonce.checked_add(1).is_some(), "nonce overflow"));
            }
        }
        0x05 => {
            checks.push(need(params.len() == 8, "set_value params"));
            if params.len() == 8 {
                let v = int8(params);
                checks.push(need(v > 0, "value must be positive"));
                next_value = v.max(1) as u64;
            }
        }
        0x06 => {
            checks.push(need(params.len() == 64, "propose params"));
            checks.push(need(!s.recovery_pending, "a recovery is pending"));
            next.admin_nonce = s.admin_nonce;
            if params.len() == 64 {
                next.recovery_nonce = s.recovery_nonce.wrapping_add(1);
                next.recovery_pending = true;
                next.recovery_signer_set.copy_from_slice(&params[..32]);
                next.recovery_guardian.copy_from_slice(&params[32..]);
            }
        }
        0x07 => {
            checks.push(need(params.is_empty(), "veto params"));
            checks.push(need(s.recovery_pending, "no recovery pending"));
            next.admin_nonce = s.admin_nonce;
            clear(&mut next);
        }
        _ => checks.push(Err("unknown action".into())),
    }
    Verdict { accept: first_err(checks), next, value: next_value }
}

pub fn quorum_of(action: u8) -> usize {
    match action {
        0x06 => 3,
        0x07 => 1,
        _ => 4,
    }
}

/// The nonce a governance digest carries for `action` in state `s`.
pub fn signed_nonce(s: &MinterState, action: u8) -> i64 {
    if action == 0x06 || action == 0x07 { s.recovery_nonce } else { s.admin_nonce }
}

// ---------------------------------------------------------------------------------------------
// Transactions: any arguments next to any successor.

thread_local! {
    static FUNDING: Cell<u32> = const { Cell::new(0) };
}

pub fn fresh_funding() -> TransactionOutpoint {
    FUNDING.with(|f| {
        f.set(f.get() + 1);
        outpoint(0xf7, f.get())
    })
}

pub fn bytes_array(items: impl IntoIterator<Item = Vec<u8>>) -> ArtifactValue {
    ArtifactValue::Array(items.into_iter().map(ArtifactValue::Bytes).collect())
}

pub fn keys_of(keys: &[Keypair]) -> Vec<[u8; 32]> {
    keys.iter().map(xonly).collect()
}

/// What a quorum check is given.
#[derive(Clone)]
pub struct Quorum {
    pub keys: Vec<[u8; 32]>,
    pub indices: Vec<u8>,
    pub signatures: Vec<Vec<u8>>,
}

impl Quorum {
    /// `who` (positions in `signers`) sign `digest`, honestly.
    pub fn honest(signers: &[Keypair], who: &[usize], digest: &[u8; 32]) -> Self {
        Self {
            keys: keys_of(signers),
            indices: who.iter().map(|&i| i as u8).collect(),
            signatures: who.iter().map(|&i| sign_digest(&signers[i], digest)).collect(),
        }
    }
}

pub fn cov(h: &Harness) -> [u8; 32] {
    h.minter.covenant_id.as_bytes()
}

fn classify(error: argent_runtime::BuilderError) -> Rejected {
    use argent_runtime::BuilderError;
    match error {
        BuilderError::InputScript { .. } | BuilderError::TxScript(_) => Rejected::Script(error.to_string()),
        other => Rejected::Build(other.to_string()),
    }
}

/// A mint with these exact arguments, offering `next` as the successor and `outputs` as the minted states.
#[allow(clippy::too_many_arguments)]
pub fn build_mint(
    h: &Harness,
    chain: u8,
    first_nonce: i64,
    age: i64,
    sequence: u64,
    recipients: &[Recipient],
    q: &Quorum,
    next: &MinterState,
    value: u64,
    outputs: &[Recipient],
) -> Result<Transaction, Rejected> {
    build_mint_valued(h, chain, first_nonce, age, sequence, recipients, q, next, value, outputs, &vec![TOKEN_SOMPI; outputs.len()])
}

/// `build_mint`, with the KAS value of each minted output given (`values[k]` for `outputs[k]`).
#[allow(clippy::too_many_arguments)]
pub fn build_mint_valued(
    h: &Harness,
    chain: u8,
    first_nonce: i64,
    age: i64,
    sequence: u64,
    recipients: &[Recipient],
    q: &Quorum,
    next: &MinterState,
    value: u64,
    outputs: &[Recipient],
    values: &[u64],
) -> Result<Transaction, Rejected> {
    let states: Vec<State> = recipients.iter().map(Recipient::state).collect();
    let call = EntryCall::new("mint").args(args!(
        chain,
        first_nonce,
        age,
        states,
        bytes_array(q.keys.iter().map(|k| k.to_vec())),
        q.indices.clone(),
        bytes_array(q.signatures.iter().cloned())
    ));
    let covenant = h.minter.covenant_id;
    let mut context = TxContext::new()
        .actor_input("BridgeMint", h.state.state(), call, h.minter.outpoint, h.minter.utxo.clone(), sequence)
        .input(fresh_funding(), funding(), funding_sig(), 0)
        .actor_output("BridgeMint", next.state(), CovenantBinding::new(0, covenant), value);
    for (r, v) in outputs.iter().zip(values) {
        context = context.actor_output("KCC20", r.state(), CovenantBinding::new(0, covenant), *v);
    }
    let tx = builder().build(&context).map_err(classify)?;
    run(tx, vec![h.minter.utxo.clone(), funding()])
}

/// An honest mint by signers 0, 1, 2: the arguments, the digest and the outputs agree; `next` is the model's.
pub fn honest_mint(h: &Harness, chain: u8, first_nonce: i64, age: i64, recipients: &[Recipient]) -> (Result<Transaction, Rejected>, Verdict) {
    let v = model_mint(&h.state, chain, first_nonce, age, age.max(0) as u64, recipients, h.minter.utxo.amount);
    let q = Quorum::honest(&h.signers, &[0, 1, 2], &mint_digest(&cov(h), chain, first_nonce, age.max(0), recipients));
    (build_mint(h, chain, first_nonce, age, age.max(0) as u64, recipients, &q, &v.next, v.value, recipients), v)
}

#[allow(clippy::too_many_arguments)]
pub fn build_govern(h: &Harness, action: u8, params: &[u8], age: i64, sequence: u64, q: &Quorum, next: &MinterState, value: u64) -> Result<Transaction, Rejected> {
    let call = EntryCall::new("govern").args(args!(
        action,
        params.to_vec(),
        age,
        bytes_array(q.keys.iter().map(|k| k.to_vec())),
        q.indices.clone(),
        bytes_array(q.signatures.iter().cloned())
    ));
    let context = TxContext::new()
        .actor_input("BridgeMint", h.state.state(), call, h.minter.outpoint, h.minter.utxo.clone(), sequence)
        .input(fresh_funding(), funding(), funding_sig(), 0)
        .actor_output("BridgeMint", next.state(), CovenantBinding::new(0, h.minter.covenant_id), value);
    let tx = builder().build(&context).map_err(classify)?;
    run(tx, vec![h.minter.utxo.clone(), funding()])
}

/// An honest governance action: the right number of signers (the first ones), the right nonce, the model's successor.
pub fn honest_govern(h: &Harness, action: u8, params: &[u8], age: i64) -> (Result<Transaction, Rejected>, Verdict) {
    let v = model_govern(&h.state, action, params, age, age.max(0) as u64, h.minter.utxo.amount);
    let who: Vec<usize> = (0..quorum_of(action)).collect();
    let q = Quorum::honest(&h.signers, &who, &digest_for_aged(h, signed_nonce(&h.state, action), age, action, params));
    (build_govern(h, action, params, age, age.max(0) as u64, &q, &v.next, v.value), v)
}

pub fn build_pause(h: &Harness, by: &Keypair, sequence: u64, next: &MinterState, value: u64) -> Result<Transaction, Rejected> {
    let signer = *by;
    let call = EntryCall::new("pause").args_with(move |tx, index| args!(sign_input(tx, index, &signer)));
    let context = TxContext::new()
        .actor_input("BridgeMint", h.state.state(), call, h.minter.outpoint, h.minter.utxo.clone(), sequence)
        .actor_output("BridgeMint", next.state(), CovenantBinding::new(0, h.minter.covenant_id), value);
    let tx = builder().build(&context).map_err(classify)?;
    run(tx, vec![h.minter.utxo.clone()])
}

pub fn build_execute(h: &Harness, sequence: u64, next: &MinterState, value: u64) -> Result<Transaction, Rejected> {
    let context = TxContext::new()
        .actor_input("BridgeMint", h.state.state(), EntryCall::new("execute_recovery"), h.minter.outpoint, h.minter.utxo.clone(), sequence)
        .input(fresh_funding(), funding(), funding_sig(), 0)
        .actor_output("BridgeMint", next.state(), CovenantBinding::new(0, h.minter.covenant_id), value);
    let tx = builder().build(&context).map_err(classify)?;
    run(tx, vec![h.minter.utxo.clone(), funding()])
}

/// Moves the harness to the successor an accepted transaction made (output 0).
pub fn adopt(h: &mut Harness, tx: &Transaction, next: MinterState) {
    h.state = next;
    h.minter = covenant_output(tx, 0);
}

/// The entries of a transaction whose input 0 is the minter and whose other inputs are the test funding.
pub fn entries_for(h: &Harness, tx: &Transaction) -> Vec<UtxoEntry> {
    let mut entries = vec![h.minter.utxo.clone()];
    entries.extend((1..tx.inputs.len()).map(|_| funding()));
    entries
}

/// The engine's answer, as text, for the tables the tests print.
pub fn verdict_text<T>(r: &Result<T, Rejected>) -> String {
    match r {
        Ok(_) => "ACCEPTED".into(),
        Err(Rejected::Script(e)) => format!("refused by the engine: {}", e.chars().take(110).collect::<String>()),
        Err(Rejected::Build(e)) => format!("NOT BUILT (no engine verdict): {}", e.chars().take(110).collect::<String>()),
    }
}

/// Counts what a test proved: engine refusals and accepted controls.
#[derive(Default)]
pub struct Tally {
    pub refused: usize,
    pub controls: usize,
}

impl Tally {
    /// The engine must have accepted this one.
    #[track_caller]
    pub fn control<T>(&mut self, what: &str, r: Result<T, Rejected>) -> T {
        match r {
            Ok(v) => {
                self.controls += 1;
                v
            }
            Err(e) => panic!("control `{what}` was not accepted: {e:?}"),
        }
    }
    /// The engine (not the builder) must have refused this one.
    #[track_caller]
    pub fn refused<T>(&mut self, what: &str, r: Result<T, Rejected>) {
        match r {
            Err(Rejected::Script(_)) => self.refused += 1,
            Err(Rejected::Build(e)) => panic!("`{what}`: no engine verdict, the builder failed first: {e}"),
            Ok(_) => panic!("`{what}` was ACCEPTED by the engine"),
        }
    }
    pub fn report(&self, name: &str) {
        println!("[{name}] engine refusals: {}, accepted controls: {}", self.refused, self.controls);
    }
}

// ---------------------------------------------------------------------------------------------
// Respelling a signature script (argument bytes are not signed and the transaction id does not cover them).

pub fn pushes(script: &[u8]) -> Vec<Vec<u8>> {
    let (mut out, mut i) = (Vec::new(), 0usize);
    while i < script.len() {
        let op = script[i];
        i += 1;
        match op {
            0x00 => out.push(vec![]),
            0x01..=0x4b => {
                out.push(script[i..i + op as usize].to_vec());
                i += op as usize;
            }
            0x4c => {
                let n = script[i] as usize;
                out.push(script[i + 1..i + 1 + n].to_vec());
                i += 1 + n;
            }
            0x4d => {
                let n = u16::from_le_bytes([script[i], script[i + 1]]) as usize;
                out.push(script[i + 2..i + 2 + n].to_vec());
                i += 2 + n;
            }
            0x4f => out.push(vec![0x81]),
            0x51..=0x60 => out.push(vec![op - 0x50]),
            _ => panic!("not a push-only script: {op:#x}"),
        }
    }
    out
}

pub fn push_script(items: &[Vec<u8>]) -> Vec<u8> {
    let mut s = Vec::new();
    for d in items {
        match d.len() {
            0 => s.push(0x00),
            1 if (1..=16).contains(&d[0]) => s.push(0x50 + d[0]),
            1 if d[0] == 0x81 => s.push(0x4f),
            n if n <= 75 => {
                s.push(n as u8);
                s.extend_from_slice(d);
            }
            n if n <= 255 => {
                s.push(0x4c);
                s.push(n as u8);
                s.extend_from_slice(d);
            }
            n => {
                s.push(0x4d);
                s.extend_from_slice(&(n as u16).to_le_bytes());
                s.extend_from_slice(d);
            }
        }
    }
    s
}

/// The same transaction with one argument of input 0 rewritten (every signature untouched).
pub fn with_argument(tx: &Transaction, argument: usize, value: Vec<u8>) -> Transaction {
    let mut forged = tx.clone();
    let mut items = pushes(&forged.inputs[0].signature_script);
    items[argument] = value;
    forged.inputs[0].signature_script = push_script(&items);
    forged
}

pub fn argument(tx: &Transaction, index: usize) -> Vec<u8> {
    pushes(&tx.inputs[0].signature_script)[index].clone()
}

/// The locking script of an actor state in the kUSDT family.
pub fn script_of(actor: &str, state: State) -> ScriptPublicKey {
    builder().covenant_utxo(actor, state, 0, 0, false, None).expect("a state's script").script_public_key
}

// ---------------------------------------------------------------------------------------------
// The real builders (tx.rs through api::run), fed the harness's minter.

pub fn hex32(b: &[u8; 32]) -> String {
    hex::encode(b)
}

pub fn state_json(s: &MinterState) -> Value {
    json!({
        "remaining": s.remaining.to_string(), "bucket": s.bucket.to_string(), "capacity": s.capacity.to_string(),
        "refillPerDaa": s.refill_per_daa.to_string(), "nonceEthereum": s.nonce_ethereum.to_string(), "nonceBsc": s.nonce_bsc.to_string(),
        "adminNonce": s.admin_nonce.to_string(), "paused": s.paused, "signerSet": hex32(&s.signer_set), "guardian": hex32(&s.guardian),
        "recoveryDelay": s.recovery_delay.to_string(), "recoveryNonce": s.recovery_nonce.to_string(), "recoveryPending": s.recovery_pending,
        "recoverySignerSet": hex32(&s.recovery_signer_set), "recoveryGuardian": hex32(&s.recovery_guardian),
    })
}

fn int_of(v: &Value) -> i64 {
    match v {
        Value::String(s) => s.parse().expect("an integer string"),
        other => other.as_i64().expect("an integer"),
    }
}

fn bytes32_of(v: &Value) -> [u8; 32] {
    hex::decode(v.as_str().expect("hex")).expect("hex").try_into().expect("32 bytes")
}

pub fn state_from_json(v: &Value) -> MinterState {
    MinterState {
        remaining: int_of(&v["remaining"]),
        bucket: int_of(&v["bucket"]),
        capacity: int_of(&v["capacity"]),
        refill_per_daa: int_of(&v["refillPerDaa"]),
        nonce_ethereum: int_of(&v["nonceEthereum"]),
        nonce_bsc: int_of(&v["nonceBsc"]),
        admin_nonce: int_of(&v["adminNonce"]),
        paused: v["paused"].as_bool().unwrap(),
        signer_set: bytes32_of(&v["signerSet"]),
        guardian: bytes32_of(&v["guardian"]),
        recovery_delay: int_of(&v["recoveryDelay"]),
        recovery_nonce: int_of(&v["recoveryNonce"]),
        recovery_pending: v["recoveryPending"].as_bool().unwrap(),
        recovery_signer_set: bytes32_of(&v["recoverySignerSet"]),
        recovery_guardian: bytes32_of(&v["recoveryGuardian"]),
    }
}

pub fn spk_hex(spk: &ScriptPublicKey) -> String {
    kusdt_kaspa::model::spk_to_hex(spk)
}

/// The harness's minter as the builders take it (`Located<MinterState>`).
pub fn located(h: &Harness) -> Value {
    json!({
        "utxo": {
            "transactionId": h.minter.outpoint.transaction_id.to_string(), "index": h.minter.outpoint.index,
            "amount": h.minter.utxo.amount, "scriptPublicKey": spk_hex(&h.minter.utxo.script_public_key),
            "covenantId": h.minter.covenant_id.to_string(),
        },
        "state": state_json(&h.state),
    })
}

pub fn payer() -> Keypair {
    key(0xc8)
}

/// `network`, `changeAddress` and one plain coin, as every builder takes them.
pub fn api_common(coin_seed: u64) -> Value {
    let k = payer();
    let mut id = [0xe0u8; 32];
    id[..8].copy_from_slice(&coin_seed.to_le_bytes());
    json!({
        "network": "simnet",
        "changeAddress": Address::new(Prefix::Simnet, Version::PubKey, &xonly(&k)).to_string(),
        "funding": [{
            "utxo": { "transactionId": hex::encode(&id), "index": 0, "amount": 1_000_000_000_000u64, "scriptPublicKey": format!("000020{}ac", hex::encode(&xonly(&k))) },
            "secretKey": hex::encode(&k.secret_bytes()),
        }],
    })
}

pub fn merge(mut base: Value, extra: Value) -> Value {
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

pub fn api(command: &str, request: Value) -> Result<Value, String> {
    kusdt_kaspa::api::run(command, &request.to_string())
}

pub fn recipients_json(recipients: &[Recipient]) -> Value {
    Value::Array(recipients.iter().map(|r| json!({ "ownerScheme": r.owner_scheme, "owner": hex32(&r.owner), "amount": r.amount.to_string() })).collect())
}

pub fn hex_list(items: &[Vec<u8>]) -> Vec<String> {
    items.iter().map(|b| hex::encode(b)).collect()
}

pub fn quorum_json(q: &Quorum) -> Value {
    json!({
        "signerKeys": q.keys.iter().map(hex32).collect::<Vec<_>>(),
        "signerIndices": q.indices,
        "signatures": hex_list(&q.signatures),
    })
}

/// One line of the corpus the TypeScript follower replays (bridge/packages/protocol/src/rev-minter-diff.test.ts).
pub fn corpus_case(name: &str, h: &Harness, tx: &Transaction, next: &MinterState, value: u64, minted: &[Recipient]) -> Value {
    corpus_case_raw(name, h, json!(tx.id().to_string()), kusdt_kaspa::tx::rpc_json(tx), next, value, minted)
}

/// The same for a transaction already in the node's JSON form (what the builders return).
pub fn corpus_case_raw(name: &str, h: &Harness, txid: Value, tx: Value, next: &MinterState, value: u64, minted: &[Recipient]) -> Value {
    json!({
        "name": name,
        "covenantId": h.minter.covenant_id.to_string(),
        "current": {
            "transactionId": h.minter.outpoint.transaction_id.to_string(), "index": h.minter.outpoint.index,
            "scriptPublicKey": spk_hex(&h.minter.utxo.script_public_key),
        },
        "spent": state_json(&h.state),
        "txid": txid,
        "tx": tx,
        "next": state_json(next),
        "value": value.to_string(),
        "minted": recipients_json(minted),
    })
}

/// `x as byte[8]` for any x: little-endian magnitude, the sign in the top bit (what the script hashes).
pub fn sm8(x: i64) -> [u8; 8] {
    let mut b = x.unsigned_abs().to_le_bytes();
    if x < 0 {
        b[7] |= 0x80;
    }
    b
}

/// The mint digest as the script forms it, for any numbers (the harness's own refuses negative ones).
pub fn mint_digest_any(covenant: &[u8; 32], chain: u8, first_nonce: i64, age_daa: i64, recipients: &[Recipient]) -> [u8; 32] {
    let mut message = b"kUSDT/mint/v2".to_vec();
    message.extend_from_slice(covenant);
    message.push(chain);
    message.extend_from_slice(&sm8(first_nonce));
    message.extend_from_slice(&sm8(age_daa));
    for r in recipients {
        message.push(r.owner_scheme);
        message.extend_from_slice(&r.owner);
        message.extend_from_slice(&sm8(r.amount));
    }
    *blake3::hash(&message).as_bytes()
}

/// The unpause digest (SPEC §6) for a spend that claims age 0: the paused coin's outpoint is part of it.
pub fn unpause_digest_any(covenant: &[u8; 32], nonce: i64, txid: &[u8; 32], index: u32) -> [u8; 32] {
    unpause_digest_aged(covenant, nonce, 0, txid, index)
}

/// The unpause digest (SPEC §6): the paused coin's outpoint and the age the spend claims are part of it.
pub fn unpause_digest_aged(covenant: &[u8; 32], nonce: i64, age: i64, txid: &[u8; 32], index: u32) -> [u8; 32] {
    let mut message = b"kUSDT/unpause/v2".to_vec();
    message.extend_from_slice(covenant);
    message.extend_from_slice(&sm8(nonce));
    message.extend_from_slice(&sm8(age));
    message.extend_from_slice(txid);
    message.extend_from_slice(&sm8(index as i64));
    *blake3::hash(&message).as_bytes()
}

/// The unpause message as it was before the age was signed ("kUSDT/unpause/v1"): the script must refuse it.
#[allow(dead_code)]
pub fn unpause_digest_v1(covenant: &[u8; 32], nonce: i64, txid: &[u8; 32], index: u32) -> [u8; 32] {
    let mut message = b"kUSDT/unpause/v1".to_vec();
    message.extend_from_slice(covenant);
    message.extend_from_slice(&sm8(nonce));
    message.extend_from_slice(txid);
    message.extend_from_slice(&sm8(index as i64));
    *blake3::hash(&message).as_bytes()
}

/// What the signers sign for `action` on the minter coin the harness holds now, for a spend that claims age 0: the
/// unpause message for an unpause (it names that coin), the govern message for everything else.
pub fn digest_for(h: &Harness, nonce: i64, action: u8, params: &[u8]) -> [u8; 32] {
    digest_for_aged(h, nonce, 0, action, params)
}

/// `digest_for`, for a spend that claims `age`.
pub fn digest_for_aged(h: &Harness, nonce: i64, age: i64, action: u8, params: &[u8]) -> [u8; 32] {
    if action == 0x01 {
        unpause_digest_aged(&cov(h), nonce, age, &h.minter.outpoint.transaction_id.as_bytes(), h.minter.outpoint.index)
    } else {
        govern_digest_aged(&cov(h), nonce, age, action, params)
    }
}

/// The govern digest for any nonce and any action byte and params, for a spend that claims age 0.
pub fn govern_digest_any(covenant: &[u8; 32], nonce: i64, action: u8, params: &[u8]) -> [u8; 32] {
    govern_digest_aged(covenant, nonce, 0, action, params)
}

/// The govern digest for any nonce, age, action byte and params.
pub fn govern_digest_aged(covenant: &[u8; 32], nonce: i64, age: i64, action: u8, params: &[u8]) -> [u8; 32] {
    let mut message = b"kUSDT/govern/v2".to_vec();
    message.extend_from_slice(covenant);
    message.extend_from_slice(&sm8(nonce));
    message.extend_from_slice(&sm8(age));
    message.push(action);
    message.extend_from_slice(params);
    *blake3::hash(&message).as_bytes()
}

/// The govern message as it was before the age was signed ("kUSDT/govern/v1"): the script must refuse it.
#[allow(dead_code)]
pub fn govern_digest_v1(covenant: &[u8; 32], nonce: i64, action: u8, params: &[u8]) -> [u8; 32] {
    let mut message = b"kUSDT/govern/v1".to_vec();
    message.extend_from_slice(covenant);
    message.extend_from_slice(&sm8(nonce));
    message.push(action);
    message.extend_from_slice(params);
    *blake3::hash(&message).as_bytes()
}
