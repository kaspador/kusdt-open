// A transaction id doesn't commit to signature scripts, so a miner can put any body under a
// real txid. These tests rewrite real signature scripts (real signatures, the real program
// and its real hash) and check that only the body that proves itself is believed.
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { core } from '@kusdt/core';
import { bytesToHex, hexToBytes } from '@kusdt/kaspa';
import {
  MinterFollowError, PoolFollowError, followMinter, followPool, followPositionTransfer, p2shOfProgram, parsePushes, provesProgram, writeInt8,
  type PoolLayouts, type ProgramLayout,
} from './index';
import { KAS, POSITION_VALUE, TOKEN_VALUE, offlineChain, secret, xonly } from './testing/chain';

const contracts = core.call('layout', {}).value.contracts;
const layout: ProgramLayout = contracts.BridgeMint;
const layouts: PoolLayouts = { pool: contracts.Pool, position: contracts.Position, template: core.call('template').value };
const scriptOf = (actor: string, state: unknown) => core.call('script', { actor, state }).value.scriptPublicKey as string;

function encodePushes(pushes: Uint8Array[]): string {
  const out: number[] = [];
  for (const p of pushes) {
    if (p.length === 0) out.push(0x00);
    else if (p.length <= 0x4b) out.push(p.length, ...p);
    else if (p.length <= 0xff) out.push(0x4c, p.length, ...p);
    else out.push(0x4d, p.length & 0xff, p.length >> 8, ...p);
  }
  return bytesToHex(Uint8Array.from(out));
}

const pushesOf = (tx: any, inputIndex: number) => parsePushes(hexToBytes(tx.inputs[inputIndex].signatureScript));
const inputOf = (tx: any, utxo: { transactionId: string; index: number }) => tx.inputs.findIndex((i: any) => i.previousOutpoint.transactionId === utxo.transactionId && i.previousOutpoint.index === utxo.index);

/** `tx` with input `index`'s pushes passed through `edit`: another body under the same txid. */
function rewrite(tx: any, index: number, edit: (pushes: Uint8Array[]) => Uint8Array[]) {
  const forged = structuredClone(tx);
  forged.inputs[index].signatureScript = encodePushes(edit(pushesOf(tx, index)));
  return forged;
}

/** A chain with one mint done (so the next minted nonce is 1) and a real governance transaction builder. */
function setup(name: string) {
  const c = offlineChain(name);
  const mint = c.mint([secret(`${name}/a`)], [1_000_000n]);
  const held = c.minter();
  const govern = (action: any, who: number[], ageDaa = 0) => {
    const digest = core.call('govern-digest', { covenantId: c.covenantId, adminNonce: held.state.adminNonce, ageDaa, action }).value.digest; // the age claimed is signed
    return core.call('govern', {
      ...c.common(), minter: held, action, ageDaa, signerKeys: c.signers.map(xonly), signerIndices: who,
      signatures: who.map((i) => bytesToHex(schnorr.sign(hexToBytes(digest), c.signers[i]))),
    }).value;
  };
  /** A real set_value: 4 signers, as every governance action takes. */
  const setValue = () => govern({ kind: 'setValue', value: 7n * KAS }, [0, 1, 2, 3]);
  const follow = (built: any, tx = built.transaction) => followMinter(built.txid, tx, held.utxo, layout, scriptOf as any, c.covenantId);
  return { c, mint, held, govern, setValue, follow };
}

