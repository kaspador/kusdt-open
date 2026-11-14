// Password encryption of the recovery phrase (from Pearl Wallet's
// pearl/crypto.ts): PBKDF2-HMAC-SHA256 (600,000 iterations) → AES-256-GCM,
// a random 16-byte salt and 12-byte nonce per box. WebCrypto's PBKDF2 when
// present, @noble/hashes otherwise; both give the same key.

import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';

export const PASSWORD_ITERS = 600_000;
const MIN_ITERS = 100_000;
const MAX_ITERS = 10_000_000;
const KEY_LEN = 32, SALT_LEN = 16, NONCE_LEN = 12;

export interface SealedBox { v: 2; kdf: 'pbkdf2-sha256'; it: number; salt: string; iv: string; ct: string }

async function deriveKey(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const pw = new TextEncoder().encode(secret);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const base = await subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
      const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, KEY_LEN * 8);
      return new Uint8Array(bits);
    } catch { /* the JS implementation below */ }
  }
  return pbkdf2Async(sha256, pw, salt, { c: iterations, dkLen: KEY_LEN });
}

export async function seal(plaintext: string, password: string, iterations = PASSWORD_ITERS): Promise<SealedBox> {
  if (!Number.isInteger(iterations) || iterations < MIN_ITERS || iterations > MAX_ITERS) throw new Error('Invalid key-derivation iteration count.');
  const salt = randomBytes(SALT_LEN), nonce = randomBytes(NONCE_LEN);
  const key = await deriveKey(password, salt, iterations);
  const ct = gcm(key, nonce).encrypt(new TextEncoder().encode(plaintext));
  key.fill(0);
  return { v: 2, kdf: 'pbkdf2-sha256', it: iterations, salt: base64.encode(salt), iv: base64.encode(nonce), ct: base64.encode(ct) };
}

/** The plaintext, or null for a wrong password or a damaged box. */
export async function open(box: SealedBox, password: string): Promise<string | null> {
  if (box?.v !== 2 || box.kdf !== 'pbkdf2-sha256' || !Number.isInteger(box.it) || box.it < MIN_ITERS || box.it > MAX_ITERS) return null;
  try {
    const key = await deriveKey(password, base64.decode(box.salt), box.it);
    try { return new TextDecoder().decode(gcm(key, base64.decode(box.iv)).decrypt(base64.decode(box.ct))); }
    finally { key.fill(0); }
  } catch { return null; }
}
