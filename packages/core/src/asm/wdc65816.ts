/**
 * A WDC 65816 assembler.
 *
 * The counterpart of {@link Asm}, {@link Asm6502} and {@link AsmZ80} for the
 * Super Nintendo, and it exists for the same two reasons those do (`asm/sm83.ts`,
 * doc 14 §Runtime model): machine code because the machine is small, and in
 * TypeScript because the browser has no assembler and doc 07 wants the page to
 * build the cartridge the CLI builds, byte for byte, with nothing installed.
 *
 * The design is the 6502 assembler's — one operand carries its mode, one table
 * decides whether a mnemonic has that form, a fixup list for forward references,
 * no macro or peephole layer — because the 65816 *is* that CPU with three things
 * added, and each of them is a hazard this file makes loud rather than silent:
 *
 *   - **An immediate's width is not in the opcode.** `lda #$1234` and `lda #$12`
 *     are the same byte; which one the CPU fetches depends on the M flag at the
 *     moment it runs. An assembler cannot infer that — a `rep`/`sep` behind a
 *     branch is enough to make it unknowable — so the width is the caller's:
 *     {@link imm8} and {@link imm16} are different operands, and a backend that
 *     changes mode says which one it means. Getting this wrong does not produce a
 *     wrong value, it produces a **wrong instruction stream**, because the extra
 *     operand byte is executed as an opcode.
 *   - **A bank is not an address.** `abs` is sixteen bits resolved against the
 *     data bank (or the program bank, for a jump), and `long` is twenty-four with
 *     the bank in the instruction. Since a Demotic cartridge keeps its code and
 *     its work RAM in bank zero, almost everything here is `abs` — but the tile
 *     bank lives in bank one and is reached by DMA, which takes its bank as data.
 *   - **Branches still reach ±128 bytes, and `brl` exists.** `bra`/`brl` are the
 *     unconditional pair; the conditional eight are the 6502's, so a backend
 *     inverts and jumps exactly as the NES one does.
 *
 * Sources: WDC W65C816S datasheet (opcode matrix and addressing modes) and the
 * SNESdev Wiki's 65816 reference (https://snes.nesdev.org/wiki/65816_reference).
 */

import { AsmError, label, type LabelRef, type Ref } from "./sm83.js";

export { AsmError, label };
export type { LabelRef, Ref };

/** An addressing mode, as the operand constructors produce it. */
export type Mode65816 =
  | "imp"
  | "acc"
  /** `#$nn` — one operand byte, valid when the relevant width flag is set. */
  | "imm8"
  /** `#$nnnn` — two operand bytes, valid when the relevant width flag is clear. */
  | "imm16"
  | "dp"
  | "dpX"
  | "dpY"
  | "dpInd"
  | "dpIndX"
  | "dpIndY"
  | "dpIndLong"
  | "dpIndLongY"
  | "abs"
  | "absX"
  | "absY"
  | "absInd"
  | "absIndX"
  | "absIndLong"
  | "long"
  | "longX"
  | "sr"
  | "srY"
  | "rel"
  | "rel16"
  | "block";

/**
 * An immediate operand's value.
 *
 * A number, a label (for a sixteen-bit immediate holding an address), or one
 * *part* of a label — because a program that has to build a 24-bit pointer out of
 * eight-bit pieces needs the low, high and bank bytes expressible before the
 * label exists.
 */
export type Imm65816 = Ref | { readonly part: "low" | "high" | "bank"; readonly ref: Ref };

/** An operand: a mode and the value it addresses. */
export interface Operand65816 {
  readonly mode: Mode65816;
  readonly value: Ref | Imm65816;
  /** Only for {@link block}: the second bank byte. */
  readonly second?: number;
}

/** `#$nn` — an eight-bit immediate. Only valid while the width flag is set. */
export function imm8(value: number): Operand65816 {
  return { mode: "imm8", value };
}

/** `#$nnnn` — a sixteen-bit immediate, which may be a label's address. */
export function imm16(value: Ref): Operand65816 {
  return { mode: "imm16", value };
}

/** `#<label` — the low byte of an address, as an eight-bit immediate. */
export function immLow(ref: Ref): Operand65816 {
  return { mode: "imm8", value: typeof ref === "number" ? ref & 0xff : { part: "low", ref } };
}

/** `#>label` — the high byte of an address, as an eight-bit immediate. */
export function immHigh(ref: Ref): Operand65816 {
  return {
    mode: "imm8",
    value: typeof ref === "number" ? (ref >> 8) & 0xff : { part: "high", ref },
  };
}

