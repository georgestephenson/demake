/**
 * Neo Geo Pocket (`ngp`) — doc 03 Tier 2, mono pipeline. 160×152, eight
 * grayscale shades. Same mono path as WonderSwan; the color model differs from
 * the NGPC sibling (`ngpc`).
 */
import type { ConsoleSpec, RGB8 } from "./types.js";
const GRAY8: readonly RGB8[] = Array.from({ length: 8 }, (_, i) => {
  const v = Math.round(255 * (1 - i / 7));
  return { r: v, g: v, b: v };
});
export const ngp = {
  id: "ngp",
  name: "Neo Geo Pocket",
  aliases: ["neogeo-pocket"],
  tier: 2,
  display: { width: 160, height: 152, pixelAspect: [1, 1] },
  color: { model: "mono", shades: 8, dac: { kind: "mono-ramp", shades: GRAY8 } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 4,
    subPalettes: { count: 1, size: 8 },
    attribute: { w: 8, h: 8 },
    tileBudget: 384,
    flip: true,
  },
  codegen: { family: "ngpc", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["NeoGeo Pocket dev wiki — K1GE mono video (8 shades)"] },
} satisfies ConsoleSpec;
