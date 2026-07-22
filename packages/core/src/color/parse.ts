/**
 * Parse user-supplied colors (doc 05 `--background`, `--protect`, `--palette`).
 *
 * Accepts CSS-style hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) and a small
 * set of names. Kept deliberately tiny — the CLI/UI is where richer color input
 * (palette files) is handled; core only needs robust hex parsing.
 */

import { DemakeError } from "../errors.js";

import type { Rgb8 } from "./lattice.js";

const NAMES: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080",
  magenta: "#ff00ff",
  transparent: "#00000000",
};

/** An RGBA color, channels 0–255. */
export interface Rgba8 extends Rgb8 {
  a: number;
}

function hexNibble(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  if (code >= 65 && code <= 70) return code - 55; // A-F
  return -1;
}

/** Parse a color string to RGBA (0–255 per channel). Throws on bad input. */
export function parseColorRgba(input: string): Rgba8 {
  const named = NAMES[input.trim().toLowerCase()];
  const text = (named ?? input).trim();
  if (!text.startsWith("#")) {
    throw new DemakeError("E_INVALID_OPTION", `invalid color '${input}'`, {
      hint: "use hex like #fff, #ffffff, or a name like black/white.",
    });
  }
  const hex = text.slice(1);
  for (const ch of hex) {
    if (hexNibble(ch) < 0) {
      throw new DemakeError("E_INVALID_OPTION", `invalid color '${input}'`, {
        hint: "hex digits only after '#'.",
      });
    }
  }
  const dup = (n: number): number => n * 16 + n;
  if (hex.length === 3 || hex.length === 4) {
    const r = dup(hexNibble(hex[0]!));
    const g = dup(hexNibble(hex[1]!));
    const b = dup(hexNibble(hex[2]!));
    const a = hex.length === 4 ? dup(hexNibble(hex[3]!)) : 255;
    return { r, g, b, a };
  }
  if (hex.length === 6 || hex.length === 8) {
    const byte = (i: number): number => hexNibble(hex[i]!) * 16 + hexNibble(hex[i + 1]!);
    const r = byte(0);
    const g = byte(2);
    const b = byte(4);
    const a = hex.length === 8 ? byte(6) : 255;
    return { r, g, b, a };
  }
  throw new DemakeError("E_INVALID_OPTION", `invalid color '${input}'`, {
    hint: "expected 3, 4, 6, or 8 hex digits.",
  });
}

/** Parse a color string to opaque RGB (0–255), ignoring any alpha. */
export function parseColorRgb(input: string): Rgb8 {
  const { r, g, b } = parseColorRgba(input);
  return { r, g, b };
}
