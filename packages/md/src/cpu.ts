/**
 * A Motorola 68000 interpreter.
 *
 * The fourth owned CPU, and it exists for the two jobs the other three do (doc
 * 14 §Conformance, doc 07 §no CDN): run a `demake build` cartridge in Vitest
 * with no toolchain and no emulator install, and play one in the page without
 * fetching a core from anywhere. What it has to be right about is exactly what
 * `packages/core/src/asm/m68k.ts` emits — and the *pair* is what is tested, by
 * driving this with that assembler and checking the published opcode bytes
 * separately, so an encoder and a decoder that agreed with each other and not
 * with Motorola would still fail.
 *
 * Three things about this machine shape the implementation:
 *
 *   - **The condition codes are the whole contract.** A backend built on
 *     `cmp.l` + `blt` is a backend that is wrong the moment `V` is wrong, and
 *     the failure looks like a game that plays correctly until something goes
 *     negative. So every arithmetic path sets all five flags explicitly rather
 *     than inheriting them, and `X` — which only the rotate-through-extend and
 *     the multi-precision forms read — is kept separate from `C` rather than
 *     aliased to it.
 *   - **Address registers do not set flags and do not have sizes below a word.**
 *     `adda`, `suba` and `movea` leave the codes alone, and a word source is
 *     *sign-extended* into all 32 bits. A core that zero-extended would put a
 *     game's entity pointers 64 KiB away from its entities.
 *   - **`a7` moves by two for a byte.** The stack pointer stays even whatever
 *     the operand size, because an odd stack is an address error on the next
 *     interrupt.
 *
 * Sources: Motorola — M68000 Family Programmer's Reference Manual (M68000PM/AD)
 * and the M68000 User's Manual (MC68000UM/AD, §2 addressing and §6 exceptions).
 */

/** What the CPU needs of the machine around it. */
export interface Bus {
  read8(address: number): number;
  read16(address: number): number;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
}

/** Where the hardware sends each exception. */
export const VECTOR = {
  stack: 0x000,
  reset: 0x004,
  busError: 0x008,
  addressError: 0x00c,
  illegal: 0x010,
  divideByZero: 0x014,
  privilege: 0x020,
  /** Level 4 autovector — the VDP's horizontal interrupt. */
  hint: 0x070,
  /** Level 6 autovector — the VDP's vertical interrupt. */
  vint: 0x078,
} as const;

/** Operand size in bytes. */
type Width = 1 | 2 | 4;

const MASK: Readonly<Record<Width, number>> = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };
const SIGN: Readonly<Record<Width, number>> = { 1: 0x80, 2: 0x8000, 4: 0x80000000 };

/**
 * Truncate to a width, as an unsigned number.
 *
 * Not `value & MASK[width]`: JavaScript's bitwise operators return a *signed*
 * 32-bit integer, so masking a long produces a negative number and every
 * unsigned comparison built on it is wrong for half the range. This is the one
 * place that distinction is handled, and everything else goes through it.
 */
function trunc(value: number, width: Width): number {
  return width === 4 ? value >>> 0 : value & MASK[width];
}

/** Sign-extend a value of the given width to a signed 32-bit number. */
function signed(value: number, width: Width): number {
  if (width === 4) return value | 0;
  if (width === 2) return (value << 16) >> 16;
  return (value << 24) >> 24;
}

/** Where an operand lives, once its addressing mode has been resolved. */
type Slot =
  | { readonly kind: "d"; readonly n: number }
  | { readonly kind: "a"; readonly n: number }
  | { readonly kind: "mem"; readonly at: number }
  | { readonly kind: "imm"; readonly v: number };

/** A Motorola 68000, running in supervisor mode from reset. */
export class M68k {
  /** The eight data registers, as raw 32-bit patterns. */
  readonly d = new Uint32Array(8);
  /** The eight address registers; `a[7]` is the stack pointer. */
  readonly a = new Uint32Array(8);
  pc = 0;

  // The condition codes, kept apart rather than packed: every one of them is
  // read on its own far more often than the byte is.
  c = false;
  v = false;
  z = false;
  n = false;
  x = false;
  /** The interrupt mask, bits 0–2 of the status register's high byte. */
  mask = 7;
  /** Set while the processor is stopped, waiting for an interrupt. */
  stopped = false;

