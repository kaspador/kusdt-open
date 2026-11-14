// Round 21, R21-POOL-1: the pool's kUSDT reserve proven from the body of the transaction that made it, checked against
// its id, so that no client lists the reserve's address (anyone can fill it, and trade the reserve back to it).
//
// First the id (@kusdt/kaspa txid.ts, a port of rusty-kaspa consensus/core/src/hashing/tx.rs at a41a333): that file's
// own test vectors, versions 0 and 1, and the id of every kind of transaction the core builds (version 1, covenant
// bindings and all), against the core's. Then which bodies reserveMadeBy takes as proof, and which it does not.

import { describe, expect, it } from 'vitest';
import { core } from '@kusdt/core';
import { bytesToHex, idBodyOf, idFieldsOf, transactionIdOf } from '@kusdt/kaspa';
import { reserveMadeBy, reserveOf, type PoolState } from './index';
import { KAS, POSITION_VALUE, TOKEN_VALUE, offlineChain, secret, xonly } from './testing/chain';

const scriptOf = (actor: string, state: unknown) => core.call('script', { actor, state }).value.scriptPublicKey as string;
const idOf = (body: unknown) => transactionIdOf(idBodyOf(body)!);
const poolOf = (j: any): PoolState => ({
  tokenCovid: j.tokenCovid, kasReserve: BigInt(j.kasReserve), tokenReserve: BigInt(j.tokenReserve), totalShares: BigInt(j.totalShares),
  protocolKas: BigInt(j.protocolKas), protocolTokens: BigInt(j.protocolTokens), baseValue: BigInt(j.baseValue), admin: j.admin,
  maxOutBps: BigInt(j.maxOutBps), windowLen: BigInt(j.windowLen), windowCredit: BigInt(j.windowCredit), windowRef: BigInt(j.windowRef),
  windowOut: BigInt(j.windowOut), paused: Boolean(j.paused), guardian: j.guardian,
});

