/**
 * The proof: a ROM built from a `.dmt` plays the game the interpreter defines.
 *
 * This is doc 13's D3 acceptance in a unit test — same input tape, byte-identical
 * fixed-point state per tick, against the checked-in golden trace and against
 * the reference interpreter for every fixture in the example library. It runs
 * with no toolchain and no emulator install, because the assembler is ours and
 * so is `@demake/dmg`.
 *
 * Every game in `fixtures/projects/` is here, levels and camera included. That is
 * the point of the list: a backend that quietly skipped a feature would pass a
 * shorter one.
 */

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
  mdTarget,
  megaduckTarget,
  RomRunner,
  romTrace,
  TARGETS,
  wscTarget,
  type RomTarget,
} from "./_rom-harness.js";
import { gameSource, projectBytes, projectText } from "./_projects.js";

/** The tape the golden trace was recorded with (see determinism.test.ts). */
const PONG_TAPE = "1:a,90:,90:left,120:right";

/**
 * How long one console's pass may take, where the default twenty seconds is not
 * enough.
 *
 * The Virtual Boy is the only entry, and what makes it slow is its *hardware*
 * rather than anything the runtime does: a 20 MHz processor against a 50.2 Hz
 * frame is four hundred thousand cycles a frame, where a Game Boy has seventy
 * thousand. A demade tick fills the same small fraction of a frame on both, so
 * the rest is a cartridge waiting — and a tape of three hundred frames is five
 * times as many emulated instructions here as anywhere else. Stated rather than
 * raised globally, so a case that becomes slow on another console is still
 * caught.
 */
const TIMEOUT: Record<string, number | undefined> = { vb: 60_000 };

function build(source: string, levels?: Record<string, string>, consoleId = "gb") {
  return compile(source, { profile: getProfile(consoleId), levels });
}

/**
 * How many distinct colours a finished frame shows.
 *
 * One means the screen is blank: an LCD that was never switched on holds a
 * uniform framebuffer, so this distinguishes "drew something" from "drew
 * nothing" without pinning what was drawn.
 */
function shadesShown(frame: Uint8ClampedArray): number {
  const seen = new Set<number>();
  for (let at = 0; at < frame.length; at += 4) {
    seen.add(
      (frame[at] as number) | ((frame[at + 1] as number) << 8) | ((frame[at + 2] as number) << 16),
    );
  }
  return seen.size;
}

describe("gb ROM", async () => {
  it("is a valid 32 KiB cartridge with correct checksums", async () => {
    const { bytes } = await buildGbRom(build(gameSource("pong")), { title: "PONG" });
    expect(bytes.length).toBe(ROM_SIZE);
    let header = 0;
    for (let at = 0x0134; at <= 0x014c; at += 1)
      header = (header - (bytes[at] as number) - 1) & 0xff;
    expect(bytes[HEADER_OFFSETS.headerChecksum]).toBe(header);
    expect(bytes[HEADER_OFFSETS.cartridgeType]).toBe(0x00);
    expect(String.fromCharCode(...bytes.subarray(0x134, 0x138))).toBe("PONG");
  });

  it("reproduces the checked-in golden trace tick for tick", async () => {
    const program = build(gameSource("pong"));
    expect(await romTrace(program, tape(PONG_TAPE))).toBe(
      projectText("pong", "pong.gb.trace").trimEnd(),
    );
  });

  it("refuses a console it has no backend for, rather than shipping a different game", async () => {
    const program = compile(gameSource("pong"), { profile: getProfile("nes") });
    expect(unsupportedFeatures(program).length).toBeGreaterThan(0);
    await expect(buildGbRom(program)).rejects.toThrow(/cannot build/);
  });
});

