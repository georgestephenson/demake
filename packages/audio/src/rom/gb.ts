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
  rest: 0x84,
} as const;

/** Interrupt-enable bits (Pan Docs §Interrupts). */
const IE_VBLANK = 0x01;
const IE_TIMER = 0x04;

/** What a build produced, and what the proof needs to read it back. */
export interface BuiltAudioRom {
  bytes: Uint8Array;
  /** Every label the driver defined — the map the conformance harness reads. */
  symbols: ReadonlyMap<string, number>;
  stats: AudioRomStats;
}

/** Sizes and reductions, reported rather than assumed (doc 17 §Stage 6). */
export interface AudioRomStats {
  /** Driver bytes: the code, plus the vector and header padding the format needs. */
  code: number;
  /** Packed schedule bytes: every block, plus the order list. */
  data: number;
  /** ROM still free. */
  free: number;
  /** Driver ticks the schedule covers. */
  ticks: number;
  /** Distinct blocks after dedup. */
  blocks: number;
  /** Order entries; more than `blocks` means the dedup found repeats. */
  order: number;
  /** Blocks the dedup collapsed. */
  blocksSaved: number;
  /** Driver routines this schedule actually pulled in. */
  helpers: readonly string[];
  /** The tick rate the ROM really runs at, as an exact ratio. */
  rate: { num: number; den: number };
  /** Signed error against the schedule's rate, in parts per million. */
  ratePpmError: number;
}

/** What to stamp on the cartridge. */
export interface AudioRomOptions {
  /** Cartridge title: up to 15 characters, upper-cased ASCII. */
  title?: string;
}

/** Raised when a schedule cannot become a ROM. */
export class AudioRomError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "AudioRomError";
  }
}

/** How the driver gets its tick, resolved to the registers that produce it. */
interface Clock {
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
function resolveClock(script: ChipScript): Clock {
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
  asm.ld16("hl", "Order");
  asm.ld("a", "l").stha(H.orderLo);
  asm.ld("a", "h").stha(H.orderHi);
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
  emitTick(asm, data, helpers);

  // --- the schedule ----------------------------------------------------------
  const blockLabel = (index: number) => `Block${index}`;
  const dataStart = asm.pc;

  asm.label("Order");
  for (const index of data.order) asm.dw(blockLabel(index));
  asm.dw(0x0000); // terminator: playback returns to the loop entry

  for (let index = 0; index < data.blocks.length; index += 1) {
    asm.label(blockLabel(index));
    asm.bytes(data.blocks[index]!);
  }

  return { helpers, dataStart };
}

/**
 * The tick routine, and only the parts of it this schedule needs.
 *
 * Register discipline: `hl` walks the data, `b` counts writes, `c` carries the
 * register number for `ld [$FF00+c], a`, and `de` is used only by
 * `NextBlock` — which is why the handler pushes all four pairs. `ld de, addr`
 * would clobber a live byte here exactly as it does in the game backend
 * (AGENTS.md §Gotchas), so nothing in the write loop touches `d` or `e`.
 */
function emitTick(asm: Asm, data: DriverData, helpers: string[]): void {
  asm.label("Tick");

  if (data.hasRests) {
    // A rest costs five instructions and reaches the common case first: most
    // ticks of most tracks write nothing at all.
    asm.ldha(H.rest);
    asm.alu("or", "a");
    asm.jr("TickPlay", "z");
    asm.dec("a");
    asm.stha(H.rest);
    asm.ret();
    helpers.push("rests");
  }

  asm.label("TickPlay");
  asm.ldha(H.dataLo).ld("l", "a");
  asm.ldha(H.dataHi).ld("h", "a");

  asm.label("TickFetch");
  asm.ldaHLI();
  asm.alu("or", "a");
  asm.jr("TickBlock", "z");
  if (data.hasRests) {
    asm.bit(7, "a");
    asm.jr("TickRest", "nz");
  }
  asm.ld("b", "a");

  asm.label("TickWrite");
  asm.ldaHLI().ld("c", "a"); // register
  asm.ldaHLI().staC(); // value → $FF00 + c
  asm.dec("b");
  asm.jr("TickWrite", "nz");
  asm.jr("TickSave");

  if (data.hasRests) {
    asm.label("TickRest");
    asm.aluN("and", 0x7f);
    asm.stha(H.rest);
  }

  asm.label("TickSave");
  asm.ld("a", "l").stha(H.dataLo);
  asm.ld("a", "h").stha(H.dataHi);
  asm.ret();

  // Reaching the end of a block consumes no tick, so the fetch resumes in the
  // next one — which is why a block always covers at least one tick and the
  // walk cannot spin.
  asm.label("TickBlock");
  asm.call("NextBlock");
  asm.ldha(H.dataLo).ld("l", "a");
  asm.ldha(H.dataHi).ld("h", "a");
  asm.jp("TickFetch");

  emitNextBlock(asm, data);
  helpers.push(data.hasOrder ? "order-walk" : "single-block");
  if (data.oneShot) helpers.push("one-shot-stop");
}

/**
 * Take the next order entry into the data pointer, looping when it runs out.
 *
 * The terminator is `$0000` rather than a length, so the order list is walked
 * with a pointer and nothing counts. `Loop` is an address *inside* the order
 * list, so the reload leaves the pointer two bytes past it and the walk resumes
 * as if it had never ended.
 */
function emitNextBlock(asm: Asm, data: DriverData): void {
  asm.label("NextBlock");
  asm.ldha(H.orderLo).ld("l", "a");
  asm.ldha(H.orderHi).ld("h", "a");
  asm.ldaHLI().ld("e", "a");
  asm.ldaHLI().ld("d", "a");
  asm.alu("or", "e"); // a still holds the high byte
  asm.jr("NextBlockGot", "nz");
  asm.ld16("hl", label("Order", data.loopOrderIndex * 2));
  asm.ldaHLI().ld("e", "a");
  asm.ldaHLI().ld("d", "a");

  asm.label("NextBlockGot");
  asm.ld("a", "l").stha(H.orderLo);
  asm.ld("a", "h").stha(H.orderHi);
  asm.ld("a", "e").stha(H.dataLo);
  asm.ld("a", "d").stha(H.dataHi);
  asm.ret();
}
