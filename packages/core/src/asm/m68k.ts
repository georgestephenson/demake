/**
 * A Motorola 68000 assembler.
 *
 * The fourth of `core`'s encoders, and it exists for the reason the other three
 * do (`asm/sm83.ts`, `asm/mos6502.ts`, `asm/z80.ts`, doc 14 §Runtime model): a
 * game compiles to machine code, and the encoder is TypeScript because the
 * browser has no assembler. What is new here is the *shape* of the machine — the
 * first 16/32-bit CPU in the set — and three of its properties change how the
 * backend above it is written rather than merely how it is spelled:
 *
 *   - **A 16.16 value is a register.** `move.l`, `add.l`, `sub.l`, `neg.l` and
 *     `cmp.l` each do in one instruction what the Z80 does in four and the 6502
 *     in eight. The whole of `codegen/md/val.ts` is therefore about a hundred
 *     lines where the Sega's is seven hundred, and the parts that are *not*
 *     one instruction — the 32×32 multiply and the divide — are the only two
 *     routines this console needs pulled in.
 *   - **Everything is big-endian**, so `dw`/`dl` write the high byte first and a
 *     32-bit constant in the pool is read back by a single `move.l`. Getting
 *     this backwards produces a game whose every number is byte-swapped, which
 *     looks like an arithmetic bug three layers down.
 *   - **An absolute address is two words or one.** The word form sign-extends,
 *     so `$000000`–`$007FFF` and `$FF8000`–`$FFFFFF` are reachable in two bytes
 *     rather than four — and the second of those ranges is the top half of the
 *     console's work RAM. That is why the memory plan puts a game's state there:
 *     every property read in the program is two bytes shorter for it. A
 *     {@link Ref} that is still a label always takes the long form, because its
 *     address is not known when the instruction's length is fixed.
 *
 * Two hazards it makes loud rather than silent:
 *
 *   - **A `Bcc` reaches ±32 KiB and nothing further.** The 68000 has no long
 *     conditional branch, so an out-of-range displacement is an {@link AsmError}
 *     rather than a wrap; a backend that needs to reach further inverts the
 *     condition over a `jmp`, which is absolute and always reaches.
 *   - **Word and long accesses must be even.** The instruction stream is checked
 *     by construction (every instruction is a whole number of words), and an odd
 *     `dc.b` run before a table is padded by {@link AsmZ80.align}'s counterpart
 *     here rather than faulting on real hardware.
 *
 * Sources: Motorola — M68000 Family Programmer's Reference Manual (M68000PM/AD,
 * the instruction format tables in §2 and the encodings in §4) and the M68000
 * 8-/16-/32-Bit Microprocessors User's Manual (MC68000UM/AD, §2 addressing
 * modes).
 */

import { AsmError, label, type LabelRef, type Ref } from "./sm83.js";

export { AsmError, label };
export type { LabelRef, Ref };

/** Operand size. */
export type M68kSize = "b" | "w" | "l";

/**
 * A branch condition, in the encoding's own order.
 *
 * `t` and `f` occupy the two slots `bra` and `bsr` use, which is why they are
 * listed but never passed to {@link Asm68k.bcc}.
 */
export type M68kCC =
  | "t"
  | "f"
  | "hi"
  | "ls"
  | "cc"
  | "cs"
  | "ne"
  | "eq"
  | "vc"
  | "vs"
  | "pl"
  | "mi"
  | "ge"
  | "lt"
  | "gt"
  | "le";

const CC_CODE: Readonly<Record<M68kCC, number>> = {
  t: 0,
  f: 1,
  hi: 2,
  ls: 3,
  cc: 4,
  cs: 5,
  ne: 6,
  eq: 7,
  vc: 8,
  vs: 9,
  pl: 10,
  mi: 11,
  ge: 12,
  lt: 13,
  gt: 14,
  le: 15,
};

/** The size field of a `move`, which is not the size field of anything else. */
const MOVE_SIZE: Readonly<Record<M68kSize, number>> = { b: 1, w: 3, l: 2 };

/** The size field every other sized instruction uses. */
const SIZE: Readonly<Record<M68kSize, number>> = { b: 0, w: 1, l: 2 };

