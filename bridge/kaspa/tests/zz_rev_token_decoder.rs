//! Token review, property 8: transactions for the TypeScript decoder.
//!
//! A randomized run (fixed, printed seeds) builds KCC-20 transfers of every shape the script
//! takes, runs each in the script engine, and writes those the engine ACCEPTED, with the
//! states the engine was given, to `build/zz_rev_token_decoder.json` (not checked in: megabytes;
//! the first rounds are checked in as `tests/fixtures/zz_rev_token_decoder_sample.json`). It also writes
//! bodies the engine REFUSED because their declared states were rewritten (same txid, another
//! signature script). `bridge/packages/protocol/src/zz-rev-token-decoder.test.ts` reads the
//! file and checks that `decodeKcc20Input` and the state-to-script mapping read every accepted
//! body exactly as the engine did, and take no refused body for a proven one.
//!
//!   cargo test --locked --test zz_rev_token_decoder -- --nocapture
//!   (then, in bridge/packages/protocol: npx vitest run src/zz-rev-token-decoder.test.ts)

#[path = "zz_rev_token_support.rs"]
mod support;

use argent_runtime::{EntryCall, TxContext, args, state};
use kaspa_consensus_core::{
    Hash,
    hashing::sighash_type::SIG_HASH_ALL,
    tx::{CovenantBinding, Transaction, UtxoEntry},
};
use kusdt_kaspa::protocol::{RedeemEntry, burn_owner, redeem_payload};
use serde_json::{Value, json};
use support::*;

const SEEDS: [u64; 6] = [0x8dec_0de1, 0x8dec_0de2, 0x8dec_0de3, 0x8dec_0de4, 0x8dec_0de5, 0x8dec_0de6];
const ROUNDS: usize = 60;
/// How many rounds of the first seed are checked in as a sample.
const SAMPLE_ROUNDS: usize = 12;

fn state_json(t: &Tok) -> Value {
    json!({
        "amount": t.amount.to_string(), "owner": hex(&t.owner), "ownerScheme": t.scheme, "borrowScheme": t.borrow,
        "borrowGuard": hex(&t.guard), "extensionCommitment": hex(&t.ext),
    })
}

fn total(rng: &mut Rng) -> i64 {
    match rng.below(7) {
        0 => 0,
        1 => rng.below(1_000) as i64,
        2 => (rng.below(1_000_000) * 1_000_000) as i64,
        3 => 1_000_000_000_000_000,
        4 => i64::MAX - rng.below(1_000) as i64,
        5 => i64::MAX,
        _ => (rng.next() >> 1) as i64,
    }
}

fn split(rng: &mut Rng, total: i64, n: usize) -> Vec<i64> {
    let mut left = total as u64;
    let mut parts = Vec::new();
    for _ in 1..n {
        let part = match rng.below(4) {
            0 => 0,
            1 => left.min(1),
            _ => rng.below(left + 1),
        };
        parts.push(part as i64);
        left -= part;
    }
    parts.push(left as i64);
    // The whole amount is not always last.
    let at = rng.below(n as u64) as usize;
    parts.swap(at, n - 1);
    parts
}

/// An input state of a random owner scheme with the witness that moves it. `authority` is the input index a
/// p2sh owner's coin will have.
fn input(rng: &mut Rng, amount: i64, ext: [u8; 32], authority: u8) -> (TokIn, bool) {
    let k = key(1 + rng.below(0xf0) as u8);
    let (tok, auth, needs_coin) = match rng.below(5) {
        0 => (Tok::schnorr(&k, amount), Auth::key(&k), false),
        1 => (Tok::new(1, blake3_of(&xonly(&k)), amount), Auth::PkhSchnorr(k), false),
        2 => (Tok::new(2, blake3_of(&compressed(&k)), amount), Auth::PkhEcdsa(k), false),
        3 => (Tok::new(3, script_hash(&[0x51]), amount), Auth::Raw(vec![authority]), true),
        _ => (Tok::new(4, K, amount), Auth::none(), false),
    };
    let tok = if rng.below(4) == 0 { tok.borrow(rng.below(4) as u8, rng.bytes()) } else { tok };
    (TokIn::new(tok.ext(ext), auth), needs_coin)
}

