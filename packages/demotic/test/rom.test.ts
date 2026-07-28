/**
 * The proof: a ROM built from a `.dmt` plays the game the interpreter defines.
 *
 * This is doc 13's D3 acceptance in a unit test — same input tape, byte-identical
 * fixed-point state per tick, against the checked-in golden trace and against
 * the reference interpreter for every fixture in the example library. It runs
 * with no toolchain and no emulator install, because the assembler is ours and
 * so is `@demake/dmg`.
 *
 * Every game in `fixtures/games/` is here, levels and camera included. That is
 * the point of the list: a backend that quietly skipped a feature would pass a
 * shorter one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Gameboy } from "@demake/dmg";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { buildGbRom, HEADER_OFFSETS, ROM_SIZE, unsupportedFeatures } from "../src/codegen/gb.js";
import { Sim } from "../src/sim.js";
import { tape, trace } from "../src/trace.js";

import { romReady } from "../src/rom/trace.js";

import {
  gbTarget,
  gbcTarget,
  ggTarget,
  nesTarget,
  RomRunner,
  romTrace,
  smsTarget,
  snesTarget,
} from "./_rom-harness.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

/** The tape the golden trace was recorded with (see determinism.test.ts). */
const PONG_TAPE = "1:a,90:,90:left,120:right";

function build(source: string, levels?: Record<string, string>, consoleId = "gb") {
  return compile(source, { profile: getProfile(consoleId), levels });
}

describe("gb ROM", async () => {
  it("is a valid 32 KiB cartridge with correct checksums", async () => {
    const { bytes } = await buildGbRom(build(read("pong.dmt")), { title: "PONG" });
    expect(bytes.length).toBe(ROM_SIZE);
    let header = 0;
    for (let at = 0x0134; at <= 0x014c; at += 1)
      header = (header - (bytes[at] as number) - 1) & 0xff;
    expect(bytes[HEADER_OFFSETS.headerChecksum]).toBe(header);
    expect(bytes[HEADER_OFFSETS.cartridgeType]).toBe(0x00);
    expect(String.fromCharCode(...bytes.subarray(0x134, 0x138))).toBe("PONG");
  });

  it("reproduces the checked-in golden trace tick for tick", async () => {
    const program = build(read("pong.dmt"));
    expect(await romTrace(program, tape(PONG_TAPE))).toBe(read("pong.gb.trace").trimEnd());
  });

  it("refuses a console it has no backend for, rather than shipping a different game", async () => {
    const program = compile(read("pong.dmt"), { profile: getProfile("nes") });
    expect(unsupportedFeatures(program).length).toBeGreaterThan(0);
    await expect(buildGbRom(program)).rejects.toThrow(/cannot build/);
  });
});