/**
 * An effective address, as the encoding sees it: a mode, a register, and
 * whatever extension words follow.
 *
 * Built by the constructors below rather than by hand, because the mode/register
 * split is not a thing a call site should have to remember — `abs` is mode 7
 * register 0 or 1 depending on a range check, and getting that wrong assembles
 * cleanly and addresses the wrong half of the machine.
 */
export type Ea =
  /** `Dn` */
  | { readonly k: "d"; readonly n: number }
  /** `An` */
  | { readonly k: "a"; readonly n: number }
  /** `(An)` */
  | { readonly k: "ind"; readonly n: number }
  /** `(An)+` */
  | { readonly k: "post"; readonly n: number }
  /** `-(An)` */
  | { readonly k: "pre"; readonly n: number }
  /** `(d16,An)` */
  | { readonly k: "disp"; readonly n: number; readonly d: number }
  /** `(d8,An,Xn.size)` */
  | {
      readonly k: "idx";
      readonly n: number;
      readonly d: number;
      readonly x: number;
      readonly xa: boolean;
      readonly xl: boolean;
    }
  /** `(xxx).W` or `(xxx).L`, chosen by range */
  | { readonly k: "abs"; readonly addr: Ref }
  /** `(d16,PC)` */
  | { readonly k: "pc"; readonly target: Ref }
  /** `#imm` */
  | { readonly k: "imm"; readonly v: Ref };

/** `Dn`. */
export function eaD(n: number): Ea {
  return { k: "d", n };
}
/** `An`. `a(7)` is the stack pointer. */
export function eaA(n: number): Ea {
  return { k: "a", n };
}
/** `(An)`. */
export function eaInd(n: number): Ea {
  return { k: "ind", n };
}
/** `(An)+`. */
export function eaPost(n: number): Ea {
  return { k: "post", n };
}
/** `-(An)`. */
export function eaPre(n: number): Ea {
  return { k: "pre", n };
}
/** `(d16,An)`. */
export function eaDisp(n: number, offset: number): Ea {
  return { k: "disp", n, d: offset };
}
/** `(d8,An,Dx.l)` — an index register, long and unscaled. */
export function eaIdx(n: number, offset: number, index: number, indexIsAddress = false): Ea {
  return { k: "idx", n, d: offset, x: index, xa: indexIsAddress, xl: true };
}
/** `(xxx).W` or `(xxx).L`, whichever the address needs. */
export function eaAbs(addr: Ref): Ea {
  return { k: "abs", addr };
}
/** `(d16,PC)`. */
export function eaPc(target: Ref): Ea {
  return { k: "pc", target };
}
/** `#imm`. */
export function eaImm(value: Ref): Ea {
  return { k: "imm", v: value };
}

/**
 * Whether a numeric address fits the two-byte absolute form.
 *
 * The word is sign-extended to 32 bits and the bus is 24, so `$0000`–`$7FFF`
 * reaches the bottom of the map and `$8000`–`$FFFF` reaches `$FF8000`–`$FFFFFF`
 * — the top half of a Mega Drive's work RAM, which is exactly where the memory
 * plan puts a game's state.
 */
export function fitsAbsWord(address: number): boolean {
  const at = address >>> 0;
  return at <= 0x7fff || (at >= 0xff8000 && at <= 0xffffff);
}

/** Normalise the two spellings of a label reference. */
function asLabelRef(ref: string | LabelRef): LabelRef {
  return typeof ref === "string" ? { label: ref, addend: 0 } : ref;
}

interface Fixup {
  /** Byte offset of the field to patch. */
  at: number;
  kind: "abs32" | "abs16" | "rel16" | "rel8";
  ref: LabelRef;
  /** Address the displacement is measured from — for relative fields. */
  base: number;
}

/**
 * A growable code buffer with labels, for the 68000.
 *
 * `origin` is where byte zero lives in the address space; a Mega Drive cartridge
 * starts at `$000000`, so that is what the backend passes and every absolute
 * reference resolves without the caller doing base arithmetic.
 *
 * One pass plus a fixup sweep, as in the other three encoders: every
 * instruction's length is decided by the method that emits it, so nothing
 * relaxes and an address never moves under a reference already resolved. The
 * cost of that rule on this CPU is that a label operand always takes the long
 * absolute form — see {@link fitsAbsWord}.
 */
export class Asm68k {
  private code: number[] = [];
  private readonly labels = new Map<string, number>();
  private readonly fixups: Fixup[] = [];

