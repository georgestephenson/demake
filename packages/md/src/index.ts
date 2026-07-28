/**
 * `@demake/md` — a self-hosted Mega Drive core.
 *
 * The fourth of the owned cores, and it exists for the two jobs the other three
 * do (doc 14 §Conformance, doc 07 §no CDN): run a `demake build` cartridge in
 * Vitest with no toolchain and no emulator install, and play one in the page
 * without fetching a core from anywhere.
 *
 * What it deliberately does *not* have is a sound chip. This console's audio is
 * a second processor with a YM2612 beside it, and `demake build -c md` emits
 * neither yet (doc 16 §Still to come) — so the PSG port is accepted and dropped
 * rather than half-modelled, and the day a 68000 driver lands is the day this
 * grows a `@demake/chip` dependency, the way `@demake/sms` has one.
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
