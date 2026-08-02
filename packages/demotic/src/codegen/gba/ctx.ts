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
 * The per-console question this backend answers is {@link GbaCtx.machine}, and it
 * is the Sega context's `gameGear` and the Game Boy's `color` one console along:
 * a Nintendo DS's 2D engine A is a Game Boy Advance's, so the second machine is
 * a *description* — where the program lives, where objects answer, what has to
 * be switched on, how the loop waits — and not a second emitter
 * (`machine.ts` §the two machines).
 */

import { AsmArm, type ArmCond, type Ref } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import type { Analysis } from "../analyze.js";
import { CtxBase } from "../ctx.js";
import type { Layout } from "../layout.js";

import type { GbaMachine } from "./machine.js";
import { LR, PC, RAM } from "./regs.js";

/** A branch condition, as ARM names them. */
export type Cond = ArmCond;

/** Emits a helper's body. Called once, after the main program. */
export type GbaHelperBody = (ctx: GbaCtx) => void;

/** The Game Boy Advance compilation context. */
export class GbaCtx extends CtxBase<GbaCtx, AsmArm> {
  readonly asm: AsmArm;
  /** Which of the two machines this build is for. */
  readonly machine: GbaMachine;

  constructor(
    program: Program,
    analysis: Analysis,
    layout: Layout,
    profile: ConsoleProfile,
    machine: GbaMachine,
  ) {
    super(program, analysis, layout, profile);
    this.machine = machine;
    this.asm = new AsmArm(machine.origin);
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

  /**
   * Place the literal pool early, if the oldest waiting constant is getting far.
   *
   * A pooled load reaches 4 KiB ahead of itself and a rule body can be longer
   * than that, so a routine cannot always keep its whole pool at the end. This is
   * what an emitter calls at a safe point — between rules, between objects — to
   * put the pool down over a branch, which is legal anywhere and costs one
   * instruction plus the words themselves.
   *
   * The margin is generous on purpose: what has to be true is that no load
   * emitted between here and the *next* safe point falls off the end, and an
   * emitter cannot know how long that is. A kilobyte of slack is a few hundred
   * instructions.
   */
  poolCheck(limit = 3000): void {
    if (this.asm.pending === 0 || this.asm.poolAge < limit) return;
    const over = this.unique("pool");
    this.asm.b(over);
    this.asm.ltorg();
    this.asm.label(over);
  }

  /**
   * Put the work-RAM base in its register; the boot code's first job.
   *
   * The plan's own `heapStart` rather than a constant beside it, because the two
   * being one number is what makes `mem`'s window arithmetic true: a base
   * register that pointed anywhere else would put every access one machine's
   * distance from where the allocator put it.
   */
  loadRamBase(): void {
    this.asm.movImm32(RAM, this.layout.memory.heapStart);
  }
}
