/**
 * The Game Boy audio driver: a bootable cartridge that plays a `ChipScript`.
 *
 * This is the audio counterpart of `rom-harness/gb/main.asm` — the display
 * program the image path assembles around its tiles — with one deliberate
 * difference: there is no checked-in harness. The driver is *generated* for this
 * schedule, in TypeScript, with `core`'s own SM83 assembler, for the three
 * reasons doc 16 §The driver contract gives and doc 14 §2 already proved on
 * games:
 *
 *   - **Pulled, never pushed.** A schedule with no silent ticks emits no rest
 *     handling; one that fits in a single block emits no order-list walk; a
 *     track (rather than a one-shot) emits no stop path. A fixed driver ships
 *     every feature because it cannot know which ones this track uses.
 *   - **No toolchain.** The proof (doc 16 §The proof, Level A) is then a plain
 *     unit test — build the ROM, run it in `@demake/dmg`, diff the register
 *     writes against the schedule — with nothing installed, exactly as
 *     `packages/demotic/test/rom.test.ts` is.
 *   - **The browser builds it too**, byte for byte, which is doc 07's parity
 *     contract restated for sound.
 *
 * What the driver must guarantee is narrow and it is all that is tested: **on
 * tick N it performs exactly the writes `ChipScript.ticks[N]` lists, in order.**
 * How the data is packed is `data.ts`'s business and no part of the contract.
 *
 * Sources:
 * - Pan Docs — Timer and Divider Registers: https://gbdev.io/pandocs/Timer_and_Divider_Registers.html
 * - Pan Docs — Interrupts: https://gbdev.io/pandocs/Interrupts.html
 * - Pan Docs — Audio Registers: https://gbdev.io/pandocs/Audio_Registers.html
 */

import { Asm, AsmError, GB_ROM_SIZE, label, stampGbHeader } from "@demake/core";

import type { ChipScript } from "../chipscript.js";

import { packScript, PackError, type DriverData } from "./data.js";
import { emitStream, emitStreamData } from "./gb-driver.js";

/** The Game Boy's master clock, the numerator of every driver rate. */
const GB_CLOCK = 4194304;

/** TAC's four input clock dividers, in master clocks per timer step. */
const TAC_DIVIDERS = [1024, 16, 64, 256];

/** Master clocks in one frame — the `vblank` source's period. */
const FRAME_CLOCKS = 70224;

/**
 * Driver state, in high RAM.
 *
 * High RAM because `ldh` is one byte shorter and one cycle faster than a full
 * load, and this is the one piece of code on the machine whose cycle count is
 * bounded by an interrupt period.
 */
const H = {
  dataLo: 0x80,
  dataHi: 0x81,
  orderLo: 0x82,
  orderHi: 0x83,
  loopLo: 0x84,
  loopHi: 0x85,
  rest: 0x86,
} as const;

/** Interrupt-enable bits (Pan Docs §Interrupts). */
const IE_VBLANK = 0x01;
const IE_TIMER = 0x04;

// The four things a built cartridge *is* now live in `artifact.ts`, because the
// dispatch in `index.ts` has to name them without naming a family — every
// per-family builder is behind an `import()` so its assembler is a chunk of its
// own. Re-exported here so that every emitter in this directory, and every
// caller outside it, still imports them from where it always did.
import {
  AudioRomError,
  type AudioRomOptions,
  type AudioRomStats,
  type BuiltAudioRom,
} from "./artifact.js";

export { AudioRomError };
export type { AudioRomOptions, AudioRomStats, BuiltAudioRom };

/** How the driver gets its tick, resolved to the registers that produce it. */
export interface Clock {
  source: "timer" | "vblank";
  /** TAC value, for the timer source. */
  tac?: number;
  /** TMA reload, for the timer source. */
  tma?: number;
  interrupt: number;
  vector: number;
  rate: { num: number; den: number };
}

/**
 * Resolve the schedule's driver clock to real register values.
 *
 * A `ChipScript` records the reload (`divisor`) and the exact rate but not the
 * prescaler, because the *rate* is the contract and the register split is the
 * console's business. Recovering the split here rather than storing it keeps
 * one source of truth, and it fails loudly if the two ever stop agreeing —
 * which is the only way a ROM could quietly play at the wrong tempo.
 */
export function resolveClock(script: ChipScript): Clock {
  const { rate, source, divisor } = script.driver;
  if (source === "vblank") {
    return {
      source: "vblank",
      interrupt: IE_VBLANK,
      vector: 0x0040,
      rate: { num: GB_CLOCK, den: FRAME_CLOCKS },
    };
  }
  if (source !== "timer") {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `the gb driver has no '${source}' clock`,
      "the Game Boy's driver runs on its timer or on VBlank; re-arrange with one of those.",
    );
  }
  if (divisor === undefined || divisor < 0 || divisor > 255) {
    throw new AudioRomError("E_DRIVER_CLOCK", "the timer clock has no TMA reload");
  }
  const steps = 256 - divisor;
  const divider = rate.den / steps;
  const tacIndex = TAC_DIVIDERS.indexOf(divider);
  if (tacIndex < 0 || rate.num !== GB_CLOCK) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `no TAC prescaler produces ${rate.num}/${rate.den} Hz with TMA ${divisor}`,
      "the schedule's rate and reload disagree; this is a bug in the timing fit, not in the track.",
    );
  }
  return {
    source: "timer",
    tac: 0x04 | tacIndex,
    tma: divisor,
    interrupt: IE_TIMER,
    vector: 0x0050,
    rate: { num: GB_CLOCK, den: divider * steps },
  };
}

