/**
 * `@demake/nes` — a self-hosted NES core.
 *
 * The Game Boy has `@demake/dmg` for exactly two jobs, and the NES needs both of
 * them for exactly the same reasons:
 *
 *   - **The conformance harnesses.** A Demotic cartridge has to reproduce the
 *     reference interpreter's fixed-point state tick for tick (doc 14
 *     §Conformance), and an audio ROM has to write its schedule's registers tick
 *     for tick (doc 16 §The proof). Running both in Vitest means the loops that
 *     prove a runtime correct are available on any machine that can run
 *     `pnpm test` — no cc65, no FCEUX, no libretro core. The libretro E2E still
 *     runs the framebuffer comparison, which is the layer this cannot test.
 *   - **The web app.** Doc 07 forbids fetching a core from a CDN, and shipping a
 *     WASM emulator we cannot read would be the same bargain in a different
 *     wrapper.
 *
 * Its one dependency is `@demake/chip`, and it is a deliberate one: the APU here
 * *is* the 2A03 model the audio pipeline renders previews with, because a second
 * implementation of a chip is how the preview and the emulator quietly stop
 * agreeing (doc 16 §Packages).
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 */

export { Cpu, VECTOR, type Bus } from "./cpu.js";
export { NES_MASTER, Ppu, DOTS_PER_LINE, LINES_PER_FRAME, type Mirroring } from "./ppu.js";
export { BUTTONS, FRAME_CYCLES, Nes, SCREEN_HEIGHT, SCREEN_WIDTH, type Button } from "./machine.js";
