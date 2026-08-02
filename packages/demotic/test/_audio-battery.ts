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
 * byte to an address, and an SPC700 player that is not on the console's processor
 * at all — a second computer, handed its program at boot and keeping its own
 * 125 Hz. `NR51` merged, `$4015` merged, `KON` *masked* because it is a pulse
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
  buildMdGameAudio,
  buildNesGameAudio,
  buildSmsGameAudio,
  buildSpcGameAudio,
  gbChannelOf,
  nesChannelOf,
  psgChannelTag,
  sdspChannelTag,
  type ChannelTag,
  type ChipScript,
  type GameEffect,
} from "@demake/audio";
import {
  GB_CLOCK_HZ,
  NES_CLOCK_HZ,
  SDSP_CLOCK_HZ,
  SN76489_CLOCK_HZ,
  StreamSink,
  type SampleSink,
} from "@demake/chip";
import { megaduckRegister } from "@demake/core";
import { Gameboy } from "@demake/dmg";
import { Md } from "@demake/md";
import { Nes } from "@demake/nes";
import { Sms } from "@demake/sms";
import { Snes } from "@demake/snes";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { bindAudio, type BoundAudio } from "../src/codegen/audio.js";
import type { BuiltRom } from "../src/codegen/backend.js";
import { buildGbRom } from "../src/codegen/gb.js";
import { buildMdRom } from "../src/codegen/md.js";
import { buildNesRom } from "../src/codegen/nes.js";
import { buildSmsRom } from "../src/codegen/sms.js";
import { buildSnesRom } from "../src/codegen/snes.js";
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
   * Driver ticks per Game Boy driver tick on this console.
   *
   * The Game Boy's driver runs at 120 Hz and the other two at their frame, so a
   * window written in ticks means half as much time there. Every count below is
   * written for the Game Boy and scaled, so each run covers the same seconds of
   * track.
   */
  ratio: number;
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
    id: "sms",
    name: "Master System",
    clockHz: SN76489_CLOCK_HZ,
    // Nothing shared to merge: four attenuation latches, four channels, and no
    // byte that carries more than one of them. The Game Gear is the same chip
    // with a stereo latch bolted beside it, which is where the merge comes back —
    // its own case is below, rather than a fourth pass over the whole battery.
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
    id: "md",
    name: "Mega Drive",
    clockHz: SN76489_CLOCK_HZ,
    // The Master System's chip, and the Master System's answer: four independent
    // attenuation latches and no byte carrying more than one of them. The Game
    // Gear's stereo latch is the one place this chip grows a shared register, and
    // it is not on this console — the panning here lives in the FM half, which
    // `demake build` does not emit.
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
];

