/**
 * Game Boy Advance (`gba`) — doc 03 Tier 1, Mode 0 tiled background.
 *
 * 240×160, RGB555, 8×8 tiles at 4bpp, **16 sub-palettes of 16 sharing a
 * transparent color 0**, with H/V flip. (The bitmap Modes 3/4 are a framebuffer
 * path added separately; this pins the tiled BG.)
 */
import type { ConsoleSpec } from "./types.js";
export const gba = {
  id: "gba",
  name: "Game Boy Advance",
  aliases: ["gameboy-advance", "agb"],
  tier: 1,
  display: { width: 240, height: 160, pixelAspect: [1, 1] },
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
  codegen: { family: "gba", formats: ["bin", "asm", "c", "rom"] },
  docs: {
    sources: [
      "GBATEK — LCD I/O BG Control & palette (RGB555): https://problemkaputt.de/gbatek.htm",
    ],
  },
} satisfies ConsoleSpec;
