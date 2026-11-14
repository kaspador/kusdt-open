import { describe, expect, it } from 'vitest';
import { open, seal } from '@/keys/crypto';
import { createVault, openVault, changePassword, hasVault } from '@/keys/vault';
import { newMnemonic } from '@/keys/derive';

describe('the vault', () => {
  it('seals and opens; a wrong password or a changed box opens nothing', async () => {
    const box = await seal('secret words', 'correct horse', 100_000);
    expect(await open(box, 'correct horse')).toBe('secret words');
    expect(await open(box, 'wrong')).toBeNull();
    expect(await open({ ...box, ct: box.ct.replace(/^./, c => (c === 'A' ? 'B' : 'A')) }, 'correct horse')).toBeNull();
  });

  it('keeps the phrase only sealed, and changes the password', async () => {
    const m = newMnemonic();
    await expect(createVault(m, 'short')).rejects.toThrow();
    await createVault(m, 'a long password');
    expect(await hasVault()).toBe(true);
    expect(await openVault('a long password')).toBe(m);
    expect(await openVault('another one')).toBeNull();
    expect(await changePassword('a long password', 'the new password')).toBe(true);
    expect(await openVault('the new password')).toBe(m);
  }, 60_000);
});
