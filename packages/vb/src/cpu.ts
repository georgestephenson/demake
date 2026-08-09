/**
 * A NEC V810 interpreter — the Virtual Boy's processor.
 *
 * Written against the published instruction set rather than transcribed from
 * another emulator, and driven in its tests by `@demake/core`'s own encoder,
 * which is in turn pinned against the published format tables. That is the
 * two-oracle arrangement every core in this project has (`@demake/ngp`,
 * `@demake/wsc`): an encoder and a decoder that agreed with each other and not
 * with the hardware would still have to survive running the example library in a
 * *third-party* emulator, which is what the pixel-perfect E2E is for.
 *
 * Four things about this processor shape the file:
 *
 *   - **Everything is a register.** Thirty-two of them, thirty-two bits each,
 *     with `r0` hardwired to zero — so the interpreter is an {@link Int32Array}
 *     and a write to register 0 is discarded rather than special-cased at every
 *     call site.
 *   - **An instruction is two bytes or four**, decided by its top six bits, so
 *     {@link V810.step} fetches one halfword and only reads a second where the
 *     format says there is one.
 *   - **A displacement is measured from the instruction's own address**, not
 *     from the one after it. Every other machine in this project does the
 *     opposite, which is exactly why it is stated here as well as in the
 *     encoder.
 *   - **There is a hardware multiply and divide**, and both write a *second*
 *     register: the high half of a product and the remainder of a quotient go to
 *     `r30`, whether the program wanted them or not. A backend that kept
 *     something live there across a `mul` would find it gone.
 *
 * The floating-point page and the bit-string instructions are **absent rather
 * than half-implemented**, and each raises: nothing a demade cartridge does
 * reaches either, and a model that answered plausibly for hardware nobody drives
 * is one nobody is checking.
 *
 * Sources: NEC — *V810 Family 32-bit Microprocessor User's Manual* (U10082EJ),
 * §3 registers, §4 exception processing, §5 instruction set; the Virtual Boy
 * *Sacred Tech Scroll* instruction appendix for the mnemonics and the exception
 * codes this console's peripherals raise.
 */

/** What the processor reads and writes. */
export interface Bus {
  read(address: number): number;
  write(address: number, value: number): void;
}

/** Raised when the program reaches something this model does not implement. */
export class CpuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CpuError";
  }
}

/** `PSW` bit: the last result was zero. */
export const PSW_Z = 1 << 0;
/** `PSW` bit: the last result was negative. */
export const PSW_S = 1 << 1;
/** `PSW` bit: the last result overflowed a signed 32-bit value. */
export const PSW_OV = 1 << 2;
/** `PSW` bit: the last result carried out of bit 31. */
export const PSW_CY = 1 << 3;
/** `PSW` bit: interrupts are masked. */
export const PSW_ID = 1 << 12;
/** `PSW` bit: an exception is being handled. */
export const PSW_EP = 1 << 14;
/** `PSW` bit: a non-maskable exception is being handled. */
export const PSW_NP = 1 << 15;

/** Register 30, which `mul` and `div` write whether or not anyone asked. */
export const R30 = 30;
/** Register 31, where `jal` leaves the return address. */
export const R31 = 31;

/**
 * Cycle counts, in the processor's own clock.
 *
 * Approximate, and deliberately so: what a conformance harness needs from them
 * is that a frame is the right *length*, because that is what decides how many
 * game ticks happen in one. Nothing in this project branches on an instruction
 * count, and a model that claimed exact V810 pipeline timing would be claiming
 * something no reference this project could reach states in full.
 */
const CYCLE_ALU = 1;
const CYCLE_LOAD = 4;
const CYCLE_STORE = 1;
const CYCLE_BRANCH_TAKEN = 3;
const CYCLE_JUMP = 3;
const CYCLE_MUL = 13;
const CYCLE_DIV = 38;

export class V810 {
  /** `r0`–`r31`. Register 0 reads as zero and discards what is written to it. */
  readonly r = new Int32Array(32);

