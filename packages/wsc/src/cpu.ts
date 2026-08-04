/**
 * A NEC V30MZ interpreter — the WonderSwan's processor.
 *
 * Written against the 8086's published behaviour rather than transcribed from
 * another core, for the reason `@demake/pce`'s CPU is written twice: two
 * independent readings disagree loudly where a copy inherits a wrong answer in
 * silence. The oracle above it is `core`'s own encoder — the tests assemble with
 * {@link Asm30} and run the result here, so an encoder and a decoder that agreed
 * with each other and not with the hardware would still have to get past
 * `packages/core/test/v30mz-nasm.test.ts`, which compares the encoder with NASM.
 *
 * Three things about this architecture the rest of this package is shaped by:
 *
 *   - **An address is a segment and an offset.** Everything the bus sees is
 *     twenty bits — `segment × 16 + offset` — so a WonderSwan's 64 KiB of RAM at
 *     segment zero and its cartridge bank at segment `$F000` are two windows on
 *     one address space rather than two address spaces. That is why the bus below
 *     takes a physical address and knows nothing about segments.
 *   - **The flags are the interesting state.** `SF ^ OF` is a signed comparison
 *     and `CF` an unsigned one, and the value layer above rests on both being
 *     exactly right after every operation — so the arithmetic here computes them
 *     explicitly rather than deriving them from a result that has already been
 *     truncated.
 *   - **A repeated string operation is interruptible.** `rep movsw` copying two
 *     kilobytes is one instruction that takes a thousand steps, and this model
 *     performs one iteration per step and rewinds to the prefix — which is what
 *     the hardware does, and what keeps a cycle count honest.
 *
 * Scope is what a demade cartridge and its harness need, plus what a reasonable
 * reading of the opcode map makes free: the whole ALU, every addressing form,
 * the string operations, `mul`/`div`, the 80186 additions this core has. What is
 * absent is absent rather than half-implemented — there are no interrupts, no
 * `int`, and no BCD adjustments — and an opcode this does not decode raises by
 * number rather than being skipped.
 *
 * Sources: Intel — iAPX 86/88 User's Manual (instruction set and flag
 * definitions); NEC — µPD70116 datasheet, for the execution times.
 */

/** The twenty-bit address space, as the processor hands it to the console. */
export interface Bus {
  read(address: number): number;
  write(address: number, value: number): void;
  readPort(port: number): number;
  writePort(port: number, value: number): void;
}

/** Raised on an opcode this model does not decode. */
export class CpuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CpuError";
  }
}

/** Register indices, in the order the mod/reg/rm field numbers them. */
export const AX = 0;
export const CX = 1;
export const DX = 2;
export const BX = 3;
export const SP = 4;
export const BP = 5;
export const SI = 6;
export const DI = 7;

/** Segment register indices, in the order the opcode map numbers them. */
export const ES = 0;
export const CS = 1;
export const SS = 2;
export const DS = 3;

/** Parity of a byte — the flag's definition is over the low eight bits only. */
const PARITY = (() => {
  const table = new Uint8Array(256);
  for (let value = 0; value < 256; value += 1) {
    let bits = 0;
    for (let bit = 0; bit < 8; bit += 1) if ((value >> bit) & 1) bits += 1;
    table[value] = bits % 2 === 0 ? 1 : 0;
  }
  return table;
})();

/** Where a decoded memory operand lives, and in which segment. */
interface Operand {
  /** True for a register operand, in which case `index` is the register. */
  register: boolean;
  index: number;
  /** Physical address, for a memory operand. */
  address: number;
  /**
   * The sixteen-bit offset the addressing computed, before the segment.
   *
   * Kept beside the physical address because `lea` wants exactly this and
   * recovering it by subtracting a segment base means knowing which segment was
   * used — which is a question the override and `bp`'s default between them make
   * easy to get wrong.
   */
  offset: number;
  /** Cycles the effective-address arithmetic cost. */
  ea: number;
}

/** A V30MZ. */
export class Cpu {
  /** AX, CX, DX, BX, SP, BP, SI, DI. */
  readonly regs = new Uint16Array(8);
  /** ES, CS, SS, DS. */
  readonly segs = new Uint16Array(4);
  ip = 0;

  cf = false;
  pf = false;
  af = false;
  zf = false;
  sf = false;
  tf = false;
  intEnable = false;
  df = false;
  of = false;

  /** Set by `hlt`, cleared by nothing this console does. */
  halted = false;

  /** The segment override in force for this instruction, or `-1`. */
  private override = -1;
  /** `0xf2` or `0xf3` while a string prefix is in force, else zero. */
  private repeat = 0;
  /** Where the instruction being executed began, prefixes included. */
  private start = 0;

  constructor(private readonly bus: Bus) {}

  /** Power-on state: the far jump the console resets into is at `FFFF:0000`. */
  reset(): void {
    this.regs.fill(0);
    this.segs[ES] = 0;
    this.segs[CS] = 0xffff;
    this.segs[SS] = 0;
    this.segs[DS] = 0;
    this.ip = 0;
    this.cf = false;
    this.pf = false;
    this.af = false;
    this.zf = false;
    this.sf = false;
    this.tf = false;
    this.intEnable = false;
    this.df = false;
    this.of = false;
    this.halted = false;
  }

  // --- register access -------------------------------------------------------

  /** One of the eight byte registers: `al cl dl bl ah ch dh bh`. */
  reg8(index: number): number {
    const value = this.regs[index & 3] as number;
    return index < 4 ? value & 0xff : (value >> 8) & 0xff;
  }

