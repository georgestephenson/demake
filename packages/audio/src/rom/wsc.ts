/**
 * The WonderSwan audio driver: a bootable cartridge that plays a `ChipScript`.
 *
 * The sixth standalone cartridge, and the fourth measurement of the same claim:
 * **the stream player is the processor's**. `wsc-driver.ts` is not touched here
 * at all — a game already drove it — so what this file owns is a boot sequence,
 * a clock and a cartridge wrapper, exactly as `sms.ts` and `pce.ts` do one and
 * two consoles over.
 *
 * Three of those are this machine's, and each is a way a cartridge can assemble
 * perfectly and play nothing.
 *
 *   - **The clock is a tally rather than an interrupt, and here that is a
 *     *choice about the caller* as well as about the hardware.** This cartridge
 *     takes no interrupts — the controller vectors through the processor's own
 *     table in the first kilobyte of RAM, and there is nothing here worth one —
 *     so the idle loop reads the vertical-blank timer's counter and pays
 *     whatever frames it finds owed. A game does the same thing from a loop that
 *     is also running a game, so its drift is bounded by a frame; this loop does
 *     nothing else, so it is bounded by a poll. The Mega Drive's distinction
 *     (`md.ts` versus `md-game.ts`) reached by different hardware — except that
 *     here it buys accuracy rather than a rate, because the counter still only
 *     moves once a frame.
 *   - **The waveforms are memory, so the boot copies rather than uploads.**
 *     Sixty-four bytes go from the cartridge into RAM at `WS_WAVE_BASE` and port
 *     `$8F` says where. That is why the chip's initialisation is stripped from
 *     the schedule and performed by the boot instead of riding tick 0: a channel
 *     enabled before its table is in place plays whatever powered up at that
 *     address.
 *   - **The program is the last bank and the entry is a far jump.** The
 *     processor resets to `$FFFF:0000`, which is the top sixteen bytes of the
 *     cartridge, and `packWsRom` puts a `jmp $F000:$0000` there — so a build is
 *     assembled at offset zero of a 64 KiB bank and everything above `$FFF0` is
 *     the footer's.
 *
 * **Two machines, and the difference is one byte.** A mono WonderSwan has the
 * same sound hardware as a Colour one — same chip, same ports, same waveform
 * page in the same place — so the driver, the binding and the schedule are one
 * of each, and all this file asks the console is what to stamp in the footer's
 * minimum-system field. That is the same bargain `sms.ts` makes with a Game
 * Gear's region nibble.
 *
 * Sources:
 * - WSdev wiki — Sound: https://ws.nesdev.org/wiki/Sound
 * - WSdev wiki — Cartridge header: https://ws.nesdev.org/wiki/Cartridge_header
 */

import { Asm30, AsmError, label, packWsRom, WS_CODE_SIZE, x86Abs as abs } from "@demake/core";

import { bindingFor } from "../binding/registry.js";
import { WS_BANK_BYTES, WS_WAVE_BASE, wsWaveBank } from "../binding/wsc-bank.js";
import { wsWaveforms } from "../binding/wsc.js";
import type { ChipScript, Rational } from "../chipscript.js";

import type { DriverData } from "./data.js";
import { AudioRomError, type AudioRomOptions, type BuiltAudioRom } from "./gb.js";
import { pack, stripBoot } from "./shared.js";
import { emitStream, emitStreamData, type WscStreamState } from "./wsc-driver.js";
import { portOf, resolveWscClock } from "./wsc-game.js";

/**
 * Where the driver keeps its position, in the console's own RAM.
 *
 * Directly above the waveform page, which ends at `WS_WAVE_BASE + 64`. Both are
 * inside the interrupt vector table, and both are safe there for the same
 * reason: this cartridge takes no interrupt, so nothing ever reads a vector.
 * It is also the only region below `$0400` that is free on *both* machines —
 * the mono WonderSwan has a quarter of the memory and its tile bank starts at
 * `$2000` (`codegen/wsc/machine.ts`).
 */
