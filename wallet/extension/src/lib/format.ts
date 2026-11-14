// Amounts for people: exact integer ⇄ decimal text, never through floats.

export function formatUnits(v: bigint, decimals: number, maxFrac = decimals): string {
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toLocaleString('en-US');
  let frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  if (!frac && v > 0n && v < base && maxFrac < decimals && v % base !== 0n && whole === '0') frac = '0'.repeat(Math.max(0, maxFrac - 1)) + '1';
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** "12.5" → integer with `decimals`, exactly; null for anything else (and more decimals than allowed). */
export function parseUnits(s: string, decimals: number): bigint | null {
  const m = /^(\d{1,15})(?:[.,](\d*))?$/.exec(s.trim());
  if (!m || (m[2] && m[2].length > decimals)) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
}

export const fmtKas = (sompi: bigint, maxFrac = 8) => formatUnits(sompi, 8, maxFrac);
export const fmtUsdt = (units: bigint, maxFrac = 6) => formatUnits(units, 6, maxFrac);
/** A dollar amount as people read one: two decimals ("125.50", "0.00"), cut as formatUnits cuts (a dust amount shows as 0.01, not 0). */
export const fmtUsdt2 = (units: bigint): string => {
  const [whole, frac = ''] = fmtUsdt(units, 2).split('.');
  return `${whole}.${frac.padEnd(2, '0')}`;
};
/** KAS on a balance line: up to 4 decimals, at least 2 ("478.4467", "500.00"). */
export const fmtKasBalance = (sompi: bigint): string => {
  const [whole, frac = ''] = fmtKas(sompi, 4).split('.');
  return `${whole}.${frac.padEnd(2, '0')}`;
};
/** For an input field: no thousands separators. */
export const plain = (s: string) => s.replace(/,/g, '');
export const parseKasText = (s: string) => parseUnits(s, 8);
export const parseUsdtText = (s: string) => parseUnits(s, 6);

export const shortAddr = (a: string, keep = 8): string => {
  const i = a.indexOf(':');
  const body = i >= 0 ? a.slice(i + 1) : a;
  const head = i >= 0 ? a.slice(0, i + 1) : '';
  return body.length <= keep * 2 + 1 ? a : `${head}${body.slice(0, keep)}…${body.slice(-keep)}`;
};

export const shortHash = (h: string) => (h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h);

/**
 * A server's own words, for a message that says whose they are (run 21 round 2, R21-W2-5): in quotes, cut to `max`
 * characters, on one line, and without the characters that change the direction text is read in (they can make it
 * read as something else). A coordinator or an RPC could otherwise put any text, at any length, in the wallet's own
 * windows as if the wallet said it.
 */
export function quoted(text: string, max = 200): string {
  const plain = text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  return `"${plain.length > max ? `${plain.slice(0, max)}…` : plain}"`;
}
