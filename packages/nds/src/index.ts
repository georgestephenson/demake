/**
 * `@demake/nds` — a self-hosted Nintendo DS core.
 *
 * The seventh of the owned cores, and the smallest: the processor is
 * `@demake/gba`'s `Arm7` and the picture is `@demake/gba`'s `Ppu`, because on
 * everything a demade game touches they are the same processor and the same 2D
 * engine. What is here is the machine around them — 4 MiB of main RAM a
 * cartridge is *copied into* rather than run from, nine video RAM banks of which
 * two are mapped, and a screen a third larger than the one the engine was
 * written for.
 *
 * It exists for the two jobs the other six do (doc 14 §Conformance, doc 07 §no
 * CDN): run a `demake build` cartridge in Vitest with no toolchain and no
 * emulator install, and play one in the page without fetching a core from
 * anywhere.
 *
 * What is deliberately absent, rather than pending: Thumb, because
 * `core/src/asm/arm.ts` emits none; 2D engine B and the second screen, because a
 * game is one screen and a renderer nobody drives is a renderer nobody checks;
 * the affine and bitmap modes, for the same reason; interrupts, because this
 * console's backend waits on the beam; and the ARM7, which exists to drive the
 * sound registers and has no driver yet (doc 13 §D4). Every one of them raises
 * rather than being quietly accepted.
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock.
 */

export {
  BUTTONS,
  CLOCK_HZ,
  CYCLES_PER_LINE,
  FRAME_CYCLES,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  LINES_PER_FRAME,
  MAIN_RAM_SIZE,
  Nds,
  NdsError,
  STACK_TOP,
  type Button,
} from "./machine.js";
