/**
 * `@demake/ngp` — a self-hosted Neo Geo Pocket core.
 *
 * The tenth owned core, and it exists for the two jobs every one of them does:
 * run a built cartridge in Vitest with no toolchain and no emulator install, and
 * play one in the page without fetching a core from anywhere (doc 07: no CDN).
 *
 * What is here so far is the processor. The display controller, the machine
 * around them and the sound are still to come, and each is named in doc 13
 * rather than half-present.
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