describe('a minter body must prove itself', () => {
  it('the premise: the program in a real spend hashes to the spent output\'s script', () => {
    const { held, setValue } = setup('body-proof/premise');
    const real = setValue();
    const inputIndex = inputOf(real.transaction, held.utxo);
    const program = pushesOf(real.transaction, inputIndex).at(-1)!;
    expect(p2shOfProgram(program)).toBe(held.utxo.scriptPublicKey);
    expect(provesProgram(held.utxo, real.transaction.inputs[inputIndex].signatureScript)).toBe(true);
    expect(provesProgram({ ...held.utxo, scriptPublicKey: undefined }, real.transaction.inputs[inputIndex].signatureScript)).toBe(false);
  });

  it('a real set_value and a real skip_nonce (4 signatures) are followed', () => {
    const { held, govern, setValue, follow } = setup('body-proof/real');
    const value = setValue();
    expect(follow(value)!.step.value).toBe(7n * KAS);
    const skip = govern({ kind: 'skipNonce', chain: 1, nonce: Number(held.state.nonceEthereum) }, [1, 2, 3, 4]);
    expect(follow(skip)!.step.skipped).toEqual({ chain: 1, nonce: BigInt(held.state.nonceEthereum) });
  });

  it('a set_value rewritten as a skip of the deposit minted last is refused: its signatures are not over that', () => {
    const { held, setValue, follow } = setup('body-proof/skip-forgery');
    const real = setValue();
    const params = new Uint8Array(9);
    params[0] = 1;
    params.set(writeInt8(0n), 1); // nonce 0: the deposit `mint` minted
    const forged = rewrite(real.transaction, inputOf(real.transaction, held.utxo), (p) => { p[0] = Uint8Array.of(4); p[1] = params; return p; });
    expect(() => follow(real, forged)).toThrow(MinterFollowError);
    expect(() => follow(real, forged)).toThrow(/quorum/);
  });

  it('a skip_nonce rewritten down to 3 of its real signatures is refused (it needs 4)', () => {
    const { held, govern, follow } = setup('body-proof/short-quorum');
    const real = govern({ kind: 'skipNonce', chain: 1, nonce: Number(held.state.nonceEthereum) }, [0, 1, 2, 3]);
    const forged = rewrite(real.transaction, inputOf(real.transaction, held.utxo), (p) => {
      p[4] = p[4].slice(0, 3);
      p[5] = p[5].slice(0, 192);
      return p;
    });
    expect(() => follow(real, forged)).toThrow(/quorum/);
  });

  it('a set_value rewritten down to 3 of its real signatures is refused (it needs 4, like the covenant)', () => {
    const { held, setValue, follow } = setup('body-proof/short-value');
    const real = setValue();
    const forged = rewrite(real.transaction, inputOf(real.transaction, held.utxo), (p) => {
      p[4] = p[4].slice(0, 3);
      p[5] = p[5].slice(0, 192);
      return p;
    });
    expect(() => follow(real, forged)).toThrow(/quorum/);
  });

  it('signatures by keys outside the held signer set are refused, even over the right digest', () => {
    const { c, held, setValue, follow } = setup('body-proof/outsiders');
    const real = setValue();
    const other = offlineChain('body-proof/other-signers');
    const digest = hexToBytes(core.call('govern-digest', { covenantId: c.covenantId, adminNonce: held.state.adminNonce, action: { kind: 'setValue', value: 7n * KAS } }).value.digest);
    const forged = rewrite(real.transaction, inputOf(real.transaction, held.utxo), (p) => {
      p[3] = Uint8Array.from(other.signers.flatMap((s) => [...schnorr.getPublicKey(s)]));
      p[5] = Uint8Array.from([0, 1, 2, 3].flatMap((i) => [...schnorr.sign(digest, other.signers[i])]));
      return p;
    });
    expect(() => follow(real, forged)).toThrow(/quorum/);
  });

  it('a body carrying another program is refused: it does not hash to the spent output\'s script', () => {
    const { held, setValue, follow } = setup('body-proof/other-program');
    const real = setValue();
    const other = setup('body-proof/attacker');
    const theirs = other.setValue();
    const theirProgram = pushesOf(theirs.transaction, inputOf(theirs.transaction, other.held.utxo)).at(-1)!;
    const forged = rewrite(real.transaction, inputOf(real.transaction, held.utxo), (p) => { p[p.length - 1] = theirProgram; return p; });
    expect(() => follow(real, forged)).toThrow(/program/);
  });

  it('a mint body rewritten to other recipients is refused by the digest', () => {
    const c = offlineChain('body-proof/mint');
    c.mint([secret('body-proof/a')], [1_000_000n]);
    const held = c.minter();
    const real = c.mint([secret('body-proof/b')], [2_000_000n]);
    const forged = rewrite(real.transaction, inputOf(real.transaction, held.utxo), (p) => {
      p[4] = hexToBytes(xonly(secret('body-proof/thief'))); // the owners push
      return p;
    });
    expect(() => followMinter(real.txid, forged, held.utxo, layout, scriptOf as any, c.covenantId)).toThrow(/quorum/);
  });

  it('age_daa: a padded spelling is the same number, on every action', () => {
    const { held, govern, follow } = setup('body-proof/age-daa');
    const nonMinimal = Uint8Array.of(0xb8, 0x0b, 0x00); // 3000 with a redundant zero byte
    const value = govern({ kind: 'setValue', value: 7n * KAS }, [0, 1, 2, 3], 3_000);
    const respelled = rewrite(value.transaction, inputOf(value.transaction, held.utxo), (p) => { p[2] = nonMinimal; return p; });
    expect(follow(value, respelled)!.step.value).toBe(7n * KAS);
    expect(follow(value, respelled)!.step.next).toEqual(follow(value)!.step.next);
    const limits = govern({ kind: 'setLimits', capacity: 300_000_000_000n, refillPerDaa: 347_222n }, [0, 1, 2, 4], 3_000);
    const padded = rewrite(limits.transaction, inputOf(limits.transaction, held.utxo), (p) => { p[2] = nonMinimal; return p; });
    expect(follow(limits, padded)!.step.next.capacity).toBe(300_000_000_000n);
  });

  it('a held output with no script is not trusted', () => {
    const { held, setValue, follow } = setup('body-proof/no-script');
    const real = setValue();
    expect(() => followMinter(real.txid, real.transaction, { transactionId: held.utxo.transactionId, index: held.utxo.index }, layout, scriptOf as any, 'aa'.repeat(32))).toThrow(/program/);
    expect(follow(real)!.step.value).toBe(7n * KAS);
  });
});

