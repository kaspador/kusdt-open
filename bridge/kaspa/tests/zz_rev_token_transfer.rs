//! Token review, properties 1 (conservation) and 2 (authorization), in the script engine,
//! on the checked-in artifact. Every refusal is the engine's, and each group starts from a
//! control of the same shape that the engine accepted.
//!
//!   cargo test --locked --test zz_rev_token_transfer -- --nocapture

#[path = "zz_rev_token_support.rs"]
mod support;

use kaspa_consensus_core::hashing::sighash_type::{SIG_HASH_ALL, SIG_HASH_ANY_ONE_CAN_PAY, SIG_HASH_NONE, SIG_HASH_SINGLE};
use support::*;

const MAX: i64 = i64::MAX;

fn amounts(key: &secp256k1::Keypair, list: &[i64]) -> Vec<Tok> {
    list.iter().map(|a| Tok::schnorr(key, *a)).collect()
}

/// Shapes: (input amounts, leader first), (output amounts).
fn shapes() -> Vec<(Vec<i64>, Vec<i64>)> {
    vec![
        (vec![100], vec![100]),
        (vec![100], vec![60, 40]),
        (vec![100], vec![60, 40, 0]),
        (vec![50, 30], vec![80]),
        (vec![50, 30, 20], vec![100]),
        (vec![50, 30, 20], vec![1, 2, 97]),
        (vec![0], vec![0]),
        (vec![0, 5], vec![5, 0]),
        (vec![0, 0, 0], vec![0, 0, 0]),
        (vec![MAX], vec![MAX - 7, 7, 0]),
        (vec![MAX - 10, 4, 6], vec![MAX]),
        (vec![1_000_000_000_000_000], vec![999_999_999_999_999, 1]),
    ]
}

fn shape(ins: &[i64], outs: &[i64]) -> Case {
    let (a, b) = (key(0xa1), key(0xb1));
    let leader = TokIn::of(&a, ins[0]);
    let delegates = ins[1..].iter().enumerate().map(|(i, x)| TokIn::of(&key(0xa2 + i as u8), *x)).collect();
    Case::transfer(leader, delegates, &amounts(&b, outs))
}

#[test]
fn p1_every_shape_conserves_and_no_other_total_is_accepted() {
    for (ins, outs) in shapes() {
        shape(&ins, &outs).accepted(&format!("{ins:?} -> {outs:?}"));
        // One unit more, one unit less, on each output in turn.
        for k in 0..outs.len() {
            for delta in [1i64, -1] {
                let mut bent = outs.clone();
                let Some(v) = bent[k].checked_add(delta) else { continue };
                bent[k] = v;
                shape(&ins, &bent).refused(&format!("{ins:?} -> {bent:?}"));
            }
        }
        // An extra output holding one unit, when there is room for one.
        if outs.len() < 3 {
            let mut more = outs.clone();
            more.push(1);
            shape(&ins, &more).refused(&format!("{ins:?} -> {more:?}"));
        }
    }
    tally("1 conservation: shapes, each bent by one unit");
}

