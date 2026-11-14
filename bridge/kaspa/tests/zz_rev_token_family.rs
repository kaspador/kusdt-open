//! Token review, properties 5 (identity), 6 (the seed) and 7 (a covenant-id owner that names
//! kUSDT's own ID), in the script engine. The family here is a really launched one (the
//! repository's harness: genesis, minter, seed), next to fabricated coins where a test needs
//! a coin no honest flow makes.
//!
//!   cargo test --locked --test zz_rev_token_family -- --nocapture

mod common;
#[path = "zz_rev_token_support.rs"]
mod support;

use argent_runtime::{CovenantOutput, EntryCall, TxContext, args, state};
use common::{CHAIN_ETHEREUM, Harness, Recipient, SEED_SOMPI};
use kaspa_consensus_core::{
    Hash,
    hashing::{covenant_id::covenant_id, sighash_type::SIG_HASH_ALL},
    tx::{CovenantBinding, ScriptPublicKey, Transaction, UtxoEntry},
};
use secp256k1::Keypair;
use support::{Auth, Case, K, K2, Out, POOL, Rejected, Slot, State, TOKEN_SOMPI, Tok, TokIn, classify, funding, key, outpoint, refused, run, sign_schnorr, tally, xonly};

/// The tests of this file run the launched family (compiled now) and fabricated coins (the checked-in artifact) side
/// by side, so the two must be the same bytes.
#[test]
fn the_compiled_family_is_the_checked_in_artifact() {
    for contract in ["KCC20", "TokenSeed", "BridgeMint"] {
        let fresh = &common::artifact().sil_abi.contracts.get(contract).expect("compiled").compiled.bytecode;
        let checked_in = &kusdt_kaspa::tx::artifact().sil_abi.contracts.get(contract).expect("checked in").compiled.bytecode;
        assert_eq!(fresh, checked_in, "{contract}");
    }
}

/// Property 3, at the source: the signers' mint digest covers a recipient's owner scheme, owner and amount, NOT its
/// borrow fields or extension (bridge_mint.ag mint_digest), and whoever holds three signatures submits the mint. So
/// the script alone keeps a minted state plain; a deposit to a burn owner is then a burn the signers will pay.
#[test]
fn p3_a_mint_cannot_make_a_borrowable_state_whoever_submits_it() {
    let h = Harness::launch();
    let a = key(0xa1);
    let plain = Recipient::owned(xonly(&a), 1_000_000);
    h.try_mint(common::MintCase::new(CHAIN_ETHEREUM, 0, &[plain.clone()])).expect("a plain mint");
    support::count_control();
    let bent: Vec<(&str, Recipient)> = vec![
        ("borrow scheme 1", Recipient { borrow_scheme: 1, ..plain.clone() }),
        ("borrow scheme 2", Recipient { borrow_scheme: 2, ..plain.clone() }),
        ("borrow scheme 3", Recipient { borrow_scheme: 3, ..plain.clone() }),
        ("a borrow guard with borrowing off", Recipient { borrow_guard: [0x77; 32], ..plain.clone() }),
        ("a guard of one bit", Recipient { borrow_guard: { let mut g = [0u8; 32]; g[31] = 1; g }, ..plain.clone() }),
        ("an extension", Recipient { extension_commitment: [0x01; 32], ..plain.clone() }),
    ];
    for (what, recipient) in bent {
        // The three signatures are over the plain recipient (the digest is the same): only the output differs.
        let case = common::MintCase::new(CHAIN_ETHEREUM, 0, &[recipient]).signed_recipients(&[plain.clone()]);
        match h.try_mint(case) {
            Err(common::Rejected::Script(_)) => refused::<()>(Err(Rejected::Script(String::new())), what),
            Err(common::Rejected::Build(e)) => panic!("{what}: the builder failed first: {e}"),
            Ok(_) => panic!("{what}: a mint made a state that is not plain"),
        }
    }
    tally("3 borrow: minted states are plain");
}

// ---------------------------------------------------------------------------
// Property 5: identity.

fn genesis_tx(extra: Option<Tok>, minter_value: u64, seed_owner: &Keypair) -> Result<Transaction, Rejected> {
    let h = Harness::launch();
    let seed_state = state! { owner: xonly(seed_owner).to_vec(), extension_commitment: vec![0u8; 32] };
    let mut ctx = TxContext::new()
        .input(outpoint(0xf0, 0), funding(), Vec::new(), 0)
        .actor_genesis_output(0, "launch::kusdt", "BridgeMint", h.state.state(), minter_value)
        .actor_genesis_output(0, "launch::kusdt", "TokenSeed", seed_state, SEED_SOMPI);
    if let Some(tok) = extra {
        ctx = ctx.actor_genesis_output(0, "launch::kusdt", "KCC20", tok.state(), TOKEN_SOMPI);
    }
    let tx = common::builder().build(&ctx).map_err(classify)?;
    run(tx, vec![funding()])
}

fn id_of(tx: &Transaction) -> Hash {
    tx.outputs[0].covenant.expect("a covenant output").covenant_id
}

