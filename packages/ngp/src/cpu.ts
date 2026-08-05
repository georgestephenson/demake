/**
 * A Toshiba TLCS-900/H interpreter — the Neo Geo Pocket's processor.
 *
 * Written against the published instruction set rather than transcribed from
 * another core, for the reason `@demake/pce`'s CPU is written twice: two
 * independent readings disagree loudly where a copy inherits a wrong answer in
 * silence. The oracle above it is `core`'s own encoder — the tests assemble with
 * {@link Asm900} and run the result here — and beneath that,
 * `packages/core/test/tlcs900.test.ts` pins the encoder against the published
 * code maps and the manual's own worked examples. So the two files are a
 * three-way agreement rather than a circle.
 *
 * Four things about this architecture the rest of this package is shaped by:
 *
 *   - **The operand comes before the opcode.** The first byte says where the
 *     operand is and how wide it is; the byte after it says what to do. So this
 *     decoder is two stages rather than one big switch — {@link Tlcs900.step}
 *     resolves an operand and then dispatches on one of three tables, which is
 *     exactly the shape of the hardware's four code maps.
 *   - **The registers are a byte-addressable file.** `XWA` is not a variable, it
 *     is four bytes at register-file address `$E0`, and `A` is the byte at `$E0`
 *     while `W` is the byte at `$E1`. Modelling the file as memory is what makes
 *     the register-index addressing mode and the banked windows fall out instead
 *     of needing cases, and it is why {@link Tlcs900.regs} is a `Uint8Array`.
 *   - **The flags are Z80-shaped, and the signed conditions are derived.**
 *     `S xor V` is a signed comparison and `C` an unsigned one, so the
 *     arithmetic here computes overflow explicitly rather than inferring it from
 *     a result that has already been truncated.
 *   - **A repeated block operation is one instruction that takes many steps.**
 *     `ldir` copying two kilobytes is interruptible on the hardware, so this
 *     model performs one element per step and rewinds the program counter —
 *     which is what keeps a cycle count honest and a frame from being swallowed.
 *
 * Scope is what a demade cartridge needs, plus what a reasonable reading of the
 * code maps makes free: every addressing mode, the whole ALU, the shifts and bit
 * operations, `mul`/`div`, the block operations and the conditional control
 * flow. What is absent is absent rather than half-implemented — there is no
 * `link`/`unlk`, no control-register access, no decimal adjust for words, no
 * `swi` and no register-bank switching beyond the pointer itself — and an opcode
 * this does not decode raises by number rather than being skipped.
 *
 * Sources: Toshiba — TLCS-900 Series User's Manual, Appendix A (per-instruction
 * behaviour and flag definitions) and Appendix C (the four code maps).
 */

/** The 24-bit address space, as the processor hands it to the console. */
export interface Bus {
  read(address: number): number;
  write(address: number, value: number): void;
}

/** Raised on an opcode this model does not decode. */
export class CpuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CpuError";
  }
}

/** Flag bits in `F`, which is the Z80's layout. */
export const FLAG_C = 0x01;
export const FLAG_N = 0x02;
export const FLAG_V = 0x04;
export const FLAG_H = 0x10;
export const FLAG_Z = 0x40;
export const FLAG_S = 0x80;

/** Register-file addresses of the current bank's long registers. */
export const XWA = 0xe0;
export const XBC = 0xe4;
export const XDE = 0xe8;
export const XHL = 0xec;
export const XIX = 0xf0;
export const XIY = 0xf4;
export const XIZ = 0xf8;
export const XSP = 0xfc;

/** Bytes in an operand of each size code. */
const SIZE_BYTES = [1, 2, 4] as const;

/**
 * The register-file address of the current bank's `n`th byte register.
 *
 * `A` is at `$E0` and `W` at `$E1` — the halves of a pair come out swapped
 * relative to their opcode numbering, because the file is little-endian within a
 * long word and the opcode numbers them high half first.
 */
function byteReg(index: number): number {
  return 0xe0 + (index >> 1) * 4 + (1 - (index & 1));
}

/** The register-file address of the current bank's `n`th word or long register. */
function wideReg(index: number): number {
  return 0xe0 + index * 4;
}

