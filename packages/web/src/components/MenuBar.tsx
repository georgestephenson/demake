/**
 * The workbench's menu bar (doc 07 §The workbench).
 *
 * It replaces the row of section tabs the site used to navigate with. The tabs
 * had become redundant the moment the explorer started deciding what is open
 * (doc 19 §The shell) — a tab and a file selection are two answers to one
 * question, and the file is the better one because it is the thing the project
 * actually contains. What the tabs were *also* doing was carrying the commands
 * (open a folder, save, export a zip), and those are what a menu bar is for.
 *
 * **The accelerator and the menu entry are one declaration.** {@link useMenuKeys}
 * binds exactly what {@link MenuBar} draws, walking the same array, so a menu
 * that says `Ctrl+S` is a key that saves. A second table of shortcuts is how a
 * menu comes to advertise a binding nothing listens for — the same reason the
 * CLI's flags are generated from one spec (doc 05) and the highlighter's words
 * come from the language registry.
 *
 * `Mod` is the platform's own modifier: ⌘ on a Mac and Ctrl everywhere else,
 * decided once here and never at a call site.
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

/** One command in a menu. */
export interface MenuItem {
  label: string;
  /**
   * The accelerator, written portably: `Mod+S`, `Shift+Mod+S`, `F2`.
   *
   * `Mod` is ⌘ on a Mac and Ctrl elsewhere, so a binding is declared once and
   * shown correctly on both.
   */
  key?: string;
  run?: () => void;
  disabled?: boolean;
  /**
   * The platform already provides this key, so the menu shows it and
   * {@link useMenuKeys} leaves it alone.
   *
   * Undo and redo are the case: a `<textarea>`'s own ⌘Z is the *native* undo
   * stack, which is the one the user has been filling by typing, and
   * intercepting the key to call `execCommand` for the same effect is a way to
   * get it subtly wrong for nothing. The entry stays because a menu bar that
   * omits Undo reads as an editor that has none.
   */
  native?: boolean;
  /** Checked state, for the entries that toggle something. */
  checked?: boolean;
  /**
   * A file this entry picks instead of a command it runs.
   *
   * Reading a file needs a real `<input type="file">` — a click a script
   * synthesises does not open a picker in every browser — so the entry becomes
   * one, styled as a menu row.
   */
  file?: { accept: string; onPick: (file: File) => void };
  testId?: string;
}

/** A rule between groups of commands. */
export type MenuEntry = MenuItem | "separator";

/** One top-level menu. */
export interface Menu {
  label: string;
  items: readonly MenuEntry[];
}

/** True on a platform whose primary modifier is ⌘. */
function isApple(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** An accelerator as this platform writes it. */
export function accelerator(key: string): string {
  return isApple()
    ? key.replace("Mod+", "⌘").replace("Shift+", "⇧").replace("Alt+", "⌥")
    : key.replace("Mod+", "Ctrl+");
}

/** Whether a keydown is this accelerator. */
function matches(key: string, event: KeyboardEvent): boolean {
  const parts = key.split("+");
  const wanted = (parts[parts.length - 1] as string).toLowerCase();
  const mod = parts.includes("Mod");
  const shift = parts.includes("Shift");
  const alt = parts.includes("Alt");
  if (mod !== (isApple() ? event.metaKey : event.ctrlKey)) return false;
  // The *other* modifier must be clear, or Ctrl+S on a Mac would fire ⌘S.
  if ((isApple() ? event.ctrlKey : event.metaKey) && mod) return false;
  if (shift !== event.shiftKey || alt !== event.altKey) return false;
  return event.key.toLowerCase() === wanted;
}

/** Every runnable item in a menu list, flattened. */
function commands(menus: readonly Menu[]): MenuItem[] {
  return menus.flatMap((menu) =>
    menu.items.filter((item): item is MenuItem => item !== "separator"),
  );
}

/**
 * Bind the accelerators the menus declare.
 *
 * Bindings fire wherever focus is, including inside the source editor, because
 * that is what a workbench shortcut means — ⌘S saves the project whatever you
 * were typing into. Only the entries that carry both a key and a command are
 * bound; a disabled one is not, and neither is one marked `native`.
 *
 * **Which is why two commands here carry no accelerator at all.** ⌘N is the
 * browser's new window and cannot be prevented, and a key that means something
 * inside a text box — ⌘⌫ deletes the previous word — must not be taken over by
 * a command with no undo behind it. A menu that advertised either would be
 * advertising a shortcut nothing listens for, which is the exact failure this
 * one-declaration arrangement exists to make impossible.
 */
export function useMenuKeys(menus: readonly Menu[]): void {
  const latest = useRef(menus);
  latest.current = menus;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      for (const item of commands(latest.current)) {
        if (item.key === undefined || item.run === undefined || item.disabled) continue;
        if (item.native === true) continue;
        if (!matches(item.key, event)) continue;
        event.preventDefault();
        item.run();
        return;
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
}

export function MenuBar({ menus }: { menus: readonly Menu[] }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);

  // A menu closes on Escape and on anything outside it, which is the behaviour
  // every menu bar has and the one nobody notices until it is missing.
  useEffect(() => {
    if (open === null) return;
    const away = (event: Event): void => {
      if (!bar.current?.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(null);
    };
    addEventListener("pointerdown", away);
    addEventListener("keydown", escape);
    return () => {
      removeEventListener("pointerdown", away);
      removeEventListener("keydown", escape);
    };
  }, [open]);

  const choose = useCallback((item: MenuItem) => {
    if (item.disabled || !item.run) return;
    setOpen(null);
    item.run();
  }, []);

  return (
    <div class="menubar" ref={bar} role="menubar">
      {menus.map((menu) => (
        <div key={menu.label} class="menu">
          <button
            type="button"
            class={`menu-title${open === menu.label ? " open" : ""}`}
            role="menuitem"
            aria-haspopup="true"
            aria-expanded={open === menu.label}
            data-testid={`menu-${menu.label.toLowerCase()}`}
            onClick={() => setOpen((current) => (current === menu.label ? null : menu.label))}
            // Once one menu is open, pointing at another switches to it — the
            // one interaction that makes a menu bar feel like a menu bar.
            onPointerEnter={() => setOpen((current) => (current === null ? null : menu.label))}
          >
            {menu.label}
          </button>
          {open === menu.label ? (
            <div class="menu-list" role="menu" aria-label={menu.label}>
              {menu.items.map((item, index) =>
                item === "separator" ? (
                  <hr key={index} class="menu-separator" />
                ) : item.file ? (
                  <label key={index} class="menu-item" role="menuitem">
                    <span>{item.label}</span>
                    <input
                      type="file"
                      accept={item.file.accept}
                      {...(item.testId === undefined ? {} : { "data-testid": item.testId })}
                      onChange={(event) => {
                        const input = event.currentTarget as HTMLInputElement;
                        const picked = input.files?.[0];
                        input.value = "";
                        setOpen(null);
                        if (picked) item.file?.onPick(picked);
                      }}
                    />
                  </label>
                ) : (
                  <button
                    key={index}
                    type="button"
                    class="menu-item"
                    role="menuitem"
                    disabled={item.disabled === true || item.run === undefined}
                    {...(item.testId === undefined ? {} : { "data-testid": item.testId })}
                    onClick={() => choose(item)}
                  >
                    <span>
                      {item.checked === true ? "✓ " : ""}
                      {item.label}
                    </span>
                    {item.key ? <kbd>{accelerator(item.key)}</kbd> : null}
                  </button>
                ),
              )}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
