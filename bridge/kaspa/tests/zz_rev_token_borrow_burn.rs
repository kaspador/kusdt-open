//! Token review, properties 3 (the borrow path), 4 (burns) and 9 (limits), in the script
//! engine, on the checked-in artifact.
//!
//!   cargo test --locked --test zz_rev_token_borrow_burn -- --nocapture

#[path = "zz_rev_token_support.rs"]
mod support;

use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::mass::{MassCalculator, ScriptUnits};
use kaspa_consensus_core::tx::{PopulatedTransaction, Transaction, UtxoEntry, VerifiableTransaction};
use kaspa_consensus_core::config::params::MAINNET_PARAMS;
use kaspa_txscript::{EngineCtx, EngineFlags, SigCacheKey, TxScriptEngine, caches::Cache, covenants::CovenantsContext};
use kusdt_kaspa::protocol::{burn_owner, burn_script};
use support::*;

const THRESHOLD: i64 = 10;

fn threshold_guard(threshold: i64) -> [u8; 32] {
    let mut g = [0u8; 32];
    let mut magnitude = threshold.unsigned_abs().to_le_bytes();
    if threshold < 0 {
        magnitude[7] |= 0x80;
    }
    g[..8].copy_from_slice(&magnitude);
    g
}

/// The victim's state (borrowing on) as the leader on the borrow path, a stranger's state as the delegate that
/// brings the tokens, `back` as output 0 and the stranger's change as output 1.
fn borrow(victim: &Tok, auth: Auth, back: &Tok, back_value: u64, stranger_in: i64, change: i64) -> Case {
    let x = key(0xee);
    let next = vec![back.clone(), Tok::schnorr(&x, change)];
    let mut case = Case::new(
        vec![Slot::Leader { input: TokIn::new(victim.clone(), auth), path: vec![0x01], next: next.clone() }, Slot::Delegate(TokIn::of(&x, stranger_in)), Slot::funding()],
        next.iter().map(Out::tok).collect(),
    );
    case.outs[0] = Out::tok(back).value(back_value);
    case
}

