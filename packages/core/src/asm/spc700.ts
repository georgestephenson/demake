/**
 * A Sony SPC700 assembler.
 *
 * The fifth CPU in this directory, and the first one that is not the console's
 * main processor: the Super Nintendo's sound hardware is a *second computer* —
 * an SPC700 with 64 KiB of its own RAM and no access to the cartridge — so the
 * only way a schedule reaches the S-DSP is a program uploaded at boot that
 * performs it. That program is generated for the schedule, the way every other
 * driver here is, which is why an assembler for it belongs in `core` beside the
 * SM83, 6502, Z80 and 65816 ones rather than in the audio package.
 *
 * Three things about this instruction set shape the file, and each is a place a
 * 6502 habit produces something that assembles and does not work:
 *
 *   - **Almost everything is `mov`.** There is no `lda`/`sta`/`ldx` split; the
 *     opcode is chosen by the *pair* of operands, so the table is keyed by a form
 *     like `a,d` or `[d]+y,a` rather than by a mode. A form the CPU does not have
 *     raises instead of encoding a neighbouring one.
 *   - **Two operands that both carry bytes are encoded backwards.** `mov d,#i`
 *     stores the immediate first and the direct-page offset second, and `mov
 *     dd,ds` stores the *source* offset first. Written order and encoded order
 *     differ for exactly those two shapes, and {@link Entry.reverse} is where
 *     that is said once.
 *   - **The direct page moves.** `clrp`/`setp` swap it between `$00xx` and
 *     `$01xx`, and the stack lives in `$01xx` either way. Everything generated
 *     here runs with P clear, so `dp(n)` means `$00nn` — a driver that sets P
 *     would be assembling against a different memory map with the same bytes.
 *
 * Sources: the SPC700 opcode matrix as published in the Anomie / nocash SNES
 * hardware documents, and the SNESdev Wiki's SPC700 reference
 * (https://snes.nesdev.org/wiki/SPC700_reference).
 */

import { AsmError, label, type LabelRef, type Ref } from "./sm83.js";

export { AsmError, label };
export type { LabelRef, Ref };

/**
 * The shape of an instruction's operands, as the constructors below produce it.
 *
 * A single operand is its own tag; a pair is `dst,src` joined by a comma. Keeping
 * the key a plain string is what lets the tables below be read against a printed
 * opcode matrix line by line.
 */
export type Spc700Tag =
  | "a"
  | "x"
  | "y"
  | "ya"
  | "sp"
  | "psw"
  | "c"
  | "#i"
  | "d"
  | "d+x"
  | "d+y"
  | "!a"
  | "!a+x"
  | "!a+y"
  | "(x)"
  | "(x)+"
  | "(y)"
  | "[d+x]"
  | "[d]+y"
  | "[!a+x]"
  | "r"
  | "u";

/** One operand: what it is, and the value it carries. */
export interface Spc700Operand {
  readonly tag: Spc700Tag;
  readonly value: Ref;
}

/** How many operand bytes a tag contributes, and how they are written. */
const TAG_BYTES: Readonly<Record<Spc700Tag, 0 | 1 | 2>> = {
  a: 0,
  x: 0,
  y: 0,
  ya: 0,
  sp: 0,
  psw: 0,
  c: 0,
  "#i": 1,
  d: 1,
  "d+x": 1,
  "d+y": 1,
  "!a": 2,
  "!a+x": 2,
  "!a+y": 2,
  "(x)": 0,
  "(x)+": 0,
  "(y)": 0,
  "[d+x]": 1,
  "[d]+y": 1,
  "[!a+x]": 2,
  r: 1,
  u: 1,
};

// --- operand constructors ----------------------------------------------------

/** The accumulator. */
export const A: Spc700Operand = { tag: "a", value: 0 };
/** The X index register. */
export const X: Spc700Operand = { tag: "x", value: 0 };
/** The Y index register. */
export const Y: Spc700Operand = { tag: "y", value: 0 };
/** The Y:A register pair, as one sixteen-bit value. */
export const YA: Spc700Operand = { tag: "ya", value: 0 };
/** The stack pointer (low byte only; the stack is always page one). */
export const SP: Spc700Operand = { tag: "sp", value: 0 };
/** The processor status word. */
export const PSW: Spc700Operand = { tag: "psw", value: 0 };
/** The carry flag, as a one-bit operand. */
export const C: Spc700Operand = { tag: "c", value: 0 };
/** `(X)` — the byte X points at in the direct page. */
export const indX: Spc700Operand = { tag: "(x)", value: 0 };
/** `(X)+` — the same, with X incremented afterwards. */
export const indXInc: Spc700Operand = { tag: "(x)+", value: 0 };
/** `(Y)` — only ever the source of the `(X),(Y)` block forms. */
export const indY: Spc700Operand = { tag: "(y)", value: 0 };

