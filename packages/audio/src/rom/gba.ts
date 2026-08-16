/**
 * The Game Boy Advance audio driver: a bootable cartridge that plays a
 * `ChipScript`.
 *
 * The seventh standalone cartridge, and the fifth measurement of the same claim:
 * **the stream player is the processor's**. `arm-player.ts` and `gba-driver.ts`
 * are not touched here at all — a game already drove both — so what this file
 * owns is a boot sequence, a clock and a cartridge wrapper, exactly as `sms.ts`,
 * `pce.ts`, `md.ts` and `wsc.ts` do.
 *
 * What makes this one worth having anyway is that it is the first standalone on
 * a console whose second sound device is **not a chip**. Six of this machine's
 * ten voices are `@demake/chip`'s `GbaPcm` — a mixer, whose output the processor
 * computes — so this cartridge is the first in the set whose idle loop is not
 * idle: it spends most of every tick mixing, and the proof for that half is the
 * samples themselves rather than a register stream (doc 16 §The proof, for a
 * mixer console).
 *
 * Three things about it are this console's rather than a predecessor's restated.
 *
 *   - **The clock is the transfer, and it is the same clock a game gets.** On
 *     the Mega Drive and the WonderSwan the standalone and the game differ about
 *     what the hardware will keep, because both poll and only one of them has a
 *     game in the loop. Here neither polls: sixteen FIFO refills are one block
 *     and the sixteenth refill's interrupt *is* the block boundary, so the rate
 *     is 128 Hz on both callers and `resolveGbaClock` is called rather than
 *     mirrored. This console is where the caller distinction stops mattering,
 *     and it stops mattering because the hardware counts rather than ticking.
 *   - **The idle loop is where the mixing happens**, for the game driver's own
 *     reason: a mix inside the handler would be twenty thousand cycles with
 *     interrupts masked, which is two refills the handler would then never see.
 *     So this loop calls `AudioService` and does nothing else, and the split
 *     between the handler that counts and the loop that performs is the same
 *     split a game makes.
 *   - **One stream owns the hardware**, so there is no steal mask, no `NR51`
 *     merge, no shadow and no restriction — the flat packed format, and `NR51`
 *     stored outright. That is the same simplification every standalone makes
 *     over its game, and on this console it removes the one shared byte the
 *     whole board has.
 *
 * Sources: GBATEK — *GBA Cartridge Header*, *GBA Sound Controller*, *Sound
 * Channel A and B (DMA Sound)* (https://problemkaputt.de/gbatek.htm).
 */

import { GBA_PCM_KOF, GBA_PCM_VOICES } from "@demake/chip";
import {
  AsmArm,
  AsmError,
  armAt,
  armImm,
  armReg,
  gbaSoundAddress,
  label,
  packGbaRom,
  GBA_HEADER_SIZE,
  GBA_IRQ_VECTOR,
  GBA_IWRAM_START,
  GBA_ORIGIN,
} from "@demake/core";

import { bindingFor } from "../binding/registry.js";
import type { ChipScript } from "../chipscript.js";

import { REG, emitStream, emitStreamData, type ArmStreamState } from "./arm-player.js";
import type { DriverData } from "./data.js";
import { AudioRomError, type AudioRomOptions, type BuiltAudioRom } from "./artifact.js";
import {
  emitBank,
  emitIrq,
  emitMix,
  emitMixCopy,
  emitMixWrite,
  emitSoundInit,
  emitSoundWrite,
  emitWrite,
  gbaPort,
  GBA_BLOCK_SAMPLES,
  GBA_MIX_CODE_BYTES,
  GBA_RING_BLOCKS,
  VOICE_STRIDE,
} from "./gba-driver.js";
import { resolveGbaClock } from "./gba-game.js";
import { pack, stripBoot } from "./shared.js";

/**
 * The largest cartridge this builder will produce.
 *
 * Thirty-two megabytes is the bus, and nothing here approaches it — a long track
 * is tens of kilobytes. The limit exists so a schedule that somehow did would be
 * refused by name rather than producing an image the console cannot address.
 */
const MAX_ROM_BYTES = 0x02000000;

/** `WAITCNT`, as every cartridge on this console leaves it. */
const WAITCNT = { at: 0x04000204, value: 0x4317 } as const;

/** The interrupt master enable, which is the last thing the boot switches on. */
const IME = 0x04000208;

/**
 * `IE`, as an offset from the I/O base the BIOS dispatcher leaves in `r0`.
 *
 * A register rather than an offset on each access, because `$202` — `IF`, the
 * halfword above it — is not an ARM immediate: eight bits rotated by an even
 * amount does not reach it, so the base is built once and both halfwords are
 * read through it.
 */
