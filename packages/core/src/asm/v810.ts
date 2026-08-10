/**
 * A NEC V810 assembler.
 *
 * The eleventh of `core`'s encoders, and it exists for the reason all of them do
 * (`asm/sm83.ts`, doc 14 §Runtime model): a game compiles to machine code, and
 * the encoder is TypeScript because the browser has no assembler. What it buys
 * is the Virtual Boy, whose processor is a µPD70732 — a V810 at 20 MHz with
 * thirty-two 32-bit registers over a 32-bit address space.
 *
 * This is the first *RISC* in the set, and three of its properties reach the
 * emitter above it rather than merely changing how an instruction is spelled.
 *
 *   - **Every operand is a register, and there are thirty-two of them.** There
 *     is no accumulator, no index register and no register pair: a 16.16 value
 *     is one register, `add`/`sub`/`cmp`/`shl`/`sar` each do in one instruction
 *     what the Z80 needs four for, and the hardware has `mul` and `div` — so
 *     this console pulls in *no* arithmetic helper at all, which nothing else
 *     here can say. {@link V810Reg} is a number rather than a name because the
 *     register file is flat and a backend allocates out of it.
 *   - **An instruction is two bytes or four, and which it is depends on the
 *     operand.** A constant in −16…15 is a whole instruction by itself; anything
 *     wider is two halfwords, and a full 32-bit constant is *two instructions*
 *     ({@link Asm810.movImm32}) because a 32-bit immediate cannot fit in a
 *     32-bit instruction. That is the ARM's literal-pool problem with a
 *     different answer: the V810 has `movhi`, so the constant is built rather
 *     than fetched and there is no pool to place.
 *   - **`movea` sign-extends its immediate and `movhi` does not.** So the high
 *     half of a built constant carries a correction — `hi + (lo >> 15 & 1)` —
 *     and an emitter that dropped it produces a program whose every address
 *     above `$xxxx8000` is 64 KiB low. It is applied in one place here rather
 *     than at each call site.
 *
 * Two hazards it makes loud rather than silent:
 *
 *   - **A conditional branch reaches ±256 bytes**, which is less than any other
 *     32-bit machine in the set and about a fifth of a rule body. An
 *     out-of-range displacement is an {@link AsmError} rather than a wrap, and a
 *     backend's `far` inverts the condition over a {@link Asm810.jr}, which
 *     reaches ±32 MiB and therefore always reaches on this console.
 *   - **A displacement is a byte count and its low bit is dropped by the
 *     hardware**, so a branch to an odd address is refused here rather than
 *     silently landing on the halfword below it.
 *
 * The floating-point page and the bit-string instructions are absent rather than
 * half-implemented: nothing a demade cartridge does reaches either, and an
 * encoder for hardware nobody drives is one nobody is checking.
 *
 * Sources: NEC — *V810 Family 32-bit Microprocessor User's Manual* (U10082EJ,
 * §3 register set and §5 instruction formats/encodings); the Virtual Boy
 * *Sacred Tech Scroll* (`vbtech`) instruction appendix, which lists the same
 * opcode map with the Virtual Boy's own mnemonics; Planet Virtual Boy —
 * *V810 instruction set* reference for the condition-code table.
 */

import { AsmError, label, type LabelRef, type Ref } from "./sm83.js";

export { AsmError, label };
export type { LabelRef, Ref };

/**
 * A general-purpose register, `r0`–`r31`.
 *
 * A plain number, because the file is flat and a backend allocates out of it —
 * `mov(temp, temp + 1)` is a thing an emitter wants to write and a union of
 * thirty-two string literals is not. Register 0 always reads as zero and
 * discards what is written to it, which is what makes `mov r0, rd` the way to
 * zero a register and `cmp` against it the way to test one.
 */
export type V810Reg = number;

/** `r0` — hardwired zero. */
export const R0 = 0;
/** `r1` — the assembler's own scratch by convention; this file never uses it. */
export const R1 = 1;
/** `r2` — the handler stack pointer by convention. */
export const HP = 2;
/** `r3` — the stack pointer. */
export const SP = 3;
/** `r4` — the global pointer. */
export const GP = 4;
/** `r5` — the text pointer. */
export const TP = 5;
/** `r30` — the base a short-form load is taken from by convention. */
export const EP = 30;
/** `r31` — where {@link Asm810.jal} leaves the return address. */
export const LP = 31;

