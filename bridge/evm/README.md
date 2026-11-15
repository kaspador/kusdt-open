# kUSDT vaults (Ethereum, BNB Chain)

The EVM side of kUSDT. One `KusdtVault` per chain holds the USDT that backs kUSDT on
Kaspa L1. [`SPEC.md`](../../SPEC.md) is the source of truth (§2, §3, §7, §8, §9, §11, §12);
this folder implements its vault part.

| Path | What |
|---|---|
| `contracts/KusdtVault.sol` | the vault |
| `contracts/test/MockUSDT.sol` | testnet USDT: any decimals, permissionless `mint` (faucet) |
| `contracts/test/TetherStyleUSDT.sol` | test-only: Ethereum USDT's non-standard ERC-20 (no return values) |
| `contracts/test/FeeOnTransferToken.sol` | test-only: delivers less than sent; the vault must refuse it |
| `contracts/test/ReentrantToken.sol` | test-only: calls back into the vault from a transfer |
| `test/*.test.ts` | Hardhat tests (deposits, releases, refunds, admin, randomized invariants, gas) |
| `scripts/deploy.ts` | deployment script |
| `config/*.json` | deployment parameters (examples and the dry-run file) |

## What the vault does

All amounts are **units** of 10⁻⁶ USDT. The token moves `units × scale`, where
`scale = 10^(decimals − 6)`: 1 on Ethereum (USDT, 6 decimals), 10¹² on BNB Chain
(BSC-USD, 18 decimals).

**Deposit** (EVM → Kaspa). `deposit(units, ownerScheme, owner)`:
- `ownerScheme` ≤ 4 (SPEC §4) and `owner` ≠ 0; `minDeposit ≤ units ≤ maxDeposit`;
- `fee = max(minDepositFee, ceil(units × feeBps / 10⁴))`, `minted = units − fee > 0`;
- pulls `units × scale` with SafeERC20 (so Ethereum USDT, which returns nothing, works),
  and reverts unless the balance grew by exactly that much (no fee-on-transfer tokens);
- emits `Deposit(uint64 indexed nonce, address indexed sender, uint8 ownerScheme,
  bytes32 owner, uint256 units, uint256 fee, uint256 minted)`, nonces 0, 1, 2, …;
- the fee goes to `feesAccrued`; `minted` stays as backing and is recorded per nonce
  (`depositMinted`) for a possible refund.

**Release** (Kaspa → EVM). `release(Release{redeemId, recipient, units}, signatures)`
pays a Kaspa burn: `units − fee` to `recipient`, with
`fee = max(minReleaseFee, ceil(units × feeBps / 10⁴))` added to `feesAccrued`. It needs:
- at least 3 signatures by current signers over the EIP-712 message (domain
  `{name: "kUSDT Vault", version: "1", chainId, verifyingContract}`), with recovered
  addresses strictly increasing (which proves they are distinct);
- an unused `redeemId` (`keccak256(abi.encodePacked("kusdt/redeem/v1", kaspaTxId, uint32 outputIndex))`,
  also available as `redeemIdOf`);
- `units > fee`, `units ≤ backing()`, and `units − fee` within the release allowance.

**Refund**. `refund(Refund{nonce, recipient, units}, signatures)` returns a deposit
Kaspa skipped (`skip_nonce`): same quorum, same allowance, `nonce < depositNonce`, once
per nonce, and `units` must equal what that deposit minted. The deposit fee is kept and
no release fee is charged.

**Release allowance.** A bucket of `releaseCapacity` units that refills at
`releaseRefillPerSecond`, capped at the capacity. Releases (their whole `units`, the fee too) and refunds draw
from it. `releaseAvailable()` shows what can be paid now.

**Accounting.** `balance / scale == backing() + feesAccrued` at all times; `backing()` is
what INV-1 compares with kUSDT in circulation. Only `release` and `refund` reduce the
backing, and both need the signer quorum. Tokens sent straight to the vault count as
backing.

**Roles.**

| Role | Can |
|---|---|
| owner (two-step, `Ownable2Step`; a Safe behind a 48 h timelock on mainnet) | `setFees`, `setDepositLimits`, `setReleaseLimits`, `setSigners` (5 distinct, non-zero), `setGuardian`, `pause`, `unpause`, `withdrawFees(to, units ≤ feesAccrued)`, `transferOwnership`. **Not** move backing. `renounceOwnership` is disabled |
| guardian | `pause` only |
| signers (5) | sign Release and Refund messages. Anyone may submit them |

`pause` stops deposits, releases and refunds; admin functions keep working so a fix can
be made before unpausing.

**Hard bounds** (constants): `feeBps ≤ 100`; each minimum fee ≤ 50 USDT (50 000 000
units); `0 < minDeposit ≤ maxDeposit ≤ 10¹⁵`; `releaseCapacity ≤ 10¹⁵`;
`releaseRefillPerSecond ≤ releaseCapacity / 86 400` (a full refill takes at least a day).
Decimals 6 to 18, checked against the token's own `decimals()`.

**Views for services**: `signers()`, `isSigner`, `guardian`, `owner`, `params()`,
`feeBps`, `minDepositFee`, `minReleaseFee`, `minDeposit`, `maxDeposit`,
`releaseCapacity`, `releaseRefillPerSecond`, `releaseAvailable()`, `depositNonce`,
`depositMinted(nonce)`, `isRefunded(nonce)`, `redeemed(redeemId)`, `feesAccrued`,
`backing()`, `depositFeeOf`, `releaseFeeOf`, `domainSeparator()`, `releaseDigest`,
`refundDigest`, `redeemIdOf`, `scale`, `tokenDecimals`.