#[test]
fn p1_what_the_leader_declares_must_be_what_the_outputs_hold() {
    let (a, b) = (key(0xa1), key(0xb1));
    let honest = amounts(&b, &[60, 40]);
    let base = Case::transfer(TokIn::of(&a, 100), vec![], &honest);
    base.accepted("100 -> 60, 40");

    // The arguments conserve, the outputs hold more (or other states).
    for forged in [vec![60i64, 41], vec![1_000_000, 40], vec![60, 40_000], vec![40, 60]] {
        let mut case = base.clone();
        case.outs = amounts(&b, &forged).iter().map(Out::tok).collect();
        case.refused(&format!("declared 60, 40 but outputs {forged:?}"));
    }
    // The outputs conserve, the arguments say something else.
    for declared in [vec![60i64, 39], vec![100], vec![60, 40, 0]] {
        let mut case = base.clone();
        case.slots[0] = Slot::leader(TokIn::of(&a, 100), &amounts(&b, &declared));
        case.refused(&format!("outputs 60, 40 but declared {declared:?}"));
    }
    // A token output of the family that the leader's arguments leave out.
    let mut extra = base.clone();
    extra.outs.push(Out::tok(&Tok::schnorr(&b, 1_000_000)));
    extra.refused("a third family output the leader did not declare");
    // The same extra output, claimed for the funding input instead (a 'genesis' into kUSDT's ID).
    let mut extra = base.clone();
    extra.outs.push(Out::tok(&Tok::schnorr(&b, 1_000_000)).by(1));
    extra.refused("a family output authorized by a plain coin");
    // No family output at all: the tokens would vanish.
    let mut none = base.clone();
    none.slots[0] = Slot::leader(TokIn::of(&a, 100), &[]);
    none.outs = vec![Out::plain()];
    none.refused("a transfer with no token output");
    // Four outputs.
    shape(&[100], &[25, 25, 25, 25]).refused("four token outputs");
    // An input that claims a larger state than its coin holds (leader, then delegate).
    // (The transaction is built over a coin that does hold the claimed state, then run against the smaller coin: the
    // program in the signature script no longer hashes to the coin's script.)
    let d = key(0xa2);
    let (tx, mut utxos) = Case::transfer(TokIn::of(&a, 1_000_000), vec![], &amounts(&b, &[1_000_000])).accepted("1 000 000 -> 1 000 000");
    utxos[0] = Tok::schnorr(&a, 100).utxo(K, TOKEN_SOMPI);
    refused(run(tx, utxos), "the leader overstates its own amount");
    let (tx, mut utxos) = Case::transfer(TokIn::of(&a, 100), vec![TokIn::of(&d, 1_000_000)], &amounts(&b, &[1_000_100])).accepted("100 + 1 000 000 -> 1 000 100");
    utxos[1] = Tok::schnorr(&d, 20).utxo(K, TOKEN_SOMPI);
    refused(run(tx, utxos), "a delegate overstates its amount");
    // The same with owners that need no signature (p2sh of OP_TRUE), so that the only thing wrong is the amount.
    let open = |amount: i64| TokIn::new(Tok::new(3, script_hash(&[0x51]), amount), Auth::Raw(vec![3]));
    let mut case = Case::transfer(open(100), vec![open(1_000_000)], &amounts(&b, &[1_000_100]));
    case.slots.push(Slot::Plain { entry: p2sh_coin(&[0x51]), sig: vec![0x01, 0x51] });
    let (tx, mut utxos) = case.accepted("unsigned owners: 100 + 1 000 000 -> 1 000 100");
    utxos[1] = Tok::new(3, script_hash(&[0x51]), 20).utxo(K, TOKEN_SOMPI);
    refused(run(tx.clone(), utxos.clone()), "an unsigned delegate overstates its amount");
    utxos[1] = Tok::new(3, script_hash(&[0x51]), 1_000_000).utxo(K2, TOKEN_SOMPI);
    refused(run(tx, utxos), "the delegate's coin is the same script under another covenant ID");
    tally("1 conservation: declared states against outputs");
}

