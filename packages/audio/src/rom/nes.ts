/**
 * The NES audio driver: a bootable cartridge that plays a `ChipScript`.
 *
 * `gb.ts` one console over, and deliberately the same shape — the driver is
 * *generated* for this schedule rather than checked in, so a track that never
 * rests ships no rest handling and the proof needs no toolchain (doc 16 §The
 * driver contract). What is not the same is everything the machine decides, and
 * there are three of those.
 *
 *   - **The clock is the picture's.** This CPU has no timer a driver can have
 *     without burning the DMC channel, so the schedule is fitted to a whole
 *     multiple of the frame rate and the NMI is what performs it. `gb.ts` picks
 *     between a timer and the frame; here there is nothing to pick.
 *   - **There is no entry point**, only a vector. The last six bytes of the
 *     image are what makes the cartridge boot, and they are stamped after
 *     assembly because they are addresses of labels inside it.
 *   - **The PPU has to be told to be quiet**, and then waited for. A cartridge
 *     whose only job is sound still owns the picture hardware, and one that left
 *     rendering on would show whatever the pattern tables powered up holding.
 *
 * The stream player itself is `mos-player.ts`'s and is not this file's at all:
 * it belongs to the *processor*, which is why the same walk plays a PC Engine's
 * six wavetables (`pce.ts`) with a different register base and a different clock
 * in front of it.
 *
 * Sources:
 * - NESdev Wiki — PPU power-up state: https://www.nesdev.org/wiki/PPU_power_up_state
 * - NESdev Wiki — APU frame counter: https://www.nesdev.org/wiki/APU_Frame_Counter
 * - NESdev Wiki — NROM: https://www.nesdev.org/wiki/NROM
 */

import {
  abs,
  Asm6502,
  AsmError,
  imm,
  immHigh,
  immLow,
  label,
  NES_CHR_SIZE,
  NES_PRG_SIZES,
  nesPrgOrigin,
  packInesRom,
  zp,
} from "@demake/core";

import type { ChipScript } from "../chipscript.js";

import { packScript, PackError, type DriverData } from "./data.js";
import { APU_BASE, emitStream, emitStreamData, type MosStreamState } from "./mos-player.js";
import { AudioRomError, type AudioRomOptions, type BuiltAudioRom } from "./gb.js";

/** The registers a cartridge with no picture still has to quieten. */
const PPUCTRL = 0x2000;
const PPUMASK = 0x2001;
const PPUSTATUS = 0x2002;

/**
 * The APU's frame counter, parked in five-step mode with its interrupt off.
 *
 * `$40` is what every NES program writes here at boot, and it matters more in
 * this cartridge than in a game: the frame counter's own IRQ shares the vector
 * this driver points at an `rti`, so leaving it armed would be an interrupt
 * arriving between two writes of a driver tick.
 */
const FRAMECTR = 0x4017;
const FRAMECTR_QUIET = 0x40;

/** The three vectors at the top of the image, in the order the CPU reads them. */
const VECTOR_BYTES = 6;

/**
 * Driver state, in page zero.
 *
 * Page zero is not an optimisation here and never is on this CPU: the block and
 * order pointers are *dereferenced* through `($nn),y`, which is the only
 * indirection the processor has. A standalone cartridge owns the whole page, so
 * the layout starts at zero and the rest of it is simply unused.
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

/** How many ticks a frame owes the driver, which is the whole of the clock. */
interface Clock {
  ticksPerFrame: number;
  rate: { num: number; den: number };
}

/**
 * Resolve the schedule's clock to the number of ticks each frame performs.
 *
 * Shorter than the Game Boy's because there is no register to recover: the
 * binding fits every rate to a whole multiple of this console's frame rate
 * (`binding/nes.ts` §fitRate), so the only question is *which* multiple, and a
 * rate that is not one is a bug in the fit rather than something to round.
 */