/**
 * Build a cartridge that plays this schedule.
 *
 * The caller has already been told the console is a Game Boy — `buildAudioRom`
 * in `index.ts` is where a console without a driver backend is refused, on the
 * "a backend gap is a build error, never a silent difference" rule.
 */
export function buildGbAudioRom(script: ChipScript, options: AudioRomOptions = {}): BuiltAudioRom {
  const clock = resolveClock(script);
  let data: DriverData;
  try {
    data = packScript(script);
  } catch (error) {
    if (error instanceof PackError) throw new AudioRomError(error.code, error.message, error.hint);
    throw error;
  }

  const asm = new Asm(0);
  const { helpers, dataStart } = emitDriver(asm, data, clock);

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

  if (code.length > GB_ROM_SIZE) {
    throw new AudioRomError(
      "E_TRACK_TOO_LARGE",
      `this schedule packs to ${data.bytes} bytes and a mapper-less cartridge holds ${GB_ROM_SIZE}`,
      "shorten the track, loop it earlier, or arrange with fewer per-tick writes; bank switching is not in v1.",
    );
  }

  const rom = new Uint8Array(GB_ROM_SIZE);
  rom.set(code, 0);
  stampGbHeader(rom, options.title ?? "DEMAKE");

  const wanted = script.driver.rate.num / script.driver.rate.den;
  const actual = clock.rate.num / clock.rate.den;

  return {
    bytes: rom,
    symbols: asm.symbols(),
    // Nothing is stripped on this console: the schedule's own first tick is the
    // chip's power-up, and the driver performs it as an ordinary tick.
    performed: script,
    stats: {
      code: dataStart,
      data: code.length - dataStart,
      free: GB_ROM_SIZE - code.length,
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

/**
 * Emit the whole cartridge image and report which routines it pulled in.
 *
 * Everything is emitted in one pass, in address order, because the SM83
 * assembler resolves forward references with a fixup sweep and nothing relaxes.
 */
function emitDriver(
  asm: Asm,
  data: DriverData,
  clock: Clock,
): { helpers: string[]; dataStart: number } {
  const helpers: string[] = ["tick"];

  // --- vectors ---------------------------------------------------------------
  asm.padTo(clock.vector);
  asm.jp("Interrupt");

  asm.padTo(0x0100);
  asm.nop().jp("Start");

  // $0104-$014F is the logo area and the header; both are stamped into the ROM
  // buffer after assembly, so the code simply steps over them.
  asm.padTo(0x0150);

  // --- start-up --------------------------------------------------------------
  asm.label("Start");
  asm.di();
  asm.ld16("sp", 0xfffe);
  asm.alu("xor", "a");
  asm.stha(H.rest);
  // The APU is powered on by the schedule's own first tick — the binding's
  // `init()` writes are prepended to tick 0 — so there is nothing to set up
  // here that the schedule does not already state.
  asm.ld16("hl", "Order0");
  asm.ld("a", "l").stha(H.orderLo);
  asm.ld("a", "h").stha(H.orderHi);
  asm.ld16("hl", label("Order0", data.loopOrderIndex * 2));
  asm.ld("a", "l").stha(H.loopLo);
  asm.ld("a", "h").stha(H.loopHi);
  asm.call("NextBlock");

  if (clock.source === "timer") {
    asm.alu("xor", "a").stha(0x07); // TAC off while the reload is set
    asm.ldn("a", clock.tma!).stha(0x06); // TMA
    asm.ldn("a", clock.tma!).stha(0x05); // TIMA, so the first tick is a full period
    asm.ldn("a", clock.tac!).stha(0x07);
    helpers.push("timer-clock");
  } else {
    helpers.push("vblank-clock");
  }

  asm.alu("xor", "a").stha(0x0f); // clear anything the boot sequence left pending
  asm.ldn("a", clock.interrupt).stha(0xff); // IE
  asm.ei();
  asm.label("Idle");
  asm.halt();
  asm.jr("Idle");

  // --- the interrupt handler -------------------------------------------------
  asm.label("Interrupt");
  asm.push("af").push("bc").push("de").push("hl");
  asm.call("Tick");
  asm.pop("hl").pop("de").pop("bc").pop("af");
  asm.reti();

  // --- the tick --------------------------------------------------------------
  helpers.push(
    ...emitStream(asm, {
      prefix: "",
      state: H,
      data,
    }),
  );

  // --- the schedule ----------------------------------------------------------
  const dataStart = asm.pc;
  emitStreamData(asm, "", 0, data);

  return { helpers, dataStart };
}
