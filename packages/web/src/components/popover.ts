/**
 * Closing a thing that opened over something else.
 *
 * Escape, and a pointer anywhere outside it. That is the behaviour every menu,
 * every picker and every popover has, and the one nobody notices until it is
 * missing — a panel you can only close by finding the control that opened it is
 * a panel people leave open and then work around.
 *
 * It is one definition because it had been written once already, inline in
 * `MenuBar`, and the block editor wanted it twice more. Three copies of "what
 * counts as outside" is three chances for one of them to answer differently,
 * which is the same rule the menu entries and their keybindings already run
 * under (doc 07 §The workbench).
 */

import { useEffect, useRef } from "preact/hooks";

/** Something holding an element, which is what `useRef` gives back. */
interface Held {
  current: HTMLElement | null;
}

/**
 * Close `container` on Escape or on a pointer outside it.
 *
 * The callback is kept in a ref rather than in the effect's dependencies, so a
 * caller does not have to memoise it to avoid resubscribing on every render —
 * which is the sort of requirement that is met for a while and then quietly is
 * not.
 */
export function useDismiss(container: Held, open: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;

  useEffect(() => {
    if (!open) return;
    const away = (event: Event): void => {
      if (!container.current?.contains(event.target as Node)) latest.current();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") latest.current();
    };
    addEventListener("pointerdown", away);
    addEventListener("keydown", escape);
    return () => {
      removeEventListener("pointerdown", away);
      removeEventListener("keydown", escape);
    };
  }, [open, container]);
}
