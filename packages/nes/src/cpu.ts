/**
 * The MOS 6502 processor, as the NES has it.
 *
 * Written out rather than pulled in, for the reason `@demake/dmg`'s SM83 is
 * (doc 02): this core decides what "the ROM works" means, it runs in the browser
 * under doc 07's no-CDN rule, and it is the harness the Demotic runtime's NES
 * conformance test drives.
 *
 * Its tables are written independently of `core`'s assembler even though the two
 * describe the same instruction set. Deriving the decoder from the encoder would
 * guarantee they agree — and that is exactly the problem: a wrong entry would
 * then be invisible to a test that assembles a program and runs it. Two
 * transcriptions of the same reference disagree loudly instead, which is what
 * makes the conformance suite an oracle rather than a mirror.
 *
 * Scope: the 151 documented opcodes, binary arithmetic only. The 2A03 has its
 * decimal mode disconnected, so `sed` sets a flag that changes nothing and
 * `adc` is always binary — the backend never emits either, and modelling BCD
 * would be modelling hardware this console does not have. Illegal opcodes throw
 * rather than being tolerated: one can only appear if the code generator emitted
 * it, and a silent `nop` would turn that into a hang three layers away.
 *
 * Timings are the published cycle counts, including the extra cycle an indexed
 * read pays for crossing a page and the one a taken branch pays (two if it
 * crosses). Those matter here in a way they do not on a fixed-tick simulator: the
 * runtime's VBlank window is measured in cycles, and a core that charged too few
 * would let a ROM overrun VBlank in tests and tear on hardware.
 *
 * Source: NESdev Wiki — Instruction reference
 * (https://www.nesdev.org/wiki/Instruction_reference) and CPU addressing modes
 * (https://www.nesdev.org/wiki/CPU_addressing_modes).
 */

/** Everything the processor can reach. */
export interface Bus {
  read(address: number): number;
  write(address: number, value: number): void;
}

/** Where the CPU takes its three vectors from. */
export const VECTOR = { nmi: 0xfffa, reset: 0xfffc, irq: 0xfffe } as const;

/** Addressing modes, as the decode table names them. */
type Mode =
  | "imp"
  | "acc"
  | "imm"
  | "zp"
  | "zpX"
  | "zpY"
  | "abs"
  | "absX"
  | "absY"
  | "ind"
  | "indX"
  | "indY"
  | "rel";

/** One decoded instruction. */
interface Decoded {
  readonly name: string;
  readonly mode: Mode;
  readonly cycles: number;
}