#[test]
fn p5_the_covenant_id_commits_to_every_genesis_output() {
    let h = Harness::launch();
    let honest = genesis_tx(None, common::MINTER_SOMPI, &h.guardian).expect("the genesis");
    support::count_control();
    assert_eq!(id_of(&honest), h.minter.covenant_id, "the same genesis as the harness's");
    assert_eq!(honest.outputs.iter().filter(|o| o.covenant.is_some()).count(), 2);
    // KIP-20: the ID is the hash of the authorizing outpoint and of every output of the group (index, value, script).
    let recomputed = covenant_id(outpoint(0xf0, 0), honest.outputs.iter().enumerate().take(2).map(|(i, o)| (i as u32, o)));
    assert_eq!(recomputed, h.minter.covenant_id);

    // A genesis that also makes a token state (a billion kUSDT to the deployer) is VALID to consensus: a genesis
    // runs no script. But it is another covenant ID, so a check that recomputes the ID from the minter and the seed
    // alone (mainnet-deploy.ts recomputedGenesisCovenant) cannot be passed by it.
    let thief = key(0xee);
    let premined = genesis_tx(Some(Tok::schnorr(&thief, 1_000_000_000_000_000)), common::MINTER_SOMPI, &h.guardian).expect("consensus accepts a genesis with a token output");
    support::count_control();
    assert_eq!(premined.outputs[0].script_public_key, honest.outputs[0].script_public_key, "the same minter script");
    assert_eq!(premined.outputs[1].script_public_key, honest.outputs[1].script_public_key, "the same seed script");
    assert_ne!(id_of(&premined), id_of(&honest), "a third genesis output changes the ID");
    println!("REV-TOKEN 5 identity: honest genesis ID {}, with a pre-made token output {}", id_of(&honest), id_of(&premined));
    // Other values or another seed owner: another ID too.
    assert_ne!(id_of(&genesis_tx(None, common::MINTER_SOMPI + 1, &h.guardian).unwrap()), id_of(&honest));
    assert_ne!(id_of(&genesis_tx(None, common::MINTER_SOMPI, &thief).unwrap()), id_of(&honest));

    // Three outputs claiming the two-output ID: consensus recomputes and refuses.
    let mut forged = premined.clone();
    for o in forged.outputs.iter_mut().take(3) {
        o.covenant = Some(CovenantBinding::new(0, id_of(&honest)));
    }
    refused(run(forged, vec![funding()]), "three genesis outputs under the two-output ID");
    // Two outputs under the honest ID and the token output under an ID of its own (a second group from the same
    // coin): valid, and that third output is simply not kUSDT.
    let mut split = premined.clone();
    split.outputs[0].covenant = Some(CovenantBinding::new(0, id_of(&honest)));
    split.outputs[1].covenant = Some(CovenantBinding::new(0, id_of(&honest)));
    let own = covenant_id(outpoint(0xf0, 0), std::iter::once((2u32, &premined.outputs[2])));
    split.outputs[2].covenant = Some(CovenantBinding::new(0, own));
    run(split, vec![funding()]).expect("two groups from one coin");
    support::count_control();
    assert_ne!(own, id_of(&honest));
    // After the launch: an output bound to kUSDT's ID that no family input authorizes is a 'genesis' with the wrong ID.
    let later = TxContext::new()
        .input(outpoint(0xf3, 0), funding(), Vec::new(), 0)
        .output(Tok::schnorr(&thief, 1_000_000).spk(), Some(CovenantBinding::new(0, id_of(&honest))), TOKEN_SOMPI);
    refused(common::builder().build(&later).map_err(classify).and_then(|tx| run(tx, vec![funding()])), "a token output under kUSDT's ID from a plain coin");
    tally("5 identity: the genesis and the covenant ID");
}

/// kUSDT minted by the launched family, as a coin and the state it holds.
fn minted(h: &mut Harness, nonce: i64, tok: &Tok) -> (CovenantOutput, [u8; 32]) {
    let recipient = Recipient { amount: tok.amount, owner: tok.owner, owner_scheme: tok.scheme, borrow_scheme: tok.borrow, borrow_guard: tok.guard, extension_commitment: tok.ext };
    let tx = h.mint(CHAIN_ETHEREUM, nonce, &[recipient], &[0, 1, 2]).expect("a mint");
    let out = common::covenant_output(&tx, 1);
    let id = out.covenant_id.as_bytes();
    assert_eq!(out.utxo.script_public_key, tok.utxo(id, out.utxo.amount).script_public_key, "the minted coin is the script the harness fabricates");
    (out, id)
}

#[test]
fn p5_a_minted_state_only_joins_its_own_family() {
    let mut h = Harness::launch();
    let (a, b, forger) = (key(0xa1), key(0xb1), key(0xee));
    let (coin, id) = minted(&mut h, 0, &Tok::schnorr(&a, 1_000_000));
    let real = TokIn::of(&a, 1_000_000).cov(id).value(coin.utxo.amount);
    assert_eq!(real.utxo(), UtxoEntry::new(coin.utxo.amount, coin.utxo.script_public_key.clone(), 0, false, Some(coin.covenant_id)));
    let out = |tok: &Tok| Out::tok(tok).cov(id);
    // Control: the real state moves, alone and joined by another real one.
    let next = vec![Tok::schnorr(&b, 1_000_000)];
    Case::new(vec![Slot::leader(real.clone(), &next), Slot::funding()], next.iter().map(out).collect()).accepted("minted kUSDT moves");
    // A look-alike: the same script, a large amount, under a covenant ID the forger made.
    let fake = TokIn::of(&forger, 900_000_000).cov(K2);
    let next = vec![Tok::schnorr(&forger, 901_000_000)];
    Case::new(vec![Slot::leader(real.clone(), &next), Slot::Delegate(fake.clone()), Slot::funding()], next.iter().map(out).collect()).refused("a look-alike as the delegate of real kUSDT");
    Case::new(vec![Slot::leader(fake.clone(), &next), Slot::Delegate(real.clone()), Slot::funding()], next.iter().map(out).collect()).refused("real kUSDT as the delegate of a look-alike, outputs under kUSDT's ID");
    let next = vec![Tok::schnorr(&forger, 900_000_000)];
    Case::new(vec![Slot::leader(fake.clone(), &next), Slot::funding()], next.iter().map(out).collect()).refused("a look-alike's outputs under kUSDT's ID");
    Case::new(vec![Slot::leader(fake.clone(), &next), Slot::funding()], next.iter().map(|t| Out::tok(t).cov(K2)).collect()).accepted("the look-alike moves under its own ID, where it is worth nothing");
    // (The minter and the seed next to a transfer: p5_a_token_cannot_move_inside_a_mint and p6_the_seed_only_makes_empty_states.)
    tally("5 identity: real kUSDT and a look-alike under another ID");
}

