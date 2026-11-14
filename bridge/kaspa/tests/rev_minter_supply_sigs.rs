//! Review r16/rev-minter, properties 1 (supply) and 3 (signatures) of BridgeMint, in the script engine.
//!
//! Every refusal here is the engine's (`Tally::refused` panics when the builder failed first or when the
//! engine accepted), and every group has a control of the same shape that the engine accepted.
//!
//!   cargo test --locked --test rev_minter_supply_sigs -- --nocapture

mod common;
mod rev_minter_kit;

use argent_runtime::{EntryCall, TxContext, args, state};
use kaspa_consensus_core::hashing::covenant_id::covenant_id;
use kaspa_consensus_core::tx::{CovenantBinding, MutableTransaction, Transaction, TransactionOutput};
use rev_minter_kit::*;

/// One mint attempt: what is passed, what was signed, and what is offered as outputs.
#[derive(Clone)]
struct M {
    chain: u8,
    nonce: i64,
    age: i64,
    seq: Option<u64>,
    recipients: Vec<Recipient>,
    signed_recipients: Option<Vec<Recipient>>,
    signed_chain: Option<u8>,
    signed_nonce: Option<i64>,
    signed_age: Option<i64>,
    signed_cov: Option<[u8; 32]>,
    who: Vec<usize>,
    quorum: Option<Quorum>,
    outputs: Option<Vec<Recipient>>,
    tamper: Option<fn(&mut MinterState)>,
    value: Option<u64>,
}

impl M {
    fn new(chain: u8, nonce: i64, recipients: &[Recipient]) -> Self {
        Self {
            chain,
            nonce,
            age: 1,
            seq: None,
            recipients: recipients.to_vec(),
            signed_recipients: None,
            signed_chain: None,
            signed_nonce: None,
            signed_age: None,
            signed_cov: None,
            who: vec![0, 1, 2],
            quorum: None,
            outputs: None,
            tamper: None,
            value: None,
        }
    }
    fn digest(&self, h: &Harness) -> [u8; 32] {
        mint_digest_any(
            &self.signed_cov.unwrap_or(cov(h)),
            self.signed_chain.unwrap_or(self.chain),
            self.signed_nonce.unwrap_or(self.nonce),
            self.signed_age.unwrap_or(self.age),
            self.signed_recipients.as_ref().unwrap_or(&self.recipients),
        )
    }
    fn go(&self, h: &Harness) -> Result<Transaction, Rejected> {
        let seq = self.seq.unwrap_or(self.age.max(0) as u64);
        let v = model_mint(&h.state, self.chain, self.nonce, self.age, seq, &self.recipients, h.minter.utxo.amount);
        let mut next = v.next.clone();
        if let Some(t) = self.tamper {
            t(&mut next);
        }
        let q = self.quorum.clone().unwrap_or_else(|| Quorum::honest(&h.signers, &self.who, &self.digest(h)));
        build_mint(h, self.chain, self.nonce, self.age, seq, &self.recipients, &q, &next, self.value.unwrap_or(v.value), self.outputs.as_ref().unwrap_or(&self.recipients))
    }
}

fn three() -> Vec<Recipient> {
    vec![Recipient::schnorr(&key(0xa1), 1_000), Recipient::schnorr(&key(0xa2), 2_000), Recipient::schnorr(&key(0xa3), 3_000)]
}

fn family_output(h: &Harness, actor: &str, state: State, input: u16, value: u64) -> TransactionOutput {
    TransactionOutput::with_covenant(value, script_of(actor, state), Some(CovenantBinding::new(input, h.minter.covenant_id)))
}

fn rerun(h: &Harness, tx: Transaction) -> Result<Transaction, Rejected> {
    let entries = entries_for(h, &tx);
    run(tx, entries)
}

// ---------------------------------------------------------------------------------------------
// Property 1: supply.

#[test]
fn p1_a_mint_makes_only_what_three_signers_signed_at_the_current_nonce() {
    let h = Harness::launch_with(|s| {
        s.nonce_ethereum = 5;
        s.nonce_bsc = 9;
    });
    let mut t = Tally::default();
    let all = three();
    for n in 1..=3 {
        t.control("mint of n recipients", M::new(CHAIN_ETHEREUM, 5, &all[..n]).go(&h));
    }
    t.control("mint on the other chain", M::new(CHAIN_BSC, 9, &all[..1]).go(&h));

    // Recipient count.
    let four = [all.clone(), vec![Recipient::schnorr(&key(0xa4), 4_000)]].concat();
    t.refused("no recipient", M::new(CHAIN_ETHEREUM, 5, &[]).go(&h));
    t.refused("four recipients", M::new(CHAIN_ETHEREUM, 5, &four).go(&h));

    // Amounts.
    for bad in [0i64, -1, -1_000, i64::MIN + 1] {
        let r = vec![Recipient::schnorr(&key(0xa1), bad)];
        t.refused("a non-positive amount", M::new(CHAIN_ETHEREUM, 5, &r).go(&h));
    }

    // The nonce: only the current one, on the chain named.
    for nonce in [0i64, 4, 6, 9, -5] {
        t.refused("a nonce that is not the chain's", M::new(CHAIN_ETHEREUM, nonce, &all[..1]).go(&h));
    }
    for nonce in [5i64, 8, 10] {
        t.refused("a nonce that is not BSC's", M::new(CHAIN_BSC, nonce, &all[..1]).go(&h));
    }
    for chain in [0u8, 3, 0x81, 0xff] {
        t.refused("an unknown chain", M::new(chain, 5, &all[..1]).go(&h));
    }

    // What the outputs carry is what was signed.
    let mut more = all[..1].to_vec();
    more[0].amount = 999_999;
    let mut m = M::new(CHAIN_ETHEREUM, 5, &all[..1]);
    m.outputs = Some(more.clone());
    t.refused("an output with a larger amount than the recipient", m.go(&h));
    let mut m = M::new(CHAIN_ETHEREUM, 5, &more);
    m.signed_recipients = Some(all[..1].to_vec());
    t.refused("an argument with a larger amount than the one signed", m.go(&h));
    let mut thief = all[..1].to_vec();
    thief[0].owner = xonly(&key(0xee));
    let mut m = M::new(CHAIN_ETHEREUM, 5, &all[..1]);
    m.outputs = Some(thief.clone());
    t.refused("an output owned by somebody else", m.go(&h));
    let mut m = M::new(CHAIN_ETHEREUM, 5, &thief);
    m.signed_recipients = Some(all[..1].to_vec());
    t.refused("an argument owned by somebody else", m.go(&h));
    let mut m = M::new(CHAIN_ETHEREUM, 5, &all[..2]);
    m.outputs = Some(vec![all[1].clone(), all[0].clone()]);
    t.refused("minted outputs in another order than the recipients", m.go(&h));
    let mut m = M::new(CHAIN_ETHEREUM, 5, &all[..2]);
    m.outputs = Some(all[..1].to_vec());
    t.refused("fewer outputs than recipients", m.go(&h));
    let mut m = M::new(CHAIN_ETHEREUM, 5, &all[..2]);
    m.outputs = Some(all.clone());
    t.refused("more outputs than recipients", m.go(&h));

    // Minted states are plain kUSDT.
    for (what, bend) in [
        ("owner scheme 5", (|r: &mut Recipient| r.owner_scheme = 5) as fn(&mut Recipient)),
        ("owner scheme 0xff", |r| r.owner_scheme = 0xff),
        ("a borrow scheme", |r| r.borrow_scheme = 1),
        ("a borrow guard", |r| r.borrow_guard = [1; 32]),
        ("another extension", |r| r.extension_commitment = [7; 32]),
    ] {
        let mut r = all[..1].to_vec();
        bend(&mut r[0]);
        t.refused(what, M::new(CHAIN_ETHEREUM, 5, &r).go(&h));
    }
    for scheme in 0u8..=4 {
        let mut r = all[..1].to_vec();
        r[0].owner_scheme = scheme;
        t.control("every valid owner scheme", M::new(CHAIN_ETHEREUM, 5, &r).go(&h));
    }

    // The successor is forced, field by field.
    for (what, bend) in [
        ("remaining not lowered", (|s: &mut MinterState| s.remaining += 1_000) as fn(&mut MinterState)),
        ("remaining raised", |s| s.remaining = CAP + 1),
        ("bucket not lowered", |s| s.bucket += 1_000),
        ("nonce not advanced", |s| s.nonce_ethereum = 5),
        ("nonce advanced twice", |s| s.nonce_ethereum = 7),
        ("the other chain's nonce moved", |s| s.nonce_bsc = 10),
        ("capacity raised", |s| s.capacity *= 2),
        ("refill raised", |s| s.refill_per_daa *= 2),
        ("admin nonce moved", |s| s.admin_nonce += 1),
        ("paused set", |s| s.paused = true),
        ("signer set replaced", |s| s.signer_set = [9; 32]),
        ("guardian replaced", |s| s.guardian = [9; 32]),
        ("recovery delay shortened", |s| s.recovery_delay = 1),
        ("recovery nonce moved", |s| s.recovery_nonce += 1),
        ("a recovery planted", |s| {
            s.recovery_pending = true;
            s.recovery_signer_set = [9; 32];
        }),
        ("a recovery guardian planted", |s| s.recovery_guardian = [9; 32]),
    ] {
        let mut m = M::new(CHAIN_ETHEREUM, 5, &all[..1]);
        m.tamper = Some(bend);
        t.refused(what, m.go(&h));
    }
    for value in [MINTER_SOMPI - 1, MINTER_SOMPI + 1, 1] {
        let mut m = M::new(CHAIN_ETHEREUM, 5, &all[..1]);
        m.value = Some(value);
        t.refused("the minter's KAS value changed by a mint", m.go(&h));
    }
    t.report("p1 only what was signed");
    assert_eq!((t.refused, t.controls), (49, 9));
}

