/**
 * An SM83 assembler.
 *
 * Two backends emit Game Boy *machine code* rather than shelling out to RGBDS —
 * the Demotic game backend (doc 14 §Runtime model) and the audio driver
 * (doc 16 §The driver contract) — so the encoder lives here, in `core`, where
 * both reach it and neither owns it. Both halves of that are load-bearing:
 *
 *   - **Machine code, because the machine is small.** A game's entities are
 *     known at compile time, so every property is a constant address; a rule's
 *     subject is usually one object, so its collision test is straight-line
 *     code; a feature no game uses emits no bytes at all. A track with no noise
 *     channel ships no noise handling, for the same reason. An interpreter can
 *     do none of that — it pays the general case on every tick of every input.
 *   - **In TypeScript, because the browser has no assembler.** Doc 07 wants the
 *     page to build the same ROM the CLI builds, byte for byte, with nothing
 *     installed. Owning the encoder is what makes that a fact rather than an
 *     aspiration.
 *
 * It is pure integer arithmetic over a byte array, so it sits inside `core`'s
 * platform-purity and determinism rules without qualification.
 *
 * The design is deliberately dull: one method per addressing form, explicit
 * encodings, and a fixup list for forward references. There is no macro layer
 * and no peephole pass here — optimisation belongs in the code generator, where
 * it can see what the code *means*.
 *
 * Every instruction's length is fixed by the method that emits it, so one pass
 * plus a fixup sweep is enough; nothing relaxes, and an address never moves
 * under a reference that was already resolved.
 */

/** A byte-8 register, in opcode order. `hlp` is the `[hl]` memory form. */
export type R8 = "b" | "c" | "d" | "e" | "h" | "l" | "hlp" | "a";

/** A 16-bit register pair. */
export type R16 = "bc" | "de" | "hl" | "sp";

/** A branch condition. */
export type CC = "nz" | "z" | "nc" | "c";

/** One of the eight ALU operations, in opcode order. */
export type AluOp = "add" | "adc" | "sub" | "sbc" | "and" | "xor" | "or" | "cp";

/** A rotate/shift operation from the `CB` page, in opcode order. */
export type ShiftOp = "rlc" | "rrc" | "rl" | "rr" | "sla" | "sra" | "swap" | "srl";

/**
 * An address operand: a resolved number, a label by name, or a label plus an
 * offset.
 *
 * The bare string form is what almost every call site wants — a jump target —
 * and the record form carries an addend so `label("Table", 4)` is expressible
 * without a second concept.
 */
export type Ref = number | string | LabelRef;

/** A reference to a label, plus an offset from it. */
export interface LabelRef {
  readonly label: string;
  readonly addend: number;
}

const R8_CODE: Readonly<Record<R8, number>> = {
  b: 0,
  c: 1,
  d: 2,
  e: 3,
  h: 4,
  l: 5,
  hlp: 6,
  a: 7,
};

const R16_CODE: Readonly<Record<R16, number>> = { bc: 0, de: 1, hl: 2, sp: 3 };
const CC_CODE: Readonly<Record<CC, number>> = { nz: 0, z: 1, nc: 2, c: 3 };
const ALU_CODE: Readonly<Record<AluOp, number>> = {
  add: 0,
  adc: 1,
  sub: 2,
  sbc: 3,
  and: 4,
  xor: 5,
  or: 6,
  cp: 7,
};
const SHIFT_CODE: Readonly<Record<ShiftOp, number>> = {
  rlc: 0,
  rrc: 1,
  rl: 2,
  rr: 3,
  sla: 4,
  sra: 5,
  swap: 6,
  srl: 7,
};

/** Reference a label, optionally offset from it. */
export function label(name: string, addend = 0): LabelRef {
  return { label: name, addend };
}

/** Raised when a program cannot be encoded — a bad operand or a missing label. */
export class AsmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsmError";
  }
}

/** Normalise the three spellings of a label reference. */
function asLabelRef(ref: string | LabelRef): LabelRef {
  return typeof ref === "string" ? { label: ref, addend: 0 } : ref;
}