**Events**: `Deposit`, `Released`, `Refunded`, `FeesSet`, `DepositLimitsSet`,
`ReleaseLimitsSet`, `SignersSet`, `GuardianSet`, `FeesWithdrawn`, plus OpenZeppelin's
`Paused`, `Unpaused`, `OwnershipTransferStarted`, `OwnershipTransferred`.

## Parameters (SPEC §8 mainnet defaults)

| Parameter | Ethereum | BNB Chain |
|---|---|---|
| `feeBps` | 50 (0.50 %) | 50 |
| `minDepositFee` | 500 000 (0.50 USDT) | 500 000 |
| `minReleaseFee` | 5 000 000 (5 USDT) | 500 000 (0.50 USDT) |
| `minDeposit` / `maxDeposit` | 10 000 000 / 8 000 000 000 (10 / 8 000 USDT) at the launch | same |
| `releaseCapacity` | 50 000 000 000 (50 000 USDT) at the launch | same |
| `releaseRefillPerSecond` | 578 703 (capacity / 86 400, rounded down) | same |

`maxDeposit` must stay at or below the Kaspa mint allowance ceiling (SPEC §8), which the
vault can't see: check it when changing either.

## Test

```sh
npm ci
npx hardhat test
```

Gas report: set `REPORT_GAS=1` (PowerShell: `$env:REPORT_GAS=1`) before `npx hardhat test`.
The randomized test takes `INVARIANT_SEED` and `INVARIANT_STEPS` (defaults 20261103, 250).

Measured gas (Hardhat, mock tokens): deposit ≈ 90 k (124 k for the vault's very first);
release with 3 signatures ≈ 119 k (137 k when the recipient had no balance), with 5 ≈ 135 k;
refund ≈ 109 k. Ethereum USDT's own transfer costs a little more than the mock's.

## Deploy

Parameters come from a JSON file named by `DEPLOY_CONFIG`; `KUSDT_*` environment variables
override it. The RPC URLs and the deployer key come from the environment only
(`SEPOLIA_RPC_URL`, `BSC_TESTNET_RPC_URL`, `ETHEREUM_RPC_URL`, `BSC_RPC_URL`,
`DEPLOYER_KEY`); nothing prints the key.

| JSON key | Env override | |
|---|---|---|
| `deployMockUsdt`, `mockDecimals` | `KUSDT_DEPLOY_MOCK_USDT`, `KUSDT_MOCK_DECIMALS` | test networks only |
| `token`, `tokenDecimals` | `KUSDT_TOKEN`, `KUSDT_TOKEN_DECIMALS` | when not deploying the mock |
| `signers` (5) | `KUSDT_SIGNERS` (comma-separated) | |
| `guardian`, `owner` | `KUSDT_GUARDIAN`, `KUSDT_OWNER` | |
| `feeBps`, `minDepositFee`, `minReleaseFee` | `KUSDT_FEE_BPS`, `KUSDT_MIN_DEPOSIT_FEE`, `KUSDT_MIN_RELEASE_FEE` | units |
| `minDeposit`, `maxDeposit` | `KUSDT_MIN_DEPOSIT`, `KUSDT_MAX_DEPOSIT` | units |
| `releaseCapacity`, `releaseRefillPerSecond` | `KUSDT_RELEASE_CAPACITY`, `KUSDT_RELEASE_REFILL_PER_SECOND` | units |
| `payoutDelay` | `KUSDT_PAYOUT_DELAY` | seconds a payout waits, at most 86400; at least 300 on a mainnet |

```sh
# Dry run on the in-process network (deploys a MockUSDT, then the vault):
DEPLOY_CONFIG=config/dryrun.json npx hardhat run scripts/deploy.ts

# Testnet: copy config/sepolia.example.json to config/sepolia.json, fill in the signers,
# guardian and owner, then:
DEPLOY_CONFIG=config/sepolia.json npx hardhat run scripts/deploy.ts --network sepolia
```

The script writes `deployments/<network>.json` (vault, token, signers, guardian, owner,
parameters as read back from the chain, deploy tx and block) and prints the addresses.

Guard rails: on chain 1 and 56 it refuses the mock, requires the SPEC §2 USDT address and
decimals, requires the owner to be a contract (the timelocked Safe), and asks for
`KUSDT_CONFIRM_MAINNET=deploy-to-<chainId>`. Set `HARDHAT_CHAIN_ID` to dry-run those checks
in-process. Hard bounds are checked before anything is sent. Mainnet also needs every item
in SPEC §12 first.

Config files other than `*.example.json` and `dryrun.json` are git-ignored, as are dry-run
deployment records (`deployments/hardhat.json`).

## Known limits

- Ethereum USDT has a dormant transfer fee (`basisPointsRate`). If Tether ever turns it on,
  deposits revert (the balance check) and release recipients receive less than the payout.
- A blacklisted recipient makes its release revert; the redeemId stays unused.
- The signers alone keep INV-2 (never both mint and refund a nonce) and the per-burn
  amounts honest; the vault caps the damage of a bad quorum at the release allowance.