/** Sign-extend a value of `bytes` width. */
function signed(value: number, bytes: number): number {
  const bits = bytes * 8;
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

/** Parity of the low byte — the flag is defined over eight bits whatever the size. */
const PARITY = (() => {
  const table = new Uint8Array(256);
  for (let value = 0; value < 256; value += 1) {
    let bits = 0;
    for (let bit = 0; bit < 8; bit += 1) if ((value >> bit) & 1) bits += 1;
    table[value] = bits % 2 === 0 ? FLAG_V : 0;
  }
  return table;
})();

/** Where an operand lives, once its prefix has been decoded. */
interface Operand {
  /** A register-file address, or `-1` when the operand is memory. */
  reg: number;
  /** An address in the bus's space, or `-1` when the operand is a register. */
  address: number;
}

export class Tlcs900 {
  /**
   * The register file.
   *
   * `$00`–`$3F` are the four banks, `$F0`–`$FF` are `XIX` through `XSP`, which
   * are not banked. `$E0`–`$EF` and `$D0`–`$DF` are *windows* on the current and
   * previous bank rather than storage, resolved by {@link physical}.
   */
  readonly regs = new Uint8Array(0x100);

  /** The program counter. */
  pc = 0;

  /** The flag byte. */
  f = 0;

  /** Which bank `$E0`–`$EF` currently names. */
  rfp = 0;

  /** Whether the processor is stopped until an interrupt arrives. */
  halted = false;

  /**
   * Where the instruction being executed began.
   *
   * A repeating block operation rewinds to it rather than to a fixed distance
   * back, because how long the prefix in front of it was is the decoder's
   * business and not the block operation's.
   */
  private opStart = 0;

  /** The interrupt mask level set by `ei`; seven masks everything maskable. */
  iff = 7;

  constructor(private readonly bus: Bus) {}

  /** Point the processor at an address, as the boot ROM's hand-off does. */
  reset(entry: number, stack: number): void {
    this.regs.fill(0);
    this.pc = entry & 0xffffff;
    this.writeReg(XSP, 4, stack);
    this.f = 0;
    this.rfp = 0;
    this.halted = false;
    this.iff = 7;
  }

  // --- the register file -----------------------------------------------------

  /** Resolve a banked window onto the storage behind it. */
  private physical(code: number): number {
    if (code >= 0xf0) return code;
    if (code >= 0xe0) return (this.rfp & 3) * 0x10 + (code - 0xe0);
    if (code >= 0xd0) return ((this.rfp - 1) & 3) * 0x10 + (code - 0xd0);
    if (code < 0x40) return code;
    throw new CpuError(`register code $${code.toString(16)} names no register`);
  }

  /** Read `bytes` from the register file, little-endian. */
  readReg(code: number, bytes: number): number {
    const at = this.physical(code);
    let value = 0;
    for (let index = 0; index < bytes; index += 1) {
      value |= (this.regs[at + index] as number) << (index * 8);
    }
    return value >>> 0;
  }

  /** Write `bytes` to the register file, little-endian. */
  writeReg(code: number, bytes: number, value: number): void {
    const at = this.physical(code);
    for (let index = 0; index < bytes; index += 1) {
      this.regs[at + index] = (value >>> (index * 8)) & 0xff;
    }
  }

  // --- the bus ---------------------------------------------------------------

  private read(address: number, bytes: number): number {
    let value = 0;
    for (let index = 0; index < bytes; index += 1) {
      value |= this.bus.read((address + index) & 0xffffff) << (index * 8);
    }
    return value >>> 0;
  }

  private write(address: number, bytes: number, value: number): void {
    for (let index = 0; index < bytes; index += 1) {
      this.bus.write((address + index) & 0xffffff, (value >>> (index * 8)) & 0xff);
    }
  }

  private fetch(bytes: number): number {
    const value = this.read(this.pc, bytes);
    this.pc = (this.pc + bytes) & 0xffffff;
    return value;
  }

  // --- operand access --------------------------------------------------------

  private load(operand: Operand, bytes: number): number {
    return operand.reg >= 0 ? this.readReg(operand.reg, bytes) : this.read(operand.address, bytes);
  }

  private store(operand: Operand, bytes: number, value: number): void {
    if (operand.reg >= 0) this.writeReg(operand.reg, bytes, value);
    else this.write(operand.address, bytes, value);
  }

  // --- the stack -------------------------------------------------------------

  private push(bytes: number, value: number): void {
    const sp = (this.readReg(XSP, 4) - bytes) & 0xffffff;
    this.writeReg(XSP, 4, sp);
    this.write(sp, bytes, value);
  }

  private pop(bytes: number): number {
    const sp = this.readReg(XSP, 4);
    const value = this.read(sp, bytes);
    this.writeReg(XSP, 4, (sp + bytes) & 0xffffff);
    return value;
  }

  /**
   * Take an interrupt: stack the return address and the flags, then vector.
   *
   * The program counter goes down first and the flags on top of it, so
   * {@link Tlcs900} `reti` pops them in that order. On the hardware the boot ROM
   * owns the processor's own vector table and dispatches through one in RAM, so
   * what calls this is the machine rather than the CPU (`machine.ts`).
   */
  interrupt(handler: number): void {
    this.halted = false;
    this.push(4, this.pc);
    this.push(2, this.f);
    this.pc = handler & 0xffffff;
  }

  // --- flags -----------------------------------------------------------------

  /** Whether condition `cc` holds. */
  condition(cc: number): boolean {
    const s = (this.f & FLAG_S) !== 0;
    const z = (this.f & FLAG_Z) !== 0;
    const v = (this.f & FLAG_V) !== 0;
    const c = (this.f & FLAG_C) !== 0;
    switch (cc & 0xf) {
      case 0x0:
        return false;
      case 0x1:
        return s !== v; // LT
      case 0x2:
        return z || s !== v; // LE
      case 0x3:
        return c || z; // ULE
      case 0x4:
        return v; // OV / PE
      case 0x5:
        return s; // MI
      case 0x6:
        return z; // Z / EQ
      case 0x7:
        return c; // C / ULT
      case 0x8:
        return true;
      case 0x9:
        return s === v; // GE
      case 0xa:
        return !z && s === v; // GT
      case 0xb:
        return !c && !z; // UGT
      case 0xc:
        return !v; // NOV / PO
      case 0xd:
        return !s; // PL
      case 0xe:
        return !z; // NZ / NE
      default:
        return !c; // NC / UGE
    }
  }

  /** Set S and Z from a result, leaving everything else to the caller. */
  private setSZ(result: number, bytes: number): void {
    this.f &= ~(FLAG_S | FLAG_Z);
    if (result === 0) this.f |= FLAG_Z;
    if ((result >>> (bytes * 8 - 1)) & 1) this.f |= FLAG_S;
  }

  private add(a: number, b: number, bytes: number, carry: number): number {
    const mask = bytes === 4 ? 0xffffffff : (1 << (bytes * 8)) - 1;
    const sum = (a + b + carry) >>> 0;
    const result = (bytes === 4 ? sum : sum & mask) >>> 0;
    this.setSZ(result, bytes);
    this.f &= ~(FLAG_H | FLAG_V | FLAG_N | FLAG_C);
    if ((a & 0xf) + (b & 0xf) + carry > 0xf) this.f |= FLAG_H;
    // Carry out is computed from the unsigned sum rather than from the truncated
    // result, because at four bytes the truncation is the whole of the answer.
    if (bytes === 4 ? a + b + carry > 0xffffffff : sum > mask) this.f |= FLAG_C;
    const sign = 1 << (bytes * 8 - 1);
    if ((~(a ^ b) & (a ^ result) & sign) !== 0) this.f |= FLAG_V;
    return result;
  }

  private sub(a: number, b: number, bytes: number, borrow: number): number {
    const mask = bytes === 4 ? 0xffffffff : (1 << (bytes * 8)) - 1;
    const difference = a - b - borrow;
    const result = (difference & mask) >>> 0;
    this.setSZ(result, bytes);
    this.f &= ~(FLAG_H | FLAG_V | FLAG_C);
    this.f |= FLAG_N;
    if ((a & 0xf) - (b & 0xf) - borrow < 0) this.f |= FLAG_H;
    if (difference < 0) this.f |= FLAG_C;
    const sign = 1 << (bytes * 8 - 1);
    if (((a ^ b) & (a ^ result) & sign) !== 0) this.f |= FLAG_V;
    return result;
  }

  private logic(op: number, a: number, b: number, bytes: number): number {
    const result = (op === 4 ? a & b : op === 5 ? a ^ b : a | b) >>> 0;
    this.setSZ(result, bytes);
    this.f &= ~(FLAG_H | FLAG_V | FLAG_N | FLAG_C);
    // AND sets the half-carry and the others clear it; all three report parity
    // in the overflow bit, over the low byte.
    if (op === 4) this.f |= FLAG_H;
    this.f |= PARITY[result & 0xff] as number;
    return result;
  }

  /** One of the eight ALU operations, storing unless it is `cp`. */
  private alu(op: number, target: Operand, source: number, bytes: number): void {
    const a = this.load(target, bytes);
    const carry = this.f & FLAG_C;
    switch (op) {
      case 0:
        this.store(target, bytes, this.add(a, source, bytes, 0));
        return;
      case 1:
        this.store(target, bytes, this.add(a, source, bytes, carry));
        return;
      case 2:
        this.store(target, bytes, this.sub(a, source, bytes, 0));
        return;
      case 3:
        this.store(target, bytes, this.sub(a, source, bytes, carry));
        return;
      case 7:
        this.sub(a, source, bytes, 0);
        return;
      default:
        this.store(target, bytes, this.logic(op, a, source, bytes));
    }
  }

  private shift(op: number, count: number, target: Operand, bytes: number): void {
    const bits = bytes * 8;
    const mask = bytes === 4 ? 0xffffffff : (1 << bits) - 1;
    let value = this.load(target, bytes);
    let carry = (this.f & FLAG_C) !== 0 ? 1 : 0;
    for (let step = 0; step < count; step += 1) {
      const top = (value >>> (bits - 1)) & 1;
      const bottom = value & 1;
      switch (op) {
        case 0: // rlc
          value = ((value << 1) | top) >>> 0;
          carry = top;
          break;
        case 1: // rrc
          value = ((value >>> 1) | (bottom << (bits - 1))) >>> 0;
          carry = bottom;
          break;
        case 2: // rl
          value = ((value << 1) | carry) >>> 0;
          carry = top;
          break;
        case 3: // rr
          value = ((value >>> 1) | (carry << (bits - 1))) >>> 0;
          carry = bottom;
          break;
        case 4: // sla
        case 6: // sll — the same shift; only the documented intent differs
          value = (value << 1) >>> 0;
          carry = top;
          break;
        case 5: // sra
          value = ((value >>> 1) | (top << (bits - 1))) >>> 0;
          carry = bottom;
          break;
        default: // srl
          value = value >>> 1;
          carry = bottom;
          break;
      }
      value = (value & mask) >>> 0;
    }
    this.setSZ(value, bytes);
    this.f &= ~(FLAG_H | FLAG_V | FLAG_N | FLAG_C);
    this.f |= PARITY[value & 0xff] as number;
    if (carry) this.f |= FLAG_C;
    this.store(target, bytes, value);
  }

  // --- decoding --------------------------------------------------------------

  /**
   * Run one instruction and report the states it took.
   *
   * A repeated block operation performs one element and rewinds, so a caller
   * counting states sees the loop rather than a single enormous instruction.
   */
  step(): number {
    if (this.halted) return 4;
    this.opStart = this.pc;
    const op = this.fetch(1);
    if (op < 0x80) return this.execSingle(op);

    const group = (op >> 6) & 1;
    const role = (op >> 4) & 3;
    const low = op & 0x0f;

    if (group === 1 && low >= 0x07) {
      if (role === 3) {
        // $F7 is `ldx` and $F8-$FF are `swi`; neither is something a demade
        // cartridge emits, and both are named rather than silently skipped.
        throw new CpuError(`unimplemented opcode $${op.toString(16)}`);
      }
      const code = low === 0x07 ? this.fetch(1) : byteOrWide(role, low - 8);
      return this.execReg({ reg: code, address: -1 }, SIZE_BYTES[role] as number);
    }

    const { address, states } = this.effectiveAddress(group, low);
    const operand: Operand = { reg: -1, address };
    return role === 3
      ? states + this.execDstMem(operand)
      : states + this.execSrcMem(operand, SIZE_BYTES[role] as number);
  }

  /** Decode the address a memory prefix describes, and what it cost. */
  private effectiveAddress(group: number, low: number): { address: number; states: number } {
    if (group === 0) {
      if (low < 8) return { address: this.readReg(wideReg(low), 4), states: 0 };
      const base = this.readReg(wideReg(low - 8), 4);
      return { address: (base + signed(this.fetch(1), 1)) & 0xffffff, states: 2 };
    }
    switch (low) {
      case 0:
        return { address: this.fetch(1), states: 2 };
      case 1:
        return { address: this.fetch(2), states: 2 };
      case 2:
        return { address: this.fetch(3), states: 3 };
      case 3: {
        const spec = this.fetch(1);
        const mode = spec & 3;
        if (mode === 0) return { address: this.readReg(spec & 0xfc, 4), states: 5 };
        if (mode === 1) {
          const base = this.readReg(spec & 0xfc, 4);
          return { address: (base + signed(this.fetch(2), 2)) & 0xffffff, states: 5 };
        }
        if (mode === 3) {
          const base = this.readReg(this.fetch(1), 4);
          const index = this.fetch(1);
          // Bit 2 of the sub-mode says how wide the index register is, and it is
          // signed either way — which is what makes a backwards table walk work.
          const offset =
            spec === 0x03 ? signed(this.readReg(index, 1), 1) : signed(this.readReg(index, 2), 2);
          return { address: (base + offset) & 0xffffff, states: 8 };
        }
        throw new CpuError(`memory operand sub-mode ${mode} is undefined`);
      }
      case 4:
      case 5: {
        const spec = this.fetch(1);
        const reg = spec & 0xfc;
        const step = 1 << (spec & 3);
        if (low === 4) {
          const address = (this.readReg(reg, 4) - step) & 0xffffff;
          this.writeReg(reg, 4, address);
          return { address, states: 3 };
        }
        const address = this.readReg(reg, 4);
        this.writeReg(reg, 4, (address + step) & 0xffffff);
        return { address, states: 3 };
      }
      default:
        throw new CpuError(`memory operand form ${low} is undefined`);
    }
  }

  // --- the one-byte opcodes --------------------------------------------------

  private execSingle(op: number): number {
    if (op >= 0x70) {
      // JRL cc — the displacement is measured from the byte after it.
      const delta = signed(this.fetch(2), 2);
      const taken = this.condition(op);
      if (taken) this.pc = (this.pc + delta) & 0xffffff;
      return taken ? 8 : 4;
    }
    if (op >= 0x60) {
      const delta = signed(this.fetch(1), 1);
      const taken = this.condition(op);
      if (taken) this.pc = (this.pc + delta) & 0xffffff;
      return taken ? 8 : 4;
    }
    if (op >= 0x58) {
      this.writeReg(wideReg(op - 0x58), 4, this.pop(4));
      return 8;
    }
    if (op >= 0x48) {
      this.writeReg(wideReg(op - 0x48), 2, this.pop(2));
      return 6;
    }
    if (op >= 0x40) {
      this.writeReg(wideReg(op - 0x40), 4, this.fetch(4));
      return 6;
    }
    if (op >= 0x38) {
      this.push(4, this.readReg(wideReg(op - 0x38), 4));
      return 6;
    }
    if (op >= 0x30) {
      this.writeReg(wideReg(op - 0x30), 2, this.fetch(2));
      return 4;
    }
    if (op >= 0x28) {
      this.push(2, this.readReg(wideReg(op - 0x28), 2));
      return 5;
    }
    if (op >= 0x20) {
      this.writeReg(byteReg(op - 0x20), 1, this.fetch(1));
      return 3;
    }
    switch (op) {
      case 0x00:
        return 2;
      case 0x05:
        this.halted = true;
        return 8;
      case 0x06:
        this.iff = this.fetch(1) & 7;
        return 5;
      case 0x07: {
        // The inverse of `interrupt`: flags first, then the return address.
        this.f = this.pop(2) & 0xff;
        this.pc = this.pop(4) & 0xffffff;
        return 12;
      }
      case 0x08: {
        const address = this.fetch(1);
        this.write(address, 1, this.fetch(1));
        return 5;
      }
      case 0x0a: {
        const address = this.fetch(1);
        this.write(address, 2, this.fetch(2));
        return 6;
      }
      case 0x0c:
        this.rfp = (this.rfp + 1) & 7;
        return 2;
      case 0x0d:
        this.rfp = (this.rfp - 1) & 7;
        return 2;
      case 0x0e:
        this.pc = this.pop(4) & 0xffffff;
        return 9;
      case 0x0f: {
        const drop = signed(this.fetch(2), 2);
        this.pc = this.pop(4) & 0xffffff;
        this.writeReg(XSP, 4, (this.readReg(XSP, 4) + drop) & 0xffffff);
        return 9;
      }
      case 0x10:
        this.f &= ~FLAG_C;
        return 2;
      case 0x11:
        this.f |= FLAG_C;
        return 2;
      case 0x12:
        this.f ^= FLAG_C;
        return 2;
      case 0x13:
        this.f = (this.f & ~FLAG_C) | ((this.f & FLAG_Z) !== 0 ? 0 : FLAG_C);
        return 2;
      case 0x14:
        this.push(1, this.readReg(byteReg(1), 1));
        return 3;
      case 0x15:
        this.writeReg(byteReg(1), 1, this.pop(1));
        return 4;
      case 0x18:
        this.push(1, this.f);
        return 3;
      case 0x19:
        this.f = this.pop(1) & 0xff;
        return 4;
      case 0x1a:
        this.pc = this.fetch(2);
        return 7;
      case 0x1b:
        this.pc = this.fetch(3);
        return 7;
      case 0x1c: {
        const target = this.fetch(2);
        this.push(4, this.pc);
        this.pc = target;
        return 12;
      }
      case 0x1d: {
        const target = this.fetch(3);
        this.push(4, this.pc);
        this.pc = target;
        return 12;
      }
      case 0x1e: {
        const delta = signed(this.fetch(2), 2);
        this.push(4, this.pc);
        this.pc = (this.pc + delta) & 0xffffff;
        return 12;
      }
      default:
        throw new CpuError(`unimplemented opcode $${op.toString(16)}`);
    }
  }

  // --- the register-operand table --------------------------------------------

  private execReg(operand: Operand, bytes: number): number {
    const op = this.fetch(1);
    if (op >= 0xf8) {
      // Shift by whatever the low nibble of A holds, where zero means sixteen.
      const count = this.readReg(byteReg(1), 1) & 0xf;
      this.shift(op & 7, count === 0 ? 16 : count, operand, bytes);
      return 6;
    }
    if (op >= 0xf0) {
      this.alu(7, { reg: wideOf(bytes, op - 0xf0), address: -1 }, this.load(operand, bytes), bytes);
      return 4;
    }
    if (op >= 0xe8) {
      const count = this.fetch(1) & 0xf;
      this.shift(op & 7, count === 0 ? 16 : count, operand, bytes);
      return 6;
    }
    if (op >= 0xe0) return this.aluReg(6, op - 0xe0, operand, bytes);
    if (op >= 0xd8) {
      // CP r,#3 — the three-bit immediate is one to eight, eight spelled zero.
      const value = op - 0xd8;
      this.alu(7, operand, value === 0 ? 8 : value, bytes);
      return 4;
    }
    if (op >= 0xd0) return this.aluReg(5, op - 0xd0, operand, bytes);
    if (op >= 0xc8) {
      this.alu(op - 0xc8, operand, this.fetch(bytes), bytes);
      return 4;
    }
    if (op >= 0xc0) return this.aluReg(4, op - 0xc0, operand, bytes);
    if (op >= 0xb8) {
      const other: Operand = { reg: wideOf(bytes, op - 0xb8), address: -1 };
      const a = this.load(operand, bytes);
      this.store(operand, bytes, this.load(other, bytes));
      this.store(other, bytes, a);
      return 5;
    }
    if (op >= 0xb0) return this.aluReg(3, op - 0xb0, operand, bytes);
    if (op >= 0xa8) {
      const value = op - 0xa8;
      this.store(operand, bytes, value === 0 ? 8 : value);
      return 4;
    }
    if (op >= 0xa0) return this.aluReg(2, op - 0xa0, operand, bytes);
    if (op >= 0x98) {
      // LD r,R — the prefix names the destination this time.
      this.store(operand, bytes, this.readReg(wideOf(bytes, op - 0x98), bytes));
      return 4;
    }
    if (op >= 0x90) return this.aluReg(1, op - 0x90, operand, bytes);
    if (op >= 0x88) {
      this.writeReg(wideOf(bytes, op - 0x88), bytes, this.load(operand, bytes));
      return 4;
    }
    if (op >= 0x80) return this.aluReg(0, op - 0x80, operand, bytes);
    if (op >= 0x70) {
      this.store(operand, bytes, this.condition(op) ? 1 : 0);
      return 6;
    }
    if (op >= 0x68) return this.step68(op - 0x68, operand, bytes, false);
    if (op >= 0x60) return this.step68(op - 0x60, operand, bytes, true);
    if (op >= 0x58)
      return this.divide(wideOf(bytes * 2, op - 0x58), this.load(operand, bytes), bytes, true);
    if (op >= 0x50)
      return this.divide(wideOf(bytes * 2, op - 0x50), this.load(operand, bytes), bytes, false);
    if (op >= 0x48)
      return this.multiply(wideOf(bytes * 2, op - 0x48), this.load(operand, bytes), bytes, true);
    if (op >= 0x40)
      return this.multiply(wideOf(bytes * 2, op - 0x40), this.load(operand, bytes), bytes, false);
    switch (op) {
      case 0x03:
        this.store(operand, bytes, this.fetch(bytes));
        return 4;
      case 0x04:
        this.push(bytes, this.load(operand, bytes));
        return 5;
      case 0x05:
        this.store(operand, bytes, this.pop(bytes));
        return 6;
      case 0x06: {
        const mask = bytes === 4 ? 0xffffffff : (1 << (bytes * 8)) - 1;
        const value = (~this.load(operand, bytes) & mask) >>> 0;
        this.store(operand, bytes, value);
        this.f |= FLAG_H | FLAG_N;
        return 4;
      }
      case 0x07:
        this.store(operand, bytes, this.sub(0, this.load(operand, bytes), bytes, 0));
        return 5;
      case 0x08:
        return this.multiply(operand.reg, this.fetch(bytes >> 1), bytes >> 1, false);
      case 0x09:
        return this.multiply(operand.reg, this.fetch(bytes >> 1), bytes >> 1, true);
      case 0x0a:
        return this.divide(operand.reg, this.fetch(bytes >> 1), bytes >> 1, false);
      case 0x0b:
        return this.divide(operand.reg, this.fetch(bytes >> 1), bytes >> 1, true);
      case 0x12: {
        // EXTZ — zero the upper half, which is a mask rather than a move.
        const half = bytes * 4;
        this.store(operand, bytes, this.load(operand, bytes) & ((1 << half) - 1));
        return 4;
      }
      case 0x13: {
        // EXTS — sign-extend the lower half into the upper.
        const half = bytes / 2;
        this.store(operand, bytes, signed(this.load(operand, bytes), half) >>> 0);
        return 4;
      }
      case 0x1c: {
        const delta = signed(this.fetch(1), 1);
        const value = (this.load(operand, bytes) - 1) & (bytes === 1 ? 0xff : 0xffff);
        this.store(operand, bytes, value);
        if (value !== 0) this.pc = (this.pc + delta) & 0xffffff;
        return value !== 0 ? 9 : 5;
      }
      case 0x20:
      case 0x21:
      case 0x22:
      case 0x23:
      case 0x24: {
        // The carry-flag bit operations, whose bit index is a byte of its own.
        const index = this.fetch(1) & 0xf;
        const value = this.load(operand, bytes);
        const bit = (value >>> index) & 1;
        const carry = (this.f & FLAG_C) !== 0 ? 1 : 0;
        if (op === 0x24) {
          // STCF is the only one that writes back rather than reading.
          const mask = 1 << index;
          this.store(operand, bytes, (carry ? value | mask : value & ~mask) >>> 0);
          return 4;
        }
        const result =
          op === 0x20 ? carry & bit : op === 0x21 ? carry | bit : op === 0x22 ? carry ^ bit : bit;
        this.f = (this.f & ~FLAG_C) | (result !== 0 ? FLAG_C : 0);
        return 4;
      }
      case 0x30:
      case 0x31:
      case 0x32:
      case 0x33: {
        const index = this.fetch(1) & 0xf;
        return this.bitOp(op - 0x30, index, operand, bytes);
      }
      default:
        throw new CpuError(`unimplemented register opcode $${op.toString(16)}`);
    }
  }

  /** `<alu> R, r` — the prefix names the source and the opcode the destination. */
  private aluReg(op: number, index: number, operand: Operand, bytes: number): number {
    this.alu(op, { reg: wideOf(bytes, index), address: -1 }, this.load(operand, bytes), bytes);
    return 4;
  }

  /** `inc`/`dec` by one to eight, eight spelled zero. */
  private step68(amount: number, operand: Operand, bytes: number, up: boolean): number {
    const by = amount === 0 ? 8 : amount;
    const carry = this.f & FLAG_C;
    const value = this.load(operand, bytes);
    const result = up ? this.add(value, by, bytes, 0) : this.sub(value, by, bytes, 0);
    // The carry is the one flag these two leave alone, which is what lets a
    // multi-word counter be stepped without saving it.
    this.f = (this.f & ~FLAG_C) | carry;
    this.store(operand, bytes, result);
    return 4;
  }

  private bitOp(kind: number, index: number, operand: Operand, bytes: number): number {
    const value = this.load(operand, bytes);
    const mask = 1 << index;
    switch (kind) {
      case 0:
        this.store(operand, bytes, (value & ~mask) >>> 0);
        break;
      case 1:
        this.store(operand, bytes, (value | mask) >>> 0);
        break;
      case 2:
        this.store(operand, bytes, (value ^ mask) >>> 0);
        break;
      default: {
        // BIT puts the *inverse* of the bit in Z, so `nz` means it was set.
        this.f = (this.f & ~(FLAG_Z | FLAG_N)) | FLAG_H;
        if ((value & mask) === 0) this.f |= FLAG_Z;
      }
    }
    return 4;
  }

  private multiply(dst: number, source: number, bytes: number, signedOp: boolean): number {
    const wide = bytes * 2;
    const a = this.readReg(dst, bytes);
    const x = signedOp ? signed(a, bytes) : a;
    const y = signedOp ? signed(source, bytes) : source;
    this.writeReg(dst, wide, (x * y) >>> 0);
    return bytes === 1 ? 10 : 18;
  }

  private divide(dst: number, source: number, bytes: number, signedOp: boolean): number {
    const wide = bytes * 2;
    const dividend = this.readReg(dst, wide);
    if (source === 0) {
      // The hardware sets overflow and leaves the register alone rather than
      // trapping, which is what a divide by zero has to mean in a game.
      this.f |= FLAG_V;
      return bytes === 1 ? 16 : 24;
    }
    const a = signedOp ? signed(dividend, wide) : dividend;
    const b = signedOp ? signed(source, bytes) : source;
    const quotient = Math.trunc(a / b);
    const remainder = a - quotient * b;
    const mask = (1 << (bytes * 8)) - 1;
    this.f &= ~FLAG_V;
    if (signedOp ? quotient > mask >> 1 || quotient < -(mask >> 1) - 1 : quotient > mask) {
      this.f |= FLAG_V;
    }
    this.writeReg(dst, bytes, quotient & mask);
    this.writeReg(dst + bytes, bytes, remainder & mask);
    return bytes === 1 ? 16 : 24;
  }

  // --- the source-memory table -----------------------------------------------

  private execSrcMem(operand: Operand, bytes: number): number {
    const op = this.fetch(1);
    if (op >= 0xf8) return this.aluToMem(7, op - 0xf8, operand, bytes);
    if (op >= 0xf0) return this.aluFromMem(7, op - 0xf0, operand, bytes);
    if (op >= 0xe8) return this.aluToMem(6, op - 0xe8, operand, bytes);
    if (op >= 0xe0) return this.aluFromMem(6, op - 0xe0, operand, bytes);
    if (op >= 0xd8) return this.aluToMem(5, op - 0xd8, operand, bytes);
    if (op >= 0xd0) return this.aluFromMem(5, op - 0xd0, operand, bytes);
    if (op >= 0xc8) return this.aluToMem(4, op - 0xc8, operand, bytes);
    if (op >= 0xc0) return this.aluFromMem(4, op - 0xc0, operand, bytes);
    if (op >= 0xb8) return this.aluToMem(3, op - 0xb8, operand, bytes);
    if (op >= 0xb0) return this.aluFromMem(3, op - 0xb0, operand, bytes);
    if (op >= 0xa8) return this.aluToMem(2, op - 0xa8, operand, bytes);
    if (op >= 0xa0) return this.aluFromMem(2, op - 0xa0, operand, bytes);
    if (op >= 0x98) return this.aluToMem(1, op - 0x98, operand, bytes);
    if (op >= 0x90) return this.aluFromMem(1, op - 0x90, operand, bytes);
    if (op >= 0x88) return this.aluToMem(0, op - 0x88, operand, bytes);
    if (op >= 0x80) return this.aluFromMem(0, op - 0x80, operand, bytes);
    if (op >= 0x78) {
      this.shift(op & 7, 1, operand, bytes);
      return 8;
    }
    if (op >= 0x68) return this.step68(op - 0x68, operand, bytes, false);
    if (op >= 0x60) return this.step68(op - 0x60, operand, bytes, true);
    if (op >= 0x58)
      return this.divide(wideOf(bytes * 2, op - 0x58), this.load(operand, bytes), bytes, true);
    if (op >= 0x50)
      return this.divide(wideOf(bytes * 2, op - 0x50), this.load(operand, bytes), bytes, false);
    if (op >= 0x48)
      return this.multiply(wideOf(bytes * 2, op - 0x48), this.load(operand, bytes), bytes, true);
    if (op >= 0x40)
      return this.multiply(wideOf(bytes * 2, op - 0x40), this.load(operand, bytes), bytes, false);
    if (op >= 0x38) {
      this.alu(op - 0x38, operand, this.fetch(bytes), bytes);
      return 8;
    }
    if (op >= 0x30) {
      const other: Operand = { reg: wideOf(bytes, op - 0x30), address: -1 };
      const a = this.load(operand, bytes);
      this.store(operand, bytes, this.load(other, bytes));
      this.store(other, bytes, a);
      return 8;
    }
    if (op >= 0x20) {
      this.writeReg(wideOf(bytes, op - 0x20), bytes, this.load(operand, bytes));
      return 4;
    }
    if (op >= 0x10 && op <= 0x17) return this.block(op, operand, bytes);
    if (op === 0x04) {
      this.push(bytes, this.load(operand, bytes));
      return 7;
    }
    throw new CpuError(`unimplemented source-memory opcode $${op.toString(16)}`);
  }

  private aluFromMem(op: number, index: number, operand: Operand, bytes: number): number {
    this.alu(op, { reg: wideOf(bytes, index), address: -1 }, this.load(operand, bytes), bytes);
    return 4;
  }

  private aluToMem(op: number, index: number, operand: Operand, bytes: number): number {
    this.alu(op, operand, this.readReg(wideOf(bytes, index), bytes), bytes);
    return 6;
  }

  /**
   * One element of a block move or search, rewinding if it repeats.
   *
   * The operand prefix named the destination (`ldi`) or the source (`cpi`);
   * `XHL` is the other end and `BC` is the count. A repeating form leaves the
   * program counter on its own first byte, so the next {@link step} performs the
   * next element — which is how the hardware makes a two-kilobyte copy
   * interruptible.
   */
  private block(op: number, operand: Operand, bytes: number): number {
    const down = (op & 2) !== 0;
    const repeat = (op & 1) !== 0;
    const search = op >= 0x14;
    const delta = down ? -bytes : bytes;

    if (search) {
      const value = this.readReg(byteReg(1), bytes);
      const found = this.load(operand, bytes);
      this.sub(value, found, bytes, 0);
      this.writeReg(XHL, 4, (this.readReg(XHL, 4) + delta) & 0xffffff);
    } else {
      const source = this.read(this.readReg(XHL, 4), bytes);
      this.store(operand, bytes, source);
      this.writeReg(XHL, 4, (this.readReg(XHL, 4) + delta) & 0xffffff);
      this.writeReg(XDE, 4, (this.readReg(XDE, 4) + delta) & 0xffffff);
    }

    const count = (this.readReg(0xe4, 2) - 1) & 0xffff;
    this.writeReg(0xe4, 2, count);
    this.f &= ~FLAG_V;
    if (count !== 0) this.f |= FLAG_V;
    // A search also stops early when it has found what it was looking for.
    const done = count === 0 || (search && (this.f & FLAG_Z) !== 0);
    if (repeat && !done) {
      this.pc = this.opStart;
      return 10;
    }
    return 8;
  }

  // --- the destination-memory table ------------------------------------------

  private execDstMem(operand: Operand): number {
    const op = this.fetch(1);
    if (op >= 0xf0) {
      if (this.condition(op)) this.pc = this.pop(4) & 0xffffff;
      return 9;
    }
    if (op >= 0xe0) {
      if (this.condition(op)) {
        this.push(4, this.pc);
        this.pc = operand.address;
      }
      return 9;
    }
    if (op >= 0xd0) {
      if (this.condition(op)) this.pc = operand.address;
      return 9;
    }
    if (op >= 0x80) {
      // The bit operations on memory, which are byte-sized and take their index
      // from the low three bits of the opcode rather than from a byte of their own.
      const index = op & 7;
      const kind = (op - 0x80) >> 3;
      return this.memBitOp(kind, index, operand);
    }
    if (op >= 0x60) {
      this.write(operand.address, 4, this.readReg(wideReg(op - 0x60), 4));
      return 6;
    }
    if (op >= 0x50) {
      this.write(operand.address, 2, this.readReg(wideReg(op - 0x50), 2));
      return 5;
    }
    if (op >= 0x40) {
      this.write(operand.address, 1, this.readReg(byteReg(op - 0x40), 1));
      return 4;
    }
    if (op >= 0x30 && op <= 0x37) {
      this.writeReg(wideReg(op - 0x30), 4, operand.address);
      return 4;
    }
    if (op >= 0x20 && op <= 0x27) {
      this.writeReg(wideReg(op - 0x20), 2, operand.address & 0xffff);
      return 4;
    }
    switch (op) {
      case 0x00:
        this.write(operand.address, 1, this.fetch(1));
        return 5;
      case 0x02:
        this.write(operand.address, 2, this.fetch(2));
        return 6;
      case 0x04:
        this.write(operand.address, 1, this.pop(1));
        return 6;
      case 0x06:
        this.write(operand.address, 2, this.pop(2));
        return 6;
      default:
        throw new CpuError(`unimplemented destination-memory opcode $${op.toString(16)}`);
    }
  }

  /** The `$80`–`$CF` block: eight bit operations, each in eight opcodes. */
  private memBitOp(kind: number, index: number, operand: Operand): number {
    const value = this.read(operand.address, 1);
    const mask = 1 << index;
    switch (kind) {
      case 0: // andcf
        this.f =
          (this.f & ~FLAG_C) | ((this.f & FLAG_C) !== 0 && (value & mask) !== 0 ? FLAG_C : 0);
        return 8;
      case 1: // orcf
        if ((value & mask) !== 0) this.f |= FLAG_C;
        return 8;
      case 2: // xorcf
        if ((value & mask) !== 0) this.f ^= FLAG_C;
        return 8;
      case 3: // ldcf
        this.f = (this.f & ~FLAG_C) | ((value & mask) !== 0 ? FLAG_C : 0);
        return 8;
      case 4: // stcf
        this.write(operand.address, 1, (this.f & FLAG_C) !== 0 ? value | mask : value & ~mask);
        return 8;
      case 5: // tset — test into Z, then set
        this.f = (this.f & ~(FLAG_Z | FLAG_N)) | FLAG_H;
        if ((value & mask) === 0) this.f |= FLAG_Z;
        this.write(operand.address, 1, value | mask);
        return 10;
      case 6: // res
        this.write(operand.address, 1, value & ~mask);
        return 8;
      case 7: // set
        this.write(operand.address, 1, value | mask);
        return 8;
      case 8: // chg
        this.write(operand.address, 1, value ^ mask);
        return 8;
      default: {
        // bit
        this.f = (this.f & ~(FLAG_Z | FLAG_N)) | FLAG_H;
        if ((value & mask) === 0) this.f |= FLAG_Z;
        return 8;
      }
    }
  }
}

/** The register-file address of the `n`th register at a given operand size. */
function wideOf(bytes: number, index: number): number {
  return bytes === 1 ? byteReg(index) : wideReg(index);
}

/** The same, for a prefix whose role bits gave the size. */
function byteOrWide(role: number, index: number): number {
  return role === 0 ? byteReg(index) : wideReg(index);
}