interface Fixup {
  /** Byte offset of the field to patch. */
  at: number;
  kind: "abs16" | "abs8" | "rel8";
  ref: LabelRef;
  /** Address of the instruction after the operand — for relative branches. */
  next: number;
}

/**
 * A growable code buffer with labels.
 *
 * `origin` is where byte zero lives in the address space, so absolute
 * references resolve without the caller doing base arithmetic.
 */
export class Asm {
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

  // --- operand helpers -------------------------------------------------------

  private imm8(value: Ref): void {
    if (typeof value === "number") {
      this.db(value);
      return;
    }
    this.fixups.push({ at: this.code.length, kind: "abs8", ref: asLabelRef(value), next: 0 });
    this.db(0);
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
    const at = this.code.length;
    this.db(0);
    const next = this.pc;
    if (typeof target === "number") {
      const delta = target - next;
      if (delta < -128 || delta > 127) {
        throw new AsmError(`relative branch out of range: ${delta}`);
      }
      this.code[at] = delta & 0xff;
      return;
    }
    this.fixups.push({ at, kind: "rel8", ref: asLabelRef(target), next });
  }

  // --- 8-bit loads -----------------------------------------------------------

  /** `ld dst, src` — the 0x40..0x7F block. `ld hlp, hlp` would be `halt`. */
  ld(dst: R8, src: R8): this {
    if (dst === "hlp" && src === "hlp") throw new AsmError("ld [hl],[hl] is halt");
    return this.db(0x40 | (R8_CODE[dst] << 3) | R8_CODE[src]);
  }

  /** `ld r, n`. */
  ldn(dst: R8, value: Ref): this {
    this.db(0x06 | (R8_CODE[dst] << 3));
    this.imm8(value);
    return this;
  }

  /** `ld a, [nn]`. */
  lda(address: Ref): this {
    this.db(0xfa);
    this.imm16(address);
    return this;
  }

  /** `ld [nn], a`. */
  sta(address: Ref): this {
    this.db(0xea);
    this.imm16(address);
    return this;
  }

  /** `ldh a, [$FF00+n]`. */
  ldha(low: Ref): this {
    this.db(0xf0);
    this.imm8(low);
    return this;
  }

  /** `ldh [$FF00+n], a`. */
  stha(low: Ref): this {
    this.db(0xe0);
    this.imm8(low);
    return this;
  }

  /** `ld a, [c]` / `ld [c], a`. */
  ldaC(): this {
    return this.db(0xf2);
  }
  staC(): this {
    return this.db(0xe2);
  }

  /** `ld a, [bc]` / `ld a, [de]`. */
  ldaBC(): this {
    return this.db(0x0a);
  }
  ldaDE(): this {
    return this.db(0x1a);
  }
  /** `ld [bc], a` / `ld [de], a`. */
  staBC(): this {
    return this.db(0x02);
  }
  staDE(): this {
    return this.db(0x12);
  }

  /** `ld a, [hl+]`, `ld a, [hl-]`, `ld [hl+], a`, `ld [hl-], a`. */
  ldaHLI(): this {
    return this.db(0x2a);
  }
  ldaHLD(): this {
    return this.db(0x3a);
  }
  staHLI(): this {
    return this.db(0x22);
  }
  staHLD(): this {
    return this.db(0x32);
  }

  // --- 16-bit loads ----------------------------------------------------------

  /** `ld rr, nn`. */
  ld16(pair: R16, value: Ref): this {
    this.db(0x01 | (R16_CODE[pair] << 4));
    this.imm16(value);
    return this;
  }

  /** `ld [nn], sp`. */
  stSP(address: Ref): this {
    this.db(0x08);
    this.imm16(address);
    return this;
  }

  /** `ld sp, hl`. */
  ldSPHL(): this {
    return this.db(0xf9);
  }

  push(pair: R16 | "af"): this {
    const code = pair === "af" ? 3 : R16_CODE[pair];
    return this.db(0xc5 | (code << 4));
  }

  pop(pair: R16 | "af"): this {
    const code = pair === "af" ? 3 : R16_CODE[pair];
    return this.db(0xc1 | (code << 4));
  }

  // --- arithmetic ------------------------------------------------------------

  /** `<op> a, r`. */
  alu(op: AluOp, src: R8): this {
    return this.db(0x80 | (ALU_CODE[op] << 3) | R8_CODE[src]);
  }

