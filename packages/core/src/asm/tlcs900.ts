/**
 * A Toshiba TLCS-900/H assembler.
 *
 * The tenth of `core`'s encoders, and it exists for the reason all of them do
 * (`asm/sm83.ts`, doc 14 §Runtime model): a game compiles to machine code, and
 * the encoder is TypeScript because the browser has no assembler. What it buys
 * is the Neo Geo Pocket and the Neo Geo Pocket Color, whose processor is a
 * TMP95C061 — a TLCS-900/H core running in maximum mode, so the register file
 * this file names is the 32-bit one and the address space is 24 bits.
 *
 * Four things about this architecture reach the emitter above it, and each is a
 * reason a method here looks the way it does.
 *
 *   - **The addressing mode comes before the opcode.** Every other encoder in
 *     this project puts the operation first; here the *first* byte says where
 *     the operand is and the byte after it says what to do with it. So a
 *     `LD XWA,(XHL+4)` is `<operand prefix> <displacement> <opcode>` — the
 *     address arithmetic is spelled before the verb. {@link Mem} is therefore a
 *     value the caller builds, on the V30MZ's mod/reg/rm precedent
 *     (`asm/v30mz.ts`), and one method covers every form the operand can take.
 *   - **A source prefix carries the operand size and a destination prefix does
 *     not.** The hardware spends bits 5–4 of the prefix on "byte source, word
 *     source, long source, destination", so where a memory operand is written
 *     to, the size has to come from the opcode byte instead — which is why
 *     `LD (mem),R` is a destination form while `ADD (mem),R` is a *source* one.
 *     That is the instruction set's arrangement rather than this file's, and
 *     each method encodes the form its own table gives it.
 *   - **A conditional branch reaches ±128 bytes, and a long one ±32768.**
 *     {@link Asm900.jr} is the short form and {@link Asm900.jrl} the long one,
 *     but neither is unlimited — a program is 24-bit addressed, so the form that
 *     always reaches is `jp cc, abs(target)`, which is what a backend's `far`
 *     should reduce to. An out-of-range branch is an {@link AsmError} rather
 *     than a wrap.
 *   - **Only eight registers fit in an opcode.** The 3-bit `R` field names the
 *     current bank's eight registers and nothing else; every other register in
 *     the file — the other banks, the previous bank, the halves of IX/IY/IZ —
 *     needs an 8-bit extension code and a longer encoding. This file exposes the
 *     current bank only, because that is the whole of what a compiled game uses
 *     and an encoder that offered the rest would be one nobody is checking.
 *
 * The design is the same dull one every encoder here has: explicit encodings, a
 * fixup list for forward references, one pass and no relaxation. Where the
 * instruction set offers a shorter encoding of the same operation — an 8-bit
 * absolute address, a displacement that fits in a byte — this file takes it
 * unconditionally, so the choice is a property of the operands rather than of
 * when the assembler saw them.
 *
 * Sources: Toshiba — *TLCS-900 Series User's Manual* (16-bit microcontroller),
 * Appendix A "Details of Instructions" for the per-instruction encodings,
 * Appendix C "Instruction Code Maps" for the four first-byte tables, and the
 * register maps and `mem`/`cc` specify codes in front of Appendix A; Toshiba —
 * *TMP95C061B* datasheet for the /H part the Neo Geo Pocket actually carries.
 * The /H core drops the TLCS-900's minimum mode and keeps its encoding, so the
 * maximum-mode register map is the one that applies.
 */

import { AsmError, label, type LabelRef, type Ref } from "./sm83.js";

export { AsmError, label };
export type { LabelRef, Ref };

/** An operand size. The hardware calls these byte, word and long word. */
export type T9Size = "b" | "w" | "l";

/** An 8-bit register of the current bank, in `R`-field order. */
export type T9R8 = "w" | "a" | "b" | "c" | "d" | "e" | "h" | "l";

/** A 16-bit register of the current bank, in `R`-field order. */
export type T9R16 = "wa" | "bc" | "de" | "hl" | "ix" | "iy" | "iz" | "sp";

/** A 32-bit register of the current bank, in `R`-field order. */
export type T9R32 = "xwa" | "xbc" | "xde" | "xhl" | "xix" | "xiy" | "xiz" | "xsp";

/** Any register this encoder will name. */
export type T9Reg = T9R8 | T9R16 | T9R32;

/**
 * The eight ALU operations, in the order every one of the opcode maps puts them.
 *
 * Register-to-register, register-to-immediate, register-to-memory and
 * memory-to-immediate each get a block of eight consecutive opcodes in this
 * order, so the operation is arithmetic on an opcode rather than a table lookup
 * — which is why this type is an ordered union and not a set of method names.
 */
export type T9AluOp = "add" | "adc" | "sub" | "sbc" | "and" | "xor" | "or" | "cp";

/** The eight shift and rotate operations, in opcode order. */
export type T9ShiftOp = "rlc" | "rrc" | "rl" | "rr" | "sla" | "sra" | "sll" | "srl";

/**
 * A condition code, in the 4-bit `cc` field's own order.
 *
 * Several conditions have two spellings because the hardware gives them two —
 * `z`/`eq` and `c`/`ult` are the same four bits, and both read naturally at a
 * call site depending on whether what preceded them was a comparison or an
 * addition. `t` is the unconditional form, which is what a bare `jr` encodes as.
 */
export type T9CC =
  | "f"
  | "lt"
  | "le"
  | "ule"
  | "ov"
  | "pe"
  | "mi"
  | "z"
  | "eq"
  | "c"
  | "ult"
  | "t"
  | "ge"
  | "gt"
  | "ugt"
  | "nov"
  | "po"
  | "pl"
  | "nz"
  | "ne"
  | "nc"
  | "uge";