fn output(rng: &mut Rng, amount: i64, ext: [u8; 32]) -> Tok {
    let scheme = rng.below(5) as u8;
    let owner = match rng.below(4) {
        0 => burn_owner(1 + rng.below(2) as u8, &rng.bytes()),
        1 => [0u8; 32],
        _ => rng.bytes(),
    };
    let tok = Tok::new(if rng.below(3) == 0 { 3 } else { scheme }, owner, amount);
    let tok = match rng.below(3) {
        0 => tok,
        1 => tok.borrow(rng.below(4) as u8, [0; 32]),
        _ => tok.borrow(rng.below(4) as u8, rng.bytes()),
    };
    tok.ext(ext)
}

struct Built {
    #[allow(dead_code)]
    name: String,
    case: Case,
    tx: Transaction,
    utxos: Vec<UtxoEntry>,
    /// (input index, covenant ID, next states with the output each one is).
    leaders: Vec<(usize, [u8; 32], Vec<(usize, Tok)>)>,
}

fn random_case(rng: &mut Rng, name: String) -> Built {
    let (n_in, n_out) = (1 + rng.below(3) as usize, 1 + rng.below(3) as usize);
    let ext = if rng.below(5) == 0 { rng.bytes() } else { [0u8; 32] };
    let sum = total(rng);
    let authority = (n_in + 1) as u8;
    let mut needs_coin = false;
    let mut inputs = Vec::new();
    for amount in split(rng, sum, n_in) {
        let (tok_in, coin) = input(rng, amount, ext, authority);
        needs_coin |= coin;
        inputs.push(tok_in);
    }
    let next: Vec<Tok> = split(rng, sum, n_out).into_iter().map(|a| output(rng, a, ext)).collect();
    let mut slots = vec![Slot::leader(inputs[0].clone(), &next)];
    slots.extend(inputs[1..].iter().cloned().map(Slot::Delegate));
    slots.push(Slot::funding());
    // The p2sh owners' coin is always there, so that its index is fixed.
    slots.push(Slot::Plain { entry: p2sh_coin(&[0x51]), sig: vec![0x01, 0x51] });
    let _ = needs_coin;

    // Another token (the same script, covenant ID K2) moving in the same transaction, sometimes.
    let mut other: Option<(usize, Vec<Tok>)> = None;
    if rng.below(3) == 0 {
        let k = key(0xf1);
        let amount = total(rng);
        let parts = 1 + rng.below(2) as usize;
        let other_next: Vec<Tok> = split(rng, amount, parts).into_iter().map(|a| output(rng, a, [0; 32])).collect();
        other = Some((slots.len(), other_next.clone()));
        slots.push(Slot::leader(TokIn::of(&k, amount).cov(K2), &other_next));
    }

    // Outputs: the two families' bound outputs keep their own order; plain outputs and plain copies of the token
    // scripts (decoys) are dropped in anywhere.
    let mut pending: Vec<Vec<Out>> = vec![next.iter().map(Out::tok).collect()];
    if let Some((index, other_next)) = &other {
        pending.push(other_next.iter().map(|t| Out::tok(t).cov(K2).by(*index as u16)).collect());
    }
    let mut outs = Vec::new();
    while pending.iter().any(|p| !p.is_empty()) {
        match rng.below(6) {
            0 => outs.push(Out::plain()),
            1 => outs.push(Out::Spk { spk: next[rng.below(next.len() as u64) as usize].spk(), bind: None, value: TOKEN_SOMPI }),
            _ => {
                let from = rng.below(pending.len() as u64) as usize;
                if !pending[from].is_empty() {
                    outs.push(pending[from].remove(0));
                }
            }
        }
    }
    let mut case = Case::new(slots, outs);
    // A redemption payload naming the burn-like outputs, a random payload, or none.
    case.payload = match rng.below(3) {
        0 => Vec::new(),
        1 => {
            let n = rng.below(60) as usize;
            rng.vec(n)
        }
        _ => {
            let entries: Vec<RedeemEntry> = case
                .outs
                .iter()
                .enumerate()
                .filter(|(_, o)| matches!(o, Out::Tok { tok, cov, .. } if tok.scheme == 3 && *cov == K))
                .map(|(i, _)| RedeemEntry { output_index: i as u8, chain: 1 + rng.below(2) as u8, address: rng.bytes() })
                .collect();
            if entries.is_empty() { Vec::new() } else { redeem_payload(&entries).unwrap() }
        }
    };

    let (tx, utxos) = case.accepted(&name);
    let mut leaders = Vec::new();
    for (i, slot) in case.slots.iter().enumerate() {
        if let Slot::Leader { input, next, .. } = slot {
            let bound: Vec<usize> = case
                .outs
                .iter()
                .enumerate()
                .filter(|(_, o)| matches!(o, Out::Tok { cov, by, .. } if *cov == input.cov && *by as usize == i))
                .map(|(k, _)| k)
                .collect();
            assert_eq!(bound.len(), next.len());
            leaders.push((i, input.cov, bound.into_iter().zip(next.iter().cloned()).collect()));
        }
    }
    Built { name, case, tx, utxos, leaders }
}

