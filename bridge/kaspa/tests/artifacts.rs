//! The builders embed `artifacts/kusdt.json` and `artifacts/pool.json`; they
//! must be what the contracts compile to today. Refresh them with
//! `cargo run --example build_artifacts`.

fn assert_fresh(contract: &str, out: &str, checked_in: &str) {
    let fresh = kusdt_kaspa::build_contract(contract, out).expect("compiles");
    let fresh = serde_json::to_value(&fresh).unwrap();
    let checked_in: serde_json::Value = serde_json::from_str(checked_in).expect("checked-in artifact parses");
    assert!(fresh == checked_in, "the artifact of {contract} is stale: run `cargo run --example build_artifacts`");
}

#[test]
fn checked_in_kusdt_artifact_matches_the_contracts() {
    assert_fresh("kusdt.ag", "test-artifacts", include_str!("../artifacts/kusdt.json"));
}

#[test]
fn checked_in_pool_artifact_matches_the_contracts() {
    assert_fresh("pool.ag", "test-artifacts-pool", include_str!("../artifacts/pool.json"));
}
