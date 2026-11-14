// Token review (r16/rev-token), property 8: the TypeScript decoder against the script engine.
//
// bridge/kaspa/tests/zz_rev_token_decoder.rs builds randomized KCC-20 transfers (fixed seeds), runs each in the real
// script engine, and writes the accepted ones with the states the engine was given, plus other bodies of the same
// transactions (the same txid, a respelled signature script), some the engine accepted and some it refused.
//
// Here: every accepted body must decode to exactly those states, each state must map to the script of the output
// that holds it, and no refused body may pass the "its next_states are its outputs" check the services use to pick
// the body consensus accepted (shared/accepted.ts transferScore).
//
// The whole run is in bridge/kaspa/build/zz_rev_token_decoder.json once the Rust test has run:
//   (bridge/kaspa)  cargo test --locked --test zz_rev_token_decoder -- --nocapture
// Without it, the checked-in sample (the first rounds of the first seed) is read.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blake3 } from '@noble/hashes/blake3.js';
import { core } from '@kusdt/core';
import { bytesToHex, hexToBytes } from '@kusdt/kaspa';
import { authorizedOutputs, decodeKcc20Input, parsePushes, spkHex, stateOfProgram, type TokenState } from './index';

const whole = fileURLToPath(new URL('../../../kaspa/build/zz_rev_token_decoder.json', import.meta.url));
const sample = fileURLToPath(new URL('../../../kaspa/tests/fixtures/zz_rev_token_decoder_sample.json', import.meta.url));
const path = existsSync(whole) ? whole : sample;
const run = JSON.parse(readFileSync(path, 'utf8'));
const template = core.call('template').value;
const scriptOf = (state: TokenState) => String(core.call('script', { actor: 'KCC20', state }).value.scriptPublicKey).toLowerCase();

const stateOf = (j: any): TokenState => ({
  amount: BigInt(j.amount), owner: j.owner, ownerScheme: j.ownerScheme, borrowScheme: j.borrowScheme, borrowGuard: j.borrowGuard, extensionCommitment: j.extensionCommitment,
});

const push = (data: Uint8Array, pushdata1 = false): Uint8Array => {
  if (pushdata1 && data.length <= 255) return Uint8Array.of(0x4c, data.length, ...data);
  if (data.length === 0) return Uint8Array.of(0x00);
  if (data.length === 1 && data[0] >= 1 && data[0] <= 16) return Uint8Array.of(0x50 + data[0]);
  if (data.length === 1 && data[0] === 0x81) return Uint8Array.of(0x4f);
  if (data.length <= 75) return Uint8Array.of(data.length, ...data);
  if (data.length <= 255) return Uint8Array.of(0x4c, data.length, ...data);
  return Uint8Array.of(0x4d, data.length & 0xff, data.length >> 8, ...data);
};

/** The body a variant describes: the base transaction with one input's signature script respelled. */
function bodyOf(v: any): any {
  const tx = structuredClone(run.cases[v.base].transaction);
  const items = parsePushes(hexToBytes(tx.inputs[v.input].signatureScript));
  for (const [at, hex] of v.replace) items[at] = hexToBytes(hex);
  const parts = items.map((d, i) => push(d, v.pushdata1 === i));
  const script = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { script.set(p, at); at += p.length; }
  // The very bytes the engine ran.
  expect(bytesToHex(blake3(script)), v.name).toBe(v.scriptHash);
  tx.inputs[v.input].signatureScript = bytesToHex(script);
  return tx;
}

/** What shared/accepted.ts transferScore decides for one body: how many kUSDT leaders are proven, -1 if one is not. */
function score(tx: any, kusdt: string): number {
  let proven = 0;
  try {
    for (const [i, input] of tx.inputs.entries()) {
      const decoded = decodeKcc20Input(hexToBytes(input.signatureScript ?? ''), template);
      if (decoded?.role !== 'leader') continue;
      const authorized = authorizedOutputs(tx, kusdt, i);
      if (authorized.length === 0) continue;
      if (authorized.length !== decoded.nextStates.length) return -1;
      for (const [k, state] of decoded.nextStates.entries()) if (spkHex(tx.outputs[authorized[k]].scriptPublicKey) !== scriptOf(state)) return -1;
      proven++;
    }
  } catch { return -1; }
  return proven;
}

