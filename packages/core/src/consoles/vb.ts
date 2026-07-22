/**
 * Virtual Boy (`vb`) — doc 03 Tier 3, mono pipeline.
 *
 * 384×224, four **red** shades at 2bpp (the LED display has no other hue). It is
 * the DMG mono path with a red ramp instead of green: luminance mapping with
 * auto-contrast, rendered through the red tint. Index 0 is the brightest shade.
 */

import type { ConsoleSpec, RGB8 } from "./types.js";

/** Virtual Boy red ramp, brightest → darkest. */
const RED_RAMP: readonly RGB8[] = [
  { r: 255, g: 0, b: 0 },
  { r: 170, g: 0, b: 0 },
  { r: 85, g: 0, b: 0 },
  { r: 0, g: 0, b: 0 },
];

export const vb = {
  id: "vb",
  name: "Virtual Boy",
  aliases: ["virtualboy"],
  tier: 3,
  display: { width: 384, height: 224, pixelAspect: [1, 1] },
  color: { model: "mono", shades: 4, dac: { kind: "mono-ramp", shades: RED_RAMP } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 2,
    subPalettes: { count: 1, size: 4 },
    attribute: { w: 8, h: 8 },
    tileBudget: 2048,
    flip: true,
  },
  codegen: { family: "vb", formats: ["bin", "asm", "c", "rom"] },
  docs: {
    sources: [
      "Virtual Boy Sacred Tech Scroll — display & BGMap format",
      "Planet Virtual Boy — VIP registers (2bpp, 4 red shades)",
    ],
  },
} satisfies ConsoleSpec;
