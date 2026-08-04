/**
 * The HuC6280 processor, as the PC Engine has it.
 *
 * Written out rather than pulled in, for the reason `@demake/nes`'s 6502 is
 * (doc 02): this core decides what "the ROM works" means, it runs in the browser
 * under doc 07's no-CDN rule, and it is the harness the Demotic runtime's PC
 * Engine conformance test drives. Its tables are written independently of
 * `core`'s assembler even though the two describe the same instruction set —
 * deriving the decoder from the encoder would guarantee agreement, and that is
 * exactly the problem: a wrong entry would then be invisible to a test that
 * assembles a program and runs it.
 *
 * It is *not* a copy of the NES's 6502 with rows added, and the three reasons are
 * the three ways this CPU is a different machine:
 *
 *   - **Zero page is at `$2000` and the stack at `$2100`.** The CPU adds `$2000`
 *     to every zero-page operand, so `lda $40` reads `$2040` and `($40),y`
 *     dereferences the pointer at `$2040`/`$2041`. Nothing in the address space
 *     moves that; it is the instruction's own arithmetic, which is why it is
 *     here and not in the bus.
 *   - **A logical address is not a physical one.** Eight `MPR` registers map the
 *     eight 8 KiB pages of the visible 64 KiB onto a 2 MiB space, and the CPU
 *     performs the translation — so this class owns the `MPR` file and the bus
 *     below it takes a *physical* address. Reset leaves `MPR7` holding bank zero
 *     and says nothing about the rest, which is why a program's first
 *     instructions are `tam`s.
 *   - **A block transfer is one instruction.** `tia` and its four siblings move
 *     up to 65535 bytes and destroy `A`, `X` and `Y` on the way. They are
 *     modelled as the loop they are, charged the hardware's 17 + 6n cycles, and
 *     they are how anything reaches video RAM here.
 *
 * Scope: every documented instruction, binary arithmetic only. Decimal mode is
 * not implemented on this CPU, so `sed` sets a flag that changes nothing. The `T`
 * flag is stored and is never set, because nothing the code generator emits uses
 * `set`, and a memory-operand ALU mode nobody exercises would be a wrong answer
 * waiting to be believed. Illegal opcodes throw rather than being tolerated: one
 * can only appear if the code generator emitted it, and a silent `nop` would turn
 * that into a hang three layers away.
 *
 * Source: Archaic Pixels — HuC6280 instruction set and CPU addressing modes.
 */

/** Everything the processor can reach, addressed physically. */
export interface Bus {
  read(address: number): number;
  write(address: number, value: number): void;
}

/** Where the CPU takes its five vectors from, as logical addresses. */
export const VECTOR = {
  irq2: 0xfff6,
  irq1: 0xfff8,
  timer: 0xfffa,
  nmi: 0xfffc,
  reset: 0xfffe,
} as const;

/** The logical base of the zero page — which is not page zero on this CPU. */
export const ZERO_PAGE = 0x2000;

/** The logical base of the stack, one page above it. */
export const STACK = 0x2100;

/**
 * Physical base of bank `$FF`, where every peripheral answers.
 *
 * Named here because `st0`–`st2` reach the video chip without going through the
 * mapper at all: they are wired to it, so a program can write a VDC register
 * with `MPR0` pointing anywhere. Everything else on this page is reached the
 * ordinary way, through whichever page a `tam` mapped it into.
 */
export const HARDWARE_PAGE = 0xff << 13;

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
  | "indZp"
  | "rel"
  /** `#imm` then an address: `tst` alone. */
  | "immZp"
  | "immAbs"
  | "immZpX"
  | "immAbsX"
  /** A zero-page byte then a branch offset: `bbr`/`bbs`. */
  | "zpRel"
  /** Three little-endian words: the block transfers. */
  | "block";

/** One decoded instruction. */
interface Decoded {
  readonly name: string;
  readonly mode: Mode;
  readonly cycles: number;
  /** For the bit instructions, which bit; for `st0`–`st2`, which port. */
  readonly arg?: number;
}

