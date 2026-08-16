/**
 * The TLCS-900/H's four 8-bit interval timers, as much of them as a demade
 * cartridge uses.
 *
 * Nothing on this console needed one until a cartridge whose *only* job is a
 * schedule turned up: a demade game rides the picture's own interrupt, because
 * its music and effects share one clock with the frame (doc 16 §Two streams, one
 * clock). A standalone audio cartridge has no picture to share with and a
 * schedule that may ask for a rate the frame cannot express, so it programs a
 * timer — and a timer this project could not model is a cartridge whose Level A
 * proof does not exist (doc 13 §A5).
 *
 * What is here is the **8-bit interval timer mode** and the compare match that
 * ends it. Four things about the block shape this file and each is the
 * hardware's rather than a simplification:
 *
 *   - **The prescaler is shared and it is gated.** One 9-bit prescaler feeds all
 *     four timers, and `TRUN`'s top bit runs it — so a cartridge that programmes
 *     a reload and starts its timer without also starting the prescaler counts
 *     nothing at all. Clearing either bit *clears* the counter rather than
 *     pausing it.
 *   - **The two timers of a pair do not offer the same clocks.** A lower timer
 *     takes φT1, φT4 or φT16 and an upper one φT1, φT16 or φT256
 *     (`NGP_T0CLK`/`NGP_T1CLK`), so which timer a driver picks decides what
 *     rates it can keep. Selection 0 is not a division on either: it is the
 *     external pin below and the partner's comparator output above, and this
 *     model refuses both rather than pretending a rate.
 *   - **The period is the reload**, because a match clears the up-counter — so
 *     `TREG = N` is N input clocks and `TREG = 0` is 256 of them.
 *   - **The priority is the enable.** A timer's interrupt is armed by writing a
 *     level of 1 to 6 into its nibble of `INTET01`; **both 0 and 7 refuse it**,
 *     which is the trap in that field and the one thing here a driver is most
 *     likely to get wrong in a way nothing else would report.
 *
 * **Nothing routes the register page here yet, and that is deliberate.** `Ngp`
 * does not call {@link Timers.write}, because the two descriptions this project
 * holds about that page *collide*: Toshiba's datasheet puts `TRUN` at I/O `$20`,
 * and `NGP_SOUND_RIGHT` — cited from MAME's own NGP driver — is the same byte.
 * They cannot both be plain bytes of one 128-byte page, and which is wrong is
 * not something either source settles. Wiring this in on the datasheet's reading
 * swallows every write to the sound chip's right-hand port, which is how the
 * conflict was found: a cartridge that booted, unlocked the chip, programmed a
 * timer and then went silent (doc 13 §A5).
 *
 * So this file is a *tested description of the block* and not yet a peripheral.
 * It costs nothing to keep and the moment the address question is answered the
 * standalone cartridge is a boot sequence, a clock and a wrapper — everything
 * else it needs is already written. What it must not become in the meantime is a
 * timer a cartridge can programme, because a cartridge built on a page this
 * project has two answers for is the wrong-and-consistent failure with the
 * consistency removed.
 *
 * When it is wired in, the interrupt dispatches the way every other one on this
 * machine does: through a pointer the cartridge writes into the boot ROM's
 * table, which is `Ngp`'s job rather than this file's.
 *
 * Modes this does not implement — the 16-bit cascade, PPG and PWM — are absent
 * rather than approximated, and `Timers.write` records a request for one so the
 * machine can refuse it by name instead of silently interval-timing.
 *
 * Sources: Toshiba TMP95C061 datasheet §3.8 (8-bit timers) — the up-counter and
 * prescaler sections, Figures 3.8 (4) and 3.8 (7), and the interrupt-enable
 * table of §3.3.
 */