// -- The pool's view of kUSDT ------------------------------------------------

const KAS: i64 = 100_000_000;
const USDT: i64 = 1_000_000;
const BASE: i64 = KAS;
const X: i64 = 10_000 * KAS;
const Y: i64 = 1_000 * USDT;

fn pool_state(token_covid: [u8; 32], x: i64, y: i64, pt: i64, window: (i64, i64)) -> State {
    state! {
        token_covid: token_covid.to_vec(),
        kas_reserve: x,
        token_reserve: y,
        total_shares: X,
        protocol_kas: 0i64,
        protocol_tokens: pt,
        base_value: BASE,
        admin: xonly(&key(0x30)).to_vec(),
        max_out_bps: 1_000i64,
        window_len: 36_000i64,
        window_credit: 0i64,
        window_ref: window.0,
        window_out: window.1,
        paused: false,
        guardian: xonly(&key(0x32)).to_vec()
    }
}

fn position_state(token_covid: [u8; 32], owner: &Keypair) -> State {
    state! { token_covid: token_covid.to_vec(), shares: X - 1_000, owner: xonly(owner).to_vec() }
}

fn reserve(amount: i64) -> Tok {
    Tok::new(0x04, POOL, amount)
}

/// A sell of 1 kUSDT into a pool that trades the token `K`. `reserve_cov` and `payer_cov` are the covenant IDs of
/// the two token coins spent; the token outputs are bound to `out_cov`.
fn sell(reserve_cov: [u8; 32], payer_cov: [u8; 32], out_cov: [u8; 32]) -> Result<Transaction, Rejected> {
    let (tx, utxos) = bent_sell(reserve_cov, payer_cov, out_cov)?;
    run(tx, utxos)
}

fn bent_sell(reserve_cov: [u8; 32], payer_cov: [u8; 32], out_cov: [u8; 32]) -> Result<(Transaction, Vec<UtxoEntry>), Rejected> {
    // The builder refuses to assemble a sell whose token coins are not the pool's token, so the honest sell is built
    // and then bent by hand: the coins' covenant IDs and the outputs' bindings are replaced, and the seller signs again.
    let (mut tx, mut utxos) = honest_sell()?;
    utxos[1].covenant_id = Some(Hash::from_bytes(reserve_cov));
    utxos[2].covenant_id = Some(Hash::from_bytes(payer_cov));
    for o in tx.outputs.iter_mut().skip(1) {
        o.covenant = Some(CovenantBinding::new(1, Hash::from_bytes(out_cov)));
    }
    let signable = kaspa_consensus_core::tx::MutableTransaction::with_entries(tx.clone(), utxos.clone());
    let signature = sign_schnorr(&signable, 2, &key(0xc0), SIG_HASH_ALL);
    Ok((support::with_push(&tx, 2, 0, signature), utxos))
}

fn honest_sell() -> Result<(Transaction, Vec<UtxoEntry>), Rejected> {
    let (reserve_cov, payer_cov, out_cov) = (K, K, K);
    let b = support::pool_builder();
    let seller = key(0xc0);
    let (tokens_in, held) = (USDT, 100 * USDT);
    let eff = tokens_in as i128 * 9_950 / 10_000;
    let kas_out = (X as i128 * eff / (Y as i128 + eff)) as i64;
    let cut = tokens_in * 5 / 10_000;
    let before = pool_state(K, X, Y, 0, (X, 0));
    let after = pool_state(K, X - kas_out, Y + tokens_in - cut, cut, (X - kas_out, kas_out));
    let reserve_out = reserve(Y + tokens_in);
    let change = Tok::schnorr(&seller, held - tokens_in);
    let payer = Tok::schnorr(&seller, held);
    let pool_utxo = b.covenant_utxo("Pool", before.clone(), (BASE + X) as u64, 0, false, Some(Hash::from_bytes(POOL))).unwrap();
    let reserve_utxo = b.covenant_utxo("kusdt::KCC20", reserve(Y).state(), KAS as u64, 0, false, Some(Hash::from_bytes(reserve_cov))).unwrap();
    let payer_utxo = b.covenant_utxo("kusdt::KCC20", payer.state(), KAS as u64, 0, false, Some(Hash::from_bytes(payer_cov))).unwrap();
    let next = vec![reserve_out.state(), change.state()];
    let ctx = TxContext::new()
        .actor_input("Pool", before, EntryCall::new("sell").args(args!(kas_out, 0i64, change.state())), outpoint(0x40, 0), pool_utxo.clone(), 0)
        .actor_input("kusdt::KCC20", reserve(Y).state(), EntryCall::new("transfer").args(args!(next, vec![0x00u8])), outpoint(0x41, 0), reserve_utxo.clone(), 0)
        .actor_input("kusdt::KCC20", payer.state(), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_schnorr(tx, i, &seller, SIG_HASH_ALL))), outpoint(0x42, 0), payer_utxo.clone(), 0)
        .actor_output("Pool", after, CovenantBinding::new(0, Hash::from_bytes(POOL)), (BASE + X - kas_out) as u64)
        .actor_output("kusdt::KCC20", reserve_out.state(), CovenantBinding::new(1, Hash::from_bytes(out_cov)), KAS as u64)
        .actor_output("kusdt::KCC20", change.state(), CovenantBinding::new(1, Hash::from_bytes(out_cov)), KAS as u64);
    let tx = b.build(&ctx).map_err(classify)?;
    let utxos = vec![pool_utxo, reserve_utxo, payer_utxo];
    Ok((run(tx, utxos.clone())?, utxos))
}