#[test]
fn p1_negative_wrapping_and_respelled_amounts() {
    let (a, b) = (key(0xa1), key(0xb1));
    Case::transfer(TokIn::of(&a, 100), vec![], &amounts(&b, &[101, 0])).refused("control shape, one unit too many");
    Case::transfer(TokIn::of(&a, 100), vec![], &amounts(&b, &[100, 0])).accepted("100 -> 100, 0");
    // Negative outputs that would balance a larger one.
    for outs in [vec![101i64, -1], vec![1_000_000, -999_900], vec![MAX, -(MAX - 100)], vec![200, -50, -50]] {
        Case::transfer(TokIn::of(&a, 100), vec![], &amounts(&b, &outs)).refused(&format!("100 -> {outs:?}"));
    }
    // Sums past 2^63: would equal the input under wrapping arithmetic.
    //   5 -> MAX, MAX, 7      (MAX + MAX + 7 = 5 mod 2^64)
    Case::transfer(TokIn::of(&a, 5), vec![], &amounts(&b, &[MAX, MAX, 7])).refused("5 -> MAX, MAX, 7 (wraps to 5)");
    Case::transfer(TokIn::of(&a, 0), vec![], &amounts(&b, &[MAX, MAX, 2])).refused("0 -> MAX, MAX, 2 (wraps to 0)");
    // Inputs past 2^63 (they cannot exist under kUSDT's cap; under another ID anyone can make them).
    let d = key(0xa2);
    Case::transfer(TokIn::of(&a, MAX), vec![TokIn::of(&d, MAX)], &amounts(&b, &[MAX, MAX])).refused("MAX + MAX -> MAX, MAX");
    Case::transfer(TokIn::of(&a, MAX), vec![TokIn::of(&d, MAX), TokIn::of(&key(0xa3), 2)], &amounts(&b, &[0])).refused("MAX + MAX + 2 -> 0 (wraps to 0)");
    Case::transfer(TokIn::of(&a, MAX), vec![TokIn::of(&d, 1)], &amounts(&b, &[MAX])).refused("MAX + 1 -> MAX");

    // Respelling the amounts argument of an accepted transfer (no signature covers a signature script).
    let (tx, utxos) = Case::transfer(TokIn::of(&a, 100), vec![], &amounts(&b, &[100, 0])).accepted("100 -> 100, 0, for respelling");
    let items = pushes(&tx.inputs[0].signature_script);
    assert_eq!(items.len(), 9, "six state fields, the witness, the tag, the program");
    assert_eq!(items[0].len(), 16, "two eight-byte amounts");
    run(tx.clone(), utxos.clone()).expect("the untouched transaction runs again");
    count_control();
    let amounts_with = |change: &dyn Fn(&mut Vec<u8>)| {
        let mut bytes = items[0].clone();
        change(&mut bytes);
        run(with_push(&tx, 0, 0, bytes), utxos.clone())
    };
    // Negative zero for the empty output: the same number to the engine. What matters is that the OUTPUT is unchanged
    // (its script is fixed by the transaction ID), so the state on chain is the canonical one either way.
    let negative_zero = amounts_with(&|b| b[15] = 0x80);
    println!("REV-TOKEN probe: amounts respelled with a negative zero for the empty output: {}", if negative_zero.is_ok() { "ACCEPTED (same outputs, same states)" } else { "refused" });
    // Any other bytes are another number or no number.
    refused(amounts_with(&|b| b[7] = 0x80), "the first amount negated");
    refused(amounts_with(&|b| b[8] = 0x01), "the empty output declared as 1");
    refused(amounts_with(&|b| { b[0] = 99; b[8] = 1 }), "99 + 1 declared for outputs holding 100, 0");
    refused(amounts_with(&|b| b.push(0)), "seventeen amount bytes");
    refused(amounts_with(&|b| { b.pop(); }), "fifteen amount bytes");
    refused(amounts_with(&|b| b.truncate(8)), "one amount for two outputs");
    refused(amounts_with(&|b| b.extend_from_slice(&[0; 8])), "three amounts for two outputs");
    // The other grouped fields must have one entry per state too.
    for (field, len) in [(1usize, 64usize), (2, 2), (3, 2), (4, 64), (5, 64)] {
        assert_eq!(items[field].len(), len);
        let mut short = items[field].clone();
        short.pop();
        refused(run(with_push(&tx, 0, field, short), utxos.clone()), "a state field one byte short");
        let mut long = items[field].clone();
        long.push(0);
        refused(run(with_push(&tx, 0, field, long), utxos.clone()), "a state field one byte long");
    }
    // An extra stack item under the arguments, or one argument missing.
    let mut extra = tx.clone();
    extra.inputs[0].signature_script = [push_one(&[0x01, 0x02]), tx.inputs[0].signature_script.clone()].concat();
    refused(run(extra, utxos.clone()), "an extra push before the arguments");
    let mut fewer = tx.clone();
    fewer.inputs[0].signature_script = push_script(&items[1..]);
    refused(run(fewer, utxos.clone()), "the first argument missing");
    // A non-push opcode in the signature script.
    let mut nop = tx.clone();
    nop.inputs[0].signature_script = [vec![0x61], tx.inputs[0].signature_script.clone()].concat();
    refused(run(nop, utxos), "an OP_NOP in the signature script");
    tally("1 conservation: negative, wrapping and respelled numbers");
}

#[test]
fn p1_order_of_outputs_and_other_covenants_among_them() {
    let (a, b, c) = (key(0xa1), key(0xb1), key(0xc1));
    let next = amounts(&b, &[60, 40]);
    // kUSDT outputs between plain outputs and plain copies of their own scripts (decoys).
    let mut mixed = Case::transfer(TokIn::of(&a, 100), vec![], &next);
    let decoy = |t: &Tok| Out::Spk { spk: t.spk(), bind: None, value: TOKEN_SOMPI };
    mixed.outs = vec![Out::plain(), decoy(&next[1]), Out::tok(&next[0]), Out::plain(), decoy(&next[0]), Out::tok(&next[1]), Out::plain()];
    mixed.accepted("token outputs among plain outputs and decoys");
    // The same outputs, the bound ones in the other order: the leader's k-th state is its k-th bound output.
    let mut swapped = mixed.clone();
    swapped.outs = vec![Out::plain(), Out::tok(&next[1]), Out::plain(), Out::tok(&next[0])];
    swapped.refused("bound outputs in another order than declared");
    // A decoy instead of a bound output: the tokens of that state would be gone, so it must be refused.
    let mut unbound = mixed.clone();
    unbound.outs = vec![Out::tok(&next[0]), decoy(&next[1])];
    unbound.refused("the second state only as a plain output");

    // Another token (the same script under another covenant ID) moves in the same transaction: each conserves alone.
    let other_next = amounts(&c, &[7_000, 3_000]);
    let two = |k_out: &[i64], other_out: &[i64]| {
        let k_next = amounts(&b, k_out);
        let o_next = amounts(&c, other_out);
        Case::new(
            vec![Slot::leader(TokIn::of(&a, 100), &k_next), Slot::leader(TokIn::of(&c, 10_000).cov(K2), &o_next), Slot::funding()],
            k_next.iter().map(Out::tok).zip(o_next.iter().map(|t| Out::tok(t).cov(K2).by(1))).flat_map(|(x, y)| [y, x]).collect(),
        )
    };
    two(&[60, 40], &[7_000, 3_000]).accepted("kUSDT and another token, interleaved");
    two(&[60, 41], &[7_000, 2_999]).refused("one unit moved from the other token into kUSDT");
    two(&[5_060, 40], &[2_000, 3_000]).refused("5 000 units moved from the other token into kUSDT");
    two(&[60, 39], &[7_000, 3_001]).refused("one unit moved from kUSDT into the other token");
    let _ = other_next;

    // The other token's input as a DELEGATE of the kUSDT leader, to add its amount to kUSDT's.
    let k_next = amounts(&b, &[10_100]);
    Case::new(
        vec![Slot::leader(TokIn::of(&a, 100), &k_next), Slot::Delegate(TokIn::of(&c, 10_000).cov(K2)), Slot::funding()],
        k_next.iter().map(Out::tok).collect(),
    )
    .refused("another covenant's state as a kUSDT delegate");
    // The other token's leader authorizing an output bound to kUSDT's ID.
    let o_next = amounts(&c, &[10_000]);
    Case::new(
        vec![Slot::leader(TokIn::of(&c, 10_000).cov(K2), &o_next), Slot::funding()],
        vec![Out::tok(&o_next[0]).cov(K)],
    )
    .refused("another covenant's leader authorizing an output under kUSDT's ID");
    Case::new(vec![Slot::leader(TokIn::of(&c, 10_000).cov(K2), &o_next), Slot::funding()], vec![Out::tok(&o_next[0]).cov(K2)]).accepted("the other token alone");
    tally("1 conservation: output order, decoys, another covenant");
}