/** `#$nn`. */
export function imm(value: Ref): Spc700Operand {
  return { tag: "#i", value };
}
/** `$nn` — direct page, which is `$00nn` with P clear. */
export function dp(value: Ref): Spc700Operand {
  return { tag: "d", value };
}
/** `$nn+X`. */
export function dpX(value: Ref): Spc700Operand {
  return { tag: "d+x", value };
}
/** `$nn+Y`. */
export function dpY(value: Ref): Spc700Operand {
  return { tag: "d+y", value };
}
/** `!$nnnn` — a sixteen-bit address anywhere in the SPC700's memory. */
export function abs(value: Ref): Spc700Operand {
  return { tag: "!a", value };
}
/** `!$nnnn+X`. */
export function absX(value: Ref): Spc700Operand {
  return { tag: "!a+x", value };
}
/** `!$nnnn+Y`. */
export function absY(value: Ref): Spc700Operand {
  return { tag: "!a+y", value };
}
/** `[$nn+X]` — a pointer at `$nn+X`, read before indexing. */
export function indIdxX(value: Ref): Spc700Operand {
  return { tag: "[d+x]", value };
}
/** `[$nn]+Y` — a pointer at `$nn`, indexed by Y afterwards. */
export function idxIndY(value: Ref): Spc700Operand {
  return { tag: "[d]+y", value };
}

/** One table entry: the opcode, and whether the two operands swap on encoding. */
interface Entry {
  op: number;
  /**
   * The written order is `dst,src` and the encoded order is `src,dst`.
   *
   * True for exactly the two shapes where both operands carry a byte: `d,#i` and
   * `d,d`. Everything else has at most one byte to place, so the question does
   * not arise.
   */
  reverse?: true;
}

type Table = Readonly<Record<string, Entry>>;

/** The six ALU operations, which share one column layout offset by their base. */
function alu(base: number): Table {
  return {
    "a,d": { op: base + 0x04 },
    "a,!a": { op: base + 0x05 },
    "a,(x)": { op: base + 0x06 },
    "a,[d+x]": { op: base + 0x07 },
    "a,#i": { op: base + 0x08 },
    "d,d": { op: base + 0x09, reverse: true },
    "a,d+x": { op: base + 0x14 },
    "a,!a+x": { op: base + 0x15 },
    "a,!a+y": { op: base + 0x16 },
    "a,[d]+y": { op: base + 0x17 },
    "d,#i": { op: base + 0x18, reverse: true },
    "(x),(y)": { op: base + 0x19 },
  };
}

/** A read-modify-write shift, whose four forms are always the same offsets. */
function shift(base: number): Table {
  return {
    d: { op: base + 0x0b },
    "!a": { op: base + 0x0c },
    "d+x": { op: base + 0x1b },
    a: { op: base + 0x1c },
  };
}

const MOV: Table = {
  "a,#i": { op: 0xe8 },
  "a,d": { op: 0xe4 },
  "a,d+x": { op: 0xf4 },
  "a,!a": { op: 0xe5 },
  "a,!a+x": { op: 0xf5 },
  "a,!a+y": { op: 0xf6 },
  "a,(x)": { op: 0xe6 },
  "a,(x)+": { op: 0xbf },
  "a,[d+x]": { op: 0xe7 },
  "a,[d]+y": { op: 0xf7 },
  "x,#i": { op: 0xcd },
  "x,d": { op: 0xf8 },
  "x,d+y": { op: 0xf9 },
  "x,!a": { op: 0xe9 },
  "y,#i": { op: 0x8d },
  "y,d": { op: 0xeb },
  "y,d+x": { op: 0xfb },
  "y,!a": { op: 0xec },
  "d,a": { op: 0xc4 },
  "d+x,a": { op: 0xd4 },
  "!a,a": { op: 0xc5 },
  "!a+x,a": { op: 0xd5 },
  "!a+y,a": { op: 0xd6 },
  "(x),a": { op: 0xc6 },
  "(x)+,a": { op: 0xaf },
  "[d+x],a": { op: 0xc7 },
  "[d]+y,a": { op: 0xd7 },
  "d,x": { op: 0xd8 },
  "d+y,x": { op: 0xd9 },
  "!a,x": { op: 0xc9 },
  "d,y": { op: 0xcb },
  "d+x,y": { op: 0xdb },
  "!a,y": { op: 0xcc },
  "d,#i": { op: 0x8f, reverse: true },
  "d,d": { op: 0xfa, reverse: true },
  "a,x": { op: 0x7d },
  "x,a": { op: 0x5d },
  "a,y": { op: 0xdd },
  "y,a": { op: 0xfd },
  "x,sp": { op: 0x9d },
  "sp,x": { op: 0xbd },
};

