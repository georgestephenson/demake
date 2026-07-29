/**
 * Nintendo DS (`nds`) — doc 03 Tier 1, tiled BG on one screen. 256×192, RGB555,
 * 8×8 4bpp tiles, 16 sub-palettes of 16 (shared transparent 0), with flip. The
 * dual-screen spanning and 16-bit framebuffer modes are later additions.
 */
import type { ConsoleSpec } from "./types.js";
export const nds = {
  id: "nds",
  name: "Nintendo DS",
  aliases: ["nintendo-ds", "ndsl"],
  tier: 1,
  display: { width: 256, height: 192, pixelAspect: [1, 1] },
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
  codegen: { family: "nds", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["GBATEK — DS video & extended palettes (RGB555)"] },
} satisfies ConsoleSpec;