/**
 * A system register, by the number `ldsr`/`stsr` name it with.
 *
 * Only the ones a cartridge has any reason to touch are named. `PSW` is the one
 * that matters to a runtime: its interrupt-disable bit is what {@link
 * Asm810.sei} and {@link Asm810.cli} move, and its exception-pending bit is what
 * a handler clears on the way out.
 */
export const SR_EIPC = 0;
export const SR_EIPSW = 1;
export const SR_FEPC = 2;
export const SR_FEPSW = 3;
export const SR_ECR = 4;
export const SR_PSW = 5;
export const SR_PIR = 6;
export const SR_TKCW = 7;
/** Cache control — writing it is how a program enables the instruction cache. */
export const SR_CHCW = 24;
export const SR_ADTRE = 25;

/**
 * A branch condition, named by the four bits that encode it.
 *
 * The hardware gives several of these two spellings because the same four bits
 * read differently after a comparison than after an addition — `e`/`z` and
 * `c`/`l` are one condition each. Both are listed, because which one a call site
 * wants depends on what it just computed. `nop` is the never-taken encoding and
 * `r` the always-taken one; {@link Asm810.br} is the second of those spelled out.
 */
export type V810Cond =
  | "v"
  | "c"
  | "l"
  | "e"
  | "z"
  | "nh"
  | "n"
  | "r"
  | "lt"
  | "le"
  | "nv"
  | "nc"
  | "nl"
  | "ne"
  | "nz"
  | "h"
  | "p"
  | "nop"
  | "ge"
  | "gt";

const COND_CODE: Readonly<Record<V810Cond, number>> = {
  v: 0x0,
  c: 0x1,
  l: 0x1,
  e: 0x2,
  z: 0x2,
  nh: 0x3,
  n: 0x4,
  r: 0x5,
  lt: 0x6,
  le: 0x7,
  nv: 0x8,
  nc: 0x9,
  nl: 0x9,
  ne: 0xa,
  nz: 0xa,
  h: 0xb,
  p: 0xc,
  nop: 0xd,
  ge: 0xe,
  gt: 0xf,
};

/** The condition a branch tests when the one given is false. */
const INVERSE: Readonly<Record<V810Cond, V810Cond>> = {
  v: "nv",
  c: "nc",
  l: "nl",
  e: "ne",
  z: "nz",
  nh: "h",
  n: "p",
  r: "nop",
  lt: "ge",
  le: "gt",
  nv: "v",
  nc: "c",
  nl: "l",
  ne: "e",
  nz: "z",
  h: "nh",
  p: "n",
  nop: "r",
  ge: "lt",
  gt: "le",
};

/** The condition that is true exactly when `cond` is false. */
export function invertCond(cond: V810Cond): V810Cond {
  return INVERSE[cond];
}

/** Normalise the three spellings of a label reference. */
function asLabelRef(ref: string | LabelRef): LabelRef {
  return typeof ref === "string" ? { label: ref, addend: 0 } : ref;
}

interface Fixup {
  /** Byte offset of the halfword to patch. */
  at: number;
  kind: "disp9" | "disp26" | "imm16lo" | "imm16hi" | "abs32";
  ref: LabelRef;
  /** Address of the instruction the displacement is measured from. */
  base: number;
}

function checkReg(reg: V810Reg, what: string): number {
  if (!Number.isInteger(reg) || reg < 0 || reg > 31) {
    throw new AsmError(`${what} must be r0-r31, got ${reg}`);
  }
  return reg;
}

function checkImm5(value: number): number {
  if (value < -16 || value > 15) throw new AsmError(`imm5 out of range: ${value}`);
  return value & 0x1f;
}

function checkUimm5(value: number, what: string): number {
  if (value < 0 || value > 31) throw new AsmError(`${what} out of range: ${value}`);
  return value & 0x1f;
}

function checkDisp16(value: number, what: string): number {
  if (value < -0x8000 || value > 0xffff) throw new AsmError(`${what} out of range: ${value}`);
  return value & 0xffff;
}