/** Every mnemonic this assembler encodes, and the forms each one has. */
const OPCODES = {
  mov: MOV,
  or: alu(0x00),
  and: alu(0x20),
  eor: alu(0x40),
  cmp: {
    ...alu(0x60),
    "x,#i": { op: 0xc8 },
    "x,d": { op: 0x3e },
    "x,!a": { op: 0x1e },
    "y,#i": { op: 0xad },
    "y,d": { op: 0x7e },
    "y,!a": { op: 0x5e },
  },
  adc: alu(0x80),
  sbc: alu(0xa0),
  asl: shift(0x00),
  rol: shift(0x20),
  lsr: shift(0x40),
  ror: shift(0x60),
  dec: { ...shift(0x80), x: { op: 0x1d }, y: { op: 0xdc } },
  inc: { ...shift(0xa0), x: { op: 0x3d }, y: { op: 0xfc } },
  movw: { "ya,d": { op: 0xba }, "d,ya": { op: 0xda } },
  incw: { d: { op: 0x3a } },
  decw: { d: { op: 0x1a } },
  addw: { "ya,d": { op: 0x7a } },
  subw: { "ya,d": { op: 0x9a } },
  cmpw: { "ya,d": { op: 0x5a } },
  mul: { ya: { op: 0xcf } },
  div: { "ya,x": { op: 0x9e } },
  push: { a: { op: 0x2d }, x: { op: 0x4d }, y: { op: 0x6d }, psw: { op: 0x0d } },
  pop: { a: { op: 0xae }, x: { op: 0xce }, y: { op: 0xee }, psw: { op: 0x8e } },
  tset1: { "!a": { op: 0x0e } },
  tclr1: { "!a": { op: 0x4e } },
  jmp: { "!a": { op: 0x5f }, "[!a+x]": { op: 0x1f } },
  call: { "!a": { op: 0x3f } },
  pcall: { u: { op: 0x4f } },
} as const satisfies Readonly<Record<string, Table>>;

/** A mnemonic with operands. */
export type Mnemonic700 = keyof typeof OPCODES;

/** Conditional branches, by the flag test they perform. */
const BRANCH = {
  bra: 0x2f,
  beq: 0xf0,
  bne: 0xd0,
  bcs: 0xb0,
  bcc: 0x90,
  bmi: 0x30,
  bpl: 0x10,
  bvs: 0x70,
  bvc: 0x50,
} as const;

/** A relative branch mnemonic. */
export type Branch700 = keyof typeof BRANCH;

/** Instructions with no operands at all. */
const IMPLIED = {
  nop: 0x00,
  clrp: 0x20,
  setp: 0x40,
  clrc: 0x60,
  setc: 0x80,
  notc: 0xed,
  clrv: 0xe0,
  ei: 0xa0,
  di: 0xc0,
  ret: 0x6f,
  reti: 0x7f,
  brk: 0x0f,
  xcn: 0x9f,
  daa: 0xdf,
  das: 0xbe,
  sleep: 0xef,
  stop: 0xff,
} as const;

/** An operandless mnemonic. */
export type Implied700 = keyof typeof IMPLIED;

/** Normalise the two spellings of a label reference. */
function asLabelRef(ref: string | LabelRef): LabelRef {
  return typeof ref === "string" ? { label: ref, addend: 0 } : ref;
}

interface Fixup {
  at: number;
  kind: "abs16" | "byte8" | "low8" | "high8" | "rel8";
  ref: LabelRef;
  /** Address of the instruction after the operand — for relative branches. */
  next: number;
}

/**
 * A growable code buffer with labels, for the SPC700.
 *
 * `origin` is where byte zero lands in the SPC700's own 64 KiB address space,
 * which is wherever the boot uploader was told to put the driver. Nothing here
 * knows about the cartridge: the bytes this produces travel to the sound chip
 * four at a time through a mailbox, and the assembler's job stops at the bytes.
 */
