/**
 * What the Mega Drive build is, beyond playing the same game.
 *
 * Trace conformance is in `rom.test.ts`, over the same battery every other
 * console runs — that is where "the Mega Drive plays the game the interpreter
 * defines" is settled. Here are the things only this console has, and each is
 * here because getting it wrong produces a cartridge that traces perfectly and
 * looks wrong:
 *
 *   - **The tile bank has to arrive.** Characters are video RAM here, not
 *     cartridge, so boot uploads them. A build whose upload was short, or
 *     addressed the wrong place, would still tick correctly and draw nothing.
 *   - **The plane against the level grid.** A framebuffer comparison needs a
 *     libretro core (doc 10); what is available here is better for finding this
 *     class of bug anyway, because it names the cell. Every visible cell is
 *     checked against what the level says should be there, after the camera has
 *     travelled — which is what catches an edge painter that walks the wrong
 *     column, or a wrap computed at the wrong modulus.
 *   - **The reserved palette.** One sub-palette of four is the font's, and a
 *     caption is only legible if its ink was chosen against the backdrop the
 *     picture's own colour zero shows through.
 *   - **The linked sprite list.** A link of zero is what stops the hardware, so
 *     a frame that drew eleven objects has to cut the chain after the eleventh
 *     — parking one off screen without fixing the link draws the rest of the
 *     table.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MD_ROM_SIZE, mdChecksum } from "@demake/core";
import { Md } from "@demake/md";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { builtinMd, BUILTIN_TILES, MD_TILE_BYTES } from "../src/rom/graphics.js";
import { bindMdArt } from "../src/codegen/md-art.js";
import { buildMdRom, CODE_SIZE } from "../src/codegen/md.js";
import {
  ART_PALETTES,
  packCells,
  SPRITE_PALETTE,
  SYSTEM_INK,
  SYSTEM_PALETTE,
} from "../src/codegen/md/emit.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");
const asset = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));

/** Where the emitter puts the VDP's tables. */
const PLANE_A = 0xc000;
const SAT = 0xf000;

function build(file: string, levels?: Record<string, string>) {
  return compile(read(file), { profile: getProfile("md"), levels });
}

/** Boot a cartridge and run it until the runtime says it has finished booting. */
function boot(bytes: Uint8Array, bootedAt: number): Md {
  const machine = new Md(bytes);
  for (let guard = 0; guard < 8_000_000; guard += 1) {
    if (machine.readMemory(bootedAt, 1)[0] !== 0) return machine;
    machine.stepInstruction();
  }
  throw new Error("md: the runtime never finished initialising");
}

/** The plane-A cell word at a position, with the plane's own wrap applied. */
function cellAt(machine: Md, column: number, row: number): number {
  const at = PLANE_A + ((row % 32) * 64 + (column % 64)) * 2;
  return ((machine.vdp.vram[at] as number) << 8) | (machine.vdp.vram[at + 1] as number);
}

describe("the Mega Drive cartridge", async () => {
  const built = await buildMdRom(build("pong.dmt"), { title: "PONG" });

  it("is a 512 KiB image with a header the boot ROM will accept", () => {
    expect(built.bytes.length).toBe(MD_ROM_SIZE);
    expect(String.fromCharCode(...built.bytes.subarray(0x100, 0x110))).toBe("SEGA MEGA DRIVE ");
    expect(String.fromCharCode(...built.bytes.subarray(0x120, 0x124))).toBe("PONG");
    const stored = ((built.bytes[0x18e] as number) << 8) | (built.bytes[0x18f] as number);
    expect(mdChecksum(built.bytes)).toBe(stored);
  });

  it("points the reset and the vertical interrupt at the code that handles them", () => {
    const long = (at: number): number =>
      ((((built.bytes[at] as number) << 24) |
        ((built.bytes[at + 1] as number) << 16) |
        ((built.bytes[at + 2] as number) << 8) |
        (built.bytes[at + 3] as number)) >>>
        0) as number;
    expect(long(0x04)).toBe(built.symbols.get("Reset"));
    // The one vector that must not point at the reset code: a game enables the
    // frame interrupt, and a handler that restarted the game would do so sixty
    // times a second.
    expect(long(0x78)).toBe(built.symbols.get("Vint"));
    expect(long(0x78)).not.toBe(long(0x04));
  });

  it("has room the other three consoles do not", () => {
    // Every size assertion in this project is about a game that nearly did not
    // fit. There is no such story here, and the number is worth pinning so that
    // the day one appears it is a change rather than a discovery.
    expect(CODE_SIZE).toBe(MD_ROM_SIZE - 0x200);
    expect(built.stats.free).toBeGreaterThan(MD_ROM_SIZE / 2);
  });
});

