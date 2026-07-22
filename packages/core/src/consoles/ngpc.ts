/**
 * Neo Geo Pocket Color (`ngpc`) — doc 03 Tier 2. 160×152, RGB444, 8×8 tiles at
 * 2bpp with 16 small sub-palettes of 4 (shared transparent 0) — a GBC-like fit
 * with many tiny palettes.
 */
import type { ConsoleSpec } from "./types.js";
export const ngpc = {
  id: "ngpc",
  name: "Neo Geo Pocket Color",
  aliases: ["neogeo-pocket-color", "ngp-color"],
  tier: 2,
  display: { width: 160, height: 152, pixelAspect: [1, 1] },
  color: { model: "rgb", bitsPerChannel: [4, 4, 4], dac: { kind: "linear" } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 2,
    subPalettes: { count: 16, size: 4, sharedIndex0: "transparent" },
    attribute: { w: 8, h: 8 },
    tileBudget: 384,
    flip: true,
  },
  codegen: { family: "ngpc", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["NeoGeo Pocket dev wiki — K1GE video (RGB444, 2bpp tiles)"] },
} satisfies ConsoleSpec;
