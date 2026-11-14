//! Consensus facts the off-chain followers must respect (found by the security
//! review, 2026-11-04; the followers now match outputs by covenant binding):
//!
//! 1. A covenant transition may also carry a decoy: a plain output (no covenant
//!    binding) whose scriptPublicKey is byte-for-byte the successor's, even
//!    before it. The covenants find their successors through OpAuthOutputIdx /
//!    OpCovOutputIdx, which skip unbound outputs, so the transaction is valid. A
//!    follower must take the input's authorized outputs in the family, never the
//!    first output with the script (protocol/src/decoys.test.ts).
//! 2. A pool-owned kUSDT state that is not the reserve (anyone can send kUSDT to
//!    owner scheme 0x04 = the pool's covenant ID) can pay a `sell`, by anyone:
//!    the Pool input's presence satisfies its owner. The pool follower must
//!    accept such a payer.

mod common;

use std::sync::OnceLock;

use argent::artifact::Artifact;
use argent_runtime::{ArtifactBundle, ArtifactValue, EntryCall, TxBuilder, TxContext, args, state};
use common::{
    CHAIN_ETHEREUM, Harness, Recipient, State, TOKEN_SOMPI, funding, funding_sig, key, mint_digest, outpoint, refilled, sign_digest, xonly,
};
use kaspa_consensus_core::{Hash, tx::CovenantBinding};

fn bytes_array(items: impl IntoIterator<Item = Vec<u8>>) -> ArtifactValue {
    ArtifactValue::Array(items.into_iter().map(ArtifactValue::Bytes).collect())
}

#[test]
fn a_mint_may_carry_a_decoy_of_its_successor() {
    let h = Harness::launch();
    let alice = key(0xa0);
    let recipients = vec![Recipient::schnorr(&alice, 1_000_000)];
    let s = &h.state;
    let age = 1i64;
    let total: i64 = recipients.iter().map(|r| r.amount).sum();
    let available = refilled(s.bucket, age, s.capacity, s.refill_per_daa);
    let mut next = s.clone();
    next.remaining -= total;
    next.bucket = available - total;
    next.nonce_ethereum = 1;

    let covenant = h.minter.covenant_id;
    let digest = mint_digest(&covenant.as_bytes(), CHAIN_ETHEREUM, 0, age, &recipients);
    let signers = [0usize, 1, 2];
    let keys = bytes_array(h.signers.iter().map(|k| xonly(k).to_vec()));
    let indices: Vec<u8> = signers.iter().map(|&i| i as u8).collect();
    let signatures = bytes_array(signers.iter().map(|&i| sign_digest(&h.signers[i], &digest)));
    let recipient_states: Vec<State> = recipients.iter().map(Recipient::state).collect();
    let call = EntryCall::new("mint").args(args!(CHAIN_ETHEREUM, 0i64, age, recipient_states, keys, indices, signatures));

    // The decoy: a plain P2SH output paying to the successor's own script.
    let successor_spk = common::builder()
        .covenant_utxo("BridgeMint", next.state(), h.minter.utxo.amount, 0, false, Some(covenant))
        .expect("successor script")
        .script_public_key;

    let ctx = TxContext::new()
        .actor_input("BridgeMint", s.state(), call, h.minter.outpoint, h.minter.utxo.clone(), age as u64)
        .input(outpoint(0xf1, 77), funding(), funding_sig(), 0)
        .output(successor_spk.clone(), None, 100_000_000)
        .actor_output("BridgeMint", next.state(), CovenantBinding::new(0, covenant), h.minter.utxo.amount)
        .actor_output("KCC20", recipients[0].state(), CovenantBinding::new(0, covenant), TOKEN_SOMPI);
    let tx = common::builder().build(&ctx).expect("builds");
    let tx = common::run(tx, vec![h.minter.utxo.clone(), funding()]).expect("the covenant accepts a decoy before its successor");

    assert!(tx.outputs[0].covenant.is_none(), "output 0 is a plain output");
    assert_eq!(tx.outputs[0].script_public_key, tx.outputs[1].script_public_key, "with the successor's script");
    assert_eq!(tx.outputs[1].covenant.map(|c| c.covenant_id), Some(covenant), "output 1 is the real successor");
    println!("AUDIT decoy mint accepted: output 0 (plain) and output 1 (BridgeMint) share script {}", hex(successor_spk.script()));
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().take(12).map(|b| format!("{b:02x}")).collect::<String>() + "…"
}

