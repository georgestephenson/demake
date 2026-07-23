/**
 * Nintendo DS (`nds`) — doc 03 Tier 1, tiled BG on one screen. 256×192, RGB555,
 * 8×8 4bpp tiles, 16 sub-palettes of 16 (shared transparent 0), with flip. The
 * dual-screen spanning and 16-bit framebuffer modes are later additions.
 */
import type { ConsoleSpec } from "./types.js";
export const nds = {
  id: "nds",
  name: "Nintendo DS",
  aliases: ["nintendo-ds", "ndsl"],
  tier: 1,
  display: { width: 256, height: 192, pixelAspect: [1, 1] },
  color: { model: "rgb", bitsPerChannel: [5, 5, 5], dac: { kind: "linear" } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 4,
    subPalettes: { count: 16, size: 16, sharedIndex0: "transparent" },
    attribute: { w: 8, h: 8 },
    tileBudget: 1024,
    flip: true,
  },
  codegen: { family: "nds", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["GBATEK — DS video & extended palettes (RGB555)"] },
} satisfies ConsoleSpec;