/**
 * A growable code buffer with labels, for the V810.
 *
 * `origin` is where byte zero lives in the address space. On this console that
 * is not a formality: a cartridge is mapped at `$07000000` *and* mirrored into
 * the top of the address space, where the reset vector is — so a program is
 * assembled at the mirror it will actually run from and every absolute reference
 * resolves without the caller doing base arithmetic.
 */
export class Asm810 {
  private code: number[] = [];
  private readonly labels = new Map<string, number>();
  private readonly fixups: Fixup[] = [];

  constructor(readonly origin = 0) {
    if ((origin & 1) !== 0) throw new AsmError("origin must be halfword-aligned");
  }

  /** Bytes emitted so far. */
  get length(): number {
    return this.code.length;
  }

  /** The address the next byte will occupy. */
  get pc(): number {
    return (this.origin + this.code.length) >>> 0;
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
    this.labels.set(name, address >>> 0);
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

  /** Emit a little-endian halfword. */
  dw(value: number): this {
    return this.db(value, value >> 8);
  }

  /** Emit a little-endian 32-bit value, resolving a label if given. */
  dd(value: Ref): this {
    if (typeof value === "number") {
      return this.db(value, value >> 8, value >> 16, value >> 24);
    }
    this.fixups.push({ at: this.code.length, kind: "abs32", ref: asLabelRef(value), base: 0 });
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

  /**
   * Pad to the next halfword, and then to the next word.
   *
   * Every instruction is a whole number of halfwords, so the stream is aligned
   * by construction; what is not is a run of `db`. Data this machine reads with
   * `ld.w` has to be word-aligned or the hardware drops the low two bits of the
   * address, which reads the wrong four bytes rather than faulting.
   */
  align(bytes: 2 | 4 = 4): this {
    while (this.code.length % bytes !== 0) this.db(0);
    return this;
  }

  /** Pad with `fill` until the next byte lands on `address`. */
  padTo(address: number, fill = 0): this {
    if (this.pc > address >>> 0) {
      throw new AsmError(
        `cannot pad to $${(address >>> 0).toString(16)}: already at $${this.pc.toString(16)}`,
      );
    }
    return this.ds((address >>> 0) - this.pc, fill);
  }

  // --- the six instruction formats -------------------------------------------

  /** Format I: `op reg1, reg2` — both operands registers, one halfword. */
  private formatI(op: number, reg1: V810Reg, reg2: V810Reg): this {
    return this.dw((op << 10) | (checkReg(reg2, "reg2") << 5) | checkReg(reg1, "reg1"));
  }

  /** Format II: `op imm5, reg2` — a five-bit field and a register. */
  private formatII(op: number, imm5: number, reg2: V810Reg): this {
    return this.dw((op << 10) | (checkReg(reg2, "reg2") << 5) | (imm5 & 0x1f));
  }

  /** Format V: `op imm16, reg1, reg2` — two registers and a 16-bit immediate. */
  private formatV(op: number, imm16: number, reg1: V810Reg, reg2: V810Reg): this {
    this.dw((op << 10) | (checkReg(reg2, "reg2") << 5) | checkReg(reg1, "reg1"));
    return this.dw(imm16 & 0xffff);
  }

  /** Format VI: `op disp16[reg1], reg2` — the load/store shape. */
  private formatVI(op: number, disp: number, reg1: V810Reg, reg2: V810Reg): this {
    this.dw((op << 10) | (checkReg(reg2, "reg2") << 5) | checkReg(reg1, "reg1"));
    return this.dw(checkDisp16(disp, "displacement"));
  }

  // --- register-to-register (format I) ---------------------------------------

  /** `mov reg1, reg2` — reg2 ← reg1. */
  mov(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x00, src, dst);
  }
  /** `add reg1, reg2` — reg2 ← reg2 + reg1. */
  add(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x01, src, dst);
  }
  /** `sub reg1, reg2` — reg2 ← reg2 − reg1. */
  sub(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x02, src, dst);
  }
  /** `cmp reg1, reg2` — flags from reg2 − reg1, with reg2 unchanged. */
  cmp(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x03, src, dst);
  }
  /** `shl reg1, reg2` — logical left by the low five bits of reg1. */
  shl(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x04, src, dst);
  }
  /** `shr reg1, reg2` — logical right. */
  shr(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x05, src, dst);
  }
  /** `jmp [reg1]` — the indirect jump, and how a subroutine returns (`jmp [lp]`). */
  jmp(reg: V810Reg): this {
    return this.formatI(0x06, reg, R0);
  }
  /** `sar reg1, reg2` — arithmetic right. */
  sar(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x07, src, dst);
  }
  /**
   * `mul reg1, reg2` — signed 32×32, the low half into reg2 and the high half
   * into r30.
   *
   * That second destination is the whole reason a 16.16 multiply is three
   * instructions on this console: the 64-bit product a fixed-point multiply
   * needs is *already there*, so the normalising shift is a `shr`/`shl` pair
   * over two registers rather than a routine.
   */
  mul(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x08, src, dst);
  }
  /** `div reg1, reg2` — signed; quotient into reg2, remainder into r30. */
  div(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x09, src, dst);
  }
  /** `mulu reg1, reg2` — unsigned multiply, high half into r30. */
  mulu(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x0a, src, dst);
  }
  /** `divu reg1, reg2` — unsigned divide, remainder into r30. */
  divu(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x0b, src, dst);
  }
  /** `or reg1, reg2`. */
  or(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x0c, src, dst);
  }
  /** `and reg1, reg2`. */
  and(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x0d, src, dst);
  }
  /** `xor reg1, reg2`. */
  xor(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x0e, src, dst);
  }
  /** `not reg1, reg2` — reg2 ← ~reg1. */
  not(src: V810Reg, dst: V810Reg): this {
    return this.formatI(0x0f, src, dst);
  }

  // --- immediate forms (format II) -------------------------------------------

  /** `mov imm5, reg2` — a sign-extended five-bit constant. */
  movImm5(value: number, dst: V810Reg): this {
    return this.formatII(0x10, checkImm5(value), dst);
  }
  /** `add imm5, reg2`. */
  addImm5(value: number, dst: V810Reg): this {
    return this.formatII(0x11, checkImm5(value), dst);
  }
  /** `setf cond, reg2` — reg2 ← 1 when the condition holds, 0 when it does not. */
  setf(cond: V810Cond, dst: V810Reg): this {
    return this.formatII(0x12, COND_CODE[cond], dst);
  }
  /** `cmp imm5, reg2`. */
  cmpImm5(value: number, dst: V810Reg): this {
    return this.formatII(0x13, checkImm5(value), dst);
  }
  /** `shl imm5, reg2` — the count is unsigned, 0–31. */
  shlImm5(count: number, dst: V810Reg): this {
    return this.formatII(0x14, checkUimm5(count, "shift count"), dst);
  }
  /** `shr imm5, reg2`. */
  shrImm5(count: number, dst: V810Reg): this {
    return this.formatII(0x15, checkUimm5(count, "shift count"), dst);
  }
  /** `sar imm5, reg2`. */
  sarImm5(count: number, dst: V810Reg): this {
    return this.formatII(0x17, checkUimm5(count, "shift count"), dst);
  }
  /** `trap imm5`. */
  trap(vector: number): this {
    return this.formatII(0x18, checkUimm5(vector, "trap vector"), R0);
  }
  /** `reti` — return from an interrupt or exception. */
  reti(): this {
    return this.formatII(0x19, 0, R0);
  }
  /** `halt`. */
  halt(): this {
    return this.formatII(0x1a, 0, R0);
  }
  /** `ldsr reg2, sysreg` — move a general register into a system one. */
  ldsr(src: V810Reg, sysreg: number): this {
    return this.formatII(0x1c, checkUimm5(sysreg, "system register"), src);
  }
  /** `stsr sysreg, reg2` — and back. */
  stsr(sysreg: number, dst: V810Reg): this {
    return this.formatII(0x1d, checkUimm5(sysreg, "system register"), dst);
  }
  /** `sei` — mask interrupts. */
  sei(): this {
    return this.formatII(0x1e, 0, R0);
  }
  /** `cli` — unmask them. */
  cli(): this {
    return this.formatII(0x16, 0, R0);
  }

  // --- 16-bit immediate forms (format V) -------------------------------------

  /**
   * `movea imm16, reg1, reg2` — reg2 ← reg1 + sign-extend(imm16).
   *
   * The sign extension is what {@link movImm32} corrects for, and it is also
   * what makes this the cheap way to add a signed constant that does not fit in
   * five bits.
   */
  movea(imm16: number, src: V810Reg, dst: V810Reg): this {
    return this.formatV(0x28, checkDisp16(imm16, "imm16"), src, dst);
  }
  /** `add imm16, reg1, reg2` — the flag-setting counterpart of `movea`. */
  addi(imm16: number, src: V810Reg, dst: V810Reg): this {
    return this.formatV(0x29, checkDisp16(imm16, "imm16"), src, dst);
  }
  /** `ori imm16, reg1, reg2` — zero-extended. */
  ori(imm16: number, src: V810Reg, dst: V810Reg): this {
    return this.formatV(0x2c, imm16 & 0xffff, src, dst);
  }
  /** `andi imm16, reg1, reg2` — zero-extended. */
  andi(imm16: number, src: V810Reg, dst: V810Reg): this {
    return this.formatV(0x2d, imm16 & 0xffff, src, dst);
  }
  /** `xori imm16, reg1, reg2` — zero-extended. */
  xori(imm16: number, src: V810Reg, dst: V810Reg): this {
    return this.formatV(0x2e, imm16 & 0xffff, src, dst);
  }
  /** `movhi imm16, reg1, reg2` — reg2 ← reg1 + (imm16 << 16). */
  movhi(imm16: number, src: V810Reg, dst: V810Reg): this {
    return this.formatV(0x2f, imm16 & 0xffff, src, dst);
  }

  // --- loads and stores (format VI) ------------------------------------------

  /** `ld.b disp16[reg1], reg2` — sign-extended into the whole register. */
  ldb(disp: number, base: V810Reg, dst: V810Reg): this {
    return this.formatVI(0x30, disp, base, dst);
  }
  /** `ld.h disp16[reg1], reg2` — sign-extended; the low address bit is ignored. */
  ldh(disp: number, base: V810Reg, dst: V810Reg): this {
    return this.formatVI(0x31, disp, base, dst);
  }
  /** `ld.w disp16[reg1], reg2`. */
  ldw(disp: number, base: V810Reg, dst: V810Reg): this {
    return this.formatVI(0x33, disp, base, dst);
  }
  /** `st.b reg2, disp16[reg1]`. */
  stb(src: V810Reg, disp: number, base: V810Reg): this {
    return this.formatVI(0x34, disp, base, src);
  }
  /** `st.h reg2, disp16[reg1]`. */
  sth(src: V810Reg, disp: number, base: V810Reg): this {
    return this.formatVI(0x35, disp, base, src);
  }
  /** `st.w reg2, disp16[reg1]`. */
  stw(src: V810Reg, disp: number, base: V810Reg): this {
    return this.formatVI(0x37, disp, base, src);
  }
  /**
   * `in.b disp16[reg1], reg2` — a *zero*-extended load, which is the only thing
   * separating it from `ld.b`.
   *
   * The V810 has no separate I/O space; these opcodes exist because a peripheral
   * byte is a number rather than a signed quantity, and reading one with `ld.b`
   * turns everything above `$7F` negative.
   */
  inb(disp: number, base: V810Reg, dst: V810Reg): this {
    return this.formatVI(0x38, disp, base, dst);
  }
  /** `in.h disp16[reg1], reg2` — zero-extended. */
  inh(disp: number, base: V810Reg, dst: V810Reg): this {
    return this.formatVI(0x39, disp, base, dst);
  }
  /** `in.w disp16[reg1], reg2` — identical to `ld.w`; there is nothing to extend. */
  inw(disp: number, base: V810Reg, dst: V810Reg): this {
    return this.formatVI(0x3b, disp, base, dst);
  }
  /** `out.b reg2, disp16[reg1]` — identical to `st.b`. */
  outb(src: V810Reg, disp: number, base: V810Reg): this {
    return this.formatVI(0x3c, disp, base, src);
  }
  /** `out.h reg2, disp16[reg1]`. */
  outh(src: V810Reg, disp: number, base: V810Reg): this {
    return this.formatVI(0x3d, disp, base, src);
  }
  /** `out.w reg2, disp16[reg1]`. */
  outw(src: V810Reg, disp: number, base: V810Reg): this {
    return this.formatVI(0x3f, disp, base, src);
  }

  // --- branches --------------------------------------------------------------

  /**
   * `Bcond disp9` — a conditional branch, reaching ±256 bytes.
   *
   * The displacement is measured from the branch's *own* address, not from the
   * instruction after it, and its low bit is dropped by the hardware — so an odd
   * target is refused here rather than landing one halfword low.
   */
  bcond(cond: V810Cond, target: Ref): this {
    const at = this.code.length;
    const base = this.pc;
    this.dw(0x8000 | (COND_CODE[cond] << 9));
    if (typeof target === "number") this.patchDisp9(at, target >>> 0, base);
    else this.fixups.push({ at, kind: "disp9", ref: asLabelRef(target), base });
    return this;
  }

  /** `br disp9` — the always-taken conditional branch. */
  br(target: Ref): this {
    return this.bcond("r", target);
  }

  /** `nop` — the never-taken branch, which is what this machine spells it as. */
  nop(): this {
    return this.dw(0x8000 | (COND_CODE.nop << 9));
  }

  /**
   * `jr disp26` — an unconditional relative jump reaching ±32 MiB.
   *
   * A cartridge is at most 16 MiB, so this always reaches within a program: it
   * is what a backend's long jump reduces to, and there is no absolute jump
   * instruction to fall back on.
   */
  jr(target: Ref): this {
    return this.formatIV(0x2a, target);
  }

  /** `jal disp26` — the same reach, leaving the return address in `lp`. */
  jal(target: Ref): this {
    return this.formatIV(0x2b, target);
  }

  private formatIV(op: number, target: Ref): this {
    const at = this.code.length;
    const base = this.pc;
    this.dw(op << 10);
    this.dw(0);
    if (typeof target === "number") this.patchDisp26(at, target >>> 0, base);
    else this.fixups.push({ at, kind: "disp26", ref: asLabelRef(target), base });
    return this;
  }

  // --- pseudo-instructions ---------------------------------------------------

  /**
   * Load a 32-bit constant into a register, in as few instructions as it takes.
   *
   * One instruction for a constant in −16…15, one for anything that fits
   * `movea`'s sign-extended sixteen bits, and two otherwise — where the high
   * half carries the correction `movea`'s sign extension will apply. A label is
   * always the two-instruction form, because its address is not known when the
   * instruction's length is fixed.
   */
  movImm32(value: Ref, dst: V810Reg): this {
    if (typeof value !== "number") {
      const ref = asLabelRef(value);
      this.fixups.push({ at: this.code.length + 2, kind: "imm16hi", ref, base: 0 });
      this.movhi(0, R0, dst);
      this.fixups.push({ at: this.code.length + 2, kind: "imm16lo", ref, base: 0 });
      return this.movea(0, dst, dst);
    }
    const word = value | 0;
    if (word >= -16 && word <= 15) return this.movImm5(word, dst);
    if (word >= -0x8000 && word <= 0x7fff) return this.movea(word, R0, dst);
    this.movhi(highHalf(word), R0, dst);
    return this.movea(word & 0xffff, dst, dst);
  }

  /**
   * Add a 32-bit constant to a register, in as few instructions as it takes.
   *
   * `addi` sign-extends like `movea`, so anything wider than sixteen bits needs
   * the same correction — and `movhi` adds rather than replaces, which is what
   * lets the pair be written against the destination itself.
   */
  addImm32(value: number, dst: V810Reg): this {
    const word = value | 0;
    if (word === 0) return this;
    if (word >= -16 && word <= 15) return this.addImm5(word, dst);
    if (word >= -0x8000 && word <= 0x7fff) return this.movea(word, dst, dst);
    this.movhi(highHalf(word), dst, dst);
    return this.movea(word & 0xffff, dst, dst);
  }

  /** `mov reg1, reg2`, omitted when the two are the same register. */
  movReg(src: V810Reg, dst: V810Reg): this {
    return src === dst ? this : this.mov(src, dst);
  }

  /** `jmp [lp]` — a return. */
  ret(): this {
    return this.jmp(LP);
  }

  // --- finishing -------------------------------------------------------------

  private patchDisp9(at: number, target: number, base: number): void {
    const delta = (target | 0) - (base | 0);
    if ((target & 1) !== 0) throw new AsmError(`branch target $${target.toString(16)} is odd`);
    if (delta < -0x100 || delta > 0xfe) {
      throw new AsmError(`conditional branch is ${delta} bytes away; use jr`);
    }
    const word = ((this.code[at] as number) | ((this.code[at + 1] as number) << 8)) & 0xfe00;
    const patched = word | (delta & 0x1ff);
    this.code[at] = patched & 0xff;
    this.code[at + 1] = (patched >> 8) & 0xff;
  }

  private patchDisp26(at: number, target: number, base: number): void {
    const delta = (target | 0) - (base | 0);
    if ((target & 1) !== 0) throw new AsmError(`jump target $${target.toString(16)} is odd`);
    if (delta < -0x2000000 || delta > 0x1fffffe) {
      throw new AsmError(`jump is ${delta} bytes away; out of a V810's reach`);
    }
    const word = ((this.code[at] as number) | ((this.code[at + 1] as number) << 8)) & 0xfc00;
    const high = word | ((delta >> 16) & 0x3ff);
    this.code[at] = high & 0xff;
    this.code[at + 1] = (high >> 8) & 0xff;
    this.code[at + 2] = delta & 0xff;
    this.code[at + 3] = (delta >> 8) & 0xff;
  }

  /** Resolve every reference and return the assembled bytes. */
  assemble(): Uint8Array {
    for (const fixup of this.fixups) {
      const base = this.labels.get(fixup.ref.label);
      if (base === undefined) throw new AsmError(`undefined label '${fixup.ref.label}'`);
      const value = (base + fixup.ref.addend) >>> 0;
      switch (fixup.kind) {
        case "disp9":
          this.patchDisp9(fixup.at, value, fixup.base);
          break;
        case "disp26":
          this.patchDisp26(fixup.at, value, fixup.base);
          break;
        case "imm16lo":
          this.code[fixup.at] = value & 0xff;
          this.code[fixup.at + 1] = (value >>> 8) & 0xff;
          break;
        case "imm16hi": {
          const high = highHalf(value | 0);
          this.code[fixup.at] = high & 0xff;
          this.code[fixup.at + 1] = (high >>> 8) & 0xff;
          break;
        }
        case "abs32":
          this.code[fixup.at] = value & 0xff;
          this.code[fixup.at + 1] = (value >>> 8) & 0xff;
          this.code[fixup.at + 2] = (value >>> 16) & 0xff;
          this.code[fixup.at + 3] = (value >>> 24) & 0xff;
          break;
      }
    }
    return Uint8Array.from(this.code);
  }

  /** Every label and its address — the map a profiler or a harness reads. */
  symbols(): ReadonlyMap<string, number> {
    return new Map(this.labels);
  }
}

/**
 * The high half of a 32-bit constant, corrected for the sign extension the
 * `movea` that follows it will apply.
 *
 * One definition with three readers — {@link Asm810.movImm32}, {@link
 * Asm810.addImm32} and the label fixup — because a second copy of this
 * correction is a program whose addresses are right until one of them crosses
 * `$xxxx8000`.
 */
export function highHalf(value: number): number {
  return ((value >>> 16) + ((value >>> 15) & 1)) & 0xffff;
}

/**
 * The conventional registers again, under names that survive a re-export.
 *
 * `SP` is the SPC700's and `R0`–`R1` are the ARM's, so `core`'s public surface
 * cannot carry a second set under those names — the same collision `arm.ts`
 * resolves the same way. A backend for this console names its own registers for
 * what they hold anyway (`codegen/vb/regs.ts`); these are for the two callers
 * inside `core` that want the hardware's own convention.
 */
export const V810_R0 = R0;
export const V810_R1 = R1;
export const V810_HP = HP;
export const V810_SP = SP;
export const V810_GP = GP;
export const V810_TP = TP;
export const V810_EP = EP;
export const V810_LP = LP;
