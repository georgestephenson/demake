/**
 * The proof for a game's sound: the ROM performs the schedule the demakers made.
 *
 * This is doc 16 §The proof, Level A, moved one layer up — where
 * `packages/audio/test/rom.test.ts` proves it for a cartridge whose only job is
 * one track, this proves it for a cartridge that is also playing a game: the
 * driver runs on a timer while the game runs on VBlank, an effect borrows a
 * channel from the music and gives it back, and none of that is allowed to
 * change a single register write.
 *
 * Attribution is by program counter, as it is there: `AudioTick` comes back in
 * the build's symbol table and `Gameboy.apuTap` observes the chip. Nothing is
 * added to the cartridge to make it testable, because the cartridge under test
 * has to be the cartridge that ships.
 *
 * It runs with no toolchain and no emulator install — the assembler is ours and
 * so is `@demake/dmg` — which is what makes an exact audio proof something
 * `pnpm test` can do on every change.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { gbChannelOf } from "@demake/audio";
import { GB_CLOCK_HZ, StreamSink } from "@demake/chip";
import { Gameboy } from "@demake/dmg";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { bindAudio } from "../src/codegen/audio.js";
import { buildGbRom } from "../src/codegen/gb.js";
import { Sim } from "../src/sim.js";
import { tape, trace } from "../src/trace.js";

import { romTrace } from "./_rom-harness.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const games = join(fixtures, "games");

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
 * Compile, demake and build — memoized, because demaking a track and two effects
 * is a second of work and several tests want the same cartridge.
 */
const builds = new Map<string, ReturnType<typeof buildOnce>>();

function buildOnce(source: string, dir: string) {
  const program = compile(source, { profile: getProfile("gb"), levels: levelsIn(dir) });
  const assets = assetsIn(dir);
  return {
    program,
    assets,
    built: buildGbRom(program, { assets }),
    bound: bindAudio(program, assets, 0xff8b),
  };
}