  constructor(readonly origin = 0) {}

  /** Bytes emitted so far. */
  get length(): number {
    return this.code.length;
  }

  /** The address the next byte will occupy. */
  get pc(): number {
    return this.origin + this.code.length;
  }

  /** Define a label at the current address. */
  label(name: string): this {
    if (this.labels.has(name)) throw new AsmError(`duplicate label '${name}'`);
    this.labels.set(name, this.pc);
    return this;
  }

  /** Define a label at an address the assembler does not own (RAM, hardware). */
  equate(name: string, address: number): this {
    if (this.labels.has(name)) throw new AsmError(`duplicate label '${name}'`);
    this.labels.set(name, address);
    return this;
  }

  /** Whether a label has been defined. */
  has(name: string): boolean {
    return this.labels.has(name);
  }

  /** Resolve a label that is already defined. */
  addressOf(name: string): number {
    const at = this.labels.get(name);
    if (at === undefined) throw new AsmError(`undefined label '${name}'`);
    return at;
  }

  // --- raw data --------------------------------------------------------------

  /** Emit literal bytes. */
  db(...values: number[]): this {
    for (const value of values) this.code.push(value & 0xff);
    return this;
  }

  /** Emit a big-endian word, resolving a label if given. */
  dw(value: Ref): this {
    if (typeof value === "number") return this.db(value >> 8, value);
    this.fixups.push({ at: this.code.length, kind: "abs16", ref: asLabelRef(value), base: 0 });
    return this.db(0, 0);
  }

  /** Emit a big-endian 32-bit value, resolving a label if given. */
  dl(value: Ref): this {
    if (typeof value === "number") return this.db(value >> 24, value >> 16, value >> 8, value);
    this.fixups.push({ at: this.code.length, kind: "abs32", ref: asLabelRef(value), base: 0 });
    return this.db(0, 0, 0, 0);
  }

  /**
   * The 32-bit datum every backend's constant pool emits.
   *
   * An alias for {@link dl} and not a second encoding: `CtxBase` writes pooled
   * 16.16 literals through this name on every console, and on this one they are
   * read back by a single `move.l` — so they must be the machine's own byte
   * order rather than the Game Boy's.
   */
  dd(value: number): this {
    return this.dl(value);
  }

  /** Emit `count` bytes of `fill`. */
  ds(count: number, fill = 0): this {
    for (let index = 0; index < count; index += 1) this.db(fill);
    return this;
  }

  /** Emit a block of bytes. */
  bytes(values: ArrayLike<number>): this {
    for (let index = 0; index < values.length; index += 1) this.db(values[index] as number);
    return this;
  }

  /**
   * Pad to an even address.
   *
   * A word or long access to an odd address is an address error on this CPU, so
   * anything that follows a run of bytes — a table of words, the next
   * instruction — has to start even. Called by the emitter after every `db`
   * block rather than left to a linker, because there is no linker.
   */
  align(): this {
    if ((this.code.length & 1) !== 0) this.db(0);
    return this;
  }

  /** Pad with `fill` until the next byte lands on `address`. */
  padTo(address: number, fill = 0): this {
    if (this.pc > address) {
      throw new AsmError(
        `cannot pad to $${address.toString(16)}: already at $${this.pc.toString(16)}`,
      );
    }
    return this.ds(address - this.pc, fill);
  }

  // --- effective addresses ---------------------------------------------------

  /** The six bits an effective address occupies in an opcode word. */
  private eaBits(ea: Ea): number {
    switch (ea.k) {
      case "d":
        return (0 << 3) | ea.n;
      case "a":
        return (1 << 3) | ea.n;
      case "ind":
        return (2 << 3) | ea.n;
      case "post":
        return (3 << 3) | ea.n;
      case "pre":
        return (4 << 3) | ea.n;
      case "disp":
        return (5 << 3) | ea.n;
      case "idx":
        return (6 << 3) | ea.n;
      case "abs":
        return (7 << 3) | (typeof ea.addr === "number" && fitsAbsWord(ea.addr) ? 0 : 1);
      case "pc":
        return (7 << 3) | 2;
      case "imm":
        return (7 << 3) | 4;
    }
  }