import {
  NGP_INTET01,
  NGP_INTET23,
  NGP_INT_PRIORITY_MAX,
  NGP_T01M,
  NGP_T01MOD,
  NGP_T01M_SHIFT,
  NGP_T0CLK_DIVISORS,
  NGP_T0CLK_SHIFT,
  NGP_T1CLK_DIVISORS,
  NGP_T1CLK_SHIFT,
  NGP_TREG0,
  NGP_TREG1,
  NGP_TREG2,
  NGP_TREG3,
  NGP_TRUN,
  NGP_TRUN_BITS,
} from "@demake/core";

/** How many 8-bit timers there are. */
const TIMERS = 4;

/** Which of the four each pair's registers belong to. */
const PAIRS = [
  { mode: NGP_T01MOD, enable: NGP_INTET01, lower: 0, upper: 1 },
  { mode: NGP_T01MOD + 4, enable: NGP_INTET23, lower: 2, upper: 3 },
] as const;

/**
 * The second pair's mode register.
 *
 * `T23MOD` is at `$28`, which is `T01MOD` plus four — stated as the sum in
 * {@link PAIRS} so the two are visibly one layout rather than two constants that
 * happen to be near each other.
 */
export const NGP_T23MOD = NGP_T01MOD + 4;

/** One timer's programming, as the registers currently say it. */
interface Timer {
  /** Compare value; the period in input clocks, with 0 meaning 256. */
  reload: number;
  /** Input clocks per count, or 0 for a selection this model will not run. */
  divisor: number;
  /** Whether `TRUN` says this timer counts. */
  running: boolean;
  /** Interrupt priority, 1-6 to accept and 0 or 7 to refuse. */
  priority: number;
  /** The up-counter. */
  count: number;
  /** Fractional system clocks carried between steps. */
  cycles: number;
}

/** Which timer raised, and whether anything is armed. */
export interface TimerFire {
  /** Index of the timer whose compare matched. */
  timer: number;
}

export class Timers {
  private readonly timers: Timer[] = Array.from({ length: TIMERS }, () => ({
    reload: 0,
    divisor: 0,
    running: false,
    priority: 0,
    count: 0,
    cycles: 0,
  }));

  /** Whether the shared prescaler is running, which gates every timer. */
  private prescaler = false;

  /**
   * A mode this model does not implement, named rather than approximated.
   *
   * Read by the machine so a cartridge asking for the 16-bit cascade, PPG or PWM
   * is refused by name — a model that ran an interval timer instead would keep
   * a schedule's tempo in our core and lose it on the board.
   */
  unsupported: string | undefined = undefined;

  /** Reset to what a power-on leaves: every bit of every register zero. */
  reset(): void {
    for (const timer of this.timers) {
      timer.reload = 0;
      timer.divisor = 0;
      timer.running = false;
      timer.priority = 0;
      timer.count = 0;
      timer.cycles = 0;
    }
    this.prescaler = false;
    this.unsupported = undefined;
  }

  /** Whether an address is one of the block's registers. */
  static owns(address: number): boolean {
    if (address === NGP_TRUN || address === NGP_T01MOD || address === NGP_T23MOD) return true;
    if (address === NGP_INTET01 || address === NGP_INTET23) return true;
    return (
      address === NGP_TREG0 ||
      address === NGP_TREG1 ||
      address === NGP_TREG2 ||
      address === NGP_TREG3
    );
  }