  /** Where the next instruction is. */
  pc = 0;

  /** The program status word: the four flags, the masks and the exception bits. */
  psw = PSW_NP;

  /** Saved `PC` and `PSW` for a maskable exception. */
  eipc = 0;
  eipsw = 0;
  /** Saved `PC` and `PSW` for a non-maskable one. */
  fepc = 0;
  fepsw = 0;
  /** The code of the exception being handled. */
  ecr = 0xfff0;
  /** The cache control word, which a program writes and nothing here reads. */
  chcw = 0;
  /** The address-trap register, likewise. */
  adtre = 0;

  /** Set by `halt`, cleared by an interrupt. */
  halted = false;

  constructor(private readonly bus: Bus) {}

  /** Point the processor at an address, as a reset does. */
  reset(pc: number): void {
    this.r.fill(0);
    this.pc = pc >>> 0;
    this.psw = PSW_NP;
    this.halted = false;
  }

  // --- flags -----------------------------------------------------------------

  private setFlag(mask: number, on: boolean): void {
    this.psw = on ? this.psw | mask : this.psw & ~mask;
  }

  private flag(mask: number): boolean {
    return (this.psw & mask) !== 0;
  }

  /** Set `Z` and `S` from a result, which every arithmetic instruction does. */
  private logicFlags(value: number): void {
    this.setFlag(PSW_Z, value === 0);
    this.setFlag(PSW_S, value < 0);
    this.setFlag(PSW_OV, false);
  }

  /** `a + b`, with all four flags. */
  private addFlags(a: number, b: number): number {
    const sum = (a + b) | 0;
    this.setFlag(PSW_Z, sum === 0);
    this.setFlag(PSW_S, sum < 0);
    this.setFlag(PSW_CY, (a >>> 0) + (b >>> 0) > 0xffffffff);
    this.setFlag(PSW_OV, ((a ^ sum) & (b ^ sum) & 0x80000000) !== 0);
    return sum;
  }

  /** `a − b`, with all four flags. Carry here means *borrow*, unlike the 6502. */
  private subFlags(a: number, b: number): number {
    const diff = (a - b) | 0;
    this.setFlag(PSW_Z, diff === 0);
    this.setFlag(PSW_S, diff < 0);
    this.setFlag(PSW_CY, a >>> 0 < b >>> 0);
    this.setFlag(PSW_OV, ((a ^ b) & (a ^ diff) & 0x80000000) !== 0);
    return diff;
  }

  /** Whether a condition holds, in the encoding's own order. */
  condition(code: number): boolean {
    const s = this.flag(PSW_S);
    const ov = this.flag(PSW_OV);
    const cy = this.flag(PSW_CY);
    const z = this.flag(PSW_Z);
    switch (code & 0xf) {
      case 0x0:
        return ov;
      case 0x1:
        return cy;
      case 0x2:
        return z;
      case 0x3:
        return cy || z;
      case 0x4:
        return s;
      case 0x5:
        return true;
      case 0x6:
        return s !== ov;
      case 0x7:
        return s !== ov || z;
      case 0x8:
        return !ov;
      case 0x9:
        return !cy;
      case 0xa:
        return !z;
      case 0xb:
        return !(cy || z);
      case 0xc:
        return !s;
      case 0xd:
        return false;
      case 0xe:
        return s === ov;
      default:
        return !(s !== ov || z);
    }
  }

  // --- memory ----------------------------------------------------------------

  private readHalf(address: number): number {
    const at = address & ~1;
    return this.bus.read(at) | (this.bus.read(at + 1) << 8);
  }

  private readWord(address: number): number {
    const at = address & ~3;
    return (
      this.bus.read(at) |
      (this.bus.read(at + 1) << 8) |
      (this.bus.read(at + 2) << 16) |
      (this.bus.read(at + 3) << 24) |
      0
    );
  }

  private writeHalf(address: number, value: number): void {
    const at = address & ~1;
    this.bus.write(at, value & 0xff);
    this.bus.write(at + 1, (value >> 8) & 0xff);
  }

