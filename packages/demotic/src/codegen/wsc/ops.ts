/**
 * The V30MZ's operand constructors, aliased back to their assembly spellings.
 *
 * `core` exports them under an `x86` prefix because `abs` and `at` already mean
 * something on the 6502 and something else again on the 65816 — three CPUs, one
 * word, three incompatible types (`asm/v30mz.ts`'s note at the export site). The
 * prefix is what keeps a 6502 operand from reaching an x86 instruction; this file
 * is what keeps a call site reading like assembly, and it is the one place the
 * aliasing happens. The Super Nintendo backend's `codegen/snes/ops.ts` is the
 * same file for the same reason.
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
