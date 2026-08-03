/**
 * A HuC6280 assembler: the PC Engine's CPU, which is a 6502 with three habits.
 *
 * The sixth encoder here and the first that is a *superset* rather than a new
 * instruction set. {@link Asm6280} extends {@link Asm6502} rather than restating
 * it, and that inheritance is load-bearing in exactly one place: the Demotic
 * value layer — 16.16 arithmetic, expressions, rule bodies, the tile walk — is
 * written against `Asm6502` and is shared verbatim by both consoles
 * (`demotic/src/codegen/mos/`). A second table with the same two hundred rows in
 * it would be two places for the shift-and-subtract divider's opcodes to
 * disagree, and nothing would notice until a game played almost right.
 *
 * What this file adds is the difference, and it comes in three groups:
 *
 *   - **The 65C02's.** `stz`, `bra`, `phx`/`phy`/`plx`/`ply`, `inc a`/`dec a`,
 *     the unindexed `(zp)` dereference, `jmp (abs,x)`, `tsb`/`trb`, three more
 *     `bit` forms, and the Rockwell bit instructions. Ordinary instructions that
 *     happen to be absent from a 6502.
 *   - **The memory mapper's.** This CPU has a sixteen-bit address bus over a
 *     twenty-one-bit one: eight `MPR` registers each map an 8 KiB page of the
 *     visible space onto one of 256 banks, and `tam`/`tma` are how a program
 *     writes and reads them. A cartridge is banks 0 upward, work RAM is bank
 *     `$F8` and the hardware page is `$FF`, and none of them is anywhere until a
 *     `tam` puts it there — which is why a PC Engine program's first four
 *     instructions are not optional.
 *   - **The block transfer's.** `tii`/`tia`/`tai`/`tin`/`tdd` move up to 65535
 *     bytes with one instruction, and `tia src, $0002, n` is how anything
 *     reaches video RAM here: the destination stays put while the source walks,
 *     which is exactly the shape of an auto-incrementing data port. They are
 *     seven bytes each and they destroy `A`, `X` and `Y` — stated here because
 *     the datasheet does not put it where anyone reads it, and a caller that
 *     assumed otherwise loses a value rather than crashing.
 *
 * And one habit that is not an instruction at all: **zero page is at `$2000`**.
 * The CPU adds `$2000` to every zero-page operand and puts the stack in the page
 * above, so `zp($40)` addresses `$2040` and no `MPR` setting changes that. The
 * memory plan (`demotic/src/codegen/layout.ts` §`zeroPage`) is where that fact is
 * written down for the code generator; there is nothing for an assembler to do
 * about it, which is why it is a comment here rather than a translation.
 *
 * Deliberately absent, because nothing emits them and a wrong encoding nobody
 * runs is worse than no encoding at all: the `T`-flag forms of the ALU
 * instructions (`set` is here, but no emitter uses it), and decimal mode, which
 * this CPU does not implement.
 *
 * Sources: Archaic Pixels — HuC6280 instruction set; the WDC 65C02 datasheet for
 * the shared additions.
 */

import { Asm6502, AsmError, type Mnemonic, type Mode, type Operand, type Ref } from "./mos6502.js";

/** Every mnemonic this assembler adds to the 6502's. */
export type Mnemonic6280 =
  | "adc"
  | "and"
  | "bit"
  | "bra"
  | "cmp"
  | "dea"
  | "eor"
  | "ina"
  | "jmpIndX"
  | "lda"
  | "ora"
  | "phx"
  | "phy"
  | "plx"
  | "ply"
  | "sbc"
  | "sta"
  | "stz"
  | "trb"
  | "tsb"
  // HuC6280 proper.
  | "cla"
  | "clx"
  | "cly"
  | "csh"
  | "csl"
  | "sax"
  | "say"
  | "set"
  | "sxy";

type Table = Partial<Record<Mode, number>>;

/**
 * The additions, one row per mnemonic.
 *
 * Only the *new* forms: `lda` already has eight modes in the 6502's table and
 * gains one here, so this row holds one entry and {@link Asm6280.op6280} falls
 * back to the base table for the rest. Written out for the reason the 6502's is
 * — the matrix has holes, and a table can be read against the reference.
 */