#[test]
fn p3_borrowing_only_adds_to_the_state_and_returns_it() {
    let (v, x) = (key(0xc1), key(0xee));
    let victim = Tok::schnorr(&v, 100).borrow(1, threshold_guard(THRESHOLD));
    let back = |amount: i64| victim.clone().amount(amount);
    // Anyone, with no signature of the victim's: the state comes back larger by more than the threshold.
    borrow(&victim, Auth::none(), &back(111), TOKEN_SOMPI, 50, 39).accepted("borrow: +11 with a threshold of 10");
    borrow(&victim, Auth::none(), &back(150), TOKEN_SOMPI + 5, 50, 0).accepted("borrow: +50, more KAS");

    borrow(&victim, Auth::none(), &back(110), TOKEN_SOMPI, 50, 40).refused("+10: not above the threshold");
    borrow(&victim, Auth::none(), &back(100), TOKEN_SOMPI, 50, 50).refused("+0");
    borrow(&victim, Auth::none(), &back(99), TOKEN_SOMPI, 50, 51).refused("-1");
    borrow(&victim, Auth::none(), &back(0), TOKEN_SOMPI, 50, 150).refused("everything to the stranger");
    borrow(&victim, Auth::none(), &back(111), TOKEN_SOMPI - 1, 50, 39).refused("one sompi less KAS in the returned state");
    borrow(&victim, Auth::none(), &back(111), 1, 50, 39).refused("the returned state holds 1 sompi");
    // The returned state must be the same owner, schemes and guard.
    let bent: Vec<(&str, Tok)> = vec![
        ("the stranger's key as owner", Tok { owner: xonly(&x), ..back(111) }),
        ("owner scheme p2pkh", Tok { scheme: 1, ..back(111) }),
        ("owner scheme covenant-id", Tok { scheme: 4, ..back(111) }),
        ("borrowing switched off", Tok { borrow: 0, ..back(111) }),
        ("another borrow scheme", Tok { borrow: 2, ..back(111) }),
        ("a lower threshold", Tok { guard: threshold_guard(0), ..back(111) }),
        ("a higher threshold", Tok { guard: threshold_guard(1_000_000), ..back(111) }),
        ("a guard differing in its last byte", Tok { guard: { let mut g = threshold_guard(THRESHOLD); g[31] = 1; g }, ..back(111) }),
        ("another extension", Tok { ext: [1; 32], ..back(111) }),
    ];
    for (what, state) in bent {
        borrow(&victim, Auth::none(), &state, TOKEN_SOMPI, 50, 39).refused(&format!("returned with {what}"));
    }
    // The returned state must be the leader's FIRST output.
    let mut swapped = borrow(&victim, Auth::none(), &back(111), TOKEN_SOMPI, 50, 39);
    if let Slot::Leader { next, .. } = &mut swapped.slots[0] {
        next.swap(0, 1);
    }
    swapped.outs.swap(0, 1);
    swapped.refused("the returned state as the second output");
    // A threshold witness must be empty.
    borrow(&victim, Auth::Raw(vec![0]), &back(111), TOKEN_SOMPI, 50, 39).refused("a byte after the path byte");
    // Nobody to bring tokens: the state cannot grow, so it cannot be borrowed.
    let alone = |amount: i64| {
        let next = vec![back(amount)];
        Case::new(vec![Slot::Leader { input: TokIn::new(victim.clone(), Auth::none()), path: vec![0x01], next: next.clone() }, Slot::funding()], next.iter().map(Out::tok).collect())
    };
    alone(100).refused("borrowed alone, same amount");
    alone(111).refused("borrowed alone, more out than in");
    // An empty delegate brings nothing.
    borrow(&victim, Auth::none(), &back(111), TOKEN_SOMPI, 0, 0).refused("an empty delegate");
    // The delegate still needs its own owner: a stranger cannot pull a third party's state in to pay for the borrow.
    let third = key(0xc7);
    let next = vec![back(150)];
    Case::new(
        vec![Slot::Leader { input: TokIn::new(victim.clone(), Auth::none()), path: vec![0x01], next: next.clone() }, Slot::Delegate(TokIn::new(Tok::schnorr(&third, 50), Auth::key(&x))), Slot::funding()],
        next.iter().map(Out::tok).collect(),
    )
    .refused("the delegate signed by somebody else");
    // A victim's borrowable state as the DELEGATE (no path byte there): the owner's signature or nothing.
    let next = vec![Tok::schnorr(&x, 150)];
    Case::transfer(TokIn::of(&x, 50), vec![TokIn::new(victim.clone(), Auth::none())], &next).refused("a borrowable state as a delegate, no witness");
    Case::transfer(TokIn::of(&x, 50), vec![TokIn::new(victim.clone(), Auth::Raw(vec![0x01]))], &next).refused("a borrowable state as a delegate, witness 01");
    // Borrowing off: the borrow path is closed. Same shape as the first control.
    let closed = Tok::schnorr(&v, 100);
    borrow(&closed, Auth::none(), &closed.clone().amount(111), TOKEN_SOMPI, 50, 39).refused("the borrow path on a state with borrowing off");
    // The owner still moves a borrowable state anywhere on the normal path.
    Case::transfer(TokIn::new(victim.clone(), Auth::key(&v)), vec![], &[Tok::schnorr(&x, 100)]).accepted("the owner spends a borrowable state");

    // A negative threshold counts as zero: +1 passes, +0 does not.
    let negative = Tok::schnorr(&v, 100).borrow(1, threshold_guard(-5));
    borrow(&negative, Auth::none(), &negative.clone().amount(101), TOKEN_SOMPI, 50, 49).accepted("negative threshold: +1");
    borrow(&negative, Auth::none(), &negative.clone().amount(100), TOKEN_SOMPI, 50, 50).refused("negative threshold: +0");
    borrow(&negative, Auth::none(), &negative.clone().amount(96), TOKEN_SOMPI, 50, 54).refused("negative threshold: -4");
    tally("3 borrow: the amount-threshold scheme");
}