/**
 * How a memory operand names its address.
 *
 * The five forms the hardware offers, and no more: a base register with an
 * optional displacement, an absolute address, the two auto-stepping forms, and
 * a base plus a register index. There is no scaling and there is no
 * base-plus-index-plus-displacement.
 */
export type T9MemMode = "base" | "abs" | "predec" | "postinc" | "index";

/**
 * A memory operand.
 *
 * Built by {@link at}, {@link abs}, {@link predec}, {@link postinc} and
 * {@link indexed} rather than written out, because which of the hardware's
 * encodings a form takes is decided from the values — an offset that fits in a
 * byte encodes shorter than one that does not, and this file makes that choice
 * unconditionally so that it is a property of the operand.
 */
export interface Mem {
  readonly mode: T9MemMode;
  readonly base?: T9R32;
  /** A displacement off `base`, or the address itself when the mode is `abs`. */
  readonly disp?: Ref;
  readonly index?: T9R8 | T9R16;
  /** How far `predec`/`postinc` step. The hardware allows 1, 2 and 4. */
  readonly step?: 1 | 2 | 4;
}

/**
 * `(base + disp)` — the form a structure field takes.
 *
 * The displacement is a number rather than a {@link Ref} on purpose: an offset
 * from a register is a distance into a record, always known when the
 * instruction is emitted, and letting a label reach here would mean an
 * encoding whose length depended on a value the assembler has not seen yet.
 */
export function at(base: T9R32, disp = 0): Mem {
  return { mode: "base", base, disp };
}

/**
 * `(address)` — an absolute address anywhere in the 24-bit space.
 *
 * A number takes the shortest of the hardware's three widths, so the internal
 * I/O page below `$100` costs one operand byte. A label takes the full 24 bits,
 * because a forward reference has no value to be short about.
 */
export function abs(address: Ref): Mem {
  return { mode: "abs", disp: address };
}

/** `(-base)` — pre-decrement by `step`, which the hardware limits to 1, 2 or 4. */
export function predec(base: T9R32, step: 1 | 2 | 4 = 1): Mem {
  return { mode: "predec", base, step };
}

/** `(base+)` — post-increment by `step`. */
export function postinc(base: T9R32, step: 1 | 2 | 4 = 1): Mem {
  return { mode: "postinc", base, step };
}

/**
 * `(base + index)` — a register index, which is signed.
 *
 * An 8-bit index register sign-extends and a 16-bit one does too, so this is
 * how a table is walked by a quantity a rule computed rather than by a constant.
 */
export function indexed(base: T9R32, index: T9R8 | T9R16): Mem {
  return { mode: "index", base, index };
}

// --- register and condition tables -------------------------------------------

const R8_CODE: Readonly<Record<T9R8, number>> = {
  w: 0,
  a: 1,
  b: 2,
  c: 3,
  d: 4,
  e: 5,
  h: 6,
  l: 7,
};

const R16_CODE: Readonly<Record<T9R16, number>> = {
  wa: 0,
  bc: 1,
  de: 2,
  hl: 3,
  ix: 4,
  iy: 5,
  iz: 6,
  sp: 7,
};

const R32_CODE: Readonly<Record<T9R32, number>> = {
  xwa: 0,
  xbc: 1,
  xde: 2,
  xhl: 3,
  xix: 4,
  xiy: 5,
  xiz: 6,
  xsp: 7,
};

/**
 * The 8-bit extension codes for the current bank, from the maximum-mode
 * register map.
 *
 * These are addresses in the register file rather than opcode fields, and they
 * are not the `R` codes above in a different order: `A` is `$E0` and `W` is
 * `$E1` because the file is little-endian within a long word, so the byte
 * registers of a pair come out swapped relative to their `R` numbering. Only
 * the forms that genuinely need a register *address* use these — the
 * register-index operand and the `(r32)` displacement form.
 */
const R8_EXT: Readonly<Record<T9R8, number>> = {
  a: 0xe0,
  w: 0xe1,
  c: 0xe4,
  b: 0xe5,
  e: 0xe8,
  d: 0xe9,
  l: 0xec,
  h: 0xed,
};

const R16_EXT: Readonly<Record<T9R16, number>> = {
  wa: 0xe0,
  bc: 0xe4,
  de: 0xe8,
  hl: 0xec,
  ix: 0xf0,
  iy: 0xf4,
  iz: 0xf8,
  sp: 0xfc,
};

const R32_EXT: Readonly<Record<T9R32, number>> = {
  xwa: 0xe0,
  xbc: 0xe4,
  xde: 0xe8,
  xhl: 0xec,
  xix: 0xf0,
  xiy: 0xf4,
  xiz: 0xf8,
  xsp: 0xfc,
};

const CC_CODE: Readonly<Record<T9CC, number>> = {
  f: 0x0,
  lt: 0x1,
  le: 0x2,
  ule: 0x3,
  ov: 0x4,
  pe: 0x4,
  mi: 0x5,
  z: 0x6,
  eq: 0x6,
  c: 0x7,
  ult: 0x7,
  t: 0x8,
  ge: 0x9,
  gt: 0xa,
  ugt: 0xb,
  nov: 0xc,
  po: 0xc,
  pl: 0xd,
  nz: 0xe,
  ne: 0xe,
  nc: 0xf,
  uge: 0xf,
};

/**
 * The condition that is true exactly when `cc` is false.
 *
 * Bit 3 of the field *is* the sense — `z` is `0110` and `nz` is `1110`, `lt` is
 * `0001` and `ge` is `1001`, and "always false" and "always true" are `0000`
 * and `1000` — so inversion is one exclusive-or rather than a table. A backend
 * inverting a condition to jump over a body is the reason this is exported.
 */
