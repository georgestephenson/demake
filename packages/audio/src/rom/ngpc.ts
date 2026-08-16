/**
 * The Neo Geo Pocket audio driver: a bootable cartridge that plays a
 * `ChipScript`.
 *
 * Named after the Colour machine because that is what its *family* is called
 * everywhere else in the repository — the game backend's, the console-support
 * matrix's — and because the page's JS budget matches a chunk to a family by
 * the name of the file it came from (`tools/ci/check-web-budget.mjs`). This
 * file is six kilobytes of TLCS-900/H assembler behind an `import()`, so a name
 * no family claims is six kilobytes charged to every visitor rather than to the
 * one building for this console. `wsc.ts` is the same bargain one console
 * along, and both machines are served here for the same reason.
 *
 * The tenth standalone cartridge, and the seventh measurement of the same
 * claim: **the stream player is the processor's**. `ngp-driver.ts` is not
 * touched here at all — a game already drove it — so what this file owns is a
 * boot sequence, a clock and a cartridge wrapper, exactly as `sms.ts`, `pce.ts`,
 * `wsc.ts` and `vb.ts` do.
 *
 * Four things about it are this machine's, and each is a way a cartridge can
 * assemble perfectly and play nothing.
 *
 *   - **The chip has to be asked for.** Its own bus belongs to a Z80 sound
 *     processor, so two bytes of the console's I/O page hand it to the main CPU
 *     before anything else is listened to. That is the game driver's `UNLOCK`
 *     unchanged and it is the *first* thing this boot does.
 *   - **The clock is the processor's own 8-bit timer, and this cartridge is why
 *     the block exists.** A demade *game* rides the picture, because its music
 *     and effects share one interrupt with the frame; a cartridge whose only job
 *     is a schedule has no picture to share with and a rate the frame cannot
 *     express, so it programmes timer 1 — the *upper* timer, because
 *     φT256 is the only prescaler output that reaches the bottom of a driver's
 *     useful band and no single timer offers all four (`NGP_T1CLK`). A track
 *     that fits the frame exactly still takes the frame, because refusing a
 *     source the binding legitimately produced would be a build error about
 *     nothing.
 *   - **An interrupt handler is a pointer in RAM.** The boot ROM owns the
 *     processor's own vector table and dispatches through one of its own, so
 *     this cartridge claims a clock by writing four bytes at `$6FD8` (the timer)
 *     or `$6FCC` (the frame) — and it writes them *last*, because until then
 *     there is no driver for a tick to reach.
 *   - **The priority is the enable, and seven is off.** Arming the timer's
 *     interrupt is a level of 1 to 6 in its nibble of `INTET01`; both 0 and 7
 *     refuse it, so a cartridge that set the top three bits "to be sure" would
 *     programme a perfect timer nothing ever hears from.
 *
 * **Two machines, and the difference is one byte** — the header's system field,
 * which says whether a mono Neo Geo Pocket may run this. The sound hardware is
 * the same T6W28 on both, so the driver, the binding and the schedule are one of
 * each: `sms.ts`'s bargain with a Game Gear's region nibble, and `wsc.ts`'s with
 * a WonderSwan's minimum-system byte.
 *
 * **And this cartridge is the reason four addresses in the machine description
 * got fixed.** Building it the first time produced one that booted, took the
 * chip, programmed its clock and played silence — because the sound ports were
 * recorded at `$20`/`$21`, which is where the *timer* registers are, and the
 * timer block therefore swallowed every write. Both were MAME's I/O map read as
 * absolute when it is installed at `$80` and indexed from there; the ports are
 * `$A0`/`$A1` and there was never a collision (doc 13 §A5).
 *
 * Sources:
 * - Toshiba TMP95C061 datasheet §3.8 (the 8-bit timers) and §3.3 (the
 *   interrupt-enable registers)
 * - Neo Geo Pocket Color technical reference (`ngpcspec.txt`) — the boot ROM's
 *   dispatch table
 * - MAME `src/mame/snk/ngp.cpp` and beetle-ngp `mednafen/ngp/mem.c` — the I/O
 *   page's decoding
 */

