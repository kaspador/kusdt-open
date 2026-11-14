# kUSDT: protocol specification

kUSDT is USDT locked on Ethereum and BNB Chain and issued 1:1 on **Kaspa L1** as a
KCC-20 covenant token. This file defines what every part must agree on: the Kaspa
covenants, the EVM vaults, the signers, the coordinator, the wallet and the web app.
When code and this file disagree, one of them is a bug.

Status: **v1, testnet.** Mainnet needs the steps in §12.

## 1. Parts and trust

| Part | Runs where | Trusted with |
|---|---|---|
| **kUSDT covenant family** | Kaspa L1 | the token itself. Its `KCC20` and `TokenSeed` actors are the unmodified KCC-20 reference; `BridgeMint` is the only issuer |
| **Vault**, one per EVM chain | Ethereum, BNB Chain | all locked USDT. Pays out only with 3 of the 5 signers' signatures, within a daily limit |
| **Signers** (5, independent) | each on its own machine, with its own Kaspa node and EVM RPCs | one Kaspa Schnorr key and one EVM ECDSA key each |
| **Guardian** | the monitor | two keys, one role: a Kaspa key (the minter's `guardian`) and an EVM key (each vault's `guardian`). They can pause the minter and the vaults, and nothing else |
| **Coordinator** | bridge server | nothing that moves funds: it collects signatures, submits transactions and serves status. A lying coordinator can stall the bridge, never redirect funds |
| **Vault owner** | an AccessManager whose admin is a Safe (mainnet): 48 h delays, ≈6 h for `setGuardian` and `unpause`, independent cancellers who can cancel the Safe's queued vault calls and its power-adding calls on the manager itself (§7) | vault parameters within hard bounds, and the vault's signer set |
| **Wallet / web app** | the user's device | the user's keys. They pin each deployment (covenant ID, vault addresses): the wallet in its build; the web app on mainnet in its build too, the wallet's own values, refusing a runtime config that names another (since run 21) |

Every signer checks every request against **its own** nodes before signing. Nothing the
coordinator says is taken as fact.

Safety assumes at most 2 of the 5 signers misbehave. A bad quorum of 3 still can't mint or
release more than the allowances (§8), and can't undo the guardian's pause (unpausing takes
4). With 4 bad signers Kaspa's limits fall, since 4 signers set them; the vaults' release
allowance is set only by the vault owner, so USDT can leave no faster than that, and the
guardian pauses the vaults the moment INV-1 fails (§11). Every payout waits in the vault first
(§7): a pause within the wait stops it, however small a thief splits the theft.

## 2. Networks and identifiers

| | Testnet | Mainnet |
|---|---|---|
| Kaspa | testnet-10 | mainnet |
| Ethereum | Sepolia (chain ID 11155111) | Ethereum (1) |
| BNB Chain | BSC testnet (97) | BNB Smart Chain (56) |
| Ethereum USDT | `MockUSDT`, 6 decimals (ours) | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| BNB Chain USDT | `MockUSDT`, 18 decimals (ours) | `0x55d398326f99059fF775485246999027B3197955` (BSC-USD) |
| Token blocklist (§9) | Sepolia's mock: `isBlackListed`; BSC testnet's: none | USDT: `isBlackListed`; BSC-USD: none |

**Chain codes**, used on Kaspa: `0x01` Ethereum, `0x02` BNB Chain. A deployment is the
pair (kUSDT covenant ID, vault addresses); testnet and mainnet are separate deployments.

**The pair is for life.** A redeem ID is the burn's outpoint (§9) and a deposit is a nonce counted per vault (§7):
neither names the other half. INV-2 and INV-3 (§11) therefore hold only while each vault serves one covenant, and
each covenant one vault per chain, from the first block to the last. **A vault is never replaced under a live
kUSDT, and a kUSDT is never replaced over live vaults: a new deployment is new vaults and a new covenant together.**
A new vault under an old covenant would pay every earlier burn of its chain again (its `redeemed` is empty), and
could never have its first deposits minted (the minter is past their nonces). A new covenant over old vaults starts
its nonces at 0 and would mint every earlier deposit again. Nothing on either chain enforces the pair, so the tools
refuse what the chains show of a broken one (`bridge/services/src/shared/pairing.ts`; round 12): a vault that has
taken fewer deposits than the minter is past, a vault that queued a release or a refund while its kUSDT had minted
nothing, a vault created after its kUSDT's genesis, and a saved state that shares only the covenant or only a vault
with the deployment it is started on. Deposits made into a new vault before its kUSDT's first mint are ordinary
(the vault is public from its first block) and no chain can tell them from deposits another covenant minted: that
case rests on this rule and on the states' binding alone. Moving to new code is a new pair, reached by redeeming
out of the old one.

## 3. Units

- **Base unit:** 10⁻⁶ USDT. kUSDT has 6 decimals and every amount in this spec, on every
  chain, is an integer number of base units.
- **EVM conversion:** token amount = units × 10^(decimals − 6). On BNB Chain (18 decimals)
  a deposit moves `units × 10¹²` wei; amounts that aren't a whole number of units can't
  be deposited.
- **Kaspa ints** are 64-bit signed. The cap (§6) keeps every sum far below 2⁶³.

## 4. Kaspa recipients (KCC-2 owners)

A deposit names its Kaspa recipient as a KCC-2 `(owner_scheme, owner)` pair. The wallet
and the web app derive it from a Kaspa address:

| Kaspa address | `owner_scheme` | `owner` |
|---|---|---|
| Schnorr P2PK (`kaspa:q…`, 32-byte key) | `0x00` p2pk-schnorr | the x-only public key |
| ECDSA P2PK (33-byte key) | `0x02` p2pkh-ecdsa | `BLAKE3(compressed key)` |
| P2SH (`kaspa:p…`) | `0x03` p2sh | the 32-byte script hash |
| (no address) | `0x04` covenant-id | a covenant ID, for contracts |

`0x01` (p2pkh-schnorr) is accepted too. The vaults reject any other scheme byte.

A key address whose bytes are no key decodes all the same, with a valid checksum: an x that is not on the curve, or
33 bytes that are no compressed point. Nothing can ever spend what is sent there, so the wallet and the web app refuse
such an address as a recipient (since run 21 round 2, R21-CRYPTO-5); it is made on purpose, never by a typo.

An owner of the covenant-ID type (`0x04`) is satisfied by **any** input of that covenant family in the spending
transaction. A state sent to kUSDT's own covenant ID is therefore anyone's: every kUSDT state is itself an input of that
family. Name a covenant ID as owner only for a contract of another family (the pool is one).

## 5. The kUSDT covenant family (Kaspa)

One genesis transaction creates the family: one `BridgeMint` and one `TokenSeed`, no
token balance. Its covenant ID **is** kUSDT's identity; wallets pin it. A KCC-23
preparation transaction binds the metadata
`{"name":"kUSDT","symbol":"kUSDT","decimals":6,…}` to that ID.

- **`KCC20`**: the reference actor, compiled to the exact standard template (template
  hash `9703112e…3cf7`; checked by `bridge/kaspa/tests/template.rs`). Every kUSDT state
  uses extension commitment `0³²`.
- **`TokenSeed`**: the reference actor, for zero-amount receiving states.
- **`BridgeMint`**: see §6.

## 6. BridgeMint

State:

| Field | Meaning |
|---|---|
| `remaining` | issuance left under the hard cap. Only goes down. Starts at 10¹⁵ (1 billion USDT) |
| `bucket` | the mint allowance held when this UTXO was created, before its age refills it |
| `capacity`, `refill_per_daa` | allowance ceiling and refill per DAA score unit |
| `nonce_ethereum`, `nonce_bsc` | next deposit nonce to mint, per chain |
| `admin_nonce` | next nonce a governance message must carry |
| `paused` | minting stopped |
| `signer_set` | `BLAKE3(k₀ ‖ k₁ ‖ k₂ ‖ k₃ ‖ k₄)`, the five x-only Schnorr keys in order |
| `guardian` | x-only key that may pause |
| `extension_commitment` | `0³²` |
| `recovery_delay` | DAA the minter must stand untouched before a proposed recovery can be carried out. Fixed at genesis: no entry changes it. 1 to 2³² − 1 (a relative lock has 32 bits) |
| `recovery_nonce` | next nonce a recovery proposal or veto must carry |
| `recovery_pending` | a recovery is proposed |
| `recovery_signer_set`, `recovery_guardian` | the signer set and guardian proposed while `recovery_pending`; `0³²` otherwise |

The script bounds nothing at genesis. The deployment plan does (`mainnet-deploy.ts`): `capacity`, `refill_per_daa` and
`remaining` at most 10¹⁵, and a `recovery_delay` a relative lock can express.

**Mint** (`mint`): 1 to 3 consecutive deposits of one chain, starting exactly at that
chain's nonce. The covenant checks, on-chain:

1. not paused; every recipient has `amount > 0`, a valid owner scheme, borrow scheme
   `0x00`, borrow guard `0³²` and extension `0³²`;