fn record(b: &Built, tx: &Transaction, accepted: bool, name: &str, forged_input: Option<usize>) -> Value {
    let inputs: Vec<Value> = b
        .case
        .slots
        .iter()
        .enumerate()
        .map(|(i, slot)| match slot {
            Slot::Leader { input, .. } => {
                let (_, _, next) = b.leaders.iter().find(|(at, _, _)| *at == i).unwrap();
                json!({
                    "index": i, "role": "leader", "covenantId": hex(&input.cov), "spent": state_json(&input.tok),
                    "next": next.iter().map(|(output, tok)| json!({ "output": output, "state": state_json(tok) })).collect::<Vec<_>>(),
                })
            }
            Slot::Delegate(input) => json!({ "index": i, "role": "delegator", "covenantId": hex(&input.cov), "spent": state_json(&input.tok) }),
            Slot::Plain { .. } => json!({ "index": i, "role": "other" }),
        })
        .collect();
    json!({
        "name": name, "accepted": accepted, "kusdt": hex(&K), "forgedInput": forged_input,
        "txid": tx.id().to_string(), "transaction": kusdt_kaspa::tx::rpc_json(tx), "inputs": inputs,
    })
}

/// The signature script of `pushes` with some of them replaced, and push `pushdata1` spelled with OP_PUSHDATA1
/// whatever its length. The TypeScript side rebuilds the same bytes from the same description.
fn spelled(items: &[Vec<u8>], replace: &[(usize, Vec<u8>)], pushdata1: Option<usize>) -> Vec<u8> {
    let mut items = items.to_vec();
    for (at, bytes) in replace {
        items[*at] = bytes.clone();
    }
    let mut out = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if Some(i) == pushdata1 && item.len() <= 255 {
            out.push(0x4c);
            out.push(item.len() as u8);
            out.extend_from_slice(item);
        } else {
            out.extend(push_one(item));
        }
    }
    out
}

/// Another body of case `base`: the same transaction ID, input `input`'s signature script respelled.
fn variant(base: usize, name: String, accepted: bool, input: usize, script: &[u8], replace: &[(usize, Vec<u8>)], pushdata1: Option<usize>) -> Value {
    json!({
        "base": base, "name": name, "accepted": accepted, "input": input,
        "replace": replace.iter().map(|(at, bytes)| json!([at, hex(bytes)])).collect::<Vec<_>>(),
        "pushdata1": pushdata1, "scriptHash": hex(&blake3_of(script)),
    })
}

const FIELDS: [(usize, usize); 6] = [(0, 8), (1, 32), (2, 1), (3, 1), (4, 32), (5, 32)];