#[test]
fn p5_the_pool_takes_only_its_own_token_id() {
    honest_sell().expect("the honest sell");
    support::count_control();
    sell(K, K, K).expect("the honest sell, through the bending helper (nothing bent)");
    support::count_control();
    // Everything on the token side under another covenant ID: the token script itself is satisfied (the look-alike
    // family conserves, the pool's presence stands for the reserve's owner), so only the pool's own rule can refuse.
    let why = match sell(K2, K2, K2) {
        Err(Rejected::Script(e)) => e,
        other => panic!("expected an engine refusal, got {:?}", other.map(|_| "ACCEPTED")),
    };
    println!("REV-TOKEN 5 identity: the look-alike sell is refused with: {why}");
    assert!(why.contains("input 0"), "the pool's script (input 0) refuses: {why}");
    // And it is the only one that does: the look-alike token scripts (inputs 1 and 2) are satisfied by themselves.
    let (tx, utxos) = bent_sell(K2, K2, K2).unwrap();
    argent_runtime::execute_input_with_covenants(&tx, utxos.clone(), 1).expect("the look-alike reserve's script passes");
    argent_runtime::execute_input_with_covenants(&tx, utxos.clone(), 2).expect("the look-alike payer's script passes");
    assert!(argent_runtime::execute_input_with_covenants(&tx, utxos, 0).is_err());
    refused(sell(K2, K2, K2), "a look-alike reserve and payer: KAS for a token that is not kUSDT");
    // Mixtures.
    refused(sell(K, K2, K), "real reserve, look-alike payer");
    refused(sell(K2, K, K), "look-alike reserve, real payer");
    refused(sell(K2, K, K2), "look-alike reserve, real payer, outputs under the look-alike's ID");
    refused(sell(K, K, K2), "real coins, outputs under another ID");
    tally("5 identity: the pool's `observes token` rule");
}

// ---------------------------------------------------------------------------
// Property 7: a covenant-id owner that names kUSDT's own covenant ID.

#[test]
fn p7_a_state_owned_by_kusdts_own_covenant_id_is_anyones() {
    let mut h = Harness::launch();
    let thief = key(0xee);
    // A deposit may name any owner (SPEC §4): scheme 0x04 with kUSDT's own covenant ID. The minter mints it.
    let id = h.minter.covenant_id.as_bytes();
    let trap = Tok::new(0x04, id, 5_000_000);
    let (coin, _) = minted(&mut h, 0, &trap);
    let out = |tok: &Tok| Out::tok(tok).cov(id);
    // Anyone moves it: no key, and no other kUSDT in the transaction. The state is itself an input of the family
    // that owns it, so `OpCovInputCount(owner) > 0` holds for the state alone.
    let next = vec![Tok::schnorr(&thief, 5_000_000)];
    let (tx, _) = Case::new(vec![Slot::leader(TokIn::new(trap.clone(), Auth::none()).cov(id).value(coin.utxo.amount), &next), Slot::funding()], next.iter().map(out).collect())
        .accepted("a stranger with no kUSDT takes a state owned by kUSDT's covenant ID");
    assert_eq!(tx.inputs.len(), 2, "the state and a fee coin");
    // The same as a delegate of the stranger's own state.
    let next = vec![Tok::schnorr(&thief, 5_000_001)];
    Case::new(vec![Slot::leader(TokIn::of(&thief, 1).cov(id), &next), Slot::Delegate(TokIn::new(trap.clone(), Auth::none()).cov(id)), Slot::funding()], next.iter().map(out).collect())
        .accepted("the same, joined to the stranger's own kUSDT");

    // What that does NOT reach: a state owned by ANOTHER covenant ID (the pool's reserve). Same two shapes.
    let pool_reserve = reserve(1_000 * USDT);
    let next = vec![Tok::schnorr(&thief, 1_000 * USDT)];
    Case::new(vec![Slot::leader(TokIn::new(pool_reserve.clone(), Auth::none()).cov(id), &next), Slot::funding()], next.iter().map(out).collect()).refused("the pool's reserve taken with no pool input");
    let next = vec![Tok::schnorr(&thief, 1_000 * USDT + 1)];
    Case::new(vec![Slot::leader(TokIn::of(&thief, 1).cov(id), &next), Slot::Delegate(TokIn::new(pool_reserve.clone(), Auth::none()).cov(id)), Slot::funding()], next.iter().map(out).collect())
        .refused("the pool's reserve joined to a stranger's kUSDT");
    // With the trap state itself in the transaction (a member of kUSDT's family, satisfied by itself): still not the reserve.
    let next = vec![Tok::schnorr(&thief, 1_000 * USDT + 5_000_000)];
    Case::new(
        vec![Slot::leader(TokIn::new(trap.clone(), Auth::none()).cov(id), &next), Slot::Delegate(TokIn::new(pool_reserve.clone(), Auth::none()).cov(id)), Slot::funding()],
        next.iter().map(out).collect(),
    )
    .refused("the pool's reserve joined to a state owned by kUSDT's ID");
    // Nor the minter: it is not a token state, and no owner rule applies to it (p5 above shows it cannot join a transfer).
    tally("7 a covenant-id owner naming kUSDT's own ID");
}

