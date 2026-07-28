/**
 * The Zilog Z80 processor.
 *
 * Written out rather than pulled in, for the reasons `@demake/dmg`'s SM83 and
 * `@demake/nes`'s 6502 are (doc 02): this core decides what "the ROM works"
 * means, it runs in the browser under doc 07's no-CDN rule, and it is the
 * harness the Demotic runtime's conformance test drives. A dependency we cannot
 * read is a dependency we cannot trust with any of those jobs.
 *
 * Unlike the other two, this one is not scoped down to what the backend emits.
 * The Z80 is the one processor in the set that is *also* a general-purpose part
 * — the same silicon runs the Master System, the Game Gear and the SG-1000, and
 * later the audio driver — so the whole documented instruction set is here,
 * prefixes included, and the undocumented flag bits with it. What is deliberately
 * absent is anything below instruction granularity: no memory contention, no
 * per-M-cycle bus model. The VDP is clocked from whole instructions, which is
 * what the runtime's discipline (do the video work in the blanking window) is
 * written against.
 *
 * Three details in here are load-bearing and easy to get subtly wrong:
 *
 *   - **`P/V` is two flags wearing one bit.** Arithmetic sets it to signed
 *     overflow; logic and `in r,(c)` set it to parity; the block instructions set
 *     it to "`bc` is not yet zero". A comparison compiled to `jp pe` reads the
 *     first of those, so the three cases cannot share an implementation.
 *   - **An index prefix means different things in one instruction than in
 *     another.** `dd 66` is `ld h,(ix+d)` — a *real* `h` — while `dd 6c` is
 *     `ld l,ixh`. The rule is that the register halves are substituted only when
 *     no `(ix+d)` operand is present, and it is implemented once, in
 *     {@link Z80.reg8}, rather than case by case.
 *   - **`dd cb` puts the displacement before the opcode.** Every other prefix
 *     group has its opcode second. Decoding it in the obvious order runs a valid
 *     instruction on the wrong address.
 *
 * Sources: Zilog — Z80 CPU User Manual (UM0080) and Sean Young's "The
 * Undocumented Z80 Documented" for the `X`/`Y` flag bits and the `dd cb` forms.
 */

/** Everything the processor can reach: memory, and the separate port space. */
export interface Bus {
  read(address: number): number;
  write(address: number, value: number): void;
  /** Read a port. The Z80 puts the whole of `bc` on the address bus. */
  in(port: number): number;
  /** Write a port. */
  out(port: number, value: number): void;
}

/** Flag bits, in the order the manual numbers them. */
export const FLAG = {
  c: 0x01,
  n: 0x02,
  pv: 0x04,
  x: 0x08,
  h: 0x10,
  y: 0x20,
  z: 0x40,
  s: 0x80,
} as const;

/** Where interrupt mode 1 dispatches, and where a non-maskable interrupt does. */
export const VECTOR = { irq: 0x0038, nmi: 0x0066 } as const;

/** `S`, `Z` and the two undocumented copies, for every byte value. */
const SZ53 = new Uint8Array(256);
/** The same, plus the parity bit — what a logical operation sets. */
const SZ53P = new Uint8Array(256);
for (let value = 0; value < 256; value += 1) {
  let bits = 0;
  for (let bit = 0; bit < 8; bit += 1) bits ^= (value >> bit) & 1;
  const parity = bits === 0 ? FLAG.pv : 0;
  const base = (value & (FLAG.s | FLAG.x | FLAG.y)) | (value === 0 ? FLAG.z : 0);
  SZ53[value] = base;
  SZ53P[value] = base | parity;
}

/** Base T-states of each unprefixed opcode. Conditional forms add their taken cost. */
// prettier-ignore
const CYCLES: readonly number[] = [
   4,10, 7, 6, 4, 4, 7, 4, 4,11, 7, 6, 4, 4, 7, 4,
   8,10, 7, 6, 4, 4, 7, 4,12,11, 7, 6, 4, 4, 7, 4,
   7,10,16, 6, 4, 4, 7, 4, 7,11,16, 6, 4, 4, 7, 4,
   7,10,13, 6,11,11,10, 4, 7,11,13, 6, 4, 4, 7, 4,
   4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
   4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
   4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
   7, 7, 7, 7, 7, 7, 4, 7, 4, 4, 4, 4, 4, 4, 7, 4,
   4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
   4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
   4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
   4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
   5,10,10,10,10,11, 7,11, 5,10,10, 0,10,17, 7,11,
   5,10,10,11,10,11, 7,11, 5, 4,10,11,10, 0, 7,11,
   5,10,10,19,10,11, 7,11, 5, 4,10, 4,10, 0, 7,11,
   5,10,10, 4,10,11, 7,11, 5, 6,10, 4,10, 0, 7,11,
];