#[test]
fn p8_accepted_and_refused_bodies_for_the_typescript_decoder() {
    let mut cases: Vec<Value> = Vec::new();
    let mut variants: Vec<Value> = Vec::new();
    // The part of the run that is checked in (the whole run is megabytes of transactions; it is written to build/).
    let mut sample = (0usize, 0usize);
    let (mut accepted, mut refused_forgeries, mut negative_zero, mut pushdata_accepted, mut pushdata_refused) = (0, 0, 0, 0, 0);
    for (s, seed) in SEEDS.into_iter().enumerate() {
        let mut rng = Rng(seed);
        for round in 0..ROUNDS {
            let name = format!("seed {seed:#x} round {round}");
            let b = random_case(&mut rng, name.clone());
            let base = cases.len();
            cases.push(record(&b, &b.tx, true, &name, None));
            accepted += 1;
            let (leader, _, next) = b.leaders[0].clone();
            let items = pushes(&b.tx.inputs[leader].signature_script);
            assert_eq!(items.len(), 9, "{name}: a leader's signature script is nine pushes");
            assert_eq!(spelled(&items, &[], None), b.tx.inputs[leader].signature_script, "{name}: the builder spells pushes minimally");
            let body = |replace: &[(usize, Vec<u8>)], pushdata1: Option<usize>| {
                let mut tx = b.tx.clone();
                tx.inputs[leader].signature_script = spelled(&items, replace, pushdata1);
                tx
            };

            // Respellings the engine may take (a signature script is in no signature and in no transaction ID).
            // 1. Negative zero for every empty state.
            if next.iter().any(|(_, t)| t.amount == 0) {
                let mut amounts = items[0].clone();
                for (k, (_, t)) in next.iter().enumerate() {
                    if t.amount == 0 {
                        amounts[8 * k + 7] = 0x80;
                    }
                }
                let replace = vec![(0usize, amounts)];
                let tx = body(&replace, None);
                run(tx.clone(), b.utxos.clone()).unwrap_or_else(|e| panic!("{name}: negative zeros were refused: {e:?}"));
                variants.push(variant(base, format!("{name}, empty states spelled as negative zero"), true, leader, &tx.inputs[leader].signature_script, &replace, None));
                negative_zero += 1;
            }
            // 2. One push spelled with OP_PUSHDATA1.
            let at = rng.below(8) as usize;
            let tx = body(&[], Some(at));
            if tx.inputs[leader].signature_script != b.tx.inputs[leader].signature_script {
                match run(tx.clone(), b.utxos.clone()) {
                    Ok(_) => {
                        variants.push(variant(base, format!("{name}, push {at} spelled with OP_PUSHDATA1"), true, leader, &tx.inputs[leader].signature_script, &[], Some(at)));
                        pushdata_accepted += 1;
                    }
                    Err(Rejected::Script(_)) => pushdata_refused += 1,
                    Err(e) => panic!("{name}: {e:?}"),
                }
            }

            // Forgeries: the same transaction ID with other declared states. The engine must refuse each; the
            // decoder side must not take one for a proven body.
            let n = next.len();
            let mut forgeries: Vec<(String, Vec<(usize, Vec<u8>)>)> = Vec::new();
            let one = |what: &str, field: usize, change: &dyn Fn(&mut Vec<u8>)| {
                let mut bytes = items[field].clone();
                change(&mut bytes);
                (what.to_string(), vec![(field, bytes)])
            };
            forgeries.push(one("the first amount changed by one", 0, &|b| b[0] ^= 0x01));
            forgeries.push(one("one bit of the first owner", 1, &|b| b[31] ^= 0x80));
            forgeries.push(one("the first owner scheme", 2, &|b| b[0] = (b[0] + 1) % 5));
            forgeries.push(one("the first borrow scheme", 3, &|b| b[0] = (b[0] + 1) % 4));
            forgeries.push(one("one bit of the first borrow guard", 4, &|b| b[0] ^= 0x01));
            if n > 1 && next[0].1 != next[1].1 {
                let swapped = FIELDS
                    .iter()
                    .map(|(field, width)| {
                        let mut bytes = items[*field].clone();
                        let (a, rest) = bytes.split_at_mut(*width);
                        a.swap_with_slice(&mut rest[..*width]);
                        (*field, bytes)
                    })
                    .collect();
                forgeries.push(("the first two states swapped".to_string(), swapped));
            }
            if n > 1 {
                let shorter = FIELDS.iter().map(|(field, width)| (*field, items[*field][..items[*field].len() - width].to_vec())).collect();
                forgeries.push(("the last state left out".to_string(), shorter));
            }
            for (what, replace) in forgeries {
                let tx = body(&replace, None);
                refused(run(tx.clone(), b.utxos.clone()), &format!("{name}: {what}"));
                variants.push(variant(base, format!("{name}, FORGED: {what}"), false, leader, &tx.inputs[leader].signature_script, &replace, None));
                refused_forgeries += 1;
            }
            if s == 0 && round + 1 == SAMPLE_ROUNDS {
                sample = (cases.len(), variants.len());
            }
        }
        println!("REV-TOKEN 8 decoder: seed {seed:#x}: {ROUNDS} random transfers accepted by the engine");
    }

    // Two fixed shapes from other members of the family: a seed's create and a pool sell. The decoder must read
    // the seed and the pool inputs as 'not a KCC20 input', the reserve as a leader and the payer as a delegate.
    let fixed = vec![seed_create(), pool_sell()];

    println!(
        "REV-TOKEN 8 decoder: {accepted} accepted transfers; {negative_zero} more with negative zeros (accepted); OP_PUSHDATA1 respellings: {pushdata_accepted} accepted, {pushdata_refused} refused; {refused_forgeries} forged bodies refused"
    );
    tally("8 decoder: bodies for the TypeScript side");
    let burns = burn_shapes();
    let seeds = SEEDS.iter().map(|s| format!("{s:#x}")).collect::<Vec<_>>();
    let write = |path: std::path::PathBuf, cases: &[Value], variants: &[Value], what: &str| {
        std::fs::create_dir_all(path.parent().unwrap()).expect("the directory");
        let all: Vec<Value> = cases.iter().cloned().chain(fixed.iter().cloned()).collect();
        let text = serde_json::to_string(&json!({ "what": what, "seeds": seeds, "rounds": ROUNDS, "cases": all, "variants": variants, "burns": burns })).unwrap();
        std::fs::write(&path, text).expect("the fixture is written");
        println!("REV-TOKEN 8 decoder: wrote {} transactions and {} other bodies of them to {}", all.len(), variants.len(), path.display());
    };
    write(kusdt_kaspa::crate_root().join("build/zz_rev_token_decoder.json"), &cases, &variants, "the whole run");
    write(
        kusdt_kaspa::crate_root().join("tests/fixtures/zz_rev_token_decoder_sample.json"),
        &cases[..sample.0],
        &variants[..sample.1],
        "the first rounds of the first seed (the whole run is written to build/ by the same test)",
    );
}