/** Every core answers the same five questions; this is the adapter, once. */
function wrap(machine: Gameboy | Nes | Sms | Snes | Md): Machine {
  return {
    step: () => {
      machine.stepInstruction();
      // On the Super Nintendo the program counter that matters is the *sound*
      // processor's: the driver runs there, so that is where a tick begins.
      return machine instanceof Snes ? machine.smp.pc : machine.cpu.pc;
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
      if (machine instanceof Sms) machine.psgTap = listener;
      else if (machine instanceof Snes) machine.dspTap = listener;
      else machine.apuTap = listener;
    },
    setButtons: (down) =>
      machine instanceof Snes
        ? // This pad's B and Y sit where the NES's A and B sat, which is the
          // mapping the cartridge assumes and the one the page uses.
          machine.setButtons(
            down.map((name) => (name === "a" ? "b" : name === "b" ? "y" : name)) as never,
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

/** Look a console up by id, so a per-console file names one and gets one. */
export function target(id: string): Target {
  const found = ALL.find((one) => one.id === id);
  if (!found) throw new Error(`no audio target for '${id}'`);
  return found;
}

/**
 * The register-level battery: what every driver must do, on one machine.
 *
 * Called once per console, from that console's own file.
 */
export function audioBattery(target: Target): void {
  describe(`a game's music, on ${target.name} hardware`, async () => {
    it("performs the schedule tick for tick, with nothing preempting it", async () => {
      const { built, bound } = await build(target, MUSIC_ONLY);
      const script = bound.driver?.performed.tracks[0];
      expect(script).toBeDefined();
      const address = target.tickAddress(built, bound);
      expect(address).toBeDefined();

      const ticks = 600;
      const expected = (script as ChipScript).ticks.slice(0, ticks).map((tick) => [...tick.writes]);
      const actual = capture(target, built.bytes, address as number, ticks);
      expect(firstDivergence(expected, actual)).toBeNull();
    });

    it("performs it identically in a ROM that also has effects in it", async () => {
      // The run-packed stream and the flat one are two encodings of one schedule,
      // and the whole point of the run format is that it changes nothing the chip
      // can see.
      const { built, bound } = await build(target, WITH_EFFECT);
      const script = bound.driver?.performed.tracks[0] as ChipScript;
      const address = target.tickAddress(built, bound);
      const ticks = 600;
      const expected = script.ticks.slice(0, ticks).map((tick) => [...tick.writes]);
      expect(firstDivergence(expected, capture(target, built.bytes, address, ticks))).toBeNull();
    });

    it("starts at the top of the schedule, with no silencing in front of it", async () => {
      const { built, bound } = await build(target, MUSIC_ONLY);
      const address = target.tickAddress(built, bound);
      const first = capture(target, built.bytes, address, 1)[0] as Write[];
      const want = bound.driver?.performed.tracks[0] as ChipScript;
      expect(show(first)).toBe(show([...(want.ticks[0] as { writes: Write[] }).writes]));
    });
  });

  describe(`an effect borrowing a ${target.name} channel`, async () => {
    it("plays its own schedule and hands the channel back", async () => {
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
    });

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
    it("emits audible samples at the delivery rate the page asks for", async () => {
      // The last link in doc 07's chain: the page plays what the chip emitted, so
      // what the chip emits from a *running game* has to be real audio. The
      // stream is `@demake/chip`'s, bit-identical to the offline renderer
      // (`packages/chip/test/stream.test.ts`), which is what makes the page a
      // playback device rather than a second implementation of the hardware.
      const { built } = await build(target, MUSIC_ONLY);
      const machine = target.boot(built.bytes);
      const sink = new StreamSink(target.clockHz, { sampleRate: 48000, capacitySeconds: 3 });
      machine.listen(sink);
      for (let frame = 0; frame < 120; frame += 1) machine.runFrame();

      // Two seconds of frames, two seconds of samples: the chip is clocked by the
      // same master clock the CPU counts in, and a ratio slipped in anywhere here
      // would show up as a tempo that is not the one the arranger reported. The
      // band is loose by a few percent because `runFrame` stops at the *next*
      // vertical blank rather than after an exact number of clocks; a wrong ratio
      // would miss by a factor, not by three percent.
      const left = new Float32Array(sink.available);
      const right = new Float32Array(sink.available);
      const count = sink.read(left, right, left.length);
      const seconds = count / 48000;
      expect(seconds).toBeGreaterThan(1.9);
      expect(seconds).toBeLessThan(2.2);
      expect(sink.dropped).toBe(0);

      let peak = 0;
      for (let i = 0; i < count; i += 1) peak = Math.max(peak, Math.abs(left[i] as number));
      expect(peak, "the cartridge played silence").toBeGreaterThan(0.05);
    });

    it("stays silent when nothing is listening", async () => {
      // The conformance suites run without a sink, and must pay nothing for it.
      const { built } = await build(target, MUSIC_ONLY);
      const machine = target.boot(built.bytes);
      expect(machine.listening).toBe(false);
      for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
      expect(machine.listening).toBe(false);
    });
  });

  describe(`what a ${target.name} game pulls in`, async () => {
    it("emits no preemption machinery when nothing can preempt", async () => {
      const { built } = await build(target, MUSIC_ONLY);
      const helpers = built.stats.audio?.helpers ?? [];
      expect(helpers).toContain("music-order-walk");
      expect(helpers.some((name) => name.includes("preemptible"))).toBe(false);
      expect(helpers).not.toContain(target.mergeHelper);
    });

    it("emits no music player in a game that only has effects", async () => {
      const { built } = await build(target, EFFECT_ONLY);
      const helpers = built.stats.audio?.helpers ?? [];
      expect(helpers.some((name) => name.startsWith("sfx-"))).toBe(true);
      expect(helpers.some((name) => name.startsWith("music-"))).toBe(false);
      expect(built.stats.audio?.tracks).toBe(0);
    });

    it("pulls the one-shot stop path for an effect and not for a track", async () => {
      const { built } = await build(target, WITH_EFFECT);
      const helpers = built.stats.audio?.helpers ?? [];
      expect(helpers).toContain("sfx-one-shot-stop");
      expect(helpers).not.toContain("music-one-shot-stop");
    });
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
     * with it; the tightest fixture is the caves, at 3062 bytes free.
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
     * And the Mega Drive is slower still, for the same reason one layer along.
     *
     * A fit's cost is its pixels, and this console has the biggest screen in the
     * set: 320x224 against a Master System's 256x192 and a Game Boy's 160x144. One
     * backdrop through the tournament is around twenty-five seconds here — nearly
     * all of it inside `latticeKmeans`, which is the fit doing its job rather than
     * a redundant scan — so a two-backdrop game with objects is minutes. The
     * number is generous rather than tight because what it guards against is a
     * hang, and a build that got half again slower should be caught by someone
     * reading a duration rather than by a red test with nothing to say about why.
     */
    const TIMEOUT: Readonly<Record<string, number>> = { md: 360_000, snes: 240_000 };

    /**
     * How much of the library each console sweeps.
     *
     * **A budget can only decide a cartridge already near the edge**, so what a
     * console sweeps is the fixtures a budget could plausibly decide — measured,
     * not guessed. Bytes free against the 1 KiB floor, tightest first:
     *
     * | console | free bytes |
     * | --- | --- |
     * | `gb` | shooter 2178, caves 6012, runner 7411, dodger 8372, breakout 10641, pong 12716, platformer 14448 |
     * | `sms` | caves 3358, runner 4599, shooter 7218, dodger 9027, breakout 9312, pong 11093, platformer 12007 |
     * | `nes` | caves 10667, runner 11774, shooter 13457, breakout 14285, dodger 14575, pong 14582, platformer 18037 |
     *
     * The Game Boys sweep everything because they are the tightest family in the
     * library *and* the cheapest to build — the whole seven is under a minute
     * there, against six for the same seven on an NES. That is also what keeps
     * every game's audio bound somewhere: the sweep is the only place a fixture is
     * built *with* its music and effects, since `rom.test.ts` traces them with the
     * assets left out.
     *
     * The other four sweep the fixtures that could actually fail. A Master System
     * is a real budget — the caves land 2.3 KiB above the floor — so it takes the
     * two tightest. An NES is not: every fixture there is ten to eighteen
     * kilobytes clear, so no code-generator change short of a catastrophe could
     * trip one, and the two tightest are kept as a floor guard and to assert the
     * driver's reported sizes are real rather than the zero they held before
     * `assemble` (`backend.ts` §BoundAudioShape). Five more builds a piece bought
     * neither, at ten minutes of `pnpm test`.
     *
     * A Mega Drive and a Super Nintendo take the shooter alone, for opposite
     * reasons: a Mega Drive game is twenty-odd kilobytes of a half-megabyte image
     * and there is no overflow to catch at all, and a Super Nintendo picture is
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
      nes: ["caves", "runner"],
      sms: ["caves", "runner"],
      md: ["shooter"],
      snes: ["shooter"],
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
