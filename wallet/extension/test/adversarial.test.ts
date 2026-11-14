// Attacks on the wallet's money paths: what a site, a lying coordinator or a
// mistyped address can make the wallet burn or sign. Tests marked "// BUG:"
// fail on purpose: each proves a defect. The others are regression tests for
// what held up.

import { describe, expect, it } from 'vitest';
import { checkRedeemAmount, executeRedeem, planRedeem, recipientCheck, VAULT_READER } from '@/kusdt/redeem';
import { burnOwnerLocal, evmHex } from '@/kusdt/tokens';
import { checkBuilt } from '@/kusdt/build';
import { plainState, type TokenState } from '@/kusdt/owner';
import { p2shAddressOf, scriptOf, verifyPool, verifyTokenStates } from '@/kusdt/verify';
import { addCheck, POOL_WAIT, quoteRemove } from '@/kusdt/pool';
import { cleanAmount, parseRequest, senderOrigin } from '@/provider/protocol';
import { open, seal } from '@/keys/crypto';
import { isEvmAddressStrict, toChecksumAddress } from '@/keys/derive';
import { parseUnits } from '@/lib/format';
import type { NodeUtxo } from '@/kaspa/node';
import type { Ctx, PoolState } from '@/kusdt/types';
import { COVENANT, FakeNode, NET, POOL, core, devKey, fakeApi, fakeVault, kasCoin, recipientAnswer, signerFor, testCtx } from './helpers';

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;

const A = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
/** A with the case of one letter flipped: the shape of a typo the EIP-55 checksum exists to catch. */
const BAD_CHECKSUM = (() => {
  const c = toChecksumAddress(A);
  const i = c.search(/[a-fA-F]/);
  const flip = c[i] === c[i].toUpperCase() ? c[i].toLowerCase() : c[i].toUpperCase();
  return c.slice(0, i) + flip + c.slice(i + 1);
})();
const alice = devKey('adversarial-alice');

const chainEntry = (chain: 1 | 2, over: Record<string, unknown> = {}) => ({
  chain, name: chain === 1 ? 'ethereum-local' : 'bsc-local', paused: false, backing: 1_000_000_000, releaseAvailable: 300_000_000,
  fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: chain === 1 ? 5_000_000 : 500_000, minDeposit: 10_000_000, maxDeposit: 100_000_000_000, releaseCapacity: 400_000_000, releaseRefillPerSecond: 2893518 },
  ...over,
});
const status = (one: Record<string, unknown> = {}, two: Record<string, unknown> = {}) => ({ chains: [chainEntry(1, one), chainEntry(2, two)] });

function tokenUtxo(ctx: Ctx, txid: string, state: TokenState): NodeUtxo {
  const spk = scriptOf(ctx, 'KCC20', state);
  return { address: p2shAddressOf(spk, NET.prefix), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT };
}

/** A wallet with one 20 kUSDT state and 10 KAS, and a coordinator answering `statusNow`. */
function wallet(tag: string, statusNow: unknown = status(), amount = 20_000_000n) {
  const node = new FakeNode();
  const state = plainState({ ownerScheme: 0, owner: alice.xonly }, amount);
  const tx = (n: number) => `${tag}${n}`.padEnd(64, '0');
  const api = fakeApi({ status: async () => statusNow, tokens: async () => ({ states: [{ utxo: { transactionId: tx(1), index: 0 }, state: { ...state, amount: Number(state.amount) } }] }) });
  const ctx = testCtx(node, api);
  node.utxoSet.push(tokenUtxo(ctx, tx(1), state), kasCoin(alice, tx(2), 1_000_000_000n));
  return { node, ctx, signer: signerFor(alice), kas: [alice.address] };
}

const POOL_STATE: PoolState = {
  tokenCovid: COVENANT, kasReserve: 200n * 100_000_000n, tokenReserve: 20_000_000n, totalShares: 200n * 100_000_000n, protocolKas: 0n, protocolTokens: 0n,
  baseValue: 100_000_000n, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 0n, windowOut: 0n, paused: false, guardian: '22'.repeat(32),
};