/** The Z80 register file and instruction decoder. */
export class Z80 {
  a = 0xff;
  f = 0xff;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  h = 0;
  l = 0;
  /** The shadow set, reached through `ex af,af'` and `exx`. */
  a2 = 0xff;
  f2 = 0xff;
  b2 = 0;
  c2 = 0;
  d2 = 0;
  e2 = 0;
  h2 = 0;
  l2 = 0;
  ix = 0xffff;
  iy = 0xffff;
  sp = 0xdff0;
  pc = 0;
  /** The interrupt page, and the refresh counter `ld a,r` reads. */
  i = 0;
  r = 0;
  /** The two interrupt enables; `iff2` is the copy a non-maskable interrupt saves. */
  iff1 = false;
  iff2 = false;
  im: 0 | 1 | 2 = 0;
  halted = false;
  /**
   * Set while an `ei` has been executed but its shadow instruction has not.
   *
   * Interrupts are not accepted between `ei` and the instruction after it, which
   * is what makes the `ei` / `ret` at the end of an interrupt handler safe.
   */
  private eiPending = false;

  constructor(private readonly bus: Bus) {}

  /** Power-on state, which the Z80 defines rather than leaves to the board. */
  reset(): void {
    this.pc = 0;
    this.i = 0;
    this.r = 0;
    this.iff1 = false;
    this.iff2 = false;
    this.im = 0;
    this.halted = false;
    this.eiPending = false;
  }

  // --- register pairs --------------------------------------------------------

  get bc(): number {
    return (this.b << 8) | this.c;
  }
  set bc(value: number) {
    this.b = (value >> 8) & 0xff;
    this.c = value & 0xff;
  }
  get de(): number {
    return (this.d << 8) | this.e;
  }
  set de(value: number) {
    this.d = (value >> 8) & 0xff;
    this.e = value & 0xff;
  }
  get hl(): number {
    return (this.h << 8) | this.l;
  }
  set hl(value: number) {
    this.h = (value >> 8) & 0xff;
    this.l = value & 0xff;
  }
  get af(): number {
    return (this.a << 8) | this.f;
  }
  set af(value: number) {
    this.a = (value >> 8) & 0xff;
    this.f = value & 0xff;
  }

  // --- fetch and stack -------------------------------------------------------

  private fetch(): number {
    const value = this.bus.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return value;
  }

  private fetch16(): number {
    const low = this.fetch();
    return low | (this.fetch() << 8);
  }

  /** The signed displacement byte an `(ix+d)` operand carries. */
  private fetchDisp(): number {
    return (this.fetch() << 24) >> 24;
  }

