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
 * It carries a whole second computer, which none of the others do: the S-SMP is
 * an SPC700 with its own 64 KiB and its own program, and the S-DSP hanging off it
 * is `@demake/chip`'s — not a second model, on the same terms as every other
 * console here. A cartridge boots by *uploading* its sound driver through four
 * mailbox bytes, so `smp.ts` implements the handshake as well as the processor.
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
export { BOOT_ROM, BOOT_ROM_BASE, DSP_CLOCKS_PER_CYCLE, SPC_CLOCK_HZ, Smp } from "./smp.js";
export {
  BUTTONS,
  FRAME_CYCLES,
  MASTER_PER_CPU,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  Snes,
  type Button,
} from "./machine.js";