  setReg8(index: number, value: number): void {
    const current = this.regs[index & 3] as number;
    this.regs[index & 3] =
      index < 4 ? (current & 0xff00) | (value & 0xff) : (current & 0x00ff) | ((value & 0xff) << 8);
  }

  // --- memory ----------------------------------------------------------------

  private physical(segment: number, offset: number): number {
    return (((this.segs[segment] as number) << 4) + (offset & 0xffff)) & 0xfffff;
  }

  private read8(address: number): number {
    return this.bus.read(address) & 0xff;
  }

  private read16(address: number): number {
    // A word straddling the top of the space wraps within it, which is what a
    // twenty-bit adder does.
    return this.read8(address) | (this.read8((address + 1) & 0xfffff) << 8);
  }

  private write8(address: number, value: number): void {
    this.bus.write(address, value & 0xff);
  }

  private write16(address: number, value: number): void {
    this.write8(address, value & 0xff);
    this.write8((address + 1) & 0xfffff, (value >> 8) & 0xff);
  }

  // --- fetch -----------------------------------------------------------------

  private fetch8(): number {
    const byte = this.read8(this.physical(CS, this.ip));
    this.ip = (this.ip + 1) & 0xffff;
    return byte;
  }

  private fetch16(): number {
    const low = this.fetch8();
    return low | (this.fetch8() << 8);
  }

  private fetchSigned8(): number {
    const byte = this.fetch8();
    return byte < 0x80 ? byte : byte - 0x100;
  }

  // --- addressing ------------------------------------------------------------

  /** The segment a memory operand uses, honouring an override. */
  private segmentOf(base: number): number {
    return this.override >= 0 ? this.override : base;
  }

  /**
   * Decode a mod/reg/rm byte into the operand it names and the register field.
   *
   * The effective-address arithmetic is the hardware's: `bp` defaults to the
   * stack segment because the only things addressed through it are frames, and
   * every other base defaults to data.
   */
  private modrm(): { reg: number; operand: Operand } {
    const byte = this.fetch8();
    const mod = byte >> 6;
    const reg = (byte >> 3) & 7;
    const rm = byte & 7;
    if (mod === 3) {
      return { reg, operand: { register: true, index: rm, address: 0, offset: 0, ea: 0 } };
    }
    let base: number;
    let segment = DS;
    let ea: number;
    switch (rm) {
      case 0:
        base = (this.regs[BX] as number) + (this.regs[SI] as number);
        ea = 7;
        break;
      case 1:
        base = (this.regs[BX] as number) + (this.regs[DI] as number);
        ea = 8;
        break;
      case 2:
        base = (this.regs[BP] as number) + (this.regs[SI] as number);
        segment = SS;
        ea = 8;
        break;
      case 3:
        base = (this.regs[BP] as number) + (this.regs[DI] as number);
        segment = SS;
        ea = 7;
        break;
      case 4:
        base = this.regs[SI] as number;
        ea = 5;
        break;
      case 5:
        base = this.regs[DI] as number;
        ea = 5;
        break;
      case 6:
        if (mod === 0) {
          // The one form with no base: a direct address.
          const direct = this.fetch16();
          return {
            reg,
            operand: {
              register: false,
              index: 0,
              address: this.physical(this.segmentOf(DS), direct),
              offset: direct,
              ea: 6,
            },
          };
        }
        base = this.regs[BP] as number;
        segment = SS;
        ea = 5;
        break;
      default:
        base = this.regs[BX] as number;
        ea = 5;
        break;
    }
    let displacement = 0;
    if (mod === 1) {
      displacement = this.fetchSigned8();
      ea += 4;
    } else if (mod === 2) {
      displacement = this.fetch16();
      ea += 4;
    }
    const offset = (base + displacement) & 0xffff;
    return {
      reg,
      operand: {
        register: false,
        index: 0,
        address: this.physical(this.segmentOf(segment), offset),
        offset,
        ea,
      },
    };
  }

  private get16(operand: Operand): number {
    return operand.register ? (this.regs[operand.index] as number) : this.read16(operand.address);
  }

  private set16(operand: Operand, value: number): void {
    if (operand.register) this.regs[operand.index] = value & 0xffff;
    else this.write16(operand.address, value);
  }

  private get8(operand: Operand): number {
    return operand.register ? this.reg8(operand.index) : this.read8(operand.address);
  }

  private set8(operand: Operand, value: number): void {
    if (operand.register) this.setReg8(operand.index, value);
    else this.write8(operand.address, value);
  }

  // --- flags -----------------------------------------------------------------

  private setLogic(result: number, wide: boolean): number {
    const value = wide ? result & 0xffff : result & 0xff;
    this.cf = false;
    this.of = false;
    this.af = false;
    this.zf = value === 0;
    this.sf = (value & (wide ? 0x8000 : 0x80)) !== 0;
    this.pf = PARITY[value & 0xff] === 1;
    return value;
  }

  private setAdd(a: number, b: number, carry: number, wide: boolean): number {
    const mask = wide ? 0xffff : 0xff;
    const sign = wide ? 0x8000 : 0x80;
    const sum = a + b + carry;
    const value = sum & mask;
    this.cf = sum > mask;
    this.af = ((a ^ b ^ value) & 0x10) !== 0;
    this.of = ((a ^ value) & (b ^ value) & sign) !== 0;
    this.zf = value === 0;
    this.sf = (value & sign) !== 0;
    this.pf = PARITY[value & 0xff] === 1;
    return value;
  }