  /** Set when the CPU executed something it does not implement. */
  illegal = 0;

  /** The stack pointer, which is `a7` under a name that reads. */
  get sp(): number {
    return this.a[7] as number;
  }

  constructor(private readonly bus: Bus) {}

  /** Load the stack pointer and the program counter from the vector table. */
  reset(): void {
    this.a[7] = this.read32(VECTOR.stack) >>> 0;
    this.pc = this.read32(VECTOR.reset) >>> 0;
    this.mask = 7;
    this.stopped = false;
  }

  /** The status register, as a program sees it. */
  get sr(): number {
    return (
      0x2000 |
      (this.mask << 8) |
      ((this.x ? 1 : 0) << 4) |
      ((this.n ? 1 : 0) << 3) |
      ((this.z ? 1 : 0) << 2) |
      ((this.v ? 1 : 0) << 1) |
      (this.c ? 1 : 0)
    );
  }

  set sr(value: number) {
    this.mask = (value >> 8) & 7;
    this.x = (value & 0x10) !== 0;
    this.n = (value & 0x08) !== 0;
    this.z = (value & 0x04) !== 0;
    this.v = (value & 0x02) !== 0;
    this.c = (value & 0x01) !== 0;
  }

  // --- memory ----------------------------------------------------------------

  private read32(address: number): number {
    return ((this.bus.read16(address) << 16) | this.bus.read16((address + 2) >>> 0)) >>> 0;
  }

  private write32(address: number, value: number): void {
    this.bus.write16(address, (value >>> 16) & 0xffff);
    this.bus.write16((address + 2) >>> 0, value & 0xffff);
  }

  private readWidth(address: number, width: Width): number {
    if (width === 1) return this.bus.read8(address);
    if (width === 2) return this.bus.read16(address);
    return this.read32(address);
  }

  private writeWidth(address: number, value: number, width: Width): void {
    if (width === 1) this.bus.write8(address, value & 0xff);
    else if (width === 2) this.bus.write16(address, value & 0xffff);
    else this.write32(address, value >>> 0);
  }

  /** Fetch the word at the program counter and step past it. */
  private fetch(): number {
    const word = this.bus.read16(this.pc);
    this.pc = (this.pc + 2) >>> 0;
    return word;
  }

  private fetchLong(): number {
    const value = this.read32(this.pc);
    this.pc = (this.pc + 4) >>> 0;
    return value >>> 0;
  }

  // --- interrupts ------------------------------------------------------------

  /**
   * Take an autovectored interrupt, if its level is above the mask.
   *
   * The stack frame is the 68000's short one — status register then return
   * address — because nothing here ever needs to *resume* a faulted bus cycle,
   * only to return from a handler.
   */
  interrupt(level: number, vector: number): boolean {
    if (level <= this.mask && level !== 7) return false;
    this.stopped = false;
    const status = this.sr;
    this.a[7] = (this.sp - 4) >>> 0;
    this.write32(this.sp, this.pc);
    this.a[7] = (this.sp - 2) >>> 0;
    this.bus.write16(this.sp, status);
    this.mask = level;
    this.pc = this.read32(vector) >>> 0;
    return true;
  }

  // --- addressing ------------------------------------------------------------

  /** Resolve one effective address, consuming whatever extension words it has. */
  private resolve(mode: number, reg: number, width: Width): Slot {
    switch (mode) {
      case 0:
        return { kind: "d", n: reg };
      case 1:
        return { kind: "a", n: reg };
      case 2:
        return { kind: "mem", at: this.a[reg] as number };
      case 3: {
        const at = this.a[reg] as number;
        // The stack pointer stays even whatever the operand size: an odd `a7` is
        // an address error the moment anything is pushed on it.
        const step = width === 1 && reg === 7 ? 2 : width;
        this.a[reg] = (at + step) >>> 0;
        return { kind: "mem", at };
      }
      case 4: {
        const step = width === 1 && reg === 7 ? 2 : width;
        const at = ((this.a[reg] as number) - step) >>> 0;
        this.a[reg] = at;
        return { kind: "mem", at };
      }
      case 5: {
        const offset = signed(this.fetch(), 2);
        return { kind: "mem", at: ((this.a[reg] as number) + offset) >>> 0 };
      }
      case 6:
        return { kind: "mem", at: this.indexed(this.a[reg] as number) };
      case 7:
        switch (reg) {
          case 0:
            return { kind: "mem", at: signed(this.fetch(), 2) >>> 0 };
          case 1:
            return { kind: "mem", at: this.fetchLong() };
          case 2: {
            const base = this.pc;
            const offset = signed(this.fetch(), 2);
            return { kind: "mem", at: (base + offset) >>> 0 };
          }
          case 3: {
            const base = this.pc;
            return { kind: "mem", at: this.indexed(base) };
          }
          case 4: {
            if (width === 4) return { kind: "imm", v: this.fetchLong() };
            const word = this.fetch();
            return { kind: "imm", v: width === 1 ? word & 0xff : word };
          }
          default:
            this.illegal += 1;
            return { kind: "imm", v: 0 };
        }
      default:
        this.illegal += 1;
        return { kind: "imm", v: 0 };
    }
  }

