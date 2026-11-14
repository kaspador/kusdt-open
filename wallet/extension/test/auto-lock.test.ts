// "Lock when the popup closes" can't rely on the service worker being awake when the popup closes (round 2 of the attack review):
// a repeating alarm looks for an open wallet page. A setting changed while unlocked applies at once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOLOCK_ALARM, CLOSE_CHECK_ALARM, SESSION_KEY, lock, lockIfNoPageOpen, rearmAutoLock, unlockWith } from '@/keys/session';
import { local, session } from '@/lib/storage';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let alarms: Map<string, unknown>;

beforeEach(() => {
  alarms = new Map();
  (globalThis as any).chrome = {
    ...(globalThis as any).chrome,
    alarms: { clear: vi.fn(async (name: string) => alarms.delete(name)), create: vi.fn((name: string, info: unknown) => { alarms.set(name, info); }) },
  };
});
afterEach(async () => { await lock(); await local.remove('kusdt.settings'); });

const setting = (autoLockMins: number) => local.set({ 'kusdt.settings': { autoLockMins } });

describe('auto-lock', () => {
  it('"when the popup closes" keeps a repeating check, and no timer', async () => {
    await setting(0);
    await unlockWith(PHRASE);
    expect(alarms.get(CLOSE_CHECK_ALARM)).toEqual({ periodInMinutes: 1 });
    expect(alarms.has(AUTOLOCK_ALARM)).toBe(false);
  });

  it('a time keeps its timer and no check', async () => {
    await setting(15);
    await unlockWith(PHRASE);
    expect(alarms.get(AUTOLOCK_ALARM)).toEqual({ delayInMinutes: 15 });
    expect(alarms.has(CLOSE_CHECK_ALARM)).toBe(false);
  });

  it('a setting changed while unlocked applies at once', async () => {
    await setting(0);
    await unlockWith(PHRASE);
    await setting(5);
    await rearmAutoLock();
    expect(alarms.get(AUTOLOCK_ALARM)).toEqual({ delayInMinutes: 5 });
    expect(alarms.has(CLOSE_CHECK_ALARM)).toBe(false);
  });

  it('changing it while locked arms nothing', async () => {
    await setting(5);
    await rearmAutoLock();
    expect(alarms.size).toBe(0);
  });

  it('the check locks when no wallet page is open, and leaves an open one alone', async () => {
    await setting(0);
    await unlockWith(PHRASE);
    await lockIfNoPageOpen(async () => true);
    expect(await session.get(SESSION_KEY)).toBe(PHRASE);
    await lockIfNoPageOpen(async () => false);
    expect(await session.get(SESSION_KEY)).toBeFalsy();
    expect(alarms.has(CLOSE_CHECK_ALARM)).toBe(false);
  });

  it('a check that can not answer locks', async () => {
    await setting(0);
    await unlockWith(PHRASE);
    await lockIfNoPageOpen(async () => { throw new Error('no API'); });
    expect(await session.get(SESSION_KEY)).toBeFalsy();
  });

  it('locking by hand clears both alarms', async () => {
    await setting(0);
    await unlockWith(PHRASE);
    await lock();
    expect(alarms.size).toBe(0);
  });
});
