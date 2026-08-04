/**
 * A NEC V30MZ assembler — 16-bit x86.
 *
 * The ninth of `core`'s encoders, and it exists for the reason all of them do
 * (`asm/sm83.ts`, doc 14 §Runtime model): a game compiles to machine code, and
 * the encoder is TypeScript because the browser has no assembler. What it buys
 * is the WonderSwan and the WonderSwan Color, whose processor is an 8086 core
 * with the 80186's additions — so the instruction set here is the one a stock
 * `nasm -f bin` assembles for `bits 16`, which is what makes the differential
 * oracle in `test/v30mz-nasm.test.ts` possible at all.
 *
 * Four things about this architecture reach the emitter above it, and each is a
 * reason a method here looks the way it does.
 *
 *   - **An operand is a byte after the opcode, not part of it.** Every 8-bit CPU
 *     in this project spends an opcode per addressing form; x86 spends a
 *     *mod/reg/rm* byte instead, so one encoder method covers "register",
 *     "[address]" and "[base+displacement]" and the operand decides. That is why
 *     {@link Mem} is a value the caller builds rather than a spelling of a method
 *     name, and why {@link Asm30 the assembler} has an `alu` taking an operation
 *     rather than eight named methods.
 *   - **A conditional branch reaches ±128 bytes.** `jcc rel16` is an 80386
 *     instruction and this is not an 80386, so a rule body — routinely a
 *     kilobyte — cannot be branched over. The backend inverts the condition and
 *     jumps, exactly as the 6502 backend's `ctx.far` does; an out-of-range
 *     branch is an {@link AsmError} here rather than a wrap.
 *   - **A memory operand carries a segment.** Data reads default to `DS` and the
 *     stack to `SS`, and a table in cartridge ROM is in neither — so a `Mem` has
 *     an optional segment override, which encodes as a one-byte prefix in front
 *     of everything else. {@link romAt} is the form the backend uses for its own
 *     tables, and it is a `cs:` override because a WonderSwan cartridge answers
 *     the code segment.
 *   - **`mul` and `div` are real instructions.** 16×16→32 in `dx:ax` and
 *     32÷16→16 with a remainder, which is what makes a 16.16 multiply four
 *     `mul`s rather than a bit loop, on the Mega Drive's terms. `div` faults on
 *     overflow rather than truncating, which is the value layer's problem and
 *     not this file's.
 *
 * The design is the same dull one every encoder here has: explicit encodings, a
 * fixup list for forward references, one pass and no relaxation. Where the
 * instruction set offers a shorter encoding of the same operation — a
 * sign-extended immediate, an accumulator form — this file takes it
 * unconditionally, so the choice is a property of the operands rather than of
 * when the assembler saw them.
 *
 * Sources: Intel — iAPX 86/88 User's Manual (the opcode tables in Appendix B)
 * and 80186 instruction extensions; NEC — µPD70116 (V30) datasheet, whose
 * additions over the 8086 are the 80186 set. The encodings are checked twice:
 * hand-read, as every encoder here is, and word-for-word against NASM.
 */

import { AsmError, label, type LabelRef, type Ref } from "./sm83.js";

export { AsmError, label };
export type { LabelRef, Ref };

/** A 16-bit register, in mod/reg/rm order. */
export type X86R16 = "ax" | "cx" | "dx" | "bx" | "sp" | "bp" | "si" | "di";

/** An 8-bit register, in mod/reg/rm order. */
export type X86R8 = "al" | "cl" | "dl" | "bl" | "ah" | "ch" | "dh" | "bh";

/** A segment register, in opcode order. */
export type X86Seg = "es" | "cs" | "ss" | "ds";

/**
 * The eight ALU operations, in the order the opcode map puts them.
 *
 * One block of eight opcodes per addressing form, so the operation is arithmetic
 * on an opcode rather than a table lookup — which is why this type is an ordered
 * union and not a set of method names.
 */
export type X86AluOp = "add" | "or" | "adc" | "sbb" | "and" | "sub" | "xor" | "cmp";

/** The eight shift and rotate operations, in `/reg` order. `sal` is `shl`. */
export type X86ShiftOp = "rol" | "ror" | "rcl" | "rcr" | "shl" | "shr" | "sal" | "sar";

/** The `F6`/`F7` group: the unary operations that are not `inc`/`dec`. */
export type X86UnaryOp = "test" | "not" | "neg" | "mul" | "imul" | "div" | "idiv";