/** Build the decode table from a compact listing of the documented opcodes. */
function decodeTable(): readonly (Decoded | undefined)[] {
  const table: (Decoded | undefined)[] = new Array(256).fill(undefined);
  const add = (opcode: number, name: string, mode: Mode, cycles: number): void => {
    table[opcode] = { name, mode, cycles };
  };

  // Arithmetic and logic: the eight regular columns, written out per mnemonic so
  // a hole in the matrix cannot be filled by accident.
  const group = (
    name: string,
    [immOp, zpOp, zpXOp, absOp, absXOp, absYOp, indXOp, indYOp]: readonly number[],
  ): void => {
    add(immOp as number, name, "imm", 2);
    add(zpOp as number, name, "zp", 3);
    add(zpXOp as number, name, "zpX", 4);
    add(absOp as number, name, "abs", 4);
    add(absXOp as number, name, "absX", 4);
    add(absYOp as number, name, "absY", 4);
    add(indXOp as number, name, "indX", 6);
    add(indYOp as number, name, "indY", 5);
  };
  group("ora", [0x09, 0x05, 0x15, 0x0d, 0x1d, 0x19, 0x01, 0x11]);
  group("and", [0x29, 0x25, 0x35, 0x2d, 0x3d, 0x39, 0x21, 0x31]);
  group("eor", [0x49, 0x45, 0x55, 0x4d, 0x5d, 0x59, 0x41, 0x51]);
  group("adc", [0x69, 0x65, 0x75, 0x6d, 0x7d, 0x79, 0x61, 0x71]);
  group("lda", [0xa9, 0xa5, 0xb5, 0xad, 0xbd, 0xb9, 0xa1, 0xb1]);
  group("cmp", [0xc9, 0xc5, 0xd5, 0xcd, 0xdd, 0xd9, 0xc1, 0xd1]);
  group("sbc", [0xe9, 0xe5, 0xf5, 0xed, 0xfd, 0xf9, 0xe1, 0xf1]);

  // `sta` has no immediate form, and its indexed stores never take the
  // page-cross penalty because they always write.
  add(0x85, "sta", "zp", 3);
  add(0x95, "sta", "zpX", 4);
  add(0x8d, "sta", "abs", 4);
  add(0x9d, "sta", "absX", 5);
  add(0x99, "sta", "absY", 5);
  add(0x81, "sta", "indX", 6);
  add(0x91, "sta", "indY", 6);

  add(0xa2, "ldx", "imm", 2);
  add(0xa6, "ldx", "zp", 3);
  add(0xb6, "ldx", "zpY", 4);
  add(0xae, "ldx", "abs", 4);
  add(0xbe, "ldx", "absY", 4);
  add(0xa0, "ldy", "imm", 2);
  add(0xa4, "ldy", "zp", 3);
  add(0xb4, "ldy", "zpX", 4);
  add(0xac, "ldy", "abs", 4);
  add(0xbc, "ldy", "absX", 4);
  add(0x86, "stx", "zp", 3);
  add(0x96, "stx", "zpY", 4);
  add(0x8e, "stx", "abs", 4);
  add(0x84, "sty", "zp", 3);
  add(0x94, "sty", "zpX", 4);
  add(0x8c, "sty", "abs", 4);

  add(0xe0, "cpx", "imm", 2);
  add(0xe4, "cpx", "zp", 3);
  add(0xec, "cpx", "abs", 4);
  add(0xc0, "cpy", "imm", 2);
  add(0xc4, "cpy", "zp", 3);
  add(0xcc, "cpy", "abs", 4);
  add(0x24, "bit", "zp", 3);
  add(0x2c, "bit", "abs", 4);

  // Read-modify-write: five cycles in zero page, six or seven elsewhere, and no
  // page-cross discount because the write is unconditional.
  for (const [name, ops] of [
    ["asl", [0x0a, 0x06, 0x16, 0x0e, 0x1e]],
    ["rol", [0x2a, 0x26, 0x36, 0x2e, 0x3e]],
    ["lsr", [0x4a, 0x46, 0x56, 0x4e, 0x5e]],
    ["ror", [0x6a, 0x66, 0x76, 0x6e, 0x7e]],
  ] as const) {
    add(ops[0], name, "acc", 2);
    add(ops[1], name, "zp", 5);
    add(ops[2], name, "zpX", 6);
    add(ops[3], name, "abs", 6);
    add(ops[4], name, "absX", 7);
  }
  add(0xe6, "inc", "zp", 5);
  add(0xf6, "inc", "zpX", 6);
  add(0xee, "inc", "abs", 6);
  add(0xfe, "inc", "absX", 7);
  add(0xc6, "dec", "zp", 5);
  add(0xd6, "dec", "zpX", 6);
  add(0xce, "dec", "abs", 6);
  add(0xde, "dec", "absX", 7);

  add(0x4c, "jmp", "abs", 3);
  add(0x6c, "jmp", "ind", 5);
  add(0x20, "jsr", "abs", 6);
  add(0x60, "rts", "imp", 6);
  add(0x40, "rti", "imp", 6);
  add(0x00, "brk", "imp", 7);

  for (const [opcode, name] of [
    [0x10, "bpl"],
    [0x30, "bmi"],
    [0x50, "bvc"],
    [0x70, "bvs"],
    [0x90, "bcc"],
    [0xb0, "bcs"],
    [0xd0, "bne"],
    [0xf0, "beq"],
  ] as const) {
    add(opcode, name, "rel", 2);
  }

  for (const [opcode, name, cycles] of [
    [0x18, "clc", 2],
    [0x38, "sec", 2],
    [0x58, "cli", 2],
    [0x78, "sei", 2],
    [0xb8, "clv", 2],
    [0xd8, "cld", 2],
    [0xf8, "sed", 2],
    [0xaa, "tax", 2],
    [0x8a, "txa", 2],
    [0xa8, "tay", 2],
    [0x98, "tya", 2],
    [0xba, "tsx", 2],
    [0x9a, "txs", 2],
    [0xca, "dex", 2],
    [0x88, "dey", 2],
    [0xe8, "inx", 2],
    [0xc8, "iny", 2],
    [0xea, "nop", 2],
    [0x48, "pha", 3],
    [0x08, "php", 3],
    [0x68, "pla", 4],
    [0x28, "plp", 4],
  ] as const) {
    add(opcode, name, "imp", cycles);
  }
  return table;
}

