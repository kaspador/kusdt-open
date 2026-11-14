// Node entry: loads the WebAssembly module synchronously.
import { createRequire } from 'node:module';
import { makeCore, type CoreModule } from './core';

const require = createRequire(import.meta.url);
const module = require('../pkg-node/kusdt_wasm.js') as CoreModule;

export const core = makeCore(module);
export * from './core';