#[test]
fn p1_each_nonce_once_and_remaining_only_falls() {
    let mut h = Harness::launch_with(|s| s.remaining = 10_000);
    let mut t = Tally::default();
    let r = vec![Recipient::schnorr(&key(0xa1), 4_000)];
    let m = M::new(CHAIN_ETHEREUM, 0, &r);
    let q = Quorum::honest(&h.signers, &[0, 1, 2], &m.digest(&h));
    let (tx, v) = honest_mint(&h, CHAIN_ETHEREUM, 0, 1, &r);
    let tx = t.control("first mint of nonce 0", tx);
    adopt(&mut h, &tx, v.next);
    assert_eq!(h.state.remaining, 6_000);

    // The same signatures on the successor: nonce 0 is gone.
    let mut again = M::new(CHAIN_ETHEREUM, 0, &r);
    again.quorum = Some(q.clone());
    t.refused("the same mint again", again.go(&h));
    // The same signatures passed as nonce 1.
    let mut shifted = M::new(CHAIN_ETHEREUM, 1, &r);
    shifted.quorum = Some(q.clone());
    t.refused("signatures for nonce 0 used at nonce 1", shifted.go(&h));
    // And on the other chain, whose nonce is still 0.
    let mut other = M::new(CHAIN_BSC, 0, &r);
    other.quorum = Some(q);
    t.refused("Ethereum signatures used for BSC's nonce 0", other.go(&h));
    t.control("BSC's own nonce 0", M::new(CHAIN_BSC, 0, &r[..1]).go(&h));

    let (tx, v) = honest_mint(&h, CHAIN_ETHEREUM, 1, 1, &r);
    let tx = t.control("nonce 1", tx);
    adopt(&mut h, &tx, v.next);
    assert_eq!(h.state.remaining, 2_000);
    // The lifetime cap: 2 000 left.
    t.refused("more than remaining", honest_mint(&h, CHAIN_ETHEREUM, 2, 1, &[Recipient::schnorr(&key(0xa1), 2_001)]).0);
    let split = [Recipient::schnorr(&key(0xa1), 1_000), Recipient::schnorr(&key(0xa2), 1_000), Recipient::schnorr(&key(0xa3), 1)];
    t.refused("more than remaining across three recipients", honest_mint(&h, CHAIN_ETHEREUM, 2, 1, &split).0);
    let (tx, v) = honest_mint(&h, CHAIN_ETHEREUM, 2, 1, &[Recipient::schnorr(&key(0xa1), 2_000)]);
    let tx = t.control("exactly remaining", tx);
    adopt(&mut h, &tx, v.next);
    assert_eq!(h.state.remaining, 0);
    t.refused("one unit past the lifetime cap", honest_mint(&h, CHAIN_ETHEREUM, 3, 1, &[Recipient::schnorr(&key(0xa1), 1)]).0);

    // No governance action raises remaining (each offered with remaining restored).
    let h = Harness::launch_with(|s| {
        s.remaining = 10_000;
        s.paused = true;
        s.recovery_pending = true;
        s.recovery_signer_set = [3; 32];
        s.recovery_guardian = [4; 32];
        s.recovery_delay = 10;
    });
    let new_keys: Vec<_> = (0x30..0x35).map(key).collect();
    let rotate = [signer_set_of(&new_keys).to_vec(), xonly(&key(0x36)).to_vec()].concat();
    for (action, params) in [
        (0x01u8, vec![]),
        (0x02, [le8(1_000), le8(1)].concat()),
        (0x03, rotate.clone()),
        (0x04, [vec![CHAIN_ETHEREUM], le8(0).to_vec()].concat()),
        (0x05, le8(MINTER_SOMPI as i64 + 5).to_vec()),
        (0x07, vec![]),
    ] {
        let (ok, v) = honest_govern(&h, action, &params, 0);
        t.control("the action itself", ok);
        let who: Vec<usize> = (0..quorum_of(action)).collect();
        let q = Quorum::honest(&h.signers, &who, &digest_for(&h, signed_nonce(&h.state, action), action, &params));
        let mut raised = v.next.clone();
        raised.remaining = CAP;
        t.refused("a governance action that raises remaining", build_govern(&h, action, &params, 0, 0, &q, &raised, v.value));
    }
    let v = model_execute(&h.state, 10, MINTER_SOMPI);
    t.control("execute_recovery", build_execute(&h, 10, &v.next, v.value));
    let mut raised = v.next.clone();
    raised.remaining = CAP;
    t.refused("execute_recovery raising remaining", build_execute(&h, 10, &raised, v.value));
    let h = Harness::launch_with(|s| s.remaining = 10_000);
    let v = model_pause(&h.state, 0, MINTER_SOMPI);
    t.control("pause", build_pause(&h, &h.guardian, 0, &v.next, v.value));
    let mut raised = v.next.clone();
    raised.remaining = CAP;
    t.refused("pause raising remaining", build_pause(&h, &h.guardian, 0, &raised, v.value));
    t.report("p1 each nonce once, remaining only falls");
    assert_eq!((t.refused, t.controls), (14, 12));
}