  private push16(value: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.bus.write(this.sp, (value >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this.bus.write(this.sp, value & 0xff);
  }

  private pop16(): number {
    const low = this.bus.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const high = this.bus.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return low | (high << 8);
  }

  /** Bump the refresh counter, whose top bit the CPU does not touch. */
  private refresh(): void {
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
  }

  // --- flags -----------------------------------------------------------------

  private get carry(): number {
    return this.f & FLAG.c;
  }

  private add8(value: number): void {
    const result = this.a + value;
    const byte = result & 0xff;
    this.f =
      (SZ53[byte] as number) |
      (result > 0xff ? FLAG.c : 0) |
      (((this.a ^ value ^ byte) & FLAG.h) !== 0 ? FLAG.h : 0) |
      (((this.a ^ ~value) & (this.a ^ byte) & 0x80) !== 0 ? FLAG.pv : 0);
    this.a = byte;
  }

  private adc8(value: number): void {
    const carry = this.carry !== 0 ? 1 : 0;
    const result = this.a + value + carry;
    const byte = result & 0xff;
    this.f =
      (SZ53[byte] as number) |
      (result > 0xff ? FLAG.c : 0) |
      (((this.a ^ value ^ byte) & FLAG.h) !== 0 ? FLAG.h : 0) |
      (((this.a ^ ~value) & (this.a ^ byte) & 0x80) !== 0 ? FLAG.pv : 0);
    this.a = byte;
  }

  private sub8(value: number): void {
    const result = this.a - value;
    const byte = result & 0xff;
    this.f =
      (SZ53[byte] as number) |
      FLAG.n |
      (result < 0 ? FLAG.c : 0) |
      (((this.a ^ value ^ byte) & FLAG.h) !== 0 ? FLAG.h : 0) |
      (((this.a ^ value) & (this.a ^ byte) & 0x80) !== 0 ? FLAG.pv : 0);
    this.a = byte;
  }

  private sbc8(value: number): void {
    const carry = this.carry !== 0 ? 1 : 0;
    const result = this.a - value - carry;
    const byte = result & 0xff;
    this.f =
      (SZ53[byte] as number) |
      FLAG.n |
      (result < 0 ? FLAG.c : 0) |
      (((this.a ^ value ^ byte) & FLAG.h) !== 0 ? FLAG.h : 0) |
      (((this.a ^ value) & (this.a ^ byte) & 0x80) !== 0 ? FLAG.pv : 0);
    this.a = byte;
  }

  /**
   * `cp` — a subtract that keeps only the flags.
   *
   * The undocumented `X`/`Y` bits come from the *operand* here, not from the
   * result, which is the one place they are not a copy of the answer.
   */
  private cp8(value: number): void {
    const result = this.a - value;
    const byte = result & 0xff;
    this.f =
      (byte === 0 ? FLAG.z : 0) |
      (byte & FLAG.s) |
      (value & (FLAG.x | FLAG.y)) |
      FLAG.n |
      (result < 0 ? FLAG.c : 0) |
      (((this.a ^ value ^ byte) & FLAG.h) !== 0 ? FLAG.h : 0) |
      (((this.a ^ value) & (this.a ^ byte) & 0x80) !== 0 ? FLAG.pv : 0);
  }

  private and8(value: number): void {
    this.a &= value;
    this.f = (SZ53P[this.a] as number) | FLAG.h;
  }

  private or8(value: number): void {
    this.a |= value;
    this.f = SZ53P[this.a] as number;
  }

  private xor8(value: number): void {
    this.a ^= value;
    this.f = SZ53P[this.a] as number;
  }

  private inc8(value: number): number {
    const byte = (value + 1) & 0xff;
    this.f =
      this.carry |
      (SZ53[byte] as number) |
      ((byte & 0x0f) === 0 ? FLAG.h : 0) |
      (byte === 0x80 ? FLAG.pv : 0);
    return byte;
  }

  private dec8(value: number): number {
    const byte = (value - 1) & 0xff;
    this.f =
      this.carry |
      FLAG.n |
      (SZ53[byte] as number) |
      ((byte & 0x0f) === 0x0f ? FLAG.h : 0) |
      (byte === 0x7f ? FLAG.pv : 0);
    return byte;
  }

  /** `add hl,rr` — carry and half-carry only; `S`, `Z` and `P/V` are untouched. */
  private add16(left: number, right: number): number {
    const result = left + right;
    this.f =
      (this.f & (FLAG.s | FLAG.z | FLAG.pv)) |
      (((left ^ right ^ result) & 0x1000) !== 0 ? FLAG.h : 0) |
      (result > 0xffff ? FLAG.c : 0) |
      ((result >> 8) & (FLAG.x | FLAG.y));
    return result & 0xffff;
  }

  /** `adc hl,rr` — a full set of flags, which is why the arithmetic uses it. */
  private adc16(right: number): void {
    const left = this.hl;
    const result = left + right + (this.carry !== 0 ? 1 : 0);
    const word = result & 0xffff;
    this.f =
      (word === 0 ? FLAG.z : 0) |
      ((word >> 8) & (FLAG.s | FLAG.x | FLAG.y)) |
      (result > 0xffff ? FLAG.c : 0) |
      (((left ^ right ^ word) & 0x1000) !== 0 ? FLAG.h : 0) |
      (((left ^ ~right) & (left ^ word) & 0x8000) !== 0 ? FLAG.pv : 0);
    this.hl = word;
  }

  private sbc16(right: number): void {
    const left = this.hl;
    const result = left - right - (this.carry !== 0 ? 1 : 0);
    const word = result & 0xffff;
    this.f =
      (word === 0 ? FLAG.z : 0) |
      ((word >> 8) & (FLAG.s | FLAG.x | FLAG.y)) |
      FLAG.n |
      (result < 0 ? FLAG.c : 0) |
      (((left ^ right ^ word) & 0x1000) !== 0 ? FLAG.h : 0) |
      (((left ^ right) & (left ^ word) & 0x8000) !== 0 ? FLAG.pv : 0);
    this.hl = word;
  }

  /**
   * `daa` — the decimal adjust, and the only instruction that reads `H` and `N`.
   *
   * Written as the manual's table rather than as arithmetic, because the
   * arithmetic-looking versions of this in the wild disagree with each other
   * about the case where both nibbles need adjusting after a subtraction.
   */
  private daa(): void {
    let adjust = 0;
    let carry = this.carry;
    if ((this.f & FLAG.h) !== 0 || (this.a & 0x0f) > 9) adjust |= 0x06;
    if (carry !== 0 || this.a > 0x99) {
      adjust |= 0x60;
      carry = FLAG.c;
    }
    const before = this.a;
    this.a = ((this.f & FLAG.n) !== 0 ? this.a - adjust : this.a + adjust) & 0xff;
    this.f =
      (SZ53P[this.a] as number) |
      (this.f & FLAG.n) |
      carry |
      ((before ^ this.a) & FLAG.h ? FLAG.h : 0);
  }

  // --- rotates and shifts ----------------------------------------------------

  private rlc(value: number): number {
    const byte = ((value << 1) | (value >> 7)) & 0xff;
    this.f = (SZ53P[byte] as number) | ((value >> 7) & 1);
    return byte;
  }
  private rrc(value: number): number {
    const byte = ((value >> 1) | (value << 7)) & 0xff;
    this.f = (SZ53P[byte] as number) | (value & 1);
    return byte;
  }
  private rl(value: number): number {
    const byte = ((value << 1) | (this.carry !== 0 ? 1 : 0)) & 0xff;
    this.f = (SZ53P[byte] as number) | ((value >> 7) & 1);
    return byte;
  }
  private rr(value: number): number {
    const byte = ((value >> 1) | (this.carry !== 0 ? 0x80 : 0)) & 0xff;
    this.f = (SZ53P[byte] as number) | (value & 1);
    return byte;
  }
  private sla(value: number): number {
    const byte = (value << 1) & 0xff;
    this.f = (SZ53P[byte] as number) | ((value >> 7) & 1);
    return byte;
  }
  private sra(value: number): number {
    const byte = ((value >> 1) | (value & 0x80)) & 0xff;
    this.f = (SZ53P[byte] as number) | (value & 1);
    return byte;
  }
  private sll(value: number): number {
    const byte = ((value << 1) | 1) & 0xff;
    this.f = (SZ53P[byte] as number) | ((value >> 7) & 1);
    return byte;
  }
  private srl(value: number): number {
    const byte = (value >> 1) & 0xff;
    this.f = (SZ53P[byte] as number) | (value & 1);
    return byte;
  }

  private bitTest(bit: number, value: number, undocumented: number): void {
    const masked = value & (1 << bit);
    this.f =
      this.carry |
      FLAG.h |
      (masked === 0 ? FLAG.z | FLAG.pv : 0) |
      (bit === 7 && masked !== 0 ? FLAG.s : 0) |
      (undocumented & (FLAG.x | FLAG.y));
  }

  // --- register file access, with the index substitution ---------------------

  /**
   * Read one of the eight register slots.
   *
   * `slot` is the opcode's three-bit field. When an index prefix is active *and*
   * the instruction has no `(ix+d)` operand, `h` and `l` name the halves of the
   * index register instead — the rule that makes `dd 6c` a register move and
   * `dd 66` a memory load.
   */
  private reg8(slot: number, index: number | null): number {
    switch (slot) {
      case 0:
        return this.b;
      case 1:
        return this.c;
      case 2:
        return this.d;
      case 3:
        return this.e;
      case 4:
        return index === null ? this.h : (index >> 8) & 0xff;
      case 5:
        return index === null ? this.l : index & 0xff;
      case 6:
        return this.bus.read(this.hl);
      default:
        return this.a;
    }
  }

  private setReg8(slot: number, value: number, index: number | null): void {
    const byte = value & 0xff;
    switch (slot) {
      case 0:
        this.b = byte;
        return;
      case 1:
        this.c = byte;
        return;
      case 2:
        this.d = byte;
        return;
      case 3:
        this.e = byte;
        return;
      case 4:
        if (index === null) this.h = byte;
        else this.setIndex(index, ((index & 0x00ff) | (byte << 8)) & 0xffff);
        return;
      case 5:
        if (index === null) this.l = byte;
        else this.setIndex(index, (index & 0xff00) | byte);
        return;
      case 6:
        this.bus.write(this.hl, byte);
        return;
      default:
        this.a = byte;
    }
  }

  /** Which index register is currently prefixed, tracked so its halves can be written. */
  private indexIsY = false;

  private setIndex(_previous: number, value: number): void {
    if (this.indexIsY) this.iy = value & 0xffff;
    else this.ix = value & 0xffff;
  }

  private pair(slot: number, index: number | null): number {
    switch (slot) {
      case 0:
        return this.bc;
      case 1:
        return this.de;
      case 2:
        return index === null ? this.hl : index;
      default:
        return this.sp;
    }
  }

  private setPair(slot: number, value: number, index: number | null): void {
    const word = value & 0xffff;
    switch (slot) {
      case 0:
        this.bc = word;
        return;
      case 1:
        this.de = word;
        return;
      case 2:
        if (index === null) this.hl = word;
        else this.setIndex(index, word);
        return;
      default:
        this.sp = word;
    }
  }

  /** Whether a condition slot holds, in the opcode's own numbering. */
  private condition(slot: number): boolean {
    switch (slot) {
      case 0:
        return (this.f & FLAG.z) === 0;
      case 1:
        return (this.f & FLAG.z) !== 0;
      case 2:
        return (this.f & FLAG.c) === 0;
      case 3:
        return (this.f & FLAG.c) !== 0;
      case 4:
        return (this.f & FLAG.pv) === 0;
      case 5:
        return (this.f & FLAG.pv) !== 0;
      case 6:
        return (this.f & FLAG.s) === 0;
      default:
        return (this.f & FLAG.s) !== 0;
    }
  }

  // --- interrupts ------------------------------------------------------------

  /**
   * Take a maskable interrupt, if one is allowed right now.
   *
   * Returns the T-states spent, or zero when the interrupt was not accepted —
   * which is what the caller uses to decide whether the line is still asserted.
   */
  interrupt(): number {
    if (!this.iff1 || this.eiPending) return 0;
    this.iff1 = false;
    this.iff2 = false;
    if (this.halted) {
      this.halted = false;
      this.pc = (this.pc + 1) & 0xffff;
    }
    this.refresh();
    switch (this.im) {
      case 2: {
        // The device supplies the low byte; nothing on these consoles drives the
        // bus, so it floats to $FF — which is what real hardware reads.
        const vector = (this.i << 8) | 0xff;
        this.push16(this.pc);
        this.pc = this.bus.read(vector) | (this.bus.read((vector + 1) & 0xffff) << 8);
        return 19;
      }
      case 1:
        this.push16(this.pc);
        this.pc = VECTOR.irq;
        return 13;
      default:
        // Mode 0 executes whatever the device puts on the bus; with nothing
        // driving it that is `rst 38h`, which is mode 1's behaviour anyway.
        this.push16(this.pc);
        this.pc = VECTOR.irq;
        return 13;
    }
  }

  /** Take a non-maskable interrupt — the Pause button, and never masked. */
  nmi(): number {
    if (this.halted) {
      this.halted = false;
      this.pc = (this.pc + 1) & 0xffff;
    }
    this.iff2 = this.iff1;
    this.iff1 = false;
    this.refresh();
    this.push16(this.pc);
    this.pc = VECTOR.nmi;
    return 11;
  }

  // --- the decoder -----------------------------------------------------------

  /** Execute one instruction and return the T-states it took. */
  step(): number {
    if (this.halted) {
      this.refresh();
      return 4;
    }
    const wasPending = this.eiPending;
    this.refresh();
    const cycles = this.execute(this.fetch(), null);
    // `ei` opens the window only after the instruction that follows it.
    if (wasPending) this.eiPending = false;
    return cycles;
  }

  /**
   * Execute one opcode, with an index register substituted or not.
   *
   * `index` is the current value of `ix`/`iy` when a `DD`/`FD` prefix is active,
   * and `null` otherwise — so every site that would touch `hl` can ask one
   * question instead of carrying a mode flag.
   */
  private execute(opcode: number, index: number | null): number {
    // The prefixes first, because each re-enters this function.
    switch (opcode) {
      case 0xdd:
        this.indexIsY = false;
        this.refresh();
        return 4 + this.execute(this.fetch(), this.ix);
      case 0xfd:
        this.indexIsY = true;
        this.refresh();
        return 4 + this.execute(this.fetch(), this.iy);
      case 0xcb:
        return this.executeCb(index);
      case 0xed:
        this.refresh();
        return this.executeEd();
      default:
        break;
    }

    const cycles = CYCLES[opcode] as number;
    const x = opcode >> 6;
    const y = (opcode >> 3) & 7;
    const z = opcode & 7;

    // 0x40..0x7F: the load block, and `halt` in the hole where `ld (hl),(hl)` would be.
    if (x === 1) {
      if (y === 6 && z === 6) {
        this.halted = true;
        return cycles;
      }
      if (index !== null && (y === 6 || z === 6)) {
        const offset = this.fetchDisp();
        const address = (index + offset) & 0xffff;
        if (z === 6) {
          this.setReg8(y, this.bus.read(address), null);
        } else {
          this.bus.write(address, this.reg8(z, null));
        }
        return 15;
      }
      this.setReg8(y, this.reg8(z, index), index);
      return cycles;
    }

    // 0x80..0xBF: the ALU block.
    if (x === 2) {
      let value: number;
      let extra = 0;
      if (index !== null && z === 6) {
        const offset = this.fetchDisp();
        value = this.bus.read((index + offset) & 0xffff);
        // Documented as 19; the prefix's own four are added by the caller.
        extra = 8;
      } else {
        value = this.reg8(z, index);
      }
      this.alu(y, value);
      return cycles + extra;
    }

    if (x === 0) return this.executeLow(y, z, index, cycles);
    return this.executeHigh(y, z, index, cycles);
  }

  /** One of the eight ALU operations, by opcode slot. */
  private alu(op: number, value: number): void {
    switch (op) {
      case 0:
        this.add8(value);
        return;
      case 1:
        this.adc8(value);
        return;
      case 2:
        this.sub8(value);
        return;
      case 3:
        this.sbc8(value);
        return;
      case 4:
        this.and8(value);
        return;
      case 5:
        this.xor8(value);
        return;
      case 6:
        this.or8(value);
        return;
      default:
        this.cp8(value);
    }
  }

  /** Opcodes `$00`–`$3F`: loads, 16-bit arithmetic, the accumulator rotates. */
  private executeLow(y: number, z: number, index: number | null, cycles: number): number {
    switch (z) {
      case 0:
        switch (y) {
          case 0:
            return cycles; // nop
          case 1: {
            const a = this.a;
            const f = this.f;
            this.a = this.a2;
            this.f = this.f2;
            this.a2 = a;
            this.f2 = f;
            return cycles;
          }
          case 2: {
            // djnz: decrement b, branch when it is not yet zero.
            const offset = this.fetchDisp();
            this.b = (this.b - 1) & 0xff;
            if (this.b !== 0) {
              this.pc = (this.pc + offset) & 0xffff;
              return 13;
            }
            return 8;
          }
          case 3: {
            const offset = this.fetchDisp();
            this.pc = (this.pc + offset) & 0xffff;
            return 12;
          }
          default: {
            const offset = this.fetchDisp();
            if (this.condition(y - 4)) {
              this.pc = (this.pc + offset) & 0xffff;
              return 12;
            }
            return 7;
          }
        }
      case 1:
        if ((y & 1) === 0) {
          this.setPair(y >> 1, this.fetch16(), index);
          return cycles;
        }
        this.setPair(2, this.add16(this.pair(2, index), this.pair(y >> 1, index)), index);
        return cycles;
      case 2:
        switch (y) {
          case 0:
            this.bus.write(this.bc, this.a);
            return cycles;
          case 1:
            this.a = this.bus.read(this.bc);
            return cycles;
          case 2:
            this.bus.write(this.de, this.a);
            return cycles;
          case 3:
            this.a = this.bus.read(this.de);
            return cycles;
          case 4: {
            const address = this.fetch16();
            const value = this.pair(2, index);
            this.bus.write(address, value & 0xff);
            this.bus.write((address + 1) & 0xffff, (value >> 8) & 0xff);
            return cycles;
          }
          case 5: {
            const address = this.fetch16();
            this.setPair(
              2,
              this.bus.read(address) | (this.bus.read((address + 1) & 0xffff) << 8),
              index,
            );
            return cycles;
          }
          case 6:
            this.bus.write(this.fetch16(), this.a);
            return cycles;
          default:
            this.a = this.bus.read(this.fetch16());
            return cycles;
        }
      case 3:
        if ((y & 1) === 0) this.setPair(y >> 1, (this.pair(y >> 1, index) + 1) & 0xffff, index);
        else this.setPair(y >> 1, (this.pair(y >> 1, index) - 1) & 0xffff, index);
        return cycles;
      case 4:
      case 5: {
        const down = z === 5;
        if (index !== null && y === 6) {
          const offset = this.fetchDisp();
          const address = (index + offset) & 0xffff;
          const value = this.bus.read(address);
          this.bus.write(address, down ? this.dec8(value) : this.inc8(value));
          return 19; // 23 documented, less the prefix's four
        }
        const value = this.reg8(y, index);
        this.setReg8(y, down ? this.dec8(value) : this.inc8(value), index);
        return cycles;
      }
      case 6: {
        if (index !== null && y === 6) {
          const offset = this.fetchDisp();
          const value = this.fetch();
          this.bus.write((index + offset) & 0xffff, value);
          return 15; // 19 documented, less the prefix's four
        }
        this.setReg8(y, this.fetch(), index);
        return cycles;
      }
      default:
        return this.accumulatorOp(y, cycles);
    }
  }

  /** The eight one-byte accumulator and flag operations at `$07`–`$3F`. */
  private accumulatorOp(y: number, cycles: number): number {
    switch (y) {
      case 0:
        this.a = ((this.a << 1) | (this.a >> 7)) & 0xff;
        this.f = (this.f & (FLAG.s | FLAG.z | FLAG.pv)) | (this.a & (FLAG.x | FLAG.y | FLAG.c));
        return cycles;
      case 1: {
        const carry = this.a & 1;
        this.a = ((this.a >> 1) | (this.a << 7)) & 0xff;
        this.f = (this.f & (FLAG.s | FLAG.z | FLAG.pv)) | (this.a & (FLAG.x | FLAG.y)) | carry;
        return cycles;
      }
      case 2: {
        const carry = (this.a >> 7) & 1;
        this.a = ((this.a << 1) | (this.carry !== 0 ? 1 : 0)) & 0xff;
        this.f = (this.f & (FLAG.s | FLAG.z | FLAG.pv)) | (this.a & (FLAG.x | FLAG.y)) | carry;
        return cycles;
      }
      case 3: {
        const carry = this.a & 1;
        this.a = ((this.a >> 1) | (this.carry !== 0 ? 0x80 : 0)) & 0xff;
        this.f = (this.f & (FLAG.s | FLAG.z | FLAG.pv)) | (this.a & (FLAG.x | FLAG.y)) | carry;
        return cycles;
      }
      case 4:
        this.daa();
        return cycles;
      case 5:
        this.a = ~this.a & 0xff;
        this.f =
          (this.f & (FLAG.s | FLAG.z | FLAG.pv | FLAG.c)) |
          FLAG.h |
          FLAG.n |
          (this.a & (FLAG.x | FLAG.y));
        return cycles;
      case 6:
        this.f = (this.f & (FLAG.s | FLAG.z | FLAG.pv)) | FLAG.c | (this.a & (FLAG.x | FLAG.y));
        return cycles;
      default:
        this.f =
          (this.f & (FLAG.s | FLAG.z | FLAG.pv)) |
          (this.carry !== 0 ? FLAG.h : FLAG.c) |
          (this.a & (FLAG.x | FLAG.y));
        return cycles;
    }
  }

  /** Opcodes `$C0`–`$FF`: control flow, the stack, ports, and the prefixes' hosts. */
  private executeHigh(y: number, z: number, index: number | null, cycles: number): number {
    switch (z) {
      case 0:
        if (this.condition(y)) {
          this.pc = this.pop16();
          return 11;
        }
        return 5;
      case 1:
        if ((y & 1) === 0) {
          const value = this.pop16();
          if (y >> 1 === 3) this.af = value;
          else this.setPair(y >> 1, value, index);
          return cycles;
        }
        switch (y >> 1) {
          case 0:
            this.pc = this.pop16();
            return cycles;
          case 1: {
            const b = this.b;
            const c = this.c;
            const d = this.d;
            const e = this.e;
            const h = this.h;
            const l = this.l;
            this.b = this.b2;
            this.c = this.c2;
            this.d = this.d2;
            this.e = this.e2;
            this.h = this.h2;
            this.l = this.l2;
            this.b2 = b;
            this.c2 = c;
            this.d2 = d;
            this.e2 = e;
            this.h2 = h;
            this.l2 = l;
            return cycles;
          }
          case 2:
            this.pc = this.pair(2, index);
            return cycles;
          default:
            this.sp = this.pair(2, index);
            return cycles;
        }
      case 2: {
        const target = this.fetch16();
        if (this.condition(y)) this.pc = target;
        return cycles;
      }
      case 3:
        switch (y) {
          case 0:
            this.pc = this.fetch16();
            return cycles;
          case 2: {
            const port = this.fetch();
            this.bus.out(port | (this.a << 8), this.a);
            return cycles;
          }
          case 3: {
            const port = this.fetch();
            this.a = this.bus.in(port | (this.a << 8));
            return cycles;
          }
          case 4: {
            // ex (sp),hl — the one instruction that swaps memory with a register pair.
            const low = this.bus.read(this.sp);
            const high = this.bus.read((this.sp + 1) & 0xffff);
            const value = this.pair(2, index);
            this.bus.write(this.sp, value & 0xff);
            this.bus.write((this.sp + 1) & 0xffff, (value >> 8) & 0xff);
            this.setPair(2, low | (high << 8), index);
            return cycles;
          }
          case 5: {
            const de = this.de;
            this.de = this.hl;
            this.hl = de;
            return cycles;
          }
          case 6:
            this.iff1 = false;
            this.iff2 = false;
            return cycles;
          default:
            this.iff1 = true;
            this.iff2 = true;
            this.eiPending = true;
            return cycles;
        }
      case 4: {
        const target = this.fetch16();
        if (this.condition(y)) {
          this.push16(this.pc);
          this.pc = target;
          return 17;
        }
        return 10;
      }
      case 5: {
        if ((y & 1) === 0) {
          this.push16(y >> 1 === 3 ? this.af : this.pair(y >> 1, index));
          return cycles;
        }
        // The only odd `y` left is 1, `call nn`: 3, 5 and 7 are the `DD`, `ED` and
        // `FD` prefixes, which `execute` intercepted before the decode got here.
        const target = this.fetch16();
        this.push16(this.pc);
        this.pc = target;
        return cycles;
      }
      case 6:
        this.alu(y, this.fetch());
        return cycles;
      default:
        this.push16(this.pc);
        this.pc = y << 3;
        return cycles;
    }
  }

  /** The `CB` page: rotates, shifts and bit operations. */
  private executeCb(index: number | null): number {
    if (index !== null) {
      // `dd cb d op` — the displacement comes *before* the opcode, uniquely.
      const offset = this.fetchDisp();
      const opcode = this.fetch();
      const address = (index + offset) & 0xffff;
      const value = this.bus.read(address);
      const x = opcode >> 6;
      const y = (opcode >> 3) & 7;
      const z = opcode & 7;
      if (x === 1) {
        this.bitTest(y, value, (address >> 8) & 0xff);
        return 16; // 20 documented, less the prefix's four
      }
      const result =
        x === 0 ? this.shiftOp(y, value) : x === 2 ? value & ~(1 << y) : value | (1 << y);
      this.bus.write(address, result);
      // The undocumented forms also drop the result into a register.
      if (z !== 6) this.setReg8(z, result, null);
      return 19; // 23 documented, less the prefix's four
    }
    this.refresh();
    const opcode = this.fetch();
    const x = opcode >> 6;
    const y = (opcode >> 3) & 7;
    const z = opcode & 7;
    const value = this.reg8(z, null);
    if (x === 1) {
      this.bitTest(y, value, z === 6 ? (this.hl >> 8) & 0xff : value);
      return z === 6 ? 12 : 8;
    }
    // `res` and `set` leave every flag alone, which is why only the shift path
    // goes through `shiftOp` — the flags are that function's side effect.
    const result =
      x === 0 ? this.shiftOp(y, value) : x === 2 ? value & ~(1 << y) : value | (1 << y);
    this.setReg8(z, result, null);
    return z === 6 ? 15 : 8;
  }

  private shiftOp(op: number, value: number): number {
    switch (op) {
      case 0:
        return this.rlc(value);
      case 1:
        return this.rrc(value);
      case 2:
        return this.rl(value);
      case 3:
        return this.rr(value);
      case 4:
        return this.sla(value);
      case 5:
        return this.sra(value);
      case 6:
        return this.sll(value);
      default:
        return this.srl(value);
    }
  }

  /** The `ED` page: 16-bit arithmetic, ports, block moves, the odd loads. */
  private executeEd(): number {
    const opcode = this.fetch();
    const x = opcode >> 6;
    const y = (opcode >> 3) & 7;
    const z = opcode & 7;
    if (x !== 1) {
      if (x === 2 && z < 4 && y >= 4) return this.block(y, z);
      return 8; // every other slot is a two-byte nop on real silicon
    }
    switch (z) {
      case 0: {
        const value = this.bus.in(this.bc);
        if (y !== 6) this.setReg8(y, value, null);
        this.f = this.carry | (SZ53P[value] as number);
        return 12;
      }
      case 1:
        this.bus.out(this.bc, y === 6 ? 0 : this.reg8(y, null));
        return 12;
      case 2:
        if ((y & 1) === 0) this.sbc16(this.pair(y >> 1, null));
        else this.adc16(this.pair(y >> 1, null));
        return 15;
      case 3: {
        const address = this.fetch16();
        if ((y & 1) === 0) {
          const value = this.pair(y >> 1, null);
          this.bus.write(address, value & 0xff);
          this.bus.write((address + 1) & 0xffff, (value >> 8) & 0xff);
        } else {
          this.setPair(
            y >> 1,
            this.bus.read(address) | (this.bus.read((address + 1) & 0xffff) << 8),
            null,
          );
        }
        return 20;
      }
      case 4: {
        const value = this.a;
        this.a = 0;
        this.sub8(value);
        return 8;
      }
      case 5:
        this.iff1 = this.iff2;
        this.pc = this.pop16();
        return 14;
      case 6:
        this.im = y === 0 || y === 1 || y === 4 || y === 5 ? 0 : y === 2 || y === 6 ? 1 : 2;
        return 8;
      default:
        return this.edMisc(y);
    }
  }

  /** `ld a,i`, `ld a,r`, their stores, and the two decimal rotates. */
  private edMisc(y: number): number {
    switch (y) {
      case 0:
        this.i = this.a;
        return 9;
      case 1:
        this.r = this.a;
        return 9;
      case 2:
        this.a = this.i;
        this.f = this.carry | (SZ53[this.a] as number) | (this.iff2 ? FLAG.pv : 0);
        return 9;
      case 3:
        this.a = this.r & 0xff;
        this.f = this.carry | (SZ53[this.a] as number) | (this.iff2 ? FLAG.pv : 0);
        return 9;
      case 4: {
        // rrd
        const value = this.bus.read(this.hl);
        this.bus.write(this.hl, ((value >> 4) | (this.a << 4)) & 0xff);
        this.a = (this.a & 0xf0) | (value & 0x0f);
        this.f = this.carry | (SZ53P[this.a] as number);
        return 18;
      }
      case 5: {
        // rld
        const value = this.bus.read(this.hl);
        this.bus.write(this.hl, ((value << 4) | (this.a & 0x0f)) & 0xff);
        this.a = (this.a & 0xf0) | ((value >> 4) & 0x0f);
        this.f = this.carry | (SZ53P[this.a] as number);
        return 18;
      }
      default:
        return 8;
    }
  }

  /**
   * The block instructions: transfer, search, and their port siblings.
   *
   * `y` selects increment/decrement and repeat; `z` selects the family. A
   * repeating form that has not finished backs the program counter up over its
   * own two bytes, which is how it loops without a branch.
   */
  private block(y: number, z: number): number {
    const step = (y & 1) === 0 ? 1 : -1;
    const repeat = (y & 2) !== 0;
    switch (z) {
      case 0: {
        // ldi / ldd / ldir / lddr
        const value = this.bus.read(this.hl);
        this.bus.write(this.de, value);
        this.hl = (this.hl + step) & 0xffff;
        this.de = (this.de + step) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        const mixed = (value + this.a) & 0xff;
        this.f =
          (this.f & (FLAG.s | FLAG.z | FLAG.c)) |
          (this.bc !== 0 ? FLAG.pv : 0) |
          (mixed & FLAG.x) |
          ((mixed & 0x02) !== 0 ? FLAG.y : 0);
        if (repeat && this.bc !== 0) {
          this.pc = (this.pc - 2) & 0xffff;
          return 21;
        }
        return 16;
      }
      case 1: {
        // cpi / cpd / cpir / cpdr
        const value = this.bus.read(this.hl);
        const carry = this.carry;
        const result = (this.a - value) & 0xff;
        const half = (this.a & 0x0f) < (value & 0x0f);
        this.hl = (this.hl + step) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        const mixed = (result - (half ? 1 : 0)) & 0xff;
        this.f =
          carry |
          FLAG.n |
          (result === 0 ? FLAG.z : 0) |
          (result & FLAG.s) |
          (half ? FLAG.h : 0) |
          (this.bc !== 0 ? FLAG.pv : 0) |
          (mixed & FLAG.x) |
          ((mixed & 0x02) !== 0 ? FLAG.y : 0);
        if (repeat && this.bc !== 0 && result !== 0) {
          this.pc = (this.pc - 2) & 0xffff;
          return 21;
        }
        return 16;
      }
      case 2: {
        // ini / ind / inir / indr
        const value = this.bus.in(this.bc);
        this.bus.write(this.hl, value);
        this.hl = (this.hl + step) & 0xffff;
        this.b = (this.b - 1) & 0xff;
        this.f = (SZ53[this.b] as number) | FLAG.n;
        if (repeat && this.b !== 0) {
          this.pc = (this.pc - 2) & 0xffff;
          return 21;
        }
        return 16;
      }
      default: {
        // outi / outd / otir / otdr — `b` is decremented *before* the port write,
        // so the port address the VDP sees carries the new count in its high half.
        const value = this.bus.read(this.hl);
        this.b = (this.b - 1) & 0xff;
        this.bus.out(this.bc, value);
        this.hl = (this.hl + step) & 0xffff;
        this.f = (SZ53[this.b] as number) | FLAG.n;
        if (repeat && this.b !== 0) {
          this.pc = (this.pc - 2) & 0xffff;
          return 21;
        }
        return 16;
      }
    }
  }
}
