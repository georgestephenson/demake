/**
 * `@demake/vb` — a self-hosted Virtual Boy core.
 *
 * The eleventh owned core, and it exists for the two jobs every one of them does
 * (doc 14 §Conformance, doc 07 §no CDN): run a `demake build` cartridge in
 * Vitest with no toolchain and no emulator install, and play one in the page
 * without fetching a core from anywhere.
 *
 * It is the only core here that renders **two pictures**. The video processor
 * draws every scene once an eye, offset by a parallax the scene itself declares,
 * and {@link Vb.eye} is how a caller asks for one of them — so a test can assert
 * not only that something was drawn but *how far in front of the scenery it
 * was*, which is a claim no other console in this project can make.
 *
 * Its processor is a V810 — written against the published instruction set rather
 * than transcribed from another emulator, and driven in its tests by
 * `@demake/core`'s own encoder, which is in turn pinned against the published
 * format tables.
 *
 * Its **boot is three lines**, on `@demake/neogeo`'s terms: this console has no
 * boot ROM worth modelling, because the processor simply starts fetching at
 * `$FFFFFFF0` — which a 27-bit address bus puts inside the cartridge's own last
 * sixteen bytes — and the cartridge's reset stub takes it from there.
 *
 * What is absent is absent rather than half-implemented, and each is a gap
 * rather than a decision: the **sound processor**, which is the only thing
 * between this console and an in-game audio driver; the affine and h-bias world
 * modes; the hardware timer; and the LED brightness curve, which `vip.ts`
 * explains.
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 */

export {
  CpuError,
  V810,
  PSW_CY,
  PSW_EP,
  PSW_ID,
  PSW_NP,
  PSW_OV,
  PSW_S,
  PSW_Z,
  R30,
  R31,
  type Bus,
} from "./cpu.js";
export {
  Vip,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  VB_DEPTH,
  VB_NEARER,
  VB_SHADES,
  vbParallax,
  vbShade,
  VRAM_SIZE,
  type Eye,
} from "./vip.js";
export {
  BUTTONS,
  CYCLES_PER_FRAME,
  FRAME_HZ,
  MASTER_HZ,
  PAD_ALWAYS_SET,
  Vb,
  type Button,
} from "./machine.js";