const IE_OFFSET = 0x200;

/** Where the BIOS keeps the flags a `SWI IntrWait` would read back. */
const BIOS_IF = 0x03007ff8;

/**
 * The system-mode stack.
 *
 * The BIOS already points it here before a cartridge's first instruction, so
 * this is a restatement rather than a requirement — and it is written for the
 * game backend's reason: a program that depends on a boot ROM having done
 * something is a program that is one emulator away from not booting.
 */
const STACK_TOP = 0x03007f00;

/**
 * The driver's state, at the bottom of internal work RAM.
 *
 * Nothing else runs on this machine, so it starts at the first byte — a game
 * takes this from its own memory plan instead, and the shape below is that plan
 * with everything a second stream needs left out. What dominates it is not the
 * stream position but the **mixing accumulator**: a 32-bit word per side per
 * sample of a block, in internal RAM rather than beside the ring in external
 * RAM, because the mix loop touches it four times a sample.
 */
const STATE = (() => {
  let at = GBA_IWRAM_START;
  const word = (): number => {
    const address = at;
    at += 4;
    return address;
  };
  const byte = (): number => {
    const address = at;
    at += 1;
    return address;
  };
  const data = word();
  const order = word();
  const loop = word();
  // No `active`: this stream starts at boot and never stops, so the byte a
  // stoppable stream tests would be a byte nothing ever writes.
  const music: ArmStreamState = { data, order, loop, rest: byte() };
  const refill = byte();
  const readBlock = byte();
  const writeBlock = byte();
  const pending = byte();
  at = (at + 3) & ~3;
  const voices = at;
  at += GBA_PCM_VOICES * VOICE_STRIDE;
  const acc = at;
  at += GBA_BLOCK_SAMPLES * 2 * 4;
  // The mix routine itself, because on this console an instruction fetched from
  // the cartridge costs four cycles and one fetched from here costs none
  // (`gba-driver.ts` §GBA_MIX_CODE_BYTES).
  const mixCode = at;
  at += GBA_MIX_CODE_BYTES;
  return {
    base: GBA_IWRAM_START,
    music,
    refill,
    readBlock,
    writeBlock,
    pending,
    voices,
    acc,
    mixCode,
    end: at,
  };
})();

/** A state field, as an offset from the base register. */
const off = (address: number): number => address - STATE.base;

// The stack grows down from here and the BIOS keeps its own flags just above it,
// so the state has to end below it — three kilobytes of a thirty-two kilobyte
// region, most of it the accumulator. Checked rather than assumed, because
// overrunning it would be a driver quietly mixing into its own return addresses.
if (STATE.end > STACK_TOP) {
  throw new Error(
    `the driver's state ends at $${STATE.end.toString(16)} and the stack starts at $${STACK_TOP.toString(16)}`,
  );
}

/**
 * Build a cartridge that plays this schedule.
 *
 * The caller has already been told the console is a Game Boy Advance —
 * `buildAudioRom` in `index.ts` is where a console with no driver backend is
 * refused, on the "a backend gap is a build error, never a silent difference"
 * rule.
 */
