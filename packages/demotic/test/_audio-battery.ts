/**
 * The proof for a game's sound: the ROM performs the schedule the demakers made.
 *
 * This is doc 16 §The proof, Level A, moved one layer up — where
 * `packages/audio/test/rom.test.ts` proves it for a cartridge whose only job is
 * one track, this proves it for a cartridge that is also playing a game: the
 * driver runs on its own clock while the game runs on the frame, an effect
 * borrows a channel from the music and gives it back, and none of that is
 * allowed to change a single register write.
 *
 * **And it runs on every console with a driver**, which is what makes it a proof
 * of the *contract* rather than of one emitter. They share nothing below the
 * packed format: an SM83 player on a programmable timer at 120 Hz, a 6502 player
 * on the picture's own interrupt at 60, a Z80 player on the Sega VDP's frame
 * interrupt writing an I/O port rather than an address, a 68000 player storing a
 * byte to an address, an SPC700 player that is not on the console's processor
 * at all — a second computer, handed its program at boot and keeping its own
 * 125 Hz — and an ARM player at 128 Hz clocked by its own sample transfer, which
 * has to *compute* six of its ten voices before it can play them and is
 * therefore only half provable here (§{@link Target.observed}). `NR51` merged, `$4015` merged, `KON` *masked* because it is a pulse
 * rather than a state, and — on a Master System and a Mega Drive — no shared
 * register to merge at all. Four writes to silence a Game Boy channel, one bit to
 * silence an NES's, one attenuation latch to silence a PSG's, one `GAIN` of zero
 * to silence an S-DSP voice. And on the three machines that share a chip the
 * *channel* is not in the register number but in the data byte, latched across
 * writes, so "which voice does this write belong to" is a question with a running
 * answer — the same question, answered by the same code, from two instruction
 * sets.
 *
 * What all of them share is the only thing doc 16 promises — on tick N the driver
 * performs exactly the writes `ChipScript.ticks[N]` lists, in order — so the
 * battery below is written once and pointed at each machine in turn.
 *
 * Attribution is by program counter, as it is there: the tick routine's address
 * comes out of the build (`Target.tickAddress`) and the core's own tap observes
 * the chip. Nothing is added to the cartridge to make it testable, because the
 * cartridge under test has to be the cartridge that ships.
 *
 * It runs with no toolchain and no emulator install — the assemblers are ours
 * and so are the cores — which is what makes an exact audio proof something
 * `pnpm test` can do on every change.
 *
 * **Why this is a battery rather than a test file.** It is pointed at each
 * machine from a file of its own — `audio-gb.test.ts`, `audio-nes.test.ts` and
 * the rest — because a test file is the unit Vitest schedules: one file is one
 * worker, start to finish. Written as a single file it was thirteen minutes of a
 * fourteen-minute suite and every other core sat idle behind it, which made the
 * whole of CI as long as the slowest console's sweep (doc 11 §Affected-only
 * gates). Split per console the same work fits across the runner's four workers.
 * Split it per console and not per battery: `builds` below is memoized per
 * module, so a machine's register battery and its size sweep have to stay in one
 * file or each build happens twice.
 *
 * The same shared-battery shape as `packages/cli/test/_emu-battery.ts`, and for
 * the same reason — running one battery on every machine is what makes `Backend`
 * a contract rather than a resemblance.
 */

import { describe, expect, it } from "vitest";

import {
  buildGameAudio,
  mdChannelTag,
  buildGbaGameAudio,
  buildMdGameAudio,
  buildNdsGameAudio,
  buildNesGameAudio,
  buildNgpGameAudio,
  buildPceGameAudio,
  buildSmsGameAudio,
  buildSpcGameAudio,
  buildWscGameAudio,
  gbChannelOf,
  ndsChannelTag,
  nesChannelOf,
  pceChannelTag,
  wscChannelTag,
  psgChannelTag,
  psgShadowSlot,
  t6w28ChannelTag,
  t6w28ShadowSlot,
  PSG_STEREO_REG,
  sdspChannelTag,
  type ChannelTag,
  type ChipScript,
  type GameEffect,
} from "@demake/audio";
import {
  GB_CLOCK_HZ,
  NDS_SPU_CLOCK_HZ,
  HUC6280_PSG_CLOCK_HZ,
  NES_CLOCK_HZ,
  SDSP_CLOCK_HZ,
  SN76489_CLOCK_HZ,
  T6W28_CLOCK_HZ,
  WS_SOUND_CLOCK_HZ,
  StreamSink,
  type SampleSink,
} from "@demake/chip";
import { megaduckRegister } from "@demake/core";
import { Gameboy } from "@demake/dmg";
import { Gba, ROM_BASE } from "@demake/gba";
import { Md } from "@demake/md";
import { Nds } from "@demake/nds";
import { Nes } from "@demake/nes";
import { Ngp } from "@demake/ngp";
import { Pce } from "@demake/pce";
import { Sms } from "@demake/sms";
import { Snes } from "@demake/snes";
import { Wsc } from "@demake/wsc";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { bindAudio, type BoundAudio } from "../src/codegen/audio.js";
import type { BuiltRom } from "../src/codegen/backend.js";
import { buildGbaRom } from "../src/codegen/gba.js";
import { buildGbRom } from "../src/codegen/gb.js";
import { buildMdRom } from "../src/codegen/md.js";
import { buildNesRom } from "../src/codegen/nes.js";
import { buildNgpcRom } from "../src/codegen/ngpc.js";
import { buildPceRom } from "../src/codegen/pce.js";
import { buildSmsRom } from "../src/codegen/sms.js";
import { buildSnesRom } from "../src/codegen/snes.js";
import { buildWscRom } from "../src/codegen/wsc.js";
import { EXAMPLES, exampleProject, gameSource } from "./_projects.js";

/** The five things this battery needs of a console, and nothing else. */
export interface Machine {
  /** Run one instruction, and say where the program counter ended up. */
  step(): number;
  /** Everything the chips receive, observed rather than intercepted. */
  tap(listener: (reg: number, value: number, chip: number) => void): void;
  setButtons(down: readonly string[]): void;
  runFrame(): void;
  listen(sink: SampleSink | undefined): void;
  readonly listening: boolean;
  /**
   * Call `onEnter` every time the driver reaches `address`, where a core can.
   *
   * Absent on every console but one because it is not needed: one host step is
   * one instruction of the processor the driver runs on, so sampling the program
   * counter afterwards sees every arrival. On the Super Nintendo the driver runs
   * on a processor with its own clock, and one step of the game can advance it by
   * several instructions — long enough for a whole driver tick to begin and end
   * unseen. Watching its instruction stream is still observation: nothing is
   * added to the cartridge, which is what the proof rests on.
   */
  watch?(address: number, onEnter: () => void): void;
}