/** `#^label` — the bank byte of an address, as an eight-bit immediate. */
export function immBank(ref: Ref): Operand65816 {
  return {
    mode: "imm8",
    value: typeof ref === "number" ? (ref >> 16) & 0xff : { part: "bank", ref },
  };
}

/** `$nn` — direct page. One byte shorter and one cycle cheaper than {@link abs}. */
export function dp(address: Ref): Operand65816 {
  return { mode: "dp", value: address };
}

/** `$nn,x` — direct page indexed. */
export function dpX(address: Ref): Operand65816 {
  return { mode: "dpX", value: address };
}

/** `$nn,y` — direct page indexed by Y; `ldx`/`stx` only. */
export function dpY(address: Ref): Operand65816 {
  return { mode: "dpY", value: address };
}

/** `($nn)` — direct page indirect, which the 6502 does not have. */
export function dpInd(address: Ref): Operand65816 {
  return { mode: "dpInd", value: address };
}

/** `($nn,x)` — indexed indirect. */
export function dpIndX(address: Ref): Operand65816 {
  return { mode: "dpIndX", value: address };
}

/** `($nn),y` — indirect indexed. */
export function dpIndY(address: Ref): Operand65816 {
  return { mode: "dpIndY", value: address };
}

/** `[$nn]` — direct page indirect long: a 24-bit pointer. */
export function dpIndLong(address: Ref): Operand65816 {
  return { mode: "dpIndLong", value: address };
}

/** `[$nn],y` — indirect long indexed. */
export function dpIndLongY(address: Ref): Operand65816 {
  return { mode: "dpIndLongY", value: address };
}

/** `$nnnn` — absolute, against the data bank (or the program bank, for a jump). */
export function abs(address: Ref): Operand65816 {
  return { mode: "abs", value: address };
}

/** `$nnnn,x` — absolute indexed. */
export function absX(address: Ref): Operand65816 {
  return { mode: "absX", value: address };
}

/** `$nnnn,y` — absolute indexed. */
export function absY(address: Ref): Operand65816 {
  return { mode: "absY", value: address };
}

/** `($nnnn)` — the indirect jump. */
export function absInd(address: Ref): Operand65816 {
  return { mode: "absInd", value: address };
}

/** `($nnnn,x)` — the indexed indirect jump, which is how a dispatch table works. */
export function absIndX(address: Ref): Operand65816 {
  return { mode: "absIndX", value: address };
}

/** `[$nnnn]` — the indirect long jump. */
export function absIndLong(address: Ref): Operand65816 {
  return { mode: "absIndLong", value: address };
}

/**
 * `$nnnnnn` — long: the bank travels in the instruction.
 *
 * Takes a label as well as a number, which is what makes `jsl`/`jml` usable
 * between banks: a label in a banked program carries its bank
 * ({@link Asm65816.section}), so the operand resolves to all twenty-four bits
 * without a caller doing the arithmetic.
 */
export function long(address: Ref): Operand65816 {
  return { mode: "long", value: address };
}

/** `$nnnnnn,x` — long indexed. */
export function longX(address: number): Operand65816 {
  return { mode: "longX", value: address };
}

/** `$nn,s` — stack relative. */
export function sr(offset: number): Operand65816 {
  return { mode: "sr", value: offset };
}

/** `($nn,s),y` — stack relative indirect indexed. */
export function srY(offset: number): Operand65816 {
  return { mode: "srY", value: offset };
}

/** The accumulator, for the shifts, rotates, increment and decrement. */
export const acc65816: Operand65816 = { mode: "acc", value: 0 };

/**
 * Direct page when the address is in it, absolute otherwise.
 *
 * Only valid unindexed, for the reason the 6502 assembler gives: an indexed
 * direct-page access and an indexed absolute one do not compute the same address
 * in every case, so an inferred short form there would change what the program
 * means. Backends index explicitly.
 */
export function at65816(address: number): Operand65816 {
  return address < 0x100 ? dp(address) : abs(address);
}