fn seed_create() -> Value {
    let b = builder();
    let owner = key(0x20);
    let seed = state! { owner: xonly(&owner).to_vec(), extension_commitment: vec![0u8; 32] };
    let utxo = b.covenant_utxo("TokenSeed", seed.clone(), 100_000_000, 0, false, Some(Hash::from_bytes(K))).unwrap();
    let empty = Tok::new(3, burn_owner(1, &[0x77; 20]), 0);
    let ctx = TxContext::new()
        .actor_input("TokenSeed", seed.clone(), EntryCall::new("create").args(args!(empty.state())), outpoint(0x70, 0), utxo.clone(), 0)
        .input(outpoint(0x71, 0), funding(), Vec::new(), 0)
        .actor_output("TokenSeed", seed, CovenantBinding::new(0, Hash::from_bytes(K)), 100_000_000)
        .actor_output("KCC20", empty.state(), CovenantBinding::new(0, Hash::from_bytes(K)), TOKEN_SOMPI);
    let tx = run(b.build(&ctx).map_err(classify).expect("a create"), vec![utxo, funding()]).expect("a create runs");
    count_control();
    json!({
        "name": "a seed's create (an empty state at a burn owner)", "accepted": true, "kusdt": hex(&K), "forgedInput": null,
        "txid": tx.id().to_string(), "transaction": kusdt_kaspa::tx::rpc_json(&tx),
        "inputs": [{ "index": 0, "role": "other" }, { "index": 1, "role": "other" }],
        "seedMade": { "output": 1, "state": state_json(&empty) },
    })
}

