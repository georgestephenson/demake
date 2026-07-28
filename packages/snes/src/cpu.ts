/**
 * A WDC 65816 processor.
 *
 * The counterpart of `@demake/nes`'s `Cpu`, and it exists for the same reason:
 * the Demotic conformance suite has to boot a cartridge `demake build` produced
 * and diff its 16.16 state against the reference interpreter (doc 14
 * §Conformance), on any machine that can run `pnpm test`.
 *
 * The 6502's model with four things added, and each of them is somewhere a
 * plausible-looking implementation goes quietly wrong:
 *
 *   - **The registers change width at run time.** `M` decides whether the
 *     accumulator is eight or sixteen bits and `X` decides the same for the index
 *     registers, and both are ordinary status bits a program flips with
 *     `rep`/`sep`. So there is no "16-bit `lda`" opcode to implement: there is one
 *     `lda` that reads one byte or two depending on a flag, and *the operand it
 *     fetches is a different length too*. Getting that wrong desynchronises the
 *     instruction stream rather than producing a wrong number.
 *   - **Clearing `X` does not widen the index registers, it reveals them.**
 *     Setting `X` zeroes their high bytes, permanently; clearing it again does not
 *     bring anything back. Modelled the other way round, a loop counter survives a
 *     narrowing it should not have.
 *   - **An address has a bank, and which bank depends on the mode.** Absolute data
 *     accesses take the data bank, jumps take the program bank, direct page and
 *     the stack are always bank zero, and `long` carries its own. A model that
 *     kept one flat sixteen-bit space would run a Demotic cartridge perfectly —
 *     until the tile bank, which lives in bank one.
 *   - **Reset lands in emulation mode.** There is no native reset vector, so a
 *     cartridge's first two instructions are `clc` and `xce`. Emulation mode is
 *     therefore modelled far enough to execute exactly that.
 *
 * Decimal mode is not implemented. Nothing this project emits sets `D`, and a
 * silently-wrong BCD add would be worse than an obvious gap — so it is a gap.
 *
 * Sources: WDC W65C816S datasheet and the SNESdev Wiki's 65816 reference
 * (https://snes.nesdev.org/wiki/65816_reference).
 */

/** What the CPU needs of the machine around it: a flat 24-bit address space. */
export interface Bus {
  read(address: number): number;
  write(address: number, value: number): void;
}

/** Status register bits. */
export const FLAG = {
  C: 0x01,
  Z: 0x02,
  I: 0x04,
  D: 0x08,
  /** Index width: set means eight bits. */
  X: 0x10,
  /** Accumulator width: set means eight bits. */
  M: 0x20,
  V: 0x40,
  N: 0x80,
} as const;

/** Where the CPU takes each of its vectors, in bank zero. */
export const VECTOR = {
  nativeCop: 0xffe4,
  nativeBrk: 0xffe6,
  nativeAbort: 0xffe8,
  nativeNmi: 0xffea,
  nativeIrq: 0xffee,
  emulationCop: 0xfff4,
  emulationAbort: 0xfff8,
  emulationNmi: 0xfffa,
  emulationReset: 0xfffc,
  emulationIrq: 0xfffe,
} as const;

export class Cpu {
  /** The accumulator, always held as sixteen bits; `M` decides how much is used. */
  a = 0;
  x = 0;
  y = 0;
  /** Stack pointer, sixteen bits in native mode and `$01xx` in emulation. */
  s = 0x01ff;
  /** Direct page base. */
  d = 0;
  /** Program bank and data bank. */
  pb = 0;
  db = 0;
  pc = 0;
  p = FLAG.M | FLAG.X | FLAG.I;
  /** Emulation mode, which reset leaves set. */
  e = true;
  /** Set by `stp`, and by a `wai` with nothing to wake it. */
  stopped = false;
  /** Set by `wai`; cleared when an interrupt is taken. */
  waiting = false;

  /** Cycles the instruction just executed took. */
  private cycles = 0;

  constructor(private readonly bus: Bus) {}

  // --- widths ----------------------------------------------------------------

  /** Whether the accumulator is eight bits. */
  get narrowA(): boolean {
    return this.e || (this.p & FLAG.M) !== 0;
  }

  /** Whether the index registers are eight bits. */
  get narrowIndex(): boolean {
    return this.e || (this.p & FLAG.X) !== 0;
  }

  // --- memory ----------------------------------------------------------------

  private read8(address: number): number {
    return this.bus.read(address & 0xffffff) & 0xff;
  }

  private write8(address: number, value: number): void {
    this.bus.write(address & 0xffffff, value & 0xff);
  }

  private read16(address: number): number {
    return this.read8(address) | (this.read8(address + 1) << 8);
  }

  private write16(address: number, value: number): void {
    this.write8(address, value & 0xff);
    this.write8(address + 1, (value >> 8) & 0xff);
  }

  /** Read one or two bytes, as the accumulator's current width asks. */
  private readValue(address: number, narrow: boolean): number {
    return narrow ? this.read8(address) : this.read16(address);
  }

  private writeValue(address: number, value: number, narrow: boolean): void {
    if (narrow) this.write8(address, value);
    else this.write16(address, value);
  }

  // --- fetching --------------------------------------------------------------