#[test]
fn p1_family_roles_cannot_be_bent() {
    let (a, b, d) = (key(0xa1), key(0xb1), key(0xa2));
    let next = amounts(&b, &[120]);
    Case::transfer(TokIn::of(&a, 100), vec![TokIn::of(&d, 20)], &next).accepted("leader then delegate");
    // The delegate first, the leader second.
    Case::new(vec![Slot::Delegate(TokIn::of(&d, 20)), Slot::leader(TokIn::of(&a, 100), &next), Slot::funding()], vec![Out::tok(&next[0]).by(1)]).refused("the leader is not the first family input");
    // Two leaders, each authorizing its own outputs (each would count the other's amount as a delegate's).
    let (n0, n1) = (amounts(&b, &[120]), amounts(&b, &[120]));
    Case::new(
        vec![Slot::leader(TokIn::of(&a, 100), &n0), Slot::leader(TokIn::of(&d, 20), &n1), Slot::funding()],
        vec![Out::tok(&n0[0]), Out::tok(&n1[0]).by(1)],
    )
    .refused("two leaders, 120 out twice");
    // Two delegates and no leader.
    Case::new(vec![Slot::Delegate(TokIn::of(&a, 100)), Slot::Delegate(TokIn::of(&d, 20)), Slot::funding()], vec![Out::plain()]).refused("delegates without a leader");
    // A delegate alone.
    Case::new(vec![Slot::Delegate(TokIn::of(&a, 100)), Slot::funding()], vec![Out::plain()]).refused("a delegate alone");
    // An output authorized by the delegate.
    let split = amounts(&b, &[100, 20]);
    Case::new(
        vec![Slot::leader(TokIn::of(&a, 100), &split[..1]), Slot::Delegate(TokIn::of(&d, 20)), Slot::funding()],
        vec![Out::tok(&split[0]), Out::tok(&split[1]).by(1)],
    )
    .refused("an output authorized by a delegate");
    // Four family inputs.
    // Four family inputs. The builder refuses to assemble that, so it is assembled by hand from an accepted
    // three-input transfer of owners that need no signature: a third delegate holding nothing is appended, which
    // changes no total, so the count is the only thing wrong.
    let open = |amount: i64| TokIn::new(Tok::new(3, script_hash(&[0x51]), amount), Auth::Raw(vec![4]));
    let mut three = Case::transfer(open(100), vec![open(20), open(0)], &amounts(&b, &[120]));
    three.slots.push(Slot::Plain { entry: p2sh_coin(&[0x51]), sig: vec![0x01, 0x51] });
    let (tx, utxos) = three.accepted("unsigned owners: 100 + 20 + 0 -> 120");
    let mut four = tx.clone();
    let mut extra = tx.inputs[2].clone();
    extra.previous_outpoint = outpoint(0x97, 0);
    four.inputs.push(extra);
    let mut four_utxos = utxos.clone();
    four_utxos.push(utxos[2].clone());
    refused(run(four, four_utxos), "three delegates");

    // Extension commitments: every input and output shares the leader's.
    let e = [0x5e; 32];
    let with_ext = |leader: [u8; 32], delegate: [u8; 32], out: [u8; 32]| {
        let next = vec![Tok::schnorr(&b, 120).ext(out)];
        Case::transfer(TokIn::new(Tok::schnorr(&a, 100).ext(leader), Auth::key(&a)), vec![TokIn::new(Tok::schnorr(&d, 20).ext(delegate), Auth::key(&d))], &next)
    };
    with_ext(e, e, e).accepted("one extension throughout");
    with_ext(e, [0; 32], e).refused("a delegate of another extension");
    with_ext(e, e, [0; 32]).refused("an output of another extension");
    with_ext([0; 32], [0; 32], e).refused("plain inputs into an output with an extension");

    // Scheme bytes outside the reference's lists, on an output.
    for scheme in [5u8, 6, 0x7f, 0x80, 0x84, 0xff] {
        Case::transfer(TokIn::of(&a, 100), vec![], &[Tok::new(scheme, xonly(&b), 100)]).refused(&format!("owner scheme {scheme:#x}"));
    }
    for borrow in [4u8, 5, 0x7f, 0x80, 0x83, 0xff] {
        Case::transfer(TokIn::of(&a, 100), vec![], &[Tok::schnorr(&b, 100).borrow(borrow, [0; 32])]).refused(&format!("borrow scheme {borrow:#x}"));
    }
    for scheme in 0u8..=4 {
        for borrow in 0u8..=3 {
            Case::transfer(TokIn::of(&a, 100), vec![], &[Tok::new(scheme, xonly(&b), 100).borrow(borrow, [0x33; 32])]).accepted(&format!("owner scheme {scheme}, borrow scheme {borrow}"));
        }
    }
    tally("1 conservation: roles, extensions, scheme bytes");
}

