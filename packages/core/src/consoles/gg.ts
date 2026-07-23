/**
 * Sega Game Gear (`gg`) — doc 03 Tier 2. The Master System's handheld sibling:
 * same 8×8 4bpp tiles and single 16-color BG palette, but a richer RGB444 LCD
 * (4096 colors) and a 160×144 viewport (a windowed crop of the SMS 256×192 VDP).
 */
import type { ConsoleSpec } from "./types.js";
export const gg = {
  id: "gg",
  name: "Sega Game Gear",
  aliases: ["gamegear", "game-gear"],
  tier: 2,
  display: { width: 160, height: 144, pixelAspect: [1, 1] },
  color: { model: "rgb", bitsPerChannel: [4, 4, 4], dac: { kind: "linear" } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 4,
    subPalettes: { count: 1, size: 16 },
    attribute: { w: 8, h: 8 },
    tileBudget: 448,
    flip: true,
  },
  codegen: { family: "sms", formats: ["bin", "asm", "c", "rom"] },
  docs: {
    sources: ["SMS Power! — Game Gear VDP (RGB444): https://www.smspower.org/Development/Palette"],
  },
} satisfies ConsoleSpec;