const OPCODES: Readonly<Record<Mnemonic6280, Table>> = {
  adc: { indZp: 0x72 },
  and: { indZp: 0x32 },
  bit: { imm: 0x89, zpX: 0x34, absX: 0x3c },
  bra: { rel: 0x80 },
  cmp: { indZp: 0xd2 },
  dea: { imp: 0x3a },
  eor: { indZp: 0x52 },
  ina: { imp: 0x1a },
  jmpIndX: { abs: 0x7c },
  lda: { indZp: 0xb2 },
  ora: { indZp: 0x12 },
  phx: { imp: 0xda },
  phy: { imp: 0x5a },
  plx: { imp: 0xfa },
  ply: { imp: 0x7a },
  sbc: { indZp: 0xf2 },
  sta: { indZp: 0x92 },
  stz: { zp: 0x64, zpX: 0x74, abs: 0x9c, absX: 0x9e },
  trb: { zp: 0x14, abs: 0x1c },
  tsb: { zp: 0x04, abs: 0x0c },
  cla: { imp: 0x62 },
  clx: { imp: 0x82 },
  cly: { imp: 0xc2 },
  csh: { imp: 0xd4 },
  csl: { imp: 0x54 },
  sax: { imp: 0x22 },
  say: { imp: 0x42 },
  set: { imp: 0xf4 },
  sxy: { imp: 0x02 },
};

/** `tst #imm, <mode>` — the one instruction with two operands and four modes. */
const TST: Table = { zp: 0x83, abs: 0x93, zpX: 0xa3, absX: 0xb3 };

/** The five block transfers, by what each end does. */
const BLOCK = {
  /** Both ends increment: a straight copy. */
  tii: 0x73,
  /** Both decrement: a copy that may overlap upward. */
  tdd: 0xc3,
  /** The source is fixed: fill a region from one byte. */
  tin: 0xd3,
  /** The destination is fixed: a stream into a hardware port. */
  tia: 0xe3,
  /** The source is fixed and the destination alternates — video RAM's own shape. */
  tai: 0xf3,
} as const;

/** Which block transfer to perform. */
export type BlockMove = keyof typeof BLOCK;

/**
 * A growable code buffer for the HuC6280.
 *
 * Everything a 6502 can do, plus the three groups above. `origin` means what it
 * means on the base class — where byte zero lives in the *visible* address
 * space, which on this machine is decided by an `MPR` register rather than by
 * cartridge wiring, so a backend passes the address its `tam` puts the code at.
 */
export class Asm6280 extends Asm6502 {
  /**
   * Encode a 6502 mnemonic, reaching this chip's extra modes for it first.
   *
   * Nine of the mnemonics below are the base class's with a mode added — the
   * unindexed `(zp)` on the eight ALU instructions, and three more forms of
   * `bit` — so overriding here is what makes the *inherited* named methods reach
   * them: `asm.lda(indZp(p0))` is the base class's `lda`, and without this it
   * would refuse a mode this CPU has. The tables cannot collide, because every
   * entry above is a mode the 6502 does not have at all.
   */
  override op(mnemonic: Mnemonic, operand: Operand = { mode: "imp", value: 0 }): this {
    const added = (OPCODES as Partial<Record<string, Table>>)[mnemonic]?.[operand.mode];
    if (added !== undefined) return this.encode(added, operand);
    return super.op(mnemonic, operand);
  }

  /** Emit one of the additions above, checking the mode as the base class does. */
  op6280(mnemonic: Mnemonic6280, operand: Operand = { mode: "imp", value: 0 }): this {
    const opcode = OPCODES[mnemonic][operand.mode];
    if (opcode === undefined) {
      throw new AsmError(`${mnemonic} has no ${operand.mode} addressing mode on the HuC6280`);
    }
    return this.encode(opcode, operand);
  }

  // --- the 65C02's additions -------------------------------------------------