/** Build the decode table from a compact listing of the documented opcodes. */
function decodeTable(): readonly (Decoded | undefined)[] {
  const table: (Decoded | undefined)[] = new Array(256).fill(undefined);
  const add = (opcode: number, name: string, mode: Mode, cycles: number, arg?: number): void => {
    table[opcode] = arg === undefined ? { name, mode, cycles } : { name, mode, cycles, arg };
  };

  // The eight ALU columns, and the ninth this chip adds: `(zp)`, unindexed.
  const group = (
    name: string,
    [immOp, zpOp, zpXOp, absOp, absXOp, absYOp, indXOp, indYOp, indZpOp]: readonly number[],
  ): void => {
    add(immOp as number, name, "imm", 2);
    add(zpOp as number, name, "zp", 4);
    add(zpXOp as number, name, "zpX", 4);
    add(absOp as number, name, "abs", 5);
    add(absXOp as number, name, "absX", 5);
    add(absYOp as number, name, "absY", 5);
    add(indXOp as number, name, "indX", 7);
    add(indYOp as number, name, "indY", 7);
    add(indZpOp as number, name, "indZp", 7);
  };
  group("ora", [0x09, 0x05, 0x15, 0x0d, 0x1d, 0x19, 0x01, 0x11, 0x12]);
  group("and", [0x29, 0x25, 0x35, 0x2d, 0x3d, 0x39, 0x21, 0x31, 0x32]);
  group("eor", [0x49, 0x45, 0x55, 0x4d, 0x5d, 0x59, 0x41, 0x51, 0x52]);
  group("adc", [0x69, 0x65, 0x75, 0x6d, 0x7d, 0x79, 0x61, 0x71, 0x72]);
  group("lda", [0xa9, 0xa5, 0xb5, 0xad, 0xbd, 0xb9, 0xa1, 0xb1, 0xb2]);
  group("cmp", [0xc9, 0xc5, 0xd5, 0xcd, 0xdd, 0xd9, 0xc1, 0xd1, 0xd2]);
  group("sbc", [0xe9, 0xe5, 0xf5, 0xed, 0xfd, 0xf9, 0xe1, 0xf1, 0xf2]);

  // `sta` has no immediate form.
  add(0x85, "sta", "zp", 4);
  add(0x95, "sta", "zpX", 4);
  add(0x8d, "sta", "abs", 5);
  add(0x9d, "sta", "absX", 5);
  add(0x99, "sta", "absY", 5);
  add(0x81, "sta", "indX", 7);
  add(0x91, "sta", "indY", 7);
  add(0x92, "sta", "indZp", 7);

  add(0xa2, "ldx", "imm", 2);
  add(0xa6, "ldx", "zp", 4);
  add(0xb6, "ldx", "zpY", 4);
  add(0xae, "ldx", "abs", 5);
  add(0xbe, "ldx", "absY", 5);
  add(0xa0, "ldy", "imm", 2);
  add(0xa4, "ldy", "zp", 4);
  add(0xb4, "ldy", "zpX", 4);
  add(0xac, "ldy", "abs", 5);
  add(0xbc, "ldy", "absX", 5);
  add(0x86, "stx", "zp", 4);
  add(0x96, "stx", "zpY", 4);
  add(0x8e, "stx", "abs", 5);
  add(0x84, "sty", "zp", 4);
  add(0x94, "sty", "zpX", 4);
  add(0x8c, "sty", "abs", 5);
  // `stz`, which is `sty` with a zero the program did not have to load.
  add(0x64, "stz", "zp", 4);
  add(0x74, "stz", "zpX", 4);
  add(0x9c, "stz", "abs", 5);
  add(0x9e, "stz", "absX", 5);

  add(0xe0, "cpx", "imm", 2);
  add(0xe4, "cpx", "zp", 4);
  add(0xec, "cpx", "abs", 5);
  add(0xc0, "cpy", "imm", 2);
  add(0xc4, "cpy", "zp", 4);
  add(0xcc, "cpy", "abs", 5);
  add(0x89, "bit", "imm", 2);
  add(0x24, "bit", "zp", 4);
  add(0x34, "bit", "zpX", 4);
  add(0x2c, "bit", "abs", 5);
  add(0x3c, "bit", "absX", 5);
  add(0x04, "tsb", "zp", 6);
  add(0x0c, "tsb", "abs", 7);
  add(0x14, "trb", "zp", 6);
  add(0x1c, "trb", "abs", 7);

  for (const [name, ops] of [
    ["asl", [0x0a, 0x06, 0x16, 0x0e, 0x1e]],
    ["rol", [0x2a, 0x26, 0x36, 0x2e, 0x3e]],
    ["lsr", [0x4a, 0x46, 0x56, 0x4e, 0x5e]],
    ["ror", [0x6a, 0x66, 0x76, 0x6e, 0x7e]],
  ] as const) {
    add(ops[0], name, "acc", 2);
    add(ops[1], name, "zp", 6);
    add(ops[2], name, "zpX", 6);
    add(ops[3], name, "abs", 7);
    add(ops[4], name, "absX", 7);
  }
  add(0xe6, "inc", "zp", 6);
  add(0xf6, "inc", "zpX", 6);
  add(0xee, "inc", "abs", 7);
  add(0xfe, "inc", "absX", 7);
  add(0x1a, "inc", "acc", 2);
  add(0xc6, "dec", "zp", 6);
  add(0xd6, "dec", "zpX", 6);
  add(0xce, "dec", "abs", 7);
  add(0xde, "dec", "absX", 7);
  add(0x3a, "dec", "acc", 2);

  add(0x4c, "jmp", "abs", 4);
  add(0x6c, "jmp", "ind", 7);
  // The indexed indirect jump takes an absolute operand and is told apart by its
  // name, because the index is applied to the *pointer* rather than to the target.
  add(0x7c, "jmpIndX", "abs", 7);
  add(0x20, "jsr", "abs", 7);
  add(0x44, "bsr", "rel", 8);
  add(0x60, "rts", "imp", 7);
  add(0x40, "rti", "imp", 7);
  add(0x00, "brk", "imp", 8);

  for (const [opcode, name] of [
    [0x10, "bpl"],
    [0x30, "bmi"],
    [0x50, "bvc"],
    [0x70, "bvs"],
    [0x90, "bcc"],
    [0xb0, "bcs"],
    [0xd0, "bne"],
    [0xf0, "beq"],
    [0x80, "bra"],
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
    [0xda, "phx", 3],
    [0x5a, "phy", 3],
    [0xfa, "plx", 4],
    [0x7a, "ply", 4],
    // The HuC6280's own: register swaps, register clears and the clock.
    [0x02, "sxy", 3],
    [0x22, "sax", 3],
    [0x42, "say", 3],
    [0x62, "cla", 2],
    [0x82, "clx", 2],
    [0xc2, "cly", 2],
    [0x54, "csl", 3],
    [0xd4, "csh", 3],
    [0xf4, "set", 2],
  ] as const) {
    add(opcode, name, "imp", cycles);
  }

  // The mapper and the video chip's shortcut, all immediate-operand.
  add(0x53, "tam", "imm", 5);
  add(0x43, "tma", "imm", 4);
  add(0x03, "st", "imm", 5, 0);
  add(0x13, "st", "imm", 5, 2);
  add(0x23, "st", "imm", 5, 3);

  // `tst #mask, <address>`.
  add(0x83, "tst", "immZp", 7);
  add(0x93, "tst", "immAbs", 8);
  add(0xa3, "tst", "immZpX", 7);
  add(0xb3, "tst", "immAbsX", 8);

  // The Rockwell bit instructions, eight of each.
  for (let bit = 0; bit < 8; bit += 1) {
    add(0x07 | (bit << 4), "rmb", "zp", 7, bit);
    add(0x87 | (bit << 4), "smb", "zp", 7, bit);
    add(0x0f | (bit << 4), "bbr", "zpRel", 6, bit);
    add(0x8f | (bit << 4), "bbs", "zpRel", 6, bit);
  }

  // The block transfers. The base cost is 17 cycles; the per-byte six is charged
  // by the handler, which is the only place the length is known.
  add(0x73, "tii", "block", 17);
  add(0xc3, "tdd", "block", 17);
  add(0xd3, "tin", "block", 17);
  add(0xe3, "tia", "block", 17);
  add(0xf3, "tai", "block", 17);

  return table;
}

