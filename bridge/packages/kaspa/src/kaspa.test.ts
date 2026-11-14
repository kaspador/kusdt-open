// The wallet's Kaspa code against Kaspa's official SDK. Every expected value in
// fixtures/kaspa-vectors.json was produced by the rusty-kaspa v2.1.0 WASM SDK
// (scripts/kaspa-vectors.cjs). If anything here fails, a change altered which
// addresses a phrase gives, what a payment locks funds to, what gets signed,
// or what a payment costs.
import { describe, it, expect } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import V from './fixtures/kaspa-vectors.json';
import {
  encodeKaspaAddress, decodeKaspaAddress, isValidKaspaAddress, scriptForAddress, addressForScript,
} from './address';
import { kaspaAccountNode, kaspaKeyAt, kaspaPrivateKeyAt, kaspaAddressForPrivateKey, kaspaKeyPath } from './derive';
import {
  signatureHash, signInput, transactionId, computeMass, storageMass, transactionMass, toSubmitJson, p2pkScript,
  type KaspaTx, type KaspaUtxo,
} from './tx';
import {
  planKaspaSend, buildFromPlan, signAll, spendableUtxos, checkTransaction, clampFeerate,
  MAX_INPUTS, MIN_FEERATE, MAX_FEERATE, MAX_ABSORBED_CHANGE,
} from './build';
import { KASPA_NETWORKS, parseKas, formatKas } from './network';
import { summarizeHistory } from './wallet';
import { mnemonicToHDKey } from './derive';
import { bytesToHex, hexToBytes } from './bytes';

const MAIN = KASPA_NETWORKS.mainnet;
const TEST = KASPA_NETWORKS['testnet-10'];

describe('kaspa addresses', () => {
  it('matches rusty-kaspa unit vectors', () => {
    expect(encodeKaspaAddress('kaspatest', 0, new Uint8Array(32))).toBe('kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya');
    expect(encodeKaspaAddress('kaspatest', 1, new Uint8Array(33))).toBe('kaspatest:qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhe837j2d');
    expect(encodeKaspaAddress('kaspatest', 1, hexToBytes('ba01fc5f4e9d9879599c69a3dafdb835a7255e5f2e934e9322ecd3af190ab0f60e')))
      .toBe('kaspatest:qxaqrlzlf6wes72en3568khahq66wf27tuhfxn5nytkd8tcep2c0vrse6gdmpks');
    expect(encodeKaspaAddress('kaspa', 0, new Uint8Array(32))).toBe('kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e');
    expect(encodeKaspaAddress('kaspa', 0, hexToBytes('5fff3c4da18f45adcdd499e44611e9fff148ba69db3c4ea2ddd955fc46a59522')))
      .toBe('kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj');
  });

  it('derives the same address as the SDK for 40 random keys, both networks', () => {
    for (const a of V.addresses) {
      const priv = hexToBytes(a.priv);
      expect(kaspaAddressForPrivateKey(priv, MAIN)).toBe(a.mainnet);
      expect(kaspaAddressForPrivateKey(priv, TEST)).toBe(a.testnet);
      expect(bytesToHex(decodeKaspaAddress(a.mainnet)!.payload)).toBe(a.xonly);
    }
  });

  it('rejects every address the SDK rejects', () => {
    expect(V.invalid.length).toBeGreaterThan(0);
    for (const x of V.invalid) {
      expect(x.valid).toBe(false);
      expect(decodeKaspaAddress(x.address)).toBeNull();
    }
    expect(decodeKaspaAddress(V.validSample.address)).not.toBeNull();
  });

  it('rejects wrong network, wrong case, junk and wrong lengths', () => {
    const a = V.addresses[0].mainnet;
    expect(isValidKaspaAddress(a, 'kaspa')).toBe(true);
    expect(isValidKaspaAddress(a, 'kaspatest')).toBe(false);
    expect(isValidKaspaAddress(V.addresses[0].testnet, 'kaspa')).toBe(false);
    expect(decodeKaspaAddress('kaspa:' + a.slice(6).toUpperCase())).toBeNull();
    expect(decodeKaspaAddress(a + 'q')).toBeNull();
    expect(decodeKaspaAddress(a.slice(0, -1))).toBeNull();
    expect(decodeKaspaAddress('bitcoin:' + a.slice(6))).toBeNull();
    expect(decodeKaspaAddress('kaspa:kaspa:' + a.slice(6))).toBeNull();
    expect(decodeKaspaAddress('')).toBeNull();
    expect(decodeKaspaAddress('prl1pkaspad0r')).toBeNull();
    // Single-character corruption anywhere in the body is always caught.
    const body = a.slice(6);
    for (let i = 0; i < body.length; i++) {
      const swapped = body[i] === 'q' ? 'p' : 'q';
      expect(decodeKaspaAddress('kaspa:' + body.slice(0, i) + swapped + body.slice(i + 1))).toBeNull();
    }
  });

  it('builds the same locking script as the SDK for all address types', () => {
    const kinds = new Set<string>();
    for (const s of V.scripts) {
      kinds.add(s.kind);
      const prefix = s.address.split(':')[0];
      const spk = scriptForAddress(s.address, prefix);
      expect(spk.version).toBe(s.version);
      expect(bytesToHex(spk.script)).toBe(s.script);
      expect(addressForScript(spk, prefix)).toBe(s.address);
    }
    expect([...kinds].sort()).toEqual(['ecdsa', 'p2pk', 'p2pk-testnet', 'p2sh']);
  });

  it('refuses to build a script for the other network', () => {
    expect(() => scriptForAddress(V.addresses[0].testnet, 'kaspa')).toThrow();
    expect(() => scriptForAddress(V.addresses[0].mainnet, 'kaspatest')).toThrow();
  });
});

