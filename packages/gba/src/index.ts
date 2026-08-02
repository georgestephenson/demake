/**
 * `@demake/gba` — a self-hosted Game Boy Advance core.
 *
 * The fifth of the owned cores, and it exists for the two jobs the other four do
 * (doc 14 §Conformance, doc 07 §no CDN): run a `demake build` cartridge in
 * Vitest with no toolchain and no emulator install, and play one in the page
 * without fetching a core from anywhere.
 *
 * Both halves of this console's sound are here, because a demade cartridge plays
 * both. The four Game Boy channels are `@demake/chip`'s `GbApu` reached through
 * a permuted register map — a machine description rather than a second chip, the
 * Mega Duck's arrangement exactly — and the two direct-sound channels are
 * `DirectSound`, which is the pair of converters DMA feeds rather than the mixer
 * that decides what to feed them. That second distinction is load-bearing: the
 * mixer is `@demake/chip`'s `GbaPcm`, and comparing what a cartridge sends here
 * against what that renders is doc 16's proof for a console whose sample voices
 * are software.
 *
 * What is deliberately absent, rather than pending: Thumb, because
 * `core/src/asm/arm.ts` emits none; the affine background and object modes and
 * every bitmap video mode, because `demake build` programs mode 0 and a renderer
 * nobody drives is a renderer nobody checks; and Nintendo's BIOS, which is
 * neither shipped nor needed — the interrupt dispatcher is six instructions of
 * ours.
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 */

export {
  Arm7,
  CpuError,
  MODE_ABT,
  MODE_FIQ,
  MODE_IRQ,
  MODE_SVC,
  MODE_SYS,
  MODE_UND,
  MODE_USER,
  VECTOR,
  type Bus,
} from "./cpu.js";
export {
  CYCLES_PER_LINE,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  LINES_PER_FRAME,
  OAM_ENTRIES,
  OBJ_VRAM_BASE,
  PALETTE_ENTRIES,
  Ppu,
  PpuError,
  VRAM_SIZE,
  type Frame,
} from "./ppu.js";
export { DirectSound, FIFO_REFILL_AT, FIFO_SIZE } from "./sound.js";
export {
  BUTTONS,
  CLOCK_HZ,
  FRAME_CYCLES,
  Gba,
  IRQ,
  PSG_MIX_GAIN,
  ROM_BASE,
  type Button,
} from "./machine.js";
