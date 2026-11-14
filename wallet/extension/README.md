# kUSDT Wallet (browser extension)

A Chrome (Manifest V3) wallet for Kaspa L1 with first-class **kUSDT**, the KCC-20 covenant
token that the kUSDT bridge issues 1:1 for USDT locked on Ethereum and BNB Chain. It does:

- **KAS**: balance, receive (address and QR), send.
- **kUSDT**: balance, send and receive. Up to 3 inputs and 3 outputs per transfer; when
  more states are needed, they are merged first.
- **Bridge in**: deposit USDT into the vault on Ethereum or BNB Chain from the wallet's own
  EVM account. The kUSDT is minted to the wallet's own Kaspa key. On Testnet and Local (never
  Mainnet), "Get 1,000 test USDT" mints the deployment's MockUSDT to that account.
- **Bridge out**: redeem kUSDT to an EVM address on either chain.
- **Pool**: swap KAS ⇄ kUSDT on the pool, add or remove liquidity, and open a pool that has no
  liquidity yet (its first deposit sets the price; 1000 shares stay locked for good).
- **Activity**: history, with the mint and release status read from the coordinator.
- **`window.kusdt`**: a provider for web pages (SPEC §14).

It is **not in any extension store yet**: load it unpacked (below). The protocol is in
[`../../SPEC.md`](../../SPEC.md).

## Build and load

```sh
npm install --legacy-peer-deps   # plain `npm install` may fail here with an "edgesOut" error
npm run build                    # tsc --noEmit + vite build → dist/
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick
`dist/`.

This is a standalone npm project. It uses `../../bridge/packages/core` (the WebAssembly
transaction builder) and `../../bridge/packages/kaspa` (Kaspa primitives) from source,
through path aliases (`aliases.ts`, `tsconfig.json`), so npm never touches those folders.

## Tests

| Command | What it runs |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (vitest) with the Node build of the real core. Covers: derivation vectors, owner conversions, burn owners and payloads, quotes and minimums, the stale-pool retry, state verification, the pre-burn checks (amounts, and recipients: blocked, refused, unanswered), the provider rules, the vault calls and settings |
| `npm run test:simnet` | Against a kaspad simnet at `ws://127.0.0.1:18610` (`docker start kusdt-simnet`). The test runs the devnet flow itself (genesis and mints), then the wallet's own code sends KAS, sends kUSDT (with a merge) and redeems |
| `npm run smoke` | After `npm run build`: loads `dist/` in Chromium (Playwright's, or `CHROMIUM=path`). Checks the popup, the core under the extension's CSP in the popup and in the service worker, `window.kusdt`, a site connect, balances, and a rejected request. Needs the simnet node |
| `npm run test:stack` | Against the live local stack (`npm run local:stack` in `bridge/devnet`; it is never started or stopped by this test). A fresh wallet funded by the dev faucet runs deposits on both chains, mints, a send, a redemption to chain 2 until it is `released`, swaps both ways, and liquidity in and out. Then an address chain 1's mock USDT blacklists (the faucet's `POST /blacklist`): refused before any burn, and a burn built past the checks held as `blocked` until it is taken off the list, then `released`. `KUSDT_E2E_OUT=file` keeps the txids and balances |

`test:simnet` and `test:stack` are skipped by a plain `npm test`. They are turned on by
`KUSDT_SIMNET=1` and `KUSDT_STACK=1`, which their npm scripts set.

## Configuration

**Built-in defaults**, one per network, are in [`src/config/defaults.ts`](src/config/defaults.ts):
- the Kaspa node (wRPC JSON);
- the coordinator API;
- the pinned deployment: kUSDT's covenant ID, the pool ID, and the vault and USDT
  addresses on each chain;
- the EVM RPC URLs;
- the KAS each new token state carries (1.5 KAS) and each new position carries (2 KAS).

**Networks**: testnet-10 (the default), mainnet and simnet. You can edit every value in
**Settings → Endpoints and deployment**; your edits are stored per network.

**Node**: an empty node URL on mainnet or testnet-10 means a node of the public Kaspa node
network (via its resolvers).

**Simnet, the local stack**: the defaults point at the stack's endpoints. Its covenant and
pool IDs change with every new stack, so Settings has a simnet-only button: **Fill the
deployment from the coordinator's /status**. Review the values, then save. On real networks
you pin the deployment yourself; the wallet never takes it from the coordinator.

## Security model

