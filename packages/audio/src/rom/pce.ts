/**
 * The PC Engine audio driver: a bootable HuCard that plays a `ChipScript`.
 *
 * The third standalone cartridge, and the one that measures what the second one
 * proved: **the stream player is the processor's**. `mos-player.ts` is not
 * touched here at all — a HuC6280 *is* a 6502, so the same walk that plays a
 * 2A03 plays six wavetables — and what this file owns is the three things the
 * machine decides for itself. Two of them are the NES's questions with different
 * answers and the third is a question the NES does not have.
 *
 *   - **The clock is the CPU's own timer**, seven bits of reload at master ÷ 3 ÷
 *     1024, so this console gets the Game Boy's clock discipline rather than the
 *     NES's frame. `AudioInit` programmes two registers and nothing else; which
 *     interrupts the cartridge answers is the *reset's* policy, which is why the
 *     mask is in the boot stub below.
 *   - **The registers are somewhere else**, at `$0800` in the hardware page the
 *     boot code maps at logical zero, so the player is handed a base rather than
 *     having one. That is the whole of `MosStreamOptions.base`'s reason for
 *     existing.
 *   - **The program is not where it was assembled.** The mapper's eight pages
 *     have to hold the hardware, work RAM, the code and the data, and reset maps
 *     only bank 0 at `$E000` — so the boot stub is emitted *last*, padded to
 *     `$E000`, and the two halves of the window are swapped on the way into the
 *     image. A build that wrote them in the obvious order boots into the middle
 *     of the packed schedule.
 *
 * Sources:
 * - Archaic Pixels — Memory mapping: https://archaicpixels.com/Memory_Mapping
 * - Charles MacDonald — PC Engine hardware notes (`pcetech.txt`), §Timer, §IRQ
 */

import {
  abs,
  absX,
  Asm6280,
  AsmError,
  imm,
  immHigh,
  immLow,
  indY,
  label,
  packHuCard,
  PCE_BANK_SIZE,
  zp,
} from "@demake/core";

import type { RegisterWrite } from "@demake/chip";

import { bindingFor } from "../binding/registry.js";
import type { ChipScript } from "../chipscript.js";

import { packScript, PackError, type DriverData } from "./data.js";
import { emitStream, emitStreamData, PSG_BASE, type MosStreamState } from "./mos-player.js";
import { stripBoot } from "./shared.js";
import { AudioRomError, type AudioRomOptions, type BuiltAudioRom } from "./gb.js";

/** Where the code and data are assembled, and where the boot stub goes. */
const CODE_ORIGIN = 0x4000;
const BOOT_ORIGIN = 0xe000;
const WINDOW_SIZE = 0x10000 - CODE_ORIGIN;

/** The ten bytes of vectors at the top of bank 0, which the code may not reach. */
const VECTOR_BYTES = 10;

/**
 * The interrupt controller, in the hardware page.
 *
 * Writing the status register acknowledges whatever raised the interrupt, which
 * on this chip is how a handler stops being re-entered rather than a flag it
 * clears somewhere else.
 */
const IRQ_MASK = 0x1402;
const IRQ_STATUS = 0x1403;

/**
 * Every source masked but the timer.
 *
 * Bit 0 is IRQ2, bit 1 the video chip and bit 2 the timer, and a *set* bit is a
 * masked one — so `$03` is "the timer only". A game leaves the video chip
 * unmasked because the picture needs it; a cartridge whose only job is sound has
 * no picture to wait for and would be taking an interrupt for nothing.
 */
const IRQ_TIMER_ONLY = 0x03;

/** The CPU's timer: a seven-bit reload, and a one-bit run flag. */
const TIMER_RELOAD = 0x0c00;
const TIMER_CONTROL = 0x0c01;
const MAX_TIMER_RELOAD = 0x7f;

