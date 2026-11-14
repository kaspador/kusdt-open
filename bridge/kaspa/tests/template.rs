//! kUSDT must use the exact standard KCC20 template, so that wallets and
//! indexers which already accept KCC-20 recognise kUSDT states.

use kusdt_kaspa::{crate_root, kcc20_wallet_template, kusdt_artifact, read_json};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn kcc20_template_matches_the_one_wallets_accept() {
    let artifact = kusdt_artifact().expect("kUSDT app compiles");
    let (prefix, suffix) = kcc20_wallet_template(&artifact, "KCC20").expect("KCC20 contract");

    // Kaspire's copy of the standard template (kcc20-reference c8a0871).
    let accepted = read_json(
        &crate_root().join("../../vendor/third-party/kaspire-kcc20_standard_template.json"),
    )
    .expect("template file");
    assert_eq!(hex(&prefix), accepted["prefix"].as_str().unwrap(), "prefix");
    assert_eq!(hex(&suffix), accepted["suffix"].as_str().unwrap(), "suffix");
}