describe('recipients and amounts the wallet burns to', () => {
  it('precondition: the typo fails EIP-55', () => {
    expect(isEvmAddressStrict(BAD_CHECKSUM)).toBe(false);
    expect(BAD_CHECKSUM.toLowerCase()).toBe(A.toLowerCase());
  });

  // BUG: window.kusdt takes a mixed-case EVM address whose EIP-55 checksum is wrong; the wallet's own Bridge screen refuses it (isEvmAddressStrict), the provider path does not.
  it('kusdt_redeem refuses a bad-checksum address', () => {
    const req = parseRequest({ id: 'adversarial-1', method: 'kusdt_redeem', params: { chain: 'ethereum', address: BAD_CHECKSUM, amount: '10000000' } });
    expect(req).toBeNull();
  });

  // BUG: planRedeem (the Approve window's only gate) builds an irreversible burn to it: recipientCheck, /recipients and burnOwner all accept it.
  it('planRedeem refuses a bad-checksum address', async () => {
    const w = wallet('b1');
    await expect(planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: BAD_CHECKSUM, amount: 20_000_000n })).rejects.toThrow();
  });

  // BUG: the fee and the "above the fee" check come only from the coordinator's /status. A lying coordinator (minReleaseFee 0) makes a burn at or below the vault's real 5 USDT fee look payable: it is then unpayable and lost for good (SPEC §1, §9). vaultReleaseFee() exists for this cross-check and is never called.
  it('planRedeem does not trust a lying /status about the release fee', async () => {
    const lying = status({ fees: { ...chainEntry(1).fees, minReleaseFee: 0, feeBps: 0 } });
    const w = wallet('b2', lying, 4_000_000n);
    const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 4_000_000n }).catch(() => null);
    // The real vault's fee on 4 USDT is 5 USDT, so this burn pays nothing. Either refused, or a fee no lower than the vault's.
    expect(plan === null || plan.releaseFee >= 5_000_000n).toBe(true);
  });

  // Was a BUG proof under the old vault, which drew units - fee. The vault now draws the gross units (SPEC §7, approved by the owner), so
  // comparing the amount with releaseAvailable is right, and the wallet must refuse exactly one unit above it: the vault would revert.
  it('checkRedeemAmount lets a burn of exactly releaseAvailable through, and refuses one unit more (SPEC §7, §9)', () => {
    const available = 100_000_000n;
    const check = (units: bigint) => checkRedeemAmount(status({}, { releaseAvailable: Number(available) }), 'bsc', units);
    expect(check(available).problem).toBeNull();
    expect(check(available + 1n).problem).toMatch(/can pay at most/);
  });

  it('planRedeem takes the fee and the capacity from the vault, whatever /status says', async () => {
    const honest = wallet('b3');
    expect((await planRedeem(honest.ctx, honest.signer, honest.kas, { chain: 'ethereum', address: A, amount: 20_000_000n })).releaseFee).toBe(5_000_000n);

    const over = wallet('b4', status({ fees: { ...chainEntry(1).fees, releaseCapacity: 1_000_000_000_000_000 } }), 20_000_000n);
    const before = fakeVault.releaseCapacity;
    fakeVault.releaseCapacity = 10_000_000n;
    try { await expect(planRedeem(over.ctx, over.signer, over.kas, { chain: 'ethereum', address: A, amount: 20_000_000n })).rejects.toThrow(/release capacity/); }
    finally { fakeVault.releaseCapacity = before; }

    // No answer from the vault is a no.
    const reader = VAULT_READER.rpc;
    VAULT_READER.rpc = () => ({ ethCall: async () => { throw new Error('rpc down'); } });
    const down = wallet('b5');
    try { await expect(planRedeem(down.ctx, down.signer, down.kas, { chain: 'ethereum', address: A, amount: 20_000_000n })).rejects.toThrow(/Couldn't read the release fee/); }
    finally { VAULT_READER.rpc = reader; }
    expect(down.node.submitted).toHaveLength(0);
  });

  it('commits the burn to the exact chain and address, with the deployment burn value (no chain mix-up)', async () => {
    for (const [chain, code] of [['ethereum', 1], ['bsc', 2]] as const) {
      const w = wallet(chain === 'ethereum' ? 'c1' : 'c2');
      const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain, address: A, amount: 20_000_000n });
      const out = plan.built!.outputs[0];
      expect(out.token.ownerScheme).toBe(3);
      expect(out.token.owner).toBe(burnOwnerLocal(code, evmHex(A)));
      expect(out.value).toBe(30_000_000n);
    }
    expect(burnOwnerLocal(1, evmHex(A))).not.toBe(burnOwnerLocal(2, evmHex(A)));
  });

  it("refuses the zero address and the pinned vault's own without asking, even when the coordinator says payable", async () => {
    const api = fakeApi({ recipient: async (chain, address) => recipientAnswer(chain, address, { payable: true, blocked: false }) });
    const ctx = testCtx(new FakeNode(), api);
    expect((await recipientCheck(ctx, 'ethereum', '0x' + '00'.repeat(20))).payable).toBe(false);
    expect((await recipientCheck(ctx, 'bsc', ctx.config.chains.bsc.vault)).payable).toBe(false);
  });

  it('refuses a burn at the fee, above the backing, or to a paused vault', () => {
    expect(checkRedeemAmount(status(), 'ethereum', 5_000_000n).problem).toMatch(/release fee/);
    expect(checkRedeemAmount(status({ backing: 1_000_000 }), 'ethereum', 6_000_000n).problem).toMatch(/backing/);
    expect(checkRedeemAmount(status({ paused: true }), 'ethereum', 6_000_000n).problem).toMatch(/paused/);
  });

  it('checks what comes back from the core: an output paying a stranger is dropped, nothing submitted', async () => {
    const w = wallet('c3');
    const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 20_000_000n });
    const stranger = `000020${'ab'.repeat(32)}ac`;
    const built = { ...plan.built!, outputs: plan.built!.outputs.map((o, i) => (i === 1 ? { ...o, scriptPublicKey: stranger } : o)) };
    if (built.outputs.length < 2) built.outputs.push({ index: 1, kind: 'change', value: 1n, scriptPublicKey: stranger });
    expect(() => checkBuilt(w.ctx, built, w.signer, { tokens: [{ index: 0, state: plainState(plan.to, 20_000_000n), value: plan.tokenValue }] })).toThrow(/address it should not/);
    expect(w.node.submitted).toHaveLength(0);
  });

  it('asks about the recipient again at execute: a recipient blocked since the plan is refused, nothing is burnt', async () => {
    const w = wallet('c4');
    const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: A, amount: 20_000_000n });
    (w.ctx.api as any).recipient = async (chain: 'ethereum' | 'bsc', address: string) => recipientAnswer(chain, address, { blocked: true, payable: false });
    await expect(executeRedeem(w.ctx, w.signer, w.kas, plan)).rejects.toThrow(/blocks this address/);
    expect(w.node.submitted).toHaveLength(0);
  });
});

