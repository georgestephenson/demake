/**
 * The Super Nintendo compilation context.
 *
 * Everything about pooled constants and pulled helpers is `CtxBase`'s, because
 * neither is a property of an instruction set. What this adds is the 65816's own
 * shape, and one of the three items is a discipline rather than a helper:
 *
 *   - **The width invariant.** This CPU's accumulator and index registers are
 *     eight or sixteen bits depending on two status flags, and the *instruction
 *     stream itself* changes length with them — an immediate is one byte or two.
 *     So the backend fixes an invariant and keeps it: **at every label, every
 *     call and every return, the accumulator and the index registers are sixteen
 *     bits.** That is the width a 16.16 value wants, which is what almost all of
 *     this backend does. A stretch of code that needs eight-bit arithmetic asks
 *     for it with {@link SnesCtx.narrow}, which restores the invariant on the way
 *     out and must not be branched out of.
 *   - **A branch reaches 128 bytes and a rule body does not.** So every branch
 *     toward a label the emitter did not just define goes through
 *     {@link SnesCtx.far}. Unlike the 6502 backend's, it is one instruction where
 *     it can be — this CPU has `brl`, a sixteen-bit relative branch — but a
 *     *conditional* one still has to be inverted and jumped, exactly as there.
 *   - **A pointer is a register.** The index registers are sixteen bits wide and
 *     `$nnnn,x` reaches all of bank zero, so a helper is told an address by
 *     having it put in `X`. There is no page-zero pointer to write first, which
 *     is most of why this backend is shorter than the 6502 one.
 */

import { Asm65816, imm16, type Ref } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import type { Analysis } from "../analyze.js";
import { CtxBase } from "../ctx.js";
import type { Layout } from "../layout.js";

/** A branch condition, named as the 65816 names its branches. */
export type Cond = "eq" | "ne" | "cs" | "cc" | "mi" | "pl" | "vs" | "vc";

const INVERSE: Readonly<Record<Cond, Cond>> = {
  eq: "ne",
  ne: "eq",
  cs: "cc",
  cc: "cs",
  mi: "pl",
  pl: "mi",
  vs: "vc",
  vc: "vs",
};

/** The status bits that make the accumulator and the index registers narrow. */
export const FLAG_M = 0x20;
export const FLAG_X = 0x10;

/** Emits a helper's body. Called once, after the main program. */
export type SnesHelperBody = (ctx: SnesCtx) => void;

export class SnesCtx extends CtxBase<SnesCtx, Asm65816> {
  readonly asm: Asm65816;

  /**
   * Whether this program's routines are reached across bank boundaries.
   *
   * A LoROM bank is thirty-two kilobytes and `jsr`, `rts` and `jmp` are all
   * bank-local: they carry sixteen bits and take the seventeenth from whichever
   * bank the processor is already in. So a program that does not fit one bank
   * calls with `jsl` and returns with `rtl` — four bytes instead of three, two
   * cycles either way — and this is the switch (doc 13 §Banked cartridges).
   *
   * It is all-or-nothing on purpose. `rts` and `rtl` pull different numbers of
   * bytes, so which one a routine ends with has to match how *every* caller
   * reaches it — and "which callers are in this routine's bank" is not a
   * question an emitter can answer while it is still deciding where things go.
   * Converting the whole program instead makes the answer the same everywhere,
   * and it costs nothing at all for the games that fit one bank: `snes.ts`
   * assembles those exactly as it always did, so their cartridges are
   * byte-identical.
   */
  banked = false;

  /** Call a routine — near inside one bank, long when the program is banked. */
  call(target: Ref): void {
    if (this.banked) this.asm.jsl(target);
    else this.asm.jsr(target);
  }

  /** Return from a routine, matching how {@link call} reached it. */
  ret(): void {
    if (this.banked) this.asm.rtl();
    else this.asm.rts();
  }

  /**
   * Jump to a routine that may not be in this bank.
   *
   * For the handful of transfers that are between *routines* rather than inside
   * one: the scene dispatch, and a scene's tail jump back to the shared tail of
   * the tick. Everything else `jmp`s, because a branch inside a routine cannot
   * leave the bank the routine is in.
   */
  jump(target: Ref): void {
    if (this.banked) this.asm.jml(target);
    else this.asm.jmp(target);
  }

  /** The same, conditionally: invert the branch and jump over it. */
  farJump(cond: Cond, target: Ref): void {
    const over = this.unique("br");
    this.branch(INVERSE[cond], over);
    this.jump(target);
    this.asm.label(over);
  }

  constructor(
    program: Program,
    analysis: Analysis,
    layout: Layout,
    profile: ConsoleProfile,
    origin = 0,
  ) {
    super(program, analysis, layout, profile);
    this.asm = new Asm65816(origin);
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
      case "vs":
        this.asm.bvs(target);
        return;
      case "vc":
        this.asm.bvc(target);
        return;
    }
  }

  /**
   * Run `body` with an eight-bit accumulator, and restore the invariant after.
   *
   * The only sanctioned way to leave sixteen-bit mode. Two rules come with it and
   * neither is enforceable by the assembler, which is why they are stated here:
   *
   *   - **Nothing inside may branch to a label outside.** The width flags are
   *     part of the machine state a label promises, and a jump out of a narrow
   *     block arrives with the accumulator eight bits wide — where the next
   *     `lda #$1234` fetches one byte and executes the other as an opcode.
   *   - **Nothing inside may call a routine.** Every helper this backend emits
   *     assumes the invariant on entry.
   *
   * Where a whole routine wants eight-bit arithmetic — the object builder, the
   * write queue — it narrows once at its entry and widens once before its `rts`,
   * which is this same rule at a different scale.
   */
  narrow(body: () => void): void {
    this.asm.sep(FLAG_M);
    body();
    this.asm.rep(FLAG_M);
  }

  /** Load a sixteen-bit immediate, which is the accumulator's width everywhere. */
  loadImmediate(value: number): void {
    this.asm.lda(imm16(value & 0xffff));
  }
}