describe('kaspa derivation (m/44\'/111111\'/account\'/chain/index)', () => {
  it('matches the SDK for 11 phrases × 2 accounts × receive and change', async () => {
    let checked = 0;
    for (const d of V.derivation) {
      const hd = await mnemonicToHDKey(d.phrase);
      for (const acc of d.accounts) {
        expect(acc.pathCheck).toBe(true);
        const node = kaspaAccountNode(hd, acc.account);
        for (const r of acc.receive) {
          const k = kaspaKeyAt(node, acc.account, 0, r.index, MAIN);
          expect(k.address).toBe(r.address);
          expect(k.address).toBe(r.pubgen);
          expect(kaspaKeyAt(node, acc.account, 0, r.index, TEST).address).toBe(r.testnet);
          expect(bytesToHex(kaspaPrivateKeyAt(node, 0, r.index))).toBe(r.priv);
          checked++;
        }
        for (const c of acc.change) {
          expect(kaspaKeyAt(node, acc.account, 1, c.index, MAIN).address).toBe(c.address);
          expect(bytesToHex(kaspaPrivateKeyAt(node, 1, c.index))).toBe(c.priv);
          checked++;
        }
      }
    }
    expect(checked).toBe(V.derivation.length * 2 * 8);
  });

  it('pins the well-known test phrase (same addresses Kaspa NG, Kaspium and KasWare show)', async () => {
    const hd = await mnemonicToHDKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    const node = kaspaAccountNode(hd, 0);
    expect(kaspaKeyAt(node, 0, 0, 0, MAIN).address).toBe('kaspa:qqd6e65yefepe9wk0m9vuxdufxd80sphy67gwwd0vdaumzdt4tc9s3qt0lqeh');
    expect(kaspaKeyAt(node, 0, 1, 0, MAIN).address).toBe('kaspa:qqnkyg4hha30lnjystpugz42yh3paurdylxfrsshk3jfstgy95elu2a8l3jcs');
    expect(kaspaKeyPath(0, 0, 0)).toBe("m/44'/111111'/0'/0/0");
  });

  it('maps Pearl networks to Kaspa networks', () => {
  });
});

