/**
 * The Virtual Boy audio driver: a bootable cartridge that plays a `ChipScript`.
 *
 * The eighth standalone cartridge and the first on this processor, so unlike the
 * five before it this one arrives *with* its player rather than reusing one:
 * `v810-player.ts` is the walk, and what is here is the three things a console
 * decides for itself — a boot sequence, a clock, and how a packed byte reaches
 * the chip.
 *
 * Three of those answers are this machine's.
 *
 *   - **A packed register is a *port*, because this chip's registers do not fit
 *     in a byte.** The VSU's address space is eleven bits — five waveform
 *     tables, a modulation table and six channel blocks, all one region rather
 *     than a port and an index — so a schedule's register number runs to `$7FF`
 *     and the packed format spends one byte on it. What a *stream* carries is
 *     narrower than that: the waveform tables are written once at boot and
 *     stripped, so everything left is a channel register or the stop register,
 *     which is forty-nine values. {@link portOf} packs a channel and its
 *     register into six bits and the driver takes them apart again, which is the
 *     Mega Drive's five destinations reached by a chip with more registers
 *     rather than more chips.
 *   - **The clock is the picture, and this cartridge takes no interrupt to learn
 *     it.** A demade Virtual Boy game polls `INTPND` for `XPEND` because a loop
 *     that waits either way gains nothing from a vector (`codegen/vb/emit.ts`),
 *     and a cartridge whose only job is a track has even less to gain. So the
 *     idle loop waits for the drawing processor to finish, acknowledges, and
 *     ticks — at 50.2 Hz, the slowest driver rate in the matrix and the one
 *     `vbBinding.fitRate` already returns.
 *   - **The waveform tables go in the boot, and they are the whole of why the
 *     prefix is stripped.** A hundred and sixty writes through five tables is
 *     more than a packed run's count can hold, which is the PC Engine's reason
 *     rather than the Game Boy's — and a channel enabled before its table is in
 *     place plays whatever powered up at that address.
 *
 * Sources: the Virtual Boy *Sacred Tech Scroll* (`vbtech`, David Tucker) — VSU
 * register map and the VIP's interrupt registers.
 */

import {
  Asm810,
  AsmError,
  label,
  packVbRom,
  vbRomSize,
  VB_INTCLR,
  VB_INTPND,
  VB_INT_XPEND,
  VB_ROM,
  VB_VSU,
  VB_WRAM,
} from "@demake/core";

import { bindingFor } from "../binding/registry.js";
import type { ChipScript, Rational } from "../chipscript.js";

import type { DriverData } from "./data.js";
import { AudioRomError, type AudioRomOptions, type BuiltAudioRom } from "./artifact.js";
import { pack, stripBoot } from "./shared.js";
import { emitStream, emitStreamData, REG, type V810StreamState } from "./v810-player.js";

/** The chip's channel block, as `@demake/chip`'s `Vsu` numbers it. */
const CHANNEL_BASE = 0x400;
const CHANNEL_STRIDE = 0x40;
const STOP_REG = 0x580;

/** The port byte the stop register takes, above the forty-eight channel ones. */
const STOP_PORT = 48;

/**
 * A schedule's register number, as one byte the driver can take apart.
 *
 * Six bits: three of channel and three of register, because a channel block is
 * eight registers four bytes apart. Anything outside the channel blocks is the
 * stop register, which is the only other thing a stripped stream can carry —
 * and a schedule that carried a waveform write here would be a timbre change
 * mid-piece, which this chip's binding does not make (a table is a boot
 * decision).
 */
export function portOf(reg: number): number {
  if (reg === STOP_REG) return STOP_PORT;
  if (reg < CHANNEL_BASE || reg >= CHANNEL_BASE + 6 * CHANNEL_STRIDE) {
    throw new AudioRomError(
      "E_INTERNAL",
      `a stream for this console carries register $${reg.toString(16)}, which is neither a channel nor the stop register`,
      "the waveform tables are performed at boot and stripped from the stream; this is a bug in the ROM builder, not in the track.",
    );
  }
  const channel = (reg - CHANNEL_BASE) >> 6;
  return (channel << 3) | ((reg & 0x3f) >> 2);
}

/**
 * Where the driver keeps its position.
 *
 * The first words of the console's sixty-four kilobytes, which nothing else in
 * this cartridge uses — the stack is at the top and the packed data is in ROM.
 */
const STATE: V810StreamState = {
  data: VB_WRAM,
  order: VB_WRAM + 4,
  loop: VB_WRAM + 8,
  rest: VB_WRAM + 12,
};

/** The top of work RAM, which is where this program's stack starts. */
const STACK_TOP = VB_WRAM + 0x10000;

/**
 * Build a cartridge that plays this schedule.
 *
 * The caller has already been told the console is a Virtual Boy —
 * `buildAudioRom` in `index.ts` is where a console with no driver backend is
 * refused, on the "a backend gap is a build error, never a silent difference"
 * rule.
 */