  /** Emit whatever extension words an effective address carries. */
  private eaWords(ea: Ea, size: M68kSize): void {
    switch (ea.k) {
      case "disp":
        if (ea.d < -0x8000 || ea.d > 0x7fff) {
          throw new AsmError(`displacement ${ea.d} does not fit in a signed word`);
        }
        this.dw(ea.d & 0xffff);
        return;
      case "idx": {
        if (ea.d < -128 || ea.d > 127) {
          throw new AsmError(`index displacement ${ea.d} does not fit in a signed byte`);
        }
        const word =
          ((ea.xa ? 1 : 0) << 15) | (ea.x << 12) | ((ea.xl ? 1 : 0) << 11) | (ea.d & 0xff);
        this.dw(word);
        return;
      }
      case "abs":
        if (typeof ea.addr === "number") {
          if (fitsAbsWord(ea.addr)) this.dw(ea.addr & 0xffff);
          else this.dl(ea.addr >>> 0);
          return;
        }
        this.dl(ea.addr);
        return;
      case "pc": {
        const at = this.code.length;
        this.db(0, 0);
        this.fixups.push({
          at,
          kind: "rel16",
          ref: asLabelRef(ea.target as string | LabelRef),
          base: this.origin + at,
        });
        return;
      }
      case "imm":
        if (typeof ea.v !== "number") {
          if (size !== "l") throw new AsmError("a label immediate has to be long");
          this.dl(ea.v);
          return;
        }
        if (size === "l") this.dl(ea.v >>> 0);
        else if (size === "w") this.dw(ea.v & 0xffff);
        else this.dw(ea.v & 0xff);
        return;
      default:
        return;
    }
  }

  /** Reject an addressing mode an instruction cannot take. */
  private noAddress(ea: Ea, what: string): void {
    if (ea.k === "a") throw new AsmError(`${what} cannot take an address register`);
  }

  // --- moves -----------------------------------------------------------------

  /** `move.<size> src, dst`, and `movea` when the destination is an `An`. */
  move(size: M68kSize, src: Ea, dst: Ea): this {
    if (dst.k === "a") {
      if (size === "b") throw new AsmError("movea has no byte form");
      return this.movea(size, src, dst.n);
    }
    if (size === "b") this.noAddress(src, "move.b");
    const dstBits = this.eaBits(dst);
    this.dw(
      (MOVE_SIZE[size] << 12) |
        ((dstBits & 7) << 9) |
        (((dstBits >> 3) & 7) << 6) |
        this.eaBits(src),
    );
    this.eaWords(src, size);
    this.eaWords(dst, size);
    return this;
  }

  /** `movea.<w|l> src, An` — no flags, and a word source is sign-extended. */
  movea(size: "w" | "l", src: Ea, an: number): this {
    this.dw((MOVE_SIZE[size] << 12) | (an << 9) | (1 << 6) | this.eaBits(src));
    this.eaWords(src, size);
    return this;
  }

  /** `moveq #imm8, Dn` — the cheapest way to put a small constant in a register. */
  moveq(value: number, dn: number): this {
    if (value < -128 || value > 127) throw new AsmError(`moveq #${value} is out of range`);
    return this.dw(0x7000 | (dn << 9) | (value & 0xff));
  }

  /** `lea <ea>, An`. */
  lea(src: Ea, an: number): this {
    this.dw(0x41c0 | (an << 9) | this.eaBits(src));
    this.eaWords(src, "l");
    return this;
  }

  /** `pea <ea>`. */
  pea(src: Ea): this {
    this.dw(0x4840 | this.eaBits(src));
    this.eaWords(src, "l");
    return this;
  }

  /**
   * `movem.<w|l> regs, -(An)` and `movem.<w|l> (An)+, regs`.
   *
   * `mask` numbers `d0`–`d7` as bits 0–7 and `a0`–`a7` as bits 8–15, whichever
   * direction is being emitted: the predecrement form's reversal is done here,
   * because a caller that had to remember it would eventually not.
   */
  movem(size: "w" | "l", mask: number, ea: Ea, toMemory: boolean): this {
    let bits = mask & 0xffff;
    if (toMemory && ea.k === "pre") {
      let flipped = 0;
      for (let index = 0; index < 16; index += 1) {
        if ((bits >> index) & 1) flipped |= 1 << (15 - index);
      }
      bits = flipped;
    }
    this.dw(0x4880 | ((toMemory ? 0 : 1) << 10) | ((size === "l" ? 1 : 0) << 6) | this.eaBits(ea));
    this.dw(bits);
    this.eaWords(ea, size);
    return this;
  }

