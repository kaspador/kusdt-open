# The KCC-20 reference contracts

`contracts/kcc20.ag` and `contracts/token_seed.ag`, unchanged, from
[argent-lang/kcc20-reference](https://github.com/argent-lang/kcc20-reference) at commit
`27f8403fee55863125b044c73b2c9449d997a6ca` (ISC licence, per its `Cargo.toml`).

kUSDT imports these two actors, so they are part of what its covenant bytecode compiles from. They are
checked in so that the bytecode can be rebuilt and compared without fetching anything for the sources:
see `tools/check-artifacts.mjs`, which also compares them with that commit (`--upstream`).

Their path appears in the artifacts, so it stays here. Don't edit them: kUSDT's `KCC20` actor has to stay
byte for byte the standard one that wallets and indexers recognise.