function build(source: string, dir = fixtures) {
  const key = `${dir}\u0000${source}`;
  const seen = builds.get(key);
  if (seen) return seen;
  const made = buildOnce(source, dir);
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
function capture(rom: Uint8Array, tickAddress: number, ticks: number, press?: number): Write[][] {
  const machine = new Gameboy(rom);
  const groups: Write[][] = [];
  let current: Write[] | undefined;
  machine.apuTap = (reg, value) => current?.push({ reg, value });
  let guard = 0;
  while (groups.length <= ticks) {
    machine.stepInstruction();
    if (machine.cpu.pc === tickAddress) {
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

describe("a game's music, on the hardware", () => {
  it("performs the schedule tick for tick, with nothing preempting it", () => {
    const { built, bound } = build(MUSIC_ONLY);
    const script = bound.driver?.performed.tracks[0];
    expect(script).toBeDefined();
    const address = built.symbols.get("AudioTick");
    expect(address).toBeDefined();

    const ticks = 600;
    const expected = (script as NonNullable<typeof script>).ticks
      .slice(0, ticks)
      .map((tick) => [...tick.writes]);
    const actual = capture(built.bytes, address as number, ticks);
    expect(firstDivergence(expected, actual)).toBeNull();
  });

  it("performs it identically in a ROM that also has effects in it", () => {
    // The run-packed stream and the flat one are two encodings of one schedule,
    // and the whole point of the run format is that it changes nothing the chip
    // can see.
    const { built, bound } = build(WITH_EFFECT);
    const script = bound.driver?.performed.tracks[0];
    const address = built.symbols.get("AudioTick") as number;
    const ticks = 600;
    const expected = (script as NonNullable<typeof script>).ticks
      .slice(0, ticks)
      .map((tick) => [...tick.writes]);
    expect(firstDivergence(expected, capture(built.bytes, address, ticks))).toBeNull();
  });

  it("starts at the top of the schedule, with no silencing in front of it", () => {
    const { built, bound } = build(MUSIC_ONLY);
    const address = built.symbols.get("AudioTick") as number;
    const first = capture(built.bytes, address, 1)[0] as Write[];
    const want = (bound.driver as NonNullable<typeof bound.driver>).performed.tracks[0];
    expect(show(first)).toBe(show([...(want as NonNullable<typeof want>).ticks[0]!.writes]));
  });
});

describe("an effect borrowing a channel", () => {
  it("plays its own schedule and hands the channel back", () => {
    const { built, bound } = build(WITH_EFFECT);
    const driver = bound.driver as NonNullable<typeof bound.driver>;
    const effect = driver.performed.effects[0] as NonNullable<(typeof driver.performed.effects)[0]>;
    const address = built.symbols.get("AudioTick") as number;
    const groups = capture(built.bytes, address, 400, 120);

    // The effect's channel, taken from the schedule rather than assumed.
    const owned = gbChannelOf(effect.ticks[0]!.writes[0]!.reg);
    const mine = (writes: readonly Write[]) =>
      writes.filter((write) => gbChannelOf(write.reg) === owned);

    // Find where the effect started: the first tick carrying its opening writes.
    const opening = show(mine([...effect.ticks[0]!.writes]));
    const start = groups.findIndex((writes, tick) => tick > 120 && show(mine(writes)) === opening);
    expect(start, "the effect never reached the chip").toBeGreaterThan(0);

    // From there, the effect's own channel is exactly what the schedule says —
    // and nothing else writes to it, which is the preemption working.
    for (let tick = 0; tick < effect.ticks.length; tick += 1) {
      const want = show(mine([...effect.ticks[tick]!.writes]));
      const got = show(mine((groups[start + tick] ?? []) as Write[]));
      expect(got, `effect tick ${tick}`).toBe(want);
    }

    // The music was never stopped: it kept writing its own channels across the
    // effect. (An effect is a few ticks long, so the window has to be wider than
    // the effect itself — the music writes when a note changes, not every tick.)
    const window = groups.slice(start, start + effect.ticks.length + 60).flat();
    const elsewhere = window.filter(
      (write) => gbChannelOf(write.reg) !== owned && gbChannelOf(write.reg) !== 0,
    );
    expect(elsewhere.length, "the music stopped while the effect played").toBeGreaterThan(0);

    // And it got its channel back: something writes the borrowed channel again
    // once the effect has released it.
    const after = groups
      .slice(start + effect.ticks.length + 1)
      .flat()
      .filter((write) => gbChannelOf(write.reg) === owned);
    expect(after.length, "the borrowed channel never came back").toBeGreaterThan(0);
  });

  it("leaves the music's panning bits alone while it holds a channel", () => {
    const { built, bound } = build(WITH_EFFECT);
    const driver = bound.driver as NonNullable<typeof bound.driver>;
    const effect = driver.performed.effects[0] as NonNullable<(typeof driver.performed.effects)[0]>;
    const owned = gbChannelOf(effect.ticks[0]!.writes[0]!.reg);
    const address = built.symbols.get("AudioTick") as number;
    const groups = capture(built.bytes, address, 400, 120);

    // `NR51` is merged, never stored: every value the chip sees after the effect
    // starts must keep at least one channel that is not the effect's, or the
    // music has been muted by a stream that had no business writing it.
    const panning = groups
      .slice(130)
      .flat()
      .filter((write) => write.reg === 0x25);
    expect(panning.length).toBeGreaterThan(0);
    const musical = (owned | (owned << 4)) ^ 0xff;
    expect(panning.some((write) => (write.value & musical) !== 0)).toBe(true);
  });
});

describe("listening to a running cartridge", () => {
  it("emits audible samples at the delivery rate the page asks for", () => {
    // The last link in doc 07's chain: the page plays what the chip emitted, so
    // what the chip emits from a *running game* has to be real audio. The
    // stream is `@demake/chip`'s, bit-identical to the offline renderer
    // (`packages/chip/test/stream.test.ts`), which is what makes the page a
    // playback device rather than a second implementation of the hardware.
    const { built } = build(MUSIC_ONLY);
    const machine = new Gameboy(built.bytes);
    const sink = new StreamSink(GB_CLOCK_HZ, { sampleRate: 48000, capacitySeconds: 3 });
    machine.audioSink = sink;
    for (let frame = 0; frame < 120; frame += 1) machine.runFrame();

    // Two seconds of frames, two seconds of samples: the APU is clocked by the
    // same master clock the CPU counts in, and a ratio slipped in anywhere here
    // would show up as a tempo that is not the one the arranger reported. The
    // band is loose by a few percent because `runFrame` stops at the *next*
    // VBlank rather than after an exact number of clocks; a wrong ratio would
    // miss by a factor, not by three percent.
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
    const { built } = build(MUSIC_ONLY);
    const machine = new Gameboy(built.bytes);
    expect(machine.audioSink).toBeUndefined();
    for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
    expect(machine.audioSink).toBeUndefined();
  });
});

describe("what a game pulls in", () => {
  it("emits no preemption machinery when nothing can preempt", () => {
    const { built } = build(MUSIC_ONLY);
    const helpers = built.stats.audio?.helpers ?? [];
    expect(helpers).toContain("music-order-walk");
    expect(helpers.some((name) => name.includes("preemptible"))).toBe(false);
    expect(helpers).not.toContain("panning-merge");
  });

  it("emits no music player in a game that only has effects", () => {
    const { built } = build(EFFECT_ONLY);
    const helpers = built.stats.audio?.helpers ?? [];
    expect(helpers.some((name) => name.startsWith("sfx-"))).toBe(true);
    expect(helpers.some((name) => name.startsWith("music-"))).toBe(false);
    expect(built.stats.audio?.tracks).toBe(0);
  });

  it("pulls the one-shot stop path for an effect and not for a track", () => {
    const { built } = build(WITH_EFFECT);
    const helpers = built.stats.audio?.helpers ?? [];
    expect(helpers).toContain("sfx-one-shot-stop");
    expect(helpers).not.toContain("music-one-shot-stop");
  });
});

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

  for (const [file, dir] of cases) {
    it(`${file} fits in a cartridge with its music and effects`, () => {
      const { built } = build(readFileSync(join(dir, file), "utf8"), dir);
      expect(built.stats.missingAudio).toEqual([]);
      expect(built.stats.audio?.effects ?? 0).toBeGreaterThan(0);
      // Headroom, deliberately asserted: a fixture built to the last hundred
      // bytes turns the next code-generator change into a mystery.
      expect(built.stats.free).toBeGreaterThan(1024);
    });
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
  // Three fixtures rather than seven, and the three biggest: demaking a picture
  // in colour is the whole `prep` tournament — seconds, where the mono path is
  // a fraction of one — and a kilobyte can only decide the cartridges that are
  // already near the edge. The shooter is the tightest in the library, the
  // caves are a level with tile art, and the runner composes its levels.
  for (const file of ["shooter.dmt", "caves.dmt", "runner.dmt"]) {
    it(`${file} still fits when it is demade in colour`, () => {
      const source = readFileSync(join(games, file), "utf8");
      const program = compile(source, { profile: getProfile("gbc"), levels: levelsIn(games) });
      const built = buildGbRom(program, { assets: assetsIn(games) });
      expect(built.stats.missingAudio).toEqual([]);
      expect(built.stats.free).toBeGreaterThan(512);
    });
  }
});
