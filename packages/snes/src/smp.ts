/**
 * The S-SMP: the Super Nintendo's sound processor, and everything around it.
 *
 * This is the console's *second computer*. An SPC700 with 64 KiB of its own RAM,
 * three timers, an S-DSP hanging off two registers, and four mailbox bytes — and
 * no access to the cartridge whatsoever. The only way a program reaches it is an
 * upload through the mailbox at boot, which is why `demake build -c snes` emits
 * two programs: 65816 for the game and SPC700 for its music.
 *
 * The CPU and the hardware around it live in one file because they are one chip.
 * Splitting them the way `cpu.ts` and `machine.ts` are split would suggest a bus
 * that could have something else on it, and there is nothing else on it.
 *
 * **The boot ROM here is ours.** The sixty-four bytes at `$FFC0` are a program
 * written in this repository that speaks the documented upload handshake — the
 * `$AA`/`$BB` greeting, the `$CC` kick, the byte counter echo, the zero that ends
 * it — rather than a transcription of Nintendo's. That is the same decision as
 * leaving the Game Boy's boot logo area blank (doc 14 §Gotchas): a cartridge this
 * project builds has to work against the real thing, so the *protocol* is
 * reproduced exactly, and the code that implements it is written rather than
 * copied.
 *
 * Cycle counts are the published ones for the addressing forms the generated
 * driver uses. They are not load-bearing the way the 65816's are: the driver's
 * tempo comes from a timer, not from counting instructions, and it does a handful
 * of register writes in a window eight thousand cycles wide.
 *
 * Sources:
 * - SNESdev Wiki — SPC700 reference: https://snes.nesdev.org/wiki/SPC700_reference
 * - SNESdev Wiki — S-SMP registers and the boot protocol:
 *   https://snes.nesdev.org/wiki/S-SMP
 */

import { A, Asm700, SP, X, Y, YA, spcDp, spcIdxIndY, spcImm, spcIndX } from "@demake/core";
import { ARAM_SIZE, SDsp, type SampleSink } from "@demake/chip";

export { ARAM_SIZE };

/** The console's master clock, which the sound side is unrelated to. */
const SNES_MASTER_HZ = 21477272;

/** The SPC700's clock. One cycle is 24 of the DSP's own 24.576 MHz clocks. */
export const SPC_CLOCK_HZ = 1024000;

/** DSP master clocks per SPC700 cycle. */
export const DSP_CLOCKS_PER_CYCLE = 24;

/** Where the boot ROM sits, and how big it is. */
export const BOOT_ROM_BASE = 0xffc0;

/** SPC700 cycles per tick of timers 0 and 1 (8 kHz). */
const TIMER_SLOW = 128;
/** SPC700 cycles per tick of timer 2 (64 kHz). */
const TIMER_FAST = 16;

/** Processor status bits. */
const F = {
  C: 0x01,
  Z: 0x02,
  I: 0x04,
  H: 0x08,
  B: 0x10,
  P: 0x20,
  V: 0x40,
  N: 0x80,
} as const;

/**
 * Our upload boot ROM, assembled once.
 *
 * The handshake, in the order the two processors perform it:
 *
 * 1. The sound side clears its low RAM, then puts `$AA` in port 0 and `$BB` in
 *    port 1 — "I am awake".
 * 2. The main CPU writes the destination address to ports 2 and 3, a non-zero
 *    byte to port 1, and `$CC` to port 0.
 * 3. For each byte: the main CPU puts the data in port 1 and a counter in port 0,
 *    and waits for port 0 to come back. The sound side stores the byte and echoes
 *    the counter.
 * 4. A counter *two* ahead of the last one ends the block. Port 1 non-zero means
 *    another block follows at the address in ports 2 and 3; port 1 zero means
 *    jump there and start.
 *
 * The "two ahead" is what makes the wait loop work at all: while the main CPU is
 * still preparing a byte, port 0 holds the *previous* counter, so the expected
 * counter minus the port reads as +1 — positive, keep waiting. Only a value that
 * has jumped past it reads as negative, and that is the end of the block.
 */
