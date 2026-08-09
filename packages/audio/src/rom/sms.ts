/**
 * The Sega 8-bit audio driver: a bootable cartridge that plays a `ChipScript`.
 *
 * `gb.ts`, `nes.ts` and `pce.ts` two, one and zero consoles over, and
 * deliberately the same shape — the driver is *generated* for this schedule
 * rather than checked in, so a track that never rests ships no rest handling and
 * the proof needs no toolchain (doc 16 §The driver contract). The stream player
 * is `sms-driver.ts`'s and is not this file's at all: it belongs to the
 * *processor*, and a game already drove it. What is left is the three things a
 * console decides for itself, and on this machine all three are worth stating.
 *
 *   - **The clock is the picture's, and there is nothing to choose.** This CPU
 *     has two interrupt sources and both are the VDP's: the frame, and the line
 *     counter. The line counter is finer and looks like a timer — but it is
 *     reloaded on every scanline *outside* the active display, so an interrupt
 *     programmed for every 65 lines fires twice inside the picture and then not
 *     at all for seventy: two ticks a frame, in a burst, out of the four the rate
 *     claims. This file is what made that worth acting on rather than merely
 *     noting, because it is the first caller that would have had to keep such a
 *     rate — so `psgBinding.fitRate` offers the frame and nothing else now, and
 *     so does the console's own `driver.sources`.
 *   - **There is no entry point and no vector table — there are addresses.** The
 *     Z80 resets to `$0000` and takes a maskable interrupt to `$0038` in mode 1,
 *     so the boot, the frame handler and the Pause handler are not pointed at:
 *     they are *placed*, by padding the image out to the addresses the CPU will
 *     go to. A build that emitted them in the wrong order would still assemble.
 *   - **The header is sixteen bytes inside the image**, at `$7FF0`, rather than a
 *     wrapper around it. A 32 KiB cartridge is therefore one whose code and data
 *     stop below the header, and a schedule that does not fit takes the 48 KiB
 *     board and lays its blocks *either side* of the hole. That is where this
 *     file parts company with `codegen/sms.ts`, which pads the whole data section
 *     past the header: there the code is what fills the region below it, and here
 *     the code is a couple of hundred bytes — so the same bargain would throw
 *     thirty-two kilobytes away and make the larger board unreachable.
 *
 * Two machines, and the difference is two lines. A Game Gear is a Master System
 * whose sound chip has a stereo latch on a port of its own, and the schedule
 * already carries the writes to it — so the only thing this file asks the console
 * is which region nibble to stamp. There is nothing to merge, because a
 * standalone cartridge owns the chip: one stream, no preemption, and the latch is
 * stored outright.
 *
 * Sources:
 * - SMS Power! — ROM Header: https://www.smspower.org/Development/ROMHeader
 * - SMS Power! — VDP Registers: https://www.smspower.org/Development/VDPRegisters
 * - SMS Power! — SN76489: https://www.smspower.org/Development/SN76489
 */

import {
  AsmError,
  AsmZ80,
  label,
  packSegaRom,
  regionFor,
  SMS_FLAT_ROM_SIZES,
  SMS_HEADER_OFFSET,
  SMS_HEADER_SIZE,
  SMS_IRQ_VECTOR,
  SMS_NMI_VECTOR,
  SMS_ORIGIN,
  SMS_ROM_SIZE,
} from "@demake/core";

import type { ChipScript, Rational } from "../chipscript.js";

import type { DriverData } from "./data.js";
import { AudioRomError, type AudioRomOptions, type BuiltAudioRom } from "./gb.js";
import { pack } from "./shared.js";
import { psgPortOf, psgWrite, PSG_PORT } from "./sms-driver.js";
import { emitStream, emitStreamData, type Z80StreamState } from "./z80-player.js";
import { resolveSmsClock } from "./sms-game.js";

/**
 * The VDP's control port.
 *
 * What a register is written through *and* what the frame interrupt is
 * acknowledged by, because reading it clears the status byte — which is the only
 * way to tell this chip the interrupt was taken. The data port at `$BE` is the
 * other half of the pair and this cartridge never touches it: it has no picture.
 */
const VDP_CONTROL = 0xbf;

/**
 * Where the stack starts.
 *
 * The top of work RAM, less the sixteen bytes the mapper's control registers
 * occupy through the mirror at `$DFFC`–`$DFFF`. Pushing into those would page a
 * ROM bank out from under the running program (`asm/sms-cart.ts` §`SMS_RAM_END`),
 * which on a flat cartridge means the interrupt handler disappearing mid-tick.
 */