// ---------------------------------------------------------------------------
// Property 2: authorization.

/// A state of each owner scheme with the witness that moves it, and the extra inputs/outputs the scheme needs.
struct Owned {
    name: &'static str,
    tok: Tok,
    auth: Auth,
    /// Slots appended after the funding coin (a p2sh authority coin, another family's transfer), with their outputs.
    extra: Vec<Slot>,
    extra_outs: Vec<Out>,
}

/// `at`: the input index the scheme's extra coin will have.
fn owned(scheme: u8, amount: i64, at: usize) -> Owned {
    let k = key(0xd0 + scheme);
    match scheme {
        0 => Owned { name: "p2pk-schnorr", tok: Tok::schnorr(&k, amount), auth: Auth::key(&k), extra: vec![], extra_outs: vec![] },
        1 => Owned { name: "p2pkh-schnorr", tok: Tok::new(1, blake3_of(&xonly(&k)), amount), auth: Auth::PkhSchnorr(k), extra: vec![], extra_outs: vec![] },
        2 => Owned { name: "p2pkh-ecdsa", tok: Tok::new(2, blake3_of(&compressed(&k)), amount), auth: Auth::PkhEcdsa(k), extra: vec![], extra_outs: vec![] },
        3 => Owned {
            name: "p2sh",
            tok: Tok::new(3, script_hash(&[0x51]), amount),
            auth: Auth::Raw(vec![at as u8]),
            extra: vec![Slot::Plain { entry: p2sh_coin(&[0x51]), sig: vec![0x01, 0x51] }],
            extra_outs: vec![],
        },
        _ => {
            // Owned by another family (ID K2): one of its members moves in the same transaction.
            let member = key(0xd9);
            let next = vec![Tok::schnorr(&member, 9)];
            Owned {
                name: "covenant-id",
                tok: Tok::new(4, K2, amount),
                auth: Auth::none(),
                extra: vec![Slot::leader(TokIn::of(&member, 9).cov(K2), &next)],
                extra_outs: vec![Out::tok(&next[0]).cov(K2).by(at as u16)],
            }
        }
    }
}

/// The scheme's state as the leader (alone) or as the delegate of a p2pk leader.
fn auth_case(scheme: u8, as_delegate: bool, auth: Option<Auth>, with_extra: bool) -> Case {
    let (l, to) = (key(0xa1), key(0xb1));
    let at = if as_delegate { 3 } else { 2 };
    let o = owned(scheme, 70, at);
    let input = TokIn::new(o.tok.clone(), auth.unwrap_or(o.auth.clone()));
    let mut case = if as_delegate {
        Case::transfer(TokIn::of(&l, 30), vec![input], &[Tok::schnorr(&to, 100)])
    } else {
        Case::transfer(input, vec![], &[Tok::schnorr(&to, 70)])
    };
    if with_extra {
        case.slots.extend(o.extra);
        case.outs.extend(o.extra_outs);
    }
    case
}