export const BOOT_ROM: Uint8Array = (() => {
  const asm = new Asm700(BOOT_ROM_BASE);
  asm.mov(X, spcImm(0xef));
  asm.mov(SP, X);
  asm.mov(A, spcImm(0x00));
  asm.label("Zero");
  asm.mov(spcIndX, A);
  asm.dec(X);
  asm.bne("Zero");
  asm.mov(spcDp(0xf4), spcImm(0xaa));
  asm.mov(spcDp(0xf5), spcImm(0xbb));
  asm.label("Kick");
  asm.cmp(spcDp(0xf4), spcImm(0xcc));
  asm.bne("Kick");
  asm.label("Block");
  asm.movw(YA, spcDp(0xf6)); // the destination address the main CPU set
  asm.movw(spcDp(0x00), YA); // ...becomes the pointer at $00/$01
  asm.movw(YA, spcDp(0xf4)); // A = port 0 (the marker), Y = port 1
  asm.mov(spcDp(0xf4), A); // echo the marker so the sender may proceed
  asm.mov(A, Y);
  asm.beq("Run"); // port 1 zero: this block is the entry point
  asm.mov(Y, spcImm(0x00));
  asm.label("Byte");
  asm.cmp(Y, spcDp(0xf4));
  asm.beq("Store");
  asm.bpl("Byte"); // the sender is still behind; keep waiting
  asm.bra("Block"); // it jumped ahead: this block is finished
  asm.label("Store");
  asm.mov(A, spcDp(0xf5));
  asm.mov(spcIdxIndY(0x00), A);
  asm.mov(spcDp(0xf4), Y);
  asm.inc(Y);
  asm.bne("Byte");
  asm.inc(spcDp(0x01)); // Y wrapped: carry into the pointer's high byte
  asm.bra("Byte");
  asm.label("Run");
  // X is still zero from the clear loop, so this is `jmp [$0000]`.
  asm.jmpIndX(0x0000);
  asm.padTo(0xfffe, 0xff);
  asm.dw(BOOT_ROM_BASE);
  return asm.assemble();
})();

/** One of the three timers: a prescaler, a target, and a four-bit counter. */
interface Timer {
  enabled: boolean;
  /** Cycles until the prescaler ticks. */
  prescale: number;
  /** How many prescaler ticks make one counter step; 0 means 256. */
  target: number;
  stage: number;
  /** The four-bit value `$FD`–`$FF` reports, cleared by reading. */
  out: number;
}

function newTimer(): Timer {
  return { enabled: false, prescale: 0, target: 0, stage: 0, out: 0 };
}

/** The sound side of a Super Nintendo. */
export class Smp {
  /** The 64 KiB the SPC700 and the DSP share. */
  readonly ram = new Uint8Array(ARAM_SIZE);
  readonly dsp: SDsp;

  /** Every DSP register write, for the conformance harness (doc 16 §The proof). */
  dspTap: ((reg: number, value: number) => void) | undefined = undefined;
  /**
   * Every instruction's address, before it runs.
   *
   * The counterpart of `dspTap` for *when* rather than *what*, and the sound side
   * is the one place it is needed: the two processors run on unrelated clocks, so
   * a host that steps the game one instruction at a time may advance this one by
   * several — and a harness sampling the program counter afterwards would miss a
   * driver tick beginning and ending inside a single step. Observing rather than
   * intercepting, on the same terms: with nothing listening it costs a branch.
   */
  pcTap: ((pc: number) => void) | undefined = undefined;
  /** Where the DSP's output goes when anything is listening. */
  audioSink: SampleSink | undefined = undefined;

  a = 0;
  x = 0;
  y = 0;
  sp = 0;
  pc = BOOT_ROM_BASE;
  psw = 0;

  /** `$2140`–`$2143` as the sound side reads them at `$F4`–`$F7`. */
  private readonly inPort = new Uint8Array(4);
  /** What the sound side has written for the main CPU to read. */
  private readonly outPort = new Uint8Array(4);

  private dspAddr = 0;
  private control = 0xb0;
  private readonly timers: Timer[] = [newTimer(), newTimer(), newTimer()];
  /** Master cycles owed to the sound side but not yet spent. */
  private credit = 0;
  private stopped = false;

  constructor() {
    this.dsp = new SDsp({ ram: this.ram });
    this.reset();
  }

  reset(): void {
    this.ram.fill(0);
    this.dsp.reset();
    this.inPort.fill(0);
    this.outPort.fill(0);
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0xef;
    this.psw = 0;
    this.dspAddr = 0;
    // The boot ROM is mapped and every timer is off, which is the state the chip
    // powers up in.
    this.control = 0x80;
    for (let i = 0; i < 3; i += 1) this.timers[i] = newTimer();
    this.credit = 0;
    this.stopped = false;
    this.pc = this.readWord(0xfffe);
  }

  // --- the main CPU's side of the mailbox ------------------------------------

  /** `$2140`–`$2143` read by the 65816. */
  readPort(index: number): number {
    return this.outPort[index & 3] as number;
  }

  /** `$2140`–`$2143` written by the 65816. */
  writePort(index: number, value: number): void {
    this.inPort[index & 3] = value & 0xff;
  }

  // --- memory ----------------------------------------------------------------

  private read8(address: number): number {
    const at = address & 0xffff;
    if (at >= 0x00f0 && at <= 0x00ff) return this.readRegister(at);
    if (at >= BOOT_ROM_BASE && (this.control & 0x80) !== 0) {
      return BOOT_ROM[at - BOOT_ROM_BASE] as number;
    }
    return this.ram[at] as number;
  }

