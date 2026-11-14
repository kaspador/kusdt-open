// JSON with exact integers. JS numbers round above 2^53, so a value of 16 or more
// digits reads as a string and writes as bare digits, and nothing here can be
// confused with what a string holds.
//
// The same file lives in packages/core/src and packages/kaspa/src, which depend on
// nothing and on each other not at all; a test in packages/kaspa keeps them identical.

/** The most digits kept as an exact integer: a uint256. Past it the text itself stays, which BigInt refuses. */
const MAX_INTEGER_DIGITS = 78;

/**
 * What a JSON number must read as to stay exact, in whichever notation it came:
 * 12345678901234567, 12345678901234567.0 and 1.2345678901234567e16 are the same
 * integer. null: leave it a number (15 digits or fewer, a real fraction, or not a
 * JSON number at all, which JSON.parse then refuses).
 */
function exactInteger(token: string): string | null {
  const m = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!m) return null;
  const digits = m[2] + (m[3] ?? '');
  const point = m[2].length + (m[4] ? Number(m[4]) : 0);
  const first = digits.search(/[1-9]/);
  if (first < 0) return null; // zero
  if (digits.slice(Math.max(point, 0)).search(/[1-9]/) >= 0) return null; // a fraction: nothing in the protocol is one
  const count = point - first;
  if (count < 16) return null;
  if (count > MAX_INTEGER_DIGITS) return token;
  return m[1] + digits.slice(first, point).padEnd(count, '0');
}

/** The text with every number that must stay exact quoted. It walks JSON's own structure: a string's contents are never touched. */
function quoteLargeIntegers(text: string): string {
  let out = '';
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 34) { // a string: to its closing quote, past escapes
      i++;
      while (i < text.length && text.charCodeAt(i) !== 34) i += text.charCodeAt(i) === 92 ? 2 : 1;
      i++;
    } else if (c === 45 || (c >= 48 && c <= 57)) { // a number: all of it, fraction and exponent included
      const start = i;
      i++;
      for (; i < text.length; i++) {
        const d = text.charCodeAt(i);
        if (!((d >= 48 && d <= 57) || d === 46 || d === 101 || d === 69 || d === 43 || d === 45)) break;
      }
      const exact = exactInteger(text.slice(start, i));
      if (exact !== null) {
        out += text.slice(copied, start) + '"' + exact + '"';
        copied = i;
      }
    } else i++;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** JSON.parse that keeps every integer of 16 or more digits exact, as a string. */
export function parseExactJson(text: string): any {
  return JSON.parse(quoteLargeIntegers(text));
}

/** JSON.stringify that writes BigInt values as exact JSON integers, with no marker a string could also hold. */
export function stringifyExact(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const toJson = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJson === 'function') return stringifyExact(toJson.call(value));
  if (Array.isArray(value)) return `[${value.map((v) => stringifyExact(v) ?? 'null').join(',')}]`;
  const fields: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const written = stringifyExact(v);
    if (written !== undefined) fields.push(`${JSON.stringify(k)}:${written}`);
  }
  return `{${fields.join(',')}}`;
}