/**
 * A branch condition, in opcode order.
 *
 * Both spellings of each are here because both read naturally at a call site:
 * `b`/`ae` after a comparison of unsigned quantities, `l`/`ge` after a signed
 * one, and `c`/`nc` when what is being tested really is the carry out of an
 * addition. They encode identically, which is the hardware's arrangement rather
 * than a convenience of this file.
 */
export type X86CC =
  | "o"
  | "no"
  | "b"
  | "c"
  | "nb"
  | "ae"
  | "nc"
  | "e"
  | "z"
  | "ne"
  | "nz"
  | "be"
  | "a"
  | "s"
  | "ns"
  | "p"
  | "np"
  | "l"
  | "ge"
  | "le"
  | "g";

/**
 * The base and index a memory operand may name.
 *
 * 16-bit addressing offers these eight and no others — there is no `[ax]`, and
 * no scale — so this is the whole of it rather than a subset someone has to
 * check against a manual. `bp` addresses the stack segment by default and every
 * other form addresses data; the backend keeps `SS` equal to `DS`, so that
 * distinction costs it nothing.
 */
export type X86Base = "bx+si" | "bx+di" | "bp+si" | "bp+di" | "si" | "di" | "bp" | "bx";

/**
 * A memory operand: an optional base, a displacement, and an optional segment.
 *
 * With no base this is a direct `[disp16]`, which is what almost every access to
 * a game's own state is — the allocator gives every property a fixed address, so
 * the interesting operands are the plain ones.
 */
export interface Mem {
  readonly base?: X86Base;
  readonly disp?: Ref;
  readonly seg?: X86Seg;
}

/** `[disp]` — a direct address in the data segment. */
export function abs(disp: Ref): Mem {
  return { disp };
}

/** `[base + disp]`, where `disp` defaults to zero. */
export function at(base: X86Base, disp: Ref = 0): Mem {
  return { base, disp };
}

/**
 * The same operand, read through the code segment.
 *
 * A cartridge's tables are in ROM and a game's state is in RAM, and on this
 * machine those are two segments rather than two addresses. The backend keeps
 * `DS` on RAM because that is what a tick touches most, so a table read carries
 * the one-byte override and says so at the call site.
 */
export function rom(operand: Mem): Mem {
  return { ...operand, seg: "cs" };
}

/** `cs:[base + disp]` — the form a table walk uses. */
export function romAt(base: X86Base, disp: Ref = 0): Mem {
  return { base, disp, seg: "cs" };
}

/** `cs:[disp]` — one word of a table at a known address. */
export function romAbs(disp: Ref): Mem {
  return { disp, seg: "cs" };
}

const R16_CODE: Readonly<Record<X86R16, number>> = {
  ax: 0,
  cx: 1,
  dx: 2,
  bx: 3,
  sp: 4,
  bp: 5,
  si: 6,
  di: 7,
};

const R8_CODE: Readonly<Record<X86R8, number>> = {
  al: 0,
  cl: 1,
  dl: 2,
  bl: 3,
  ah: 4,
  ch: 5,
  dh: 6,
  bh: 7,
};

const SEG_CODE: Readonly<Record<X86Seg, number>> = { es: 0, cs: 1, ss: 2, ds: 3 };

const SEG_PREFIX: Readonly<Record<X86Seg, number>> = { es: 0x26, cs: 0x2e, ss: 0x36, ds: 0x3e };

const BASE_CODE: Readonly<Record<X86Base, number>> = {
  "bx+si": 0,
  "bx+di": 1,
  "bp+si": 2,
  "bp+di": 3,
  si: 4,
  di: 5,
  bp: 6,
  bx: 7,
};

const ALU_CODE: Readonly<Record<X86AluOp, number>> = {
  add: 0,
  or: 1,
  adc: 2,
  sbb: 3,
  and: 4,
  sub: 5,
  xor: 6,
  cmp: 7,
};

const SHIFT_CODE: Readonly<Record<X86ShiftOp, number>> = {
  rol: 0,
  ror: 1,
  rcl: 2,
  rcr: 3,
  shl: 4,
  shr: 5,
  sal: 4,
  sar: 7,
};

const UNARY_CODE: Readonly<Record<X86UnaryOp, number>> = {
  test: 0,
  not: 2,
  neg: 3,
  mul: 4,
  imul: 5,
  div: 6,
  idiv: 7,
};