const DECODE = decodeTable();

/** The HuC6280 register file, memory mapper and instruction decoder. */
export class Cpu {
  a = 0;
  x = 0;
  y = 0;
  /** Stack pointer: the stack lives at `$2100 + sp`. */
  sp = 0xfd;
  pc = 0;

  carry = false;
  zero = false;
  /** Interrupt *disable*, as the hardware names it. */
  interrupt = true;
  decimal = false;
  /** The `T` flag, which `set` arms and nothing here emits. */
  memoryMode = false;
  overflow = false;
  negative = false;

  /**
   * The mapper: eight banks, one per 8 KiB page of the visible address space.
   *
   * Reset defines only `MPR7`, which holds bank zero so that the vectors and the
   * first instructions are reachable. The rest are whatever they were, which on
   * a real console is whatever the last game left; zero here, because a
   * deterministic core must answer *something* and a program that reads an
   * unmapped page has a bug either way.
   */
  readonly mpr = new Uint8Array(8);

  /** Whether the CPU is running at 7.16 MHz rather than 1.79. */
  fast = false;

  /** Latched until taken: NMI is edge-triggered. */
  private nmiPending = false;
  /** Level-sensitive per source, so a device holds its line until acknowledged. */
  private irqLines = { irq1: false, irq2: false, timer: false };
  /** Which of the three the interrupt controller is masking (`$1403`). */
  irqMask = 0;
  /** Extra cycles this instruction earned — a page cross, or a taken branch. */
  private extra = 0;

