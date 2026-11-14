//! Run 21, outside review (Daybreak [41]): on any pool state and any amount the core answers, it never panics.
//!
//! The quote command and the pool builders divide by the pool's reserves, its shares and its breaker window. A pool
//! before its first deposit (no shares, no reserves), a window of 0 or below zero, or an amount below zero that brings a
//! reserve plus itself to zero panicked: that stops the CLI and traps the WebAssembly core (a panic aborts in wasm32),
//! where the caller expects `{"error": ...}`. Each is refused now with the reason; opened pools are quoted as before.
//! The reviewer's reproduction (run 21, agents/pool, `daybreak41_quotes_on_zero_states_panic`), with the builders added.
//!
//!   cargo test --locked --test run21_pool_quotes -- --nocapture

use std::panic::{AssertUnwindSafe, catch_unwind};

use kusdt_kaspa::api;
use serde_json::{Value, json};

const KAS: i64 = 100_000_000;
const KAS_RESERVE: i64 = 10_000 * KAS;
const TOKEN_RESERVE: i64 = 1_000_000_000;

fn pool_id() -> String {
    "22".repeat(32)
}

fn token_id() -> String {
    "11".repeat(32)
}

/// A pool after its first deposit: 10 000 KAS and 1 000 kUSDT, the deployment's breaker (10 % per 36 000 DAA).
fn opened() -> Value {
    json!({
        "tokenCovid": token_id(), "kasReserve": KAS_RESERVE, "tokenReserve": TOKEN_RESERVE, "totalShares": KAS_RESERVE,
        "protocolKas": 0, "protocolTokens": 0, "baseValue": KAS, "admin": "33".repeat(32), "maxOutBps": 1_000, "windowLen": 36_000,
        "windowCredit": 0, "windowRef": KAS_RESERVE, "windowOut": 0, "paused": false, "guardian": "44".repeat(32),
    })
}