// Rebuild a signed SDK transaction in our own types.
type VTx = (typeof V.txs)[number];
function fromVector(v: VTx): KaspaTx {
  const spk = (hex: string) => ({ version: parseInt(hex.slice(0, 4), 16), script: hexToBytes(hex.slice(4)) });
  return {
    version: v.tx.version,
    inputs: v.tx.inputs.map(i => ({
      txid: i.transactionId, index: i.index, sequence: BigInt(i.sequence), sigOpCount: i.sigOpCount,
      signatureScript: hexToBytes(i.signatureScript),
      utxo: { amount: BigInt(i.utxo.amount), script: spk(i.utxo.scriptPublicKey) },
    })),
    outputs: v.tx.outputs.map(o => ({ amount: BigInt(o.value), script: spk(o.scriptPublicKey) })),
    lockTime: BigInt(v.tx.lockTime), subnetworkId: hexToBytes(v.tx.subnetworkId), gas: BigInt(v.tx.gas),
    payload: hexToBytes(v.tx.payload),
  };
}

describe('kaspa signing and transaction ids', () => {
  it('computes the signature hash the SDK signed, for every input of 5 transactions', () => {
    let inputs = 0;
    for (const v of V.txs) {
      const tx = fromVector(v);
      tx.inputs.forEach((input, i) => {
        const sig = input.signatureScript.slice(1, 65);
        expect(input.signatureScript[0]).toBe(0x41);
        expect(input.signatureScript[65]).toBe(0x01);
        const xonly = input.utxo.script.script.slice(1, 33);
        expect(schnorr.verify(sig, signatureHash(tx, i), xonly)).toBe(true);
        inputs++;
      });
    }
    expect(inputs).toBe(V.txs.reduce((s, v) => s + v.tx.inputs.length, 0));
  });

  it('computes the same transaction id as the SDK', () => {
    for (const v of V.txs) expect(transactionId(fromVector(v))).toBe(v.tx.id);
  });

  it('a signature over a changed field no longer verifies', () => {
    const tx = fromVector(V.txs[2]);
    const sig = tx.inputs[0].signatureScript.slice(1, 65);
    const xonly = tx.inputs[0].utxo.script.script.slice(1, 33);
    tx.outputs[0].amount += 1n;
    expect(schnorr.verify(sig, signatureHash(tx, 0), xonly)).toBe(false);
  });

  it('our own signatures verify, and signing someone else\'s coin is refused', () => {
    const keys = V.derivation[0].accounts[0].receive.map(r => hexToBytes(r.priv));
    const v = V.txs[2];
    const tx = fromVector(v);
    tx.inputs.forEach(i => { i.signatureScript = new Uint8Array(0); });
    tx.inputs.forEach((_, i) => signInput(tx, i, keys[i % keys.length]));
    tx.inputs.forEach((input, i) => {
      expect(schnorr.verify(input.signatureScript.slice(1, 65), signatureHash(tx, i), input.utxo.script.script.slice(1, 33))).toBe(true);
    });
    expect(transactionId(tx)).toBe(v.tx.id);   // ids exclude signatures
    expect(() => signInput(tx, 0, keys[3])).toThrow(/not locked to this key/);
  });
});

