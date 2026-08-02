/**
 * The second processor, and the hardware only it can reach.
 *
 * A Nintendo DS is two computers sharing four megabytes, and which one a piece of
 * hardware answers to is not negotiable: **the sound channels are the ARM7's
 * alone**. An ARM9 store to `$4000400` reaches nothing at all. So a cartridge
 * that wants sound carries a second program, the loader copies it into main RAM
 * beside the first, and the two talk by writing bytes the other one reads —
 * which is the whole of the arrangement `@demake/audio`'s ARM7 driver was written
 * against (`rom/nds-game.ts`).
 *
 * What is here is that processor's *world*, and it is deliberately small:
 *
 *   - **Main RAM, shared.** The same `Uint8Array` the ARM9 has, because that is
 *     the point. No cache is modelled on either side, which is the hardware a
 *     demade cartridge presents: this core's ARM9 program never enables one.
 *   - **Its own 64 KiB**, mirrored across the whole `$3xxxxxx` window because
 *     `WRAMCNT` comes up giving the shared block to the ARM9 — the state the
 *     driver is written against, and the reason it keeps its cursors there.
 *   - **Four timers**, including the count-up chaining that makes this console's
 *     audio clock a *tally* rather than a flag (`nds-driver.ts` §the clock).
 *   - **The sound channels**, which are `@demake/chip`'s `NdsSpu` and not a
 *     second model — the rule every core in this repo is under.
 *
 * Two absences, named rather than left to be found. **Interrupts are not
 * modelled**, on this processor for the same reason as on the other one: nothing
 * demake emits enables one, because the driver's clock is a counter it reads. And
 * **the ARM7's own peripherals** — the touchscreen, the microphone, the real-time
 * clock, wireless — are absent entirely; a demade cartridge's second program
 * drives the sound and nothing else, and an access to any of them raises rather
 * than answering plausibly.
 *
 * Sources: GBATEK — *DS Memory Maps*, *DS Sound Channels*, *DS Timers*
 * (https://problemkaputt.de/gbatek.htm).
 */

import { NdsSpu, NDS_RAM_BASE, type SampleSink } from "@demake/chip";
import { Arm7, type Bus } from "@demake/gba";

/** Bytes of the ARM7's private work RAM. */
const ARM7_WRAM_SIZE = 0x10000;

/** Where the sound channels and the master volume answer. */
const SOUND_BASE = 0x400;
const SOUND_END = 0x520;

/** Where the timers answer, four of four bytes each. */
const TIMER_BASE = 0x100;
const TIMER_END = 0x110;

/** What each of the four prescaler settings divides the system clock by. */
const PRESCALERS = [1, 64, 256, 1024] as const;

/** The system clock, which is what one ARM7 cycle is. */
export const ARM7_CLOCK_HZ = 33513982;

/**
 * Sound clocks per ARM7 cycle, as a divisor.
 *
 * The channels count at half the system clock, so the sound side advances one
 * clock every two cycles — an exact halving rather than a ratio, which is why
 * `NdsSpu.clockHz` is 16756991 and not a rounding of anything.
 */
const SOUND_DIVISOR = 2;

/** Raised when the second program asks for hardware this core does not model. */
export class Arm7Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Arm7Error";
  }
}

/** One timer's registers and where its counter has got to. */
interface Timer {
  reload: number;
  control: number;
  counter: number;
  /** Prescaler clocks not yet worth a count. */
  fraction: number;
}

function newTimer(): Timer {
  return { reload: 0, control: 0, counter: 0, fraction: 0 };
}

/** The sound processor: an ARM7TDMI, its memory, its timers and the channels. */
export class Arm7Machine implements Bus {
  readonly cpu = new Arm7(this);
  /** The channels, which are `@demake/chip`'s model and not a second one. */
  readonly spu = new NdsSpu();
  /** Its private 64 KiB, which the other processor cannot see. */
  readonly wram = new Uint8Array(ARM7_WRAM_SIZE);

  /**
   * Everything the channels receive, observed rather than intercepted.
   *
   * Doc 16's Level A proof taps this: a register number in the chip's own
   * numbering (which is its offset from `$4000400`) and the byte written.
   */
  spuTap: ((reg: number, value: number, chip: number) => void) | undefined = undefined;