  /**
   * Take a register write.
   *
   * The timer registers are documented **write-only**, so nothing here keeps a
   * readable shadow: what a caller can observe is the interrupt, which is the
   * only thing a cartridge can observe either.
   */
  write(address: number, value: number): void {
    const byte = value & 0xff;
    switch (address) {
      case NGP_TRUN: {
        // Clearing a run bit *clears* the counter rather than pausing it, and
        // the prescaler's bit does it to all four at once — which is why a
        // cartridge programmes the reload before it starts anything.
        const wasPrescaler = this.prescaler;
        this.prescaler = (byte & (1 << NGP_TRUN_BITS.prescaler)) !== 0;
        if (!this.prescaler && wasPrescaler) for (const t of this.timers) this.clear(t);
        for (let index = 0; index < TIMERS; index += 1) {
          const timer = this.timers[index] as Timer;
          const running = (byte & (1 << index)) !== 0;
          if (!running && timer.running) this.clear(timer);
          timer.running = running;
        }
        return;
      }
      case NGP_TREG0:
      case NGP_TREG1:
      case NGP_TREG2:
      case NGP_TREG3: {
        const index =
          address === NGP_TREG0 ? 0 : address === NGP_TREG1 ? 1 : address === NGP_TREG2 ? 2 : 3;
        (this.timers[index] as Timer).reload = byte;
        return;
      }
      default:
        break;
    }
    for (const pair of PAIRS) {
      if (address === pair.mode) {
        const mode = (byte >> NGP_T01M_SHIFT) & 3;
        if (mode !== NGP_T01M.two8Bit) {
          this.unsupported = `timer mode ${mode} (only the two-8-bit-timer mode is implemented)`;
          return;
        }
        (this.timers[pair.lower] as Timer).divisor =
          NGP_T0CLK_DIVISORS[(byte >> NGP_T0CLK_SHIFT) & 3] ?? 0;
        (this.timers[pair.upper] as Timer).divisor =
          NGP_T1CLK_DIVISORS[(byte >> NGP_T1CLK_SHIFT) & 3] ?? 0;
        return;
      }
      if (address === pair.enable) {
        // Three bits of priority and a request flag, a nibble per timer. The
        // priority *is* the enable, and both 0 and 7 refuse — so this is a
        // range test rather than a bit test, which is the whole trap in the
        // field (`core/src/asm/ngp.ts` §NGP_INTET01).
        (this.timers[pair.lower] as Timer).priority = byte & 0x07;
        (this.timers[pair.upper] as Timer).priority = (byte >> 4) & 0x07;
        return;
      }
    }
  }

  /**
   * Advance every running timer by `cycles` of the **system** clock, and report
   * a compare match.
   *
   * The system clock rather than the crystal, because that is what
   * `NGP_T1CLK_DIVISORS` divides and what one processor state is — so a caller
   * hands this what the CPU spent and nothing has to be scaled.
   *
   * **One armed timer at a time is what this models**, and the second is
   * refused rather than dropped. The hardware latches a request flip-flop per
   * channel and takes them in priority order, so two that match together are
   * both eventually served; this has no pending queue, and a model that
   * returned the lower index and forgot the other would lose one interrupt in
   * every alias — silently, and worst where the two rates divide evenly, which
   * is exactly where a driver would put them. Nothing this project builds arms
   * more than one: a standalone audio cartridge has a single tick and a game
   * programmes no timer at all. So a second arrival names itself in
   * {@link unsupported} and the machine refuses the cartridge.
   */
  step(cycles: number): TimerFire | undefined {
    if (!this.prescaler) return undefined;
    let fired: TimerFire | undefined;
    for (let index = 0; index < TIMERS; index += 1) {
      const timer = this.timers[index] as Timer;
      if (!timer.running || timer.divisor === 0) continue;
      timer.cycles += cycles;
      const ticks = Math.floor(timer.cycles / timer.divisor);
      if (ticks <= 0) continue;
      timer.cycles -= ticks * timer.divisor;
      // The period is the reload itself, because a match clears the counter —
      // and a reload of zero is a full 256 rather than a timer that fires on
      // every clock (`core/src/asm/ngp.ts` §NGP_TREG0).
      const period = timer.reload === 0 ? 256 : timer.reload;
      timer.count += ticks;
      if (timer.count < period) continue;
      timer.count %= period;
      if (!this.accepts(timer)) continue;
      if (fired !== undefined) {
        this.unsupported = `timers ${fired.timer} and ${index} both raised (no pending queue is modelled)`;
        continue;
      }
      fired = { timer: index };
    }
    return fired;
  }

  /** Whether this timer's priority nibble accepts the interrupt. */
  private accepts(timer: Timer): boolean {
    return timer.priority >= 1 && timer.priority <= NGP_INT_PRIORITY_MAX;
  }

  private clear(timer: Timer): void {
    timer.count = 0;
    timer.cycles = 0;
  }
}