const STATE: WscStreamState = {
  data: WS_WAVE_BASE + WS_BANK_BYTES,
  order: WS_WAVE_BASE + WS_BANK_BYTES + 2,
  loop: WS_WAVE_BASE + WS_BANK_BYTES + 4,
  rest: WS_WAVE_BASE + WS_BANK_BYTES + 6,
};

/** The counter this loop last saw, so elapsed frames are a subtraction. */
const LAST_FRAME = WS_WAVE_BASE + WS_BANK_BYTES + 7;

/**
 * Where the stack starts.
 *
 * The top of the *mono* machine's usable RAM, so one number serves both: a
 * Colour WonderSwan has four times the memory and nothing here needs it, and a
 * stack that only exists on one of the two would be a cartridge that runs on one
 * of them. `$0C00` is where the mono machine's own memory plan puts it.
 */
const STACK_TOP = 0x0c00;

/**
 * The vertical-blank timer, which is this driver's whole clock.
 *
 * `wsc-game.ts` §`TIMER` states the arrangement and the reason for the reload:
 * the counter decrements at the start of line 144 and reloads at one, so a whole
 * low byte between reloads makes `(last - now) & $FF` an exact count of frames
 * however many have passed.
 */
const TIMER = {
  control: 0xa2,
  reload: 0xa6,
  counter: 0xaa,
  enable: 0x0c,
  period: 0x0100,
} as const;

/** The minimum-system byte: `0` a mono WonderSwan will run this, `1` Colour only. */
const MINIMUM_SYSTEM: Readonly<Record<string, number>> = { ws: 0, wsc: 1 };

/**
 * Build a cartridge that plays this schedule.
 *
 * The caller has already been told the console is a WonderSwan — `buildAudioRom`
 * in `index.ts` is where a console with no driver backend is refused, on the
 * "a backend gap is a build error, never a silent difference" rule.
 */
