/**
 * Nintendo Entertainment System / Famicom (`nes`) — doc 03 Tier 1.
 *
 * 256×240 (top/bottom overscan usually cropped), 8×8 tiles at 2bpp from a 256-
 * tile pattern table, and a **fixed 64-entry master palette** (the 2C02 PPU has
 * no programmable RGB — you pick indices into its built-in colors). Background
 * color is chosen per **16×16 attribute cell** from **4 sub-palettes of 4**,
 * and — the load-bearing NES quirk beyond the 16×16 cells — **color 0 of every
 * background palette is the shared universal backdrop** ($3F00). So at most
 * 4×3 + 1 = 13 background colors are on screen at once.
 *
 * The master palette below is the canonical FCEUX/Nintendulator NTSC set; it is
 * the demake *reference* the headless emulator will be calibrated to render
 * (doc 10), exactly as the GB DAC models are. Non-square pixels: 8:7 PAR.
 */

import type { ConsoleSpec, RGB8 } from "./types.js";

/** The 64-entry NES master palette (indices $00–$3F), sRGB. */
const NES_MASTER: readonly RGB8[] = (
  [
    [84, 84, 84],
    [0, 30, 116],
    [8, 16, 144],
    [48, 0, 136],
    [68, 0, 100],
    [92, 0, 48],
    [84, 4, 0],
    [60, 24, 0],
    [32, 42, 0],
    [8, 58, 0],
    [0, 64, 0],
    [0, 60, 0],
    [0, 50, 60],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [152, 150, 152],
    [8, 76, 196],
    [48, 50, 236],
    [92, 30, 228],
    [136, 20, 176],
    [160, 20, 100],
    [152, 34, 32],
    [120, 60, 0],
    [84, 90, 0],
    [40, 114, 0],
    [8, 124, 0],
    [0, 118, 40],
    [0, 102, 120],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [236, 238, 236],
    [76, 154, 236],
    [120, 124, 236],
    [176, 98, 236],
    [228, 84, 236],
    [236, 88, 180],
    [236, 106, 100],
    [212, 136, 32],
    [160, 170, 0],
    [116, 196, 0],
    [76, 208, 32],
    [56, 204, 108],
    [56, 180, 204],
    [60, 60, 60],
    [0, 0, 0],
    [0, 0, 0],
    [236, 238, 236],
    [168, 204, 236],
    [188, 188, 236],
    [212, 178, 236],
    [236, 174, 236],
    [236, 174, 212],
    [236, 180, 176],
    [228, 196, 144],
    [204, 210, 120],
    [180, 222, 120],
    [168, 226, 144],
    [152, 226, 180],
    [160, 214, 228],
    [160, 162, 160],
    [0, 0, 0],
    [0, 0, 0],
  ] as const
).map(([r, g, b]) => ({ r, g, b }));

export const nes = {
  id: "nes",
  name: "Nintendo Entertainment System",
  aliases: ["famicom", "fc", "nintendo"],
  tier: 1,
  display: {
    width: 256,
    height: 240,
    // NTSC NES pixels are wider than tall.
    pixelAspect: [8, 7],
    // The top/bottom 8 rows are hidden by overscan on most TVs.
    overscanSafe: { x: 0, y: 8, width: 256, height: 224 },
  },
  color: {
    model: "fixed-master",
    masterPalette: NES_MASTER,
    // The master entries are already the displayed sRGB; no separate curve.
    dac: { kind: "linear" },
  },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 2,
    // 4 background sub-palettes of 4, sharing color 0 (the universal backdrop).
    subPalettes: { count: 4, size: 4, sharedIndex0: "backdrop" },
    // Palette is chosen per 16×16 attribute cell, not per tile.
    attribute: { w: 16, h: 16 },
    // One 256-tile pattern table for the background.
    tileBudget: 256,
    // The NES background has no per-tile H/V flip (that is an OAM/sprite feature).
    flip: false,
  },
  codegen: { family: "nes", formats: ["bin", "asm", "c", "rom"] },
  docs: {
    sources: [
      "NESdev Wiki — PPU palettes (2C02, 64-entry master): https://www.nesdev.org/wiki/PPU_palettes",
      "NESdev Wiki — PPU attribute tables (16×16 palette cells): https://www.nesdev.org/wiki/PPU_attribute_tables",
      "NESdev Wiki — PPU pattern tables (2bpp planar CHR): https://www.nesdev.org/wiki/PPU_pattern_tables",
    ],
  },
} satisfies ConsoleSpec;