/** Every mnemonic this assembler encodes. */
export type Mnemonic65816 =
  | "adc"
  | "and"
  | "asl"
  | "bcc"
  | "bcs"
  | "beq"
  | "bit"
  | "bmi"
  | "bne"
  | "bpl"
  | "bra"
  | "brk"
  | "brl"
  | "bvc"
  | "bvs"
  | "clc"
  | "cld"
  | "cli"
  | "clv"
  | "cmp"
  | "cop"
  | "cpx"
  | "cpy"
  | "dec"
  | "dex"
  | "dey"
  | "eor"
  | "inc"
  | "inx"
  | "iny"
  | "jml"
  | "jmp"
  | "jsl"
  | "jsr"
  | "lda"
  | "ldx"
  | "ldy"
  | "lsr"
  | "mvn"
  | "mvp"
  | "nop"
  | "ora"
  | "pea"
  | "pei"
  | "per"
  | "pha"
  | "phb"
  | "phd"
  | "phk"
  | "php"
  | "phx"
  | "phy"
  | "pla"
  | "plb"
  | "pld"
  | "plp"
  | "plx"
  | "ply"
  | "rep"
  | "rol"
  | "ror"
  | "rti"
  | "rtl"
  | "rts"
  | "sbc"
  | "sec"
  | "sed"
  | "sei"
  | "sep"
  | "sta"
  | "stp"
  | "stx"
  | "sty"
  | "stz"
  | "tax"
  | "tay"
  | "tcd"
  | "tcs"
  | "tdc"
  | "trb"
  | "tsb"
  | "tsc"
  | "tsx"
  | "txa"
  | "txs"
  | "txy"
  | "tya"
  | "tyx"
  | "wai"
  | "wdm"
  | "xba"
  | "xce";

/**
 * Table keys.
 *
 * `imm` is one key for two modes: the opcode does not carry the width, so
 * `imm8` and `imm16` normalise to it and only {@link OPERAND_BYTES} differs.
 * That is the encoding restating the hazard the header names.
 */
type TableKey = Exclude<Mode65816, "imm8" | "imm16"> | "imm";

type Table = Partial<Record<TableKey, number>>;

/**
 * The opcode table, one row per mnemonic.
 *
 * Written out rather than derived from the matrix's regular columns, for the
 * reason the 6502 table gives: the matrix has holes, and a derivation would have
 * to special-case every one of them. A table is checkable against the reference
 * by reading it, and `packages/core/test/wdc65816.test.ts` reads it against the
 * published bytes.
 */
