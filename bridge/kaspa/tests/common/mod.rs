//! Shared harness for the VM tests: deterministic keys, a launched kUSDT
//! family, and builders for mint and governance transactions that can be bent
//! into each attack the tests try.
#![allow(dead_code)]

use std::cell::Cell;
use std::collections::BTreeMap;
use std::sync::OnceLock;

use argent::artifact::Artifact;
use argent_runtime::{
    ArtifactValue, BuilderError, CovenantOutput, EntryCall, InputSigScript, TxBuilder, TxContext, args,
    execute_transaction_with_covenants, state,
};
use kaspa_consensus_core::{
    Hash,
    hashing::{
        sighash::{SigHashReusedValuesUnsync, calc_schnorr_signature_hash},
        sighash_type::{SIG_HASH_ALL, SigHashType},
    },
    tx::{
        CovenantBinding, MutableTransaction, ScriptPublicKey, Transaction, TransactionId,
        TransactionOutpoint, UtxoEntry,
    },
};
use secp256k1::{Keypair, Message, Secp256k1, SecretKey};

pub type State = BTreeMap<String, ArtifactValue>;

pub const CHAIN_ETHEREUM: u8 = 0x01;
pub const CHAIN_BSC: u8 = 0x02;
/// 1 billion USDT in base units (10^-6).
pub const CAP: i64 = 1_000_000_000_000_000;
pub const GENESIS_DAA: i64 = 500_000_000;
pub const MINTER_SOMPI: u64 = 100_000_000;
pub const SEED_SOMPI: u64 = 100_000_000;
/// What every token output of the harness carries: the minter's floor for a minted output (MIN_MINTED_VALUE, 1 KAS).
pub const TOKEN_SOMPI: u64 = 100_000_000;

pub fn artifact() -> &'static Artifact {
    static ARTIFACT: OnceLock<Artifact> = OnceLock::new();
    ARTIFACT.get_or_init(|| {
        // One build directory per test binary: they run in parallel.
        let out = format!("test-{}", env!("CARGO_CRATE_NAME"));
        kusdt_kaspa::build_contract("kusdt.ag", &out).expect("kUSDT compiles")
    })
}

pub fn builder() -> TxBuilder<'static> {
    TxBuilder::new(artifact()).expect("builder")
}

pub fn key(seed: u8) -> Keypair {
    let secret = SecretKey::from_slice(&[seed; 32]).expect("valid test seed");
    Keypair::from_secret_key(&Secp256k1::new(), &secret)
}

pub fn xonly(key: &Keypair) -> [u8; 32] {
    key.x_only_public_key().0.serialize()
}

pub fn outpoint(seed: u8, index: u32) -> TransactionOutpoint {
    TransactionOutpoint::new(TransactionId::from_bytes([seed; 32]), index)
}

/// The key of the synthetic funding coin.
pub fn funding_key() -> Keypair {
    key(0xfd)
}

/// A plain Schnorr P2PK script: the only kind of plain coin a pool or minter transaction takes.
pub fn p2pk_spk(key: &Keypair) -> ScriptPublicKey {
    let mut script = vec![0x20];
    script.extend_from_slice(&xonly(key));
    script.push(0xac);
    ScriptPublicKey::from_vec(0, script)
}

/// Synthetic funding, already in a block: a P2PK coin of `funding_key`, spent with `funding_sig`.
pub fn funding() -> UtxoEntry {
    UtxoEntry::new(100_000_000_000, p2pk_spk(&funding_key()), 1, false, None)
}

/// SIGHASH_NONE | ANYONECANPAY: the funding coin signs only its own input, so a test that changes the
/// transaction after building it still fails, or passes, for the covenant's reason.
pub const FUNDING_SIG_HASH: u8 = 0x82;

/// The signature script of a `funding` input.
pub fn funding_sig<'a>() -> InputSigScript<'a> {
    InputSigScript::with_transaction(|tx, index| {
        let hash_type = SigHashType::from_u8(FUNDING_SIG_HASH).expect("a valid sighash type");
        let digest = calc_schnorr_signature_hash(&tx.as_verifiable(), index, hash_type, &SigHashReusedValuesUnsync::new());
        let signature = Secp256k1::new().sign_schnorr_no_aux_rand(&Message::from_digest(digest.as_bytes()), &funding_key());
        let mut script = vec![0x41];
        script.extend_from_slice(signature.as_ref());
        script.push(FUNDING_SIG_HASH);
        script
    })
}