const DECODE = decodeTable();

/**
 * Instructions whose indexed *read* pays an extra cycle for crossing a page.
 *
 * The penalty is the discarded read at the wrong high byte, so only a pure load
 * pays it: a store always takes its fixed longer count, and a read-modify-write
 * has already paid for the write cycle it needs anyway.
 */
const PENALISED: ReadonlySet<string> = new Set([
  "lda",
  "ldx",
  "ldy",
  "and",
  "ora",
  "eor",
  "adc",
  "sbc",
  "cmp",
]);

/** The 6502 register file and instruction decoder. */
export class Cpu {
  a = 0;
  x = 0;
  y = 0;
  /** Stack pointer: the stack lives at `$0100 + sp`. */
  sp = 0xfd;
  pc = 0;

  carry = false;
  zero = false;
  /** Interrupt *disable*, as the hardware names it. */
  interrupt = true;
  decimal = false;
  overflow = false;
  negative = false;

  /** Latched until taken: the NMI is edge-triggered on real hardware. */
  private nmiPending = false;
  /** Level-sensitive, so the device holds it until it is acknowledged. */
  private irqLine = false;
  /** Extra cycles this instruction earned — a page cross, or a taken branch. */
  private extra = 0;

  constructor(private readonly bus: Bus) {}

  /** Take the reset vector, as the CPU does on power-up. */
  reset(): void {
    this.pc = this.bus.read(VECTOR.reset) | (this.bus.read(VECTOR.reset + 1) << 8);
    this.sp = 0xfd;
    this.interrupt = true;
  }

  /** Raise the non-maskable interrupt — the PPU's VBlank, in this machine. */
  nmi(): void {
    this.nmiPending = true;
  }

  /** Hold or release the maskable interrupt line. */
  setIrq(level: boolean): void {
    this.irqLine = level;
  }

  /** The status byte, as `php` and an interrupt push it. */
  get status(): number {
    return (
      (this.carry ? 0x01 : 0) |
      (this.zero ? 0x02 : 0) |
      (this.interrupt ? 0x04 : 0) |
      (this.decimal ? 0x08 : 0) |
      0x20 |
      (this.overflow ? 0x40 : 0) |
      (this.negative ? 0x80 : 0)
    );
  }

  set status(value: number) {
    this.carry = (value & 0x01) !== 0;
    this.zero = (value & 0x02) !== 0;
    this.interrupt = (value & 0x04) !== 0;
    this.decimal = (value & 0x08) !== 0;
    this.overflow = (value & 0x40) !== 0;
    this.negative = (value & 0x80) !== 0;
  }

  private fetch(): number {
    const value = this.bus.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return value;
  }

  private fetchWord(): number {
    const low = this.fetch();
    return low | (this.fetch() << 8);
  }

  private push(value: number): void {
    this.bus.write(0x0100 + this.sp, value & 0xff);
    this.sp = (this.sp - 1) & 0xff;
  }

  private pull(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.bus.read(0x0100 + this.sp);
  }

  /** Read a word from zero page, wrapping inside it — as the hardware does. */
  private zeroPageWord(address: number): number {
    return this.bus.read(address & 0xff) | (this.bus.read((address + 1) & 0xff) << 8);
  }

  /** The effective address of an operand, charging the page-cross penalty. */
  private address(mode: Mode): number {
    switch (mode) {
      case "zp":
        return this.fetch();
      case "zpX":
        return (this.fetch() + this.x) & 0xff;
      case "zpY":
        return (this.fetch() + this.y) & 0xff;
      case "abs":
        return this.fetchWord();
      case "absX": {
        const base = this.fetchWord();
        const at = (base + this.x) & 0xffff;
        if ((base & 0xff00) !== (at & 0xff00)) this.extra += 1;
        return at;
      }
      case "absY": {
        const base = this.fetchWord();
        const at = (base + this.y) & 0xffff;
        if ((base & 0xff00) !== (at & 0xff00)) this.extra += 1;
        return at;
      }
      case "indX":
        return this.zeroPageWord((this.fetch() + this.x) & 0xff);
      case "indY": {
        const base = this.zeroPageWord(this.fetch());
        const at = (base + this.y) & 0xffff;
        if ((base & 0xff00) !== (at & 0xff00)) this.extra += 1;
        return at;
      }
      case "ind": {
        // The hardware's own bug: an indirect jump through `$xxFF` takes its
        // high byte from `$xx00`, not from the next page. Reproduced because a
        // core that quietly fixed it would disagree with every other one.
        const pointer = this.fetchWord();
        const low = this.bus.read(pointer);
        const high = this.bus.read((pointer & 0xff00) | ((pointer + 1) & 0xff));
        return low | (high << 8);
      }
      default:
        throw new Error(`nes: ${mode} has no effective address`);
    }
  }