#[test]
fn p3_the_signature_and_hash_chain_schemes() {
    let (v, g, x) = (key(0xc1), key(0xc2), key(0xee));
    // Scheme 2: the guard is a key; its signature opens the borrow path.
    let signed = Tok::schnorr(&v, 100).borrow(2, xonly(&g));
    let back = signed.clone().amount(101);
    borrow(&signed, Auth::key(&g), &back, TOKEN_SOMPI, 50, 49).accepted("signature scheme: the guard key signs");
    borrow(&signed, Auth::key(&x), &back, TOKEN_SOMPI, 50, 49).refused("signature scheme: a stranger signs");
    borrow(&signed, Auth::none(), &back, TOKEN_SOMPI, 50, 49).refused("signature scheme: no signature");
    borrow(&signed, Auth::key(&g), &signed.clone().amount(100), TOKEN_SOMPI, 50, 50).refused("signature scheme: +0");
    borrow(&signed, Auth::key(&g), &Tok { owner: xonly(&g), ..back.clone() }, TOKEN_SOMPI, 50, 49).refused("signature scheme: the guard key takes the state");
    borrow(&signed, Auth::key(&g), &Tok { guard: xonly(&x), ..back.clone() }, TOKEN_SOMPI, 50, 49).refused("signature scheme: the guard replaced");
    // The guard key is not the owner: it cannot use the normal path.
    Case::transfer(TokIn::new(signed.clone(), Auth::key(&g)), vec![], &[Tok::schnorr(&g, 100)]).refused("signature scheme: the guard key on the normal path");

    // Scheme 3: guard = BLAKE3(next guard ‖ one-time key); the returned state carries the next guard.
    let (otk, next_guard) = (key(0xc3), [0x9a; 32]);
    let guard = blake3_of(&[next_guard.to_vec(), xonly(&otk).to_vec()].concat());
    let chained = Tok::schnorr(&v, 100).borrow(3, guard);
    let back = Tok { guard: next_guard, ..chained.clone().amount(101) };
    borrow(&chained, Auth::Chain(next_guard, otk), &back, TOKEN_SOMPI, 50, 49).accepted("hash chain: the committed key signs, the guard advances");
    borrow(&chained, Auth::Chain(next_guard, otk), &Tok { guard, ..back.clone() }, TOKEN_SOMPI, 50, 49).refused("hash chain: the guard does not advance");
    borrow(&chained, Auth::Chain([0x9b; 32], otk), &Tok { guard: [0x9b; 32], ..back.clone() }, TOKEN_SOMPI, 50, 49).refused("hash chain: another next guard");
    borrow(&chained, Auth::Chain(next_guard, x), &back, TOKEN_SOMPI, 50, 49).refused("hash chain: another key");
    borrow(&chained, Auth::none(), &back, TOKEN_SOMPI, 50, 49).refused("hash chain: no witness");
    borrow(&chained, Auth::Chain(next_guard, otk), &Tok { owner: xonly(&otk), ..back.clone() }, TOKEN_SOMPI, 50, 49).refused("hash chain: the one-time key takes the state");
    borrow(&chained, Auth::Chain(next_guard, otk), &back.clone().amount(100), TOKEN_SOMPI, 50, 50).refused("hash chain: +0");
    tally("3 borrow: the signature and hash-chain schemes");
}

const ADDRESS: [u8; 20] = [0x5a; 20];