  constructor(private readonly bus: Bus) {}

  /** Translate a logical address to the physical one the bus answers. */
  physical(address: number): number {
    const at = address & 0xffff;
    return ((this.mpr[at >> 13] as number) << 13) | (at & 0x1fff);
  }

  /** Read one byte through the mapper. */
  read(address: number): number {
    return this.bus.read(this.physical(address));
  }

  /** Write one byte through the mapper. */
  write(address: number, value: number): void {
    this.bus.write(this.physical(address), value & 0xff);
  }

  /** Take the reset vector, as the CPU does on power-up. */
  reset(): void {
    this.mpr.fill(0);
    this.mpr[7] = 0;
    this.pc = this.read(VECTOR.reset) | (this.read(VECTOR.reset + 1) << 8);
    this.sp = 0xfd;
    this.interrupt = true;
    this.decimal = false;
    this.fast = false;
  }

  /** Raise the non-maskable interrupt. Nothing in this console does. */
  nmi(): void {
    this.nmiPending = true;
  }

  /** Hold or release one of the three maskable lines. */
  setIrq(source: "irq1" | "irq2" | "timer", level: boolean): void {
    this.irqLines[source] = level;
  }

  /** The status byte, as `php` and an interrupt push it. */
  get status(): number {
    return (
      (this.carry ? 0x01 : 0) |
      (this.zero ? 0x02 : 0) |
      (this.interrupt ? 0x04 : 0) |
      (this.decimal ? 0x08 : 0) |
      (this.memoryMode ? 0x20 : 0) |
      (this.overflow ? 0x40 : 0) |
      (this.negative ? 0x80 : 0)
    );
  }

  set status(value: number) {
    this.carry = (value & 0x01) !== 0;
    this.zero = (value & 0x02) !== 0;
    this.interrupt = (value & 0x04) !== 0;
    this.decimal = (value & 0x08) !== 0;
    this.memoryMode = (value & 0x20) !== 0;
    this.overflow = (value & 0x40) !== 0;
    this.negative = (value & 0x80) !== 0;
  }

  private fetch(): number {
    const value = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return value;
  }

  private fetchWord(): number {
    const low = this.fetch();
    return low | (this.fetch() << 8);
  }

  private push(value: number): void {
    this.write(STACK + this.sp, value & 0xff);
    this.sp = (this.sp - 1) & 0xff;
  }

  private pull(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.read(STACK + this.sp);
  }

  /** Read a word from the zero page, wrapping inside it — as the hardware does. */
  private zeroPageWord(offset: number): number {
    return (
      this.read(ZERO_PAGE + (offset & 0xff)) | (this.read(ZERO_PAGE + ((offset + 1) & 0xff)) << 8)
    );
  }