  private setNZ(value: number): number {
    const byte = value & 0xff;
    this.zero = byte === 0;
    this.negative = (byte & 0x80) !== 0;
    return byte;
  }

  private compare(register: number, value: number): void {
    const result = (register - value) & 0x1ff;
    this.carry = register >= value;
    this.zero = (result & 0xff) === 0;
    this.negative = (result & 0x80) !== 0;
  }

  private branch(taken: boolean): void {
    const offset = this.fetch();
    if (!taken) return;
    const target = (this.pc + (offset > 127 ? offset - 256 : offset)) & 0xffff;
    this.extra += (this.pc & 0xff00) !== (target & 0xff00) ? 2 : 1;
    this.pc = target;
  }

  /** Enter an interrupt through `vector`, pushing the return state. */
  private interruptTo(vector: number, brk: boolean): void {
    this.push(this.pc >> 8);
    this.push(this.pc & 0xff);
    this.push(this.status | (brk ? 0x10 : 0));
    this.interrupt = true;
    this.pc = this.bus.read(vector) | (this.bus.read(vector + 1) << 8);
  }

  /**
   * Run one instruction, or dispatch a pending interrupt.
   *
   * Returns the cycles it took, which is what the machine clocks its PPU and its
   * APU with.
   */
  step(): number {
    if (this.nmiPending) {
      this.nmiPending = false;
      this.interruptTo(VECTOR.nmi, false);
      return 7;
    }
    if (this.irqLine && !this.interrupt) {
      this.interruptTo(VECTOR.irq, false);
      return 7;
    }

    this.extra = 0;
    const at = this.pc;
    const opcode = this.fetch();
    const decoded = DECODE[opcode];
    if (decoded === undefined) {
      throw new Error(
        `nes: illegal opcode $${opcode.toString(16)} at $${at.toString(16)} — the code generator emitted something the CPU has no instruction for`,
      );
    }
    const { name, mode } = decoded;

    /** The operand's value, for the modes that have one. */
    const operand = (): number =>
      mode === "imm" ? this.fetch() : this.bus.read(this.address(mode));

    switch (name) {
      case "lda":
        this.a = this.setNZ(operand());
        break;
      case "ldx":
        this.x = this.setNZ(operand());
        break;
      case "ldy":
        this.y = this.setNZ(operand());
        break;
      case "sta":
        this.bus.write(this.address(mode), this.a);
        break;
      case "stx":
        this.bus.write(this.address(mode), this.x);
        break;
      case "sty":
        this.bus.write(this.address(mode), this.y);
        break;
      case "and":
        this.a = this.setNZ(this.a & operand());
        break;
      case "ora":
        this.a = this.setNZ(this.a | operand());
        break;
      case "eor":
        this.a = this.setNZ(this.a ^ operand());
        break;
      case "adc": {
        const value = operand();
        const sum = this.a + value + (this.carry ? 1 : 0);
        this.carry = sum > 0xff;
        this.overflow = ((this.a ^ sum) & (value ^ sum) & 0x80) !== 0;
        this.a = this.setNZ(sum);
        break;
      }
      case "sbc": {
        const value = operand();
        const diff = this.a - value - (this.carry ? 0 : 1);
        this.carry = diff >= 0;
        this.overflow = ((this.a ^ value) & (this.a ^ diff) & 0x80) !== 0;
        this.a = this.setNZ(diff);
        break;
      }
      case "cmp":
        this.compare(this.a, operand());
        break;
      case "cpx":
        this.compare(this.x, operand());
        break;
      case "cpy":
        this.compare(this.y, operand());
        break;
      case "bit": {
        const value = operand();
        this.zero = (this.a & value) === 0;
        this.overflow = (value & 0x40) !== 0;
        this.negative = (value & 0x80) !== 0;
        break;
      }
      case "asl":
      case "lsr":
      case "rol":
      case "ror": {
        const shift = (value: number): number => {
          const carryIn = this.carry ? 1 : 0;
          let out: number;
          if (name === "asl") {
            this.carry = (value & 0x80) !== 0;
            out = value << 1;
          } else if (name === "lsr") {
            this.carry = (value & 0x01) !== 0;
            out = value >> 1;
          } else if (name === "rol") {
            this.carry = (value & 0x80) !== 0;
            out = (value << 1) | carryIn;
          } else {
            this.carry = (value & 0x01) !== 0;
            out = (value >> 1) | (carryIn << 7);
          }
          return this.setNZ(out);
        };
        if (mode === "acc") {
          this.a = shift(this.a);
          break;
        }
        const target = this.address(mode);
        this.bus.write(target, shift(this.bus.read(target)));
        break;
      }
      case "inc":
      case "dec": {
        const target = this.address(mode);
        const value = this.bus.read(target) + (name === "inc" ? 1 : -1);
        this.bus.write(target, this.setNZ(value));
        break;
      }
      case "inx":
        this.x = this.setNZ(this.x + 1);
        break;
      case "dex":
        this.x = this.setNZ(this.x - 1);
        break;
      case "iny":
        this.y = this.setNZ(this.y + 1);
        break;
      case "dey":
        this.y = this.setNZ(this.y - 1);
        break;
      case "tax":
        this.x = this.setNZ(this.a);
        break;
      case "txa":
        this.a = this.setNZ(this.x);
        break;
      case "tay":
        this.y = this.setNZ(this.a);
        break;
      case "tya":
        this.a = this.setNZ(this.y);
        break;
      case "tsx":
        this.x = this.setNZ(this.sp);
        break;
      case "txs":
        // The only transfer that sets no flags, which is why it is not in the
        // group above.
        this.sp = this.x;
        break;
      case "pha":
        this.push(this.a);
        break;
      case "php":
        this.push(this.status | 0x10);
        break;
      case "pla":
        this.a = this.setNZ(this.pull());
        break;
      case "plp":
        this.status = this.pull();
        break;
      case "clc":
        this.carry = false;
        break;
      case "sec":
        this.carry = true;
        break;
      case "cli":
        this.interrupt = false;
        break;
      case "sei":
        this.interrupt = true;
        break;
      case "clv":
        this.overflow = false;
        break;
      case "cld":
        this.decimal = false;
        break;
      case "sed":
        this.decimal = true;
        break;
      case "jmp":
        this.pc = this.address(mode);
        break;
      case "jsr": {
        const target = this.fetchWord();
        const back = (this.pc - 1) & 0xffff;
        this.push(back >> 8);
        this.push(back & 0xff);
        this.pc = target;
        break;
      }
      case "rts": {
        const low = this.pull();
        this.pc = ((low | (this.pull() << 8)) + 1) & 0xffff;
        break;
      }
      case "rti": {
        this.status = this.pull();
        const low = this.pull();
        this.pc = low | (this.pull() << 8);
        break;
      }
      case "brk":
        this.pc = (this.pc + 1) & 0xffff;
        this.interruptTo(VECTOR.irq, true);
        break;
      case "bpl":
        this.branch(!this.negative);
        break;
      case "bmi":
        this.branch(this.negative);
        break;
      case "bvc":
        this.branch(!this.overflow);
        break;
      case "bvs":
        this.branch(this.overflow);
        break;
      case "bcc":
        this.branch(!this.carry);
        break;
      case "bcs":
        this.branch(this.carry);
        break;
      case "bne":
        this.branch(!this.zero);
        break;
      case "beq":
        this.branch(this.zero);
        break;
      case "nop":
        break;
      default:
        throw new Error(`nes: ${name} is decoded but not implemented`);
    }
    // A store or a read-modify-write never pays the page-cross penalty even
    // though its address computation crossed one: the extra cycle is the
    // discarded *read*, and those instructions have a fixed longer count that
    // already covers it. A taken branch's extra is not this penalty and stays.
    const indexed = mode === "absX" || mode === "absY" || mode === "indY";
    if (indexed && !PENALISED.has(name)) this.extra = 0;
    return decoded.cycles + this.extra;
  }
}
