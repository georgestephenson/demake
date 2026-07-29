/**
 * `@demake/md` — a self-hosted Mega Drive core.
 *
 * The fourth of the owned cores, and it exists for the two jobs the other three
 * do (doc 14 §Conformance, doc 07 §no CDN): run a `demake build` cartridge in
 * Vitest with no toolchain and no emulator install, and play one in the page
 * without fetching a core from anywhere.
 *
 * It has both of this console's sound chips, because a demade cartridge plays
 * both: the SN76489 at `$C00011` and the YM2612 at `$A04000`, each
 * `@demake/chip`'s model rather than a second implementation of it. What is
 * absent is the Z80 that would normally drive them — `demake build -c md` emits
 * none, so the 68000 owns the FM bus outright, which is what a 68000-only
 * program does on the hardware after taking the Z80's bus.
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 */

export { M68k, VECTOR, type Bus } from "./cpu.js";
export {
  CRAM_ENTRIES,
  CYCLES_PER_LINE,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  LINES_PER_FRAME,
  Vdp,
  type Frame,
} from "./vdp.js";
export { BUTTONS, FRAME_CYCLES, Md, PSG_MIX_GAIN, type Button } from "./machine.js";
