/**
 * A Zilog Z80 assembler.
 *
 * The third of `core`'s encoders, and it exists for the reasons the other two
 * do (`asm/sm83.ts`, `asm/mos6502.ts`, doc 14 §Runtime model): a game compiles
 * to machine code because the machine is small, and the encoder is TypeScript
 * because the browser has no assembler. What is new here is how much of a
 * *family* one encoder buys — the Master System, the Game Gear and the SG-1000
 * are one CPU, so this file is the whole of the instruction-set difference
 * between three consoles.
 *
 * The Game Boy's SM83 is a Z80 with pieces removed and a few of its own added,
 * so the two files look alike in the middle and diverge at both ends. Sharing
 * one encoder between them was considered and rejected: the overlap is the
 * *encoding table*, not the instruction set, and a class whose every method had
 * to ask which machine it was on would make the differences invisible at exactly
 * the sites where they matter. What is shared is what genuinely is common —
 * {@link Ref}, {@link AsmError} and the fixup discipline, imported from
 * `sm83.ts` rather than restated.
 *
 * The four things a Z80 has that an SM83 does not, and that the backend uses:
 *
 *   - **Eight branch conditions**, not four. `po`/`pe` read the parity/overflow
 *     flag, which after an 8-bit `sub` or `cp` is *signed overflow* — the flag a
 *     16.16 comparison needs and the one the Game Boy backend has to synthesise.
 *   - **`ix`/`iy`**, two index registers with a signed displacement. An entity
 *     record is a fixed layout at a computed base, which is exactly what an
 *     index register addresses in one instruction.
 *   - **`adc hl,rr` and `sbc hl,rr`**, so sixteen bits of a 16.16 value add in
 *     one instruction instead of four.
 *   - **`in`/`out`**, because the VDP and the sound chip are on ports here, not
 *     in the address space.
 *
 * Two hazards this file makes loud rather than silent, both inherited:
 *
 *   - **`jr` reaches ±128 bytes** and a generated rule body does not, so an
 *     out-of-range relative jump is an {@link AsmError} rather than a wrap. The
 *     backend uses `jp` for anything a caller handed it.
 *   - **A displacement is signed and eight bits.** `(ix+d)` cannot reach past
 *     127 bytes from the base, which is a real limit on how large an entity
 *     record may be; it is checked here rather than truncated.
 *
 * Sources: Zilog — Z80 CPU User Manual (UM0080, the opcode tables in §6) and
 * ClrHome's Z80 opcode table (http://clrhome.org/table/).
 */

import { AsmError, label, type LabelRef, type Ref } from "./sm83.js";

export { AsmError, label };
export type { LabelRef, Ref };

/** An 8-bit register, in opcode order. `hlp` is the `(hl)` memory form. */
export type Z80R8 = "b" | "c" | "d" | "e" | "h" | "l" | "hlp" | "a";

/** A 16-bit register pair, in opcode order. */
export type Z80R16 = "bc" | "de" | "hl" | "sp";

/**
 * A branch condition, in opcode order.
 *
 * `po`/`pe` are the parity/overflow flag, which arithmetic sets to signed
 * overflow: after `cp`, `pe` means the subtraction overflowed, and `sign xor
 * overflow` is the signed less-than the backend's comparisons are built on.
 */
export type Z80CC = "nz" | "z" | "nc" | "c" | "po" | "pe" | "p" | "m";

/** The four conditions a *relative* jump can take. */
export type Z80JrCC = "nz" | "z" | "nc" | "c";

/** One of the eight ALU operations, in opcode order. */
export type Z80AluOp = "add" | "adc" | "sub" | "sbc" | "and" | "xor" | "or" | "cp";

/**
 * A rotate/shift operation from the `CB` page, in opcode order.
 *
 * `sll` sits where the SM83 puts `swap`. It is undocumented on real silicon but
 * uniformly implemented (it shifts left and sets bit 0); the backend does not
 * emit it, and it is here so the table is the hardware's rather than a subset
 * someone has to check against a manual later.
 */