import {
  Asm900,
  AsmError,
  label,
  NGP_DISABLE_VALUE,
  NGP_ENABLE_VALUE,
  NGP_HEADER_SIZE,
  NGP_INTET01,
  NGP_INTET_SHIFT,
  NGP_RAM,
  NGP_RAM_RESERVED,
  NGP_ROM_BASE,
  NGP_ROM_SIZES,
  NGP_SOUND_ENABLE,
  NGP_T01M,
  NGP_T01M_SHIFT,
  NGP_T01MOD,
  NGP_T0CLK,
  NGP_T0CLK_SHIFT,
  NGP_T1CLK_DIVISORS,
  NGP_T1CLK_SHIFT,
  NGP_TREG1,
  NGP_TRUN,
  NGP_TRUN_BITS,
  NGP_VECTOR_TIMER1,
  NGP_VECTOR_VBLANK,
  NGP_Z80_ENABLE,
  ngpRomSize,
  packNgpRom,
  t9Abs as abs,
  type Ref,
} from "@demake/core";

import { bindingFor } from "../binding/registry.js";
import type { ChipScript, Rational } from "../chipscript.js";

import type { DriverData } from "./data.js";
import { AudioRomError, type AudioRomOptions, type BuiltAudioRom } from "./gb.js";
import { emitStream, emitStreamData, ngpPortByte, type NgpStreamState } from "./ngp-driver.js";
import { pack, stripBoot } from "./shared.js";
import { checkLatchDiscipline } from "./t6w28.js";

/**
 * Where the driver keeps its position, at the bottom of the console's RAM.
 *
 * Longwords, because a pointer here is twenty-four bits: the packed data is in
 * the cartridge at `$200000` and nothing sixteen bits wide could name it
 * (`ngp-driver.ts` §`NgpStreamState`).
 */
const STATE: NgpStreamState = {
  data: NGP_RAM,
  order: NGP_RAM + 4,
  loop: NGP_RAM + 8,
  rest: NGP_RAM + 12,
};

/**
 * Where the stack starts: the top of the RAM a cartridge owns.
 *
 * `$6C00` and up is the boot ROM's own page — its dispatch table is in it — so
 * a stack that grew down from the end of the address space would be growing
 * through the vector this cartridge is about to install.
 */
const STACK_TOP = NGP_RAM_RESERVED;

/**
 * The interrupt priority the driver's timer is armed at.
 *
 * Three, which is the middle of the range that *accepts* — 1 to 6 do and both 0
 * and 7 refuse. Nothing else on this cartridge takes an interrupt, so the level
 * decides nothing; what it must not be is the value somebody reaches for when
 * they mean "highest" (`core/src/asm/ngp.ts` §NGP_INTET01).
 */
const PRIORITY = 3;

/** The system byte: `false` a mono machine may run this, `true` Colour only. */
const COLOUR_ONLY: Readonly<Record<string, boolean>> = { ngp: false, ngpc: true };

/** What the clock resolved to: which interrupt, and what to programme. */
interface Clock {
  /** The boot ROM dispatch pointer this cartridge installs its handler in. */
  vector: number;
  /** The timer's own registers, absent when the clock is the picture's. */
  timer?: { select: number; reload: number };
  rate: Rational;
}

/**
 * Resolve the schedule's clock to the interrupt this cartridge will take.
 *
 * Both sources are accepted and that is the *caller* being a standalone
 * cartridge rather than the hardware being generous. A game gets the frame and
 * only the frame, because its two streams share one interrupt with the picture
 * (`ngp-game.ts` §resolveNgpClock); here the timer is the point of the exercise
 * and the frame is what a track whose tempo happens to land on 59.95 Hz is
 * fitted to. Refusing that one would be `E_DRIVER_CLOCK` about a schedule
 * nothing is wrong with.
 *
 * **The reload is read off the schedule and the prescaler is factored out of
 * it.** A `ChipScript` carries the reload as `divisor`, because a ROM programmes
 * a register and re-deriving one from a rational would be a second timing fit
 * (doc 16 §Anything that stores a driver rate). The prescaler is the other half
 * of the same product and is recovered by division rather than by searching, so
 * it cannot disagree with the fit: `den` is `prescaler × reload` exactly, and a
 * quotient that is not one of the three the upper timer offers is refused rather
 * than rounded.
 */
