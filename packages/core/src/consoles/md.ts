/**
 * Sega Mega Drive / Genesis (`md`) — doc 03 Tier 1.
 *
 * 320×224 (or 256×224), RGB333 (512 colors, ~61 usable at once), 8×8 tiles at
 * 4bpp with H/V flip, and **4 sub-palettes of 16 sharing a transparent color 0**
 * — the same shared-index-0 machinery the NES backdrop uses. Large VRAM means the
 * unique-tile budget, not the palette, is usually the binding constraint.
 */

import type { ConsoleSpec } from "./types.js";

export const md = {
  id: "md",
  name: "Sega Mega Drive",
  aliases: ["genesis", "megadrive", "sega-genesis"],
  tier: 1,
  display: {
    width: 320,
    height: 224,
    altModes: [{ name: "h32", width: 256, height: 224 }],
    // 320-wide NTSC pixels are narrow.
    pixelAspect: [32, 35],
  },
  color: { model: "rgb", bitsPerChannel: [3, 3, 3], dac: { kind: "linear" } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 4,
    subPalettes: { count: 4, size: 16, sharedIndex0: "transparent" },
    attribute: { w: 8, h: 8 },
    tileBudget: 1408,
    flip: true,
  },
  codegen: { family: "md", formats: ["bin", "asm", "c", "rom"] },
  docs: {
    sources: [
      "Sega Genesis Software Manual — VDP CRAM (RGB333, 4×16 palettes)",
      "Plutiedev — VDP tiles & plane cells (flip bits, transparent color 0): https://plutiedev.com/vdp-planes",
    ],
  },
} satisfies ConsoleSpec;
