/**
 * Permalinks (doc 07 §UX): the *options* — never the image — serialize into the
 * URL hash, so a link shares a setup without uploading anything anywhere.
 *
 * Only non-default fields are written, which keeps a shared link readable and
 * means a future default change doesn't silently pin the old one.
 */

import { DEFAULT_OPTIONS } from "./options.js";
import type { PrepOptionsUi } from "../worker/protocol.js";

type Key = keyof PrepOptionsUi;

const KEYS: Key[] = Object.keys(DEFAULT_OPTIONS) as Key[];

/** Serialize non-default options into a `#a=b&c=d` hash fragment. */
export function toHash(ui: PrepOptionsUi): string {
  const params = new URLSearchParams();
  for (const key of KEYS) {
    const value = ui[key];
    if (value === DEFAULT_OPTIONS[key]) continue;
    params.set(key, typeof value === "boolean" ? "1" : String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `#${text}`;
}

/** Parse a hash fragment back into a full option record (defaults fill gaps). */
export function fromHash(hash: string): PrepOptionsUi {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const ui: PrepOptionsUi = { ...DEFAULT_OPTIONS };
  for (const key of KEYS) {
    const raw = params.get(key);
    if (raw === null) continue;
    const fallback = DEFAULT_OPTIONS[key];
    if (typeof fallback === "boolean") {
      (ui[key] as boolean) = raw === "1" || raw === "true";
    } else {
      (ui[key] as string) = raw;
    }
  }
  return ui;
}