fn pool_sell() -> Value {
    const KAS: i64 = 100_000_000;
    const USDT: i64 = 1_000_000;
    let (x, y) = (10_000 * KAS, 1_000 * USDT);
    let b = pool_builder();
    let seller = key(0xc0);
    let pool = |x: i64, y: i64, pt: i64, window: (i64, i64)| {
        state! {
            token_covid: K.to_vec(), kas_reserve: x, token_reserve: y, total_shares: 10_000 * KAS, protocol_kas: 0i64, protocol_tokens: pt,
            base_value: KAS, admin: xonly(&key(0x30)).to_vec(), max_out_bps: 1_000i64, window_len: 36_000i64, window_credit: 0i64,
            window_ref: window.0, window_out: window.1, paused: false, guardian: xonly(&key(0x32)).to_vec()
        }
    };
    let (tokens_in, held) = (USDT, 100 * USDT);
    let eff = tokens_in as i128 * 9_950 / 10_000;
    let kas_out = (x as i128 * eff / (y as i128 + eff)) as i64;
    let cut = tokens_in * 5 / 10_000;
    let reserve_in = Tok::new(4, POOL, y);
    let reserve_out = Tok::new(4, POOL, y + tokens_in);
    let payer = Tok::schnorr(&seller, held);
    let change = Tok::schnorr(&seller, held - tokens_in);
    let pool_utxo = b.covenant_utxo("Pool", pool(x, y, 0, (x, 0)), (KAS + x) as u64, 0, false, Some(Hash::from_bytes(POOL))).unwrap();
    let reserve_utxo = b.covenant_utxo("kusdt::KCC20", reserve_in.state(), KAS as u64, 0, false, Some(Hash::from_bytes(K))).unwrap();
    let payer_utxo = b.covenant_utxo("kusdt::KCC20", payer.state(), KAS as u64, 0, false, Some(Hash::from_bytes(K))).unwrap();
    let ctx = TxContext::new()
        .actor_input("Pool", pool(x, y, 0, (x, 0)), EntryCall::new("sell").args(args!(kas_out, 0i64, change.state())), outpoint(0x40, 0), pool_utxo.clone(), 0)
        .actor_input("kusdt::KCC20", reserve_in.state(), EntryCall::new("transfer").args(args!(vec![reserve_out.state(), change.state()], vec![0x00u8])), outpoint(0x41, 0), reserve_utxo.clone(), 0)
        .actor_input("kusdt::KCC20", payer.state(), EntryCall::new("transfer_delegator").args_with(move |tx, i| args!(sign_schnorr(tx, i, &seller, SIG_HASH_ALL))), outpoint(0x42, 0), payer_utxo.clone(), 0)
        .actor_output("Pool", pool(x - kas_out, y + tokens_in - cut, cut, (x - kas_out, kas_out)), CovenantBinding::new(0, Hash::from_bytes(POOL)), (KAS + x - kas_out) as u64)
        .actor_output("kusdt::KCC20", reserve_out.state(), CovenantBinding::new(1, Hash::from_bytes(K)), KAS as u64)
        .actor_output("kusdt::KCC20", change.state(), CovenantBinding::new(1, Hash::from_bytes(K)), KAS as u64);
    let tx = run(b.build(&ctx).map_err(classify).expect("a sell"), vec![pool_utxo, reserve_utxo, payer_utxo]).expect("a sell runs");
    count_control();
    json!({
        "name": "a pool sell (the reserve leads, the seller's state is the delegate)", "accepted": true, "kusdt": hex(&K), "forgedInput": null,
        "txid": tx.id().to_string(), "transaction": kusdt_kaspa::tx::rpc_json(&tx),
        "inputs": [
            { "index": 0, "role": "other" },
            { "index": 1, "role": "leader", "covenantId": hex(&K), "spent": state_json(&reserve_in), "next": [{ "output": 1, "state": state_json(&reserve_out) }, { "output": 2, "state": state_json(&change) }] },
            { "index": 2, "role": "delegator", "covenantId": hex(&K), "spent": state_json(&payer) },
        ],
    })
}