/// The guardian's signature commits to the outputs, so a pause with one more output is signed again.
fn resign_pause(h: &Harness, tx: &Transaction) -> Transaction {
    let mutable = MutableTransaction::with_entries(tx.clone(), entries_for(h, tx));
    let signature = sign_input(&mutable, 0, &h.guardian);
    with_argument(tx, 0, signature)
}

#[test]
fn p1_nothing_rides_along_with_any_entry() {
    let mut t = Tally::default();
    let thief = Recipient::schnorr(&key(0xee), 5_000_000);
    let zero = Recipient::schnorr(&key(0xee), 0);

    // --- mint ---
    let h = Harness::launch();
    let r = three()[..1].to_vec();
    let (tx, v) = honest_mint(&h, CHAIN_ETHEREUM, 0, 1, &r);
    let tx = t.control("the mint", tx);
    let other_minter = {
        let mut s = v.next.clone();
        s.signer_set = [9; 32];
        s
    };
    let extra: Vec<(&str, TransactionOutput)> = vec![
        ("one more token state, vouched for by the minter input", family_output(&h, "KCC20", thief.state(), 0, TOKEN_SOMPI)),
        ("one more zero token state, vouched for by the minter input", family_output(&h, "KCC20", zero.state(), 0, TOKEN_SOMPI)),
        ("a second minter with the same state", family_output(&h, "BridgeMint", v.next.state(), 0, MINTER_SOMPI)),
        ("a second minter with other signers", family_output(&h, "BridgeMint", other_minter.state(), 0, MINTER_SOMPI)),
        ("a token state vouched for by the funding input", family_output(&h, "KCC20", thief.state(), 1, TOKEN_SOMPI)),
        ("a second minter vouched for by the funding input", family_output(&h, "BridgeMint", other_minter.state(), 1, MINTER_SOMPI)),
        ("a token state vouched for by an input that does not exist", family_output(&h, "KCC20", thief.state(), 2, TOKEN_SOMPI)),
    ];
    for (what, output) in extra {
        for at_end in [true, false] {
            let mut forged = tx.clone();
            if at_end {
                forged.outputs.push(output.clone());
            } else {
                forged.outputs.insert(0, output.clone());
            }
            forged.finalize();
            t.refused(what, rerun(&h, forged));
        }
    }
    // The successor must come first among what the minter authorizes.
    let mut swapped = tx.clone();
    swapped.outputs.swap(0, 1);
    swapped.finalize();
    t.refused("the minted state before the successor", rerun(&h, swapped));
    // An unbound copy rides along freely (it is in no family; decoy_outputs.rs): the control for the shape.
    let mut decoy = tx.clone();
    decoy.outputs.push(TransactionOutput::new(TOKEN_SOMPI, script_of("KCC20", thief.state())));
    decoy.finalize();
    t.control("an unbound output with a token's script (not in the family)", rerun(&h, decoy));

    // An output in ANOTHER covenant's name, authorized by the minter input: only as the genesis of a new family,
    // whose ID is not kUSDT's. Recorded as observed (it creates no kUSDT either way).
    let mut foreign = tx.clone();
    let plain = TransactionOutput::new(TOKEN_SOMPI, script_of("KCC20", thief.state()));
    let index = foreign.outputs.len() as u32;
    let new_family = covenant_id(h.minter.outpoint, [(index, &plain)].into_iter());
    assert_ne!(new_family, h.minter.covenant_id);
    foreign.outputs.push(TransactionOutput::with_covenant(TOKEN_SOMPI, plain.script_public_key.clone(), Some(CovenantBinding::new(0, new_family))));
    foreign.finalize();
    let observed = rerun(&h, foreign);
    println!("[p1 ride-along] a new family's genesis authorized by the minter input (another covenant ID): {}", verdict_text(&observed));
    // A made-up covenant ID that is neither kUSDT's nor a genesis.
    let mut madeup = tx.clone();
    madeup.outputs.push(TransactionOutput::with_covenant(TOKEN_SOMPI, plain.script_public_key.clone(), Some(CovenantBinding::new(0, covenant_hash([0x77; 32])))));
    madeup.finalize();
    t.refused("an output under a made-up covenant ID", rerun(&h, madeup));

    // --- govern (every action), pause, execute_recovery: no token and no second minter ---
    let h = Harness::launch_with(|s| {
        s.paused = true;
        s.recovery_pending = true;
        s.recovery_signer_set = [3; 32];
        s.recovery_guardian = [4; 32];
        s.recovery_delay = 10;
    });
    let new_keys: Vec<_> = (0x30..0x35).map(key).collect();
    let rotate = [signer_set_of(&new_keys).to_vec(), xonly(&key(0x36)).to_vec()].concat();
    let mut singles: Vec<(String, Transaction, MinterState)> = Vec::new();
    for (action, params) in [
        (0x01u8, vec![]),
        (0x02, [le8(1_000), le8(1)].concat()),
        (0x03, rotate.clone()),
        (0x04, [vec![CHAIN_ETHEREUM], le8(0).to_vec()].concat()),
        (0x05, le8(MINTER_SOMPI as i64 + 5).to_vec()),
        (0x07, vec![]),
    ] {
        let (ok, v) = honest_govern(&h, action, &params, 0);
        singles.push((format!("govern action {action}"), t.control("the action", ok), v.next));
    }
    let v = model_execute(&h.state, 10, MINTER_SOMPI);
    singles.push(("execute_recovery".into(), t.control("execute_recovery", build_execute(&h, 10, &v.next, v.value)), v.next));
    for (what, tx, next) in &singles {
        for output in [
            family_output(&h, "KCC20", thief.state(), 0, TOKEN_SOMPI),
            family_output(&h, "KCC20", zero.state(), 0, TOKEN_SOMPI),
            family_output(&h, "BridgeMint", next.state(), 0, MINTER_SOMPI),
            family_output(&h, "KCC20", thief.state(), 1, TOKEN_SOMPI),
        ] {
            let mut forged = tx.clone();
            forged.outputs.push(output);
            forged.finalize();
            t.refused(&format!("{what} with one more family output"), rerun(&h, forged));
        }
    }
    // propose_recovery, from a state with none pending.
    let h2 = Harness::launch();
    let (ok, v) = honest_govern(&h2, 0x06, &rotate, 0);
    let tx = t.control("propose_recovery", ok);
    for output in [family_output(&h2, "KCC20", thief.state(), 0, TOKEN_SOMPI), family_output(&h2, "BridgeMint", v.next.state(), 0, MINTER_SOMPI)] {
        let mut forged = tx.clone();
        forged.outputs.push(output);
        forged.finalize();
        t.refused("propose_recovery with one more family output", rerun(&h2, forged));
    }
    // pause: signed again by the guardian over the transaction with the extra output.
    let v = model_pause(&h2.state, 0, MINTER_SOMPI);
    let tx = t.control("pause", build_pause(&h2, &h2.guardian, 0, &v.next, v.value));
    for output in [family_output(&h2, "KCC20", thief.state(), 0, TOKEN_SOMPI), family_output(&h2, "BridgeMint", v.next.state(), 0, MINTER_SOMPI)] {
        let mut forged = tx.clone();
        forged.outputs.push(output);
        forged.finalize();
        let forged = resign_pause(&h2, &forged);
        t.refused("a pause, signed by the guardian, with one more family output", rerun(&h2, forged));
    }
    // The re-signing helper itself: a pause with an unbound extra output, signed again, is accepted.
    let mut plain_extra = tx.clone();
    plain_extra.outputs.push(TransactionOutput::new(TOKEN_SOMPI, script_of("KCC20", thief.state())));
    plain_extra.finalize();
    t.control("a pause signed again over an unbound extra output", rerun(&h2, resign_pause(&h2, &plain_extra)));
    t.report("p1 nothing rides along");
    assert_eq!((t.refused, t.controls), (14 + 1 + 1 + 28 + 2 + 2, 1 + 1 + 6 + 1 + 1 + 1 + 1));
}