  // --- arithmetic and logic --------------------------------------------------

  private aluToReg(base: number, size: M68kSize, src: Ea, dn: number): this {
    this.dw(base | (dn << 9) | (SIZE[size] << 6) | this.eaBits(src));
    this.eaWords(src, size);
    return this;
  }

  private aluToMem(base: number, size: M68kSize, dn: number, dst: Ea): this {
    this.noAddress(dst, "a read-modify-write operation");
    // The opmode field is one number, not two: `4 + size` is the to-memory
    // direction, and or-ing two shifted fields together would land on `eor`.
    this.dw(base | (dn << 9) | ((4 + SIZE[size]) << 6) | this.eaBits(dst));
    this.eaWords(dst, size);
    return this;
  }

  /** `add.<size> <ea>, Dn`. */
  add(size: M68kSize, src: Ea, dn: number): this {
    return this.aluToReg(0xd000, size, src, dn);
  }
  /** `add.<size> Dn, <ea>`. */
  addTo(size: M68kSize, dn: number, dst: Ea): this {
    return this.aluToMem(0xd000, size, dn, dst);
  }
  /** `sub.<size> <ea>, Dn`. */
  sub(size: M68kSize, src: Ea, dn: number): this {
    return this.aluToReg(0x9000, size, src, dn);
  }
  /** `sub.<size> Dn, <ea>`. */
  subTo(size: M68kSize, dn: number, dst: Ea): this {
    return this.aluToMem(0x9000, size, dn, dst);
  }
  /** `and.<size> <ea>, Dn`. */
  and(size: M68kSize, src: Ea, dn: number): this {
    return this.aluToReg(0xc000, size, src, dn);
  }
  /** `and.<size> Dn, <ea>`. */
  andTo(size: M68kSize, dn: number, dst: Ea): this {
    return this.aluToMem(0xc000, size, dn, dst);
  }
  /** `or.<size> <ea>, Dn`. */
  or(size: M68kSize, src: Ea, dn: number): this {
    return this.aluToReg(0x8000, size, src, dn);
  }
  /** `or.<size> Dn, <ea>`. */
  orTo(size: M68kSize, dn: number, dst: Ea): this {
    return this.aluToMem(0x8000, size, dn, dst);
  }
  /** `eor.<size> Dn, <ea>` — the one logical operation with no to-register form. */
  eorTo(size: M68kSize, dn: number, dst: Ea): this {
    return this.aluToMem(0xb000, size, dn, dst);
  }

  /**
   * `cmp.<size> <ea>, Dn` — which computes `Dn - ea`.
   *
   * The operand order is the assembler's traditional one and the opposite of
   * what a reader expects from the flag it sets: after `cmp.l src,d0`, `blt`
   * means `d0 < src`. Every comparison in the backend above is written that way
   * round.
   */
  cmp(size: M68kSize, src: Ea, dn: number): this {
    return this.aluToReg(0xb000, size, src, dn);
  }

  /** `adda.<w|l> <ea>, An`. */
  adda(size: "w" | "l", src: Ea, an: number): this {
    this.dw(0xd000 | (an << 9) | ((size === "l" ? 7 : 3) << 6) | this.eaBits(src));
    this.eaWords(src, size);
    return this;
  }
  /** `suba.<w|l> <ea>, An`. */
  suba(size: "w" | "l", src: Ea, an: number): this {
    this.dw(0x9000 | (an << 9) | ((size === "l" ? 7 : 3) << 6) | this.eaBits(src));
    this.eaWords(src, size);
    return this;
  }
  /** `cmpa.<w|l> <ea>, An`. */
  cmpa(size: "w" | "l", src: Ea, an: number): this {
    this.dw(0xb000 | (an << 9) | ((size === "l" ? 7 : 3) << 6) | this.eaBits(src));
    this.eaWords(src, size);
    return this;
  }

  private immOp(base: number, size: M68kSize, value: Ref, dst: Ea): this {
    this.noAddress(dst, "an immediate operation");
    this.dw(base | (SIZE[size] << 6) | this.eaBits(dst));
    this.eaWords(eaImm(value), size);
    this.eaWords(dst, size);
    return this;
  }