  private setSub(a: number, b: number, borrow: number, wide: boolean): number {
    const mask = wide ? 0xffff : 0xff;
    const sign = wide ? 0x8000 : 0x80;
    const difference = a - b - borrow;
    const value = difference & mask;
    this.cf = difference < 0;
    this.af = ((a ^ b ^ value) & 0x10) !== 0;
    this.of = ((a ^ b) & (a ^ value) & sign) !== 0;
    this.zf = value === 0;
    this.sf = (value & sign) !== 0;
    this.pf = PARITY[value & 0xff] === 1;
    return value;
  }

  /** The whole flag word, for `pushf` and `popf`. */
  get flags(): number {
    return (
      0xf002 |
      (this.cf ? 0x0001 : 0) |
      (this.pf ? 0x0004 : 0) |
      (this.af ? 0x0010 : 0) |
      (this.zf ? 0x0040 : 0) |
      (this.sf ? 0x0080 : 0) |
      (this.tf ? 0x0100 : 0) |
      (this.intEnable ? 0x0200 : 0) |
      (this.df ? 0x0400 : 0) |
      (this.of ? 0x0800 : 0)
    );
  }

  set flags(value: number) {
    this.cf = (value & 0x0001) !== 0;
    this.pf = (value & 0x0004) !== 0;
    this.af = (value & 0x0010) !== 0;
    this.zf = (value & 0x0040) !== 0;
    this.sf = (value & 0x0080) !== 0;
    this.tf = (value & 0x0100) !== 0;
    this.intEnable = (value & 0x0200) !== 0;
    this.df = (value & 0x0400) !== 0;
    this.of = (value & 0x0800) !== 0;
  }

  // --- stack -----------------------------------------------------------------

  private push(value: number): void {
    this.regs[SP] = ((this.regs[SP] as number) - 2) & 0xffff;
    this.write16(this.physical(SS, this.regs[SP] as number), value);
  }

  private pop(): number {
    const value = this.read16(this.physical(SS, this.regs[SP] as number));
    this.regs[SP] = ((this.regs[SP] as number) + 2) & 0xffff;
    return value;
  }

  // --- the ALU ---------------------------------------------------------------

  /** One of the eight operations, by its number in the opcode map. */
  private alu(op: number, a: number, b: number, wide: boolean): number | undefined {
    switch (op) {
      case 0:
        return this.setAdd(a, b, 0, wide);
      case 1:
        return this.setLogic(a | b, wide);
      case 2:
        return this.setAdd(a, b, this.cf ? 1 : 0, wide);
      case 3:
        return this.setSub(a, b, this.cf ? 1 : 0, wide);
      case 4:
        return this.setLogic(a & b, wide);
      case 5:
        return this.setSub(a, b, 0, wide);
      case 6:
        return this.setLogic(a ^ b, wide);
      default:
        // `cmp` writes nothing back, which is the whole of its difference.
        this.setSub(a, b, 0, wide);
        return undefined;
    }
  }

  private shift(op: number, value: number, count: number, wide: boolean): number {
    const bits = wide ? 16 : 8;
    const mask = wide ? 0xffff : 0xff;
    const sign = wide ? 0x8000 : 0x80;
    let result = value & mask;
    const amount = count & 0x1f;
    if (amount === 0) return result;
    for (let step = 0; step < amount; step += 1) {
      switch (op) {
        case 0: {
          // rol
          const top = (result & sign) !== 0 ? 1 : 0;
          result = ((result << 1) | top) & mask;
          this.cf = top === 1;
          break;
        }
        case 1: {
          // ror
          const bottom = result & 1;
          result = ((result >> 1) | (bottom << (bits - 1))) & mask;
          this.cf = bottom === 1;
          break;
        }
        case 2: {
          // rcl
          const top = (result & sign) !== 0;
          result = ((result << 1) | (this.cf ? 1 : 0)) & mask;
          this.cf = top;
          break;
        }
        case 3: {
          // rcr
          const bottom = (result & 1) !== 0;
          result = ((result >> 1) | (this.cf ? sign : 0)) & mask;
          this.cf = bottom;
          break;
        }
        case 4:
        case 6: {
          // shl / sal
          this.cf = (result & sign) !== 0;
          result = (result << 1) & mask;
          break;
        }
        case 5: {
          // shr
          this.cf = (result & 1) !== 0;
          result = (result >> 1) & mask;
          break;
        }
        default: {
          // sar — the arithmetic one, and the reason a 16.16 value can be
          // divided by a power of two at all.
          this.cf = (result & 1) !== 0;
          result = ((result >> 1) | (result & sign)) & mask;
          break;
        }
      }
    }
    if (op < 4) {
      // A rotate leaves the arithmetic flags alone; only the carry and the
      // overflow move.
      this.of = ((result & sign) !== 0) !== this.cf;
      return result;
    }
    // Overflow is only defined for a shift by one, and each of the three says
    // something different: a left shift asks whether the sign changed, a logical
    // right shift reports the sign that was shifted out of, and an arithmetic
    // one cannot overflow at all.
    if (op === 5) this.of = (value & sign) !== 0;
    else if (op === 7) this.of = false;
    else this.of = ((result & sign) !== 0) !== this.cf;
    this.zf = result === 0;
    this.sf = (result & sign) !== 0;
    this.pf = PARITY[result & 0xff] === 1;
    return result;
  }

  // --- execution -------------------------------------------------------------

