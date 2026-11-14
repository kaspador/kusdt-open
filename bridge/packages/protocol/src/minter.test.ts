import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { core } from '@kusdt/core';
import { bytesToHex, encodeKaspaAddress, hexToBytes } from '@kusdt/kaspa';
import {
  ACTION, GOVERN_AGE_MARGIN_DAA, MinterFollowError, decodeMinterProgram, decodeMinterSpend, followMinter, fullRefillAge, governAge, hasQuorum, minterFromJson, parsePushes, readScriptNum, refilled, claimableAge, unpauseDigest, writeInt8,
  type MinterSpend, type MinterState, type ProgramLayout,
} from './index';
import { blake3 } from '@noble/hashes/blake3.js';

const KAS = 100_000_000n;
const layout: ProgramLayout = core.call('layout', {}).value.contracts.BridgeMint;
const scriptOf = (actor: string, state: unknown) => core.call('script', { actor, state }).value.scriptPublicKey as string;
const secret = (seed: string) => blake2b(new TextEncoder().encode(seed), { dkLen: 32 });
const xonly = (s: Uint8Array) => bytesToHex(schnorr.getPublicKey(s));
const payer = secret('minter-test/payer');
const payerAddress = encodeKaspaAddress('kaspasim', 0, schnorr.getPublicKey(payer));
const signers = [0, 1, 2, 3, 4].map((i) => secret(`minter-test/signer-${i}`));
const guardian = secret('minter-test/guardian');
let coinSeed = 0;
const funding = () => [{
  utxo: { transactionId: (++coinSeed).toString(16).padStart(64, '0'), index: 0, amount: 10_000n * KAS, scriptPublicKey: `000020${xonly(payer)}ac` },
  secretKey: bytesToHex(payer),
}];
const common = () => ({ network: 'simnet', changeAddress: payerAddress, funding: funding() });
const { signerSet } = core.call('signer-set', { signerKeys: signers.map(xonly) }).value;

const genesis = core.call('genesis', {
  ...common(),
  minter: {
    remaining: 1_000_000_000_000_000n, bucket: 400_000_000_000n, capacity: 500_000_000_000n, refillPerDaa: 578_703n,
    nonceEthereum: 0n, nonceBsc: 0n, adminNonce: 0n, paused: false, signerSet, guardian: xonly(guardian),
  },
  minterValue: 5n * KAS, seedOwner: xonly(payer), seedValue: 2n * KAS,
}).value;
const covenantId: string = genesis.covenantId;

type Located = { utxo: any; state: any };
const locate = (built: any, index = 0): Located => ({
  utxo: { transactionId: built.txid, index, amount: built.outputs[index].value, scriptPublicKey: built.outputs[index].scriptPublicKey, covenantId },
  state: built.outputs[index].minter,
});
const minter0 = locate(genesis);
const sign = (digest: string, who: number[]) => who.map((i) => bytesToHex(schnorr.sign(hexToBytes(digest), signers[i])));
const follow = (built: any, from: Located) => followMinter(built.txid, built.transaction, from.utxo, layout, scriptOf as any, covenantId);

function govern(from: Located, action: any, who: number[], ageDaa = 0) {
  // A recovery proposal or veto is signed at the recovery nonce.
  const nonce = action.kind === 'proposeRecovery' || action.kind === 'vetoRecovery' ? from.state.recoveryNonce : from.state.adminNonce;
  const digest = core.call('govern-digest', { covenantId, adminNonce: nonce, ageDaa, action, outpoint: { transactionId: from.utxo.transactionId, index: from.utxo.index } }).value.digest; // the age claimed is signed
  return core.call('govern', {
    ...common(), minter: from, action, ageDaa, signerKeys: signers.map(xonly), signerIndices: who, signatures: sign(digest, who),
  }).value;
}

function expectFollowed(built: any, from: Located): MinterState {
  const move = follow(built, from)!;
  const expected = minterFromJson(built.outputs[0].minter);
  expect(move.minter.state).toEqual(expected);
  expect(move.minter.utxo.index).toBe(0);
  expect(move.minter.utxo.amount).toBe(BigInt(built.outputs[0].value));
  return move.minter.state;
}