  /** `stz` — store zero, which saves loading it first. */
  stz(operand: Operand): this {
    return this.op6280("stz", operand);
  }
  /** `bra` — an unconditional branch, two bytes against `jmp`'s three. */
  bra(target: Ref): this {
    return this.op6280("bra", { mode: "rel", value: target });
  }
  /** `inc a` / `dec a`, which a 6502 can only do through memory or `X`. */
  ina(): this {
    return this.op6280("ina");
  }
  dea(): this {
    return this.op6280("dea");
  }
  phx(): this {
    return this.op6280("phx");
  }
  phy(): this {
    return this.op6280("phy");
  }
  plx(): this {
    return this.op6280("plx");
  }
  ply(): this {
    return this.op6280("ply");
  }
  /** `tsb`/`trb` — set or clear the bits of `A` in memory, keeping the rest. */
  tsb(operand: Operand): this {
    return this.op6280("tsb", operand);
  }
  trb(operand: Operand): this {
    return this.op6280("trb", operand);
  }
  /** `jmp ($nnnn,x)` — the indexed indirect jump, for a dispatch table. */
  jmpIndX(target: Ref): this {
    return this.op6280("jmpIndX", { mode: "abs", value: target });
  }

  /**
   * `rmb`/`smb` — clear or set one bit of a zero-page byte, in one instruction.
   *
   * Two bytes and no accumulator, where the 6502 needs a load, a mask and a
   * store. A contact bitfield is exactly this shape.
   */
  rmb(bit: number, address: Ref): this {
    return this.bitOp(0x07, bit, address);
  }
  smb(bit: number, address: Ref): this {
    return this.bitOp(0x87, bit, address);
  }

  /** `bbr`/`bbs` — branch on one bit of a zero-page byte: test and branch in one. */
  bbr(bit: number, address: Ref, target: Ref): this {
    return this.bitBranch(0x0f, bit, address, target);
  }
  bbs(bit: number, address: Ref, target: Ref): this {
    return this.bitBranch(0x8f, bit, address, target);
  }

  // --- the mapper ------------------------------------------------------------

  /**
   * `tam #mask` — put `A` in every `MPR` the mask names.
   *
   * The mask is a *bit per register*, not a register number: `tam #$04` writes
   * `MPR2`, which is the page at `$4000`. Writing two at once is legal and is
   * what the bit field is for; writing none is a no-op that looks like a working
   * instruction, so a zero mask is refused here rather than in an emulator.
   */
  tam(mask: number): this {
    if ((mask & 0xff) === 0) throw new AsmError("tam with an empty mask maps nothing");
    return this.db(0x53).db(mask & 0xff);
  }

  /** `tma #mask` — read the `MPR` the mask names into `A`. One bit only. */
  tma(mask: number): this {
    if ((mask & 0xff) === 0 || (mask & (mask - 1)) !== 0) {
      throw new AsmError("tma reads exactly one MPR, so its mask must be one bit");
    }
    return this.db(0x43).db(mask & 0xff);
  }

  /** The bit `tam`/`tma` want for the page beginning at `page * $2000`. */
  static mprBit(page: number): number {
    if (page < 0 || page > 7) throw new AsmError(`MPR${page} does not exist`);
    return 1 << page;
  }

  // --- the video chip's shortcut --------------------------------------------

  /**
   * `st0`/`st1`/`st2` — write the VDC without an address bus cycle to spare.
   *
   * The video chip answers at `$0000`–`$0003` of the hardware page, and these
   * three write those addresses with an immediate byte and no `lda` in front:
   * `st0` selects a register, `st1` and `st2` are its low and high halves. Four
   * bytes for a whole register write against seven, which on a machine that
   * programs sixteen VDC registers at boot and two per frame is worth having.
   *
   * They do not touch `A`, which is the other reason to use them: a register
   * write can happen in the middle of an expression.
   */
  st0(value: number): this {
    return this.db(0x03).db(value & 0xff);
  }
  st1(value: number): this {
    return this.db(0x13).db(value & 0xff);
  }
  st2(value: number): this {
    return this.db(0x23).db(value & 0xff);
  }