  /** `addi.<size> #imm, <ea>`. */
  addi(size: M68kSize, value: Ref, dst: Ea): this {
    return this.immOp(0x0600, size, value, dst);
  }
  /** `subi.<size> #imm, <ea>`. */
  subi(size: M68kSize, value: Ref, dst: Ea): this {
    return this.immOp(0x0400, size, value, dst);
  }
  /** `andi.<size> #imm, <ea>`. */
  andi(size: M68kSize, value: Ref, dst: Ea): this {
    return this.immOp(0x0200, size, value, dst);
  }
  /** `ori.<size> #imm, <ea>`. */
  ori(size: M68kSize, value: Ref, dst: Ea): this {
    return this.immOp(0x0000, size, value, dst);
  }
  /** `eori.<size> #imm, <ea>`. */
  eori(size: M68kSize, value: Ref, dst: Ea): this {
    return this.immOp(0x0a00, size, value, dst);
  }
  /** `cmpi.<size> #imm, <ea>`. */
  cmpi(size: M68kSize, value: Ref, dst: Ea): this {
    return this.immOp(0x0c00, size, value, dst);
  }

  /** `addq.<size> #1..8, <ea>`. */
  addq(size: M68kSize, value: number, dst: Ea): this {
    if (value < 1 || value > 8) throw new AsmError(`addq #${value} is out of range`);
    this.dw(0x5000 | ((value & 7) << 9) | (SIZE[size] << 6) | this.eaBits(dst));
    this.eaWords(dst, size);
    return this;
  }
  /** `subq.<size> #1..8, <ea>`. */
  subq(size: M68kSize, value: number, dst: Ea): this {
    if (value < 1 || value > 8) throw new AsmError(`subq #${value} is out of range`);
    this.dw(0x5100 | ((value & 7) << 9) | (SIZE[size] << 6) | this.eaBits(dst));
    this.eaWords(dst, size);
    return this;
  }

  private unary(base: number, size: M68kSize, dst: Ea): this {
    this.noAddress(dst, "a unary operation");
    this.dw(base | (SIZE[size] << 6) | this.eaBits(dst));
    this.eaWords(dst, size);
    return this;
  }

  /** `clr.<size> <ea>`. */
  clr(size: M68kSize, dst: Ea): this {
    return this.unary(0x4200, size, dst);
  }
  /** `neg.<size> <ea>`. */
  neg(size: M68kSize, dst: Ea): this {
    return this.unary(0x4400, size, dst);
  }
  /** `not.<size> <ea>`. */
  not(size: M68kSize, dst: Ea): this {
    return this.unary(0x4600, size, dst);
  }
  /** `tst.<size> <ea>` — the flags without the value. */
  tst(size: M68kSize, dst: Ea): this {
    return this.unary(0x4a00, size, dst);
  }

  /** `ext.w Dn` / `ext.l Dn` — sign-extend a byte to a word, or a word to a long. */
  ext(size: "w" | "l", dn: number): this {
    return this.dw((size === "w" ? 0x4880 : 0x48c0) | dn);
  }

  /** `swap Dn` — exchange a register's halves, which is a shift by sixteen. */
  swap(dn: number): this {
    return this.dw(0x4840 | dn);
  }

  /** `muls.w <ea>, Dn` — signed 16×16 into 32. */
  muls(src: Ea, dn: number): this {
    this.dw(0xc1c0 | (dn << 9) | this.eaBits(src));
    this.eaWords(src, "w");
    return this;
  }
  /** `mulu.w <ea>, Dn` — unsigned 16×16 into 32. */
  mulu(src: Ea, dn: number): this {
    this.dw(0xc0c0 | (dn << 9) | this.eaBits(src));
    this.eaWords(src, "w");
    return this;
  }
  /** `divu.w <ea>, Dn` — 32 by 16, quotient low and remainder high. */
  divu(src: Ea, dn: number): this {
    this.dw(0x80c0 | (dn << 9) | this.eaBits(src));
    this.eaWords(src, "w");
    return this;
  }
  /** `divs.w <ea>, Dn`. */
  divs(src: Ea, dn: number): this {
    this.dw(0x81c0 | (dn << 9) | this.eaBits(src));
    this.eaWords(src, "w");
    return this;
  }