export type Z80ShiftOp = "rlc" | "rrc" | "rl" | "rr" | "sla" | "sra" | "sll" | "srl";

/** An index register: the `DD` and `FD` prefixes. */
export type Z80Index = "ix" | "iy";

/**
 * An immediate byte: a value, or one half of an address not resolved yet.
 *
 * A Z80 program loads a pointer as two immediates, so the low and high halves of
 * a label have to be expressible before the label exists — the same problem the
 * 6502's `#<label` solves, and the same shape of answer. A bare {@link Ref} is
 * deliberately *not* accepted where a byte is wanted: "the low byte of this
 * label" and "this label" are different things, and inferring one from a string
 * is how a fixup silently truncates.
 */
export type Imm8 = number | { readonly half: "low" | "high"; readonly ref: Ref };

/** `low(label)` — the low byte of an address. */
export function lowByte(ref: Ref): Imm8 {
  return typeof ref === "number" ? ref & 0xff : { half: "low", ref };
}

/** `high(label)` — the high byte of an address. */
export function highByte(ref: Ref): Imm8 {
  return typeof ref === "number" ? (ref >> 8) & 0xff : { half: "high", ref };
}

const R8_CODE: Readonly<Record<Z80R8, number>> = {
  b: 0,
  c: 1,
  d: 2,
  e: 3,
  h: 4,
  l: 5,
  hlp: 6,
  a: 7,
};

const R16_CODE: Readonly<Record<Z80R16, number>> = { bc: 0, de: 1, hl: 2, sp: 3 };

const CC_CODE: Readonly<Record<Z80CC, number>> = {
  nz: 0,
  z: 1,
  nc: 2,
  c: 3,
  po: 4,
  pe: 5,
  p: 6,
  m: 7,
};

const ALU_CODE: Readonly<Record<Z80AluOp, number>> = {
  add: 0,
  adc: 1,
  sub: 2,
  sbc: 3,
  and: 4,
  xor: 5,
  or: 6,
  cp: 7,
};

const SHIFT_CODE: Readonly<Record<Z80ShiftOp, number>> = {
  rlc: 0,
  rrc: 1,
  rl: 2,
  rr: 3,
  sla: 4,
  sra: 5,
  sll: 6,
  srl: 7,
};

/** The prefix byte an index register is selected by. */
const INDEX_PREFIX: Readonly<Record<Z80Index, number>> = { ix: 0xdd, iy: 0xfd };

/** Normalise the two spellings of a label reference. */
function asLabelRef(ref: string | LabelRef): LabelRef {
  return typeof ref === "string" ? { label: ref, addend: 0 } : ref;
}

interface Fixup {
  /** Byte offset of the field to patch. */
  at: number;
  kind: "abs16" | "abs8" | "low8" | "high8" | "rel8";
  ref: LabelRef;
  /** Address of the instruction after the operand — for relative branches. */
  next: number;
}

/**
 * A growable code buffer with labels, for the Z80.
 *
 * `origin` is where byte zero lives in the address space. A Master System
 * cartridge's first bank is at `$0000`, so that is what the backend passes and
 * every absolute reference resolves without the caller doing base arithmetic.
 *
 * Every instruction's length is fixed by the method that emits it, so one pass
 * plus a fixup sweep is enough; nothing relaxes, and an address never moves
 * under a reference that was already resolved.
 *
 * ## Slots
 *
 * A Sega cartridge past 48 KiB is *paged*: slots 0 and 1 are the first two banks
 * and never move, and slot 2 shows whichever bank `$FFFF` names. So a program
 * that outgrows the flat image is emitted in pieces that live at two different
 * addresses — the fixed half at `$0000` and each paged bank at `$8000` — and
 * {@link section} is how a caller says which. It changes what an address *means*
 * and moves no bytes; the image stays one linear buffer and the backend copies
 * each 16 KiB chunk to the bank its plan named.
 *
 * Unlike the 65816's, a label here does **not** carry its bank: a Z80 address is
 * sixteen bits and that is all the hardware has. Which bank a paged routine is in
 * is the *caller's* to know, because reaching it means writing `$FFFF` first —
 * so the emitter carries the plan and this class carries only the address.
 */
