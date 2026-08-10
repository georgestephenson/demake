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
 *   - **255 sub-palettes of 16**, against a Mega Drive's four — one short of the
 *     bank, because its last entry is the backdrop register and not a colour an
 *     art path may spend. Nothing else here is within an order of magnitude, and
 *     the fit is correspondingly easy: a 320×224 picture is 280 cells and cannot
 *     exhaust them.
 *   - **Tiles are not in VRAM.** They are read from the cartridge's C ROM by the
 *     video hardware, so nothing is ever uploaded and the tile budget is a
 *     cartridge size rather than a bank. `tileBudget` is the sixteen-bit tile
 *     field in SCB1's even word, which is a floor: four more bits live in the
 *     odd word. It is set to what can be cited rather than to what is believed,
 *     and either number is far past what one picture asks for.
 *
 * **Five bits a channel is the hardware's precision, not a conservative guess.**
 * A colour word is bit 15 "dark", bits 14–12 the per-channel least significant
 * bits, and bits 11–0 four high bits each — and the reference is explicit that
 * the dark bit is "a common LSB for the 3 components". A *shared* bit cannot be
 * chosen per channel, so declaring `[6, 6, 6]` would tell the fit it can pick
 * colours no palette word expresses. What the sixth bit buys is a global
 * half-step, which is a fact about the whole palette rather than about any
 * colour in it, and `@demake/neogeo` records why it is left unmodelled.
 */
import { neogeoAudio } from "./audio-specs.js";
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
    // Two banks of 256, one usable at a time — and the bank's **last entry is
    // the backdrop**, which is what colour zero of every palette shows through
    // to. So a frame has 255 palettes an art path may fill and a 256th whose
    // sixteenth colour belongs to the hardware: a fit given all 256 puts a
    // colour where the backdrop goes and has it replaced, which the display-ROM
    // E2E found as five wrong pixels in a screenful of noise.
    subPalettes: { count: 255, size: 16, sharedIndex0: "transparent" },
    // The palette lives in the 16×16 sprite tile's attribute word, not the 8×8.
    attribute: { w: 16, h: 16 },
    tileBudget: 65536,
    flip: true,
  },
  codegen: { family: "neogeo", formats: ["bin", "asm", "c", "rom"] },
  audio: neogeoAudio,
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