  /** The effective address of an operand, charging the page-cross penalty. */
  private address(mode: Mode): number {
    switch (mode) {
      case "zp":
      case "immZp":
        return ZERO_PAGE + this.fetch();
      case "zpX":
      case "immZpX":
        return ZERO_PAGE + ((this.fetch() + this.x) & 0xff);
      case "zpY":
        return ZERO_PAGE + ((this.fetch() + this.y) & 0xff);
      case "abs":
      case "immAbs":
        return this.fetchWord();
      case "absX":
      case "immAbsX": {
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
      case "indZp":
        return this.zeroPageWord(this.fetch());
      case "ind": {
        // No page-wrap bug here: the 65C02 line fixed the 6502's, so an indirect
        // jump through `$xxFF` reads its high byte from the next page. A core
        // that reproduced the older behaviour would disagree with the hardware.
        const pointer = this.fetchWord();
        return this.read(pointer) | (this.read((pointer + 1) & 0xffff) << 8);
      }
      default:
        throw new Error(`pce: ${mode} has no effective address`);
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
    this.pc = (this.pc + (offset > 127 ? offset - 256 : offset)) & 0xffff;
    this.extra += 2;
  }

  /** Enter an interrupt through `vector`, pushing the return state. */
  private interruptTo(vector: number, brk: boolean): void {
    this.push(this.pc >> 8);
    this.push(this.pc & 0xff);
    // `B` is bit 4 and the `T` flag is cleared on entry, which is what stops an
    // interrupt inheriting a memory-mode instruction's arming.
    this.push((this.status & ~0x20) | (brk ? 0x10 : 0));
    this.interrupt = true;
    this.memoryMode = false;
    this.decimal = false;
    this.pc = this.read(vector) | (this.read(vector + 1) << 8);
  }

  /** The highest-priority interrupt waiting, or `undefined`. */
  private pendingIrq(): number | undefined {
    // `$1403` masks by bit: 1 = IRQ2, 2 = IRQ1, 4 = timer, and the priority runs
    // the same way — IRQ2 is the highest and the timer the lowest.
    if (this.irqLines.irq2 && (this.irqMask & 0x01) === 0) return VECTOR.irq2;
    if (this.irqLines.irq1 && (this.irqMask & 0x02) === 0) return VECTOR.irq1;
    if (this.irqLines.timer && (this.irqMask & 0x04) === 0) return VECTOR.timer;
    return undefined;
  }

  /**
   * Run one instruction, or dispatch a pending interrupt.
   *
   * Returns the cycles it took, in CPU clocks — which the machine multiplies by
   * three or by twelve depending on `csh`/`csl` before it clocks the video chip.
   */
  step(): number {
    if (this.nmiPending) {
      this.nmiPending = false;
      this.interruptTo(VECTOR.nmi, false);
      return 8;
    }
    if (!this.interrupt) {
      const vector = this.pendingIrq();
      if (vector !== undefined) {
        this.interruptTo(vector, false);
        return 8;
      }
    }

    this.extra = 0;
    const at = this.pc;
    const opcode = this.fetch();
    const decoded = DECODE[opcode];
    if (decoded === undefined) {
      throw new Error(
        `pce: illegal opcode $${opcode.toString(16)} at $${at.toString(16)} — the code generator emitted something the CPU has no instruction for`,
      );
    }
    const { name, mode } = decoded;

    /** The operand's value, for the modes that have one. */
    const operand = (): number => (mode === "imm" ? this.fetch() : this.read(this.address(mode)));

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
        this.write(this.address(mode), this.a);
        break;
      case "stx":
        this.write(this.address(mode), this.x);
        break;
      case "sty":
        this.write(this.address(mode), this.y);
        break;
      case "stz":
        this.write(this.address(mode), 0);
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
        // An immediate `bit` sets `Z` alone — there is no memory byte whose top
        // two bits could reach the flags.
        if (mode !== "imm") {
          this.overflow = (value & 0x40) !== 0;
          this.negative = (value & 0x80) !== 0;
        }
        break;
      }
      case "tsb":
      case "trb": {
        const target = this.address(mode);
        const value = this.read(target);
        this.zero = (this.a & value) === 0;
        this.overflow = (value & 0x40) !== 0;
        this.negative = (value & 0x80) !== 0;
        this.write(target, name === "tsb" ? value | this.a : value & ~this.a);
        break;
      }
      case "tst": {
        const mask = this.fetch();
        const value = this.read(this.address(mode));
        this.zero = (mask & value) === 0;
        this.overflow = (value & 0x40) !== 0;
        this.negative = (value & 0x80) !== 0;
        break;
      }
      case "rmb":
      case "smb": {
        const target = ZERO_PAGE + this.fetch();
        const bit = 1 << (decoded.arg as number);
        const value = this.read(target);
        this.write(target, name === "smb" ? value | bit : value & ~bit);
        break;
      }
      case "bbr":
      case "bbs": {
        const value = this.read(ZERO_PAGE + this.fetch());
        const set = (value & (1 << (decoded.arg as number))) !== 0;
        this.branch(name === "bbs" ? set : !set);
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
        this.write(target, shift(this.read(target)));
        break;
      }
      case "inc":
      case "dec": {
        const delta = name === "inc" ? 1 : -1;
        if (mode === "acc") {
          this.a = this.setNZ(this.a + delta);
          break;
        }
        const target = this.address(mode);
        this.write(target, this.setNZ(this.read(target) + delta));
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
        this.sp = this.x;
        break;
      // The register swaps set the flags from what lands in the accumulator, and
      // `sxy` sets none at all because the accumulator is not involved.
      case "sax": {
        const held = this.a;
        this.a = this.x;
        this.x = held;
        break;
      }
      case "say": {
        const held = this.a;
        this.a = this.y;
        this.y = held;
        break;
      }
      case "sxy": {
        const held = this.x;
        this.x = this.y;
        this.y = held;
        break;
      }
      case "cla":
        this.a = 0;
        break;
      case "clx":
        this.x = 0;
        break;
      case "cly":
        this.y = 0;
        break;
      case "pha":
        this.push(this.a);
        break;
      case "phx":
        this.push(this.x);
        break;
      case "phy":
        this.push(this.y);
        break;
      case "php":
        this.push(this.status | 0x10);
        break;
      case "pla":
        this.a = this.setNZ(this.pull());
        break;
      case "plx":
        this.x = this.setNZ(this.pull());
        break;
      case "ply":
        this.y = this.setNZ(this.pull());
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
      case "set":
        this.memoryMode = true;
        break;
      case "csl":
        this.fast = false;
        break;
      case "csh":
        this.fast = true;
        break;
      case "tam": {
        // A bit per register, so one instruction can map several pages at once.
        const mask = this.fetch();
        for (let page = 0; page < 8; page += 1) {
          if ((mask & (1 << page)) !== 0) this.mpr[page] = this.a;
        }
        break;
      }
      case "tma": {
        const mask = this.fetch();
        for (let page = 0; page < 8; page += 1) {
          if ((mask & (1 << page)) !== 0) {
            this.a = this.mpr[page] as number;
            break;
          }
        }
        break;
      }
      case "st":
        // The video chip's three ports, written with an immediate and without
        // disturbing the accumulator. They reach the VDC *directly* rather than
        // through the address bus, so no `MPR` has to be pointing at the
        // hardware page for one to work — which is why this is a physical write
        // and not a `this.write`.
        this.bus.write(HARDWARE_PAGE | (decoded.arg as number), this.fetch());
        break;
      case "jmp":
        this.pc = this.address(mode);
        break;
      case "jmpIndX": {
        const pointer = (this.fetchWord() + this.x) & 0xffff;
        this.pc = this.read(pointer) | (this.read((pointer + 1) & 0xffff) << 8);
        break;
      }
      case "jsr": {
        const target = this.fetchWord();
        const back = (this.pc - 1) & 0xffff;
        this.push(back >> 8);
        this.push(back & 0xff);
        this.pc = target;
        break;
      }
      case "bsr": {
        const offset = this.fetch();
        const back = (this.pc - 1) & 0xffff;
        this.push(back >> 8);
        this.push(back & 0xff);
        this.pc = (this.pc + (offset > 127 ? offset - 256 : offset)) & 0xffff;
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
        this.interruptTo(VECTOR.irq2, true);
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
      case "bra":
        this.branch(true);
        break;
      case "tii":
      case "tdd":
      case "tin":
      case "tia":
      case "tai":
        this.blockMove(name);
        break;
      case "nop":
        break;
      default:
        throw new Error(`pce: ${name} is decoded but not implemented`);
    }
    return decoded.cycles + this.extra;
  }

  /**
   * One of the five block transfers.
   *
   * The alternating destination of `tai` (and source of `tia`) is what makes
   * these more than a memcpy: `tia src, $0002, n` streams a run into the video
   * chip's two data ports, low byte then high byte, which is how a tile bank
   * reaches VRAM in one instruction. Six cycles a byte is charged through
   * {@link extra}, and `A`, `X` and `Y` really are destroyed — the hardware uses
   * them as the loop's own state, and a caller that expected otherwise loses a
   * value rather than crashing.
   */
  private blockMove(kind: "tii" | "tdd" | "tin" | "tia" | "tai"): void {
    let source = this.fetchWord();
    let dest = this.fetchWord();
    const length = this.fetchWord();
    const count = length === 0 ? 0x10000 : length;
    // Which end alternates between the two bytes of a fixed pair.
    let alternate = 0;
    for (let index = 0; index < count; index += 1) {
      const from = kind === "tia" ? source : kind === "tai" ? source + alternate : source;
      const to = kind === "tia" ? dest + alternate : dest;
      this.write(to & 0xffff, this.read(from & 0xffff));
      switch (kind) {
        case "tii":
          source += 1;
          dest += 1;
          break;
        case "tdd":
          source -= 1;
          dest -= 1;
          break;
        case "tin":
          dest += 1;
          break;
        case "tia":
          source += 1;
          alternate ^= 1;
          break;
        case "tai":
          dest += 1;
          alternate ^= 1;
          break;
      }
    }
    this.extra += 6 * count;
    this.a = 0;
    this.x = 0;
    this.y = 0;
  }
}