  private writeWord(address: number, value: number): void {
    const at = address & ~3;
    this.bus.write(at, value & 0xff);
    this.bus.write(at + 1, (value >> 8) & 0xff);
    this.bus.write(at + 2, (value >> 16) & 0xff);
    this.bus.write(at + 3, (value >>> 24) & 0xff);
  }

  /** Write a register, discarding a write to `r0`. */
  private set(index: number, value: number): void {
    if (index !== 0) this.r[index] = value | 0;
  }

  // --- exceptions ------------------------------------------------------------

  /**
   * Take a maskable interrupt, if the program is letting one in.
   *
   * Returns whether it was taken. `PSW.ID` masks it, and so does already being
   * inside an exception — a handler that took a second interrupt would clobber
   * the `EIPC` it needs to return through, which the hardware prevents by
   * setting `EP` on the way in.
   */
  interrupt(code: number, handler: number): boolean {
    if (this.flag(PSW_ID) || this.flag(PSW_EP) || this.flag(PSW_NP)) return false;
    this.eipc = this.pc >>> 0;
    this.eipsw = this.psw;
    this.ecr = code & 0xffff;
    this.psw |= PSW_EP | PSW_ID;
    this.pc = handler >>> 0;
    this.halted = false;
    return true;
  }

  /** Take an exception the program itself caused, which nothing can mask. */
  private exception(code: number, handler: number): void {
    this.eipc = this.pc >>> 0;
    this.eipsw = this.psw;
    this.ecr = code & 0xffff;
    this.psw |= PSW_EP | PSW_ID;
    this.pc = handler >>> 0;
  }

  private readSystem(id: number): number {
    switch (id) {
      case 0:
        return this.eipc;
      case 1:
        return this.eipsw;
      case 2:
        return this.fepc;
      case 3:
        return this.fepsw;
      case 4:
        return this.ecr;
      case 5:
        return this.psw;
      case 6:
        return 0x0000_8100; // PIR — the part number this console carries.
      case 7:
        return 0x0000_00e0; // TKCW — the floating-point task control word.
      case 24:
        return this.chcw;
      case 25:
        return this.adtre;
      default:
        return 0;
    }
  }

  private writeSystem(id: number, value: number): void {
    switch (id) {
      case 0:
        this.eipc = value;
        break;
      case 1:
        this.eipsw = value;
        break;
      case 2:
        this.fepc = value;
        break;
      case 3:
        this.fepsw = value;
        break;
      case 5:
        this.psw = value;
        break;
      case 24:
        // The cache control word clears or enables the instruction cache, which
        // this model does not have — the write is accepted because a cartridge's
        // boot performs it, and there is nothing for it to do.
        this.chcw = value & ~0x30;
        break;
      case 25:
        this.adtre = value;
        break;
      default:
        break;
    }
  }

  // --- the interpreter -------------------------------------------------------

