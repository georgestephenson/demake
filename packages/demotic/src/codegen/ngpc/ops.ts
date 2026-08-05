/**
 * The TLCS-900/H's operand constructors, under the names they read as.
 *
 * `@demake/core` exports these prefixed, because `abs` and `at` now mean four
 * different things across four instruction sets and nothing may hand one CPU's
 * operand to another's instruction. This file aliases them back in one place, so
 * a call site below reads like assembly — the fourth time this trick is played
 * and the same file `codegen/snes/ops.ts` and `codegen/wsc/ops.ts` are.
 */

export {
  t9Abs as abs,
  t9At as at,
  t9Indexed as indexed,
  t9Invert as invert,
  t9Postinc as postinc,
  t9Predec as predec,
  type T9Mem as Mem,
} from "@demake/core";