export class AsmZ80 {
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
   * Continue at `address`, which is where the next byte will be *seen*.
   *
   * For a cartridge whose pieces are mapped at different addresses (§Slots). It
   * moves no bytes: a caller that wants a bank boundary in the image pads to it
   * first, because only the caller knows how big a bank is on its console.
   */
  section(address: number): this {
    this.base = address;
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

  private imm8(value: Imm8): void {
    if (typeof value === "number") {
      this.db(value);
      return;
    }
    if (typeof value.ref === "number") {
      this.db(value.half === "low" ? value.ref & 0xff : (value.ref >> 8) & 0xff);
      return;
    }
    this.fixups.push({
      at: this.code.length,
      kind: value.half === "low" ? "low8" : "high8",
      ref: asLabelRef(value.ref),
      next: 0,
    });
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

  /**
   * The signed byte an `(ix+d)` operand carries.
   *
   * Checked rather than masked: a record that outgrew the displacement is a real
   * limit on the backend's memory plan, and it should say so at the emit site
   * instead of addressing something 256 bytes away.
   */
  private disp(offset: number): void {
    if (offset < -128 || offset > 127) {
      throw new AsmError(`index displacement ${offset} does not fit in a signed byte`);
    }
    this.db(offset & 0xff);
  }

  // --- 8-bit loads -----------------------------------------------------------

  /** `ld dst, src` — the 0x40..0x7F block. `ld (hl),(hl)` would be `halt`. */
  ld(dst: Z80R8, src: Z80R8): this {
    if (dst === "hlp" && src === "hlp") throw new AsmError("ld (hl),(hl) is halt");
    return this.db(0x40 | (R8_CODE[dst] << 3) | R8_CODE[src]);
  }

  /** `ld r, n`. */
  ldn(dst: Z80R8, value: Imm8): this {
    this.db(0x06 | (R8_CODE[dst] << 3));
    this.imm8(value);
    return this;
  }

  /** `ld a, (nn)`. */
  lda(address: Ref): this {
    this.db(0x3a);
    this.imm16(address);
    return this;
  }

  /** `ld (nn), a`. */
  sta(address: Ref): this {
    this.db(0x32);
    this.imm16(address);
    return this;
  }

  /** `ld a, (bc)` / `ld a, (de)`. */
  ldaBC(): this {
    return this.db(0x0a);
  }
  ldaDE(): this {
    return this.db(0x1a);
  }
  /** `ld (bc), a` / `ld (de), a`. */
  staBC(): this {
    return this.db(0x02);
  }
  staDE(): this {
    return this.db(0x12);
  }

  /** `ld a, i` / `ld a, r` and their stores — the `ED` page's odd corner. */
  ldAI(): this {
    return this.db(0xed, 0x57);
  }
  ldIA(): this {
    return this.db(0xed, 0x47);
  }
  ldAR(): this {
    return this.db(0xed, 0x5f);
  }
  ldRA(): this {
    return this.db(0xed, 0x4f);
  }

  // --- indexed loads ---------------------------------------------------------

  /** `ld r, (ix+d)`. */
  ldIdx(dst: Z80R8, index: Z80Index, offset: number): this {
    if (dst === "hlp") throw new AsmError("ld (hl),(ix+d) does not exist");
    this.db(INDEX_PREFIX[index], 0x46 | (R8_CODE[dst] << 3));
    this.disp(offset);
    return this;
  }

  /** `ld (ix+d), r`. */
  stIdx(index: Z80Index, offset: number, src: Z80R8): this {
    if (src === "hlp") throw new AsmError("ld (ix+d),(hl) does not exist");
    this.db(INDEX_PREFIX[index], 0x70 | R8_CODE[src]);
    this.disp(offset);
    return this;
  }

  /** `ld (ix+d), n` — the one instruction with a displacement *and* an immediate. */
  stIdxN(index: Z80Index, offset: number, value: Imm8): this {
    this.db(INDEX_PREFIX[index], 0x36);
    this.disp(offset);
    this.imm8(value);
    return this;
  }

  /** `inc (ix+d)` / `dec (ix+d)`. */
  incIdx(index: Z80Index, offset: number): this {
    this.db(INDEX_PREFIX[index], 0x34);
    this.disp(offset);
    return this;
  }
  decIdx(index: Z80Index, offset: number): this {
    this.db(INDEX_PREFIX[index], 0x35);
    this.disp(offset);
    return this;
  }

  /** `<op> a, (ix+d)`. */
  aluIdx(op: Z80AluOp, index: Z80Index, offset: number): this {
    this.db(INDEX_PREFIX[index], 0x86 | (ALU_CODE[op] << 3));
    this.disp(offset);
    return this;
  }

  // --- 16-bit loads ----------------------------------------------------------

  /** `ld rr, nn`. */
  ld16(pair: Z80R16, value: Ref): this {
    this.db(0x01 | (R16_CODE[pair] << 4));
    this.imm16(value);
    return this;
  }

  /** `ld ix, nn`. */
  ld16Idx(index: Z80Index, value: Ref): this {
    this.db(INDEX_PREFIX[index], 0x21);
    this.imm16(value);
    return this;
  }

  /**
   * `ld rr, (nn)`.
   *
   * `hl` has a one-byte opcode of its own from the original 8080; every other
   * pair goes through the `ED` page. Emitting the short form for `hl` is not an
   * optimisation the caller has to ask for, because there is no case where the
   * long one would be wanted.
   */
  ld16From(pair: Z80R16, address: Ref): this {
    if (pair === "hl") this.db(0x2a);
    else this.db(0xed, 0x4b | (R16_CODE[pair] << 4));
    this.imm16(address);
    return this;
  }

  /** `ld (nn), rr`. */
  st16To(address: Ref, pair: Z80R16): this {
    if (pair === "hl") this.db(0x22);
    else this.db(0xed, 0x43 | (R16_CODE[pair] << 4));
    this.imm16(address);
    return this;
  }

  /** `ld ix, (nn)` / `ld (nn), ix`. */
  ld16IdxFrom(index: Z80Index, address: Ref): this {
    this.db(INDEX_PREFIX[index], 0x2a);
    this.imm16(address);
    return this;
  }
  st16IdxTo(address: Ref, index: Z80Index): this {
    this.db(INDEX_PREFIX[index], 0x22);
    this.imm16(address);
    return this;
  }

  /** `ld sp, hl` / `ld sp, ix`. */
  ldSPHL(): this {
    return this.db(0xf9);
  }
  ldSPIdx(index: Z80Index): this {
    return this.db(INDEX_PREFIX[index], 0xf9);
  }

  push(pair: Z80R16 | "af"): this {
    return this.db(0xc5 | ((pair === "af" ? 3 : R16_CODE[pair]) << 4));
  }

  pop(pair: Z80R16 | "af"): this {
    return this.db(0xc1 | ((pair === "af" ? 3 : R16_CODE[pair]) << 4));
  }

  pushIdx(index: Z80Index): this {
    return this.db(INDEX_PREFIX[index], 0xe5);
  }
  popIdx(index: Z80Index): this {
    return this.db(INDEX_PREFIX[index], 0xe1);
  }

  // --- exchanges -------------------------------------------------------------

  /** `ex de, hl` — the cheapest way to move a whole pointer. */
  exDEHL(): this {
    return this.db(0xeb);
  }
  /** `ex af, af'`. */
  exAF(): this {
    return this.db(0x08);
  }
  /** `exx` — swap `bc`/`de`/`hl` with their shadows. */
  exx(): this {
    return this.db(0xd9);
  }
  /** `ex (sp), hl`. */
  exSPHL(): this {
    return this.db(0xe3);
  }
  /** `ex (sp), ix`. */
  exSPIdx(index: Z80Index): this {
    return this.db(INDEX_PREFIX[index], 0xe3);
  }

  // --- arithmetic ------------------------------------------------------------

  /** `<op> a, r`. */
  alu(op: Z80AluOp, src: Z80R8): this {
    return this.db(0x80 | (ALU_CODE[op] << 3) | R8_CODE[src]);
  }

  /** `<op> a, n`. */
  aluN(op: Z80AluOp, value: Imm8): this {
    this.db(0xc6 | (ALU_CODE[op] << 3));
    this.imm8(value);
    return this;
  }

  inc(reg: Z80R8): this {
    return this.db(0x04 | (R8_CODE[reg] << 3));
  }

  dec(reg: Z80R8): this {
    return this.db(0x05 | (R8_CODE[reg] << 3));
  }

  inc16(pair: Z80R16): this {
    return this.db(0x03 | (R16_CODE[pair] << 4));
  }

  dec16(pair: Z80R16): this {
    return this.db(0x0b | (R16_CODE[pair] << 4));
  }

  inc16Idx(index: Z80Index): this {
    return this.db(INDEX_PREFIX[index], 0x23);
  }
  dec16Idx(index: Z80Index): this {
    return this.db(INDEX_PREFIX[index], 0x2b);
  }

  /** `add hl, rr` — does not touch the zero flag. */
  addHL(pair: Z80R16): this {
    return this.db(0x09 | (R16_CODE[pair] << 4));
  }

  /**
   * `adc hl, rr` / `sbc hl, rr` — sixteen bits with a carry, and a zero flag.
   *
   * The instructions a 16.16 value is added and subtracted with: two of these
   * carry a whole 32-bit operation, where the SM83 needs eight `adc`s and the
   * 6502 four. They set S/Z/V from the 16-bit result, which is also what makes a
   * signed comparison one instruction rather than a sequence.
   */
  adcHL(pair: Z80R16): this {
    return this.db(0xed, 0x4a | (R16_CODE[pair] << 4));
  }
  sbcHL(pair: Z80R16): this {
    return this.db(0xed, 0x42 | (R16_CODE[pair] << 4));
  }

  /** `add ix, rr` — where `rr` names `ix` itself when the pair is `hl`. */
  addIdx(index: Z80Index, pair: Z80R16): this {
    return this.db(INDEX_PREFIX[index], 0x09 | (R16_CODE[pair] << 4));
  }

  /** `neg` — negate the accumulator. */
  neg(): this {
    return this.db(0xed, 0x44);
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
  shift(op: Z80ShiftOp, reg: Z80R8): this {
    return this.db(0xcb, (SHIFT_CODE[op] << 3) | R8_CODE[reg]);
  }

  /** `<op> (ix+d)` — the `DD CB d op` form, displacement *before* the opcode. */
  shiftIdx(op: Z80ShiftOp, index: Z80Index, offset: number): this {
    this.db(INDEX_PREFIX[index], 0xcb);
    this.disp(offset);
    return this.db((SHIFT_CODE[op] << 3) | 0x06);
  }

  bit(index: number, reg: Z80R8): this {
    return this.db(0xcb, 0x40 | (index << 3) | R8_CODE[reg]);
  }

  res(index: number, reg: Z80R8): this {
    return this.db(0xcb, 0x80 | (index << 3) | R8_CODE[reg]);
  }

  set(index: number, reg: Z80R8): this {
    return this.db(0xcb, 0xc0 | (index << 3) | R8_CODE[reg]);
  }

  /** `bit n, (ix+d)` and its two siblings. */
  bitIdx(bit: number, index: Z80Index, offset: number): this {
    this.db(INDEX_PREFIX[index], 0xcb);
    this.disp(offset);
    return this.db(0x46 | (bit << 3));
  }
  resIdx(bit: number, index: Z80Index, offset: number): this {
    this.db(INDEX_PREFIX[index], 0xcb);
    this.disp(offset);
    return this.db(0x86 | (bit << 3));
  }
  setIdx(bit: number, index: Z80Index, offset: number): this {
    this.db(INDEX_PREFIX[index], 0xcb);
    this.disp(offset);
    return this.db(0xc6 | (bit << 3));
  }

  // --- block operations ------------------------------------------------------

  /**
   * `ldir` and its family: copy `bc` bytes from `(hl)` to `(de)`.
   *
   * Twenty-one clocks a byte with no loop overhead, which is what a tile upload
   * and a background block copy are written with.
   */
  ldi(): this {
    return this.db(0xed, 0xa0);
  }
  ldir(): this {
    return this.db(0xed, 0xb0);
  }
  ldd(): this {
    return this.db(0xed, 0xa8);
  }
  lddr(): this {
    return this.db(0xed, 0xb8);
  }
  cpi(): this {
    return this.db(0xed, 0xa1);
  }
  cpir(): this {
    return this.db(0xed, 0xb1);
  }

  /** `outi` / `otir` — the VDP upload loop, one byte per iteration. */
  outi(): this {
    return this.db(0xed, 0xa3);
  }
  otir(): this {
    return this.db(0xed, 0xb3);
  }
  ini(): this {
    return this.db(0xed, 0xa2);
  }
  inir(): this {
    return this.db(0xed, 0xb2);
  }

  // --- ports -----------------------------------------------------------------

  /** `out (n), a` — the port form the VDP and the PSG are addressed with. */
  outN(port: Imm8): this {
    this.db(0xd3);
    this.imm8(port);
    return this;
  }

  /** `in a, (n)`. */
  inN(port: Imm8): this {
    this.db(0xdb);
    this.imm8(port);
    return this;
  }

  /** `out (c), r` — the port number in `c`, so a loop can walk one. */
  outC(reg: Z80R8): this {
    if (reg === "hlp") throw new AsmError("out (c),(hl) does not exist");
    return this.db(0xed, 0x41 | (R8_CODE[reg] << 3));
  }

  /** `in r, (c)`. */
  inC(reg: Z80R8): this {
    if (reg === "hlp") throw new AsmError("in (hl),(c) does not exist");
    return this.db(0xed, 0x40 | (R8_CODE[reg] << 3));
  }

  // --- control flow ----------------------------------------------------------

  /** `jp nn`, or `jp cc, nn` when a condition is given. */
  jp(target: Ref, cc?: Z80CC): this {
    this.db(cc === undefined ? 0xc3 : 0xc2 | (CC_CODE[cc] << 3));
    this.imm16(target);
    return this;
  }

  /** `jp (hl)` — the dispatch a jump table ends with. */
  jpHL(): this {
    return this.db(0xe9);
  }

  /** `jp (ix)`. */
  jpIdx(index: Z80Index): this {
    return this.db(INDEX_PREFIX[index], 0xe9);
  }

  /** `jr e`, or `jr cc, e`. Only four conditions have a relative form. */
  jr(target: Ref, cc?: Z80JrCC): this {
    this.db(cc === undefined ? 0x18 : 0x20 | (CC_CODE[cc] << 3));
    this.rel8(target);
    return this;
  }

  /** `djnz e` — decrement `b` and branch, in one instruction. */
  djnz(target: Ref): this {
    this.db(0x10);
    this.rel8(target);
    return this;
  }

  call(target: Ref, cc?: Z80CC): this {
    this.db(cc === undefined ? 0xcd : 0xc4 | (CC_CODE[cc] << 3));
    this.imm16(target);
    return this;
  }

  ret(cc?: Z80CC): this {
    return this.db(cc === undefined ? 0xc9 : 0xc0 | (CC_CODE[cc] << 3));
  }

  /** `reti` and `retn` are two instructions here, unlike on the SM83. */
  reti(): this {
    return this.db(0xed, 0x4d);
  }
  retn(): this {
    return this.db(0xed, 0x45);
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
  di(): this {
    return this.db(0xf3);
  }
  ei(): this {
    return this.db(0xfb);
  }

  /** `im 0` / `im 1` / `im 2`. A Master System runs in mode 1. */
  im(mode: 0 | 1 | 2): this {
    return this.db(0xed, mode === 0 ? 0x46 : mode === 1 ? 0x56 : 0x5e);
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