  /** The `(d8,An,Xn)` extension word, which is the same for the PC-relative form. */
  private indexed(base: number): number {
    const word = this.fetch();
    const register = (word >> 12) & 7;
    const isAddress = (word & 0x8000) !== 0;
    const raw = isAddress ? (this.a[register] as number) : (this.d[register] as number);
    const index = (word & 0x0800) !== 0 ? raw | 0 : signed(raw & 0xffff, 2);
    return (base + signed(word & 0xff, 1) + index) >>> 0;
  }

  private load(slot: Slot, width: Width): number {
    switch (slot.kind) {
      case "d":
        return trunc(this.d[slot.n] as number, width);
      case "a":
        return trunc(this.a[slot.n] as number, width);
      case "mem":
        return this.readWidth(slot.at, width);
      case "imm":
        return trunc(slot.v, width);
    }
  }

  private store(slot: Slot, value: number, width: Width): void {
    switch (slot.kind) {
      case "d": {
        const old = this.d[slot.n] as number;
        this.d[slot.n] =
          width === 4 ? value >>> 0 : ((old & ~MASK[width]) | trunc(value, width)) >>> 0;
        return;
      }
      case "a":
        // An address register is always written whole, sign-extended from a word.
        this.a[slot.n] = (width === 4 ? value : signed(value, 2)) >>> 0;
        return;
      case "mem":
        this.writeWidth(slot.at, value, width);
        return;
      case "imm":
        this.illegal += 1;
    }
  }

  // --- flags -----------------------------------------------------------------

  private setLogic(result: number, width: Width): number {
    const masked = trunc(result, width);
    this.n = (masked & SIGN[width]) !== 0;
    this.z = masked === 0;
    this.v = false;
    this.c = false;
    return masked;
  }

  private doAdd(left: number, right: number, width: Width, carryIn = 0): number {
    const l = trunc(left, width);
    const r = trunc(right, width);
    const sum = l + r + carryIn;
    const masked = trunc(sum, width);
    const carry = sum > MASK[width];
    const sl = (l & SIGN[width]) !== 0;
    const sr = (r & SIGN[width]) !== 0;
    const sm = (masked & SIGN[width]) !== 0;
    this.c = carry;
    this.x = carry;
    this.v = sl === sr && sm !== sl;
    this.n = sm;
    this.z = masked === 0;
    return masked;
  }

  /** `left - right`, setting the codes; `keepX` is false for `cmp`. */
  private doSub(left: number, right: number, width: Width, keepX = true): number {
    const l = trunc(left, width);
    const r = trunc(right, width);
    const masked = trunc(l - r, width);
    const borrow = l < r;
    const sl = (l & SIGN[width]) !== 0;
    const sr = (r & SIGN[width]) !== 0;
    const sm = (masked & SIGN[width]) !== 0;
    this.c = borrow;
    if (keepX) this.x = borrow;
    this.v = sl !== sr && sm !== sl;
    this.n = sm;
    this.z = masked === 0;
    return masked;
  }