/// The reserve is owned by the POOL's covenant ID, so any input of the pool's family stands for its owner. The one
/// member an outsider holds is a liquidity position; its own script refuses to move next to any kUSDT.
#[test]
fn p7_a_liquidity_position_does_not_open_the_reserve() {
    let b = support::pool_builder();
    let (lp, thief) = (key(0xa1), key(0xee));
    let position = position_state(K, &lp);
    let position_utxo = b.covenant_utxo("Position", position.clone(), 50_000_000, 0, false, Some(Hash::from_bytes(POOL))).unwrap();
    let moved = position_state(K, &thief);
    let transfer = |with_reserve: bool| -> Result<Transaction, Rejected> {
        let signer = lp;
        let new_owner = xonly(&thief).to_vec();
        let mut ctx = TxContext::new().actor_input(
            "Position",
            position.clone(),
            EntryCall::new("transfer").args_with(move |tx, i| args!(new_owner.clone(), sign_schnorr(tx, i, &signer, SIG_HASH_ALL))),
            outpoint(0x50, 0),
            position_utxo.clone(),
            0,
        );
        let mut utxos = vec![position_utxo.clone()];
        let stolen = Tok::schnorr(&thief, Y);
        if with_reserve {
            let reserve_utxo = b.covenant_utxo("kusdt::KCC20", reserve(Y).state(), KAS as u64, 0, false, Some(Hash::from_bytes(K))).unwrap();
            ctx = ctx.actor_input("kusdt::KCC20", reserve(Y).state(), EntryCall::new("transfer").args(args!(vec![stolen.state()], vec![0x00u8])), outpoint(0x51, 0), reserve_utxo.clone(), 0);
            utxos.push(reserve_utxo);
        }
        ctx = ctx.input(outpoint(0x52, 0), funding(), Vec::new(), 0).actor_output("Position", moved.clone(), CovenantBinding::new(0, Hash::from_bytes(POOL)), 50_000_000);
        utxos.push(funding());
        if with_reserve {
            ctx = ctx.actor_output("kusdt::KCC20", stolen.state(), CovenantBinding::new(1, Hash::from_bytes(K)), KAS as u64);
        }
        let tx = b.build(&ctx).map_err(classify)?;
        run(tx, utxos)
    };
    transfer(false).expect("a position moves to a new owner");
    support::count_control();
    refused(transfer(true), "a position transfer next to the reserve");
    tally("7 the pool's reserve and a liquidity position");
}

// ---------------------------------------------------------------------------
// Property 6: the seed.

fn seed_state(owner: &Keypair) -> State {
    state! { owner: xonly(owner).to_vec(), extension_commitment: vec![0u8; 32] }
}

/// `create(recipient)` on the launched seed. `declared` is the argument, `held` the state of the output.
fn create(h: &Harness, declared: &Tok, held: &Tok, bend: impl FnOnce(&mut SeedBend)) -> Result<Transaction, Rejected> {
    let mut how = SeedBend { seeder_value: h.seed.utxo.amount, seeder_owner: h.guardian, extra: None, recipient_cov: h.seed.covenant_id, joined: None };
    bend(&mut how);
    let id = h.seed.covenant_id;
    let mut ctx = TxContext::new().actor_input("TokenSeed", seed_state(&h.guardian), EntryCall::new("create").args(args!(declared.state())), h.seed.outpoint, h.seed.utxo.clone(), 0);
    let mut utxos = vec![h.seed.utxo.clone()];
    if let Some((tok, owner)) = &how.joined {
        let utxo = tok.utxo(id.as_bytes(), TOKEN_SOMPI);
        let owner = *owner;
        let next = vec![tok.state()];
        ctx = ctx.actor_input("KCC20", tok.state(), EntryCall::new("transfer").args_with(move |tx, i| args!(next.clone(), [vec![0u8], sign_schnorr(tx, i, &owner, SIG_HASH_ALL)].concat())), outpoint(0x61, 0), utxo.clone(), 0);
        utxos.push(utxo);
    }
    ctx = ctx
        .input(outpoint(0x62, 0), funding(), Vec::new(), 0)
        .actor_output("TokenSeed", seed_state(&how.seeder_owner), CovenantBinding::new(0, id), how.seeder_value)
        .actor_output("KCC20", held.state(), CovenantBinding::new(0, how.recipient_cov), TOKEN_SOMPI);
    utxos.push(funding());
    if let Some(tok) = &how.extra {
        ctx = ctx.actor_output("KCC20", tok.state(), CovenantBinding::new(0, id), TOKEN_SOMPI);
    }
    if let Some((tok, _)) = &how.joined {
        ctx = ctx.actor_output("KCC20", tok.state(), CovenantBinding::new(1, id), TOKEN_SOMPI);
    }
    let tx = common::builder().build(&ctx).map_err(classify)?;
    run(tx, utxos)
}

struct SeedBend {
    seeder_value: u64,
    seeder_owner: Keypair,
    extra: Option<Tok>,
    recipient_cov: Hash,
    joined: Option<(Tok, Keypair)>,
}