describe("ROM conformance across the example library", async () => {
  const cases: readonly (readonly [string, string, Record<string, string>?])[] = [
    ["pong", "1:a,90:,90:left,120:right"],
    // Both directions at once, released in the order they were pressed rather
    // than the order that unwinds neatly — and `a` pressed with one of them
    // already down, so the play scene is entered holding a button whose press
    // edge belonged to the title screen. Both are `on hold` snapshots taken and
    // put back, which no other tape here exercises.
    ["breakout", "30:,20:a+right,30:right,20:,60:left,30:left+right,30:right,80:"],
    ["platformer", "20:,15:a,40:right,20:a+right,60:right,45:"],
    ["dodger", "20:,20:a,60:left,60:right,40:"],
    ["shooter", "20:,20:a,40:left,20:a,60:right,40:"],
    [
      "caves",
      // Climbs onto the first ledge, takes the coin there, then runs right into
      // the spikes: tile rules, tile separation, a vanishing object and a scene
      // change, all in one tape.
      "240:,42:right,1:a,18:,26:left,60:,200:right,40:",
      { "cavern.dmtl": projectText("caves", "levels/cavern.dmtl") },
    ],
    [
      "runner",
      "20:,20:a,60:right,30:a+right,60:right,40:",
      {
        "open.dmtl": projectText("runner", "levels/open.dmtl"),
        "lowpipe.dmtl": projectText("runner", "levels/lowpipe.dmtl"),
        "highpipe.dmtl": projectText("runner", "levels/highpipe.dmtl"),
        "pipemid.dmtl": projectText("runner", "levels/pipemid.dmtl"),
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
  // Mega Duck, where the claim is the opposite one: that console differs from the
  // Game Boy only in where its registers live, so a divergence here would mean a
  // *machine description* had leaked into the code the tick runs. And the Super
  // Nintendo, because its accumulator is *sixteen* bits: every routine in its
  // value layer is a different program from the eight-bit one the others share,
  // so agreement there is agreement about the arithmetic rather than about the
  // code.
  for (const target of TARGETS) {
    for (const [file, script, levels] of cases) {
      it(
        `matches the interpreter for ${file} on ${target.console}`,
        async () => {
          const program = build(gameSource(file), levels, target.console);
          const frames = tape(script);
          expect(await romTrace(program, frames, {}, target)).toBe(trace(new Sim(program), frames));
        },
        TIMEOUT[target.console],
      );
    }
  }

  it("plays the same game on every machine in the family, whatever it looks like", async () => {
    const frames = tape(PONG_TAPE);
    // Everything but the header line, which names the console it was built for.
    // The target is passed rather than defaulted: a Mega Duck cartridge carries
    // no header, so nothing in its bytes says which machine to boot it as —
    // which is the whole reason `@demake/dmg` takes that as an argument.
    const body = async (target: RomTarget): Promise<string> =>
      (await romTrace(build(gameSource("pong"), undefined, target.console), frames, {}, target))
        .split("\n")
        .slice(1)
        .join("\n");
    expect(await body(gbcTarget)).toBe(await body(gbTarget));
    expect(await body(megaduckTarget)).toBe(await body(gbTarget));
  });

  /**
   * And the biggest game in the library, on the one console that can hold it.
   *
   * Not in the matrix above, and the reason is the cartridge rather than the
   * code: three levels, a boss and a room behind a pipe compile to around
   * 122 KiB of SM83 and 117 of Z80 against a mapper-less 32 (doc 13 §Banked
   * cartridges). The Mega Drive has 512 KiB and uses 96 of them, so this is the
   * only place the claim can be made at all — and it is worth making, because
   * nothing else in the library has four playfields, two of them sharing a tile
   * bank, or a rule set written against classes rather than named objects.
   *
   * The tape runs the meadow: fall, run, jump the first pit, and keep going into
   * the second one — which is a tile walk, a camera that scrolls on one axis,
   * an object collected, a level restart and a counter that outlives it.
   */
  it("matches the interpreter for the quest fixture on md", async () => {
    const levels = Object.fromEntries(
      ["meadow.dmtl", "vault.dmtl", "hollow.dmtl", "keep.dmtl"].map((name) => [
        name,
        projectText("quest", `levels/${name}`),
      ]),
    );
    const program = build(gameSource("quest"), levels, "md");
    const frames = tape("2:,1:a,85:right,1:a,90:right,60:right,120:right");
    expect(await romTrace(program, frames, {}, mdTarget)).toBe(trace(new Sim(program), frames));
  }, 120_000);

  it("builds a Mega Duck cartridge that a Game Boy could not run", async () => {
    // The guard the test above cannot be: identical traces are also what a map
    // that had quietly become the identity would produce, since the same wrong
    // map would then be used to build the ROM *and* to route its writes. So boot
    // the Duck's cartridge on the wrong machine and require the screen to stay
    // off — this console's `LCDC` is at $FF10, which is a sound register over
    // there, so nothing a Duck cartridge stores ever tells a Game Boy to switch
    // its display on.
    //
    // The *screen* rather than the trace, because a demade game's state is
    // arithmetic on the pad: the tick runs correctly wherever the display writes
    // land, so whether a trace diverges depends on where stray stores happen to
    // fall, and that moves whenever the RAM map does. It said what this test
    // means for exactly as long as pong's happened to hit something load-bearing.
    const program = build(gameSource("pong"), undefined, "megaduck");
    const { bytes } = await buildGbRom(program, { title: "PONG" });
    const onDuck = new Gameboy(bytes, "megaduck");
    const onGameboy = new Gameboy(bytes, "gameboy");
    for (let frame = 0; frame < 120; frame += 1) {
      onDuck.runFrame();
      onGameboy.runFrame();
    }
    expect(shadesShown(onDuck.framebuffer)).toBeGreaterThan(1);
    expect(shadesShown(onGameboy.framebuffer)).toBe(1);
    // And the cartridge carries no header for a Game Boy to read: the title
    // field is this game's own code, not "PONG", and there is no CGB flag.
    expect(String.fromCharCode(...bytes.subarray(0x134, 0x138))).not.toBe("PONG");
    expect(bytes[HEADER_OFFSETS.cgb]).not.toBe(0xc0);
    // It begins with the jump past the interrupt vectors that $0000 must hold.
    expect(bytes[0]).toBe(0xc3);
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

describe("the generator, on every console", async () => {
  /**
   * Two draws a tick, the first of them degenerate.
   *
   * `random(3, 3)` has nothing to choose, so its *value* is fixed on every
   * implementation — and the generator still advances, which only the draw after
   * it can see. That is the whole point of the program: a backend that skipped
   * the advance would agree with the interpreter about `settled` and disagree
   * about `spread` from the first tick, and about everything afterwards.
   *
   * It lives here rather than in `fixtures/games/` because it is not a game: the
   * example library is the shop window (doc 14 §The example library) and this is
   * a regression test with a program attached.
   */
  const SOURCE = [
    "start only",
    "seed 20260726",
    "",
    "scene only",
    "",
    "create number settled in only (x 1, y 1, value 0, visible 0)",
    "create number spread in only (x 1, y 2, value 0, visible 0)",
    "",
    "when always in only then (settled.value, spread.value) as (random(3, 3), random(0, 100))",
    "",
  ].join("\n");

  for (const target of TARGETS) {
    it(`advances on a degenerate draw, like the interpreter, on ${target.console}`, async () => {
      const program = build(SOURCE, undefined, target.console);
      const frames = tape("40:");
      expect(await romTrace(program, frames, {}, target)).toBe(trace(new Sim(program), frames));
    });
  }
});

describe("the colour cartridge", { timeout: COLOUR_TIMEOUT }, async () => {
  const assets = () =>
    new Map(
      ["ball.svg", "paddle.svg", "pong.title.svg", "pong.play.svg"].map((name) => [
        name,
        projectBytes("pong", `art/${name}`),
      ]),
    );

  it("declares itself a Game Boy Color cartridge, and a gb build does not", async () => {
    const color = await buildGbRom(build(gameSource("pong"), undefined, "gbc"), { title: "PONG" });
    const mono = await buildGbRom(build(gameSource("pong")), { title: "PONG" });
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
    const built = await buildGbRom(build(gameSource("pong"), undefined, "gbc"), {
      assets: assets(),
    });
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
    const built = await buildGbRom(build(gameSource("pong"), undefined, "gbc"), {
      assets: assets(),
    });
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
    const built = await buildGbRom(build(gameSource("pong"), undefined, "gbc"), {
      assets: assets(),
    });
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
    ["pong", undefined],
    ["shooter", undefined],
    ["caves", { "cavern.dmtl": projectText("caves", "levels/cavern.dmtl") }],
  ] as const) {
    it(`fits a tick inside a frame for ${file}`, async () => {
      expect(await framesPerTick(build(gameSource(file), levels))).toBeLessThan(1.2);
    });
  }

  // And on the console with the shortest frame in the set. A WonderSwan draws
  // 75.47 times a second where every other machine here draws sixty, so a tick
  // that fits comfortably everywhere else has a fifth less time to do it in —
  // which is why this console is the one that found a decimal renderer walking
  // the powers of ten by subtraction on a processor that can divide.
  it("fits a tick inside a frame for caves on the shortest frame in the set", async () => {
    const levels = { "cavern.dmtl": projectText("caves", "levels/cavern.dmtl") };
    const program = build(gameSource("caves"), levels, "wsc");
    expect(await framesPerTick(program, wscTarget)).toBeLessThan(1.2);
  });
});