  private fetch8(): number {
    const byte = this.read8((this.pb << 16) | this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return byte;
  }

  private fetch16(): number {
    return this.fetch8() | (this.fetch8() << 8);
  }

  private fetch24(): number {
    return this.fetch8() | (this.fetch8() << 8) | (this.fetch8() << 16);
  }

  // --- stack -----------------------------------------------------------------

  private push8(value: number): void {
    this.write8(this.s, value);
    // In emulation mode the stack never leaves page one, which is the whole of
    // what that mode changes about it.
    this.s = this.e ? 0x0100 | ((this.s - 1) & 0xff) : (this.s - 1) & 0xffff;
  }

  private pull8(): number {
    this.s = this.e ? 0x0100 | ((this.s + 1) & 0xff) : (this.s + 1) & 0xffff;
    return this.read8(this.s);
  }

  private push16(value: number): void {
    this.push8((value >> 8) & 0xff);
    this.push8(value & 0xff);
  }

  private pull16(): number {
    return this.pull8() | (this.pull8() << 8);
  }

  // --- flags -----------------------------------------------------------------

  private setFlag(bit: number, on: boolean): void {
    if (on) this.p |= bit;
    else this.p &= ~bit & 0xff;
  }

  private setNZ(value: number, narrow: boolean): void {
    const mask = narrow ? 0xff : 0xffff;
    const sign = narrow ? 0x80 : 0x8000;
    this.setFlag(FLAG.Z, (value & mask) === 0);
    this.setFlag(FLAG.N, (value & sign) !== 0);
  }

  /** Narrowing the index registers throws their high bytes away, for good. */
  private applyWidths(): void {
    if (this.narrowIndex) {
      this.x &= 0xff;
      this.y &= 0xff;
    }
  }

  // --- addressing ------------------------------------------------------------
  //
  // Each returns a 24-bit effective address and charges the cycles its mode
  // costs. The "+1 when the direct page is not page aligned" penalty is real
  // hardware behaviour and is modelled because a build that moved `D` off a page
  // boundary would otherwise look free.

  private dpPenalty(): void {
    if ((this.d & 0xff) !== 0) this.cycles += 1;
  }

  private addrDp(): number {
    this.cycles += 3;
    this.dpPenalty();
    return (this.d + this.fetch8()) & 0xffff;
  }

  private addrDpX(): number {
    this.cycles += 4;
    this.dpPenalty();
    return (this.d + this.fetch8() + this.x) & 0xffff;
  }

  private addrDpY(): number {
    this.cycles += 4;
    this.dpPenalty();
    return (this.d + this.fetch8() + this.y) & 0xffff;
  }

  private addrDpInd(): number {
    this.cycles += 5;
    this.dpPenalty();
    const pointer = (this.d + this.fetch8()) & 0xffff;
    return ((this.db << 16) + this.read16(pointer)) & 0xffffff;
  }

  private addrDpIndX(): number {
    this.cycles += 6;
    this.dpPenalty();
    const pointer = (this.d + this.fetch8() + this.x) & 0xffff;
    return ((this.db << 16) + this.read16(pointer)) & 0xffffff;
  }

  private addrDpIndY(): number {
    this.cycles += 5;
    this.dpPenalty();
    const pointer = (this.d + this.fetch8()) & 0xffff;
    return ((this.db << 16) + this.read16(pointer) + this.y) & 0xffffff;
  }

  private addrDpIndLong(): number {
    this.cycles += 6;
    this.dpPenalty();
    const pointer = (this.d + this.fetch8()) & 0xffff;
    return (this.read16(pointer) | (this.read8(pointer + 2) << 16)) & 0xffffff;
  }

  private addrDpIndLongY(): number {
    this.cycles += 6;
    this.dpPenalty();
    const pointer = (this.d + this.fetch8()) & 0xffff;
    const base = this.read16(pointer) | (this.read8(pointer + 2) << 16);
    return (base + this.y) & 0xffffff;
  }

  private addrAbs(): number {
    this.cycles += 4;
    return ((this.db << 16) | this.fetch16()) & 0xffffff;
  }

  private addrAbsX(): number {
    this.cycles += 4;
    const base = ((this.db << 16) | this.fetch16()) & 0xffffff;
    const target = (base + this.x) & 0xffffff;
    if ((base & 0xff00) !== (target & 0xff00)) this.cycles += 1;
    return target;
  }

  private addrAbsY(): number {
    this.cycles += 4;
    const base = ((this.db << 16) | this.fetch16()) & 0xffffff;
    const target = (base + this.y) & 0xffffff;
    if ((base & 0xff00) !== (target & 0xff00)) this.cycles += 1;
    return target;
  }

  private addrLong(): number {
    this.cycles += 5;
    return this.fetch24() & 0xffffff;
  }

  private addrLongX(): number {
    this.cycles += 5;
    return (this.fetch24() + this.x) & 0xffffff;
  }

  private addrSr(): number {
    this.cycles += 4;
    return (this.s + this.fetch8()) & 0xffff;
  }

  private addrSrY(): number {
    this.cycles += 7;
    const pointer = (this.s + this.fetch8()) & 0xffff;
    return ((this.db << 16) + this.read16(pointer) + this.y) & 0xffffff;
  }

  /** The immediate operand itself, one or two bytes wide. */
  private immediate(narrow: boolean): number {
    this.cycles += narrow ? 2 : 3;
    return narrow ? this.fetch8() : this.fetch16();
  }

  // --- arithmetic ------------------------------------------------------------

  private adc(value: number): void {
    const narrow = this.narrowA;
    const carry = this.p & FLAG.C;
    if (narrow) {
      const a = this.a & 0xff;
      const sum = a + value + carry;
      this.setFlag(FLAG.V, (~(a ^ value) & (a ^ sum) & 0x80) !== 0);
      this.setFlag(FLAG.C, sum > 0xff);
      this.a = (this.a & 0xff00) | (sum & 0xff);
      this.setNZ(sum, true);
      return;
    }
    const sum = this.a + value + carry;
    this.setFlag(FLAG.V, (~(this.a ^ value) & (this.a ^ sum) & 0x8000) !== 0);
    this.setFlag(FLAG.C, sum > 0xffff);
    this.a = sum & 0xffff;
    this.setNZ(sum, false);
  }

  /** Subtract with borrow, which on this CPU is `adc` of the complement. */
  private sbc(value: number): void {
    this.adc(this.narrowA ? ~value & 0xff : ~value & 0xffff);
  }

  private compare(register: number, value: number, narrow: boolean): void {
    const mask = narrow ? 0xff : 0xffff;
    const left = register & mask;
    const right = value & mask;
    const difference = (left - right) & mask;
    this.setFlag(FLAG.C, left >= right);
    this.setNZ(difference, narrow);
  }

  private bitTest(value: number, immediateForm: boolean): void {
    const narrow = this.narrowA;
    const mask = narrow ? 0xff : 0xffff;
    this.setFlag(FLAG.Z, (this.a & mask & value) === 0);
    if (immediateForm) return;
    this.setFlag(FLAG.N, (value & (narrow ? 0x80 : 0x8000)) !== 0);
    this.setFlag(FLAG.V, (value & (narrow ? 0x40 : 0x4000)) !== 0);
  }

  // --- read/modify/write -----------------------------------------------------

  private modify(address: number, transform: (value: number) => number): void {
    const narrow = this.narrowA;
    const value = this.readValue(address, narrow);
    const result = transform(value);
    this.writeValue(address, result, narrow);
    this.cycles += narrow ? 2 : 4;
  }

  private asl(value: number): number {
    const narrow = this.narrowA;
    const sign = narrow ? 0x80 : 0x8000;
    this.setFlag(FLAG.C, (value & sign) !== 0);
    const result = (value << 1) & (narrow ? 0xff : 0xffff);
    this.setNZ(result, narrow);
    return result;
  }

  private lsr(value: number): number {
    const narrow = this.narrowA;
    this.setFlag(FLAG.C, (value & 1) !== 0);
    const result = (value >> 1) & (narrow ? 0x7f : 0x7fff);
    this.setNZ(result, narrow);
    return result;
  }

  private rol(value: number): number {
    const narrow = this.narrowA;
    const sign = narrow ? 0x80 : 0x8000;
    const carry = this.p & FLAG.C;
    this.setFlag(FLAG.C, (value & sign) !== 0);
    const result = ((value << 1) | carry) & (narrow ? 0xff : 0xffff);
    this.setNZ(result, narrow);
    return result;
  }

  private ror(value: number): number {
    const narrow = this.narrowA;
    const top = narrow ? 0x80 : 0x8000;
    const carry = (this.p & FLAG.C) !== 0 ? top : 0;
    this.setFlag(FLAG.C, (value & 1) !== 0);
    const result = ((value >> 1) | carry) & (narrow ? 0xff : 0xffff);
    this.setNZ(result, narrow);
    return result;
  }

  private incValue(value: number): number {
    const narrow = this.narrowA;
    const result = (value + 1) & (narrow ? 0xff : 0xffff);
    this.setNZ(result, narrow);
    return result;
  }

  private decValue(value: number): number {
    const narrow = this.narrowA;
    const result = (value - 1) & (narrow ? 0xff : 0xffff);
    this.setNZ(result, narrow);
    return result;
  }

  // --- loads and stores ------------------------------------------------------

  private loadA(address: number): void {
    const narrow = this.narrowA;
    const value = this.readValue(address, narrow);
    this.a = narrow ? (this.a & 0xff00) | value : value;
    this.setNZ(value, narrow);
    if (!narrow) this.cycles += 1;
  }

  private storeA(address: number): void {
    const narrow = this.narrowA;
    this.writeValue(address, narrow ? this.a & 0xff : this.a, narrow);
    if (!narrow) this.cycles += 1;
  }

  private loadIndex(address: number, into: "x" | "y"): void {
    const narrow = this.narrowIndex;
    const value = this.readValue(address, narrow);
    this[into] = value;
    this.setNZ(value, narrow);
    if (!narrow) this.cycles += 1;
  }

  private storeIndex(address: number, from: "x" | "y"): void {
    const narrow = this.narrowIndex;
    this.writeValue(address, narrow ? this[from] & 0xff : this[from], narrow);
    if (!narrow) this.cycles += 1;
  }

  private storeZero(address: number): void {
    const narrow = this.narrowA;
    this.writeValue(address, 0, narrow);
    if (!narrow) this.cycles += 1;
  }

  /** An accumulator ALU operation over an addressed value. */
  private aluAt(address: number, operation: (value: number) => void): void {
    const narrow = this.narrowA;
    operation(this.readValue(address, narrow));
    if (!narrow) this.cycles += 1;
  }

  private andA(value: number): void {
    const narrow = this.narrowA;
    if (narrow) this.a = (this.a & 0xff00) | (this.a & value & 0xff);
    else this.a &= value;
    this.setNZ(this.a, narrow);
  }

  private oraA(value: number): void {
    const narrow = this.narrowA;
    if (narrow) this.a = (this.a & 0xff00) | ((this.a | value) & 0xff);
    else this.a |= value;
    this.setNZ(this.a, narrow);
  }

  private eorA(value: number): void {
    const narrow = this.narrowA;
    if (narrow) this.a = (this.a & 0xff00) | ((this.a ^ value) & 0xff);
    else this.a ^= value;
    this.setNZ(this.a, narrow);
  }

  // --- branches --------------------------------------------------------------

  private branch(taken: boolean): void {
    const offset = this.fetch8();
    this.cycles += 2;
    if (!taken) return;
    this.cycles += 1;
    this.pc = (this.pc + (offset < 0x80 ? offset : offset - 0x100)) & 0xffff;
  }

  // --- interrupts ------------------------------------------------------------

  /** Take the reset vector, which is the one place emulation mode is entered. */
  reset(): void {
    this.e = true;
    this.p = FLAG.M | FLAG.X | FLAG.I;
    this.d = 0;
    this.db = 0;
    this.pb = 0;
    this.s = 0x01ff;
    this.x &= 0xff;
    this.y &= 0xff;
    this.stopped = false;
    this.waiting = false;
    this.pc = this.read16(VECTOR.emulationReset);
  }

  /** Take the non-maskable interrupt, which the PPU raises at vertical blank. */
  nmi(): void {
    this.waiting = false;
    this.enter(this.e ? VECTOR.emulationNmi : VECTOR.nativeNmi);
  }

  /** Take a maskable interrupt, if the program is not masking them. */
  irq(): boolean {
    if ((this.p & FLAG.I) !== 0) return false;
    this.waiting = false;
    this.enter(this.e ? VECTOR.emulationIrq : VECTOR.nativeIrq);
    return true;
  }

  private enter(vector: number): void {
    // A native-mode interrupt saves the program bank as well as the address; an
    // emulation-mode one does not, because there is nowhere for it to have been.
    if (!this.e) this.push8(this.pb);
    this.push16(this.pc);
    this.push8(this.p);
    this.p |= FLAG.I;
    this.p &= ~FLAG.D & 0xff;
    this.pb = 0;
    this.pc = this.read16(vector);
    this.cycles += this.e ? 7 : 8;
  }

  // --- the instruction loop --------------------------------------------------

  /** Execute one instruction and return the cycles it took. */
  step(): number {
    if (this.stopped) return 1;
    if (this.waiting) return 1;
    this.cycles = 0;
    const opcode = this.fetch8();
    this.execute(opcode);
    return this.cycles;
  }

  private execute(opcode: number): void {
    switch (opcode) {
      // --- ADC ---------------------------------------------------------------
      case 0x69:
        this.adc(this.immediate(this.narrowA));
        return;
      case 0x65:
        this.aluAt(this.addrDp(), (v) => this.adc(v));
        return;
      case 0x75:
        this.aluAt(this.addrDpX(), (v) => this.adc(v));
        return;
      case 0x72:
        this.aluAt(this.addrDpInd(), (v) => this.adc(v));
        return;
      case 0x61:
        this.aluAt(this.addrDpIndX(), (v) => this.adc(v));
        return;
      case 0x71:
        this.aluAt(this.addrDpIndY(), (v) => this.adc(v));
        return;
      case 0x67:
        this.aluAt(this.addrDpIndLong(), (v) => this.adc(v));
        return;
      case 0x77:
        this.aluAt(this.addrDpIndLongY(), (v) => this.adc(v));
        return;
      case 0x6d:
        this.aluAt(this.addrAbs(), (v) => this.adc(v));
        return;
      case 0x7d:
        this.aluAt(this.addrAbsX(), (v) => this.adc(v));
        return;
      case 0x79:
        this.aluAt(this.addrAbsY(), (v) => this.adc(v));
        return;
      case 0x6f:
        this.aluAt(this.addrLong(), (v) => this.adc(v));
        return;
      case 0x7f:
        this.aluAt(this.addrLongX(), (v) => this.adc(v));
        return;
      case 0x63:
        this.aluAt(this.addrSr(), (v) => this.adc(v));
        return;
      case 0x73:
        this.aluAt(this.addrSrY(), (v) => this.adc(v));
        return;

      // --- AND ---------------------------------------------------------------
      case 0x29:
        this.andA(this.immediate(this.narrowA));
        return;
      case 0x25:
        this.aluAt(this.addrDp(), (v) => this.andA(v));
        return;
      case 0x35:
        this.aluAt(this.addrDpX(), (v) => this.andA(v));
        return;
      case 0x32:
        this.aluAt(this.addrDpInd(), (v) => this.andA(v));
        return;
      case 0x21:
        this.aluAt(this.addrDpIndX(), (v) => this.andA(v));
        return;
      case 0x31:
        this.aluAt(this.addrDpIndY(), (v) => this.andA(v));
        return;
      case 0x27:
        this.aluAt(this.addrDpIndLong(), (v) => this.andA(v));
        return;
      case 0x37:
        this.aluAt(this.addrDpIndLongY(), (v) => this.andA(v));
        return;
      case 0x2d:
        this.aluAt(this.addrAbs(), (v) => this.andA(v));
        return;
      case 0x3d:
        this.aluAt(this.addrAbsX(), (v) => this.andA(v));
        return;
      case 0x39:
        this.aluAt(this.addrAbsY(), (v) => this.andA(v));
        return;
      case 0x2f:
        this.aluAt(this.addrLong(), (v) => this.andA(v));
        return;
      case 0x3f:
        this.aluAt(this.addrLongX(), (v) => this.andA(v));
        return;
      case 0x23:
        this.aluAt(this.addrSr(), (v) => this.andA(v));
        return;
      case 0x33:
        this.aluAt(this.addrSrY(), (v) => this.andA(v));
        return;

      // --- EOR ---------------------------------------------------------------
      case 0x49:
        this.eorA(this.immediate(this.narrowA));
        return;
      case 0x45:
        this.aluAt(this.addrDp(), (v) => this.eorA(v));
        return;
      case 0x55:
        this.aluAt(this.addrDpX(), (v) => this.eorA(v));
        return;
      case 0x52:
        this.aluAt(this.addrDpInd(), (v) => this.eorA(v));
        return;
      case 0x41:
        this.aluAt(this.addrDpIndX(), (v) => this.eorA(v));
        return;
      case 0x51:
        this.aluAt(this.addrDpIndY(), (v) => this.eorA(v));
        return;
      case 0x47:
        this.aluAt(this.addrDpIndLong(), (v) => this.eorA(v));
        return;
      case 0x57:
        this.aluAt(this.addrDpIndLongY(), (v) => this.eorA(v));
        return;
      case 0x4d:
        this.aluAt(this.addrAbs(), (v) => this.eorA(v));
        return;
      case 0x5d:
        this.aluAt(this.addrAbsX(), (v) => this.eorA(v));
        return;
      case 0x59:
        this.aluAt(this.addrAbsY(), (v) => this.eorA(v));
        return;
      case 0x4f:
        this.aluAt(this.addrLong(), (v) => this.eorA(v));
        return;
      case 0x5f:
        this.aluAt(this.addrLongX(), (v) => this.eorA(v));
        return;
      case 0x43:
        this.aluAt(this.addrSr(), (v) => this.eorA(v));
        return;
      case 0x53:
        this.aluAt(this.addrSrY(), (v) => this.eorA(v));
        return;

      // --- ORA ---------------------------------------------------------------
      case 0x09:
        this.oraA(this.immediate(this.narrowA));
        return;
      case 0x05:
        this.aluAt(this.addrDp(), (v) => this.oraA(v));
        return;
      case 0x15:
        this.aluAt(this.addrDpX(), (v) => this.oraA(v));
        return;
      case 0x12:
        this.aluAt(this.addrDpInd(), (v) => this.oraA(v));
        return;
      case 0x01:
        this.aluAt(this.addrDpIndX(), (v) => this.oraA(v));
        return;
      case 0x11:
        this.aluAt(this.addrDpIndY(), (v) => this.oraA(v));
        return;
      case 0x07:
        this.aluAt(this.addrDpIndLong(), (v) => this.oraA(v));
        return;
      case 0x17:
        this.aluAt(this.addrDpIndLongY(), (v) => this.oraA(v));
        return;
      case 0x0d:
        this.aluAt(this.addrAbs(), (v) => this.oraA(v));
        return;
      case 0x1d:
        this.aluAt(this.addrAbsX(), (v) => this.oraA(v));
        return;
      case 0x19:
        this.aluAt(this.addrAbsY(), (v) => this.oraA(v));
        return;
      case 0x0f:
        this.aluAt(this.addrLong(), (v) => this.oraA(v));
        return;
      case 0x1f:
        this.aluAt(this.addrLongX(), (v) => this.oraA(v));
        return;
      case 0x03:
        this.aluAt(this.addrSr(), (v) => this.oraA(v));
        return;
      case 0x13:
        this.aluAt(this.addrSrY(), (v) => this.oraA(v));
        return;

      // --- SBC ---------------------------------------------------------------
      case 0xe9:
        this.sbc(this.immediate(this.narrowA));
        return;
      case 0xe5:
        this.aluAt(this.addrDp(), (v) => this.sbc(v));
        return;
      case 0xf5:
        this.aluAt(this.addrDpX(), (v) => this.sbc(v));
        return;
      case 0xf2:
        this.aluAt(this.addrDpInd(), (v) => this.sbc(v));
        return;
      case 0xe1:
        this.aluAt(this.addrDpIndX(), (v) => this.sbc(v));
        return;
      case 0xf1:
        this.aluAt(this.addrDpIndY(), (v) => this.sbc(v));
        return;
      case 0xe7:
        this.aluAt(this.addrDpIndLong(), (v) => this.sbc(v));
        return;
      case 0xf7:
        this.aluAt(this.addrDpIndLongY(), (v) => this.sbc(v));
        return;
      case 0xed:
        this.aluAt(this.addrAbs(), (v) => this.sbc(v));
        return;
      case 0xfd:
        this.aluAt(this.addrAbsX(), (v) => this.sbc(v));
        return;
      case 0xf9:
        this.aluAt(this.addrAbsY(), (v) => this.sbc(v));
        return;
      case 0xef:
        this.aluAt(this.addrLong(), (v) => this.sbc(v));
        return;
      case 0xff:
        this.aluAt(this.addrLongX(), (v) => this.sbc(v));
        return;
      case 0xe3:
        this.aluAt(this.addrSr(), (v) => this.sbc(v));
        return;
      case 0xf3:
        this.aluAt(this.addrSrY(), (v) => this.sbc(v));
        return;

      // --- CMP / CPX / CPY ---------------------------------------------------
      case 0xc9:
        this.compare(this.a, this.immediate(this.narrowA), this.narrowA);
        return;
      case 0xc5:
        this.aluAt(this.addrDp(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xd5:
        this.aluAt(this.addrDpX(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xd2:
        this.aluAt(this.addrDpInd(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xc1:
        this.aluAt(this.addrDpIndX(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xd1:
        this.aluAt(this.addrDpIndY(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xc7:
        this.aluAt(this.addrDpIndLong(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xd7:
        this.aluAt(this.addrDpIndLongY(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xcd:
        this.aluAt(this.addrAbs(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xdd:
        this.aluAt(this.addrAbsX(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xd9:
        this.aluAt(this.addrAbsY(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xcf:
        this.aluAt(this.addrLong(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xdf:
        this.aluAt(this.addrLongX(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xc3:
        this.aluAt(this.addrSr(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xd3:
        this.aluAt(this.addrSrY(), (v) => this.compare(this.a, v, this.narrowA));
        return;
      case 0xe0:
        this.compare(this.x, this.immediate(this.narrowIndex), this.narrowIndex);
        return;
      case 0xe4:
        this.compareAt(this.addrDp(), this.x);
        return;
      case 0xec:
        this.compareAt(this.addrAbs(), this.x);
        return;
      case 0xc0:
        this.compare(this.y, this.immediate(this.narrowIndex), this.narrowIndex);
        return;
      case 0xc4:
        this.compareAt(this.addrDp(), this.y);
        return;
      case 0xcc:
        this.compareAt(this.addrAbs(), this.y);
        return;

      // --- BIT / TSB / TRB ---------------------------------------------------
      case 0x89:
        this.bitTest(this.immediate(this.narrowA), true);
        return;
      case 0x24:
        this.aluAt(this.addrDp(), (v) => this.bitTest(v, false));
        return;
      case 0x34:
        this.aluAt(this.addrDpX(), (v) => this.bitTest(v, false));
        return;
      case 0x2c:
        this.aluAt(this.addrAbs(), (v) => this.bitTest(v, false));
        return;
      case 0x3c:
        this.aluAt(this.addrAbsX(), (v) => this.bitTest(v, false));
        return;
      case 0x04:
        this.modify(this.addrDp(), (v) => this.testAndSet(v, true));
        return;
      case 0x0c:
        this.modify(this.addrAbs(), (v) => this.testAndSet(v, true));
        return;
      case 0x14:
        this.modify(this.addrDp(), (v) => this.testAndSet(v, false));
        return;
      case 0x1c:
        this.modify(this.addrAbs(), (v) => this.testAndSet(v, false));
        return;

      // --- shifts and rotates ------------------------------------------------
      case 0x0a:
        this.shiftAccumulator((v) => this.asl(v));
        return;
      case 0x06:
        this.modify(this.addrDp(), (v) => this.asl(v));
        return;
      case 0x16:
        this.modify(this.addrDpX(), (v) => this.asl(v));
        return;
      case 0x0e:
        this.modify(this.addrAbs(), (v) => this.asl(v));
        return;
      case 0x1e:
        this.modify(this.addrAbsX(), (v) => this.asl(v));
        return;
      case 0x4a:
        this.shiftAccumulator((v) => this.lsr(v));
        return;
      case 0x46:
        this.modify(this.addrDp(), (v) => this.lsr(v));
        return;
      case 0x56:
        this.modify(this.addrDpX(), (v) => this.lsr(v));
        return;
      case 0x4e:
        this.modify(this.addrAbs(), (v) => this.lsr(v));
        return;
      case 0x5e:
        this.modify(this.addrAbsX(), (v) => this.lsr(v));
        return;
      case 0x2a:
        this.shiftAccumulator((v) => this.rol(v));
        return;
      case 0x26:
        this.modify(this.addrDp(), (v) => this.rol(v));
        return;
      case 0x36:
        this.modify(this.addrDpX(), (v) => this.rol(v));
        return;
      case 0x2e:
        this.modify(this.addrAbs(), (v) => this.rol(v));
        return;
      case 0x3e:
        this.modify(this.addrAbsX(), (v) => this.rol(v));
        return;
      case 0x6a:
        this.shiftAccumulator((v) => this.ror(v));
        return;
      case 0x66:
        this.modify(this.addrDp(), (v) => this.ror(v));
        return;
      case 0x76:
        this.modify(this.addrDpX(), (v) => this.ror(v));
        return;
      case 0x6e:
        this.modify(this.addrAbs(), (v) => this.ror(v));
        return;
      case 0x7e:
        this.modify(this.addrAbsX(), (v) => this.ror(v));
        return;

      // --- increment and decrement -------------------------------------------
      case 0x1a:
        this.shiftAccumulator((v) => this.incValue(v));
        return;
      case 0xe6:
        this.modify(this.addrDp(), (v) => this.incValue(v));
        return;
      case 0xf6:
        this.modify(this.addrDpX(), (v) => this.incValue(v));
        return;
      case 0xee:
        this.modify(this.addrAbs(), (v) => this.incValue(v));
        return;
      case 0xfe:
        this.modify(this.addrAbsX(), (v) => this.incValue(v));
        return;
      case 0x3a:
        this.shiftAccumulator((v) => this.decValue(v));
        return;
      case 0xc6:
        this.modify(this.addrDp(), (v) => this.decValue(v));
        return;
      case 0xd6:
        this.modify(this.addrDpX(), (v) => this.decValue(v));
        return;
      case 0xce:
        this.modify(this.addrAbs(), (v) => this.decValue(v));
        return;
      case 0xde:
        this.modify(this.addrAbsX(), (v) => this.decValue(v));
        return;
      case 0xe8:
        this.stepIndex("x", 1);
        return;
      case 0xc8:
        this.stepIndex("y", 1);
        return;
      case 0xca:
        this.stepIndex("x", -1);
        return;
      case 0x88:
        this.stepIndex("y", -1);
        return;

      // --- loads and stores --------------------------------------------------
      case 0xa9:
        this.loadImmediateA();
        return;
      case 0xa5:
        this.loadA(this.addrDp());
        return;
      case 0xb5:
        this.loadA(this.addrDpX());
        return;
      case 0xb2:
        this.loadA(this.addrDpInd());
        return;
      case 0xa1:
        this.loadA(this.addrDpIndX());
        return;
      case 0xb1:
        this.loadA(this.addrDpIndY());
        return;
      case 0xa7:
        this.loadA(this.addrDpIndLong());
        return;
      case 0xb7:
        this.loadA(this.addrDpIndLongY());
        return;
      case 0xad:
        this.loadA(this.addrAbs());
        return;
      case 0xbd:
        this.loadA(this.addrAbsX());
        return;
      case 0xb9:
        this.loadA(this.addrAbsY());
        return;
      case 0xaf:
        this.loadA(this.addrLong());
        return;
      case 0xbf:
        this.loadA(this.addrLongX());
        return;
      case 0xa3:
        this.loadA(this.addrSr());
        return;
      case 0xb3:
        this.loadA(this.addrSrY());
        return;
      case 0xa2:
        this.loadImmediateIndex("x");
        return;
      case 0xa6:
        this.loadIndex(this.addrDp(), "x");
        return;
      case 0xb6:
        this.loadIndex(this.addrDpY(), "x");
        return;
      case 0xae:
        this.loadIndex(this.addrAbs(), "x");
        return;
      case 0xbe:
        this.loadIndex(this.addrAbsY(), "x");
        return;
      case 0xa0:
        this.loadImmediateIndex("y");
        return;
      case 0xa4:
        this.loadIndex(this.addrDp(), "y");
        return;
      case 0xb4:
        this.loadIndex(this.addrDpX(), "y");
        return;
      case 0xac:
        this.loadIndex(this.addrAbs(), "y");
        return;
      case 0xbc:
        this.loadIndex(this.addrAbsX(), "y");
        return;
      case 0x85:
        this.storeA(this.addrDp());
        return;
      case 0x95:
        this.storeA(this.addrDpX());
        return;
      case 0x92:
        this.storeA(this.addrDpInd());
        return;
      case 0x81:
        this.storeA(this.addrDpIndX());
        return;
      case 0x91:
        this.storeA(this.addrDpIndY());
        return;
      case 0x87:
        this.storeA(this.addrDpIndLong());
        return;
      case 0x97:
        this.storeA(this.addrDpIndLongY());
        return;
      case 0x8d:
        this.storeA(this.addrAbs());
        return;
      case 0x9d:
        this.storeA(this.addrAbsX());
        return;
      case 0x99:
        this.storeA(this.addrAbsY());
        return;
      case 0x8f:
        this.storeA(this.addrLong());
        return;
      case 0x9f:
        this.storeA(this.addrLongX());
        return;
      case 0x83:
        this.storeA(this.addrSr());
        return;
      case 0x93:
        this.storeA(this.addrSrY());
        return;
      case 0x86:
        this.storeIndex(this.addrDp(), "x");
        return;
      case 0x96:
        this.storeIndex(this.addrDpY(), "x");
        return;
      case 0x8e:
        this.storeIndex(this.addrAbs(), "x");
        return;
      case 0x84:
        this.storeIndex(this.addrDp(), "y");
        return;
      case 0x94:
        this.storeIndex(this.addrDpX(), "y");
        return;
      case 0x8c:
        this.storeIndex(this.addrAbs(), "y");
        return;
      case 0x64:
        this.storeZero(this.addrDp());
        return;
      case 0x74:
        this.storeZero(this.addrDpX());
        return;
      case 0x9c:
        this.storeZero(this.addrAbs());
        return;
      case 0x9e:
        this.storeZero(this.addrAbsX());
        return;

      // --- transfers ---------------------------------------------------------
      case 0xaa:
        this.transferToIndex("x", this.a);
        return;
      case 0xa8:
        this.transferToIndex("y", this.a);
        return;
      case 0x8a:
        this.transferToA(this.x);
        return;
      case 0x98:
        this.transferToA(this.y);
        return;
      case 0x9b:
        this.transferToIndex("y", this.x);
        return;
      case 0xbb:
        this.transferToIndex("x", this.y);
        return;
      case 0xba:
        this.transferToIndex("x", this.s);
        return;
      case 0x9a:
        // In native mode the whole index register becomes the stack pointer; in
        // emulation the stack cannot leave page one, so only the low byte moves.
        this.s = this.e ? 0x0100 | (this.x & 0xff) : this.x & 0xffff;
        this.cycles += 2;
        return;
      case 0x5b:
        this.d = this.a & 0xffff;
        this.setNZ(this.d, false);
        this.cycles += 2;
        return;
      case 0x7b:
        this.a = this.d & 0xffff;
        this.setNZ(this.a, false);
        this.cycles += 2;
        return;
      case 0x1b:
        this.s = this.e ? 0x0100 | (this.a & 0xff) : this.a & 0xffff;
        this.cycles += 2;
        return;
      case 0x3b:
        this.a = this.s & 0xffff;
        this.setNZ(this.a, false);
        this.cycles += 2;
        return;
      case 0xeb:
        this.a = ((this.a << 8) | (this.a >> 8)) & 0xffff;
        this.setNZ(this.a & 0xff, true);
        this.cycles += 3;
        return;

      // --- stack -------------------------------------------------------------
      case 0x48:
        if (this.narrowA) this.push8(this.a);
        else this.push16(this.a);
        this.cycles += this.narrowA ? 3 : 4;
        return;
      case 0x68:
        if (this.narrowA) this.a = (this.a & 0xff00) | this.pull8();
        else this.a = this.pull16();
        this.setNZ(this.a, this.narrowA);
        this.cycles += this.narrowA ? 4 : 5;
        return;
      case 0xda:
        this.pushIndex(this.x);
        return;
      case 0x5a:
        this.pushIndex(this.y);
        return;
      case 0xfa:
        this.x = this.pullIndex();
        this.setNZ(this.x, this.narrowIndex);
        return;
      case 0x7a:
        this.y = this.pullIndex();
        this.setNZ(this.y, this.narrowIndex);
        return;
      case 0x08:
        this.push8(this.p);
        this.cycles += 3;
        return;
      case 0x28:
        this.p = this.pull8();
        if (this.e) this.p |= FLAG.M | FLAG.X;
        this.applyWidths();
        this.cycles += 4;
        return;
      case 0x8b:
        this.push8(this.db);
        this.cycles += 3;
        return;
      case 0xab:
        this.db = this.pull8();
        this.setNZ(this.db, true);
        this.cycles += 4;
        return;
      case 0x0b:
        this.push16(this.d);
        this.cycles += 4;
        return;
      case 0x2b:
        this.d = this.pull16();
        this.setNZ(this.d, false);
        this.cycles += 5;
        return;
      case 0x4b:
        this.push8(this.pb);
        this.cycles += 3;
        return;
      case 0xf4:
        this.push16(this.fetch16());
        this.cycles += 5;
        return;
      case 0xd4: {
        const pointer = (this.d + this.fetch8()) & 0xffff;
        this.push16(this.read16(pointer));
        this.cycles += 6;
        return;
      }
      case 0x62: {
        const offset = this.fetch16();
        this.push16((this.pc + (offset < 0x8000 ? offset : offset - 0x10000)) & 0xffff);
        this.cycles += 6;
        return;
      }

      // --- jumps and calls ---------------------------------------------------
      case 0x4c:
        this.pc = this.fetch16();
        this.cycles += 3;
        return;
      case 0x6c: {
        // The indirect jump reads its pointer from bank zero, not from the
        // program bank — which is the one place this differs from the 6502's, and
        // the 6502's page-wrap bug is not reproduced because this CPU does not
        // have it.
        const pointer = this.fetch16();
        this.pc = this.read16(pointer);
        this.cycles += 5;
        return;
      }
      case 0x7c: {
        const pointer = ((this.pb << 16) | this.fetch16()) + this.x;
        this.pc = this.read16(pointer & 0xffffff);
        this.cycles += 6;
        return;
      }
      case 0xdc: {
        const pointer = this.fetch16();
        this.pc = this.read16(pointer);
        this.pb = this.read8(pointer + 2);
        this.cycles += 6;
        return;
      }
      case 0x5c: {
        const target = this.fetch24();
        this.pc = target & 0xffff;
        this.pb = (target >> 16) & 0xff;
        this.cycles += 4;
        return;
      }
      case 0x20: {
        const target = this.fetch16();
        this.push16((this.pc - 1) & 0xffff);
        this.pc = target;
        this.cycles += 6;
        return;
      }
      case 0xfc: {
        const pointer = ((this.pb << 16) | this.fetch16()) + this.x;
        this.push16((this.pc - 1) & 0xffff);
        this.pc = this.read16(pointer & 0xffffff);
        this.cycles += 8;
        return;
      }
      case 0x22: {
        const target = this.fetch24();
        this.push8(this.pb);
        this.push16((this.pc - 1) & 0xffff);
        this.pb = (target >> 16) & 0xff;
        this.pc = target & 0xffff;
        this.cycles += 8;
        return;
      }
      case 0x60:
        this.pc = (this.pull16() + 1) & 0xffff;
        this.cycles += 6;
        return;
      case 0x6b:
        this.pc = (this.pull16() + 1) & 0xffff;
        this.pb = this.pull8();
        this.cycles += 6;
        return;
      case 0x40:
        this.p = this.pull8();
        if (this.e) this.p |= FLAG.M | FLAG.X;
        this.pc = this.pull16();
        if (!this.e) this.pb = this.pull8();
        this.applyWidths();
        this.cycles += this.e ? 6 : 7;
        return;

      // --- branches ----------------------------------------------------------
      case 0x90:
        this.branch((this.p & FLAG.C) === 0);
        return;
      case 0xb0:
        this.branch((this.p & FLAG.C) !== 0);
        return;
      case 0xf0:
        this.branch((this.p & FLAG.Z) !== 0);
        return;
      case 0xd0:
        this.branch((this.p & FLAG.Z) === 0);
        return;
      case 0x30:
        this.branch((this.p & FLAG.N) !== 0);
        return;
      case 0x10:
        this.branch((this.p & FLAG.N) === 0);
        return;
      case 0x50:
        this.branch((this.p & FLAG.V) === 0);
        return;
      case 0x70:
        this.branch((this.p & FLAG.V) !== 0);
        return;
      case 0x80:
        this.branch(true);
        return;
      case 0x82: {
        const offset = this.fetch16();
        this.pc = (this.pc + (offset < 0x8000 ? offset : offset - 0x10000)) & 0xffff;
        this.cycles += 4;
        return;
      }

      // --- flags -------------------------------------------------------------
      case 0x18:
        this.p &= ~FLAG.C & 0xff;
        this.cycles += 2;
        return;
      case 0x38:
        this.p |= FLAG.C;
        this.cycles += 2;
        return;
      case 0x58:
        this.p &= ~FLAG.I & 0xff;
        this.cycles += 2;
        return;
      case 0x78:
        this.p |= FLAG.I;
        this.cycles += 2;
        return;
      case 0xb8:
        this.p &= ~FLAG.V & 0xff;
        this.cycles += 2;
        return;
      case 0xd8:
        this.p &= ~FLAG.D & 0xff;
        this.cycles += 2;
        return;
      case 0xf8:
        this.p |= FLAG.D;
        this.cycles += 2;
        return;
      case 0xc2:
        this.p &= ~this.fetch8() & 0xff;
        // Emulation mode holds both width bits set whatever a program asks for.
        if (this.e) this.p |= FLAG.M | FLAG.X;
        this.cycles += 3;
        return;
      case 0xe2:
        this.p |= this.fetch8();
        this.applyWidths();
        this.cycles += 3;
        return;
      case 0xfb: {
        // The carry and the emulation flag change places, which is how a
        // cartridge leaves the mode reset put it in.
        const carry = (this.p & FLAG.C) !== 0;
        this.setFlag(FLAG.C, this.e);
        this.e = carry;
        if (this.e) {
          this.p |= FLAG.M | FLAG.X;
          this.s = 0x0100 | (this.s & 0xff);
          this.applyWidths();
        }
        this.cycles += 2;
        return;
      }

      // --- block moves -------------------------------------------------------
      case 0x54:
        this.blockMove(1);
        return;
      case 0x44:
        this.blockMove(-1);
        return;

      // --- the rest ----------------------------------------------------------
      case 0xea:
        this.cycles += 2;
        return;
      case 0x42:
        this.fetch8();
        this.cycles += 2;
        return;
      case 0xcb:
        this.waiting = true;
        this.cycles += 3;
        return;
      case 0xdb:
        this.stopped = true;
        this.cycles += 3;
        return;
      case 0x00:
        this.fetch8();
        this.enter(this.e ? VECTOR.emulationIrq : VECTOR.nativeBrk);
        return;
      case 0x02:
        this.fetch8();
        this.enter(this.e ? VECTOR.emulationCop : VECTOR.nativeCop);
        return;
      default:
        throw new Error(`snes: unimplemented opcode $${opcode.toString(16).padStart(2, "0")}`);
    }
  }

  // --- helpers the switch leans on -------------------------------------------

  private compareAt(address: number, register: number): void {
    const narrow = this.narrowIndex;
    this.compare(register, this.readValue(address, narrow), narrow);
    if (!narrow) this.cycles += 1;
  }

  private testAndSet(value: number, set: boolean): number {
    const narrow = this.narrowA;
    const mask = narrow ? 0xff : 0xffff;
    const a = this.a & mask;
    this.setFlag(FLAG.Z, (a & value) === 0);
    return set ? (value | a) & mask : value & ~a & mask;
  }

  private shiftAccumulator(transform: (value: number) => number): void {
    const narrow = this.narrowA;
    const result = transform(narrow ? this.a & 0xff : this.a);
    this.a = narrow ? (this.a & 0xff00) | (result & 0xff) : result & 0xffff;
    this.cycles += 2;
  }

  private stepIndex(register: "x" | "y", delta: number): void {
    const narrow = this.narrowIndex;
    this[register] = (this[register] + delta) & (narrow ? 0xff : 0xffff);
    this.setNZ(this[register], narrow);
    this.cycles += 2;
  }

  private loadImmediateA(): void {
    const narrow = this.narrowA;
    const value = this.immediate(narrow);
    this.a = narrow ? (this.a & 0xff00) | value : value;
    this.setNZ(value, narrow);
  }

  private loadImmediateIndex(register: "x" | "y"): void {
    const narrow = this.narrowIndex;
    const value = this.immediate(narrow);
    this[register] = value;
    this.setNZ(value, narrow);
  }

  private transferToIndex(register: "x" | "y", value: number): void {
    const narrow = this.narrowIndex;
    this[register] = narrow ? value & 0xff : value & 0xffff;
    this.setNZ(this[register], narrow);
    this.cycles += 2;
  }

  private transferToA(value: number): void {
    // Eight-bit A keeps its high byte; sixteen-bit A takes the whole register,
    // whose own high byte is zero whenever the index registers are narrow.
    const narrow = this.narrowA;
    this.a = narrow ? (this.a & 0xff00) | (value & 0xff) : value & 0xffff;
    this.setNZ(this.a, narrow);
    this.cycles += 2;
  }

  private pushIndex(value: number): void {
    if (this.narrowIndex) this.push8(value);
    else this.push16(value);
    this.cycles += this.narrowIndex ? 3 : 4;
  }

  private pullIndex(): number {
    this.cycles += this.narrowIndex ? 4 : 5;
    return this.narrowIndex ? this.pull8() : this.pull16();
  }

  /**
   * `mvn`/`mvp` — a block move, run to completion.
   *
   * Real hardware executes one byte per instruction and rewinds the program
   * counter, so an interrupt can land in the middle of one; here the whole run
   * happens at once and is charged its full cycle count. Nothing this project
   * emits uses it, and a game that did would be transferring within one frame
   * either way.
   */
  private blockMove(delta: number): void {
    const destinationBank = this.fetch8();
    const sourceBank = this.fetch8();
    this.db = destinationBank;
    const mask = this.narrowIndex ? 0xff : 0xffff;
    for (;;) {
      const byte = this.read8((sourceBank << 16) | (this.x & 0xffff));
      this.write8((destinationBank << 16) | (this.y & 0xffff), byte);
      this.x = (this.x + delta) & mask;
      this.y = (this.y + delta) & mask;
      this.cycles += 7;
      if (this.a === 0) break;
      this.a = (this.a - 1) & 0xffff;
    }
    this.a = 0xffff;
  }
}
