/**
 * Neo Geo Pocket (`ngp`) — doc 03 Tier 2, mono pipeline. 160×152, eight
 * grayscale shades. Same mono path as WonderSwan; the color model differs from
 * the NGPC sibling (`ngpc`).
 */
import { ngpAudio } from "./audio-specs.js";
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
  // Its **own** family, not the Color's, on the WonderSwan's terms: these two
  // machines share a display controller and a processor, but a palette here is
  // three-bit shade numbers in an eight-entry lookup table and there is one of
  // them, where a Color has sixteen four-entry RGB444 palettes per layer. A data
  // backend emits palettes, so there is nothing for the two to share.
  codegen: { family: "ngp", formats: ["bin", "asm", "c", "rom"] },
  audio: ngpAudio,
  docs: { sources: ["NeoGeo Pocket dev wiki — K1GE mono video (8 shades)"] },
} satisfies ConsoleSpec;