#[test]
fn p6_the_seed_only_makes_empty_states() {
    let h = Harness::launch();
    let (anyone, victim) = (key(0xee), key(0xc1));
    // Anyone (no signature at all) makes an empty state for any owner, scheme and borrow setting.
    for scheme in 0u8..=4 {
        for borrow in 0u8..=3 {
            let empty = Tok::new(scheme, xonly(&victim), 0).borrow(borrow, [0x44; 32]);
            create(&h, &empty, &empty, |_| {}).expect("an empty state");
            support::count_control();
        }
    }
    let empty = Tok::schnorr(&victim, 0);
    // Never a state that holds something.
    for amount in [1i64, 1_000_000, i64::MAX, -1] {
        let full = Tok::schnorr(&anyone, amount);
        refused(create(&h, &full, &full, |_| {}), &format!("the seed asked for a state of {amount}"));
        refused(create(&h, &empty, &full, |_| {}), &format!("declared empty, the output holds {amount}"));
    }
    refused(create(&h, &empty.clone().ext([1; 32]), &empty.clone().ext([1; 32]), |_| {}), "an empty state of another extension");
    refused(create(&h, &Tok::new(5, [0; 32], 0), &Tok::new(5, [0; 32], 0), |_| {}), "owner scheme 5");
    refused(create(&h, &empty.clone().borrow(4, [0; 32]), &empty.clone().borrow(4, [0; 32]), |_| {}), "borrow scheme 4");
    // The seed itself must come out unchanged.
    refused(create(&h, &empty, &empty, |b| b.seeder_value -= 1), "the seed's KAS reduced by one sompi");
    refused(create(&h, &empty, &empty, |b| b.seeder_value += 1), "the seed's KAS raised");
    refused(create(&h, &empty, &empty, |b| b.seeder_owner = anyone), "the seed's owner replaced");
    // No second state, in or out of the family, and no token moving alongside.
    refused(create(&h, &empty, &empty, |b| b.extra = Some(Tok::schnorr(&anyone, 0))), "two states from one create");
    refused(create(&h, &empty, &empty, |b| b.extra = Some(Tok::schnorr(&anyone, 1_000_000))), "a second state holding 1 kUSDT");
    refused(create(&h, &empty, &empty, |b| b.recipient_cov = Hash::from_bytes(K2)), "the new state bound to another covenant ID");
    // A token moving in the same transaction as a create (the builder refuses to assemble it, so by hand): the token
    // is one that needs no signature (owned by the family's own covenant ID, see p7), taken from an accepted transfer
    // of its own and appended to an accepted create.
    let id = h.seed.covenant_id.as_bytes();
    let open = Tok::new(0x04, id, 5);
    let (moved, moved_utxos) = Case::new(vec![Slot::leader(TokIn::new(open.clone(), Auth::none()).cov(id), &[open.clone()])], vec![Out::tok(&open).cov(id)]).accepted("the open token moves by itself");
    let created = create(&h, &empty, &empty, |_| {}).expect("a create");
    support::count_control();
    let mut both = created.clone();
    both.inputs.push(moved.inputs[0].clone());
    let mut out = moved.outputs[0].clone();
    out.covenant = Some(CovenantBinding::new(2, h.seed.covenant_id));
    both.outputs.push(out);
    refused(run(both, vec![h.seed.utxo.clone(), funding(), moved_utxos[0].clone()]), "a token transfer in the same transaction as a create");
    // The same with the token first, so that it is the family's first input.
    let mut both = moved.clone();
    both.inputs.extend(created.inputs.iter().cloned());
    for o in created.outputs.iter() {
        let mut o = o.clone();
        o.covenant = o.covenant.map(|c| CovenantBinding::new(1, c.covenant_id));
        both.outputs.push(o);
    }
    refused(run(both, vec![moved_utxos[0].clone(), h.seed.utxo.clone(), funding()]), "a create in the same transaction as a token transfer");
    tally("6 the seed: create");
}

#[test]
fn p6_seed_upkeep_and_what_an_empty_state_is_worth() {
    let h = Harness::launch();
    let id = h.seed.covenant_id;
    let (anyone, victim) = (key(0xee), key(0xc1));
    let b = common::builder();
    let seed = |owner: &Keypair, value: u64| (seed_state(owner), value);
    // split: anyone, a second seed for a key of their choosing; the first is unchanged.
    let split = |second: (State, u64), first_value: u64| -> Result<Transaction, Rejected> {
        let ctx = TxContext::new()
            .actor_input("TokenSeed", seed_state(&h.guardian), EntryCall::new("split").args(args!(xonly(&anyone).to_vec())), h.seed.outpoint, h.seed.utxo.clone(), 0)
            .input(outpoint(0x63, 0), funding(), Vec::new(), 0)
            .actor_output("TokenSeed", seed_state(&h.guardian), CovenantBinding::new(0, id), first_value)
            .actor_output("TokenSeed", second.0, CovenantBinding::new(0, id), second.1);
        run(b.build(&ctx).map_err(classify)?, vec![h.seed.utxo.clone(), funding()])
    };
    let tx = split(seed(&anyone, 30_000_000), h.seed.utxo.amount).expect("anyone splits the seed");
    support::count_control();
    refused(split(seed(&anyone, 30_000_000), h.seed.utxo.amount - 1), "a split that takes KAS from the seed");
    refused(split(seed(&victim, 30_000_000), h.seed.utxo.amount), "a split whose second seed is not the declared key's");
    refused(split((state! { owner: xonly(&anyone).to_vec(), extension_commitment: vec![1u8; 32] }, 30_000_000), h.seed.utxo.amount), "a second seed of another extension");
    let (first, second) = (common::covenant_output(&tx, 0), common::covenant_output(&tx, 1));

    // rebalance_value: the seed's owner only.
    let rebalance = |signer: Keypair, coin: &CovenantOutput, owner: &Keypair| -> Result<Transaction, Rejected> {
        let ctx = TxContext::new()
            .actor_input("TokenSeed", seed_state(owner), EntryCall::new("rebalance_value").args_with(move |tx, i| args!(sign_schnorr(tx, i, &signer, SIG_HASH_ALL))), coin.outpoint, coin.utxo.clone(), 0)
            .actor_output("TokenSeed", seed_state(owner), CovenantBinding::new(0, id), coin.utxo.amount - 1_000_000);
        run(b.build(&ctx).map_err(classify)?, vec![coin.utxo.clone()])
    };
    rebalance(h.guardian, &first, &h.guardian).expect("the owner rebalances");
    support::count_control();
    refused(rebalance(anyone, &first, &h.guardian), "a stranger takes KAS out of the launch seed");

    // reclaim: a seed retires into another with its own owner's signature; the stranger can retire only their own.
    let reclaim = |retiring: &CovenantOutput, retiring_owner: &Keypair, signer: Keypair| -> Result<Transaction, Rejected> {
        let ctx = TxContext::new()
            .actor_input("TokenSeed", seed_state(&h.guardian), EntryCall::new("reclaim"), first.outpoint, first.utxo.clone(), 0)
            .actor_input("TokenSeed", seed_state(retiring_owner), EntryCall::new("reclaim_delegator").args_with(move |tx, i| args!(sign_schnorr(tx, i, &signer, SIG_HASH_ALL))), retiring.outpoint, retiring.utxo.clone(), 0)
            .actor_output("TokenSeed", seed_state(&h.guardian), CovenantBinding::new(0, id), first.utxo.amount);
        run(b.build(&ctx).map_err(classify)?, vec![first.utxo.clone(), retiring.utxo.clone()])
    };
    reclaim(&second, &anyone, anyone).expect("the stranger retires their own seed");
    support::count_control();
    refused(reclaim(&second, &anyone, victim), "a seed retired without its owner");

    // An empty state is an ordinary state holding nothing: only its owner moves it, and it adds nothing to a transfer.
    let empty = Tok::schnorr(&victim, 0);
    let out = |tok: &Tok| Out::tok(tok).cov(id.as_bytes());
    let made = create(&h, &empty, &empty, |_| {}).expect("an empty state for the victim");
    support::count_control();
    let empty_in = |auth: Auth| TokIn::new(empty.clone(), auth).cov(id.as_bytes()).value(made.outputs[1].value);
    assert_eq!(empty_in(Auth::none()).utxo().script_public_key, made.outputs[1].script_public_key);
    let next = vec![Tok::schnorr(&anyone, 0)];
    Case::new(vec![Slot::leader(empty_in(Auth::key(&anyone)), &next), Slot::funding()], next.iter().map(out).collect()).refused("a stranger moves the victim's empty state");
    Case::new(vec![Slot::leader(empty_in(Auth::key(&victim)), &next), Slot::funding()], next.iter().map(out).collect()).accepted("the victim moves it");
    let next = vec![Tok::schnorr(&anyone, 1)];
    Case::new(vec![Slot::leader(empty_in(Auth::key(&victim)), &next), Slot::funding()], next.iter().map(out).collect()).refused("an empty state turned into one unit");
    let next = vec![Tok::schnorr(&anyone, 8)];
    Case::new(vec![Slot::leader(TokIn::of(&anyone, 7).cov(id.as_bytes()), &next), Slot::Delegate(empty_in(Auth::key(&victim))), Slot::funding()], next.iter().map(out).collect()).refused("7 + an empty state -> 8");
    tally("6 the seed: split, rebalance, reclaim, empty states");
    let _ = ScriptPublicKey::from_vec(0, vec![]);
}