#[test]
fn p3_a_borrowable_state_at_a_burn_owner_only_moves_to_the_same_owner() {
    let x = key(0xee);
    let owner = burn_owner(1, &ADDRESS);
    let burn = Tok::new(3, owner, 1_000_000).borrow(1, threshold_guard(0));
    // Anyone moves it to a new outpoint by adding one unit of their own: the one thing that can happen.
    let (tx, _) = borrow(&burn, Auth::none(), &burn.clone().amount(1_000_001), TOKEN_SOMPI, 50, 49).accepted("a borrowable burn moved by a stranger");
    assert_eq!(tx.outputs[0].script_public_key, burn.clone().amount(1_000_001).spk(), "the same owner, schemes and guard, one unit more");
    // Nothing else.
    for (what, back, change) in [
        ("the same amount", burn.clone(), 50i64),
        ("less", burn.clone().amount(999_999), 51),
        ("emptied", burn.clone().amount(0), 1_000_050),
        ("to the stranger", Tok { owner: xonly(&x), scheme: 0, ..burn.clone().amount(1_000_001) }, 49),
        ("to another burn address", Tok { owner: burn_owner(1, &[0x5b; 20]), ..burn.clone().amount(1_000_001) }, 49),
        ("to the other chain", Tok { owner: burn_owner(2, &ADDRESS), ..burn.clone().amount(1_000_001) }, 49),
        ("with borrowing off (a plain burn the signers would pay)", Tok { borrow: 0, ..burn.clone().amount(1_000_001) }, 49),
        ("with borrowing off and a zero guard", Tok { borrow: 0, guard: [0; 32], ..burn.clone().amount(1_000_001) }, 49),
    ] {
        borrow(&burn, Auth::none(), &back, TOKEN_SOMPI, 50, change).refused(&format!("a borrowable burn returned {what}"));
    }
    // And the normal path stays shut (see p4).
    for index in 0u8..4 {
        Case::transfer(TokIn::new(burn.clone(), Auth::Raw(vec![index])), vec![], &[Tok::schnorr(&x, 1_000_000)]).refused("a borrowable burn on the normal path");
    }
    tally("3 borrow: a borrowable state at a burn owner");
}

// ---------------------------------------------------------------------------
// Property 4: burns.

#[test]
fn p4_the_burn_owner_is_the_p2sh_hash_of_one_script_per_chain_and_address() {
    // The owner is exactly what the engine's P2SH check compares against.
    for chain in [1u8, 2] {
        assert_eq!(script_hash(&burn_script(chain, &ADDRESS)), burn_owner(chain, &ADDRESS));
    }
    // The script has one fixed layout: 6a ‖ 0f ‖ tag[15] ‖ 01 ‖ chain ‖ 14 ‖ address[20]. Every field has a fixed
    // place and length, so two (chain, address) pairs give two scripts.
    let mut seen = std::collections::HashSet::new();
    let mut rng = Rng(0x6275726e);
    let mut addresses: Vec<[u8; 20]> = vec![[0; 20], [0xff; 20], ADDRESS];
    for i in 0..20 {
        let mut a = ADDRESS;
        a[i] ^= 1;
        addresses.push(a);
    }
    addresses.extend((0..40).map(|_| rng.bytes::<20>()));
    for chain in 0u8..=255 {
        for address in &addresses {
            let script = burn_script(chain, address);
            assert_eq!(script.len(), 40);
            assert_eq!(script[0], 0x6a, "OP_RETURN first");
            assert_eq!(&script[1..17], b"\x0fkUSDT/redeem/v1");
            assert_eq!((script[17], script[18], script[19]), (0x01, chain, 0x14));
            assert_eq!(&script[20..], address);
            assert!(seen.insert(burn_owner(chain, address)), "two pairs, one owner");
        }
    }
    println!("REV-TOKEN 4 burns: {} (chain, address) pairs, {} distinct owners", 256 * addresses.len(), seen.len());
}

/// The burn state as the leader with `witness` (path byte included), `extra` coins after the funding coin.
fn spend_burn(burn: &Tok, witness: Vec<u8>, extra: Vec<Slot>) -> Case {
    let x = key(0xee);
    let next = vec![Tok::schnorr(&x, burn.amount)];
    let mut slots = vec![Slot::Leader { input: TokIn::new(burn.clone(), Auth::Raw(witness)), path: vec![], next: next.clone() }, Slot::funding()];
    slots.extend(extra);
    Case::new(slots, next.iter().map(Out::tok).collect())
}

/// The burn state as the delegate of a stranger's leader.
fn join_burn(burn: &Tok, witness: Vec<u8>, extra: Vec<Slot>) -> Case {
    let x = key(0xee);
    let mut case = Case::transfer(TokIn::of(&x, 1), vec![TokIn::new(burn.clone(), Auth::Raw(witness))], &[Tok::schnorr(&x, burn.amount + 1)]);
    case.slots.extend(extra);
    case
}