describe('the minter follower', () => {
  it('reads the state inside a BridgeMint program', () => {
    const mint = buildMint(minter0, 1);
    const input = mint.transaction.inputs.find((i: any) => i.previousOutpoint.transactionId === genesis.txid);
    const program = parsePushes(hexToBytes(input.signatureScript)).at(-1)!;
    expect(program.length).toBe(8499);
    expect(decodeMinterProgram(program, layout)).toEqual(minterFromJson(minter0.state));
    expect(decodeMinterProgram(program.slice(1), layout)).toBeNull();
  });

  it('follows mints of one to three recipients, recipients included', () => {
    for (const n of [1, 2, 3]) {
      const mint = buildMint(minter0, n);
      const move = follow(mint, minter0)!;
      expect(move.spend.entry).toBe('mint');
      expect(move.minter.state).toEqual(minterFromJson(mint.outputs[0].minter));
      expect(move.minted.map((m) => m.index)).toEqual(Array.from({ length: n }, (_, k) => k + 1));
      expect(move.minted.map((m) => m.state.amount)).toEqual(Array.from({ length: n }, (_, k) => BigInt(k + 1) * 1_000_000n));
    }
  });

  it('follows a pause and every governance action', () => {
    const pause = core.call('pause', { ...common(), minter: minter0, guardianSecretKey: bytesToHex(guardian) }).value;
    expect(expectFollowed(pause, minter0).paused).toBe(true);
    const paused = locate(pause);
    const unpause = govern(paused, { kind: 'unpause' }, [0, 1, 2, 3]);
    expect(expectFollowed(unpause, paused).paused).toBe(false);

    const limits = govern(minter0, { kind: 'setLimits', capacity: 300_000_000_000n, refillPerDaa: 347_222n }, [0, 1, 2, 4], 5_000);
    const s = expectFollowed(limits, minter0);
    expect(s.capacity).toBe(300_000_000_000n);
    expect(s.bucket).toBe(300_000_000_000n);

    const skip = govern(minter0, { kind: 'skipNonce', chain: 2, nonce: 0 }, [1, 2, 3, 4]);
    expect(expectFollowed(skip, minter0).nonceBsc).toBe(1n);
    expect(follow(skip, minter0)!.step.skipped).toEqual({ chain: 2, nonce: 0n });

    const newSigners = [5, 6, 7, 8, 9].map((i) => xonly(secret(`minter-test/signer-${i}`)));
    const rotate = govern(minter0, { kind: 'setSigners', signerKeys: newSigners, guardian: xonly(payer) }, [0, 1, 2, 3]);
    const rotated = expectFollowed(rotate, minter0);
    expect(rotated.signerSet).toBe(core.call('signer-set', { signerKeys: newSigners }).value.signerSet);
    expect(rotated.guardian).toBe(xonly(payer));

    const value = govern(minter0, { kind: 'setValue', value: 7n * KAS }, [0, 1, 2, 3]);
    expectFollowed(value, minter0);
    expect(follow(value, minter0)!.step.value).toBe(7n * KAS);
  });

  it('refuses to adopt a successor the outputs do not hold', () => {
    const mint = buildMint(minter0, 2);
    const forged = structuredClone(mint.transaction);
    forged.outputs[0].scriptPublicKey = forged.outputs[3].scriptPublicKey;
    expect(() => followMinter(mint.txid, forged, minter0.utxo, layout, scriptOf as any, covenantId)).toThrow(MinterFollowError);
    const recipient = structuredClone(mint.transaction);
    recipient.outputs[2].scriptPublicKey = recipient.outputs[3].scriptPublicKey;
    expect(() => followMinter(mint.txid, recipient, minter0.utxo, layout, scriptOf as any, covenantId)).toThrow(MinterFollowError);
  });

  it('ignores transactions that do not spend the minter', () => {
    const mint = buildMint(minter0, 1);
    expect(followMinter(mint.txid, mint.transaction, { transactionId: '11'.repeat(32), index: 0 }, layout, scriptOf as any, covenantId)).toBeNull();
  });

  it('mirrors the covenant refill exactly', () => {
    expect(refilled(0n, 10n, 100n, 3n)).toBe(30n);
    expect(refilled(0n, 34n, 100n, 3n)).toBe(100n);
    expect(refilled(99n, 1n, 100n, 3n)).toBe(100n);
    expect(refilled(120n, 1n, 100n, 3n)).toBe(100n);
    expect(refilled(5n, 1000n, 100n, 0n)).toBe(5n);
    expect(() => refilled(0n, -1n, 100n, 3n)).toThrow();
  });

  it('claims less than the age it reads, and nothing when it can not tell', () => {
    expect(claimableAge(1_000n, 900n)).toBe(90n);
    expect(claimableAge(1_000n, '900')).toBe(90n);
    expect(claimableAge(1_000n, 995n)).toBe(0n);
    expect(claimableAge(1_000n, 2_000n)).toBe(0n);
    expect(claimableAge(1_000n, null)).toBe(0n);
    expect(claimableAge(1_000n, undefined)).toBe(0n);
    expect(claimableAge(10n ** 12n, 0n)).toBe((1n << 32n) - 1n);
  });

  // Outside review, row F: a governance spend claims an age (it settles the allowance), and the age was not signed, so a
  // copy of a signed action could claim less and throw the refill away. The quorum now signs the age, as a mint's does.
  describe('a governance action signs the age it claims', () => {
    const pause = core.call('pause', { ...common(), minter: minter0, guardianSecretKey: bytesToHex(guardian) }).value;
    const paused = locate(pause);
    const newSigners = [5, 6, 7, 8, 9].map((i) => xonly(secret(`minter-test/signer-${i}`)));
    const AGE = 5_000;
    // Every action kind, on the minter it is valid on. A proposal takes 3 signers; a veto any 1, on a minter with a proposal.
    const proposal = govern(minter0, { kind: 'proposeRecovery', signerKeys: newSigners, guardian: xonly(payer) }, [0, 1, 2], AGE);
    const proposed = locate(proposal);
    const cases: [string, Located, any, number[]][] = [
      ['unpause', paused, { kind: 'unpause' }, [0, 1, 2, 3]],
      ['setLimits', minter0, { kind: 'setLimits', capacity: 450_000_000_000n, refillPerDaa: 347_222n }, [0, 1, 2, 4]],
      ['setSigners', minter0, { kind: 'setSigners', signerKeys: newSigners, guardian: xonly(payer) }, [0, 1, 2, 3]],
      ['skipNonce', minter0, { kind: 'skipNonce', chain: 2, nonce: 0 }, [1, 2, 3, 4]],
      ['setValue', minter0, { kind: 'setValue', value: 7n * KAS }, [0, 1, 2, 3]],
      ['proposeRecovery', minter0, { kind: 'proposeRecovery', signerKeys: newSigners, guardian: xonly(payer) }, [0, 1, 2]],
      ['vetoRecovery', proposed, { kind: 'vetoRecovery' }, [3]],
    ];
    const spendOf = (built: any, from: Located) => {
      const input = built.transaction.inputs.find((i: any) => i.previousOutpoint.transactionId === from.utxo.transactionId);
      return decodeMinterSpend(hexToBytes(input.signatureScript), layout) as Extract<MinterSpend, { entry: 'govern' }>;
    };

    it('the follower finds the quorum at the signed age and at no other, for every action', () => {
      for (const [name, from, action, who] of cases) {
        const built = govern(from, action, who, AGE);
        const spent = { transactionId: from.utxo.transactionId, index: from.utxo.index };
        const spend = spendOf(built, from);
        expect(spend.ageDaa, name).toBe(BigInt(AGE));
        expect(hasQuorum(spend, covenantId, spent), name).toBe(true);
        for (const other of [BigInt(AGE) - 1n, 0n, BigInt(AGE) + 1n]) expect(hasQuorum({ ...spend, ageDaa: other }, covenantId, spent), `${name} at ${other}`).toBe(false);
        // The allowance credited is the signed age's, exactly.
        const before = minterFromJson(from.state);
        const settled = refilled(before.bucket, BigInt(AGE), before.capacity, before.refillPerDaa);
        const next = expectFollowed(built, from);
        expect(next.bucket, name).toBe(name === 'setLimits' ? (settled > next.capacity ? next.capacity : settled) : settled);
      }
    });

    it('a copy of a signed action that claims another age fails the script: the builder, which runs it, refuses to make one', () => {
      for (const [name, from, action, who] of cases) {
        const digest = core.call('govern-digest', { covenantId, adminNonce: name === 'proposeRecovery' || name === 'vetoRecovery' ? from.state.recoveryNonce : from.state.adminNonce, ageDaa: AGE, action, outpoint: { transactionId: from.utxo.transactionId, index: from.utxo.index } }).value.digest;
        const build = (claimed: number) => core.call('govern', { ...common(), minter: from, action, ageDaa: claimed, signerKeys: signers.map(xonly), signerIndices: who, signatures: sign(digest, who) });
        // The control: the same signatures at the age they were made for.
        expect(build(AGE).value.txid, name).toMatch(/^[0-9a-f]{64}$/);
        // What a copier would send: the same action and signatures, claiming less (or more). The core runs the minter's script on what it builds.
        for (const claimed of [0, AGE - 1, AGE + 1]) expect(() => build(claimed), `${name} claiming ${claimed}`).toThrow(/script failed/);
      }
    });

    it('signatures over the old messages, which named no age, are no quorum', () => {
      const le8 = (n: bigint) => writeInt8(n);
      const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
      const utf8 = (s: string) => new TextEncoder().encode(s);
      for (const [name, from, action, who] of cases) {
        const built = govern(from, action, who, 0);
        const spend = spendOf(built, from);
        const spent = { transactionId: from.utxo.transactionId, index: from.utxo.index };
        const nonce = spend.action === ACTION.proposeRecovery || spend.action === ACTION.vetoRecovery ? spend.spent.recoveryNonce : spend.spent.adminNonce;
        const old = spend.action === ACTION.unpause
          ? blake3(cat(utf8('kUSDT/unpause/v1'), hexToBytes(covenantId), le8(nonce), hexToBytes(spent.transactionId), le8(BigInt(spent.index))))
          : blake3(cat(utf8('kUSDT/govern/v1'), hexToBytes(covenantId), le8(nonce), [spend.action], spend.params));
        const signatures = Uint8Array.from(who.flatMap((i) => [...schnorr.sign(old, signers[i])]));
        expect(hasQuorum({ ...spend, quorum: { ...spend.quorum, signatures } }, covenantId, spent), name).toBe(false);
        expect(hasQuorum(spend, covenantId, spent), name).toBe(true);
      }
    });

    it('the follower\'s message is the builders\', byte for byte, at every age', () => {
      const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
      const utf8 = (s: string) => new TextEncoder().encode(s);
      const coin = { transactionId: 'c1'.repeat(32), index: 3 };
      const params: [any, number, Uint8Array][] = [
        [{ kind: 'setLimits', capacity: 42n, refillPerDaa: 3n }, ACTION.setLimits, cat(writeInt8(42n), writeInt8(3n))],
        [{ kind: 'skipNonce', chain: 2, nonce: 9n }, ACTION.skipNonce, cat([2], writeInt8(9n))],
        [{ kind: 'setValue', value: 77n }, ACTION.setValue, writeInt8(77n)],
        [{ kind: 'vetoRecovery' }, ACTION.vetoRecovery, new Uint8Array()],
      ];
      for (const ageDaa of [0n, 1n, 127n, 128n, 255n, 256n, 65_536n, 0x7fffffffn, 0x80000000n, 0xffffffffn]) {
        for (const [action, code, bytes] of params) {
          const built = core.call('govern-digest', { covenantId: 'ab'.repeat(32), adminNonce: 6n, ageDaa, action }).value;
          const message = cat(utf8('kUSDT/govern/v2'), hexToBytes('ab'.repeat(32)), writeInt8(6n), writeInt8(ageDaa), [code], bytes);
          expect(built.digest, `${action.kind} at ${ageDaa}`).toBe(bytesToHex(blake3(message)));
          expect(built.ageDaa).toBe(ageDaa.toString());
        }
        const unpause = core.call('govern-digest', { covenantId: 'ab'.repeat(32), adminNonce: 6n, ageDaa, action: { kind: 'unpause' }, outpoint: coin }).value.digest;
        expect(unpause).toBe(bytesToHex(unpauseDigest('ab'.repeat(32), 6n, ageDaa, coin)));
        expect(unpause).toBe(bytesToHex(blake3(cat(utf8('kUSDT/unpause/v2'), hexToBytes('ab'.repeat(32)), writeInt8(6n), writeInt8(ageDaa), hexToBytes(coin.transactionId), writeInt8(3n)))));
      }
      // No age given is age 0; an age no spend can claim has no digest.
      const none = core.call('govern-digest', { covenantId: 'ab'.repeat(32), adminNonce: 6n, action: { kind: 'vetoRecovery' } }).value;
      expect(none.digest).toBe(core.call('govern-digest', { covenantId: 'ab'.repeat(32), adminNonce: 6n, ageDaa: 0n, action: { kind: 'vetoRecovery' } }).value.digest);
      expect(none.ageDaa).toBe('0');
      expect(() => core.call('govern-digest', { covenantId: 'ab'.repeat(32), adminNonce: 6n, ageDaa: 1n << 32n, action: { kind: 'vetoRecovery' } })).toThrow(/ageDaa/);
    });
  });

  it('the default governance age: the coin\'s age less a margin, and never more than a full refill needs', () => {
    const m = { bucket: 400n, capacity: 1_000n, refillPerDaa: 3n };
    expect(fullRefillAge(m)).toBe(200n); // 600 / 3
    expect(fullRefillAge({ ...m, bucket: 401n })).toBe(200n); // 599 / 3, rounded up
    expect(fullRefillAge({ ...m, bucket: 1_000n })).toBe(0n);
    expect(fullRefillAge({ ...m, bucket: 2_000n })).toBe(0n);
    expect(fullRefillAge({ ...m, refillPerDaa: 0n })).toBe(0n);
    // refilled() at that age is the ceiling, and one DAA less is not.
    expect(refilled(m.bucket, fullRefillAge(m), m.capacity, m.refillPerDaa)).toBe(1_000n);
    expect(refilled(m.bucket, fullRefillAge(m) - 1n, m.capacity, m.refillPerDaa)).toBe(997n);
    expect(GOVERN_AGE_MARGIN_DAA).toBe(600n);
    // Young coin: the age read, less the margin.
    expect(governAge(m, 10_700n, 10_000n)).toBe(100n);
    expect(governAge(m, 10_700n, '10000')).toBe(100n);
    // Older than a full refill needs: capped there.
    expect(governAge(m, 50_000n, 10_000n)).toBe(200n);
    // Within the margin, in the future, or unknown: nothing.
    expect(governAge(m, 10_600n, 10_000n)).toBe(0n);
    expect(governAge(m, 10_100n, 10_000n)).toBe(0n);
    expect(governAge(m, 9_000n, 10_000n)).toBe(0n);
    expect(governAge(m, 50_000n, null)).toBe(0n);
    expect(governAge(m, 50_000n, undefined)).toBe(0n);
    // Nothing to refill: no age is claimed, so the action never waits on the coin.
    expect(governAge({ ...m, bucket: 1_000n }, 50_000n, 10_000n)).toBe(0n);
    expect(governAge({ ...m, refillPerDaa: 0n }, 50_000n, 10_000n)).toBe(0n);
    // Never past what a relative lock can hold.
    expect(governAge({ bucket: 0n, capacity: 10n ** 15n, refillPerDaa: 1n }, 10n ** 13n, 0n)).toBe((1n << 32n) - 1n);
  });

  it('reads minimal script numbers', () => {
    expect(readScriptNum(new Uint8Array())).toBe(0n);
    expect(readScriptNum(Uint8Array.of(0xd0, 0x07))).toBe(2000n);
    expect(readScriptNum(Uint8Array.of(0x81))).toBe(-1n);
    expect(readScriptNum(Uint8Array.of(0x80, 0x00))).toBe(128n);
    // Padding is the same number to consensus (see audit2.test.ts).
    expect(readScriptNum(Uint8Array.of(0x00))).toBe(0n);
    expect(readScriptNum(Uint8Array.of(0x80))).toBe(0n);
    expect(readScriptNum(Uint8Array.of(0x05, 0x00))).toBe(5n);
    expect(() => readScriptNum(new Uint8Array(9))).toThrow();
  });
});

function buildMint(from: Located, n: number) {
  const recipients = Array.from({ length: n }, (_, k) => ({ ownerScheme: 0, owner: xonly(secret(`minter-test/holder-${k}`)), amount: BigInt(k + 1) * 1_000_000n }));
  const firstNonce = BigInt(from.state.nonceEthereum);
  const digest = core.call('mint-digest', { covenantId, chain: 1, firstNonce, recipients }).value.digest;
  return core.call('mint', {
    ...common(), minter: from, chain: 1, firstNonce, ageDaa: 0, recipients,
    signerKeys: signers.map(xonly), signerIndices: [0, 2, 4], signatures: sign(digest, [0, 2, 4]), tokenValue: 150_000_000n,
  }).value;
}
