/**
 * `@demake/dmg` — a self-hosted Game Boy core.
 *
 * It exists because two jobs in this repository need one and neither can take a
 * dependency on someone else's:
 *
 *   - **The conformance harness.** A Demotic ROM has to reproduce the reference
 *     interpreter's fixed-point state tick for tick (doc 14 §Conformance).
 *     Running that in Vitest, with no toolchain and no emulator install, means
 *     the loop that proves a runtime correct is available on any machine that
 *     can run `pnpm test`. SameBoy still runs the framebuffer E2E; this runs the
 *     logic one, which is the layer that finds bugs fastest.
 *   - **The web app.** Doc 07 forbids fetching a core from a CDN, and shipping
 *     a WASM emulator we cannot read would be the same bargain in a different
 *     wrapper. This is ~1200 lines of TypeScript with no dependencies, which is
 *     the same call the repository already made for its PNG codec.
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 */

export { Cpu, INT, type Bus } from "./cpu.js";
export {
  BUTTONS,
  FRAME_CYCLES,
  Gameboy,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type Button,
} from "./machine.js";
