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
 * **And it runs on both consoles**, which is what makes it a proof of the
 * *contract* rather than of one driver. The two share nothing below the packed
 * format: an SM83 player on a programmable timer at 120 Hz against a 6502 player
 * on the picture's own interrupt at 60, `NR51` merged against `$4015` merged,
 * four writes to silence a Game Boy channel against one bit to silence an NES's.
 * What they do share is the only thing doc 16 promises — on tick N the driver
 * performs exactly the writes `ChipScript.ticks[N]` lists, in order — so the
 * battery below is written once and pointed at each machine in turn.
 *
 * Attribution is by program counter, as it is there: `AudioTick` comes back in
 * the build's symbol table and the core's `apuTap` observes the chip. Nothing is
 * added to the cartridge to make it testable, because the cartridge under test
 * has to be the cartridge that ships.
 *
 * It runs with no toolchain and no emulator install — the assemblers are ours
 * and so are `@demake/dmg` and `@demake/nes` — which is what makes an exact
 * audio proof something `pnpm test` can do on every change.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildGameAudio,
  buildNesGameAudio,
  gbChannelOf,
  nesChannelOf,
  type ChipScript,
  type GameEffect,
} from "@demake/audio";
import { GB_CLOCK_HZ, NES_CLOCK_HZ, StreamSink, type SampleSink } from "@demake/chip";
import { Gameboy } from "@demake/dmg";
import { Nes } from "@demake/nes";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { bindAudio, type BoundAudio } from "../src/codegen/audio.js";
import type { BuiltRom } from "../src/codegen/backend.js";
import { buildGbRom } from "../src/codegen/gb.js";
import { buildNesRom } from "../src/codegen/nes.js";
import { Sim } from "../src/sim.js";
import { tape, trace } from "../src/trace.js";

import { romTrace } from "./_rom-harness.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const games = join(fixtures, "games");

/** The five things this battery needs of a console, and nothing else. */
interface Machine {
  /** Run one instruction, and say where the program counter ended up. */
  step(): number;
  /** Everything the chip receives, observed rather than intercepted. */
  tap(listener: (reg: number, value: number) => void): void;
  setButtons(down: readonly string[]): void;
  runFrame(): void;
  listen(sink: SampleSink | undefined): void;
  readonly listening: boolean;
}

/** One console, as everything below addresses it. */
interface Target {
  id: string;
  name: string;
  /** The chip's master clock, which the stream sink is rendered against. */
  clockHz: number;
  /** Compile and build the cartridge, and demake its audio again beside it. */
  build(source: string, dir: string): { built: BuiltRom; bound: BoundAudio<Driver> };
  boot(rom: Uint8Array): Machine;
  /** Which voice a register belongs to; `0` for one that belongs to none. */
  channelOf(reg: number): number;
  /** The one register two streams merge into rather than store over. */
  mergeReg: number;
  /** The helper name the merge pulls in, which each driver calls its own thing. */
  mergeHelper: string;
}

/** What both drivers agree to hand back, which is all this file uses. */
interface Driver {
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
}

/** Every file in a directory, as the bytes a build is handed. */
function assetsIn(dir: string): Map<string, Uint8Array> {
  const assets = new Map<string, Uint8Array>();
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isFile()) continue;
    assets.set(name.name, new Uint8Array(readFileSync(join(dir, name.name))));
  }
  return assets;
}

function levelsIn(dir: string): Record<string, string> {
  const levels: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".dmtl")) levels[name] = readFileSync(join(dir, name), "utf8");
  }
  return levels;
}

/**
 * The two consoles, and the whole of what differs between them.
 *
 * Rebuilding the driver beside the cartridge rather than reading it out of the
 * build is deliberate: the schedules a test compares against have to come from
 * the demakers, not from anything the backend chose to remember, or the proof
 * would be the ROM agreeing with itself.
 */
