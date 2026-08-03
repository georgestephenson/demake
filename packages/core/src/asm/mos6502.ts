/**
 * A MOS 6502 assembler.
 *
 * The counterpart of {@link Asm} for the NES family, and it exists for the same
 * two reasons that one does (`asm/sm83.ts`, doc 14 §Runtime model):
 *
 *   - **Machine code, because the machine is small.** A game's entities are
 *     known at compile time, so every property is a constant address — which on
 *     this CPU is worth more than it is on the Game Boy, because the 6502 has
 *     three registers and addresses memory directly. A 16.16 add is four
 *     `lda`/`adc`/`sta` triples over absolute addresses and touches no pointer
 *     at all.
 *   - **In TypeScript, because the browser has no assembler.** Doc 07 wants the
 *     page to build the same cartridge the CLI builds, byte for byte, with
 *     nothing installed. The Game Boy backend already keeps that promise; a
 *     second console must not break it by reaching for cc65.
 *
 * The design is the SM83 assembler's, deliberately: explicit encodings from one
 * table, a fixup list for forward references, one pass plus a sweep, and no
 * macro or peephole layer — optimisation belongs in the code generator, where it
 * can see what the code *means*.
 *
 * Where it differs is the operand model. The 6502 has one accumulator and
 * thirteen addressing modes, so a method per mnemonic-and-mode would be six
 * hundred methods; instead an operand carries its mode ({@link imm},
 * {@link zp}, {@link abs}, {@link absX}, {@link indY}, …) and the table decides
 * whether that mnemonic has that form. An invalid pair is an {@link AsmError}
 * at emit time rather than a wrong opcode.
 *
 * Two hazards this file makes loud rather than silent:
 *
 *   - **Zero page is a different instruction, not an optimisation.** `zp(x)` and
 *     `abs(x)` encode differently and `zp,x` wraps inside page zero where
 *     `abs,x` does not, so the choice is the caller's and never inferred from a
 *     value. Backends that want the short form for a low address say so.
 *   - **Branches reach ±128 bytes.** A conditional branch out of range is an
 *     error, exactly as the SM83 assembler refuses an over-long `jr`; a
 *     generated rule body easily exceeds it, so backends invert the condition
 *     and `jmp`.
 *
 * Sources: NESdev Wiki — CPU instruction set
 * (https://www.nesdev.org/wiki/Instruction_reference) and CPU addressing modes
 * (https://www.nesdev.org/wiki/CPU_addressing_modes).
 */

import { AsmError, label, type LabelRef, type Ref } from "./sm83.js";

export { AsmError, label };
export type { LabelRef, Ref };

/** An addressing mode, as the operand constructors produce it. */
export type Mode =
  | "imp"
  | "acc"
  | "imm"
  | "zp"
  | "zpX"
  | "zpY"
  | "abs"
  | "absX"
  | "absY"
  | "ind"
  | "indX"
  | "indY"
  | "indZp"
  | "rel";

/**
 * An immediate byte: a number, or one half of an address that is not resolved
 * yet.
 *
 * `lda #<Table` is how a 6502 program loads a pointer, so the low and high
 * halves of a label have to be expressible before the label exists.
 */
export type Imm = number | { readonly half: "low" | "high"; readonly ref: Ref };

/** An operand: a mode and the value it addresses. */
export interface Operand {
  readonly mode: Mode;
  readonly value: Ref | Imm;
}

/** `#nn` — an immediate byte. */
export function imm(value: number): Operand {
  return { mode: "imm", value };
}

/** `#<label` — the low byte of an address. */
export function immLow(ref: Ref): Operand {
  return { mode: "imm", value: typeof ref === "number" ? ref & 0xff : { half: "low", ref } };
}

/** `#>label` — the high byte of an address. */
export function immHigh(ref: Ref): Operand {
  return {
    mode: "imm",
    value: typeof ref === "number" ? (ref >> 8) & 0xff : { half: "high", ref },
  };
}

/** `$nn` — zero page. Two bytes and one cycle cheaper than {@link abs}. */
export function zp(address: Ref): Operand {
  return { mode: "zp", value: address };
}

/** `$nn,x` — zero page indexed. Wraps inside page zero. */
export function zpX(address: Ref): Operand {
  return { mode: "zpX", value: address };
}

/** `$nn,y` — zero page indexed by Y; `ldx`/`stx` only. */
export function zpY(address: Ref): Operand {
  return { mode: "zpY", value: address };
}

/** `$nnnn` — absolute. */
export function abs(address: Ref): Operand {
  return { mode: "abs", value: address };
}

/** `$nnnn,x` — absolute indexed. */
export function absX(address: Ref): Operand {
  return { mode: "absX", value: address };
}

/** `$nnnn,y` — absolute indexed. */
export function absY(address: Ref): Operand {
  return { mode: "absY", value: address };
}

