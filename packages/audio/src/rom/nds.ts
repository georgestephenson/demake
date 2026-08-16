/**
 * The Nintendo DS audio driver: a bootable cartridge that plays a `ChipScript`.
 *
 * The ninth standalone cartridge, and the sharpest statement in the set of a
 * claim this console makes twice over: **the driver is not on the processor the
 * cartridge is nominally for**. A `.nds` names two binaries and the loader copies
 * both into the four megabytes they share, so what a game builds here is an ARM9
 * program with an ARM7 one beside it — and a cartridge whose only job is a track
 * needs the second and almost nothing of the first.
 *
 * So this is the one standalone whose **main processor does nothing at all**. The
 * ARM9's whole program is a branch to itself: the sound channels answer the ARM7
 * alone, the loader enters that processor from the same image, and there is no
 * upload, no handshake and no request. The Super Nintendo's driver is also off
 * the console's own CPU and has to be *sent* there; here the loader does it.
 *
 * Two other answers are this machine's rather than a predecessor's restated.
 *
 *   - **The clock is a hardware tally, and it is the same clock a game gets.**
 *     Timer 0 reloads at the driver rate and timer 1 counts its overflows, so how
 *     many ticks have happened is a register the driver *reads* — no interrupt
 *     anywhere in this cartridge, and a tick cannot be lost by a driver that was
 *     busy. `resolveNdsClock` is therefore *called* rather than mirrored: unlike
 *     the Mega Drive's and the WonderSwan's, this console's two callers keep the
 *     same rate, because neither of them is polling anything that can drift.
 *   - **The waveform bank has to *be* at the address the binding named**, because
 *     a channel reads an absolute pointer rather than an index. `emitBankCopy`
 *     puts it there at boot, which is the same routine a game's driver runs and
 *     the reason this console's bank is bytes to copy rather than register
 *     writes.
 *
 * Sources: GBATEK — *DS Cartridge Header*, *DS Sound*
 * (https://problemkaputt.de/gbatek.htm).
 */

import {
  AsmArm,
  AsmError,
  armAt,
  armAtPost,
  armImm,
  label,
  packNdsRom,
  NDS_ARM7_RAM,
  NDS_ARM9_RAM,
  type Ref,
} from "@demake/core";

import { bindingFor } from "../binding/registry.js";
import type { ChipScript } from "../chipscript.js";

import { REG, emitStream, emitStreamData, type ArmStreamState } from "./arm-player.js";
import { AudioRomError, type AudioRomOptions, type BuiltAudioRom } from "./artifact.js";
import type { DriverData } from "./data.js";
import {
  emitBankCopy,
  emitBankData,
  emitClockStart,
  emitMainLoop,
  emitSoundWrite,
  emitWrite,
  ndsPort,
  NDS_STACK_TOP,
  NDS_STATE_BASE,
} from "./nds-driver.js";
import { resolveNdsClock } from "./nds-game.js";
import { MAX_PENDING, pack, stripBoot } from "./shared.js";

/** Main RAM, which is what a `.nds` image is copied into and bounded by. */
const NDS_MAIN_RAM_BYTES = 0x00400000;

/**
 * Where the driver keeps its position: the ARM7's own memory, as a game's does.
 *
 * One stream rather than two and no request bytes, so this is the game's layout
 * with everything a second stream needs left out.
 */
const STATE = (() => {
  let at = NDS_STATE_BASE;
  const word = (): number => {
    const address = at;
    at += 4;
    return address;
  };
  const data = word();
  const order = word();
  const loop = word();
  const tally = at;
  at += 2;
  const rest = at;
  at += 1;
  // No `active`: this stream starts at boot and never stops.
  const music: ArmStreamState = { data, order, loop, rest };
  at = (at + 3) & ~3;
  return { base: NDS_STATE_BASE, music, tally, end: at };
})();

/**
 * Build a cartridge that plays this schedule.
 *
 * The caller has already been told the console is a Nintendo DS —
 * `buildAudioRom` in `index.ts` is where a console with no driver backend is
 * refused, on the "a backend gap is a build error, never a silent difference"
 * rule.
 */