const OPCODES: Readonly<Record<Mnemonic65816, Table>> = {
  adc: {
    imm: 0x69,
    dp: 0x65,
    dpX: 0x75,
    dpInd: 0x72,
    dpIndX: 0x61,
    dpIndY: 0x71,
    dpIndLong: 0x67,
    dpIndLongY: 0x77,
    abs: 0x6d,
    absX: 0x7d,
    absY: 0x79,
    long: 0x6f,
    longX: 0x7f,
    sr: 0x63,
    srY: 0x73,
  },
  and: {
    imm: 0x29,
    dp: 0x25,
    dpX: 0x35,
    dpInd: 0x32,
    dpIndX: 0x21,
    dpIndY: 0x31,
    dpIndLong: 0x27,
    dpIndLongY: 0x37,
    abs: 0x2d,
    absX: 0x3d,
    absY: 0x39,
    long: 0x2f,
    longX: 0x3f,
    sr: 0x23,
    srY: 0x33,
  },
  asl: { acc: 0x0a, dp: 0x06, dpX: 0x16, abs: 0x0e, absX: 0x1e },
  bcc: { rel: 0x90 },
  bcs: { rel: 0xb0 },
  beq: { rel: 0xf0 },
  bit: { imm: 0x89, dp: 0x24, dpX: 0x34, abs: 0x2c, absX: 0x3c },
  bmi: { rel: 0x30 },
  bne: { rel: 0xd0 },
  bpl: { rel: 0x10 },
  bra: { rel: 0x80 },
  brk: { imm: 0x00 },
  brl: { rel16: 0x82 },
  bvc: { rel: 0x50 },
  bvs: { rel: 0x70 },
  clc: { imp: 0x18 },
  cld: { imp: 0xd8 },
  cli: { imp: 0x58 },
  clv: { imp: 0xb8 },
  cmp: {
    imm: 0xc9,
    dp: 0xc5,
    dpX: 0xd5,
    dpInd: 0xd2,
    dpIndX: 0xc1,
    dpIndY: 0xd1,
    dpIndLong: 0xc7,
    dpIndLongY: 0xd7,
    abs: 0xcd,
    absX: 0xdd,
    absY: 0xd9,
    long: 0xcf,
    longX: 0xdf,
    sr: 0xc3,
    srY: 0xd3,
  },
  cop: { imm: 0x02 },
  cpx: { imm: 0xe0, dp: 0xe4, abs: 0xec },
  cpy: { imm: 0xc0, dp: 0xc4, abs: 0xcc },
  dec: { acc: 0x3a, dp: 0xc6, dpX: 0xd6, abs: 0xce, absX: 0xde },
  dex: { imp: 0xca },
  dey: { imp: 0x88 },
  eor: {
    imm: 0x49,
    dp: 0x45,
    dpX: 0x55,
    dpInd: 0x52,
    dpIndX: 0x41,
    dpIndY: 0x51,
    dpIndLong: 0x47,
    dpIndLongY: 0x57,
    abs: 0x4d,
    absX: 0x5d,
    absY: 0x59,
    long: 0x4f,
    longX: 0x5f,
    sr: 0x43,
    srY: 0x53,
  },
  inc: { acc: 0x1a, dp: 0xe6, dpX: 0xf6, abs: 0xee, absX: 0xfe },
  inx: { imp: 0xe8 },
  iny: { imp: 0xc8 },
  jml: { long: 0x5c, absIndLong: 0xdc },
  jmp: { abs: 0x4c, absInd: 0x6c, absIndX: 0x7c },
  jsl: { long: 0x22 },
  jsr: { abs: 0x20, absIndX: 0xfc },
  lda: {
    imm: 0xa9,
    dp: 0xa5,
    dpX: 0xb5,
    dpInd: 0xb2,
    dpIndX: 0xa1,
    dpIndY: 0xb1,
    dpIndLong: 0xa7,
    dpIndLongY: 0xb7,
    abs: 0xad,
    absX: 0xbd,
    absY: 0xb9,
    long: 0xaf,
    longX: 0xbf,
    sr: 0xa3,
    srY: 0xb3,
  },
  ldx: { imm: 0xa2, dp: 0xa6, dpY: 0xb6, abs: 0xae, absY: 0xbe },
  ldy: { imm: 0xa0, dp: 0xa4, dpX: 0xb4, abs: 0xac, absX: 0xbc },
  lsr: { acc: 0x4a, dp: 0x46, dpX: 0x56, abs: 0x4e, absX: 0x5e },
  mvn: { block: 0x54 },
  mvp: { block: 0x44 },
  nop: { imp: 0xea },
  ora: {
    imm: 0x09,
    dp: 0x05,
    dpX: 0x15,
    dpInd: 0x12,
    dpIndX: 0x01,
    dpIndY: 0x11,
    dpIndLong: 0x07,
    dpIndLongY: 0x17,
    abs: 0x0d,
    absX: 0x1d,
    absY: 0x19,
    long: 0x0f,
    longX: 0x1f,
    sr: 0x03,
    srY: 0x13,
  },
  pea: { abs: 0xf4 },
  pei: { dp: 0xd4 },
  per: { rel16: 0x62 },
  pha: { imp: 0x48 },
  phb: { imp: 0x8b },
  phd: { imp: 0x0b },
  phk: { imp: 0x4b },
  php: { imp: 0x08 },
  phx: { imp: 0xda },
  phy: { imp: 0x5a },
  pla: { imp: 0x68 },
  plb: { imp: 0xab },
  pld: { imp: 0x2b },
  plp: { imp: 0x28 },
  plx: { imp: 0xfa },
  ply: { imp: 0x7a },
  rep: { imm: 0xc2 },
  rol: { acc: 0x2a, dp: 0x26, dpX: 0x36, abs: 0x2e, absX: 0x3e },
  ror: { acc: 0x6a, dp: 0x66, dpX: 0x76, abs: 0x6e, absX: 0x7e },
  rti: { imp: 0x40 },
  rtl: { imp: 0x6b },
  rts: { imp: 0x60 },
  sbc: {
    imm: 0xe9,
    dp: 0xe5,
    dpX: 0xf5,
    dpInd: 0xf2,
    dpIndX: 0xe1,
    dpIndY: 0xf1,
    dpIndLong: 0xe7,
    dpIndLongY: 0xf7,
    abs: 0xed,
    absX: 0xfd,
    absY: 0xf9,
    long: 0xef,
    longX: 0xff,
    sr: 0xe3,
    srY: 0xf3,
  },
  sec: { imp: 0x38 },
  sed: { imp: 0xf8 },
  sei: { imp: 0x78 },
  sep: { imm: 0xe2 },
  sta: {
    dp: 0x85,
    dpX: 0x95,
    dpInd: 0x92,
    dpIndX: 0x81,
    dpIndY: 0x91,
    dpIndLong: 0x87,
    dpIndLongY: 0x97,
    abs: 0x8d,
    absX: 0x9d,
    absY: 0x99,
    long: 0x8f,
    longX: 0x9f,
    sr: 0x83,
    srY: 0x93,
  },
  stp: { imp: 0xdb },
  stx: { dp: 0x86, dpY: 0x96, abs: 0x8e },
  sty: { dp: 0x84, dpX: 0x94, abs: 0x8c },
  stz: { dp: 0x64, dpX: 0x74, abs: 0x9c, absX: 0x9e },
  tax: { imp: 0xaa },
  tay: { imp: 0xa8 },
  tcd: { imp: 0x5b },
  tcs: { imp: 0x1b },
  tdc: { imp: 0x7b },
  trb: { dp: 0x14, abs: 0x1c },
  tsb: { dp: 0x04, abs: 0x0c },
  tsc: { imp: 0x3b },
  tsx: { imp: 0xba },
  txa: { imp: 0x8a },
  txs: { imp: 0x9a },
  txy: { imp: 0x9b },
  tya: { imp: 0x98 },
  tyx: { imp: 0xbb },
  wai: { imp: 0xcb },
  wdm: { imm: 0x42 },
  xba: { imp: 0xeb },
  xce: { imp: 0xfb },
};

