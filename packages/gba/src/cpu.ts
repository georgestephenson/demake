/**
 * An ARM7TDMI, in ARM state.
 *
 * The fifth CPU this project owns an interpreter for, and it exists for the two
 * jobs the other four do (doc 14 §Conformance, doc 07 §no CDN): run a
 * `demake build` cartridge in Vitest with no toolchain and no emulator install,
 * and play one in the page without fetching a core from anywhere.
 *
 * **ARM state only, and that is a statement about what demake emits rather than
 * a shortcut.** `core/src/asm/arm.ts` encodes no Thumb, so no cartridge this
 * project builds contains any — and a half-implemented second instruction set
 * would be a decoder nobody exercises, which is the thing `@demake/snes`'s
 * missing background layers are deliberately not (AGENTS.md §Iron rules). A
 * `bx` to an odd address therefore raises rather than quietly executing ARM.
 *
 * Three things about this core reach further than the decoder:
 *
 *   - **The program counter reads as this instruction plus eight**, because the
 *     pipeline has already fetched two more. Every operand that names `r15` sees
 *     that value — and *twelve* when the instruction takes a register-specified
 *     shift, because that form costs the prefetch another cycle. Both are
 *     implemented, because a PC-relative literal pool is how ARM loads constants
 *     and it reads the wrong word if either is off by one.
 *   - **The banked registers are real.** An interrupt runs in its own mode with
 *     its own stack pointer, so a handler that pushes does not walk over the
 *     game's stack. Modelling one flat register file would work until the first
 *     interrupt that arrived mid-expression.
 *   - **`movs pc, lr` is a return *and* a mode switch.** A data-processing
 *     instruction with the S bit and `r15` as its destination copies SPSR back
 *     into CPSR, which is the only way out of an exception. A core that treated
 *     it as an ordinary branch would leave the machine in IRQ mode for ever, and
 *     the symptom would be a stack pointer that silently changes meaning.
 *
 * Sources: ARM — *ARM7TDMI Technical Reference Manual* (DDI 0210C) and the *ARM
 * Architecture Reference Manual* (DDI 0100E, §A3 instruction encodings, §A2.5
 * the program status registers).
 */

/** What the processor reads and writes; the console supplies it. */
export interface Bus {
  read8(address: number): number;
  read16(address: number): number;
  read32(address: number): number;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;
  /**
   * Extra cycles an access to this address costs, beyond the one every access
   * takes.
   *
   * A fact about the *bus* rather than the processor: cartridge ROM is sixteen
   * bits wide behind programmable wait states, external work RAM is sixteen bits
   * behind two, and internal work RAM is thirty-two bits behind none. The
   * processor asks; the console answers.
   */
  wait(address: number, width: 1 | 2 | 4): number;
}

/** Processor modes, by the five bits that name them in the status register. */
export const MODE_USER = 0x10;
/** Fast interrupt — banked but unused; nothing here raises one. */
export const MODE_FIQ = 0x11;
/** Interrupt, which is where a handler runs. */
export const MODE_IRQ = 0x12;
/** Supervisor, which is where reset and `swi` land. */
export const MODE_SVC = 0x13;
/** Abort. */
export const MODE_ABT = 0x17;
/** Undefined. */
export const MODE_UND = 0x1b;
/** System — user's registers with privilege, which is where a game runs. */
export const MODE_SYS = 0x1f;

/** Exception vectors, at the bottom of the address space. */
export const VECTOR = {
  reset: 0x00000000,
  undefined: 0x00000004,
  swi: 0x00000008,
  prefetchAbort: 0x0000000c,
  dataAbort: 0x00000010,
  irq: 0x00000018,
  fiq: 0x0000001c,
} as const;

/** Raised when a cartridge does something this core does not implement. */
export class CpuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CpuError";
  }
}

/** One mode's banked stack pointer, link register and saved status. */
interface Bank {
  sp: number;
  lr: number;
  spsr: number;
}

/** A fresh bank. */
function bank(): Bank {
  return { sp: 0, lr: 0, spsr: 0 };
}