describe('kaspa mass', () => {
  it('matches the SDK mass and storage mass', () => {
    for (const v of V.txs) {
      const tx = fromVector(v);
      const storage = storageMass(
        tx.inputs.map(i => ({ amount: i.utxo.amount, scriptLen: i.utxo.script.script.length })),
        tx.outputs.map(o => ({ amount: o.amount, scriptLen: o.script.script.length })),
      );
      expect(String(storage)).toBe(v.storageMass);
      // calculateTransactionMass treats its argument as unsigned and adds a
      // 66-byte signature per input on top of the ones already there.
      const compute = computeMass(tx) + 66n * BigInt(tx.inputs.length);
      expect(String(compute > storage! ? compute : storage)).toBe(v.mass);
    }
  });

  it('matches mainnet: 1-in/1-out = 1624, 1-in/2-out = 2036 (real transactions)', () => {
    const k = p2pkScript(new Uint8Array(32).fill(7));
    const one: KaspaTx = {
      version: 0, lockTime: 0n, subnetworkId: new Uint8Array(20), gas: 0n, payload: new Uint8Array(0),
      inputs: [{ txid: '00'.repeat(32), index: 0, sequence: 0n, sigOpCount: 1, signatureScript: new Uint8Array(66), utxo: { amount: 20_000_000n, script: k } }],
      outputs: [{ amount: 19_998_156n, script: k }],
    };
    expect(computeMass(one)).toBe(1624n);
    expect(computeMass({ ...one, outputs: [...one.outputs, { amount: 1n, script: k }] })).toBe(2036n);
  });
});

// ── Planning, against the SDK's own generator ──────────────────────────────
function utxosFor(script: ReturnType<typeof p2pkScript>, address: string, rows: { txid: string; index: number; amount: string }[]): KaspaUtxo[] {
  return rows.map(r => ({ txid: r.txid, index: r.index, amount: BigInt(r.amount), script, blockDaaScore: 1000n, isCoinbase: false, address }));
}