#[test]
fn p1_the_other_actors_of_the_family_make_no_kusdt() {
    let mut h = Harness::launch();
    let mut t = Tally::default();
    let alice = key(0xa1);
    let (tx, v) = honest_mint(&h, CHAIN_ETHEREUM, 0, 1, &[Recipient::schnorr(&alice, 1_000)]);
    let tx = t.control("mint 1000 to alice", tx);
    adopt(&mut h, &tx, v.next);
    let token = covenant_output(&tx, 1);
    let bob = xonly(&key(0xb0));
    t.control("a transfer that conserves the amount", transfer(&token, &alice, 1_000, &[(bob, 400), (xonly(&alice), 600)]));
    t.refused("a transfer that makes one unit", transfer(&token, &alice, 1_000, &[(bob, 400), (xonly(&alice), 601)]));
    t.refused("a transfer that makes a lot", transfer(&token, &alice, 1_000, &[(bob, 1_000_000_000)]));

    // TokenSeed makes zero-amount states only.
    let seed_state = || state! { owner: xonly(&h.guardian).to_vec(), extension_commitment: vec![0u8; 32] };
    let create = |amount: i64| -> Result<Transaction, Rejected> {
        let recipient = Recipient::schnorr(&key(0xee), amount);
        let context = TxContext::new()
            .actor_input("TokenSeed", seed_state(), EntryCall::new("create").args(args!(recipient.state())), h.seed.outpoint, h.seed.utxo.clone(), 0)
            .input(fresh_funding(), funding(), funding_sig(), 0)
            .actor_output("TokenSeed", seed_state(), CovenantBinding::new(0, h.seed.covenant_id), SEED_SOMPI)
            .actor_output("KCC20", recipient.state(), CovenantBinding::new(0, h.seed.covenant_id), TOKEN_SOMPI);
        let tx = builder().build(&context).map_err(|e| match e {
            argent_runtime::BuilderError::InputScript { .. } | argent_runtime::BuilderError::TxScript(_) => Rejected::Script(e.to_string()),
            other => Rejected::Build(other.to_string()),
        })?;
        run(tx, vec![h.seed.utxo.clone(), funding()])
    };
    t.control("the seed makes a zero-amount state", create(0));
    t.refused("the seed makes one unit", create(1));
    t.refused("the seed makes a million", create(1_000_000_000_000));

    // A mint and a KCC-20 transfer in one transaction (the builder refuses a seed `create` next to another family
    // input, so the transfer is the neighbour that can be tried): each input vouches for its own outputs only.
    let r = vec![Recipient::schnorr(&alice, 1_000)];
    let model = model_mint(&h.state, CHAIN_ETHEREUM, 1, 1, 1, &r, MINTER_SOMPI);
    let q = Quorum::honest(&h.signers, &[0, 1, 2], &mint_digest(&cov(&h), CHAIN_ETHEREUM, 1, 1, &r));
    let together = |transferred: i64, minted_amount: i64| -> Result<Transaction, Rejected> {
        let states: Vec<State> = r.iter().map(Recipient::state).collect();
        let call = EntryCall::new("mint").args(args!(
            CHAIN_ETHEREUM,
            1i64,
            1i64,
            states,
            bytes_array(q.keys.iter().map(|k| k.to_vec())),
            q.indices.clone(),
            bytes_array(q.signatures.iter().cloned())
        ));
        let moved = vec![Recipient::owned(bob, transferred).state()];
        let moved_for_call = moved.clone();
        let owner = alice;
        let spend = EntryCall::new("transfer").args_with(move |tx, index| {
            let mut witness = vec![0x00];
            witness.extend(sign_input(tx, index, &owner));
            args!(moved_for_call.clone(), witness)
        });
        let minted = Recipient::schnorr(&alice, minted_amount);
        let id = h.minter.covenant_id;
        let context = TxContext::new()
            .actor_input("BridgeMint", h.state.state(), call, h.minter.outpoint, h.minter.utxo.clone(), 1)
            .actor_input("KCC20", Recipient::schnorr(&alice, 1_000).state(), spend, token.outpoint, token.utxo.clone(), 0)
            .input(fresh_funding(), funding(), funding_sig(), 0)
            .actor_output("BridgeMint", model.next.state(), CovenantBinding::new(0, id), MINTER_SOMPI)
            .actor_output("KCC20", minted.state(), CovenantBinding::new(0, id), TOKEN_SOMPI)
            .actor_output("KCC20", moved[0].clone(), CovenantBinding::new(1, id), TOKEN_SOMPI);
        let tx = builder().build(&context).map_err(|e| match e {
            argent_runtime::BuilderError::InputScript { .. } | argent_runtime::BuilderError::TxScript(_) => Rejected::Script(e.to_string()),
            other => Rejected::Build(other.to_string()),
        })?;
        run(tx, vec![h.minter.utxo.clone(), token.utxo.clone(), funding()])
    };
    let both = together(1_000, 1_000);
    println!("[p1 the other actors] a mint and a KCC-20 transfer in one transaction: {}", verdict_text(&both));
    if both.is_ok() {
        t.controls += 1;
        t.refused("the transfer's output carrying more next to a mint", together(1_007, 1_000));
        t.refused("the mint's output carrying more next to a transfer", together(1_000, 1_007));
    }
    t.report("p1 the other actors");
}

// ---------------------------------------------------------------------------------------------
// Property 3: signatures.

