//! kUSDT in WebAssembly: the same JSON-in, JSON-out commands as the
//! `kusdt-tx` CLI (`kusdt_kaspa::api`), callable from a browser or Node.
//!
//! ```js
//! import init, { run } from '@kusdt/core';
//! await init();
//! const answer = JSON.parse(run('mint-digest', JSON.stringify(request)));
//! ```
//!
//! Secret keys passed in requests are used for one signing and dropped with
//! the request; nothing is stored.

use wasm_bindgen::prelude::*;

/// Runs `command` on a JSON request. Answers JSON: the result, or
/// `{"error": "..."}`.
#[wasm_bindgen]
pub fn run(command: &str, request: &str) -> String {
    match kusdt_kaspa::api::run(command, request) {
        Ok(value) => value.to_string(),
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}

/// The commands `run` accepts, as a JSON array.
#[wasm_bindgen]
pub fn commands() -> String {
    serde_json::to_string(kusdt_kaspa::api::COMMANDS).expect("static list")
}

/// The version of the contracts and builders compiled in.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
