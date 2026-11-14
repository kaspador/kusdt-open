// Review r16/rev-minter, property 7, the follower's side.
//
// rev-minter-corpus.json is written by bridge/kaspa/tests/rev_minter_diff.rs: every transaction in it was
// ACCEPTED by the script engine, and carries the state it spends and the successor the script demanded (computed by
// a model of bridge_mint.ag that is independent of tx.rs and of this package). The follower must adopt each one
// with exactly that successor: a transaction the chain accepts and the follower refuses, or reads differently,
// blinds or stalls the services.
//
// Run the Rust test first to refresh the corpus (its seeds are in the file), then: npx vitest run rev-minter

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { core } from '@kusdt/core';
import { hexToBytes } from '@kusdt/kaspa';
import { blake3 } from '@noble/hashes/blake3.js';
import { MinterFollowError, decodeMinterSpend, followMinter, hasQuorum, minterFromJson, nextMinter, unpauseDigest, writeInt8, type MinterSpend, type MinterState, type ProgramLayout } from './index';

interface Case {
  name: string;
  covenantId: string;
  current: { transactionId: string; index: number; scriptPublicKey: string };
  spent: any;
  txid: string;
  tx: any;
  next: any;
  value: string;
  minted: { ownerScheme: number; owner: string; amount: string }[];
}

function load(): { seeds: string[]; rounds: number; cases: Case[] } {
  const raw = readFileSync(new URL('./rev-minter-corpus.json', import.meta.url), 'utf8');
  // The long constants of every signature script are written once in the file (see the Rust test).
  const cut = raw.indexOf(',\n"cases":');
  const constants: Record<string, string> = JSON.parse(raw.slice(0, cut) + '}').constants;
  let cases = raw.slice(cut);
  for (const [token, value] of Object.entries(constants)) cases = cases.split(token).join(value);
  return JSON.parse(raw.slice(0, cut) + cases);
}

const corpus = load();
const layout: ProgramLayout = core.call('layout', {}).value.contracts.BridgeMint;
const scriptOf = (actor: string, state: unknown) => core.call('script', { actor, state }).value.scriptPublicKey as string;