2. `first_nonce` equals the chain's nonce; the nonce advances by the number of recipients;
3. `age_daa` is at most the age of the minter UTXO (the input's sequence, a relative lock consensus enforces, and since rc.22 exactly `age_daa`), and between 0 and 2³² − 1. An age above 0 is claimed only on a minter UTXO already in a block, and every other input follows `require_settled_inputs` (§15, "Parked spends"). Each spend starts a new UTXO at age zero, so no stretch of time refills the allowance twice. The coordinator claims the UTXO's age less a margin of 10 DAA, and never more than brings the allowance to its ceiling (more credits nothing and only lengthens the lock); it counts the age from the DAA score its own follower read, or, for a minter that came with a checkpoint, the score its node holds for that UTXO, never the checkpoint's word (round 12). `pause` and `execute_recovery` claim no age; every `govern` action settles the allowance with its own, which its signers sign as a mint's do;
4. the total is at most the refilled allowance and at most `remaining`;
5. 3 signatures by distinct signers, in increasing signer order, over the **mint digest**;
6. the successor `BridgeMint` carries exactly the updated state and the same KAS value;
   each minted output is a standard `KCC20` state equal to its recipient;
7. each minted output carries at least `MIN_MINTED_VALUE`, 1 KAS (100 000 000 sompi), whoever its owner is (added in
   rc.16). The mint digest names the kUSDT each recipient gets, not the KAS the outputs carry: whoever submits the
   mint pays that (the coordinator gives each output the deployment's `tokenValue`, 1.5 KAS). Without a floor, anyone
   who saw a signed mint could land a copy of it whose outputs carried next to no KAS, and a recipient who held no KAS
   could not move the kUSDT until they got some. With it, a copy can still carry less than `tokenValue`, down to
   1 KAS, which is enough to send all of that kUSDT or to redeem all of it with no other coin (a part of it, with
   its change, needs more KAS than that at most feerates). A wallet that sends all of it with no other coin takes the
   fee out of the KAS under the state: the recipient's state then carries a little less than the sender's did. A deposit that names a burn owner is minted the same way, with the same
   value (the lower `burnValue` of §9 is for a burn made by a transfer), so the floor holds for it too.

Mint digest (all integers as 8-byte little-endian):

```text
BLAKE3( "kUSDT/mint/v2" ‖ covenant_id[32] ‖ chain[1] ‖ first_nonce[8] ‖ age_daa[8]
        ‖ for each recipient: owner_scheme[1] ‖ owner[32] ‖ amount[8] )
```

The minted amount for a deposit is its `minted` field (§7), never more.

**Governance** (`govern`; 4 of 5 signers unless noted). Every action but `unpause` signs the **govern digest**
(all integers as 8-byte little-endian):

```text
BLAKE3( "kUSDT/govern/v2" ‖ covenant_id[32] ‖ nonce[8] ‖ age_daa[8] ‖ action[1] ‖ params )
```

`nonce` is `admin_nonce`, or `recovery_nonce` for `propose_recovery` and `veto_recovery`. `age_daa` is the age of the
minter UTXO the spend claims (below). Each 4-of-5 action moves `admin_nonce` forward by one, so every message is
single-use. A governance signature has no expiry of its own: it is good for as long as the minter holds the nonce it
names.

| Action | Code | Params | Quorum |
|---|---|---|---|
| `unpause` | `0x01` | none (it signs the **unpause digest** below, not the govern digest) | 4 |
| `set_limits` | `0x02` | `capacity[8] ‖ refill_per_daa[8]`, each from 0 to 10¹⁵ (the lifetime cap; more is refused). `refill_per_daa` is per DAA score, ten a second; the tools refuse a refill faster than once a day (`> capacity / 864 000`) unless told it was agreed (run 20, D9-3) | 4 |
| `set_signers` | `0x03` | `signer_set[32] ‖ guardian[32]` | 4 |
| `skip_nonce` | `0x04` | `chain[1] ‖ nonce[8]` (must be the current nonce) | 4 |
| `set_value` | `0x05` | `value[8]` (the minter's own KAS deposit, 5 KAS at genesis) | 4 |
| `propose_recovery` | `0x06` | `signer_set[32] ‖ guardian[32]` | 3 (see below) |
| `veto_recovery` | `0x07` | none | 1 (see below) |

Every action settles the allowance with the age it claims (as a mint does) and keeps the minter's KAS value, except
`set_value`, which sets it. Every action takes 4 of 5, so a bad minting quorum of 3 can neither undo a pause nor burn
the nonce of a signed governance message.

**A lowering `set_value` frees KAS to whoever builds its transaction** (run 20, RT-1). The script pins only the minter
output's new value (`minter.value == next_value`), and the signers sign the governance message, not the transaction:
the KAS the lower deposit frees goes to whoever builds the first transaction a block takes with those signatures in
it, and anyone who sees the signed action before a block (in a mempool, say) can send it paying that KAS to
themselves. The bound is the operators' own minter deposit (5 KAS at genesis, whatever a raise since put in): no
user money, no kUSDT and no state other than the deposit's size. `govern-submit` sends a lowering straight to the
block-building nodes of `kaspaSubmitRpcs` first, where it waits the least time for a block, and says what is at
stake. Closing it would mean signing where the freed KAS goes, a change of the covenant that is the owner's decision.

**The age of a governance action is signed** (rc.16; before it the sender chose it). The spend's `age_daa` argument
must be the `age_daa` in the digest the quorum signed, exactly: the script puts the argument into the digest it
checks, so a copy of a signed action that claims another age carries no valid signature. Three things follow:

- Nobody who sees a signed action (in the mempool, or in a signature file) can send it with a smaller age to throw
  away the allowance that refilled since the minter's last spend. That was possible before rc.16.
- The action is valid only once the minter UTXO is `age_daa` old (the input's sequence is a relative lock, exactly
  `age_daa`, as for a mint). The signatures name no coin (an unpause aside), so if a mint or any other spend replaces the minter UTXO
  before the action is sent, the action is valid again once the new UTXO is `age_daa` old. So an action signed for
  an age above 0 can be made to wait for as long as spends of the minter keep landing less than `age_daa` apart. It
  is never voided by that, only delayed. An age of 0 is always valid, on any coin, and credits no refill. What can
  replace the minter UTXO, and so restart the wait:
  - a mint: the coordinator's, for any deposit (anyone can make one), or one made by whoever holds three signer keys,
    for as little as one unit;
  - a guardian pause (on a minter that is not paused);
  - another governance action, a recovery proposal (three keys), a veto (any one key, while a proposal stands), a
    recovery carried out (anyone, once its wait is over). Three keys can propose and veto in turn, on a paused minter
    too.

  `"holdMints": true` in the coordinator's config, after a restart of the coordinator, stops one of these only: the
  honest coordinator's own new mints. It does not stop a mint the coordinator had already sent, a mint by a holder of
  three keys, a pause, or any of the governance and recovery spends. It makes a quiet minter likely, not certain.
- So the actions that must never wait are signed for age 0: `set_signers` (the remedy for stolen keys),
  `propose_recovery` and `veto_recovery` (a veto has a deadline). `kusdt govern-sign` signs these for age 0 unless
  `--age` names another, and warns when it does. They credit no refill; that is the price of not being stoppable.
- Every signer signs the same age. `kusdt govern-digest` and `kusdt govern-sign` show it before anything is signed.
  For `unpause`, `set_limits`, `skip_nonce` and `set_value`, without `--age`, they take the coin's age as the
  signer's own follower and node show it, less 600 DAA, and at most the age a full refill needs
  (`⌈(capacity − bucket) ÷ refill_per_daa⌉`). They refuse an age the coin has not reached by the signer's own view,
  and an age above what a full refill needs (it would credit nothing more and only lengthen the wait). `kusdt
  govern-submit` refuses signatures for different ages, and while the coin is younger than the age signed it sends
  nothing and names the DAA score the action is valid from. `--age 0` is always accepted, and needs no node.

What stays unsigned is only what cannot matter: the time between the age signed and the moment the action lands is
not credited (at most the 600 DAA margin plus however long the signatures take to gather and send, and nothing once
the age signed is the full refill), and an action signed for age 0 credits none of the refill, by its signers' choice.

**Pause** (`pause`) takes only the guardian's transaction signature, and only on a minter that is not paused. It sets
`paused` and moves `admin_nonce` forward by one. It claims no age: an emergency path never waits on a clock. So the
allowance that refilled between the minter's last spend and the pause is not credited (the time after the pause is:
the unpause claims it). That is the guardian's choice to make, and less than what a pause already stops.

- What a pause voids: every 4-of-5 message signed for the nonce the minter held. So the guardian's key alone can void
  one round of governance signatures, once per unpause (a paused minter cannot be paused again).
- What a pause does not void: a message signed for the nonce it moves to (the pause is what makes that one valid, which is
  why an unpause signs more than a nonce, below, and why a signer signs a governance message only for the nonce its own
  node shows); a mint signed before it, which is good again once the minter is unpaused, until its deposit nonce is minted
  or skipped or its signers are replaced; a recovery proposal or veto, which carry `recovery_nonce`.

**Unpause** (`govern` action `0x01`) is accepted only on a paused minter, with no params, and its four signatures are over
the **unpause digest**, which names the paused minter coin itself (all integers as 8-byte little-endian):

```text
BLAKE3( "kUSDT/unpause/v2" ‖ covenant_id[32] ‖ admin_nonce[8] ‖ age_daa[8] ‖ outpoint_txid[32] ‖ outpoint_index[8] )
```

`outpoint_txid` and `outpoint_index` are the transaction ID and output index of the minter UTXO the unpause spends, read
by the script from its own input. `age_daa` is the age of that coin the unpause claims: an unpause settles the
allowance like every governance action (the time since the pause refills it), so its age is signed like theirs.
Because the unpause names its coin, that age can only be reached, never lost: the coin's age only grows until
something spends it, and any spend voids the unpause anyway. The message is 104 bytes; it has its own domain string,
so a signature over a govern message is never one over an unpause, nor the reverse. Both strings moved from `v1` to
`v2` when the age went in, so a signature over an old message verifies under neither. The paused coin does not exist before the pause, so an unpause
cannot be signed ahead of the pause it lifts, and four signatures over an unpause are good for that one coin and no other.
No other action names its coin: that would void an action the operators sign over hours whenever a mint lands first.

Anything else that spends the paused minter makes a new coin, and an unpause signed for the old one is then signed
again: another 4-of-5 action, a recovery proposal (3 of 5), a veto (any 1, only while a proposal stands), a recovery
carried out. With no proposal standing, nothing short of three signer keys can spend a paused minter. Three keys that are
stolen (their holders still sign) can keep proposing and vetoing to void each unpause as it is signed; a rotation ends
that, because `set_signers` is signed at the nonce, not at a coin, and neither a proposal nor a veto moves `admin_nonce`.
So after a theft of keys the order is: rotate, then unpause. While a recovery proposal stands, any one signer can void
an unpause the four have signed, once per proposal, by vetoing (a veto spends the paused coin and clears the proposal):
a round of signing lost, nothing minted or moved. So with a proposal standing the order is: veto it, or let it be
carried out, then sign the unpause (round 13, R13-COV-L2; the minter's comment on `recovery_nonce` said a proposal
could not void what four signed, which holds for every action but this one). `kusdt govern-sign` takes the coin of an unpause from the
signer's own follower state only, and refuses while that state does not show the minter paused.

Four rules added in rc.16 (a new covenant, so a new kUSDT covenant ID). The fourth is the signed age of a governance
action, above; the other three:

- **A pause moves `admin_nonce` forward by one**, so it voids every 4-of-5 signature made before it. A governance
  signature never expires on its own: without this, an `unpause` or a `set_limits` that four signers had signed and
  never sent stayed good after a later pause, for whoever held it and three keys. After a pause the signers sign
  again, at the new nonce. The guardian key alone can therefore void signatures that are being gathered, once per
  pause (a paused minter can't be paused again); it could already stop the minter.
- **`unpause` requires a paused minter.** One signed in advance can't be spent on a running minter.
- **`set_limits` refuses a `capacity` or a `refill_per_daa` above 10¹⁵**, the lifetime cap. Without a ceiling four
  signers could set limits so large that every later step overflowed, and the minter stopped for good.

A known limit that remains, and is by design: `execute_recovery` claims no age (it needs no signature, so there is
nobody to sign one), and its successor keeps `bucket` as it was. The allowance that refilled during the recovery
wait (72 hours on mainnet, three times a full refill at the launch limits) is therefore not credited, and the first
mints after a recovery wait for the refill again. That is a delay, never a loss.

**Recovery** (added 2026-11-08). With two signer keys lost for good, 4 of 5 can never be reached again, and without this a
minter pause could never be lifted and the lost signers never replaced. So three signers can **propose** a new signer set and
guardian. Proposal and veto are signed at the minter's `recovery_nonce`, not `admin_nonce`, and each moves `recovery_nonce` forward
by one and leaves `admin_nonce`: three keys can't void what four signed at a nonce (an unpause, which also names its coin, they
can, and while a proposal stands so can one key, by its veto: see above). One proposal stands at a time. `execute_recovery` needs no signature and moves both nonces forward by one (so does
`set_signers`); it claims no age. It carries the proposal out once the minter UTXO has
stood untouched for `recovery_delay` DAA (72 hours, 2 592 000 DAA, on mainnet; fixed at genesis), which consensus enforces as a relative lock on
the UTXO (its input's sequence is exactly `recovery_delay`, on a minter UTXO already in a block, since rc.22). **Any single signer can veto** with `veto_recovery` until then. Every spend of the minter restarts the wait, a mint
included, so a working bridge can't be taken over quietly; a pause doesn't, once the minter is paused (a paused minter can't be paused again).
`set_signers` by four signers ends any recovery under way. The proposal is public in the minter's state. The monitor raises
`recovery-proposed` for one the operators didn't announce. What this adds to the trust model: three stolen keys can now attempt to replace
the signer set, and one honest signer must veto within the wait. The same rule serves a hostile key: any one signer key can veto every
proposal, so with one key lost and one hostile there is no recovery and no 4 of 5, and a pause then stands for good.

## 7. Vaults (EVM)

`deposit(uint256 units, uint8 ownerScheme, bytes32 owner)`:
- pulls `units × scale` of USDT; requires `minDeposit ≤ units ≤ maxDeposit`;
- `fee` = the deposit fee below, `minted = units − fee > 0`;
- emits `Deposit(uint64 indexed nonce, address indexed sender, uint8 ownerScheme,
  bytes32 owner, uint256 units, uint256 fee, uint256 minted)`, with nonces 0, 1, 2, … in
  order. **Every nonce is minted on Kaspa exactly once, or refunded (§9).**

`depositAtLeast(uint256 units, uint8 ownerScheme, bytes32 owner, uint256 minMinted)` (added in rc.16) is the same
deposit, and reverts with `MintedBelowMinimum`, taking nothing, unless `minted ≥ minMinted`. The fee now depends on
what was deposited before in the same day, so a deposit that lands just ahead can raise it; this bounds what the
depositor accepts. The web app and the wallet always use it, with what they showed the user less a quarter of a
percent of the deposit (the web app allows no slack on a vault whose fee can't rise).

**The deposit fee rises with the day's deposits** (added in rc.16). Each vault keeps a deposit meter: every
deposit adds its `units`, the meter drains at `surgeCapacity` per day (`SURGE_PERIOD`), and it never holds more
than `surgeCapacity`. The rate a unit pays depends on where the meter stands as that unit goes in:

| Meter | Rate |
|---|---|
| under half of `surgeCapacity` | `feeBps` |
| from half to all of `surgeCapacity` | a straight line from `feeBps` up to `surgeFeeBps` |
| at `surgeCapacity` (it holds no more) | `surgeFeeBps` |

`fee = max(minDepositFee, ceil(Σ units × rate / 10⁴))`. A deposit pays each of its units at that unit's own rate, so
splitting a deposit changes nothing. With `surgeCapacity = 0`, or `surgeFeeBps ≤ feeBps`, the fee is the flat
`max(minDepositFee, ceil(units × feeBps / 10⁴))`. `depositFeeOf(units)` answers the fee a deposit would pay in the
current block, and `depositMeterNow()` the meter. The two values are set at creation (constructor arguments) and by
the owner's `setDepositSurge(surgeFeeBps, capacity)`, which keeps what the meter holds, up to the new capacity.
Hard bounds: `surgeFeeBps ≤ 300` (3 %); `capacity` is 0 or from 2 to 10¹⁵. The plain fee's bound (`feeBps ≤ 100`)
is unchanged.

Why: the signers sign for a limited amount a day (§8), and one party could use that up for the flat fee. The
rising fee makes filling the day's limit by deposits cost more. It covers deposits only. A release still pays the
flat fee: the vault sets a release's fee after the user has burnt on Kaspa, where the user can no longer refuse a
higher one. So using up the day's limit in the bridge-back direction still costs only the flat fee.

`release(Release r, bytes[] signatures)` queues the payout of a Kaspa redemption (§9):
- EIP-712, domain `{name: "kUSDT Vault", version: "1", chainId, verifyingContract}`;
- `Release(bytes32 redeemId, address recipient, uint256 units)`;
- at least 3 signatures of distinct current signers, given in strictly increasing signer
  address order (that ordering is the distinctness proof); `redeemId` not used before;
- `fee = max(minReleaseFee, ceil(units × feeBps / 10⁴))`, `units > fee`; `units` must fit in
  the backing that no other queued payout has a claim on (`unreservedBacking()`);
- draws `units` from the vault's release allowance (§8) now, the fee included because it leaves the backing too, and
  needs `reservedUnits + units` to stay within `releaseCapacity`: the queue holds at most one allowance, because everything in it can be paid in one block
  once its wait is over; emits `ReleaseQueued(redeemId, recipient, units, fee, payout, readyAt)`, with
  `readyAt = now + payoutDelay`.

`executeRelease(bytes32 redeemId)` pays it once `readyAt` has passed: anyone may call it, and
not while the vault is paused. It pays `units − fee` to `recipient`, adds `fee` to
`feesAccrued`, and emits `Released(redeemId, recipient, units, fee, payout)`.

`refund(Refund r, bytes[] signatures)`: `Refund(uint64 nonce, address recipient, uint256 units)`
returns a deposit that Kaspa skipped (`skip_nonce`). The vault records what every deposit
minted; a refund must return exactly that amount, once, with no release fee (the deposit
fee is kept). Same quorum, same allowance, same wait: it emits
`RefundQueued(nonce, recipient, units, readyAt)`, and `executeRefund(uint64 nonce)` pays it,
emitting `Refunded(nonce, recipient, units)`. A signer signs a refund only when its own Kaspa node shows the nonce skipped (`skip_nonce`,
final) and never minted, to the deposit's `sender`, for exactly its `minted`; the
coordinator collects 3 signatures (`/sign/refund`) and submits.

**Every payout waits.** The wait (`payoutDelay`, 10 minutes on mainnet) is the guardian's time
to pause: a thief with 3 signer keys gets nothing out if the pause comes within it, and
splitting the theft into small payouts changes nothing, since small payouts wait too. The
owner can set it from 5 minutes to 24 hours (`setPayoutDelay`, behind its 48 h delay); payouts
already queued keep their time. Each monitor's `failClosedMs` must stay at most half the wait (§11), so it is
lowered first: a mainnet monitor refuses to start on an announced wait it does not fit. A queued payout that should never be paid is cancelled by the
owner, and only the owner (`cancelRelease`, `cancelRefund`), before unpausing: that clears it,
returns its allowance, and **leaves it cancelled** (`releaseCancelled`, `refundCancelled`; changed in
rc.16). `release` and `refund` refuse a cancelled `redeemId` or nonce with `PayoutCancelled`,
whatever signatures come with it, until the owner calls `reinstateRelease(redeemId)` or
`reinstateRefund(nonce)`. Before, the signatures a payout was queued with still counted until the
signers were replaced, so anyone could queue a cancelled payout again at once. Reinstating does
not queue anything: the payout must then be queued again, with signatures of the current signers,
and waits again. On mainnet a reinstate is a GOVERNOR call (48 h), so bringing a cancelled payout
back leaves the cancellers the same time as any other change. A cancel is also the way to take
out a payout that must wait (a recipient the token blocked during the wait); it is reinstated
once it can be paid. The mark is on the id, not on the payout: a forged payout that named a real
burn's `redeemId` or a real skip's nonce bars that burn's or that deposit's honest payout too once it
is cancelled. Such an id is reinstated after `setSigners` has run on that vault (the forged payout's
signatures no longer count there), and the honest payout is then signed and queued as any other
(round 16, R16-ONCE-2); the coordinator's `/health` names the ids of burns and skips it read that a
cancel holds. Until it is paid a queued
payout stays part of `backing()`, so INV-1 and the books don't change. An `unpause` starts a
full wait again for everything queued (`payoutsResumeAt`), so a bad payout someone missed gives
the guardian the same time to pause again.

Fees accrue in the vault (`feesAccrued`) and only the owner can withdraw them, never more
than `feesAccrued`. The owner can't withdraw backing and can't renounce ownership (two-step
transfers only). The owner sets fees and limits only within hard bounds (`feeBps ≤ 100`,
`surgeFeeBps ≤ 300`, min fees ≤ 50 USDT, deposit limits, the deposit meter and release capacity
≤ 10¹⁵ units, a full refill no faster than once a day), changes the signer set and the guardian,
cancels and reinstates payouts, and unpauses. The guardian and the owner can pause.

**The owner on mainnet** is `KusdtAccessManager` (OpenZeppelin's AccessManager 5.1.0 with `renounceRole` closed
and `revokeCanceller` added), whose only admin is the project Safe. Every owner call goes through `manager.execute(vault, data)`
(bridge/evm/scripts/access-manager.ts holds the whole configuration):

| Role | Id | Members | Execution delay | Vault functions |
|---|---|---|---|---|
| ADMIN | 0 | the Safe | 48 h | none on the vault: the manager itself (roles, delays, targets) |
| GOVERNOR | 1 | the Safe | 48 h | `setFees`, `setDepositSurge`, `setDepositLimits`, `setReleaseLimits`, `reinstateRelease`, `reinstateRefund`, `setPayoutDelay`, `setSigners`, `withdrawFees`, `transferOwnership` |
| EMERGENCY | 2 | the Safe | 6 h (1 h to 48 h) | `setGuardian`, `unpause`, `cancelRelease`, `cancelRefund` |
| PAUSER | 3 | the Safe | none | `pause` |
| CANCELLER | 4 | the cancellers | none | none: it is the role guardian of GOVERNOR, EMERGENCY and GUARDED, so it can cancel their scheduled calls |
| GUARDED | 5 | nobody | | none: the manager's own power-adding functions and `revokeRole` are mapped to it, which changes one thing only, who may cancel them |

GUARDED was added in rc.16. Before, a canceller could cancel only calls on the vault: a stolen Safe could schedule
`grantRole(GOVERNOR, thief, 0)` on the manager, and for the 48 hours it waited nobody could stop it. Now the
manager's `grantRole`, `setRoleAdmin`, `setRoleGuardian`, `setGrantDelay`, `setTargetAdminDelay`,
`setTargetFunctionRole`, `setTargetClosed` and `updateAuthority` are mapped to GUARDED, a role with no member whose
guardian is CANCELLER. Who may call them does not change (the manager decides that from its own table); who may
cancel them does: any one canceller.

`revokeRole` is mapped to GUARDED too (round 11). Left to ADMIN, as it was at first so that no canceller could
cancel its own removal, it left every revocation beyond the cancellers, the Safe's own roles among them: stolen Safe
keys could pause a vault, schedule the removal of the Safe's EMERGENCY, GOVERNOR, PAUSER and ADMIN roles, and 48
hours later nobody could ever unpause it. A canceller is removed through `revokeCanceller(account)`, a function of
`KusdtAccessManager` that removes cancellers only and is mapped to nothing: an ADMIN call of the Safe's 48 hours
that only an ADMIN can cancel. So a canceller still can't cancel its own removal, and it is the only revocation a
canceller can't cancel. Whoever holds the Safe can add power or strip the Safe's roles only once no canceller
cancels it: it must remove every canceller (48 h, which no canceller can cancel, and which every monitor sees
queued) or outlast them. In figures (round 12): a theft takes 48 hours from the cancellers' last cancel, since the
removals and the power-adding call can be scheduled together and a cancelled call can be scheduled again at once;
it is 96 hours only when a canceller cancels every re-schedule up to its own removal. A freeze takes one
transaction: the Safe pauses with no delay and may cancel every unpause scheduled through it, so a vault stays
paused for as long as someone holds the Safe's keys, and the 96 hours are only what makes the freeze outlast those
keys. The trade-off stays: a rogue canceller can cancel every GOVERNOR,
EMERGENCY and guarded call, an emergency unpause included, until the Safe removes it. It can only delay. One
delay grew: when a rogue canceller and a role that must be revoked come together, the Safe needs 48 h for the
canceller and 48 h more for the revocation.

Signers check two rules the vault can't see: a release names the chain and address the
burn owner commits to (§9), and a refund pays the depositor (`sender` of the `Deposit`).

`redeemId = keccak256(abi.encodePacked("kusdt/redeem/v1", bytes32 kaspaTxId, uint32 outputIndex))`.

## 8. Limits

| Limit | Default (mainnet) |
|---|---|
| Kaspa mint allowance | a ceiling of twice the signers' agreed daily limit (100 000 USDT at the launch), refills fully in 24 h (`refill_per_daa = capacity / 864 000`) |
| Kaspa hard cap | 1 000 000 000 USDT, can only fall |
| Vault release allowance | 250 000 USDT per vault, refills fully in 24 h |
| Payout wait | 10 minutes in each vault (§7): the owner can set 5 minutes to 24 hours |
| Deposit | 10 to 100 000 USDT |
| Fees | 0.50 % each way; minimum 0.50 USDT per deposit; minimum 5 USDT per release on Ethereum, 0.50 USDT on BNB Chain |
| Rising deposit fee (§7) | 2.50 % at a full deposit meter (`surgeFeeBps` 250); each vault's meter (`surgeCapacity`) is a quarter of the signers' agreed daily limit |

The vaults' `maxDeposit` must stay at or below the Kaspa allowance ceiling, so every
deposit can be minted. A batch of up to three deposits may add up to more than the ceiling: the coordinator then
mints a shorter batch, down to one deposit (round 16, R16-ST-3), so the rule is one deposit at a time, not three. A
single deposit above the ceiling (after `maxDeposit` was raised above it, or a `setLimits` lowered it) can't be
minted until 4 of 5 raise the ceiling again or skip it, and the deposits behind it on its chain wait.

The signers' daily limit (each signer's `dailyLimit`, its fuse) is one budget for both chains, so the deployer gives
each vault a meter of a quarter of it unless the inputs name another size: both meters are then full once half the
limit is used, however the deposits are split between the chains, and the rest of the day's limit pays the top rate.
It refuses meters that together exceed the limit (the limit would be used up before the fee reached its top rate), a
top rate above 3 % or not above `feeBps`, and a meter without a rate; on mainnet it also refuses a meter above a
quarter of the limit. At the launch the signers' limit is 50 000 kUSDT per 24 hours, so each meter is 12 500 USDT:
from an empty meter the first 6 250 USDT deposited on a chain pay 0.50 %, the next 6 250 pay a rate rising from
0.50 % to 2.50 % (1.50 % on average), and deposits made while the meter is full pay 2.50 %. A full meter is empty
again 24 hours later.

Why a quarter (the owner's decision of 14 November 2026, run 21, R21-ECON-1): a meter of half the limit drains
fast enough that deposits spread over the day (one 8 000 USDT deposit into each vault every 7.6 hours) always pay
the plain fee while keeping the signers' daily mint limit full, and everyone else's deposits wait longer each day.
At a quarter the same steady flow pays about 2.1 %, and an honest 8 000 USDT deposit on an empty meter pays 44.90
instead of 40.00.

The mint allowance's ceiling is twice the signers' daily limit unless the inputs name another, with a refill of one
ceiling a day; on mainnet the deployer refuses a larger ceiling (the owner's decision of 14 November 2026, run 21,
R21-ECON-5). The ceiling bounds what three stolen signer keys can mint: all of it at once, and twice it in any 24
hours. Honest deposits never need more than the signers' limit a day, and a ceiling of twice it was measured never
to slow them; the first plan kept 500 000, ten times the launch's 50 000 a day.

An allowance is a bucket: it holds at most its ceiling and refills at ceiling ÷ 24 h. So over
a window of length t at most `capacity + refill × t` can be drawn from it. On Kaspa, where a
draw is a mint, that is the most that can move: twice the ceiling in any 24 hours. A vault's
allowance is drawn when a payout is queued, and a queue drawn before the window can be paid
inside it, so the most that can leave a vault is `capacity + refill × t + one queue` (the queue
is at most one ceiling): just under three times the ceiling in any 24 hours.

So "50 000 USDT of releases per vault per day", the launch value, names the allowance's ceiling and its refill, not
a cap on a calendar day: after a quiet time the bucket is full, and about twice 50 000 can be queued within 24 hours
(under three times can leave, counting a queue from before). That is what the vault alone enforces. The signers
enforce their own limit beside it: each signs at most its `dailyLimit` of releases and refunds in any 24 hours, both
chains together, so with honest signers no more than 50 000 is signed in any 24 hours. The vault's bound is the one
that holds when three signer keys are stolen.

## 9. Redeeming (Kaspa → EVM)

A redemption is a standard KCC-20 transfer that sends kUSDT to a **burn owner** that names
the payout, so nobody can redirect it:

```text
R(chain, address) = 6a ‖ 0f ‖ "kUSDT/redeem/v1" ‖ 01 ‖ chain ‖ 14 ‖ address[20]
burn owner        = owner_scheme 0x03 (p2sh), owner = BLAKE2b-256(R)
```

`R` starts with `OP_RETURN`, so no input can ever satisfy it: tokens sent to a burn owner
can never move again. The burn state must have borrow scheme `0x00`, so it can't be
borrowed into either. The transaction payload should carry the preimage:

```text
payload = "KUSDT" ‖ 01 ‖ count[1] ‖ count × ( output_index[1] ‖ chain[1] ‖ address[20] )
```

If the payload is missing, anyone can give the coordinator the preimage later; it is
checked against the burn owner. Signers sign a `Release` for each burn output once it is
final (§10) and its amount is above the release fee.

A deposit may name a burn owner too (§6: owner scheme `0x03`), and is then minted straight into a burn. A mint
carries no redemption payload, and from the minted state alone nobody can tell a burn owner from the hash of any
other script, so such a burn is paid only once someone gives the coordinator its preimage: `POST /redeems` with
`{txid, outputIndex, chain, address, state}` of the minted output (§13). The one pair known from the chain is the
depositor's own: since run 21 a minted output whose owner is the burn owner of the deposit's `sender` on chain 1 or 2
is recorded as that redemption as the coordinator follows the mint. Until then no redemption is recorded for it
(`GET /redeems/...` answers 404), `/tokens` lists it under its burn owner like any P2SH-owned state, and it has the
exposure of every burn without a payload (known limits: a claim is needed, and at an address someone fills, the
signers can confirm it only from their books). The web app and the wallet never build such a deposit; a script that
deposits for a payout on the other chain must send the claim itself.

Edge cases:

- **The KAS in a burn output** is locked with it forever: a burn can never be spent. So burn
  outputs carry the deployment's `burnValue` (0.3 KAS), not the token value (1.5 KAS) other
  states carry, whose KAS comes back to their holder. A smaller output costs storage mass
  (about 4·10¹² / value for a covenant output), so fee: 0.3 KAS locked + 0.16 KAS fee makes a
  redemption cost about 0.46 KAS, against 1.55 KAS with a 1.5 KAS burn; 0.2 KAS would save
  0.03 more for 40 % more storage mass (bridge/kaspa/tests/standard.rs measures the range).
  Wallets show it as part of a redemption's cost.
- **Only plain burns are paid.** Signers refuse a burn state whose borrow scheme, borrow
  guard or extension commitment isn't zero: a borrowable state could move to a new outpoint
  and be claimed twice. Such kUSDT is lost, so wallets never build one. Nor does the core's
  `transfer` builder, which kUSDT Wallet builds every redemption with, the web app's included (run 21,
  Daybreak [27]): it refuses a redemption that names a chain other than 1 or 2 or the zero address,
  and any output to a burn owner it names that is not plain or holds nothing. The coordinator applies
  the same rule when it records a burn (since rc.16): a state with borrowing or an extension, or
  with an amount of zero, is not recorded as a redemption at all. Before, each move of a
  borrowable state made a new record that no signer would ever sign.
- **A burn the vault can't pay yet waits.** Wallets refuse a burn the named vault can't pay
  now: an amount (the whole burn, the release fee included) above its release capacity, its
  `releaseAvailable` or its backing, or while it is paused, and they offer the
  other chain when that one can pay. One burn takes at most the capacity less what is queued
  and less 1 % of it (since run 21 round 2, R21-ECON-2): the vault queues a payout only while
  the queue and it fit the capacity together, so a burn of all the room left would wait for as
  long as anyone keeps one tiny payout waiting there. If such a burn lands anyway, the relayer retries it with
  a backoff of its own until the allowance refills, deposits on that chain bring the backing,
  or the owner raises the capacity (within its hard bound). It never holds up other burns.
- **A burn the vault can't pay out** (at or below the release fee, or naming the zero or the
  vault's own address) is marked `unpayable`. A burn at or below the fee is looked at again
  about once a minute and paid if the fee falls below it; one naming the zero or the vault's
  own address is lost for good. Wallets never build either. Burns at or below the release fee
  the coordinator last read are set aside all at once, before the next burn is chosen and with
  no vault read (since rc.16), so they can't take the places of real burns in the queue.
- **A payout the owner cancelled waits for the owner** (since rc.16, §7). The coordinator reads
  `releaseCancelled` or `refundCancelled` before it asks the signers; for a cancelled one it asks
  nobody and sends nothing, looks again every ten minutes, and goes on once the owner has
  reinstated it. It holds up no other payout.
  They take the fee and the release capacity from the vault itself over the chain's RPCs, not
  from the coordinator's `/status`, and refuse when they can't read them. Since rc.18 the same
  holds for whether the vault can pay now: `paused()`, `unreservedBacking()`,
  `releaseAvailable()` and `reservedUnits` are read from the vault before a burn is built
  and again before it is sent, and a burn is refused on `units > unreservedBacking`,
  `units > releaseAvailable`, `reservedUnits + units > releaseCapacity` or a pause.
  Since run 21 (Daybreak [2], [19]) that second read, and the recipient's check, come after
  any merge the burn needed first, right before the burn is sent, and a release fee above the
  one the review showed stops it: the vault charges the fee of the moment it queues the payout,
  after the burn, so nothing binds it to the one shown. A fee raised after the burn is still
  charged; the wallet can only refuse to burn into one it already sees.
  `/status` is still asked: it names the other chain to offer, and when it says a vault can't
  pay what the vault says it can, the clients stop and say that the two disagree.
- **A blocked recipient is never paid** (decided 2026-11-04). Ethereum USDT keeps a
  blacklist (`isBlackListed(address)`, edited by Tether); BSC-USD keeps none (both checked
  on mainnet forks: `npm run fork:rehearsal`). USDT's blacklist stops only senders, so the
  vault would pay a blacklisted address, and the USDT would be frozen there for good. So:
  - wallets ask `GET /recipients/:chain/:address` before a burn and refuse one the vault
    wouldn't pay; if they can't ask, they refuse too (a burn can't be undone). That answer is
    only the coordinator's word, so kUSDT Wallet also asks the token itself, through the view
    its pinned deployment names (`isBlackListed` for Ethereum USDT; BSC-USD keeps none), on
    each of the chain's RPCs, when it plans the burn and again right before it is sent: one
    RPC saying blocked, or none answering, refuses the burn (since run 21, Daybreak [24]);
  - signers refuse to sign a release or a refund to an address the token reports blocked
    on every one of their RPCs (the deployment names the view: `blocklist` per chain);
  - a burn that lands anyway is held (`blocked`), checked again every hour, and paid if
    the token unblocks the address. Nothing re-targets it: no key can redirect a burn, and
    its USDT stays in the vault as backing. A refund to a blocked depositor waits the same
    way. A held burn never holds up others.
- **A vault the token blocks** can pay nothing while deposits still go in: the monitor
  raises `vault-blocked` and the guardian pauses everything (§11).
- **Who pays a minted state's KAS:** the coordinator's Kaspa funding, out of the deposit
  fee. From then on the KAS belongs to the holder and travels with the token.

## 10. Finality

| Chain | A deposit or burn counts once |
|---|---|
| Ethereum | its block is at or below the `finalized` block |
| BNB Chain | its block is at or below the `finalized` block |
| Kaspa | its accepting block is ≥ 1 000 DAA below the virtual DAA score (≈100 s); 300 on testnet. Larger burns wait deeper (below) |

A deposit counts for a signer or a monitor only as every one of its EVM RPCs shows it when asked, all of them at
once, at the deposit's own blocks (at or below the `finalized` block every one of them reports), each field and the
block's hash alike. The records each RPC reported earlier only say where to look: until run 21 (R21-SIG2-1) they were
compared instead, so a lie one RPC told once and another told days later added up to agreement, and a mint and a refund
of it were signed. A record that is not what every RPC says now is replaced by it (R21-SIG2-2).

A release can't be undone, so larger burns wait deeper. The deployment's `kaspa.finalityTiers`
(`[{above, daa}]`, `above` in base units) raise the depth for a burn output of more than
`above`: on mainnet 6 000 DAA (≈10 min) above 10 000 kUSDT and 36 000 DAA (≈1 h) above 100 000.
Signers check the tiers on their own nodes (`burnFinalityDaa`); the coordinator marks a burn
`final` by the same rule, for the burn's own amount; the preflight refuses a mainnet deployment
with shallower tiers, and since round 17 (R17-MINT-2) a mainnet signer and monitor refuse to start
on one, and on a chain whose `finality` is not `finalized` (a block count has no floor). A signer that asks for a deeper tier than that (see below) says so in its
refusal, and the coordinator asks again when the burn is that deep, without counting the try as a
failure (for the deepest tier's time at most).
A signer sees a burn in its own node in two ways, and every one it can ask must agree: the UTXO set
(the output is there, with kUSDT's covenant ID and exactly the claimed state's script), and the
accepted transaction its own follower read (the same output, with the chain block that accepted it).
The UTXO set is found by listing the burn's address, which anyone can fill with coins; only when it
cannot be listed does the follower's record stand alone, after the node has confirmed that the
follower's last chain block is still on its selected chain, and has not said that the record's own
block is off it. The depth is the accepting block's, the
later one if the two differ. A UTXO set that answers "not there" is a refusal either way.
What a follower saves is of one moment (since round 12): its position and everything it took from
the transactions up to there (burn records, the minter, the journal that undoes its moves) go to
the disk together. Every wait for the node that a batch of accepted transactions needs is made
before any of the batch is applied, so no save, by whichever path, holds records from above its
own position; a reorg after a restart is then always found from that position, and undone. A signer
also lets go, at a start, of whatever an older state holds from above its position.
A signer measures a burn or a refund together with what it signed for release within the
deepest tier's time, requests asked at the same moment included (the depth is worked out
again as each is recorded), so one large burn split into small ones waits as deep as the whole.
The skip behind a refund waits by the same rule, for the refund's size: a refund can't be undone either.

## 11. Invariants

- **INV-1** kUSDT in circulation = minted − burned ≤ Σ vault backing, where a vault's
  backing is `balance − feesAccrued`. The monitor checks it continuously and the guardian
  pauses everything when it fails.
- **INV-2** Every vault deposit nonce is minted once or refunded once, never both. Signers
  sign a refund only for a nonce their own minter follower saw skipped (final) and never
  minted, and sign a mint only while the vault's live `depositMinted(nonce)`, read on every
  RPC, is non-zero (not refunded) and their own follower does not show the nonce skipped, so
  no mint is signed after its refund. A signer whose follower shows the minter past a nonce
  signs no first mint for it either (a mint it has a record of signing it signs again): such a
  signature mints nothing, and must not be chargeable to the signer's daily limit by whoever
  holds the coordinator. A mint signed before the skip does not expire: a Kaspa
  reorg that undoes the skip frees the nonce, and that mint could land after the refund was
  paid. "Never both" therefore rests on finality depth, as every release does: since round 14
  (R14-ONCE-L1) the skip is as deep as the deepest finality tier (§10) before any signer signs
  the refund, whatever its size and whatever the signer remembers signing. The tier by size
  held only for a deposit a signer remembered signing no mint for, and a signer rolled back
  from a snapshot or started on new volumes forgets the mint signatures it gave.
  A follower that sees a nonce re-decided across such a reorg keeps only the current
  outcome; the monitor keeps the refunds it has seen and alarms on a mint that names one.
- **INV-3** Every burn output is released at most once (`redeemId`).
- **INV-4** No single key, the coordinator included, can mint, release or refund.
- **INV-5** Within any 24 hours, less than three times each vault's release allowance (§8)
  can leave it (a full bucket, a day of refill and one queue drawn earlier), whatever signer,
  guardian or coordinator keys are stolen: only the vault owner
  sets that allowance. At most twice the Kaspa allowance can be minted unless 4 signer keys
  are stolen; with 4, the remaining hard cap is the bound and INV-1's monitor is the defence.

**The monitor** (bridge/services/src/monitor) checks these from its own nodes and takes
nothing from the coordinator. It reads Kaspa in acceptance order (the virtual chain's
accepted transactions, a few DAA deep), so a transaction that lost a double-spend race never
counts. If the selected chain still moves off a block it already read (TN10 did, 2026-11-04),
it reads again from the fork point; a transaction it already followed spends a state it no
longer holds, so reading it twice changes nothing. The coordinator and the signers follow the
same way (20 DAA deep by default). It follows `BridgeMint` and adopts each successor only when the outputs hold it, and
it indexes every kUSDT burn (by covenant ID). It can't tell a burn owner from any other script hash, so it records
every kUSDT output with a P2SH owner; a record whose output is later spent is dropped (since rc.16), because a real
burn can never be spent. So the records an outsider can keep in its state are bounded by the KAS their outputs
hold, not by network fees. A monitor that starts from a checkpoint (`scanFrom`, `initialMinter`) is given the
burns from before it that no vault has paid, by the same answer of a running monitor's `GET /api/v1/checkpoint`,
asked with that monitor's operator bearer (`initialBurns`, at most 20,000, the largest first; the public answer
does not carry the list): the address of a burn can be filled with coins until it can
never be listed, and a monitor with no record of the burn would then fail closed for an outsider. A listed burn
keeps the block its entry names (a reorg that drops the block drops it) and is asked for in the UTXO set while its
release waits. A monitor that goes on from a checkpoint after a gap longer than its node keeps holds on only to the
burns that were deeper than the deepest finality tier when it last read Kaspa; the signers and the coordinator
forget all of theirs in that case. A successor counts only among the outputs the
spending input authorizes in the family (covenant ID and authorizing input, in the
covenant's order): a plain output paying to the same script is a decoy and is ignored. An
alarm is raised when:

| Alarm | Means |
|---|---|
| `inv1` | minted − released > Σ backing, with each vault read at one block (INV-1) |
| `mint-without-deposit`, `mint-mismatch` | a mint has no final deposit behind each recipient, or not the same recipient and amount (INV-2) |
| `release-without-burn`, `release-mismatch` | a vault queued or paid a `redeemId` that is no kUSDT burn, or not its amount or the recipient its burn owner commits to (INV-3). For a burn the monitor did not read from a block, "no burn" is only its synced node's own answer, given in that round: a look in the UTXO set that failed says nothing, and is made again |
| `release-before-finality`, `release-burn-dropped` | a vault queued or paid a release whose burn is shallower than its amount's finality depth (§10) by more than the monitor's own margin of 650 DAA, or whose burn a Kaspa reorg dropped while the release was queued. A burn counts for a release only at its full finality depth; a queued release stays under watch until it has left the queue. The depth for this alarm (and for `refund-before-finality`) is by a virtual read after the vault, held to the round's start plus the time since, so an honest payout signed during a long round is not called early (round 14, R14-PAY-1); a payout counts by the round's start |
| `refund-of-minted-deposit`, `refund-without-skip` | a vault queued or paid the refund of a deposit that was minted, or one Kaspa never skipped (INV-2) |
| `refund-before-finality` | a vault queued or paid a refund whose skip is shallower than the refund amount's finality depth (§10) by more than the monitor's margin of 650 DAA. A queued refund is judged again every round until it leaves the queue, so a skip a Kaspa reorg drops meanwhile is `refund-without-skip` (since round 13, R13-ONCE-1) |
| `mint-of-refunded-deposit` | a mint names a deposit a vault refunded or queued a refund for: seen by the monitor (a refund the owner cancelled no longer counts, one reinstated does again), or read from `isRefunded(nonce)` on every RPC (INV-2) |
| `refund-mismatch` | a vault queued or paid a refund to anyone but the deposit's `sender`, or for anything but what it minted |
| `flagged-payout-still-queued` | a vault runs again while a queued payout that raised an alarm has not been cancelled |
| `signers-changed`, `limits-raised`, `governance-unannounced` | governance the operators didn't announce (`expectedGovernance`): a new signer set, a higher allowance, and since run 20 (D7-4) a skip or a `setLimits` that does not raise the allowance. An unpause with no alarm open and a veto are noted, announced or not |
| `unpaused-while-alarmed`, `vault-unpaused-while-alarmed` | an unpause while an alarm is open |
| `vault-signers-differ` | a vault's signers are not the deployment's |
| `minter-unverifiable` | the minter moved in a way the monitor can't verify, also after reading that chain block's transactions from its node a second time |
| `minter-lost` | the minter UTXO it follows is not in the node's UTXO set with kUSDT's covenant ID, on three caught-up checks, and no fetched transaction spends it. A minter address holding more coins than can be listed, or (since run 21) so many that the node does not answer a read of it once it has read it crowded, is neither a miss nor an alarm: `/health` warns, with the address |
| `vault-blocked` | the token's blocklist names a vault, which then can't pay anything out (§9) |
| `pool-unverifiable` | the pool was spent in a way the monitor can't verify, also after reading that chain block's transactions from its node a second time (§15) |
| `pool-keys-changed` | a pool `set_keys` changed a key the operators did not announce (`expectedPoolKeys`) |
| `recovery-proposed` | three signers proposed replacing the signer set, which the operators did not announce: any one signer can veto it within the wait |
| `guardian-not-ours` | a rotation or a recovery left the minter with a guardian this monitor does not hold, announced or not: it can no longer pause the minter. Since run 20 (D3-2) also a vault's `guardian()` or the pool's guardian that is not this monitor's key, read every 5 minutes and after a `GuardianSet` or a pool `set_keys` |
| `pause-failed` | a pause has failed to go out for a minute, or the guardian key is not the one the minter or pool holds. A vault every RPC refuses the pause for as already paused (`EnforcedPause`) is paused, not failed, once every RPC also says `paused()` of its latest block (since round 20, MON20-3); the refusal alone never counts |
| `pause-unlanded` | pauses of the minter or the pool have gone out for three minutes and the chain has accepted none (since round 11): a node took them, no block did, as when a spend no block can take holds the coin in ordinary nodes' mempools (§15, "Parked spends"). Since run 20's deep round (D3-7) also for a vault: its pause has gone out for three minutes and not every RPC says the vault is paused; the pause is sent again every 30 seconds, through the next RPC, with a bid capped at 1 000 gwei on Ethereum and 100 gwei on BNB Chain (D3-6) |
| `unverifiable` | something could not be read or judged for `failClosedMs` (5 minutes by default), or a mint is still unjudged `failClosedMs` after the monitor saw it, whatever kept it so (since round 16), or a queued payout is still unjudged two thirds of the way through its wait, or the burn behind a payout could not be looked for in the UTXO set for two minutes (five for a paid one): the monitor fails closed |
| `crash-loop` | the monitor has started three times or more over `failClosedMs` without finishing one round (since rc.16) |

Its `/health` also answers 503 while its Kaspa view lags (default 600 DAA), so an operator
learns about a stalled node before alarms would come late, and after each start until a round of
that start has made a check (since round 17): the check saved before a start is never shown as fresh.

On any alarm the guardian pauses every vault, the minter and the pool (§15: swaps and new
liquidity stop, withdrawals stay open) and keeps them paused until an operator acknowledges
the alarm. It never unpauses: that takes 4 of 5 signers on Kaspa and
the vault owner on each chain. The pauses start as the alarm opens, not when the round ends, and
the alarms one pass of the monitor raises are saved together once it lets the thread go (since
round 20, MON20-1: a save per alarm held the pause back, by 89 s for 2,000 small forged payouts on
a 10 MB state). The local end-to-end run proves it: three stolen signer keys
mint 400 000 kUSDT with no deposit (the covenant accepts it), and both vaults, the minter and
the pool are paused: since round 16 by that mint's own fail-closed clock, `failClosedMs` after the
monitor saw it, inside a payout's wait (within seconds until rc.19).

The monitor also watches the vault owner: every owner event on a vault and every operation
queued in its AccessManager (`OperationScheduled`) must match an announced call
(`expectedOwnerCalls`), or it is an alarm (`vault-owner-unannounced`, `owner-op-unannounced`)
that pauses everything; with a canceller key the monitor also cancels the queued operation. The
owner events include `ReleaseReinstated`, `RefundReinstated` and `DepositSurgeSet` (since rc.16). A
payout with no burn behind it is an alarm as soon as it is queued and the monitor's Kaspa view
has caught up, while the pause still stops it. A queued refund with no skip behind it is judged the
same way (since rc.16): in the second round that read Kaspa up to date, not only when its two-minute
grace runs out, and a round that did not read Kaspa up to date stops that grace for as long as it
took and never starts it over. Any queued payout still unjudged two thirds of the way through its
wait fails closed (`unverifiable`), whatever kept it unjudged, judged in the chains' time (its
`readyAt` is a block time; since round 18); a start holds it in its first round only, and being
offline (below) while it lasts, but not a catch-up (since run 21's decision 12). Each open mint has a
fail-closed clock of its own, from when the monitor saw it (from when the chain accepted it, for a mint
read more than a minute after that: below),
that no other mint's check and no step's success moves (since round 16): one still unjudged
`failClosedMs` later is `unverifiable`, naming it, whatever kept it so (a deposit history still being
read, a nonce past the vault's count, a failed read, rounds out of time). Since round 17 a restart
leaves out only the time the monitor was away, and a mint that a Kaspa reorg drops and the chain
accepts again keeps its first sighting, its clock and its verdict (kept for a day, at most 1,024 such
records, more is `unverifiable`). A mint past the vault's count stays out of INV-1 while its clock
runs, and since round 20 (MON20-2) not out of what the public is shown: while a mint names a deposit
past the count, or one no RPC has shown for over a minute, the signal is not ok and `/health` is 503,
the backing is never published healthy while what is owed exceeds the backing read, and the amount
INV-1 left out is published as `unverifiedMinted`; nothing is paused for it before its clock runs
out. `failClosedMs` is at most half the vaults' payout wait, with a
round, the pauses and a mined block inside it too: a mainnet monitor refuses to start on an
announced `setPayoutDelay` it does not fit. A deposit shown but not
final, or none where the vault's count says one is, is a verdict for now with its own grace. While a
chain's deposit history is behind, each mint's deposit is read by its nonce on every RPC, and an RPC
that reports a deposit under another transaction than before counts as failing; it reads the history
again once a day at most.

Since round 30 an outage of the monitor's own machine pauses nothing by itself. A start more than
90 s after its last round, and its network back after it was offline (every RPC of every chain with
no answer at all, and its Kaspa node not answering or stopped, in the same rounds), is a catch-up:
until its node is within a minute of the network, its reading caught up to the node and every vault
read to its head, in one round, the rules above for what it cannot verify (`unverifiable`, the
clocks of unjudged mints and payouts) wait while it makes progress, and their clocks get that time
back. A part with no progress for `failClosedMs`, or a catch-up longer than the time away (at least
30 minutes, at most 6 hours), ends it, and they apply again at once. Offline, the clocks do not run.
Evidence pauses at once throughout as soon as it can be seen: a release, by the node's UTXO set, in any
round whose node is within a minute of the network (since run 21, R21-MON2-1); a mint, a refund or
governance once the reading has reached it. `/health` says `not guarding: ...` meanwhile. Since
round 18 a vault makes progress only in a round that read it whole (its logs and every agreed read); a start
after a gap during a catch-up goes on with it, and gives its time away back only when every part
still behind had made progress since the last time away, so no restart pattern renews its bounds; a
start after a gap while guarding moves every fail-closed clock on by the time away instead of
emptying it, and what had been failing for a minute before it (a node, a chain, an unjudged payout)
gets nothing from the catch-up; a machine frozen with both its clocks going on for more than about 3
minutes is time away as a start after a gap is; and a step of the clock forward that the chains'
time confirms moves the clocks forward by as much. Two exceptions since run 21's decision 12 (the
owner's, 14 November 2026), while catching up and not while offline: a queued payout still unjudged
two thirds of the way through its wait fails closed as when guarding (an honest one too: the cost the
owner accepts); and a mint read more than a minute after the chain accepted it (by how far behind the
node's virtual DAA it was read) has its graces, its fail-closed clock and its time out of INV-1 from
that acceptance, which no catch-up or time away holds or moves.

A monitor that dies in every round would clear its failure clocks at each start and never fail
closed. So it keeps the times of the starts that no finished round followed in a small file next to
its state (`<statePath>.starts`), written before anything is read. Three starts or more over
`failClosedMs` with no round finished: it pauses everything first, then raises `crash-loop`. Starts
further apart than `failClosedMs` are a host that was off, not a loop. An alarm is saved when it is
raised, not only at the round's end. Every EVM RPC answer the services read is asked for
uncompressed, refused unread if it comes compressed, and cut off at 16 MB, so one answer can't end
a service (bridge/services/src/shared/capped-fetch.ts). A getLogs cut off there is asked again in
halves, as one a provider refuses for its size is, down to a single block, and is not retried whole.
Only a refusal that names a block range (a provider's own limit) is remembered for that RPC, and even
that one is tried double again after 64 full ranges; one for what the range held (a result cap such
as Infura's 10,000 logs, or an answer over 16 MB) shortens that read alone, to the range the refusal
says would fit where it names one, and the read doubles its range again after each range served. A
burst of deposits in a few blocks used to leave the RPC reading a few blocks a request until a
restart (R15-MINT-1). Each RPC's current range is on the signer's `/health` (`getLogsBlocks`,
behind its bearer), every service logs when an RPC names a lower block-range limit, and
`kusdt check` says how far an RPC that refuses the 2,000-block tail does serve.
Since rc.22 the signer's `/health` also says whether the signer can do its work, and is 503 with the
reasons when it cannot: its Kaspa node has not answered for two minutes (an ask of `getServerInfo`
every ten seconds, five seconds each, or a scan of its follower) or has said it is not synced for two
minutes (not judged on a simnet or devnet), its minter follower has not seen the node's virtual DAA
rise for two minutes or lags it by more than 600 DAA (or by more than 100 DAA, past which it refuses
every refund, for two minutes: since run 20), or every read of a chain's RPCs has failed over
five minutes (from the first failed read to the last, with none answering between; one failed read
alone is no problem, since run 20). Since run 20 it is 503 too while the signer holds itself (its daily
limits count as spent after a lost journal, a mint on the chain its records lack, or `fuseHoldUntil`),
with the end of the hold and why. It reads nothing for the request, only what the signer's loops and its sign requests
noted, and what the signer signs or refuses does not depend on it.
The local load run proves it: three stolen signer
keys queue a small payout with no burn, the monitor pauses within the wait, nothing leaves, and
the owner cancels it.
For integrators it serves `GET /api/v1/signal`: `{version: 1, ok, reasons, backing, paused,
alarms}`; `ok` false means stop accepting new kUSDT. `backing` is `{healthy, owed, total,
unverifiedMinted}` (the last since round 20), and `healthy` is never true while `owed` exceeds `total`.

**Who answers the public** (since the work after round 12). The monitor answers nobody from outside. It writes its
public answers (`/health`, the signal, `/api/v1/monitor` and the public `/api/v1/checkpoint`) to two files, written
whole and swapped in (a reader sees the old file or the new one), at the end of every round, at once when an alarm
opens or is acknowledged, and every five seconds in between. A separate process, `kusdt status`, with those files on
a read-only mount and no key, no bearer and no connection to any node, serves them under the same paths and fields.
It applies the monitor's freshness rules again when it answers: a status file more than a minute old makes `/health`
503 and the signal `ok: false` with that reason first, and the status `healthy: false`; a check more than five
minutes old is no fresh check, as before. How old a file is, the status process measures by its own monotonic clock
since the monitor last wrote a newer one (each file carries the monitor's start and a count of its writes, and a
newer file is told by those, never by its time), and never less than by the time the file names; a file or a check
dated ahead of the host's clock is never fresh (since round 14: a clock set back used to freeze the answers from
before the step as fresh). A monitor that is stopped, stuck or cannot write is therefore never shown
as healthy, and a flood of status requests costs the monitor nothing. Its own listener takes the operator bearer for
every request, before anything is read: acknowledging an alarm, and the checkpoint with the unpaid burns.

## 12. Before mainnet

1. Five independent signer operators, each with their own nodes.
2. External audits of `BridgeMint` and `KasPool` (and the SilverScript they compile to) and
   of the vault.
3. The vault owner is an OpenZeppelin AccessManager, with `renounceRole` closed, whose admin is a Safe: the vault's
   governance waits 48 h (`setGuardian` and `unpause` ≈6 h), the manager's own changes 48 h,
   and independent cancellers may cancel any queued vault change and any queued power-adding
   change of the manager itself (§7).
4. Legal review of holding users' USDT.
5. Proof of reserves published live (INV-1).
6. kUSDT's genesis reviewed by kascov.io (wallets mark unreviewed tokens "unvalidated").
7. The pool admin key held offline by the operator (it takes the protocol fees, unpauses the pool, hands the keys
   over, and signs the pool's first deposit and the first into an emptied pool, §15), and a pool keeper running with
   a funded key of its own (§15).
8. ~~A decision on redemptions to a blocked recipient~~: decided 2026-11-04, they are
   blocked (§9); no re-target power exists.
9. ~~Burn finality scaled to the payout~~: done 2026-11-05 (§10).

## 13. Coordinator API

Public, read-mostly, JSON over HTTPS at `/api/v1`. Amounts are JSON integers; clients parse them exactly (some exceed 2⁵³), and accept a value of 16 or more digits as a decimal string too. Nothing here moves funds: every answer that matters
can be checked against a node (a token state against its UTXO, a pool state against its
script). The coordinator learns the minter, the pool and the positions the way the monitor
does (accepted transactions, every successor checked against the outputs), and supply from
the chain: minted = genesis `remaining` − the minter's `remaining`, released = the vaults'
`Released` events.

**Who answers the public** (since the work after round 12). The API is answered by a process of its own, `kusdt api`,
never by the coordinator. It reads what the coordinator writes to its state volume, mounted read-only: the state file,
the token index and the positions (each a log of its own since round 15), which the coordinator writes for itself in
any case, the archive of closed records, and a
small public copy the coordinator writes once a second whatever anyone asks (the pool and the minter as followed
now, the mempool's pool moves, how far each chain was read, its last health check, and when it wrote all this). The
API process asks the Kaspa node and the EVM RPCs on connections of its own, with the budgets below. The coordinator
listens for nobody outside its own container (its health is on 127.0.0.1 there), so no request reaches the process
that mints and pays. The answers are the same as when the coordinator gave them; how old they can be:
- `GET /health` is the coordinator's last health check as published, with its own `at`; it is 503 when the copy is
  more than 15 seconds old (the coordinator is stopped, restarting or cannot write) or the check more than five
  minutes old. The copy's age is measured by the API process's own monotonic clock since the coordinator last wrote a
  newer one (told by the coordinator's start and a count of its writes, never by the copy's time), and never less than
  by the time the copy names; a copy or a check dated ahead of the host's clock is not current (since round 14).
  A copy written this second says nothing of whether the coordinator follows the chains, so the copy also carries
  how long ago each follower last read its chain, by the coordinator's monotonic clock (since round 15): the Kaspa
  follower's last scan that came back from the node with its virtual DAA moved on, and each chain's last pass whose
  reads all went through. A read counts, not something new found: a quiet chain is not a stopped one. `/health` is
  503 when, with the copy's own age added, the Kaspa follower has not seen its node move on for 60 seconds (the node
  is down, frozen or cut off) or a chain has not been read in full for five minutes (its RPCs fail), and when the
  coordinator's state file cannot be written. The coordinator's own health on 127.0.0.1 says the same.
  Since round 16 a read that goes through is not enough on its own. A chain's reads stop at the lowest block across
  its RPCs, so the copy also carries, per chain, how long ago the lowest head and the lowest finalized block across
  them last rose, and which RPC trails the best one by more than the bound and for how long (R16-PUB-1): `/health` is
  503 once a chain's lowest head has not risen for five minutes, its lowest finalized block for 20 minutes on Ethereum
  (three epochs) or 10 on BNB Chain, or one RPC has had its head more than two minutes behind the best one (its
  finalized block more than that chain's finalized bound) for five minutes without a break. A local chain that mines
  on demand (`evmHeadLag: 0`) is not judged. And a Kaspa scan counts as the follower moving on only while the node
  calls itself synced (`getServerInfo`, asked every ten seconds, at most five seconds each; a node that cannot say is
  judged by the rest) and its virtual DAA rose by at least one a second over the last 30 seconds, the monitor's pace
  (R16-PUB-2). The copy says which of the two held a scan back. Since rc.22 the check is also a problem (503) when
  no release or refund has had three signatures for five minutes because the signers that did not answer, or answered
  anything but a signature or a refusal (HTTP 422), leave fewer than three that could sign; it names them by their
  place in the coordinator's `signers` list, and ends with the first payout that has three. Since run 20 a signer
  that refuses because it holds itself (`this signer's daily limits count as spent until ...`) counts as one that
  cannot sign; any other refusal still counts as judging the payout. Since run 21 the warnings name each payout or
  mint batch held because two signers refused it only for their daily limit (the payout or batch, its chain, those
  signers, when the hold ends). Since run 21 round 2 (R21-COORD2-1) such a refusal counts only with its proof: a signer
  that refuses for a limit answers `{error, proof}`, where `proof` is `{index, kind, limit, time, entries, signature}`:
  its index in the deployment, `mint` or `release`, its limit, its clock (ms), and up to 800 charges of its last 24
  hours by key alone, largest first and no more than show the limit used up (so a limit filled by charges averaging
  under 1/800 of it can't be shown), with keys
  `release:<redeemId>`, `refund:<chain>:<nonce>` and `mint:<chain>:<nonce>` (one per deposit), signed by its Kaspa key
  (BIP-340) over SHA-256 of `kUSDT signer fuse proof v1\n` and the JSON array `[index, kind, limit, time, entries]`
  (`bridge/services/src/shared/fuse-proof.ts`). The coordinator believes it when the signature is that deployment
  signer's, the time is within ten minutes of its own, the limit is `signerDailyLimit` (the deployment's, else its
  config's, which is then required; the two must agree), and the entries it can match, each once and none of them
  what the refused request itself asks, to a release, refund or deposit signed for it in the last 25 hours (one it
  asked for and got a valid signature for from a signer other than those whose proofs it is judging, or one its
  records show queued, paid, refunded or minted),
  at the units it knows that item by, pass the limit together with the amount refused. Any other refusal for a limit
  is an ordinary one, and the warnings name the signer and why.
- `GET /pool` refuses (503 with `retryAt`) once the copy is more than 15 seconds old, once the Kaspa follower has not
  seen its node move on for 60 seconds, and while it lags its node by more than the 600 DAA the health allows
  (catching up after a start): a wallet builds a swap on that state, and is never handed one the coordinator stopped
  updating.
- The records (`/deposits`, `/redeems`, `/positions`, `/reserves`, the minter in `/status`) are as of the
  coordinator's last save, a few seconds behind what it knows. Every output `/tokens` and `/positions` list is still
  looked up on the node when it is answered. What a route keeps for a moment (an owner's answer, a vault's state, the
  node's virtual DAA, the reserves, a blocklist answer, the archive's lists, a page of deposits) is over as soon as
  the host's clock reads before it was made, and the budgets and per-client counts start over rather than owe the
  step: a clock set back no longer holds them for its length (since round 16, R16-PUB-5). The same holds since
  round 17 for the coordinator's own clocks (R17-SURF-1, R17-DIFF-2, R17-PUB-2): its retry times (each record's next
  try, the fuse and depth holds, each chain's mint backoff, the count of payouts short of signers) are moved back by
  the step when its wall clock goes back against the monotonic clock, and at a start on a state file written after
  now; its loopback `/health` limiter and the claims puller's waits owe nothing for the step; and a signer's
  per-minute sign window starts over when it ends more than a minute ahead. A queued payout's `readyAt` is the
  vault's own time and stays judged on the wall clock: a clock that is right again pays it when it is due.
- `GET /tokens` refuses (503 with `retryAt`), and `/health` says why, after each start of the API process until it
  has read the token index's log to its end once (16 MB a second: seconds for a full index). An empty index is never
  answered as "this owner holds nothing" (since round 14). `GET /positions` does the same for the positions' log
  (since round 15).

A burn claim (`POST /redeems`) is checked for its shape by the API process and waits there, at most 32 claims or 4 MB
in all and 15 seconds each, until the coordinator fetches it. The coordinator asks for claims itself, one exchange at
a time and no more often than five times a second, reads at most 1.2 MB and eight claims of each answer, and takes
each claim within the same budget of time a claim had before; the reading of the answer counts against it. It says in
each exchange how much it reads, and the API process never hands out more: a claim whose text, as the API process
writes it out (which can be about three times the request's body), would not fit one exchange alone is refused at
once with 413 (since round 14: one such claim failed every exchange it was in). A claim
it cannot take in time is refused to the wallet (503 with `retryAt`), and nothing is queued anywhere: a burn nobody
claimed is still found on the chain. Neither the API process nor anyone who controls it can make the coordinator do
more than take claims a client could have sent, at the rate the coordinator asks for them. The channel's bearer only
tells the API process that it is the coordinator asking; the coordinator takes no other word from that process (a
pool age the API process learns from its own node stays there). An exchange the API process refuses for its bearer
(two claims tokens that differ) is said by both, in their logs once a minute and on their health, and a claim sent
meanwhile is refused (503 with `retryAt`) with the words that the operators' claims setting is wrong and that the
burn is still found on the chain and paid; no token is named (since rc.22: it was told as a stopped coordinator).

A client checks a state against its node by listing the state's address, and a node lists an address whole or not
at all. Where it cannot (the address holds more coins than the client reads, or the read times out: anyone can
send an address coins), a wallet neither shows the state nor drops it (since rc.18). A kUSDT state is shown apart
as not checked, is kept out of the balance and out of every automatic choice, and is spent only at the user's
word, from the wallet's own record of what its node showed it before or, without one, from this API's answer; the
node is the judge of that spend, since a signature commits to the spent output's script and amount. The pool is
never built on unchecked. The reads this takes are bounded (one address at a time, at most 64 a look, an
unlistable address not asked about again for ten minutes).

Request bodies are limited (since rc.16): a body is at most 512 kB (413 above it) and must arrive whole within 10
seconds, or its connection is cut; the server reads at most 64 bodies at a time, 4 per client (an
IPv4 address, an IPv6 /64) and 16 per client network (an IPv4 /24, an IPv6 /48), the last 16 only
for a network that holds none (429 above any; since run 21, R21-OPS2-3: counted per client alone,
sixteen addresses with bodies that never finished held all 64), a request's headers must arrive
within 10 seconds and the whole request within 30. The mainnet
package's Caddy limits bodies to 1 MB and read times as well.

The read routes are bounded too (since rc.17). An owner's answer (`/tokens`, `/positions`) is made by one read at a
time and shared by everyone who asks; it is kept for a second from when it was finished, and for twenty times the
time its read took when that is longer, up to a minute (an owner whose outputs share an address with very many coins).
All such reads together have a budget of time, a quarter of it for one client network, and at most two are with the
node at once. Past the budget an owner asked about lately gets its last answer with `stale: true` and `staleSeconds`;
any other request gets 503 (or 429 for its network's share) with `retryAt`. Reads of closed records from the archive
(`/deposits`, `/deposits/:chain/:nonce`, `/redeems/:txid/:outputIndex`) have a budget of their own and answer 503 or
429 with `retryAt` past it; a record still in the coordinator's state costs no such read. A page of `/deposits` is
shared for a second. `virtualDaa` in `/status` and `/pool` can be a second old.

What a request makes the API ask its Kaspa node goes over connections kept for the API, and the API's reads
of addresses wait in a line of their own, eight at the most (503 with `retryAt` past it): no request stands in the
line the mint and release loops' reads wait in (since rc.18; since the split they are another process's connections
altogether). `/pool` reads no address at all: the pool output's age
(`poolDaa`) is the DAA score at which the coordinator's follower saw that output accepted, kept in its state. For an
output the follower did not see accepted (a state from before rc.18, a pool that has not moved since the launch or a
checkpoint, a reorg that undid a pool move) the address is read once, by the rules an owner's answer has, and no
request waits for that read: until it is back, `poolDaa` is `null`, which claims no age (and `readyAtDaa` is `null` while a claim is needed). What the
API keeps in memory (owners' answers, lists read from the archive, pages) is bounded by how many records it holds
and by its age, not only by how many entries there are.

| Call | Answer |
|---|---|
| `GET /status` | `{network, kaspa: {covenantId, poolId, virtualDaa, minter: {utxo, state}, genesisRemaining, tokenValue, burnValue, finalityDaa, finalityTiers}, chains: [{chain, name, chainId, vault, token, decimals, scannedBlock, depositNonce, backing, unreservedBacking, reservedUnits, releaseAvailable, paused, fees: {feeBps, minDepositFee, minReleaseFee, minDeposit, maxDeposit, releaseCapacity, releaseRefillPerSecond}, blocklist}]}`: each vault's parameters as it reports them; `blocklist` is the token view the bridge honours (`isBlackListed`) or `null`; `scannedBlock` is the last final block the coordinator read (`finalizedBlock` is its old name). Every figure of a vault is read at one block every one of the API's RPCs has (the lowest head, two blocks back) and shown only when all of them answer the same (since run 21; all but `fees` was the first RPC's word before). While they disagree the entry holds the last state they agreed on, with `staleSeconds` and `rpcsDisagree` (the figures they answer differently); before they have agreed once the call fails |
| `GET /tokens?owner=<kaspa address \| x-only hex>` | `{states: [{utxo, state}], unread?, truncated?, stale?, staleSeconds?}`: the owner's unspent kUSDT states, the 500 largest (`truncated` when there are more), a script hash's (P2SH) as well as a key's, all but the burns their transaction's payload names (since run 21); `stale` when the answer is the last one made and could not be made again yet. `unread: [{utxo, state}]` (since rc.19): the index's records among those 500 at an address holding too many coins for the node's answer to be read at all (past 100 MB), with the KAS each coin carried as recorded. The node said neither that they are there nor that they are gone: they are never in `states`, and such an address is not read again for ten minutes |
| `GET /pool` | `{pool, reserve, pending: [txid], confirmed: {pool, reserve}, prices: {kasInKusdt, kusdtInKas}, exact: {unitsPerKas, sompiPerKusdt}, tvlKas}`: `pool` and `reserve` (each `{utxo, state}`) are the newest, mempool included, carried through the pool moves in `pending` (only moves a block can take, §15 "Parked spends"); `confirmed` is the newest accepted. A reserve whose making move the coordinator followed also carries `made` (there only, not in `confirmed`): the id of that transaction, whose body `GET /pool/made/:txid` serves (below). The body is not in this answer, which every page asks for every few seconds: a trader chooses the making transaction's outputs, about 1,200 of them fit a block, so it can be some 140 KB. It proves the reserve (R21-POOL-1) when its id is the reserve's `transactionId` and the reserve its first output bound to kUSDT, at the reserve state's script, in a transaction that also made a coin of the pool's. When that transaction also made the pool coin a client finds on its node, that is the reserve, unspent while the pool coin is (a pool entry either refuses kUSDT beside it or makes the reserve's successor as its first kUSDT output, §15), and clients do not list its address, which anyone can fill. A reserve made before the pool coin (a tick or a pause since) is listed as before: its body says what the outpoint held, not that it is still there, and is taken only when the address cannot be listed (a spent or never-made outpoint then makes the node refuse the transaction built on it). `exact` gives the spot prices as integer strings, rounded down (kUSDT units per KAS, sompi per kUSDT); `prices` are floats for display. `breaker: {maxOutBps, windowLen, maxKasOutNow, windowEndsDaa, virtualDaa, poolDaa}` is what sells may still take out of the KAS reserve now (§15): `windowEndsDaa` is the DAA score at which the allowance has fully refilled, `poolDaa` the DAA score the pool UTXO was accepted at (`null` while it is only in the mempool, and while the coordinator does not know it yet, see above); `breaker` also carries `minAgeDaa`, the least age a pool transaction must claim now, and `readyAtDaa`, the DAA score before which none can be sent (`null` while the newest pool UTXO is only in the mempool, or its age is not known yet and a claim is needed). `paused` says whether the guardian paused the pool. `priceKas` stays as an alias of `prices.kasInKusdt` |
| `GET /pool/made/:txid` | `{txid, made}`: `made` is the body of transaction `txid` (64 lowercase hex digits), as far as its id goes (`{version, inputs: [{previousOutpoint, sequence}], outputs: [{value, scriptPublicKey, covenant}], lockTime, subnetworkId, gas, payloadDigest}`, no signature scripts; a version 1 id commits to the payload by its digest alone, so the digest stands in for it, whatever a trader put there), for a transaction that made the pool reserve the coordinator follows now (the confirmed one or the newest); 404 for any other id, from memory, with no read of the node. A body never changes: the answer says `Cache-Control: public, max-age=31536000, immutable`, and clients keep it by its id and fetch it once. The API's per-client limit counts it as any other request. The coordinator writes these bodies beside its public copy (`<publicPath>.made`), only when they change, for the API process to serve |
| `GET /positions?owner=<kaspa address \| x-only hex>` | `{positions: [{utxo, state: {tokenCovid, shares, owner}}], unread?, truncated?, notListedAtOrBelowShares?}`: the owner's live liquidity positions, the 500 with the most shares, each found in the node's UTXO set; `unread` as for `/tokens`. The coordinator's index holds 50,000 positions at most (`maxPositions`, since round 15): while it is full, positions of `notListedAtOrBelowShares` shares or fewer are not taken in, and every answer says `truncated` |
| `GET /deposits/:chain/:nonce` | `{chain, nonce, txHash, sender, ownerScheme, owner, units, fee, minted, status, kaspaTxid?, refund?}`; status `pending → final → minting → minted` or `refunded`; `refund` is `{status: skipped → refunded, or blocked (§9), skipTxid, evmTxHash?, attempts?, nextTry?, lastError?}` once Kaspa skipped the nonce. `:chain` is the code (1, 2), `ethereum` / `bsc`, or the deployment's chain name |
| `GET /recipients/:chain/:address` | `{chain, address, blocklist, blocked, payable, reason}`: whether the vault would pay `address` (§9). `payable` is false for the zero address, the vault's own and an address the token blocks; 503 when the token can't be read. Wallets refuse a burn unless `payable` |
| `GET /deposits?sender=0x…` or `?owner=…` | the matching deposits, newest first, at most 1 000 per answer; `limit` and `offset` page them (with no filter, 100 unless `limit` says more), and `total` says how many match. `sender` is an EVM address (`0x` and 40 hex digits, in any case); anything else matches no deposit and is answered with an empty page, with nothing read |
| `POST /redeems` | body `{transaction, transactionId}` (a submitted burn, node JSON, with the id the node answered) or `{txid, outputIndex, chain, address, state}` (a payload-less burn's preimage); answers `{redeems: [{redeemId, status}]}`. Nothing is read from the node on the request: a claim waits until the coordinator's follower or its claims loop has found the output. Claims nobody has proven are bounded fairly (since run 21): at most 256 redemptions of each kind, past which the client network that sent the most loses one first, and no claim the node was not asked about yet goes for a newer one from another network; at most 16 other claims per output, one per network, each taking only the place of one the node was asked about. A claim with no place for now is refused, 503 with `retryAt` |
| `GET /redeems/:txid/:outputIndex` | `{redeemId, chain, address, units, status, fee?, payout?, evmTxHash?, readyAt?, queuedTx?, attempts?, nextTry?, lastError?}`; status `seen → final → signing → queued → released` (`queued`: waiting in the vault until `readyAt`, §7), or `invalid` (not in the UTXO set), `unpayable` (§9) or `blocked` (held while the token blocks the recipient; back to `final` once it doesn't, §9). `fee` and `payout` come from the vault's `Released` event |
| `GET /reserves` | `{supply: {minted, released, pendingBurns, circulating}, backing: {<chain name>: units, total}, at: {<chain name>: block}, healthy}`; healthy means `total ≥ minted − released` (INV-1). Each backing is read at the block (`at`) the releases were counted to, so a release that just landed never looks like missing backing; before they are counted (`at` is `null`), at the newest block every one of the API's RPCs has. Either way every RPC must answer the same (since run 21, the first RPC's word before), or the call fails |

## 14. Wallet provider

The wallet extension injects `window.kusdt`, an EIP-1193-style object:
`request({method, params}) → Promise`, plus `on(event, listener)`. The wallet builds every
transaction itself (WebAssembly core + §13 data), shows the user what it does, signs and
submits; the page never sees a key. It builds on the network the request was asked on, the one
its window names, whatever the wallet's settings say by then (run 21).

| Method | Params | Result |
|---|---|---|
| `kaspa_requestAccounts` | none | `[address]`, after the user approves the site |
| `kaspa_getNetwork` | none | `"mainnet" \| "testnet-10" \| "simnet"` |
| `kaspa_switchNetwork` | `{network}`, one of the three | the network the wallet is on afterwards. A connected site only (4100 otherwise). Already there: answered at once; else the user approves in the wallet's window (4001 declined, -32002 another window open, 4200 nothing deployed there, -32602 malformed). The site stays connected on the new network; `networkChanged` and `accountsChanged` follow |
| `kusdt_getBalances` | none | `{kas, kusdt}` in sompi and base units |
| `kusdt_send` | `{to, amount}` | `{txid}` |
| `kusdt_redeem` | `{chain, address, amount}` | `{txid, redeemIds}` |
| `kusdt_swap` | `{side: "buy" \| "sell", amountIn, minOut}` | `{txid, amountOut, confirmed}` |
| `kusdt_addLiquidity` | `{kasIn, tokensIn}` | `{txid, shares, confirmed}` |
| `kusdt_removeLiquidity` | `{position}` | `{txid, confirmed}` |

`confirmed` (added 2026-11-11): `true` once the wallet's node shows the transaction accepted (one of its outputs
in the UTXO set). `false`: the node took it and neither it nor a rival was seen accepted within the wallet's wait
(30 s); another transaction can still reach the pool first, and then nothing of it happens. A page says "sent",
not "done", for `false`, and treats a missing field (an older wallet) as unknown. A transaction the wallet sees
lose the race for the pool UTXO is never answered as a result: the wallet frees what it held and goes again on
the new pool under §15's rule (never below the minimum, and on its own only at no worse a quote), or answers
an error.

Requests (round 14): each site's requests wait in a queue of their own, answered in order, and sites wait on
each other only for the one approval window (the tab the user is looking at first, unless that would pass a
request that waited over a second). A site, and a tab across all its sites, has at most 8 requests waiting or
running; one more is answered -32002 at once, before anything is read, and so is a request that waited 45 s
in its queue or for the approval window's turn. A
request a page may not make, or that is malformed, is answered at once; params of more than 4 096
characters, nested more than 4 deep, or not JSON are refused (-32602) in the page, before the wallet reads them
(run 21). `kusdt_getBalances` for the same wallet
and network shares one read while it runs and its answer for a second after; a site waits for it at most 30 s
(then -32603). It is read on the network the site was checked against (run 21). A locked wallet tells no site its
account or balances, and reads nothing for them (run 21, R21-W2-4): a connected site's `kusdt_getBalances` is
answered 4100 with `data: { locked: true }`, which a page tells apart from "not connected" and keeps its connection
for; its `kaspa_requestAccounts` opens the wallet's window, which asks for the password and then answers the account
the site already has. At unlock each connected site's tab hears `accountsChanged` with its account. Requests a closed
tab left waiting
are dropped, and so are those of a page that navigated away (its content script names them at `pagehide`). Since
run 21 this includes the request the approval window is open for: the window closes and the site is answered 4001.
The window holds a request for at most 5 minutes; then the next site's request takes its place (the first is
answered 4001), and the window can no longer approve it.

Events: `accountsChanged`, `networkChanged`. Each names the origin it was decided for, and a page of
another origin (the tab navigated meanwhile) is not given it (run 21). For the EVM side (deposits) the page uses the
user's EVM wallet (EIP-1193 / EIP-6963 / WalletConnect); the extension also offers one.

## 15. KasPool (KAS ⇄ kUSDT)

A constant-product pool in its own covenant family. Its covenant ID is the deployment's
`poolId`; wallets pin it like kUSDT's.

- **`Pool`**, a singleton: `{token_covid, kas_reserve X, token_reserve Y, total_shares S,
  protocol_kas, protocol_tokens, base_value, admin, max_out_bps, window_len, window_credit,
  window_ref, window_out, paused, guardian}`. Its UTXO holds exactly
  `base_value + X + protocol_kas` sompi.
- **The reserve**: one kUSDT `KCC20` state owned by the pool's covenant ID (scheme `0x04`),
  borrowing disabled, holding `Y + protocol_tokens`.
- **`Position`**: `{token_covid, shares, owner}`, one per liquidity deposit, 2 KAS each.

| Entry | Does | Checks (exact, with 128-bit products) |
|---|---|---|
| `init` | first deposit | the admin's signature (added 2026-11-10); `X = Y = S = 0` before; `S = kas_in`; the position gets `kas_in − 1000` shares, and the 1000 unowned shares stay forever; `window_ref = kas_in` |
| `buy` | KAS in, kUSDT out | not paused; fee 0.50 %, of which 0.05 % of the input goes to `protocol_kas`; `(X + 0.995·in) · Y′ ≥ X · Y`; the breaker's `age_daa` (below) |
| `sell`, `sell_all` | kUSDT in, KAS out | not paused; the same, with the protocol cut in kUSDT; and the circuit breaker (below), with `age_daa` within the pool UTXO's real age |
| `add` | KAS + kUSDT in, a new position | not paused; `shares · X ≤ kas_in · S` and `shares · Y ≤ tokens_in · S`; `age_daa` settles the breaker first, as a swap's does; into an emptied pool (`S = 1000`, only the unowned shares) the admin's signature, and `window_ref` = the new reserve, as `init` (added 2026-11-10) |
| `remove` | burns a position (its owner signs) | open while paused; `kas_out · S ≤ shares · X`, `tokens_out · S ≤ shares · Y`; `S` stays ≥ 1000; `age_daa` settles the breaker first; while paused `age_daa = 0` and nothing settles |
| `tick` | settles the breaker with the pool UTXO's age, nothing else (added 2026-11-10) | anyone; not paused; an opened pool (`S > 0`: refused between the genesis and `init`, added 2026-11-11); `age_daa` ≥ the minimum claim; no kUSDT input; the pool's value unchanged |
| `collect` | the admin takes `protocol_kas` and `protocol_tokens` | admin signature; X and Y unchanged |
| `pause` | stops swaps and new liquidity | the guardian's signature; not paused already (added 2026-11-11, as the minter's); no kUSDT input in the transaction |
| `unpause` | resumes them | the admin's signature; no kUSDT input |
| `set_keys` | hands the admin key, the guardian key or both over | admin signature; no kUSDT input |

**The circuit breaker.** kUSDT minted with stolen bridge keys (§1: 3 of 5) is real kUSDT to
the pool: same token, same covenant ID. A forged mint and a sell into the pool can land in the
same block, before any monitor can see them, so nothing off-chain can stop such a dump. The
pool limits it on-chain instead, with an allowance that refills over time rather than a fixed
window:

- The reserve's token output must keep at least 1 KAS (`MIN_RESERVE_VALUE`, added 2026-11-09): nothing else binds that KAS, and stripped to a sliver the next transaction couldn't carry the storage mass.
- `window_ref` is the KAS reserve the **cap** is measured on, and the cap is `max_out_bps`
  (1 000, 10 %) of it, or of the reserve now if that is smaller. `init` sets it to the first
  deposit. A sell and a withdrawal lower it at once to the reserve they leave. It rises only
  with claimed time: a swap moves it toward the reserve the pool UTXO stood at by
  `age_daa ÷ window_len` of the gap, and the gap counts for at most `window_ref` itself, so it
  grows by at most its own size per window (changed 2026-11-08). KAS that arrives at one moment,
  a buy or new liquidity, can't lift it until it has stayed, and liquidity added to inflate the
  cap and withdrawn again earns at most about 1.6 times the honest refill rate, bounded by the doubling. The cost: a
  large genuine deposit lifts the cap only by about doubling per window.
- `window_out` is the allowance **used**, in net KAS: a sell adds what it takes out, a buy takes
  off what it adds to the reserve. Only claimed time and real buys bring a positive count down;
  a sell is refused while it is at or over the cap. A withdrawal that takes the reserve below the reference cuts a
  larger count down to two caps of the smaller pool (added 2026-11-08): that gives no room, and sells open again within
  two windows instead of many. No other move cuts it.
  Below zero (net buying, at most one cap of credit) a sell has that much more room. Counting
  the net flow keeps round trips (a buy, then a sell back) from using up honest sellers' room
  (changed 2026-11-05), and protects as well: on the constant-product curve the pool's end state
  follows from its net KAS change alone.
- `window_credit` is how much of the room buys gave is still KAS those buys left in the reserve
  (added 2026-11-08). A buy adds what it really credited, after the one-cap limit; a sell spends
  it first; when credit lapses with time, this falls by the same amount. A `remove` moves
  `min(kas_out, window_credit)` of it back onto `window_out`. So KAS that was bought in and
  withdrawn again leaves no room behind: without this, liquidity added, used for a buy and
  withdrawn at one moment reset the breaker again and again. A remove is never refused for it: it
  can only leave sells less room. An honest withdrawal just after buys can therefore use up sell
  room until it refills. `window_out + window_credit` never falls without claimed time.
- The allowance **refills** at one cap per `window_len` DAA (36 000, an hour at 10 BPS):
  `window_out` moves toward zero by `elapsed × cap ÷ window_len`, stopping at zero. Idle time
  fills it to one cap and no further. With no time claimed, the net KAS that can leave is at
  most one cap of the reference, plus any credit, whatever sequence of buys, sells, adds and
  removes is used; over any time *t* it is at most about `cap + credit + cap × t ÷ window_len`,
  with `cap` measured on the largest reference in that time (credit is at most one cap and
  comes only from real buys). The credit does **not** fade with time alone (corrected
  2026-11-13, second outside review of rc.22, D8-1; this said it "fades over a window"): it
  falls only as a spend claims time, which moves a negative count toward zero, or as a sell
  or a remove uses it. A spend that claims age 0 keeps all of it, however long the pool stood.
  So after a quiet period one sell claiming age 0 can take the credit and a whole cap at once,
  up to two caps of the reference: about 18 % of the reserve right after net buying of one cap
  (17.4 % in the reviewer's case), where a sell that claims the pool UTXO's age, as kUSDT Wallet
  builds every sell (the web app's included), settles the credit away first and has one cap, about 10 %.
  The bound above holds as written, with that credit in it. `max_out_bps` and `window_len` are
  fixed at genesis.
- The **clock** is the pool UTXO's own age. A buy, sell, add, remove or tick names `age_daa`
  (0 to two windows) and its pool input's sequence must be exactly that (since rc.22; at least that
  before): `OP_CHECKSEQUENCEVERIFY` in the script, which consensus turns into a relative lock on the
  UTXO's real age, and an age above 0 only on a pool UTXO already in a block (§15, "Parked spends"). A spend can
  claim only the time the pool UTXO has really stood. Every pool transaction makes a new pool
  UTXO, whose age starts at zero, so a burst of sells at one moment can claim one UTXO's age
  once, and a backdated claim only gives less room: unlike a claimed absolute clock, a relative
  lock can't be set back to replay idle windows. The time a spend doesn't claim is lost. `add`
  and `remove` settle the breaker with their claim before their own effect, exactly as a swap
  does (toward the reserve the UTXO stood at); a remove then takes the credit back and cuts the
  count, on the settled values (changed 2026-11-10).
- The **shortest claim** (added 2026-11-10, narrowed the same day after a review found a bot could
  keep it in force with dust): while more than half of the stored cap is in use (`window_out`
  above half of `max_out_bps` of the stored `window_ref`: `2 · window_out > cap` in integers),
  every public entry (`buy`, `sell`, `sell_all`, `add`, `remove`) claims at least
  `min_age = max(1, window_len ÷ 720)`, 50 DAA (5 s) at 36 000, and `tick` always does. So while it
  holds nobody can spend the pool more often than once per `min_age`, each spend refills at least
  `min_age`, and the count falls back to half a cap at the stated rate. The stored reference is
  at most the reserve, so it is never above the one a spend settles to, and the rule comes on no
  later than it would on settled values. At
  or below half, sells have at least half a cap of room and any spend may claim nothing, as before
  this change: no dust spend can bring the minimum back, and holding the count above half takes
  selling about the whole refill, a cap a window.
- **While paused the breaker stands still** (changed 2026-11-10, as it was before the clock
  change): `tick` is refused, and a `remove` claims exactly 0 and settles nothing, so it needs no
  minimum and the guardian's pause never holds providers in. `unpause` makes a new pool UTXO, so
  the clock starts again from there. A long pause therefore never hands sells a fresh cap: the
  count is where the pause found it.
- **A pool that was never opened takes no `tick`** (added 2026-11-11, round 11). Between its genesis and the
  admin's `init` every counter is zero, and a tick changed nothing but the pool's outpoint: anyone could move it
  every 50 DAA for a fee, so that the launch check no longer found the pool where the genesis put it and an `init`
  signed offline for that outpoint never landed. `tick` now requires `S > 0`. Until `init` only the admin (`init`,
  `unpause`, `set_keys`) and the guardian (`pause`, once) can spend the pool. An emptied pool (`S = 1000`) is an
  opened one and takes ticks: its count can still be above half of its cap. There anyone's tick or dust swap still
  moves the outpoint under an admin deposit signed offline; the way through is a pause, then the admin's `unpause`
  and deposit sent as a chain (deploy/RUNBOOK.md).
- **A paused pool takes no second pause** (added 2026-11-11): the holder of the guardian key could otherwise keep
  moving a paused pool's outpoint from under a withdrawal, or under the admin's `unpause` and `set_keys`, which are
  the remedy when that key is stolen.
- **The first deposit takes the admin's signature** (added 2026-11-10, the owner's decision after
  an outside review): `init`, and the first `add` into an emptied pool (only the 1000 unowned
  shares left), which also starts `window_ref` again at the new reserve, as `init` does. An open
  by anyone with dust left a reference so small that sells stayed shut for about a day, and with a
  reference under about 720 sompi a 50 DAA claim rounds both its rise and the refill to nothing, so
  a griefer spending every slot could keep it there for good. Left: a pool whose last provider
  leaves while someone else's dust position remains is not "emptied", so anyone may add to it and
  its reference stays the dust (`check_a_dust_position_keeps_an_emptied_pools_reference_small`:
  341 sompi under a window of 50 DAA claims); a claim of a window doubles it.
  `init`, `collect`, `pause`, `unpause` and `set_keys` claim none: the first comes before any
  window, the others take the admin's or the guardian's key. An absolute clock (`tx.daa` or a
  stored last-settled DAA score) is not an option: consensus proves only a lower bound of it, so a
  quiet stretch could be left unclaimed and cashed in slices, one cap per slice, in one burst (the
  reason BridgeMint dropped `last_daa`, rc.14). Rounding: the refill of a claim is
  `claim × cap ÷ window_len` rounded down, so with a cap under 720 sompi (a pool of under 7 200
  sompi of KAS at 10 %) a claim of `min_age` refills nothing, and a bot spending every 50 DAA
  could hold such a pool's count where it is; only longer claims refill it. No real pool is that
  small.

The wallet and the web app take the age from their node's view of the pool UTXO's DAA score,
as of 10 DAA (≈1 s) behind the node's virtual DAA so that the relative lock is met on nodes a
moment behind it, but never below the least claim: at the first DAA the lock allows they claim
exactly that (changed 2026-11-10). At or below half of the cap they claim none when the pool UTXO
is still only in the mempool; above it they build nothing until their node shows the pool UTXO
accepted and `min_age` old, and send at that DAA (a node refuses a transaction whose relative lock
is not met yet and does not keep it, so a wallet whose node is a moment behind sends again, for
up to 2 s), after verifying the pool again (a reorg may have moved the pool UTXO's acceptance DAA).
A withdrawal from a paused pool waits for nothing and claims 0. So a busy pool still advances the
reference and refills the allowance. Then the monitor pauses the pool with everything else
(§11): a dump costs the liquidity providers at most about one cap (10 % of the KAS side) and then
its refill rate, and they can still withdraw.

**Slots** (2026-11-10). Above half of the cap each pool UTXO can be spent once it is `min_age` old,
by whichever transaction the network takes first. Clients are ready at that same DAA as anyone, so
a bot has no head start among spends a block can take: which of those wins is the network's call
(a spend no block can take is another matter, see "Parked spends" below). A bot that always wins (better
connected to the miners, or replacing others' transactions) can take every slot and keep every
other pool transaction out while the count is above half: with dust for at most as long as the
count takes to fall to half (half a window from a full cap; 1.5 windows after a full-cap sell and
a withdrawal of half the pool, whose cut leaves the count at two of the smaller caps), since its
own spends refill at the full rate; for longer it must also sell about a cap a window, the whole
refill, besides a fee per
slot (720 an hour, about 42 KAS an hour for dust sells at the relay floor). In the tests a seller
who wins one race in two loses about one race per sell and is served in full; one who never wins
gets nothing while the bot holds the count up; one who wants more than the refill, against a bot
that also wastes the refill below half, gets about half a cap less than alone (0.40 of a cap in
two windows), and the refill. Replacement by fee (rusty-kaspa a41a333: `submitTransactionReplacement`
takes a double spend with a strictly higher feerate, and relayed transactions are taken under
`RbfPolicy::Allowed`, so a replacement spreads across the network like any transaction) is not
used by the clients: a bot can always bid higher, so it would make every slot an open-ended fee
auction the user must approve, and between honest users it only evicts each other; at 10 BPS a
transaction is in a block within about a second anyway.

**Parked spends** (2026-11-11, round 11). A Kaspa node admits a transaction that spends an output of
another mempool transaction without applying the input's relative lock: it gives the unconfirmed
output the DAA score `u64::MAX`, and the lock test then passes for any sequence. A block applies
the real score. (Read in rusty-kaspa v2.1.0, `mining/src/mempool/populate_entries_and_try_validate.rs`
and `check_sequence_lock`, and run on kaspad 2.1.0 by the outside review of 2026-11-12.) So a spend of the pool UTXO, whose entries are
anyone's, can be made that ordinary nodes keep for up to 24 hours and no block takes: a dust buy or
a `tick` paid with a coin whose sequence claims an age its unconfirmed parent does not have, or a
`tick` claiming an age on a pool UTXO that is itself unconfirmed. Nodes that keep it refuse every
other spend of the pool UTXO as a double spend, and a replacement must pay a higher feerate than a
transaction whose fee is never paid. Nodes that build block templates drop it when they first try
it. The same holds for the minter UTXO: a mint or a governance action is authorized by signatures
over a digest, not over the transaction, so a signed one fits into anyone's transaction until it
is in a block, and `execute_recovery` takes no signature. What such a spend does is keep real spends
of that UTXO out of the blocks reached through ordinary nodes. It takes nothing, with one exception
(run 20, RT-1; this said "nothing is taken" until then): a copy of a signed `set_value` that lowers
the minter's deposit pays the KAS it frees to whoever made the copy, at most the operators' own minter
deposit, never user money (§6, "A lowering `set_value`").
A relative lock is not the only way: a funding input whose own script reads its DAA score (a P2SH
script `OpTxInputIndex OpTxInputDaaScore OP_1NEGATE OP_NUMEQUAL`) passes while its parent is in the
mempool and in no block; so does an input whose parent no block can take, and one whose script reads
a chain block commitment near the end of its depth window (design review, 2026-11-12).

**The covenants refuse them** (rc.22). Every Pool and BridgeMint entry calls `require_settled_inputs`
(bridge_mint.ag; pool.ag imports it): the active input's sequence is exactly the age the entry
claims (0 when it claims none: `init`, `collect`, `pause`, `unpause`, `set_keys`, the minter's
`pause`; `recovery_delay` for `execute_recovery`), and an age above 0 is claimed only on a coin
already in a block (`OpTxInputDaaScore >= 0`: the node's mark for an unconfirmed output reads -1).
Every other input has sequence 0, is a coin already in a block or another output of the transaction
that made the active coin, and is a coin of one of the two families (the pool's, kUSDT's: their code
reads no DAA score, lock time or chain commitment) or a plain Schnorr P2PK coin (36 bytes:
`00 00 20 <key> ac`). At most `MAX_TX_INPUTS` (8) inputs. So a pool or minter spend that a node
accepts is one a block can take: its lock time only gets easier, every relative lock is judged the
same in the mempool and in a block, its scripts read nothing a block sees differently, and every
unconfirmed parent is an earlier spend of the same covenant that passed the same rule
(`bridge/kaspa/tests/acceptance_parity.rs`). The entries' arguments and what the signers sign are
unchanged; only the bytecode changed, with new covenant ids. It costs about 7.8 KB on every pool
transaction and 2.8 KB on a minter one, at most 8 inputs, funding only from plain Schnorr P2PK coins,
and kUSDT owned by a P2SH script or another covenant moves to a plain owner before it trades with the
pool (its authority input is neither). It rests on the node's mark for an unconfirmed output; a
node version that changes that mark is checked again before the node pin moves. What is left: a
reorg that drops a parent's block, fee races, and copies of a signed mint, which a block can now
take (they mint the same batch).

The checks below stay, as a second line and for deployments made before rc.22. Everything that
reads the mempool judges a spender of the pool or minter UTXO before using it (`minability`, `bridge/packages/kaspa/src/minable.ts`): each input must
have the lock-disable bit, or a lock of 0, or a parent accepted at DAA `d` with
`d + lock - 1 <` the virtual DAA; an unconfirmed parent proves no age, and must itself pass, up
its unconfirmed ancestors within a bound. A spender that fails is never built on and never waited
for: the monitor's pause, the coordinator's `pending` pool, the keeper, the wallet and the web
app. The services also stop building on a spender they have seen unaccepted for two minutes, since
a short lock passes the test again a few seconds after the template builders have dropped the
transaction; the keeper's tick does not replace such a spender (run 21, R21-OPS2-2: in a busy
network an honest sale waits that long), it goes out beside it plainly and loses to it where it is
held. Their own spend then goes out as a replacement paying above what the parked one names,
up to a bound each (pause and governance 6 400 sompi per gram, the keeper's `maxFeerate`; a mint
only up to twice the node's estimate at that nonce's first try, since round 13, and never by more
than the parked spend names: such a spend never pays the fee it names, and could otherwise set
every mint's fee), and through the extra nodes of the config key `kaspaSubmitRpcs`. The monitor shows a
parked spend as a warning, not an alarm (anyone can place one on the pool for a fee), and raises
`pause-unlanded` when its pauses reach a node and no block. What is left is in Known limits and in
the operators' runbook ("A parked state coin").

**What the check may read** (2026-11-11, round 12). The age `d` of an output is taken only from
what the checker knows itself: the UTXO it follows (the pool, the minter) as it saw it accepted or
as it reads it once at that UTXO's own address, and, in the wallet and the web app, the outputs
they found at addresses they asked about themselves, among them the confirmed pool the coordinator
names beside the newest one. A lock on any other output is not looked up and counts as not
minable: kaspad 2.1.0 answers about an output only by listing every coin at an address, and the
only address to be had for such an output is the one the judged transaction names. The check of
round 11 listed it, once per locked input, inside the coordinator's Kaspa loop: a pool spend with
a few hundred locked inputs of an address its sender had filled stopped mints and the confirming
of redemptions for as long as it was kept fresh. A check now makes at most 64 lookups by
transaction id, asks the age of at most 4 outputs, and judges the inputs that claim an age first;
a verdict of "minable" is kept for 5 seconds and one of "not minable" for as long as the
transaction is seen; the coordinator's look for pool spends runs beside its Kaspa loop, one at a
time, with a deadline of 8 seconds. No transaction this project builds locks an input other than
the pool's or the minter's own; another's that does is treated as parked while it waits.

**A mint and the other spends of the minter** (2026-11-11, round 12). A mint is submitted plainly,
to the coordinator's node and, from its first try, to the nodes of `kaspaSubmitRpcs`. When the
node refuses it as a double spend of a mempool transaction, the coordinator judges that
transaction and offers the mint as a replacement only of one no block can take, of its own
earlier transaction for the same nonces, or of a copy of the same mint (same chain and first
nonce, proved by the signers' quorum); behind any other spend a block can take (the guardian's
`pause`, a governance action) it gives way and keeps its feerate. Until round 12 it was offered as
a replacement of whatever held the minter UTXO, and doubled its feerate after any refusal, so an
honest mint could take the place of a pause for 30 to 90 seconds. While a mint waits to be
accepted the coordinator asks its node every 3 seconds what spends the minter UTXO, and tries
again at once when a parked copy took the mint's place. The monitor sends its next pause as soon
as the UTXO its last one was built on is seen spent by another transaction (in the blocks not yet
read, in the state read, or in its node's mempool), not only when its 30 seconds are up, and since
run 21 as soon as the pause itself is in no block fetched and its node, asked by its id, no longer
holds it (two replacements push a pool pause out of a node's mempool and leave the UTXO unspent).
Each pause also goes to the extra nodes of `kaspaSubmitRpcs` from its first try.

**The keeper** (added 2026-11-10, changed the same day). A spend may still claim less than the
UTXO's age: above half of the cap a griefer can let the pool UTXO age and then spend it claiming
only `min_age`, again and again, so the count stays up. A keeper (bridge/services/src/keeper, its
own key, no bridge key) follows the pool; once it has seen a public spend that, while more than
half of the cap was in use and the pool not paused, claimed less than its UTXO's age by more than
its slack (50 DAA, 5 s: a client loses about a second, or its clock's 10 DAA margin), it sends a
`tick` for an hour after the last such spend, 25 DAA (2.5 s) after each pool UTXO is `min_age` old
(so clients, who send at that DAA and take up to about 2.5 s to do it, come first), while more than
half of the cap is in use, the pool is not paused and no other spend of that UTXO is in its node's
mempool (asked once per round for the pool's address, and for the keeper's own transactions by
their ids: since round 14, R14-ST-1, a read of the pool's address that fails or is refused for its
length leaves the keeper not knowing for 30 s, and the tick then goes out plainly, which replaces
nothing; a spend the node names when it refuses one is judged by its id). A tick claims the UTXO's age
less the clients' 10 DAA margin (never under `min_age`), so nodes a moment behind take it; one that
is refused, dropped or lost is sent again once it is neither in the mempool nor accepted. A griefer
can then waste only what lands before the tick: a late spend no longer lands at all (in the tests,
a bot landing 950 DAA late keeps the refill at 5 % of the stated rate without a keeper, 84 % with
one, the keeper's own margin and delay included; 94 % with a seller about), and one under the slack,
never evidence, wastes at most the slack per slot (50 % of the stated rate with nobody else
spending, 76 % with a seller about). The delay is the trade-off: at 5 DAA an armed keeper took the
slot from any wallet more than about half a second from its submit; at 25 a griefer landing just
before the keeper wastes up to 25 DAA a slot (a refill of 50 in 75 at worst while it lasts). It
pays one coin per tick, free again as soon as that tick is neither in its node's mempool nor
accepted, and splits a coin into four on startup (it refuses to start with a coin setting whose
split no node would take, and a split refused later is a warning in its health). Since round 13
(R13-ST-1, R13-SURF-3) it reads no address in its rounds: its own coins are kept from the
accepted transactions (shared/coins.ts, as the coordinator's and the monitor's), the pool UTXO's
age is the DAA score of the chain block that accepted it (the score the node gives the output),
its follower has a cursor of its own and makes every second look of a batch before applying any
of it, and its health is 503 when a due tick has not gone out for a minute or its rounds have
failed that long. Since run 21 (D9-1) every wait it keeps in memory (a refused tick's retry, the
pause before the next tick against a parked spend, the fee budget's hour, its health's minute, its
saves, the pause after a failed read of the pool's address, its judge's timers) is timed on the
monotonic clock: a host clock set back an hour held the next tick, and its health's word on it, for
that hour. When it is armed until, and its last evidence and tick, stay on the wall clock. It does not tick at or below half of the cap: a tick of a pool whose breaker has
settled leaves the state, and so the address, as it was, so ticking is no way off an address
someone filled; a small buy is (deploy/RUNBOOK.md). Since run 21 (R21-OPS2-1) it sends no tick
that would leave the breaker as it is (`afterTick` leaves `windowOut`, `windowRef` and
`windowCredit` unchanged): a pool every provider has left keeps a cap of a few sompi, a tick
refills one sompi per hundreds of DAA it claims, and the keeper paid for a tick every 75 DAA that
changed nothing, for as long as anyone's late spend kept it armed; now it waits until its tick
would change something, and its health says `idle` once every tick due has changed nothing for a
minute. Nor does it tick a pool whose KAS reserve would allow a cap under `minCap` (0.1 KAS),
whatever its reference: a pool every provider has left, or dust, where nobody can trade, and where
a sell of 90 sompi and one late tick (0.15 KAS) had an armed keeper pay 45 ticks (2.5 KAS). A live
pool's ticks are its job and stay: anyone who sells half a cap and spends late buys about 280 ticks
(16 KAS at the floor), which `maxFeesPerHour` caps (Known limits). Its own ticks are no evidence (a transaction that spends one of its own coins is its own):
accepted late in a busy network, each one used to arm it again. A tick costs about 0.057 KAS at
the relay floor and 0.57 KAS at the keeper's fee ceiling (1 000 sompi a gram, ten times the
floor; measured in run 21, where these lines said 0.04 and 0.4): at most one per 75 DAA, 480 an
hour, 27 KAS (271 at the ceiling), only while the count is above half, and never more than
`maxFeesPerHour` (30 KAS) of fees in an hour, past which a due tick waits and its health is 503.
Without sells that lasts half a window of claimed time from a full cap, and 1.5 windows after a
full-cap sell and a withdrawal of half the pool: about 830 ticks, 47 KAS at the floor and 469 at
the ceiling (some 16 hours of the budget). None of this moves any KAS. Tested in the script engine
(bridge/kaspa/tests/pool.rs, tests/audit3_pool.rs, tests/pool_slots.rs, tests/adversarial.rs and
tests/review.rs, with randomized and exhaustive runs of every entry against the bounds, the slot
race of every bot strategy with and without a keeper, and the temporary-liquidity sequences of
row 41 run through main's covenant and this one in the engine: this one is never worse, both keep
the stated bound, and one claim reaches at most about 1.14 of the strict allowance on either), in
the keeper's unit tests, and end to
end (`npm run local:e2e`: 400 000 forged kUSDT get under 10 % of the pool's KAS; not run on this
change yet).

Rules:

- Every entry that moves kUSDT observes the kUSDT family exhaustively: only the reserve, and
  the one user state its shape allows, may move, and the reserve's successor is forced.
- A covenant-ID owner is satisfied by any input of its family, so the entries that don't
  observe kUSDT (`Position.transfer`, `set_keys`, `pause`, `unpause`, `tick`) refuse any kUSDT input.
- A swap input is at most 230 584 300 921 369 (so `amount × 10⁴` fits in 64 bits);
  reserves, shares and amounts are at most 2⁶¹ − 1.
- A swap spends the exact pool UTXO it was quoted on, so a competing swap makes it invalid,
  never worse. A front-runner can still make a wallet rebuild on a worse price, so wallets
  never take a worse price without asking: when the pool moved, they rebuild on its newest
  state (mempool included while at most half of the cap is in use; above it, the newest one
  accepted and `min_age` old) and go ahead on their own only if the new quote is at least the one
  the user confirmed; a worse one needs the user's approval again. The slippage minimum stays
  the hard floor.
- The admin can take only the accrued protocol fees, resume a paused pool and hand the keys
  over, and only its signature opens the pool or reopens an emptied one; it can't touch X, Y or
  any position. The guardian (the bridge's, §1) can only pause.
