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
 * Where each CPU in this family puts the page its short addressing reaches.
 *
 * `$0000` on a 6502 and `$2000` on a HuC6280, which adds that base to every
 * zero-page operand and puts the stack in the page above it. No memory map moves
 * either — it is the instruction's own arithmetic — so a plan's addresses are the
 * *machine's*: a PC Engine build's cheap page really is at `$2013` and its heap
 * really is at `$2400` (`codegen/layout.ts` §`PCE_MEMORY`).
 *
 * Both windows are named here rather than threaded through, because this is the
 * family's addressing module and no console in it has RAM in the other's window:
 * an NES has 2 KiB at `$0000` and a PC Engine 8 KiB at `$2000`. That is what lets
 * one predicate serve both — and it is what makes `absX(layout.contacts)` mean
 * the same thing on both machines, which is the thing that has to be true for
 * `rules.ts` to be one copy.
 */
const ZERO_PAGES: readonly number[] = [0x0000, 0x2000];

/** The operand byte an address would take, or `null` if it is out of reach. */
function shortForm(address: number): number | null {
  for (const base of ZERO_PAGES) {
    if (address >= base && address < base + 0x100) return address - base;
  }
  return null;
}

/**
 * Address a byte, choosing the short form when the address is in the cheap page.
 *
 * Only ever unindexed. An indexed zero-page access wraps at `$FF` where an
 * absolute one carries, so the assembler refuses to infer the short form there
 * and so does this — which is also why every *indexed* access in this family
 * takes the plan's address as an absolute one and needs no translation.
 */
export function mem(address: Ref, offset = 0): Operand {
  if (typeof address === "number") {
    const at = address + offset;
    const short = shortForm(at);
    return short === null ? memAt(at) : zp(short);
  }
  if (offset === 0) return abs(address);
  return abs(
    typeof address === "string"
      ? { label: address, addend: offset }
      : { label: address.label, addend: address.addend + offset },
  );
}

/** The same, forced to the cheap page — for an address the caller knows is in it. */
export function fast(address: number, offset = 0): Operand {
  const short = shortForm(address + offset);
  if (short === null) {
    throw new Error(`$${(address + offset).toString(16)} is not in this CPU's zero page`);
  }
  return zp(short);
}

/**
 * The operand a zero-page *pointer* takes.
 *
 * `($nn),y` encodes an offset into the cheap page rather than an address, so a
 * pointer the allocator placed — which is a machine address like every other
 * allocation — has to be reduced to one. On a 6502 that is the identity and on a
 * HuC6280 it is minus `$2000`; anywhere else it is a bug, and it raises here
 * rather than assembling an instruction that reads the wrong two bytes.
 */
export function slotOf(address: number): number {
  const short = shortForm(address);
  if (short === null) {
    throw new Error(`a pointer at $${address.toString(16)} is not in this CPU's zero page`);
  }
  return short;
}

/** Whether an address is one the cheap page can reach. */
export function inFastPage(address: Ref): boolean {
  return typeof address === "number" && shortForm(address) !== null;
}