/** `($nnnn)` — the indirect jump. */
export function ind(address: Ref): Operand {
  return { mode: "ind", value: address };
}

/** `($nn,x)` — indexed indirect. */
export function indX(address: Ref): Operand {
  return { mode: "indX", value: address };
}

/** `($nn),y` — indirect indexed: the 6502's pointer dereference. */
export function indY(address: Ref): Operand {
  return { mode: "indY", value: address };
}

/**
 * `($nn)` — indirect, unindexed.
 *
 * No 6502 instruction has it; the 65C02 added it to eight, and the HuC6280
 * inherits them. The mode lives here rather than in `huc6280.ts` because the
 * operand model is this file's and a mode a subclass invented would be a second
 * one — but nothing in {@link OPCODES} names it, so a plain 6502 still refuses
 * it as it should.
 */
export function indZp(address: Ref): Operand {
  return { mode: "indZp", value: address };
}

/** The accumulator, for the shifts and rotates. */
export const acc: Operand = { mode: "acc", value: 0 };

/**
 * Zero page when the address is in it, absolute otherwise.
 *
 * Only valid unindexed: an indexed zero-page access wraps at `$FF` where an
 * absolute one carries, so an inferred short form there would change what the
 * program means. Backends index explicitly.
 */
export function at(address: number): Operand {
  return address < 0x100 ? zp(address) : abs(address);
}

/** Every mnemonic this assembler encodes. */
export type Mnemonic =
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
  | "brk"
  | "bvc"
  | "bvs"
  | "clc"
  | "cld"
  | "cli"
  | "clv"
  | "cmp"
  | "cpx"
  | "cpy"
  | "dec"
  | "dex"
  | "dey"
  | "eor"
  | "inc"
  | "inx"
  | "iny"
  | "jmp"
  | "jsr"
  | "lda"
  | "ldx"
  | "ldy"
  | "lsr"
  | "nop"
  | "ora"
  | "pha"
  | "php"
  | "pla"
  | "plp"
  | "rol"
  | "ror"
  | "rti"
  | "rts"
  | "sbc"
  | "sec"
  | "sed"
  | "sei"
  | "sta"
  | "stx"
  | "sty"
  | "tax"
  | "tay"
  | "tsx"
  | "txa"
  | "txs"
  | "tya";

type Table = Partial<Record<Mode, number>>;

/**
 * The opcode table, one row per mnemonic.
 *
 * Written out rather than derived from the instruction matrix's regular columns:
 * the matrix has holes (`stx` has no absolute-indexed form, `ldx` indexes by Y
 * and `ldy` by X) and a derivation would have to special-case every one of them.
 * A table is checkable against the reference by reading it.
 */