  /**
   * Run one instruction and return the cycles it took.
   *
   * A prefix is not an instruction: the loop below consumes prefixes and then
   * executes what follows, so `rep movsw` is one call per iteration and a
   * segment override costs the two cycles the hardware charges for it.
   */
  step(): number {
    if (this.halted) return 4;
    this.override = -1;
    this.repeat = 0;
    this.start = this.ip;
    let cycles = 0;
    for (;;) {
      const opcode = this.fetch8();
      switch (opcode) {
        case 0x26:
          this.override = ES;
          cycles += 2;
          continue;
        case 0x2e:
          this.override = CS;
          cycles += 2;
          continue;
        case 0x36:
          this.override = SS;
          cycles += 2;
          continue;
        case 0x3e:
          this.override = DS;
          cycles += 2;
          continue;
        case 0xf2:
        case 0xf3:
          this.repeat = opcode;
          cycles += 2;
          continue;
        default:
          return cycles + this.execute(opcode);
      }
    }
  }

  private execute(opcode: number): number {
    // The ALU block: eight operations × six addressing forms, laid out so the
    // operation is `opcode >> 3` and the form is `opcode & 7`.
    if (opcode < 0x40 && (opcode & 7) < 6) {
      const op = opcode >> 3;
      switch (opcode & 7) {
        case 0: {
          const { reg, operand } = this.modrm();
          const result = this.alu(op, this.get8(operand), this.reg8(reg), false);
          if (result !== undefined) this.set8(operand, result);
          return operand.register ? 2 : 16 + operand.ea;
        }
        case 1: {
          const { reg, operand } = this.modrm();
          const result = this.alu(op, this.get16(operand), this.regs[reg] as number, true);
          if (result !== undefined) this.set16(operand, result);
          return operand.register ? 2 : 16 + operand.ea;
        }
        case 2: {
          const { reg, operand } = this.modrm();
          const result = this.alu(op, this.reg8(reg), this.get8(operand), false);
          if (result !== undefined) this.setReg8(reg, result);
          return operand.register ? 2 : 11 + operand.ea;
        }
        case 3: {
          const { reg, operand } = this.modrm();
          const result = this.alu(op, this.regs[reg] as number, this.get16(operand), true);
          if (result !== undefined) this.regs[reg] = result;
          return operand.register ? 2 : 11 + operand.ea;
        }
        case 4: {
          const result = this.alu(op, this.reg8(AX), this.fetch8(), false);
          if (result !== undefined) this.setReg8(AX, result);
          return 4;
        }
        default: {
          const result = this.alu(op, this.regs[AX] as number, this.fetch16(), true);
          if (result !== undefined) this.regs[AX] = result;
          return 4;
        }
      }
    }

    switch (opcode) {
      // --- segment pushes and pops -------------------------------------------
      case 0x06:
      case 0x0e:
      case 0x16:
      case 0x1e:
        this.push(this.segs[opcode >> 3] as number);
        return 8;
      case 0x07:
      case 0x17:
      case 0x1f:
        this.segs[opcode >> 3] = this.pop();
        return 8;

      // --- inc / dec on a register -------------------------------------------
      case 0x40:
      case 0x41:
      case 0x42:
      case 0x43:
      case 0x44:
      case 0x45:
      case 0x46:
      case 0x47: {
        const index = opcode & 7;
        const carry = this.cf;
        this.regs[index] = this.setAdd(this.regs[index] as number, 1, 0, true);
        this.cf = carry; // `inc` leaves the carry alone, which `adc` chains rely on
        return 2;
      }
      case 0x48:
      case 0x49:
      case 0x4a:
      case 0x4b:
      case 0x4c:
      case 0x4d:
      case 0x4e:
      case 0x4f: {
        const index = opcode & 7;
        const carry = this.cf;
        this.regs[index] = this.setSub(this.regs[index] as number, 1, 0, true);
        this.cf = carry;
        return 2;
      }

      // --- the stack ---------------------------------------------------------
      case 0x50:
      case 0x51:
      case 0x52:
      case 0x53:
      case 0x54:
      case 0x55:
      case 0x56:
      case 0x57:
        this.push(this.regs[opcode & 7] as number);
        return 8;
      case 0x58:
      case 0x59:
      case 0x5a:
      case 0x5b:
      case 0x5c:
      case 0x5d:
      case 0x5e:
      case 0x5f:
        this.regs[opcode & 7] = this.pop();
        return 8;
      case 0x60: {
        const sp = this.regs[SP] as number;
        for (const index of [AX, CX, DX, BX]) this.push(this.regs[index] as number);
        this.push(sp);
        for (const index of [BP, SI, DI]) this.push(this.regs[index] as number);
        return 36;
      }
      case 0x61: {
        for (const index of [DI, SI, BP]) this.regs[index] = this.pop();
        this.pop(); // the stack pointer is discarded, not restored
        for (const index of [BX, DX, CX, AX]) this.regs[index] = this.pop();
        return 40;
      }
      case 0x68:
        this.push(this.fetch16());
        return 8;
      case 0x6a:
        this.push(this.fetchSigned8() & 0xffff);
        return 8;

      // --- conditional branches ----------------------------------------------
      case 0x70:
      case 0x71:
      case 0x72:
      case 0x73:
      case 0x74:
      case 0x75:
      case 0x76:
      case 0x77:
      case 0x78:
      case 0x79:
      case 0x7a:
      case 0x7b:
      case 0x7c:
      case 0x7d:
      case 0x7e:
      case 0x7f: {
        const delta = this.fetchSigned8();
        if (this.condition(opcode & 0x0f)) {
          this.ip = (this.ip + delta) & 0xffff;
          return 13;
        }
        return 4;
      }

      // --- the immediate group -----------------------------------------------
      case 0x80:
      case 0x81:
      case 0x82:
      case 0x83: {
        const wide = (opcode & 1) === 1;
        const { reg, operand } = this.modrm();
        const value = wide
          ? opcode === 0x83
            ? this.fetchSigned8() & 0xffff
            : this.fetch16()
          : this.fetch8();
        const result = wide
          ? this.alu(reg, this.get16(operand), value, true)
          : this.alu(reg, this.get8(operand), value, false);
        if (result !== undefined) {
          if (wide) this.set16(operand, result);
          else this.set8(operand, result);
        }
        return operand.register ? 4 : 18 + operand.ea;
      }

      // --- test and exchange -------------------------------------------------
      case 0x84: {
        const { reg, operand } = this.modrm();
        this.setLogic(this.get8(operand) & this.reg8(reg), false);
        return operand.register ? 2 : 10 + operand.ea;
      }
      case 0x85: {
        const { reg, operand } = this.modrm();
        this.setLogic(this.get16(operand) & (this.regs[reg] as number), true);
        return operand.register ? 2 : 10 + operand.ea;
      }
      case 0x86: {
        const { reg, operand } = this.modrm();
        const left = this.get8(operand);
        this.set8(operand, this.reg8(reg));
        this.setReg8(reg, left);
        return operand.register ? 3 : 16 + operand.ea;
      }
      case 0x87: {
        const { reg, operand } = this.modrm();
        const left = this.get16(operand);
        this.set16(operand, this.regs[reg] as number);
        this.regs[reg] = left;
        return operand.register ? 3 : 16 + operand.ea;
      }

      // --- moves -------------------------------------------------------------
      case 0x88: {
        const { reg, operand } = this.modrm();
        this.set8(operand, this.reg8(reg));
        return operand.register ? 2 : 9 + operand.ea;
      }
      case 0x89: {
        const { reg, operand } = this.modrm();
        this.set16(operand, this.regs[reg] as number);
        return operand.register ? 2 : 9 + operand.ea;
      }
      case 0x8a: {
        const { reg, operand } = this.modrm();
        this.setReg8(reg, this.get8(operand));
        return operand.register ? 2 : 8 + operand.ea;
      }
      case 0x8b: {
        const { reg, operand } = this.modrm();
        this.regs[reg] = this.get16(operand);
        return operand.register ? 2 : 8 + operand.ea;
      }
      case 0x8c: {
        const { reg, operand } = this.modrm();
        this.set16(operand, this.segs[reg & 3] as number);
        return operand.register ? 2 : 9 + operand.ea;
      }
      case 0x8d: {
        // `lea` wants the offset the addressing computed and nothing else, which
        // is why the operand carries it beside the address it resolved to.
        const { reg, operand } = this.modrm();
        if (operand.register) throw new CpuError("lea with a register operand");
        this.regs[reg] = operand.offset;
        return 2 + operand.ea;
      }
      case 0x8e: {
        const { reg, operand } = this.modrm();
        this.segs[reg & 3] = this.get16(operand);
        return operand.register ? 2 : 8 + operand.ea;
      }
      case 0x8f: {
        const { operand } = this.modrm();
        this.set16(operand, this.pop());
        return operand.register ? 8 : 17 + operand.ea;
      }

      // --- xchg with the accumulator, and the nop that is one ----------------
      case 0x90:
        return 2;
      case 0x91:
      case 0x92:
      case 0x93:
      case 0x94:
      case 0x95:
      case 0x96:
      case 0x97: {
        const index = opcode & 7;
        const value = this.regs[AX] as number;
        this.regs[AX] = this.regs[index] as number;
        this.regs[index] = value;
        return 3;
      }

      case 0x98: {
        const low = this.reg8(AX);
        this.regs[AX] = low < 0x80 ? low : (low - 0x100) & 0xffff;
        return 2;
      }
      case 0x99: {
        const value = this.regs[AX] as number;
        this.regs[DX] = (value & 0x8000) !== 0 ? 0xffff : 0x0000;
        return 4;
      }
      case 0x9a: {
        const offset = this.fetch16();
        const segment = this.fetch16();
        this.push(this.segs[CS] as number);
        this.push(this.ip);
        this.segs[CS] = segment;
        this.ip = offset;
        return 20;
      }
      case 0x9c:
        this.push(this.flags);
        return 8;
      case 0x9d:
        this.flags = this.pop();
        return 8;

      // --- the accumulator's direct-address moves ----------------------------
      case 0xa0: {
        const address = this.physical(this.segmentOf(DS), this.fetch16());
        this.setReg8(AX, this.read8(address));
        return 10;
      }
      case 0xa1: {
        const address = this.physical(this.segmentOf(DS), this.fetch16());
        this.regs[AX] = this.read16(address);
        return 10;
      }
      case 0xa2: {
        const address = this.physical(this.segmentOf(DS), this.fetch16());
        this.write8(address, this.reg8(AX));
        return 9;
      }
      case 0xa3: {
        const address = this.physical(this.segmentOf(DS), this.fetch16());
        this.write16(address, this.regs[AX] as number);
        return 9;
      }

      // --- string operations -------------------------------------------------
      case 0xa4:
      case 0xa5:
      case 0xa6:
      case 0xa7:
      case 0xaa:
      case 0xab:
      case 0xac:
      case 0xad:
      case 0xae:
      case 0xaf:
        return this.string(opcode);

      case 0xa8:
        this.setLogic(this.reg8(AX) & this.fetch8(), false);
        return 4;
      case 0xa9:
        this.setLogic((this.regs[AX] as number) & this.fetch16(), true);
        return 4;

      // --- immediates into registers -----------------------------------------
      case 0xb0:
      case 0xb1:
      case 0xb2:
      case 0xb3:
      case 0xb4:
      case 0xb5:
      case 0xb6:
      case 0xb7:
        this.setReg8(opcode & 7, this.fetch8());
        return 4;
      case 0xb8:
      case 0xb9:
      case 0xba:
      case 0xbb:
      case 0xbc:
      case 0xbd:
      case 0xbe:
      case 0xbf:
        this.regs[opcode & 7] = this.fetch16();
        return 4;

      // --- shifts by an immediate, which is the 80186's addition -------------
      case 0xc0:
      case 0xc1: {
        const wide = (opcode & 1) === 1;
        const { reg, operand } = this.modrm();
        const count = this.fetch8();
        const value = wide ? this.get16(operand) : this.get8(operand);
        const result = this.shift(reg, value, count, wide);
        if (wide) this.set16(operand, result);
        else this.set8(operand, result);
        return (operand.register ? 5 : 17 + operand.ea) + count;
      }

      case 0xc2: {
        const drop = this.fetch16();
        this.ip = this.pop();
        this.regs[SP] = ((this.regs[SP] as number) + drop) & 0xffff;
        return 20;
      }
      case 0xc3:
        this.ip = this.pop();
        return 15;
      case 0xc6: {
        const { operand } = this.modrm();
        this.set8(operand, this.fetch8());
        return operand.register ? 4 : 11 + operand.ea;
      }
      case 0xc7: {
        const { operand } = this.modrm();
        this.set16(operand, this.fetch16());
        return operand.register ? 4 : 11 + operand.ea;
      }
      case 0xcb: {
        this.ip = this.pop();
        this.segs[CS] = this.pop();
        return 22;
      }
      case 0xcf: {
        this.ip = this.pop();
        this.segs[CS] = this.pop();
        this.flags = this.pop();
        return 24;
      }

      // --- shifts by one and by cl -------------------------------------------
      case 0xd0:
      case 0xd1:
      case 0xd2:
      case 0xd3: {
        const wide = (opcode & 1) === 1;
        const byCl = (opcode & 2) !== 0;
        const { reg, operand } = this.modrm();
        const count = byCl ? this.reg8(CX) : 1;
        const value = wide ? this.get16(operand) : this.get8(operand);
        const result = this.shift(reg, value, count, wide);
        if (wide) this.set16(operand, result);
        else this.set8(operand, result);
        if (!byCl) return operand.register ? 2 : 15 + operand.ea;
        return (operand.register ? 5 : 17 + operand.ea) + count;
      }

      // --- loops -------------------------------------------------------------
      case 0xe0:
      case 0xe1:
      case 0xe2: {
        const delta = this.fetchSigned8();
        const count = ((this.regs[CX] as number) - 1) & 0xffff;
        this.regs[CX] = count;
        const zero = opcode === 0xe0 ? !this.zf : opcode === 0xe1 ? this.zf : true;
        if (count !== 0 && zero) {
          this.ip = (this.ip + delta) & 0xffff;
          return 13;
        }
        return 5;
      }
      case 0xe3: {
        const delta = this.fetchSigned8();
        if ((this.regs[CX] as number) === 0) {
          this.ip = (this.ip + delta) & 0xffff;
          return 13;
        }
        return 5;
      }

      // --- ports -------------------------------------------------------------
      case 0xe4:
        this.setReg8(AX, this.bus.readPort(this.fetch8()) & 0xff);
        return 9;
      case 0xe5: {
        const port = this.fetch8();
        this.regs[AX] =
          (this.bus.readPort(port) & 0xff) | ((this.bus.readPort(port + 1) & 0xff) << 8);
        return 13;
      }
      case 0xe6:
        this.bus.writePort(this.fetch8(), this.reg8(AX));
        return 8;
      case 0xe7: {
        const port = this.fetch8();
        const value = this.regs[AX] as number;
        this.bus.writePort(port, value & 0xff);
        this.bus.writePort(port + 1, (value >> 8) & 0xff);
        return 12;
      }
      case 0xec:
        this.setReg8(AX, this.bus.readPort(this.regs[DX] as number) & 0xff);
        return 8;
      case 0xed: {
        const port = this.regs[DX] as number;
        this.regs[AX] =
          (this.bus.readPort(port) & 0xff) | ((this.bus.readPort(port + 1) & 0xff) << 8);
        return 12;
      }
      case 0xee:
        this.bus.writePort(this.regs[DX] as number, this.reg8(AX));
        return 8;
      case 0xef: {
        const port = this.regs[DX] as number;
        const value = this.regs[AX] as number;
        this.bus.writePort(port, value & 0xff);
        this.bus.writePort(port + 1, (value >> 8) & 0xff);
        return 12;
      }

      // --- unconditional transfers -------------------------------------------
      case 0xe8: {
        const delta = this.fetch16();
        this.push(this.ip);
        this.ip = (this.ip + delta) & 0xffff;
        return 20;
      }
      case 0xe9: {
        const delta = this.fetch16();
        this.ip = (this.ip + delta) & 0xffff;
        return 12;
      }
      case 0xea: {
        const offset = this.fetch16();
        this.segs[CS] = this.fetch16();
        this.ip = offset;
        return 15;
      }
      case 0xeb: {
        const delta = this.fetchSigned8();
        this.ip = (this.ip + delta) & 0xffff;
        return 12;
      }

      // --- flags and idling --------------------------------------------------
      case 0xf4:
        this.halted = true;
        return 8;
      case 0xf5:
        this.cf = !this.cf;
        return 4;
      case 0xf8:
        this.cf = false;
        return 4;
      case 0xf9:
        this.cf = true;
        return 4;
      case 0xfa:
        this.intEnable = false;
        return 4;
      case 0xfb:
        this.intEnable = true;
        return 4;
      case 0xfc:
        this.df = false;
        return 4;
      case 0xfd:
        this.df = true;
        return 4;

      // --- the unary groups --------------------------------------------------
      case 0xf6:
      case 0xf7:
        return this.unary(opcode);
      case 0xfe:
      case 0xff:
        return this.incGroup(opcode);

      default:
        throw new CpuError(
          `unimplemented opcode $${opcode.toString(16).padStart(2, "0")} at ` +
            `${((this.segs[CS] as number) & 0xffff).toString(16)}:${this.start.toString(16)}`,
        );
    }
  }

