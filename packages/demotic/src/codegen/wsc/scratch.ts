/**
 * The backend's own scratch, and why it is four anonymous words.
 *
 * The 6502 backend keeps sixteen named pointers below the allocator's page zero
 * (`codegen/mos/zp.ts`) because on that CPU a shared routine has no other way to
 * be told where its argument is. This one does not need them either: a table
 * address goes in `si` or `di`, an entity's base in `bx`, and an operand can be
 * a plain absolute address in the instruction that uses it. So what is left is
 * the much smaller problem of a value that has to *survive a call* — and
 * `layout.scratch`'s eight bytes are enough for every one of them.
 *
 * They are numbered rather than named on purpose. Naming them after what the
 * first caller put there is how a scratch block acquires two owners.
 *
 * The rule for using them is the one the whole helper scratch runs under: a word
 * here is valid for the length of one routine, and a value that must survive a
 * call to another goes somewhere else — `layout.words` for the renderer's
 * sixteen, or a temporary for anything four bytes wide.
 */

/** Four 16-bit words, as offsets into `layout.scratch`. */
export const S = {
  w0: 0,
  w1: 2,
  w2: 4,
  w3: 6,
} as const;

/** Bytes the block holds — the whole of `layout.scratch`. */
export const SCRATCH_BYTES = 8;