  /**
   * Called with the program counter before every instruction, when set.
   *
   * The Super Nintendo's `smp.pcTap` and the same reason: the two processors run
   * on unrelated clocks, so a host stepping the game one instruction at a time
   * may advance this one by several — and a harness sampling afterwards would
   * miss a driver tick beginning and ending inside a single step.
   */
  pcTap: ((pc: number) => void) | undefined = undefined;

  /** Where the channels' output goes when anything is listening. */
  audioSink: SampleSink | undefined = undefined;

  private readonly timers: Timer[] = [newTimer(), newTimer(), newTimer(), newTimer()];
  /** ARM7 cycles not yet spent on the sound side's slower clock. */
  private soundFraction = 0;
  /** Cycles owed, so a step that overran one call is paid for in the next. */
  private debt = 0;

  /**
   * @param ram the four megabytes both processors share, which is where this
   * program, its waveform bank and the game's request bytes all live.
   * @param entry where the loader left this program's first instruction.
   */
  constructor(
    private readonly ram: Uint8Array,
    entry: number,
  ) {
    this.spu.setRam(ram, NDS_RAM_BASE);
    // The stacks are this program's own, as they are on the other processor: it
    // sets its own on its first instruction, and these are what a program that
    // forgot would fall back on.
    this.cpu.reset(entry, { sys: 0x0380ff00, irq: 0x0380fe00, svc: 0x0380fd00 });
  }

  // --- the bus ---------------------------------------------------------------

  /**
   * Extra cycles an access costs.
   *
   * Main RAM is a sixteen-bit bus this processor reaches through the same
   * arbiter the ARM9 uses, and it is where the driver's packed data lives; its
   * own work RAM and the I/O page are on the fast bus. Charging for it is what
   * keeps a measurement of the driver's cost honest.
   */
  wait(address: number, width: 1 | 2 | 4): number {
    return ((address >>> 24) & 0xf) === 0x2 ? (width === 4 ? 6 : 3) : 0;
  }

  read8(address: number): number {
    const at = address >>> 0;
    switch ((at >>> 24) & 0xf) {
      case 0x2:
        return this.ram[at & (this.ram.length - 1)] as number;
      case 0x3:
        return this.wram[at & (ARM7_WRAM_SIZE - 1)] as number;
      case 0x4:
        return this.readIo(at & 0xffffff);
      default:
        throw new Arm7Error(
          `the sound processor read $${at.toString(16)}, which is hardware this core does not model`,
        );
    }
  }

  read16(address: number): number {
    const at = address & ~1;
    return (this.read8(at) | (this.read8(at + 1) << 8)) & 0xffff;
  }

  read32(address: number): number {
    const at = address & ~3;
    return (this.read16(at) | (this.read16(at + 2) << 16)) >>> 0;
  }

  write8(address: number, value: number): void {
    const at = address >>> 0;
    const byte = value & 0xff;
    switch ((at >>> 24) & 0xf) {
      case 0x2:
        this.ram[at & (this.ram.length - 1)] = byte;
        return;
      case 0x3:
        this.wram[at & (ARM7_WRAM_SIZE - 1)] = byte;
        return;
      case 0x4:
        this.writeIo(at & 0xffffff, byte);
        return;
      default:
        throw new Arm7Error(
          `the sound processor wrote $${at.toString(16)}, which is hardware this core does not model`,
        );
    }
  }

  write16(address: number, value: number): void {
    const at = address & ~1;
    this.write8(at, value & 0xff);
    this.write8(at + 1, (value >> 8) & 0xff);
  }

  write32(address: number, value: number): void {
    const at = address & ~3;
    this.write16(at, value & 0xffff);
    this.write16(at + 2, (value >>> 16) & 0xffff);
  }

  // --- registers -------------------------------------------------------------