/** Rotate a word right by `amount`, which is what the immediate field means. */
function ror32(value: number, amount: number): number {
  const n = amount & 31;
  if (n === 0) return value >>> 0;
  return ((value >>> n) | (value << (32 - n))) >>> 0;
}

/**
 * The unsigned 64-bit product of two words, in two words.
 *
 * Built from four 16-bit partial products rather than from `BigInt`, because a
 * fixed-point multiply is the single most-executed helper in a compiled game and
 * an allocation per multiply is what turns a conformance run from seconds into
 * minutes. The signed forms are this with a correction applied — see
 * {@link Arm7.multiplyLong}.
 */
function mul64(a: number, b: number): { low: number; high: number } {
  const al = a & 0xffff;
  const ah = a >>> 16;
  const bl = b & 0xffff;
  const bh = b >>> 16;
  const p0 = al * bl;
  const p1 = ah * bl;
  const p2 = al * bh;
  const p3 = ah * bh;
  const middle = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
  const low = (((middle & 0xffff) * 0x10000 + (p0 & 0xffff)) >>> 0) as number;
  const high = ((p3 + (p1 >>> 16) + (p2 >>> 16) + (middle >>> 16)) >>> 0) as number;
  return { low, high };
}

/** An ARM7TDMI. */
export class Arm7 {
  /** The visible register file; `r[15]` is the program counter. */
  readonly r = new Uint32Array(16);

  /**
   * Where the next instruction will be fetched from.
   *
   * The same name the other five cores' processors give it, so a harness that
   * asks "which routine is this" reads the same on every machine — the audio
   * conformance battery attributes a driver tick by program counter and is
   * written once against all of them.
   */
  get pc(): number {
    return this.r[15] as number;
  }

  /** Negative. */
  n = false;
  /** Zero. */
  z = false;
  /** Carry — and on a subtraction it means *no borrow*, as on the 6502. */
  c = false;
  /** Overflow. */
  v = false;
  /** The I bit: interrupts are masked while it is set. */
  irqDisabled = true;
  /** The current mode, as one of the `MODE_*` constants. */
  mode: number = MODE_SVC;
  /** The current mode's saved status register. */
  spsr = 0;

  /**
   * Whether the processor is waiting for an interrupt.
   *
   * Set by a write to `HALTCNT`, cleared by the console when an enabled
   * interrupt is requested. It is what makes the conformance suite affordable: a
   * game's main loop spends almost the whole frame here, and a core that spun
   * through it would execute tens of thousands of instructions per frame to
   * observe nothing.
   */
  halted = false;

  private readonly banks = new Map<number, Bank>([
    [MODE_FIQ, bank()],
    [MODE_IRQ, bank()],
    [MODE_SVC, bank()],
    [MODE_ABT, bank()],
    [MODE_UND, bank()],
  ]);
  /** User and System share one bank, which is what makes System useful. */
  private readonly userBank = bank();
  /** Set by any write to `r15`, so a branch is distinguishable from a fall-through. */
  private branched = false;

  constructor(readonly bus: Bus) {}

  // --- state -----------------------------------------------------------------

  /** The status register, assembled from the flags that are kept apart. */
  get cpsr(): number {
    return (
      ((this.n ? 1 : 0) << 31) |
      ((this.z ? 1 : 0) << 30) |
      ((this.c ? 1 : 0) << 29) |
      ((this.v ? 1 : 0) << 28) |
      ((this.irqDisabled ? 1 : 0) << 7) |
      (1 << 6) | // F: fast interrupts are masked, always, on this machine
      this.mode
    );
  }

  /** Write the status register, switching banks if the mode field changed. */
  set cpsr(value: number) {
    this.n = (value & 0x80000000) !== 0;
    this.z = (value & 0x40000000) !== 0;
    this.c = (value & 0x20000000) !== 0;
    this.v = (value & 0x10000000) !== 0;
    this.irqDisabled = (value & 0x80) !== 0;
    if ((value & 0x20) !== 0) throw new CpuError("this core is ARM state only; T was set");
    this.setMode(value & 0x1f);
  }

