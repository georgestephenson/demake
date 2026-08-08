/**
 * `@demake/neogeo` — a self-hosted Neo Geo core.
 *
 * The eleventh owned core, and it exists for the jobs the other ten do (doc 14
 * §Conformance, doc 07 §no CDN): run a `demake build` cartridge in Vitest with
 * no toolchain and no emulator install, and play one in the page without
 * fetching a core from anywhere.
 *
 * **This console was on doc 13's "gated on a BIOS we will not ship" list, and it
 * is not gated at all.** That entry was written when the proof loop was
 * libretro-only. Owning the core changes the question from "can we run somebody
 * else's emulator" to "what does the hardware do before it hands control over",
 * and the answer here is: take the stack pointer from the cartridge's first
 * longword and enter at its header's `USER` vector. Commercial cartridges lean
 * on the system ROM heavily; one this project writes calls none of it. Nothing
 * copyrighted is shipped, reimplemented or needed — the same position
 * `@demake/snes` takes about the S-SMP's boot ROM and `@demake/ngp` about SNK's
 * other console.
 *
 * The 68000 is `@demake/md`'s rather than a second transcription of it, on the
 * terms `@demake/nds` borrows `@demake/gba`'s ARM: two consoles here run this
 * processor and it is the *processor* either way.
 *
 * The Z80 sound processor, the memory card, the calendar and the sprite
 * shrinking hardware are absent rather than half-implemented, and each raises.
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 */

export {
  decodeAttribute,
  decodeScb3,
  decodeScb4,
  encodeAttribute,
  encodeScb3,
  encodeScb4,
  expandColor,
  FIRST_USABLE_SPRITE,
  FIX_COLUMNS,
  FIX_MAP,
  FIX_ROWS,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  Lspc,
  PALETTE_ENTRIES,
  SCB1,
  SCB1_STRIDE,
  SCB2,
  SCB3,
  SCB4,
  SPRITE_COUNT,
  SPRITE_ORDER_FRONT_TO_BACK,
  SPRITES_PER_LINE,
  VRAM_WORDS,
  type Frame,
  type LspcOptions,
  type StripPosition,
  type TileAttribute,
} from "./lspc.js";
export {
  BUTTONS,
  CPU_HZ,
  CYCLES_PER_LINE,
  FRAME_CYCLES,
  HEADER_BASE,
  loadNeo,
  LINES_PER_FRAME,
  Neogeo,
  PALETTE_BASE,
  SYSTEM_BUTTONS,
  USER_ENTRY,
  VBLANK_LEVEL,
  VBLANK_VECTOR,
  WATCHDOG_FRAMES,
  WORK_RAM_BASE,
  WORK_RAM_SIZE,
  type Button,
  type Cartridge,
} from "./machine.js";