#[test]
fn p4_a_burn_can_never_be_spent() {
    let script = burn_script(1, &ADDRESS);
    let burn = Tok::new(3, burn_owner(1, &ADDRESS), 1_000_000);
    // Control of the same shape: a p2sh owner whose script CAN be satisfied (OP_TRUE) moves, as leader and as delegate.
    let open = Tok::new(3, script_hash(&[0x51]), 1_000_000);
    let open_coin = || Slot::Plain { entry: p2sh_coin(&[0x51]), sig: vec![0x01, 0x51] };
    spend_burn(&open, vec![0x00, 2], vec![open_coin()]).accepted("a satisfiable p2sh owner, as leader");
    join_burn(&open, vec![3], vec![open_coin()]).accepted("a satisfiable p2sh owner, as delegate");
    // And the authority coin of an OP_TRUE script by itself is spendable; the burn script's coin is not, whatever reveals it.
    Case::new(vec![open_coin()], vec![Out::plain()]).accepted("a coin of P2SH(OP_TRUE) is spent");
    let reveal = push_one(&script);
    let burn_coin = |sig: Vec<u8>| Slot::Plain { entry: p2sh_coin(&script), sig };
    let reveals: Vec<(&str, Vec<u8>)> = vec![
        ("the script", reveal.clone()),
        ("OP_1, the script", [vec![0x51], reveal.clone()].concat()),
        ("OP_0, the script", [vec![0x00], reveal.clone()].concat()),
        ("the script twice", [reveal.clone(), reveal.clone()].concat()),
        ("nothing", vec![]),
        ("OP_1", vec![0x51]),
        ("another script (OP_TRUE)", vec![0x01, 0x51]),
    ];
    for (what, sig) in &reveals {
        Case::new(vec![burn_coin(sig.clone())], vec![Out::plain()]).refused(&format!("a coin of the burn script, revealed with {what}"));
    }
    // The token at the burn owner, with such a coin as its authority: the coin's own script stops the transaction.
    for (what, sig) in &reveals {
        spend_burn(&burn, vec![0x00, 2], vec![burn_coin(sig.clone())]).refused(&format!("leader, the burn script's coin revealed with {what}"));
        join_burn(&burn, vec![3], vec![burn_coin(sig.clone())]).refused(&format!("delegate, the burn script's coin revealed with {what}"));
    }
    // Pointing anywhere else: itself, the funding coin, a satisfiable p2sh coin of another script, past the inputs.
    for index in 0u8..=5 {
        spend_burn(&burn, vec![0x00, index], vec![open_coin()]).refused(&format!("leader, authority index {index}"));
        join_burn(&burn, vec![index], vec![open_coin()]).refused(&format!("delegate, authority index {index}"));
    }
    // The burn script as a BARE script coin (not P2SH), and the script's bytes as a coin's own script.
    let bare = Slot::Plain { entry: UtxoEntry::new(1_000_000_000, kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, script.clone()), 1, false, None), sig: vec![] };
    spend_burn(&burn, vec![0x00, 2], vec![bare]).refused("leader, a bare coin of the burn script");
    // Every path byte with an empty rest, and every owner-scheme reading the script does not offer.
    for path in 0u8..=255 {
        spend_burn(&burn, vec![path], vec![open_coin()]).refused(&format!("leader, path byte {path:#x} alone"));
    }
    // The borrow path on a plain burn (borrowing off), with a stranger adding tokens: same shape as p3's control.
    borrow_like(&burn).refused("the borrow path on a plain burn");
    tally("4 burns: every way to point at an authority");
}

fn borrow_like(burn: &Tok) -> Case {
    let x = key(0xee);
    let next = vec![burn.clone().amount(burn.amount + 1), Tok::schnorr(&x, 49)];
    Case::new(
        vec![Slot::Leader { input: TokIn::new(burn.clone(), Auth::none()), path: vec![0x01], next: next.clone() }, Slot::Delegate(TokIn::of(&x, 50)), Slot::funding()],
        next.iter().map(Out::tok).collect(),
    )
}

