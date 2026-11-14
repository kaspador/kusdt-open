// Browser and bundler entry: call `loadCore()` once before using it.
import init, * as wasm from '../pkg-web/kusdt_wasm.js';
import { makeCore, type Core } from './core';

let loaded: Promise<Core> | null = null;

export function loadCore(wasmUrl?: string | URL): Promise<Core> {
  loaded ??= init(wasmUrl ? { module_or_path: wasmUrl } : undefined).then(() => makeCore(wasm));
  return loaded;
}
export * from './core';