  /** Whether a condition holds, by its number in the branch block. */
  private condition(code: number): boolean {
    switch (code) {
      case 0x0:
        return this.of;
      case 0x1:
        return !this.of;
      case 0x2:
        return this.cf;
      case 0x3:
        return !this.cf;
      case 0x4:
        return this.zf;
      case 0x5:
        return !this.zf;
      case 0x6:
        return this.cf || this.zf;
      case 0x7:
        return !this.cf && !this.zf;
      case 0x8:
        return this.sf;
      case 0x9:
        return !this.sf;
      case 0xa:
        return this.pf;
      case 0xb:
        return !this.pf;
      case 0xc:
        return this.sf !== this.of;
      case 0xd:
        return this.sf === this.of;
      case 0xe:
        return this.zf || this.sf !== this.of;
      default:
        return !this.zf && this.sf === this.of;
    }
  }

  /**
   * One iteration of a string operation, rewinding if a `rep` has more to do.
   *
   * Rewinding to {@link start} rather than looping here is what makes a repeated
   * copy interruptible and its cycle count honest: two kilobytes of tilemap is a
   * thousand steps of the machine rather than one that takes ten thousand cycles
   * with nothing else able to happen.
   */
  private string(opcode: number): number {
    const wide = (opcode & 1) === 1;
    const size = wide ? 2 : 1;
    const step = this.df ? -size : size;
    if (this.repeat !== 0 && (this.regs[CX] as number) === 0) return 4;

    const source = () => this.physical(this.segmentOf(DS), this.regs[SI] as number);
    const destination = () => this.physical(ES, this.regs[DI] as number);
    let compared = false;
    let equal = false;
    switch (opcode) {
      case 0xa4:
      case 0xa5: {
        const value = wide ? this.read16(source()) : this.read8(source());
        if (wide) this.write16(destination(), value);
        else this.write8(destination(), value);
        this.regs[SI] = ((this.regs[SI] as number) + step) & 0xffff;
        this.regs[DI] = ((this.regs[DI] as number) + step) & 0xffff;
        break;
      }
      case 0xa6:
      case 0xa7: {
        const left = wide ? this.read16(source()) : this.read8(source());
        const right = wide ? this.read16(destination()) : this.read8(destination());
        this.setSub(left, right, 0, wide);
        this.regs[SI] = ((this.regs[SI] as number) + step) & 0xffff;
        this.regs[DI] = ((this.regs[DI] as number) + step) & 0xffff;
        compared = true;
        equal = this.zf;
        break;
      }
      case 0xaa:
      case 0xab: {
        if (wide) this.write16(destination(), this.regs[AX] as number);
        else this.write8(destination(), this.reg8(AX));
        this.regs[DI] = ((this.regs[DI] as number) + step) & 0xffff;
        break;
      }
      case 0xac:
      case 0xad: {
        if (wide) this.regs[AX] = this.read16(source());
        else this.setReg8(AX, this.read8(source()));
        this.regs[SI] = ((this.regs[SI] as number) + step) & 0xffff;
        break;
      }
      default: {
        const value = wide ? this.read16(destination()) : this.read8(destination());
        this.setSub(wide ? (this.regs[AX] as number) : this.reg8(AX), value, 0, wide);
        this.regs[DI] = ((this.regs[DI] as number) + step) & 0xffff;
        compared = true;
        equal = this.zf;
        break;
      }
    }

    if (this.repeat === 0) return 11;
    const count = ((this.regs[CX] as number) - 1) & 0xffff;
    this.regs[CX] = count;
    const stop = count === 0 || (compared && (this.repeat === 0xf3 ? !equal : equal));
    if (!stop) this.ip = this.start;
    return 8;
  }