  private readIo(at: number): number {
    if (at >= TIMER_BASE && at < TIMER_END) {
      const timer = this.timers[(at - TIMER_BASE) >> 2] as Timer;
      // The counter reads back and the control byte reads back; the reload does
      // not, because on this hardware the same address is two registers.
      switch ((at - TIMER_BASE) & 3) {
        case 0:
          return timer.counter & 0xff;
        case 1:
          return (timer.counter >> 8) & 0xff;
        case 2:
          return timer.control & 0xff;
        default:
          return (timer.control >> 8) & 0xff;
      }
    }
    if (at >= SOUND_BASE && at < SOUND_END) return this.spu.read(at - SOUND_BASE);
    throw new Arm7Error(
      `the sound processor read register $${at.toString(16)}; this core models the timers and the sound channels`,
    );
  }

  private writeIo(at: number, value: number): void {
    if (at >= TIMER_BASE && at < TIMER_END) {
      this.writeTimer(at - TIMER_BASE, value);
      return;
    }
    if (at >= SOUND_BASE && at < SOUND_END) {
      const reg = at - SOUND_BASE;
      this.spu.write(reg, value);
      this.spuTap?.(reg, value, 0);
      return;
    }
    throw new Arm7Error(
      `the sound processor wrote register $${at.toString(16)}; this core models the timers and the sound channels`,
    );
  }

  /**
   * A timer's four bytes: two of reload and two of control.
   *
   * Starting a stopped timer loads the counter from the reload, which is the
   * hardware's own behaviour and the reason the driver can arm the counting timer
   * before the one that feeds it.
   */
  private writeTimer(offset: number, value: number): void {
    const timer = this.timers[offset >> 2] as Timer;
    const byte = value & 0xff;
    switch (offset & 3) {
      case 0:
        timer.reload = (timer.reload & 0xff00) | byte;
        return;
      case 1:
        timer.reload = (timer.reload & 0x00ff) | (byte << 8);
        return;
      default: {
        const before = timer.control;
        timer.control =
          (offset & 3) === 2 ? (before & 0xff00) | byte : (before & 0x00ff) | (byte << 8);
        if ((before & 0x80) === 0 && (timer.control & 0x80) !== 0) {
          timer.counter = timer.reload;
          timer.fraction = 0;
        }
      }
    }
  }

  /** Advance the timers by `cycles` of the system clock. */
  private clockTimers(cycles: number): void {
    for (let index = 0; index < this.timers.length; index += 1) {
      const timer = this.timers[index] as Timer;
      if ((timer.control & 0x80) === 0) continue;
      // A count-up timer is advanced by the one below it and not by the clock,
      // which is what makes a chained pair a tally of overflows.
      if (index > 0 && (timer.control & 0x04) !== 0) continue;
      const prescale = PRESCALERS[timer.control & 3] as number;
      timer.fraction += cycles;
      const steps = (timer.fraction / prescale) | 0;
      timer.fraction -= steps * prescale;
      if (steps > 0) this.advanceTimer(index, steps);
    }
  }

  /** Add `steps` to a timer, cascading each overflow into the next one. */
  private advanceTimer(index: number, steps: number): void {
    const timer = this.timers[index] as Timer;
    let remaining = steps;
    while (remaining > 0) {
      const room = 0x10000 - timer.counter;
      if (remaining < room) {
        timer.counter += remaining;
        return;
      }
      remaining -= room;
      timer.counter = timer.reload;
      const next = this.timers[index + 1];
      if (next !== undefined && (next.control & 0x80) !== 0 && (next.control & 0x04) !== 0) {
        this.advanceTimer(index + 1, 1);
      }
    }
  }

  // --- running ---------------------------------------------------------------

  /**
   * Run this processor for `cycles` of *its* clock, and clock what it drives.
   *
   * Whole instructions, with the remainder carried: a step that ran past the
   * budget is paid for out of the next call rather than rounded away, so the two
   * processors stay in a fixed relationship however finely the host interleaves
   * them.
   */
  run(cycles: number): void {
    this.debt += cycles;
    while (this.debt > 0) {
      this.pcTap?.(this.cpu.pc);
      const used = this.cpu.step();
      this.debt -= used;
      this.clockTimers(used);
      if (this.audioSink) {
        this.soundFraction += used;
        const clocks = (this.soundFraction / SOUND_DIVISOR) | 0;
        this.soundFraction -= clocks * SOUND_DIVISOR;
        if (clocks > 0) this.spu.run(clocks, this.audioSink);
      }
    }
  }
}
