// A form whose action takes a while and signs more than once (approve, then
// deposit; merge, then swap) is locked while it runs: its inputs are disabled,
// and right before every signature what it shows is compared with what was
// clicked. Changed all the same, or left for another screen: nothing more is signed.

import { useEffect, useRef } from 'react';
import type { Signer } from '@/kusdt/types';

export const FORM_CHANGED = 'The form changed while this was running, so nothing more was signed. Check it and try again.';
export class FormChanged extends Error {
  constructor() { super(FORM_CHANGED); }
}

/** Whether two looks at a form show the same values. */
export function sameForm<T extends Record<string, unknown>>(a: T, b: T): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => a[k] === b[k]);
}

/** A signer that hands out no key once `unchanged` says no: every transaction the wallet builds asks it for its keys first. */
export function guardedSigner(signer: Signer, unchanged: () => boolean): Signer {
  return {
    address: signer.address,
    ownerHex: signer.ownerHex,
    secretFor(address: string) {
      if (!unchanged()) throw new FormChanged();
      return signer.secretFor(address);
    },
  };
}

/**
 * For a form showing `form` (its values as rendered now). Called at the click, it answers a check to make before each
 * signature: whether the form is still on screen and still shows what was clicked.
 */
export function useFormLock<T extends Record<string, unknown>>(form: T): () => () => boolean {
  const shown = useRef(form);
  shown.current = form;
  const onScreen = useRef(true);
  useEffect(() => { onScreen.current = true; return () => { onScreen.current = false; }; }, []);
  return () => {
    const clicked = shown.current;
    return () => onScreen.current && sameForm(shown.current, clicked);
  };
}