/**
 * Driver state, in the cheap page — which on this CPU is at `$2000`.
 *
 * The processor adds that base to every zero-page operand and no memory map
 * moves it, so these are *offsets* and the addresses are the machine's. The
 * block and order pointers are dereferenced through `($nn),y`, which is the only
 * indirection this processor has, so they have to live here and be adjacent.
 */
const STATE: MosStreamState & { count: number; flags: number } = {
  dataLo: 0x00,
  dataHi: 0x01,
  orderLo: 0x02,
  orderHi: 0x03,
  loopLo: 0x04,
  loopHi: 0x05,
  rest: 0x06,
  count: 0x07,
  flags: 0x08,
};

/** The timer reload the schedule's rate asks for. */
interface Clock {
  reload: number;
  rate: { num: number; den: number };
}

/**
 * Resolve the schedule's clock to the reload the timer is programmed with.
 *
 * A `ChipScript` carries the reload as well as the exact rate, because a ROM
 * programmes a register and re-deriving one from a rational would be a second
 * timing fit that could disagree with the first (doc 16 §Anything that stores a
 * driver rate).
 */
export function resolvePceAudioClock(script: ChipScript): Clock {
  const { rate, source, divisor } = script.driver;
  if (source !== "timer") {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `the pce driver has no '${source}' clock`,
      "this CPU has a timer nothing else in an audio cartridge uses; re-arrange with `timer`.",
    );
  }
  if (divisor === undefined || divisor < 0 || divisor > MAX_TIMER_RELOAD) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `${rate.num / rate.den} Hz needs a timer reload of ${String(divisor)}` +
        `, and the register holds 0–${MAX_TIMER_RELOAD}`,
      "the schedule's rate and reload disagree; this is a bug in the timing fit, not in the track.",
    );
  }
  return { reload: divisor, rate };
}

/**
 * Build a HuCard that plays this schedule.
 *
 * The caller has already been told the console is a PC Engine — `buildAudioRom`
 * in `index.ts` is where a console with no driver backend is refused, on the "a
 * backend gap is a build error, never a silent difference" rule.
 */
export function buildPceAudioRom(script: ChipScript, options: AudioRomOptions = {}): BuiltAudioRom {
  void options; // a HuCard carries no title field
  const clock = resolvePceAudioClock(script);
  // The chip's initialisation comes off the head of the stream and is performed
  // once, at boot. On this console that is not a tidy-up: a waveform is
  // thirty-two writes through the register port and there are five of them, so
  // tick 0 arrives with more writes in it than the packed format's run count can
  // hold — the *only* console in the set where the boot strip is what makes a
  // schedule packable at all rather than merely what stops an effect powering
  // the chip up again.
  const boot = bindingFor(script.console).init();
  const performed = stripBoot(script, boot);
  let data: DriverData;
  try {
    data = packScript(performed);
  } catch (error) {
    if (error instanceof PackError) throw new AudioRomError(error.code, error.message, error.hint);
    throw error;
  }

  const asm = new Asm6280(CODE_ORIGIN);
  const { helpers, dataStart, codeEnd } = emitDriver(asm, data, clock, boot);

  let code: Uint8Array;
  try {
    code = asm.assemble();
  } catch (error) {
    if (error instanceof AsmError) {
      throw new AudioRomError(
        "E_INTERNAL",
        `the driver emitter produced invalid code: ${error.message}`,
      );
    }
    throw error;
  }

  // The image is the window, rearranged into cartridge banks. Reset maps bank 0
  // at `$E000`, so the *top* 8 KiB of the window is bank 0 and everything below
  // it follows — which is why the boot stub is emitted last and why the halves
  // are swapped here rather than assembled in this order.
  const split = BOOT_ORIGIN - CODE_ORIGIN;
  const banks = new Uint8Array(WINDOW_SIZE);
  banks.set(code.subarray(split, WINDOW_SIZE), 0);
  banks.set(code.subarray(0, split), PCE_BANK_SIZE);

  const wanted = script.driver.rate.num / script.driver.rate.den;
  const actual = clock.rate.num / clock.rate.den;

  return {
    bytes: packHuCard(banks, { vectors: vectorsOf(asm) }),
    symbols: asm.symbols(),
    performed,
    stats: {
      code: dataStart - CODE_ORIGIN,
      data: codeEnd - dataStart,
      // What the *program* has left, which is the window below the boot bank
      // rather than the board: everything above `$E000` is the stub and its
      // vectors, and everything past the last board size is padding no program
      // can reach without a `tam` this cartridge never emits.
      free: BOOT_ORIGIN - codeEnd,
      ticks: data.ticks,
      blocks: data.blocks.length,
      order: data.order.length,
      blocksSaved: data.blocksSaved,
      helpers,
      rate: clock.rate,
      ratePpmError: wanted === 0 ? 0 : Math.round(((actual - wanted) / wanted) * 1e6),
    },
  };
}

