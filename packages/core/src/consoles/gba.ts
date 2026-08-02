/**
 * Game Boy Advance (`gba`) — doc 03 Tier 1, Mode 0 tiled background.
 *
 * 240×160, RGB555, 8×8 tiles at 4bpp, **16 sub-palettes of 16 sharing a
 * transparent color 0**, with H/V flip. (The bitmap Modes 3/4 are a framebuffer
 * path added separately; this pins the tiled BG.)
 */
import { gbaAudio } from "./audio-specs.js";
import type { ConsoleSpec } from "./types.js";
export const gba = {
  id: "gba",
  name: "Game Boy Advance",
  aliases: ["gameboy-advance", "agb"],
  tier: 1,
  display: { width: 240, height: 160, pixelAspect: [1, 1] },
  color: { model: "rgb", bitsPerChannel: [5, 5, 5], dac: { kind: "linear" } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 4,
    subPalettes: { count: 16, size: 16, sharedIndex0: "transparent" },
    attribute: { w: 8, h: 8 },
    tileBudget: 1024,
    flip: true,
  },
  modes: [
    /**
     * The 256-colour tiled mode, which is what a *game* built for this console
     * uses.
     *
     * Not the primary layout, and the difference is worth stating. `prep` fits a
     * still picture, and for that the 4bpp sixteen-palette layout above is what the
     * display-ROM harness and the pixel-perfect E2E were built against. A game is
     * fitted by `demake build`, which asks for this instead — one palette of 256
     * with no per-cell restriction at all, which is a strictly larger space than
     * sixteen palettes of sixteen because *any* cell may use *any* colour.
     *
     * The cost is the tile budget: a 256-colour tile is 64 bytes rather than 32, so
     * the same video RAM holds half as many. On a console with 64 KiB of background
     * character memory that is still 896 tiles against a 600-cell screen, which is
     * why the trade is not close.
     */
    {
      kind: "tiles",
      tileW: 8,
      tileH: 8,
      bpp: 8,
      subPalettes: { count: 1, size: 256, sharedIndex0: "transparent" },
      attribute: { w: 8, h: 8 },
      tileBudget: 896,
      flip: true,
    },
  ],
  codegen: { family: "gba", formats: ["bin", "asm", "c", "rom"] },
  audio: gbaAudio,
  docs: {
    sources: [
      "GBATEK — LCD I/O BG Control & palette (RGB555): https://problemkaputt.de/gbatek.htm",
    ],
  },
} satisfies ConsoleSpec;
