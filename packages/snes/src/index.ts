/**
 * `@demake/snes` — a self-hosted Super Nintendo core.
 *
 * The fourth of these, and it is here for the two jobs `@demake/dmg`,
 * `@demake/nes` and `@demake/sms` are here for:
 *
 *   - **The conformance harness.** A Demotic cartridge has to reproduce the
 *     reference interpreter's fixed-point state tick for tick (doc 14
 *     §Conformance). Running that in Vitest means the loop that proves a runtime
 *     correct is available on any machine that can run `pnpm test` — no WLA-DX, no
 *     libretro core. The pixel-perfect E2E still runs the framebuffer comparison,
 *     which is the layer this cannot test.
 *   - **The web app.** Doc 07 forbids fetching a core from a CDN, and shipping a
 *     WASM emulator we cannot read would be the same bargain in a different
 *     wrapper.
 *
 * Unlike the other three it has no `@demake/chip` dependency, and that is a gap
 * rather than a design: the S-DSP is not modelled and the S-SMP is not
 * implemented, so a cartridge this core runs is silent. Doc 16 §Still to come is
 * where that sits. Everything else a Demotic cartridge uses is here.
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 */

export { Cpu, FLAG, VECTOR, type Bus } from "./cpu.js";
export {
  LINES_PER_FRAME,
  MASTER_PER_LINE,
  OBJECTS_PER_LINE,
  Ppu,
  VBLANK_LINE,
  objectSizeBit,
} from "./ppu.js";
export {
  BUTTONS,
  FRAME_CYCLES,
  MASTER_PER_CPU,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  Snes,
  type Button,
} from "./machine.js";