  // --- shifts ----------------------------------------------------------------

  /**
   * A register shift by a constant of one to eight, or by another register.
   *
   * `type` is the encoding's: 0 arithmetic, 1 logical, 2 rotate-with-extend,
   * 3 rotate.
   */
  private shiftReg(
    type: number,
    left: boolean,
    size: M68kSize,
    count: number,
    dn: number,
    byRegister: boolean,
  ): this {
    if (!byRegister && (count < 1 || count > 8)) {
      throw new AsmError(`a constant shift of ${count} is out of range`);
    }
    return this.dw(
      0xe000 |
        ((count & 7) << 9) |
        ((left ? 1 : 0) << 8) |
        (SIZE[size] << 6) |
        ((byRegister ? 1 : 0) << 5) |
        (type << 3) |
        dn,
    );
  }

  /** `asl.<size> #count, Dn`. */
  asl(size: M68kSize, count: number, dn: number): this {
    return this.shiftReg(0, true, size, count, dn, false);
  }
  /** `asr.<size> #count, Dn` — an arithmetic shift, which is floor division. */
  asr(size: M68kSize, count: number, dn: number): this {
    return this.shiftReg(0, false, size, count, dn, false);
  }
  /** `lsl.<size> #count, Dn`. */
  lsl(size: M68kSize, count: number, dn: number): this {
    return this.shiftReg(1, true, size, count, dn, false);
  }
  /** `lsr.<size> #count, Dn`. */
  lsr(size: M68kSize, count: number, dn: number): this {
    return this.shiftReg(1, false, size, count, dn, false);
  }
  /** `roxl.<size> #count, Dn` — through the X flag, which a 64-bit shift needs. */
  roxl(size: M68kSize, count: number, dn: number): this {
    return this.shiftReg(2, true, size, count, dn, false);
  }
  /** `roxr.<size> #count, Dn`. */
  roxr(size: M68kSize, count: number, dn: number): this {
    return this.shiftReg(2, false, size, count, dn, false);
  }
  /** `lsl.<size> Dx, Dn` — a shift by a count in a register. */
  lslReg(size: M68kSize, dx: number, dn: number): this {
    return this.shiftReg(1, true, size, dx, dn, true);
  }
  /** `lsr.<size> Dx, Dn`. */
  lsrReg(size: M68kSize, dx: number, dn: number): this {
    return this.shiftReg(1, false, size, dx, dn, true);
  }
  /** `asr.<size> Dx, Dn`. */
  asrReg(size: M68kSize, dx: number, dn: number): this {
    return this.shiftReg(0, false, size, dx, dn, true);
  }

  // --- bits ------------------------------------------------------------------

  /** `btst #n, <ea>`. */
  btst(bit: number, dst: Ea): this {
    this.dw(0x0800 | this.eaBits(dst));
    this.dw(bit & 0xff);
    this.eaWords(dst, "b");
    return this;
  }
  /** `bset #n, <ea>`. */
  bset(bit: number, dst: Ea): this {
    this.dw(0x08c0 | this.eaBits(dst));
    this.dw(bit & 0xff);
    this.eaWords(dst, "b");
    return this;
  }
  /** `bclr #n, <ea>`. */
  bclr(bit: number, dst: Ea): this {
    this.dw(0x0880 | this.eaBits(dst));
    this.dw(bit & 0xff);
    this.eaWords(dst, "b");
    return this;
  }

  // --- control flow ----------------------------------------------------------

  /** A 16-bit relative displacement to a label, patched at assembly time. */
  private rel16(target: Ref): void {
    const at = this.code.length;
    const base = this.pc;
    this.db(0, 0);
    if (typeof target === "number") {
      const delta = target - base;
      if (delta < -0x8000 || delta > 0x7fff) throw new AsmError(`branch out of range: ${delta}`);
      this.code[at] = (delta >> 8) & 0xff;
      this.code[at + 1] = delta & 0xff;
      return;
    }
    this.fixups.push({ at, kind: "rel16", ref: asLabelRef(target), base });
  }