  /** The `F6`/`F7` group: `test`, `not`, `neg` and the multiplies. */
  private unary(opcode: number): number {
    const wide = (opcode & 1) === 1;
    const { reg, operand } = this.modrm();
    switch (reg) {
      case 0:
      case 1: {
        const value = wide ? this.fetch16() : this.fetch8();
        this.setLogic((wide ? this.get16(operand) : this.get8(operand)) & value, wide);
        return operand.register ? 4 : 10 + operand.ea;
      }
      case 2: {
        const value = wide ? this.get16(operand) : this.get8(operand);
        // `not` touches no flag at all, which is the one place this group is not
        // an ordinary logical operation.
        if (wide) this.set16(operand, ~value & 0xffff);
        else this.set8(operand, ~value & 0xff);
        return operand.register ? 2 : 16 + operand.ea;
      }
      case 3: {
        const value = wide ? this.get16(operand) : this.get8(operand);
        const result = this.setSub(0, value, 0, wide);
        if (wide) this.set16(operand, result);
        else this.set8(operand, result);
        this.cf = value !== 0;
        return operand.register ? 2 : 16 + operand.ea;
      }
      case 4: {
        if (wide) {
          const product = (this.regs[AX] as number) * this.get16(operand);
          this.regs[AX] = product & 0xffff;
          this.regs[DX] = (product >>> 16) & 0xffff;
          this.cf = this.of = (this.regs[DX] as number) !== 0;
          return 21;
        }
        const product = this.reg8(AX) * this.get8(operand);
        this.regs[AX] = product & 0xffff;
        this.cf = this.of = (product & 0xff00) !== 0;
        return 15;
      }
      case 5: {
        const sign16 = (value: number) => (value & 0x8000 ? value - 0x10000 : value);
        const sign8 = (value: number) => (value & 0x80 ? value - 0x100 : value);
        if (wide) {
          const product = sign16(this.regs[AX] as number) * sign16(this.get16(operand));
          this.regs[AX] = product & 0xffff;
          this.regs[DX] = (product >> 16) & 0xffff;
          const low = product & 0xffff;
          this.cf = this.of = product !== (low & 0x8000 ? low - 0x10000 : low);
          return 24;
        }
        const product = sign8(this.reg8(AX)) * sign8(this.get8(operand));
        this.regs[AX] = product & 0xffff;
        this.cf = this.of = product < -128 || product > 127;
        return 18;
      }
      case 6: {
        if (wide) {
          const divisor = this.get16(operand);
          if (divisor === 0) throw new CpuError("divide by zero");
          const dividend = ((this.regs[DX] as number) << 16) + (this.regs[AX] as number);
          const quotient = Math.floor(dividend / divisor);
          if (quotient > 0xffff) throw new CpuError("divide overflow");
          this.regs[AX] = quotient & 0xffff;
          this.regs[DX] = dividend % divisor;
          return 25;
        }
        const divisor = this.get8(operand);
        if (divisor === 0) throw new CpuError("divide by zero");
        const dividend = this.regs[AX] as number;
        const quotient = Math.floor(dividend / divisor);
        if (quotient > 0xff) throw new CpuError("divide overflow");
        this.setReg8(AX, quotient);
        this.setReg8(AX + 4, dividend % divisor);
        return 19;
      }
      default: {
        if (wide) {
          const raw = this.get16(operand);
          const divisor = raw & 0x8000 ? raw - 0x10000 : raw;
          if (divisor === 0) throw new CpuError("divide by zero");
          const unsigned = ((this.regs[DX] as number) << 16) + (this.regs[AX] as number);
          const dividend = unsigned >= 0x80000000 ? unsigned - 0x100000000 : unsigned;
          const quotient = Math.trunc(dividend / divisor);
          if (quotient > 32767 || quotient < -32768) throw new CpuError("divide overflow");
          this.regs[AX] = quotient & 0xffff;
          this.regs[DX] = (dividend - quotient * divisor) & 0xffff;
          return 29;
        }
        const raw = this.get8(operand);
        const divisor = raw & 0x80 ? raw - 0x100 : raw;
        if (divisor === 0) throw new CpuError("divide by zero");
        const value = this.regs[AX] as number;
        const dividend = value & 0x8000 ? value - 0x10000 : value;
        const quotient = Math.trunc(dividend / divisor);
        if (quotient > 127 || quotient < -128) throw new CpuError("divide overflow");
        this.setReg8(AX, quotient);
        this.setReg8(AX + 4, dividend - quotient * divisor);
        return 23;
      }
    }
  }