/** One console, as everything below addresses it. */
export interface Target {
  id: string;
  name: string;
  /** The chip's master clock, which the stream sink is rendered against. */
  clockHz: number;
  /** Compile and build the cartridge, and demake its audio again beside it. */
  build(source: string, project: string): { built: BuiltRom; bound: BoundAudio<Driver> };
  /**
   * Where a driver tick begins, as a program counter.
   *
   * Asked of the target rather than read out of the cartridge's symbol table,
   * because on one of these consoles the driver is not in the cartridge's
   * instruction set at all: the Super Nintendo's runs on the *sound* processor,
   * so its symbols are the sound processor's and mixing the two address spaces
   * into one map would be a symbol file nobody could read.
   */
  tickAddress(built: BuiltRom, bound: BoundAudio<Driver>): number;
  boot(rom: Uint8Array): Machine;
  /**
   * A **fresh** tag: which voice a write belongs to, `0` for none.
   *
   * A factory rather than a function because one of these chips latches the
   * channel in the data byte, so the answer depends on the writes before it. Ask
   * for one per stream you are about to walk, and walk it in order — a tag reused
   * across two captures would read the second from the first's last write.
   */
  tag(): ChannelTag;
  /**
   * The one register two streams merge into rather than store over.
   *
   * `null` where the chip has none: a Master System's PSG has four independent
   * attenuation latches and nothing shared, so there is no byte for one stream to
   * erase the other's half of, and no merge to emit.
   */
  mergeReg: number | null;
  /** The helper name the merge pulls in, which each driver calls its own thing. */
  mergeHelper: string;
  /**
   * The writes of a schedule this console's *tap* can see.
   *
   * Everywhere but one console that is all of them: a schedule addresses a chip,
   * and the core reports what the chip received. The Game Boy Advance's second
   * device is a **software mixer**, so six of its ten voices are written to a
   * register file in work RAM and cross no bus at all — what those writes have to
   * produce is *the samples*, which is a sharper claim than a register diff and a
   * different test (`audio-gba.test.ts`). Filtering them out here is not weakening
   * the proof; it is putting the two halves where each can be checked.
   */
  observed?(writes: readonly Write[]): Write[];
  /**
   * Driver ticks per Game Boy driver tick on this console.
   *
   * The Game Boy's driver runs at 120 Hz and the other two at their frame, so a
   * window written in ticks means half as much time there. Every count below is
   * written for the Game Boy and scaled, so each run covers the same seconds of
   * track.
   */
  ratio: number;
  /**
   * A **fresh** namer: which *register* a write addresses, `null` for none.
   *
   * Sibling of {@link Target.tag} and a factory for the same reason. Everywhere
   * but the SN76489 a register is named by its own number, so the default is the
   * number; that chip has one write port and puts the register select in the byte
   * — and only in some bytes — so naming one there means carrying its latch.
   *
   * It is what lets "the channel came back holding the music's own registers" be
   * one assertion rather than one per console: reduce both write streams to a
   * last-value-per-register map and compare.
   */
  register?(): (write: Write) => string | null;
  /**
   * Frames a second, where the console does not draw sixty of them.
   *
   * Every machine in this set did until the WonderSwan, which draws 75.47 — so
   * "run a hundred and twenty frames and expect two seconds of samples" was a
   * sixty-hertz assumption written as arithmetic. Absent means sixty.
   */
  frameHz?: number;
}

/** What every driver agrees to hand back, which is all this file uses. */
export interface Driver {
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  /** Present only where the driver runs on a processor of its own. */
  symbols?: ReadonlyMap<string, number>;
}

/** The usual answer: the tick routine is a label in the cartridge's own code. */
function cartridgeTick(built: BuiltRom): number {
  return built.symbols.get("AudioTick") as number;
}

/** Every file in a directory, as the bytes a build is handed. */
/**
 * The consoles, and the whole of what differs between them.
 *
 * Rebuilding the driver beside the cartridge rather than reading it out of the
 * build is deliberate: the schedules a test compares against have to come from
 * the demakers, not from anything the backend chose to remember, or the proof
 * would be the ROM agreeing with itself.
 */