- **The recovery phrase** (24 words, BIP-39) is sealed with your password:
  PBKDF2-HMAC-SHA256 with 600 000 iterations, then AES-256-GCM, kept in
  `chrome.storage.local`.
  - The password is sealed in Unicode's NFKC form (since run 21), so it opens the wallet however
    its accents were typed; a wallet sealed before opens with the password as it was typed then.
  - A browser holds one wallet: creating or importing another is refused until it is removed
    (Settings), as its recovery phrase is its only backup.
  - While the wallet is unlocked, the phrase sits in `chrome.storage.session`: memory only,
    never readable by content scripts.
  - Auto-lock and Lock clear it, and end what the unlock handed out (since run 21): an action
    already under way, such as a burn waiting for its merge or a send confirmed on its Review,
    stops before its next signature, and unlocking again does not restart it.
  - Keys are derived when needed (Kaspa `m/44'/111111'/0'`, EVM `m/44'/60'/0'/0/0`) and
    never stored.
- **No key export.** The phrase is shown only while creating the wallet: the same words until the wallet exists, then never again, and the window it was created in keeps no copy of them from then on (since run 21). No screen shows
  a key or the phrase again.
- **Nothing the coordinator says is trusted.**
  - Before a token state is shown or spent, its locking script is recomputed with the core
    (`script`). That exact outpoint must be on the Kaspa node, at the script's P2SH address,
    with the pinned covenant ID.
  - The pool, its reserve and every liquidity position are checked the same way.
  - A state that fails is not counted, and the wallet says so.
- **Every transaction is built by the WebAssembly core** and checked again before it is
  submitted:
  - each token output is the approved state, with its script recomputed;
  - each plain output pays the wallet's own address;
  - the fee is at most **3 KAS**.

  KAS sends use the checked planner from `packages/kaspa`. EVM transactions are signed only
  for the configured chain IDs, after the RPC is asked for its chain ID.
- **Swaps and liquidity** never go below the minimum you set. On a stale pool the wallet
  quotes again on the newest verified state, at most 3 times in all, and goes ahead on its own
  only for at least the quote you approved: for less it sends nothing and asks you again.
  A paused pool takes no swaps or new liquidity (removing stays open), and a sell above the
  circuit breaker's room is refused before anything is built, with the largest sell that fits.
- **Before any burn** (SPEC §9), the wallet refuses an amount that:
  - is at or below the release fee;
  - is above the named vault's release capacity;
  - is above what that vault can pay right now;
  - is above its backing (all from `GET /status`).

  It also refuses a recipient the vault wouldn't pay. It asks the coordinator
  (`GET /recipients/:chain/:address`) and burns only when the answer, about exactly that
  chain and address, says `payable`. So no burn goes to:
  - an address the token blocks (Ethereum USDT's `isBlackListed`), where a payout would be
    frozen;
  - the zero address or the vault's own (refused without asking);
  - any address while the coordinator can't answer (a network error, a 503, a 404 from an
    older coordinator): "couldn't check the recipient, try again".

  The planner asks again, whatever the screen showed, and again right before the burn is
  sent. It names the other chain when that one can pay, but only to an address both vaults
  would pay: a blocked address is refused, never steered to another chain. A redemption
  can't be undone, and the wallet says so.
- **Held payouts**: Activity shows a redemption the coordinator holds (`blocked`) as held,
  because USDT blocks its address, and says it is paid automatically if the address is
  unblocked. A refund of a deposit Kaspa skipped is shown the same way.
- **`window.kusdt`** is offered to HTTPS pages and localhost.
  - Each site is approved once per network in the wallet's own window.
  - Every signing request (`kusdt_send`, `kusdt_redeem`, `kusdt_swap`,
    `kusdt_addLiquidity`, `kusdt_removeLiquidity`) opens that window and shows what the
    wallet built.
  - `kaspa_switchNetwork` asks the user too ("Switch network", both networks named); the site
    stays connected on the new network. The wallet's own network answers at once; a preset with
    nothing deployed is refused (4200).
  - Pages never see a key, and they can't ask for a raw signature.
  - Three declines in two minutes make a site wait a minute, and its tab too, so a page that
    moves to a new subdomain after each decline waits all the same; other tabs are not held.
- **No analytics, no remote code.** The CSP allows `'wasm-unsafe-eval'` only, so the
  extension can compile its own core.

## Known limits

- Not published to any store yet.
- Testnet-10 and mainnet deployment values (covenant ID, pool ID, vaults) are empty until
  those deployments exist. kUSDT is shown as "not configured" there.
- Positions come from the coordinator's `GET /positions`, falling back to the ones this
  wallet recorded when it added them. A position made elsewhere shows only once the
  coordinator lists it.
- One Kaspa account. kUSDT is always owned by the first key. KAS is also found on the first
  20 receive and change addresses of that account.