describe('what the coordinator cannot forge', () => {
  it('a token state that is not on the node is dropped', async () => {
    const ctx = testCtx(new FakeNode());
    const forged = plainState({ ownerScheme: 0, owner: alice.xonly }, 1_000_000_000_000n);
    const r = await verifyTokenStates(ctx, [{ utxo: { transactionId: 'ee'.repeat(32), index: 0 }, state: { ...forged, amount: forged.amount.toString() } }], alice.xonly);
    expect(r.verified).toHaveLength(0);
    expect(r.rejected).toBe(1);
  });

  it('a pool of another token, or under another covenant ID on the node, is refused', async () => {
    const node = new FakeNode();
    const ctx = testCtx(node);
    const reserve = plainState({ ownerScheme: 4, owner: POOL }, POOL_STATE.tokenReserve);
    await expect(verifyPool(ctx, { pool: { utxo: { transactionId: 'aa'.repeat(32), index: 0 }, state: { ...POOL_STATE, tokenCovid: 'cc'.repeat(32) } }, reserve: { utxo: { transactionId: 'aa'.repeat(32), index: 1 }, state: reserve } })).rejects.toThrow(/another token/);
    // On the node, but under a covenant ID the wallet doesn't pin.
    const spk = scriptOf(ctx, 'Pool', POOL_STATE);
    node.utxoSet.push({ address: p2shAddressOf(spk, NET.prefix), transactionId: 'aa'.repeat(32), index: 0, amount: POOL_STATE.baseValue + POOL_STATE.kasReserve, scriptPublicKey: spk, blockDaaScore: 1n, isCoinbase: false, covenantId: 'dd'.repeat(32) });
    const rs = scriptOf(ctx, 'KCC20', reserve);
    node.utxoSet.push({ address: p2shAddressOf(rs, NET.prefix), transactionId: 'aa'.repeat(32), index: 1, amount: 150_000_000n, scriptPublicKey: rs, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT });
    await expect(verifyPool(ctx, { pool: { utxo: { transactionId: 'aa'.repeat(32), index: 0 }, state: POOL_STATE }, reserve: { utxo: { transactionId: 'aa'.repeat(32), index: 1 }, state: reserve } })).rejects.toThrow(/could not be found/);
  });
});