  /**
   * `bcc.w target` — a conditional branch with a sixteen-bit displacement.
   *
   * Always the word form, never the byte one. A generated rule body is routinely
   * a kilobyte and the assembler is single-pass, so choosing the short form
   * would mean guessing; ±32 KiB covers any one routine and anything further is
   * an {@link AsmError} rather than a wrap.
   */
  bcc(cond: M68kCC, target: Ref): this {
    if (cond === "t" || cond === "f") throw new AsmError("use bra/bsr for the t and f conditions");
    this.dw(0x6000 | (CC_CODE[cond] << 8));
    this.rel16(target);
    return this;
  }

  /** `bra.w target`. */
  bra(target: Ref): this {
    this.dw(0x6000);
    this.rel16(target);
    return this;
  }

  /** `bsr.w target`. */
  bsr(target: Ref): this {
    this.dw(0x6100);
    this.rel16(target);
    return this;
  }

  /** `dbra Dn, target` — decrement and branch while the counter is not `-1`. */
  dbra(dn: number, target: Ref): this {
    this.dw(0x51c8 | dn);
    this.rel16(target);
    return this;
  }

  /** `jmp <ea>` — absolute, so it always reaches. */
  jmp(target: Ea | Ref): this {
    const ea = isEa(target) ? target : eaAbs(target);
    this.dw(0x4ec0 | this.eaBits(ea));
    this.eaWords(ea, "l");
    return this;
  }

  /** `jsr <ea>` — absolute, so it always reaches. */
  jsr(target: Ea | Ref): this {
    const ea = isEa(target) ? target : eaAbs(target);
    this.dw(0x4e80 | this.eaBits(ea));
    this.eaWords(ea, "l");
    return this;
  }

  /** `rts`. */
  rts(): this {
    return this.dw(0x4e75);
  }
  /** `rte`. */
  rte(): this {
    return this.dw(0x4e73);
  }
  /** `nop`. */
  nop(): this {
    return this.dw(0x4e71);
  }
  /** `move <ea>, sr` — the interrupt mask, among other things. */
  moveToSr(src: Ea): this {
    this.dw(0x46c0 | this.eaBits(src));
    this.eaWords(src, "w");
    return this;
  }
  /** `move sr, <ea>`. */
  moveFromSr(dst: Ea): this {
    this.dw(0x40c0 | this.eaBits(dst));
    this.eaWords(dst, "w");
    return this;
  }
  /** `stop #imm`. */
  stop(value: number): this {
    this.dw(0x4e72);
    return this.dw(value & 0xffff);
  }

  // --- finishing -------------------------------------------------------------

  /** Resolve every reference and return the assembled bytes. */
  assemble(): Uint8Array {
    for (const fixup of this.fixups) {
      const base = this.labels.get(fixup.ref.label);
      if (base === undefined) throw new AsmError(`undefined label '${fixup.ref.label}'`);
      const value = base + fixup.ref.addend;
      switch (fixup.kind) {
        case "abs32":
          this.code[fixup.at] = (value >>> 24) & 0xff;
          this.code[fixup.at + 1] = (value >>> 16) & 0xff;
          this.code[fixup.at + 2] = (value >>> 8) & 0xff;
          this.code[fixup.at + 3] = value & 0xff;
          break;
        case "abs16":
          this.code[fixup.at] = (value >> 8) & 0xff;
          this.code[fixup.at + 1] = value & 0xff;
          break;
        case "rel16": {
          const delta = value - fixup.base;
          if (delta < -0x8000 || delta > 0x7fff) {
            throw new AsmError(
              `branch to '${fixup.ref.label}' is ${delta} bytes away; use jmp or jsr`,
            );
          }
          this.code[fixup.at] = (delta >> 8) & 0xff;
          this.code[fixup.at + 1] = delta & 0xff;
          break;
        }
        case "rel8": {
          const delta = value - fixup.base;
          if (delta < -128 || delta > 127) {
            throw new AsmError(`short branch to '${fixup.ref.label}' is ${delta} bytes away`);
          }
          this.code[fixup.at] = delta & 0xff;
          break;
        }
      }
    }
    return Uint8Array.from(this.code);
  }

  /** Every label and its address — the map a profiler or a harness reads. */
  symbols(): ReadonlyMap<string, number> {
    return new Map(this.labels);
  }
}

/** Whether a jump target was given as an addressing mode or as a bare label. */
function isEa(value: Ea | Ref): value is Ea {
  return typeof value === "object" && value !== null && "k" in value;
}