/** Operand widths, by mode. */
const OPERAND_BYTES: Readonly<Record<Mode65816, number>> = {
  imp: 0,
  acc: 0,
  imm8: 1,
  imm16: 2,
  dp: 1,
  dpX: 1,
  dpY: 1,
  dpInd: 1,
  dpIndX: 1,
  dpIndY: 1,
  dpIndLong: 1,
  dpIndLongY: 1,
  abs: 2,
  absX: 2,
  absY: 2,
  absInd: 2,
  absIndX: 2,
  absIndLong: 2,
  long: 3,
  longX: 3,
  sr: 1,
  srY: 1,
  rel: 1,
  rel16: 2,
  block: 2,
};

/** The table key a mode resolves to; both immediate widths share one opcode. */
function keyOf(mode: Mode65816): TableKey {
  return mode === "imm8" || mode === "imm16" ? "imm" : mode;
}

/** Normalise the two spellings of a label reference. */
function asLabelRef(ref: string | LabelRef): LabelRef {
  return typeof ref === "string" ? { label: ref, addend: 0 } : ref;
}

interface Fixup {
  /** Byte offset of the field to patch. */
  at: number;
  kind: "abs16" | "byte8" | "low8" | "high8" | "bank8" | "long24" | "rel8" | "rel16";
  ref: LabelRef;
  /** Address of the instruction after the operand — for relative branches. */
  next: number;
}

/**
 * A growable code buffer with labels, for the 65816.
 *
 * `origin` is where byte zero lives in the *bank's* address space. A LoROM
 * cartridge's first bank is visible at `$8000`, so that is what a backend passes,
 * and every absolute reference then resolves without the caller doing base
 * arithmetic.
 *
 * ## Banks
 *
 * A program that outgrows one bank calls {@link section} to say which bank the
 * code after it lives in, and from then on a label carries all twenty-four bits
 * of its address. Three things follow and each is what makes the arrangement
 * safe rather than merely possible:
 *
 *   - **`abs16` takes the low sixteen**, which is what the hardware does with an
 *     absolute operand — the bank comes from the data bank register or the
 *     program bank register, not from the instruction. So a `jmp` or a data read
 *     is still bank-local and reads exactly as it did before.
 *   - **`long24` takes all of it**, so `jsl` and `jml` reach any bank and need no
 *     arithmetic at a call site.
 *   - **A section does not move any byte.** The image stays one linear buffer and
 *     `section` only changes what an address *means*; a caller that wants a bank
 *     boundary in the image pads to it first, which is the one thing this class
 *     cannot decide for it (a Demotic cartridge's banks are not contiguous — the
 *     tile art and the sound processor's image sit between them).
 */
export class Asm65816 {
  private code: number[] = [];
  private readonly labels = new Map<string, number>();
  private readonly fixups: Fixup[] = [];
  /** Address of `code[sectionAt]`, which is {@link origin} until `section` moves it. */
  private base: number;
  /** Where the current section began, as a byte offset. */
  private sectionAt = 0;

  constructor(readonly origin = 0) {
    this.base = origin;
  }

  /** Bytes emitted so far. */
  get length(): number {
    return this.code.length;
  }

  /** The address the next byte will occupy. */
  get pc(): number {
    return this.base + (this.code.length - this.sectionAt);
  }

