// Dark (the default, as on the site), light, or the system's setting. Kept in the extension's
// own localStorage so the popup and the approval window read it before they
// draw (no flash of the wrong theme); it is a display preference, nothing more.

export type Theme = 'system' | 'light' | 'dark';
export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];
const KEY = 'kusdt.theme';

export function storedTheme(): Theme {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'system' ? v : 'dark'; } catch { return 'system'; }
}

const systemDark = () => !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export function applyTheme(t: Theme = storedTheme()): void {
  document.documentElement.classList.toggle('dark', t === 'dark' || (t === 'system' && systemDark()));
}

export function setTheme(t: Theme): void {
  try { localStorage.setItem(KEY, t); } catch { /* private mode */ }
  applyTheme(t);
}

/** Applies the theme now, and again when the system's setting or another wallet window changes it. */
export function followTheme(): void {
  applyTheme();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme());
  window.addEventListener('storage', (e) => { if (e.key === KEY) applyTheme(); });
}
