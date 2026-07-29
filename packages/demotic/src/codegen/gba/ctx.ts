/**
 * The Game Boy Advance compilation context.
 *
 * Everything about pooled constants and pulled helpers is `CtxBase`'s, because
 * neither is a property of an instruction set. What this adds is the three
 * things this architecture makes an emitter's business:
 *
 *   - **A branch reaches ±32 MB**, so {@link GbaCtx.far} is one instruction and
 *     there is no long form at all. That is the first console in the set where
 *     the distinction simply does not arise — the 6502's `far` inverts a
 *     condition over a jump, the 68000's needs a second spelling for a target in
 *     another routine, and here a branch reaches the whole cartridge.
 *   - **A routine that calls anything has to save `lr`**, because a call writes a
 *     register rather than pushing a stack frame. {@link GbaCtx.routine} wraps a
 *     body in the save and the return, so a body that later grows a call cannot
 *     silently lose its return address — which would present as a jump into
 *     whatever the last helper's caller was.
 *   - **The literal pool has to be flushed, and where matters.** A pooled
 *     constant must sit within 4 KiB *ahead* of the load that reads it, and it
 *     must not sit anywhere the instruction stream can reach — so
 *     {@link GbaCtx.routine} flushes past the return, which is both.
 *
 * There is no per-console question for this backend to answer. The Sega context
 * has `gameGear` and the Game Boy's has `color`, because each builds for two
 * machines; this one builds for one, and the DS is a second backend rather than
 * a flag here, because its sound lives on a processor this one does not have.
 */

import { AsmArm, type ArmCond, type Ref } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import type { Analysis } from "../analyze.js";
import { CtxBase } from "../ctx.js";
import type { Layout } from "../layout.js";

import { LR, PC, RAM, RAM_BASE } from "./regs.js";

/** A branch condition, as ARM names them. */
export type Cond = ArmCond;

/** Emits a helper's body. Called once, after the main program. */
export type GbaHelperBody = (ctx: GbaCtx) => void;

/** The Game Boy Advance compilation context. */
export class GbaCtx extends CtxBase<GbaCtx, AsmArm> {
  readonly asm: AsmArm;

  constructor(
    program: Program,
    analysis: Analysis,
    layout: Layout,
    profile: ConsoleProfile,
    origin = 0,
  ) {
    super(program, analysis, layout, profile);
    this.asm = new AsmArm(origin);
  }

  /**
   * Take a branch.
   *
   * The counterpart of the other four backends' `far`, and the only one that
   * needs no argument about range: a `b` here is a signed 24-bit word
   * displacement, so it reaches thirty-two megabytes in either direction and a
   * cartridge is thirty-two at most. Nothing in this backend has to know whether
   * its target is in the same routine.
   */
  far(cond: Cond, target: Ref): void {
    this.asm.b(target, cond);
  }

  /**
   * Emit a routine: its label, its body, its return, and its literal pool.
   *
   * Three things happen here rather than at every call site, because forgetting
   * any of them produces a program that runs and is wrong.
   *
   * `lr` is saved when the body may call something. A call on this architecture
   * writes `lr`, so a routine that was itself reached by a call and then calls a
   * helper has lost its own return address — and the symptom is a jump into
   * whatever that helper's previous caller was, which is nowhere near the cause.
   * The default is to save it, because a body that does not call anything today
   * is a body that will.
   *
   * The pool is flushed *past the return*. A pool inside a reachable instruction
   * stream is executed, and a load whose pool is more than 4 KiB ahead of it does
   * not assemble — so the flush belongs at the end of every routine rather than
   * at the end of the program.
   */
  routine(name: string, body: () => void, options: { leaf?: boolean } = {}): void {
    const leaf = options.leaf ?? false;
    this.asm.label(name);
    if (!leaf) this.asm.push([LR]);
    body();
    if (leaf) this.asm.ret();
    else this.asm.pop([PC]);
    this.asm.ltorg();
  }

  /**
   * Return from the routine currently being emitted.
   *
   * A non-leaf routine returns by popping the saved link register straight into
   * the program counter, which is one instruction rather than two — so an early
   * exit in the middle of a body has to spell it the same way the tail does, or
   * it leaves the stack one word deep.
   */
  exit(options: { leaf?: boolean } = {}, cond: Cond = "al"): void {
    if (options.leaf === true) this.asm.ret(cond);
    else this.asm.pop([PC], cond);
  }

  /** Put the work-RAM base in its register; the boot code's first job. */
  loadRamBase(): void {
    this.asm.movImm32(RAM, RAM_BASE);
  }
}
