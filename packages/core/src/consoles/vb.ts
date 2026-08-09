/**
 * Virtual Boy (`vb`) — doc 03 Tier 3, mono pipeline.
 *
 * 384×224, four **red** shades at 2bpp (the LED display has no other hue). It is
 * the DMG mono path with a red ramp instead of green: luminance mapping with
 * auto-contrast, rendered through the red tint. Index 0 is the brightest shade,
 * which is where every mono console in this project puts its lightest — on this
 * display that is the *top* of the ramp rather than the bottom, because shade
 * zero here is the LEDs being off. `@demake/vb`'s `vbShade` is the one place
 * that reversal happens.
 *
 * The ramp is a **tested artifact**, on the Mega Drive's terms (AGENTS.md
 * §Gotchas): it reproduces what beetle-vb puts on screen for the standard
 * brightness setting a demade cartridge programs — `BRTA` 32, `BRTB` 64,
 * `BRTC` 32, which is the LED intensity every homebrew initialisation uses. The
 * spacing is not linear because the emulator applies a gamma to the LED
 * intensities, so an evenly spaced ramp would fail the pixel-perfect E2E on
 * every mid-tone. The values were measured rather than derived, and
 * `packages/cli/test/vb.e2e.test.ts` is what keeps them true.
 */

import type { ConsoleSpec, RGB8 } from "./types.js";

/** Virtual Boy red ramp, brightest → darkest, as the LED display shows it. */
const RED_RAMP: readonly RGB8[] = [
  { r: 254, g: 0, b: 0 },
  { r: 185, g: 0, b: 0 },
  { r: 135, g: 0, b: 0 },
  { r: 0, g: 0, b: 0 },
];

export const vb = {
  id: "vb",
  name: "Virtual Boy",
  aliases: ["virtualboy"],
  tier: 3,
  display: { width: 384, height: 224, pixelAspect: [1, 1] },
  color: { model: "mono", shades: 4, dac: { kind: "mono-ramp", shades: RED_RAMP } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 2,
    subPalettes: { count: 1, size: 4 },
    attribute: { w: 8, h: 8 },
    tileBudget: 2048,
    flip: true,
  },
  codegen: { family: "vb", formats: ["bin", "asm", "c", "rom"] },
  docs: {
    sources: [
      "Virtual Boy Sacred Tech Scroll — display & BGMap format",
      "Planet Virtual Boy — VIP registers (2bpp, 4 red shades)",
    ],
  },
} satisfies ConsoleSpec;