const CC_CODE: Readonly<Record<X86CC, number>> = {
  o: 0x0,
  no: 0x1,
  b: 0x2,
  c: 0x2,
  nb: 0x3,
  ae: 0x3,
  nc: 0x3,
  e: 0x4,
  z: 0x4,
  ne: 0x5,
  nz: 0x5,
  be: 0x6,
  a: 0x7,
  s: 0x8,
  ns: 0x9,
  p: 0xa,
  np: 0xb,
  l: 0xc,
  ge: 0xd,
  le: 0xe,
  g: 0xf,
};

/** Invert a condition — what a long branch is built out of. */
export function invert(cc: X86CC): X86CC {
  const flipped: Readonly<Record<X86CC, X86CC>> = {
    o: "no",
    no: "o",
    b: "ae",
    c: "nc",
    nb: "b",
    ae: "b",
    nc: "c",
    e: "ne",
    z: "nz",
    ne: "e",
    nz: "z",
    be: "a",
    a: "be",
    s: "ns",
    ns: "s",
    p: "np",
    np: "p",
    l: "ge",
    ge: "l",
    le: "g",
    g: "le",
  };
  return flipped[cc];
}

/** Normalise the two spellings of a label reference. */
function asLabelRef(ref: string | LabelRef): LabelRef {
  return typeof ref === "string" ? { label: ref, addend: 0 } : ref;
}

interface Fixup {
  at: number;
  kind: "abs16" | "rel8" | "rel16";
  ref: LabelRef;
  /** Address of the instruction after the operand — for relative branches. */
  next: number;
}

/**
 * A growable code buffer with labels, for the V30MZ.
 *
 * `origin` is the offset byte zero occupies *within its segment*, which on this
 * console is zero: a cartridge's last 64 KiB bank answers segment `$F000` from
 * its own first byte, so a label is a plain 16-bit offset and nothing has to do
 * base arithmetic.
 */
export class Asm30 {
  private code: number[] = [];
  private readonly labels = new Map<string, number>();
  private readonly fixups: Fixup[] = [];

  constructor(readonly origin = 0) {}

  /** Bytes emitted so far. */
  get length(): number {
    return this.code.length;
  }

  /** The offset the next byte will occupy. */
  get pc(): number {
    return this.origin + this.code.length;
  }