  /**
   * Run one instruction and return what it cost.
   *
   * A halted processor costs a cycle and stays where it is, so a caller's frame
   * loop still advances the hardware around it — which is how a cartridge that
   * waits for its interrupt with `halt` gets one.
   */
  step(): number {
    if (this.halted) return CYCLE_ALU;

    const at = this.pc >>> 0;
    const word = this.readHalf(at);
    const op = word >>> 10;
    const reg2 = (word >>> 5) & 0x1f;
    const reg1 = word & 0x1f;

    // A branch is the one format whose opcode field is only three bits wide.
    if ((op & 0x38) === 0x20) {
      const cond = (word >>> 9) & 0xf;
      if (!this.condition(cond)) {
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      }
      // Nine signed bits, measured from this instruction rather than the next.
      const disp = ((word & 0x1ff) << 23) >> 23;
      this.pc = (at + disp) >>> 0;
      return CYCLE_BRANCH_TAKEN;
    }

    switch (op) {
      case 0x00: // mov reg1, reg2
        this.set(reg2, this.r[reg1] as number);
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x01: // add reg1, reg2
        this.set(reg2, this.addFlags(this.r[reg2] as number, this.r[reg1] as number));
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x02: // sub reg1, reg2
        this.set(reg2, this.subFlags(this.r[reg2] as number, this.r[reg1] as number));
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x03: // cmp reg1, reg2
        this.subFlags(this.r[reg2] as number, this.r[reg1] as number);
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x04: // shl reg1, reg2
        this.shift(reg2, (this.r[reg1] as number) & 0x1f, "l");
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x05: // shr reg1, reg2
        this.shift(reg2, (this.r[reg1] as number) & 0x1f, "r");
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x06: // jmp [reg1]
        this.pc = ((this.r[reg1] as number) >>> 0) & 0xfffffffe;
        return CYCLE_JUMP;
      case 0x07: // sar reg1, reg2
        this.shift(reg2, (this.r[reg1] as number) & 0x1f, "a");
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x08: // mul reg1, reg2
        this.multiply(reg2, reg1, true);
        this.pc = (at + 2) >>> 0;
        return CYCLE_MUL;
      case 0x09: // div reg1, reg2
        this.pc = (at + 2) >>> 0;
        this.divide(reg2, reg1, true);
        return CYCLE_DIV;
      case 0x0a: // mulu
        this.multiply(reg2, reg1, false);
        this.pc = (at + 2) >>> 0;
        return CYCLE_MUL;
      case 0x0b: // divu
        this.pc = (at + 2) >>> 0;
        this.divide(reg2, reg1, false);
        return CYCLE_DIV;
      case 0x0c: // or
        this.set(reg2, (this.r[reg2] as number) | (this.r[reg1] as number));
        this.logicFlags(this.r[reg2] as number);
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x0d: // and
        this.set(reg2, (this.r[reg2] as number) & (this.r[reg1] as number));
        this.logicFlags(this.r[reg2] as number);
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x0e: // xor
        this.set(reg2, (this.r[reg2] as number) ^ (this.r[reg1] as number));
        this.logicFlags(this.r[reg2] as number);
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x0f: // not
        this.set(reg2, ~(this.r[reg1] as number));
        this.logicFlags(this.r[reg2] as number);
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;

      case 0x10: // mov imm5, reg2
        this.set(reg2, signed5(reg1));
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x11: // add imm5, reg2
        this.set(reg2, this.addFlags(this.r[reg2] as number, signed5(reg1)));
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x12: // setf cond, reg2
        this.set(reg2, this.condition(reg1) ? 1 : 0);
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x13: // cmp imm5, reg2
        this.subFlags(this.r[reg2] as number, signed5(reg1));
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x14: // shl imm5, reg2
        this.shift(reg2, reg1, "l");
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x15: // shr imm5, reg2
        this.shift(reg2, reg1, "r");
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x16: // cli
        this.setFlag(PSW_ID, false);
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x17: // sar imm5, reg2
        this.shift(reg2, reg1, "a");
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x18: // trap imm5
        this.pc = (at + 2) >>> 0;
        this.exception(0xffa0 + reg1, reg1 < 16 ? 0xffffffb0 : 0xffffffa0);
        return CYCLE_JUMP;
      case 0x19: {
        // reti — through whichever pair the exception that got here saved into.
        const nmi = this.flag(PSW_NP);
        this.pc = (nmi ? this.fepc : this.eipc) >>> 0;
        this.psw = nmi ? this.fepsw : this.eipsw;
        return CYCLE_JUMP;
      }
      case 0x1a: // halt
        this.halted = true;
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x1c: // ldsr reg2, regID
        this.writeSystem(reg1, this.r[reg2] as number);
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x1d: // stsr regID, reg2
        this.set(reg2, this.readSystem(reg1));
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x1e: // sei
        this.setFlag(PSW_ID, true);
        this.pc = (at + 2) >>> 0;
        return CYCLE_ALU;
      case 0x1f:
        throw new CpuError(`v810: bit-string instruction at $${at.toString(16)} is not modelled`);
      default:
        break;
    }

    // Everything below is a 32-bit instruction: one more halfword to fetch.
    const extra = this.readHalf(at + 2);
    const next = (at + 4) >>> 0;
    switch (op) {
      case 0x28: // movea imm16, reg1, reg2
        this.set(reg2, ((this.r[reg1] as number) + signed16(extra)) | 0);
        this.pc = next;
        return CYCLE_ALU;
      case 0x29: // addi imm16, reg1, reg2
        this.set(reg2, this.addFlags(this.r[reg1] as number, signed16(extra)));
        this.pc = next;
        return CYCLE_ALU;
      case 0x2a: // jr disp26
        this.pc = (at + signed26(((word & 0x3ff) << 16) | extra)) >>> 0;
        return CYCLE_JUMP;
      case 0x2b: // jal disp26
        this.set(R31, next | 0);
        this.pc = (at + signed26(((word & 0x3ff) << 16) | extra)) >>> 0;
        return CYCLE_JUMP;
      case 0x2c: // ori
        this.set(reg2, (this.r[reg1] as number) | extra);
        this.logicFlags(this.r[reg2] as number);
        this.pc = next;
        return CYCLE_ALU;
      case 0x2d: // andi
        this.set(reg2, (this.r[reg1] as number) & extra);
        this.logicFlags(this.r[reg2] as number);
        this.pc = next;
        return CYCLE_ALU;
      case 0x2e: // xori
        this.set(reg2, (this.r[reg1] as number) ^ extra);
        this.logicFlags(this.r[reg2] as number);
        this.pc = next;
        return CYCLE_ALU;
      case 0x2f: // movhi
        this.set(reg2, ((this.r[reg1] as number) + (extra << 16)) | 0);
        this.pc = next;
        return CYCLE_ALU;

      case 0x30: // ld.b
        this.set(reg2, (this.bus.read(this.address(reg1, extra)) << 24) >> 24);
        this.pc = next;
        return CYCLE_LOAD;
      case 0x31: // ld.h
        this.set(reg2, (this.readHalf(this.address(reg1, extra)) << 16) >> 16);
        this.pc = next;
        return CYCLE_LOAD;
      case 0x33: // ld.w
        this.set(reg2, this.readWord(this.address(reg1, extra)));
        this.pc = next;
        return CYCLE_LOAD;
      case 0x34: // st.b
        this.bus.write(this.address(reg1, extra), (this.r[reg2] as number) & 0xff);
        this.pc = next;
        return CYCLE_STORE;
      case 0x35: // st.h
        this.writeHalf(this.address(reg1, extra), this.r[reg2] as number);
        this.pc = next;
        return CYCLE_STORE;
      case 0x37: // st.w
        this.writeWord(this.address(reg1, extra), this.r[reg2] as number);
        this.pc = next;
        return CYCLE_STORE;
      case 0x38: // in.b — zero-extended, which is the whole difference from ld.b
        this.set(reg2, this.bus.read(this.address(reg1, extra)) & 0xff);
        this.pc = next;
        return CYCLE_LOAD;
      case 0x39: // in.h
        this.set(reg2, this.readHalf(this.address(reg1, extra)) & 0xffff);
        this.pc = next;
        return CYCLE_LOAD;
      case 0x3b: // in.w
        this.set(reg2, this.readWord(this.address(reg1, extra)));
        this.pc = next;
        return CYCLE_LOAD;
      case 0x3c: // out.b
        this.bus.write(this.address(reg1, extra), (this.r[reg2] as number) & 0xff);
        this.pc = next;
        return CYCLE_STORE;
      case 0x3d: // out.h
        this.writeHalf(this.address(reg1, extra), this.r[reg2] as number);
        this.pc = next;
        return CYCLE_STORE;
      case 0x3f: // out.w
        this.writeWord(this.address(reg1, extra), this.r[reg2] as number);
        this.pc = next;
        return CYCLE_STORE;
      case 0x3a:
        throw new CpuError(`v810: caxi at $${at.toString(16)} is not modelled`);
      case 0x3e:
        throw new CpuError(`v810: floating-point instruction at $${at.toString(16)}`);
      default:
        throw new CpuError(`v810: invalid opcode $${op.toString(16)} at $${at.toString(16)}`);
    }
  }