fn with(mut base: Value, changes: Value) -> Value {
    for (k, v) in changes.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

/// What pool genesis leaves: no shares, no reserves, no reference yet.
fn never_opened() -> Value {
    with(opened(), json!({ "kasReserve": 0, "tokenReserve": 0, "totalShares": 0, "windowRef": 0 }))
}

/// The amount below zero that leaves exactly `-reserve` once the 0.50 % fee is taken (rounded toward zero, as the
/// quote does): a buy or sell quote's denominator, the reserve plus it, is then zero.
fn cancelling(reserve: i64) -> i64 {
    let amount = -((reserve as i128 * 10_000 + 9_949) / 9_950);
    assert_eq!(amount * 9_950 / 10_000, -(reserve as i128));
    amount as i64
}

/// What `command` answers: its answer or its error, or the message of the panic that stopped it.
fn ask(command: &str, request: &Value) -> Result<Result<Value, String>, String> {
    let text = request.to_string();
    catch_unwind(AssertUnwindSafe(|| api::run(command, &text))).map_err(|p| {
        p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
    })
}

/// Each request must be refused with an error naming `why`: never a panic, never an answer.
fn all_refused(cases: Vec<(&str, &str, Value, &str)>) {
    let mut wrong = Vec::new();
    for (what, command, request, why) in cases {
        match ask(command, &request) {
            Err(panic) => {
                println!("RUN21 [41] {what}: PANIC ({panic})");
                wrong.push(what);
            }
            Ok(Ok(answer)) => {
                println!("RUN21 [41] {what}: answered {answer}");
                wrong.push(what);
            }
            Ok(Err(e)) => {
                println!("RUN21 [41] {what}: error: {e}");
                assert!(e.contains(why), "{what}: an error, but not the one expected ({why}): {e}");
            }
        }
    }
    assert!(wrong.is_empty(), "not refused with an error: {wrong:?}");
}

fn located(utxo_covenant: &str, state: Value, daa: u64) -> Value {
    json!({
        "utxo": { "transactionId": "ab".repeat(32), "index": 0, "amount": 2 * KAS, "scriptPublicKey": "000051", "covenantId": utxo_covenant, "blockDaaScore": daa },
        "state": state,
    })
}

/// The pool coin and its reserve, as a builder takes them.
fn pool_and_reserve(pool: &Value) -> (Value, Value) {
    let amount = pool["tokenReserve"].as_i64().unwrap() + pool["protocolTokens"].as_i64().unwrap();
    let reserve = json!({ "amount": amount, "owner": pool_id(), "ownerScheme": 4, "borrowScheme": 0, "borrowGuard": "00".repeat(32), "extensionCommitment": "00".repeat(32) });
    (located(&pool_id(), pool.clone(), 999_000), located(&token_id(), reserve, 999_000))
}

/// A holder's plain kUSDT, as a seller or provider gives it.
fn holding(amount: i64) -> Value {
    let mut h = located(&token_id(), json!({ "amount": amount, "owner": "55".repeat(32), "ownerScheme": 0 }), 999_000);
    h["secretKey"] = json!("66".repeat(32));
    h
}

fn common(extra: Value) -> Value {
    with(json!({ "network": "mainnet", "changeAddress": "kaspa:qqd6e65yefepe9wk0m9vuxdufxd80sphy67gwwd0vdaumzdt4tc9s3qt0lqeh", "funding": [] }), extra)
}

#[test]
fn quotes_on_a_pool_with_no_price_or_no_window_and_amounts_below_zero_are_errors() {
    let never = never_opened();
    let window = |len: i64| with(opened(), json!({ "windowLen": len }));
    all_refused(vec![
        ("buy 1 sompi, a pool before its first deposit", "quote", json!({ "kind": "buy", "pool": never, "kasIn": 1 }), "no liquidity"),
        ("buy 1 000 sompi, a pool before its first deposit", "quote", json!({ "kind": "buy", "pool": never, "kasIn": 1_000 }), "no liquidity"),
        ("sell, a pool before its first deposit", "quote", json!({ "kind": "sell", "pool": never, "tokensIn": 1 }), "no liquidity"),
        ("add, a pool before its first deposit", "quote", json!({ "kind": "add", "pool": never, "kasIn": 1_000, "tokensIn": 1_000 }), "no liquidity"),
        ("remove, a pool before its first deposit", "quote", json!({ "kind": "remove", "pool": never, "shares": 1 }), "no liquidity"),
        ("remove, no shares but reserves", "quote", json!({ "kind": "remove", "pool": with(opened(), json!({ "totalShares": 0 })), "shares": 1 }), "no liquidity"),
        ("sell with a clock, windowLen 0", "quote", json!({ "kind": "sell", "pool": window(0), "tokensIn": 1_000, "nowDaa": 10, "poolDaa": 5 }), "windowLen 0"),
        ("sell with a clock, windowLen -1", "quote", json!({ "kind": "sell", "pool": window(-1), "tokensIn": 1_000, "nowDaa": 10, "poolDaa": 5 }), "windowLen -1"),
        ("sell with a clock, windowLen 2^62", "quote", json!({ "kind": "sell", "pool": window(1i64 << 62), "tokensIn": 1_000, "nowDaa": 10, "poolDaa": 5 }), "windowLen"),
        ("buy, kasIn below zero that cancels the KAS reserve", "quote", json!({ "kind": "buy", "pool": opened(), "kasIn": cancelling(KAS_RESERVE) }), "below zero"),
        ("sell, tokensIn below zero that cancels the token reserve", "quote", json!({ "kind": "sell", "pool": opened(), "tokensIn": cancelling(TOKEN_RESERVE) }), "below zero"),
        ("remove, shares below zero", "quote", json!({ "kind": "remove", "pool": opened(), "shares": -1 }), "below zero"),
    ]);
}

#[test]
fn pool_builders_on_such_states_are_errors() {
    let never = never_opened();
    let (pool, reserve) = pool_and_reserve(&opened());
    let (never_pool, never_reserve) = pool_and_reserve(&never);
    let (no_window, no_window_reserve) = pool_and_reserve(&with(opened(), json!({ "windowLen": 0 })));
    let (below_zero_window, _) = pool_and_reserve(&with(opened(), json!({ "windowLen": -1 })));
    let position = located(&pool_id(), json!({ "tokenCovid": token_id(), "shares": 1_000_000, "owner": "77".repeat(32) }), 999_000);
    all_refused(vec![
        (
            "pool-buy, kasIn below zero that cancels the KAS reserve",
            "pool-buy",
            common(json!({ "pool": pool, "reserve": reserve, "kasIn": cancelling(KAS_RESERVE), "tokensOut": 1, "buyer": "88".repeat(32), "tokenValue": 150_000_000 })),
            "kasIn",
        ),
        (
            "pool-sell, windowLen 0",
            "pool-sell",
            common(json!({ "pool": no_window, "reserve": no_window_reserve, "payer": holding(5_000_000), "tokensIn": 1_000_000, "kasOut": 1, "tokenValue": 150_000_000, "nowDaa": 1_000_000 })),
            "windowLen 0",
        ),
        (
            "pool-add, a pool before its first deposit",
            "pool-add",
            common(json!({
                "pool": never_pool.clone(), "reserve": never_reserve.clone(), "provider": holding(5_000_000), "kasIn": 100 * KAS, "tokensIn": 1_000_000, "shares": 1,
                "positionOwner": "77".repeat(32), "tokenValue": 150_000_000, "positionValue": 2 * KAS,
            })),
            "no liquidity",
        ),
        (
            "pool-remove, a pool before its first deposit",
            "pool-remove",
            common(json!({
                "pool": never_pool, "reserve": never_reserve, "position": position, "positionSecretKey": "99".repeat(32), "kasOut": 0, "tokensOut": 0,
                "receiver": "77".repeat(32), "tokenValue": 150_000_000,
            })),
            "no liquidity",
        ),
        ("pool-tick, windowLen -1", "pool-tick", common(json!({ "pool": below_zero_window, "nowDaa": 1_000_000 })), "windowLen -1"),
    ]);
}

#[test]
fn opened_pools_are_quoted_as_before() {
    let eff = |x: i64| x as i128 * 9_950 / 10_000;
    let quote = |request: Value| api::run("quote", &request.to_string()).unwrap_or_else(|e| panic!("{request}: {e}"));
    let buy = quote(json!({ "kind": "buy", "pool": opened(), "kasIn": 10 * KAS }));
    assert_eq!(buy["tokensOut"], json!((TOKEN_RESERVE as i128 * eff(10 * KAS) / (KAS_RESERVE as i128 + eff(10 * KAS))) as i64));
    let sell = quote(json!({ "kind": "sell", "pool": opened(), "tokensIn": 1_000_000, "nowDaa": 1_000_000, "poolDaa": 999_000 }));
    assert_eq!(sell["kasOut"], json!((KAS_RESERVE as i128 * eff(1_000_000) / (TOKEN_RESERVE as i128 + eff(1_000_000))) as i64));
    assert_eq!(sell["breaker"]["maxKasOut"], json!(KAS_RESERVE / 10), "a fresh breaker lets out 10 % of the reserve");
    assert_eq!(quote(json!({ "kind": "add", "pool": opened(), "kasIn": KAS, "tokensIn": 100_000 }))["shares"], json!(KAS));
    assert_eq!(quote(json!({ "kind": "remove", "pool": opened(), "shares": KAS_RESERVE / 10 })), json!({ "kasOut": KAS_RESERVE / 10, "tokensOut": TOKEN_RESERVE / 10 }));
    // A quote of nothing is nothing (the wallet asks for one to read the breaker); so is one on a pool that only kept
    // its unowned shares.
    assert_eq!(quote(json!({ "kind": "buy", "pool": opened(), "kasIn": 0 }))["tokensOut"], json!(0));
    assert_eq!(quote(json!({ "kind": "sell", "pool": opened(), "tokensIn": 0, "nowDaa": 1_000_000 }))["kasOut"], json!(0));
    let emptied = with(opened(), json!({ "totalShares": 1_000, "kasReserve": 1_000, "tokenReserve": 100 }));
    assert_eq!(quote(json!({ "kind": "add", "pool": emptied, "kasIn": 1_000, "tokensIn": 100 }))["shares"], json!(1_000));
}
