/**
 * Pokémon Mini (`pokemini`) — doc 03 Tier 3, 1bpp mono. 96×64, two shades on a
 * greenish reflective LCD (grays come from flicker, out of scope). The DMG mono
 * path with a 2-level ramp = a threshold/dither pipeline.
 */
import type { ConsoleSpec, RGB8 } from "./types.js";
const RAMP: readonly RGB8[] = [
  { r: 184, g: 194, b: 176 },
  { r: 24, g: 24, b: 24 },
];
export const pokemini = {
  id: "pokemini",
  name: "Pokémon Mini",
  aliases: ["pokemon-mini", "pkmn-mini"],
  tier: 3,
  display: { width: 96, height: 64, pixelAspect: [1, 1] },
  color: { model: "mono", shades: 2, dac: { kind: "mono-ramp", shades: RAMP } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 1,
    subPalettes: { count: 1, size: 2 },
    attribute: { w: 8, h: 8 },
    tileBudget: 256,
    flip: false,
  },
  codegen: { family: "mono-misc", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["Pokémon-Mini.net — PM hardware (1bpp)"] },
} satisfies ConsoleSpec;
