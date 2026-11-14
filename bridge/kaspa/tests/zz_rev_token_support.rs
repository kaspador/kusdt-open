//! Shared harness of the token review (r16/rev-token). Not a test by itself: the
//! `zz_rev_token_*.rs` files include it with `#[path]`.
//!
//! Everything here drives the CHECKED-IN artifact (`artifacts/kusdt.json`, the bytes
//! that will be deployed) through the real script engine. A case is a list of inputs
//! and outputs; token inputs are fabricated UTXOs (the script of a state, a covenant ID
//! of the test's choosing), which is exactly what a node holds for a state.
#![allow(dead_code)]

use std::cell::Cell;
use std::collections::BTreeMap;

use argent_runtime::{ArtifactBundle, ArtifactValue, BuilderError, EntryCall, TxBuilder, TxContext, args, execute_transaction_with_covenants, state};
use kaspa_consensus_core::{
    Hash,
    hashing::{
        sighash::{SigHashReusedValuesUnsync, calc_ecdsa_signature_hash, calc_schnorr_signature_hash},
        sighash_type::{SIG_HASH_ALL, SigHashType},
    },
    tx::{CovenantBinding, MutableTransaction, ScriptPublicKey, Transaction, TransactionId, TransactionOutpoint, UtxoEntry},
};
use secp256k1::{Keypair, Message, Secp256k1, SecretKey};

pub type State = BTreeMap<String, ArtifactValue>;

/// kUSDT's covenant ID in these tests, another token's (same script), and the pool's.
pub const K: [u8; 32] = [0x11; 32];
pub const K2: [u8; 32] = [0x77; 32];
pub const POOL: [u8; 32] = [0x22; 32];
pub const TOKEN_SOMPI: u64 = 150_000_000;

pub fn builder() -> TxBuilder<'static> {
    TxBuilder::new(kusdt_kaspa::tx::artifact()).expect("the checked-in artifact builds")
}

pub fn pool_builder() -> TxBuilder<'static> {
    let bundle = ArtifactBundle::new(kusdt_kaspa::pool::pool_artifact()).unwrap().with_artifact(kusdt_kaspa::tx::artifact()).unwrap();
    TxBuilder::from_bundle(&bundle).expect("bundle builder")
}

pub fn key(seed: u8) -> Keypair {
    Keypair::from_secret_key(&Secp256k1::new(), &SecretKey::from_slice(&[seed; 32]).expect("valid test seed"))
}

pub fn xonly(key: &Keypair) -> [u8; 32] {
    key.x_only_public_key().0.serialize()
}

pub fn compressed(key: &Keypair) -> [u8; 33] {
    key.public_key().serialize()
}

pub fn blake3_of(bytes: &[u8]) -> [u8; 32] {
    *blake3::hash(bytes).as_bytes()
}

pub fn outpoint(seed: u8, index: u32) -> TransactionOutpoint {
    TransactionOutpoint::new(TransactionId::from_bytes([seed; 32]), index)
}

/// A plain coin anyone can spend (OP_TRUE), so the tests stay about the covenants.
pub fn funding() -> UtxoEntry {
    UtxoEntry::new(100_000_000_000, ScriptPublicKey::from_vec(0, vec![0x51]), 1, false, None)
}

/// A P2SH coin of `redeem`, and the signature script that reveals it after `before`.
pub fn p2sh_coin(redeem: &[u8]) -> UtxoEntry {
    UtxoEntry::new(1_000_000_000, kaspa_txscript::pay_to_script_hash_script(redeem), 1, false, None)
}

pub fn script_hash(redeem: &[u8]) -> [u8; 32] {
    let spk = kaspa_txscript::pay_to_script_hash_script(redeem);
    let s = spk.script();
    assert!(s.len() == 35 && s[0] == 0xaa && s[1] == 0x20 && s[34] == 0x87, "a P2SH script");
    s[2..34].try_into().unwrap()
}

pub fn sign_schnorr(tx: &MutableTransaction<Transaction>, index: usize, key: &Keypair, hash_type: SigHashType) -> Vec<u8> {
    let digest = calc_schnorr_signature_hash(&tx.as_verifiable(), index, hash_type, &SigHashReusedValuesUnsync::new());
    // No auxiliary randomness: the same transaction gives the same bytes, so the decoder fixtures are reproducible.
    let mut out = Secp256k1::new().sign_schnorr_no_aux_rand(&Message::from_digest(digest.as_bytes()), key).as_ref().to_vec();
    out.push(hash_type.to_u8());
    out
}