describe("what boot leaves in the video hardware", async () => {
  const built = await buildMdRom(build("pong.dmt"));
  const machine = boot(built.bytes, built.layout.booted);

  it("uploads the built-in bank to the address the registers point at", () => {
    const builtin = builtinMd(SYSTEM_INK);
    expect([...machine.vdp.vram.subarray(0, builtin.length)]).toEqual([...builtin]);
  });

  it("points the tables where the renderer addresses them", () => {
    expect(((machine.vdp.regs[2] as number) & 0x38) << 10).toBe(PLANE_A);
    expect(((machine.vdp.regs[5] as number) & 0x7f) << 9).toBe(SAT);
    // A 64×32 plane, which is what leaves a scrolling scene somewhere off screen
    // to paint into.
    expect(machine.vdp.regs[16]).toBe(0x01);
    // H40, so the window really is forty cells wide.
    expect((machine.vdp.regs[12] as number) & 0x81).toBe(0x81);
  });

  it("turns the display and the frame interrupt on", () => {
    expect((machine.vdp.regs[1] as number) & 0x60).toBe(0x60);
  });

  it("leaves plane B blank, so the backdrop shows through it", () => {
    // Every cell of it is tile zero, whose pixels are index 0 and therefore
    // transparent. A renderer that found stray pattern data there would draw it
    // behind the whole game.
    const planeB = machine.vdp.vram.subarray(0xe000, 0xf000);
    expect(planeB.every((byte) => byte === 0)).toBe(true);
  });

  it("draws something, rather than a screen of one colour", () => {
    for (let frame = 0; frame < 3; frame += 1) machine.runFrame();
    // Once, into a local: the getter renders the whole frame, so reading it in
    // the loop condition would draw the picture seventeen thousand times.
    const pixels = machine.framebuffer;
    const seen = new Set<string>();
    for (let at = 0; at < pixels.length; at += 4) {
      seen.add(`${pixels[at]},${pixels[at + 1]}`);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("the plane against the level", async () => {
  const levels = { "cavern.dmtl": read(join("games", "cavern.dmtl")) };
  const program = compile(read(join("games", "caves.dmt")), {
    profile: getProfile("md"),
    levels,
  });
  const built = await buildMdRom(program);

  /** Run the scene forward, pressing whatever the caller asks for. */
  function play(down: readonly string[], ticks: number): Md {
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 4; frame += 1) machine.runFrame();
    machine.setButtons(down as never);
    for (let frame = 0; frame < ticks; frame += 1) machine.runFrame();
    return machine;
  }

  it("settles on a scrolled picture rather than repainting it every frame", () => {
    // The renderer only repaints everything when the camera jumps further than
    // it can walk. A HUD counter that scribbled on the map origin would make
    // *every* frame look like a teleport — the game plays correctly and turns
    // the display off and on sixty times a second.
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 4; frame += 1) machine.runFrame();
    machine.setButtons([]);
    let pending = 0;
    for (let frame = 0; frame < 90; frame += 1) {
      machine.runFrame();
      if (machine.readMemory(built.layout.redraw, 1)[0] !== 0) pending += 1;
    }
    expect(pending).toBeLessThan(20);
  });

  it("scrolls by moving the picture, not the window", () => {
    const machine = play(["right"], 90);
    // The horizontal scroll table's first word carries the negated camera; the
    // vertical scroll RAM's first carries it directly.
    const camera = built.layout.camera as number;
    const cell = (offset: number): number => {
      const bytes = machine.readMemory(camera + offset, 2);
      return ((((bytes[0] as number) << 8) | (bytes[1] as number)) << 16) >> 16;
    };
    const hscroll =
      ((machine.vdp.vram[0xb000] as number) << 8) | (machine.vdp.vram[0xb001] as number);
    expect(hscroll).toBe((-(cell(0) * 8) & 0x3ff) as number);
    expect(machine.vdp.vsram[0]).toBe(((cell(4) * 8) & 0xff) as number);
  });

  it("draws every visible cell from the level's own grid", () => {
    // Ninety frames, not four: the scene opens with the player falling, and a
    // camera moving more than four cells in a tick is a teleport rather than a
    // scroll — the renderer asks for a full redraw next frame instead of tearing.
    const machine = play([], 90);
    const scene = program.scenes.find((entry) => entry.level !== undefined);
    const level = scene?.level;
    expect(level).toBeDefined();
    if (!level) return;

    const camera = built.layout.camera as number;
    const originOf = (offset: number): number => {
      const bytes = machine.readMemory(camera + offset, 2);
      return ((bytes[0] as number) << 8) | (bytes[1] as number);
    };
    const originCol = originOf(0);
    const originRow = originOf(4);

    let checked = 0;
    for (let row = originRow; row < originRow + built.layout.memory.viewH; row += 1) {
      for (let column = originCol; column < originCol + built.layout.memory.viewW; column += 1) {
        if (column >= level.width || row >= level.height) continue;
        const cell = (level.rows[row] ?? "")[column] ?? " ";
        const tile = cellAt(machine, column, row) & 0x7ff;
        // An empty cell draws tile zero; a named one draws its legend's pattern.
        if (cell === " ") expect(tile).toBe(0);
        else expect(tile).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("draws the built-in patterns in the font's own sub-palette", () => {
    // Nothing in this build has art, so every non-blank cell is a built-in
    // pattern and every one of them names the reserved palette.
    const machine = play([], 90);
    let patterns = 0;
    for (let column = 0; column < 40; column += 1) {
      for (let row = 0; row < 28; row += 1) {
        const cell = cellAt(machine, column, row);
        if ((cell & 0x7ff) === 0) continue;
        expect(cell & 0x7ff).toBeLessThan(BUILTIN_TILES);
        expect((cell >> 13) & 3).toBe(SYSTEM_PALETTE);
        patterns += 1;
      }
    }
    expect(patterns).toBeGreaterThan(0);
  });
});

describe("the edge painter", () => {
  // Wider and taller than the plane, so both wraps are exercised rather than
  // just the arithmetic that would compute them.
  const columns = 80;
  const rows = 60;
  // A pattern with a long period on both axes, so a strip painted one cell out
  // of place is a mismatch rather than a coincidence.
  const grid = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) =>
      (column + row * 3) % 7 === 0 ? "#" : column % 5 === 0 ? "." : " ",
    ).join(""),
  ).join("\n");
  const levels = { "wide.dmtl": ["tile # wall solid", "tile . dot", "map", grid, ""].join("\n") };
  const source = [
    "start play",
    "",
    "scene play",
    "level wide from wide.dmtl",
    "camera follows walker",
    "",
    "create object mover (width 1 cell, height 1 cell, speed 30)",
    // Mid-level on both axes, so the camera is off its clamp in every direction
    // and a step back is a step the painter has to make rather than a no-op.
    "create mover walker in play (x 40, y 30)",
    "",
    "control walker left (xdirection -1) on hold",
    "control walker right (xdirection 1) on hold",
    "control walker up (ydirection -1) on hold",
    "control walker down (ydirection 1) on hold",
    "",
  ].join("\n");

  it("keeps the window and one cell past it painted from the grid", async () => {
    const program = compile(source, { profile: getProfile("md"), levels });
    const built = await buildMdRom(program);
    const { viewW, viewH } = built.layout.memory;
    const camera = built.layout.camera as number;
    const machine = boot(built.bytes, built.layout.booted);

    const originOf = (offset: number): number => {
      const bytes = machine.readMemory(camera + offset, 2);
      return ((bytes[0] as number) << 8) | (bytes[1] as number);
    };

    // The plane is bigger than the screen here, so unlike the Sega 8-bits there
    // is no masked column to skip: every cell the window covers *and* the sliver
    // past it on each axis is one the hardware really shows during a sub-cell
    // scroll.
    const check = (where: string): void => {
      const originCol = originOf(0);
      const originRow = originOf(4);
      for (let row = originRow; row <= originRow + viewH; row += 1) {
        for (let column = originCol; column <= originCol + viewW; column += 1) {
          if (column >= columns || row >= rows) continue;
          const blank = (grid.split("\n")[row] ?? "")[column] === " ";
          const drawn = (cellAt(machine, column, row) & 0x7ff) !== 0;
          expect(
            drawn,
            `${where}: cell (${column},${row}) with origin ${originCol},${originRow}`,
          ).toBe(!blank);
        }
      }
    };

    const travel = (down: readonly string[], frames: number): void => {
      machine.setButtons(down as never);
      for (let frame = 0; frame < frames; frame += 1) machine.runFrame();
      // A full redraw runs with interrupts masked and spans a frame, so a scene
      // is compared once it has settled rather than part-way through the picture
      // the runtime is still painting.
      machine.setButtons([] as never);
      for (let frame = 0; frame < 40; frame += 1) machine.runFrame();
    };

    travel([], 20);
    check("at rest");
    // Out and back on each axis in turn, then both at once: a diagonal step
    // paints a column and a row in the same tick.
    for (const [out, home] of [
      [["right"], ["left"]],
      [["down"], ["up"]],
      [
        ["right", "down"],
        ["left", "up"],
      ],
    ] as const) {
      travel(out, 40);
      check(`after ${out.join("+")}`);
      travel(home, 40);
      check(`after ${home.join("+")}`);
    }
    // The camera really did leave its clamp, or none of the above moved a cell.
    travel(["right"], 120);
    expect(originOf(0)).toBeGreaterThan(20);
    check("far from the start");
  });
});

describe("objects", async () => {
  const built = await buildMdRom(build("pong.dmt"));

  it("ends the sprite list where the frame stopped filling it", () => {
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
    // Walk the links the way the hardware does, and count what it would draw.
    let index = 0;
    let drawn = 0;
    const seen = new Set<number>();
    for (;;) {
      expect(seen.has(index)).toBe(false);
      seen.add(index);
      drawn += 1;
      const link = (machine.vdp.vram[SAT + index * 8 + 3] as number) & 0x7f;
      // Every entry the list reaches names a tile inside the bank.
      const attribute =
        ((machine.vdp.vram[SAT + index * 8 + 4] as number) << 8) |
        (machine.vdp.vram[SAT + index * 8 + 5] as number);
      expect(attribute & 0x7ff).toBeLessThan(1408);
      if (link === 0) break;
      index = link;
    }
    // Pong in play is a ball and two paddles, and the paddles are *six* cells
    // here rather than the Game Boy's three: `15vw` is fifteen per cent of the
    // playfield, and this playfield is forty cells wide. Which is the relative
    // vocabulary doing its job — the paddle covers the same fraction of the wall
    // on every machine.
    expect(drawn).toBe(13);
  });

  it("puts the art the image engine demade in the bank, not the placeholder block", async () => {
    const art = await buildMdRom(build("pong.dmt"), {
      assets: new Map([
        ["ball.svg", asset("ball.svg")],
        ["paddle.svg", asset("paddle.svg")],
      ]),
    });
    expect(art.stats.artTiles).toBeGreaterThan(0);
    const machine = boot(art.bytes, art.layout.booted);
    const start = BUILTIN_TILES * MD_TILE_BYTES;
    const end = start + art.stats.artTiles * MD_TILE_BYTES;
    expect(machine.vdp.vram.subarray(start, end).some((byte) => byte !== 0)).toBe(true);
    // And an object draws in the palette the object fit was given, not the
    // font's — the two share colour RAM on this console, so the split is the
    // only thing keeping them apart.
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
    const attribute =
      ((machine.vdp.vram[SAT + 4] as number) << 8) | (machine.vdp.vram[SAT + 5] as number);
    expect((attribute >> 13) & 3).toBe(SPRITE_PALETTE);
  });
});

describe("a demade backdrop", { timeout: 180_000 }, async () => {
  // The one place in this file that pays for a real `prep` tournament, because
  // there is no cheaper oracle for it: what reaches the plane is the picture
  // after a pool, an encoding and an unpacker, and every one of those has been
  // wrong on some console.
  const assets = new Map([
    ["pong.title.svg", asset("pong.title.svg")],
    ["ball.svg", asset("ball.svg")],
    ["paddle.svg", asset("paddle.svg")],
  ]);
  const program = build("pong.dmt");
  const built = await buildMdRom(program, { assets });
  const art = await bindMdArt(program, assets);
  const machine = boot(built.bytes, built.layout.booted);
  for (let frame = 0; frame < 4; frame += 1) machine.runFrame();

  it("puts the picture in the plane, palettes and flips and all", () => {
    // Cell for cell against the map the build produced — the *whole* word, not
    // just the tile number. This layout is flip-aware and carries the fit's
    // palette select, so the fitter stores one tile for up to four orientations
    // and says which; dropping either costs the right-hand end of every mirrored
    // letter, or its colours. The encoding between the two is deliberately not
    // checked: what is guaranteed is the bytes that reach the VDP.
    const map = art.options.backdrops?.get("title")?.map;
    expect(map).toBeDefined();
    if (!map) return;
    let flipped = 0;
    let compared = 0;
    for (let row = 0; row < built.layout.memory.viewH; row += 1) {
      for (let column = 0; column < built.layout.memory.viewW; column += 1) {
        const cell = (row * 64 + column) * 2;
        const word = ((map[cell] as number) << 8) | (map[cell + 1] as number);
        const drawn = cellAt(machine, column, row);
        // The caption the title screen writes over the picture is the runtime's,
        // and it draws in the reserved palette — so the cells it covers are the
        // ones skipped, and everything else is the picture's.
        if (((drawn >> 13) & 3) === SYSTEM_PALETTE) continue;
        if (drawn !== word) {
          expect(`(${column},${row}) = ${drawn.toString(16)}`).toBe(
            `(${column},${row}) = ${word.toString(16)}`,
          );
        }
        compared += 1;
        if ((word & 0x1800) !== 0) flipped += 1;
      }
    }
    // Most of the screen, so the skip above is a caption and not a get-out.
    expect(compared).toBeGreaterThan(1000);
    // And the picture really does use the flip bits, or the check proves nothing.
    expect(flipped).toBeGreaterThan(0);
  });

  it("stores that picture packed, because a plane is cartridge", () => {
    // Less pressing here than on a 32 KiB machine, and still worth it: a
    // screenful padded to the plane's width is 3584 bytes, and a demade screen
    // is mostly runs.
    const map = art.options.backdrops?.get("title")?.map as Uint8Array;
    expect(packCells(map).length).toBeLessThan(map.length * 0.8);
  });

  it("uploads all four sub-palettes, and keeps the last of them for the font", () => {
    const palette = art.options.scenePalettes?.get("title");
    expect(palette?.length).toBe(128);
    const words = machine.vdp.cram;
    for (let entry = 0; entry < 64; entry += 1) {
      const want =
        (((palette as Uint8Array)[entry * 2] as number) << 8) |
        ((palette as Uint8Array)[entry * 2 + 1] as number);
      expect(words[entry]).toBe(want);
    }
    // The font's ink is the brightest thing in its palette *away from* the
    // backdrop, which on this console is what shows through a glyph's shade
    // zero. A fixed ramp would be invisible over a picture whose colour zero
    // happened to match it.
    const backdrop = words[0] as number;
    const ink = words[SYSTEM_PALETTE * 16 + SYSTEM_INK] as number;
    const luma = (word: number): number =>
      ((word >> 1) & 7) * 2 + ((word >> 5) & 7) * 5 + ((word >> 9) & 7);
    expect(Math.abs(luma(ink) - luma(backdrop))).toBeGreaterThan(8);
  });

  it("gives the art two sub-palettes and no more", () => {
    // One of the four is the objects' and one is the font's; a picture told it
    // had all four would take colours a caption needs.
    expect(ART_PALETTES).toBe(2);
    const map = art.options.backdrops?.get("title")?.map as Uint8Array;
    const used = new Set<number>();
    for (let cell = 0; cell < map.length; cell += 2) {
      used.add(((map[cell] as number) >> 5) & 3);
    }
    for (const palette of used) expect(palette).toBeLessThan(ART_PALETTES);
  });

  it("gives a scene without a picture the build's own palette, not the last one's", () => {
    // Pong's ending scenes have no backdrop. Uploading nothing there would leave
    // colour RAM holding whichever title screen the player arrived from.
    const ending = boot(built.bytes, built.layout.booted);
    ending.setButtons(["a"]);
    for (let frame = 0; frame < 4; frame += 1) ending.runFrame();
    const own = art.options.palette as Uint8Array;
    for (let entry = 0; entry < 64; entry += 1) {
      expect(ending.vdp.cram[entry]).toBe(
        ((own[entry * 2] as number) << 8) | (own[entry * 2 + 1] as number),
      );
    }
  });
});