#[test]
fn p3_a_mint_signature_serves_one_message_only() {
    // Both chains at the same nonce, so that only the chain byte separates them.
    let h = Harness::launch_with(|s| {
        s.nonce_ethereum = 3;
        s.nonce_bsc = 3;
    });
    let mut t = Tally::default();
    let all = three();
    t.control("an honest mint", M::new(CHAIN_ETHEREUM, 3, &all[..2]).go(&h));

    let base = || M::new(CHAIN_ETHEREUM, 3, &all[..2]);
    let mut m = base();
    m.signed_cov = Some([0x55; 32]);
    t.refused("signed for another covenant ID", m.go(&h));
    let mut m = base();
    m.signed_chain = Some(CHAIN_BSC);
    t.refused("signed for the other chain (same nonce)", m.go(&h));
    for n in [2i64, 4, 0] {
        let mut m = base();
        m.signed_nonce = Some(n);
        t.refused("signed for another nonce", m.go(&h));
    }
    for (claimed, signed) in [(1i64, 2i64), (2, 1), (0, 1), (1, 0), (5, 1 << 32)] {
        let mut m = base();
        m.age = claimed;
        m.seq = Some(10);
        m.signed_age = Some(signed);
        t.refused("signed for another age", m.go(&h));
    }
    // Recipients: any field, the order, the count.
    let variants: Vec<(&str, Vec<Recipient>)> = vec![
        ("one amount", {
            let mut r = all[..2].to_vec();
            r[1].amount += 1;
            r
        }),
        ("one owner", {
            let mut r = all[..2].to_vec();
            r[0].owner[31] ^= 1;
            r
        }),
        ("one owner scheme", {
            let mut r = all[..2].to_vec();
            r[0].owner_scheme = 3;
            r
        }),
        ("the order", vec![all[1].clone(), all[0].clone()]),
        ("one recipient fewer", all[..1].to_vec()),
        ("one recipient more", all.clone()),
        ("amounts moved between recipients (same total)", {
            let mut r = all[..2].to_vec();
            r[0].amount += 500;
            r[1].amount -= 500;
            r
        }),
    ];
    for (what, signed) in variants {
        let mut m = base();
        m.signed_recipients = Some(signed.clone());
        t.refused(&format!("signed for other recipients: {what}"), m.go(&h));
        // And the mirror: the variant passed, the base signed.
        let mut m = M::new(CHAIN_ETHEREUM, 3, &signed);
        m.signed_recipients = Some(all[..2].to_vec());
        t.refused(&format!("other recipients passed: {what}"), m.go(&h));
    }
    // A governance signature is not a mint signature, and the reverse.
    let params = [signer_set_of(&h.signers).to_vec(), xonly(&h.guardian).to_vec()].concat();
    for action in [0x03u8, 0x06] {
        let digest = digest_for(&h, 0, action, &params);
        let mut m = base();
        m.quorum = Some(Quorum::honest(&h.signers, &[0, 1, 2], &digest));
        t.refused("governance signatures on a mint", m.go(&h));
    }
    let mint_sigs = Quorum::honest(&h.signers, &[0, 1, 2], &base().digest(&h));
    let v = model_govern(&h.state, 0x06, &params, 0, 0, MINTER_SOMPI);
    t.refused("mint signatures on a recovery proposal", build_govern(&h, 0x06, &params, 0, 0, &mint_sigs, &v.next, v.value));
    t.control("the honest proposal", honest_govern(&h, 0x06, &params, 0).0);
    t.report("p3 mint signatures");
    assert_eq!((t.refused, t.controls), (1 + 1 + 3 + 5 + 14 + 2 + 1, 2));
}

#[test]
fn p3_quorums_cannot_be_met_with_repeats_or_wrong_positions() {
    let h = Harness::launch_with(|s| {
        s.paused = true;
        s.recovery_pending = true;
        s.recovery_signer_set = [3; 32];
    });
    let hm = Harness::launch();
    let mut t = Tally::default();
    let r = three()[..1].to_vec();
    let m = M::new(CHAIN_ETHEREUM, 0, &r);
    let digest = m.digest(&hm);
    let keys = keys_of(&hm.signers);
    let sig = |i: usize| sign_digest(&hm.signers[i], &digest);
    let with = |indices: Vec<u8>, signatures: Vec<Vec<u8>>| {
        let mut m = m.clone();
        m.quorum = Some(Quorum { keys: keys.clone(), indices, signatures });
        m.go(&hm)
    };
    for who in [[0usize, 1, 2], [0, 1, 3], [0, 1, 4], [0, 2, 3], [0, 2, 4], [0, 3, 4], [1, 2, 3], [1, 2, 4], [1, 3, 4], [2, 3, 4]] {
        t.control("every increasing triple of signers", with(who.iter().map(|&i| i as u8).collect(), who.iter().map(|&i| sig(i)).collect()));
    }
    t.refused("a signer repeated (0,0,1)", with(vec![0, 0, 1], vec![sig(0), sig(0), sig(1)]));
    t.refused("a signer repeated (0,1,1)", with(vec![0, 1, 1], vec![sig(0), sig(1), sig(1)]));
    t.refused("one signature under three positions", with(vec![0, 1, 2], vec![sig(0), sig(0), sig(0)]));
    t.refused("decreasing order (2,1,0)", with(vec![2, 1, 0], vec![sig(2), sig(1), sig(0)]));
    t.refused("out of order (0,2,1)", with(vec![0, 2, 1], vec![sig(0), sig(2), sig(1)]));
    t.refused("position 5", with(vec![0, 1, 5], vec![sig(0), sig(1), sig(2)]));
    t.refused("position 255", with(vec![0, 1, 255], vec![sig(0), sig(1), sig(2)]));
    t.refused("position 0x80", with(vec![0, 1, 0x80], vec![sig(0), sig(1), sig(2)]));
    t.refused("a signature under another signer's position", with(vec![0, 1, 2], vec![sig(1), sig(0), sig(2)]));
    t.refused("two signatures", with(vec![0, 1], vec![sig(0), sig(1)]));
    t.refused("one signature", with(vec![0], vec![sig(0)]));
    t.refused("no signature", with(vec![], vec![]));
    t.refused("four signatures on a mint", with(vec![0, 1, 2, 3], vec![sig(0), sig(1), sig(2), sig(3)]));
    t.refused("five signatures on a mint", with(vec![0, 1, 2, 3, 4], (0..5).map(sig).collect()));
    t.refused("three positions, two signatures", with(vec![0, 1, 2], vec![sig(0), sig(1)]));
    t.refused("two positions, three signatures", with(vec![0, 1], vec![sig(0), sig(1), sig(2)]));
    t.refused("a signature by a key outside the set", with(vec![0, 1, 2], vec![sig(0), sig(1), sign_digest(&key(0x77), &digest)]));
    // Keys that are not the set: an attacker's own five keys, and the set with one key swapped for the attacker's.
    let foreign: Vec<_> = (0x40..0x45).map(key).collect();
    let mut m2 = m.clone();
    m2.quorum = Some(Quorum::honest(&foreign, &[0, 1, 2], &digest));
    t.refused("five foreign keys", m2.go(&hm));
    let mut mixed = hm.signers.clone();
    mixed[2] = key(0x77);
    let mut m2 = m.clone();
    m2.quorum = Some(Quorum::honest(&mixed, &[0, 1, 2], &digest));
    t.refused("the set with one key swapped", m2.go(&hm));
    let mut reordered = hm.signers.clone();
    reordered.swap(0, 1);
    let mut m2 = m.clone();
    m2.quorum = Some(Quorum::honest(&reordered, &[0, 1, 2], &digest));
    t.refused("the set in another order", m2.go(&hm));
    // Four or six keys.
    let mut m2 = m.clone();
    m2.quorum = Some(Quorum { keys: keys[..4].to_vec(), indices: vec![0, 1, 2], signatures: vec![sig(0), sig(1), sig(2)] });
    t.refused("four keys", m2.go(&hm));
    let mut m2 = m.clone();
    m2.quorum = Some(Quorum { keys: [keys.clone(), vec![xonly(&key(0x77))]].concat(), indices: vec![0, 1, 2], signatures: vec![sig(0), sig(1), sig(2)] });
    t.refused("six keys", m2.go(&hm));

    // Governance: the count is exact for every action.
    let rotate = [signer_set_of(&foreign).to_vec(), xonly(&key(0x36)).to_vec()].concat();
    let gov = |h: &Harness, action: u8, params: &[u8], who: &[usize]| {
        let v = model_govern(&h.state, action, params, 0, 0, MINTER_SOMPI);
        let d = digest_for(h, signed_nonce(&h.state, action), action, params);
        let q = Quorum { keys: keys_of(&h.signers), indices: who.iter().map(|&i| i as u8).collect(), signatures: who.iter().map(|&i| sign_digest(&h.signers[i], &d)).collect() };
        build_govern(h, action, params, 0, 0, &q, &v.next, v.value)
    };
    let actions: Vec<(u8, Vec<u8>)> = vec![
        (0x01, vec![]),
        (0x02, [le8(1_000), le8(1)].concat()),
        (0x03, rotate.clone()),
        (0x04, [vec![CHAIN_BSC], le8(0).to_vec()].concat()),
        (0x05, le8(MINTER_SOMPI as i64 * 2).to_vec()),
    ];
    for (action, params) in &actions {
        for who in [[0usize, 1, 2, 3], [0, 1, 2, 4], [0, 1, 3, 4], [0, 2, 3, 4], [1, 2, 3, 4]] {
            t.control("every increasing four", gov(&h, *action, params, &who));
        }
        t.refused("three signers", gov(&h, *action, params, &[0, 1, 2]));
        t.refused("five signers", gov(&h, *action, params, &[0, 1, 2, 3, 4]));
        t.refused("a repeat among four (0,1,2,2)", gov(&h, *action, params, &[0, 1, 2, 2]));
        t.refused("a repeat among four (0,0,1,2)", gov(&h, *action, params, &[0, 0, 1, 2]));
        t.refused("four out of order", gov(&h, *action, params, &[1, 0, 2, 3]));
        t.refused("no signer", gov(&h, *action, params, &[]));
    }
    // veto: exactly one, by a member.
    for who in 0..5 {
        t.control("any one signer vetoes", gov(&h, 0x07, &[], &[who]));
    }
    t.refused("a veto with no signature", gov(&h, 0x07, &[], &[]));
    t.refused("a veto with two signatures", gov(&h, 0x07, &[], &[0, 1]));
    // propose: exactly three.
    for who in [[0usize, 1, 2], [2, 3, 4], [0, 2, 4]] {
        t.control("three propose", gov(&hm, 0x06, &rotate, &who));
    }
    t.refused("two propose", gov(&hm, 0x06, &rotate, &[0, 1]));
    t.refused("four propose", gov(&hm, 0x06, &rotate, &[0, 1, 2, 3]));
    t.refused("a repeat among the proposers", gov(&hm, 0x06, &rotate, &[0, 1, 1]));
    t.report("p3 quorum counts");
    assert_eq!((t.refused, t.controls), (17 + 5 + 30 + 2 + 3, 10 + 25 + 5 + 3));
}