pub fn sign_ecdsa(tx: &MutableTransaction<Transaction>, index: usize, key: &Keypair, hash_type: SigHashType) -> Vec<u8> {
    let digest = calc_ecdsa_signature_hash(&tx.as_verifiable(), index, hash_type, &SigHashReusedValuesUnsync::new());
    let sig = Secp256k1::new().sign_ecdsa(&Message::from_digest(digest.as_bytes()), &key.secret_key());
    let mut out = sig.serialize_compact().to_vec();
    out.push(hash_type.to_u8());
    out
}

/// A KCC-20 state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tok {
    pub amount: i64,
    pub owner: [u8; 32],
    pub scheme: u8,
    pub borrow: u8,
    pub guard: [u8; 32],
    pub ext: [u8; 32],
}

impl Tok {
    pub fn new(scheme: u8, owner: [u8; 32], amount: i64) -> Self {
        Self { amount, owner, scheme, borrow: 0, guard: [0; 32], ext: [0; 32] }
    }
    pub fn schnorr(key: &Keypair, amount: i64) -> Self {
        Self::new(0x00, xonly(key), amount)
    }
    pub fn amount(mut self, amount: i64) -> Self {
        self.amount = amount;
        self
    }
    pub fn borrow(mut self, scheme: u8, guard: [u8; 32]) -> Self {
        self.borrow = scheme;
        self.guard = guard;
        self
    }
    pub fn ext(mut self, ext: [u8; 32]) -> Self {
        self.ext = ext;
        self
    }
    pub fn state(&self) -> State {
        state! {
            amount: self.amount,
            owner: self.owner.to_vec(),
            owner_scheme: self.scheme,
            borrow_scheme: self.borrow,
            borrow_guard: self.guard.to_vec(),
            extension_commitment: self.ext.to_vec()
        }
    }
    /// The 112 bytes this state takes inside its program (the pushes the script commits to).
    pub fn encoded(&self) -> Vec<u8> {
        let mut s = vec![0x08];
        let mut magnitude = self.amount.unsigned_abs().to_le_bytes();
        if self.amount < 0 {
            magnitude[7] |= 0x80;
        }
        s.extend_from_slice(&magnitude);
        s.push(0x20);
        s.extend_from_slice(&self.owner);
        s.extend_from_slice(&[0x01, self.scheme, 0x01, self.borrow, 0x20]);
        s.extend_from_slice(&self.guard);
        s.push(0x20);
        s.extend_from_slice(&self.ext);
        s
    }
    pub fn utxo(&self, cov: [u8; 32], value: u64) -> UtxoEntry {
        builder().covenant_utxo("KCC20", self.state(), value, 0, false, Some(Hash::from_bytes(cov))).expect("a KCC20 script")
    }
    pub fn spk(&self) -> ScriptPublicKey {
        self.utxo(K, 0).script_public_key
    }
}

/// How an input proves its owner (the bytes after the leader's path byte, or a delegate's whole witness).
#[derive(Clone)]
pub enum Auth {
    /// p2pk-schnorr: a 65-byte signature with this sighash type.
    Schnorr(Keypair, u8),
    /// A signature made for ANOTHER input index of the same transaction.
    SchnorrFor(Keypair, usize),
    /// p2pkh-schnorr: key ‖ signature.
    PkhSchnorr(Keypair),
    /// p2pkh-ecdsa: compressed key ‖ signature.
    PkhEcdsa(Keypair),
    /// Literal bytes: a p2sh authority index, nothing for a covenant owner, or garbage.
    Raw(Vec<u8>),
    /// The hash-chain borrow witness: next guard ‖ one-time key ‖ that key's signature.
    Chain([u8; 32], Keypair),
}

impl Auth {
    pub fn key(key: &Keypair) -> Self {
        Self::Schnorr(*key, SIG_HASH_ALL.to_u8())
    }
    pub fn none() -> Self {
        Self::Raw(Vec::new())
    }
    pub fn witness(&self, tx: &MutableTransaction<Transaction>, index: usize) -> Vec<u8> {
        match self {
            Self::Schnorr(key, t) => sign_schnorr(tx, index, key, SigHashType::from_u8(*t).expect("a sighash type")),
            Self::SchnorrFor(key, other) => sign_schnorr(tx, *other, key, SIG_HASH_ALL),
            Self::PkhSchnorr(key) => [xonly(key).to_vec(), sign_schnorr(tx, index, key, SIG_HASH_ALL)].concat(),
            Self::PkhEcdsa(key) => [compressed(key).to_vec(), sign_ecdsa(tx, index, key, SIG_HASH_ALL)].concat(),
            Self::Raw(bytes) => bytes.clone(),
            Self::Chain(next_guard, key) => [next_guard.to_vec(), xonly(key).to_vec(), sign_schnorr(tx, index, key, SIG_HASH_ALL)].concat(),
        }
    }
}

#[derive(Clone)]
pub struct TokIn {
    /// The state the input claims (its program is built from it).
    pub tok: Tok,
    /// The state the coin really holds, when the claim lies.
    pub held: Option<Tok>,
    pub cov: [u8; 32],
    pub auth: Auth,
    pub value: u64,
}

