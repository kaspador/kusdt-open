/// <reference types="chrome" />
// chrome.storage, with an in-memory stand-in where it doesn't exist (tests and
// the integration run). `local` survives restarts; `session` is memory only and
// is cleared when the browser closes or the wallet locks.

type Area = {
  get<T>(key: string): Promise<T | undefined>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(...keys: string[]): Promise<void>;
};

function memoryArea(): Area {
  const m = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return m.get(key) as T | undefined; },
    async set(values) { for (const [k, v] of Object.entries(values)) m.set(k, structuredClone(v)); },
    async remove(...keys) { for (const k of keys) m.delete(k); },
  };
}

function chromeArea(name: 'local' | 'session'): Area | null {
  const c = (globalThis as { chrome?: typeof chrome }).chrome;
  const area = c?.storage?.[name];
  if (!area) return null;
  return {
    get: <T>(key: string) => new Promise<T | undefined>(r => area.get([key], v => r(v?.[key] as T | undefined))),
    set: (values) => new Promise<void>(r => area.set(values, () => r())),
    remove: (...keys) => new Promise<void>(r => area.remove(keys, () => r())),
  };
}

export const local: Area = chromeArea('local') ?? memoryArea();
export const session: Area = chromeArea('session') ?? memoryArea();