export function resolveNesAudioClock(
  script: ChipScript,
  frameRate: {
    num: number;
    den: number;
  },
): Clock {
  const { rate, source } = script.driver;
  if (source !== "vblank") {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `the nes driver has no '${source}' clock`,
      "the NES's driver runs on the frame; re-arrange with `vblank`.",
    );
  }
  const ticks = (rate.num * frameRate.den) / (rate.den * frameRate.num);
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > 8) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `${rate.num / rate.den} Hz is not a whole number of ticks per frame on this console`,
      "the frame is the only clock the driver has; this is a bug in the timing fit, not in the track.",
    );
  }
  return { ticksPerFrame: ticks, rate };
}

/**
 * Build a cartridge that plays this schedule.
 *
 * The caller has already been told the console is an NES — `buildAudioRom` in
 * `index.ts` is where a console with no driver backend is refused, on the "a
 * backend gap is a build error, never a silent difference" rule.
 */
export function buildNesAudioRom(
  script: ChipScript,
  frameRate: { num: number; den: number },
  options: AudioRomOptions = {},
): BuiltAudioRom {
  void options;
  const clock = resolveNesAudioClock(script, frameRate);
  let data: DriverData;
  try {
    data = packScript(script);
  } catch (error) {
    if (error instanceof PackError) throw new AudioRomError(error.code, error.message, error.hint);
    throw error;
  }

  // The big board first, for the reason `codegen/nes.ts` gives: a program that
  // does not fit the small one would be assembled past `$FFFF` there, and this
  // assembler truncates an address rather than refusing it — so a wasted pass
  // would produce garbage rather than an error.
  const attempt = (size: number) => {
    const asm = new Asm6502(nesPrgOrigin(size));
    const built = emitDriver(asm, data, clock);
    try {
      return { asm, code: asm.assemble(), ...built };
    } catch (error) {
      if (error instanceof AsmError) {
        throw new AudioRomError(
          "E_INTERNAL",
          `the driver emitter produced invalid code: ${error.message}`,
        );
      }
      throw error;
    }
  };

  const big = NES_PRG_SIZES[NES_PRG_SIZES.length - 1] as number;
  let built = attempt(big);
  let size = big;
  const board = NES_PRG_SIZES.find((bytes) => built.code.length <= bytes - VECTOR_BYTES);
  if (board !== undefined && board < size) {
    const smaller = attempt(board);
    if (smaller.code.length <= board - VECTOR_BYTES) {
      built = smaller;
      size = board;
    }
  }

  if (built.code.length > size - VECTOR_BYTES) {
    throw new AudioRomError(
      "E_TRACK_TOO_LARGE",
      `this schedule packs to ${data.bytes} bytes and the largest NROM board holds ${
        size - VECTOR_BYTES
      }`,
      "shorten the track, loop it earlier, or arrange with fewer per-tick writes; bank switching is not in v1.",
    );
  }

  const prg = new Uint8Array(size);
  prg.set(built.code, 0);
  // There is no fixed entry point on this CPU — it takes the address from
  // `$FFFC` — so these six bytes are what makes the cartridge boot.
  for (const [index, name] of ["Nmi", "Reset", "Irq"].entries()) {
    const offset = size - VECTOR_BYTES + index * 2;
    const target = built.asm.addressOf(name);
    prg[offset] = target & 0xff;
    prg[offset + 1] = (target >> 8) & 0xff;
  }

  const wanted = script.driver.rate.num / script.driver.rate.den;
  const actual = clock.rate.num / clock.rate.den;

  return {
    // A cartridge with no picture still needs a character bank, because NROM has
    // no short one and the header's count is what a reader believes.
    bytes: packInesRom(prg, new Uint8Array(NES_CHR_SIZE), { mirroring: "vertical" }),
    symbols: built.asm.symbols(),
    // Nothing is stripped here either: this chip's initialisation is a handful
    // of writes and the schedule's own first tick performs them.
    performed: script,
    stats: {
      code: built.dataStart - nesPrgOrigin(size),
      data: built.code.length - (built.dataStart - nesPrgOrigin(size)),
      free: size - VECTOR_BYTES - built.code.length,
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
  asm: Asm6502,
  data: DriverData,
  clock: Clock,
): { helpers: string[]; dataStart: number } {
  const helpers: string[] = ["tick", "frame-clock"];

  // --- start-up --------------------------------------------------------------
  asm.label("Reset");
  asm.sei();
  asm.cld();
  asm.ldx(imm(0xff));
  asm.txs();
  // Rendering off and the APU's frame counter parked, so neither can raise an
  // interrupt this cartridge does not handle.
  asm.lda(imm(0));
  asm.sta(abs(PPUCTRL));
  asm.sta(abs(PPUMASK));
  asm.lda(imm(FRAMECTR_QUIET));
  asm.sta(abs(FRAMECTR));

  // The PPU needs two frames before its registers can be trusted, and its status
  // bit is the only clock available before the NMI is enabled.
  asm.bit(abs(PPUSTATUS));
  asm.label("Warm");
  asm.bit(abs(PPUSTATUS));
  asm.bpl("Warm");
  asm.label("WarmAgain");
  asm.bit(abs(PPUSTATUS));
  asm.bpl("WarmAgain");

  // The chip's own power-up writes are the schedule's: the binding prepends
  // `init()` to tick 0, so there is nothing to set up here it does not state.
  asm.lda(imm(0));
  asm.sta(zp(STATE.rest));
  emitPointer(asm, STATE.orderLo, "Order0");
  emitPointer(asm, STATE.loopLo as number, "Order0", data.loopOrderIndex * 2);
  asm.jsr("NextBlock");

  // Ticks owed, so a frame that owes more than one performs them all rather
  // than dropping the rest — which is the difference between a schedule fitted
  // to twice the frame rate and one played at half speed.
  if (clock.ticksPerFrame > 1) helpers.push("multi-tick-frame");

  asm.lda(imm(0x80)); // NMI on, rendering still off
  asm.sta(abs(PPUCTRL));
  asm.cli();
  asm.label("Idle");
  asm.jmp("Idle");

  // --- the interrupt handler -------------------------------------------------
  //
  // The tick happens *inside* the NMI here, where a game's is counted in the
  // handler and performed by the main loop. A game splits them because the
  // blanking interval belongs to the picture; this cartridge has no picture, so
  // there is nothing for the tick to be in the way of.
  asm.label("Nmi");
  asm.pha();
  asm.txa();
  asm.pha();
  asm.tya();
  asm.pha();
  if (clock.ticksPerFrame > 1) {
    asm.ldx(imm(clock.ticksPerFrame));
    asm.label("NmiTick");
    asm.txa();
    asm.pha();
    asm.jsr("Tick");
    asm.pla();
    asm.tax();
    asm.dex();
    asm.bne("NmiTick");
  } else {
    asm.jsr("Tick");
  }
  asm.pla();
  asm.tay();
  asm.pla();
  asm.tax();
  asm.pla();
  asm.rti();

  // Nothing in this cartridge raises an IRQ, and the vector still has to point
  // somewhere: a cartridge whose `$FFFE` held padding would run it.
  asm.label("Irq");
  asm.rti();

  // --- the tick --------------------------------------------------------------
  helpers.push(
    ...emitStream(asm, {
      prefix: "",
      base: APU_BASE,
      state: STATE,
      scratch: { count: STATE.count, flags: STATE.flags },
      data,
    }),
  );

  // --- the schedule ----------------------------------------------------------
  const dataStart = asm.pc;
  emitStreamData(asm, "", 0, data);

  return { helpers, dataStart };
}

/** Point a page-zero pointer pair at a label, low byte first. */
function emitPointer(asm: Asm6502, slot: number, name: string, offset = 0): void {
  asm.lda(immLow(label(name, offset)));
  asm.sta(zp(slot));
  asm.lda(immHigh(label(name, offset)));
  asm.sta(zp(slot + 1));
}
