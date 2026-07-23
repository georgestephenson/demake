/**
 * Neo Geo (`neogeo`) — doc 03 Tier 2. 320×224, ~15-bit RGB. Sprite-only
 * hardware whose "background" is tiled sprite strips + an 8×8 fix layer; for
 * prep we model it as generous 4bpp tiles with many 16-color palettes (shared
 * transparent 0). Palette abundance makes fitting easy; the codegen strip format
 * is the work.
 */
import type { ConsoleSpec } from "./types.js";
export const neogeo = {
  id: "neogeo",
  name: "Neo Geo",
  aliases: ["neo-geo", "aes", "mvs"],
  tier: 2,
  display: { width: 320, height: 224, pixelAspect: [1, 1] },
  color: { model: "rgb", bitsPerChannel: [5, 5, 5], dac: { kind: "linear" } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 4,
    subPalettes: { count: 16, size: 16, sharedIndex0: "transparent" },
    attribute: { w: 8, h: 8 },
    tileBudget: 4096,
    flip: true,
  },
  codegen: { family: "neogeo", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["Neo Geo Development Wiki — palettes & sprites (15-bit + dark bit)"] },
} satisfies ConsoleSpec;