export function buildGbaAudioRom(script: ChipScript, options: AudioRomOptions = {}): BuiltAudioRom {
  void options;
  const clock = resolveGbaClock(script);
  const binding = bindingFor(script.console);
  const boot = binding.init();
  const port = (reg: number, chip: number): number => gbaPort(reg, chip, gbaSoundAddress);

  // Stripped rather than performed from tick 0, for the reason every standalone
  // strips it: the boot writes the chip's initialisation once, and leaving a
  // second copy at the head of the stream would re-silence the first tick.
  const performed = stripBoot(script, boot);
  // No channel tag and no merge set: one stream owns the hardware, so nothing is
  // preempted and `NR51` is a register like any other.
  const data = pack(performed, { port });
  // `KOF` is a second way to say what a level of zero already says, and the
  // binding never emits it — so the driver only grows the path if a schedule
  // really carries one.
  const keyOff = performed.ticks.some((tick) =>
    tick.writes.some((write) => (write.chip ?? 0) === 1 && write.reg === GBA_PCM_KOF),
  );

  const asm = new AsmArm(GBA_ORIGIN);
  let built: { helpers: string[]; dataStart: number };
  let code: Uint8Array;
  try {
    built = emitDriver(asm, data, boot, port, keyOff);
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

  if (code.length > MAX_ROM_BYTES) {
    throw new AudioRomError(
      "E_TRACK_TOO_LARGE",
      `this driver assembles to ${code.length} bytes and the cartridge bus reaches ${MAX_ROM_BYTES}`,
      "shorten the track or loop it earlier.",
    );
  }

  const wanted = script.driver.rate.num / script.driver.rate.den;
  const actual = clock.rate.num / clock.rate.den;

  return {
    bytes: packGbaRom(code),
    symbols: asm.symbols(),
    performed,
    stats: {
      code: built.dataStart - GBA_ORIGIN,
      data: code.length - (built.dataStart - GBA_ORIGIN),
      free: MAX_ROM_BYTES - code.length,
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
  asm: AsmArm,
  data: DriverData,
  boot: readonly { reg: number; value: number; chip?: number }[],
  port: (reg: number, chip: number) => number,
  keyOff: boolean,
): { helpers: string[]; dataStart: number } {
  const helpers: string[] = ["tick", "transfer-clock", "mixer", "mixer-in-work-ram"];
  if (keyOff) helpers.push("mixer-key-off");

  // --- start-up --------------------------------------------------------------
  //
  // The cartridge's first word is a branch over the 192-byte header
  // (`core/src/asm/gba-cart.ts`), which `packGbaRom` stamps into the space this
  // leaves.
  asm.b("Boot");
  asm.padTo(GBA_ORIGIN + GBA_HEADER_SIZE);

  asm.label("Boot");
  asm.movImm32(REG.addr, WAITCNT.at);
  asm.movImm32(REG.a0, WAITCNT.value);
  asm.strh(REG.a0, armAt(REG.addr, 0));
  asm.movImm32(13, STACK_TOP);

  // The vector before anything can raise an interrupt, which is before
  // `AudioInit` starts the transfers below. This machine cannot install its own
  // — `$00000018` is BIOS ROM — so the handler is reached through the pointer
  // the dispatcher reads.
  asm.movImm32(REG.a0, label("AudioVector"));
  asm.movImm32(REG.addr, GBA_IRQ_VECTOR);
  asm.str(REG.a0, armAt(REG.addr, 0));
  asm.movImm32(REG.addr, IME);
  asm.mov(REG.a0, armImm(1));
  asm.strh(REG.a0, armAt(REG.addr, 0));

  asm.bl("AudioInit");

  // --- the loop --------------------------------------------------------------
  //
  // Nothing else runs on this machine, so the service call is the whole of it.
  // There is no cap on what may be owed beyond the one the handler already
  // applies — a game caps because it can be stopped for a frame and come back
  // owing ticks, and this loop cannot be stopped by anything.
  asm.label("Idle");
  asm.bl("AudioService");
  asm.b("Idle");
  asm.ltorg();

  // --- the interrupt ---------------------------------------------------------
  //
  // One source, so this is an acknowledge and a call rather than the game's
  // dispatcher. `r0` arrives holding the I/O base, which is the documented
  // six-instruction sequence's own convention (`@demake/gba` §BIOS_WORDS), and
  // `r0`–`r3`, `r12` and `lr` are already saved by it.
  asm.label("AudioVector");
  asm.push([REG.lr]);
  asm.add(REG.a2, REG.a0, armImm(IE_OFFSET));
  asm.ldrh(REG.a1, armAt(REG.a2, 2)); // IF: what has been raised
  asm.ldrh(REG.a3, armAt(REG.a2, 0)); // IE: what we asked for
  // Acknowledged before the handler runs, so a refill landing inside it is
  // counted rather than lost — and masked by `IE`, so a source nobody asked for
  // stays raised instead of being silently cleared here.
  asm.and(REG.a1, REG.a1, armReg(REG.a3));
  asm.strh(REG.a1, armAt(REG.a2, 2));
  asm.movImm32(REG.addr, BIOS_IF);
  asm.ldrh(REG.a3, armAt(REG.addr, 0));
  asm.orr(REG.a3, REG.a3, armReg(REG.a1));
  asm.strh(REG.a3, armAt(REG.addr, 0));
  asm.bl("AudioIrq");
  asm.pop([REG.pc]);
  asm.ltorg();

  // --- the boot's own routine ------------------------------------------------
  emitInit(asm, data, boot, port);
  emitService(asm);

  // --- the tick --------------------------------------------------------------
  helpers.push(...emitStream(asm, { prefix: "", state: STATE.music, data, base: STATE.base }));

  emitWrite(asm);
  emitMixWrite(asm, STATE.voices, "AudioBank", keyOff);
  emitMix(asm, { acc: STATE.acc, voices: STATE.voices, writeBlock: STATE.writeBlock });
  // After the routine, because it measures what it is copying.
  emitMixCopy(asm, STATE.mixCode);
  emitIrq(asm, {
    base: STATE.base,
    refill: STATE.refill,
    readBlock: STATE.readBlock,
    pending: STATE.pending,
  });

  // --- the schedule ----------------------------------------------------------
  asm.align();
  const dataStart = asm.pc;
  emitBank(asm);
  emitStreamData(asm, "", 0, data);

  return { helpers, dataStart };
}

/** Put the state and the hardware where the driver assumes they are. */
function emitInit(
  asm: AsmArm,
  data: DriverData,
  boot: readonly { reg: number; value: number; chip?: number }[],
  port: (reg: number, chip: number) => number,
): void {
  asm.label("AudioInit");
  asm.push([4, 5, REG.lr]);

  asm.ldrConst(REG.addr, STATE.voices);
  for (const reg of [0, 1, 2, 3]) asm.mov(reg, armImm(0));
  asm.mov(5, armImm((GBA_PCM_VOICES * VOICE_STRIDE) / 16));
  asm.label("AudioInitVoices");
  asm.stm(REG.addr, [0, 1, 2, 3], "ia", true);
  asm.subs(5, 5, armImm(1));
  asm.b("AudioInitVoices", "ne");

  asm.ldrConst(4, STATE.base);
  asm.mov(0, armImm(0));
  asm.strb(0, armAt(4, off(STATE.music.rest)));

  for (const write of boot) {
    if ((write.chip ?? 0) === 0) {
      emitSoundWrite(asm, port(write.reg, 0) & 0x3f, write.value);
      continue;
    }
    asm.mov(0, armImm(port(write.reg, 1)));
    asm.mov(1, armImm(write.value));
    asm.bl("AudioWrite");
  }

  // The stream's own position, after the hardware and before anything can tick
  // it: the first order entry, the loop entry the packer chose, and the first
  // block fetched so tick 0 has data to walk.
  asm.ldrConst(0, label("Order0"));
  asm.str(0, armAt(4, off(STATE.music.order)));
  asm.ldrConst(0, label("Order0", data.loopOrderIndex * 4));
  asm.str(0, armAt(4, off(STATE.music.loop as number)));
  asm.bl("NextBlock");

  // The mixer into internal work RAM before anything can call it, which is
  // before the transfers start below.
  asm.bl("AudioMixInstall");
  emitSoundInit(asm, {
    base: STATE.base,
    refill: STATE.refill,
    readBlock: STATE.readBlock,
    writeBlock: STATE.writeBlock,
    pending: STATE.pending,
  });
  asm.pop([4, 5, REG.pc]);
  asm.ltorg();
}

/**
 * Perform the blocks the transfer has counted: a schedule tick and a mix each.
 *
 * The game driver's routine unchanged in everything but the request bytes it has
 * none of — see `gba-game.ts` §`emitService` for why the mixing is here rather
 * than in the handler.
 */
function emitService(asm: AsmArm): void {
  asm.label("AudioService");
  asm.push([REG.lr]);
  asm.label("AudioServiceLoop");
  asm.ldrConst(REG.addr, STATE.base);
  asm.ldrb(0, armAt(REG.addr, off(STATE.pending)));
  asm.cmp(0, armImm(0));
  asm.b("AudioServiceDone", "eq");
  asm.sub(0, 0, armImm(1));
  asm.strb(0, armAt(REG.addr, off(STATE.pending)));
  asm.bl("Tick");
  // Into the copy in internal work RAM rather than the one in the cartridge:
  // same instructions, a fifth of the fetch cost. `mov lr, pc` lands the return
  // on the instruction after the `bx`, which is why the two are adjacent.
  asm.ldrConst(REG.addr, STATE.mixCode);
  asm.mov(REG.lr, armReg(REG.pc));
  asm.bx(REG.addr);
  asm.ldrConst(REG.addr, STATE.base);
  asm.ldrb(0, armAt(REG.addr, off(STATE.writeBlock)));
  asm.add(0, 0, armImm(1));
  asm.cmp(0, armImm(GBA_RING_BLOCKS));
  asm.mov(0, armImm(0), "eq");
  asm.strb(0, armAt(REG.addr, off(STATE.writeBlock)));
  asm.b("AudioServiceLoop");
  asm.label("AudioServiceDone");
  asm.pop([REG.pc]);
  asm.ltorg();
}
