/**
 * The NES compilation context.
 *
 * Everything about pooled constants and pulled helpers is `CtxBase`'s, because
 * neither is a property of an instruction set. What this adds is the 6502's own
 * shape:
 *
 *   - **A branch reaches 128 bytes and a rule body does not.** So every branch a
 *     backend emits toward a label it did not just define goes through
 *     {@link NesCtx.far}, which inverts the condition and jumps. It is the same
 *     discipline the Game Boy backend keeps by using `jp` rather than `jr`, except
 *     that here the long form has to be built out of two instructions.
 *   - **A pointer is a pair of stores.** Handing a helper the address of a value
 *     means writing it into page zero, so that is one call rather than four lines
 *     at every site.
 */

import { Asm6502, imm, immHigh, immLow, zp, type Ref } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import type { Analysis } from "../analyze.js";
import { CtxBase } from "../ctx.js";
import type { Layout } from "../layout.js";
import { selectBank, type SelectedBank } from "../../rom/graphics.js";

/** A branch condition, named as the 6502 names its branches. */
export type Cond = "eq" | "ne" | "cs" | "cc" | "mi" | "pl";

const INVERSE: Readonly<Record<Cond, Cond>> = {
  eq: "ne",
  ne: "eq",
  cs: "cc",
  cc: "cs",
  mi: "pl",
  pl: "mi",
};

/** Emits a helper's body. Called once, after the main program. */
export type NesHelperBody = (ctx: NesCtx) => void;

export class NesCtx extends CtxBase<NesCtx, Asm6502> {
  readonly asm: Asm6502;

  /**
   * The built-in pattern bank this build pulled.
   *
   * On the context rather than threaded through every emitter because a glyph's
   * tile number is needed wherever a character is drawn — including the decimal
   * renderer, which is shared code with no notion of a scene's art. It is a
   * *build*'s bank, not a module constant, because which patterns exist depends
   * on what the program draws (doc 15 §The conversion path).
   */
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

  /** Take a branch of any length: invert it and jump when it cannot reach. */
  far(cond: Cond, target: Ref): void {
    const over = this.unique("br");
    this.branch(INVERSE[cond], over);
    this.asm.jmp(target);
    this.asm.label(over);
  }

  /**
   * Take a branch that is certainly within reach.
   *
   * For a target defined a few instructions away in the same emitter — a loop
   * head, a two-instruction skip. Anything a caller passed in goes through
   * {@link far}, because a rule body is routinely a kilobyte long and the
   * assembler correctly refuses rather than wrapping.
   */
  branch(cond: Cond, target: Ref): void {
    switch (cond) {
      case "eq":
        this.asm.beq(target);
        return;
      case "ne":
        this.asm.bne(target);
        return;
      case "cs":
        this.asm.bcs(target);
        return;
      case "cc":
        this.asm.bcc(target);
        return;
      case "mi":
        this.asm.bmi(target);
        return;
      case "pl":
        this.asm.bpl(target);
        return;
    }
  }

  /** Put an address into a page-zero pointer, for a helper to dereference. */
  pointer(slot: number, address: Ref): void {
    this.asm.lda(immLow(address));
    this.asm.sta(zp(slot));
    this.asm.lda(immHigh(address));
    this.asm.sta(zp(slot + 1));
  }

  /** Load Y with a constant, which is how a helper indexes through a pointer. */
  yIndex(value: number): void {
    this.asm.ldy(imm(value));
  }

  /**
   * `slot += address`, on a page-zero pointer.
   *
   * The tile walk builds an offset into a grid and then has to turn it into an
   * address; adding the label afterwards is what lets the offset be computed in
   * sixteen bits without the base getting in the way of the carry.
   */
  addPointer(slot: number, address: Ref): void {
    this.asm.clc();
    this.asm.lda(zp(slot));
    this.asm.adc(immLow(address));
    this.asm.sta(zp(slot));
    this.asm.lda(zp(slot + 1));
    this.asm.adc(immHigh(address));
    this.asm.sta(zp(slot + 1));
  }
}
