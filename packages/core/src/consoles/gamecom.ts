/**
 * Tiger Game.com (`gamecom`) — doc 03 Tier 3. 200×160, four grayscale shades; a
 * DMG-family mono reuse.
 */
import type { ConsoleSpec, RGB8 } from "./types.js";
const RAMP: readonly RGB8[] = [
  { r: 240, g: 240, b: 232 },
  { r: 160, g: 160, b: 152 },
  { r: 80, g: 80, b: 76 },
  { r: 8, g: 8, b: 8 },
];
export const gamecom = {
  id: "gamecom",
  name: "Tiger Game.com",
  aliases: ["game-com", "tiger-gamecom"],
  tier: 3,
  display: { width: 200, height: 160, pixelAspect: [1, 1] },
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
  codegen: { family: "mono-misc", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["Game.com technical FAQ — SM8521 + LCD (4 shades)"] },
} satisfies ConsoleSpec;