  /** Is this condition true, given the codes? */
  condition(code: number): boolean {
    switch (code) {
      case 0:
        return true;
      case 1:
        return false;
      case 2:
        return !this.c && !this.z; // hi
      case 3:
        return this.c || this.z; // ls
      case 4:
        return !this.c; // cc
      case 5:
        return this.c; // cs
      case 6:
        return !this.z; // ne
      case 7:
        return this.z; // eq
      case 8:
        return !this.v; // vc
      case 9:
        return this.v; // vs
      case 10:
        return !this.n; // pl
      case 11:
        return this.n; // mi
      case 12:
        return this.n === this.v; // ge
      case 13:
        return this.n !== this.v; // lt
      case 14:
        return this.n === this.v && !this.z; // gt
      default:
        return this.n !== this.v || this.z; // le
    }
  }

  // --- execution -------------------------------------------------------------

  /** Run one instruction and return roughly the cycles it took. */
  step(): number {
    if (this.stopped) return 4;
    const op = this.fetch();
    switch (op >> 12) {
      case 0x0:
        return this.group0(op);
      case 0x1:
        return this.doMove(op, 1);
      case 0x2:
        return this.doMove(op, 4);
      case 0x3:
        return this.doMove(op, 2);
      case 0x4:
        return this.group4(op);
      case 0x5:
        return this.group5(op);
      case 0x6:
        return this.branch(op);
      case 0x7:
        return this.moveq(op);
      case 0x8:
        return this.orDiv(op);
      case 0x9:
        return this.addSub(op, false);
      case 0xb:
        return this.cmpEor(op);
      case 0xc:
        return this.andMul(op);
      case 0xd:
        return this.addSub(op, true);
      case 0xe:
        return this.shift(op);
      default:
        this.illegal += 1;
        return 4;
    }
  }

  /** The width a two-bit size field names. */
  private sizeOf(bits: number): Width {
    return bits === 0 ? 1 : bits === 1 ? 2 : 4;
  }

  private doMove(op: number, width: Width): number {
    const srcMode = (op >> 3) & 7;
    const srcReg = op & 7;
    const dstMode = (op >> 6) & 7;
    const dstReg = (op >> 9) & 7;
    const source = this.load(this.resolve(srcMode, srcReg, width), width);
    if (dstMode === 1) {
      // movea: no flags, and a word source reaches all 32 bits.
      this.a[dstReg] = (width === 4 ? source : signed(source, 2)) >>> 0;
      return 8;
    }
    const slot = this.resolve(dstMode, dstReg, width);
    this.setLogic(source, width);
    this.store(slot, source, width);
    return 8;
  }

  private moveq(op: number): number {
    const value = signed(op & 0xff, 1);
    this.d[(op >> 9) & 7] = value >>> 0;
    this.setLogic(value, 4);
    return 4;
  }

  /** Immediates and the bit operations, which share the `0000` page. */
  private group0(op: number): number {
    const sizeBits = (op >> 6) & 3;
    const mode = (op >> 3) & 7;
    const reg = op & 7;

    // The bit operations: `#n` in bits 11–8 = 1000, or a register there.
    const isBitImmediate = ((op >> 8) & 0xf) === 8;
    const isBitRegister = (op & 0x0100) !== 0 && mode !== 1;
    if (isBitImmediate || isBitRegister) {
      const bit = isBitImmediate ? this.fetch() & 0xff : (this.d[(op >> 9) & 7] as number);
      const width: Width = mode === 0 ? 4 : 1;
      const index = bit % (width === 4 ? 32 : 8);
      const slot = this.resolve(mode, reg, width);
      const value = this.load(slot, width);
      this.z = ((value >>> index) & 1) === 0;
      const action = (op >> 6) & 3;
      if (action === 1) this.store(slot, value ^ (1 << index), width);
      else if (action === 2) this.store(slot, value & ~(1 << index), width);
      else if (action === 3) this.store(slot, value | (1 << index), width);
      return 8;
    }

    const width = this.sizeOf(sizeBits);
    const value = this.load(this.resolve(7, 4, width), width);
    const slot = this.resolve(mode, reg, width);
    const target = this.load(slot, width);
    switch ((op >> 9) & 7) {
      case 0: // ori
        this.store(slot, this.setLogic(target | value, width), width);
        return 8;
      case 1: // andi
        this.store(slot, this.setLogic(target & value, width), width);
        return 8;
      case 2: // subi
        this.store(slot, this.doSub(target, value, width), width);
        return 8;
      case 3: // addi
        this.store(slot, this.doAdd(target, value, width), width);
        return 8;
      case 5: // eori
        this.store(slot, this.setLogic(target ^ value, width), width);
        return 8;
      case 6: // cmpi
        this.doSub(target, value, width, false);
        return 8;
      default:
        this.illegal += 1;
        return 4;
    }
  }