const ALL: readonly Target[] = [
  {
    id: "gb",
    name: "Game Boy",
    clockHz: GB_CLOCK_HZ,
    mergeReg: 0x25,
    mergeHelper: "panning-merge",
    ratio: 1,
    tag: () => gbChannelOf,
    tickAddress: cartridgeTick,
    async build(source, project) {
      const { files, levels, assets } = exampleProject(project);
      const program = compile(source, {
        profile: getProfile("gb"),
        files,
        levels,
      });
      const built = await buildGbRom(program, { assets });
      const bound = await bindAudio(program, assets, {
        build: (tracks, effects) =>
          buildGameAudio({ tracks, effects: effects as GameEffect[], hram: 0xff8b }),
      });
      return { built, bound };
    },
    boot(rom) {
      const machine = new Gameboy(rom);
      return wrap(machine);
    },
  },
  {
    // The Mega Duck's APU *is* the Game Boy's, at a different address — so
    // everything this battery compares is stated in Game Boy register numbers
    // and only the cartridge's stores differ. `channelOf` and `mergeReg` are
    // therefore the Game Boy's unchanged, and the fact that this passes is the
    // proof that the map is applied where a register becomes an address and
    // nowhere else: a map that leaked into the schedules would fail here, and a
    // map that never reached the ROM would fail on the console.
    id: "megaduck",
    name: "Mega Duck",
    clockHz: GB_CLOCK_HZ,
    mergeReg: 0x25,
    mergeHelper: "panning-merge",
    ratio: 1,
    tag: () => gbChannelOf,
    tickAddress: cartridgeTick,
    async build(source, project) {
      const { files, levels, assets } = exampleProject(project);
      const program = compile(source, {
        profile: getProfile("megaduck"),
        files,
        levels,
      });
      const built = await buildGbRom(program, { assets });
      const bound = await bindAudio(program, assets, {
        build: (tracks, effects) =>
          buildGameAudio({
            tracks,
            effects: effects as GameEffect[],
            hram: 0xff8b,
            port: megaduckRegister,
          }),
      });
      return { built, bound };
    },
    boot(rom) {
      return wrap(new Gameboy(rom, "megaduck"));
    },
  },
  {
    id: "nes",
    name: "NES",
    clockHz: NES_CLOCK_HZ,
    mergeReg: 0x15,
    mergeHelper: "enable-merge",
    ratio: 0.5,
    tag: () => nesChannelOf,
    tickAddress: cartridgeTick,
    async build(source, project) {
      const { files, levels, assets } = exampleProject(project);
      const program = compile(source, {
        profile: getProfile("nes"),
        files,
        levels,
      });
      const built = await buildNesRom(program, { assets });
      // Page zero the allocator set aside, which is the address the cartridge
      // itself was built against — asking the layout is how the two stay one.
      const state = built.layout.audio as number;
      const bound = await bindAudio(program, assets, {
        build: (tracks, effects) =>
          buildNesGameAudio({ tracks, effects: effects as GameEffect[], state }),
      });
      return { built, bound };
    },
    boot(rom) {
      const machine = new Nes(rom);
      return wrap(machine);
    },
  },
  {
    id: "pce",
    name: "PC Engine",
    clockHz: HUC6280_PSG_CLOCK_HZ,
    // Nothing shared to merge: the global level is written once at boot and
    // everything a stream touches afterwards belongs to one channel. A Master
    // System and a Mega Drive are the other two, and all three say it by having
    // *less* shared hardware rather than more.
    mergeReg: null,
    mergeHelper: "enable-merge",
    // The CPU has a timer nothing else in a demade cartridge uses, so this
    // driver gets the Game Boy's 120 Hz on an eight-bit machine the NES had to
    // do without.
    ratio: 1,
    // The channel is a *register* here rather than an address or a data bit, so
    // the tag carries the select latch — the SN76489's problem, reached by
    // different hardware.
    tag: pceChannelTag,
    tickAddress: cartridgeTick,
    async build(source, project) {
      const { files, levels, assets } = exampleProject(project);
      const program = compile(source, {
        profile: getProfile("pce"),
        files,
        levels,
      });
      const built = await buildPceRom(program, { assets });
      // The cheap page the allocator set aside, reduced to the operand the
      // driver writes — this CPU's zero page is at `$2000`, so the two are not
      // the same number (`codegen/mos/zp.ts`).
      const state = (built.layout.audio as number) & 0xff;
      const bound = await bindAudio(program, assets, {
        build: (tracks, effects) =>
          buildPceGameAudio({ tracks, effects: effects as GameEffect[], state }),
      });
      return { built, bound };
    },
    boot(rom) {
      const machine = new Pce(rom);
      const wrapped = wrap(machine);
      // The reset vector rather than zero: a program on this console never runs
      // from the hardware page, and reading an opcode out of it would acknowledge
      // an interrupt rather than answer a question.
      let previous = machine.cpu.pc;
      return {
        ...wrapped,
        /**
         * The program counter, unless this step was an interrupt *return*.
         *
         * A return lands on the instruction it interrupted, so the driver's entry
         * address is seen a second time without having been reached a second
         * time — the Game Boy Advance's hazard (below), on a machine that
         * interrupts a hundred and twenty times a second right where the service
         * loop calls the tick. It presents as the ROM performing a phantom empty
         * tick and everything after it being one tick late.
         *
         * A real arrival is a `jsr`; a return is an `rti`, and the opcode at the
         * address the step came *from* is the whole test. Reading it is
         * observation like everything else here — nothing is added to the
         * cartridge, and `$40` is the byte the hardware itself decodes.
         */
        step: () => {
          const from = previous;
          const pc = wrapped.step();
          previous = pc;
          return machine.read(machine.cpu.physical(from)) === 0x40 ? -1 : pc;
        },
      };
    },
  },
  {
    id: "wsc",
    name: "WonderSwan Color",
    clockHz: WS_SOUND_CLOCK_HZ,
    // `$90` is this chip's `NR51`: four channel enables and three mode bits in
    // one byte, so two streams both write it and the driver folds rather than
    // stores. The fold has to reach bit 7 as well, because that is what puts
    // channel four on its shift register.
    mergeReg: 0x90,
    mergeHelper: "shared-register-merge",
    // No timer this driver can have — the cartridge takes no interrupts at all —
    // so a tick is a frame, and a frame here is 75.47 Hz rather than sixty. The
    // window counts are the Game Boy's 120 Hz ticks, so this is the ratio that
    // makes each run cover the same seconds of track.
    ratio: 3072000 / 40704 / 120,
    // Every register is addressed by its own number, so unlike three of the
    // chips here the tag carries no latch — it is a factory only because the
    // contract is.
    tag: wscChannelTag,
    // The one console here that does not draw sixty frames a second.
    frameHz: 3072000 / 40704,
    tickAddress: cartridgeTick,
    async build(source, project) {
      const { files, levels, assets } = exampleProject(project);
      const program = compile(source, { profile: getProfile("wsc"), files, levels });
      const built = await buildWscRom(program, { assets });
      const state = built.layout.audio as number;
      const bound = await bindAudio(program, assets, {
        build: (tracks, effects) =>
          buildWscGameAudio({ tracks, effects: effects as GameEffect[], state }),
      });
      return { built, bound };
    },
    boot(rom) {
      return wrap(new Wsc(rom));
    },
  },
  {
    // The mono machine, whose sound path is the colour machine's *entire* sound
    // path: one chip, one binding, one driver, one waveform page at one address.
    // So what a pass here settles is that the page is really at that address on
    // a console with sixteen kilobytes rather than sixty-four — `WS_WAVE_BASE`
    // is inside the interrupt vectors precisely so it can be, and a copy that
    // landed where the colour machine's gap is would be writing into the tile
    // bank on this one.
    id: "ws",
    name: "WonderSwan",
    clockHz: WS_SOUND_CLOCK_HZ,
    mergeReg: 0x90,
    mergeHelper: "shared-register-merge",
    ratio: 3072000 / 40704 / 120,
    tag: wscChannelTag,
    frameHz: 3072000 / 40704,
    tickAddress: cartridgeTick,
    async build(source, project) {
      const { files, levels, assets } = exampleProject(project);
      const program = compile(source, { profile: getProfile("ws"), files, levels });
      const built = await buildWscRom(program, { assets });
      const state = built.layout.audio as number;
      const bound = await bindAudio(program, assets, {
        build: (tracks, effects) =>
          buildWscGameAudio({ tracks, effects: effects as GameEffect[], state }),
      });
      return { built, bound };
    },
    boot(rom) {
      return wrap(new Wsc(rom, "ws"));
    },
  },
  {
    id: "sms",
    name: "Master System",
    clockHz: SN76489_CLOCK_HZ,
    // Nothing shared to merge: four attenuation latches, four channels, and no
    // byte that carries more than one of them. The Game Gear is the same chip
    // with a stereo latch bolted beside it, which is where the merge comes back —
    // its own case is below, rather than a fourth pass over the whole battery.
    register: psgRegister,
    mergeReg: null,
    mergeHelper: "stereo-merge",
    ratio: 0.5,
    tag: psgChannelTag,
    tickAddress: cartridgeTick,
    async build(source, project) {
      const { files, levels, assets } = exampleProject(project);
      const program = compile(source, {
        profile: getProfile("sms"),
        files,
        levels,
      });
      const built = await buildSmsRom(program, { assets });
      // Work RAM the allocator set aside, which is the address the cartridge
      // itself was built against — asking the layout is how the two stay one.
      const state = built.layout.audio as number;
      const bound = await bindAudio(program, assets, {
        build: (tracks, effects) =>
          buildSmsGameAudio({ tracks, effects: effects as GameEffect[], state }),
      });
      return { built, bound };
    },
    boot(rom) {
      const machine = new Sms(rom);
      return wrap(machine);
    },
  },
  {
    id: "ngpc",
    name: "Neo Geo Pocket Color",
    clockHz: T6W28_CLOCK_HZ,
    // The fourth console in the set with nothing to merge, and the first to have
    // none because its hardware pans *more*: a level a side per channel rather
    // than one shared byte of enables, so there is no register two streams could
    // erase each other's half of.
    register: t6w28Register,
    mergeReg: null,
    mergeHelper: "stereo-merge",
    ratio: 0.5,
    tag: t6w28ChannelTag,
    tickAddress: cartridgeTick,
    async build(source, project) {
      const { files, levels, assets } = exampleProject(project);
      const program = compile(source, {
        profile: getProfile("ngpc"),
        files,
        levels,
      });
      const built = await buildNgpcRom(program, { assets });
      const state = built.layout.audio as number;
      const bound = await bindAudio(program, assets, {
        build: (tracks, effects) =>
          buildNgpGameAudio({ tracks, effects: effects as GameEffect[], state }),
      });
      return { built, bound };
    },
    boot(rom) {
      return wrap(new Ngp(rom));
    },
  },
  {
    id: "snes",
    name: "Super Nintendo",
    clockHz: SDSP_CLOCK_HZ,
    // `KON` is the one byte two streams both want, and it is a *pulse*: writing
    // it starts the voices whose bits are set and does nothing to the rest, so
    // the driver masks the value down to what the stream still owns instead of
    // folding two shadows the way `NR51` and `$4015` force.
    mergeReg: 0x4c,
    mergeHelper: "music-merge",
    // The sound processor has a timer of its own, so this driver runs at 125 Hz
    // where the Game Boy's runs at 120 — near enough that the same tick windows
    // cover the same seconds.
    ratio: 125 / 120,
    tag: sdspChannelTag,
    // The driver is a second program on a second processor, so the label is in
    // *its* symbol table and not in the cartridge's.
    tickAddress: (_built, bound) => (bound.driver as Driver).symbols?.get("AudioTick") as number,
    async build(source, project) {
      const { files, levels, assets } = exampleProject(project);
      const program = compile(source, {
        profile: getProfile("snes"),
        files,
        levels,
      });
      const built = await buildSnesRom(program, { assets });
      const bound = await bindAudio(program, assets, {
        build: (tracks, effects) => buildSpcGameAudio({ tracks, effects: effects as GameEffect[] }),
      });
      return { built, bound };
    },
    boot(rom) {
      const machine = new Snes(rom);
      const wrapped = wrap(machine);
      return {
        ...wrapped,
        watch: (address, onEnter) => {
          machine.smp.pcTap = (pc) => {
            if (pc === address) onEnter();
          };
        },
      };
    },
  },
  {
    id: "nds",
    name: "Nintendo DS",
    clockHz: NDS_SPU_CLOCK_HZ,
    // Nothing shared at all, which no other console in this list can say while
    // *having* sixteen channels: panning is a byte per channel, enabling is the
    // channel's own start bit, and there is no key-on pulse. So there is no merge
    // routine in this driver and no register for one stream to erase the other's
    // half of.
    mergeReg: null,
    mergeHelper: "panning-merge",
    // The ARM7 has four timers and nothing else to spend them on, so this driver
    // gets the same 120 Hz the Game Boy's does — from a chained pair it *reads*
    // rather than an interrupt it catches.
    ratio: 1,
    // Every channel numbered, unlike the driver's own tag: the packed run format
    // numbers only the stealable ones because its field is four bits, and nothing
    // here is packed — this only has to give one channel one number.
    tag: () => ndsChannelTag(),
    // The driver is a second program on a second processor, so the label is in
    // *its* symbol table and not in the cartridge's — the Super Nintendo's
    // arrangement, on a machine where the second program is simply the other half
    // of the cartridge rather than something uploaded.
    tickAddress: (_built, bound) => (bound.driver as Driver).symbols?.get("AudioTick") as number,
    async build(source, project) {
      const { files, levels, assets } = exampleProject(project);
      const program = compile(source, {
        profile: getProfile("nds"),
        files,
        levels,
      });
      const built = await buildGbaRom(program, { assets });
      // Main RAM the allocator set aside for the two request bytes, which is the
      // address the cartridge itself was built against.
      const state = built.layout.audio as number;
      const bound = await bindAudio(program, assets, {
        build: (tracks, effects) =>
          buildNdsGameAudio({ tracks, effects: effects as GameEffect[], state }),
      });
      return { built, bound };
    },
    boot(rom) {
      const machine = new Nds(rom);
      const wrapped = wrap(machine);
      return {
        ...wrapped,
        // The sound processor runs on its own clock, so one step of the game can
        // advance it by several instructions — the Super Nintendo's reason for
        // watching an instruction stream rather than sampling a program counter.
        watch: (address, onEnter) => {
          machine.arm7.pcTap = (pc) => {
            if (pc === address) onEnter();
          };
        },
      };
    },
  },
  {
    id: "md",
    name: "Mega Drive",
    clockHz: SN76489_CLOCK_HZ,
    // The Master System's chip, and the Master System's answer: four independent
    // attenuation latches and no byte carrying more than one of them. The Game
    // Gear's stereo latch is the one place this chip grows a shared register, and
    // it is not on this console — the panning here lives in the FM half, which
    // `demake build` does not emit.
    register: mdRegister,
    mergeReg: null,
    mergeHelper: "stereo-merge",
    ratio: 0.5,
    // All ten voices, unlike the driver's own tag: the packed run format numbers
    // only the stealable ones because its field is four bits, and nothing here
    // is packed — this only has to give one voice one number.
    tag: () => mdChannelTag([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])(),
    async build(source, project) {
      const { files, levels, assets } = exampleProject(project);
      const program = compile(source, {
        profile: getProfile("md"),
        files,
        levels,
      });
      const built = await buildMdRom(program, { assets });
      // Work RAM the allocator set aside, which is the address the cartridge
      // itself was built against — asking the layout is how the two stay one.
      const state = built.layout.audio as number;
      const bound = await bindAudio(program, assets, {
        build: (tracks, effects) =>
          buildMdGameAudio({ tracks, effects: effects as GameEffect[], state }),
      });
      return { built, bound };
    },
    tickAddress: cartridgeTick,
    boot(rom) {
      const machine = new Md(rom);
      return wrap(machine);
    },
  },
  {
    id: "gba",
    name: "Game Boy Advance",
    // The Game Boy channels' own clock, which is a quarter of this machine's —
    // the same `GbApu` at the same rate, behind a permuted register map.
    clockHz: GB_CLOCK_HZ,
    // `NR51` again, and it is the *only* shared byte on this board: the mixer's
    // levels are a voice's own two bytes and its `KON` is a pulse, so there is one
    // merge here rather than two.
    mergeReg: 0x25,
    mergeHelper: "panning-merge",
    // 128 Hz against the Game Boy's 120, because a tick here is a block of mixer
    // samples and 32768 divides by 256 exactly (`gba-game.ts` §the clock).
    ratio: 128 / 120,
    // The four Game Boy channels number themselves and the mixer's six answer
    // zero — which is what the driver's own packing says, and it is right rather
    // than a truncation: an effect never borrows a mixer voice, so no music write
    // to one is ever preempted.
    tag: () => (reg, _value, chip) => (chip === 0 || chip === undefined ? gbChannelOf(reg) : 0),
    // Half of a schedule addresses a register file in work RAM rather than a bus,
    // so half of it is invisible to any tap. `audio-gba.test.ts` proves that half
    // against the samples themselves, which is the sharper claim.
    observed: (writes) => writes.filter((write) => (write.chip ?? 0) === 0),
    tickAddress: cartridgeTick,
    async build(source, project) {
      const { files, levels, assets } = exampleProject(project);
      const program = compile(source, {
        profile: getProfile("gba"),
        files,
        levels,
      });
      const built = await buildGbaRom(program, { assets });
      // Work RAM the allocator set aside, which is the address the cartridge
      // itself was built against — asking the layout is how the two stay one.
      const state = built.layout.audio as number;
      const bound = await bindAudio(program, assets, {
        build: (tracks, effects) =>
          buildGbaGameAudio({ tracks, effects: effects as GameEffect[], state }),
      });
      return { built, bound };
    },
    boot(rom) {
      const machine = new Gba(rom);
      const wrapped = wrap(machine);
      let previous = ROM_BASE;
      return {
        ...wrapped,
        /**
         * The program counter, unless this step was an interrupt *return*.
         *
         * A return lands on the instruction it interrupted, so the driver's entry
         * address is seen a second time without having been reached a second
         * time. On every other console that is a curiosity — an NMI lands on the
         * tick routine's first instruction perhaps once in a long run. Here the
         * sample transfer interrupts sixteen times a driver tick, so over a few
         * hundred ticks it is a certainty, and it presents as the ROM performing
         * a phantom empty tick and everything after it being one tick late.
         *
         * A real arrival is always from the cartridge; a return is from the BIOS,
         * which is the whole test.
         */
        step: () => {
          const pc = wrapped.step();
          const from = previous;
          previous = pc;
          return from >= ROM_BASE ? pc : -1;
        },
      };
    },
  },
];