#[test]
fn p3_a_governance_signature_serves_one_action_one_nonce_one_spelling() {
    // admin_nonce == recovery_nonce, so only the action byte separates a governance message from a recovery one.
    let paused_pending = Harness::launch_with(|s| {
        s.admin_nonce = 7;
        s.recovery_nonce = 7;
        s.paused = true;
        s.recovery_pending = true;
        s.recovery_signer_set = [3; 32];
    });
    let idle = Harness::launch_with(|s| {
        s.admin_nonce = 7;
        s.recovery_nonce = 7;
    });
    let mut t = Tally::default();
    let new_keys: Vec<_> = (0x30..0x35).map(key).collect();
    let rotate = [signer_set_of(&new_keys).to_vec(), xonly(&key(0x36)).to_vec()].concat();
    // `signed` is what the signers signed (action, params, nonce); `used` is what the spend claims.
    let cross = |h: &Harness, signed: (u8, &[u8], i64), used: (u8, &[u8]), who: &[usize]| {
        let d = digest_for(h, signed.2, signed.0, signed.1);
        let q = Quorum::honest(&h.signers, who, &d);
        let v = model_govern(&h.state, used.0, used.1, 0, 0, MINTER_SOMPI);
        assert!(v.accept.is_ok(), "the used action is valid in this state apart from its signatures");
        build_govern(h, used.0, used.1, 0, 0, &q, &v.next, v.value)
    };
    // Controls: each action with its own signatures.
    t.control("unpause", cross(&paused_pending, (1, &[], 7), (1, &[]), &[0, 1, 2, 3]));
    t.control("veto", cross(&paused_pending, (7, &[], 7), (7, &[]), &[2]));
    t.control("set_signers", cross(&idle, (3, &rotate, 7), (3, &rotate), &[0, 1, 2, 3]));
    t.control("propose", cross(&idle, (6, &rotate, 7), (6, &rotate), &[0, 1, 2]));

    // unpause and veto both sign empty params: at equal nonces only the action byte differs.
    t.refused("an unpause signature used as a veto", cross(&paused_pending, (1, &[], 7), (7, &[]), &[0]));
    t.refused("a veto signature (by four) used as an unpause", cross(&paused_pending, (7, &[], 7), (1, &[]), &[0, 1, 2, 3]));
    // set_signers and propose both sign the same 64 bytes.
    t.refused("set_signers signatures used as a proposal", cross(&idle, (3, &rotate, 7), (6, &rotate), &[0, 1, 2]));
    t.refused("proposal signatures (by four) used as set_signers", cross(&idle, (6, &rotate, 7), (3, &rotate), &[0, 1, 2, 3]));
    // Nonces: the previous, the next, and the other counter.
    let apart = Harness::launch_with(|s| {
        s.admin_nonce = 7;
        s.recovery_nonce = 9;
        s.paused = true;
        s.recovery_pending = true;
        s.recovery_signer_set = [3; 32];
    });
    for n in [6i64, 8, 9, 0] {
        t.refused("an unpause signed at another nonce", cross(&apart, (1, &[], n), (1, &[]), &[0, 1, 2, 3]));
    }
    for n in [8i64, 10, 7, 0] {
        t.refused("a veto signed at another nonce (7 is the admin nonce)", cross(&apart, (7, &[], n), (7, &[]), &[0]));
    }
    t.control("unpause at the admin nonce", cross(&apart, (1, &[], 7), (1, &[]), &[0, 1, 2, 3]));
    t.control("veto at the recovery nonce", cross(&apart, (7, &[], 9), (7, &[]), &[0]));
    let apart_idle = Harness::launch_with(|s| {
        s.admin_nonce = 7;
        s.recovery_nonce = 9;
    });
    t.refused("a proposal signed at the admin nonce", cross(&apart_idle, (6, &rotate, 7), (6, &rotate), &[0, 1, 2]));
    t.refused("set_signers signed at the recovery nonce", cross(&apart_idle, (3, &rotate, 9), (3, &rotate), &[0, 1, 2, 3]));
    t.control("a proposal at the recovery nonce", cross(&apart_idle, (6, &rotate, 9), (6, &rotate), &[0, 1, 2]));
    // Parameters: signatures over one value never serve another.
    let limits = |c: i64, r: i64| [le8(c), le8(r)].concat();
    t.control("set_limits", cross(&idle, (2, &limits(1_000, 5), 7), (2, &limits(1_000, 5)), &[0, 1, 2, 3]));
    t.refused("limits signed, other limits used", cross(&idle, (2, &limits(1_000, 5), 7), (2, &limits(1_000_000, 5)), &[0, 1, 2, 3]));
    t.refused("limits signed, capacity and refill swapped", cross(&idle, (2, &limits(1_000, 5), 7), (2, &limits(5, 1_000)), &[0, 1, 2, 3]));
    let skip = |c: u8, n: i64| [vec![c], le8(n).to_vec()].concat();
    t.refused("a skip signed for BSC used for Ethereum (same nonce)", cross(&idle, (4, &skip(CHAIN_BSC, 0), 7), (4, &skip(CHAIN_ETHEREUM, 0)), &[0, 1, 2, 3]));
    t.control("skip", cross(&idle, (4, &skip(CHAIN_ETHEREUM, 0), 7), (4, &skip(CHAIN_ETHEREUM, 0)), &[0, 1, 2, 3]));
    t.refused("a value signed, another used", cross(&idle, (5, &le8(200_000_000), 7), (5, &le8(100)), &[0, 1, 2, 3]));
    let other_rotate = [signer_set_of(&new_keys).to_vec(), xonly(&key(0x37)).to_vec()].concat();
    t.refused("a rotation signed, another guardian used", cross(&idle, (3, &rotate, 7), (3, &other_rotate), &[0, 1, 2, 3]));
    t.refused("a proposal signed, another guardian used", cross(&idle, (6, &rotate, 7), (6, &other_rotate), &[0, 1, 2]));
    // Another covenant ID.
    let d = unpause_digest_any(&[0x55; 32], 7, &paused_pending.minter.outpoint.transaction_id.as_bytes(), paused_pending.minter.outpoint.index);
    let v = model_govern(&paused_pending.state, 1, &[], 0, 0, MINTER_SOMPI);
    t.refused("an unpause signed for another covenant ID", build_govern(&paused_pending, 1, &[], 0, 0, &Quorum::honest(&paused_pending.signers, &[0, 1, 2, 3], &d), &v.next, v.value));

    // Spellings of the parameters: a wrong length is refused even when exactly those bytes were signed.
    let exact = |h: &Harness, action: u8, params: &[u8]| {
        let who: Vec<usize> = (0..quorum_of(action)).collect();
        let d = digest_for(h, signed_nonce(&h.state, action), action, params);
        // Offer the successor of the canonical parameters: what a builder following the action's meaning would make.
        let v = model_govern(&h.state, action, params, 0, 0, MINTER_SOMPI);
        build_govern(h, action, params, 0, 0, &Quorum::honest(&h.signers, &who, &d), &v.next, v.value)
    };
    let canonical: Vec<(&Harness, u8, Vec<u8>)> = vec![
        (&paused_pending, 1, vec![]),
        (&idle, 2, limits(1_000, 5)),
        (&idle, 3, rotate.clone()),
        (&idle, 4, skip(CHAIN_ETHEREUM, 0)),
        (&idle, 5, le8(200_000_000).to_vec()),
        (&idle, 6, rotate.clone()),
        (&paused_pending, 7, vec![]),
    ];
    for (h, action, params) in &canonical {
        t.control("the canonical parameters", exact(h, *action, params));
        let mut longer = params.clone();
        longer.push(0);
        // The successor offered is the canonical one (the extra byte changes nothing a builder would compute).
        let who: Vec<usize> = (0..quorum_of(*action)).collect();
        let d = digest_for(h, signed_nonce(&h.state, *action), *action, &longer);
        let v = model_govern(&h.state, *action, params, 0, 0, MINTER_SOMPI);
        t.refused("one more byte, signed as such", build_govern(h, *action, &longer, 0, 0, &Quorum::honest(&h.signers, &who, &d), &v.next, v.value));
        if !params.is_empty() {
            let shorter = &params[..params.len() - 1];
            let d = digest_for(h, signed_nonce(&h.state, *action), *action, shorter);
            t.refused("one byte fewer, signed as such", build_govern(h, *action, shorter, 0, 0, &Quorum::honest(&h.signers, &who, &d), &v.next, v.value));
        }
    }
    // Unknown actions, signed as such.
    for action in [0u8, 8, 9, 0x10, 0x80, 0x81, 0xff] {
        let d = digest_for(&idle, 7, action, &[]);
        let mut next = idle.state.clone();
        next.admin_nonce += 1;
        t.refused("an unknown action", build_govern(&idle, action, &[], 0, 0, &Quorum::honest(&idle.signers, &[0, 1, 2, 3], &d), &next, MINTER_SOMPI));
    }
    t.report("p3 governance signatures");
    assert_eq!((t.refused, t.controls), (4 + 8 + 2 + 2 + 1 + 3 + 1 + 7 + 5 + 7, 4 + 3 + 2 + 7));
}