#[test]
fn p2_every_scheme_moves_only_with_its_owner() {
    let stranger = key(0xee);
    for scheme in 0u8..=4 {
        for as_delegate in [false, true] {
            let role = if as_delegate { "delegate" } else { "leader" };
            let name = owned(scheme, 0, 0).name;
            auth_case(scheme, as_delegate, None, true).accepted(&format!("{name} as {role}"));
            let mut wrong: Vec<(&str, Auth)> = vec![
                ("no witness", Auth::none()),
                ("a stranger's p2pk signature", Auth::key(&stranger)),
                ("a stranger's key and signature (p2pkh-schnorr form)", Auth::PkhSchnorr(stranger)),
                ("a stranger's key and signature (p2pkh-ecdsa form)", Auth::PkhEcdsa(stranger)),
                ("65 zero bytes", Auth::Raw(vec![0; 65])),
                ("97 zero bytes", Auth::Raw(vec![0; 97])),
                ("98 zero bytes", Auth::Raw(vec![0; 98])),
                ("one byte: input 0", Auth::Raw(vec![0])),
                ("one byte: input 1", Auth::Raw(vec![1])),
                ("one byte: an input that does not exist", Auth::Raw(vec![9])),
                ("one byte: 0xff", Auth::Raw(vec![0xff])),
            ];
            // The scheme's own right witness is not wrong for it.
            if scheme == 4 {
                wrong.remove(0);
            }
            for (what, auth) in wrong {
                auth_case(scheme, as_delegate, Some(auth), true).refused(&format!("{name} as {role}: {what}"));
            }
            // p2sh and covenant-id: the right witness without the coin it points at.
            if scheme >= 3 {
                auth_case(scheme, as_delegate, None, false).refused(&format!("{name} as {role}: the authority is not in the transaction"));
            }
        }
    }
    tally("2 authorization: five schemes, as leader and as delegate");
}