/** Every core answers the same five questions; this is the adapter, once. */
function wrap(machine: Gameboy | Nes | Sms | Snes | Md | Gba | Nds | Pce | Wsc | Ngp): Machine {
  return {
    step: () => {
      machine.stepInstruction();
      // On the Super Nintendo the program counter that matters is the *sound*
      // processor's: the driver runs there, so that is where a tick begins.
      // On the two consoles whose driver is a second program, the program
      // counter that matters is the *other* processor's — that is where a tick
      // begins, and the game's own is running something else entirely.
      if (machine instanceof Snes) return machine.smp.pc;
      if (machine instanceof Nds) return machine.arm7.cpu.pc;
      // And on the one whose processor is an 8086, the register is called `ip`
      // and it is an *offset* — the driver is in the same segment as everything
      // else a cartridge runs, so the offset is the whole address.
      if (machine instanceof Wsc) return machine.cpu.ip;
      return machine.cpu.pc;
    },
    tap: (listener) => {
      // Each core names it after its own chip; the shape is the same, and so is
      // the promise — it observes, it does not intercept.
      if (machine instanceof Md) {
        // Two chips, and the tag has to know which: an FM bus port and a PSG
        // write are both "register 0" and mean nothing alike.
        machine.ymTap = (reg, value) => listener(reg, value, 0);
        machine.psgTap = (reg, value) => listener(reg, value, 1);
        return;
      }
      if (machine instanceof Wsc || machine instanceof Ngp) machine.soundTap = listener;
      else if (machine instanceof Sms || machine instanceof Pce) machine.psgTap = listener;
      else if (machine instanceof Snes) machine.dspTap = listener;
      else if (machine instanceof Nds) machine.spuTap = listener;
      else machine.apuTap = listener;
    },
    setButtons: (down) =>
      machine instanceof Snes
        ? // This pad's B and Y sit where the NES's A and B sat, which is the
          // mapping the cartridge assumes and the one the page uses.
          machine.setButtons(
            down.map((name) => (name === "a" ? "b" : name === "b" ? "y" : name)) as never,
          )
        : machine instanceof Pce
          ? // This pad's face buttons are I and II and its start is Run, which
            // is what the cartridge reads and what the page maps onto.
            machine.setButtons(
              down.map((name) =>
                name === "a" ? "i" : name === "b" ? "ii" : name === "start" ? "run" : name,
              ) as never,
            )
          : machine.setButtons(down as never),
    runFrame: () => void machine.runFrame(),
    listen: (sink) => {
      machine.audioSink = sink;
    },
    get listening() {
      return machine.audioSink !== undefined;
    },
  };
}

/**
 * Compile, demake and build — memoized, because demaking a track and two effects
 * is a second of work and several tests want the same cartridge.
 */
const builds = new Map<string, ReturnType<Target["build"]>>();

export function build(target: Target, source: string, project = "pong") {
  const key = `${target.id}\u0000${project}\u0000${source}`;
  const seen = builds.get(key);
  if (seen) return seen;
  const made = target.build(source, project);
  builds.set(key, made);
  return made;
}

/** One register write a chip received. */
export interface Write {
  reg: number;
  value: number;
  /** Which chip, for the one console with two. */
  chip?: number;
}

