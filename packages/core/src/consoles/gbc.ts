/**
 * Game Boy Color (`gbc`) — the predecessor baseline console (doc 03 Tier 1).
 *
 * 160×144 LCD, RGB555 color displayed through the CGB LCD curve, 8×8 tiles at
 * 2bpp, and **8 background sub-palettes of 4 colors** selected per tile — up to
 * 32 colors on screen. VRAM is two 8 KiB banks (~512 unique tiles). The
 * predecessor `prep-portraits.py`/`gen-portraits.py` targeted exactly this
 * hardware (its fixed "3×4 palettes, 7×7 tiles" is one point in this spec's
 * space), which is why GBC is the Phase-1 reference.
 *
 * Sources are cited per the doc-03 hardware-verification task; values are
 * ultimately locked by emulator tests (doc 10), not by these constants.
 */

import type { ConsoleSpec } from "./types.js";

export const gbc = {
  id: "gbc",
  name: "Game Boy Color",
  aliases: ["cgb", "gameboy-color", "gbcolor"],
  tier: 1,
  display: {
    width: 160,
    height: 144,
    // The DMG/CGB LCD has square pixels.
    pixelAspect: [1, 1],
  },
  color: {
    model: "rgb",
    bitsPerChannel: [5, 5, 5],
    dac: { kind: "cgb" },
  },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 2,
    subPalettes: { count: 8, size: 4 },
    attribute: { w: 8, h: 8 },
    // Two VRAM banks of 256 tiles each; BG can draw from both on CGB.
    tileBudget: 512,
    flip: true,
  },
  codegen: { family: "gb", formats: ["bin", "asm", "c", "rom"] },
  docs: {
    sources: [
      "Pan Docs — Video Display / LCD Color Palettes (CGB): https://gbdev.io/pandocs/Palettes.html",
      "Pan Docs — VRAM Tile Data & Banks: https://gbdev.io/pandocs/Tile_Data.html",
      "Pan Docs — CGB Registers (BCPS/BCPD, RGB555): https://gbdev.io/pandocs/CGB_Registers.html",
    ],
  },
} satisfies ConsoleSpec;