  /**
   * Move to another mode, swapping the stack pointer and link register.
   *
   * Only `r13`/`r14` and the saved status are banked here. `r8`–`r12` are banked
   * on a real core in FIQ mode alone, and nothing on this console raises an FIQ
   * — so modelling it would be a second register file no test could reach.
   */
  private setMode(next: number): void {
    if (next === this.mode) return;
    const from =
      this.mode === MODE_USER || this.mode === MODE_SYS ? this.userBank : this.bankOf(this.mode);
    from.sp = this.r[13] as number;
    from.lr = this.r[14] as number;
    from.spsr = this.spsr;
    const to = next === MODE_USER || next === MODE_SYS ? this.userBank : this.bankOf(next);
    this.r[13] = to.sp;
    this.r[14] = to.lr;
    this.spsr = to.spsr;
    this.mode = next;
  }

  private bankOf(mode: number): Bank {
    const found = this.banks.get(mode);
    if (found === undefined) throw new CpuError(`no register bank for mode $${mode.toString(16)}`);
    return found;
  }

  /**
   * Power on.
   *
   * The three stack pointers are the ones a Game Boy Advance's own boot code
   * leaves behind, because a cartridge is entitled to assume them: the system
   * stack at the top of internal work RAM, and the supervisor and interrupt
   * stacks below it. A core that left them zero would run any cartridge that set
   * its own and fault on every one that did not.
   */
  reset(entry: number, stacks = { sys: 0x03007f00, irq: 0x03007fa0, svc: 0x03007fe0 }): void {
    this.r.fill(0);
    this.n = this.z = this.c = this.v = false;
    // Not the architecture's reset state, which masks interrupts in supervisor
    // mode: this is the state a *cartridge* starts in, after the boot ROM has
    // set the three stacks and entered it in System mode with interrupts
    // unmasked. `IME` is what a program actually gates on, and it starts clear.
    this.irqDisabled = false;
    this.halted = false;
    this.spsr = 0;
    this.mode = MODE_SVC;
    for (const entryBank of this.banks.values()) {
      entryBank.sp = 0;
      entryBank.lr = 0;
      entryBank.spsr = 0;
    }
    this.userBank.sp = stacks.sys;
    this.userBank.lr = 0;
    this.bankOf(MODE_IRQ).sp = stacks.irq;
    this.bankOf(MODE_SVC).sp = stacks.svc;
    this.r[13] = stacks.svc;
    this.setMode(MODE_SYS);
    this.r[15] = entry >>> 0;
  }

  /**
   * Take an interrupt, if one is not masked.
   *
   * The saved link register is the *next* instruction plus four, because the
   * return is `subs pc, lr, #4` — the architecture's convention, and the reason
   * an exception return is not a plain branch.
   */
  interrupt(): boolean {
    if (this.irqDisabled) return false;
    const returnTo = ((this.r[15] as number) + 4) >>> 0;
    const saved = this.cpsr;
    this.setMode(MODE_IRQ);
    this.spsr = saved;
    this.r[14] = returnTo;
    this.irqDisabled = true;
    this.r[15] = VECTOR.irq;
    this.halted = false;
    return true;
  }

  // --- reading and writing registers ----------------------------------------

  /**
   * Read a register.
   *
   * `r15` already holds this instruction plus eight — the fetch put it there,
   * because that is what the pipeline makes the program counter read as — so
   * `extra` is what a *particular form* adds on top of that, and it is zero
   * almost everywhere. The two exceptions are the ones the manual calls out:
   * an operand of an instruction whose shift comes from a register reads four
   * higher, because that form costs the prefetch another cycle, and so does the
   * value a store writes out.
   */
  private read(index: number, extra = 0): number {
    if (index === 15) return ((this.r[15] as number) + extra) >>> 0;
    return this.r[index] as number;
  }

  /** Write a register, noticing when the program counter moved. */
  private write(index: number, value: number): void {
    if (index === 15) {
      this.r[15] = (value & ~3) >>> 0;
      this.branched = true;
      return;
    }
    this.r[index] = value >>> 0;
  }

  // --- the barrel shifter ----------------------------------------------------