const OPCODES: Readonly<Record<Mnemonic, Table>> = {
  adc: {
    imm: 0x69,
    zp: 0x65,
    zpX: 0x75,
    abs: 0x6d,
    absX: 0x7d,
    absY: 0x79,
    indX: 0x61,
    indY: 0x71,
  },
  and: {
    imm: 0x29,
    zp: 0x25,
    zpX: 0x35,
    abs: 0x2d,
    absX: 0x3d,
    absY: 0x39,
    indX: 0x21,
    indY: 0x31,
  },
  asl: { acc: 0x0a, zp: 0x06, zpX: 0x16, abs: 0x0e, absX: 0x1e },
  bcc: { rel: 0x90 },
  bcs: { rel: 0xb0 },
  beq: { rel: 0xf0 },
  bit: { zp: 0x24, abs: 0x2c },
  bmi: { rel: 0x30 },
  bne: { rel: 0xd0 },
  bpl: { rel: 0x10 },
  brk: { imp: 0x00 },
  bvc: { rel: 0x50 },
  bvs: { rel: 0x70 },
  clc: { imp: 0x18 },
  cld: { imp: 0xd8 },
  cli: { imp: 0x58 },
  clv: { imp: 0xb8 },
  cmp: {
    imm: 0xc9,
    zp: 0xc5,
    zpX: 0xd5,
    abs: 0xcd,
    absX: 0xdd,
    absY: 0xd9,
    indX: 0xc1,
    indY: 0xd1,
  },
  cpx: { imm: 0xe0, zp: 0xe4, abs: 0xec },
  cpy: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
  dec: { zp: 0xc6, zpX: 0xd6, abs: 0xce, absX: 0xde },
  dex: { imp: 0xca },
  dey: { imp: 0x88 },
  eor: {
    imm: 0x49,
    zp: 0x45,
    zpX: 0x55,
    abs: 0x4d,
    absX: 0x5d,
    absY: 0x59,
    indX: 0x41,
    indY: 0x51,
  },
  inc: { zp: 0xe6, zpX: 0xf6, abs: 0xee, absX: 0xfe },
  inx: { imp: 0xe8 },
  iny: { imp: 0xc8 },
  jmp: { abs: 0x4c, ind: 0x6c },
  jsr: { abs: 0x20 },
  lda: {
    imm: 0xa9,
    zp: 0xa5,
    zpX: 0xb5,
    abs: 0xad,
    absX: 0xbd,
    absY: 0xb9,
    indX: 0xa1,
    indY: 0xb1,
  },
  ldx: { imm: 0xa2, zp: 0xa6, zpY: 0xb6, abs: 0xae, absY: 0xbe },
  ldy: { imm: 0xa0, zp: 0xa4, zpX: 0xb4, abs: 0xac, absX: 0xbc },
  lsr: { acc: 0x4a, zp: 0x46, zpX: 0x56, abs: 0x4e, absX: 0x5e },
  nop: { imp: 0xea },
  ora: {
    imm: 0x09,
    zp: 0x05,
    zpX: 0x15,
    abs: 0x0d,
    absX: 0x1d,
    absY: 0x19,
    indX: 0x01,
    indY: 0x11,
  },
  pha: { imp: 0x48 },
  php: { imp: 0x08 },
  pla: { imp: 0x68 },
  plp: { imp: 0x28 },
  rol: { acc: 0x2a, zp: 0x26, zpX: 0x36, abs: 0x2e, absX: 0x3e },
  ror: { acc: 0x6a, zp: 0x66, zpX: 0x76, abs: 0x6e, absX: 0x7e },
  rti: { imp: 0x40 },
  rts: { imp: 0x60 },
  sbc: {
    imm: 0xe9,
    zp: 0xe5,
    zpX: 0xf5,
    abs: 0xed,
    absX: 0xfd,
    absY: 0xf9,
    indX: 0xe1,
    indY: 0xf1,
  },
  sec: { imp: 0x38 },
  sed: { imp: 0xf8 },
  sei: { imp: 0x78 },
  sta: { zp: 0x85, zpX: 0x95, abs: 0x8d, absX: 0x9d, absY: 0x99, indX: 0x81, indY: 0x91 },
  stx: { zp: 0x86, zpY: 0x96, abs: 0x8e },
  sty: { zp: 0x84, zpX: 0x94, abs: 0x8c },
  tax: { imp: 0xaa },
  tay: { imp: 0xa8 },
  tsx: { imp: 0xba },
  txa: { imp: 0x8a },
  txs: { imp: 0x9a },
  tya: { imp: 0x98 },
};

/** Operand widths, by mode. */
const OPERAND_BYTES: Readonly<Record<Mode, number>> = {
  imp: 0,
  acc: 0,
  imm: 1,
  zp: 1,
  zpX: 1,
  zpY: 1,
  abs: 2,
  absX: 2,
  absY: 2,
  ind: 2,
  indX: 1,
  indY: 1,
  indZp: 1,
  rel: 1,
};

/** Normalise the two spellings of a label reference. */
function asLabelRef(ref: string | LabelRef): LabelRef {
  return typeof ref === "string" ? { label: ref, addend: 0 } : ref;
}

interface Fixup {
  /** Byte offset of the field to patch. */
  at: number;
  kind: "abs16" | "byte8" | "low8" | "high8" | "rel8";
  ref: LabelRef;
  /** Address of the instruction after the operand — for relative branches. */
  next: number;
}

/**
 * A growable code buffer with labels, for the 6502.
 *
 * `origin` is where byte zero lives in the address space. A NROM cartridge's
 * program is at `$8000`, so that is what a backend passes, and every absolute
 * reference then resolves without the caller doing base arithmetic.
 */
export class Asm6502 {
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
   * The single entry point every named method below funnels through, so the
   * mode check and the operand encoding exist once. An unsupported
   * mnemonic-and-mode pair raises rather than encoding something else.
   */
  op(mnemonic: Mnemonic, operand: Operand = { mode: "imp", value: 0 }): this {
    const opcode = OPCODES[mnemonic][operand.mode];
    if (opcode === undefined) {
      throw new AsmError(`${mnemonic} has no ${operand.mode} addressing mode`);
    }
    return this.encode(opcode, operand);
  }

  /**
   * Emit an opcode already chosen, and the operand its mode calls for.
   *
   * `protected` because {@link Mnemonic} is this CPU's list and a superset of it
   * is a subclass's — the HuC6280 has fifty-odd instructions a 6502 does not
   * (`asm/huc6280.ts`). What is shared is the operand encoding, the fixup list
   * and the branch-range check, and sharing them is what makes one `codegen`
   * value layer serve both machines.
   */
  protected encode(opcode: number, operand: Operand): this {
    this.db(opcode);
    switch (OPERAND_BYTES[operand.mode]) {
      case 0:
        return this;
      case 2:
        this.word(operand.value as Ref);
        return this;
      default:
        if (operand.mode === "rel") this.relative(operand.value as Ref);
        else if (operand.mode === "imm") this.immediate(operand.value as Imm);
        else this.byte(operand.value as Ref);
        return this;
    }
  }

