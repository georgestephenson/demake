/**
 * The Virtual Boy compilation context.
 *
 * Everything about pooled constants and pulled helpers is `CtxBase`'s, because
 * neither is a property of an instruction set. What this adds is the V810's own
 * shape, and there is one thing in it that no other backend's context has to do.
 *
 * **A conditional branch reaches ±256 bytes**, which is the shortest in the
 * project — a fifth of what the 6502 gets and a hundredth of what the TLCS-900/H
 * does. A rule body is routinely a kilobyte, so {@link VbCtx.far} inverts the
 * condition over a `jr`, which reaches ±32 MiB and therefore always lands on a
 * console whose largest cartridge is two megabytes. That makes `far` two
 * instructions where the Neo Geo Pocket's is one and the Mega Drive's is one —
 * and it is why nothing in this backend ever emits a bare `bcond` to a label a
 * caller supplied.
 *
 * {@link VbCtx.farJump} is the same instruction, and it is the same instruction
 * *because* `jr` already reaches everywhere: this is the only console here where
 * the short form is the one that needs help and the long form has no limit worth
 * naming.
 */

import { Asm810, invertV810Cond, type Ref, type V810Cond } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import type { Analysis } from "../analyze.js";
import { CtxBase } from "../ctx.js";
import type { Layout } from "../layout.js";

/** A branch condition, as the V810 names its branches. */
export type Cond = V810Cond;

/** Emits a helper's body. Called once, after the main program. */
export type VbHelperBody = (ctx: VbCtx) => void;

export class VbCtx extends CtxBase<VbCtx, Asm810> {
  readonly asm: Asm810;

  constructor(
    program: Program,
    analysis: Analysis,
    layout: Layout,
    profile: ConsoleProfile,
    origin = 0,
  ) {
    super(program, analysis, layout, profile);
    this.asm = new Asm810(origin);
  }

  /**
   * Take a branch to a label a caller supplied.
   *
   * Inverted over a `jr`, because a conditional branch on this processor reaches
   * ±256 bytes and a rule body is a kilobyte. Four bytes plus two against the
   * two a bare branch would take, which is the price of never having to know how
   * far away the target is — the 6502 backend's bargain, on a machine whose
   * short branch is half as long again.
   */
  far(cond: Cond, target: Ref): void {
    const over = this.unique("far");
    this.asm.bcond(invertV810Cond(cond), over);
    this.asm.jr(target);
    this.asm.label(over);
  }

  /**
   * The same, and it is the same: `jr` reaches ±32 MiB, which is sixteen times
   * the largest cartridge this console has.
   *
   * Kept as its own name because every other backend distinguishes the two and a
   * reader coming from one of them should find the distinction answered rather
   * than absent.
   */
  farJump(cond: Cond, target: Ref): void {
    this.far(cond, target);
  }

  /** An unconditional jump that always reaches. */
  jump(target: Ref): void {
    this.asm.jr(target);
  }
}