// ---------------------------------------------------------------------------
// KasPool, with the same shapes as tests/pool.rs.

const BPS: i128 = 10_000;
const PROTOCOL_BPS: i128 = 5;
const FEE_BPS: i128 = 50;
const MIN_LIQUIDITY: i64 = 1_000;
const KAS: i64 = 100_000_000;
const USDT: i64 = 1_000_000;
const BASE: i64 = KAS;
const POSITION_SOMPI: u64 = 50_000_000;
/** The pool requires its reserve output to keep at least 1 KAS. */
const RESERVE_SOMPI: u64 = 100_000_000;
const KUSDT_ID: [u8; 32] = [0x11; 32];
const POOL_ID: [u8; 32] = [0x22; 32];

fn kusdt() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("kusdt.ag", "test-audit-pool-kusdt").expect("kUSDT compiles"))
}

fn pool_artifact() -> &'static Artifact {
    static A: OnceLock<Artifact> = OnceLock::new();
    A.get_or_init(|| kusdt_kaspa::build_contract("pool.ag", "test-audit-pool").expect("pool compiles"))
}

fn pool_builder() -> TxBuilder<'static> {
    let bundle = ArtifactBundle::new(pool_artifact()).unwrap().with_artifact(kusdt()).unwrap();
    TxBuilder::from_bundle(&bundle).expect("bundle builder")
}

fn token_state(owner: [u8; 32], scheme: u8, amount: i64) -> State {
    state! {
        amount: amount,
        owner: owner.to_vec(),
        owner_scheme: scheme,
        borrow_scheme: 0u8,
        borrow_guard: vec![0u8; 32],
        extension_commitment: vec![0u8; 32]
    }
}

fn reserve_state(amount: i64) -> State {
    token_state(POOL_ID, 0x04, amount)
}

#[derive(Clone)]
struct Pool {
    x: i64,
    y: i64,
    s: i64,
    pk: i64,
    pt: i64,
    admin: [u8; 32],
    /// The circuit breaker (credit, reference, out).
    window: (i64, i64, i64),
}

// The circuit breaker: 10 % of the KAS reserve per hour; sells here run at this DAA.
const MAX_OUT_BPS: i64 = 1_000;
const WINDOW: i64 = 36_000;

impl Pool {
    fn state(&self) -> State {
        state! {
            token_covid: KUSDT_ID.to_vec(),
            kas_reserve: self.x,
            token_reserve: self.y,
            total_shares: self.s,
            protocol_kas: self.pk,
            protocol_tokens: self.pt,
            base_value: BASE,
            admin: self.admin.to_vec(),
            max_out_bps: MAX_OUT_BPS,
            window_len: WINDOW,
            window_credit: self.window.0,
            window_ref: self.window.1,
            window_out: self.window.2,
            paused: false,
            guardian: xonly(&key(0x32)).to_vec()
        }
    }
    fn value(&self) -> u64 {
        (BASE + self.x + self.pk) as u64
    }
}

