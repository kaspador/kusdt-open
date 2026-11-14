// Round 11, R11-WW-5 and the open item before it: a holder whose only KAS is
// the KAS under their kUSDT state. Sending or redeeming a PART of the state
// needs a second token coin's KAS, which they don't have: the wallet answered
// "There is no KAS to pay for this transaction" and left them to work out the
// rest. Sending ALL of it failed too, at 1 KAS under the state and at 1.5 KAS
// alike, because the recipient's state was always given 1.5 KAS and the fee
// had nowhere to come from. Now: all of it is sent with the fee taken out of
// the KAS that travels with the tokens (said in the review), and a part is
// refused with the reason and the offer to send or redeem all of it instead.

import { beforeEach, describe, expect, it } from 'vitest';
import { FakeNode, COVENANT, devKey, fakeApi, testCtx, signerFor, kasCoin } from './helpers';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import { MIN_CARRIED, PartNeedsKas, executeSend, planSend } from '@/kusdt/tokens';
import { feeNeeded, InsufficientKas } from '@/kusdt/build';
import { burnOwner } from '@/kusdt/tokens';
import { plainState } from '@/kusdt/owner';
import { session } from '@/lib/storage';

const alice = devKey('r11-nokas-a'), bob = devKey('r11-nokas-b');
const KAS = 100_000_000n;
const EVM = '0x' + '5a'.repeat(20);
let n = 0;
const uniq = (c: string) => (++n).toString(16).padStart(64, c);

