/**
 * The SM83 processor.
 *
 * Written out rather than pulled in, for the same reason the PNG codec and the
 * math kernels are ours (doc 02): this core decides what "the ROM works" means,
 * it runs in the browser under doc 07's no-CDN rule, and it is the harness the
 * Demotic runtime's conformance test drives. A dependency we cannot read is a
 * dependency we cannot trust with any of those jobs.
 *
 * Scope is deliberately DMG: no CGB double speed, no MBC, no sound. That is
 * exactly what a `demake build` ROM needs, and every line not written is a line
 * that cannot be wrong. Instruction timings are the published machine-cycle
 * counts ×4, which is what the PPU and timer below are clocked with.
 */

/** Everything the processor can reach. */
export interface Bus {
  read(address: number): number;
  write(address: number, value: number): void;
}

/** Interrupt bits, in priority order. */
export const INT = { vblank: 1, stat: 2, timer: 4, serial: 8, joypad: 16 } as const;

/** Base machine-cycle cost of each unprefixed opcode, ×4. Conditional branches
 * add their taken cost separately. */
// prettier-ignore
const CYCLES: readonly number[] = [
   4,12, 8, 8, 4, 4, 8, 4,20, 8, 8, 8, 4, 4, 8, 4,
   4,12, 8, 8, 4, 4, 8, 4,12, 8, 8, 8, 4, 4, 8, 4,
   8,12, 8, 8, 4, 4, 8, 4, 8, 8, 8, 8, 4, 4, 8, 4,
   8,12, 8, 8,12,12,12, 4, 8, 8, 8, 8, 4, 4, 8, 4,
   4, 4, 4, 4, 4, 4, 8, 4, 4, 4, 4, 4, 4, 4, 8, 4,
   4, 4, 4, 4, 4, 4, 8, 4, 4, 4, 4, 4, 4, 4, 8, 4,
   4, 4, 4, 4, 4, 4, 8, 4, 4, 4, 4, 4, 4, 4, 8, 4,
   8, 8, 8, 8, 8, 8, 4, 8, 4, 4, 4, 4, 4, 4, 8, 4,
   4, 4, 4, 4, 4, 4, 8, 4, 4, 4, 4, 4, 4, 4, 8, 4,
   4, 4, 4, 4, 4, 4, 8, 4, 4, 4, 4, 4, 4, 4, 8, 4,
   4, 4, 4, 4, 4, 4, 8, 4, 4, 4, 4, 4, 4, 4, 8, 4,
   4, 4, 4, 4, 4, 4, 8, 4, 4, 4, 4, 4, 4, 4, 8, 4,
   8,12,12,16,12,16, 8,16, 8,16,12, 4,12,24, 8,16,
   8,12,12, 0,12,16, 8,16, 8,16,12, 0,12, 0, 8,16,
  12,12, 8, 0, 0,16, 8,16,16, 4,16, 0, 0, 0, 8,16,
  12,12, 8, 4, 0,16, 8,16,12, 8,16, 4, 0, 0, 8,16,
];

/** The SM83 register file and instruction decoder. */
export class Cpu {
  a = 0x01;
  f = 0xb0;
  b = 0x00;
  c = 0x13;
  d = 0x00;
  e = 0xd8;
  h = 0x01;
  l = 0x4d;
  sp = 0xfffe;
  pc = 0x0100;

  /** Interrupt master enable. */
  ime = false;
  /** `ei` enables interrupts after the *following* instruction. */
  private imePending = false;
  halted = false;

  constructor(private readonly bus: Bus) {}

  private get zero(): boolean {
    return (this.f & 0x80) !== 0;
  }
  private get negative(): boolean {
    return (this.f & 0x40) !== 0;
  }
  private get half(): boolean {
    return (this.f & 0x20) !== 0;
  }
  private get carry(): boolean {
    return (this.f & 0x10) !== 0;
  }

  private setFlags(z: boolean, n: boolean, h: boolean, c: boolean): void {
    this.f = (z ? 0x80 : 0) | (n ? 0x40 : 0) | (h ? 0x20 : 0) | (c ? 0x10 : 0);
  }

  private fetch(): number {
    const value = this.bus.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return value;
  }

  private fetch16(): number {
    const low = this.fetch();
    return low | (this.fetch() << 8);
  }