/// A pool initialized at 10 000 KAS : 1 000 kUSDT; answers (pool, pool utxo, reserve utxo).
fn seeded(b: &TxBuilder<'static>) -> (Pool, (kaspa_consensus_core::tx::TransactionOutpoint, kaspa_consensus_core::tx::UtxoEntry), (kaspa_consensus_core::tx::TransactionOutpoint, kaspa_consensus_core::tx::UtxoEntry)) {
    let lp = key(0xa1);
    let genesis = Pool { x: 0, y: 0, s: 0, pk: 0, pt: 0, admin: xonly(&key(0x30)), window: (0, 0, 0) };
    let pool_utxo = b.covenant_utxo("Pool", genesis.state(), genesis.value(), 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap();
    let held = 5_000 * USDT;
    let (kas_in, tokens_in) = (10_000 * KAS, 1_000 * USDT);
    let provider = token_state(xonly(&lp), 0x00, held);
    let provider_utxo = b.covenant_utxo("kusdt::KCC20", provider.clone(), TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap();
    let change = token_state(xonly(&lp), 0x00, held - tokens_in);
    let next = Pool { x: kas_in, y: tokens_in, s: kas_in, window: (0, kas_in, 0), ..genesis.clone() };
    let next_states = vec![reserve_state(tokens_in), change.clone()];
    let ctx = TxContext::new()
        .actor_input("Pool", genesis.state(), { let (a0, a1, a2, admin) = (kas_in, xonly(&lp).to_vec(), change.clone(), key(0x30)); EntryCall::new("init").args_with(move |tx, i| args!(a0, a1.clone(), a2.clone(), common::sign_input(tx, i, &admin))) }, outpoint(0x40, 0), pool_utxo.clone(), 0)
        .actor_input("kusdt::KCC20", provider, EntryCall::new("transfer").args_with(move |tx, i| {
            let mut w = vec![0x00];
            w.extend(common::sign_input(tx, i, &lp));
            args!(next_states.clone(), w)
        }), outpoint(0x41, 0), provider_utxo.clone(), 0)
        .input(outpoint(0x42, 0), funding(), funding_sig(), 0)
        .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
        .actor_output("Position", state! { token_covid: KUSDT_ID.to_vec(), shares: kas_in - MIN_LIQUIDITY, owner: xonly(&key(0xa1)).to_vec() }, CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), POSITION_SOMPI)
        .actor_output("kusdt::KCC20", reserve_state(tokens_in), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), RESERVE_SOMPI)
        .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let tx = b.build(&ctx).expect("init builds");
    let tx = common::run(tx, vec![pool_utxo, provider_utxo, funding()]).expect("init runs");
    let pool = argent_runtime::CovenantOutput::from_tx(&tx, 0).unwrap();
    let reserve = argent_runtime::CovenantOutput::from_tx(&tx, 2).unwrap();
    (next, (pool.outpoint, pool.utxo), (reserve.outpoint, reserve.utxo))
}

#[test]
fn a_pool_buy_may_carry_decoys_of_its_successors() {
    let b = pool_builder();
    let (p, pool, reserve) = seeded(&b);
    let bob = key(0xb0);
    let kas_in = 100 * KAS;
    let eff = kas_in as i128 * (BPS - FEE_BPS) / BPS;
    let out = (p.y as i128 * eff / (p.x as i128 + eff)) as i64;
    let cut = (kas_in as i128 * PROTOCOL_BPS / BPS) as i64;
    // The breaker counts the net flow: the KAS the buy adds gives sells that much room.
    // The window is untouched by time here (the pool UTXO is new): just the credit.
    let credit = (p.window.1.min(p.x) as i128 * 1_000 / 10_000) as i64;
    let next_out = (p.window.2 - (kas_in - cut)).max(-credit);
    let next = Pool { x: p.x + kas_in - cut, y: p.y - out, pk: p.pk + cut, window: (p.window.0 + (p.window.2 - next_out), p.window.1, next_out), ..p.clone() };
    let reserve_out = next.y + next.pt;
    let buyer = token_state(xonly(&bob), 0x00, out);

    let pool_spk = b.covenant_utxo("Pool", next.state(), next.value(), 0, false, Some(Hash::from_bytes(POOL_ID))).unwrap().script_public_key;
    let reserve_spk = b.covenant_utxo("kusdt::KCC20", reserve_state(reserve_out), TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap().script_public_key;

    let ctx = TxContext::new()
        .actor_input("Pool", p.state(), EntryCall::new("buy").args(args!(kas_in, 0i64, buyer.clone())), pool.0, pool.1.clone(), 0)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(vec![reserve_state(reserve_out), buyer.clone()], vec![0x00u8])), reserve.0, reserve.1.clone(), 0)
        .input(outpoint(0x43, 0), funding(), funding_sig(), 0)
        // Decoys first: plain outputs with the pool's and the reserve's successor scripts.
        .output(pool_spk.clone(), None, 100_000_000)
        .output(reserve_spk.clone(), None, 100_000_000)
        .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), RESERVE_SOMPI)
        .actor_output("kusdt::KCC20", buyer, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let tx = b.build(&ctx).expect("buy builds");
    let tx = common::run(tx, vec![pool.1, reserve.1, funding()]).expect("the pool accepts decoys before its successors");
    assert!(tx.outputs[0].covenant.is_none() && tx.outputs[1].covenant.is_none());
    assert_eq!(tx.outputs[0].script_public_key, tx.outputs[2].script_public_key);
    assert_eq!(tx.outputs[1].script_public_key, tx.outputs[3].script_public_key);
    println!("AUDIT decoy buy accepted: outputs 0,1 are plain copies of the Pool (2) and reserve (3) successor scripts");
}

