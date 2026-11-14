// Offline transaction chains for tests: every builder runs through the core
// (the same code the wallet and the services call), on made-up funding coins,
// so tests can follow real covenant transactions without a node.

import { schnorr } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { core } from '@kusdt/core';
import { bytesToHex, encodeKaspaAddress, hexToBytes } from '@kusdt/kaspa';

export const KAS = 100_000_000n;
export const TOKEN_VALUE = 150_000_000n;
export const POSITION_VALUE = 200_000_000n;

export const secret = (seed: string) => blake2b(new TextEncoder().encode(seed), { dkLen: 32 });
export const xonly = (s: Uint8Array) => bytesToHex(schnorr.getPublicKey(s));
export const address = (s: Uint8Array) => encodeKaspaAddress('kaspasim', 0, schnorr.getPublicKey(s));

/** A launched kUSDT family and pool, with helpers that chain real transactions. */
export function offlineChain(name = 'chain') {
  const payer = secret(`${name}/payer`);
  const signers = [0, 1, 2, 3, 4].map((i) => secret(`${name}/signer-${i}`));
  const guardian = secret(`${name}/guardian`);
  const admin = secret(`${name}/pool-admin`);
  let seed = 0;
  const funding = () => [{
    utxo: { transactionId: (++seed).toString(16).padStart(8, '0') + bytesToHex(blake2b(new TextEncoder().encode(name), { dkLen: 28 })), index: 0, amount: 100_000n * KAS, scriptPublicKey: `000020${xonly(payer)}ac` },
    secretKey: bytesToHex(payer),
  }];
  const common = () => ({ network: 'simnet', changeAddress: address(payer), funding: funding() });
  const { signerSet } = core.call('signer-set', { signerKeys: signers.map(xonly) }).value;
  const genesis = core.call('genesis', {
    ...common(),
    minter: {
      remaining: 1_000_000_000_000_000n, bucket: 500_000_000_000n, capacity: 500_000_000_000n, refillPerDaa: 578_703n,
      nonceEthereum: 0n, nonceBsc: 0n, adminNonce: 0n, paused: false, signerSet, guardian: xonly(guardian),
    },
    minterValue: 5n * KAS, seedOwner: xonly(payer), seedValue: 2n * KAS,
  }).value;
  const covenantId: string = genesis.covenantId;

  /** Output `index` of a built transaction, as the next builder's `Located` input. */
  const at = (built: any, index: number, key: 'minter' | 'token' | 'pool' | 'position', covenant = covenantId) => ({
    utxo: { transactionId: built.txid, index, amount: built.outputs[index].value, scriptPublicKey: built.outputs[index].scriptPublicKey, covenantId: covenant },
    state: built.outputs[index][key],
  });
  let minter = at(genesis, 0, 'minter');

  /** Mints `amounts` (base units) to the holders' keys; answers the built mint. */
  function mint(holders: Uint8Array[], amounts: bigint[]) {
    const recipients = holders.map((h, k) => ({ ownerScheme: 0, owner: xonly(h), amount: amounts[k] }));
    const firstNonce = BigInt(minter.state.nonceEthereum);
    const digest = core.call('mint-digest', { covenantId, chain: 1, firstNonce, recipients }).value.digest;
    const signatures = [0, 2, 4].map((i) => bytesToHex(schnorr.sign(hexToBytes(digest), signers[i])));
    const built = core.call('mint', {
      ...common(), minter, chain: 1, firstNonce, ageDaa: 0, recipients,
      signerKeys: signers.map(xonly), signerIndices: [0, 2, 4], signatures, tokenValue: TOKEN_VALUE,
    }).value;
    minter = at(built, 0, 'minter');
    return built;
  }

  // A breaker of 100 % per window: these chains test following, the breaker's limits are
  // the Rust script-engine tests' (bridge/kaspa/tests/pool.rs).
  const poolGenesis = core.call('pool-genesis', {
    ...common(), tokenCovid: covenantId, baseValue: KAS, admin: xonly(admin), guardian: xonly(guardian), maxOutBps: 10_000, windowLen: 36_000,
  }).value;
  const poolId: string = poolGenesis.covenantId;
  const owned = (located: any, holder: Uint8Array) => ({ ...located, secretKey: bytesToHex(holder) });

  return { payer, signers, guardian, admin, covenantId, poolId, genesis, poolGenesis, common, at, mint, owned, minter: () => minter };
}
