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

import { Asm30, AsmError, type Ref } from "@demake/core";

import type { ConsoleProfile } from "../../profiles.js";
import type { Program } from "../../program.js";
import type { Analysis } from "../analyze.js";
import { CtxBase } from "../ctx.js";
import type { Layout } from "../layout.js";

import { WSC_MACHINE, type WsMachine } from "./machine.js";
import { invert, vram, type Base, type CC, type Mem } from "./ops.js";

/**
 * The label a reference names, for the two transfers that need it by name.
 *
 * A far call resolves its segment from where the label was *defined*, so it
 * takes the name rather than the reference an offset fixup would take — and a
 * numeric target has no segment to look up, which is a transfer to an address
 * this backend never emits.
 */
function nameOf(target: Ref): string {
  if (typeof target === "string") return target;
  if (typeof target === "number")
    throw new AsmError("a far transfer needs a label, not an address");
  return target.label;
}

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

  /**
   * Whether this program's routines are spread across segments.
   *
   * The Super Nintendo's `banked`, on a machine where the other half of an
   * address is a register rather than the top eight bits — and it is
   * **all-or-nothing** for the same reason: `call`/`ret` push two bytes and
   * `callFar`/`retf` push four, so which pair a routine ends with has to match
   * how *every* caller reaches it, and "which callers are in this routine's
   * segment" is not a question an emitter can answer while it is still deciding
   * where things go. Converting the whole program makes the answer the same
   * everywhere and costs nothing at all for a game that fits one segment, whose
   * cartridge is byte-identical to the one it always built.
   */
  banked = false;

  /** The segment the fixed half is in, which is what an unsectioned label means. */
  homeSegment = 0;

  /** Call a routine — near inside one segment, far when the program is spread. */
  call(target: Ref): void {
    if (!this.banked) {
      this.asm.call(target);
      return;
    }
    this.asm.callFarLabel(nameOf(target), this.homeSegment);
  }

  /**
   * Call a routine that returns *near* whatever the rest of the program does.
   *
   * The audio driver's three entry points, and only those. `@demake/audio` emits
   * that driver with this assembler directly and ends its routines with `ret`,
   * which is right: the driver is in the fixed segment and so is every caller —
   * the boot, the main loop and the scene change. A far call to a near return
   * pops the caller's segment off the stack as an offset and lands wherever that
   * word points, which is a cartridge that boots and then jumps into nothing.
   */
  callNear(target: Ref): void {
    this.asm.call(target);
  }

  /** Return from a routine, matching how {@link call} reached it. */
  ret(): void {
    if (this.banked) this.asm.retf();
    else this.asm.ret();
  }

  /**
   * Jump to a routine that may not be in this segment.
   *
   * For the transfers that are between *routines* rather than inside one: the
   * scene dispatch, and a scene's tail jump back to the shared tail of the tick.
   * Everything else `jmp`s, because a branch inside a routine cannot leave the
   * segment the routine is in.
   */
  jump(target: Ref): void {
    if (!this.banked) {
      this.asm.jmp(target);
      return;
    }
    this.asm.jmpFarLabel(nameOf(target), this.homeSegment);
  }

  /**
   * Which copy of the cartridge's tables this segment reads.
   *
   * Empty in the fixed half and on every unbanked build. A routine in another
   * segment reads a pooled constant, a level's grid and its instance defaults
   * with a `cs:` override, which reaches *its own* segment — so each segment
   * carries the tables its code reads and this is what tells the copies apart
   * (doc 13 §Banked cartridges). The NES's `LevelData.suffix`, arrived at by
   * completely different hardware.
   */
  dataSuffix = "";

  // This backend emits the pool per segment, so `finish` leaves it alone.
  protected override poolIsPlaced = true;

  /** A pooled 16.16 constant, from the copy this segment can reach. */
  override constant(value: number): Ref {
    const shared = super.constant(value);
    if (this.dataSuffix === "") return shared;
    return { label: (shared as { label: string }).label + this.dataSuffix, addend: 0 };
  }

  /**
   * Whether this program's heap is in the cartridge's save RAM rather than in
   * the console's own memory.
   *
   * Read off the plan rather than set, because it *is* the plan: `planLayout` was
   * handed `WS_SAVE_MEMORY` or it was not (`layout.ts` §heapSegment). `DS` and
   * `ES` are pointed at that segment for the length of a program that answers
   * true, so the heap is still what an unprefixed operand means and only the
   * display's own addresses have to say otherwise.
   */
  get saved(): boolean {
    return this.layout.memory.heapSegment !== undefined;
  }

  /** The segment the heap is in, which is zero when it is the console's memory. */
  get heapSegment(): number {
    return this.layout.memory.heapSegment ?? 0;
  }

  /** An operand in the console's own memory: `ops.ts`'s {@link vram}, bound. */
  vram(base: Base | undefined, disp: Ref = 0): Mem {
    return vram(this.saved, base, disp);
  }

  /**
   * Run `body` with `ES` pointing at the console's own memory, and put it back.
   *
   * For a string instruction writing where the display reads — the tile bank, a
   * screen map, the object table, palette RAM. A segment override reaches a
   * memory operand and even the *source* of a `movs`; the destination is `ES` and
   * there is no prefix that changes it, so the register itself has to move. That
   * is the whole reason the heap moves in one piece rather than spilling the way
   * the NES's does: a copy between two heap addresses cannot have one end in each
   * memory, so which one "the heap" is has to be a single answer.
   *
   * `source` moves `DS` with it, for a copy whose *source* is the console's
   * memory too — which is one site, the frame's objects going from the shadow
   * the tick built to the table the chip reads.
   *
   * Nothing at all on a build whose heap is the console's own memory, where `ES`
   * is already zero and always was — which is what keeps those cartridges
   * byte-identical.
   */
  toInternal(body: () => void, source = false): void {
    if (!this.saved) {
      body();
      return;
    }
    this.asm.movi("ax", 0);
    this.asm.movsr("es", "ax");
    if (source) this.asm.movsr("ds", "ax");
    body();
    this.asm.movi("ax", this.heapSegment);
    this.asm.movsr("es", "ax");
    if (source) this.asm.movsr("ds", "ax");
  }
}
