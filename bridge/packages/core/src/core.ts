// Typed access to the WebAssembly command API (bridge/kaspa/src/api.rs).
// Every command takes a JSON request and answers JSON; big integers stay
// exact (they are parsed as strings when they would not fit a JS number).

import { parseExactJson, stringifyExact } from './exactJson';

export interface CoreModule {
  run(command: string, request: string): string;
  commands(): string;
  version(): string;
}

export class CoreError extends Error {
  constructor(readonly command: string, message: string) { super(`${command}: ${message}`); }
}

/** Serializes a request; BigInt values become exact JSON integers. */
export function requestJson(request: unknown): string {
  return stringifyExact(request) ?? 'null';
}

/** JSON.parse that keeps 16+ digit integers exact, as strings. */
export function parseAnswer(text: string): any {
  return parseExactJson(text);
}

export interface Answer<T = any> { value: T; raw: string }

export function makeCore(module: CoreModule) {
  const call = <T = any>(command: string, request: unknown = {}): Answer<T> => {
    const raw = module.run(command, typeof request === 'string' ? request : requestJson(request));
    const value = parseAnswer(raw);
    if (value && typeof value === 'object' && 'error' in value && Object.keys(value).length === 1) throw new CoreError(command, String(value.error));
    return { value, raw };
  };
  return {
    call,
    commands: (): string[] => JSON.parse(module.commands()),
    version: () => module.version(),
  };
}

export type Core = ReturnType<typeof makeCore>;