export function buildNdsAudioRom(script: ChipScript, options: AudioRomOptions = {}): BuiltAudioRom {
  const clock = resolveNdsClock(script);
  const binding = bindingFor(script.console);
  const boot = binding.init();

  // Stripped rather than performed from tick 0, on every standalone's terms: the
  // boot writes the chip's initialisation once, and a second copy at the head of
  // the stream would re-silence the first tick.
  const performed = stripBoot(script, boot);
  // No channel tag and no merge set: one stream owns the hardware, and nothing
  // on this chip is shared between channels anyway (`binding/nds.ts`).
  const data = pack(performed, { port: ndsPort });

  const arm7 = new AsmArm(NDS_ARM7_RAM);
  let built: { helpers: string[]; dataStart: number };
  let image: Uint8Array;
  try {
    built = emitDriver(arm7, data, boot, clock);
    image = arm7.assemble();
  } catch (error) {
    if (error instanceof AsmError) {
      throw new AudioRomError(
        "E_INTERNAL",
        `the driver emitter produced invalid code: ${error.message}`,
      );
    }
    throw error;
  }

  const wanted = script.driver.rate.num / script.driver.rate.den;
  const actual = clock.rate.num / clock.rate.den;

  return {
    bytes: packNdsRom(mainProcessorStub(), image, {
      ...(options.title === undefined ? {} : { title: options.title }),
    }),
    symbols: arm7.symbols(),
    performed,
    stats: {
      code: built.dataStart - NDS_ARM7_RAM,
      data: image.length - (built.dataStart - NDS_ARM7_RAM),
      // The image is copied into main RAM rather than run from a board, so what
      // is free is that — the Game Boy Advance's answer for the same reason, one
      // console along.
      free: NDS_MAIN_RAM_BYTES - image.length,
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

/**
 * The main processor's whole program.
 *
 * A branch to itself, which is the honest thing for a cartridge whose sound
 * hardware this processor cannot reach: there is nothing for it to do, and a
 * program that spun *doing* something would be spending a bus the driver shares.
 * It cannot be omitted — a `.nds` names two binaries and the loader enters this
 * one — so it is one instruction rather than none.
 */
function mainProcessorStub(): Uint8Array {
  const asm = new AsmArm(NDS_ARM9_RAM);
  asm.label("Halt");
  asm.b("Halt");
  return asm.assemble();
}

/** Emit the whole driver and report which routines it pulled in. */
function emitDriver(
  asm: AsmArm,
  data: DriverData,
  boot: readonly { reg: number; value: number }[],
  clock: { divisor: number },
): { helpers: string[]; dataStart: number } {
  const helpers: string[] = ["tick", "hardware-tally"];

  // --- start-up --------------------------------------------------------------
  //
  // The loader has already put this binary where it belongs and entered it, so
  // there is nothing to copy and nothing to wait for — which is the whole of what
  // this console's hand-off costs (`nds-game.ts` §the cartridge's other binary).
  asm.label("Reset");
  asm.ldrConst(13, NDS_STACK_TOP);
  // The bank has to *be* at the address the binding named, because a channel
  // reads an absolute pointer rather than an index.
  emitBankCopy(asm, "AudioBankBytes");

  asm.ldrConst(REG.a0, STATE.base);
  asm.mov(REG.a1, armImm(0));
  asm.mov(REG.a2, armImm((STATE.end - STATE.base + 3) >> 2));
  asm.label("AudioClearState");
  asm.str(REG.a1, armAtPost(REG.a0, 4));
  asm.subs(REG.a2, REG.a2, armImm(1));
  asm.b("AudioClearState", "ne");

  for (const write of boot) emitSoundWrite(asm, write.reg, write.value);

  // The stream's own position, after the hardware and before the clock starts.
  asm.ldrConst(REG.a0, label("Order0") as Ref);
  asm.ldrConst(REG.a1, STATE.base);
  asm.str(REG.a0, armAt(REG.a1, STATE.music.order - STATE.base));
  asm.ldrConst(REG.a0, label("Order0", data.loopOrderIndex * 4) as Ref);
  asm.str(REG.a0, armAt(REG.a1, (STATE.music.loop as number) - STATE.base));
  asm.bl("NextBlock");

  emitClockStart(asm, clock.divisor);
  asm.b("AudioMain");
  asm.ltorg();

  // --- the loop and the tick -------------------------------------------------
  emitMainLoop(asm, { tally: STATE.tally, base: STATE.base }, MAX_PENDING);
  // Two names for one address, and no instruction between them. The shared main
  // loop calls `AudioTick` because a game's driver has two streams to step and a
  // routine that does both; this cartridge has one stream and no such routine, so
  // naming the stream's own entry is cheaper than a tail call — and `Tick` stays
  // the name doc 16's proof attributes a tick by.
  asm.label("AudioTick");
  helpers.push(...emitStream(asm, { prefix: "", state: STATE.music, data, base: STATE.base }));
  emitWrite(asm);

  // --- the schedule ----------------------------------------------------------
  asm.align();
  const dataStart = asm.pc;
  emitBankData(asm, "AudioBankBytes");
  emitStreamData(asm, "", 0, data);

  return { helpers, dataStart };
}