describe("ROM conformance across the example library", async () => {
  const cases: readonly (readonly [string, string, Record<string, string>?])[] = [
    ["pong.dmt", "1:a,90:,90:left,120:right"],
    [join("games", "breakout.dmt"), "30:,20:a,50:,60:left,60:right,80:"],
    [join("games", "platformer.dmt"), "20:,15:a,40:right,20:a+right,60:right,45:"],
    [join("games", "dodger.dmt"), "20:,20:a,60:left,60:right,40:"],
    [join("games", "shooter.dmt"), "20:,20:a,40:left,20:a,60:right,40:"],
    [
      join("games", "caves.dmt"),
      // Climbs onto the first ledge, takes the coin there, then runs right into
      // the spikes: tile rules, tile separation, a vanishing object and a scene
      // change, all in one tape.
      "240:,42:right,1:a,18:,26:left,60:,200:right,40:",
      { "cavern.dmtl": read(join("games", "cavern.dmtl")) },
    ],
    [
      join("games", "runner.dmt"),
      "20:,20:a,60:right,30:a+right,60:right,40:",
      {
        "open.dmtl": read(join("games", "open.dmtl")),
        "lowpipe.dmtl": read(join("games", "lowpipe.dmtl")),
        "highpipe.dmtl": read(join("games", "highpipe.dmtl")),
        "pipemid.dmtl": read(join("games", "pipemid.dmtl")),
      },
    ],
  ];

  // Every console with a backend, over the same battery — which is what makes
  // `Backend` a contract rather than a resemblance (doc 14 §Runtime model). Both
  // Game Boys, because the colour build is the same machine code with a second
  // half bolted to the renderer: if that half ever leaked into the *simulation* —
  // a cell walk that moved an object, a palette upload that clobbered a scratch
  // byte — this is where it would show, and it would name the tick. And the NES,
  // because a second CPU is where an arithmetic or an ordering difference would
  // surface, and the whole point of the shared spine is that neither can. And the
  // Super Nintendo, because its accumulator is *sixteen* bits: every routine in
  // its value layer is a different program from the eight-bit one the other three
  // share, so agreement there is agreement about the arithmetic rather than about
  // the code.
  for (const target of [gbTarget, gbcTarget, nesTarget, smsTarget, ggTarget, snesTarget]) {
    for (const [file, script, levels] of cases) {
      it(`matches the interpreter for ${file} on ${target.console}`, async () => {
        const program = build(read(file), levels, target.console);
        const frames = tape(script);
        expect(await romTrace(program, frames, {}, target)).toBe(trace(new Sim(program), frames));
      });
    }
  }

  it("plays the same game on both, whatever it looks like", async () => {
    const frames = tape(PONG_TAPE);
    // Everything but the header line, which names the console it was built for.
    const body = async (consoleId: string): Promise<string> =>
      (await romTrace(build(read("pong.dmt"), undefined, consoleId), frames))
        .split("\n")
        .slice(1)
        .join("\n");
    expect(await body("gbc")).toBe(await body("gb"));
  });
});

/**
 * Headroom for a colour conversion.
 *
 * Demaking a picture for colour hardware is the whole `prep` tournament, which
 * is seconds where the mono path is milliseconds — the cost `demake prep -c gbc`
 * has always had. `bindArt` memoises it so only the first test here pays, but
 * the default timeout is written for tests that run one pipeline and a loaded
 * CI runner is several times slower than a developer's machine.
 */
const COLOUR_TIMEOUT = 120_000;