  /** The shifted operand and the carry it produced. */
  private shift(
    value: number,
    type: number,
    amount: number,
    fromRegister: boolean,
  ): { value: number; carry: boolean } {
    const word = value >>> 0;
    if (fromRegister) {
      // A register-specified shift of zero leaves both the value and the carry
      // alone, whatever the type — which an immediate shift of zero does not.
      if (amount === 0) return { value: word, carry: this.c };
      if (amount >= 32) {
        switch (type) {
          case 0:
            return { value: 0, carry: amount === 32 ? (word & 1) !== 0 : false };
          case 1:
            return { value: 0, carry: amount === 32 ? (word & 0x80000000) !== 0 : false };
          case 2: {
            const sign = (word & 0x80000000) !== 0;
            return { value: sign ? 0xffffffff : 0, carry: sign };
          }
          default: {
            const rotated = ror32(word, amount & 31);
            return { value: rotated, carry: (rotated & 0x80000000) !== 0 };
          }
        }
      }
    } else if (amount === 0) {
      switch (type) {
        case 0:
          return { value: word, carry: this.c };
        case 1:
          // `lsr #0` means `lsr #32`, which is the whole word gone.
          return { value: 0, carry: (word & 0x80000000) !== 0 };
        case 2:
          return {
            value: (word & 0x80000000) !== 0 ? 0xffffffff : 0,
            carry: (word & 0x80000000) !== 0,
          };
        default: {
          // `ror #0` is `rrx`: a 33-bit rotate through the carry flag.
          const result = (((this.c ? 1 : 0) << 31) | (word >>> 1)) >>> 0;
          return { value: result, carry: (word & 1) !== 0 };
        }
      }
    }
    switch (type) {
      case 0:
        return { value: (word << amount) >>> 0, carry: (word & (1 << (32 - amount))) !== 0 };
      case 1:
        return { value: word >>> amount, carry: (word & (1 << (amount - 1))) !== 0 };
      case 2:
        return { value: ((word | 0) >> amount) >>> 0, carry: (word & (1 << (amount - 1))) !== 0 };
      default: {
        const result = ror32(word, amount);
        return { value: result, carry: (word & (1 << (amount - 1))) !== 0 };
      }
    }
  }

  // --- running ---------------------------------------------------------------

  /** Whether a condition field holds against the current flags. */
  private passes(cond: number): boolean {
    switch (cond) {
      case 0:
        return this.z;
      case 1:
        return !this.z;
      case 2:
        return this.c;
      case 3:
        return !this.c;
      case 4:
        return this.n;
      case 5:
        return !this.n;
      case 6:
        return this.v;
      case 7:
        return !this.v;
      case 8:
        return this.c && !this.z;
      case 9:
        return !this.c || this.z;
      case 10:
        return this.n === this.v;
      case 11:
        return this.n !== this.v;
      case 12:
        return !this.z && this.n === this.v;
      case 13:
        return this.z || this.n !== this.v;
      case 14:
        return true;
      default:
        throw new CpuError("condition 'nv' is unpredictable on this architecture");
    }
  }

  /**
   * Execute one instruction and report what it cost.
   *
   * The cost is a model rather than a cycle-exact count: one cycle for the
   * instruction, whatever the bus charges for its fetch and its data accesses,
   * and the pipeline refill a taken branch pays. It decides the speed figure a
   * build reports and how much of a frame a tick uses; it does not decide *what*
   * a program computes, and the audio driver's tempo comes from a hardware timer
   * counting the console's own clock rather than from anything here.
   */
  step(): number {
    if (this.halted) return 1;
    const at = (this.r[15] as number) >>> 0;
    const op = this.bus.read32(at) >>> 0;
    let cycles = 1 + this.bus.wait(at, 4);
    this.r[15] = (at + 8) >>> 0;
    this.branched = false;

    const cond = op >>> 28;
    if (cond === 14 || this.passes(cond)) {
      cycles += this.execute(op);
    }

    if (this.branched) cycles += 2;
    else this.r[15] = (at + 4) >>> 0;
    return cycles;
  }