/** A wallet holding kUSDT states (units, the KAS under each) and nothing else, unless `coin` is given. */
function scene(states: [bigint, bigint][], coin?: bigint) {
  const node = new FakeNode();
  const listed: { utxo: { transactionId: string; index: number }; state: unknown }[] = [];
  const ctx = testCtx(node, fakeApi({ tokens: async () => ({ states: listed }) }));
  for (const [amount, kas] of states) {
    const state = plainState({ ownerScheme: 0, owner: alice.xonly }, amount), spk = scriptOf(ctx, 'KCC20', state), txid = uniq('e');
    node.utxoSet.push({ address: p2shAddressOf(spk, 'kaspasim'), transactionId: txid, index: 0, amount: kas, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
    listed.push({ utxo: { transactionId: txid, index: 0 }, state: { ...state, amount: amount.toString() } });
  }
  if (coin) node.utxoSet.push(kasCoin(alice, uniq('c'), coin));
  return { node, ctx };
}
const toBob = { ownerScheme: 0, owner: bob.xonly };
const UNITS = 25_000_000n;

beforeEach(async () => { await session.remove('kusdt.pending.simnet'); });

describe('sending all of a kUSDT state with no other KAS', () => {
  for (const held of [150_000_000n, 100_000_000n]) {
    it(`a state on ${Number(held) / 1e8} KAS: the fee comes out of the KAS that travels with the tokens, and the plan says so`, async () => {
      const s = scene([[UNITS, held]]);
      const plan = await planSend(s.ctx, signerFor(alice), [alice.address], { to: toBob, amount: UNITS });
      const built = plan.built!;
      expect(plan.feeFromTokenKas).toBe(true);
      // One output, the recipient's tokens, carrying everything the state held less the fee its size needs: nothing is lost to dust.
      expect(built.outputs).toHaveLength(1);
      expect(built.fee).toBe(feeNeeded(built, 100));
      expect(built.outputs[0].value).toBe(held - built.fee);
      expect(plan.tokenValue).toBe(held - built.fee);
      expect(plan.tokenValue).toBeGreaterThanOrEqual(MIN_CARRIED);
      expect(BigInt(built.outputs[0].token.amount)).toBe(UNITS);
      expect(built.outputs[0].token.owner).toBe(bob.xonly);
      const sent = await executeSend(s.ctx, signerFor(alice), [alice.address], plan);
      expect(sent.txid).toBe(built.txid);
      expect(s.node.submitted).toHaveLength(1);
    });
  }

  it('with KAS in the wallet the recipient gets the usual 1.5 KAS, as before', async () => {
    const s = scene([[UNITS, 150_000_000n]], 2n * KAS);
    const plan = await planSend(s.ctx, signerFor(alice), [alice.address], { to: toBob, amount: UNITS });
    expect(plan.feeFromTokenKas).toBeFalsy();
    expect(plan.tokenValue).toBe(150_000_000n);
    expect(plan.built!.outputs[0].value).toBe(150_000_000n);
  });

  it('a state with too little KAS under it to leave the recipient enough is still refused, with the reason', async () => {
    const s = scene([[UNITS, 40_000_000n]]);
    const e = await planSend(s.ctx, signerFor(alice), [alice.address], { to: toBob, amount: UNITS }).catch(x => x);
    expect(e).toBeInstanceOf(InsufficientKas);
    expect(e.message).toMatch(/would be left with/);
    expect(s.node.submitted).toHaveLength(0);
  });

  it('never carries more than the usual 1.5 KAS, and never touches a coin it does not need', async () => {
    // Two states: 3 KAS under them. All of both is sent; what is above 1.5 KAS and the fee comes back as KAS.
    const s = scene([[UNITS, 150_000_000n], [5_000_000n, 150_000_000n]]);
    const plan = await planSend(s.ctx, signerFor(alice), [alice.address], { to: toBob, amount: UNITS + 5_000_000n });
    expect(plan.feeFromTokenKas).toBeFalsy();
    expect(plan.built!.outputs[0].value).toBe(150_000_000n);
  });
});

describe('sending or redeeming a part of a kUSDT state with no other KAS', () => {
  it('a send of a part is refused before anything is signed for, says why, and names all of it as the way', async () => {
    const s = scene([[UNITS, 150_000_000n]]);
    const e = await planSend(s.ctx, signerFor(alice), [alice.address], { to: toBob, amount: 10_000_000n }).catch(x => x);
    expect(e).toBeInstanceOf(PartNeedsKas);
    expect(e).toBeInstanceOf(InsufficientKas);
    expect(e.all).toBe(UNITS);
    expect(e.redeem).toBe(false);
    // The second token coin's 1.5 KAS and a fee are missing: about that much is named.
    expect(e.short).toBeGreaterThanOrEqual(150_000_000n);
    expect(e.short).toBeLessThan(170_000_000n);
    expect(e.message).toMatch(/Sending a part of your kUSDT needs KAS this wallet does not have/);
    expect(e.message).toMatch(/send all 25 kUSDT instead/);
    expect(s.node.submitted).toHaveLength(0);
  });

  it('a redemption of a part likewise; redeeming all of it needs no other KAS', async () => {
    const s = scene([[UNITS, 100_000_000n]]);
    const owner = burnOwner(s.ctx, 1, EVM);
    const part = await planSend(s.ctx, signerFor(alice), [alice.address], { to: owner, amount: 10_000_000n, redeem: { chain: 1, address: EVM } }).catch(x => x);
    expect(part).toBeInstanceOf(PartNeedsKas);
    expect(part.redeem).toBe(true);
    expect(part.all).toBe(UNITS);
    expect(part.message).toMatch(/Redeeming a part of your kUSDT needs KAS this wallet does not have/);
    expect(part.message).toMatch(/redeem all 25 kUSDT instead/);
    const all = await planSend(s.ctx, signerFor(alice), [alice.address], { to: owner, amount: UNITS, redeem: { chain: 1, address: EVM } });
    // The burn carries the burn value; the rest of the state's KAS comes back, less the fee.
    expect(all.built!.outputs[0].value).toBe(BigInt(s.ctx.config.burnValue));
    expect(all.feeFromTokenKas).toBeFalsy();
  });

  it('with enough KAS in the wallet a part is sent as before', async () => {
    const s = scene([[UNITS, 150_000_000n]], 3n * KAS);
    const plan = await planSend(s.ctx, signerFor(alice), [alice.address], { to: toBob, amount: 10_000_000n });
    expect(plan.built!.outputs.slice(0, 2).map(o => o.value)).toEqual([150_000_000n, 150_000_000n]);
    expect(plan.keptInToken).toBe(150_000_000n);
  });
});
