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
 */

import { Asm6502 } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import { selectBank, type SelectedBank } from "../../rom/graphics.js";
import type { Analysis } from "../analyze.js";
import type { Layout } from "../layout.js";
import { MosCtx } from "../mos/ctx.js";

export type { Cond } from "../mos/ctx.js";

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
}