export class Asm700 {
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
   * Emit one instruction from its mnemonic and operands.
   *
   * The single entry point the named methods funnel through. A form the CPU does
   * not have raises rather than encoding a neighbour: on a machine where `mov
   * a,!a+y` exists and `mov a,!a+x` also exists but `mov x,!a+y` does not, a
   * quiet substitution would read the right address off the wrong register.
   */
  op(mnemonic: Mnemonic700, dst?: Spc700Operand, src?: Spc700Operand): this {
    const key = src === undefined ? (dst?.tag ?? "") : `${dst!.tag},${src.tag}`;
    const entry = (OPCODES[mnemonic] as Table)[key];
    if (entry === undefined) throw new AsmError(`${mnemonic} has no '${key}' form`);
    this.db(entry.op);
    const operands = entry.reverse ? [src!, dst!] : [dst, src];
    for (const operand of operands) {
      if (operand === undefined) continue;
      const width = TAG_BYTES[operand.tag];
      if (width === 1) this.byte(operand.value);
      else if (width === 2) this.word(operand.value);
    }
    return this;
  }

  /** `mov dst, src` — the instruction this CPU mostly is. */
  mov(dst: Spc700Operand, src: Spc700Operand): this {
    return this.op("mov", dst, src);
  }
  movw(dst: Spc700Operand, src: Spc700Operand): this {
    return this.op("movw", dst, src);
  }
  or(dst: Spc700Operand, src: Spc700Operand): this {
    return this.op("or", dst, src);
  }
  and(dst: Spc700Operand, src: Spc700Operand): this {
    return this.op("and", dst, src);
  }
  eor(dst: Spc700Operand, src: Spc700Operand): this {
    return this.op("eor", dst, src);
  }
  cmp(dst: Spc700Operand, src: Spc700Operand): this {
    return this.op("cmp", dst, src);
  }
  adc(dst: Spc700Operand, src: Spc700Operand): this {
    return this.op("adc", dst, src);
  }
  sbc(dst: Spc700Operand, src: Spc700Operand): this {
    return this.op("sbc", dst, src);
  }
  addw(dst: Spc700Operand, src: Spc700Operand): this {
    return this.op("addw", dst, src);
  }
  subw(dst: Spc700Operand, src: Spc700Operand): this {
    return this.op("subw", dst, src);
  }
  cmpw(dst: Spc700Operand, src: Spc700Operand): this {
    return this.op("cmpw", dst, src);
  }
  asl(target: Spc700Operand = A): this {
    return this.op("asl", target);
  }
  rol(target: Spc700Operand = A): this {
    return this.op("rol", target);
  }
  lsr(target: Spc700Operand = A): this {
    return this.op("lsr", target);
  }
  ror(target: Spc700Operand = A): this {
    return this.op("ror", target);
  }
  inc(target: Spc700Operand = A): this {
    return this.op("inc", target);
  }
  dec(target: Spc700Operand = A): this {
    return this.op("dec", target);
  }
  incw(target: Spc700Operand): this {
    return this.op("incw", target);
  }
  decw(target: Spc700Operand): this {
    return this.op("decw", target);
  }
  mul(): this {
    return this.op("mul", YA);
  }
  div(): this {
    return this.op("div", YA, X);
  }
  push(target: Spc700Operand): this {
    return this.op("push", target);
  }
  pop(target: Spc700Operand): this {
    return this.op("pop", target);
  }
  tset1(target: Spc700Operand): this {
    return this.op("tset1", target);
  }
  tclr1(target: Spc700Operand): this {
    return this.op("tclr1", target);
  }
  jmp(target: Ref): this {
    return this.op("jmp", abs(target));
  }
  /** `jmp [!$nnnn+X]` — the CPU's one indirect jump, and how the boot ROM ends. */
  jmpIndX(target: Ref): this {
    return this.op("jmp", { tag: "[!a+x]", value: target });
  }
  call(target: Ref): this {
    return this.op("call", abs(target));
  }

  /** An operandless instruction. */
  implied(mnemonic: Implied700): this {
    return this.db(IMPLIED[mnemonic]);
  }
  nop(): this {
    return this.implied("nop");
  }
  clrp(): this {
    return this.implied("clrp");
  }
  setp(): this {
    return this.implied("setp");
  }
  clrc(): this {
    return this.implied("clrc");
  }
  setc(): this {
    return this.implied("setc");
  }
  ei(): this {
    return this.implied("ei");
  }
  di(): this {
    return this.implied("di");
  }
  ret(): this {
    return this.implied("ret");
  }
  reti(): this {
    return this.implied("reti");
  }
  xcn(): this {
    return this.implied("xcn");
  }
  sleep(): this {
    return this.implied("sleep");
  }
  stop(): this {
    return this.implied("stop");
  }