  /** The `0100` page: unary operations, `lea`, `jmp`/`jsr`, `movem`, returns. */
  private group4(op: number): number {
    const mode = (op >> 3) & 7;
    const reg = op & 7;

    if (op === 0x4e71) return 4; // nop
    if (op === 0x4e75) {
      // rts
      this.pc = this.read32(this.sp);
      this.a[7] = (this.sp + 4) >>> 0;
      return 16;
    }
    if (op === 0x4e73) {
      // rte
      this.sr = this.bus.read16(this.sp);
      this.a[7] = (this.sp + 2) >>> 0;
      this.pc = this.read32(this.sp);
      this.a[7] = (this.sp + 4) >>> 0;
      return 20;
    }
    if (op === 0x4e72) {
      // stop #imm
      this.sr = this.fetch();
      this.stopped = true;
      return 4;
    }

    if ((op & 0xffc0) === 0x4ec0) {
      // jmp
      const slot = this.resolve(mode, reg, 4);
      if (slot.kind !== "mem") {
        this.illegal += 1;
        return 4;
      }
      this.pc = slot.at;
      return 8;
    }
    if ((op & 0xffc0) === 0x4e80) {
      // jsr
      const slot = this.resolve(mode, reg, 4);
      if (slot.kind !== "mem") {
        this.illegal += 1;
        return 4;
      }
      this.a[7] = (this.sp - 4) >>> 0;
      this.write32(this.sp, this.pc);
      this.pc = slot.at;
      return 16;
    }
    if ((op & 0xf1c0) === 0x41c0) {
      // lea
      const slot = this.resolve(mode, reg, 4);
      if (slot.kind !== "mem") {
        this.illegal += 1;
        return 4;
      }
      this.a[(op >> 9) & 7] = slot.at >>> 0;
      return 8;
    }
    if ((op & 0xfff8) === 0x4840) {
      // swap
      const value = this.d[reg] as number;
      const swapped = ((value >>> 16) | (value << 16)) >>> 0;
      this.d[reg] = swapped;
      this.setLogic(swapped, 4);
      return 4;
    }
    if ((op & 0xffc0) === 0x4840) {
      // pea
      const slot = this.resolve(mode, reg, 4);
      if (slot.kind !== "mem") {
        this.illegal += 1;
        return 4;
      }
      this.a[7] = (this.sp - 4) >>> 0;
      this.write32(this.sp, slot.at);
      return 12;
    }
    if ((op & 0xfff8) === 0x4880 || (op & 0xfff8) === 0x48c0) {
      // ext.w / ext.l
      const value = this.d[reg] as number;
      const result =
        (op & 0x0040) === 0
          ? ((value & 0xffff0000) | (signed(value & 0xff, 1) & 0xffff)) >>> 0
          : signed(value & 0xffff, 2) >>> 0;
      this.d[reg] = result;
      this.setLogic(result, (op & 0x0040) === 0 ? 2 : 4);
      return 4;
    }
    if ((op & 0xfb80) === 0x4880) return this.movem(op);
    if ((op & 0xffc0) === 0x46c0) {
      // move to sr
      this.sr = this.load(this.resolve(mode, reg, 2), 2);
      return 12;
    }
    if ((op & 0xffc0) === 0x40c0) {
      // move from sr
      const slot = this.resolve(mode, reg, 2);
      this.store(slot, this.sr, 2);
      return 8;
    }
    if ((op & 0xffc0) === 0x44c0) {
      // move to ccr
      this.sr = (this.sr & 0xff00) | (this.load(this.resolve(mode, reg, 2), 2) & 0xff);
      return 12;
    }

    const width = this.sizeOf((op >> 6) & 3);
    switch ((op >> 9) & 7) {
      case 1: {
        // clr — which reads first on real silicon, and does not need to here.
        const slot = this.resolve(mode, reg, width);
        this.store(slot, 0, width);
        this.n = false;
        this.z = true;
        this.v = false;
        this.c = false;
        return 8;
      }
      case 2: {
        // neg
        const slot = this.resolve(mode, reg, width);
        const value = this.load(slot, width);
        this.store(slot, this.doSub(0, value, width), width);
        return 8;
      }
      case 3: {
        // not
        const slot = this.resolve(mode, reg, width);
        const value = this.load(slot, width);
        this.store(slot, this.setLogic(~value, width), width);
        return 8;
      }
      case 5: {
        // tst
        const value = this.load(this.resolve(mode, reg, width), width);
        this.setLogic(value, width);
        return 4;
      }
      default:
        this.illegal += 1;
        return 4;
    }
  }