  /** Decode and perform one instruction whose condition already held. */
  private execute(op: number): number {
    // The order below is the decode tree's, which is not the order the manual
    // lists instructions in: several forms live in holes inside the
    // data-processing space and have to be tested for *before* it.
    if ((op & 0x0fffff00) === 0x012fff00 && (op & 0xf0) === 0x10) {
      return this.branchExchange(op);
    }
    if ((op & 0x0fc000f0) === 0x00000090) return this.multiply(op);
    if ((op & 0x0f8000f0) === 0x00800090) return this.multiplyLong(op);
    if ((op & 0x0fb00ff0) === 0x01000090) {
      throw new CpuError("swp is not implemented; nothing demake emits uses it");
    }
    if ((op & 0x0e000090) === 0x00000090 && (op & 0x60) !== 0) {
      return this.halfTransfer(op);
    }
    const kind = (op >>> 25) & 7;
    switch (kind) {
      case 0:
      case 1:
        return this.dataProcessing(op);
      case 2:
      case 3:
        if (kind === 3 && (op & 0x10) !== 0) {
          throw new CpuError(`undefined instruction $${op.toString(16)}`);
        }
        return this.transfer(op);
      case 4:
        return this.block(op);
      case 5:
        return this.branch(op);
      case 6:
        throw new CpuError("coprocessor transfers are not implemented on this console");
      default:
        if ((op & 0x0f000000) === 0x0f000000) {
          throw new CpuError(
            `swi $${(op & 0xffffff).toString(16)}: demake emits no BIOS call — ` +
              "a wait writes HALTCNT directly",
          );
        }
        throw new CpuError(`coprocessor instruction $${op.toString(16)}`);
    }
  }

  private branchExchange(op: number): number {
    const target = this.read(op & 0xf);
    if ((target & 1) !== 0) {
      throw new CpuError("bx to a Thumb address; this core is ARM state only");
    }
    this.write(15, target);
    return 0;
  }

  private branch(op: number): number {
    const link = (op & 0x01000000) !== 0;
    const offset = ((op & 0xffffff) << 8) >> 6; // sign-extend, then × 4
    if (link) this.r[14] = ((this.r[15] as number) - 4) >>> 0;
    this.write(15, ((this.r[15] as number) + offset) >>> 0);
    return 0;
  }