  private write8(address: number, value: number): void {
    const at = address & 0xffff;
    const byte = value & 0xff;
    if (at >= 0x00f0 && at <= 0x00ff) {
      this.writeRegister(at, byte);
      return;
    }
    // RAM underlies the boot ROM: reads see the ROM, writes always land.
    this.ram[at] = byte;
  }

  private readRegister(at: number): number {
    switch (at) {
      case 0xf2:
        return this.dspAddr;
      case 0xf3:
        return this.dsp.read(this.dspAddr);
      case 0xf4:
      case 0xf5:
      case 0xf6:
      case 0xf7:
        return this.inPort[at - 0xf4] as number;
      case 0xf8:
      case 0xf9:
        return this.ram[at] as number;
      case 0xfd:
      case 0xfe:
      case 0xff: {
        // The counter is four bits and reading it clears it, which is how a
        // driver asks "how many ticks have I missed" and cannot miss one.
        const timer = this.timers[at - 0xfd]!;
        const value = timer.out;
        timer.out = 0;
        return value;
      }
      default:
        return 0;
    }
  }

  private writeRegister(at: number, byte: number): void {
    switch (at) {
      case 0xf1: {
        for (let i = 0; i < 3; i += 1) {
          const on = (byte & (1 << i)) !== 0;
          const timer = this.timers[i]!;
          // Enabling a timer restarts it; leaving it enabled does not.
          if (on && !timer.enabled) {
            timer.stage = 0;
            timer.out = 0;
            timer.prescale = i === 2 ? TIMER_FAST : TIMER_SLOW;
          }
          timer.enabled = on;
        }
        if ((byte & 0x10) !== 0) {
          this.inPort[0] = 0;
          this.inPort[1] = 0;
        }
        if ((byte & 0x20) !== 0) {
          this.inPort[2] = 0;
          this.inPort[3] = 0;
        }
        this.control = byte;
        return;
      }
      case 0xf2:
        this.dspAddr = byte;
        return;
      case 0xf3:
        if (this.dspAddr < 0x80) {
          this.dsp.write(this.dspAddr, byte);
          this.dspTap?.(this.dspAddr, byte);
        }
        return;
      case 0xf4:
      case 0xf5:
      case 0xf6:
      case 0xf7:
        this.outPort[at - 0xf4] = byte;
        return;
      case 0xfa:
      case 0xfb:
      case 0xfc:
        this.timers[at - 0xfa]!.target = byte;
        return;
      default:
        this.ram[at] = byte;
        return;
    }
  }

  private readWord(address: number): number {
    return this.read8(address) | (this.read8((address + 1) & 0xffff) << 8);
  }

  // --- timing ----------------------------------------------------------------

  /**
   * Spend `master` of the console's master cycles on the sound side.
   *
   * The two clocks are unrelated — 21.477 MHz against 1.024 MHz — so the credit
   * is carried in master cycles and converted once, which is what stops a long
   * run drifting against a short one.
   */
  run(master: number): void {
    this.credit += master * SPC_CLOCK_HZ;
    const cycles = Math.floor(this.credit / SNES_MASTER_HZ);
    if (cycles <= 0) return;
    this.credit -= cycles * SNES_MASTER_HZ;
    this.spend(cycles);
  }

  private spend(cycles: number): void {
    let owed = cycles;
    while (owed > 0) {
      if (!this.stopped) this.pcTap?.(this.pc);
      const used = this.stopped ? owed : this.step();
      const spent = used > owed ? owed : used;
      this.clockTimers(spent);
      if (this.audioSink) this.dsp.run(spent * DSP_CLOCKS_PER_CYCLE, this.audioSink);
      owed -= spent;
    }
  }

  private clockTimers(cycles: number): void {
    for (let i = 0; i < 3; i += 1) {
      const timer = this.timers[i]!;
      if (!timer.enabled) continue;
      const period = i === 2 ? TIMER_FAST : TIMER_SLOW;
      timer.prescale -= cycles;
      while (timer.prescale <= 0) {
        timer.prescale += period;
        timer.stage += 1;
        const target = timer.target === 0 ? 256 : timer.target;
        if (timer.stage >= target) {
          timer.stage = 0;
          timer.out = (timer.out + 1) & 0x0f;
        }
      }
    }
  }

  // --- the processor ---------------------------------------------------------