#[test]
fn p2_scheme_details() {
    let (to, stranger) = (key(0xb1), key(0xee));
    // p2pkh: the owner's key with a stranger's signature, and a stranger's key with the owner's hash.
    for scheme in [1u8, 2] {
        let k = key(0xd0 + scheme);
        let tok = owned(scheme, 70, 0).tok;
        let case = |auth: Auth| Case::transfer(TokIn::new(tok.clone(), auth), vec![], &[Tok::schnorr(&to, 70)]);
        case(owned(scheme, 70, 0).auth).accepted("p2pkh control");
        let (tx, utxos) = case(owned(scheme, 70, 0).auth).accepted("p2pkh control, for surgery");
        let items = pushes(&tx.inputs[0].signature_script);
        let witness = items[6].clone();
        let key_len = if scheme == 1 { 32 } else { 33 };
        assert_eq!(witness.len(), 1 + key_len + 65);
        // Flip one bit of the key, of the signature, of the sighash type; drop or add a byte.
        for (what, at) in [("key", 1usize), ("signature", 1 + key_len), ("signature s", 1 + key_len + 40), ("sighash type", key_len + 65)] {
            let mut w = witness.clone();
            w[at] ^= 0x01;
            refused(run(with_push(&tx, 0, 6, w), utxos.clone()), &format!("scheme {scheme}: one bit of the {what} flipped"));
        }
        let mut short = witness.clone();
        short.pop();
        refused(run(with_push(&tx, 0, 6, short), utxos.clone()), "the witness one byte short");
        let mut long = witness.clone();
        long.push(0x01);
        refused(run(with_push(&tx, 0, 6, long), utxos.clone()), "the witness one byte long");
        // The owner's key bytes, a stranger's signature.
        let stranger_sig = if scheme == 1 { Auth::PkhSchnorr(stranger) } else { Auth::PkhEcdsa(stranger) };
        let (stx, _) = Case::transfer(TokIn::new(Tok::new(scheme, blake3_of(&if scheme == 1 { xonly(&stranger).to_vec() } else { compressed(&stranger).to_vec() }), 70), stranger_sig), vec![], &[Tok::schnorr(&to, 70)])
            .accepted("the stranger's own state of the same shape");
        let theirs = pushes(&stx.inputs[0].signature_script)[6].clone();
        let mut mixed = witness[..1 + key_len].to_vec();
        mixed.extend_from_slice(&theirs[1 + key_len..]);
        refused(run(with_push(&tx, 0, 6, mixed), utxos.clone()), "the owner's key with a stranger's signature");
        // A Schnorr signature where ECDSA is asked and the reverse (same key).
        let crossed = if scheme == 1 { [xonly(&k).to_vec(), vec![0u8; 65]].concat() } else { [compressed(&k).to_vec(), vec![0u8; 65]].concat() };
        refused(run(with_push(&tx, 0, 6, [vec![0u8], crossed].concat()), utxos.clone()), "the key with an empty signature");
    }

    // p2sh: which input the witness may point at.
    let hash = script_hash(&[0x51]);
    let tok = Tok::new(3, hash, 70);
    let p2sh = |index: u8, authority: Slot| {
        let mut case = Case::transfer(TokIn::new(tok.clone(), Auth::Raw(vec![index])), vec![], &[Tok::schnorr(&to, 70)]);
        case.slots.push(authority);
        case
    };
    let true_coin = || Slot::Plain { entry: p2sh_coin(&[0x51]), sig: vec![0x01, 0x51] };
    p2sh(2, true_coin()).accepted("p2sh: the authority at input 2");
    p2sh(1, true_coin()).refused("p2sh: pointing at the funding coin");
    p2sh(0, true_coin()).refused("p2sh: pointing at the token itself");
    p2sh(3, true_coin()).refused("p2sh: pointing past the inputs");
    // A coin of another script (OP_1 OP_1 OP_EQUAL), spent correctly.
    p2sh(2, Slot::Plain { entry: p2sh_coin(&[0x51, 0x51, 0x87]), sig: vec![0x03, 0x51, 0x51, 0x87] }).refused("p2sh: a coin of another script");
    // The owner's script as a bare script (not P2SH).
    p2sh(2, Slot::Plain { entry: funding(), sig: vec![] }).refused("p2sh: a bare OP_TRUE coin");
    // Witness of the wrong length.
    let mut two = p2sh(2, true_coin());
    two.slots[0] = Slot::leader(TokIn::new(tok.clone(), Auth::Raw(vec![2, 0])), &[Tok::schnorr(&to, 70)]);
    two.refused("p2sh: a two-byte witness");
    // One authority coin serves every state of that owner in the transaction (leader and delegate): by design.
    let mut both = Case::transfer(TokIn::new(tok.clone(), Auth::Raw(vec![3])), vec![TokIn::new(tok.clone().amount(5), Auth::Raw(vec![3]))], &[Tok::schnorr(&to, 75)]);
    both.slots.push(true_coin());
    both.accepted("p2sh: one authority coin for two states of the same owner");

    // covenant-id: the witness must be empty, and the family must be present.
    let cov = |auth: Auth, present: bool| auth_case(4, false, Some(auth), present);
    cov(Auth::none(), true).accepted("covenant-id control");
    cov(Auth::Raw(vec![0]), true).refused("covenant-id: a one-byte witness");
    cov(Auth::none(), false).refused("covenant-id: the owning family is absent");
    // A plain coin does not stand for a family, nor does a family of another ID.
    let member = key(0xd9);
    let next = vec![Tok::schnorr(&member, 9)];
    let mut other = Case::transfer(TokIn::new(Tok::new(4, K2, 70), Auth::none()), vec![], &[Tok::schnorr(&to, 70)]);
    other.slots.push(Slot::leader(TokIn::of(&member, 9).cov(POOL), &next));
    other.outs.push(Out::tok(&next[0]).cov(POOL).by(2));
    other.refused("covenant-id: a member of another family");
    tally("2 authorization: scheme details");
}