/**
 * Run a ROM and group the writes the chip receives by driver tick.
 *
 * A group opens when the driver *enters* its tick routine, which is why the run
 * continues past the last tick wanted: the final group would otherwise be
 * reported half-finished.
 */
export function capture(
  target: Target,
  rom: Uint8Array,
  tickAddress: number,
  ticks: number,
  press?: number,
): Write[][] {
  const machine = target.boot(rom);
  const groups: Write[][] = [];
  let current: Write[] | undefined;
  const open = (): void => {
    current = [];
    groups.push(current);
  };
  machine.tap((reg, value, chip) =>
    current?.push(chip === undefined || chip === 0 ? { reg, value } : { reg, value, chip }),
  );
  // Where the core can say when the driver entered its tick, it says so — and
  // where it cannot, one host step is one instruction and the program counter
  // afterwards is the same answer.
  const watched = machine.watch !== undefined;
  machine.watch?.(tickAddress, open);
  let guard = 0;
  while (groups.length <= ticks) {
    const pc = machine.step();
    if (!watched && pc === tickAddress) open();
    if (press !== undefined && groups.length === press) machine.setButtons(["a"]);
    guard += 1;
    if (guard > 100_000_000) throw new Error("the driver stopped ticking");
  }
  return groups.slice(0, ticks);
}

/** A register named by its own number, which is every chip but one. */
function defaultRegister(): (write: Write) => string {
  return (write) => `${write.chip ?? 0}:${write.reg}`;
}

/**
 * The SN76489's, which has no register numbers at all.
 *
 * One write port, and the byte says what it is: `psgShadowSlot` reads the same
 * two bits the driver's own recording path reads. The stereo latch is a
 * different device and belongs to no voice. On a Mega Drive this chip is the
 * second one, so the chip index rides along and the FM half keeps its numbers.
 */
/**
 * The Mega Drive's, which is both of the above and neither.
 *
 * The PSG is the second chip and keeps its own answer. The FM chip has four bus
 * *ports* rather than register numbers: an even port latches an address and an
 * odd one writes the register that address named, so a register is only named by
 * following the latch — and an address write is a selector rather than state, so
 * it names nothing.
 */
function mdRegister(): (write: Write) => string | null {
  const latched: [number, number] = [-1, -1];
  const psg = psgRegister();
  return (write) => {
    if ((write.chip ?? 0) !== 0) return psg(write);
    const half = (write.reg >> 1) & 1;
    if ((write.reg & 1) === 0) {
      latched[half] = write.value & 0xff;
      return null;
    }
    return `0:fm:${latched[half]}`;
  };
}

/**
 * A register on the T6W28, which is a *port* and a byte together.
 *
 * The SN76489's problem with a second port in it: this chip has no register
 * numbers either, and here the same byte means two different things depending on
 * which of the two addresses it went to. So the name carries both — which is
 * exactly what makes "the channel came back holding the music's own registers"
 * checkable at all, because a left-hand attenuation and a right-hand one are
 * indistinguishable by value.
 */
function t6w28Register(): (write: Write) => string | null {
  return (write) => `${write.chip ?? 0}:t6w28:${t6w28ShadowSlot(write.reg, write.value)}`;
}

function psgRegister(): (write: Write) => string | null {
  return (write) => {
    if (write.reg === PSG_STEREO_REG) return null;
    return `${write.chip ?? 0}:psg:${psgShadowSlot(write.value)}`;
  };
}

