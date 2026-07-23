/**
 * Watara Supervision (`supervision`) — doc 03 Tier 3. 160×160, four grayish
 * shades; a DMG-family mono reuse.
 */
import type { ConsoleSpec, RGB8 } from "./types.js";
const RAMP: readonly RGB8[] = [
  { r: 252, g: 252, b: 252 },
  { r: 168, g: 168, b: 168 },
  { r: 84, g: 84, b: 84 },
  { r: 0, g: 0, b: 0 },
];
export const supervision = {
  id: "supervision",
  name: "Watara Supervision",
  aliases: ["watara", "quickshot-supervision"],
  tier: 3,
  display: { width: 160, height: 160, pixelAspect: [1, 1] },
  color: { model: "mono", shades: 4, dac: { kind: "mono-ramp", shades: RAMP } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 2,
    subPalettes: { count: 1, size: 4 },
    attribute: { w: 8, h: 8 },
    tileBudget: 256,
    flip: false,
  },
  codegen: { family: "mono-misc", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["Supervision technical notes — WDC 65C02 + LCD (4 shades)"] },
} satisfies ConsoleSpec;