  private address(base: number, disp: number): number {
    return ((this.r[base] as number) + signed16(disp)) >>> 0;
  }

  private shift(reg: number, count: number, kind: "l" | "r" | "a"): void {
    const value = this.r[reg] as number;
    if (count === 0) {
      this.setFlag(PSW_CY, false);
      this.logicFlags(value);
      return;
    }
    let result: number;
    let carry: boolean;
    if (kind === "l") {
      carry = ((value >>> (32 - count)) & 1) !== 0;
      result = value << count;
    } else {
      carry = ((value >>> (count - 1)) & 1) !== 0;
      result = kind === "r" ? value >>> count : value >> count;
    }
    this.set(reg, result);
    this.setFlag(PSW_CY, carry);
    this.logicFlags(result | 0);
  }

  /**
   * `mul`/`mulu` — the 64-bit product, low half into `reg2` and high into `r30`.
   *
   * Done through {@link BigInt} rather than in two halves because the product is
   * genuinely 64 bits wide and a fixed-point multiply *reads the high half*: a
   * model that computed only the low one would be right for small numbers and
   * silently wrong for the ones a 16.16 multiply is made of.
   */
  private multiply(reg2: number, reg1: number, signedOp: boolean): void {
    const a = signedOp ? BigInt(this.r[reg2] as number) : BigInt((this.r[reg2] as number) >>> 0);
    const b = signedOp ? BigInt(this.r[reg1] as number) : BigInt((this.r[reg1] as number) >>> 0);
    const product = BigInt.asIntN(64, a * b);
    const low = Number(BigInt.asIntN(32, product));
    const high = Number(BigInt.asIntN(32, product >> 32n));
    this.set(reg2, low);
    this.set(R30, high);
    this.setFlag(PSW_Z, product === 0n);
    this.setFlag(PSW_S, product < 0n);
    this.setFlag(PSW_OV, BigInt(low) !== product);
  }

