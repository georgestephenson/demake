/**
 * The Neo Geo Pocket Color compilation context.
 *
 * Everything about pooled constants and pulled helpers is `CtxBase`'s, because
 * neither is a property of an instruction set. What this adds is the
 * TLCS-900/H's own shape, and there is less of it than any other backend needed:
 *
 *   - **A conditional branch never has to be inverted.** This is the only
 *     processor in the set with both a long conditional relative branch and a
 *     conditional *absolute* jump, so {@link NgpcCtx.far} is a `jrl` — three
 *     bytes, ±32 KiB, which covers any routine — and {@link NgpcCtx.farJump} is
 *     a `jp cc` that reaches the whole 24-bit space in five. The 6502, the Z80
 *     and the V30MZ all invert a condition over an unconditional jump for the
 *     long case; here there is nothing to invert.
 *   - **A pointer is a register with room to spare.** Eight of them, thirty-two
 *     bits wide, so nothing here helps with dereferencing the way the 6502
 *     backend's page-zero pointers have to.
 *
 * There is no per-console question for this backend to answer yet. The Sega
 * context has `gameGear` and the Game Boy's has `color` because each builds for
 * two machines; this one builds for one until the mono Neo Geo Pocket's art path
 * exists.
 */

import { Asm900, type Ref, type T9CC } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import type { Analysis } from "../analyze.js";
import { CtxBase } from "../ctx.js";
import type { Layout } from "../layout.js";

/** A branch condition, as the TLCS-900/H names its jumps. */
export type Cond = T9CC;

/** Emits a helper's body. Called once, after the main program. */
export type NgpcHelperBody = (ctx: NgpcCtx) => void;

export class NgpcCtx extends CtxBase<NgpcCtx, Asm900> {
  readonly asm: Asm900;

  constructor(
    program: Program,
    analysis: Analysis,
    layout: Layout,
    profile: ConsoleProfile,
    origin = 0,
  ) {
    super(program, analysis, layout, profile);
    this.asm = new Asm900(origin);
  }

  /**
   * Take a branch inside a routine.
   *
   * The counterpart of the 6502 backend's `far` and the Mega Drive's, and like
   * the Mega Drive's it is one instruction — a sixteen-bit displacement covers
   * any one rule body and nothing further, so a target in another routine needs
   * {@link farJump}. Every call site in the emitters is within one routine by
   * construction.
   */
  far(cond: Cond, target: Ref): void {
    this.asm.jrl(cond, target);
  }

  /**
   * The same, for a target anywhere in the cartridge.
   *
   * Five bytes against three, and — unlike every other backend's long branch —
   * still a single conditional instruction, because this processor has a
   * conditional jump to an absolute address. Used only where the distance really
   * is unbounded, such as a scene's tick routine reaching another scene's.
   */
  farJump(cond: Cond, target: Ref): void {
    this.asm.jpc(cond, target);
  }
}
