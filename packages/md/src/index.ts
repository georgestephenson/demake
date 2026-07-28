/**
 * `@demake/md` — a self-hosted Mega Drive core.
 *
 * The fourth of the owned cores, and it exists for the two jobs the other three
 * do (doc 14 §Conformance, doc 07 §no CDN): run a `demake build` cartridge in
 * Vitest with no toolchain and no emulator install, and play one in the page
 * without fetching a core from anywhere.
 *
 * It has **half** this console's sound, and it is the half a demade cartridge
 * plays: the SN76489 at `$C00011`, which is `@demake/chip`'s model rather than a
 * second implementation of it. The other half is a Z80 with a YM2612 beside it
 * and `demake build -c md` emits neither (doc 16 §Still to come), so nothing here
 * pretends to it — an FM register write reaches a Z80 bus that answers as RAM,
 * which is exactly what a 68000-only program sees on the hardware.
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
export { BUTTONS, FRAME_CYCLES, Md, type Button } from "./machine.js";
