// A small DOM for rendering the wallet's real screens in Node (these tests have
// no browser and no jsdom): elements, text, attributes and events, enough for
// react-dom. It installs itself when imported; react-dom must load after that,
// which mount() sees to.

import type { ReactElement } from 'react';

type Listener = (event: any) => void;
type Options = boolean | { capture?: boolean };
const capturing = (o?: Options) => (typeof o === 'object' ? !!o.capture : !!o);

class Target {
  private listeners = new Map<string, { fn: Listener; capture: boolean }[]>();
  addEventListener(type: string, fn: Listener, o?: Options) {
    const list = this.listeners.get(type) ?? [];
    if (!list.some(l => l.fn === fn && l.capture === capturing(o))) list.push({ fn, capture: capturing(o) });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener, o?: Options) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(l => !(l.fn === fn && l.capture === capturing(o))));
  }
  run(event: { type: string }, capture: boolean) {
    for (const l of [...(this.listeners.get(event.type) ?? [])]) if (l.capture === capture) l.fn.call(this, event);
  }
}

export class FakeNode extends Target {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  constructor(readonly nodeType: number, readonly nodeName: string, public ownerDocument: FakeDocument | null, public nodeValue: string | null = null) { super(); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  private sibling(d: number): FakeNode | null { const all = this.parentNode?.childNodes; return all ? all[all.indexOf(this) + d] ?? null : null; }
  get nextSibling(): FakeNode | null { return this.sibling(1); }
  get previousSibling(): FakeNode | null { return this.sibling(-1); }
  appendChild<T extends FakeNode>(c: T): T { return this.insertBefore(c, null); }
  insertBefore<T extends FakeNode>(c: T, ref: FakeNode | null): T {
    c.parentNode?.removeChild(c);
    this.childNodes.splice(ref ? this.childNodes.indexOf(ref) : this.childNodes.length, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild<T extends FakeNode>(c: T): T { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
  contains(n: FakeNode | null): boolean { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }
  get textContent(): string { return this.nodeType === 3 ? this.nodeValue ?? '' : this.childNodes.map(c => c.textContent).join(''); }
  set textContent(v: string) {
    if (this.nodeType === 3) { this.nodeValue = v; return; }
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (v) this.appendChild(new FakeNode(3, '#text', this.ownerDocument, v));
  }
}

export class FakeElement extends FakeNode {
  readonly style = { setProperty() {} };
  private attrs = new Map<string, string>();
  private current = '';
  private on = false;
  // What react-dom sets on form controls.
  name = '';
  defaultValue = '';
  defaultChecked = false;
  constructor(readonly tagName: string, doc: FakeDocument | null, readonly namespaceURI: string) { super(1, tagName, doc); }
  setAttribute(n: string, v: unknown) { this.attrs.set(n, String(v)); }
  setAttributeNS(_ns: string, n: string, v: unknown) { this.attrs.set(n, String(v)); }
  removeAttribute(n: string) { this.attrs.delete(n); }
  removeAttributeNS(_ns: string, n: string) { this.attrs.delete(n); }
  getAttribute(n: string) { return this.attrs.get(n) ?? null; }
  hasAttribute(n: string) { return this.attrs.has(n); }
  get value() { return this.current; }
  set value(v: string) { this.current = String(v); }
  get checked() { return this.on; }
  set checked(v: boolean) { this.on = !!v; }
  get type() { return this.attrs.get('type') ?? (this.nodeName === 'INPUT' ? 'text' : ''); }
  set type(v: string) { this.attrs.set('type', v); }
  get disabled() { return this.attrs.has('disabled'); }
}

const XHTML = 'http://www.w3.org/1999/xhtml';

export class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement;
  /** react-dom looks for this to know the input event exists. */
  oninput = null;
  visibilityState = 'visible';
  focused = true;
  constructor() {
    super(9, '#document', null);
    this.documentElement = this.appendChild(this.createElement('html'));
    this.body = this.documentElement.appendChild(this.createElement('body'));
    this.activeElement = this.body;
  }
  createElement(t: string) { return new FakeElement(t.toUpperCase(), this, XHTML); }
  createElementNS(ns: string, t: string) { return new FakeElement(t, this, ns); }
  createTextNode(v: string) { return new FakeNode(3, '#text', this, v); }
  hasFocus() { return this.focused; }
}

export const fakeDocument = new FakeDocument();
// No dispatchEvent: react-dom then calls handlers directly, without its fake-event trick.
export const fakeWindow = Object.assign(new Target(), {
  document: fakeDocument, location: { hash: '' }, top: {}, self: null as unknown,
  HTMLIFrameElement: class {}, close() {},
});
fakeWindow.self = fakeWindow;
Object.assign(globalThis, { window: fakeWindow, document: fakeDocument, location: fakeWindow.location });

/** Fires an event at `target`, in the DOM's order: capture from the window down, then bubbling back up. */
export function fire(target: FakeNode | typeof fakeWindow, type: string, init: Record<string, unknown> = {}) {
  const event: any = {
    type, target, bubbles: true, cancelable: true, defaultPrevented: false, timeStamp: Date.now(), isTrusted: true, eventPhase: 0, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init,
  };
  const path: Target[] = [];
  for (let n: any = target; n; n = n.parentNode) path.push(n);
  if (target !== fakeWindow) path.push(fakeWindow);
  for (const n of [...path].reverse()) { if (event.stopped) return; n.run(event, true); }
  for (const n of event.bubbles ? path : path.slice(0, 1)) { if (event.stopped) return; n.run(event, false); }
}

export interface Mounted { root: FakeElement; unmount: () => void }

const live: (() => void)[] = [];

/** Renders into a new element of the fake document. */
export async function mount(ui: ReactElement): Promise<Mounted> {
  const { createRoot } = await import('react-dom/client');
  const el = fakeDocument.body.appendChild(fakeDocument.createElement('div'));
  const root = createRoot(el as unknown as Element);
  root.render(ui);
  await flush();
  const unmount = () => { root.unmount(); if (el.parentNode) fakeDocument.body.removeChild(el); };
  live.push(unmount);
  return { root: el, unmount };
}

/** Unmounts what is left mounted (afterEach). */
export const cleanup = () => { for (const u of live.splice(0)) { try { u(); } catch { /* unmounted already */ } } };

const turn = () => new Promise<void>(r => setImmediate(r));

/** Lets React finish its work (never timers: it uses setImmediate here, so this works under fake timers). */
export async function flush(turns = 25): Promise<void> { for (let i = 0; i < turns; i++) await turn(); }

export async function until(what: string, ok: () => unknown, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (ok()) return;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await turn();
  }
}

export const elements = (root: FakeNode): FakeElement[] => root.childNodes.flatMap(c => (c instanceof FakeElement ? [c, ...elements(c)] : []));
const hits = (want: string | RegExp, s: string) => (typeof want === 'string' ? s === want : want.test(s));
const labelOf = (e: FakeElement) => e.getAttribute('aria-label') ?? e.textContent.trim();

export const findButton = (root: FakeNode, name: string | RegExp) => elements(root).find(e => e.nodeName === 'BUTTON' && hits(name, labelOf(e)));
export function button(root: FakeNode, name: string | RegExp): FakeElement {
  const b = findButton(root, name);
  if (!b) throw new Error(`No button ${name}. Shown: ${root.textContent}`);
  return b;
}
export function field(root: FakeNode, name: string | RegExp): FakeElement {
  const f = elements(root).find(e => (e.nodeName === 'INPUT' || e.nodeName === 'TEXTAREA') && hits(name, e.getAttribute('aria-label') ?? e.getAttribute('placeholder') ?? ''));
  if (!f) throw new Error(`No field ${name}.`);
  return f;
}
export const checkbox = (root: FakeNode) => elements(root).find(e => e.nodeName === 'INPUT' && e.type === 'checkbox')!;

const setter = (name: 'value' | 'checked') => Object.getOwnPropertyDescriptor(FakeElement.prototype, name)!.set!;

/** What typing does: the value changes behind React's back, then an input event. */
export async function typeIn(el: FakeElement, value: string) { setter('value').call(el, value); fire(el, 'input'); await flush(); }
/** A click, as the browser delivers one: never to a disabled control (react-dom holds it back). */
export async function click(el: FakeElement) { fire(el, 'click'); await flush(); }
export async function toggle(el: FakeElement) { setter('checked').call(el, !el.checked); fire(el, 'click'); await flush(); }
/** Runs an element's own click handler, as if it had slipped past `disabled`. */
export async function forceClick(el: FakeElement) {
  const key = Object.keys(el).find(k => k.startsWith('__reactProps$'))!;
  (el as unknown as Record<string, { onClick: () => void }>)[key].onClick();
  await flush();
}
