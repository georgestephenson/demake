/**
 * Sega SG-1000 (`sg1000`) — doc 03. Sega's first console: a Z80 driving a
 * TMS9918A VDP in "Graphics II" (Mode 2). 256×192, a fixed 16-color palette, and
 * the era's tightest color rule — each **8×1 tile row** shows only two of the 16
 * colors (a foreground and a background), stored one byte per row in the VDP
 * color table. That constraint is the `tms-rowpair` scanline layout, fitted by
 * the dedicated per-row two-color path (`pipeline/fit-tms.ts`).
 *
 * The master colors are genesis-plus-gx's original TMS9918 palette, so the
 * emulator comparison (SG-1000 runs on the same core as the SMS/Game Gear) is
 * exact in the core's native RGB565.
 */

import type { ConsoleSpec, RGB8 } from "./types.js";

/**
 * The 16 fixed TMS9918 colors. These are genesis-plus-gx's SG-1000 `tms_palette`
 * expanded from the core's native RGB565 entries, so a color reduces back to the
 * exact 16-bit value the core renders — the emulator comparison is then bit-exact
 * in RGB565 (the same calibrate-the-model approach as the NES/MD DACs).
 */
const TMS_MASTER: readonly RGB8[] = [
  { r: 0x00, g: 0x00, b: 0x00 }, // 0  transparent (shows backdrop)
  { r: 0x00, g: 0x00, b: 0x00 }, // 1  black
  { r: 0x21, g: 0xcb, b: 0x42 }, // 2  medium green
  { r: 0x5a, g: 0xdb, b: 0x7b }, // 3  light green
  { r: 0x52, g: 0x55, b: 0xef }, // 4  dark blue
  { r: 0x7b, g: 0x75, b: 0xf7 }, // 5  light blue
  { r: 0xd6, g: 0x51, b: 0x4a }, // 6  dark red
  { r: 0x42, g: 0xeb, b: 0xf7 }, // 7  cyan
  { r: 0xf7, g: 0x55, b: 0x52 }, // 8  medium red
  { r: 0xff, g: 0x79, b: 0x7b }, // 9  light red
  { r: 0xd6, g: 0xc3, b: 0x52 }, // 10 dark yellow
  { r: 0xe7, g: 0xcf, b: 0x84 }, // 11 light yellow
  { r: 0x21, g: 0xae, b: 0x39 }, // 12 dark green
  { r: 0xc6, g: 0x5d, b: 0xbd }, // 13 magenta
  { r: 0xce, g: 0xcb, b: 0xce }, // 14 gray
  { r: 0xff, g: 0xff, b: 0xff }, // 15 white
];

export const sg1000 = {
  id: "sg1000",
  name: "Sega SG-1000",
  aliases: ["sg-1000", "sc-3000"],
  tier: 3,
  display: { width: 256, height: 192, pixelAspect: [1, 1] },
  color: { model: "fixed-master", masterPalette: TMS_MASTER, dac: { kind: "linear" } },
  layout: { kind: "scanline", strategy: "tms-rowpair" },
  codegen: { family: "sg1000", formats: ["bin", "asm", "c", "rom"] },
  docs: {
    sources: [
      "TMS9918A/TMS9928A Video Display Processors data manual — Graphics II mode",
      "SMS Power! — TMS9918 color table (2 colors per 8×1 tile row)",
    ],
  },
} satisfies ConsoleSpec;