describe('the id of a transaction body', () => {
  // rusty-kaspa consensus/core/src/hashing/tx.rs, test_transaction_hashing, at a41a333 (the revision the core pins).
  const ZERO = '00'.repeat(32), H = '59b3d6dc6cdc660c389c3fdb5704c48c598d279cdf1bab54182db586a4c95dd5';
  const NATIVE = '00'.repeat(20), COINBASE = '01' + '00'.repeat(19), REGISTRY = '02' + '00'.repeat(19);
  const input = (txid: string) => ({ previousOutpoint: { transactionId: txid, index: 2 }, signatureScript: '0102', sequence: 7, sigOpCount: 5 });
  const output = { value: 1564, scriptPublicKey: '0007' + '0102030405' };
  const tx = (version: number, inputs: unknown[], outputs: unknown[], lockTime: number, subnetworkId: string, gas: number, payload: string) => ({ version, inputs, outputs, lockTime, subnetworkId, gas, payload });
  const vectors: [string, unknown, string][] = [
    ['#1', tx(0, [], [], 0, NATIVE, 0, ''), '2c18d5e59ca8fc4c23d9560da3bf738a8f40935c11c162017fbf2c907b7e665c'],
    ['#2', tx(0, [input(ZERO)], [], 0, NATIVE, 0, ''), 'b2d65ae36e123eb73f253176d7234a57656b84d0d60b9fc746ab0d0f085c9cc7'],
    ['#3', tx(0, [input(ZERO)], [output], 0, NATIVE, 0, ''), '67289b12146d1b5ef384332137399791a5cfe89506ff31688b0d95ae821d0a0c'],
    ['#4', tx(0, [input(ZERO)], [output], 54, NATIVE, 3, ''), '7cd34b788d7d230970d4bfd955c34c5abc49e3bcdd5adb03a77bb71d05554401'],
    ['#5', tx(0, [input(H)], [output], 54, NATIVE, 3, ''), 'c9dd78e818445f617a28348d6db752142e2fab440effa58140ad2773e638b628'],
    ['#6', tx(0, [], [output], 54, COINBASE, 3, ''), '2578783ec93c3a02414a228e10b1b5af298623254775f972f97df08d4ec28c8f'],
    ['#7', tx(0, [input(H)], [output], 54, REGISTRY, 3, ''), '3f6cea6d7ac8f6b2f86209fa748ea0ef5a1d5d380d43b79e77d52e770bb9a7b9'],
    ['#8', tx(0, [input(H)], [output], 54, REGISTRY, 3, '010203'), '4acda997dfb31c6518224c9ac00d0777fc7cbecdab461be3c0816b1cba19a056'],
    ['#10', tx(1, [input(H)], [output], 54, REGISTRY, 3, '010203'), 'a08a500b21be3e692c080b14e399fcfa2cfa01b25c08f2f8e7414d1c116e8d18'],
    // A compute budget is not in the id (#11, #12), nor a signature operation count (#13, #14).
    ['#11', tx(1, [{ previousOutpoint: { transactionId: ZERO, index: 0 }, signatureScript: '', sequence: 0, computeBudget: 111 }], [], 0, NATIVE, 0, ''), '5978e7aa1a9ba8fdf12dae6aa39aa198a91985e91192b291e207d4d6246349e6'],
    ['#12', tx(1, [{ previousOutpoint: { transactionId: ZERO, index: 0 }, signatureScript: '', sequence: 0, computeBudget: 222 }], [], 0, NATIVE, 0, ''), '5978e7aa1a9ba8fdf12dae6aa39aa198a91985e91192b291e207d4d6246349e6'],
    ['#13', tx(1, [{ previousOutpoint: { transactionId: ZERO, index: 0 }, signatureScript: '', sequence: 0, sigOpCount: 111 }], [], 0, NATIVE, 0, ''), '5978e7aa1a9ba8fdf12dae6aa39aa198a91985e91192b291e207d4d6246349e6'],
  ];
  it.each(vectors)('is rusty-kaspa\'s for its test %s', (_name, body, id) => {
    expect(idOf(body)).toBe(id);
  });

  it('is the core\'s for every kind of transaction it builds: version 1, covenant bindings included, as the core and as a node spell them', () => {
    const c = offlineChain('reserve-made/ids');
    const alice = secret('reserve-made/ids/alice');
    const minted = c.mint([alice, alice], [60_000_000n, 30_000_000n]);
    const pool0 = c.at(c.poolGenesis, 0, 'pool', c.poolId);
    const init = core.call('pool-init', {
      ...c.common(), adminSecretKey: bytesToHex(c.admin), pool: pool0, provider: c.owned(c.at(minted, 1, 'token'), alice), kasIn: 1_000n * KAS, tokensIn: 50_000_000n,
      positionOwner: xonly(alice), tokenValue: TOKEN_VALUE, positionValue: POSITION_VALUE,
    }).value;
    const pool1 = c.at(init, 0, 'pool', c.poolId), reserve1 = c.at(init, init.outputs.findIndex((o: any) => o.kind === 'reserve'), 'token');
    const tokensOut = BigInt(core.call('quote', { kind: 'buy', pool: pool1.state, kasIn: 10n * KAS }).value.tokensOut);
    const buy = core.call('pool-buy', { ...c.common(), pool: pool1, reserve: reserve1, kasIn: 10n * KAS, tokensOut, buyer: xonly(alice), tokenValue: TOKEN_VALUE }).value;
    const pause = core.call('pool-pause', { ...c.common(), pool: c.at(buy, 0, 'pool', c.poolId), secretKey: bytesToHex(c.guardian) }).value;
    const built = [c.genesis, minted, c.poolGenesis, init, buy, pause];
    for (const b of built) {
      expect(b.transaction.version).toBe(1);
      expect(idOf(b.transaction)).toBe(b.txid);
      // What a server hands out (no signature scripts), and a node's spelling of the same: scripts as {version, script}, integers as text.
      expect(idOf(idFieldsOf(b.transaction))).toBe(b.txid);
      const asNode = { ...b.transaction, lockTime: String(b.transaction.lockTime), gas: String(b.transaction.gas),
        inputs: b.transaction.inputs.map((i: any) => ({ ...i, sequence: String(i.sequence) })),
        outputs: b.transaction.outputs.map((o: any) => ({ ...o, value: String(o.value), scriptPublicKey: { version: parseInt(o.scriptPublicKey.slice(0, 4), 16), scriptPublicKey: o.scriptPublicKey.slice(4) } })) };
      expect(idOf(asNode)).toBe(b.txid);
    }
    // Each part the id commits to changes it: a value, a script, a binding, its authorizing input, a sequence.
    const t = idFieldsOf(buy.transaction);
    const v0 = { ...buy.transaction, version: 0 };
    const edits = [
      { ...t, outputs: t.outputs.map((o: any, i: number) => (i === 1 ? { ...o, value: String(BigInt(o.value) + 1n) } : o)) },
      { ...t, outputs: t.outputs.map((o: any, i: number) => (i === 1 ? { ...o, scriptPublicKey: o.scriptPublicKey.replace(/.$/, '6') } : o)) },
      { ...t, outputs: t.outputs.map((o: any, i: number) => (i === 1 ? { ...o, covenant: null } : o)) },
      { ...t, outputs: t.outputs.map((o: any, i: number) => (i === 1 ? { ...o, covenant: { ...o.covenant, authorizingInput: 2 } } : o)) },
      { ...t, inputs: t.inputs.map((x: any, i: number) => (i === 0 ? { ...x, sequence: 1 } : x)) },
      v0,
    ];
    for (const e of edits) expect(idOf(e)).not.toBe(buy.txid);
    // A version 0 id leaves the bindings out (R21-IDENT-3): with and without one it is the same.
    expect(idOf({ ...v0, outputs: v0.outputs.map((o: any) => ({ ...o, covenant: null })) })).toBe(idOf(v0));
  });

  it('of a version 1 body, commits to the payload by its digest alone: a body handed out carries the digest, whatever the payload', () => {
    // rusty-kaspa's #10, a version 1 transaction with a payload, as handed out: the digest in the payload's place.
    const [, body10, id10] = vectors.find(([name]) => name === '#10')!;
    const served = idFieldsOf(body10);
    expect('payload' in served).toBe(false);
    expect(served).toHaveProperty('payloadDigest');
    expect(idOf(served)).toBe(id10);
    // A trader's 120 000-byte payload on a real pool transaction: the body handed out stays the size of one without it.
    const c = offlineChain('reserve-made/payload');
    const alice = secret('reserve-made/payload/alice');
    const minted = c.mint([alice], [60_000_000n]);
    const big = { ...minted.transaction, payload: 'ab'.repeat(120_000) };
    const handed = idFieldsOf(big);
    expect(JSON.stringify(handed).length).toBeLessThan(JSON.stringify(idFieldsOf(minted.transaction)).length + 100);
    expect(idOf(handed)).toBe(idOf(big));
    expect(idOf(handed)).not.toBe(minted.txid);
    // A version 0 body is hashed with its payload: a digest alone is no version 0 body; nor is a digest of another length.
    expect(idBodyOf({ ...idFieldsOf(body10), version: 0 })).toBeNull();
    expect(idBodyOf({ ...served, payloadDigest: 'ab' })).toBeNull();
  });

  it('reads nothing that is not a body', () => {
    for (const v of [null, 'tx', 7, {}, { inputs: [], outputs: [] }, { version: 1, inputs: 'x', outputs: [], lockTime: 0, subnetworkId: '00'.repeat(20), gas: 0, payload: '' }]) expect(idBodyOf(v)).toBeNull();
    const ok = { version: 1, inputs: [], outputs: [], lockTime: 0, subnetworkId: '00'.repeat(20), gas: 0, payload: '' };
    expect(idBodyOf(ok)).not.toBeNull();
    expect(idBodyOf({ ...ok, subnetworkId: '00' })).toBeNull();
    expect(idBodyOf({ ...ok, payload: 'xyz' })).toBeNull();
    expect(idBodyOf({ ...ok, gas: -1 })).toBeNull();
    expect(idBodyOf({ ...ok, lockTime: '18446744073709551616' })).toBeNull();
    expect(idBodyOf({ ...ok, outputs: [{ value: 1, scriptPublicKey: '00' }] })).toBeNull();
    expect(idBodyOf({ ...ok, outputs: [{ value: 1, scriptPublicKey: '0000ac', covenant: { authorizingInput: 0, covenantId: 'ab' } }] })).toBeNull();
    expect(idBodyOf({ ...ok, inputs: [{ previousOutpoint: { transactionId: 'ab', index: 0 }, sequence: 0 }] })).toBeNull();
  });
});

