// Run 21 round 2, R21-W2-3, after reviewer "wallet2"'s test of the same name: INV-8 on a site's pool requests. A sale
// of a part of a kUSDT state (kusdt_swap sell) and a deposit (kusdt_addLiquidity) leave a change token that carries the
// deployment's token value (1.5 KAS). When the state spent carries less (a send from a wallet with no KAS takes its fee
// out of the KAS under the tokens, down to 0.6 KAS), the build tops the change up from the wallet's coins (kusdt/pool.ts
// buildSell `tokenValue - payer.utxo.amount`, addLiquidity `... + tokenValue - provider.utxo.amount`). The window's
// rows said nothing of it: a sale shown as bringing 9.40 KAS brought 8.50, the rest in the user's own change token.
// Now the window shows the change token's KAS ("Kept in your token (change)"), and how much of it comes from the
// wallet's KAS, as the wallet's own Pool screen shows the change it keeps. Nothing was ever lost: it stays the user's.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, click, fakeWindow, mount, until } from './fake-dom';
import { fixture, noNetwork, resetStores } from './screen-fixture';
import { COVENANT, POOL } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { POOL_WAIT } from '@/kusdt/pool';
import { session } from '@/lib/storage';
import { REQUEST_KEY, type PendingRequest } from '@/provider/protocol';
import { Approve, ARM_MS } from '@/screens/Approve';
import type { PoolState } from '@/kusdt/types';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };

beforeEach(async () => {
  await resetStores(); vi.stubGlobal('fetch', noNetwork);
  vi.stubGlobal('chrome', { tabs: { sendMessage: (_t: number, _m: unknown, cb?: () => void) => cb?.() }, runtime: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** A wallet with one kUSDT state of `kusdt` (3 kUSDT) carrying `stateKas`, 110 KAS in coins, and the pool at `base`. */
function scene(tag: string, stateKas: bigint, kusdt = 3_000_000n) {
  let answer: any = null;
  const fx = fixture(tag, { tokens: [kusdt], api: { pool: async () => answer } });
  const state = fx.node.utxoSet.find(u => u.covenantId === COVENANT)!;
  state.amount = stateKas;
  const pspk = scriptOf(fx.ctx, 'Pool', base), reserve = reserveStateOf(POOL, base), rspk = scriptOf(fx.ctx, 'KCC20', reserve);
  const ptx = `${tag}f`.padEnd(64, '0');
  fx.node.utxoSet.push(
    { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: ptx, index: 0, amount: poolValue(base), scriptPublicKey: pspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: POOL },
    { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: ptx, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: COVENANT },
  );
  answer = { pool: { utxo: { transactionId: ptx, index: 0 }, state: base }, reserve: { utxo: { transactionId: ptx, index: 1 }, state: reserve } };
  const coin = fx.node.utxoSet.find(u => `${u.transactionId}:${u.index}` === fx.kasOutpoint)!;
  fx.node.utxoSet.push({ ...coin, transactionId: `${tag}a`.padEnd(64, '0'), amount: 100n * KAS });
  h.wallet = fx.wallet;
  return fx;
}

/** The request's window, armed: what it shows, and Approve. */
async function windowFor(id: string, params: PendingRequest['params']) {
  await session.set({ [REQUEST_KEY]: { id, method: params.method, params, origin: 'https://site.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest });
  fakeWindow.location.hash = `#request=${id}`;
  const { root } = await mount(createElement(Approve));
  await until('Approve', () => button(root, 'Approve'));
  await until('Approve to arm', () => !button(root, 'Approve').disabled, ARM_MS + 5_000).catch((e) => { throw new Error(`${e.message}. Shown: ${root.textContent}`); });
  return { root, shown: root.textContent as string };
}
const sell = (amountIn: string) => ({ method: 'kusdt_swap', side: 'sell', amountIn, minOut: String(20_000_000) }) as PendingRequest['params'];
const add = { method: 'kusdt_addLiquidity', kasIn: String(10n * KAS), tokensIn: '1000000' } as PendingRequest['params'];

describe('R21-W2-3: a site\'s sale or deposit shows the KAS its change token keeps, and the part from the wallet\'s KAS', () => {
  it('a sale of 1 of 3 kUSDT from a state carrying 0.6 KAS: 1.5 KAS kept in the change token, 0.9 KAS of it from the wallet\'s KAS', async () => {
    const fx = scene('d1', 60_000_000n);
    const { root, shown } = await windowFor('window-w2-sell-1', sell('1000000'));
    expect(shown).toContain('Kept in your token (change)1.5 KAS (0.9 KAS of it from your KAS)');
    await click(button(root, 'Approve'));
    await until('the sale', () => fx.node.submitted.length > 0, 20_000);
    // The change token the sale made carries what the window said.
    expect(BigInt(JSON.parse(fx.node.submitted[0]).outputs[2].value)).toBe(150_000_000n);
  }, 60_000);

  it('a deposit from a state carrying 0.6 KAS: the same, beside the KAS kept in the position', async () => {
    const fx = scene('d2', 60_000_000n);
    const { root, shown } = await windowFor('window-w2-add-1', add);
    expect(shown).toContain('Kept in the position2 KAS');
    expect(shown).toContain('Kept in your token (change)1.5 KAS (0.9 KAS of it from your KAS)');
    await click(button(root, 'Approve'));
    await until('the deposit', () => fx.node.submitted.length > 0, 20_000);
    expect(BigInt(JSON.parse(fx.node.submitted[0]).outputs[3].value)).toBe(150_000_000n);
  }, 60_000);

  it('a state carrying the full 1.5 KAS: the change keeps it, and nothing comes from the wallet\'s KAS for it', async () => {
    scene('d3', 150_000_000n);
    const { shown } = await windowFor('window-w2-sell-3', sell('1000000'));
    expect(shown).toContain('Kept in your token (change)1.5 KAS');
    expect(shown).not.toContain('of it from your KAS');
  });

  it('a sale of the whole state leaves no change token, and shows none', async () => {
    scene('d4', 60_000_000n, 1_000_000n);
    const { shown } = await windowFor('window-w2-sell-4', sell('1000000'));
    expect(shown).not.toContain('Kept in your token');
  });
});