#[test]
fn p3_respelled_arguments_and_array_boundaries() {
    let h = Harness::launch_with(|s| s.nonce_ethereum = 1);
    let mut t = Tally::default();
    let all = three();
    let tx = t.control("a mint of three", M::new(CHAIN_ETHEREUM, 1, &all).go(&h));
    let args = pushes(&tx.inputs[0].signature_script);
    assert_eq!(args.len(), 16, "chain, nonce, age, six recipient fields, keys, positions, signatures, two template parts, the entry tag, the program");
    println!("[p3 spellings] mint argument sizes: {:?}", args.iter().map(Vec::len).collect::<Vec<_>>());

    // Arrays: one byte more or fewer in any array argument.
    for index in 3..12 {
        let original = args[index].clone();
        let mut longer = original.clone();
        longer.push(0);
        let r = rerun(&h, with_argument(&tx, index, longer));
        println!("[p3 spellings] mint argument {index} with one more byte: {}", verdict_text(&r));
        t.refused("an array argument with a trailing byte", r);
        let mut shorter = original.clone();
        shorter.pop();
        t.refused("an array argument one byte short", rerun(&h, with_argument(&tx, index, shorter)));
    }
    // Bytes moved across the boundary of neighbouring arrays (keys | positions | signatures).
    let (keys, positions, sigs) = (args[9].clone(), args[10].clone(), args[11].clone());
    let mut forged = with_argument(&tx, 9, [keys.clone(), positions[..1].to_vec()].concat());
    forged = with_argument(&forged, 10, positions[1..].to_vec());
    t.refused("a position moved into the keys", rerun(&h, forged));
    let mut forged = with_argument(&tx, 10, [positions.clone(), sigs[..1].to_vec()].concat());
    forged = with_argument(&forged, 11, sigs[1..].to_vec());
    t.refused("a signature byte moved into the positions", rerun(&h, forged));
    // The template parts the script takes for the KCC20 outputs: a byte moved across their boundary.
    let (prefix, suffix) = (args[12].clone(), args[13].clone());
    let mut forged = with_argument(&tx, 12, [prefix.clone(), suffix[..1].to_vec()].concat());
    forged = with_argument(&forged, 13, suffix[1..].to_vec());
    t.refused("the KCC20 template split one byte later", rerun(&h, forged));
    let mut forged = with_argument(&tx, 12, prefix[..prefix.len() - 1].to_vec());
    forged = with_argument(&forged, 13, [prefix[prefix.len() - 1..].to_vec(), suffix.clone()].concat());
    t.refused("the KCC20 template split one byte earlier", rerun(&h, forged));
    let mut bent = prefix.clone();
    bent[0] ^= 1;
    t.refused("another KCC20 template", rerun(&h, with_argument(&tx, 12, bent)));
    // One more push in front, or one fewer.
    let mut extra = args.clone();
    extra.insert(0, vec![7]);
    let mut forged = tx.clone();
    forged.inputs[0].signature_script = push_script(&extra);
    t.refused("one more push in front", rerun(&h, forged));
    // The chain and the action as bytes: no second spelling.
    for spelled in [vec![1u8, 0], vec![1, 0x80], vec![]] {
        t.refused("the chain spelled otherwise", rerun(&h, with_argument(&tx, 0, spelled)));
    }

    // Numbers: the script takes padded spellings of first_nonce and age_daa (audit 2; the follower reads them since).
    // Recorded here so that the count of accepted spellings is known; the follower's side is the corpus test.
    let mut accepted = 0;
    for (index, spelled) in [(1usize, vec![1u8, 0]), (1, vec![1, 0, 0, 0, 0, 0, 0, 0]), (2, vec![1, 0]), (2, vec![1, 0, 0, 0, 0, 0, 0, 0])] {
        let forged = with_argument(&tx, index, spelled);
        assert_eq!(forged.id(), tx.id());
        if rerun(&h, forged).is_ok() {
            accepted += 1;
        }
    }
    println!("[p3 spellings] padded spellings of first_nonce / age_daa the engine accepts: {accepted} of 4");
    for (index, spelled) in [(1usize, vec![1u8, 0, 0, 0, 0, 0, 0, 0, 0]), (2, vec![1, 0, 0, 0, 0, 0, 0, 0, 0]), (1, vec![2]), (2, vec![2]), (1, vec![0x81]), (2, vec![0x81])] {
        t.refused("nine bytes, or another number", rerun(&h, with_argument(&tx, index, spelled)));
    }

    // govern: the same for its arrays, its action byte and its params.
    let hp = Harness::launch_with(|s| s.paused = true);
    let (ok, _) = honest_govern(&hp, 0x02, &[le8(1_000), le8(5)].concat(), 0);
    let gtx = t.control("set_limits", ok);
    let gargs = pushes(&gtx.inputs[0].signature_script);
    assert_eq!(gargs.len(), 8, "action, params, age, keys, positions, signatures, the entry tag, the program");
    for index in [1usize, 3, 4, 5] {
        let mut longer = gargs[index].clone();
        longer.push(0);
        let r = rerun(&hp, with_argument(&gtx, index, longer));
        println!("[p3 spellings] govern argument {index} with one more byte: {}", verdict_text(&r));
        t.refused("a govern array argument with a trailing byte", r);
        let mut shorter = gargs[index].clone();
        shorter.pop();
        t.refused("a govern array argument one byte short", rerun(&hp, with_argument(&gtx, index, shorter)));
    }
    for spelled in [vec![2u8, 0], vec![2, 0x80], vec![], vec![0x82]] {
        t.refused("the action spelled otherwise", rerun(&hp, with_argument(&gtx, 0, spelled)));
    }
    t.report("p3 spellings and boundaries");
    assert_eq!((t.refused, t.controls), (18 + 2 + 3 + 1 + 3 + 6 + 8 + 4, 2));
}

