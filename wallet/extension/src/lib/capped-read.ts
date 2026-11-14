// Reading an HTTP answer with a limit on its size (round 14, R14-CL-2).
//
// The wallet and the web app read the coordinator's answers, the EVM RPCs' and their own config whole (text(), json())
// before looking at them: a server that answered hundreds of megabytes within the request's time filled the popup's,
// the background's or the page's memory, and the KAS side and Settings went down with kUSDT. The services read
// through a capped reader since round 10 (bridge/services/src/shared/capped-fetch.ts); this is the same for fetch.
// A browser inflates a compressed answer itself and a page can't ask for it uncompressed, so what is counted here is
// what is held: the bytes after inflating. Reading stops past the limit, and the answer counts as no answer.
// The web app uses this file too (by path, as it does the wallet's engine).

/** An answer longer than the limit: not read to the end, and not used. */
export class AnswerTooLong extends Error {
  constructor(readonly maxBytes: number) { super(`The answer is longer than ${maxBytes} bytes: refused.`); }
}

/** The coordinator's (and the monitor's) largest answers: 500 token states, 1,000 deposits. A few MB at most. */
export const MAX_API_ANSWER_BYTES = 8_000_000;
/** One JSON-RPC answer other than a log scan: a receipt, a block without its transactions, a call. */
export const MAX_RPC_ANSWER_BYTES = 4_000_000;
/** An eth_getLogs answer, as the services allow one (MAX_RPC_ANSWER_BYTES there). */
export const MAX_LOGS_ANSWER_BYTES = 16_000_000;
/** A small answer: a config file, a faucet's, a price, a block number. */
export const MAX_SMALL_ANSWER_BYTES = 1_000_000;

/** The answer's body as text, never more than `maxBytes` of it: past that the read is stopped and AnswerTooLong thrown. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const told = Number(res.headers?.get('content-length') ?? NaN);
  if (told > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new AnswerTooLong(maxBytes);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AnswerTooLong(maxBytes);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** readCapped, then JSON.parse; a body that is not JSON is null (as `res.json().catch(() => null)` was). */
export async function readCappedJson(res: Response, maxBytes: number): Promise<unknown> {
  const text = await readCapped(res, maxBytes);
  try { return JSON.parse(text); } catch { return null; }
}