export function show(writes: readonly Write[]): string {
  return writes
    .map((w) => `${w.chip ? `c${w.chip}:` : ""}$${hex(w.reg)}=$${hex(w.value)}`)
    .join(" ");
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

/** Where two write streams first differ, named by tick — never a deep-equal dump. */
export function firstDivergence(
  expected: readonly Write[][],
  actual: readonly Write[][],
): string | null {
  for (let tick = 0; tick < expected.length; tick += 1) {
    const want = show(expected[tick] as Write[]);
    const got = show((actual[tick] ?? []) as Write[]);
    if (want !== got) return `tick ${tick}: expected [${want}], the ROM wrote [${got}]`;
  }
  return null;
}

export const MUSIC_ONLY = `
start play
scene play
create number score in play (value 0, x 1, y 1)
music rally.mid in play
`;

export const WITH_EFFECT = `${MUSIC_ONLY}
sound bounce.wav on a pressed
`;

export const EFFECT_ONLY = `
start play
scene play
create number score in play (value 0, x 1, y 1)
sound bounce.wav on a pressed
`;

/**
 * The channel an effect took, read out of the schedule it will really perform.
 *
 * The first write that names a channel, not the first write: an effect's opening
 * tick states the chip's shared state first on some machines — the NES's `$4015`
 * is the whole enable mask and belongs to no single voice — and taking that one
 * would name "no channel" and make every assertion below vacuous.
 */
export function channelOfEffect(target: Target, effect: ChipScript): number {
  const tag = target.tag();
  let found = 0;
  // Every write is offered to the tag, not just the ones before the answer: on a
  // latching chip an early write is what *gives* a later one its channel.
  for (const tick of effect.ticks) {
    for (const write of tick.writes) {
      const channel = tag(write.reg, write.value, write.chip ?? 0);
      if (found === 0) found = channel;
    }
  }
  if (found === 0) throw new Error("this effect writes no channel at all");
  return found;
}

/** A schedule's writes, as far as this console's tap reaches. */
function observed(target: Target, writes: readonly Write[]): Write[] {
  return target.observed ? target.observed(writes) : [...writes];
}

/** Look a console up by id, so a per-console file names one and gets one. */
export function target(id: string): Target {
  const found = ALL.find((one) => one.id === id);
  if (!found) throw new Error(`no audio target for '${id}'`);
  return found;
}

/**
 * What a case that *builds* is allowed to take, stated rather than inherited.
 *
 * The default twenty seconds was written for a battery whose bindings are all
 * table lookups, and one console's is not: the Mega Drive's timbre is
 * **searched** rather than selected (`binding/fm-patch.ts`, doc 17 §Stage 3),
 * hardware-in-the-loop, because an FM voice is thirty-odd register bits and far
 * too large a space to pick from a list. Measured on the shooter's theme,
 * `arrangeScore` takes **8685 ms** there against **9 ms** on a Master System —
 * so this console's first case spent nineteen of its twenty seconds inside a
 * search that is the design working, and was a coin toss on a loaded runner.
 *
 * Raised for every console rather than one, because a number that only one
 * target needs is a number the next FM console would have to discover again.
 * A case that is fast pays nothing for a generous ceiling.
 */
const BUILDS_TIMEOUT = 120_000;

/**
 * The register-level battery: what every driver must do, on one machine.
 *
 * Called once per console, from that console's own file.
 */
export function audioBattery(target: Target): void {
  describe(`a game's music, on ${target.name} hardware`, async () => {
    it(
      "performs the schedule tick for tick, with nothing preempting it",
      async () => {
        const { built, bound } = await build(target, MUSIC_ONLY);
        const script = bound.driver?.performed.tracks[0];
        expect(script).toBeDefined();
        const address = target.tickAddress(built, bound);
        expect(address).toBeDefined();

        const ticks = 600;
        const expected = (script as ChipScript).ticks
          .slice(0, ticks)
          .map((tick) => observed(target, tick.writes as Write[]));
        const actual = capture(target, built.bytes, address as number, ticks);
        expect(firstDivergence(expected, actual)).toBeNull();
      },
      BUILDS_TIMEOUT,
    );

    it(
      "performs it identically in a ROM that also has effects in it",
      async () => {
        // The run-packed stream and the flat one are two encodings of one schedule,
        // and the whole point of the run format is that it changes nothing the chip
        // can see.
        const { built, bound } = await build(target, WITH_EFFECT);
        const script = bound.driver?.performed.tracks[0] as ChipScript;
        const address = target.tickAddress(built, bound);
        const ticks = 600;
        const expected = script.ticks
          .slice(0, ticks)
          .map((tick) => observed(target, tick.writes as Write[]));
        expect(firstDivergence(expected, capture(target, built.bytes, address, ticks))).toBeNull();
      },
      BUILDS_TIMEOUT,
    );

    it(
      "starts at the top of the schedule, with no silencing in front of it",
      async () => {
        const { built, bound } = await build(target, MUSIC_ONLY);
        const address = target.tickAddress(built, bound);
        const first = capture(target, built.bytes, address, 1)[0] as Write[];
        const want = bound.driver?.performed.tracks[0] as ChipScript;
        expect(show(first)).toBe(
          show(observed(target, (want.ticks[0] as { writes: Write[] }).writes)),
        );
      },
      BUILDS_TIMEOUT,
    );
  });

  describe(`an effect borrowing a ${target.name} channel`, async () => {
    it(
      "plays its own schedule and hands the channel back",
      async () => {
        const { built, bound } = await build(target, WITH_EFFECT);
        const driver = bound.driver as Driver;
        const effect = driver.performed.effects[0] as ChipScript;
        const address = target.tickAddress(built, bound);
        // The press lands at the same *moment* on every machine rather than at the
        // same tick index: a frame-clocked driver ticks half as often as a Game
        // Boy's, so a fixed tick number would be a different second of the track.
        const press = Math.round(120 * target.ratio);
        const groups = capture(target, built.bytes, address, Math.round(400 * target.ratio), press);

        // The effect's channel, taken from the schedule rather than assumed — the
        // first write that names one, because a schedule may open with a register
        // that belongs to no channel (the NES's enable mask does).
        const owned = channelOfEffect(target, effect);
        // A fresh tag per group, walked in order over the *whole* group: on a
        // latching chip the filter cannot be a predicate on one write.
        const mine = (writes: readonly Write[]) => {
          const tag = target.tag();
          return writes.filter((write) => tag(write.reg, write.value, write.chip ?? 0) === owned);
        };

        // Find where the effect started: the first tick carrying its opening writes.
        const opening = show(mine([...(effect.ticks[0] as { writes: Write[] }).writes]));
        // At or after the press, not strictly after: the NES driver is serviced in
        // the same main-loop pass that ran the rule, so the effect's first tick can
        // land in the very group the button went down in.
        const start = groups.findIndex(
          (writes, tick) => tick >= press && show(mine(writes)) === opening,
        );
        expect(start, "the effect never reached the chip").toBeGreaterThan(0);

        // From there, the effect's own channel is exactly what the schedule says —
        // and nothing else writes to it, which is the preemption working.
        for (let tick = 0; tick < effect.ticks.length; tick += 1) {
          const want = show(mine([...(effect.ticks[tick] as { writes: Write[] }).writes]));
          const got = show(mine((groups[start + tick] ?? []) as Write[]));
          expect(got, `effect tick ${tick}`).toBe(want);
        }

        // The music was never stopped: it kept writing its own channels across the
        // effect. (An effect is a few ticks long, so the window has to be wider than
        // the effect itself — the music writes when a note changes, not every tick.)
        const window = groups.slice(start, start + effect.ticks.length + 60).flat();
        const others = target.tag();
        const elsewhere = window
          .map((write) => others(write.reg, write.value, write.chip ?? 0))
          .filter((channel) => channel !== owned && channel !== 0);
        expect(elsewhere.length, "the music stopped while the effect played").toBeGreaterThan(0);

        // And it got its channel back: something writes the borrowed channel again
        // once the effect has released it.
        const after = mine(groups.slice(start + effect.ticks.length + 1).flat());
        expect(after.length, "the borrowed channel never came back").toBeGreaterThan(0);
      },
      BUILDS_TIMEOUT,
    );

    it(
      "hands it back holding the music's own registers, not the effect's",
      async () => {
        // The sharp half of the previous test. The packed music is a *delta*
        // stream, so a register the music's own value did not change is a register
        // the music never states again — and after an effect has borrowed the
        // channel the chip is holding the effect's value for it. Left alone, the
        // music's next volume step re-triggers the voice through a register whose
        // neighbour still carries the effect's pitch, and a Game Boy pulse comes
        // back a whole tone sharp and rings until the bar ends. So the release has
        // to replay what the music would have been holding, and this is where that
        // is checked: not that *something* wrote the channel, but that what the
        // chip ends up holding is what the schedule says.
        const { built, bound } = await build(target, WITH_EFFECT);
        const driver = bound.driver as Driver;
        const effect = driver.performed.effects[0] as ChipScript;
        const track = driver.performed.tracks[0] as ChipScript;
        const owned = channelOfEffect(target, effect);
        const address = target.tickAddress(built, bound);
        const press = Math.round(120 * target.ratio);
        const ticks = Math.round(600 * target.ratio);
        const groups = capture(target, built.bytes, address, ticks, press);

        // Two walks of the same length: what the chip was left holding for the
        // borrowed channel, and what the music's schedule says it should. Both tags
        // and both namers run across the whole stream in order, because a latch is
        // state that carries through one.
        const chipTag = target.tag();
        const chipReg = (target.register ?? defaultRegister)();
        const musicTag = target.tag();
        const musicReg = (target.register ?? defaultRegister)();
        const held = new Map<string, number>();
        const wanted = new Map<string, number>();
        const record = (
          into: Map<string, number>,
          tag: ChannelTag,
          name: (write: Write) => string | null,
          writes: readonly Write[],
        ): void => {
          for (const write of writes) {
            const channels = tag(write.reg, write.value, write.chip ?? 0);
            const key = name(write);
            if (key === null || (channels & owned) === 0) continue;
            // A merged register is not state a voice holds: it is folded from two
            // shadows, and on the Super Nintendo it is a *pulse* that starts one.
            // The test above it is what checks a merge; this one is about the
            // registers the release has to replay.
            if (write.reg === target.mergeReg) continue;
            into.set(key, write.value);
          }
        };

        const disagreements: string[] = [];
        for (let tick = 0; tick < ticks && tick < track.ticks.length; tick += 1) {
          record(held, chipTag, chipReg, (groups[tick] ?? []) as Write[]);
          record(wanted, musicTag, musicReg, (track.ticks[tick] as { writes: Write[] }).writes);
          // While the effect is sounding the chip is *meant* to hold its values, so
          // the window opens once it has let go. It is a few ticks long and the
          // press lands at `press`; a generous margin keeps this from depending on
          // exactly which tick the button was seen.
          if (tick < press + effect.ticks.length + 4) continue;
          for (const [key, value] of wanted) {
            if (held.get(key) !== value && disagreements.length < 6) {
              disagreements.push(
                `tick ${tick}: ${key} holds ${held.get(key) ?? "nothing"}, the music wants ${value}`,
              );
            }
          }
          if (disagreements.length > 0) break;
        }
        expect(disagreements.join("; ")).toBe("");
      },
      BUILDS_TIMEOUT,
    );

    it.skipIf(target.mergeReg === null)(
      "leaves the music's own bits alone in the register they share",
      async () => {
        // `NR51` on one machine and `$4015` on the other, and the same rule: one
        // byte carries every channel, so it is merged and never stored. Every value
        // the chip sees after the effect starts must keep at least one channel that
        // is not the effect's, or the music has been muted by a stream that had no
        // business writing it.
        const { built, bound } = await build(target, WITH_EFFECT);
        const driver = bound.driver as Driver;
        const effect = driver.performed.effects[0] as ChipScript;
        const owned = channelOfEffect(target, effect);
        const address = target.tickAddress(built, bound);
        const press = Math.round(120 * target.ratio);
        const groups = capture(target, built.bytes, address, Math.round(400 * target.ratio), press);

        const shared = groups
          .slice(press + 10)
          .flat()
          .filter((write) => write.reg === target.mergeReg);
        expect(shared.length).toBeGreaterThan(0);
        // The Game Boy's byte carries each channel twice, left and right; the NES's
        // carries it once. Masking with both is what makes one assertion serve two.
        const musical = (owned | (owned << 4)) ^ 0xff;
        expect(shared.some((write) => (write.value & musical) !== 0)).toBe(true);
      },
    );
  });

  describe(`listening to a running ${target.name} cartridge`, async () => {
    it(
      "emits audible samples at the delivery rate the page asks for",
      async () => {
        // The last link in doc 07's chain: the page plays what the chip emitted, so
        // what the chip emits from a *running game* has to be real audio. The
        // stream is `@demake/chip`'s, bit-identical to the offline renderer
        // (`packages/chip/test/stream.test.ts`), which is what makes the page a
        // playback device rather than a second implementation of the hardware.
        const { built } = await build(target, MUSIC_ONLY);
        const machine = target.boot(built.bytes);
        const sink = new StreamSink(target.clockHz, { sampleRate: 48000, capacitySeconds: 3 });
        machine.listen(sink);
        const FRAMES = 120;
        for (let frame = 0; frame < FRAMES; frame += 1) machine.runFrame();

        // A hundred and twenty frames of the *console's* own rate, and that many
        // seconds of samples: the chip is clocked by the same master clock the CPU
        // counts in, and a ratio slipped in anywhere here would show up as a tempo
        // that is not the one the arranger reported. The band is loose by a few
        // percent because `runFrame` stops at the *next* vertical blank rather than
        // after an exact number of clocks; a wrong ratio would miss by a factor,
        // not by three percent.
        const expected = FRAMES / (target.frameHz ?? 60);
        const left = new Float32Array(sink.available);
        const right = new Float32Array(sink.available);
        const count = sink.read(left, right, left.length);
        const seconds = count / 48000;
        expect(seconds).toBeGreaterThan(expected * 0.95);
        expect(seconds).toBeLessThan(expected * 1.1);
        expect(sink.dropped).toBe(0);

        let peak = 0;
        for (let i = 0; i < count; i += 1) peak = Math.max(peak, Math.abs(left[i] as number));
        expect(peak, "the cartridge played silence").toBeGreaterThan(0.05);
      },
      BUILDS_TIMEOUT,
    );

    it(
      "stays silent when nothing is listening",
      async () => {
        // The conformance suites run without a sink, and must pay nothing for it.
        const { built } = await build(target, MUSIC_ONLY);
        const machine = target.boot(built.bytes);
        expect(machine.listening).toBe(false);
        for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
        expect(machine.listening).toBe(false);
      },
      BUILDS_TIMEOUT,
    );
  });

  describe(`what a ${target.name} game pulls in`, async () => {
    it(
      "emits no preemption machinery when nothing can preempt",
      async () => {
        const { built } = await build(target, MUSIC_ONLY);
        const helpers = built.stats.audio?.helpers ?? [];
        expect(helpers).toContain("music-order-walk");
        expect(helpers.some((name) => name.includes("preemptible"))).toBe(false);
        expect(helpers).not.toContain(target.mergeHelper);
      },
      BUILDS_TIMEOUT,
    );

    it(
      "emits no music player in a game that only has effects",
      async () => {
        const { built } = await build(target, EFFECT_ONLY);
        const helpers = built.stats.audio?.helpers ?? [];
        expect(helpers.some((name) => name.startsWith("sfx-"))).toBe(true);
        expect(helpers.some((name) => name.startsWith("music-"))).toBe(false);
        expect(built.stats.audio?.tracks).toBe(0);
      },
      BUILDS_TIMEOUT,
    );

    it(
      "pulls the one-shot stop path for an effect and not for a track",
      async () => {
        const { built } = await build(target, WITH_EFFECT);
        const helpers = built.stats.audio?.helpers ?? [];
        expect(helpers).toContain("sfx-one-shot-stop");
        expect(helpers).not.toContain("music-one-shot-stop");
      },
      BUILDS_TIMEOUT,
    );
  });
}

/**
 * The size sweep: every example game, built with its art and its audio.
 *
 * The counterpart of the battery above and the reason this file is minutes
 * rather than seconds — a build here is the whole `prep` tournament per picture.
 */
export function audioSweep(target: Target): void {
  describe(`the example library, on ${target.name} hardware`, async () => {
    /**
     * `quest` is not swept here, and the reason is the cartridge rather than the
     * audio: three levels, a boss and a secret room do not fit a mapper-less 32 KiB
     * on any 8-bit console in the set (doc 13 §Banked cartridges). The one machine
     * with the room is the Mega Drive, where `rom.test.ts` runs it — and a game
     * that cannot be built cannot have its register stream compared.
     */
    const cases = EXAMPLES.filter((name) => name !== "quest");

    /**
     * The fixtures whose cartridges cannot hold their audio.
     *
     * Empty, and the emptiness is the record: every console with a backend now
     * builds every example game with its art and its music in it. The Sega 8-bits
     * were the last entry here — the shooter overflowed a Master System by 1.9 KiB
     * — and what closed it was the work the NES had already had: the name tables
     * packed, the collision pairs looped rather than copied, and the integrator
     * grouped by what it would have compiled to. Not a skip either way: an overflow
     * is *asserted*, so the day a change makes a listed fixture fit, this test fails
     * and someone moves it into the sweep above.
     */
    const OVER_BUDGET: Readonly<Record<string, readonly string[]>> = {};

    /**
     * Bytes a build has to have left over: a kilobyte, everywhere.
     *
     * The Sega 8-bits carried an exception at 512 while their rule code was still
     * copied per object, exactly as the NES did before them. Looping the pairs took
     * nine kilobytes off the shooter's Master System build and the exception went
     * with it.
     *
     * **Measured against the largest board the console has**, not the one the
     * cartridge shipped on (doc 14 §Elastic cartridges) — so on the Sega 8-bits
     * this is headroom against 48 KiB even though every fixture ships on 32, and
     * the number it reports is larger than it used to be for that reason alone.
     * What it still catches is the only thing it ever could: a game that has
     * stopped fitting the console. The cliff *within* a console — crossing `$7FF0`
     * and paying for the 48 KiB board — is a bigger file rather than a failure,
     * and is visible in `stats.cartridge`.
     */
    const HEADROOM: Readonly<Record<string, number>> = {};

    /**
     * What one of these builds is allowed to take.
     *
     * Demaking a game's art for a colour console is the whole `prep` tournament per
     * picture, which is seconds rather than the fraction of one the mono path costs
     * — so the sweep states its own budget instead of inheriting one written for a
     * test that runs a single pipeline.
     *
     * The Sega 8-bits are the slow end of it, and knowingly — for the *art* rather
     * than for the code. A Master System picture is 768 cells against a shared bank
     * of 256 tiles, so two full-screen pictures routinely want more of it than there
     * is, and where sharing the bank out changes what a picture may spend, that
     * picture is demade a second time (`sms-art.ts`). Half again on the worst
     * fixture, in exchange for a title screen fitted to the tiles it actually needs
     * rather than to half the bank.
     */
    const BUILD_TIMEOUT = 120_000;

    /**
     * And the colour consoles are slower still, for the same reason one layer along.
     *
     * A fit's cost is its pixels, and these have the big screens: 320x224 on a
     * Mega Drive against a Master System's 256x192 and a Game Boy's 160x144, and
     * a Super Nintendo's 256x224 fitted into *seven* sixteen-colour sub-palettes
     * rather than one. One backdrop through the tournament is around twenty-five
     * seconds on a Mega Drive and thirty on a Super Nintendo — nearly all of it
     * inside `latticeKmeans`, which is the fit doing its job rather than a
     * redundant scan — so a two-backdrop game with objects is minutes.
     *
     * **The rule is at least double what the console costs on the slowest machine
     * that runs it**, which is CI rather than a workstation: a GitHub runner is
     * around half the speed of a developer's, so a budget with a comfortable
     * margin here is a red test there. What these guard against is a *hang*, and
     * a build that merely got half again slower should be caught by someone
     * reading a duration rather than by a timeout with nothing to say about why —
     * so a generous number is the point and not a concession. Measured on the
     * runner, slowest fixture per console: Mega Drive 122 s, Super Nintendo 247 s,
     * PC Engine 123 s.
     *
     * The PC Engine had no entry and inherited {@link BUILD_TIMEOUT}, which was
     * written before that console existed and is a third of what its slowest
     * fixture takes in CI.
     */
    const TIMEOUT: Readonly<Record<string, number>> = {
      md: 360_000,
      snes: 540_000,
      pce: 300_000,
    };

    /**
     * How much of the library each console sweeps.
     *
     * **A budget can only decide a cartridge already near the edge**, so what a
     * console sweeps is the fixtures a budget could plausibly decide — measured,
     * not guessed. Bytes free against the 1 KiB floor, tightest first:
     *
     * | console | free bytes |
     * | --- | --- |
     * | `gb` | shooter 2182, caves 6016, runner 6455, dodger 8744, breakout 10643, pong 12721, platformer 14448 |
     * | `sms` | caves 19648, runner 20982, shooter 23602, dodger 25301, breakout 25695, pong 27477, platformer 28386 |
     * | `nes` | caves 10586, runner 11205, shooter 13457, breakout 14285, pong 14582, dodger 14692, platformer 18037 |
     *
     * The Game Boys sweep everything because they are the tightest family in the
     * library *and* the cheapest to build — the whole seven is under a minute
     * there, against six for the same seven on an NES. That is also what keeps
     * every game's audio bound somewhere: the sweep is the only place a fixture is
     * built *with* its music and effects, since `rom.test.ts` traces them with the
     * assets left out.
     *
     * The other five sweep the fixtures that could actually fail. A Master System
     * used to be a real budget at 32 KiB and is now measured against the 48 KiB
     * board it grows onto, so its numbers above are the larger ones; it keeps the
     * two tightest, because the caves are still the fixture nearest whatever the
     * limit is. An NES is not a budget either: every fixture there is nine to
     * eighteen kilobytes clear, so no code-generator change short of a catastrophe
     * could trip one, and the two tightest are kept as a floor guard and to assert
     * the driver's reported sizes are real rather than the zero they held before
     * `assemble` (`backend.ts` §BoundAudioShape). Five more builds a piece bought
     * neither, at ten minutes of `pnpm test`.
     *
     * A Mega Drive and a Super Nintendo take the shooter alone, for opposite
     * reasons: a Mega Drive game is twenty-odd kilobytes against four megabytes of
     * boards and there is no overflow to catch at all, and a Super Nintendo picture is
     * thirty seconds of tournament against five. Both build the shooter because it
     * is the tightest fixture everywhere else — two demade backdrops, nine aliens,
     * a theme and four effects.
     *
     * Re-measure before widening or narrowing this: the numbers above move with
     * every code-generator change, and the day a console's tightest fixture
     * approaches the floor is the day it wants more of the library, not less.
     *
     * **These are example names, not file names.** `cases` comes from `EXAMPLES`,
     * which is a project folder per game — `shooter`, not `shooter.dmt`. Written
     * with the extension the filter matched nothing and both consoles swept *no*
     * fixtures at all, which is what this list exists to prevent; splitting the
     * battery per console is what surfaced it, because an empty `describe` is an
     * error where one console's silence inside a shared one is invisible.
     */
    const SWEEP: Readonly<Record<string, readonly string[]>> = {
      // The platformer is the third for a reason that is not its size: it is the
      // one fixture whose NES build fits an NROM-128, so it is the only place in
      // the suite a *small-board* cartridge is built with a driver in it (doc 14
      // §Elastic cartridges). `rom.test.ts` runs NROM-128 cartridges in the core
      // and proves the origin change is invisible to a tick; those builds have no
      // audio, and this is the case that does.
      nes: ["caves", "runner", "platformer"],
      sms: ["caves", "runner"],
      md: ["shooter"],
      snes: ["shooter"],
      // The PC Engine keeps the two tightest, and here they really are the two
      // tightest rather than the shooter: characters are *program* bytes on this
      // console, uploaded at boot, so a game's budget follows its art and not its
      // object count. The caves and the runner leave around eight kilobytes of
      // the 48 KiB window; the shooter, which is the tightest fixture on every
      // other machine, leaves fifteen.
      pce: ["caves", "runner"],
      // The WonderSwan keeps the same two, and for the PC Engine's reason with
      // the numbers changed: a cartridge here is half a megabyte and only its
      // last 64 KiB is mapped, so a game's budget is the window and the window
      // holds its characters as well as its code. The two level games are what
      // fill it. Demaking a 224×144 picture into seven sixteen-colour
      // sub-palettes is also a couple of minutes a fixture on this console, so
      // the list is what the sweep can actually afford.
      wsc: ["caves", "runner"],
      // The Neo Geo Pocket Color keeps one, and unlike every entry above it the
      // reason is not the budget: a cartridge here is four megabits against a
      // game's seventeen kilobytes, so there is no overflow for the assertion to
      // catch. What the sweep still buys is the Mega Drive's and the Nintendo
      // DS's — that the driver's reported sizes are *real* rather than the zero
      // they hold before `assemble` — and one fixture says that as well as
      // seven. The shooter, because a budget can only ever decide a cartridge
      // already near the edge and it is the nearest this console has.
      ngpc: ["shooter"],
      ws: ["caves", "runner"],
    };

    for (const file of cases) {
      if (OVER_BUDGET[target.id]?.includes(file)) continue;
      if (SWEEP[target.id] !== undefined && !SWEEP[target.id]?.includes(file)) continue;
      it(
        `${file} fits in a ${target.name} cartridge with its music and effects`,
        async () => {
          const { built } = await build(target, gameSource(file), file);
          expect(built.stats.missingAudio).toEqual([]);
          expect(built.stats.audio?.effects ?? 0).toBeGreaterThan(0);
          // What the audio cost, and *that* it was measured at all. A driver is
          // emitted during `assemble`, so a backend that copies its sizes out of
          // the binding instead of querying them reports the zero they held
          // beforehand (`backend.ts` §BoundAudioShape) — which every backend did
          // until recently, and `demake build` said "0 bytes of driver, 0 of
          // schedule" for every cartridge it made. Nothing caught it, because
          // nothing asserted the number was real. This is that assertion.
          expect(built.stats.audio?.code ?? 0).toBeGreaterThan(0);
          expect(built.stats.audio?.data ?? 0).toBeGreaterThan(0);
          // Headroom, deliberately asserted: a fixture built to the last hundred
          // bytes turns the next code-generator change into a mystery.
          expect(built.stats.free).toBeGreaterThan(HEADROOM[target.id] ?? 1024);
          // And nothing was dropped to get there. A game that outgrows the biggest
          // board its console has loses its music rather than failing to build
          // (doc 14 §When it does not fit, the music goes first), which is the
          // right answer for somebody's game and the wrong one for a fixture: it
          // would turn an overflow into a cartridge that quietly plays silently.
          expect(built.stats.cut).toEqual([]);
        },
        TIMEOUT[target.id] ?? BUILD_TIMEOUT,
      );
    }

    for (const file of OVER_BUDGET[target.id] ?? []) {
      it(
        `${file} does not fit in a ${target.name} cartridge with its music`,
        async () => {
          await expect(build(target, gameSource(file), file)).rejects.toThrowError(
            /E_GAME_TOO_LARGE|holds/,
          );
        },
        TIMEOUT[target.id] ?? BUILD_TIMEOUT,
      );
    }
  });
}

/**
 * The Game Boy Color's own budget, which is the Game Boy's plus what colour costs.
 */
export function colourBudget(): void {
  describe("a Game Boy Color cartridge's budget", async () => {
    // Colour costs cartridge, the way audio does. A Game Boy Color build of the
    // same game carries one attribute byte per backdrop cell (360 a picture), the
    // palettes it uploads, and the extra tiles colour art costs — two cells that
    // differ only in tone are one tile on a DMG and two here. That is a bit over
    // a kilobyte for a game with two demade backdrops, so the floor below is
    // lower than the monochrome one. Not because the budget matters less: it is a
    // *measured* fact about the hardware, and asserting it is what makes the next
    // code-generator change visible rather than a mystery.
    //
    // One fixture rather than seven, and the shooter because it is the tightest
    // in the library — two demade backdrops, nine aliens, a theme and four
    // effects. A kilobyte can only decide a cartridge that is already near the
    // edge, and demaking a picture in colour is the whole `prep` tournament:
    // seconds where the mono path is a fraction of one, and the reason this test
    // states its own timeout rather than inheriting one written for a single
    // pipeline. The others have four kilobytes and more to spare, and
    // `rom.test.ts` builds every fixture for `gbc` regardless.
    it("the shooter, the tightest cartridge in the library, still fits in colour", async () => {
      const { source, files, levels, assets } = exampleProject("shooter");
      const program = compile(source, { profile: getProfile("gbc"), files, levels });
      const built = await buildGbRom(program, { assets });
      expect(built.stats.missingAudio).toEqual([]);
      expect(built.stats.free).toBeGreaterThan(512);
    }, 120_000);
  });
}