/// A 64-byte Schnorr transaction signature followed by SIGHASH_ALL.
pub fn sign_input(tx: &MutableTransaction<Transaction>, input_index: usize, key: &Keypair) -> Vec<u8> {
    let digest = calc_schnorr_signature_hash(
        &tx.as_verifiable(),
        input_index,
        SIG_HASH_ALL,
        &SigHashReusedValuesUnsync::new(),
    );
    let mut witness = Secp256k1::new().sign_schnorr_no_aux_rand(&Message::from_digest(digest.as_bytes()), key).as_ref().to_vec();
    witness.push(SIG_HASH_ALL.to_u8());
    witness
}

/// A 64-byte Schnorr signature over a 32-byte digest (the `datasig` type). No auxiliary randomness: the same key
/// and digest give the same signature in every run, so what the tests write (the follower's corpus) does not change
/// from run to run.
pub fn sign_digest(key: &Keypair, digest: &[u8; 32]) -> Vec<u8> {
    Secp256k1::new().sign_schnorr_no_aux_rand(&Message::from_digest(*digest), key).as_ref().to_vec()
}

pub fn signer_set_of(keys: &[Keypair]) -> [u8; 32] {
    let mut packed = Vec::new();
    for k in keys {
        packed.extend_from_slice(&xonly(k));
    }
    *blake3::hash(&packed).as_bytes()
}

/// `x as byte[8]`: an eight-byte little-endian script number.
fn le8(x: i64) -> [u8; 8] {
    assert!(x >= 0, "digests only carry non-negative numbers");
    x.to_le_bytes()
}

pub fn mint_digest(covenant: &[u8; 32], chain: u8, first_nonce: i64, age_daa: i64, recipients: &[Recipient]) -> [u8; 32] {
    let mut message = b"kUSDT/mint/v2".to_vec();
    message.extend_from_slice(covenant);
    message.push(chain);
    message.extend_from_slice(&le8(first_nonce));
    message.extend_from_slice(&le8(age_daa));
    for r in recipients {
        message.push(r.owner_scheme);
        message.extend_from_slice(&r.owner);
        message.extend_from_slice(&le8(r.amount));
    }
    *blake3::hash(&message).as_bytes()
}

/// What the signers sign for a governance action: it names the age of the minter UTXO the spend claims (SPEC §6).
pub fn govern_digest(covenant: &[u8; 32], admin_nonce: i64, age_daa: i64, action: u8, params: &[u8]) -> [u8; 32] {
    let mut message = b"kUSDT/govern/v2".to_vec();
    message.extend_from_slice(covenant);
    message.extend_from_slice(&le8(admin_nonce));
    message.extend_from_slice(&le8(age_daa));
    message.push(action);
    message.extend_from_slice(params);
    *blake3::hash(&message).as_bytes()
}

/// What four signers sign to lift a pause: it names the paused minter coin and the age claimed (SPEC §6).
pub fn unpause_digest(covenant: &[u8; 32], admin_nonce: i64, age_daa: i64, minter: &TransactionOutpoint) -> [u8; 32] {
    let mut message = b"kUSDT/unpause/v2".to_vec();
    message.extend_from_slice(covenant);
    message.extend_from_slice(&le8(admin_nonce));
    message.extend_from_slice(&le8(age_daa));
    message.extend_from_slice(&minter.transaction_id.as_bytes());
    message.extend_from_slice(&le8(minter.index as i64));
    *blake3::hash(&message).as_bytes()
}

#[derive(Clone, Debug)]
pub struct Recipient {
    pub amount: i64,
    pub owner: [u8; 32],
    pub owner_scheme: u8,
    pub borrow_scheme: u8,
    pub borrow_guard: [u8; 32],
    pub extension_commitment: [u8; 32],
}

impl Recipient {
    pub fn schnorr(key: &Keypair, amount: i64) -> Self {
        Self::owned(xonly(key), amount)
    }

    pub fn owned(owner: [u8; 32], amount: i64) -> Self {
        Self {
            amount,
            owner,
            owner_scheme: 0x00,
            borrow_scheme: 0x00,
            borrow_guard: [0; 32],
            extension_commitment: [0; 32],
        }
    }