export function resolveNgpcAudioClock(script: ChipScript): Clock {
  const { rate, source, divisor } = script.driver;
  if (source === "vblank") return { vector: NGP_VECTOR_VBLANK, rate };
  if (source !== "timer") {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `the ngp driver has no '${source}' clock`,
      "this cartridge takes the processor's own 8-bit timer, or the picture's own interrupt; re-arrange with `timer` or `vblank`.",
    );
  }
  if (divisor === undefined || divisor < 0 || divisor > 0xff) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `${rateHzOf(rate)} Hz needs a timer reload of ${String(divisor)}, and the register holds 0–255`,
      "the schedule's rate and reload disagree; this is a bug in the timing fit, not in the track.",
    );
  }
  // A match clears the up-counter, so the period *is* the reload — and a reload
  // of zero is a full 256 rather than a timer that fires on every input clock.
  const period = divisor === 0 ? 256 : divisor;
  const prescaler = rate.den / period;
  const select = NGP_T1CLK_DIVISORS.indexOf(prescaler);
  if (!Number.isInteger(prescaler) || select < 1) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `${rateHzOf(rate)} Hz over a reload of ${period} needs a prescaler of ${prescaler}, ` +
        `and this timer divides by ${NGP_T1CLK_DIVISORS.slice(1).join(", ")}`,
      "the schedule's rate and reload disagree; this is a bug in the timing fit, not in the track.",
    );
  }
  return { vector: NGP_VECTOR_TIMER1, timer: { select, reload: divisor }, rate };
}

/** A rate as hertz, for a message. */
function rateHzOf(rate: Rational): string {
  return (rate.num / rate.den).toFixed(2);
}

/**
 * Build a cartridge that plays this schedule.
 *
 * The caller has already been told the console is a Neo Geo Pocket —
 * `buildAudioRom` in `index.ts` is where a console with no driver backend is
 * refused, on the "a backend gap is a build error, never a silent difference"
 * rule.
 */
