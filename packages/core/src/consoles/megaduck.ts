/**
 * Mega Duck / Cougar Boy (`megaduck`) — doc 03 Tier 3. A Game Boy clone: 160×144,
 * four shades at 2bpp, differing from the DMG only in register layout (a codegen
 * detail). Uses a neutral grey ramp.
 */
import type { ConsoleSpec, RGB8 } from "./types.js";
const RAMP: readonly RGB8[] = [
  { r: 232, g: 232, b: 232 },
  { r: 160, g: 160, b: 160 },
  { r: 84, g: 84, b: 84 },
  { r: 16, g: 16, b: 16 },
];
export const megaduck = {
  id: "megaduck",
  name: "Mega Duck",
  aliases: ["cougar-boy", "mega-duck"],
  tier: 3,
  display: { width: 160, height: 144, pixelAspect: [1, 1] },
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
  codegen: { family: "gb", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["Mega Duck technical notes — GB-clone LCD (4 shades)"] },
} satisfies ConsoleSpec;