  private movem(op: number): number {
    const toRegisters = (op & 0x0400) !== 0;
    const width: Width = (op & 0x0040) !== 0 ? 4 : 2;
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const mask = this.fetch();
    let cycles = 12;

    if (!toRegisters && mode === 4) {
      // Predecrement: the mask runs a7 first, and the address register is stepped
      // down before each store.
      let at = this.a[reg] as number;
      for (let bit = 0; bit < 16; bit += 1) {
        if (((mask >> bit) & 1) === 0) continue;
        const which = 15 - bit;
        const value = which < 8 ? (this.d[which] as number) : (this.a[which - 8] as number);
        at = (at - width) >>> 0;
        this.writeWidth(at, value, width);
        cycles += 8;
      }
      this.a[reg] = at;
      return cycles;
    }

    const slot = this.resolve(mode, reg, width);
    if (slot.kind !== "mem") {
      this.illegal += 1;
      return 4;
    }
    let at = slot.at;
    for (let bit = 0; bit < 16; bit += 1) {
      if (((mask >> bit) & 1) === 0) continue;
      if (toRegisters) {
        const value = this.readWidth(at, width);
        const wide = width === 2 ? signed(value, 2) >>> 0 : value >>> 0;
        if (bit < 8) this.d[bit] = wide;
        else this.a[bit - 8] = wide;
      } else {
        const value = bit < 8 ? (this.d[bit] as number) : (this.a[bit - 8] as number);
        this.writeWidth(at, value, width);
      }
      at = (at + width) >>> 0;
      cycles += 8;
    }
    if (toRegisters && mode === 3) this.a[reg] = at >>> 0;
    return cycles;
  }

  /** `addq`/`subq`, `Scc` and `DBcc` — the `0101` page. */
  private group5(op: number): number {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const sizeBits = (op >> 6) & 3;

    if (sizeBits === 3) {
      if (mode === 1) {
        // dbcc: fall through when the condition holds, else count down.
        const cond = (op >> 8) & 0xf;
        const base = this.pc;
        const offset = signed(this.fetch(), 2);
        if (this.condition(cond)) return 12;
        const counter = ((this.d[reg] as number) & 0xffff) - 1;
        this.d[reg] = (((this.d[reg] as number) & 0xffff0000) | (counter & 0xffff)) >>> 0;
        if ((counter & 0xffff) !== 0xffff) {
          this.pc = (base + offset) >>> 0;
          return 10;
        }
        return 14;
      }
      // scc
      const slot = this.resolve(mode, reg, 1);
      this.store(slot, this.condition((op >> 8) & 0xf) ? 0xff : 0x00, 1);
      return 8;
    }

    const width = this.sizeOf(sizeBits);
    const raw = (op >> 9) & 7;
    const amount = raw === 0 ? 8 : raw;
    const slot = this.resolve(mode, reg, width);
    if (slot.kind === "a") {
      // Quick arithmetic on an address register touches no condition code and is
      // always a full 32-bit operation, whatever the size field says.
      const value = this.a[slot.n] as number;
      this.a[slot.n] = ((op & 0x0100) !== 0 ? value - amount : value + amount) >>> 0;
      return 8;
    }
    const value = this.load(slot, width);
    const result =
      (op & 0x0100) !== 0
        ? this.doSub(value, amount, width)
        : this.doAdd(value, amount, width);
    this.store(slot, result, width);
    return 8;
  }

