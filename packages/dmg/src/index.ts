/**
 * `@demake/dmg` — a self-hosted Game Boy core.
 *
 * It exists because two jobs in this repository need one and neither can take a
 * dependency on someone else's:
 *
 *   - **The conformance harnesses.** A Demotic ROM has to reproduce the
 *     reference interpreter's fixed-point state tick for tick (doc 14
 *     §Conformance), and an audio ROM has to write its schedule's registers tick
 *     for tick (doc 16 §The proof). Running both in Vitest, with no toolchain
 *     and no emulator install, means the loops that prove a runtime correct are
 *     available on any machine that can run `pnpm test`. SameBoy still runs the
 *     framebuffer E2E; this runs the logic ones, which are the layers that find
 *     bugs fastest.
 *   - **The web app.** Doc 07 forbids fetching a core from a CDN, and shipping
 *     a WASM emulator we cannot read would be the same bargain in a different
 *     wrapper. This is ~1200 lines of TypeScript, which is the same call the
 *     repository already made for its PNG codec.
 *
 * Its two dependencies are deliberate, and for one reason between them: a
 * hardware fact must exist once. The APU here *is* `@demake/chip`'s model, the
 * one the audio pipeline renders previews with, because a second implementation
 * of a chip is how the preview and the emulator quietly stop agreeing (doc 16
 * §Packages). And the Mega Duck's I/O map is `@demake/core`'s
 * (`asm/megaduck.ts`), because the audio driver and the game backend emit code
 * against the same table this routes writes through.
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 */

export { Cpu, INT, type Bus } from "./cpu.js";
export {
  BUTTONS,
  DMG_SHADES,
  FRAME_CYCLES,
  Gameboy,
  MEGADUCK_SHADES,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type Button,
  type Machine,
} from "./machine.js";
