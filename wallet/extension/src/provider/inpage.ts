// window.kusdt, in the page's own JavaScript world (SPEC §14). Built on its
// own into inpage.js (vite.config.ts) and registered as a MAIN-world content
// script by the background. It holds nothing: every request goes through the
// content script to the wallet, which decides. Keep it free of imports.

(() => {
  const w = window as unknown as { kusdt?: unknown };
  if (w.kusdt) return;
  const TO_CONTENT = 'kusdt-wallet-content';
  const TO_PAGE = 'kusdt-wallet-inpage';
  type Listener = (data: unknown) => void;
  const pending = new Map<string, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  const listeners = new Map<string, Set<Listener>>();

  class ProviderRpcError extends Error {
    constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
  }

  const newId = () => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  };

  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data as { target?: string; id?: string; result?: unknown; error?: { code?: number; message?: string; data?: unknown }; event?: string; data?: unknown } | null;
    if (!d || d.target !== TO_PAGE) return;
    if (typeof d.event === 'string') {
      for (const l of listeners.get(d.event) ?? []) { try { l(d.data); } catch { /* a listener's own error */ } }
      return;
    }
    if (typeof d.id !== 'string') return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    // `data` as the wallet gave it (EIP-1193): { locked: true } says a 4100 is a locked wallet, not a site not connected.
    if (d.error) p.fail(new ProviderRpcError(typeof d.error.code === 'number' ? d.error.code : -32603, String(d.error.message ?? 'kUSDT Wallet error'), d.error.data));
    else p.ok(d.result);
  });

  const provider = Object.freeze({
    isKusdtWallet: true,
    request(args: { method: string; params?: unknown }): Promise<unknown> {
      if (!args || typeof args.method !== 'string') return Promise.reject(new ProviderRpcError(-32602, 'request({ method, params })'));
      const id = newId();
      return new Promise((ok, fail) => {
        pending.set(id, { ok, fail });
        window.postMessage({ target: TO_CONTENT, id, method: args.method, params: args.params ?? {} }, window.location.origin);
      });
    },
    on(event: string, listener: Listener) {
      if (typeof listener !== 'function') return provider;
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return provider;
    },
    removeListener(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return provider;
    },
  });

  Object.defineProperty(window, 'kusdt', { value: provider, writable: false, configurable: false, enumerable: true });
  window.dispatchEvent(new Event('kusdt#initialized'));
})();
