/**
 * PC Engine / TurboGrafx-16 (`pce`) — doc 03 Tier 2. 256×224, RGB333 (512),
 * 8×8 4bpp tiles, 16 sub-palettes of 16 (shared transparent 0). The abundant
 * palettes make fits easy; the codegen VRAM layout is the real work. The BAT has
 * no per-tile flip.
 */
import type { ConsoleSpec } from "./types.js";
export const pce = {
  id: "pce",
  name: "PC Engine",
  aliases: ["turbografx", "turbografx-16", "tg16"],
  tier: 2,
  display: { width: 256, height: 224, pixelAspect: [8, 7] },
  color: { model: "rgb", bitsPerChannel: [3, 3, 3], dac: { kind: "linear" } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 4,
    subPalettes: { count: 16, size: 16, sharedIndex0: "transparent" },
    attribute: { w: 8, h: 8 },
    tileBudget: 2048,
    flip: false,
  },
  codegen: { family: "pce", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["Archaic Pixels — HuC6270 VDC & VCE palette (RGB333)"] },
} satisfies ConsoleSpec;