const TARGETS: readonly Target[] = [
  {
    id: "gb",
    name: "Game Boy",
    clockHz: GB_CLOCK_HZ,
    mergeReg: 0x25,
    mergeHelper: "panning-merge",
    channelOf: gbChannelOf,
    build(source, dir) {
      const program = compile(source, { profile: getProfile("gb"), levels: levelsIn(dir) });
      const assets = assetsIn(dir);
      const built = buildGbRom(program, { assets });
      const bound = bindAudio(program, assets, {
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
    id: "nes",
    name: "NES",
    clockHz: NES_CLOCK_HZ,
    mergeReg: 0x15,
    mergeHelper: "enable-merge",
    channelOf: nesChannelOf,
    build(source, dir) {
      const program = compile(source, { profile: getProfile("nes"), levels: levelsIn(dir) });
      const assets = assetsIn(dir);
      const built = buildNesRom(program, { assets });
      // Page zero the allocator set aside, which is the address the cartridge
      // itself was built against — asking the layout is how the two stay one.
      const state = built.layout.audio as number;
      const bound = bindAudio(program, assets, {
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
];

/** Both cores answer the same five questions; this is the adapter, once. */
function wrap(machine: Gameboy | Nes): Machine {
  return {
    step: () => {
      machine.stepInstruction();
      return machine.cpu.pc;
    },
    tap: (listener) => {
      machine.apuTap = listener;
    },
    setButtons: (down) => machine.setButtons(down as never),
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

function build(target: Target, source: string, dir = fixtures) {
  const key = `${target.id}\u0000${dir}\u0000${source}`;
  const seen = builds.get(key);
  if (seen) return seen;
  const made = target.build(source, dir);
  builds.set(key, made);
  return made;
}

/** One register write the chip received. */
interface Write {
  reg: number;
  value: number;
}

/**
 * Run a ROM and group the writes the chip receives by driver tick.
 *
 * A group opens when the driver *enters* its tick routine, which is why the run
 * continues past the last tick wanted: the final group would otherwise be
 * reported half-finished.
 */
function capture(
  target: Target,
  rom: Uint8Array,
  tickAddress: number,
  ticks: number,
  press?: number,
): Write[][] {
  const machine = target.boot(rom);
  const groups: Write[][] = [];
  let current: Write[] | undefined;
  machine.tap((reg, value) => current?.push({ reg, value }));
  let guard = 0;
  while (groups.length <= ticks) {
    if (machine.step() === tickAddress) {
      current = [];
      groups.push(current);
    }
    if (press !== undefined && groups.length === press) machine.setButtons(["a"]);
    guard += 1;
    if (guard > 100_000_000) throw new Error("the driver stopped ticking");
  }
  return groups.slice(0, ticks);
}

function show(writes: readonly Write[]): string {
  return writes.map((w) => `$${hex(w.reg)}=$${hex(w.value)}`).join(" ");
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

/** Where two write streams first differ, named by tick — never a deep-equal dump. */
function firstDivergence(expected: readonly Write[][], actual: readonly Write[][]): string | null {
  for (let tick = 0; tick < expected.length; tick += 1) {
    const want = show(expected[tick] as Write[]);
    const got = show((actual[tick] ?? []) as Write[]);
    if (want !== got) return `tick ${tick}: expected [${want}], the ROM wrote [${got}]`;
  }
  return null;
}

const MUSIC_ONLY = `
start play
scene play
create number score in play (value 0, x 1, y 1)
music rally.mid in play
`;

const WITH_EFFECT = `${MUSIC_ONLY}
sound bounce.wav on a pressed
`;

const EFFECT_ONLY = `
start play
scene play
create number score in play (value 0, x 1, y 1)
sound bounce.wav on a pressed
`;

for (const target of TARGETS) {
  describe(`a game's music, on ${target.name} hardware`, () => {
    it("performs the schedule tick for tick, with nothing preempting it", () => {
      const { built, bound } = build(target, MUSIC_ONLY);
      const script = bound.driver?.performed.tracks[0];
      expect(script).toBeDefined();
      const address = built.symbols.get("AudioTick");
      expect(address).toBeDefined();

      const ticks = 600;
      const expected = (script as ChipScript).ticks.slice(0, ticks).map((tick) => [...tick.writes]);
      const actual = capture(target, built.bytes, address as number, ticks);
      expect(firstDivergence(expected, actual)).toBeNull();
    });

    it("performs it identically in a ROM that also has effects in it", () => {
      // The run-packed stream and the flat one are two encodings of one schedule,
      // and the whole point of the run format is that it changes nothing the chip
      // can see.
      const { built, bound } = build(target, WITH_EFFECT);
      const script = bound.driver?.performed.tracks[0] as ChipScript;
      const address = built.symbols.get("AudioTick") as number;
      const ticks = 600;
      const expected = script.ticks.slice(0, ticks).map((tick) => [...tick.writes]);
      expect(firstDivergence(expected, capture(target, built.bytes, address, ticks))).toBeNull();
    });

    it("starts at the top of the schedule, with no silencing in front of it", () => {
      const { built, bound } = build(target, MUSIC_ONLY);
      const address = built.symbols.get("AudioTick") as number;
      const first = capture(target, built.bytes, address, 1)[0] as Write[];
      const want = bound.driver?.performed.tracks[0] as ChipScript;
      expect(show(first)).toBe(show([...(want.ticks[0] as { writes: Write[] }).writes]));
    });
  });

  describe(`an effect borrowing a ${target.name} channel`, () => {
    it("plays its own schedule and hands the channel back", () => {
      const { built, bound } = build(target, WITH_EFFECT);
      const driver = bound.driver as Driver;
      const effect = driver.performed.effects[0] as ChipScript;
      const address = built.symbols.get("AudioTick") as number;
      // The press lands at the same *moment* on both machines rather than at the
      // same tick index: an NES driver ticks half as often as a Game Boy's, so a
      // fixed tick number would be a different second of the track.
      const press = Math.round(120 * ratio(target));
      const groups = capture(target, built.bytes, address, Math.round(400 * ratio(target)), press);

      // The effect's channel, taken from the schedule rather than assumed — the
      // first write that names one, because a schedule may open with a register
      // that belongs to no channel (the NES's enable mask does).
      const owned = channelOfEffect(target, effect);
      const mine = (writes: readonly Write[]) =>
        writes.filter((write) => target.channelOf(write.reg) === owned);

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
      const elsewhere = window.filter(
        (write) => target.channelOf(write.reg) !== owned && target.channelOf(write.reg) !== 0,
      );
      expect(elsewhere.length, "the music stopped while the effect played").toBeGreaterThan(0);

      // And it got its channel back: something writes the borrowed channel again
      // once the effect has released it.
      const after = groups
        .slice(start + effect.ticks.length + 1)
        .flat()
        .filter((write) => target.channelOf(write.reg) === owned);
      expect(after.length, "the borrowed channel never came back").toBeGreaterThan(0);
    });

    it("leaves the music's own bits alone in the register they share", () => {
      // `NR51` on one machine and `$4015` on the other, and the same rule: one
      // byte carries every channel, so it is merged and never stored. Every value
      // the chip sees after the effect starts must keep at least one channel that
      // is not the effect's, or the music has been muted by a stream that had no
      // business writing it.
      const { built, bound } = build(target, WITH_EFFECT);
      const driver = bound.driver as Driver;
      const effect = driver.performed.effects[0] as ChipScript;
      const owned = channelOfEffect(target, effect);
      const address = built.symbols.get("AudioTick") as number;
      const press = Math.round(120 * ratio(target));
      const groups = capture(target, built.bytes, address, Math.round(400 * ratio(target)), press);

      const shared = groups
        .slice(press + 10)
        .flat()
        .filter((write) => write.reg === target.mergeReg);
      expect(shared.length).toBeGreaterThan(0);
      // The Game Boy's byte carries each channel twice, left and right; the NES's
      // carries it once. Masking with both is what makes one assertion serve two.
      const musical = (owned | (owned << 4)) ^ 0xff;
      expect(shared.some((write) => (write.value & musical) !== 0)).toBe(true);
    });
  });

  describe(`listening to a running ${target.name} cartridge`, () => {
    it("emits audible samples at the delivery rate the page asks for", () => {
      // The last link in doc 07's chain: the page plays what the chip emitted, so
      // what the chip emits from a *running game* has to be real audio. The
      // stream is `@demake/chip`'s, bit-identical to the offline renderer
      // (`packages/chip/test/stream.test.ts`), which is what makes the page a
      // playback device rather than a second implementation of the hardware.
      const { built } = build(target, MUSIC_ONLY);
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

    it("stays silent when nothing is listening", () => {
      // The conformance suites run without a sink, and must pay nothing for it.
      const { built } = build(target, MUSIC_ONLY);
      const machine = target.boot(built.bytes);
      expect(machine.listening).toBe(false);
      for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
      expect(machine.listening).toBe(false);
    });
  });

  describe(`what a ${target.name} game pulls in`, () => {
    it("emits no preemption machinery when nothing can preempt", () => {
      const { built } = build(target, MUSIC_ONLY);
      const helpers = built.stats.audio?.helpers ?? [];
      expect(helpers).toContain("music-order-walk");
      expect(helpers.some((name) => name.includes("preemptible"))).toBe(false);
      expect(helpers).not.toContain(target.mergeHelper);
    });

    it("emits no music player in a game that only has effects", () => {
      const { built } = build(target, EFFECT_ONLY);
      const helpers = built.stats.audio?.helpers ?? [];
      expect(helpers.some((name) => name.startsWith("sfx-"))).toBe(true);
      expect(helpers.some((name) => name.startsWith("music-"))).toBe(false);
      expect(built.stats.audio?.tracks).toBe(0);
    });

    it("pulls the one-shot stop path for an effect and not for a track", () => {
      const { built } = build(target, WITH_EFFECT);
      const helpers = built.stats.audio?.helpers ?? [];
      expect(helpers).toContain("sfx-one-shot-stop");
      expect(helpers).not.toContain("music-one-shot-stop");
    });
  });
}

/**
 * The channel an effect took, read out of the schedule it will really perform.
 *
 * The first write that names a channel, not the first write: an effect's opening
 * tick states the chip's shared state first on some machines — the NES's `$4015`
 * is the whole enable mask and belongs to no single voice — and taking that one
 * would name "no channel" and make every assertion below vacuous.
 */
function channelOfEffect(target: Target, effect: ChipScript): number {
  for (const tick of effect.ticks) {
    for (const write of tick.writes) {
      const channel = target.channelOf(write.reg);
      if (channel !== 0) return channel;
    }
  }
  throw new Error("this effect writes no channel at all");
}

/**
 * Driver ticks per Game Boy driver tick on this console.
 *
 * The Game Boy's driver runs at 120 Hz and the NES's at the frame, so a window
 * written in ticks means half as much time there. Every count below is written
 * for the Game Boy and scaled, so the two runs cover the same seconds of track.
 */
function ratio(target: Target): number {
  return target.id === "nes" ? 0.5 : 1;
}

describe("audio in the trace", () => {
  it("records what the game asked for, with or without the files", () => {
    // A build with no audio bytes still records the request, so the conformance
    // suite can run without loading a megabyte of fixtures and still be
    // comparing the same game.
    const source = readFileSync(join(fixtures, "pong.dmt"), "utf8");
    const program = compile(source, { profile: getProfile("gb") });
    const frames = tape("1:a,90:,90:left,120:right");
    const silent = romTrace(program, frames);
    const sounding = romTrace(program, frames, { assets: assetsIn(fixtures) });
    expect(sounding).toBe(silent);
    expect(silent).toBe(trace(new Sim(program), frames));
  });

  it("names the track a scene asks for, and -1 for a silent one", () => {
    const source = readFileSync(join(fixtures, "pong.dmt"), "utf8");
    const program = compile(source, { profile: getProfile("gb") });
    const lines = trace(new Sim(program), tape("2:,3:a,3:")).split("\n");
    // The title screen is silent; the play scene asks for track 0.
    expect(lines.find((line) => line.includes(" title "))).toContain("audio=-1,-1");
    expect(lines.find((line) => line.includes(" play "))).toContain("audio=0,-1");
  });
});

describe("the example library", () => {
  const cases = [
    ["pong.dmt", fixtures],
    ...["breakout", "platformer", "dodger", "shooter", "caves", "runner"].map(
      (name) => [`${name}.dmt`, games] as const,
    ),
  ] as const;

  /**
   * The one fixture whose NES cartridge cannot hold its audio, and by how much.
   *
   * Not a skip: the overflow is *asserted*, so the day a codegen change makes it
   * fit, this test fails and someone moves it into the sweep above. The shooter is
   * the tightest game in the library on every console — two demade backdrops, nine
   * aliens, a theme and its effects — and on this one it runs out. Two facts add
   * up to it and both are measured rather than guessed: the game's 6502 code is
   * around 3.8 KiB larger than its SM83 code, and an NES backdrop is a 960-cell
   * nametable against a Game Boy's 360. There is no mapper on an NROM cartridge to
   * spend the difference from.
   */
  const OVER_BUDGET: Readonly<Record<string, readonly string[]>> = { nes: ["shooter.dmt"] };

  for (const target of TARGETS) {
    for (const [file, dir] of cases) {
      if (OVER_BUDGET[target.id]?.includes(file)) continue;
      it(`${file} fits in a ${target.name} cartridge with its music and effects`, () => {
        const { built } = build(target, readFileSync(join(dir, file), "utf8"), dir);
        expect(built.stats.missingAudio).toEqual([]);
        expect(built.stats.audio?.effects ?? 0).toBeGreaterThan(0);
        // Headroom, deliberately asserted: a fixture built to the last hundred
        // bytes turns the next code-generator change into a mystery.
        expect(built.stats.free).toBeGreaterThan(1024);
      }, // Demaking a game's art for the NES is the whole `prep` tournament per
      // picture, which is seconds rather than the fraction of one the mono path
      // costs — so this states its own budget instead of inheriting one written
      // for a single pipeline.
      60_000);
    }

    for (const file of OVER_BUDGET[target.id] ?? []) {
      it(`${file} does not fit in a ${target.name} cartridge with its music`, () => {
        const source = readFileSync(join(games, file), "utf8");
        expect(() => build(target, source, games)).toThrowError(/E_GAME_TOO_LARGE|holds/);
      }, 60_000);
    }
  }

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
  it("the shooter, the tightest cartridge in the library, still fits in colour", () => {
    const source = readFileSync(join(games, "shooter.dmt"), "utf8");
    const program = compile(source, { profile: getProfile("gbc"), levels: levelsIn(games) });
    const built = buildGbRom(program, { assets: assetsIn(games) });
    expect(built.stats.missingAudio).toEqual([]);
    expect(built.stats.free).toBeGreaterThan(512);
  }, 120_000);
});