  private dataProcessing(op: number): number {
    const immediate = (op & 0x02000000) !== 0;
    const opcode = (op >>> 21) & 0xf;
    const setFlags = (op & 0x00100000) !== 0;
    const rn = (op >>> 16) & 0xf;
    const rd = (op >>> 12) & 0xf;
    // Which opcodes leave the overflow flag alone, and it is not simply "the
    // ones above seven": `cmp` and `cmn` are *arithmetic* comparisons and set V
    // like the `sub` and `add` they are, while `tst` and `teq` are logical ones
    // and do not. Getting that wrong produces flags that are right until a
    // comparison overflows — which is exactly what a clamp against the ends of
    // the 16.16 range does, so it surfaces as a value clamped to the wrong end.
    const logical = opcode <= 1 || opcode === 8 || opcode === 9 || opcode >= 12;

    // The four comparison opcodes with the S bit clear are not comparisons at
    // all — that hole in the encoding is where the status-register transfers
    // live, and a core that missed it would perform an `and` that writes nothing.
    if (!setFlags && opcode >= 8 && opcode <= 11) return this.statusTransfer(op);

    let operand: number;
    let shifterCarry = this.c;
    let extra = 0;
    if (immediate) {
      const rotate = ((op >>> 8) & 0xf) * 2;
      operand = ror32(op & 0xff, rotate);
      if (rotate !== 0) shifterCarry = (operand & 0x80000000) !== 0;
    } else {
      const type = (op >>> 5) & 3;
      const byRegister = (op & 0x10) !== 0;
      // A register-specified shift costs the pipeline a cycle, which is exactly
      // why `r15` reads four higher in that form than in every other.
      const amount = byRegister ? this.read((op >>> 8) & 0xf) & 0xff : (op >>> 7) & 0x1f;
      if (byRegister) extra = 1;
      const shifted = this.shift(this.read(op & 0xf, byRegister ? 4 : 0), type, amount, byRegister);
      operand = shifted.value;
      shifterCarry = shifted.carry;
    }

    const a = this.read(rn, !immediate && (op & 0x10) !== 0 ? 4 : 0);
    let result: number;
    let carry: boolean;
    let overflow = this.v;
    switch (opcode) {
      case 0: // and
      case 8: // tst
        result = (a & operand) >>> 0;
        carry = shifterCarry;
        break;
      case 1: // eor
      case 9: // teq
        result = (a ^ operand) >>> 0;
        carry = shifterCarry;
        break;
      case 2: // sub
      case 10: // cmp
        result = (a - operand) >>> 0;
        carry = a >>> 0 >= operand >>> 0;
        overflow = ((a ^ operand) & (a ^ result) & 0x80000000) !== 0;
        break;
      case 3: {
        // rsb
        result = (operand - a) >>> 0;
        carry = operand >>> 0 >= a >>> 0;
        overflow = ((operand ^ a) & (operand ^ result) & 0x80000000) !== 0;
        break;
      }
      case 4: // add
      case 11: {
        // cmn
        const sum = (a >>> 0) + (operand >>> 0);
        result = sum >>> 0;
        carry = sum > 0xffffffff;
        overflow = (~(a ^ operand) & (a ^ result) & 0x80000000) !== 0;
        break;
      }
      case 5: {
        // adc
        const sum = (a >>> 0) + (operand >>> 0) + (this.c ? 1 : 0);
        result = sum >>> 0;
        carry = sum > 0xffffffff;
        overflow = (~(a ^ operand) & (a ^ result) & 0x80000000) !== 0;
        break;
      }
      case 6: {
        // sbc
        const diff = (a >>> 0) - (operand >>> 0) - (this.c ? 0 : 1);
        result = diff >>> 0;
        carry = diff >= 0;
        overflow = ((a ^ operand) & (a ^ result) & 0x80000000) !== 0;
        break;
      }
      case 7: {
        // rsc
        const diff = (operand >>> 0) - (a >>> 0) - (this.c ? 0 : 1);
        result = diff >>> 0;
        carry = diff >= 0;
        overflow = ((operand ^ a) & (operand ^ result) & 0x80000000) !== 0;
        break;
      }
      case 12: // orr
        result = (a | operand) >>> 0;
        carry = shifterCarry;
        break;
      case 13: // mov
        result = operand >>> 0;
        carry = shifterCarry;
        break;
      case 14: // bic
        result = (a & ~operand) >>> 0;
        carry = shifterCarry;
        break;
      default: // mvn
        result = ~operand >>> 0;
        carry = shifterCarry;
        break;
    }

    const writes = opcode < 8 || opcode > 11;
    if (setFlags && rd === 15 && writes) {
      // The exception return: `movs pc, lr` and `subs pc, lr, #4` restore the
      // whole status register from the mode's saved copy, which is the only way
      // back out of an interrupt.
      const saved = this.spsr;
      this.write(15, result);
      this.cpsr = saved;
      return extra;
    }
    if (writes) this.write(rd, result);
    if (setFlags) {
      this.n = (result & 0x80000000) !== 0;
      this.z = result === 0;
      this.c = carry;
      if (!logical) this.v = overflow;
    }
    return extra;
  }

  /** `mrs` and `msr`, which live in the comparison opcodes' unused corner. */
  private statusTransfer(op: number): number {
    const useSpsr = (op & 0x00400000) !== 0;
    if ((op & 0x00200000) === 0) {
      // mrs
      this.write((op >>> 12) & 0xf, useSpsr ? this.spsr : this.cpsr);
      return 0;
    }
    const value =
      (op & 0x02000000) !== 0 ? ror32(op & 0xff, ((op >>> 8) & 0xf) * 2) : this.read(op & 0xf);
    const mask = (op >>> 16) & 0xf;
    let bits = 0;
    if ((mask & 1) !== 0) bits |= 0x000000ff;
    if ((mask & 2) !== 0) bits |= 0x0000ff00;
    if ((mask & 4) !== 0) bits |= 0x00ff0000;
    if ((mask & 8) !== 0) bits |= 0xff000000;
    if (useSpsr) {
      this.spsr = ((this.spsr & ~bits) | (value & bits)) >>> 0;
      return 0;
    }
    // In User mode only the flag byte is writable. Nothing here runs in User
    // mode — a game runs in System, which has the same registers and the
    // privilege — so the distinction never bites, and it is still the rule.
    const writable = this.mode === MODE_USER ? bits & 0xff000000 : bits;
    this.cpsr = ((this.cpsr & ~writable) | (value & writable)) >>> 0;
    return 0;
  }