  private branch(op: number): number {
    const cond = (op >> 8) & 0xf;
    const short = signed(op & 0xff, 1);
    const base = this.pc;
    const offset = short === 0 ? signed(this.fetch(), 2) : short;
    const target = (base + offset) >>> 0;
    if (cond === 1) {
      // bsr
      this.a[7] = (this.sp - 4) >>> 0;
      this.write32(this.sp, this.pc);
      this.pc = target;
      return 18;
    }
    if (cond === 0 || this.condition(cond)) {
      this.pc = target;
      return 10;
    }
    return 8;
  }

  /** `or`, `divu`, `divs` — the `1000` page. */
  private orDiv(op: number): number {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const dn = (op >> 9) & 7;
    const opmode = (op >> 6) & 7;

    if (opmode === 3 || opmode === 7) {
      const divisor = this.load(this.resolve(mode, reg, 2), 2);
      const dividend = this.d[dn] as number;
      if (divisor === 0) {
        this.v = false;
        this.c = false;
        return 10;
      }
      let quotient: number;
      let remainder: number;
      if (opmode === 3) {
        quotient = Math.floor((dividend >>> 0) / divisor);
        remainder = (dividend >>> 0) % divisor;
        if (quotient > 0xffff) {
          this.v = true;
          this.c = false;
          return 140;
        }
      } else {
        const left = dividend | 0;
        const right = signed(divisor, 2);
        quotient = Math.trunc(left / right);
        remainder = left % right;
        if (quotient > 32767 || quotient < -32768) {
          this.v = true;
          this.c = false;
          return 158;
        }
      }
      this.d[dn] = (((remainder & 0xffff) << 16) | (quotient & 0xffff)) >>> 0;
      this.n = (quotient & 0x8000) !== 0;
      this.z = (quotient & 0xffff) === 0;
      this.v = false;
      this.c = false;
      return 140;
    }

    const width = this.sizeOf(opmode & 3);
    if (opmode < 3) {
      const value = this.load(this.resolve(mode, reg, width), width);
      const result = this.setLogic((this.d[dn] as number) | value, width);
      this.store({ kind: "d", n: dn }, result, width);
      return 8;
    }
    const slot = this.resolve(mode, reg, width);
    const result = this.setLogic(this.load(slot, width) | (this.d[dn] as number), width);
    this.store(slot, result, width);
    return 12;
  }

  /** `and`, `mulu`, `muls` — the `1100` page. `exg` and `abcd` are not emitted. */
  private andMul(op: number): number {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const dn = (op >> 9) & 7;
    const opmode = (op >> 6) & 7;

    if (opmode === 3 || opmode === 7) {
      const source = this.load(this.resolve(mode, reg, 2), 2);
      const left = (this.d[dn] as number) & 0xffff;
      const product =
        opmode === 3
          ? Math.imul(left, source) >>> 0
          : Math.imul(signed(left, 2), signed(source, 2)) >>> 0;
      this.d[dn] = product;
      this.n = (product & 0x80000000) !== 0;
      this.z = product === 0;
      this.v = false;
      this.c = false;
      return 54;
    }

    const width = this.sizeOf(opmode & 3);
    if (opmode < 3) {
      const value = this.load(this.resolve(mode, reg, width), width);
      const result = this.setLogic((this.d[dn] as number) & value, width);
      this.store({ kind: "d", n: dn }, result, width);
      return 8;
    }
    const slot = this.resolve(mode, reg, width);
    const result = this.setLogic(this.load(slot, width) & (this.d[dn] as number), width);
    this.store(slot, result, width);
    return 12;
  }

  /** `add`/`adda`/`sub`/`suba` — the `1101` and `1001` pages. */
  private addSub(op: number, adding: boolean): number {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const dn = (op >> 9) & 7;
    const opmode = (op >> 6) & 7;

    if (opmode === 3 || opmode === 7) {
      // adda / suba: no condition codes, a word source sign-extended.
      const width: Width = opmode === 3 ? 2 : 4;
      const raw = this.load(this.resolve(mode, reg, width), width);
      const value = width === 2 ? signed(raw, 2) : raw;
      const current = this.a[dn] as number;
      this.a[dn] = (adding ? current + value : current - value) >>> 0;
      return 8;
    }

    const width = this.sizeOf(opmode & 3);
    if (opmode < 3) {
      const value = this.load(this.resolve(mode, reg, width), width);
      const left = trunc(this.d[dn] as number, width);
      const result = adding
        ? this.doAdd(left, value, width)
        : this.doSub(left, value, width);
      this.store({ kind: "d", n: dn }, result, width);
      return 8;
    }
    const slot = this.resolve(mode, reg, width);
    const target = this.load(slot, width);
    const value = trunc(this.d[dn] as number, width);
    const result = adding
      ? this.doAdd(target, value, width)
      : this.doSub(target, value, width);
    this.store(slot, result, width);
    return 12;
  }