/// Random witnesses, as leader and as delegate, with and without coins around that a witness might point at.
/// Seeds are fixed and printed; a failure names the seed.
#[test]
fn p4_no_random_witness_spends_a_burn() {
    let script = burn_script(2, &ADDRESS);
    let burn = Tok::new(3, burn_owner(2, &ADDRESS), 5_000_000);
    let open = Tok::new(3, script_hash(&[0x51]), 5_000_000);
    let open_coin = || Slot::Plain { entry: p2sh_coin(&[0x51]), sig: vec![0x01, 0x51] };
    spend_burn(&open, vec![0x00, 2], vec![open_coin()]).accepted("the control the random run is measured against");
    let seeds = [0x5eed_0001u64, 0x5eed_0002, 0x5eed_0003, 0x5eed_0004];
    let lengths = [0usize, 1, 2, 3, 32, 33, 64, 65, 66, 97, 98, 99, 129, 130, 131, 200];
    for seed in seeds {
        let mut rng = Rng(seed);
        for round in 0..90 {
            let n = lengths[rng.below(lengths.len() as u64) as usize];
            let mut witness = rng.vec(n);
            // Half the time, a path byte the script knows and a small index after it.
            if !witness.is_empty() && rng.below(2) == 0 {
                witness[0] = rng.below(2) as u8;
                if witness.len() > 1 {
                    witness[1] = rng.below(5) as u8;
                }
            }
            let extra = match rng.below(3) {
                0 => vec![],
                1 => vec![open_coin()],
                _ => vec![Slot::Plain { entry: p2sh_coin(&script), sig: push_one(&script) }],
            };
            let what = format!("seed {seed:#x} round {round}: witness {}", hex(&witness));
            if rng.below(2) == 0 {
                // A leader witness can't be empty for the builder to place a path byte; the engine sees it as given.
                spend_burn(&burn, witness, extra).refused(&what);
            } else {
                join_burn(&burn, witness, extra).refused(&what);
            }
        }
        println!("REV-TOKEN 4 burns: random witnesses, seed {seed:#x}: 90 refused");
    }
    tally("4 burns: random witnesses");
}

// ---------------------------------------------------------------------------
// Property 9: limits.

/// (deepest combined stack, opcodes run, script units) of one input, from the engine's own execution log.
fn measure(tx: &Transaction, entries: &[UtxoEntry], index: usize) -> (usize, usize, u64) {
    let reused = SigHashReusedValuesUnsync::new();
    let sig_cache: Cache<SigCacheKey, bool> = Cache::new(100);
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    let covenants = CovenantsContext::from_tx(&populated).expect("covenant context");
    let input = populated.tx.inputs[index].clone();
    let utxo = populated.utxo(index).expect("input utxo");
    let mut log = Vec::new();
    let units;
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
        units = vm.used_script_units().0;
    }
    let log = String::from_utf8_lossy(&log);
    (log.lines().map(|line| line.matches("\"0x").count()).max().unwrap_or(0), log.lines().count(), units)
}

