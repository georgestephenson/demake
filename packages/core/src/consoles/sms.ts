/**
 * Sega Master System (`sms`) — doc 03 Tier 1.
 *
 * 256×192, a tiny RGB222 master palette (64 colors), 8×8 tiles at 4bpp with H/V
 * flip in the name table, and a single 16-color background palette. The small
 * lattice dominates error, so the fitter's importance weighting earns its keep.
 */

import type { ConsoleSpec } from "./types.js";

export const sms = {
  id: "sms",
  name: "Sega Master System",
  aliases: ["mastersystem", "sega-master-system", "sg-mark-iii"],
  tier: 1,
  display: { width: 256, height: 192, pixelAspect: [8, 7] },
  color: { model: "rgb", bitsPerChannel: [2, 2, 2], dac: { kind: "linear" } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 4,
    subPalettes: { count: 1, size: 16 },
    attribute: { w: 8, h: 8 },
    tileBudget: 448,
    flip: true,
  },
  codegen: { family: "sms", formats: ["bin", "asm", "c", "rom"] },
  docs: {
    sources: [
      "SMS Power! — VDP Palette (RGB222): https://www.smspower.org/Development/Palette",
      "SMS Power! — VDP Name Table / tile flip: https://www.smspower.org/Development/TileMapAddress",
    ],
  },
} satisfies ConsoleSpec;