  /** Define a label at the current offset. */
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
    const at2 = this.labels.get(name);
    if (at2 === undefined) throw new AsmError(`undefined label '${name}'`);
    return at2;
  }

  // --- raw data --------------------------------------------------------------

  /** Emit literal bytes. */
  db(...values: number[]): this {
    for (const value of values) this.code.push(value & 0xff);
    return this;
  }

  /** Emit a little-endian word, resolving a label if given. */
  dw(value: Ref): this {
    if (typeof value === "number") return this.db(value, value >> 8);
    this.fixups.push({ at: this.code.length, kind: "abs16", ref: asLabelRef(value), next: 0 });
    return this.db(0, 0);
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

  /** Pad with `fill` until the next byte lands on `address`. */
  padTo(address: number, fill = 0): this {
    if (this.pc > address) {
      throw new AsmError(
        `cannot pad to $${address.toString(16)}: already at $${this.pc.toString(16)}`,
      );
    }
    return this.ds(address - this.pc, fill);
  }

  // --- operand encoding ------------------------------------------------------

  private imm8(value: number): void {
    this.db(value);
  }

  private imm16(value: Ref): void {
    if (typeof value === "number") {
      this.db(value, value >> 8);
      return;
    }
    this.fixups.push({ at: this.code.length, kind: "abs16", ref: asLabelRef(value), next: 0 });
    this.db(0, 0);
  }

  private rel8(target: Ref): void {
    const at2 = this.code.length;
    this.db(0);
    const next = this.pc;
    if (typeof target === "number") {
      const delta = target - next;
      if (delta < -128 || delta > 127) throw new AsmError(`short branch out of range: ${delta}`);
      this.code[at2] = delta & 0xff;
      return;
    }
    this.fixups.push({ at: at2, kind: "rel8", ref: asLabelRef(target), next });
  }

  private rel16(target: Ref): void {
    const at2 = this.code.length;
    this.db(0, 0);
    const next = this.pc;
    if (typeof target === "number") {
      const delta = (target - next) & 0xffff;
      this.code[at2] = delta & 0xff;
      this.code[at2 + 1] = (delta >> 8) & 0xff;
      return;
    }
    this.fixups.push({ at: at2, kind: "rel16", ref: asLabelRef(target), next });
  }

  /** A segment override, if the operand asked for one. */
  private prefix(operand: Mem): void {
    if (operand.seg !== undefined) this.db(SEG_PREFIX[operand.seg]);
  }

  /**
   * The mod/reg/rm byte and whatever displacement follows it.
   *
   * `reg` is the opcode's other operand — a register number, or the `/n`
   * extension for the groups that have one. The displacement takes the shortest
   * encoding the value allows, except that a label is always sixteen bits: how
   * far away it is has not been decided yet, and an assembler that guessed short
   * would have to relax, which is the one thing every encoder here refuses to do.
   */
  private modrm(reg: number, operand: Mem): void {
    const disp = operand.disp ?? 0;
    if (operand.base === undefined) {
      this.db(0x06 | ((reg & 7) << 3));
      this.imm16(disp);
      return;
    }
    const rm = BASE_CODE[operand.base];
    if (typeof disp === "number") {
      // `[bp]` with no displacement is where the direct form lives, so the base
      // that would encode it takes an explicit zero instead.
      if (disp === 0 && operand.base !== "bp") {
        this.db(rm | ((reg & 7) << 3));
        return;
      }
      if (disp >= -128 && disp <= 127) {
        this.db(0x40 | rm | ((reg & 7) << 3));
        this.imm8(disp);
        return;
      }
      this.db(0x80 | rm | ((reg & 7) << 3));
      this.imm16(disp);
      return;
    }
    this.db(0x80 | rm | ((reg & 7) << 3));
    this.imm16(disp);
  }

  /** The mod/reg/rm byte for a register destination. */
  private modrmReg(reg: number, rm: number): void {
    this.db(0xc0 | ((reg & 7) << 3) | (rm & 7));
  }

  // --- moves -----------------------------------------------------------------

  /** `mov dst, src` — 16-bit register to register. */
  mov(dst: X86R16, src: X86R16): this {
    this.db(0x89);
    this.modrmReg(R16_CODE[src], R16_CODE[dst]);
    return this;
  }

  /** `mov dst, imm16`. */
  movi(dst: X86R16, value: Ref): this {
    this.db(0xb8 | R16_CODE[dst]);
    this.imm16(value);
    return this;
  }

  /**
   * `mov dst, [mem]`.
   *
   * The accumulator has an opcode of its own for a direct address — three bytes
   * against four, with no mod/reg/rm byte at all — and this takes it. That is
   * worth having rather than tidying away: `ax` is where a 16.16 value's low
   * word lives and a direct address is what every property of every object is,
   * so the pair is most of what a tick does.
   */
  movm(dst: X86R16, src: Mem): this {
    this.prefix(src);
    if (dst === "ax" && src.base === undefined) {
      this.db(0xa1);
      this.imm16(src.disp ?? 0);
      return this;
    }
    this.db(0x8b);
    this.modrm(R16_CODE[dst], src);
    return this;
  }

  /** `mov [mem], src`, with the accumulator's own form for a direct address. */
  movmr(dst: Mem, src: X86R16): this {
    this.prefix(dst);
    if (src === "ax" && dst.base === undefined) {
      this.db(0xa3);
      this.imm16(dst.disp ?? 0);
      return this;
    }
    this.db(0x89);
    this.modrm(R16_CODE[src], dst);
    return this;
  }

  /** `mov word [mem], imm16`. */
  movmi(dst: Mem, value: Ref): this {
    this.prefix(dst);
    this.db(0xc7);
    this.modrm(0, dst);
    this.imm16(value);
    return this;
  }

  /** `mov dst, src` — 8-bit register to register. */
  mov8(dst: X86R8, src: X86R8): this {
    this.db(0x88);
    this.modrmReg(R8_CODE[src], R8_CODE[dst]);
    return this;
  }

  /** `mov dst, imm8`. */
  movi8(dst: X86R8, value: number): this {
    this.db(0xb0 | R8_CODE[dst]);
    this.imm8(value);
    return this;
  }

  /** `mov dst, byte [mem]`, with `al`'s own form for a direct address. */
  movm8(dst: X86R8, src: Mem): this {
    this.prefix(src);
    if (dst === "al" && src.base === undefined) {
      this.db(0xa0);
      this.imm16(src.disp ?? 0);
      return this;
    }
    this.db(0x8a);
    this.modrm(R8_CODE[dst], src);
    return this;
  }

  /** `mov byte [mem], src`, with `al`'s own form for a direct address. */
  movmr8(dst: Mem, src: X86R8): this {
    this.prefix(dst);
    if (src === "al" && dst.base === undefined) {
      this.db(0xa2);
      this.imm16(dst.disp ?? 0);
      return this;
    }
    this.db(0x88);
    this.modrm(R8_CODE[src], dst);
    return this;
  }

  /** `mov byte [mem], imm8`. */
  movmi8(dst: Mem, value: number): this {
    this.prefix(dst);
    this.db(0xc6);
    this.modrm(0, dst);
    this.imm8(value);
    return this;
  }

  /** `mov sreg, src` — the only way a segment register is loaded. */
  movsr(dst: X86Seg, src: X86R16): this {
    if (dst === "cs") throw new AsmError("mov cs, r16 is not an instruction");
    this.db(0x8e);
    this.modrmReg(SEG_CODE[dst], R16_CODE[src]);
    return this;
  }

  /** `mov dst, sreg`. */
  movrs(dst: X86R16, src: X86Seg): this {
    this.db(0x8c);
    this.modrmReg(SEG_CODE[src], R16_CODE[dst]);
    return this;
  }

  /** `lea dst, [mem]` — the address, not what is at it. */
  lea(dst: X86R16, src: Mem): this {
    if (src.seg !== undefined)
      throw new AsmError("lea computes an offset; a segment is meaningless");
    this.db(0x8d);
    this.modrm(R16_CODE[dst], src);
    return this;
  }

  /** `xchg a, b`. */
  xchg(a: X86R16, b: X86R16): this {
    if (a === "ax") return this.db(0x90 | R16_CODE[b]);
    if (b === "ax") return this.db(0x90 | R16_CODE[a]);
    this.db(0x87);
    this.modrmReg(R16_CODE[a], R16_CODE[b]);
    return this;
  }

  // --- stack -----------------------------------------------------------------

  push(reg: X86R16): this {
    return this.db(0x50 | R16_CODE[reg]);
  }

  pop(reg: X86R16): this {
    return this.db(0x58 | R16_CODE[reg]);
  }

  pushSeg(seg: X86Seg): this {
    return this.db(0x06 | (SEG_CODE[seg] << 3));
  }

  popSeg(seg: X86Seg): this {
    if (seg === "cs") throw new AsmError("pop cs is not an instruction");
    return this.db(0x07 | (SEG_CODE[seg] << 3));
  }

  /** `push imm16` — an 80186 addition, and this core has them. */
  pushi(value: Ref): this {
    this.db(0x68);
    this.imm16(value);
    return this;
  }

  pushf(): this {
    return this.db(0x9c);
  }

  popf(): this {
    return this.db(0x9d);
  }

  /** `pusha` / `popa` — all eight registers, an 80186 addition. */
  pusha(): this {
    return this.db(0x60);
  }

  popa(): this {
    return this.db(0x61);
  }

  // --- arithmetic and logic --------------------------------------------------

  /** `op dst, src` — 16-bit register to register. */
  alu(op: X86AluOp, dst: X86R16, src: X86R16): this {
    this.db(0x01 | (ALU_CODE[op] << 3));
    this.modrmReg(R16_CODE[src], R16_CODE[dst]);
    return this;
  }

  /** `op dst, [mem]`. */
  aluM(op: X86AluOp, dst: X86R16, src: Mem): this {
    this.prefix(src);
    this.db(0x03 | (ALU_CODE[op] << 3));
    this.modrm(R16_CODE[dst], src);
    return this;
  }

  /** `op [mem], src`. */
  aluMR(op: X86AluOp, dst: Mem, src: X86R16): this {
    this.prefix(dst);
    this.db(0x01 | (ALU_CODE[op] << 3));
    this.modrm(R16_CODE[src], dst);
    return this;
  }

  /**
   * `op dst, imm16`.
   *
   * Three encodings of the same thing, and which one comes out is decided by the
   * value: a sign-extended byte where the value fits in one, the accumulator's
   * own opcode where the destination is `ax`, and the general form otherwise.
   * Each is shorter than the next and none of them depends on assembly order.
   */
  aluI(op: X86AluOp, dst: X86R16, value: Ref): this {
    if (typeof value === "number" && value >= -128 && value <= 127) {
      this.db(0x83);
      this.modrmReg(ALU_CODE[op], R16_CODE[dst]);
      this.imm8(value);
      return this;
    }
    if (dst === "ax") {
      this.db(0x05 | (ALU_CODE[op] << 3));
      this.imm16(value);
      return this;
    }
    this.db(0x81);
    this.modrmReg(ALU_CODE[op], R16_CODE[dst]);
    this.imm16(value);
    return this;
  }

  /** `op word [mem], imm16`. */
  aluMI(op: X86AluOp, dst: Mem, value: Ref): this {
    this.prefix(dst);
    if (typeof value === "number" && value >= -128 && value <= 127) {
      this.db(0x83);
      this.modrm(ALU_CODE[op], dst);
      this.imm8(value);
      return this;
    }
    this.db(0x81);
    this.modrm(ALU_CODE[op], dst);
    this.imm16(value);
    return this;
  }

  /** `op dst, src` — 8-bit register to register. */
  alu8(op: X86AluOp, dst: X86R8, src: X86R8): this {
    this.db(0x00 | (ALU_CODE[op] << 3));
    this.modrmReg(R8_CODE[src], R8_CODE[dst]);
    return this;
  }

  /** `op dst, byte [mem]`. */
  aluM8(op: X86AluOp, dst: X86R8, src: Mem): this {
    this.prefix(src);
    this.db(0x02 | (ALU_CODE[op] << 3));
    this.modrm(R8_CODE[dst], src);
    return this;
  }

  /** `op byte [mem], src`. */
  aluMR8(op: X86AluOp, dst: Mem, src: X86R8): this {
    this.prefix(dst);
    this.db(0x00 | (ALU_CODE[op] << 3));
    this.modrm(R8_CODE[src], dst);
    return this;
  }

  /** `op dst, imm8`. */
  aluI8(op: X86AluOp, dst: X86R8, value: number): this {
    if (dst === "al") {
      this.db(0x04 | (ALU_CODE[op] << 3));
      this.imm8(value);
      return this;
    }
    this.db(0x80);
    this.modrmReg(ALU_CODE[op], R8_CODE[dst]);
    this.imm8(value);
    return this;
  }

  /** `op byte [mem], imm8`. */
  aluMI8(op: X86AluOp, dst: Mem, value: number): this {
    this.prefix(dst);
    this.db(0x80);
    this.modrm(ALU_CODE[op], dst);
    this.imm8(value);
    return this;
  }

  /** `test dst, src` — an `and` that keeps only the flags. */
  test(dst: X86R16, src: X86R16): this {
    this.db(0x85);
    this.modrmReg(R16_CODE[src], R16_CODE[dst]);
    return this;
  }

  /** `test dst, imm16`. */
  testI(dst: X86R16, value: Ref): this {
    if (dst === "ax") {
      this.db(0xa9);
      this.imm16(value);
      return this;
    }
    this.db(0xf7);
    this.modrmReg(0, R16_CODE[dst]);
    this.imm16(value);
    return this;
  }

  /** `test dst, imm8`. */
  testI8(dst: X86R8, value: number): this {
    if (dst === "al") {
      this.db(0xa8);
      this.imm8(value);
      return this;
    }
    this.db(0xf6);
    this.modrmReg(0, R8_CODE[dst]);
    this.imm8(value);
    return this;
  }

  /** `test byte [mem], imm8` — how a flag byte is read without loading it. */
  testMI8(dst: Mem, value: number): this {
    this.prefix(dst);
    this.db(0xf6);
    this.modrm(0, dst);
    this.imm8(value);
    return this;
  }

  inc(reg: X86R16): this {
    return this.db(0x40 | R16_CODE[reg]);
  }

  dec(reg: X86R16): this {
    return this.db(0x48 | R16_CODE[reg]);
  }

  incM(operand: Mem): this {
    this.prefix(operand);
    this.db(0xff);
    this.modrm(0, operand);
    return this;
  }

  decM(operand: Mem): this {
    this.prefix(operand);
    this.db(0xff);
    this.modrm(1, operand);
    return this;
  }

  incM8(operand: Mem): this {
    this.prefix(operand);
    this.db(0xfe);
    this.modrm(0, operand);
    return this;
  }

  decM8(operand: Mem): this {
    this.prefix(operand);
    this.db(0xfe);
    this.modrm(1, operand);
    return this;
  }

  /** `not` / `neg` / `mul` / `imul` / `div` / `idiv` on a 16-bit register. */
  unary(op: Exclude<X86UnaryOp, "test">, reg: X86R16): this {
    this.db(0xf7);
    this.modrmReg(UNARY_CODE[op], R16_CODE[reg]);
    return this;
  }

  /** The same, on a word in memory. */
  unaryM(op: Exclude<X86UnaryOp, "test">, operand: Mem): this {
    this.prefix(operand);
    this.db(0xf7);
    this.modrm(UNARY_CODE[op], operand);
    return this;
  }

  /** The same, on an 8-bit register. */
  unary8(op: Exclude<X86UnaryOp, "test">, reg: X86R8): this {
    this.db(0xf6);
    this.modrmReg(UNARY_CODE[op], R8_CODE[reg]);
    return this;
  }

  /** `cbw` — sign-extend `al` into `ax`. */
  cbw(): this {
    return this.db(0x98);
  }

  /** `cwd` — sign-extend `ax` into `dx:ax`, which is what `idiv` divides. */
  cwd(): this {
    return this.db(0x99);
  }

  // --- shifts ----------------------------------------------------------------

  /**
   * `op reg, count` — by one, by `cl`, or by an immediate.
   *
   * The immediate form is the 80186's rather than the 8086's, and this core has
   * it: a 16.16 value is shifted by sixteen constantly, and doing that one bit at
   * a time or through `cl` would cost the value layer a register it needs.
   */
  shift(op: X86ShiftOp, reg: X86R16, count: number | "cl" = 1): this {
    if (count === "cl") {
      this.db(0xd3);
      this.modrmReg(SHIFT_CODE[op], R16_CODE[reg]);
      return this;
    }
    if (count === 1) {
      this.db(0xd1);
      this.modrmReg(SHIFT_CODE[op], R16_CODE[reg]);
      return this;
    }
    this.db(0xc1);
    this.modrmReg(SHIFT_CODE[op], R16_CODE[reg]);
    this.imm8(count);
    return this;
  }

  /** The same, on an 8-bit register. */
  shift8(op: X86ShiftOp, reg: X86R8, count: number | "cl" = 1): this {
    if (count === "cl") {
      this.db(0xd2);
      this.modrmReg(SHIFT_CODE[op], R8_CODE[reg]);
      return this;
    }
    if (count === 1) {
      this.db(0xd0);
      this.modrmReg(SHIFT_CODE[op], R8_CODE[reg]);
      return this;
    }
    this.db(0xc0);
    this.modrmReg(SHIFT_CODE[op], R8_CODE[reg]);
    this.imm8(count);
    return this;
  }

  /** The same, on a word in memory. */
  shiftM(op: X86ShiftOp, operand: Mem, count: number | "cl" = 1): this {
    this.prefix(operand);
    if (count === "cl") {
      this.db(0xd3);
      this.modrm(SHIFT_CODE[op], operand);
      return this;
    }
    if (count === 1) {
      this.db(0xd1);
      this.modrm(SHIFT_CODE[op], operand);
      return this;
    }
    this.db(0xc1);
    this.modrm(SHIFT_CODE[op], operand);
    this.imm8(count);
    return this;
  }

  // --- control flow ----------------------------------------------------------

  /**
   * `jmp near` — three bytes, and it reaches the whole segment.
   *
   * There is a two-byte short form, and this file does not choose it: a jump the
   * emitter did not measure is a jump that stops reaching the day a rule body
   * grows, and a byte is not worth a class of failure that only appears in large
   * games. {@link jmpShort} is there for the places a caller *can* see the
   * distance.
   */
  jmp(target: Ref): this {
    this.db(0xe9);
    this.rel16(target);
    return this;
  }

  /** `jmp short` — two bytes, ±128, and range-checked. */
  jmpShort(target: Ref): this {
    this.db(0xeb);
    this.rel8(target);
    return this;
  }

  /** `jmp seg:off` — the far jump a reset vector is. */
  jmpFar(segment: number, offset: Ref): this {
    this.db(0xea);
    this.imm16(offset);
    this.imm16(segment);
    return this;
  }

  /** `jmp reg` — an indirect jump, which is how a scene table dispatches. */
  jmpr(reg: X86R16): this {
    this.db(0xff);
    this.modrmReg(4, R16_CODE[reg]);
    return this;
  }

  /**
   * `jcc` — and it reaches ±128 bytes, because a near conditional jump is an
   * 80386 instruction.
   *
   * That is the constraint the backend's `far` exists for: anything branching
   * over a rule body inverts the condition and jumps.
   */
  jcc(cc: X86CC, target: Ref): this {
    this.db(0x70 | CC_CODE[cc]);
    this.rel8(target);
    return this;
  }

  /** `call near`. */
  call(target: Ref): this {
    this.db(0xe8);
    this.rel16(target);
    return this;
  }

  ret(): this {
    return this.db(0xc3);
  }

  /** `iret` — the return an interrupt handler takes, flags included. */
  iret(): this {
    return this.db(0xcf);
  }

  /** `loop` — decrement `cx` and branch, ±128 bytes. */
  loop(target: Ref): this {
    this.db(0xe2);
    this.rel8(target);
    return this;
  }

  // --- strings ---------------------------------------------------------------

  /** `movsb` / `movsw` — `ES:DI` from `DS:SI`, which is what a block copy is. */
  movsb(): this {
    return this.db(0xa4);
  }

  movsw(): this {
    return this.db(0xa5);
  }

  stosb(): this {
    return this.db(0xaa);
  }

  stosw(): this {
    return this.db(0xab);
  }

  lodsb(): this {
    return this.db(0xac);
  }

  lodsw(): this {
    return this.db(0xad);
  }

  /**
   * `rep` — the prefix, emitted on its own.
   *
   * A prefix is a byte in front of the instruction it repeats, so this is a
   * method rather than a flag: `asm.rep().movsw()` reads as the two bytes it is,
   * and nothing has to enumerate the string operations twice.
   */
  rep(): this {
    return this.db(0xf3);
  }

  /** A segment override, for the one case a {@link Mem} cannot carry it: a string op. */
  segPrefix(seg: X86Seg): this {
    return this.db(SEG_PREFIX[seg]);
  }

  // --- ports -----------------------------------------------------------------

  /** `out imm8, al` — the display controller and the sound chip are here. */
  out8(port: number): this {
    this.db(0xe6);
    this.imm8(port);
    return this;
  }

  /** `out imm8, ax` — two consecutive ports in one instruction. */
  out16(port: number): this {
    this.db(0xe7);
    this.imm8(port);
    return this;
  }

  /** `in al, imm8`. */
  in8(port: number): this {
    this.db(0xe4);
    this.imm8(port);
    return this;
  }

  /** `in ax, imm8`. */
  in16(port: number): this {
    this.db(0xe5);
    this.imm8(port);
    return this;
  }

  /** `out dx, al` — for a port number the code computed. */
  outDx8(): this {
    return this.db(0xee);
  }

  /** `in al, dx`. */
  inDx8(): this {
    return this.db(0xec);
  }

  // --- flags and idling ------------------------------------------------------

  cli(): this {
    return this.db(0xfa);
  }

  sti(): this {
    return this.db(0xfb);
  }

  cld(): this {
    return this.db(0xfc);
  }

  std(): this {
    return this.db(0xfd);
  }

  clc(): this {
    return this.db(0xf8);
  }

  stc(): this {
    return this.db(0xf9);
  }

  hlt(): this {
    return this.db(0xf4);
  }

  nop(): this {
    return this.db(0x90);
  }

  // --- finishing -------------------------------------------------------------

  /** Resolve every reference and return the assembled bytes. */
  assemble(): Uint8Array {
    for (const fixup of this.fixups) {
      const base = this.labels.get(fixup.ref.label);
      if (base === undefined) throw new AsmError(`undefined label '${fixup.ref.label}'`);
      const value = base + fixup.ref.addend;
      switch (fixup.kind) {
        case "abs16":
          this.code[fixup.at] = value & 0xff;
          this.code[fixup.at + 1] = (value >> 8) & 0xff;
          break;
        case "rel8": {
          const delta = value - fixup.next;
          if (delta < -128 || delta > 127) {
            throw new AsmError(
              `short branch to '${fixup.ref.label}' is ${delta} bytes away; invert it and jmp`,
            );
          }
          this.code[fixup.at] = delta & 0xff;
          break;
        }
        case "rel16": {
          const delta = (value - fixup.next) & 0xffff;
          this.code[fixup.at] = delta & 0xff;
          this.code[fixup.at + 1] = (delta >> 8) & 0xff;
          break;
        }
      }
    }
    return Uint8Array.from(this.code);
  }

  /** Every label and its offset — the map a profiler or a harness reads. */
  symbols(): ReadonlyMap<string, number> {
    return new Map(this.labels);
  }
}