  private fetch(): number {
    const byte = this.read8(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return byte;
  }

  private fetch16(): number {
    const low = this.fetch();
    return low | (this.fetch() << 8);
  }

  /** A direct-page address, which `P` moves between page zero and page one. */
  private dpAddr(offset: number): number {
    return ((this.psw & F.P) !== 0 ? 0x0100 : 0) | (offset & 0xff);
  }

  private push(value: number): void {
    this.write8(0x0100 | this.sp, value);
    this.sp = (this.sp - 1) & 0xff;
  }

  private pull(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.read8(0x0100 | this.sp);
  }

  private setFlag(bit: number, on: boolean): void {
    if (on) this.psw |= bit;
    else this.psw &= ~bit & 0xff;
  }

  private setNZ(value: number): number {
    const byte = value & 0xff;
    this.setFlag(F.Z, byte === 0);
    this.setFlag(F.N, (byte & 0x80) !== 0);
    return byte;
  }

  /** The six ALU operations, chosen by the opcode's top three bits. */
  private alu(op: number, left: number, right: number): number {
    switch (op & 0xe0) {
      case 0x00:
        return this.setNZ(left | right);
      case 0x20:
        return this.setNZ(left & right);
      case 0x40:
        return this.setNZ(left ^ right);
      case 0x60: {
        const result = left - right;
        this.setFlag(F.C, result >= 0);
        this.setNZ(result);
        return left;
      }
      case 0x80: {
        const carry = (this.psw & F.C) !== 0 ? 1 : 0;
        const result = left + right + carry;
        this.setFlag(F.C, result > 0xff);
        this.setFlag(F.V, ((left ^ result) & (right ^ result) & 0x80) !== 0);
        this.setFlag(F.H, (left & 0x0f) + (right & 0x0f) + carry > 0x0f);
        return this.setNZ(result);
      }
      default: {
        const carry = (this.psw & F.C) !== 0 ? 1 : 0;
        const result = left - right - (1 - carry);
        this.setFlag(F.C, result >= 0);
        this.setFlag(F.V, ((left ^ right) & (left ^ result) & 0x80) !== 0);
        this.setFlag(F.H, (left & 0x0f) - (right & 0x0f) - (1 - carry) >= 0);
        return this.setNZ(result);
      }
    }
  }

  /** The four shifts, chosen the same way. */
  private shiftOp(op: number, value: number): number {
    const carryIn = (this.psw & F.C) !== 0 ? 1 : 0;
    switch (op & 0xe0) {
      case 0x00:
        this.setFlag(F.C, (value & 0x80) !== 0);
        return this.setNZ(value << 1);
      case 0x20:
        this.setFlag(F.C, (value & 0x80) !== 0);
        return this.setNZ((value << 1) | carryIn);
      case 0x40:
        this.setFlag(F.C, (value & 0x01) !== 0);
        return this.setNZ(value >> 1);
      default:
        this.setFlag(F.C, (value & 0x01) !== 0);
        return this.setNZ((value >> 1) | (carryIn << 7));
    }
  }

  private branch(taken: boolean, extra = 2): number {
    const offset = this.fetch();
    if (!taken) return 2;
    this.pc = (this.pc + ((offset << 24) >> 24)) & 0xffff;
    return 2 + extra;
  }

  /** Word arithmetic on YA, which is the CPU's only sixteen-bit path. */
  private get ya(): number {
    return (this.y << 8) | this.a;
  }
  private set ya(value: number) {
    this.a = value & 0xff;
    this.y = (value >> 8) & 0xff;
  }

  /** Execute one instruction and return the cycles it cost. */
  step(): number {
    const op = this.fetch();
    switch (op) {
      // --- ALU: A against a memory operand -----------------------------------
      case 0x04:
      case 0x24:
      case 0x44:
      case 0x64:
      case 0x84:
      case 0xa4:
        this.a = this.alu(op, this.a, this.read8(this.dpAddr(this.fetch())));
        return 3;
      case 0x05:
      case 0x25:
      case 0x45:
      case 0x65:
      case 0x85:
      case 0xa5:
        this.a = this.alu(op, this.a, this.read8(this.fetch16()));
        return 4;
      case 0x06:
      case 0x26:
      case 0x46:
      case 0x66:
      case 0x86:
      case 0xa6:
        this.a = this.alu(op, this.a, this.read8(this.dpAddr(this.x)));
        return 3;
      case 0x07:
      case 0x27:
      case 0x47:
      case 0x67:
      case 0x87:
      case 0xa7:
        this.a = this.alu(op, this.a, this.read8(this.indirectX()));
        return 6;
      case 0x08:
      case 0x28:
      case 0x48:
      case 0x68:
      case 0x88:
      case 0xa8:
        this.a = this.alu(op, this.a, this.fetch());
        return 2;
      case 0x09:
      case 0x29:
      case 0x49:
      case 0x69:
      case 0x89:
      case 0xa9: {
        // `op dd,ds` — the *source* offset is encoded first.
        const source = this.dpAddr(this.fetch());
        const destination = this.dpAddr(this.fetch());
        const result = this.alu(op, this.read8(destination), this.read8(source));
        if ((op & 0xe0) !== 0x60) this.write8(destination, result);
        return 6;
      }
      case 0x14:
      case 0x34:
      case 0x54:
      case 0x74:
      case 0x94:
      case 0xb4:
        this.a = this.alu(op & 0xe0, this.a, this.read8(this.dpAddr(this.fetch() + this.x)));
        return 4;
      case 0x15:
      case 0x35:
      case 0x55:
      case 0x75:
      case 0x95:
      case 0xb5:
        this.a = this.alu(op & 0xe0, this.a, this.read8((this.fetch16() + this.x) & 0xffff));
        return 5;
      case 0x16:
      case 0x36:
      case 0x56:
      case 0x76:
      case 0x96:
      case 0xb6:
        this.a = this.alu(op & 0xe0, this.a, this.read8((this.fetch16() + this.y) & 0xffff));
        return 5;
      case 0x17:
      case 0x37:
      case 0x57:
      case 0x77:
      case 0x97:
      case 0xb7:
        this.a = this.alu(op & 0xe0, this.a, this.read8(this.indirectY()));
        return 6;
      case 0x18:
      case 0x38:
      case 0x58:
      case 0x78:
      case 0x98:
      case 0xb8: {
        // `op d,#i` — the immediate is encoded first.
        const value = this.fetch();
        const address = this.dpAddr(this.fetch());
        const result = this.alu(op & 0xe0, this.read8(address), value);
        if ((op & 0xe0) !== 0x60) this.write8(address, result);
        return 5;
      }
      case 0x19:
      case 0x39:
      case 0x59:
      case 0x79:
      case 0x99:
      case 0xb9: {
        const destination = this.dpAddr(this.x);
        const result = this.alu(
          op & 0xe0,
          this.read8(destination),
          this.read8(this.dpAddr(this.y)),
        );
        if ((op & 0xe0) !== 0x60) this.write8(destination, result);
        return 5;
      }

      // --- comparisons against X and Y ---------------------------------------
      case 0xc8:
        this.compare(this.x, this.fetch());
        return 2;
      case 0x3e:
        this.compare(this.x, this.read8(this.dpAddr(this.fetch())));
        return 3;
      case 0x1e:
        this.compare(this.x, this.read8(this.fetch16()));
        return 4;
      case 0xad:
        this.compare(this.y, this.fetch());
        return 2;
      case 0x7e:
        this.compare(this.y, this.read8(this.dpAddr(this.fetch())));
        return 3;
      case 0x5e:
        this.compare(this.y, this.read8(this.fetch16()));
        return 4;

      // --- shifts, increments and decrements ---------------------------------
      case 0x0b:
      case 0x2b:
      case 0x4b:
      case 0x6b: {
        const address = this.dpAddr(this.fetch());
        this.write8(address, this.shiftOp(op, this.read8(address)));
        return 4;
      }
      case 0x0c:
      case 0x2c:
      case 0x4c:
      case 0x6c: {
        const address = this.fetch16();
        this.write8(address, this.shiftOp(op, this.read8(address)));
        return 5;
      }
      case 0x1b:
      case 0x3b:
      case 0x5b:
      case 0x7b: {
        const address = this.dpAddr(this.fetch() + this.x);
        this.write8(address, this.shiftOp(op, this.read8(address)));
        return 5;
      }
      case 0x1c:
      case 0x3c:
      case 0x5c:
      case 0x7c:
        this.a = this.shiftOp(op, this.a);
        return 2;
      case 0x8b:
      case 0xab: {
        const address = this.dpAddr(this.fetch());
        this.write8(address, this.setNZ(this.read8(address) + (op === 0xab ? 1 : -1)));
        return 4;
      }
      case 0x8c:
      case 0xac: {
        const address = this.fetch16();
        this.write8(address, this.setNZ(this.read8(address) + (op === 0xac ? 1 : -1)));
        return 5;
      }
      case 0x9b:
      case 0xbb: {
        const address = this.dpAddr(this.fetch() + this.x);
        this.write8(address, this.setNZ(this.read8(address) + (op === 0xbb ? 1 : -1)));
        return 5;
      }
      case 0x9c:
        this.a = this.setNZ(this.a - 1);
        return 2;
      case 0xbc:
        this.a = this.setNZ(this.a + 1);
        return 2;
      case 0x1d:
        this.x = this.setNZ(this.x - 1);
        return 2;
      case 0x3d:
        this.x = this.setNZ(this.x + 1);
        return 2;
      case 0xdc:
        this.y = this.setNZ(this.y - 1);
        return 2;
      case 0xfc:
        this.y = this.setNZ(this.y + 1);
        return 2;

      // --- sixteen-bit -------------------------------------------------------
      case 0xba: {
        const address = this.dpAddr(this.fetch());
        const value = this.read8(address) | (this.read8(this.dpAddr(address + 1)) << 8);
        this.ya = value;
        this.setFlag(F.Z, value === 0);
        this.setFlag(F.N, (value & 0x8000) !== 0);
        return 5;
      }
      case 0xda: {
        const address = this.dpAddr(this.fetch());
        this.write8(address, this.a);
        this.write8(this.dpAddr(address + 1), this.y);
        return 5;
      }
      case 0x3a:
      case 0x1a: {
        const address = this.dpAddr(this.fetch());
        const value =
          ((this.read8(address) | (this.read8(this.dpAddr(address + 1)) << 8)) +
            (op === 0x3a ? 1 : -1)) &
          0xffff;
        this.write8(address, value & 0xff);
        this.write8(this.dpAddr(address + 1), value >> 8);
        this.setFlag(F.Z, value === 0);
        this.setFlag(F.N, (value & 0x8000) !== 0);
        return 6;
      }
      case 0x7a:
      case 0x9a: {
        const address = this.dpAddr(this.fetch());
        const operand = this.read8(address) | (this.read8(this.dpAddr(address + 1)) << 8);
        const left = this.ya;
        const result = op === 0x7a ? left + operand : left - operand;
        this.setFlag(F.C, op === 0x7a ? result > 0xffff : result >= 0);
        const sign = op === 0x7a ? operand : ~operand;
        this.setFlag(F.V, ((left ^ result) & (sign ^ result) & 0x8000) !== 0);
        this.setFlag(F.H, ((left ^ operand ^ result) & 0x1000) !== 0);
        this.ya = result;
        this.setFlag(F.Z, (result & 0xffff) === 0);
        this.setFlag(F.N, (result & 0x8000) !== 0);
        return 5;
      }
      case 0x5a: {
        const address = this.dpAddr(this.fetch());
        const operand = this.read8(address) | (this.read8(this.dpAddr(address + 1)) << 8);
        const result = this.ya - operand;
        this.setFlag(F.C, result >= 0);
        this.setFlag(F.Z, (result & 0xffff) === 0);
        this.setFlag(F.N, (result & 0x8000) !== 0);
        return 4;
      }
      case 0xcf: {
        const result = this.y * this.a;
        this.ya = result;
        this.setNZ(this.y);
        return 9;
      }
      case 0x9e: {
        this.divide();
        return 12;
      }

      // --- moves -------------------------------------------------------------
      case 0xe8:
        this.a = this.setNZ(this.fetch());
        return 2;
      case 0xe4:
        this.a = this.setNZ(this.read8(this.dpAddr(this.fetch())));
        return 3;
      case 0xf4:
        this.a = this.setNZ(this.read8(this.dpAddr(this.fetch() + this.x)));
        return 4;
      case 0xe5:
        this.a = this.setNZ(this.read8(this.fetch16()));
        return 4;
      case 0xf5:
        this.a = this.setNZ(this.read8((this.fetch16() + this.x) & 0xffff));
        return 5;
      case 0xf6:
        this.a = this.setNZ(this.read8((this.fetch16() + this.y) & 0xffff));
        return 5;
      case 0xe6:
        this.a = this.setNZ(this.read8(this.dpAddr(this.x)));
        return 3;
      case 0xbf:
        this.a = this.setNZ(this.read8(this.dpAddr(this.x)));
        this.x = (this.x + 1) & 0xff;
        return 4;
      case 0xe7:
        this.a = this.setNZ(this.read8(this.indirectX()));
        return 6;
      case 0xf7:
        this.a = this.setNZ(this.read8(this.indirectY()));
        return 6;
      case 0xcd:
        this.x = this.setNZ(this.fetch());
        return 2;
      case 0xf8:
        this.x = this.setNZ(this.read8(this.dpAddr(this.fetch())));
        return 3;
      case 0xf9:
        this.x = this.setNZ(this.read8(this.dpAddr(this.fetch() + this.y)));
        return 4;
      case 0xe9:
        this.x = this.setNZ(this.read8(this.fetch16()));
        return 4;
      case 0x8d:
        this.y = this.setNZ(this.fetch());
        return 2;
      case 0xeb:
        this.y = this.setNZ(this.read8(this.dpAddr(this.fetch())));
        return 3;
      case 0xfb:
        this.y = this.setNZ(this.read8(this.dpAddr(this.fetch() + this.x)));
        return 4;
      case 0xec:
        this.y = this.setNZ(this.read8(this.fetch16()));
        return 4;
      case 0xc4:
        this.write8(this.dpAddr(this.fetch()), this.a);
        return 4;
      case 0xd4:
        this.write8(this.dpAddr(this.fetch() + this.x), this.a);
        return 5;
      case 0xc5:
        this.write8(this.fetch16(), this.a);
        return 5;
      case 0xd5:
        this.write8((this.fetch16() + this.x) & 0xffff, this.a);
        return 6;
      case 0xd6:
        this.write8((this.fetch16() + this.y) & 0xffff, this.a);
        return 6;
      case 0xc6:
        this.write8(this.dpAddr(this.x), this.a);
        return 4;
      case 0xaf:
        this.write8(this.dpAddr(this.x), this.a);
        this.x = (this.x + 1) & 0xff;
        return 4;
      case 0xc7:
        this.write8(this.indirectX(), this.a);
        return 7;
      case 0xd7:
        this.write8(this.indirectY(), this.a);
        return 7;
      case 0xd8:
        this.write8(this.dpAddr(this.fetch()), this.x);
        return 4;
      case 0xd9:
        this.write8(this.dpAddr(this.fetch() + this.y), this.x);
        return 5;
      case 0xc9:
        this.write8(this.fetch16(), this.x);
        return 5;
      case 0xcb:
        this.write8(this.dpAddr(this.fetch()), this.y);
        return 4;
      case 0xdb:
        this.write8(this.dpAddr(this.fetch() + this.x), this.y);
        return 5;
      case 0xcc:
        this.write8(this.fetch16(), this.y);
        return 5;
      case 0x8f: {
        const value = this.fetch();
        this.write8(this.dpAddr(this.fetch()), value);
        return 5;
      }
      case 0xfa: {
        const source = this.dpAddr(this.fetch());
        this.write8(this.dpAddr(this.fetch()), this.read8(source));
        return 5;
      }
      case 0x7d:
        this.a = this.setNZ(this.x);
        return 2;
      case 0x5d:
        this.x = this.setNZ(this.a);
        return 2;
      case 0xdd:
        this.a = this.setNZ(this.y);
        return 2;
      case 0xfd:
        this.y = this.setNZ(this.a);
        return 2;
      case 0x9d:
        this.x = this.setNZ(this.sp);
        return 2;
      case 0xbd:
        this.sp = this.x;
        return 2;

      // --- stack -------------------------------------------------------------
      case 0x2d:
        this.push(this.a);
        return 4;
      case 0x4d:
        this.push(this.x);
        return 4;
      case 0x6d:
        this.push(this.y);
        return 4;
      case 0x0d:
        this.push(this.psw);
        return 4;
      case 0xae:
        this.a = this.pull();
        return 4;
      case 0xce:
        this.x = this.pull();
        return 4;
      case 0xee:
        this.y = this.pull();
        return 4;
      case 0x8e:
        this.psw = this.pull();
        return 4;

      // --- branches and jumps ------------------------------------------------
      case 0x2f:
        return this.branch(true);
      case 0x10:
        return this.branch((this.psw & F.N) === 0);
      case 0x30:
        return this.branch((this.psw & F.N) !== 0);
      case 0x50:
        return this.branch((this.psw & F.V) === 0);
      case 0x70:
        return this.branch((this.psw & F.V) !== 0);
      case 0x90:
        return this.branch((this.psw & F.C) === 0);
      case 0xb0:
        return this.branch((this.psw & F.C) !== 0);
      case 0xd0:
        return this.branch((this.psw & F.Z) === 0);
      case 0xf0:
        return this.branch((this.psw & F.Z) !== 0);
      case 0x2e: {
        const value = this.read8(this.dpAddr(this.fetch()));
        return 3 + this.branch(this.a !== value);
      }
      case 0xde: {
        const value = this.read8(this.dpAddr(this.fetch() + this.x));
        return 4 + this.branch(this.a !== value);
      }
      case 0x6e: {
        const address = this.dpAddr(this.fetch());
        const value = (this.read8(address) - 1) & 0xff;
        this.write8(address, value);
        return 3 + this.branch(value !== 0);
      }
      case 0xfe:
        this.y = (this.y - 1) & 0xff;
        return 2 + this.branch(this.y !== 0);
      case 0x5f:
        this.pc = this.fetch16();
        return 3;
      case 0x1f:
        this.pc = this.readWord((this.fetch16() + this.x) & 0xffff);
        return 6;
      case 0x3f: {
        const target = this.fetch16();
        this.push((this.pc >> 8) & 0xff);
        this.push(this.pc & 0xff);
        this.pc = target;
        return 8;
      }
      case 0x4f: {
        const target = 0xff00 | this.fetch();
        this.push((this.pc >> 8) & 0xff);
        this.push(this.pc & 0xff);
        this.pc = target;
        return 6;
      }
      case 0x6f:
        this.pc = this.pull() | (this.pull() << 8);
        return 5;
      case 0x7f:
        this.psw = this.pull();
        this.pc = this.pull() | (this.pull() << 8);
        return 6;

      // --- flags and the odds and ends ---------------------------------------
      case 0x00:
        return 2;
      case 0x20:
        this.setFlag(F.P, false);
        return 2;
      case 0x40:
        this.setFlag(F.P, true);
        return 2;
      case 0x60:
        this.setFlag(F.C, false);
        return 2;
      case 0x80:
        this.setFlag(F.C, true);
        return 2;
      case 0xed:
        this.setFlag(F.C, (this.psw & F.C) === 0);
        return 3;
      case 0xe0:
        this.setFlag(F.V, false);
        this.setFlag(F.H, false);
        return 2;
      case 0xa0:
        this.setFlag(F.I, true);
        return 3;
      case 0xc0:
        this.setFlag(F.I, false);
        return 3;
      case 0x9f:
        this.a = this.setNZ((this.a >> 4) | (this.a << 4));
        return 5;
      case 0xef:
      case 0xff:
        // `sleep` and `stop` both halt the processor; only a reset restarts it.
        this.stopped = true;
        return 2;
      case 0x0f:
        // `brk` has no vector worth honouring in a driver, so it halts loudly
        // rather than running off into RAM.
        this.stopped = true;
        return 8;
      case 0x0e:
      case 0x4e: {
        const address = this.fetch16();
        const value = this.read8(address);
        this.setNZ((this.a - value) & 0xff);
        this.write8(address, op === 0x0e ? value | this.a : value & ~this.a & 0xff);
        return 6;
      }

      default:
        return this.bitwise(op);
    }
  }

  /**
   * The bit instructions, which are the rest of the map.
   *
   * `set1`/`clr1`/`bbs`/`bbc` carry their bit number in the *opcode*, `$20`
   * apart, so they are decoded arithmetically rather than as sixty-four cases;
   * the carry-bit group packs a thirteen-bit address and a three-bit index into
   * one operand word.
   */
  private bitwise(op: number): number {
    if ((op & 0x0f) === 0x01) {
      // `tcall n` — a call through a vector table at the top of memory. Its
      // index is the *high* nibble, so it is sixteen opcodes apart rather than
      // the bit instructions' thirty-two.
      const target = this.readWord(0xffde - (op >> 4) * 2);
      this.push((this.pc >> 8) & 0xff);
      this.push(this.pc & 0xff);
      this.pc = target;
      return 8;
    }
    const low = op & 0x1f;
    const bit = (op >> 5) & 0x07;
    if (low === 0x02 || low === 0x12) {
      const address = this.dpAddr(this.fetch());
      const value = this.read8(address);
      this.write8(address, low === 0x02 ? value | (1 << bit) : value & ~(1 << bit) & 0xff);
      return 4;
    }
    if (low === 0x03 || low === 0x13) {
      const value = this.read8(this.dpAddr(this.fetch()));
      const set = (value & (1 << bit)) !== 0;
      return 3 + this.branch(low === 0x03 ? set : !set);
    }
    if (low === 0x0a) {
      const operand = this.fetch16();
      const address = operand & 0x1fff;
      const index = (operand >> 13) & 0x07;
      const value = (this.read8(address) >> index) & 1;
      const carry = (this.psw & F.C) !== 0 ? 1 : 0;
      switch (op) {
        case 0x0a:
          this.setFlag(F.C, (carry | value) !== 0);
          return 5;
        case 0x2a:
          this.setFlag(F.C, (carry | (value ^ 1)) !== 0);
          return 5;
        case 0x4a:
          this.setFlag(F.C, (carry & value) !== 0);
          return 4;
        case 0x6a:
          this.setFlag(F.C, (carry & (value ^ 1)) !== 0);
          return 4;
        case 0x8a:
          this.setFlag(F.C, (carry ^ value) !== 0);
          return 5;
        case 0xaa:
          this.setFlag(F.C, value !== 0);
          return 4;
        case 0xca: {
          const byte = this.read8(address);
          this.write8(address, carry !== 0 ? byte | (1 << index) : byte & ~(1 << index) & 0xff);
          return 6;
        }
        default: {
          const byte = this.read8(address);
          this.write8(address, byte ^ (1 << index));
          return 5;
        }
      }
    }
    // `daa` and `das` are the only opcodes left, and a generated driver emits
    // neither: this CPU's decimal adjust has no caller here.
    return 3;
  }

  private compare(left: number, right: number): void {
    const result = left - right;
    this.setFlag(F.C, result >= 0);
    this.setNZ(result);
  }

  private indirectX(): number {
    const offset = this.dpAddr(this.fetch() + this.x);
    return this.read8(offset) | (this.read8(this.dpAddr(offset + 1)) << 8);
  }

  private indirectY(): number {
    const offset = this.dpAddr(this.fetch());
    const base = this.read8(offset) | (this.read8(this.dpAddr(offset + 1)) << 8);
    return (base + this.y) & 0xffff;
  }

  /**
   * `div ya,x` — sixteen by eight, with the hardware's own overflow behaviour.
   *
   * Above a quotient of 255 the chip does not produce a wrong answer politely;
   * it produces a specific wrong answer, and `V` says so. A driver never divides
   * by anything that could overflow, but a model that quietly clamped would be
   * the kind of difference that only shows up in someone else's program.
   */
  private divide(): void {
    const value = this.ya;
    this.setFlag(F.H, (this.x & 0x0f) <= (this.y & 0x0f));
    this.setFlag(F.V, this.y >= this.x);
    if (this.x === 0) {
      this.a = 0xff;
      this.y = 0xff;
    } else if (this.y < this.x * 2) {
      this.a = Math.floor(value / this.x) & 0xff;
      this.y = value % this.x;
    } else {
      const spill = value - this.x * 512;
      this.a = (255 - Math.floor(spill / (256 - this.x))) & 0xff;
      this.y = (this.x + (spill % (256 - this.x))) & 0xff;
    }
    this.setNZ(this.a);
  }
}