describe('a pool or position body must prove itself', () => {
  function initialized(name: string) {
    const c = offlineChain(name);
    const owner = secret(`${name}/owner`);
    const m = c.mint([owner], [80_000_000n]);
    const genesisPool = c.at(c.poolGenesis, 0, 'pool', c.poolId);
    const init = core.call('pool-init', {
      ...c.common(), adminSecretKey: bytesToHex(c.admin), pool: genesisPool, provider: c.owned(c.at(m, 1, 'token'), owner),
      kasIn: 500n * KAS, tokensIn: 40_000_000n, positionOwner: xonly(owner), tokenValue: TOKEN_VALUE, positionValue: POSITION_VALUE,
    }).value;
    const positionIndex = init.outputs.findIndex((o: any) => o.kind === 'position');
    const position = c.at(init, positionIndex, 'position', c.poolId);
    return { c, owner, genesisPool, init, position };
  }

  it('a real pool init is followed; the same body with another program (a wrong script hash) is refused', () => {
    const { c, genesisPool, init } = initialized('body-proof/pool');
    expect(followPool(init.txid, init.transaction, genesisPool.utxo, c.poolId, layouts, scriptOf)?.spend.entry).toBe('init');
    const inputIndex = inputOf(init.transaction, genesisPool.utxo);
    const forged = rewrite(init.transaction, inputIndex, (p) => { p[p.length - 1] = Uint8Array.of(0x51); return p; });
    expect(() => followPool(init.txid, forged, genesisPool.utxo, c.poolId, layouts, scriptOf)).toThrow(/program/);
    expect(() => followPool(init.txid, init.transaction, { transactionId: genesisPool.utxo.transactionId, index: genesisPool.utxo.index }, c.poolId, layouts, scriptOf)).toThrow(PoolFollowError);
  });

  it('a real transfer of a position rewritten as a redeem is refused', () => {
    const { c, owner, position } = initialized('body-proof/position');
    const dave = secret('body-proof/dave');
    const transfer = core.call('position-transfer', { ...c.common(), position, secretKey: bytesToHex(owner), newOwner: xonly(dave) }).value;
    expect(followPositionTransfer(transfer.txid, transfer.transaction, position.utxo, layouts.position, scriptOf, c.poolId)).not.toBe('redeemed');
    const inputIndex = inputOf(transfer.transaction, position.utxo);
    const forged = rewrite(transfer.transaction, inputIndex, (p) => {
      const [newOwner, sig, , program] = p;
      return [newOwner, sig, sig, hexToBytes(layouts.position.entries.redeem), program];
    });
    expect(() => followPositionTransfer(transfer.txid, forged, position.utxo, layouts.position, scriptOf, c.poolId)).toThrow(/authorizes outputs/);
  });
});
