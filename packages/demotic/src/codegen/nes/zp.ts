/**
 * The backend's own corner of page zero, and how it addresses everything else.
 *
 * `NES_MEMORY` hands the allocator page zero from `$0010` up, keeping the bottom
 * sixteen bytes for the pointers named here. They cannot come from the allocator
 * because they are what *routines* use: a shared helper has to find its argument
 * at an address fixed when the helper was written, not at one the plan happened to
 * choose for this game.
 *
 * Page zero matters more on this CPU than a cheap-addressing region does on the
 * Game Boy. It is two bytes and three cycles instead of three and four — and it is
 * the only place a pointer can live at all, because `($nn),y` is the 6502's one
 * indirect mode. A helper that walks a caller's four-byte value has no other way
 * to be told where it is.
 */

import { abs, at as memAt, zp, type Operand, type Ref } from "@demake/core";

/** The pointers and byte scratch the shared helpers pass arguments in. */
export const ZP = {
  /** First argument pointer: the value a helper reads, or reads and writes. */
  p0: 0x00,
  /** Second argument pointer: the other operand. */
  p1: 0x02,
  /** Where a helper's result goes, when it is not the first argument. */
  p2: 0x04,
  /** Byte scratch inside a helper, valid only for the length of one. */
  t0: 0x06,
  t1: 0x07,
  t2: 0x08,
  t3: 0x09,
  /** A pointer a helper saves across calling another. */
  saved: 0x0a,
  /** A loop counter a helper keeps out of the registers. */
  count: 0x0c,
  /** Two spare bytes, deliberately: the next routine that needs one has it. */
  spare: 0x0e,
  /**
   * The collision pair loop's own state: the other object, and where it is up to.
   *
   * Separate from the scratch above because it is the one thing that has to
   * survive everything a *rule body* does — a rule may multiply, divide, fire a
   * sound and write four properties, and all of that runs between one pair and
   * the next. A helper's scratch is valid for the length of one helper; this is
   * valid for the length of a loop.
   */
  pair: 0x10,
  pairIndex: 0x12,
} as const;

/** First byte the allocator may hand out of page zero. */
export const ZP_FREE = 0x13;

/**
 * Address a byte, choosing the short form when the address is in page zero.
 *
 * Only ever unindexed. An indexed zero-page access wraps at `$FF` where an
 * absolute one carries, so the assembler refuses to infer the short form there
 * and so does this.
 */
export function mem(address: Ref, offset = 0): Operand {
  if (typeof address === "number") return memAt(address + offset);
  if (offset === 0) return abs(address);
  return abs(
    typeof address === "string"
      ? { label: address, addend: offset }
      : { label: address.label, addend: address.addend + offset },
  );
}

/** The same, forced to page zero — for an address the caller knows is in it. */
export function fast(address: number, offset = 0): Operand {
  return zp(address + offset);
}

/** Whether an address is one page zero can reach. */
export function inFastPage(address: Ref): boolean {
  return typeof address === "number" && address < 0x100;
}