  /** A relative branch. Range is ±128 bytes, as on the 6502. */
  branch(kind: Branch700, target: Ref): this {
    this.db(BRANCH[kind]);
    this.relative(target);
    return this;
  }
  bra(target: Ref): this {
    return this.branch("bra", target);
  }
  beq(target: Ref): this {
    return this.branch("beq", target);
  }
  bne(target: Ref): this {
    return this.branch("bne", target);
  }
  bcs(target: Ref): this {
    return this.branch("bcs", target);
  }
  bcc(target: Ref): this {
    return this.branch("bcc", target);
  }
  bmi(target: Ref): this {
    return this.branch("bmi", target);
  }
  bpl(target: Ref): this {
    return this.branch("bpl", target);
  }

  /** `dbnz $nn, rel` — decrement a direct-page byte and branch while non-zero. */
  dbnzDp(offset: Ref, target: Ref): this {
    this.db(0x6e);
    this.byte(offset);
    this.relative(target);
    return this;
  }
  /** `dbnz Y, rel` — the register form, which needs no memory at all. */
  dbnzY(target: Ref): this {
    this.db(0xfe);
    this.relative(target);
    return this;
  }
  /** `cbne $nn, rel` — compare A with a direct-page byte and branch if unequal. */
  cbneDp(offset: Ref, target: Ref): this {
    this.db(0x2e);
    this.byte(offset);
    this.relative(target);
    return this;
  }
  /** `cbne $nn+X, rel`. */
  cbneDpX(offset: Ref, target: Ref): this {
    this.db(0xde);
    this.byte(offset);
    this.relative(target);
    return this;
  }

  /**
   * `set1 $nn.b` / `clr1 $nn.b` — a bit in the direct page, in one instruction.
   *
   * The bit number is in the *opcode*, eight opcodes apart in pairs, which is why
   * these are methods rather than table entries: the operand does not carry it.
   */
  set1(offset: Ref, bit: number): this {
    this.db(0x02 + (checkBit(bit) << 5));
    return this.byte(offset);
  }
  clr1(offset: Ref, bit: number): this {
    this.db(0x12 + (checkBit(bit) << 5));
    return this.byte(offset);
  }
  /** `bbs $nn.b, rel` — branch if the bit is set. */
  bbs(offset: Ref, bit: number, target: Ref): this {
    this.db(0x03 + (checkBit(bit) << 5));
    this.byte(offset);
    this.relative(target);
    return this;
  }
  /** `bbc $nn.b, rel` — branch if the bit is clear. */
  bbc(offset: Ref, bit: number, target: Ref): this {
    this.db(0x13 + (checkBit(bit) << 5));
    this.byte(offset);
    this.relative(target);
    return this;
  }

  /**
   * The carry-bit instructions, whose operand packs an address and a bit number.
   *
   * Thirteen bits of address and three of bit index in one little-endian word,
   * which is the only place on this CPU where an operand is not simply a value.
   */
  bitOp(
    kind: "mov1From" | "mov1To" | "and1" | "and1Not" | "or1" | "or1Not" | "eor1" | "not1",
    address: number,
    bit: number,
  ): this {
    const OPS = {
      mov1From: 0xaa,
      mov1To: 0xca,
      and1: 0x4a,
      and1Not: 0x6a,
      or1: 0x0a,
      or1Not: 0x2a,
      eor1: 0x8a,
      not1: 0xea,
    } as const;
    if (address < 0 || address > 0x1fff) {
      throw new AsmError(`$${address.toString(16)} is out of the bit instructions' 13-bit reach`);
    }
    this.db(OPS[kind]);
    const packed = address | (checkBit(bit) << 13);
    return this.db(packed, packed >> 8);
  }

  private word(value: Ref): void {
    if (typeof value === "number") {
      this.db(value, value >> 8);
      return;
    }
    this.fixups.push({ at: this.code.length, kind: "abs16", ref: asLabelRef(value), next: 0 });
    this.db(0, 0);
  }

  private byte(value: Ref): this {
    if (typeof value === "number") {
      if (value > 0xff || value < 0) {
        throw new AsmError(`$${value.toString(16)} does not fit in one operand byte`);
      }
      return this.db(value);
    }
    this.fixups.push({ at: this.code.length, kind: "byte8", ref: asLabelRef(value), next: 0 });
    return this.db(0);
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

  /** Resolve every forward reference and return the finished bytes. */
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
      }
    }
    return Uint8Array.from(this.code);
  }

  /** Every label, for a symbol file. */
  symbols(): ReadonlyMap<string, number> {
    return new Map(this.labels);
  }
}

function checkBit(bit: number): number {
  if (!Number.isInteger(bit) || bit < 0 || bit > 7) {
    throw new AsmError(`${bit} is not a bit number`);
  }
  return bit;
}
