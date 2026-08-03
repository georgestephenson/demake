/**
 * `@demake/pce` — a self-hosted PC Engine core.
 *
 * The eighth owned core, and it exists for the two jobs every one of them does
 * (doc 14 §Conformance, doc 07 §no CDN): run a `demake build` cartridge in
 * Vitest with no toolchain and no emulator install, and play one in the page
 * without fetching a core from anywhere.
 *
 * What is different about this one is what it is a core *of*. The CPU is a 6502
 * with a memory mapper and block transfers, so `@demake/nes`'s decoder was the
 * obvious thing to copy and is deliberately not what happened: it is transcribed
 * from the reference again, because two transcriptions disagree loudly where a
 * copy would inherit a wrong answer in silence. The picture hardware has nothing
 * in common with a 2C02 at all — word-addressed video RAM behind a port, a
 * palette in a cell's own map entry, sixteen-pixel sprites and a sprite table the
 * chip *copies* rather than reads.
 *
 * It has no dependency on `@demake/chip`, which every other core here does, and
 * that is a gap rather than a design: this console's PSG has no model yet, so a
 * cartridge built for it carries no audio driver (doc 13 §Console rollout). The
 * write tap the audio proof needs is already on the machine, so closing the gap
 * is a chip and a binding rather than a change here.
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 */

export { Cpu, HARDWARE_PAGE, STACK, VECTOR, ZERO_PAGE, type Bus } from "./cpu.js";
export { LINES_PER_FRAME, MASTER_PER_LINE, REG, Vdc, expandColor } from "./vdc.js";
export { BUTTONS, FRAME_MASTER, Pce, SCREEN_HEIGHT, SCREEN_WIDTH, type Button } from "./machine.js";