const STACK_TOP = 0xdff0;

/**
 * The driver's state, in work RAM.
 *
 * Words rather than the byte pairs the Game Boy and the two 6502 machines keep,
 * because this CPU loads and stores sixteen bits in one instruction and has no
 * cheap page to be economical in — `sms-driver.ts` §`Z80StreamState` is where
 * that is stated. A standalone cartridge owns the whole 8 KiB, so the layout
 * starts at the first byte of it and the rest is simply unused.
 */
const STATE: Z80StreamState = {
  data: 0xc000,
  order: 0xc002,
  loop: 0xc004,
  rest: 0xc006,
};

/** How many ticks a frame owes the driver, which is the whole of the clock. */
interface Clock {
  ticksPerFrame: number;
  rate: Rational;
}

/**
 * Build a cartridge that plays this schedule.
 *
 * The caller has already been told the console is a Master System or a Game
 * Gear — `buildAudioRom` in `index.ts` is where a console with no driver backend
 * is refused, on the "a backend gap is a build error, never a silent difference"
 * rule.
 */
export function buildSmsAudioRom(script: ChipScript, options: AudioRomOptions = {}): BuiltAudioRom {
  void options;
  const clock = resolveSmsClock(script);
  // The port rather than the register number, because a Z80 writes a chip with
  // `out (c), a` and the packed byte is what lands in `c`. One stream owns the
  // chip here, so there is no channel tag and no merge set: the Game Gear's
  // stereo latch is a write like any other.
  const data = pack(script, { port: psgPortOf });

  const attempt = (size: number) => {
    const asm = new AsmZ80(SMS_ORIGIN);
    const built = emitDriver(asm, data, clock, size > SMS_ROM_SIZE);
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

  // Smallest first, and each board is a whole pass rather than a measurement:
  // the two differ in where the data is laid out as well as in how much of it
  // fits, because only the larger one has anything above the header to step over
  // to. A pass that does not fit is simply discarded.
  let size = SMS_ROM_SIZE;
  let built: ReturnType<typeof attempt> | undefined;
  for (const board of SMS_FLAT_ROM_SIZES) {
    size = board;
    built = attempt(board);
    if (built.code.length <= limitOf(board)) break;
  }
  const finished = built as ReturnType<typeof attempt>;

  if (finished.code.length > limitOf(size)) {
    throw new AudioRomError(
      "E_TRACK_TOO_LARGE",
      `this driver assembles to ${finished.code.length} bytes and the largest flat Sega cartridge holds ${limitOf(size)}`,
      "shorten the track, loop it earlier, or arrange with fewer per-tick writes; bank switching is not in v1.",
    );
  }

  const image = new Uint8Array(size);
  image.set(finished.code, 0);

  const wanted = script.driver.rate.num / script.driver.rate.den;
  const actual = clock.rate.num / clock.rate.den;

  return {
    bytes: packSegaRom(image, { region: regionFor(script.console) }),
    symbols: finished.asm.symbols(),
    // Nothing is stripped: this chip's initialisation is four attenuation
    // latches and the schedule's own first tick performs them.
    performed: script,
    stats: {
      code: finished.dataStart - SMS_ORIGIN,
      data: finished.code.length - (finished.dataStart - SMS_ORIGIN),
      free: limitOf(size) - finished.code.length,
      ticks: data.ticks,
      blocks: data.blocks.length,
      order: data.order.length,
      blocksSaved: data.blocksSaved,
      helpers: finished.helpers,
      rate: clock.rate,
      ratePpmError: wanted === 0 ? 0 : Math.round(((actual - wanted) / wanted) * 1e6),
    },
  };
}

/**
 * The last byte a build may reach on a board.
 *
 * The header for the small one and the end of the image for the large one, which
 * is not an inconsistency: on the 32 KiB cartridge the header is the last
 * sixteen bytes, and on the 48 KiB one it is a hole in the middle that the data
 * section is padded across.
 */
function limitOf(size: number): number {
  return size === SMS_ROM_SIZE ? SMS_HEADER_OFFSET : size;
}

/** Emit the whole program and report which routines it pulled in. */
function emitDriver(
  asm: AsmZ80,
  data: DriverData,
  clock: Clock,
  hole: boolean,
): { helpers: string[]; dataStart: number } {
  const helpers: string[] = ["tick", "vblank-clock"];

  // --- the addresses the CPU goes to -----------------------------------------
  //
  // Placed rather than pointed at: there is no vector table on this machine, so
  // the first instruction is the first byte of the cartridge and the maskable
  // interrupt lands at a fixed address in mode 1.
  asm.label("Boot");
  asm.di();
  asm.jp("Reset");

  asm.padTo(SMS_IRQ_VECTOR);
  asm.label("Irq");
  // The tick happens *inside* the handler here, where a game's is counted in it
  // and performed by the main loop. A game splits them because the blanking
  // interval belongs to the picture; this cartridge has no picture, so there is
  // nothing for the tick to be in the way of. Every register the stream player
  // touches is saved, because what it interrupted is the idle loop only by
  // convention — the boot runs with interrupts off, but a longer one would not.
  asm.push("af");
  asm.push("bc");
  asm.push("de");
  asm.push("hl");
  // Reading the status byte is how this VDP is acknowledged; without it the
  // interrupt is still pending when `ei` runs and the handler re-enters for ever.
  asm.inN(VDP_CONTROL);
  if (clock.ticksPerFrame > 1) {
    asm.ldn("b", clock.ticksPerFrame);
    asm.label("IrqTick");
    asm.push("bc");
    asm.call("Tick");
    asm.pop("bc");
    asm.djnz("IrqTick");
    helpers.push("multi-tick-frame");
  } else {
    asm.call("Tick");
  }
  asm.pop("hl");
  asm.pop("de");
  asm.pop("bc");
  asm.pop("af");
  asm.ei();
  asm.reti();

  asm.padTo(SMS_NMI_VECTOR);
  asm.label("Nmi");
  // Pause, which this cartridge has nothing to do with — and the vector still has
  // to hold an instruction, because a Master System whose `$0066` held padding
  // would run it the first time somebody pressed the button.
  asm.retn();

  // --- start-up --------------------------------------------------------------
  asm.label("Reset");
  asm.ld16("sp", STACK_TOP);
  asm.im(1);

  // Mode 4 with no line interrupt, the display off, the frame interrupt armed,
  // and the line counter parked. A cartridge whose only job is sound still owns
  // the picture hardware, and the frame interrupt is the clock — so this is the
  // smallest VDP setup that is a clock rather than a screen.
  emitVdpRegister(asm, 0, 0x04);
  emitVdpRegister(asm, 1, 0x20);
  emitVdpRegister(asm, 10, 0xff);

  // The chip powers up making noise on all four channels and the first tick is a
  // whole frame away, so it is silenced here as well as by the schedule's own
  // opening writes. Costs eight bytes and is what the game backend's boot does
  // for the same reason.
  for (const latch of [0x9f, 0xbf, 0xdf, 0xff]) {
    asm.ldn("a", latch);
    asm.outN(PSG_PORT.psg);
  }

  asm.alu("xor", "a");
  asm.sta(STATE.rest);
  asm.ld16("hl", label("Order0"));
  asm.st16To(STATE.order, "hl");
  asm.ld16("hl", label("Order0", data.loopOrderIndex * 2));
  asm.st16To(STATE.loop as number, "hl");
  asm.call("NextBlock");

  asm.ei();
  asm.label("Idle");
  asm.jp("Idle");

  // --- the tick --------------------------------------------------------------
  helpers.push(...emitStream(asm, { prefix: "", state: STATE, data, write: psgWrite }));

  // --- the schedule ----------------------------------------------------------
  //
  // The header hole is stepped over *inside* the data rather than in front of
  // it, which is where this file parts company with the game backend. There the
  // code is what fills the region below `$7FF0` and the tables start above it;
  // here the code is a couple of hundred bytes, so padding the whole data
  // section past the header would throw away thirty-two kilobytes — and the
  // larger board would be unreachable, because every schedule big enough to
  // need it would also be too big for what was left. Blocks are addressed by
  // label, so a gap between two of them costs the gap and nothing else.
  const dataStart = asm.pc;
  emitStreamData(
    asm,
    "",
    0,
    data,
    hole ? { from: SMS_HEADER_OFFSET, to: SMS_HEADER_OFFSET + SMS_HEADER_SIZE } : undefined,
  );

  return { helpers, dataStart };
}

/** Write one VDP register: the value first, then the register number. */
function emitVdpRegister(asm: AsmZ80, register: number, value: number): void {
  asm.ldn("a", value);
  asm.outN(VDP_CONTROL);
  asm.ldn("a", 0x80 | register);
  asm.outN(VDP_CONTROL);
}
