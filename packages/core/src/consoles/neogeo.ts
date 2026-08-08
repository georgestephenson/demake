/**
 * Neo Geo (`neogeo`) — doc 03 Tier 2. 320×224, five bits a channel, and the most
 * generous palette hardware in the whole matrix.
 *
 * **This console has no tilemap and does not need one.** The playfield is built
 * from sprites, and a sprite here is a *vertical strip*: sixteen pixels wide and
 * up to thirty-two tiles tall, its column of tile numbers sitting in a 64-word
 * table in VRAM. So a row of twenty strips side by side is a 20×32 plane of
 * 16×16 cells whose cell writes are ordinary VRAM writes and whose scroll is the
 * strips' own X and Y registers — a tilemap in everything but the name, with a
 * per-column scroll no tilemap machine in the set has. Doc 13 priced this
 * console as "all five background-cell writers need counterparts"; what they
 * actually need is a different address calculation.
 *
 * Three facts decide the fit.
 *
 *   - **A palette belongs to a 16×16 tile.** The tile *data* is four 8×8 tiles
 *     to the GPU, but the attribute word that names a palette is per 16×16
 *     sprite tile — so the attribute cell is 16×16 over 8×8 tiles, which is the
 *     NES's arrangement reached by completely different hardware. The art path
 *     composes each 2×2 group into one hardware tile, as `pce-art.ts` already
 *     does for a console with no 8×8 sprite.
 *   - **256 sub-palettes of 16**, against a Mega Drive's four. Nothing else here
 *     is within an order of magnitude, and the fit is correspondingly easy: a
 *     320×224 picture is 280 cells and cannot exhaust them.
 *   - **Tiles are not in VRAM.** They are read from the cartridge's C ROM by the
 *     video hardware, so nothing is ever uploaded and the tile budget is a
 *     cartridge size rather than a bank. `tileBudget` is the sixteen-bit tile
 *     field in SCB1's even word, which is a floor: four more bits live in the
 *     odd word. It is set to what can be cited rather than to what is believed,
 *     and either number is far past what one picture asks for.
 *
 * **The colour word's low bits are ambiguous in the sources and are declared
 * conservatively.** Bit 15 is the dark bit and bits 14–12 are per-channel least
 * significant bits over four high bits each, which is five bits a channel — but
 * the same reference also calls bit 15 "a common LSB for the three components",
 * which would make it six. Five is the reading every source agrees on, so that
 * is what is declared; if the finer lattice is confirmed, this is a one-line
 * change and the fit gets strictly better. Writing down the uncertainty rather
 * than hiding it is the `NGP_BUTTON_BITS` rule (AGENTS.md §Gotchas): a machine
 * description that is wrong *and* consistent passes every test there is.
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
    // Two banks of 256; one is usable at a time, so 256 is what a frame has.
    subPalettes: { count: 256, size: 16, sharedIndex0: "transparent" },
    // The palette lives in the 16×16 sprite tile's attribute word, not the 8×8.
    attribute: { w: 16, h: 16 },
    tileBudget: 65536,
    flip: true,
  },
  codegen: { family: "neogeo", formats: ["bin", "asm", "c"] },
  docs: {
    sources: [
      "Neo Geo Development Wiki — Sprites: https://wiki.neogeodev.org/index.php?title=Sprites",
      "Neo Geo Development Wiki — VRAM: https://wiki.neogeodev.org/index.php?title=VRAM",
      "Neo Geo Development Wiki — Palettes: https://wiki.neogeodev.org/index.php?title=Palettes",
      "Neo Geo Development Wiki — Colors: https://wiki.neogeodev.org/index.php?title=Colors",
      "Neo Geo Development Wiki — Fix layer: https://wiki.neogeodev.org/index.php?title=Fix_layer",
    ],
  },
} satisfies ConsoleSpec;
