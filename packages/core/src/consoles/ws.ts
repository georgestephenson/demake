/**
 * WonderSwan (`ws`) — doc 03 Tier 2, mono pipeline. 224×144, eight grayscale
 * shades (the LCD has a faint tint). DMG mono path with an 8-level gray ramp.
 */
import type { ConsoleSpec, RGB8 } from "./types.js";
const GRAY8: readonly RGB8[] = Array.from({ length: 8 }, (_, i) => {
  const v = Math.round(255 * (1 - i / 7));
  return { r: v, g: v, b: v };
});
export const ws = {
  id: "ws",
  name: "WonderSwan",
  aliases: ["wonderswan"],
  tier: 2,
  display: { width: 224, height: 144, pixelAspect: [1, 1] },
  color: { model: "mono", shades: 8, dac: { kind: "mono-ramp", shades: GRAY8 } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 4,
    subPalettes: { count: 1, size: 8 },
    attribute: { w: 8, h: 8 },
    tileBudget: 512,
    flip: true,
  },
  codegen: { family: "ws", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["WSdev — mono display (8 shades)"] },
} satisfies ConsoleSpec;
