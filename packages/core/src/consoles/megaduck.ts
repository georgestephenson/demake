/**
 * Mega Duck / Cougar Boy (`megaduck`) — doc 03 Tier 3. A Game Boy clone: 160×144,
 * four shades at 2bpp. Uses a neutral grey ramp.
 *
 * Its *data* formats are the DMG's exactly — 2bpp planar tiles, a background
 * map, a two-bit-per-shade palette register — so it shares the `gb` codegen
 * family and `bin`/`asm`/`c` are correct for it. Its *display program* is not:
 * the LCD registers sit at $FF10–$FF1B rather than $FF40–$FF4B and LCDC's bits
 * are shuffled, so the `gb` ROM harness would assemble a cartridge that runs on
 * a Game Boy and shows nothing here. `rom` is therefore withheld until the
 * console has its own harness and an emulator to prove it against (doc 13
 * §Phase 7+); SameDuck's `Core/gb.h` is the register map to build it from.
 */
import { gbAudio } from "./audio-specs.js";
import type { ConsoleSpec, RGB8 } from "./types.js";
const RAMP: readonly RGB8[] = [
  { r: 232, g: 232, b: 232 },
  { r: 160, g: 160, b: 160 },
  { r: 84, g: 84, b: 84 },
  { r: 16, g: 16, b: 16 },
];
export const megaduck = {
  id: "megaduck",
  name: "Mega Duck",
  aliases: ["cougar-boy", "mega-duck"],
  tier: 3,
  display: { width: 160, height: 144, pixelAspect: [1, 1] },
  color: { model: "mono", shades: 4, dac: { kind: "mono-ramp", shades: RAMP } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 2,
    subPalettes: { count: 1, size: 4 },
    attribute: { w: 8, h: 8 },
    tileBudget: 256,
    flip: false,
  },
  codegen: { family: "gb", formats: ["bin", "asm", "c"] },
  // The Game Boy's APU, unchanged: same four channels, same lattices, same
  // 4.194304 MHz clock, same timer to drive a driver from. An `AudioSpec`
  // describes what the hardware can *do* and never where its registers are, so
  // the console's rewiring (`asm/megaduck.ts`) does not reach this far — it is
  // applied where a register number becomes an address, and nowhere above.
  audio: gbAudio,
  docs: {
    sources: [
      "Mega Duck technical notes — GB-clone LCD (4 shades)",
      "SameDuck (SameBoy fork) — Core/gb.h, Core/display.c: the I/O map and LCDC bits",
    ],
  },
} satisfies ConsoleSpec;