  /** The `FE`/`FF` group: `inc`, `dec`, and the indirect transfers. */
  private incGroup(opcode: number): number {
    const wide = (opcode & 1) === 1;
    const { reg, operand } = this.modrm();
    switch (reg) {
      case 0: {
        const carry = this.cf;
        const value = wide ? this.get16(operand) : this.get8(operand);
        const result = this.setAdd(value, 1, 0, wide);
        if (wide) this.set16(operand, result);
        else this.set8(operand, result);
        this.cf = carry;
        return operand.register ? 2 : 16 + operand.ea;
      }
      case 1: {
        const carry = this.cf;
        const value = wide ? this.get16(operand) : this.get8(operand);
        const result = this.setSub(value, 1, 0, wide);
        if (wide) this.set16(operand, result);
        else this.set8(operand, result);
        this.cf = carry;
        return operand.register ? 2 : 16 + operand.ea;
      }
      case 2: {
        this.push(this.ip);
        this.ip = this.get16(operand);
        return operand.register ? 16 : 21 + operand.ea;
      }
      case 4: {
        this.ip = this.get16(operand);
        return operand.register ? 11 : 18 + operand.ea;
      }
      case 5: {
        if (operand.register) throw new CpuError("jmp far through a register");
        this.ip = this.read16(operand.address);
        this.segs[CS] = this.read16((operand.address + 2) & 0xfffff);
        return 24;
      }
      case 6:
        this.push(this.get16(operand));
        return operand.register ? 8 : 16 + operand.ea;
      default:
        throw new CpuError(`unimplemented group opcode $${opcode.toString(16)}/${reg}`);
    }
  }
}