impl TokIn {
    pub fn new(tok: Tok, auth: Auth) -> Self {
        Self { tok, held: None, cov: K, auth, value: TOKEN_SOMPI }
    }
    pub fn of(key: &Keypair, amount: i64) -> Self {
        Self::new(Tok::schnorr(key, amount), Auth::key(key))
    }
    pub fn cov(mut self, cov: [u8; 32]) -> Self {
        self.cov = cov;
        self
    }
    pub fn held(mut self, held: Tok) -> Self {
        self.held = Some(held);
        self
    }
    pub fn value(mut self, value: u64) -> Self {
        self.value = value;
        self
    }
    pub fn utxo(&self) -> UtxoEntry {
        self.held.as_ref().unwrap_or(&self.tok).utxo(self.cov, self.value)
    }
}

#[derive(Clone)]
pub enum Slot {
    /// `transfer(next, path ‖ auth)`.
    Leader { input: TokIn, path: Vec<u8>, next: Vec<Tok> },
    /// `transfer_delegator(auth)`.
    Delegate(TokIn),
    /// Any other coin, with its signature script.
    Plain { entry: UtxoEntry, sig: Vec<u8> },
}

impl Slot {
    pub fn leader(input: TokIn, next: &[Tok]) -> Self {
        Self::Leader { input, path: vec![0x00], next: next.to_vec() }
    }
    pub fn funding() -> Self {
        Self::Plain { entry: funding(), sig: Vec::new() }
    }
}

#[derive(Clone)]
pub enum Out {
    Tok { tok: Tok, cov: [u8; 32], by: u16, value: u64 },
    Spk { spk: ScriptPublicKey, bind: Option<(u16, [u8; 32])>, value: u64 },
}

impl Out {
    /// A kUSDT state authorized by input 0.
    pub fn tok(tok: &Tok) -> Self {
        Self::Tok { tok: tok.clone(), cov: K, by: 0, value: TOKEN_SOMPI }
    }
    pub fn by(mut self, input: u16) -> Self {
        if let Self::Tok { by, .. } = &mut self {
            *by = input;
        }
        self
    }
    pub fn cov(mut self, id: [u8; 32]) -> Self {
        if let Self::Tok { cov, .. } = &mut self {
            *cov = id;
        }
        self
    }
    pub fn value(mut self, v: u64) -> Self {
        match &mut self {
            Self::Tok { value, .. } | Self::Spk { value, .. } => *value = v,
        }
        self
    }
    pub fn plain() -> Self {
        Self::Spk { spk: ScriptPublicKey::from_vec(0, vec![0x51]), bind: None, value: 50_000_000 }
    }
}

#[derive(Clone, Default)]
pub struct Case {
    pub slots: Vec<Slot>,
    pub outs: Vec<Out>,
    pub payload: Vec<u8>,
}

#[derive(Debug)]
pub enum Rejected {
    /// The runtime could not build the transaction: NOT a proof of anything.
    Build(String),
    /// The script engine (or consensus' covenant rules, which run before it) rejected it.
    Script(String),
}

pub fn classify(error: BuilderError) -> Rejected {
    match error {
        BuilderError::InputScript { .. } | BuilderError::TxScript(_) => Rejected::Script(error.to_string()),
        other => Rejected::Build(other.to_string()),
    }
}

/// Runs every input through the engine, as consensus does (and the relay sig-op scan).
pub fn run(tx: Transaction, utxos: Vec<UtxoEntry>) -> Result<Transaction, Rejected> {
    for (i, (input, entry)) in tx.inputs.iter().zip(&utxos).enumerate() {
        let sig_ops = kaspa_txscript::post_toccata_p2sh_sig_scanner(&input.signature_script, &entry.script_public_key);
        assert!(sig_ops <= 15, "input {i} has {sig_ops} signature operations; nodes relay at most 15");
    }
    let mut executed = tx.clone();
    execute_transaction_with_covenants(&mut executed, utxos).map_err(classify)?;
    Ok(tx)
}

impl Case {
    pub fn new(slots: Vec<Slot>, outs: Vec<Out>) -> Self {
        Self { slots, outs, payload: Vec::new() }
    }

    /// One leader (input 0) with these delegates, a funding coin, and the leader's next states as the outputs.
    pub fn transfer(leader: TokIn, delegates: Vec<TokIn>, next: &[Tok]) -> Self {
        let mut slots = vec![Slot::leader(leader, next)];
        slots.extend(delegates.into_iter().map(Slot::Delegate));
        slots.push(Slot::funding());
        Self::new(slots, next.iter().map(Out::tok).collect())
    }

