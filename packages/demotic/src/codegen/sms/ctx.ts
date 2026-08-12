/**
 * The Sega compilation context.
 *
 * Everything about pooled constants and pulled helpers is `CtxBase`'s, because
 * neither is a property of an instruction set. What this adds is the Z80's own
 * shape — and the striking thing is how little that is, compared with what the
 * other two backends need:
 *
 *   - **Every conditional jump reaches.** The 6502 backend carries a `far` that
 *     inverts a condition and jumps, because a branch there is eight signed bits
 *     and a rule body is a kilobyte; the Game Boy backend uses `jp` over `jr` for
 *     the same reason. Here `jp cc, nn` is a real instruction with a sixteen-bit
 *     target, so `far` is one instruction and exists only so the three backends
 *     read alike at their call sites. `jr` is still eight bits and is still
 *     reserved for a target defined a few instructions away.
 *   - **A pointer is a register, not a pair of stores.** The 6502 has to write an
 *     address into page zero before a routine can dereference it; here it goes in
 *     `hl`, `de`, `ix` or `iy`, so there is nothing to help with.
 *
 * What it does have to answer is which of two machines this is, and the answer is
 * used in exactly one place — how wide a colour is, which is a property of the
 * palette upload and of nothing else. Every rule, every collision and every tick
 * compiles to the same bytes on both, which is the property that makes a Game
 * Gear build trustworthy for the same reason it makes a Game Boy Color one
 * trustworthy.
 */

import { AsmZ80, SMS_SLOT2_BANK, type Ref } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import type { Analysis } from "../analyze.js";
import { CtxBase } from "../ctx.js";
import type { Layout } from "../layout.js";

/**
 * A branch condition, named as the Z80 names its jumps.
 *
 * Eight of them, where the SM83 has four. `pe`/`po` are the parity/overflow
 * flag, which after arithmetic is signed overflow — but the value layer does not
 * use it, because the clamped range makes the sign of a difference sufficient on
 * its own. It is here because the assembler has it and a future emitter may want
 * it, not because anything reaches for it today.
 */
export type Cond = "z" | "nz" | "c" | "nc" | "m" | "p" | "pe" | "po";

/** Emits a helper's body. Called once, after the main program. */
export type SmsHelperBody = (ctx: SmsCtx) => void;

export class SmsCtx extends CtxBase<SmsCtx, AsmZ80> {
  readonly asm: AsmZ80;

  /**
   * Which paged bank each routine that is not in the fixed half lives in.
   *
   * Empty for a game that fits a flat cartridge, which is every example but one,
   * and then this backend emits exactly what it always did. With entries, the
   * routines it names are at `$8000` in a bank slot 2 has to be pointed at first
   * — so {@link enter} is how anything reaches them and this is the only place
   * that knows which bank is which (doc 13 §Banked cartridges).
   *
   * A *routine*'s map rather than a scene's, because what a Sega bank holds is
   * smaller than a scene: this console's window is sixteen kilobytes and the
   * biggest scene in the library is twenty-six, so the units are a scene's tick
   * steps and its three other routines rather than the scene itself.
   */
  banks = new Map<string, number>();

  /**
   * Point slot 2 at the bank holding `target`, when it is not already fixed.
   *
   * Nothing to restore afterwards, and that is a property of where things are
   * rather than an optimisation: the boot, the shared helpers, the audio driver
   * and every table live in slots 0 and 1, which never move. So the only code
   * that cares what slot 2 holds is the routine about to be entered, and the only
   * code that enters one is in the fixed half — an interrupt arriving mid-scene
   * runs the audio tick out of the fixed half and never looks at the window.
   */
  enter(target: string): void {
    const bank = this.banks.get(target);
    if (bank === undefined) return;
    this.asm.ldn("a", bank);
    this.asm.sta(SMS_SLOT2_BANK);
  }

  /** Call a routine, paging it in first if it is not in the fixed half. */
  callUnit(target: string): void {
    this.enter(target);
    this.asm.call(target);
  }

  /**
   * Jump to a routine, paging it in first.
   *
   * For the three dispatches that *tail* into a scene's routine: the routine's
   * own `ret` lands back at whatever called the dispatch, so a jump is a call
   * that costs nothing, banked or not.
   */
  jumpUnit(target: string): void {
    this.enter(target);
    this.asm.jp(target);
  }

  constructor(
    program: Program,
    analysis: Analysis,
    layout: Layout,
    profile: ConsoleProfile,
    origin = 0,
  ) {
    super(program, analysis, layout, profile);
    this.asm = new AsmZ80(origin);
  }

  /**
   * Take a branch of any length.
   *
   * The counterpart of the 6502 backend's `far`, and it is one instruction
   * because this CPU has the instruction. Keeping the name means a reader moving
   * between the two backends sees the same discipline stated the same way rather
   * than having to notice that one of them does not need it.
   */
  far(cond: Cond, target: Ref): void {
    this.asm.jp(target, cond);
  }

  /**
   * Whether this build targets the Game Gear.
   *
   * The one fact that changes what the emitter produces, and it changes only the
   * palette upload: a Master System colour is one byte of RGB222 and a Game Gear
   * colour is two of RGB444. Nothing else branches on the console — which is why
   * a `sms` and a `gg` build of one game trace identically, and why the
   * conformance suite runs the whole example library on both.
   */
  get gameGear(): boolean {
    return this.profile.id === "gg";
  }
}