export function buildWscAudioRom(script: ChipScript, options: AudioRomOptions = {}): BuiltAudioRom {
  void options;
  const clock = resolveWscClock(script);
  const binding = bindingFor(script.console);
  const boot = binding.init();
  const shapes = wsWaveforms(binding.spec);

  // Stripped rather than performed from tick 0, which is the PC Engine's reason
  // rather than the Sega's: the boot has to copy the waveforms into RAM before
  // anything enables a channel, so it is already emitting the initialisation and
  // leaving a second copy in the stream would only re-silence the first tick.
  const performed = stripBoot(script, boot);
  // The port rather than a register number, because this chip is I/O and the
  // packed byte is what lands in `dl`. One stream owns the cartridge, so there
  // is no channel tag, no merge set and no shadow: `$90` is stored outright.
  const data = pack(performed, { port: portOf });

  const asm = new Asm30(0);
  let built: { helpers: string[]; dataStart: number };
  let code: Uint8Array;
  try {
    built = emitDriver(asm, data, boot, shapes, clock);
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

  if (code.length > WS_CODE_SIZE) {
    throw new AudioRomError(
      "E_TRACK_TOO_LARGE",
      `this driver assembles to ${code.length} bytes and the mapped bank holds ${WS_CODE_SIZE}`,
      "shorten the track, loop it earlier, or arrange with fewer per-tick writes; bank switching is not in v1.",
    );
  }

  const wanted = script.driver.rate.num / script.driver.rate.den;
  const actual = clock.rate.num / clock.rate.den;

  return {
    bytes: packWsRom(code, { minimumSystem: MINIMUM_SYSTEM[script.console] ?? 1 }),
    symbols: asm.symbols(),
    performed,
    stats: {
      code: built.dataStart,
      data: code.length - built.dataStart,
      free: WS_CODE_SIZE - code.length,
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
  asm: Asm30,
  data: DriverData,
  boot: readonly { reg: number; value: number }[],
  shapes: Parameters<typeof wsWaveBank>[0],
  clock: { ticksPerFrame: number; rate: Rational },
): { helpers: string[]; dataStart: number } {
  const helpers: string[] = ["tick", "vblank-tally"];

  // --- start-up --------------------------------------------------------------
  //
  // The processor arrives here through the far jump `packWsRom` puts at the top
  // of the bank, with nothing set up: the segments and the stack are the
  // program's own first job, and `ds` has to be RAM before a single `abs()`
  // operand means what it says.
  asm.label("Boot");
  asm.cli();
  asm.cld();
  asm.movi("ax", 0);
  asm.movsr("ds", "ax");
  asm.movsr("es", "ax");
  asm.movsr("ss", "ax");
  asm.movi("sp", STACK_TOP);

  // The waveforms first, for the game driver's reason: a channel enabled before
  // its table is in place plays whatever powered up at that address. `ds` is
  // pointed at the cartridge for the length of the copy rather than the source
  // carrying an override, because `movsb` takes its segment from `ds` and there
  // is nothing else to read while it runs.
  asm.movi("si", label("AudioWaves"));
  asm.movi("di", WS_WAVE_BASE);
  asm.movi("cx", WS_BANK_BYTES);
  asm.pushSeg("ds");
  asm.movi("ax", 0xf000);
  asm.movsr("ds", "ax");
  asm.rep().movsb();
  asm.popSeg("ds");

  for (const write of boot) {
    asm.movi8("al", write.value);
    asm.out8(portOf(write.reg));
  }

  asm.movi8("al", 0);
  asm.movmr8(abs(STATE.rest), "al");
  asm.movi("ax", label("Order0"));
  asm.movmr(abs(STATE.order), "ax");
  asm.movi("ax", label("Order0", data.loopOrderIndex * 2));
  asm.movmr(abs(STATE.loop as number), "ax");
  asm.call("NextBlock");

  // The tally. Writing the reload initialises the counter with it, so the first
  // reading below is the one this records rather than whatever the timer held.
  asm.movi("ax", TIMER.period);
  asm.out16(TIMER.reload);
  asm.movi8("al", TIMER.enable);
  asm.out8(TIMER.control);
  asm.in8(TIMER.counter);
  asm.movmr8(abs(LAST_FRAME), "al");

  // --- the loop --------------------------------------------------------------
  //
  // Nothing else runs on this machine, so the poll is as tight as the processor
  // will make it and a frame boundary is noticed within a few microseconds of
  // happening. There is no cap on what is owed and no need for one: a game caps
  // because it can be stopped for a second and come back owing hundreds of
  // ticks, and this loop cannot be stopped by anything.
  asm.label("Idle");
  asm.in8(TIMER.counter);
  asm.mov8("ah", "al"); // what the timer says now, kept across the subtraction
  asm.aluM8("sub", "al", abs(LAST_FRAME));
  asm.unary8("neg", "al"); // the counter runs *down*, so elapsed is last minus now
  asm.jcc("z", "Idle");
  asm.movmr8(abs(LAST_FRAME), "ah");

  asm.label("IdleFrame");
  asm.push("ax");
  for (let tick = 0; tick < clock.ticksPerFrame; tick += 1) asm.call("Tick");
  asm.pop("ax");
  // `sub al, 1` rather than a `dec`: this encoder has no eight-bit decrement,
  // and the flags a subtraction sets are the ones the branch below wants.
  asm.aluI8("sub", "al", 1);
  asm.jcc("nz", "IdleFrame");
  asm.jmp("Idle");
  if (clock.ticksPerFrame > 1) helpers.push("multi-tick-frame");

  // --- the tick --------------------------------------------------------------
  helpers.push(...emitStream(asm, { prefix: "", state: STATE, data }));

  // --- the schedule ----------------------------------------------------------
  const dataStart = asm.pc;
  asm.label("AudioWaves");
  asm.bytes(wsWaveBank(shapes));
  emitStreamData(asm, "", 0, data);

  return { helpers, dataStart };
}