    pub fn entries(&self) -> Vec<UtxoEntry> {
        self.slots
            .iter()
            .map(|s| match s {
                Slot::Leader { input, .. } | Slot::Delegate(input) => input.utxo(),
                Slot::Plain { entry, .. } => entry.clone(),
            })
            .collect()
    }

    /// Builds the transaction (the builder runs each input's script as it goes) and runs it whole.
    pub fn build(&self) -> Result<(Transaction, Vec<UtxoEntry>), Rejected> {
        let b = builder();
        let entries = self.entries();
        let mut ctx = TxContext::new().payload(self.payload.clone());
        for (i, slot) in self.slots.iter().enumerate() {
            let at = outpoint(0xa0 + i as u8, i as u32);
            ctx = match slot {
                Slot::Leader { input, path, next } => {
                    let (auth, path) = (input.auth.clone(), path.clone());
                    let next: Vec<State> = next.iter().map(Tok::state).collect();
                    let call = EntryCall::new("transfer").args_with(move |tx, index| {
                        let mut witness = path.clone();
                        witness.extend(auth.witness(tx, index));
                        args!(next.clone(), witness)
                    });
                    ctx.actor_input("KCC20", input.tok.state(), call, at, entries[i].clone(), 0)
                }
                Slot::Delegate(input) => {
                    let auth = input.auth.clone();
                    let call = EntryCall::new("transfer_delegator").args_with(move |tx, index| args!(auth.witness(tx, index)));
                    ctx.actor_input("KCC20", input.tok.state(), call, at, entries[i].clone(), 0)
                }
                Slot::Plain { entry, sig } => ctx.input(at, entry.clone(), sig.clone(), 0),
            };
        }
        for out in &self.outs {
            ctx = match out {
                Out::Tok { tok, cov, by, value } => ctx.actor_output("KCC20", tok.state(), CovenantBinding::new(*by, Hash::from_bytes(*cov)), *value),
                Out::Spk { spk, bind, value } => ctx.output(spk.clone(), bind.map(|(by, id)| CovenantBinding::new(by, Hash::from_bytes(id))), *value),
            };
        }
        let tx = b.build(&ctx).map_err(classify)?;
        let tx = run(tx, entries.clone())?;
        Ok((tx, entries))
    }

    pub fn accepted(&self, what: &str) -> (Transaction, Vec<UtxoEntry>) {
        match self.build() {
            Ok(done) => {
                TALLY.with(|t| t.set((t.get().0 + 1, t.get().1)));
                done
            }
            Err(e) => panic!("CONTROL REFUSED ({what}): {e:?}"),
        }
    }

    /// Passes only when the ENGINE refused; a builder failure is a broken test, an acceptance a finding.
    #[track_caller]
    pub fn refused(&self, what: &str) {
        refused(self.build(), what)
    }
}

std::thread_local!(static TALLY: Cell<(u32, u32)> = const { Cell::new((0, 0)) });

#[track_caller]
pub fn refused<T>(result: Result<T, Rejected>, what: &str) {
    match result {
        Err(Rejected::Script(_)) => TALLY.with(|t| t.set((t.get().0, t.get().1 + 1))),
        Err(Rejected::Build(e)) => panic!("NOT AN ENGINE REFUSAL ({what}): the builder failed first: {e}"),
        Ok(_) => panic!("ACCEPTED, EXPECTED A REFUSAL ({what})"),
    }
}

pub fn count_control() {
    TALLY.with(|t| t.set((t.get().0 + 1, t.get().1)));
}

/// Prints and resets this thread's counts of accepted controls and engine refusals.
pub fn tally(property: &str) {
    let (controls, refusals) = TALLY.with(|t| t.replace((0, 0)));
    println!("REV-TOKEN {property}: {controls} controls accepted, {refusals} cases refused by the engine");
}

// -- Signature-script surgery (a transaction ID and every signature leave the signature scripts out) --

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

pub fn push_one(d: &[u8]) -> Vec<u8> {
    let mut s = Vec::new();
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
    s
}

pub fn push_script(items: &[Vec<u8>]) -> Vec<u8> {
    items.iter().flat_map(|d| push_one(d)).collect()
}

/// Rewrites one push of an input's signature script, leaving every signature as it was.
pub fn with_push(tx: &Transaction, input: usize, push: usize, value: Vec<u8>) -> Transaction {
    let mut forged = tx.clone();
    let mut items = pushes(&forged.inputs[input].signature_script);
    items[push] = value;
    forged.inputs[input].signature_script = push_script(&items);
    forged
}

/// A small deterministic generator (splitmix64), so every randomized run can be repeated from its seed.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    pub fn bytes<const N: usize>(&mut self) -> [u8; N] {
        let mut out = [0u8; N];
        for b in out.iter_mut() {
            *b = self.next() as u8;
        }
        out
    }
    pub fn vec(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.next() as u8).collect()
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
