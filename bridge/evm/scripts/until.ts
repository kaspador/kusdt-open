/**
 * Polls `f` (every 3 s, up to 2 minutes) until it answers something other than false, undefined or null.
 * A receipt that isn't mined yet answers null. A read that fails counts as no answer yet.
 */
export async function until<T>(what: string, f: () => Promise<T | false | undefined | null>, opts: { tries?: number; everyMs?: number } = {}): Promise<T> {
  const tries = opts.tries ?? 40, everyMs = opts.everyMs ?? 3_000;
  for (let i = 0; i < tries; i++) {
    const v = await f().catch(() => undefined);
    if (v !== false && v !== undefined && v !== null) return v as T;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}
