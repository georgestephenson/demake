/**
 * The NES compilation context.
 *
 * Everything the 6502 family shares is {@link MosCtx}'s — the long-branch
 * discipline, the zero-page pointers, the constant pool, the pulled helpers — and
 * what is left here is the two things that really are this console's: which
 * assembler it emits through, and the built-in pattern bank a cartridge's
 * character ROM was cut down to.
 *
 * That it is this short is the point. The value layer beside it
 * (`codegen/mos/`) is a hundred and fifty kilobytes of 16.16 arithmetic, rule
 * bodies and tile walking that the PC Engine backend runs unchanged, because a
 * HuC6280 is a 6502 with a memory mapper on it.
 *
 * The third thing is the mapper, and it is here rather than shared for the same
 * reason: a PC Engine's mapper is in the *CPU* and is four `tam` instructions at
 * boot, while an MMC1 is a shift register on the cartridge that a game writes to
 * ten instructions at a time, all game long.
 */

import { abs, Asm6502, imm } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import { selectBank, type SelectedBank } from "../../rom/graphics.js";
import type { Analysis } from "../analyze.js";
import type { Layout } from "../layout.js";
import { MosCtx } from "../mos/ctx.js";

export type { Cond } from "../mos/ctx.js";

/**
 * Where MMC1's program bank register is written.
 *
 * Anywhere in `$E000`–`$FFFF` selects it — the mapper decodes two address bits
 * and nothing else — and this is the bottom of that quarter, which is inside the
 * fixed half on every board. It is a *write-only* register on a cartridge, so
 * nothing ever reads back what is in the window.
 */
const MMC1_PRG_BANK = 0xe000;

/** Emits a helper's body. Called once, after the main program. */
export type NesHelperBody = (ctx: MosCtx) => void;

export class NesCtx extends MosCtx {
  readonly asm: Asm6502;
  readonly bank: SelectedBank;

  constructor(
    program: Program,
    analysis: Analysis,
    layout: Layout,
    profile: ConsoleProfile,
    origin: number,
    // A context built without one — the arithmetic tests do that — gets a bank
    // with the placeholders and nothing to say, which is what emits no glyphs.
    bank: SelectedBank = selectBank({ characters: "", patterns: true, objectBlock: true }),
  ) {
    super(program, analysis, layout, profile);
    this.asm = new Asm6502(origin);
    this.bank = bank;
  }

  /**
   * Which paged bank each routine outside the fixed half lives in.
   *
   * Empty for a game that fits a mapper-less 32 KiB, which is every example but
   * one, and then this backend emits exactly what it always did. With entries,
   * the routines it names answer `$8000` once MMC1's bank register has been
   * pointed at their bank (doc 13 §Banked cartridges).
   *
   * A *routine*'s map rather than a scene's, because this console's window is
   * sixteen kilobytes and the library's biggest scene is thirty: the units are a
   * scene's tick steps and its three other routines, as on the Sega 8-bits and
   * the Game Boy.
   */
  banks = new Map<string, number>();

  /**
   * Point the window at the bank holding `target`, when it is paged.
   *
   * MMC1's register is **serial**: five stores of one bit each, low bit first,
   * and the fifth is what lands it. The value is built with `lsr` between the
   * stores and the destination is decided by the *address* — `$E000` is the PRG
   * bank — so this is ten instructions where a Sega's is two.
   *
   * It is never emitted inside an interrupt handler, and that is the whole reason
   * this console can page at all: a sequence broken halfway leaves the register
   * holding bits from two different values, and nothing can put it back. The NMI
   * here only uploads a frame and counts an audio tick, both of which live in the
   * fixed half (`nes/emit.ts` §emitNmi).
   */
  enter(target: string): void {
    const bank = this.banks.get(target);
    if (bank === undefined) return;
    this.asm.lda(imm(bank));
    for (let bit = 0; bit < 5; bit += 1) {
      this.asm.sta(abs(MMC1_PRG_BANK));
      if (bit < 4) this.asm.lsr();
    }
  }

  /** Call a routine, paging it in first if it is not in the fixed half. */
  callUnit(target: string): void {
    this.enter(target);
    this.asm.jsr(target);
  }

  /**
   * Jump to a routine, paging it in first.
   *
   * For the dispatches that *tail* into a scene's routine: the routine's own
   * `rts` lands back at whatever called the dispatch, so a jump is a call that
   * costs nothing, banked or not.
   */
  jumpUnit(target: string): void {
    this.enter(target);
    this.asm.jmp(target);
  }
}