// ---------------------------------------------------------------------------
// Property 5, the link that makes every family member a known script: the minter and the seed create KCC20 outputs
// from a template (prefix, suffix) that arrives in the WITNESS, which nobody signs. A create needs no signature at
// all, so if any other (prefix, suffix) passed, anyone could put a script of their own under kUSDT's covenant ID, and
// a family member with a free script can authorize token states of any amount.

/// The KCC20 template as the checked-in artifact has it: the bytes before the state span, the template hash that
/// opens the span, and the bytes after it.
fn kcc20_template() -> (Vec<u8>, [u8; 32], Vec<u8>) {
    let compiled = &kusdt_kaspa::tx::artifact().sil_abi.contracts.get("KCC20").expect("KCC20").compiled;
    let (at, len) = (compiled.state_span.offset, compiled.state_span.len);
    assert_eq!(len, 33 + 112, "the template hash and the six state fields");
    let hash: [u8; 32] = compiled.template_hash.as_ref().try_into().expect("32 bytes");
    (compiled.bytecode[..at].to_vec(), hash, compiled.bytecode[at + len..].to_vec())
}

fn program_with(prefix: &[u8], hash: &[u8; 32], tok: &Tok, suffix: &[u8]) -> Vec<u8> {
    [prefix, &[0x20], hash.as_slice(), &tok.encoded(), suffix].concat()
}