#[test]
fn p9_the_largest_transfers_stay_inside_the_engine_limits() {
    let program = kusdt_kaspa::tx::artifact().sil_abi.contracts.get("KCC20").expect("KCC20").compiled.bytecode.len();
    println!("REV-TOKEN 9 limits: the KCC20 program is {program} bytes (script limit 1 000 000, element limit 1 000 000)");
    assert!(program < 10_000);

    let to = key(0xb1);
    // Heaviest witnesses the script takes: three p2pkh-ecdsa inputs into three outputs; and a hash-chain borrow
    // with two delegates.
    let ecdsa = |seed: u8, amount: i64| {
        let k = key(seed);
        TokIn::new(Tok::new(2, blake3_of(&compressed(&k)), amount), Auth::PkhEcdsa(k))
    };
    let next: Vec<Tok> = [i64::MAX - 2, 1, 1].iter().map(|a| Tok::new(2, blake3_of(&compressed(&to)), *a).borrow(3, [0xab; 32])).collect();
    let heavy = Case::transfer(ecdsa(0xd1, i64::MAX - 100), vec![ecdsa(0xd2, 50), ecdsa(0xd3, 50)], &next);

    let (v, otk) = (key(0xc1), key(0xc3));
    let guard = blake3_of(&[[0x9a; 32].to_vec(), xonly(&otk).to_vec()].concat());
    let chained = Tok::schnorr(&v, 100).borrow(3, guard);
    let back = Tok { guard: [0x9a; 32], ..chained.clone().amount(190) };
    let nexts = vec![back, Tok::schnorr(&to, 5), Tok::schnorr(&to, 5)];
    let chain = Case::new(
        vec![Slot::Leader { input: TokIn::new(chained, Auth::Chain([0x9a; 32], otk)), path: vec![0x01], next: nexts.clone() }, Slot::Delegate(ecdsa(0xd2, 50)), Slot::Delegate(ecdsa(0xd3, 50)), Slot::funding()],
        nexts.iter().map(Out::tok).collect(),
    );
    // The plain shape the builders make: three p2pk inputs, three outputs.
    let plain = Case::transfer(TokIn::of(&key(0xa1), 50), vec![TokIn::of(&key(0xa2), 30), TokIn::of(&key(0xa3), 20)], &[Tok::schnorr(&to, 98), Tok::schnorr(&to, 1), Tok::schnorr(&to, 1)]);

    let calculator = MassCalculator::new_with_consensus_params(&MAINNET_PARAMS);
    let limits = MAINNET_PARAMS.block_mass_limits().after();
    for (what, case) in [("3 p2pk inputs, 3 outputs (the builders' largest)", plain), ("3 p2pkh-ecdsa inputs, 3 outputs", heavy), ("hash-chain borrow with 2 delegates, 3 outputs", chain)] {
        let (tx, utxos) = case.accepted(what);
        let mut committed = tx.clone();
        argent_runtime::execute_transaction_with_covenants(&mut committed, utxos.clone()).expect("runs");
        let masses = calculator.calc_non_contextual_masses(&committed);
        let mut worst = (0usize, 0usize, 0u64, 0usize);
        for i in 0..tx.inputs.len() {
            let (stack, ops, units) = measure(&tx, &utxos, i);
            println!("REV-TOKEN 9 limits:   {what}: input {i}: stack {stack}, opcodes {ops}, script units {units}, signature script {} bytes", tx.inputs[i].signature_script.len());
            worst = (worst.0.max(stack), worst.1.max(ops), worst.2.max(units), worst.3.max(tx.inputs[i].signature_script.len()));
        }
        println!(
            "REV-TOKEN 9 limits: {what}: deepest stack {} of 244, most opcodes in one input {} of 1 000 000, most script units {}, longest signature script {} bytes, compute mass {} of {}, transient mass {} of {}",
            worst.0, worst.1, worst.2, worst.3, masses.compute_mass, limits.compute, masses.transient_mass, limits.transient
        );
        assert!(worst.0 < 200, "stack {}", worst.0);
        assert!(worst.1 < 100_000, "opcodes {}", worst.1);
        assert!(masses.compute_mass * 3 < limits.compute && masses.transient_mass * 3 < limits.transient, "a transfer takes a third of a block");
    }
    tally("9 limits: the heaviest transfers");
}

/// Whatever state the script lets an output hold, its owner can spend again (alone, as a leader): amounts 0 and
/// the largest, every scheme pair, any KAS value. Nothing the script creates locks its own coin.
#[test]
fn p9_every_state_the_script_creates_can_be_spent_again() {
    let (a, to) = (key(0xa1), key(0xb1));
    for amount in [0i64, 1, 1_000_000_000_000_000, i64::MAX] {
        for borrow_scheme in 0u8..=3 {
            for value in [1u64, 20_000_000, TOKEN_SOMPI] {
                let made = Tok::schnorr(&to, amount).borrow(borrow_scheme, [0xfe; 32]);
                // Created by a transfer...
                let mut create = Case::transfer(TokIn::of(&a, amount), vec![], &[made.clone()]);
                create.outs[0] = Out::tok(&made).value(value);
                create.accepted("created");
                // ...and spent by its owner from a coin of that value.
                Case::transfer(TokIn::new(made.clone(), Auth::key(&to)).value(value), vec![], &[Tok::schnorr(&a, amount)]).accepted("spent again");
            }
        }
    }
    tally("9 limits: created states are spendable (amount x borrow scheme x KAS value)");
}