/// Transactions with burn-like outputs, each run in the engine, with what the services must make of every output:
/// `redeem` (the coordinator records it to pay), `token` (the coordinator's token index holds it), `burn` (the
/// monitor's burn index holds it). bridge/services/src/zz-rev-token-services.test.ts reads them.
fn burn_shapes() -> Vec<Value> {
    let (a, b) = (key(0xa1), key(0xb1));
    let address = |n: u8| [n; 20];
    let burn = |chain: u8, n: u8, amount: i64| Tok::new(3, burn_owner(chain, &address(n)), amount);
    let entry = |output: usize, chain: u8, n: u8| RedeemEntry { output_index: output as u8, chain, address: address(n) };
    let expect = |output: usize, tok: &Tok, redeem: bool, token: bool, burn: bool, why: &str| json!({ "output": output, "state": state_json(tok), "redeem": redeem, "token": token, "burn": burn, "why": why });
    let mut shapes = Vec::new();
    let mut push = |name: &str, case: Case, expect: Vec<Value>| {
        let (tx, _) = case.accepted(name);
        shapes.push(json!({ "name": name, "kusdt": hex(&K), "txid": tx.id().to_string(), "transaction": kusdt_kaspa::tx::rpc_json(&tx), "expect": expect }));
    };

    // A: a plain burn, a burn with borrowing on, an empty burn; the payload names all three correctly.
    let next = vec![burn(1, 0x01, 5_000_000), burn(1, 0x02, 4_000_000).borrow(1, [0; 32]), burn(2, 0x03, 0)];
    let mut case = Case::transfer(TokIn::of(&a, 9_000_000), vec![], &next);
    case.payload = redeem_payload(&[entry(0, 1, 0x01), entry(1, 1, 0x02), entry(2, 2, 0x03)]).unwrap();
    push("A: a plain burn, a borrowable burn, an empty burn, all named by the payload", case, vec![
        expect(0, &next[0], true, false, true, "a plain burn"),
        expect(1, &next[1], false, false, false, "borrowing on: anyone can move it to a new outpoint, so it is never paid"),
        expect(2, &next[2], false, false, true, "holds nothing: not a redemption (since run 21, Daybreak [26], the monitor keeps no record of a burn of 0: no release can name one)"),
    ]);

    // B: a burn whose guard is not zero (borrowing off), and a plain burn that sits after a plain copy of its own
    // script; the payload names the copy and the real one.
    let next = vec![burn(2, 0x04, 5_000_000).borrow(0, [0x77; 32]), burn(2, 0x05, 7_000_000)];
    let mut case = Case::transfer(TokIn::of(&a, 12_000_000), vec![], &next);
    case.outs = vec![Out::tok(&next[0]), Out::Spk { spk: next[1].spk(), bind: None, value: TOKEN_SOMPI }, Out::tok(&next[1])];
    case.payload = redeem_payload(&[entry(0, 2, 0x04), entry(1, 2, 0x05), entry(2, 2, 0x05)]).unwrap();
    push("B: a burn with a borrow guard, and a plain burn behind a plain copy of its script", case, vec![
        expect(0, &next[0], false, false, false, "a borrow guard that is not zero: the signers refuse it"),
        expect(1, &next[1], false, false, false, "a plain output with the burn's script and no covenant binding: not kUSDT"),
        expect(2, &next[1], true, false, true, "the real burn"),
    ]);

    // C: a look-alike token (the same script under another covenant ID) 'burns' a billion; real kUSDT moves beside it.
    let fake = vec![burn(1, 0x06, 1_000_000_000_000_000)];
    let real = vec![Tok::schnorr(&b, 3)];
    let mut case = Case::new(
        vec![Slot::leader(TokIn::of(&a, 3), &real), Slot::leader(TokIn::of(&a, 1_000_000_000_000_000).cov(K2), &fake), Slot::funding()],
        vec![Out::tok(&fake[0]).cov(K2).by(1), Out::tok(&real[0])],
    );
    case.payload = redeem_payload(&[entry(0, 1, 0x06)]).unwrap();
    push("C: a burn of another token with kUSDT's script, next to a kUSDT transfer", case, vec![
        expect(0, &fake[0], false, false, false, "bound to another covenant ID: not kUSDT"),
        expect(1, &real[0], false, true, false, "kUSDT sent to a key"),
    ]);

    // D: a plain burn whose payload names the other chain.
    let next = vec![burn(1, 0x07, 6_000_000)];
    let mut case = Case::transfer(TokIn::of(&a, 6_000_000), vec![], &next);
    case.payload = redeem_payload(&[entry(0, 2, 0x07)]).unwrap();
    push("D: a plain burn whose payload names another chain than its owner commits to", case, vec![
        expect(0, &next[0], false, true, true, "the payload is not the owner's chain: not recorded from the payload (anyone can report it with the right pair), and listed to its owner like any state no payload shows to be a burn"),
    ]);

    // E: kUSDT sent to an ordinary P2SH owner (a script hash that is no burn), with change to a key.
    let next = vec![Tok::new(3, script_hash(&[0x51]), 2_000_000), Tok::schnorr(&b, 1_000_000)];
    let case = Case::transfer(TokIn::of(&a, 3_000_000), vec![], &next);
    push("E: kUSDT sent to a P2SH owner that is not a burn", case, vec![
        expect(0, &next[0], false, true, true, "spendable kUSDT of a script-hash owner: the coordinator's token index lists it (since run 21, Daybreak [57]), the monitor holds it as a possible burn until it is spent"),
        expect(1, &next[1], false, true, false, "kUSDT sent to a key"),
    ]);
    shapes
}
