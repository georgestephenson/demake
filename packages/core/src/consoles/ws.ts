/**
 * WonderSwan (`ws`) — doc 03 Tier 2, mono pipeline. 224×144, eight grayscale
 * shades (the LCD has a faint tint). DMG mono path with an 8-level gray ramp.
 *
 * **Known optimistic** (doc 13 §Phase 5): the mono display controller has 2bpp
 * tiles and sixteen *four*-entry palettes whose entries index an eight-shade
 * pool, itself chosen from sixteen LCD levels — so no single tile can show the
 * eight shades this spec offers. Modelling it faithfully needs a tiled-mono fit
 * path (the mono path is single-palette; the tiled path fits RGB lattices),
 * which is why `ws` has no codegen backend and the WonderSwan **Color** is its
 * own `wsc` family rather than a sibling of this one.
 */
import { wsAudio } from "./audio-specs.js";
import type { ConsoleSpec, RGB8 } from "./types.js";
const GRAY8: readonly RGB8[] = Array.from({ length: 8 }, (_, i) => {
  const v = Math.round(255 * (1 - i / 7));
  return { r: v, g: v, b: v };
});
export const ws = {
  id: "ws",
  name: "WonderSwan",
  aliases: ["wonderswan"],
  tier: 2,
  display: { width: 224, height: 144, pixelAspect: [1, 1] },
  color: { model: "mono", shades: 8, dac: { kind: "mono-ramp", shades: GRAY8 } },
  layout: {
    kind: "tiles",
    tileW: 8,
    tileH: 8,
    bpp: 4,
    subPalettes: { count: 1, size: 8 },
    attribute: { w: 8, h: 8 },
    tileBudget: 512,
    flip: true,
  },
  audio: wsAudio,
  codegen: { family: "ws", formats: ["bin", "asm", "c", "rom"] },
  docs: { sources: ["WSdev — mono display (8 shades)"] },
} satisfies ConsoleSpec;