  /**
   * Continue in `bank`, at the origin the constructor was given.
   *
   * Every label from here on carries that bank, so `jsl` and `jml` reach it and
   * an absolute reference into it still means the low sixteen bits — which is
   * the hardware's own rule and the reason a banked build's data reads do not
   * change. Pad to the bank boundary first: this moves no bytes.
   */
  section(bank: number): this {
    this.base = ((bank & 0xff) << 16) | this.origin;
    this.sectionAt = this.code.length;
    return this;
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
    const address = this.labels.get(name);
    if (address === undefined) throw new AsmError(`undefined label '${name}'`);
    return address;
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

  /** Emit a little-endian 32-bit value. */
  dd(value: number): this {
    return this.db(value, value >> 8, value >> 16, value >> 24);
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

  // --- instructions ----------------------------------------------------------

  /**
   * Emit one instruction.
   *
   * The single entry point every named method below funnels through, so the mode
   * check and the operand encoding exist once. An unsupported mnemonic-and-mode
   * pair raises rather than encoding something else — which on this CPU matters
   * more than on most, because an operand byte the decoder does not expect is
   * executed.
   */
  op(mnemonic: Mnemonic65816, operand: Operand65816 = { mode: "imp", value: 0 }): this {
    const opcode = OPCODES[mnemonic][keyOf(operand.mode)];
    if (opcode === undefined) {
      throw new AsmError(`${mnemonic} has no ${operand.mode} addressing mode`);
    }
    this.db(opcode);
    switch (operand.mode) {
      case "imp":
      case "acc":
        return this;
      case "imm8":
        this.immediate8(operand.value as Imm65816);
        return this;
      case "imm16":
        this.word(operand.value as Ref);
        return this;
      case "rel":
        this.relative(operand.value as Ref);
        return this;
      case "rel16":
        this.relativeLong(operand.value as Ref);
        return this;
      case "long":
      case "longX":
        this.triple(operand.value as Ref);
        return this;
      case "block":
        // `mvn dst, src` assembles as the *destination* bank then the source,
        // which is the reverse of how it is written in every syntax there is.
        this.db(operand.value as number, operand.second as number);
        return this;
      default:
        if (OPERAND_BYTES[operand.mode] === 2) this.word(operand.value as Ref);
        else this.byte(operand.value as Ref);
        return this;
    }
  }

  private word(value: Ref): void {
    if (typeof value === "number") {
      this.db(value, value >> 8);
      return;
    }
    this.fixups.push({ at: this.code.length, kind: "abs16", ref: asLabelRef(value), next: 0 });
    this.db(0, 0);
  }

  private triple(value: Ref): void {
    if (typeof value === "number") {
      this.db(value, value >> 8, value >> 16);
      return;
    }
    this.fixups.push({ at: this.code.length, kind: "long24", ref: asLabelRef(value), next: 0 });
    this.db(0, 0, 0);
  }

  private byte(value: Ref): void {
    if (typeof value === "number") {
      if (value > 0xff || value < 0) {
        throw new AsmError(`$${value.toString(16)} is not a direct-page offset`);
      }
      this.db(value);
      return;
    }
    this.fixups.push({ at: this.code.length, kind: "byte8", ref: asLabelRef(value), next: 0 });
    this.db(0);
  }

  private immediate8(value: Imm65816): void {
    if (typeof value === "number") {
      this.db(value);
      return;
    }
    if (typeof value === "string" || "label" in value) {
      // A bare label as an eight-bit immediate is almost certainly a mistake — the
      // caller meant `immLow`, `immHigh` or `immBank` — so it is refused rather
      // than silently truncated.
      throw new AsmError(
        "an eight-bit immediate needs a part: use immLow, immHigh or immBank on a label",
      );
    }
    const kind = value.part === "low" ? "low8" : value.part === "high" ? "high8" : "bank8";
    if (typeof value.ref === "number") {
      const shift = value.part === "low" ? 0 : value.part === "high" ? 8 : 16;
      this.db((value.ref >> shift) & 0xff);
      return;
    }
    this.fixups.push({ at: this.code.length, kind, ref: asLabelRef(value.ref), next: 0 });
    this.db(0);
  }

  private relative(target: Ref): void {
    const at = this.code.length;
    this.db(0);
    const next = this.pc;
    if (typeof target === "number") {
      const delta = target - next;
      if (delta < -128 || delta > 127) throw new AsmError(`relative branch out of range: ${delta}`);
      this.code[at] = delta & 0xff;
      return;
    }
    this.fixups.push({ at, kind: "rel8", ref: asLabelRef(target), next });
  }

  private relativeLong(target: Ref): void {
    const at = this.code.length;
    this.db(0, 0);
    const next = this.pc;
    if (typeof target === "number") {
      const delta = target - next;
      if (delta < -32768 || delta > 32767) {
        throw new AsmError(`long relative branch out of range: ${delta}`);
      }
      this.code[at] = delta & 0xff;
      this.code[at + 1] = (delta >> 8) & 0xff;
      return;
    }
    this.fixups.push({ at, kind: "rel16", ref: asLabelRef(target), next });
  }

  // --- named forms -----------------------------------------------------------
  //
  // One method per mnemonic, taking the operand. Thin by design: they exist so a
  // call site reads like assembly (`asm.lda(abs(base))`) and so a typo is a type
  // error rather than a string that encodes something.

  adc(operand: Operand65816): this {
    return this.op("adc", operand);
  }
  and(operand: Operand65816): this {
    return this.op("and", operand);
  }
  asl(operand: Operand65816 = acc65816): this {
    return this.op("asl", operand);
  }
  bit(operand: Operand65816): this {
    return this.op("bit", operand);
  }
  cmp(operand: Operand65816): this {
    return this.op("cmp", operand);
  }
  cpx(operand: Operand65816): this {
    return this.op("cpx", operand);
  }
  cpy(operand: Operand65816): this {
    return this.op("cpy", operand);
  }
  dec(operand: Operand65816 = acc65816): this {
    return this.op("dec", operand);
  }
  eor(operand: Operand65816): this {
    return this.op("eor", operand);
  }
  inc(operand: Operand65816 = acc65816): this {
    return this.op("inc", operand);
  }
  jmp(target: Ref): this {
    return this.op("jmp", abs(target));
  }
  jmpInd(target: Ref): this {
    return this.op("jmp", absInd(target));
  }
  jmpIndX(target: Ref): this {
    return this.op("jmp", absIndX(target));
  }
  /** `jml` — a jump that carries its bank, so it reaches the whole cartridge. */
  jml(target: Ref): this {
    return this.op("jml", long(target));
  }
  jsr(target: Ref): this {
    return this.op("jsr", abs(target));
  }
  /** `jsl` — a call that carries its bank; returns through `rtl`, never `rts`. */
  jsl(target: Ref): this {
    return this.op("jsl", long(target));
  }
  lda(operand: Operand65816): this {
    return this.op("lda", operand);
  }
  ldx(operand: Operand65816): this {
    return this.op("ldx", operand);
  }
  ldy(operand: Operand65816): this {
    return this.op("ldy", operand);
  }
  lsr(operand: Operand65816 = acc65816): this {
    return this.op("lsr", operand);
  }
  ora(operand: Operand65816): this {
    return this.op("ora", operand);
  }
  rol(operand: Operand65816 = acc65816): this {
    return this.op("rol", operand);
  }
  ror(operand: Operand65816 = acc65816): this {
    return this.op("ror", operand);
  }
  sbc(operand: Operand65816): this {
    return this.op("sbc", operand);
  }
  sta(operand: Operand65816): this {
    return this.op("sta", operand);
  }
  stx(operand: Operand65816): this {
    return this.op("stx", operand);
  }
  sty(operand: Operand65816): this {
    return this.op("sty", operand);
  }
  stz(operand: Operand65816): this {
    return this.op("stz", operand);
  }
  trb(operand: Operand65816): this {
    return this.op("trb", operand);
  }
  tsb(operand: Operand65816): this {
    return this.op("tsb", operand);
  }

  /** `mvn dst, src` — block move upward, `A + 1` bytes. */
  mvn(destinationBank: number, sourceBank: number): this {
    return this.op("mvn", { mode: "block", value: destinationBank, second: sourceBank });
  }

  /** Set processor status bits: `$20` is an eight-bit accumulator, `$10` eight-bit index. */
  sep(mask: number): this {
    return this.op("sep", imm8(mask));
  }

  /** Clear them, which is what makes the accumulator and the index registers wide. */
  rep(mask: number): this {
    return this.op("rep", imm8(mask));
  }

  // Branches. Out of range is an error, never a wrap: a generated rule body is
  // routinely longer than a branch reaches, so backends invert and `jmp`.
  bcc(target: Ref): this {
    return this.op("bcc", { mode: "rel", value: target });
  }
  bcs(target: Ref): this {
    return this.op("bcs", { mode: "rel", value: target });
  }
  beq(target: Ref): this {
    return this.op("beq", { mode: "rel", value: target });
  }
  bne(target: Ref): this {
    return this.op("bne", { mode: "rel", value: target });
  }
  bmi(target: Ref): this {
    return this.op("bmi", { mode: "rel", value: target });
  }
  bpl(target: Ref): this {
    return this.op("bpl", { mode: "rel", value: target });
  }
  bvc(target: Ref): this {
    return this.op("bvc", { mode: "rel", value: target });
  }
  bvs(target: Ref): this {
    return this.op("bvs", { mode: "rel", value: target });
  }
  bra(target: Ref): this {
    return this.op("bra", { mode: "rel", value: target });
  }
  brl(target: Ref): this {
    return this.op("brl", { mode: "rel16", value: target });
  }

  // Implied.
  clc(): this {
    return this.op("clc");
  }
  cld(): this {
    return this.op("cld");
  }
  cli(): this {
    return this.op("cli");
  }
  clv(): this {
    return this.op("clv");
  }
  dex(): this {
    return this.op("dex");
  }
  dey(): this {
    return this.op("dey");
  }
  inx(): this {
    return this.op("inx");
  }
  iny(): this {
    return this.op("iny");
  }
  nop(): this {
    return this.op("nop");
  }
  pha(): this {
    return this.op("pha");
  }
  phb(): this {
    return this.op("phb");
  }
  phd(): this {
    return this.op("phd");
  }
  phk(): this {
    return this.op("phk");
  }
  php(): this {
    return this.op("php");
  }
  phx(): this {
    return this.op("phx");
  }
  phy(): this {
    return this.op("phy");
  }
  pla(): this {
    return this.op("pla");
  }
  plb(): this {
    return this.op("plb");
  }
  pld(): this {
    return this.op("pld");
  }
  plp(): this {
    return this.op("plp");
  }
  plx(): this {
    return this.op("plx");
  }
  ply(): this {
    return this.op("ply");
  }
  rti(): this {
    return this.op("rti");
  }
  rtl(): this {
    return this.op("rtl");
  }
  rts(): this {
    return this.op("rts");
  }
  sec(): this {
    return this.op("sec");
  }
  sed(): this {
    return this.op("sed");
  }
  sei(): this {
    return this.op("sei");
  }
  /** Halt the processor. Nothing this project emits uses it; a test harness does. */
  stp(): this {
    return this.op("stp");
  }
  tax(): this {
    return this.op("tax");
  }
  tay(): this {
    return this.op("tay");
  }
  tcd(): this {
    return this.op("tcd");
  }
  tcs(): this {
    return this.op("tcs");
  }
  tdc(): this {
    return this.op("tdc");
  }
  tsc(): this {
    return this.op("tsc");
  }
  tsx(): this {
    return this.op("tsx");
  }
  txa(): this {
    return this.op("txa");
  }
  txs(): this {
    return this.op("txs");
  }
  txy(): this {
    return this.op("txy");
  }
  tya(): this {
    return this.op("tya");
  }
  tyx(): this {
    return this.op("tyx");
  }
  wai(): this {
    return this.op("wai");
  }
  xba(): this {
    return this.op("xba");
  }
  xce(): this {
    return this.op("xce");
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
        case "long24":
          this.code[fixup.at] = value & 0xff;
          this.code[fixup.at + 1] = (value >> 8) & 0xff;
          this.code[fixup.at + 2] = (value >> 16) & 0xff;
          break;
        case "byte8":
          if (value > 0xff || value < 0) {
            throw new AsmError(
              `'${fixup.ref.label}' is $${value.toString(16)}, not a direct-page offset`,
            );
          }
          this.code[fixup.at] = value & 0xff;
          break;
        case "low8":
          this.code[fixup.at] = value & 0xff;
          break;
        case "high8":
          this.code[fixup.at] = (value >> 8) & 0xff;
          break;
        case "bank8":
          this.code[fixup.at] = (value >> 16) & 0xff;
          break;
        case "rel8": {
          const delta = value - fixup.next;
          if (delta < -128 || delta > 127) {
            throw new AsmError(
              `relative branch to '${fixup.ref.label}' is ${delta} bytes away; invert and jmp`,
            );
          }
          this.code[fixup.at] = delta & 0xff;
          break;
        }
        case "rel16": {
          const delta = value - fixup.next;
          if (delta < -32768 || delta > 32767) {
            throw new AsmError(`long relative branch to '${fixup.ref.label}' is ${delta} away`);
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