describe('the site side of window.kusdt', () => {
  it('has no method to read keys or sign raw data, and anything malformed is refused, never repaired', () => {
    for (const method of ['eth_sign', 'personal_sign', 'kusdt_signMessage', 'kaspa_getPrivateKey', 'kusdt_exportMnemonic']) {
      expect(parseRequest({ id: 'adversarial-2', method, params: {} })).toBeNull();
    }
    expect(parseRequest({ id: 'bad id!', method: 'kusdt_getBalances' })).toBeNull();
    expect(parseRequest({ id: 'adversarial-3', method: 'kusdt_swap', params: { side: 'buy', amountIn: '0', minOut: '1' } })).toBeNull();
    expect(parseRequest({ id: 'adversarial-4', method: 'kusdt_send', params: { to: 'kaspa:bad', amount: '1' } })).toBeNull();
    expect(cleanAmount(1.5)).toBeNull();
    expect(cleanAmount('1e6')).toBeNull();
    expect(cleanAmount('-1')).toBeNull();
    expect(cleanAmount(`${10n ** 18n + 1n}`)).toBeNull();
  });

  it('only a top-frame https page of the wallet\'s own content script counts as a sender', () => {
    expect(senderOrigin({ id: 'ext', tab: {}, frameId: 0, origin: 'https://site.example' }, 'ext')).toBe('https://site.example');
    expect(senderOrigin({ id: 'other', tab: {}, frameId: 0, origin: 'https://site.example' }, 'ext')).toBeNull();
    expect(senderOrigin({ id: 'ext', tab: {}, frameId: 3, origin: 'https://site.example' }, 'ext')).toBeNull();
    expect(senderOrigin({ id: 'ext', origin: 'https://site.example' }, 'ext')).toBeNull();
    expect(senderOrigin({ id: 'ext', tab: {}, frameId: 0, origin: 'http://site.example' }, 'ext')).toBeNull();
  });

  // BUG: a connected site can ask for add liquidity at any ratio. The wallet's addCheck takes it; the Approve window shows the raw amounts and a share count, so most of the user's deposit is donated to existing LPs on one Approve click.
  it('addCheck refuses a deposit far off the pool ratio', () => {
    const kasIn = 100n * 100_000_000n;
    const tokensIn = 10_000n; // 0.01 kUSDT next to 100 KAS: at the pool's 10:1 price the KAS side alone is worth about 10 kUSDT
    const vp = { pool: { utxo: { transactionId: 'aa'.repeat(32), index: 0, amount: 0n, scriptPublicKey: '', blockDaaScore: 0n, isCoinbase: false, covenantId: POOL }, state: POOL_STATE }, reserve: { utxo: { transactionId: 'aa'.repeat(32), index: 1, amount: 0n, scriptPublicKey: '', blockDaaScore: 0n, isCoinbase: false, covenantId: COVENANT }, state: plainState({ ownerScheme: 4, owner: POOL }, POOL_STATE.tokenReserve) } };
    const r = (() => { try { return addCheck({ core }, vp, { kasIn, tokensIn, minShares: 1n, quoted: 1n }); } catch { return null; } })();
    if (r) {
      // If it isn't refused, the shares must at least be worth about what went in.
      const back = quoteRemove({ core }, { ...POOL_STATE, totalShares: POOL_STATE.totalShares + r.shares, kasReserve: POOL_STATE.kasReserve + kasIn, tokenReserve: POOL_STATE.tokenReserve + tokensIn }, r.shares);
      expect(back.kasOut).toBeGreaterThanOrEqual((kasIn * 9n) / 10n);
    }
  });
});

describe('numbers and the vault of the phrase', () => {
  it('parse exactly: no floats, no rounding, no sign or exponent, and too many decimals are refused', () => {
    expect(parseUnits('1.000001', 6)).toBe(1_000_001n);
    expect(parseUnits('1.0000001', 6)).toBeNull();
    expect(parseUnits('-1', 6)).toBeNull();
    expect(parseUnits('1e6', 6)).toBeNull();
    expect(parseUnits('999999999999999', 6)).toBe(999_999_999_999_999_000_000n);
  });

  it('the phrase is sealed: a wrong password gets nothing, and a damaged box opens to nothing', async () => {
    const box = await seal('secret words', 'a good password', 100_000);
    expect(await open(box, 'a good password')).toBe('secret words');
    expect(await open(box, 'wrong password')).toBeNull();
    const bytes = Buffer.from(box.ct, 'base64');
    bytes[0] ^= 1;
    expect(await open({ ...box, ct: bytes.toString('base64') }, 'a good password')).toBeNull();
  });
});