export function buildVbAudioRom(script: ChipScript, options: AudioRomOptions = {}): BuiltAudioRom {
  const binding = bindingFor(script.console);
  const boot = binding.init();
  const rate = script.driver.rate;

  // Stripped rather than performed from tick 0, for the PC Engine's reason: five
  // waveform tables is a hundred and sixty writes, which is more than a run's
  // count byte holds, so stripping is what makes tick 0 packable at all.
  const performed = stripBoot(script, boot);
  const data = pack(performed, { port: portOf });

  const asm = new Asm810(VB_ROM);
  let built: { helpers: string[]; dataStart: number };
  let code: Uint8Array;
  try {
    built = emitDriver(asm, data, boot);
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

  const size = vbRomSize(code.length);
  const wanted = rate.num / rate.den;
  const actual = wanted;

  return {
    bytes: packVbRom(code, {
      size,
      ...(options.title === undefined ? {} : { title: options.title }),
    }),
    symbols: asm.symbols(),
    performed,
    stats: {
      code: built.dataStart - VB_ROM,
      data: code.length - (built.dataStart - VB_ROM),
      free: size - code.length,
      ticks: data.ticks,
      blocks: data.blocks.length,
      order: data.order.length,
      blocksSaved: data.blocksSaved,
      helpers: built.helpers,
      rate,
      ratePpmError: wanted === 0 ? 0 : Math.round(((actual - wanted) / wanted) * 1e6),
    },
  };
}

/** Emit the whole program and report which routines it pulled in. */
function emitDriver(
  asm: Asm810,
  data: DriverData,
  boot: readonly { reg: number; value: number }[],
): { helpers: string[]; dataStart: number } {
  const helpers: string[] = ["tick", "frame-poll"];

  // --- start-up --------------------------------------------------------------
  //
  // The processor arrives from the reset stub `packVbRom` puts in the
  // cartridge's own last sixteen bytes, with nothing set up at all.
  asm.label("Boot");
  asm.movImm32(STACK_TOP, REG.sp);

  // The chip's whole initialisation, waveform tables included, performed from
  // here rather than from tick 0.
  asm.movImm32(VB_VSU, REG.addr);
  for (const write of boot) {
    asm.movImm32(write.value, REG.a0);
    asm.stb(REG.a0, write.reg, REG.addr);
  }

  asm.movImm32(STATE.data, REG.state);
  asm.stb(0, STATE.rest - STATE.data, REG.state);
  asm.movImm32(label("Order0"), REG.a0);
  asm.stw(REG.a0, STATE.order - STATE.data, REG.state);
  asm.movImm32(label("Order0", data.loopOrderIndex * 4), REG.a0);
  asm.stw(REG.a0, (STATE.loop as number) - STATE.data, REG.state);
  asm.jal("NextBlock");

  // --- the loop --------------------------------------------------------------
  //
  // The drawing processor's own flag, polled and acknowledged — which is what a
  // demade game on this console does, because a loop that waits either way is a
  // loop that waits.
  asm.label("Idle");
  asm.movImm32(VB_INTPND, REG.addr);
  asm.label("IdleWait");
  asm.ldh(0, REG.addr, REG.a0);
  asm.andi(VB_INT_XPEND, REG.a0, REG.a0);
  asm.bcond("e", "IdleWait");
  asm.movImm32(0xffff, REG.a0);
  asm.sth(REG.a0, VB_INTCLR - VB_INTPND, REG.addr);
  asm.jal("Tick");
  asm.jr("Idle");

  // --- the tick --------------------------------------------------------------
  helpers.push(...emitStream(asm, { prefix: "", state: STATE, data }));
  emitWrite(asm);

  // --- the schedule ----------------------------------------------------------
  asm.align(4);
  const dataStart = asm.pc;
  emitStreamData(asm, "", 0, data);

  return { helpers, dataStart };
}

/**
 * One packed write: `a0` is the port byte and `a1` its value.
 *
 * The port is taken apart rather than looked up, because the packing is
 * arithmetic: three bits of channel times sixty-four, three bits of register
 * times four. The stop register is the one value above the channels and is the
 * only comparison in here.
 */
function emitWrite(asm: Asm810): void {
  asm.label("AudioWrite");
  asm.movImm32(VB_VSU + STOP_REG, REG.addr);
  // A five-bit immediate reaches −16…15 and the stop port is 48, so the
  // comparison takes a register — which is also why it is the only one here.
  asm.movImm32(STOP_PORT, REG.a2);
  asm.cmp(REG.a2, REG.a0);
  asm.bcond("e", "AudioWriteGo");
  // channel × $40: the top three bits of the port, shifted up by three more.
  asm.movReg(REG.a0, REG.a2);
  asm.shrImm5(3, REG.a2);
  asm.shlImm5(6, REG.a2);
  // register × 4: the low three bits.
  asm.andi(0x07, REG.a0, REG.addr);
  asm.shlImm5(2, REG.addr);
  asm.add(REG.a2, REG.addr);
  asm.movImm32(VB_VSU + CHANNEL_BASE, REG.a2);
  asm.add(REG.a2, REG.addr);
  asm.label("AudioWriteGo");
  asm.stb(REG.a1, 0, REG.addr);
  asm.jmp(REG.lp);
}

/** The rate a schedule for this console is fitted to, as a rational. */
export function vbClock(script: ChipScript): { rate: Rational } {
  return { rate: script.driver.rate };
}