  /** `cmp`, `cmpa` and `eor` — the `1011` page. */
  private cmpEor(op: number): number {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const dn = (op >> 9) & 7;
    const opmode = (op >> 6) & 7;

    if (opmode === 3 || opmode === 7) {
      const width: Width = opmode === 3 ? 2 : 4;
      const raw = this.load(this.resolve(mode, reg, width), width);
      const value = width === 2 ? signed(raw, 2) >>> 0 : raw;
      this.doSub(this.a[dn] as number, value, 4, false);
      return 8;
    }
    const width = this.sizeOf(opmode & 3);
    if (opmode < 3) {
      const value = this.load(this.resolve(mode, reg, width), width);
      this.doSub(trunc(this.d[dn] as number, width), value, width, false);
      return 8;
    }
    // eor
    const slot = this.resolve(mode, reg, width);
    const result = this.setLogic(this.load(slot, width) ^ (this.d[dn] as number), width);
    this.store(slot, result, width);
    return 12;
  }

  /** The shift and rotate page. */
  private shift(op: number): number {
    const mode = (op >> 3) & 7;
    const sizeBits = (op >> 6) & 3;
    const left = (op & 0x0100) !== 0;

    if (sizeBits === 3) {
      // A memory shift, which is word-only and always by one.
      const slot = this.resolve(mode, op & 7, 2);
      const value = this.load(slot, 2);
      this.store(slot, this.shiftOnce(value, 2, (op >> 9) & 3, left), 2);
      return 8;
    }

    const width = this.sizeOf(sizeBits);
    const reg = op & 7;
    const type = (op >> 3) & 3;
    const byRegister = (op & 0x0020) !== 0;
    const field = (op >> 9) & 7;
    const count = byRegister ? (this.d[field] as number) % 64 : field === 0 ? 8 : field;
    let value = trunc(this.d[reg] as number, width);
    if (count === 0) {
      // A zero count leaves X alone and clears C — the one case the general
      // path below cannot express, because it never runs.
      this.c = false;
      this.n = (value & SIGN[width]) !== 0;
      this.z = value === 0;
      this.v = false;
      return 6;
    }
    this.v = false;
    for (let index = 0; index < count; index += 1) value = this.shiftOnce(value, width, type, left);
    this.store({ kind: "d", n: reg }, value, width);
    this.n = (value & SIGN[width]) !== 0;
    this.z = trunc(value, width) === 0;
    return 6 + 2 * count;
  }

  /** One step of a shift or rotate, setting `C` (and `X`, where it applies). */
  private shiftOnce(value: number, width: Width, type: number, left: boolean): number {
    const top = SIGN[width];
    let result = value;
    if (left) {
      const out = (value & top) !== 0;
      result = trunc(value << 1, width);
      switch (type) {
        case 0: // asl — V is set if the sign changed at any point
          if (((result & top) !== 0) !== out) this.v = true;
          this.c = out;
          this.x = out;
          break;
        case 1: // lsl
          this.c = out;
          this.x = out;
          break;
        case 2: // roxl
          result |= this.x ? 1 : 0;
          this.c = out;
          this.x = out;
          break;
        default: // rol
          result |= out ? 1 : 0;
          this.c = out;
          break;
      }
      return trunc(result, width);
    }
    const out = (value & 1) !== 0;
    switch (type) {
      case 0: // asr — the sign bit is replicated
        result = trunc((value >>> 1) | (value & top), width);
        this.c = out;
        this.x = out;
        break;
      case 1: // lsr
        result = trunc(value >>> 1, width);
        this.c = out;
        this.x = out;
        break;
      case 2: // roxr
        result = trunc((value >>> 1) | (this.x ? top : 0), width);
        this.c = out;
        this.x = out;
        break;
      default: // ror
        result = trunc((value >>> 1) | (out ? top : 0), width);
        this.c = out;
        break;
    }
    return result;
  }
}