#[test]
fn anyone_can_sell_a_stray_pool_owned_state() {
    let b = pool_builder();
    let (p, pool, reserve) = seeded(&b);
    let attacker = key(0xee);
    // Someone sent 25 kUSDT to the pool's covenant ID (owner scheme 0x04), or a
    // deposit named it: a pool-owned state that is not the reserve.
    let stray = 25 * USDT;
    let stray_utxo = b.covenant_utxo("kusdt::KCC20", reserve_state(stray), TOKEN_SOMPI, 0, false, Some(Hash::from_bytes(KUSDT_ID))).unwrap();
    let tokens_in = 20 * USDT;
    let eff = tokens_in as i128 * (BPS - FEE_BPS) / BPS;
    let kas_out = (p.x as i128 * eff / (p.y as i128 + eff)) as i64;
    let cut = (tokens_in as i128 * PROTOCOL_BPS / BPS) as i64;
    // The reference follows the reserve down.
    let next = Pool { x: p.x - kas_out, y: p.y + tokens_in - cut, pt: p.pt + cut, window: ((p.window.0 - kas_out).max(0), p.window.1.min(p.x - kas_out), p.window.2 + kas_out), ..p.clone() };
    let reserve_out = next.y + next.pt;
    // The change of the stray state goes to the attacker, and so does kas_out.
    let change = token_state(xonly(&attacker), 0x00, stray - tokens_in);

    let ctx = TxContext::new()
        .actor_input("Pool", p.state(), EntryCall::new("sell").args(args!(kas_out, 0i64, change.clone())), pool.0, pool.1.clone(), 0)
        .actor_input("kusdt::KCC20", reserve_state(p.y + p.pt), EntryCall::new("transfer").args(args!(vec![reserve_state(reserve_out), change.clone()], vec![0x00u8])), reserve.0, reserve.1.clone(), 0)
        // The stray state as the payer: a covenant-ID owner needs no signature, the Pool input is present.
        .actor_input("kusdt::KCC20", reserve_state(stray), EntryCall::new("transfer_delegator").args(args!(Vec::<u8>::new())), outpoint(0x44, 0), stray_utxo.clone(), 0)
        .actor_output("Pool", next.state(), CovenantBinding::new(0, Hash::from_bytes(POOL_ID)), next.value())
        .actor_output("kusdt::KCC20", reserve_state(reserve_out), CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), RESERVE_SOMPI)
        .actor_output("kusdt::KCC20", change, CovenantBinding::new(1, Hash::from_bytes(KUSDT_ID)), TOKEN_SOMPI);
    let tx = b.build(&ctx).expect("sell builds");
    common::run(tx, vec![pool.1, reserve.1, stray_utxo]).expect("anyone may sell a stray pool-owned state");
    println!("AUDIT stray pool-owned state sold by a third party: {kas_out} sompi + {} units of change to the attacker", stray - tokens_in);
}
