/**
 * WonderSwan (`ws`) — doc 03 Tier 2, mono. 224×144, and a palette system with
 * one more level of indirection than anything else in this matrix.
 *
 * A tile is **2bpp**, so a cell shows four of anything. Those four are a
 * *palette*, of which the hardware has sixteen (ports `$20`–`$3F`), and each of
 * a palette's four entries is a **three-bit index into a shared pool of eight
 * shades** (ports `$1C`–`$1F`). Each pool entry is a four-bit LCD level, of
 * which there are sixteen — shade 0 brightest, shade 15 darkest.
 *
 * So a fit here chooses three things where every other mono console chooses
 * none: which eight of the sixteen levels the pool holds, which four of the pool
 * each palette names, and which palette each cell uses. That is
 * `pipeline/fit-mono-tiled.ts`, and it is the reason this console spent four
 * phases with a spec and no backend — the mono path fits a single ramp and the
 * tiled path fits RGB lattices, and neither expresses a *choice of* ramp with
 * per-cell selection.
 *
 * The sound is the Color model's, undivided: the same four wavetable channels on
 * the same ports, which is why both machines share `wsAudio`.
 *
 * Sources: WSdev wiki — Display/Palette and Display/IO Ports.
 */
import { wsAudio } from "./audio-specs.js";
import type { ConsoleSpec, RGB8 } from "./types.js";

/**
 * The sixteen levels the pool is chosen from.
 *
 * The panel is an FSTN with an approximately linear response, so this is a plain
 * ramp rather than a measured curve — and it runs light to dark, because that is
 * the direction the shade register counts in.
 */
const GRAY16: readonly RGB8[] = Array.from({ length: 16 }, (_, i) => {
  const v = Math.round(255 * (1 - i / 15));
  return { r: v, g: v, b: v };
});

export const ws = {
  id: "ws",
  name: "WonderSwan",
  aliases: ["wonderswan"],
  tier: 2,
  display: { width: 224, height: 144, pixelAspect: [1, 1] },
  // Eight shades on screen at once, chosen from sixteen the panel can show.
  color: { model: "mono", shades: 8, levels: 16, dac: { kind: "mono-ramp", shades: GRAY16 } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 2,
    // Sixteen palettes of four, and entry zero is transparent on the object
    // layer — the Color model's arrangement at a quarter of the depth.
    subPalettes: { count: 16, size: 4, sharedIndex0: "transparent" },
    attribute: { w: 8, h: 8 },
    tileBudget: 512,
    flip: true,
  },
  audio: wsAudio,
  codegen: { family: "ws", formats: ["bin", "asm", "c", "rom"] },
  docs: {
    sources: [
      "WSdev wiki — Display/Palette: https://ws.nesdev.org/wiki/Display/Palette",
      "WSdev wiki — Display/IO Ports: https://ws.nesdev.org/wiki/Display/IO_Ports",
    ],
  },
} satisfies ConsoleSpec;
