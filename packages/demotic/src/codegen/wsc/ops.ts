/**
 * The V30MZ's operand constructors, aliased back to their assembly spellings —
 * and the one place an operand says it means the *console's* memory.
 *
 * `core` exports them under an `x86` prefix because `abs` and `at` already mean
 * something on the 6502 and something else again on the 65816 — three CPUs, one
 * word, three incompatible types (`asm/v30mz.ts`'s note at the export site). The
 * prefix is what keeps a 6502 operand from reaching an x86 instruction; this file
 * is what keeps a call site reading like assembly, and it is the one place the
 * aliasing happens. The Super Nintendo backend's `codegen/snes/ops.ts` is the
 * same file for the same reason.
 *
 * ## Two memories, and which one `DS` is
 *
 * A game whose heap will not fit the console's own sixteen kilobytes puts the
 * whole of it in the cartridge's **save RAM**, which this console maps at segment
 * `$1` (`layout.ts` §WS_SAVE_MEMORY). `DS` and `ES` are pointed there for the
 * length of the program, so the heap is still what an unprefixed operand means
 * and the allocator still hands out offsets from zero — which is why the 16.16
 * value layer, the expression compiler, the rule bodies and the tile walk are
 * **unchanged**, prefix for prefix, on a game whose variables are in a cartridge.
 *
 * What moves instead is the short list of addresses that are the *display's*
 * rather than the allocator's: two screen maps, the object shadow, the object
 * table and the tile bank. Those are addresses the chip decodes, so they stay in
 * the console's own memory whatever the heap does — and they are reached through
 * `SS`, which is the segment register a demade cartridge already points at that
 * memory for its stack and never moves. {@link vram} is that override, and there
 * are six call sites.
 *
 * On a build whose heap is the console's own memory `DS`, `ES` and `SS` are all
 * zero, exactly as they always were, and {@link vram} emits nothing at all.
 */

export {
  x86Abs as abs,
  x86At as at,
  x86Invert as invert,
  x86Rom as rom,
  x86RomAbs as romAbs,
  x86RomAt as romAt,
} from "@demake/core";
export type {
  X86Mem as Mem,
  X86AluOp as AluOp,
  X86Base as Base,
  X86CC as CC,
  X86R8 as R8,
  X86R16 as R16,
  X86Seg as Seg,
  X86ShiftOp as ShiftOp,
} from "@demake/core";

import { x86At, type Ref, type X86Base, type X86Mem } from "@demake/core";

/**
 * An operand in the *console's* memory, wherever this build put its heap.
 *
 * For the addresses the display decodes rather than the ones the allocator chose.
 * `saved` is the build's own question — threaded from the context rather than
 * inferred, because there is nothing about the number `$1000` to inspect: it is
 * a screen map on one build and a game's own variable on the other.
 */
export function vram(saved: boolean, base: X86Base | undefined, disp: Ref = 0): X86Mem {
  const operand = base === undefined ? { disp } : x86At(base, disp);
  return saved ? { ...operand, seg: "ss" } : operand;
}
