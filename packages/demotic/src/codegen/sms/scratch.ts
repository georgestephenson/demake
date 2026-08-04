/**
 * The backend's own scratch, and why it is four anonymous words.
 *
 * The 6502 backend keeps sixteen named pointers below the allocator's page zero
 * (`codegen/mos/zp.ts`) because on that CPU a shared routine has no other way to
 * be told where its argument is. This CPU does: an address goes in `hl`, `de`,
 * `ix` or `iy`, and a routine that needs two of them has two to spare. So what is
 * left over is the much smaller problem of a value that has to *survive a call* —
 * and `layout.scratch`'s eight bytes are enough for every one of them.
 *
 * They are numbered rather than named on purpose. Naming them after what the
 * first caller put there is how a scratch block acquires two owners: the
 * generator's modulo and the generator's bounds live in the same eight bytes at
 * the same time, and the only thing keeping them apart is that one uses the low
 * half and the other the high. That is a fact about the pair, not about either.
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