export function invert(cc: T9CC): T9CC {
  const inverted = CC_CODE[cc] ^ 0x8;
  const found = (Object.keys(CC_CODE) as T9CC[]).find((name) => CC_CODE[name] === inverted);
  if (found === undefined) throw new AsmError(`no inverse for condition '${cc}'`);
  return found;
}

const ALU_CODE: Readonly<Record<T9AluOp, number>> = {
  add: 0,
  adc: 1,
  sub: 2,
  sbc: 3,
  and: 4,
  xor: 5,
  or: 6,
  cp: 7,
};

const SHIFT_CODE: Readonly<Record<T9ShiftOp, number>> = {
  rlc: 0,
  rrc: 1,
  rl: 2,
  rr: 3,
  sla: 4,
  sra: 5,
  sll: 6,
  srl: 7,
};

/**
 * Which of the four prefix roles a memory operand is playing.
 *
 * Bits 5–4 of every operand prefix, and the reason a store to memory is not
 * simply a load with the operands swapped: three of the four values carry a
 * size and the fourth does not.
 */
const Role = { SrcByte: 0, SrcWord: 1, SrcLong: 2, Dst: 3 } as const;
type Role = (typeof Role)[keyof typeof Role];

const ROLE_OF_SIZE: Readonly<Record<T9Size, Role>> = {
  b: Role.SrcByte,
  w: Role.SrcWord,
  l: Role.SrcLong,
};

function isR8(reg: T9Reg): reg is T9R8 {
  return Object.hasOwn(R8_CODE, reg);
}

function isR16(reg: T9Reg): reg is T9R16 {
  return Object.hasOwn(R16_CODE, reg);
}

function isR32(reg: T9Reg): reg is T9R32 {
  return Object.hasOwn(R32_CODE, reg);
}

/** The operand size a register name implies. */
export function sizeOf(reg: T9Reg): T9Size {
  if (isR8(reg)) return "b";
  if (isR16(reg)) return "w";
  if (isR32(reg)) return "l";
  throw new AsmError(`unknown register '${String(reg)}'`);
}

/** The 3-bit `R` field for a register, whatever its width. */
function regCode(reg: T9Reg): number {
  if (isR8(reg)) return R8_CODE[reg];
  if (isR16(reg)) return R16_CODE[reg];
  if (isR32(reg)) return R32_CODE[reg];
  throw new AsmError(`unknown register '${String(reg)}'`);
}

/** The 8-bit register-file address for a register. */
function regExt(reg: T9Reg): number {
  if (isR8(reg)) return R8_EXT[reg];
  if (isR16(reg)) return R16_EXT[reg];
  if (isR32(reg)) return R32_EXT[reg];
  throw new AsmError(`unknown register '${String(reg)}'`);
}

/** Normalise the two spellings of a label reference. */
function asLabelRef(ref: string | LabelRef): LabelRef {
  return typeof ref === "string" ? { label: ref, addend: 0 } : ref;
}

interface Fixup {
  /** Byte offset of the field to patch. */
  at: number;
  kind: "abs8" | "abs16" | "abs24" | "abs32" | "rel8" | "rel16";
  ref: LabelRef;
  /** Address of the instruction after the operand — for relative branches. */
  next: number;
}

/**
 * A growable code buffer with labels.
 *
 * `origin` is where byte zero lives in the address space, so absolute
 * references resolve without the caller doing base arithmetic. On this console
 * that is the cartridge's own base rather than zero, because the program is
 * mapped high and its own tables are addressed absolutely.
 */
export class Asm900 {
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
    const at_ = this.labels.get(name);
    if (at_ === undefined) throw new AsmError(`undefined label '${name}'`);
    return at_;
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

  /**
   * Emit a little-endian 24-bit value.
   *
   * This is the width a pointer takes on this machine — the address space is
   * 24 bits and a `(#24)` operand is three bytes — so a table of addresses is
   * three bytes an entry rather than four.
   */
  d24(value: Ref): this {
    if (typeof value === "number") return this.db(value, value >> 8, value >> 16);
    this.fixups.push({ at: this.code.length, kind: "abs24", ref: asLabelRef(value), next: 0 });
    return this.db(0, 0, 0);
  }