/** The five vectors, from the labels the emitter defined. */
function vectorsOf(asm: Asm6280): Record<string, number> {
  const at = (name: string): number => (asm.has(name) ? asm.addressOf(name) : 0);
  return {
    irq2: at("Idle2"),
    irq1: at("Idle2"),
    timer: at("TimerIrq"),
    nmi: at("Idle2"),
    reset: at("Reset"),
  };
}

/** Emit the whole window and report which routines it pulled in. */
function emitDriver(
  asm: Asm6280,
  data: DriverData,
  clock: Clock,
  boot: readonly RegisterWrite[],
): { helpers: string[]; dataStart: number; codeEnd: number } {
  const helpers: string[] = ["tick", "timer-clock", "boot-table"];

  // --- the tick --------------------------------------------------------------
  helpers.push(
    ...emitStream(asm, {
      prefix: "",
      base: PSG_BASE,
      state: STATE,
      scratch: { count: STATE.count, flags: STATE.flags },
      data,
    }),
  );

  // --- the chip's initialisation, as a table rather than as instructions ------
  //
  // Nearly two hundred writes, most of them a waveform, so a run of literal
  // stores would be a kilobyte of code to say what four hundred bytes of data
  // say. The walk is here rather than in the boot bank because the table is,
  // and both are below `$E000` where there is room for them.
  asm.label("AudioInit");
  asm.lda(immLow(label("AudioBoot")));
  asm.sta(zp(STATE.count));
  asm.lda(immHigh(label("AudioBoot")));
  asm.sta(zp(STATE.flags));
  asm.ldy(imm(0));
  asm.label("AudioInitNext");
  asm.lda(indY(STATE.count));
  asm.bmi("AudioInitDone"); // `$FF` ends it; no register on this chip is above $09
  asm.tax();
  emitStepPointer(asm, STATE.flags, "AudioInitLow");
  asm.lda(indY(STATE.count));
  asm.sta(absX(PSG_BASE));
  emitStepPointer(asm, STATE.flags, "AudioInitValue");
  asm.jmp("AudioInitNext");
  asm.label("AudioInitDone");
  asm.rts();

  // --- the schedule ----------------------------------------------------------
  const dataStart = asm.pc;
  asm.label("AudioBoot");
  for (const write of boot) asm.db(write.reg & 0xff, write.value & 0xff);
  asm.db(0xff);
  emitStreamData(asm, "", 0, data);
  const codeEnd = asm.pc;
  if (codeEnd > BOOT_ORIGIN) {
    throw new AudioRomError(
      "E_TRACK_TOO_LARGE",
      `this schedule packs to ${data.bytes} bytes and the window below the boot bank holds ${
        BOOT_ORIGIN - CODE_ORIGIN
      }`,
      "shorten the track, loop it earlier, or arrange with fewer per-tick writes; bank switching is not in v1.",
    );
  }

  // --- the boot bank ---------------------------------------------------------
  //
  // Padded with `$FF` rather than zero, for `packHuCard`'s reason: that is what
  // an unprogrammed mask ROM reads as, and a program that ran off its own end
  // then hits `bbs7` rather than `brk`.
  asm.padTo(BOOT_ORIGIN, 0xff);

  asm.label("Reset");
  asm.sei();
  asm.csh(); // 7.16 MHz, and never undone
  asm.cld();
  // The map, before anything else: reset defines only `MPR7`, so until these run
  // there is no work RAM, no stack, no hardware page and no data.
  asm.lda(imm(0xff));
  asm.tam(Asm6280.mprBit(0));
  asm.lda(imm(0xf8));
  asm.tam(Asm6280.mprBit(1));
  asm.ldx(imm(0xff));
  asm.txs();
  for (let page = 2; page <= 6; page += 1) {
    asm.lda(imm(page - 1));
    asm.tam(Asm6280.mprBit(page));
  }
  // Every source masked but the timer, and anything already pending cleared.
  asm.lda(imm(IRQ_TIMER_ONLY));
  asm.sta(abs(IRQ_MASK));
  asm.sta(abs(IRQ_STATUS));

  // The chip, once, from the table — and then the stream, whose first tick has
  // had those same writes taken off it.
  asm.jsr("AudioInit");
  asm.lda(imm(0));
  asm.sta(zp(STATE.rest));
  emitPointer(asm, STATE.orderLo, "Order0");
  emitPointer(asm, STATE.loopLo as number, "Order0", data.loopOrderIndex * 2);
  asm.jsr("NextBlock");

  // The clock last, so nothing can raise a tick before there is a driver to
  // perform it. Starting a stopped timer reloads it, which is what makes these
  // two writes the whole of programming it.
  asm.lda(imm(clock.reload & MAX_TIMER_RELOAD));
  asm.sta(abs(TIMER_RELOAD));
  asm.lda(imm(1));
  asm.sta(abs(TIMER_CONTROL));
  asm.cli();
  asm.label("Idle");
  asm.jmp("Idle");

  // --- the interrupt handler -------------------------------------------------
  //
  // The tick happens *inside* the handler here, where a game counts it and lets
  // the main loop perform it. A game splits them because the blanking interval
  // belongs to the picture; this cartridge has no picture, so there is nothing
  // for the tick to be in the way of.
  asm.label("TimerIrq");
  asm.pha();
  asm.phx();
  asm.phy();
  // Writing the status register is what acknowledges the timer; a handler that
  // skipped it would be re-entered the instant it returned.
  asm.sta(abs(IRQ_STATUS));
  asm.jsr("Tick");
  asm.ply();
  asm.plx();
  asm.pla();
  asm.rti();

  // The other three vectors point here. Nothing raises them — IRQ2 and the video
  // chip are masked and this cartridge has no hardware of its own — and a vector
  // left at zero would run whatever the padding is.
  asm.label("Idle2");
  asm.rti();

  if (asm.pc > 0x10000 - VECTOR_BYTES) {
    throw new AudioRomError(
      "E_INTERNAL",
      `the boot bank is ${asm.pc - BOOT_ORIGIN} bytes and it holds ${PCE_BANK_SIZE - VECTOR_BYTES}`,
    );
  }
  asm.padTo(0x10000, 0xff);

  return { helpers, dataStart, codeEnd };
}

/** Step Y one byte, carrying into the boot pointer's high half. */
function emitStepPointer(asm: Asm6280, high: number, name: string): void {
  asm.iny();
  asm.bne(name);
  asm.inc(zp(high));
  asm.label(name);
}

/** Point a cheap-page pointer pair at a label, low byte first. */
function emitPointer(asm: Asm6280, slot: number, name: string, offset = 0): void {
  asm.lda(immLow(label(name, offset)));
  asm.sta(zp(slot));
  asm.lda(immHigh(label(name, offset)));
  asm.sta(zp(slot + 1));
}