/// `tx` creates the KCC20 state `tok` at output `output` from input 0, whose signature script carries the template.
/// Tries every bent template, with the output's script made to match each, and counts the engine's refusals.
fn bend_template(what: &str, tx: &Transaction, utxos: &[UtxoEntry], output: usize, tok: &Tok) {
    let (prefix, hash, suffix) = kcc20_template();
    assert_eq!(tx.outputs[output].script_public_key, kaspa_txscript::pay_to_script_hash_script(&program_with(&prefix, &hash, tok, &suffix)), "{what}: the honest output is the template around the state");
    let items = support::pushes(&tx.inputs[0].signature_script);
    let at_prefix = items.iter().rposition(|p| *p == prefix).expect("the prefix is an argument");
    let at_suffix = items.iter().rposition(|p| *p == suffix).expect("the suffix is an argument");
    assert_eq!(at_suffix, at_prefix + 1);
    let with = |prefix: &[u8], suffix: &[u8], program: Vec<u8>| {
        let mut bent = tx.clone();
        let mut all = items.clone();
        all[at_prefix] = prefix.to_vec();
        all[at_suffix] = suffix.to_vec();
        bent.inputs[0].signature_script = support::push_script(&all);
        bent.outputs[output].script_public_key = kaspa_txscript::pay_to_script_hash_script(&program);
        run(bent, utxos.to_vec())
    };
    // Control: the same surgery with nothing changed.
    with(&prefix, &suffix, program_with(&prefix, &hash, tok, &suffix)).unwrap_or_else(|e| panic!("{what}: the unchanged template was refused: {e:?}"));
    support::count_control();

    let mut cases: Vec<(String, Vec<u8>, Vec<u8>)> = Vec::new();
    // The same bytes, cut elsewhere: the state would land at another place in the code.
    let whole = [prefix.clone(), suffix.clone()].concat();
    for cut in [0usize, 2, 3, 34, 100, whole.len() - 1, whole.len()] {
        cases.push((format!("the same code cut at byte {cut}"), whole[..cut].to_vec(), whole[cut..].to_vec()));
    }
    // Other code.
    let mut flipped = suffix.clone();
    *flipped.last_mut().unwrap() ^= 0x01;
    cases.push(("the last byte of the suffix changed".into(), prefix.clone(), flipped));
    let mut flipped = suffix.clone();
    flipped[0] ^= 0x01;
    cases.push(("the first byte of the suffix changed".into(), prefix.clone(), flipped));
    cases.push(("another first opcode".into(), vec![0x61], suffix.clone()));
    cases.push(("a suffix one byte shorter".into(), prefix.clone(), suffix[..suffix.len() - 1].to_vec()));
    cases.push(("a suffix one byte longer".into(), prefix.clone(), [suffix.clone(), vec![0x61]].concat()));
    // A script anyone can spend: drop the state's pushes and leave TRUE.
    cases.push(("an anyone-can-spend script".into(), vec![], [vec![0x75; 7], vec![0x51]].concat()));
    cases.push(("no code at all".into(), vec![], vec![]));
    cases.push(("OP_TRUE after the state".into(), vec![], vec![0x51]));
    for (name, p, s) in cases {
        let program = program_with(&p, &hash, tok, &s);
        refused(with(&p, &s, program), &format!("{what}: {name}"));
    }
    // The honest template in the witness, another script in the output.
    refused(with(&prefix, &suffix, vec![0x51]), &format!("{what}: the output is OP_TRUE"));
    refused(with(&prefix, &suffix, program_with(&prefix, &[0u8; 32], tok, &suffix)), &format!("{what}: the output carries another template hash"));
    let mut other = suffix.clone();
    other[10] ^= 0x01;
    refused(with(&prefix, &suffix, program_with(&prefix, &hash, tok, &other)), &format!("{what}: the output's code differs in one byte"));
}

#[test]
fn p5_the_template_in_a_create_or_a_mint_witness_cannot_be_bent() {
    let h = Harness::launch();
    // The seed: no signature anywhere in the transaction.
    let empty = Tok::schnorr(&key(0xee), 0);
    let created = create(&h, &empty, &empty, |_| {}).expect("a create");
    bend_template("create", &created, &[h.seed.utxo.clone(), funding()], 1, &empty);
    // The minter: three signatures over (chain, nonce, age, owners, amounts), not over the template.
    let minted = Tok::schnorr(&key(0xa1), 1_000_000);
    let (tx, _) = h.try_mint(common::MintCase::new(CHAIN_ETHEREUM, 0, &[Recipient::owned(minted.owner, minted.amount)])).map_err(|e| format!("{e:?}")).expect("a mint");
    bend_template("mint", &tx, &[h.minter.utxo.clone(), common::funding()], 1, &minted);
    tally("5 identity: the KCC20 template in the minter's and the seed's witness");
}

/// The minter's script does not count the family's inputs (bridge_mint.ag has no such rule), so what keeps a token
/// state from moving inside a mint (where the minter's outputs would be extra family outputs) is the token script.
/// A token that needs no signature (owned by the family's own ID) is merged into a real mint, in both input orders.
#[test]
fn p5_a_token_cannot_move_inside_a_mint() {
    let h = Harness::launch();
    let id = h.minter.covenant_id.as_bytes();
    let (mint, _) = h.try_mint(common::MintCase::new(CHAIN_ETHEREUM, 0, &[Recipient::owned(xonly(&key(0xa1)), 1_000_000)])).map_err(|e| format!("{e:?}")).expect("a mint");
    let mint_utxos = vec![h.minter.utxo.clone(), common::funding()];
    run(mint.clone(), mint_utxos.clone()).expect("the mint alone");
    support::count_control();
    let open = Tok::new(0x04, id, 5);
    let grown = Tok::new(0x04, id, 5);
    let (moved, moved_utxos) = Case::new(vec![Slot::leader(TokIn::new(open.clone(), Auth::none()).cov(id), &[grown.clone()])], vec![Out::tok(&grown).cov(id)]).accepted("the open token alone");

    // The mint first, the token after it.
    let mut after = mint.clone();
    after.inputs.push(moved.inputs[0].clone());
    let mut out = moved.outputs[0].clone();
    out.covenant = Some(CovenantBinding::new(2, h.minter.covenant_id));
    after.outputs.push(out);
    let after_utxos = [mint_utxos.clone(), moved_utxos.clone()].concat();
    argent_runtime::execute_input_with_covenants(&after, after_utxos.clone(), 0).expect("the minter's own script has nothing against company");
    assert!(argent_runtime::execute_input_with_covenants(&after, after_utxos.clone(), 2).is_err(), "the token's script refuses");
    refused(run(after, after_utxos), "a token after the minter");

    // The token first: it is the family's first input, and the minter would be its 'delegate'.
    let mut before = moved.clone();
    before.inputs.extend(mint.inputs.iter().cloned());
    for o in &mint.outputs {
        let mut o = o.clone();
        o.covenant = o.covenant.map(|c| CovenantBinding::new(1, c.covenant_id));
        before.outputs.push(o);
    }
    let before_utxos = [moved_utxos, mint_utxos].concat();
    assert!(argent_runtime::execute_input_with_covenants(&before, before_utxos.clone(), 0).is_err(), "the token's script refuses");
    refused(run(before, before_utxos), "a token before the minter");
    tally("5 identity: a token state inside a mint");
}