  /** `<op> a, n`. */
  aluN(op: AluOp, value: Ref): this {
    this.db(0xc6 | (ALU_CODE[op] << 3));
    this.imm8(value);
    return this;
  }

  inc(reg: R8): this {
    return this.db(0x04 | (R8_CODE[reg] << 3));
  }

  dec(reg: R8): this {
    return this.db(0x05 | (R8_CODE[reg] << 3));
  }

  inc16(pair: R16): this {
    return this.db(0x03 | (R16_CODE[pair] << 4));
  }

  dec16(pair: R16): this {
    return this.db(0x0b | (R16_CODE[pair] << 4));
  }

  /** `add hl, rr`. */
  addHL(pair: R16): this {
    return this.db(0x09 | (R16_CODE[pair] << 4));
  }

  /** `add sp, e` (signed). */
  addSP(offset: number): this {
    return this.db(0xe8, offset & 0xff);
  }

  /** `ld hl, sp+e` (signed). */
  ldHLSP(offset: number): this {
    return this.db(0xf8, offset & 0xff);
  }

  // --- rotates, shifts, bits -------------------------------------------------

  rlca(): this {
    return this.db(0x07);
  }
  rrca(): this {
    return this.db(0x0f);
  }
  rla(): this {
    return this.db(0x17);
  }
  rra(): this {
    return this.db(0x1f);
  }
  daa(): this {
    return this.db(0x27);
  }
  cpl(): this {
    return this.db(0x2f);
  }
  scf(): this {
    return this.db(0x37);
  }
  ccf(): this {
    return this.db(0x3f);
  }

  /** A `CB`-page shift or rotate. */
  shift(op: ShiftOp, reg: R8): this {
    return this.db(0xcb, (SHIFT_CODE[op] << 3) | R8_CODE[reg]);
  }

  bit(index: number, reg: R8): this {
    return this.db(0xcb, 0x40 | (index << 3) | R8_CODE[reg]);
  }

  res(index: number, reg: R8): this {
    return this.db(0xcb, 0x80 | (index << 3) | R8_CODE[reg]);
  }

  set(index: number, reg: R8): this {
    return this.db(0xcb, 0xc0 | (index << 3) | R8_CODE[reg]);
  }

  // --- control flow ----------------------------------------------------------

  /** `jp nn`, or `jp cc, nn` when a condition is given. */
  jp(target: Ref, cc?: CC): this {
    this.db(cc === undefined ? 0xc3 : 0xc2 | (CC_CODE[cc] << 3));
    this.imm16(target);
    return this;
  }

  /** `jp hl`. */
  jpHL(): this {
    return this.db(0xe9);
  }

  /** `jr e`, or `jr cc, e`. */
  jr(target: Ref, cc?: CC): this {
    this.db(cc === undefined ? 0x18 : 0x20 | (CC_CODE[cc] << 3));
    this.rel8(target);
    return this;
  }

  call(target: Ref, cc?: CC): this {
    this.db(cc === undefined ? 0xcd : 0xc4 | (CC_CODE[cc] << 3));
    this.imm16(target);
    return this;
  }

  ret(cc?: CC): this {
    return this.db(cc === undefined ? 0xc9 : 0xc0 | (CC_CODE[cc] << 3));
  }

  reti(): this {
    return this.db(0xd9);
  }

  rst(vector: number): this {
    if ((vector & 0x38) !== vector) throw new AsmError(`bad rst vector $${vector.toString(16)}`);
    return this.db(0xc7 | vector);
  }

  nop(): this {
    return this.db(0x00);
  }
  halt(): this {
    return this.db(0x76);
  }
  stop(): this {
    return this.db(0x10, 0x00);
  }
  di(): this {
    return this.db(0xf3);
  }
  ei(): this {
    return this.db(0xfb);
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
        case "abs8":
          this.code[fixup.at] = value & 0xff;
          break;
        case "rel8": {
          const delta = value - fixup.next;
          if (delta < -128 || delta > 127) {
            throw new AsmError(
              `relative branch to '${fixup.ref.label}' is ${delta} bytes away; use jp`,
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