    pub fn state(&self) -> State {
        state! {
            amount: self.amount,
            owner: self.owner.to_vec(),
            owner_scheme: self.owner_scheme,
            borrow_scheme: self.borrow_scheme,
            borrow_guard: self.borrow_guard.to_vec(),
            extension_commitment: self.extension_commitment.to_vec()
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MinterState {
    pub remaining: i64,
    pub bucket: i64,
    pub capacity: i64,
    pub refill_per_daa: i64,
    pub nonce_ethereum: i64,
    pub nonce_bsc: i64,
    pub admin_nonce: i64,
    pub paused: bool,
    pub signer_set: [u8; 32],
    pub guardian: [u8; 32],
    pub recovery_delay: i64,
    pub recovery_nonce: i64,
    pub recovery_pending: bool,
    pub recovery_signer_set: [u8; 32],
    pub recovery_guardian: [u8; 32],
}

impl MinterState {
    pub fn state(&self) -> State {
        state! {
            remaining: self.remaining,
            bucket: self.bucket,
            capacity: self.capacity,
            refill_per_daa: self.refill_per_daa,
            nonce_ethereum: self.nonce_ethereum,
            nonce_bsc: self.nonce_bsc,
            admin_nonce: self.admin_nonce,
            paused: self.paused,
            signer_set: self.signer_set.to_vec(),
            guardian: self.guardian.to_vec(),
            extension_commitment: vec![0u8; 32],
            recovery_delay: self.recovery_delay,
            recovery_nonce: self.recovery_nonce,
            recovery_pending: self.recovery_pending,
            recovery_signer_set: self.recovery_signer_set.to_vec(),
            recovery_guardian: self.recovery_guardian.to_vec()
        }
    }
}

/// Mirrors the covenant's `refilled`.
pub fn refilled(bucket: i64, age_daa: i64, capacity: i64, refill_per_daa: i64) -> i64 {
    let mut filled = bucket as i128;
    if refill_per_daa > 0 && bucket < capacity {
        filled = (bucket as i128 + age_daa as i128 * refill_per_daa as i128).min(capacity as i128);
    }
    filled.min(capacity as i128) as i64
}

#[derive(Debug)]
pub enum Rejected {
    /// The runtime could not build the transaction.
    Build(String),
    /// The script engine rejected it.
    Script(String),
}

/// The builder runs every input script while it builds, so a script rejection
/// can come back from it as well as from `run`.
fn classify(error: BuilderError) -> Rejected {
    match error {
        BuilderError::InputScript { .. } | BuilderError::TxScript(_) => Rejected::Script(error.to_string()),
        other => Rejected::Build(other.to_string()),
    }
}

/// Asserts that consensus (the script engine) rejects the transaction.
#[track_caller]
pub fn rejects<T>(result: Result<T, Rejected>) {
    match result {
        Err(Rejected::Script(_)) => {}
        Err(Rejected::Build(e)) => panic!("expected a script rejection, the builder failed first: {e}"),
        Ok(_) => panic!("expected a script rejection, the transaction was accepted"),
    }
}

pub fn run(tx: Transaction, utxos: Vec<UtxoEntry>) -> Result<Transaction, Rejected> {
    // Relay policy: at most 15 signature operations per P2SH input, counted
    // statically over the whole redeem script.
    for (i, (input, entry)) in tx.inputs.iter().zip(&utxos).enumerate() {
        let sig_ops = kaspa_txscript::post_toccata_p2sh_sig_scanner(&input.signature_script, &entry.script_public_key);
        assert!(sig_ops <= 15, "input {i} has {sig_ops} signature operations; nodes relay at most 15");
    }
    let mut executed = tx.clone();
    execute_transaction_with_covenants(&mut executed, utxos).map_err(|e| Rejected::Script(e.to_string()))?;
    Ok(tx)
}

pub fn covenant_output(tx: &Transaction, index: u32) -> CovenantOutput {
    CovenantOutput::from_tx(tx, index).expect("covenant output")
}

fn bytes_array(items: impl IntoIterator<Item = Vec<u8>>) -> ArtifactValue {
    ArtifactValue::Array(items.into_iter().map(ArtifactValue::Bytes).collect())
}

fn keys_value(keys: &[Keypair]) -> ArtifactValue {
    bytes_array(keys.iter().map(|k| xonly(k).to_vec()))
}

/// One mint attempt, built from the harness state and bent by the setters.
#[derive(Clone)]
pub struct MintCase {
    pub chain: u8,
    pub first_nonce: i64,
    pub recipients: Vec<Recipient>,
    pub signers: Vec<usize>,
    /// The age of the minter UTXO the mint claims (default 1).
    pub age: Option<i64>,
    /// The minter input's sequence, when it differs from the claimed age.
    pub sequence: Option<u64>,
    /// The age the signers signed, when it differs from the one claimed.
    pub signed_age: Option<i64>,
    pub minter_value: Option<u64>,
    pub signed_recipients: Option<Vec<Recipient>>,
    pub signed_chain: Option<u8>,
    pub signed_covenant: Option<[u8; 32]>,
    pub foreign_keys: bool,
    pub tamper: Option<fn(&mut MinterState)>,
    /// The funding coin and where it is, when not a fresh `funding()` coin already in a block.
    pub funding: Option<(TransactionOutpoint, UtxoEntry)>,
}

impl MintCase {
    pub fn new(chain: u8, first_nonce: i64, recipients: &[Recipient]) -> Self {
        Self {
            chain,
            first_nonce,
            recipients: recipients.to_vec(),
            signers: vec![0, 1, 2],
            age: None,
            sequence: None,
            signed_age: None,
            minter_value: None,
            signed_recipients: None,
            signed_chain: None,
            signed_covenant: None,
            foreign_keys: false,
            tamper: None,
            funding: None,
        }
    }
    pub fn signers(mut self, signers: &[usize]) -> Self {
        self.signers = signers.to_vec();
        self
    }
    pub fn age(mut self, age: i64) -> Self {
        self.age = Some(age);
        self
    }
    pub fn signed_age(mut self, age: i64) -> Self {
        self.signed_age = Some(age);
        self
    }

    pub fn sequence(mut self, sequence: u64) -> Self {
        self.sequence = Some(sequence);
        self
    }
    pub fn minter_value(mut self, value: u64) -> Self {
        self.minter_value = Some(value);
        self
    }
    pub fn signed_recipients(mut self, recipients: &[Recipient]) -> Self {
        self.signed_recipients = Some(recipients.to_vec());
        self
    }
    pub fn signed_chain(mut self, chain: u8) -> Self {
        self.signed_chain = Some(chain);
        self
    }
    pub fn signed_covenant(mut self, covenant: [u8; 32]) -> Self {
        self.signed_covenant = Some(covenant);
        self
    }
    pub fn foreign_keys(mut self) -> Self {
        self.foreign_keys = true;
        self
    }
    pub fn tamper(mut self, tamper: fn(&mut MinterState)) -> Self {
        self.tamper = Some(tamper);
        self
    }
    /// Funds the mint with this coin (a `funding_key` P2PK coin, spent with `funding_sig`).
    pub fn funded_by(mut self, outpoint: TransactionOutpoint, entry: UtxoEntry) -> Self {
        self.funding = Some((outpoint, entry));
        self
    }
}

#[derive(Clone)]
pub enum Govern {
    Unpause,
    SetLimits { capacity: i64, refill_per_daa: i64 },
    SetSigners { keys: Vec<Keypair>, guardian: Keypair },
    SkipNonce { chain: u8, nonce: i64 },
    SetValue { value: u64 },
    ProposeRecovery { keys: Vec<Keypair>, guardian: Keypair },
    VetoRecovery,
}

pub struct Harness {
    pub signers: Vec<Keypair>,
    pub guardian: Keypair,
    pub state: MinterState,
    pub minter: CovenantOutput,
    pub seed: CovenantOutput,
    funding_index: Cell<u32>,
}

impl Harness {
    pub fn launch() -> Self {
        Self::launch_with(|_| {})
    }

    pub fn launch_with(configure: impl FnOnce(&mut MinterState)) -> Self {
        let signers: Vec<Keypair> = (0x10..0x15).map(key).collect();
        let guardian = key(0x20);
        let mut state = MinterState {
            remaining: CAP,
            bucket: 500_000_000_000,
            capacity: 500_000_000_000,
            refill_per_daa: 578_703,
            nonce_ethereum: 0,
            nonce_bsc: 0,
            admin_nonce: 0,
            paused: false,
            signer_set: signer_set_of(&signers),
            guardian: xonly(&guardian),
            recovery_delay: 2_592_000,
            recovery_nonce: 0,
            recovery_pending: false,
            recovery_signer_set: [0; 32],
            recovery_guardian: [0; 32],
        };
        configure(&mut state);
        let seed_state = state! {
            owner: xonly(&guardian).to_vec(),
            extension_commitment: vec![0u8; 32]
        };
        let launch = builder()
            .build(
                &TxContext::new()
                    .input(outpoint(0xf0, 0), funding(), funding_sig(), 0)
                    .actor_genesis_output(0, "launch::kusdt", "BridgeMint", state.state(), MINTER_SOMPI)
                    .actor_genesis_output(0, "launch::kusdt", "TokenSeed", seed_state, SEED_SOMPI),
            )
            .expect("genesis builds");
        let launch = run(launch, vec![funding()]).expect("genesis runs");
        Self {
            signers,
            guardian,
            state,
            minter: covenant_output(&launch, 0),
            seed: covenant_output(&launch, 1),
            funding_index: Cell::new(0),
        }
    }

    fn next_funding(&self) -> TransactionOutpoint {
        let index = self.funding_index.get();
        self.funding_index.set(index + 1);
        outpoint(0xf1, index)
    }

    fn covenant(&self) -> [u8; 32] {
        self.minter.covenant_id.as_bytes()
    }

    fn quorum_args(&self, keys: &[Keypair], indices: &[usize], digest: &[u8; 32]) -> (ArtifactValue, Vec<u8>, ArtifactValue) {
        let signatures = indices.iter().map(|&i| sign_digest(keys.get(i).unwrap_or(&keys[0]), digest));
        (
            keys_value(keys),
            indices.iter().map(|&i| i as u8).collect(),
            bytes_array(signatures),
        )
    }

    pub fn try_mint(&self, case: MintCase) -> Result<(Transaction, MinterState), Rejected> {
        let age = case.age.unwrap_or(1);
        let sequence = case.sequence.unwrap_or(age.max(0) as u64);
        let total: i64 = case.recipients.iter().map(|r| r.amount).sum();
        let available = refilled(self.state.bucket, age, self.state.capacity, self.state.refill_per_daa);

        let mut next = self.state.clone();
        next.remaining -= total;
        next.bucket = available - total;
        match case.chain {
            CHAIN_ETHEREUM => next.nonce_ethereum = case.first_nonce + case.recipients.len() as i64,
            CHAIN_BSC => next.nonce_bsc = case.first_nonce + case.recipients.len() as i64,
            _ => {}
        }
        if let Some(tamper) = case.tamper {
            tamper(&mut next);
        }

        let digest = mint_digest(
            &case.signed_covenant.unwrap_or(self.covenant()),
            case.signed_chain.unwrap_or(case.chain),
            case.first_nonce,
            case.signed_age.unwrap_or(age),
            case.signed_recipients.as_ref().unwrap_or(&case.recipients),
        );
        let keys: Vec<Keypair> = if case.foreign_keys {
            (0x40..0x45).map(key).collect()
        } else {
            self.signers.clone()
        };
        let (keys, indices, signatures) = self.quorum_args(&keys, &case.signers, &digest);
        let recipient_states: Vec<State> = case.recipients.iter().map(Recipient::state).collect();
        let call = EntryCall::new("mint").args(args!(
            case.chain,
            case.first_nonce,
            age,
            recipient_states,
            keys,
            indices,
            signatures
        ));

        let covenant = self.minter.covenant_id;
        let (funding_at, funding_entry) = case.funding.clone().unwrap_or_else(|| (self.next_funding(), funding()));
        let mut context = TxContext::new()
            .actor_input("BridgeMint", self.state.state(), call, self.minter.outpoint, self.minter.utxo.clone(), sequence)
            .input(funding_at, funding_entry.clone(), funding_sig(), 0)
            .actor_output(
                "BridgeMint",
                next.state(),
                CovenantBinding::new(0, covenant),
                case.minter_value.unwrap_or(self.minter.utxo.amount),
            );
        for r in &case.recipients {
            context = context.actor_output("KCC20", r.state(), CovenantBinding::new(0, covenant), TOKEN_SOMPI);
        }
        let tx = builder().build(&context).map_err(classify)?;
        let tx = run(tx, vec![self.minter.utxo.clone(), funding_entry])?;
        Ok((tx, next))
    }

    pub fn mint(&mut self, chain: u8, first_nonce: i64, recipients: &[Recipient], signers: &[usize]) -> Result<Transaction, Rejected> {
        self.apply(MintCase::new(chain, first_nonce, recipients).signers(signers))
    }

    /// A mint claiming the minter UTXO is `age` DAA old.
    pub fn mint_at(&mut self, chain: u8, first_nonce: i64, recipients: &[Recipient], signers: &[usize], age: i64) -> Result<Transaction, Rejected> {
        self.apply(MintCase::new(chain, first_nonce, recipients).signers(signers).age(age))
    }

    fn apply(&mut self, case: MintCase) -> Result<Transaction, Rejected> {
        let (tx, next) = self.try_mint(case)?;
        self.state = next;
        self.minter = covenant_output(&tx, 0);
        Ok(tx)
    }

    pub fn try_pause(&self, by: &Keypair) -> Result<(Transaction, MinterState), Rejected> {
        let mut next = self.state.clone();
        next.paused = true;
        next.admin_nonce += 1; // a pause voids every 4-of-5 signature made before it
        let signer = *by;
        let call = EntryCall::new("pause").args_with(move |tx, index| args!(sign_input(tx, index, &signer)));
        let context = TxContext::new()
            .actor_input("BridgeMint", self.state.state(), call, self.minter.outpoint, self.minter.utxo.clone(), 0)
            .actor_output(
                "BridgeMint",
                next.state(),
                CovenantBinding::new(0, self.minter.covenant_id),
                self.minter.utxo.amount,
            );
        let tx = builder().build(&context).map_err(classify)?;
        let tx = run(tx, vec![self.minter.utxo.clone()])?;
        Ok((tx, next))
    }

    pub fn pause(&mut self) -> Result<Transaction, Rejected> {
        let guardian = self.guardian;
        let (tx, next) = self.try_pause(&guardian)?;
        self.state = next;
        self.minter = covenant_output(&tx, 0);
        Ok(tx)
    }

    pub fn try_govern(&self, action: Govern, signers: &[usize]) -> Result<(Transaction, MinterState), Rejected> {
        let nonce = if matches!(action, Govern::ProposeRecovery { .. } | Govern::VetoRecovery) { self.state.recovery_nonce } else { self.state.admin_nonce };
        self.try_govern_signed_at(action, signers, nonce)
    }

    pub fn try_govern_signed_at(&self, action: Govern, signers: &[usize], signed_nonce: i64) -> Result<(Transaction, MinterState), Rejected> {
        let mut next = self.state.clone();
        if !matches!(action, Govern::ProposeRecovery { .. } | Govern::VetoRecovery) {
            next.admin_nonce += 1;
        }
        let age = 1i64;
        // Every action settles the allowance: the spend restarts the UTXO's age.
        next.bucket = refilled(self.state.bucket, age, self.state.capacity, self.state.refill_per_daa);
        let mut minter_value = self.minter.utxo.amount;
        let (code, params) = match &action {
            Govern::Unpause => {
                next.paused = false;
                (0x01, Vec::new())
            }
            Govern::SetLimits { capacity, refill_per_daa } => {
                next.bucket = next.bucket.min(*capacity);
                next.capacity = *capacity;
                next.refill_per_daa = *refill_per_daa;
                let mut params = le8(*capacity).to_vec();
                params.extend_from_slice(&le8(*refill_per_daa));
                (0x02, params)
            }
            Govern::SetSigners { keys, guardian } => {
                next.signer_set = signer_set_of(keys);
                next.guardian = xonly(guardian);
                next.recovery_nonce += 1;
                next.recovery_pending = false;
                next.recovery_signer_set = [0; 32];
                next.recovery_guardian = [0; 32];
                let mut params = next.signer_set.to_vec();
                params.extend_from_slice(&next.guardian);
                (0x03, params)
            }
            Govern::ProposeRecovery { keys, guardian } => {
                next.recovery_nonce += 1;
                next.recovery_pending = true;
                next.recovery_signer_set = signer_set_of(keys);
                next.recovery_guardian = xonly(guardian);
                let mut params = next.recovery_signer_set.to_vec();
                params.extend_from_slice(&next.recovery_guardian);
                (0x06, params)
            }
            Govern::VetoRecovery => {
                next.recovery_nonce += 1;
                next.recovery_pending = false;
                next.recovery_signer_set = [0; 32];
                next.recovery_guardian = [0; 32];
                (0x07, Vec::new())
            }
            Govern::SkipNonce { chain, nonce } => {
                match *chain {
                    CHAIN_ETHEREUM => next.nonce_ethereum = nonce + 1,
                    CHAIN_BSC => next.nonce_bsc = nonce + 1,
                    _ => {}
                }
                let mut params = vec![*chain];
                params.extend_from_slice(&le8(*nonce));
                (0x04, params)
            }
            Govern::SetValue { value } => {
                minter_value = *value;
                (0x05, le8(*value as i64).to_vec())
            }
        };
        // An unpause signs the paused coin itself; every other action signs the govern message.
        let digest = if code == 0x01 { unpause_digest(&self.covenant(), signed_nonce, age, &self.minter.outpoint) } else { govern_digest(&self.covenant(), signed_nonce, age, code, &params) };
        let (keys, indices, signatures) = self.quorum_args(&self.signers, signers, &digest);
        let call = EntryCall::new("govern").args(args!(code, params.clone(), age, keys, indices, signatures));
        let context = TxContext::new()
            .actor_input("BridgeMint", self.state.state(), call, self.minter.outpoint, self.minter.utxo.clone(), age as u64)
            .input(self.next_funding(), funding(), funding_sig(), 0)
            .actor_output("BridgeMint", next.state(), CovenantBinding::new(0, self.minter.covenant_id), minter_value);
        let tx = builder().build(&context).map_err(classify)?;
        let tx = run(tx, vec![self.minter.utxo.clone(), funding()])?;
        Ok((tx, next))
    }

    pub fn govern(&mut self, action: Govern, signers: &[usize]) -> Result<Transaction, Rejected> {
        let (tx, next) = self.try_govern(action, signers)?;
        self.state = next;
        self.minter = covenant_output(&tx, 0);
        Ok(tx)
    }

    /// The covenant's `execute_recovery`, with `sequence` as the minter input's relative lock.
    pub fn try_execute_recovery(&self, sequence: u64, tamper: impl FnOnce(&mut MinterState)) -> Result<(Transaction, MinterState), Rejected> {
        let mut next = self.state.clone();
        next.signer_set = self.state.recovery_signer_set;
        next.guardian = self.state.recovery_guardian;
        next.admin_nonce += 1;
        next.recovery_nonce += 1;
        next.recovery_pending = false;
        next.recovery_signer_set = [0; 32];
        next.recovery_guardian = [0; 32];
        tamper(&mut next);
        let context = TxContext::new()
            .actor_input("BridgeMint", self.state.state(), EntryCall::new("execute_recovery"), self.minter.outpoint, self.minter.utxo.clone(), sequence)
            .input(self.next_funding(), funding(), funding_sig(), 0)
            .actor_output("BridgeMint", next.state(), CovenantBinding::new(0, self.minter.covenant_id), self.minter.utxo.amount);
        let tx = builder().build(&context).map_err(classify)?;
        let tx = run(tx, vec![self.minter.utxo.clone(), funding()])?;
        Ok((tx, next))
    }

    pub fn execute_recovery(&mut self, sequence: u64) -> Result<Transaction, Rejected> {
        let (tx, next) = self.try_execute_recovery(sequence, |_| {})?;
        self.state = next;
        self.minter = covenant_output(&tx, 0);
        Ok(tx)
    }
}

/// A standard KCC-20 transfer of `token` (owned by `owner` through
/// p2pk-schnorr) into new states of the given owners and amounts.
pub fn transfer(token: &CovenantOutput, owner: &Keypair, amount: i64, to: &[([u8; 32], i64)]) -> Result<Transaction, Rejected> {
    let before = Recipient::schnorr(owner, amount).state();
    let next: Vec<State> = to.iter().map(|(o, a)| Recipient::owned(*o, *a).state()).collect();
    let next_for_call = next.clone();
    let owner = *owner;
    let call = EntryCall::new("transfer").args_with(move |tx, index| {
        let mut witness = vec![0x00];
        witness.extend(sign_input(tx, index, &owner));
        args!(next_for_call.clone(), witness)
    });
    let mut context = TxContext::new()
        .actor_input("KCC20", before, call, token.outpoint, token.utxo.clone(), 0)
        .input(outpoint(0xf2, 0), funding(), funding_sig(), 0);
    for s in next {
        context = context.actor_output("KCC20", s, CovenantBinding::new(0, token.covenant_id), TOKEN_SOMPI);
    }
    let tx = builder().build(&context).map_err(classify)?;
    run(tx, vec![token.utxo.clone(), funding()])
}

pub fn covenant_hash(bytes: [u8; 32]) -> Hash {
    Hash::from_bytes(bytes)
}