  private multiply(op: number): number {
    const rd = (op >>> 16) & 0xf;
    const rn = (op >>> 12) & 0xf;
    const rs = (op >>> 8) & 0xf;
    const rm = op & 0xf;
    const product = Math.imul(this.read(rm) | 0, this.read(rs) | 0) >>> 0;
    const result = (op & 0x00200000) !== 0 ? (product + this.read(rn)) >>> 0 : product;
    this.write(rd, result);
    if ((op & 0x00100000) !== 0) {
      this.n = (result & 0x80000000) !== 0;
      this.z = result === 0;
    }
    // The core's multiplier is early-terminating: it costs a cycle per byte of
    // the multiplier that is not all sign bits.
    return Arm7.multiplyCost(this.read(rs));
  }

  private multiplyLong(op: number): number {
    const rdHi = (op >>> 16) & 0xf;
    const rdLo = (op >>> 12) & 0xf;
    const rs = (op >>> 8) & 0xf;
    const rm = op & 0xf;
    const a = this.read(rm);
    const b = this.read(rs);
    let { low, high } = mul64(a, b);
    if ((op & 0x00400000) !== 0) {
      // The signed product is the unsigned one with each negative operand's
      // partner subtracted out of the high word — an identity rather than a
      // second multiply, which matters because a 16.16 multiply runs on every
      // tick of every moving object.
      if ((a & 0x80000000) !== 0) high = (high - b) >>> 0;
      if ((b & 0x80000000) !== 0) high = (high - a) >>> 0;
    }
    if ((op & 0x00200000) !== 0) {
      const sum = low + this.read(rdLo);
      low = sum >>> 0;
      high = (high + this.read(rdHi) + (sum > 0xffffffff ? 1 : 0)) >>> 0;
    }
    this.write(rdLo, low);
    this.write(rdHi, high);
    if ((op & 0x00100000) !== 0) {
      this.n = (high & 0x80000000) !== 0;
      this.z = low === 0 && high === 0;
    }
    return Arm7.multiplyCost(b) + 1;
  }

  /** How many cycles the early-terminating multiplier spends on this operand. */
  private static multiplyCost(operand: number): number {
    const word = operand >>> 0;
    if (word >>> 8 === 0 || word >>> 8 === 0xffffff) return 1;
    if (word >>> 16 === 0 || word >>> 16 === 0xffff) return 2;
    if (word >>> 24 === 0 || word >>> 24 === 0xff) return 3;
    return 4;
  }

  /** The address a transfer uses, and the write-back it may owe. */
  private address(op: number, offset: number): { at: number; writeBack: number | undefined } {
    const rn = (op >>> 16) & 0xf;
    const base = this.read(rn);
    const up = (op & 0x00800000) !== 0;
    const pre = (op & 0x01000000) !== 0;
    const moved = (up ? base + offset : base - offset) >>> 0;
    const at = pre ? moved : base;
    // Post-indexing always writes back; pre-indexing does so only when asked.
    const wants = pre ? (op & 0x00200000) !== 0 : true;
    return { at, writeBack: wants && rn !== 15 ? moved : undefined };
  }

