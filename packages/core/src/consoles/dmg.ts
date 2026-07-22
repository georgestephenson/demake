/**
 * Game Boy (`dmg`) — the original mono handheld (doc 03 Tier 1).
 *
 * 160×144, four shades at 2bpp through a single background palette, rendered on
 * the characteristic green LCD. It is "nearly free" given the GBC work and
 * exercises the engine's **mono path** (doc 04 §Mono ramps): luminance mapping
 * with auto-contrast rather than the RGB-lattice quantizer. The four shade
 * colors below are the classic hardware green ramp used for preview and for the
 * emulator DAC comparison; index 0 is the lightest shade (as in the BGP
 * register's color 0).
 */

import type { RGB8 } from "./types.js";
import type { ConsoleSpec } from "./types.js";

/** Classic Game Boy green LCD ramp, lightest → darkest. */
const GREEN_RAMP: readonly RGB8[] = [
  { r: 155, g: 188, b: 15 },
  { r: 139, g: 172, b: 15 },
  { r: 48, g: 98, b: 48 },
  { r: 15, g: 56, b: 15 },
];

export const dmg = {
  id: "dmg",
  name: "Game Boy",
  aliases: ["gb", "gameboy"],
  tier: 1,
  display: {
    width: 160,
    height: 144,
    pixelAspect: [1, 1],
  },
  color: {
    model: "mono",
    shades: 4,
    dac: { kind: "mono-ramp", shades: GREEN_RAMP },
  },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 2,
    subPalettes: { count: 1, size: 4 },
    attribute: { w: 8, h: 8 },
    tileBudget: 256,
    flip: true,
  },
  codegen: { family: "gb", formats: ["bin", "asm", "c", "rom"] },
  docs: {
    sources: [
      "Pan Docs — LCD Monochrome Palettes (BGP): https://gbdev.io/pandocs/Palettes.html",
      "Pan Docs — Rendering / OBJ & BG priority: https://gbdev.io/pandocs/Rendering.html",
    ],
  },
} satisfies ConsoleSpec;