  // --- block transfer --------------------------------------------------------

  /**
   * One of the five block moves: source, destination, and a length in bytes.
   *
   * Seven bytes, and **`A`, `X` and `Y` do not survive it**. A zero length is
   * 65536 bytes on this hardware rather than nothing, which is a very long way
   * to walk by accident, so it is refused.
   */
  block(kind: BlockMove, source: Ref, dest: Ref, length: Ref): this {
    if (typeof length === "number" && (length <= 0 || length > 0xffff)) {
      throw new AsmError(`a block transfer of ${length} bytes is not what the hardware does`);
    }
    return this.db(BLOCK[kind]).dw(source).dw(dest).dw(length);
  }

  /** `tia` — walk the source into a fixed destination: the video RAM port. */
  tia(source: Ref, dest: Ref, length: Ref): this {
    return this.block("tia", source, dest, length);
  }
  /** `tii` — a straight copy, both ends walking upward. */
  tii(source: Ref, dest: Ref, length: Ref): this {
    return this.block("tii", source, dest, length);
  }
  /** `tin` — fill: one source byte into a walking destination. */
  tin(source: Ref, dest: Ref, length: Ref): this {
    return this.block("tin", source, dest, length);
  }
  /** `tai` — a fixed source into a walking destination, alternating two bytes. */
  tai(source: Ref, dest: Ref, length: Ref): this {
    return this.block("tai", source, dest, length);
  }
  /** `tdd` — a copy that walks both ends downward. */
  tdd(source: Ref, dest: Ref, length: Ref): this {
    return this.block("tdd", source, dest, length);
  }

  // --- the odds and ends -----------------------------------------------------

  /** `tst #mask, <address>` — test bits without disturbing `A`. */
  tst(mask: number, operand: Operand): this {
    const opcode = TST[operand.mode];
    if (opcode === undefined) {
      throw new AsmError(`tst has no ${operand.mode} addressing mode`);
    }
    this.db(opcode).db(mask & 0xff);
    // The address follows the mask, so it cannot go through `encode` — which
    // emits the opcode itself. Two forms, both little-endian, as everywhere.
    const value = operand.value as Ref;
    if (operand.mode === "zp" || operand.mode === "zpX") this.byte(value);
    else this.word(value);
    return this;
  }

  /** `csh`/`csl` — run at 7.16 MHz or at 1.79. A cartridge picks fast and stays. */
  csh(): this {
    return this.op6280("csh");
  }
  csl(): this {
    return this.op6280("csl");
  }
  /** `cla`/`clx`/`cly` — zero a register without an immediate. */
  cla(): this {
    return this.op6280("cla");
  }
  clx(): this {
    return this.op6280("clx");
  }
  cly(): this {
    return this.op6280("cly");
  }
  /** `sax`/`say`/`sxy` — swap two registers, which this CPU can and a 6502 cannot. */
  sax(): this {
    return this.op6280("sax");
  }
  say(): this {
    return this.op6280("say");
  }
  sxy(): this {
    return this.op6280("sxy");
  }
  /** `set` — arm the `T` flag for the next ALU instruction. Nothing emits it. */
  set(): this {
    return this.op6280("set");
  }

  // --- shared plumbing -------------------------------------------------------

  private bitOp(base: number, bit: number, address: Ref): this {
    this.db(base | (this.checkBit(bit) << 4));
    this.byte(address);
    return this;
  }

  private bitBranch(base: number, bit: number, address: Ref, target: Ref): this {
    this.db(base | (this.checkBit(bit) << 4));
    this.byte(address);
    // The offset is relative to the byte after it, exactly as an ordinary
    // branch's is — so it goes through the base class's own encoder rather than
    // being computed here, which is how a three-byte instruction's branch ends
    // up one byte out.
    this.relative(target);
    return this;
  }

  private checkBit(bit: number): number {
    if (!Number.isInteger(bit) || bit < 0 || bit > 7) {
      throw new AsmError(`bit ${bit} does not exist in a byte`);
    }
    return bit;
  }
}