  private push(value: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.bus.write(this.sp, (value >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this.bus.write(this.sp, value & 0xff);
  }

  private pop(): number {
    const low = this.bus.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const high = this.bus.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return low | (high << 8);
  }

  private hl(): number {
    return (this.h << 8) | this.l;
  }

  private setHl(value: number): void {
    this.h = (value >> 8) & 0xff;
    this.l = value & 0xff;
  }

  /** Registers in opcode order: B C D E H L (HL) A. */
  private getR(index: number): number {
    switch (index) {
      case 0:
        return this.b;
      case 1:
        return this.c;
      case 2:
        return this.d;
      case 3:
        return this.e;
      case 4:
        return this.h;
      case 5:
        return this.l;
      case 6:
        return this.bus.read(this.hl());
      default:
        return this.a;
    }
  }

  private setR(index: number, value: number): void {
    const byte = value & 0xff;
    switch (index) {
      case 0:
        this.b = byte;
        break;
      case 1:
        this.c = byte;
        break;
      case 2:
        this.d = byte;
        break;
      case 3:
        this.e = byte;
        break;
      case 4:
        this.h = byte;
        break;
      case 5:
        this.l = byte;
        break;
      case 6:
        this.bus.write(this.hl(), byte);
        break;
      default:
        this.a = byte;
        break;
    }
  }

  /**
   * Take the highest-priority pending interrupt, if any.
   *
   * Returns the cycles spent. `halt` wakes on a pending interrupt even with
   * `ime` clear, which is how a runtime can idle to VBlank without enabling
   * anything — the shape our runtime's main loop uses.
   */
  serviceInterrupts(enabled: number, flags: number, clear: (bit: number) => void): number {
    const pending = enabled & flags & 0x1f;
    if (pending === 0) return 0;
    this.halted = false;
    if (!this.ime) return 0;
    this.ime = false;
    for (let bit = 0; bit < 5; bit += 1) {
      const mask = 1 << bit;
      if ((pending & mask) === 0) continue;
      clear(mask);
      this.push(this.pc);
      this.pc = 0x40 + bit * 8;
      return 20;
    }
    return 0;
  }

  /** Execute one instruction; returns the T-cycles it took. */
  step(): number {
    if (this.imePending) {
      this.imePending = false;
      this.ime = true;
    }
    if (this.halted) return 4;

    const opcode = this.fetch();
    let cycles = CYCLES[opcode] ?? 4;

    // 0x40..0x7F — LD r, r' with 0x76 stolen for HALT.
    if (opcode >= 0x40 && opcode <= 0x7f) {
      if (opcode === 0x76) {
        this.halted = true;
        return cycles;
      }
      this.setR((opcode >> 3) & 7, this.getR(opcode & 7));
      return cycles;
    }

    // 0x80..0xBF — arithmetic and logic against A.
    if (opcode >= 0x80 && opcode <= 0xbf) {
      this.alu((opcode >> 3) & 7, this.getR(opcode & 7));
      return cycles;
    }

    switch (opcode) {
      case 0x00:
        break;
      case 0x10: // STOP — a one-byte opcode with a padding byte after it.
        this.fetch();
        break;
      case 0xf3:
        this.ime = false;
        this.imePending = false;
        break;
      case 0xfb:
        this.imePending = true;
        break;

      // --- 16-bit loads ------------------------------------------------------
      case 0x01: {
        const value = this.fetch16();
        this.b = value >> 8;
        this.c = value & 0xff;
        break;
      }
      case 0x11: {
        const value = this.fetch16();
        this.d = value >> 8;
        this.e = value & 0xff;
        break;
      }
      case 0x21:
        this.setHl(this.fetch16());
        break;
      case 0x31:
        this.sp = this.fetch16();
        break;
      case 0x08: {
        const address = this.fetch16();
        this.bus.write(address, this.sp & 0xff);
        this.bus.write((address + 1) & 0xffff, (this.sp >> 8) & 0xff);
        break;
      }
      case 0xf9:
        this.sp = this.hl();
        break;
      case 0xf8: {
        const offset = signed(this.fetch());
        const result = (this.sp + offset) & 0xffff;
        this.setFlags(
          false,
          false,
          (this.sp & 0x0f) + (offset & 0x0f) > 0x0f,
          (this.sp & 0xff) + (offset & 0xff) > 0xff,
        );
        this.setHl(result);
        break;
      }
      case 0xe8: {
        const offset = signed(this.fetch());
        this.setFlags(
          false,
          false,
          (this.sp & 0x0f) + (offset & 0x0f) > 0x0f,
          (this.sp & 0xff) + (offset & 0xff) > 0xff,
        );
        this.sp = (this.sp + offset) & 0xffff;
        break;
      }

      // --- 8-bit loads -------------------------------------------------------
      case 0x02:
        this.bus.write((this.b << 8) | this.c, this.a);
        break;
      case 0x12:
        this.bus.write((this.d << 8) | this.e, this.a);
        break;
      case 0x22:
        this.bus.write(this.hl(), this.a);
        this.setHl((this.hl() + 1) & 0xffff);
        break;
      case 0x32:
        this.bus.write(this.hl(), this.a);
        this.setHl((this.hl() - 1) & 0xffff);
        break;
      case 0x0a:
        this.a = this.bus.read((this.b << 8) | this.c);
        break;
      case 0x1a:
        this.a = this.bus.read((this.d << 8) | this.e);
        break;
      case 0x2a:
        this.a = this.bus.read(this.hl());
        this.setHl((this.hl() + 1) & 0xffff);
        break;
      case 0x3a:
        this.a = this.bus.read(this.hl());
        this.setHl((this.hl() - 1) & 0xffff);
        break;
      case 0x06:
      case 0x0e:
      case 0x16:
      case 0x1e:
      case 0x26:
      case 0x2e:
      case 0x36:
      case 0x3e:
        this.setR((opcode >> 3) & 7, this.fetch());
        break;
      case 0xe0:
        this.bus.write(0xff00 + this.fetch(), this.a);
        break;
      case 0xf0:
        this.a = this.bus.read(0xff00 + this.fetch());
        break;
      case 0xe2:
        this.bus.write(0xff00 + this.c, this.a);
        break;
      case 0xf2:
        this.a = this.bus.read(0xff00 + this.c);
        break;
      case 0xea:
        this.bus.write(this.fetch16(), this.a);
        break;
      case 0xfa:
        this.a = this.bus.read(this.fetch16());
        break;

      // --- 16-bit arithmetic -------------------------------------------------
      case 0x03:
        this.setPair(0, this.pair(0) + 1);
        break;
      case 0x13:
        this.setPair(1, this.pair(1) + 1);
        break;
      case 0x23:
        this.setPair(2, this.pair(2) + 1);
        break;
      case 0x33:
        this.sp = (this.sp + 1) & 0xffff;
        break;
      case 0x0b:
        this.setPair(0, this.pair(0) - 1);
        break;
      case 0x1b:
        this.setPair(1, this.pair(1) - 1);
        break;
      case 0x2b:
        this.setPair(2, this.pair(2) - 1);
        break;
      case 0x3b:
        this.sp = (this.sp - 1) & 0xffff;
        break;
      case 0x09:
      case 0x19:
      case 0x29:
      case 0x39: {
        const operand = opcode === 0x39 ? this.sp : this.pair((opcode >> 4) & 3);
        const before = this.hl();
        const sum = before + operand;
        this.f =
          (this.f & 0x80) |
          ((before & 0x0fff) + (operand & 0x0fff) > 0x0fff ? 0x20 : 0) |
          (sum > 0xffff ? 0x10 : 0);
        this.setHl(sum & 0xffff);
        break;
      }

      // --- 8-bit inc / dec ---------------------------------------------------
      case 0x04:
      case 0x0c:
      case 0x14:
      case 0x1c:
      case 0x24:
      case 0x2c:
      case 0x34:
      case 0x3c: {
        const index = (opcode >> 3) & 7;
        const before = this.getR(index);
        const result = (before + 1) & 0xff;
        this.setR(index, result);
        this.f =
          (this.f & 0x10) | (result === 0 ? 0x80 : 0) | ((before & 0x0f) === 0x0f ? 0x20 : 0);
        break;
      }
      case 0x05:
      case 0x0d:
      case 0x15:
      case 0x1d:
      case 0x25:
      case 0x2d:
      case 0x35:
      case 0x3d: {
        const index = (opcode >> 3) & 7;
        const before = this.getR(index);
        const result = (before - 1) & 0xff;
        this.setR(index, result);
        this.f =
          (this.f & 0x10) |
          0x40 |
          (result === 0 ? 0x80 : 0) |
          ((before & 0x0f) === 0x00 ? 0x20 : 0);
        break;
      }

      // --- rotates on A (always clear Z) --------------------------------------
      case 0x07: {
        const carry = (this.a & 0x80) !== 0;
        this.a = ((this.a << 1) | (carry ? 1 : 0)) & 0xff;
        this.setFlags(false, false, false, carry);
        break;
      }
      case 0x0f: {
        const carry = (this.a & 1) !== 0;
        this.a = ((this.a >> 1) | (carry ? 0x80 : 0)) & 0xff;
        this.setFlags(false, false, false, carry);
        break;
      }
      case 0x17: {
        const carry = (this.a & 0x80) !== 0;
        this.a = ((this.a << 1) | (this.carry ? 1 : 0)) & 0xff;
        this.setFlags(false, false, false, carry);
        break;
      }
      case 0x1f: {
        const carry = (this.a & 1) !== 0;
        this.a = ((this.a >> 1) | (this.carry ? 0x80 : 0)) & 0xff;
        this.setFlags(false, false, false, carry);
        break;
      }

      case 0x27: {
        // DAA — the one instruction whose behaviour depends on the previous op.
        let adjust = 0;
        let carry = this.carry;
        if (this.half || (!this.negative && (this.a & 0x0f) > 9)) adjust |= 0x06;
        if (carry || (!this.negative && this.a > 0x99)) {
          adjust |= 0x60;
          carry = true;
        }
        this.a = (this.negative ? this.a - adjust : this.a + adjust) & 0xff;
        this.f = (this.a === 0 ? 0x80 : 0) | (this.negative ? 0x40 : 0) | (carry ? 0x10 : 0);
        break;
      }
      case 0x2f:
        this.a = ~this.a & 0xff;
        this.f |= 0x60;
        break;
      case 0x37:
        this.f = (this.f & 0x80) | 0x10;
        break;
      case 0x3f:
        this.f = (this.f & 0x80) | (this.carry ? 0 : 0x10);
        break;

      // --- jumps, calls, returns ---------------------------------------------
      case 0x18: {
        // The operand must be fetched *before* the base is read: `pc` advances
        // past it, and JR is relative to the next instruction.
        const offset = signed(this.fetch());
        this.pc = (this.pc + offset) & 0xffff;
        break;
      }
      case 0x20:
      case 0x28:
      case 0x30:
      case 0x38: {
        const offset = signed(this.fetch());
        if (this.condition((opcode >> 3) & 3)) {
          this.pc = (this.pc + offset) & 0xffff;
          cycles += 4;
        }
        break;
      }
      case 0xc3:
        this.pc = this.fetch16();
        break;
      case 0xe9:
        this.pc = this.hl();
        break;
      case 0xc2:
      case 0xca:
      case 0xd2:
      case 0xda: {
        const target = this.fetch16();
        if (this.condition((opcode >> 3) & 3)) {
          this.pc = target;
          cycles += 4;
        }
        break;
      }
      case 0xcd:
        {
          const target = this.fetch16();
          this.push(this.pc);
          this.pc = target;
        }
        break;
      case 0xc4:
      case 0xcc:
      case 0xd4:
      case 0xdc: {
        const target = this.fetch16();
        if (this.condition((opcode >> 3) & 3)) {
          this.push(this.pc);
          this.pc = target;
          cycles += 12;
        }
        break;
      }
      case 0xc9:
        this.pc = this.pop();
        break;
      case 0xd9:
        this.pc = this.pop();
        this.ime = true;
        break;
      case 0xc0:
      case 0xc8:
      case 0xd0:
      case 0xd8:
        if (this.condition((opcode >> 3) & 3)) {
          this.pc = this.pop();
          cycles += 12;
        }
        break;
      case 0xc7:
      case 0xcf:
      case 0xd7:
      case 0xdf:
      case 0xe7:
      case 0xef:
      case 0xf7:
      case 0xff:
        this.push(this.pc);
        this.pc = opcode & 0x38;
        break;

      // --- stack -------------------------------------------------------------
      case 0xc1:
        this.setPair(0, this.pop());
        break;
      case 0xd1:
        this.setPair(1, this.pop());
        break;
      case 0xe1:
        this.setPair(2, this.pop());
        break;
      case 0xf1: {
        const value = this.pop();
        this.a = (value >> 8) & 0xff;
        this.f = value & 0xf0;
        break;
      }
      case 0xc5:
        this.push(this.pair(0));
        break;
      case 0xd5:
        this.push(this.pair(1));
        break;
      case 0xe5:
        this.push(this.pair(2));
        break;
      case 0xf5:
        this.push((this.a << 8) | (this.f & 0xf0));
        break;

      // --- immediate ALU ------------------------------------------------------
      case 0xc6:
      case 0xce:
      case 0xd6:
      case 0xde:
      case 0xe6:
      case 0xee:
      case 0xf6:
      case 0xfe:
        this.alu((opcode >> 3) & 7, this.fetch());
        break;

      case 0xcb:
        cycles = this.prefixed();
        break;

      default:
        // Unmapped opcodes lock a real Game Boy; treat them as a hard stop so a
        // runtime bug surfaces as a hang the harness reports, not as drift.
        this.halted = true;
        break;
    }
    return cycles;
  }

  private pair(index: number): number {
    switch (index) {
      case 0:
        return (this.b << 8) | this.c;
      case 1:
        return (this.d << 8) | this.e;
      default:
        return this.hl();
    }
  }

  private setPair(index: number, value: number): void {
    const word = value & 0xffff;
    switch (index) {
      case 0:
        this.b = word >> 8;
        this.c = word & 0xff;
        break;
      case 1:
        this.d = word >> 8;
        this.e = word & 0xff;
        break;
      default:
        this.setHl(word);
        break;
    }
  }

  private condition(index: number): boolean {
    switch (index) {
      case 0:
        return !this.zero;
      case 1:
        return this.zero;
      case 2:
        return !this.carry;
      default:
        return this.carry;
    }
  }

  private alu(operation: number, operand: number): void {
    switch (operation) {
      case 0: {
        const sum = this.a + operand;
        this.setFlags(
          (sum & 0xff) === 0,
          false,
          (this.a & 0x0f) + (operand & 0x0f) > 0x0f,
          sum > 0xff,
        );
        this.a = sum & 0xff;
        break;
      }
      case 1: {
        const carry = this.carry ? 1 : 0;
        const sum = this.a + operand + carry;
        this.setFlags(
          (sum & 0xff) === 0,
          false,
          (this.a & 0x0f) + (operand & 0x0f) + carry > 0x0f,
          sum > 0xff,
        );
        this.a = sum & 0xff;
        break;
      }
      case 2: {
        const difference = this.a - operand;
        this.setFlags(
          (difference & 0xff) === 0,
          true,
          (this.a & 0x0f) < (operand & 0x0f),
          difference < 0,
        );
        this.a = difference & 0xff;
        break;
      }
      case 3: {
        const carry = this.carry ? 1 : 0;
        const difference = this.a - operand - carry;
        this.setFlags(
          (difference & 0xff) === 0,
          true,
          (this.a & 0x0f) - (operand & 0x0f) - carry < 0,
          difference < 0,
        );
        this.a = difference & 0xff;
        break;
      }
      case 4:
        this.a &= operand;
        this.setFlags(this.a === 0, false, true, false);
        break;
      case 5:
        this.a ^= operand;
        this.setFlags(this.a === 0, false, false, false);
        break;
      case 6:
        this.a |= operand;
        this.setFlags(this.a === 0, false, false, false);
        break;
      default: {
        const difference = this.a - operand;
        this.setFlags(
          (difference & 0xff) === 0,
          true,
          (this.a & 0x0f) < (operand & 0x0f),
          difference < 0,
        );
        break;
      }
    }
  }

  /** The `CB` page: rotates, shifts, and single-bit operations. */
  private prefixed(): number {
    const opcode = this.fetch();
    const index = opcode & 7;
    const cycles = index === 6 ? (opcode >= 0x40 && opcode < 0x80 ? 12 : 16) : 8;
    const value = this.getR(index);

    if (opcode < 0x40) {
      let result: number;
      let carry = false;
      switch (opcode >> 3) {
        case 0:
          carry = (value & 0x80) !== 0;
          result = ((value << 1) | (carry ? 1 : 0)) & 0xff;
          break;
        case 1:
          carry = (value & 1) !== 0;
          result = ((value >> 1) | (carry ? 0x80 : 0)) & 0xff;
          break;
        case 2:
          carry = (value & 0x80) !== 0;
          result = ((value << 1) | (this.carry ? 1 : 0)) & 0xff;
          break;
        case 3:
          carry = (value & 1) !== 0;
          result = ((value >> 1) | (this.carry ? 0x80 : 0)) & 0xff;
          break;
        case 4:
          carry = (value & 0x80) !== 0;
          result = (value << 1) & 0xff;
          break;
        case 5:
          carry = (value & 1) !== 0;
          result = ((value >> 1) | (value & 0x80)) & 0xff;
          break;
        case 6:
          result = ((value << 4) | (value >> 4)) & 0xff;
          break;
        default:
          carry = (value & 1) !== 0;
          result = (value >> 1) & 0xff;
          break;
      }
      this.setR(index, result);
      this.setFlags(result === 0, false, false, carry);
      return cycles;
    }

    const bit = (opcode >> 3) & 7;
    if (opcode < 0x80) {
      this.f = (this.f & 0x10) | 0x20 | ((value & (1 << bit)) === 0 ? 0x80 : 0);
    } else if (opcode < 0xc0) {
      this.setR(index, value & ~(1 << bit));
    } else {
      this.setR(index, value | (1 << bit));
    }
    return cycles;
  }
}

function signed(byte: number): number {
  return byte > 127 ? byte - 256 : byte;
}