  /** `div`/`divu` — quotient into `reg2`, remainder into `r30`. */
  private divide(reg2: number, reg1: number, signedOp: boolean): void {
    const divisor = signedOp ? (this.r[reg1] as number) : (this.r[reg1] as number) >>> 0;
    if (divisor === 0) {
      this.exception(0xff80, 0xffffff80);
      return;
    }
    const dividend = signedOp ? (this.r[reg2] as number) : (this.r[reg2] as number) >>> 0;
    // The one case a signed divide overflows: the most negative value by −1 has
    // no positive counterpart, and the hardware leaves the dividend in place.
    if (signedOp && dividend === -0x80000000 && divisor === -1) {
      this.set(R30, 0);
      this.set(reg2, dividend);
      this.setFlag(PSW_OV, true);
      this.setFlag(PSW_Z, false);
      this.setFlag(PSW_S, true);
      return;
    }
    const quotient = Math.trunc(dividend / divisor) | 0;
    const remainder = (dividend % divisor) | 0;
    this.set(R30, remainder);
    this.set(reg2, quotient);
    this.setFlag(PSW_OV, false);
    this.setFlag(PSW_Z, quotient === 0);
    this.setFlag(PSW_S, quotient < 0);
  }
}

/** Sign-extend a five-bit immediate. */
function signed5(value: number): number {
  return (value << 27) >> 27;
}

/** Sign-extend a sixteen-bit immediate. */
function signed16(value: number): number {
  return (value << 16) >> 16;
}

/** Sign-extend a twenty-six-bit displacement. */
function signed26(value: number): number {
  return (value << 6) >> 6;
}