describe('the follower against the engine-accepted corpus', () => {
  it('the corpus is the one the Rust run wrote', () => {
    expect(corpus.seeds.length).toBeGreaterThan(0);
    expect(corpus.cases.length).toBeGreaterThan(300);
    console.log(`[p7 follower] seeds ${corpus.seeds.join(', ')}, ${corpus.rounds} rounds each, ${corpus.cases.length} accepted transactions`);
  });

  it('adopts every accepted transaction with the successor the script demanded', () => {
    const problems: string[] = [];
    const byKind: Record<string, number> = {};
    for (const c of corpus.cases) {
      const kind = /\[(engine|tx\.rs|respelled)[^\]]*\]$/.exec(c.name)?.[1] ?? 'other';
      const entry = /#\d+ (\w+)/.exec(c.name)?.[1] ?? 'signed-spelling';
      byKind[`${entry} ${kind}`] = (byKind[`${entry} ${kind}`] ?? 0) + 1;
      try {
        const move = followMinter(c.txid, c.tx, c.current, layout, scriptOf as any, c.covenantId);
        if (!move) { problems.push(`${c.name}: not seen as a spend of the minter`); continue; }
        const want = minterFromJson(c.next);
        const got = move.minter.state;
        const differs = (Object.keys(want) as (keyof MinterState)[]).filter((k) => want[k] !== got[k]);
        if (differs.length) problems.push(`${c.name}: the follower computes another ${differs.join(', ')}: ${differs.map((k) => `${String(got[k])} for ${String(want[k])}`).join('; ')}`);
        if (move.minter.utxo.amount !== BigInt(c.value)) problems.push(`${c.name}: the follower reads value ${move.minter.utxo.amount}, the script demanded ${c.value}`);
        if (move.minted.length !== c.minted.length) problems.push(`${c.name}: ${move.minted.length} minted states for ${c.minted.length}`);
        move.minted.forEach((m, k) => {
          const w = c.minted[k];
          if (m.state.amount !== BigInt(w.amount) || m.state.owner !== w.owner || m.state.ownerScheme !== w.ownerScheme) problems.push(`${c.name}: minted state ${k} is read differently`);
        });
        // The spent state is read out of the program itself: it must be the one the engine ran.
        const spent = minterFromJson(c.spent);
        const read = move.spend.spent;
        const off = (Object.keys(spent) as (keyof MinterState)[]).filter((k) => spent[k] !== read[k]);
        if (off.length) problems.push(`${c.name}: the follower decodes another spent state (${off.join(', ')})`);
      } catch (e) {
        if (!(e instanceof MinterFollowError)) throw e;
        problems.push(`${c.name}: REFUSED by the follower: ${e.message}`);
      }
    }
    console.log('[p7 follower] accepted transactions followed, by entry and source:', JSON.stringify(byKind));
    console.log(`[p7 follower] disagreements: ${problems.length}`);
    for (const p of problems) console.log(`[p7 follower]   ${p}`);
    expect(problems).toEqual([]);
  });

  // An unpause signs the paused coin it spends (SPEC §6): the follower checks the quorum over that message, so a body
  // carrying good signatures over another coin's unpause, or over the govern message unpauses had before, proves nothing.
  it('an unpause has its quorum only over the outpoint it spends', () => {
    const unpauses = corpus.cases.filter((x) => /#\d+ govern action 1 /.test(x.name));
    expect(unpauses.length).toBeGreaterThan(5);
    for (const c of unpauses) {
      const spend = decodeMinterSpend(hexToBytes(c.tx.inputs[0].signatureScript), layout) as Extract<MinterSpend, { entry: 'govern' }>;
      expect(spend.action).toBe(1);
      const spent = { transactionId: c.current.transactionId, index: c.current.index };
      expect(hasQuorum(spend, c.covenantId, spent)).toBe(true);
      expect(hasQuorum(spend, c.covenantId, { ...spent, index: spent.index + 1 })).toBe(false);
      expect(hasQuorum(spend, c.covenantId, { transactionId: c.txid, index: spent.index })).toBe(false);
      expect(hasQuorum(spend, c.covenantId)).toBe(false);
      // The same signatures are no quorum for any other action at that nonce.
      expect(hasQuorum({ ...spend, action: 5, params: new Uint8Array(8) }, c.covenantId, spent)).toBe(false);
      // The age the spend claims is signed too: the same signatures are no quorum under another age.
      expect(hasQuorum({ ...spend, ageDaa: spend.ageDaa + 1n }, c.covenantId, spent)).toBe(false);
      if (spend.ageDaa > 0n) expect(hasQuorum({ ...spend, ageDaa: 0n }, c.covenantId, spent)).toBe(false);
      // The message, spelled out.
      const message = new Uint8Array([...new TextEncoder().encode('kUSDT/unpause/v2'), ...hexToBytes(c.covenantId), ...writeInt8(spend.spent.adminNonce), ...writeInt8(spend.ageDaa), ...hexToBytes(spent.transactionId), ...writeInt8(BigInt(spent.index))]);
      expect(message.length).toBe(104);
      expect(unpauseDigest(c.covenantId, spend.spent.adminNonce, spend.ageDaa, spent)).toEqual(blake3(message));
    }
    // The follower's message is the builders' at every width of the index and of the age (the Rust engine tests
    // show the script signs these same bytes: rev_minter_findings.rs, govern_signed_age.rs).
    for (const index of [0, 1, 16, 17, 127, 128, 255, 256, 32_767, 32_768, 65_536, 0x7fffffff, 0x80000000, 0xffffffff]) {
      for (const ageDaa of [0n, 1n, 127n, 128n, 65_536n, 0x7fffffffn, 0x80000000n, 0xffffffffn]) {
        const spent = { transactionId: 'c1'.repeat(32), index };
        const built = core.call('govern-digest', { covenantId: 'ab'.repeat(32), adminNonce: 3n, ageDaa, action: { kind: 'unpause' }, outpoint: spent }).value.digest;
        expect(Buffer.from(unpauseDigest('ab'.repeat(32), 3n, ageDaa, spent)).toString('hex'), `${index}/${ageDaa}`).toBe(built);
      }
    }
    expect(() => unpauseDigest('ab'.repeat(32), 3n, 0n, { transactionId: 'c1'.repeat(32), index: 2 ** 32 })).toThrow();
    // And a non-unpause action's quorum does not depend on the outpoint.
    const other = corpus.cases.find((x) => /#\d+ govern action 2 .*\[engine\]$/.test(x.name))!;
    const spend = decodeMinterSpend(hexToBytes(other.tx.inputs[0].signatureScript), layout) as Extract<MinterSpend, { entry: 'govern' }>;
    expect(hasQuorum(spend, other.covenantId)).toBe(true);
    expect(hasQuorum(spend, other.covenantId, { transactionId: other.txid, index: 7 })).toBe(true);
  });

  // The other direction, for the record: what the follower's arithmetic would compute for a spend the script
  // refuses. The follower only ever sees accepted transactions, and adopts a body only when its computed successor
  // is the transaction's own output and the quorum's signatures check, so these are not adoptions; they show which
  // of the script's requires the follower repeats and which it leaves to consensus.
  it('which of the script\'s refusals nextMinter repeats', () => {
    const c = corpus.cases.find((x) => /#\d+ mint .*\[engine\]$/.test(x.name))!;
    const spend = decodeMinterSpend(hexToBytes(c.tx.inputs[0].signatureScript), layout) as Extract<MinterSpend, { entry: 'mint' }>;
    const throws = (s: MinterSpend) => { try { nextMinter(s); return false; } catch (e) { if (e instanceof MinterFollowError) return true; throw e; } };
    const rows: [string, boolean][] = [
      ['a mint while paused', throws({ ...spend, spent: { ...spend.spent, paused: true } })],
      ['a mint above the allowance', throws({ ...spend, spent: { ...spend.spent, bucket: 0n, refillPerDaa: 0n } })],
      ['a mint above remaining', throws({ ...spend, spent: { ...spend.spent, remaining: 0n } })],
      ['a mint at another nonce', throws({ ...spend, firstNonce: spend.firstNonce + 1n })],
      ['a mint of an unknown chain', throws({ ...spend, chain: 3 })],
      ['a mint claiming an age of 2^32', throws({ ...spend, ageDaa: 1n << 32n })],
      ['a pause of a paused minter', throws({ entry: 'pause', spent: { ...spend.spent, paused: true } })],
      ['an unpause of a minter that is not paused', throws({ entry: 'govern', spent: { ...spend.spent, paused: false }, action: 1, params: new Uint8Array(0), ageDaa: 0n, quorum: spend.quorum })],
      ['limits above the ceiling', throws({ entry: 'govern', spent: spend.spent, action: 2, params: Uint8Array.from([...Array(8).fill(0xff).map((b, i) => (i === 7 ? 0x7f : b)), 1, 0, 0, 0, 0, 0, 0, 0]), ageDaa: 0n, quorum: spend.quorum })],
      ['a negative limit', throws({ entry: 'govern', spent: spend.spent, action: 2, params: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0x80, 1, 0, 0, 0, 0, 0, 0, 0]), ageDaa: 0n, quorum: spend.quorum })],
      ['a set_value of zero', throws({ entry: 'govern', spent: spend.spent, action: 5, params: new Uint8Array(8), ageDaa: 0n, quorum: spend.quorum })],
      ['execute_recovery with no proposal', throws({ entry: 'executeRecovery', spent: { ...spend.spent, recoveryPending: false } })],
    ];
    for (const [what, refused] of rows) console.log(`[p7 follower] nextMinter on ${what}: ${refused ? 'refuses, like the script' : 'computes a successor (left to consensus)'}`);
    // The requires added by 9049f02 are repeated by the follower.
    expect(Object.fromEntries(rows)['a pause of a paused minter']).toBe(true);
    expect(Object.fromEntries(rows)['an unpause of a minter that is not paused']).toBe(true);
    expect(Object.fromEntries(rows)['limits above the ceiling']).toBe(true);
  });
});
