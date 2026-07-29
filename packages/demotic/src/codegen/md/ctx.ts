/**
 * The Mega Drive compilation context.
 *
 * Everything about pooled constants and pulled helpers is `CtxBase`'s, because
 * neither is a property of an instruction set. What this adds is the 68000's own
 * shape, and there is even less of it than the Z80 needed:
 *
 *   - **A branch reaches a rule body but not a program.** `Bcc` takes a
 *     sixteen-bit displacement, which covers any one routine and nothing
 *     further; `jmp` is absolute and always reaches. So {@link MdCtx.far} is one
 *     instruction for the in-routine case the emitters use constantly, and
 *     {@link MdCtx.farJump} is the two-instruction form for the handful of
 *     places that cross the whole program.
 *   - **A pointer is a register with room to spare.** Eight of them, thirty-two
 *     bits wide, so nothing here helps with dereferencing the way the 6502
 *     backend's page-zero pointers have to.
 *
 * There is no per-console question for this backend to answer. The Sega context
 * has `gameGear` and the Game Boy's has `color`, because each of those builds
 * for two machines; this one builds for one.
 */

import { Asm68k, eaAbs, type M68kCC, type Ref } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import type { Analysis } from "../analyze.js";
import { CtxBase } from "../ctx.js";
import type { Layout } from "../layout.js";

/** A branch condition, as the 68000 names its jumps. */
export type Cond = M68kCC;

/** The opposite of a condition, for a branch that has to be inverted. */
const OPPOSITE: Readonly<Record<string, Cond>> = {
  eq: "ne",
  ne: "eq",
  cs: "cc",
  cc: "cs",
  mi: "pl",
  pl: "mi",
  vs: "vc",
  vc: "vs",
  lt: "ge",
  ge: "lt",
  gt: "le",
  le: "gt",
  hi: "ls",
  ls: "hi",
};

/** Emits a helper's body. Called once, after the main program. */
export type MdHelperBody = (ctx: MdCtx) => void;

export class MdCtx extends CtxBase<MdCtx, Asm68k> {
  readonly asm: Asm68k;

  constructor(
    program: Program,
    analysis: Analysis,
    layout: Layout,
    profile: ConsoleProfile,
    origin = 0,
  ) {
    super(program, analysis, layout, profile);
    this.asm = new Asm68k(origin);
  }

  /**
   * Take a branch inside a routine.
   *
   * The counterpart of the 6502 backend's `far` and the Z80 backend's, and like
   * the Z80's it is one instruction — but for a weaker reason. A `Bcc` here is
   * sixteen signed bits, which is a rule body and not a program, so a target in
   * another routine needs {@link farJump} instead. Every call site in the
   * emitters below is within one routine by construction.
   */
  far(cond: Cond, target: Ref): void {
    this.asm.bcc(cond, target);
  }

  /**
   * The same, for a target anywhere in the cartridge.
   *
   * Inverts the condition over an absolute jump, which costs ten bytes against
   * four. Used only where the distance really is unbounded — a scene's tick
   * routine reaching another scene's — because paying it everywhere would be
   * most of a rule body.
   */
  farJump(cond: Cond, target: Ref): void {
    const over = this.unique("over");
    this.asm.bcc(OPPOSITE[cond] as Cond, over);
    this.asm.jmp(eaAbs(target));
    this.asm.label(over);
  }
}
