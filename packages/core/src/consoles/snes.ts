/**
 * Super Nintendo / Super Famicom (`snes`) — doc 03 Tier 1.
 *
 * 256×224, RGB555 CGRAM, 8×8 tiles at 4bpp in the common Mode 1 background:
 * **8 sub-palettes of 16 sharing a transparent color 0**, with H/V flip. (Mode 3's
 * 256-color single palette and Mode 7 are selectable modes for a later pass; this
 * spec pins Mode 1, the workhorse tiled BG.)
 */

import type { ConsoleSpec } from "./types.js";

export const snes = {
  id: "snes",
  name: "Super Nintendo Entertainment System",
  aliases: ["superfamicom", "sfc", "super-nintendo"],
  tier: 1,
  display: { width: 256, height: 224, pixelAspect: [8, 7] },
  color: { model: "rgb", bitsPerChannel: [5, 5, 5], dac: { kind: "linear" } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 4,
    subPalettes: { count: 8, size: 16, sharedIndex0: "transparent" },
    attribute: { w: 8, h: 8 },
    tileBudget: 1024,
    flip: true,
  },
  codegen: { family: "snes", formats: ["bin", "asm", "c", "rom"] },
  docs: {
    sources: [
      "SNESdev Wiki — CGRAM & palettes (RGB555): https://snes.nesdev.org/wiki/CGRAM",
      "SNESdev Wiki — Backgrounds / tilemap (flip bits, Mode 1): https://snes.nesdev.org/wiki/Backgrounds",
    ],
  },
} satisfies ConsoleSpec;