describe("the colour cartridge", { timeout: COLOUR_TIMEOUT }, async () => {
  const assets = () =>
    new Map(
      ["ball.svg", "paddle.svg", "pong.title.svg", "pong.play.svg"].map((name) => [
        name,
        new Uint8Array(readFileSync(join(fixtures, name))),
      ]),
    );

  it("declares itself a Game Boy Color cartridge, and a gb build does not", async () => {
    const color = await buildGbRom(build(read("pong.dmt"), undefined, "gbc"), { title: "PONG" });
    const mono = await buildGbRom(build(read("pong.dmt")), { title: "PONG" });
    // `$C0` is CGB-only: this build programs palette RAM from its first
    // instruction, so a DMG running it would show the wrong thing.
    expect(color.bytes[HEADER_OFFSETS.cgb]).toBe(0xc0);
    expect(mono.bytes[HEADER_OFFSETS.cgb]).toBe(0x00);
    // The flag is the last byte of the title field, so a colour cartridge's
    // title is the same fifteen characters a monochrome one's is.
    expect(String.fromCharCode(...color.bytes.subarray(0x134, 0x138))).toBe("PONG");
    let header = 0;
    for (let at = 0x0134; at <= 0x014c; at += 1)
      header = (header - (color.bytes[at] as number) - 1) & 0xff;
    expect(color.bytes[HEADER_OFFSETS.headerChecksum]).toBe(header);
  });

  it("boots the machine in colour mode and fills its palette RAM", async () => {
    const built = await buildGbRom(build(read("pong.dmt"), undefined, "gbc"), { assets: assets() });
    const machine = new Gameboy(built.bytes);
    expect(machine.cgb).toBe(true);
    for (let frame = 0; frame < 30; frame += 1) machine.runFrame();
    // The reserved palette is the font's ramp: white through black, and never
    // whatever the title screen's fit chose.
    const system = machine.bgPaletteRam.subarray(7 * 8, 8 * 8);
    expect([system[0], system[1]]).toEqual([0xff, 0x7f]); // white
    expect([system[6], system[7]]).toEqual([0x00, 0x00]); // black
    // And the picture's own palettes really arrived.
    const art = machine.bgPaletteRam.subarray(0, 7 * 8);
    expect(art.some((byte) => byte !== 0)).toBe(true);
  });

  it("draws the game in more colours than a Game Boy can show", async () => {
    const built = await buildGbRom(build(read("pong.dmt"), undefined, "gbc"), { assets: assets() });
    const machine = new Gameboy(built.bytes);
    for (let frame = 0; frame < 30; frame += 1) machine.runFrame();
    const seen = new Set<string>();
    const frame = machine.framebuffer;
    for (let at = 0; at < frame.length; at += 4) {
      seen.add(`${frame[at]},${frame[at + 1]},${frame[at + 2]}`);
    }
    expect(seen.size).toBeGreaterThan(4);
  });

  it("gives every background cell a palette, including the ones it never painted", async () => {
    const built = await buildGbRom(build(read("pong.dmt"), undefined, "gbc"), { assets: assets() });
    const machine = new Gameboy(built.bytes);
    for (let frame = 0; frame < 30; frame += 1) machine.runFrame();
    // Bank 1 at the map's addresses is the attribute map; a cell the game has
    // not drawn on still names the font's palette rather than palette 0, whose
    // colours belong to the picture.
    const attributes = machine.vram.subarray(0x2000 + 0x1800, 0x2000 + 0x1c00);
    expect(attributes.every((byte) => (byte & 0x07) <= 7)).toBe(true);
    const outsideTheView = attributes[31 * 32 + 31] as number;
    expect(outsideTheView & 0x07).toBe(7);
  });
});

describe("what the generated code costs", async () => {
  /** Console frames one game tick takes, measured with input held. */
  async function framesPerTick(
    program: ReturnType<typeof build>,
    target = gbTarget,
  ): Promise<number> {
    const runner = await RomRunner.create(program, {}, target);
    const { machine, layout } = runner;
    const read = (address: number, length: number) => machine.readMemory(address, length);
    // Past the title screen first, or the figure would be the cost of drawing a
    // still picture — which is nothing, and would report every game as fast.
    for (let frame = 0; frame < 20; frame += 1) machine.runFrame();
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
    machine.setButtons([]);
    // Settle, then hold a direction so the camera scrolls and the rules that
    // only fire while moving are in the measurement.
    for (let frame = 0; frame < 300; frame += 1) machine.runFrame();
    machine.setButtons(["right", "a"]);

    let ticks = 0;
    let last = romReady(layout, read);
    const frames = 600;
    for (let frame = 0; frame < frames; frame += 1) {
      machine.runFrame();
      const now = romReady(layout, read);
      if (now !== last) {
        last = now;
        ticks += 1;
      }
    }
    expect(ticks).toBeGreaterThan(0);
    return frames / ticks;
  }

  // Doc 14 §Runtime model publishes this figure rather than hiding it behind a
  // speed multiplier, so it is worth a test: at one frame per tick the game
  // keeps up with the hardware, and the interpreter this replaced never did.
  for (const [file, levels] of [
    ["pong.dmt", undefined],
    [join("games", "shooter.dmt"), undefined],
    [join("games", "caves.dmt"), { "cavern.dmtl": read(join("games", "cavern.dmtl")) }],
  ] as const) {
    it(`fits a tick inside a frame for ${file}`, async () => {
      expect(await framesPerTick(build(read(file), levels))).toBeLessThan(1.2);
    });
  }
});