  /**
   * The operand encoders, `protected` for the same reason {@link encode} is.
   *
   * A HuC6280 instruction can put an immediate *before* an address (`tst`) or a
   * zero-page byte before a branch offset (`bbr`), neither of which is a mode in
   * {@link Mode} — so the subclass lays those out itself and needs the pieces.
   * `relative` in particular: its range check and its fixup are what stop a
   * three-byte instruction's branch landing one byte out.
   */
  protected word(value: Ref): void {
    if (typeof value === "number") {
      this.db(value, value >> 8);
      return;
    }
    this.fixups.push({ at: this.code.length, kind: "abs16", ref: asLabelRef(value), next: 0 });
    this.db(0, 0);
  }

  protected byte(value: Ref): void {
    if (typeof value === "number") {
      if (value > 0xff || value < 0) {
        throw new AsmError(`$${value.toString(16)} is not a zero-page address`);
      }
      this.db(value);
      return;
    }
    this.fixups.push({ at: this.code.length, kind: "byte8", ref: asLabelRef(value), next: 0 });
    this.db(0);
  }

  protected immediate(value: Imm): void {
    if (typeof value === "number") {
      this.db(value);
      return;
    }
    const kind = value.half === "low" ? "low8" : "high8";
    if (typeof value.ref === "number") {
      this.db(value.half === "low" ? value.ref & 0xff : (value.ref >> 8) & 0xff);
      return;
    }
    this.fixups.push({ at: this.code.length, kind, ref: asLabelRef(value.ref), next: 0 });
    this.db(0);
  }

  protected relative(target: Ref): void {
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

  // --- named forms -----------------------------------------------------------
  //
  // One method per mnemonic, taking the operand. Thin by design: they exist so a
  // call site reads like assembly (`asm.lda(abs(base))`) and so a typo is a type
  // error rather than a string that encodes something.

  adc(operand: Operand): this {
    return this.op("adc", operand);
  }
  and(operand: Operand): this {
    return this.op("and", operand);
  }
  asl(operand: Operand = acc): this {
    return this.op("asl", operand);
  }
  bit(operand: Operand): this {
    return this.op("bit", operand);
  }
  cmp(operand: Operand): this {
    return this.op("cmp", operand);
  }
  cpx(operand: Operand): this {
    return this.op("cpx", operand);
  }
  cpy(operand: Operand): this {
    return this.op("cpy", operand);
  }
  dec(operand: Operand): this {
    return this.op("dec", operand);
  }
  eor(operand: Operand): this {
    return this.op("eor", operand);
  }
  inc(operand: Operand): this {
    return this.op("inc", operand);
  }
  jmp(target: Ref): this {
    return this.op("jmp", abs(target));
  }
  jmpInd(target: Ref): this {
    return this.op("jmp", ind(target));
  }
  jsr(target: Ref): this {
    return this.op("jsr", abs(target));
  }
  lda(operand: Operand): this {
    return this.op("lda", operand);
  }
  ldx(operand: Operand): this {
    return this.op("ldx", operand);
  }
  ldy(operand: Operand): this {
    return this.op("ldy", operand);
  }
  lsr(operand: Operand = acc): this {
    return this.op("lsr", operand);
  }
  ora(operand: Operand): this {
    return this.op("ora", operand);
  }
  rol(operand: Operand = acc): this {
    return this.op("rol", operand);
  }
  ror(operand: Operand = acc): this {
    return this.op("ror", operand);
  }
  sbc(operand: Operand): this {
    return this.op("sbc", operand);
  }
  sta(operand: Operand): this {
    return this.op("sta", operand);
  }
  stx(operand: Operand): this {
    return this.op("stx", operand);
  }
  sty(operand: Operand): this {
    return this.op("sty", operand);
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

  // Implied.
  brk(): this {
    return this.op("brk");
  }
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
  php(): this {
    return this.op("php");
  }
  pla(): this {
    return this.op("pla");
  }
  plp(): this {
    return this.op("plp");
  }
  rti(): this {
    return this.op("rti");
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
  tax(): this {
    return this.op("tax");
  }
  tay(): this {
    return this.op("tay");
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
  tya(): this {
    return this.op("tya");
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
        case "byte8":
          if (value > 0xff || value < 0) {
            throw new AsmError(
              `'${fixup.ref.label}' is $${value.toString(16)}, not a zero-page address`,
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

  /** Every label and its address — the map a profiler or a harness reads. */
  symbols(): ReadonlyMap<string, number> {
    return new Map(this.labels);
  }
}