  /** Emit a little-endian 32-bit value. */
  dd(value: Ref): this {
    if (typeof value === "number") return this.db(value, value >> 8, value >> 16, value >>> 24);
    this.fixups.push({ at: this.code.length, kind: "abs32", ref: asLabelRef(value), next: 0 });
    return this.db(0, 0, 0, 0);
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

  // --- operand helpers -------------------------------------------------------

  private imm(value: Ref, bytes: 1 | 2 | 3 | 4): void {
    if (typeof value === "number") {
      for (let index = 0; index < bytes; index += 1) this.db(value >>> (index * 8));
      return;
    }
    const kind = bytes === 1 ? "abs8" : bytes === 2 ? "abs16" : bytes === 3 ? "abs24" : "abs32";
    this.fixups.push({ at: this.code.length, kind, ref: asLabelRef(value), next: 0 });
    this.ds(bytes);
  }

  /** The immediate width an operand size takes. */
  private immOfSize(value: Ref, size: T9Size): void {
    this.imm(value, size === "b" ? 1 : size === "w" ? 2 : 4);
  }

  private rel(target: Ref, bytes: 1 | 2): void {
    const at_ = this.code.length;
    this.ds(bytes);
    const next = this.pc;
    const limit = bytes === 1 ? 128 : 32768;
    if (typeof target === "number") {
      const delta = target - next;
      if (delta < -limit || delta > limit - 1) {
        throw new AsmError(`relative branch out of range: ${delta}`);
      }
      for (let index = 0; index < bytes; index += 1) {
        this.code[at_ + index] = (delta >> (index * 8)) & 0xff;
      }
      return;
    }
    const kind = bytes === 1 ? "rel8" : "rel16";
    this.fixups.push({ at: at_, kind, ref: asLabelRef(target), next });
  }

  /**
   * Emit a register operand prefix.
   *
   * `$C8`–`$CF`, `$D8`–`$DF` and `$E8`–`$EF` are the eight current-bank
   * registers at each width. The size comes from the register's own name rather
   * than from an argument, which is what stops a caller pairing a byte prefix
   * with a word opcode.
   */
  private regPrefix(reg: T9Reg): void {
    const base = isR8(reg) ? 0xc8 : isR16(reg) ? 0xd8 : 0xe8;
    this.db(base | regCode(reg));
  }

  /**
   * Emit a memory operand prefix and whatever operand bytes it carries.
   *
   * Bit 7 is always set, bit 6 says which of the two groups the form belongs to,
   * bits 5–4 are the role, and the low nibble names the form. The address
   * arithmetic goes out *before* the opcode, which is this architecture's one
   * genuinely unusual habit.
   */
  private memPrefix(operand: Mem, role: Role): void {
    const head = (group: 0 | 1, low: number): void => {
      this.db(0x80 | (group << 6) | (role << 4) | low);
    };
    switch (operand.mode) {
      case "base": {
        const base = operand.base;
        if (base === undefined) throw new AsmError("a based memory operand needs a base register");
        const disp = operand.disp ?? 0;
        if (typeof disp !== "number") {
          throw new AsmError("a displacement off a register must be a number, not a label");
        }
        if (disp === 0) {
          head(0, R32_CODE[base]);
          return;
        }
        if (disp >= -128 && disp <= 127) {
          head(0, 8 | R32_CODE[base]);
          this.db(disp);
          return;
        }
        if (disp < -32768 || disp > 32767) {
          throw new AsmError(`displacement ${disp} does not fit in 16 bits`);
        }
        head(1, 3);
        this.db((R32_EXT[base] & 0xfc) | 0x01);
        this.db(disp, disp >> 8);
        return;
      }
      case "abs": {
        const address = operand.disp;
        if (address === undefined) throw new AsmError("an absolute operand needs an address");
        if (typeof address === "number") {
          if (address >= 0 && address <= 0xff) {
            head(1, 0);
            this.imm(address, 1);
          } else if (address >= 0 && address <= 0xffff) {
            head(1, 1);
            this.imm(address, 2);
          } else {
            head(1, 2);
            this.imm(address, 3);
          }
          return;
        }
        // A forward reference has no value to be short about, so it takes the
        // full 24 bits the address space is wide.
        head(1, 2);
        this.imm(address, 3);
        return;
      }
      case "predec":
      case "postinc": {
        const base = operand.base;
        if (base === undefined)
          throw new AsmError("an auto-stepping operand needs a base register");
        const step = operand.step ?? 1;
        const zz = step === 1 ? 0 : step === 2 ? 1 : 2;
        head(1, operand.mode === "predec" ? 4 : 5);
        this.db((R32_EXT[base] & 0xfc) | zz);
        return;
      }
      case "index": {
        const base = operand.base;
        const index = operand.index;
        if (base === undefined || index === undefined) {
          throw new AsmError("a register-index operand needs a base and an index");
        }
        head(1, 3);
        this.db(isR8(index) ? 0x03 : 0x07);
        this.db(R32_EXT[base]);
        this.db(regExt(index));
        return;
      }
    }
  }

  // --- loads -----------------------------------------------------------------

  /**
   * `ld R, r` — register to register, both of the current bank.
   *
   * The two registers must be the same width: the prefix names the source and
   * carries its size, and the opcode names the destination with no size of its
   * own, so a mismatched pair would encode as a load of the wrong width rather
   * than fail.
   */
  ld(dst: T9Reg, src: T9Reg): this {
    if (sizeOf(dst) !== sizeOf(src)) {
      throw new AsmError(`ld ${dst},${src}: operands are different sizes`);
    }
    this.regPrefix(src);
    return this.db(0x88 | regCode(dst));
  }

  /**
   * `ld R, #` — an immediate into a register.
   *
   * This is the short form, one opcode per register per width, and it is the
   * one instruction on this machine whose immediate is the operand's full
   * width — four bytes for a long, which is what a 16.16 constant costs.
   *
   * Spelled `ldn` rather than `ldi` because `ldi` is a real instruction on this
   * processor and it is the block copy, not this.
   */
  ldn(dst: T9Reg, value: Ref): this {
    const size = sizeOf(dst);
    const base = size === "b" ? 0x20 : size === "w" ? 0x30 : 0x40;
    this.db(base | regCode(dst));
    this.immOfSize(value, size);
    return this;
  }

  /** `ld R, (mem)` — a load from memory. */
  ldm(dst: T9Reg, src: Mem): this {
    this.memPrefix(src, ROLE_OF_SIZE[sizeOf(dst)]);
    return this.db(0x20 | regCode(dst));
  }

  /**
   * `ld (mem), R` — a store.
   *
   * A destination prefix has no size field, so the size is in the opcode here:
   * `$40`, `$50` and `$60` are byte, word and long.
   */
  stm(dst: Mem, src: T9Reg): this {
    const size = sizeOf(src);
    this.memPrefix(dst, Role.Dst);
    const base = size === "b" ? 0x40 : size === "w" ? 0x50 : 0x60;
    return this.db(base | regCode(src));
  }

  /**
   * `ld (mem), #` — an immediate straight into memory, byte or word only.
   *
   * There is no long form, which is why a 16.16 constant reaching memory goes
   * through a register.
   */
  stmi(dst: Mem, size: "b" | "w", value: Ref): this {
    this.memPrefix(dst, Role.Dst);
    this.db(size === "b" ? 0x00 : 0x02);
    this.immOfSize(value, size);
    return this;
  }

  /**
   * `lda R, mem` — the operand's *address* rather than its contents.
   *
   * Which is how a pointer to a record is built without doing the arithmetic:
   * the effective address the prefix describes is written to a register instead
   * of being dereferenced.
   */
  lda(dst: T9R16 | T9R32, src: Mem): this {
    this.memPrefix(src, Role.Dst);
    return this.db((isR32(dst) ? 0x30 : 0x20) | regCode(dst));
  }

  /** `push RR` / `push XRR` — the short forms, for a 16- or 32-bit register. */
  push(reg: T9R16 | T9R32): this {
    return this.db((isR32(reg) ? 0x38 : 0x28) | regCode(reg));
  }

  /** `pop RR` / `pop XRR`. */
  pop(reg: T9R16 | T9R32): this {
    return this.db((isR32(reg) ? 0x58 : 0x48) | regCode(reg));
  }

  /** `push r` — the general form, which is the only one that takes a byte register. */
  pushReg(reg: T9Reg): this {
    this.regPrefix(reg);
    return this.db(0x04);
  }

  /** `pop r` — the general form. */
  popReg(reg: T9Reg): this {
    this.regPrefix(reg);
    return this.db(0x05);
  }

  /** `push (mem)`, byte or word. */
  pushMem(operand: Mem, size: "b" | "w"): this {
    this.memPrefix(operand, ROLE_OF_SIZE[size]);
    return this.db(0x04);
  }

  /** `pop (mem)`, byte or word. */
  popMem(operand: Mem, size: "b" | "w"): this {
    this.memPrefix(operand, Role.Dst);
    return this.db(size === "b" ? 0x04 : 0x06);
  }

  /** `push A` / `pop A` / `push F` / `pop F` — the one-byte accumulator forms. */
  pushA(): this {
    return this.db(0x14);
  }

  popA(): this {
    return this.db(0x15);
  }

  pushF(): this {
    return this.db(0x18);
  }

  popF(): this {
    return this.db(0x19);
  }

  /** `ex R, r` — exchange two registers of the same width. */
  ex(a: T9Reg, b: T9Reg): this {
    if (sizeOf(a) !== sizeOf(b)) throw new AsmError(`ex ${a},${b}: operands are different sizes`);
    this.regPrefix(b);
    return this.db(0xb8 | regCode(a));
  }

  /** `ex (mem), R`. */
  exm(operand: Mem, reg: T9Reg): this {
    this.memPrefix(operand, ROLE_OF_SIZE[sizeOf(reg)]);
    return this.db(0x30 | regCode(reg));
  }

  // --- arithmetic ------------------------------------------------------------

  /** `<op> R, r` — register to register. */
  alu(op: T9AluOp, dst: T9Reg, src: T9Reg): this {
    if (sizeOf(dst) !== sizeOf(src)) {
      throw new AsmError(`${op} ${dst},${src}: operands are different sizes`);
    }
    this.regPrefix(src);
    return this.db(0x80 | (ALU_CODE[op] << 4) | regCode(dst));
  }

  /** `<op> r, #` — an immediate against a register. */
  aluImm(op: T9AluOp, dst: T9Reg, value: Ref): this {
    const size = sizeOf(dst);
    this.regPrefix(dst);
    this.db(0xc8 | ALU_CODE[op]);
    this.immOfSize(value, size);
    return this;
  }

  /** `<op> R, (mem)` — memory as the source. */
  aluMem(op: T9AluOp, dst: T9Reg, src: Mem): this {
    this.memPrefix(src, ROLE_OF_SIZE[sizeOf(dst)]);
    return this.db(0x80 | (ALU_CODE[op] << 4) | regCode(dst));
  }

  /**
   * `<op> (mem), R` — memory as the destination.
   *
   * A *source* prefix, despite the memory operand being written to: the result
   * needs a size and the destination prefix has nowhere to put one. `ld` is the
   * other way round because its opcode carries the size itself.
   */
  aluToMem(op: T9AluOp, dst: Mem, src: T9Reg): this {
    this.memPrefix(dst, ROLE_OF_SIZE[sizeOf(src)]);
    return this.db(0x88 | (ALU_CODE[op] << 4) | regCode(src));
  }

  /** `<op> (mem), #` — an immediate against memory, byte or word. */
  aluMemImm(op: T9AluOp, dst: Mem, size: "b" | "w", value: Ref): this {
    this.memPrefix(dst, ROLE_OF_SIZE[size]);
    this.db(0x38 | ALU_CODE[op]);
    this.immOfSize(value, size);
    return this;
  }

  /**
   * `inc #3, r` — add a small constant, 1 to 8.
   *
   * Eight is encoded as zero, which is the hardware's arrangement and the reason
   * this takes a count rather than being eight methods.
   */
  inc(count: number, reg: T9Reg): this {
    this.regPrefix(reg);
    return this.db(0x60 | encodeSmall(count, "inc"));
  }

  /** `dec #3, r`. */
  dec(count: number, reg: T9Reg): this {
    this.regPrefix(reg);
    return this.db(0x68 | encodeSmall(count, "dec"));
  }

  /** `inc #3, (mem)`, byte or word. */
  incMem(count: number, operand: Mem, size: "b" | "w"): this {
    this.memPrefix(operand, ROLE_OF_SIZE[size]);
    return this.db(0x60 | encodeSmall(count, "inc"));
  }

  /** `dec #3, (mem)`, byte or word. */
  decMem(count: number, operand: Mem, size: "b" | "w"): this {
    this.memPrefix(operand, ROLE_OF_SIZE[size]);
    return this.db(0x68 | encodeSmall(count, "dec"));
  }

  /** `neg r` — two's complement in place. */
  neg(reg: T9Reg): this {
    this.regPrefix(reg);
    return this.db(0x07);
  }

  /** `cpl r` — one's complement. */
  cpl(reg: T9Reg): this {
    this.regPrefix(reg);
    return this.db(0x06);
  }

  /** `extz r` — zero the upper half of a register. */
  extz(reg: T9R16 | T9R32): this {
    this.regPrefix(reg);
    return this.db(0x12);
  }

  /**
   * `exts r` — sign-extend the lower half into the upper.
   *
   * The instruction a 16-bit quantity needs before it can join 32-bit
   * arithmetic, and the one a backend reaches for on every grid index.
   */
  exts(reg: T9R16 | T9R32): this {
    this.regPrefix(reg);
    return this.db(0x13);
  }

  /** `daa r` — decimal adjust. */
  daa(reg: T9R8): this {
    this.regPrefix(reg);
    return this.db(0x10);
  }

  /** `mirr r` — reverse the bit order of a word register. */
  mirr(reg: T9R16): this {
    this.regPrefix(reg);
    return this.db(0x16);
  }

  /**
   * `mul R, r` — an unsigned multiply whose result is twice as wide as its
   * operands.
   *
   * `dst` is a register of twice `src`'s width and its *lower half* is the other
   * factor, so `mul xwa, c` multiplies `WA` by `C` into `XWA`. That is what
   * makes a 16.16 multiply four instructions here rather than a bit loop.
   */
  mul(dst: T9R16 | T9R32, src: T9Reg): this {
    checkWidening(dst, src, "mul");
    this.regPrefix(src);
    return this.db(0x40 | regCode(dst));
  }

  /** `muls R, r` — the signed multiply. */
  muls(dst: T9R16 | T9R32, src: T9Reg): this {
    checkWidening(dst, src, "muls");
    this.regPrefix(src);
    return this.db(0x48 | regCode(dst));
  }

  /**
   * `mul R, (mem)`.
   *
   * The memory operand's size is half the destination's and needs no argument:
   * a widening multiply has only one shape, so asking the caller to restate it
   * would be asking for a way to get it wrong.
   */
  mulMem(dst: T9R16 | T9R32, src: Mem): this {
    this.memPrefix(src, ROLE_OF_SIZE[halfOf(dst)]);
    return this.db(0x40 | regCode(dst));
  }

  /** `muls R, (mem)`. */
  mulsMem(dst: T9R16 | T9R32, src: Mem): this {
    this.memPrefix(src, ROLE_OF_SIZE[halfOf(dst)]);
    return this.db(0x48 | regCode(dst));
  }

  /**
   * `div R, r` — an unsigned divide.
   *
   * The dividend is all of `dst`; the quotient lands in its lower half and the
   * remainder in its upper, so one instruction answers both questions a
   * fixed-point divide asks.
   */
  div(dst: T9R16 | T9R32, src: T9Reg): this {
    checkWidening(dst, src, "div");
    this.regPrefix(src);
    return this.db(0x50 | regCode(dst));
  }

  /** `divs R, r` — the signed divide. */
  divs(dst: T9R16 | T9R32, src: T9Reg): this {
    checkWidening(dst, src, "divs");
    this.regPrefix(src);
    return this.db(0x58 | regCode(dst));
  }

  /** `div R, (mem)`. */
  divMem(dst: T9R16 | T9R32, src: Mem): this {
    this.memPrefix(src, ROLE_OF_SIZE[halfOf(dst)]);
    return this.db(0x50 | regCode(dst));
  }

  /** `divs R, (mem)`. */
  divsMem(dst: T9R16 | T9R32, src: Mem): this {
    this.memPrefix(src, ROLE_OF_SIZE[halfOf(dst)]);
    return this.db(0x58 | regCode(dst));
  }

  /** `mula r` — multiply and accumulate, over a table `XDE` walks. */
  mula(reg: T9R16): this {
    this.regPrefix(reg);
    return this.db(0x19);
  }

  // --- shifts and rotates ----------------------------------------------------

  /**
   * `<op> #4, r` — shift by a constant, 1 to 16.
   *
   * Sixteen is encoded as zero. The count is a whole byte of its own after the
   * opcode rather than a field inside it, which is why a shift by one costs the
   * same three bytes as a shift by sixteen.
   */
  shift(op: T9ShiftOp, count: number, reg: T9Reg): this {
    if (!Number.isInteger(count) || count < 1 || count > 16) {
      throw new AsmError(`${op} count ${count} must be 1..16`);
    }
    this.regPrefix(reg);
    this.db(0xe8 | SHIFT_CODE[op]);
    return this.db(count & 0x0f);
  }

  /** `<op> A, r` — shift by whatever the low nibble of `A` holds. */
  shiftA(op: T9ShiftOp, reg: T9Reg): this {
    this.regPrefix(reg);
    return this.db(0xf8 | SHIFT_CODE[op]);
  }

  /** `<op> (mem)` — shifts memory exactly one place, byte or word. */
  shiftMem(op: T9ShiftOp, operand: Mem, size: "b" | "w"): this {
    this.memPrefix(operand, ROLE_OF_SIZE[size]);
    return this.db(0x78 | SHIFT_CODE[op]);
  }

  // --- bits and flags --------------------------------------------------------

  /** `bit #4, r` — the bit's inverse into the Z flag, so `nz` means it was set. */
  bit(index: number, reg: T9R8 | T9R16): this {
    this.regPrefix(reg);
    this.db(0x33);
    return this.db(index & 0x0f);
  }

  /** `res #4, r` — clear a bit. */
  res(index: number, reg: T9R8 | T9R16): this {
    this.regPrefix(reg);
    this.db(0x30);
    return this.db(index & 0x0f);
  }

  /** `set #4, r` — set a bit. */
  set(index: number, reg: T9R8 | T9R16): this {
    this.regPrefix(reg);
    this.db(0x31);
    return this.db(index & 0x0f);
  }

  /** `chg #4, r` — invert a bit. */
  chg(index: number, reg: T9R8 | T9R16): this {
    this.regPrefix(reg);
    this.db(0x32);
    return this.db(index & 0x0f);
  }

  /** `bit #3, (mem)` — a byte in memory, so the index is 0..7. */
  bitMem(index: number, operand: Mem): this {
    this.memPrefix(operand, Role.Dst);
    return this.db(0xc8 | (index & 7));
  }

  /** `res #3, (mem)`. */
  resMem(index: number, operand: Mem): this {
    this.memPrefix(operand, Role.Dst);
    return this.db(0xb0 | (index & 7));
  }

  /** `set #3, (mem)`. */
  setMem(index: number, operand: Mem): this {
    this.memPrefix(operand, Role.Dst);
    return this.db(0xb8 | (index & 7));
  }

  /** `chg #3, (mem)`. */
  chgMem(index: number, operand: Mem): this {
    this.memPrefix(operand, Role.Dst);
    return this.db(0xc0 | (index & 7));
  }

  /** `tset #3, (mem)` — test a bit into Z, then set it. */
  tsetMem(index: number, operand: Mem): this {
    this.memPrefix(operand, Role.Dst);
    return this.db(0xa8 | (index & 7));
  }

  /** `rcf` — reset the carry. */
  rcf(): this {
    return this.db(0x10);
  }

  /** `scf` — set the carry. */
  scf(): this {
    return this.db(0x11);
  }

  /** `ccf` — complement the carry. */
  ccf(): this {
    return this.db(0x12);
  }

  /** `zcf` — the inverse of the Z flag into the carry. */
  zcf(): this {
    return this.db(0x13);
  }

  /** `ldcf #4, r` — a register's bit into the carry. */
  ldcf(index: number, reg: T9R8 | T9R16): this {
    this.regPrefix(reg);
    this.db(0x23);
    return this.db(index & 0x0f);
  }

  /** `stcf #4, r` — the carry into a register's bit. */
  stcf(index: number, reg: T9R8 | T9R16): this {
    this.regPrefix(reg);
    this.db(0x24);
    return this.db(index & 0x0f);
  }

  // --- control flow ----------------------------------------------------------

  /**
   * `jp #` — an unconditional jump to an absolute address.
   *
   * Two bytes of operand where the target is inside the first 64 KiB and three
   * otherwise; a label takes three, because the cartridge is mapped high enough
   * that every code label needs them.
   */
  jp(target: Ref): this {
    if (typeof target === "number" && target >= 0 && target <= 0xffff) {
      this.db(0x1a);
      this.imm(target, 2);
      return this;
    }
    this.db(0x1b);
    this.imm(target, 3);
    return this;
  }

  /**
   * `jp cc, mem` — the conditional jump, and the only branch with unlimited
   * reach.
   *
   * The address goes out in the operand prefix, ahead of the opcode that says
   * which condition it is taken on, which is this architecture's habit rather
   * than a quirk of this method.
   */
  jpc(cc: T9CC, target: Ref): this {
    this.memPrefix(abs(target), Role.Dst);
    return this.db(0xd0 | CC_CODE[cc]);
  }

  /** `jp cc, (mem)` — a computed jump, through a register or a table. */
  jpm(cc: T9CC, operand: Mem): this {
    this.memPrefix(operand, Role.Dst);
    return this.db(0xd0 | CC_CODE[cc]);
  }

  /**
   * `jr cc, $ + 2 + d8` — the short relative branch.
   *
   * The displacement is measured from the address after the instruction, which
   * is the same convention every other encoder here uses and the same one that
   * is easy to get one byte wrong (`asm/sm83.ts` §`jr`).
   */
  jr(cc: T9CC, target: Ref): this {
    this.db(0x60 | CC_CODE[cc]);
    this.rel(target, 1);
    return this;
  }

  /** `jrl cc, $ + 3 + d16` — the long relative branch. */
  jrl(cc: T9CC, target: Ref): this {
    this.db(0x70 | CC_CODE[cc]);
    this.rel(target, 2);
    return this;
  }

  /** `call #` — an absolute call. */
  call(target: Ref): this {
    if (typeof target === "number" && target >= 0 && target <= 0xffff) {
      this.db(0x1c);
      this.imm(target, 2);
      return this;
    }
    this.db(0x1d);
    this.imm(target, 3);
    return this;
  }

  /** `call cc, mem` — a conditional call. */
  callc(cc: T9CC, target: Ref): this {
    this.memPrefix(abs(target), Role.Dst);
    return this.db(0xe0 | CC_CODE[cc]);
  }

  /** `calr $ + 3 + d16` — a relative call. */
  calr(target: Ref): this {
    this.db(0x1e);
    this.rel(target, 2);
    return this;
  }

  /** `ret`. */
  ret(): this {
    return this.db(0x0e);
  }

  /**
   * `ret cc` — the conditional return.
   *
   * Its first byte is `$B0`, which is otherwise a destination prefix naming
   * `(XWA)`; the operand is never used, and the manual says as much rather than
   * leaving it to be inferred.
   */
  retc(cc: T9CC): this {
    this.db(0xb0);
    return this.db(0xf0 | CC_CODE[cc]);
  }

  /** `retd dd` — return and drop `dd` bytes of arguments. */
  retd(bytes: number): this {
    this.db(0x0f);
    this.imm(bytes, 2);
    return this;
  }

  /** `reti` — return from an interrupt, restoring the status register. */
  reti(): this {
    return this.db(0x07);
  }

  /**
   * `djnz r, $ + 3 + d8` — decrement and branch.
   *
   * A counted loop in one instruction, and the reason a table walk here costs
   * less than on any 8-bit processor in the set.
   */
  djnz(reg: T9R8 | T9R16, target: Ref): this {
    this.regPrefix(reg);
    this.db(0x1c);
    this.rel(target, 1);
    return this;
  }

  /** `scc cc, r` — a condition as a value, without a branch. */
  scc(cc: T9CC, reg: T9R8 | T9R16): this {
    this.regPrefix(reg);
    return this.db(0x70 | CC_CODE[cc]);
  }

  /** `swi n` — a software interrupt. */
  swi(vector: number): this {
    return this.db(0xf8 | (vector & 7));
  }

  /** `nop`. */
  nop(): this {
    return this.db(0x00);
  }

  /** `halt` — stop until an interrupt arrives. */
  halt(): this {
    return this.db(0x05);
  }

  /**
   * `ei n` — enable interrupts of level `n` and above.
   *
   * `di` is this instruction with a level of seven, which is why there is no
   * separate opcode for it and why {@link di} is spelled the way it is.
   */
  ei(level: number): this {
    this.db(0x06);
    return this.db(level & 7);
  }

  /** `di` — mask every maskable interrupt, which is `ei 7`. */
  di(): this {
    return this.ei(7);
  }

  // --- block operations ------------------------------------------------------

  /**
   * `ldi` / `ldir` / `ldd` / `lddr` — a block copy, one element or repeating.
   *
   * `XDE` is the destination, `XHL` the source and `BC` the count, and the
   * operand prefix names the *destination* register — so a byte copy is
   * `ldir(at("xde"), "b")`, which is one instruction for what an upload loop
   * costs everywhere else in this project.
   */
  ldi(dst: Mem, size: "b" | "w"): this {
    this.memPrefix(dst, ROLE_OF_SIZE[size]);
    return this.db(0x10);
  }

  ldir(dst: Mem, size: "b" | "w"): this {
    this.memPrefix(dst, ROLE_OF_SIZE[size]);
    return this.db(0x11);
  }

  ldd(dst: Mem, size: "b" | "w"): this {
    this.memPrefix(dst, ROLE_OF_SIZE[size]);
    return this.db(0x12);
  }

  lddr(dst: Mem, size: "b" | "w"): this {
    this.memPrefix(dst, ROLE_OF_SIZE[size]);
    return this.db(0x13);
  }

  /** `cpi` / `cpir` / `cpd` / `cpdr` — a block search. */
  cpi(src: Mem, size: "b" | "w"): this {
    this.memPrefix(src, ROLE_OF_SIZE[size]);
    return this.db(0x14);
  }

  cpir(src: Mem, size: "b" | "w"): this {
    this.memPrefix(src, ROLE_OF_SIZE[size]);
    return this.db(0x15);
  }

  cpd(src: Mem, size: "b" | "w"): this {
    this.memPrefix(src, ROLE_OF_SIZE[size]);
    return this.db(0x16);
  }

  cpdr(src: Mem, size: "b" | "w"): this {
    this.memPrefix(src, ROLE_OF_SIZE[size]);
    return this.db(0x17);
  }

  // --- assembly --------------------------------------------------------------

  /** Resolve every forward reference and return the finished image. */
  assemble(): Uint8Array {
    for (const fixup of this.fixups) {
      const base = this.labels.get(fixup.ref.label);
      if (base === undefined) throw new AsmError(`undefined label '${fixup.ref.label}'`);
      const value = base + fixup.ref.addend;
      switch (fixup.kind) {
        case "abs8":
          this.code[fixup.at] = value & 0xff;
          break;
        case "abs16":
          this.code[fixup.at] = value & 0xff;
          this.code[fixup.at + 1] = (value >> 8) & 0xff;
          break;
        case "abs24":
          this.code[fixup.at] = value & 0xff;
          this.code[fixup.at + 1] = (value >> 8) & 0xff;
          this.code[fixup.at + 2] = (value >> 16) & 0xff;
          break;
        case "abs32":
          this.code[fixup.at] = value & 0xff;
          this.code[fixup.at + 1] = (value >> 8) & 0xff;
          this.code[fixup.at + 2] = (value >> 16) & 0xff;
          this.code[fixup.at + 3] = (value >>> 24) & 0xff;
          break;
        case "rel8": {
          const delta = value - fixup.next;
          if (delta < -128 || delta > 127) {
            throw new AsmError(
              `relative branch to '${fixup.ref.label}' is ${delta} bytes away; use jrl or jp`,
            );
          }
          this.code[fixup.at] = delta & 0xff;
          break;
        }
        case "rel16": {
          const delta = value - fixup.next;
          if (delta < -32768 || delta > 32767) {
            throw new AsmError(
              `relative branch to '${fixup.ref.label}' is ${delta} bytes away; use jp`,
            );
          }
          this.code[fixup.at] = delta & 0xff;
          this.code[fixup.at + 1] = (delta >> 8) & 0xff;
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

/** A 1..8 count, where eight is spelled zero. */
function encodeSmall(count: number, what: string): number {
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    throw new AsmError(`${what} count ${count} must be 1..8`);
  }
  return count & 7;
}

/** The size a widening operation's other operand takes, given its destination. */
function halfOf(dst: T9R16 | T9R32): T9Size {
  return isR32(dst) ? "w" : "b";
}

/** A widening operation's destination must be twice its source. */
function checkWidening(dst: T9Reg, src: T9Reg, what: string): void {
  const wanted = sizeOf(src) === "b" ? "w" : "l";
  if (sizeOf(src) === "l") throw new AsmError(`${what}: a long source has no wider destination`);
  if (sizeOf(dst) !== wanted) {
    throw new AsmError(`${what} ${dst},${src}: destination must be twice the source's width`);
  }
}
