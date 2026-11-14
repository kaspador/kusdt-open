# kUSDT: the open code

kUSDT is USDT from Ethereum and BNB Chain, issued 1:1 on Kaspa Layer 1 as a KCC-20 covenant token, with KasPool, a
KAS ⇄ kUSDT pool, also on Kaspa L1. This repository holds the code that holds and moves users' money, and the wallet
that signs for them, published so that anyone can read it and check it against the chains.

- App: [trestly.io](https://trestly.io)
- Docs: [trestly.io/docs](https://trestly.io/docs/)
- Addresses: [Status](https://trestly.io/docs/overview/status/#addresses), published once the mainnet launch is verified

> **Not audited.** No independent audit and no legal review have been done. Internal attack rounds and outside
> reviews have, and each finding is answered in the docs ([Audit status](https://trestly.io/docs/security/audit-status/),
> [Known limits](https://trestly.io/docs/security/known-limits/)). Use it only with what you can afford to lose.

## What is here

| Path | What |
|---|---|
| `bridge/evm/` | `KusdtVault` and `KusdtAccessManager` (Solidity 0.8.24), the Hardhat setup and their tests |
| `bridge/kaspa/contracts/` | The Kaspa covenants: `bridge_mint.ag` and `kusdt.ag` (BridgeMint and the kUSDT token family), `pool.ag` (KasPool) |
| `bridge/kaspa/artifacts/` | Their compiled bytecode, and `PROVENANCE.json`: the pinned compiler commit and the hash of every source and artifact |
| `covenants-silverscript/` | The SilverScript the pinned compiler generates from those sources, with checksums |
| `bridge/kaspa/src/`, `tests/`, `wasm/` | The Rust transaction builders and the covenant tests; the WebAssembly core is built from them |
| `bridge/packages/` | The client packages the wallet uses: protocol encoding, Kaspa, and that WebAssembly core |
| `wallet/extension/` | kUSDT Wallet, the browser extension |
| `SPEC.md` | The protocol specification |
| `deployments/` | `testnet.json`, the public testnet (4 to 14 November 2026); the mainnet record once the launch is verified |
| `tools/`, `.github/workflows/artifacts.yml` | Rebuild the covenants and the WebAssembly core, and compare them byte for byte |
| `vendor/kcc20-reference/` | The standard KCC-20 actors kUSDT imports, unchanged from upstream |

This is a snapshot of the release `mainnet-v0.9.8-rc.25` (commit `f9bf1f8` of the development repository).

Not here: the off-chain services (the five signers, the coordinator, the monitors and the pool keeper), the
deployment packages and the runbooks. What they can do is bounded by the on-chain rules below, which are all in this
repository. Operators and auditors have access to the rest.

## What the code itself guarantees

Read these in `bridge/evm/contracts/` and `bridge/kaspa/contracts/`:

- **The vaults can't be upgraded.** No proxy, no `delegatecall`, no self-destruct: the code verified on the block
  explorers is the code that runs, for good.
- **A payout needs 3 of the 5 independent signers**, and then waits 10 minutes in the vault, during which a pause stops
  it. Each vault's release allowance caps what can leave in a day.
- **kUSDT is minted only by the BridgeMint covenant**, with 3 of the 5 signers' signatures for a deposit a vault
  recorded, within a daily mint allowance, under a hard cap that can only be lowered.
- **The vaults' owner is an AccessManager under a 2-of-3 Safe.** Every change waits 48 hours (6 for the emergency
  role), and independent cancellers can cancel it in that time.
- **Two monitors, on separate machines, pause** the vaults, the minter and the pool on any mismatch between deposits,
  mints, burns and payouts. They can only pause; only the owners unpause.
- **KasPool's admin** can collect the protocol's fees, unpause the pool and hand its keys over, and nothing else: never
  the reserves, never a provider's position. A circuit breaker caps the KAS that can leave the pool in an hour.

## Verify it yourself

1. **The vaults.** Their addresses are on [Status](https://trestly.io/docs/overview/status/#addresses) once the
   launch is verified, with their source verified on Etherscan and BscScan. To build the same bytecode yourself:
   ```sh
   cd bridge/evm && npm ci --legacy-peer-deps && npx hardhat compile
   ```
   On the explorers, check each vault's owner (its AccessManager), the AccessManager's admin (the Safe, 2 of 3), its
   cancellers, the vault's five signers, its guardian and its limits against the launch record in `deployments/`.
2. **The covenants.** With Docker, rebuild them in the pinned toolchain and compare (as the CI job does):
   ```sh
   node tools/check-artifacts.mjs --upstream
   bash tools/rust.sh bridge/kaspa cargo test --locked --test artifacts --test template
   bash tools/rust.sh bridge/kaspa cargo run --locked --example build_artifacts
   git status --short bridge/kaspa/artifacts    # nothing: the same bytes
   ```
   kUSDT's covenant ID on Kaspa commits to its genesis and the scripts it authorizes, so a token whose ID is the one on
   Status runs exactly this code. [Verify the template](https://trestly.io/docs/developers/verify-template/) walks
   through it.
3. **The wallet.** Build it yourself and load your own build in Chrome (Extensions, developer mode, "Load unpacked",
   `wallet/extension/dist`), or compare it with the published version.

## Build and test

Node 22 and npm:

```sh
npm ci --legacy-peer-deps                                          # the client packages
(cd bridge/evm && npm ci --legacy-peer-deps && npx hardhat compile && npx hardhat test)
npx vitest run bridge/packages
(cd wallet/extension && npm ci --legacy-peer-deps && npm run build && npx vitest run)
```

The wallet's tests read the vault's compiled ABI, so compile `bridge/evm` first. Tests that drive a whole local bridge
need the off-chain services and are not included.

## Reporting a vulnerability

Write in the Telegram group [t.me/trestly](https://t.me/trestly) that you have one, and ask an admin for a private
channel. Don't post the details there.

## Licence

MIT (`LICENSE`), except `vendor/kcc20-reference`, which keeps its upstream ISC licence.