export function buildNgpcAudioRom(
  script: ChipScript,
  options: AudioRomOptions = {},
): BuiltAudioRom {
  const clock = resolveNgpcAudioClock(script);
  const binding = bindingFor(script.console);
  const boot = binding.init();

  // Stripped rather than performed from tick 0, on the Sega's terms: the boot
  // silences every channel on both sides, and leaving a second copy of that at
  // the head of the stream would only re-silence a chip nothing has yet played.
  const performed = stripBoot(script, boot);
  // One stream owns the cartridge, so there is no channel tag, no steal mask and
  // no shadow — but the packing discipline still holds, because this chip
  // latches its channel selection in the data byte and a run that opened without
  // one would be a note on whatever the last run selected (`t6w28.ts`).
  checkLatchDiscipline(performed);
  const data = pack(performed, { port: ngpPortByte });

  const asm = new Asm900(NGP_ROM_BASE + NGP_HEADER_SIZE);
  let built: { helpers: string[]; dataStart: number };
  let code: Uint8Array;
  try {
    built = emitDriver(asm, data, boot, clock);
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

  const largest = NGP_ROM_SIZES[NGP_ROM_SIZES.length - 1] as number;
  if (NGP_HEADER_SIZE + code.length > largest) {
    throw new AudioRomError(
      "E_TRACK_TOO_LARGE",
      `this driver assembles to ${code.length} bytes and the largest cartridge holds ${
        largest - NGP_HEADER_SIZE
      }`,
      "shorten the track, loop it earlier, or arrange with fewer per-tick writes.",
    );
  }

  const wanted = script.driver.rate.num / script.driver.rate.den;
  const actual = clock.rate.num / clock.rate.den;
  // The smallest board this console shipped that holds the program, which is the
  // elastic-cartridge rule one console along — and `free` is measured against
  // the *largest*, so a track that crossed a boundary does not look roomier for
  // having grown (AGENTS.md §Iron rules).
  const size = ngpRomSize(NGP_HEADER_SIZE + code.length);

  return {
    bytes: packNgpRom(code, {
      size,
      color: COLOUR_ONLY[script.console] ?? true,
      ...(options.title === undefined ? {} : { title: options.title }),
    }),
    symbols: asm.symbols(),
    performed,
    stats: {
      code: built.dataStart + NGP_HEADER_SIZE,
      data: code.length - built.dataStart,
      free: largest - NGP_HEADER_SIZE - code.length,
      ticks: data.ticks,
      blocks: data.blocks.length,
      order: data.order.length,
      blocksSaved: data.blocksSaved,
      helpers: built.helpers,
      rate: clock.rate,
      ratePpmError: wanted === 0 ? 0 : Math.round(((actual - wanted) / wanted) * 1e6),
    },
  };
}

/** Emit the whole program and report which routines it pulled in. */
function emitDriver(
  asm: Asm900,
  data: DriverData,
  boot: readonly { reg: number; value: number }[],
  clock: Clock,
): { helpers: string[]; dataStart: number } {
  const helpers: string[] = ["tick", clock.timer ? "timer-clock" : "vblank-clock"];

  // --- start-up --------------------------------------------------------------
  //
  // The boot ROM reads the entry address out of the cartridge header and jumps
  // here with nothing set up but the machine it left running, so the stack is
  // this program's own first job.
  asm.label("Reset");
  asm.di();
  asm.ldn("xsp", STACK_TOP);

  // The chip, before anything that writes to it. Until both of these are
  // written the T6W28's bus is the Z80 sound processor's and every port write
  // below is ignored — a cartridge that skipped them would be perfect and
  // silent.
  asm.stmi(abs(NGP_SOUND_ENABLE), "b", NGP_ENABLE_VALUE);
  asm.stmi(abs(NGP_Z80_ENABLE), "b", NGP_DISABLE_VALUE);
  for (const write of boot) asm.stmi(abs(ngpPortByte(write.reg)), "b", write.value);

  asm.stmi(abs(STATE.rest), "b", 0);
  asm.ldn("xwa", label("Order0") as Ref);
  asm.stm(abs(STATE.order), "xwa");
  asm.ldn("xwa", label("Order0", data.loopOrderIndex * 4) as Ref);
  asm.stm(abs(STATE.loop as number), "xwa");
  asm.call(label("NextBlock"));

  // The clock, and then the handler that answers it — in that order, because a
  // timer that overflowed before the pointer was written would raise a request
  // the boot ROM dispatches through a vector holding whatever powered up.
  if (clock.timer) {
    asm.stmi(abs(NGP_TREG1), "b", clock.timer.reload);
    asm.stmi(
      abs(NGP_T01MOD),
      "b",
      (NGP_T01M.two8Bit << NGP_T01M_SHIFT) |
        (clock.timer.select << NGP_T1CLK_SHIFT) |
        // The lower timer's field, which is not running and therefore decides
        // nothing — but selection 0 there is the *external pin*, and a cartridge
        // that left it claiming one would be describing hardware it has not got.
        (NGP_T0CLK.t1 << NGP_T0CLK_SHIFT),
    );
    asm.stmi(abs(NGP_INTET01), "b", PRIORITY << NGP_INTET_SHIFT.odd);
  }

  asm.ldn("xwa", label("Irq") as Ref);
  asm.stm(abs(clock.vector), "xwa");

  if (clock.timer) {
    // Last of all, and both bits at once: the shared prescaler runs on bit 7 and
    // the timer on its own, so a cartridge that started one without the other
    // counts nothing at all. Starting a stopped timer clears its counter, which
    // is what makes this one write the whole of arming it.
    asm.stmi(abs(NGP_TRUN), "b", (1 << NGP_TRUN_BITS.prescaler) | (1 << NGP_TRUN_BITS.timer1));
  }
  asm.ei(0);

  // Nothing else runs on this machine, so the loop is one instruction and the
  // whole of the cartridge's time between ticks is spent in it.
  asm.label("Idle");
  asm.jp(label("Idle"));

  // --- the interrupt handler -------------------------------------------------
  //
  // **It saves nothing**, and that is this caller rather than a shortcut. The
  // only code an interrupt can arrive in is the idle loop above — the boot runs
  // with interrupts disabled and the handler is installed after it — so there is
  // no register anywhere holding anything a tick could destroy. A *game*'s
  // handler on this console saves `XWA` because what it interrupts is a game.
  //
  // The tick happens inside the handler rather than being counted for a main
  // loop to perform, for the reason every standalone cartridge in this directory
  // gives: a game splits them because the blanking interval belongs to the
  // picture, and this cartridge has no picture for a tick to be in the way of.
  asm.label("Irq");
  asm.calr(label("Tick"));
  asm.reti();

  // --- the tick --------------------------------------------------------------
  helpers.push(...emitStream(asm, { prefix: "", state: STATE, data }));

  // --- the schedule ----------------------------------------------------------
  const dataStart = asm.pc - (NGP_ROM_BASE + NGP_HEADER_SIZE);
  emitStreamData(asm, "", 0, data);

  return { helpers, dataStart };
}