#[test]
fn p3_a_former_signer_sets_signatures_die_with_it() {
    let mut t = Tally::default();
    let r = three()[..1].to_vec();
    let new_keys: Vec<_> = (0x30..0x35).map(key).collect();
    let rotate = [signer_set_of(&new_keys).to_vec(), xonly(&key(0x36)).to_vec()].concat();

    // By set_signers and by execute_recovery.
    for by_recovery in [false, true] {
        let mut h = Harness::launch_with(|s| s.recovery_delay = 10);
        let old = h.signers.clone();
        // Signed by the old set before the change: a mint of nonce 0, and governance at the nonces the change leaves.
        let old_mint = Quorum::honest(&old, &[0, 1, 2], &mint_digest(&cov(&h), CHAIN_ETHEREUM, 0, 1, &r));
        t.control("the old set's mint before the change", {
            let mut m = M::new(CHAIN_ETHEREUM, 0, &r);
            m.quorum = Some(old_mint.clone());
            m.go(&h)
        });
        if by_recovery {
            let (tx, v) = honest_govern(&h, 0x06, &rotate, 0);
            let tx = t.control("propose", tx);
            adopt(&mut h, &tx, v.next);
            let v = model_execute(&h.state, 10, MINTER_SOMPI);
            let tx = t.control("execute", build_execute(&h, 10, &v.next, v.value));
            adopt(&mut h, &tx, v.next);
        } else {
            let (tx, v) = honest_govern(&h, 0x03, &rotate, 0);
            let tx = t.control("set_signers", tx);
            adopt(&mut h, &tx, v.next);
        }
        assert_eq!(h.state.signer_set, signer_set_of(&new_keys));
        // The old signatures with the old keys: the keys are not the set.
        let mut m = M::new(CHAIN_ETHEREUM, 0, &r);
        m.quorum = Some(old_mint.clone());
        t.refused("old signatures, old keys", m.go(&h));
        // The old signatures presented under the new keys.
        let mut m = M::new(CHAIN_ETHEREUM, 0, &r);
        m.quorum = Some(Quorum { keys: keys_of(&new_keys), ..old_mint.clone() });
        t.refused("old signatures, new keys", m.go(&h));
        // Old governance at the new nonces (the old set signs for the state as it now is).
        for (action, params) in [(0x02u8, [le8(CAP), le8(CAP)].concat()), (0x03, [signer_set_of(&old).to_vec(), xonly(&key(0x20)).to_vec()].concat()), (0x06, rotate.clone())] {
            let who: Vec<usize> = (0..quorum_of(action)).collect();
            let d = digest_for(&h, signed_nonce(&h.state, action), action, &params);
            let v = model_govern(&h.state, action, &params, 0, 0, MINTER_SOMPI);
            t.refused("the old set governs after the change", build_govern(&h, action, &params, 0, 0, &Quorum::honest(&old, &who, &d), &v.next, v.value));
        }
        // The old guardian.
        let v = model_pause(&h.state, 0, MINTER_SOMPI);
        t.refused("the old guardian pauses after the change", build_pause(&h, &key(0x20), 0, &v.next, v.value));
        t.control("the new guardian pauses", build_pause(&h, &key(0x36), 0, &v.next, v.value));
        // The new set works.
        h.signers = new_keys.clone();
        t.control("the new set mints", M::new(CHAIN_ETHEREUM, 0, &r).go(&h));
    }

    // A key that STAYS in the set keeps its outstanding mint signatures: the digest does not name the set.
    // Rotating out signer 4 only: a mint signed by 0, 1, 2 before the rotation is still good after it.
    let mut h = Harness::launch();
    let before = Quorum::honest(&h.signers, &[0, 1, 2], &mint_digest(&cov(&h), CHAIN_ETHEREUM, 0, 1, &r));
    let mut kept = h.signers.clone();
    kept[4] = key(0x34);
    let params = [signer_set_of(&kept).to_vec(), xonly(&h.guardian).to_vec()].concat();
    let (tx, v) = honest_govern(&h, 0x03, &params, 0);
    let tx = t.control("rotate out signer 4 only", tx);
    adopt(&mut h, &tx, v.next);
    let mut m = M::new(CHAIN_ETHEREUM, 0, &r);
    m.quorum = Some(Quorum { keys: keys_of(&kept), ..before });
    let survived = m.go(&h);
    println!("[p3 former set] a mint signed before a rotation by three signers who stay: {}", verdict_text(&survived));
    assert!(survived.is_ok(), "observed: signatures of keys that stay survive a rotation");
    t.report("p3 former signer sets");
    assert_eq!((t.refused, t.controls), (12, 10));
}
