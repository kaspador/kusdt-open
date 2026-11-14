//! Recompiles the contracts and refreshes the checked-in artifacts that the
//! transaction builders embed: `cargo run --example build_artifacts`.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = kusdt_kaspa::crate_root();
    let artifact = kusdt_kaspa::kusdt_artifact()?;
    std::fs::create_dir_all(root.join("artifacts"))?;
    std::fs::write(root.join("artifacts/kusdt.json"), serde_json::to_string_pretty(&artifact)? + "\n")?;
    println!("{} -> artifacts/kusdt.json", artifact.app);
    for (name, contract) in &artifact.sil_abi.contracts {
        println!("  {name}: {} bytes", contract.compiled.bytecode.len());
    }
    let pool = kusdt_kaspa::pool_artifact()?;
    std::fs::write(root.join("artifacts/pool.json"), serde_json::to_string_pretty(&pool)? + "
")?;
    println!("{} -> artifacts/pool.json", pool.app);
    for (name, contract) in &pool.sil_abi.contracts {
        println!("  {name}: {} bytes", contract.compiled.bytecode.len());
    }
    Ok(())
}