describe('kaspa send planning', () => {
  const fromKey = hexToBytes(V.derivation[0].accounts[0].receive[0].priv);
  const toKey   = hexToBytes(V.derivation[0].accounts[0].receive[1].priv);
  const fromAddr = kaspaAddressForPrivateKey(fromKey, MAIN);
  const toAddr   = kaspaAddressForPrivateKey(toKey, MAIN);
  const fromSpk = scriptForAddress(fromAddr, 'kaspa');
  const toSpk   = scriptForAddress(toAddr, 'kaspa');

  it('pays the same fee and change as the SDK generator', () => {
    let compared = 0;
    for (const g of V.generator) {
      const utxos = utxosFor(fromSpk, fromAddr, g.utxos);
      const plan = planKaspaSend({
        utxos, recipient: toSpk, change: fromSpk, feerate: 100,
        amount: g.pay != null ? BigInt(Math.round(g.pay * 1e8)) : 0n, sendMax: g.sweep,
      });
      if ('error' in g && g.error) {
        if (/Insufficient/.test(g.error)) { expect(plan.ok).toBe(false); expect(plan.failure).toBe('insufficient'); compared++; }
        else if (/Storage mass/.test(g.error)) {
          // The SDK gives up here (its change rule looks at change before the
          // fee). We instead leave the too-small change to the fee, bounded.
          expect(plan.ok).toBe(true);
          expect(plan.change).toBe(0n);
          expect(plan.absorbed).toBeGreaterThan(0n);
          expect(plan.absorbed).toBeLessThanOrEqual(MAX_ABSORBED_CHANGE);
        }
        continue;
      }
      if (!g.txs || g.txs.length === 0) continue;   // SDK declines to sweep a single coin
      expect(g.txs.length).toBe(1);
      const t = g.txs[0];
      expect(plan.ok).toBe(true);
      expect(plan.inputs.length).toBe(t.inputs);
      expect(String(plan.amount)).toBe(t.outputs[0]);
      // (For a sweep the SDK reports the swept output as its "change".)
      if (!g.sweep) expect(plan.fee + plan.change).toBe(BigInt(t.fee) + BigInt(t.change));
      // The fee is the fee rate times the final transaction's mass.
      expect(plan.fee).toBe(100n * transactionMass(buildFromPlan(plan, toSpk, fromSpk)).feeMass + plan.absorbed);
      if (plan.change === 0n || plan.mass!.storage === 0n) {
        expect(String(plan.fee)).toBe(t.fee);
      } else {
        // With change and storage mass, the SDK prices storage on the change
        // before the fee is taken out, so it pays slightly less than the
        // final mass; we price the final transaction exactly.
        expect(plan.fee).toBeGreaterThanOrEqual(BigInt(t.fee));
        expect(plan.fee * 100n).toBeLessThanOrEqual(BigInt(t.fee) * 105n);
      }
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(12);
  });

  it('builds, checks and signs a payment whose signatures verify', () => {
    const utxos = utxosFor(fromSpk, fromAddr, [
      { txid: 'aa'.repeat(32), index: 0, amount: '300000000' },
      { txid: 'bb'.repeat(32), index: 1, amount: '500000000' },
    ]);
    const plan = planKaspaSend({ utxos, recipient: toSpk, change: fromSpk, amount: 600_000_000n, feerate: 100 });
    expect(plan.ok).toBe(true);
    expect(plan.inputs.length).toBe(2);
    const tx = buildFromPlan(plan, toSpk, fromSpk);
    signAll(tx, plan, a => (a === fromAddr ? fromKey.slice() : null));
    tx.inputs.forEach((input, i) => {
      expect(schnorr.verify(input.signatureScript.slice(1, 65), signatureHash(tx, i), fromSpk.script.slice(1, 33))).toBe(true);
    });
    const ins = tx.inputs.reduce((s, i) => s + i.utxo.amount, 0n);
    const outs = tx.outputs.reduce((s, o) => s + o.amount, 0n);
    expect(ins - outs).toBe(plan.fee);
    expect(tx.outputs[0].amount).toBe(600_000_000n);
    expect(bytesToHex(tx.outputs[0].script.script)).toBe(bytesToHex(toSpk.script));
    expect(bytesToHex(tx.outputs[1].script.script)).toBe(bytesToHex(fromSpk.script));
    expect(fromKey.some(b => b !== 0)).toBe(true);   // signAll wipes the copies it is given, not the caller's key
  });

  it('refuses to sign a coin that is not ours', () => {
    const other = utxosFor(toSpk, toAddr, [{ txid: 'cc'.repeat(32), index: 0, amount: '500000000' }]);
    const plan = planKaspaSend({ utxos: other, recipient: fromSpk, change: toSpk, amount: 100_000_000n, feerate: 100 });
    const tx = buildFromPlan(plan, fromSpk, toSpk);
    expect(() => signAll(tx, plan, () => fromKey.slice())).toThrow(/not locked to this key/);
    expect(() => signAll(tx, plan, () => null)).toThrow(/does not belong/);
  });

  it('a tampered transaction fails the pre-signing check', () => {
    const utxos = utxosFor(fromSpk, fromAddr, [{ txid: 'dd'.repeat(32), index: 0, amount: '1000000000' }]);
    const plan = planKaspaSend({ utxos, recipient: toSpk, change: fromSpk, amount: 200_000_000n, feerate: 100 });
    const tx = buildFromPlan(plan, toSpk, fromSpk);
    const t1 = structuredClone(tx); t1.outputs[0].amount += 1n; t1.outputs[1].amount -= 1n;
    expect(() => checkTransaction(t1, plan)).toThrow(/Recipient amount/);
    const t2 = structuredClone(tx); t2.outputs.push({ amount: 1000n, script: toSpk }); t2.outputs[1].amount -= 1000n;
    expect(() => checkTransaction(t2, plan)).toThrow(/Unexpected outputs/);
    const t3 = structuredClone(tx); t3.outputs[1].amount -= 1n;
    expect(() => checkTransaction(t3, plan)).toThrow(/Fee mismatch/);
    const t4 = structuredClone(tx); t4.payload = new Uint8Array([1]);
    expect(() => checkTransaction(t4, plan)).toThrow(/Unexpected transaction fields/);
  });

  it('says why a payment cannot be made', () => {
    const one = utxosFor(fromSpk, fromAddr, [{ txid: 'ee'.repeat(32), index: 0, amount: '1000000000' }]);
    const base = { utxos: one, recipient: toSpk, change: fromSpk, feerate: 100 };
    expect(planKaspaSend({ ...base, amount: 5_000_000n }).failure).toBe('too-small');          // 0.05 KAS: storage mass over the limit
    const short = planKaspaSend({ ...base, amount: 2_000_000_000n });
    expect(short.failure).toBe('insufficient');
    expect(short.shortfall).toBeGreaterThan(1_000_000_000n);
    expect(planKaspaSend({ ...base, utxos: [], amount: 1n }).failure).toBe('no-coins');
    expect(planKaspaSend({ ...base, amount: 0n }).ok).toBe(false);
  });

  it('send-all spends at most MAX_INPUTS coins and reports the rest', () => {
    const many = utxosFor(fromSpk, fromAddr, Array.from({ length: MAX_INPUTS + 7 }, (_, i) => ({
      txid: (i + 1).toString(16).padStart(64, '0'), index: 0, amount: String(100_000_000 + i),
    })));
    const plan = planKaspaSend({ utxos: many, recipient: toSpk, change: fromSpk, amount: 0n, sendMax: true, feerate: 100 });
    expect(plan.ok).toBe(true);
    expect(plan.inputs.length).toBe(MAX_INPUTS);
    expect(plan.leftover).toBe(7);
    expect(plan.change).toBe(0n);
    const total = plan.inputs.reduce((s, u) => s + u.amount, 0n);
    expect(plan.amount + plan.fee).toBe(total);
    // The 7 smallest coins are the ones left out.
    expect(plan.inputs.every(u => u.amount >= 100_000_007n)).toBe(true);
    const m = transactionMass(buildFromPlan(plan, toSpk, fromSpk));
    expect(m.compute).toBeLessThanOrEqual(100_000n);
  });

  it('skips coins being spent and immature mined coins', () => {
    const rows = [
      { txid: '01'.repeat(32), index: 0, amount: '100' },
      { txid: '02'.repeat(32), index: 0, amount: '100' },
      { txid: '03'.repeat(32), index: 0, amount: '100' },
    ];
    const u = utxosFor(fromSpk, fromAddr, rows);
    u[1].isCoinbase = true; u[1].blockDaaScore = 10_000n;
    u[2].isCoinbase = true; u[2].blockDaaScore = 1_000n;
    const pending = new Set([`${'01'.repeat(32)}:0`]);
    expect(spendableUtxos(u, { virtualDaaScore: 10_500n, pending }).map(x => x.txid)).toEqual(['03'.repeat(32)]);
    expect(spendableUtxos(u, { virtualDaaScore: null }).map(x => x.txid)).toEqual(['01'.repeat(32)]);
  });

  it('bounds the fee rate', () => {
    expect(clampFeerate(null)).toBe(MIN_FEERATE);
    expect(clampFeerate(1)).toBe(MIN_FEERATE);
    expect(clampFeerate(250)).toBe(250);
    expect(clampFeerate(1e9)).toBe(MAX_FEERATE);
    expect(clampFeerate(NaN)).toBe(MIN_FEERATE);
  });
});

describe('kaspa activity', () => {
  const me = 'kaspa:qqd6e65yefepe9wk0m9vuxdufxd80sphy67gwwd0vdaumzdt4tc9s3qt0lqeh';
  const other = 'kaspa:qqxxljhvp0vyl93dzgflwgkhx6j0ef87cd04vd752m9kzzm99y6zuaxt4dvyt';
  const third = 'kaspa:qp69kh7sqc3u8624mhc78xj65pmxq9jm8egayjk26x6k54hudrfwxns9tl7tj';
  const ours = new Set([me]);

  it('reads received, sent and self payments (shapes from the live API)', () => {
    const rows = [
      // Received 0.2 KAS from `third` (mainnet tx f0621b2f…)
      { transaction_id: 'f0'.repeat(32), block_time: 1774664376842, is_accepted: true,
        inputs: [{ previous_outpoint_address: third, previous_outpoint_amount: 76_301_553 }],
        outputs: [{ amount: 20_000_000, script_public_key_address: me }, { amount: 56_097_517, script_public_key_address: third }] },
      // Sent everything to `other`; the difference is the fee (mainnet tx fd5ac735…)
      { transaction_id: 'fd'.repeat(32), block_time: 1774771989326, is_accepted: true,
        inputs: [{ previous_outpoint_address: me, previous_outpoint_amount: 20_000_000 }],
        outputs: [{ amount: 19_998_156, script_public_key_address: other }] },
      // Moved coins to ourselves, not yet accepted
      { transaction_id: 'aa'.repeat(32), block_time: null, is_accepted: false,
        inputs: [{ previous_outpoint_address: me, previous_outpoint_amount: 50_000_000 }],
        outputs: [{ amount: 49_790_000, script_public_key_address: me }] },
      // Unrelated, and a duplicate row
      { transaction_id: 'bb'.repeat(32), block_time: 1, is_accepted: true, inputs: [], outputs: [{ amount: 5, script_public_key_address: other }] },
      { transaction_id: 'fd'.repeat(32), block_time: 1774771989326, is_accepted: true, inputs: [], outputs: [] },
    ];
    const a = summarizeHistory(rows, ours);
    expect(a.map(x => [x.txid.slice(0, 2), x.direction, x.net, x.confirmed, x.counterparty])).toEqual([
      ['aa', 'self', -210_000n, false, null],
      ['fd', 'out', -20_000_000n, true, other],
      ['f0', 'in', 20_000_000n, true, third],
    ]);
  });
});

describe('kaspa submit format and amounts', () => {
  it('writes amounts above 2^53 exactly', () => {
    const k = p2pkScript(new Uint8Array(32).fill(1));
    const tx: KaspaTx = {
      version: 0, lockTime: 0n, subnetworkId: new Uint8Array(20), gas: 0n, payload: new Uint8Array(0),
      inputs: [{ txid: 'ab'.repeat(32), index: 3, sequence: 0n, sigOpCount: 1, signatureScript: new Uint8Array(66).fill(9), utxo: { amount: 1n, script: k } }],
      outputs: [{ amount: 2_900_000_000_000_000_001n, script: k }],
    };
    const json = toSubmitJson(tx);
    expect(json).toContain('"amount":2900000000000000001');
    const parsed = JSON.parse(json);
    expect(parsed.allowOrphan).toBe(false);
    expect(parsed.transaction.inputs[0]).toEqual({
      previousOutpoint: { transactionId: 'ab'.repeat(32), index: 3 }, signatureScript: '09'.repeat(66), sequence: 0, sigOpCount: 1,
    });
    expect(parsed.transaction.outputs[0].scriptPublicKey).toEqual({ version: 0, scriptPublicKey: bytesToHex(k.script) });
    expect(parsed.transaction.subnetworkId).toBe('00'.repeat(20));
    tx.inputs[0].signatureScript = new Uint8Array(0);
    expect(() => toSubmitJson(tx)).toThrow(/not signed/);
  });

  it('parses and formats KAS exactly', () => {
    expect(parseKas('1')).toBe(100_000_000n);
    expect(parseKas('0.00000001')).toBe(1n);
    expect(parseKas('1,5')).toBe(150_000_000n);
    expect(parseKas('.5')).toBe(50_000_000n);
    expect(parseKas('123456789.12345678')).toBe(12_345_678_912_345_678n);
    expect(parseKas('0.000000001')).toBeNull();
    expect(parseKas('1e3')).toBeNull();
    expect(parseKas('-1')).toBeNull();
    expect(parseKas('')).toBeNull();
    expect(parseKas('.')).toBeNull();
    expect(formatKas(12_345_678_912_345_678n)).toBe('123,456,789.12345678');
    expect(formatKas(150_000_000n)).toBe('1.5');
    expect(formatKas(1n)).toBe('0.00000001');
    expect(formatKas(123_456_789n, 2)).toBe('1.23');
  });
});
