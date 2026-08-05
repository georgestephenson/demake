/**
 * The WonderSwan compilation context.
 *
 * Everything about pooled constants and pulled helpers is `CtxBase`'s, because
 * neither is a property of an instruction set. What this adds is the V30MZ's own
 * shape, and there are exactly two things in it.
 *
 *   - **A conditional branch reaches ±128 bytes**, because a near conditional
 *     jump is an 80386 instruction and this is not one. A rule body is routinely
 *     a kilobyte, so {@link WscCtx.far} inverts the condition and jumps over an
 *     unconditional one — the 6502 backend's discipline exactly, on a processor
 *     three generations later. `jcc` direct is for a target a few instructions
 *     away, where the distance is visible in the same emitter.
 *   - **A table lives in a different segment from the state.** `DS` is the
 *     console's RAM and `CS` is the cartridge, so reading a level's grid or a
 *     packed backdrop carries a one-byte override and reading a property does
 *     not. That is a fact about the *operand* rather than about the context, so
 *     what is here is only the name: `ops.ts`'s `romAt` and `romAbs` are how an
 *     emitter says which of the two it means.
 */

import { Asm30, type Ref } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import type { Analysis } from "../analyze.js";
import { CtxBase } from "../ctx.js";
import type { Layout } from "../layout.js";

import { WSC_MACHINE, type WsMachine } from "./machine.js";
import { invert, type CC } from "./ops.js";

/** Emits a helper's body. Called once, after the main program. */
export type WscHelperBody = (ctx: WscCtx) => void;

export class WscCtx extends CtxBase<WscCtx, Asm30> {
  readonly asm: Asm30;

  constructor(
    program: Program,
    analysis: Analysis,
    layout: Layout,
    profile: ConsoleProfile,
    /**
     * Which WonderSwan this build is for.
     *
     * A description rather than a branch (`machine.ts`): the two machines run
     * byte-for-byte the same instructions and differ only in where things are
     * and how wide a tile is.
     */
    readonly machine: WsMachine = WSC_MACHINE,
    origin = 0,
  ) {
    super(program, analysis, layout, profile);
    this.asm = new Asm30(origin);
  }

  /**
   * Take a branch of any length.
   *
   * Three bytes more than the conditional jump it replaces, and the reason it is
   * unconditional at every call site that was handed a label: an emitter that
   * used `jcc` for a target it did not measure produces a program that assembles
   * until the day a rule body grows past 128 bytes, and then refuses. The
   * assembler raises rather than wrapping, so the failure is loud — but it is
   * still a failure that appears in large games only, which is the class of bug
   * this exists to make impossible.
   */
  far(cond: CC, target: Ref): void {
    const over = this.unique("far");
    this.asm.jcc(invert(cond), over);
    this.asm.jmp(target);
    this.asm.label(over);
  }
}
