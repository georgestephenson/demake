/**
 * `@demake/wsc` — a self-hosted WonderSwan Color core.
 *
 * The ninth owned core, and it exists for the two jobs every one of them does
 * (doc 14 §Conformance, doc 07 §no CDN): run a `demake build` cartridge in
 * Vitest with no toolchain and no emulator install, and play one in the page
 * without fetching a core from anywhere.
 *
 * What is different about this one is that there is no video memory. The screen
 * maps, the tile bank, the object table and palette RAM are addresses in the
 * same 64 KiB the game's variables live in — so the display reads what the
 * processor writes, with no port and no upload between them, and this package's
 * `Display` is handed the console's RAM rather than owning an array of its own.
 *
 * Its processor is a V30MZ, which is an 8086 core: written against the published
 * instruction set rather than transcribed from another emulator, and driven in
 * its tests by `@demake/core`'s own encoder — which is in turn checked against
 * NASM, so an encoder and a decoder that agreed only with each other would still
 * have to get past a third party.
 *
 * Its sound is `@demake/chip`'s `WsSound`, not a second copy, and it is handed
 * the same RAM for the same reason the display is: this chip's four waveforms
 * are sixty-four bytes of the console's own memory rather than a register file.
 * `soundTap` is the window doc 16's Level A proof reads through, and `audioSink`
 * is where the output goes when something is listening.
 *
 * The **interrupt controller is absent** rather than half-implemented, and
 * nothing a demade cartridge does needs it: the main loop watches the beam, and
 * the audio driver reads the vertical-blank timer's *counter* rather than taking
 * its interrupt — so both timers are modelled as the tallies they are. The two
 * window units, channel two's PCM voice and the mono display modes are absent on
 * the same terms, and each one raises rather than answering plausibly.
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 */

export { AX, BP, BX, CS, CX, Cpu, CpuError, DI, DS, DX, ES, SI, SP, SS, type Bus } from "./cpu.js";
export {
  CYCLES_PER_LINE,
  Display,
  expandChannel,
  LINES_PER_FRAME,
  MAX_SPRITES,
  PALETTE_BASE,
  PORT,
  SPRITES_PER_LINE,
  TILE_BASE,
  VBLANK_LINE,
} from "./display.js";
export {
  BUTTONS,
  CPU_HZ,
  FRAME_CYCLES,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  Wsc,
  type Button,
} from "./machine.js";
