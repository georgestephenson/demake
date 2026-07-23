/**
 * WonderSwan Color (`wsc`) — doc 03 Tier 2. 224×144, RGB444, 8×8 4bpp tiles,
 * 16 sub-palettes of 16 (shared transparent 0), with flip. Portrait/landscape
 * orientation is a display flag; this spec uses the landscape viewport.
 */
import type { ConsoleSpec } from "./types.js";
export const wsc = {
  id: "wsc",
  name: "WonderSwan Color",
  aliases: ["wonderswan-color", "swancrystal"],
  tier: 2,
  display: { width: 224, height: 144, pixelAspect: [1, 1] },
  color: { model: "rgb", bitsPerChannel: [4, 4, 4], dac: { kind: "linear" } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 4,
    subPalettes: { count: 16, size: 16, sharedIndex0: "transparent" },
    attribute: { w: 8, h: 8 },
    tileBudget: 512,
    flip: true,
  },
  codegen: { family: "ws", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["WSdev — Display controller & palettes (RGB444)"] },
} satisfies ConsoleSpec;