  private transfer(op: number): number {
    const load = (op & 0x00100000) !== 0;
    const byte = (op & 0x00400000) !== 0;
    const rd = (op >>> 12) & 0xf;
    let offset: number;
    if ((op & 0x02000000) === 0) {
      offset = op & 0xfff;
    } else {
      const shifted = this.shift(this.read(op & 0xf), (op >>> 5) & 3, (op >>> 7) & 0x1f, false);
      offset = shifted.value;
    }
    const { at, writeBack } = this.address(op, offset);
    let cycles = this.bus.wait(at, byte ? 1 : 4);
    if (load) {
      // An unaligned word load rotates rather than faults — the one place this
      // architecture is stranger than it looks. Nothing demake emits relies on
      // it; implementing it costs a line and makes a mistake visible as a wrong
      // number rather than as a silent truncation.
      const value = byte ? this.bus.read8(at) : ror32(this.bus.read32(at & ~3), (at & 3) * 8);
      if (writeBack !== undefined) this.write((op >>> 16) & 0xf, writeBack);
      this.write(rd, value);
      cycles += 1;
    } else {
      const value = this.read(rd, 4);
      if (byte) this.bus.write8(at, value & 0xff);
      else this.bus.write32(at & ~3, value);
      if (writeBack !== undefined) this.write((op >>> 16) & 0xf, writeBack);
    }
    return cycles;
  }

  private halfTransfer(op: number): number {
    const load = (op & 0x00100000) !== 0;
    const rd = (op >>> 12) & 0xf;
    const offset =
      (op & 0x00400000) !== 0 ? (((op >>> 8) & 0xf) << 4) | (op & 0xf) : this.read(op & 0xf);
    const { at, writeBack } = this.address(op, offset);
    const kind = (op >>> 5) & 3;
    let cycles = this.bus.wait(at, kind === 2 ? 1 : 2);
    if (load) {
      let value: number;
      if (kind === 1) value = this.bus.read16(at & ~1);
      else if (kind === 2) value = ((this.bus.read8(at) << 24) >> 24) >>> 0;
      else value = ((this.bus.read16(at & ~1) << 16) >> 16) >>> 0;
      if (writeBack !== undefined) this.write((op >>> 16) & 0xf, writeBack);
      this.write(rd, value);
      cycles += 1;
    } else {
      if (kind !== 1) throw new CpuError("only strh exists; there is no signed store");
      this.bus.write16(at & ~1, this.read(rd, 4) & 0xffff);
      if (writeBack !== undefined) this.write((op >>> 16) & 0xf, writeBack);
    }
    return cycles;
  }

  private block(op: number): number {
    const rn = (op >>> 16) & 0xf;
    const load = (op & 0x00100000) !== 0;
    const pre = (op & 0x01000000) !== 0;
    const up = (op & 0x00800000) !== 0;
    const writeBack = (op & 0x00200000) !== 0;
    const userBank = (op & 0x00400000) !== 0;
    const list = op & 0xffff;
    if (userBank && !(load && (list & 0x8000) !== 0)) {
      throw new CpuError("a user-bank block transfer is not implemented");
    }

    const registers: number[] = [];
    for (let index = 0; index < 16; index += 1) {
      if ((list & (1 << index)) !== 0) registers.push(index);
    }
    if (registers.length === 0) throw new CpuError("an empty register list is unpredictable");

    // Registers always move in increasing order at increasing addresses, so the
    // four addressing modes reduce to a starting address and the write-back.
    const base = this.read(rn);
    const bytes = registers.length * 4;
    const lowest = up ? base : (base - bytes) >>> 0;
    const start = (up ? (pre ? base + 4 : base) : pre ? base - bytes : base - bytes + 4) >>> 0;
    const after = (up ? base + bytes : base - bytes) >>> 0;

    let cycles = this.bus.wait(lowest, 4) * registers.length;
    if (load) {
      // Write-back happens before the loads on this core, so a list that also
      // loads the base register keeps what memory held rather than the address.
      if (writeBack) this.write(rn, after);
      registers.forEach((register, index) => {
        this.write(register, this.bus.read32((start + index * 4) >>> 0));
      });
      if ((list & 0x8000) !== 0 && userBank) this.cpsr = this.spsr;
      cycles += 1;
    } else {
      registers.forEach((register, index) => {
        // A stored base register holds its *original* value when it is the first
        // in the list and the written-back one otherwise; this core stores the
        // original throughout, which is what every list demake emits contains.
        this.bus.write32((start + index * 4) >>> 0, this.read(register, 4));
      });
      if (writeBack) this.write(rn, after);
    }
    return cycles;
  }
}
