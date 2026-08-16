/**
 * `@demake/ngp` — a self-hosted Neo Geo Pocket core.
 *
 * The tenth owned core, and it exists for the two jobs every one of them does
 * (doc 14 §Conformance, doc 07 §no CDN): run a `demake build` cartridge in
 * Vitest with no toolchain and no emulator install, and play one in the page
 * without fetching a core from anywhere.
 *
 * Like `@demake/wsc` it has **no video memory of its own**: the display
 * controller's registers, its palettes, the two scroll maps, the object table
 * and the character bank are one region of the same address space the game's
 * variables are in, so this package's `Display` is handed the machine's array
 * and nothing is ever uploaded through a port.
 *
 * Its processor is a TLCS-900/H — written against the published instruction set
 * rather than transcribed from another emulator, and driven in its tests by
 * `@demake/core`'s own encoder, which is in turn pinned against the published
 * code maps. On that processor **the operand comes before the opcode**, which is
 * the one genuinely unusual thing about this machine and the reason the decoder
 * is two stages rather than one.
 *
 * It is **both Neo Geo Pockets**, decided by a constructor argument the way
 * `@demake/wsc` is: the maps, the character bank, the object table, the
 * scrolling and the three-deep sprite priority are identical, and only the
 * palettes differ — three grey shades looked up in a table on the mono machine,
 * sixteen four-entry RGB444 palettes per layer on the Color.
 *
 * The **boot ROM is ours**, on `@demake/snes`'s terms: SNK's is not something
 * this project ships, and what a cartridge needs from it is the documented
 * hand-off — read the entry address out of the header, point the stack, jump —
 * plus dispatching the vertical blank through the pointer a cartridge writes
 * into RAM.
 *
 Its **sound** is `@demake/chip`'s `T6w28`, and the one thing about it no
 * register diff can check is that this machine refuses every port write until
 * the cartridge has *asked* for the chip: on the board the T6W28's own bus is a
 * Z80 sound processor's, and two bytes of the console's I/O page hand it to the
 * main CPU. Its **8-bit timers** are here too, for the one caller that wants
 * them — a standalone audio cartridge, whose clock the picture cannot express.
 *
 * What is absent is absent rather than half-implemented, and each is a gap
 * rather than a decision: **input**, because the controller status byte's bit
 * layout is not in a hardware reference this project could reach and a machine
 * description that is wrong and consistent passes everything; the **sound
 * processor** itself; and the on-chip DMA.
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 */

export {
  CpuError,
  Tlcs900,
  FLAG_C,
  FLAG_H,
  FLAG_N,
  FLAG_S,
  FLAG_V,
  FLAG_Z,
  XBC,
  XDE,
  XHL,
  XIX,
  XIY,
  XIZ,
  XSP,
  XWA,
  type Bus,
} from "./cpu.js";
export {
  CYCLES_PER_LINE,
  Display,
  expandChannel,
  LINES_PER_FRAME,
  MONO_SHADES,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  VBLANK_LINE,
  VIDEO_SIZE,
  type NgpModel,
} from "./display.js";
export { BUTTONS, CRYSTAL_HZ, DEFAULT_STACK, Ngp, SYSTEM_HZ, type Button } from "./machine.js";
export { Timers, NGP_T23MOD, type TimerFire } from "./timer.js";