describe('reserveMadeBy: the reserve proven from the transaction that made it', () => {
  const c = offlineChain('reserve-made/proof');
  const alice = secret('reserve-made/proof/alice');
  const minted = c.mint([alice, alice], [60_000_000n, 30_000_000n]);
  const init = core.call('pool-init', {
    ...c.common(), adminSecretKey: bytesToHex(c.admin), pool: c.at(c.poolGenesis, 0, 'pool', c.poolId), provider: c.owned(c.at(minted, 1, 'token'), alice),
    kasIn: 1_000n * KAS, tokensIn: 50_000_000n, positionOwner: xonly(alice), tokenValue: TOKEN_VALUE, positionValue: POSITION_VALUE,
  }).value;
  const pool1 = c.at(init, 0, 'pool', c.poolId), reserve1 = c.at(init, init.outputs.findIndex((o: any) => o.kind === 'reserve'), 'token');
  const tokensOut = BigInt(core.call('quote', { kind: 'buy', pool: pool1.state, kasIn: 10n * KAS }).value.tokensOut);
  const buy = core.call('pool-buy', { ...c.common(), pool: pool1, reserve: reserve1, kasIn: 10n * KAS, tokensOut, buyer: xonly(alice), tokenValue: TOKEN_VALUE }).value;
  const ids = { covenantId: c.covenantId, poolId: c.poolId };
  const reserveAt = (b: any) => b.outputs.findIndex((o: any) => o.kind === 'reserve');
  const scriptAfter = (b: any) => scriptOf('KCC20', reserveOf(poolOf(b.outputs[0].pool), c.poolId));

  it('proves the reserve init and a buy made, with the KAS their outputs hold', () => {
    for (const b of [init, buy]) {
      const at = { transactionId: b.txid, index: reserveAt(b) };
      expect(reserveMadeBy(idFieldsOf(b.transaction), at, scriptAfter(b), ids)).toBe(BigInt(b.outputs[at.index].value));
      // The core's whole body too, signature scripts and all: they are not in the id.
      expect(reserveMadeBy(b.transaction, at, scriptAfter(b), ids)).toBe(BigInt(b.outputs[at.index].value));
    }
  });

  it('takes no other body, output, script or family as proof', () => {
    const at = { transactionId: buy.txid, index: reserveAt(buy) };
    const made = idFieldsOf(buy.transaction), script = scriptAfter(buy);
    // Another body (init's), or this one changed: not the body of the reserve's transaction.
    expect(reserveMadeBy(idFieldsOf(init.transaction), at, script, ids)).toBeNull();
    expect(reserveMadeBy({ ...made, outputs: made.outputs.map((o: any, i: number) => (i === at.index ? { ...o, value: String(BigInt(o.value) - 1n) } : o)) }, at, script, ids)).toBeNull();
    // Another output (the bought kUSDT), another script than the pool's state forces, another token, another pool.
    expect(reserveMadeBy(made, { ...at, index: at.index + 1 }, script, ids)).toBeNull();
    expect(reserveMadeBy(made, at, scriptAfter(init), ids)).toBeNull();
    expect(reserveMadeBy(made, at, script, { ...ids, covenantId: 'ab'.repeat(32) })).toBeNull();
    expect(reserveMadeBy(made, at, script, { ...ids, poolId: 'ab'.repeat(32) })).toBeNull();
    // Not a body; a version 0 body (its id leaves the bindings out), here made to hash to its own id.
    expect(reserveMadeBy('made', at, script, ids)).toBeNull();
    const v0 = { ...buy.transaction, version: 0 };
    expect(reserveMadeBy(v0, { ...at, transactionId: idOf(v0) }, script, ids)).toBeNull();
  });

  it('a transaction that made no coin of the pool\'s, or a kUSDT output at the reserve\'s script that is not its first, proves nothing', () => {
    const made = idFieldsOf(buy.transaction), script = scriptAfter(buy), r = reserveAt(buy);
    // As if a transfer to the pool's owner had made it: the same outputs with the pool's coin unbound (its id is its own).
    const noPool = { ...made, outputs: made.outputs.map((o: any) => (o.covenant?.covenantId === c.poolId ? { ...o, covenant: null } : o)) };
    expect(reserveMadeBy(noPool, { transactionId: idOf(noPool), index: r }, script, ids)).toBeNull();
    // A kUSDT output at the reserve's script before the reserve: the covenant makes the first one the reserve, not the second.
    const twice = { ...made, outputs: [...made.outputs.slice(0, r), made.outputs[r], ...made.outputs.slice(r)] };
    expect(reserveMadeBy(twice, { transactionId: idOf(twice), index: r + 1 }, script, ids)).toBeNull();
    expect(reserveMadeBy(twice, { transactionId: idOf(twice), index: r }, script, ids)).toBe(BigInt(made.outputs[r].value));
  });

  it('a tick, which moves no kUSDT, proves no reserve', () => {
    const tick = core.call('pool-tick', { ...c.common(), pool: { ...c.at(buy, 0, 'pool', c.poolId), utxo: { ...c.at(buy, 0, 'pool', c.poolId).utxo, blockDaaScore: 1_000 } }, nowDaa: 5_000 }).value;
    expect(tick.outputs.some((o: any) => o.kind === 'reserve')).toBe(false);
    for (let index = 0; index < tick.outputs.length; index++) expect(reserveMadeBy(idFieldsOf(tick.transaction), { transactionId: tick.txid, index }, scriptAfter(buy), ids)).toBeNull();
  });
});
