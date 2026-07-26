/**
 * `@demake/sms` — a self-hosted Sega 8-bit core.
 *
 * The third of the owned cores, and it exists for the two jobs the other two do
 * (doc 14 §Conformance, doc 07 §no CDN): run a `demake build` cartridge in
 * Vitest with no toolchain and no emulator install, and play one in the page
 * without fetching a core from anywhere.
 *
 * It is one core for two machines, decided by the cartridge's region nibble
 * rather than by a setting — the arrangement `@demake/dmg` uses for the DMG and
 * the Game Boy Color. What differs between a Master System and a Game Gear is
 * the width of a colour and the size of the window; what does not differ is
 * anything a game's code can see, which is why the same cartridge traces
 * identically on both.
 *
 * Its one dependency is `@demake/chip`, and it is a deliberate one: the PSG here
 * *is* the SN76489 model the audio pipeline renders previews with, because a
 * second implementation of a chip is how the preview and the emulator quietly
 * stop agreeing (doc 16 §Packages).
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 */

export { FLAG, VECTOR, Z80, type Bus } from "./cpu.js";
export {
  CYCLES_PER_LINE,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  GG_HEIGHT,
  GG_LEFT,
  GG_TOP,
  GG_WIDTH,
  LINES_PER_FRAME,
  MAP_COLUMNS,
  MAP_ROWS,
  Vdp,
  type VdpVariant,
} from "./vdp.js";
export { BUTTONS, FRAME_CYCLES, Sms, type Button } from "./machine.js";