#[test]
fn p2_a_signature_serves_one_input_of_one_transaction() {
    let (a, b, c) = (key(0xa1), key(0xb1), key(0xc1));
    // Two states of the same owner: each needs its own signature.
    let two = |leader: Auth, delegate: Auth| Case::transfer(TokIn::new(Tok::schnorr(&a, 100), leader), vec![TokIn::new(Tok::schnorr(&a, 20), delegate)], &[Tok::schnorr(&b, 120)]);
    two(Auth::key(&a), Auth::key(&a)).accepted("two states of one owner");
    two(Auth::key(&a), Auth::SchnorrFor(a, 0)).refused("the delegate reuses the leader's signature");
    two(Auth::SchnorrFor(a, 1), Auth::key(&a)).refused("the leader reuses the delegate's signature");

    // A signature from another transaction of the same owner over the same coin, with other outputs.
    let pay_b = Case::transfer(TokIn::of(&a, 100), vec![], &[Tok::schnorr(&b, 100)]);
    let pay_c = Case::transfer(TokIn::of(&a, 100), vec![], &[Tok::schnorr(&c, 100)]);
    let (tx_b, utxos) = pay_b.accepted("pays b");
    let (tx_c, _) = pay_c.accepted("pays c");
    let sig_b = pushes(&tx_b.inputs[0].signature_script)[6].clone();
    refused(run(with_push(&tx_c, 0, 6, sig_b.clone()), utxos.clone()), "the signature that paid b on the transaction that pays c");
    // The same signature on the same outputs but another coin of the owner (a later state of the same amount).
    let mut later = tx_b.clone();
    later.inputs[0].previous_outpoint = outpoint(0x99, 0);
    refused(run(later, utxos.clone()), "the signature replayed on another coin of the same state");

    // What SIGHASH_ALL covers: any change after signing is refused.
    let (tx, utxos) = Case::transfer(TokIn::of(&a, 100), vec![], &[Tok::schnorr(&b, 60), Tok::schnorr(&a, 40)]).accepted("signed with SIGHASH_ALL");
    let bent = |change: &dyn Fn(&mut kaspa_consensus_core::tx::Transaction)| {
        let mut t = tx.clone();
        change(&mut t);
        run(t, utxos.clone())
    };
    refused(bent(&|t| t.outputs[0].value += 1), "an output's KAS value changed");
    refused(bent(&|t| t.outputs.swap(0, 1)), "the two outputs swapped");
    refused(bent(&|t| t.payload = b"KUSDT".to_vec()), "a payload added");
    refused(bent(&|t| t.lock_time = 1), "the lock time changed");
    refused(bent(&|t| t.inputs[0].sequence = 1), "the sequence changed");
    refused(bent(&|t| t.inputs[1].previous_outpoint = outpoint(0x98, 0)), "the funding input replaced");
    refused(bent(&|t| t.outputs.push(kaspa_consensus_core::tx::TransactionOutput { value: 1_000_000, script_public_key: funding().script_public_key, covenant: None })), "a plain output added");
    refused(bent(&|t| t.outputs[1].covenant = None), "a binding removed");
    refused(bent(&|t| t.outputs.truncate(1)), "an output removed");

    // Other sighash types are the owner's own choice, as for a plain coin. Recorded as a fact: the script takes what
    // the engine takes. The builders (tx.rs, pool.rs) sign SIGHASH_ALL only.
    for (name, t) in [
        ("NONE", SIG_HASH_NONE.to_u8()),
        ("SINGLE", SIG_HASH_SINGLE.to_u8()),
        ("ALL|ANYONECANPAY", SIG_HASH_ALL.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8()),
        ("NONE|ANYONECANPAY", SIG_HASH_NONE.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8()),
    ] {
        let r = Case::transfer(TokIn::new(Tok::schnorr(&a, 100), Auth::Schnorr(a, t)), vec![], &[Tok::schnorr(&b, 100)]).build();
        println!("REV-TOKEN probe: an owner signature of type {name}: {}", if r.is_ok() { "accepted" } else { "refused" });
    }
    // An invalid sighash type byte.
    let (tx, utxos) = Case::transfer(TokIn::of(&a, 100), vec![], &[Tok::schnorr(&b, 100)]).accepted("for the sighash byte");
    let mut w = pushes(&tx.inputs[0].signature_script)[6].clone();
    *w.last_mut().unwrap() = 0x00;
    refused(run(with_push(&tx, 0, 6, w.clone()), utxos.clone()), "sighash type 0");
    *w.last_mut().unwrap() = 0x03;
    refused(run(with_push(&tx, 0, 6, w), utxos), "sighash type 3");
    tally("2 authorization: what a signature covers");
}

#[test]
fn p2_the_path_byte() {
    let (a, b) = (key(0xa1), key(0xb1));
    let with_path = |path: Vec<u8>| {
        let mut case = Case::transfer(TokIn::of(&a, 100), vec![], &[Tok::schnorr(&b, 100)]);
        case.slots[0] = Slot::Leader { input: TokIn::of(&a, 100), path, next: vec![Tok::schnorr(&b, 100)] };
        case
    };
    with_path(vec![0x00]).accepted("path 0 with the owner's signature");
    for path in 1u8..=255 {
        with_path(vec![path]).refused(&format!("path byte {path:#x} with the owner's signature"));
    }
    with_path(vec![]).refused("no path byte: the signature's first byte is read as the path");
    with_path(vec![0x00, 0x00]).refused("two path bytes");
    // A delegate has no path byte: a leader-style witness (00 ‖ signature) is refused.
    let d = key(0xa2);
    let (tx, utxos) = Case::transfer(TokIn::of(&a, 100), vec![TokIn::of(&d, 20)], &[Tok::schnorr(&b, 120)]).accepted("a delegate");
    let w = pushes(&tx.inputs[1].signature_script)[0].clone();
    assert_eq!(w.len(), 65);
    for path in [0x00u8, 0x01] {
        refused(run(with_push(&tx, 1, 0, [vec![path], w.clone()].concat()), utxos.clone()), "a delegate witness with a path byte");
    }
    // An empty leader witness.
    let (tx, utxos) = with_path(vec![0x00]).accepted("for the empty witness");
    refused(run(with_push(&tx, 0, 6, vec![]), utxos), "an empty leader witness");
    tally("2 authorization: the path byte");
}
