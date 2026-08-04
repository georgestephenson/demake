/**
 * The 6502-family compilation context: what two consoles' backends share.
 *
 * Everything about pooled constants and pulled helpers is `CtxBase`'s, because
 * neither is a property of an instruction set. What this adds is the *CPU's* own
 * shape, and it is a family's rather than a machine's — an NES and a PC Engine
 * differ in every register the picture answers on and in not one of these:
 *
 *   - **A branch reaches 128 bytes and a rule body does not.** So every branch a
 *     backend emits toward a label it did not just define goes through
 *     {@link MosCtx.far}, which inverts the condition and jumps. It is the same
 *     discipline the Game Boy backend keeps by using `jp` rather than `jr`, except
 *     that here the long form has to be built out of two instructions.
 *   - **A pointer is a pair of stores.** Handing a helper the address of a value
 *     means writing it into the zero page, so that is one call rather than four
 *     lines at every site.
 *
 * `asm` is `Asm6502` here and a `Asm6280` on the console whose CPU is a superset
 * of it (`core/src/asm/huc6280.ts`). That is what lets `val.ts`, `expr.ts`,
 * `rules.ts` and `tiles.ts` beside this file be *one* copy: they emit 6502
 * instructions, and 6502 instructions are what both machines run. A backend
 * reaches its own extras through its own context, whose `asm` is narrower.
 */

import { Asm6502, imm, immHigh, immLow, zp, type Ref } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import type { Analysis } from "../analyze.js";
import { CtxBase } from "../ctx.js";
import type { Layout } from "../layout.js";
import type { SelectedBank } from "../../rom/graphics.js";
import { slotOf } from "./zp.js";

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
export type MosHelperBody = (ctx: MosCtx) => void;

/**
 * One compilation, for a machine whose processor is a 6502.
 *
 * Abstract in exactly one thing — the assembler — because that is the one place
 * the two consoles differ at this level: a HuC6280 has fifty instructions a 6502
 * does not, and a backend that wants them says so by narrowing `asm` rather than
 * by casting at every call site.
 */
export abstract class MosCtx extends CtxBase<MosCtx, Asm6502> {
  abstract override readonly asm: Asm6502;

  /**
   * The built-in pattern bank this build pulled.
   *
   * On the context rather than threaded through every emitter because a glyph's
   * tile number is needed wherever a character is drawn — including the decimal
   * renderer, which is shared code with no notion of a scene's art. It is a
   * *build*'s bank, not a module constant, because which patterns exist depends
   * on what the program draws (doc 15 §The conversion path).
   */
  abstract readonly bank: SelectedBank;

  /**
   * Where this CPU's cheaply-addressed page begins, as an address.
   *
   * `$0000` on a 6502 and `$2000` on a HuC6280, read off the plan rather than
   * asked of the console — because it is the *plan* that decides where the
   * allocator put things, and a routine that reaches a cheap byte with `$nnnn,x`
   * needs the base the short form leaves out (`mos/zp.ts` §ZERO_PAGES).
   */
  get zeroPage(): number {
    return (this.layout.memory.fastStart ?? 0) & ~0xff;
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

  /**
   * Put an address into a zero-page pointer, for a helper to dereference.
   *
   * `slot` is where the pointer *is* — a machine address, like every other
   * allocation — and {@link slotOf} reduces it to the operand the instruction
   * takes. The two are the same number on a 6502 and differ by `$2000` on a
   * HuC6280 (`mos/zp.ts` §ZERO_PAGES).
   */
  pointer(slot: number, address: Ref): void {
    const at = slotOf(slot);
    this.asm.lda(immLow(address));
    this.asm.sta(zp(at));
    this.asm.lda(immHigh(address));
    this.asm.sta(zp(at + 1));
  }

  /** Load Y with a constant, which is how a helper indexes through a pointer. */
  yIndex(value: number): void {
    this.asm.ldy(imm(value));
  }

  /**
   * `slot += address`, on a zero-page pointer.
   *
   * The tile walk builds an offset into a grid and then has to turn it into an
   * address; adding the label afterwards is what lets the offset be computed in
   * sixteen bits without the base getting in the way of the carry.
   */
  addPointer(slot: number, address: Ref): void {
    const at = slotOf(slot);
    this.asm.clc();
    this.asm.lda(zp(at));
    this.asm.adc(immLow(address));
    this.asm.sta(zp(at));
    this.asm.lda(zp(at + 1));
    this.asm.adc(immHigh(address));
    this.asm.sta(zp(at + 1));
  }
}

/** Re-exported so a backend's own context file has one import for the family. */
export type { Analysis, ConsoleProfile, Layout, Program, SelectedBank };
