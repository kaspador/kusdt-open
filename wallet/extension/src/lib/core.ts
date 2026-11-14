// The kUSDT WebAssembly core (bridge/packages/core): every covenant
// transaction (version 1) is built and signed by it, never by hand. Loaded
// once, on first use. Tests and the integration run hand in the Node build.

import { loadCore, type Core } from '@kusdt/core/web';
import wasmUrl from '@kusdt/core-wasm?url';

export type { Core };

let loader: () => Promise<Core> = () => loadCore(wasmUrl);
let loaded: Promise<Core> | null = null;

export function getCore(): Promise<Core> {
  loaded ??= loader().catch((e) => { loaded = null; throw e; });
  return loaded;
}

/** Replace the loader (tests: the Node build of the same module). */
export function setCoreLoader(fn: () => Promise<Core> | Core): void {
  loader = async () => fn();
  loaded = null;
}