/** Checks one accepted body against what the engine was given. Answers how many states were compared. */
function checkAccepted(c: any, tx: any, name: string): number {
  let states = 0;
  for (const want of c.inputs) {
    const decoded = decodeKcc20Input(hexToBytes(tx.inputs[want.index].signatureScript), template);
    if (want.role === 'other') { expect(decoded, `${name}: input ${want.index} is not a KCC20 input`).toBeNull(); continue; }
    expect(decoded, `${name}: input ${want.index} decodes`).not.toBeNull();
    expect(decoded!.role, `${name}: input ${want.index}`).toBe(want.role);
    expect(decoded!.spent, `${name}: the state input ${want.index} spends`).toEqual(stateOf(want.spent));
    // The spent state, read straight from the program, is the same.
    const program = parsePushes(hexToBytes(tx.inputs[want.index].signatureScript)).at(-1)!;
    expect(stateOfProgram(program, template)).toEqual(stateOf(want.spent));
    if (want.role !== 'leader') { expect(decoded!.nextStates).toEqual([]); continue; }
    expect(decoded!.nextStates.length, `${name}: input ${want.index} declares as many states as the engine was given`).toBe(want.next.length);
    // Its k-th state is its k-th output bound to ITS covenant ID (kUSDT's or another token's), and maps to that output's script.
    const bound = authorizedOutputs(tx, want.covenantId, want.index);
    expect(bound, `${name}: the outputs input ${want.index} authorizes`).toEqual(want.next.map((n: any) => n.output));
    for (const [k, n] of want.next.entries()) {
      expect(decoded!.nextStates[k], `${name}: state ${k} of input ${want.index}`).toEqual(stateOf(n.state));
      expect(scriptOf(decoded!.nextStates[k]), `${name}: the script of state ${k} of input ${want.index}`).toBe(spkHex(tx.outputs[n.output].scriptPublicKey));
      states++;
    }
  }
  // The services' own measure: every kUSDT leader of an accepted body is proven.
  const kusdtLeaders = c.inputs.filter((x: any) => x.role === 'leader' && x.covenantId === c.kusdt).length;
  expect(score(tx, c.kusdt), `${name}: every kUSDT leader is proven`).toBe(kusdtLeaders);
  return states;
}

describe(`the KCC-20 decoder against engine-run transactions (${path.endsWith('sample.json') ? 'the checked-in sample' : 'the whole run'})`, () => {
  it('reads every accepted transaction exactly as the engine was given it', () => {
    let states = 0;
    for (const c of run.cases) {
      expect(c.accepted).toBe(true);
      states += checkAccepted(c, c.transaction, c.name);
      if (c.seedMade) {
        // A seed's output is declared by no KCC20 leader: its state is known only to who made it, and maps to its script.
        expect(scriptOf(stateOf(c.seedMade.state))).toBe(spkHex(c.transaction.outputs[c.seedMade.output].scriptPublicKey));
      }
    }
    console.log(`REV-TOKEN 8 decoder (TypeScript): ${run.cases.length} accepted transactions (seeds ${run.seeds.join(', ')}), ${states} output states compared`);
    expect(states).toBeGreaterThan(20);
  }, 300_000);

  it('reads every accepted respelling as the same states, and proves no refused body', () => {
    let accepted = 0, refused = 0;
    for (const v of run.variants) {
      const c = run.cases[v.base];
      const tx = bodyOf(v);
      if (v.accepted) {
        checkAccepted(c, tx, v.name);
        accepted++;
      } else {
        // A forged body names the forged leader's states wrongly: it must not count as proven.
        const forged = c.inputs.find((x: any) => x.index === v.input);
        if (forged.covenantId === c.kusdt) expect(score(tx, c.kusdt), `${v.name}: not proven`).toBe(-1);
        const decoded = decodeKcc20Input(hexToBytes(tx.inputs[v.input].signatureScript), template);
        if (decoded?.role === 'leader') {
          const bound = authorizedOutputs(tx, forged.covenantId, v.input);
          const matches = decoded.nextStates.length === bound.length && decoded.nextStates.every((s, k) => scriptOf(s) === spkHex(tx.outputs[bound[k]].scriptPublicKey));
          expect(matches, `${v.name}: its states are not its outputs`).toBe(false);
        }
        refused++;
      }
    }
    console.log(`REV-TOKEN 8 decoder (TypeScript): ${accepted} accepted respellings read the same, ${refused} refused bodies not proven`);
    expect(accepted).toBeGreaterThan(5);
    expect(refused).toBeGreaterThan(20);
  }, 600_000);
});
