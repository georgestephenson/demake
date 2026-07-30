/**
 * What the Game Boy Advance build is, beyond playing the same game.
 *
 * Trace conformance is in `rom.test.ts`, over the same battery every other
 * console runs — that is where "the Game Boy Advance plays the game the
 * interpreter defines" is settled. Here are the things only this console has,
 * and each is here because getting it wrong produces a cartridge that traces
 * perfectly and looks wrong:
 *
 *   - **Two banks have to arrive, in two places.** Background characters and
 *     object characters are separate memory here, so boot performs two uploads
 *     and a build that addressed one of them wrongly would tick correctly and
 *     draw either no scenery or no sprites.
 *   - **The map is four screen blocks, not a rectangle.** 64×64 cells is four
 *     32×32 blocks a kilobyte apart, so a camera that has crossed column 32 has
 *     painted into the *second* block rather than one halfword further along.
 *     A reader that assumed a rectangle would agree with a renderer that made
 *     the same mistake, which is why this computes the address the hardware's
 *     way.
 *   - **The HUD is a layer, and its whole claim is that it does not move.** A
 *     caption pinned to the camera has to land on the same cell every frame
 *     whatever the camera's sub-cell offset is — the property the other five
 *     backends cannot have, and therefore the one worth a test.
 *   - **The reserved colours.** Three of 256, whatever the art chose, and a
 *     caption is only legible if its ink was picked against the colour zero the
 *     picture shows through.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { gbaComplement, GBA_HEADER_SIZE, GBA_ORIGIN } from "@demake/core";
import { Gba } from "@demake/gba";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import {
  builtinGba,
  GBA_BUILTIN_TILES,
  GBA_TILE_BYTES,
  objectBlockGba,
} from "../src/rom/graphics.js";
import { buildGbaRom } from "../src/codegen/gba.js";
import { ART_COLORS, BANK_TILES, SYSTEM_INK, SYSTEM_PAPER } from "../src/codegen/gba/emit.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

/** Where the emitter puts the two maps, as byte offsets into video RAM. */
const MAP_BASE = 0xc000;
const HUD_BASE = 0xe000;
/** Where object character data starts, inside the same region. */
const OBJ_VRAM = 0x10000;

/** The tile an empty cell draws: a transparent blank, not the space glyph. */
const GBA_BLANK = GBA_BUILTIN_TILES - 1;

function build(file: string, levels?: Record<string, string>) {
  return compile(read(file), { profile: getProfile("gba"), levels });
}

/** Boot a cartridge and run it until the runtime says it has finished booting. */
function boot(bytes: Uint8Array, bootedAt: number): Gba {
  const machine = new Gba(bytes);
  for (let guard = 0; guard < 8_000_000; guard += 1) {
    if (machine.readMemory(bootedAt, 1)[0] !== 0) return machine;
    machine.stepInstruction();
  }
  throw new Error("gba: the runtime never finished initialising");
}

/**
 * The scrolling map's cell at a position, with the hardware's own block layout.
 *
 * Not `(row * 64 + column) * 2`: a 64×64 map is four 32×32 screen blocks a
 * kilobyte apart, so column 32 is `$800` from column 0 and row 32 is `$1000`
 * from row 0.
 */
function cellAt(machine: Gba, column: number, row: number): number {
  const col = column & 63;
  const line = row & 63;
  const block = (col >= 32 ? 1 : 0) + (line >= 32 ? 2 : 0);
  const at = MAP_BASE + block * 0x800 + ((line & 31) * 32 + (col & 31)) * 2;
  return (machine.ppu.vram[at] as number) | ((machine.ppu.vram[at + 1] as number) << 8);
}

/** The HUD layer's cell, which is one 32×32 block and therefore a rectangle. */
function hudAt(machine: Gba, column: number, row: number): number {
  const at = HUD_BASE + ((row & 31) * 32 + (column & 31)) * 2;
  return (machine.ppu.vram[at] as number) | ((machine.ppu.vram[at + 1] as number) << 8);
}

describe("the Game Boy Advance cartridge", async () => {
  const built = await buildGbaRom(build("pong.dmt"), { title: "PONG" });

  it("begins with a branch over its own header", () => {
    // Not a vector and not a magic number: this console executes the first word
    // of the cartridge, so what is there is a branch past the 188 bytes of
    // header that follow it.
    const word =
      ((built.bytes[0] as number) |
        ((built.bytes[1] as number) << 8) |
        ((built.bytes[2] as number) << 16) |
        ((built.bytes[3] as number) << 24)) >>>
      0;
    expect(word >>> 24).toBe(0xea); // b, unconditional
    const offset = ((word & 0xffffff) << 8) >> 8;
    expect(GBA_ORIGIN + 8 + offset * 4).toBe(built.symbols.get("Reset"));
    expect(built.symbols.get("Reset")).toBeGreaterThanOrEqual(GBA_ORIGIN + GBA_HEADER_SIZE);
  });

  it("carries a header the BIOS will accept", () => {
    expect(String.fromCharCode(...built.bytes.subarray(0xa0, 0xa4))).toBe("PONG");
    expect(built.bytes[0xb2]).toBe(0x96);
    expect(built.bytes[0xbd]).toBe(gbaComplement(built.bytes));
  });

  it("ships no Nintendo logo, so the area is exactly zero", () => {
    // The same bargain the Game Boy's boot logo gets: a built ROM direct-boots
    // in an emulator and does not boot on original hardware, and no copyrighted
    // data is checked in.
    expect(built.bytes.subarray(0x04, 0xa0).every((byte) => byte === 0)).toBe(true);
  });

  it("has room the 8-bit consoles do not", () => {
    // Every size assertion in this project is about a game that nearly did not
    // fit. There is no such story here either — this is the second console with
    // none — and the number is worth pinning so the day one appears it is a
    // change rather than a discovery.
    expect(built.stats.bytes).toBeLessThan(256 * 1024);
    expect(built.stats.free).toBeGreaterThan(1024 * 1024);
    expect(BANK_TILES).toBe(768);
  });
});

describe("what boot leaves in the video hardware", async () => {
  const built = await buildGbaRom(build("pong.dmt"));
  const machine = boot(built.bytes, built.layout.booted);

  it("uploads the background bank to character block zero", () => {
    const builtin = builtinGba(SYSTEM_INK, SYSTEM_PAPER);
    expect([...machine.ppu.vram.subarray(0, builtin.length)]).toEqual([...builtin]);
  });

  it("uploads the object bank to object character memory, which is a second place", () => {
    const block = objectBlockGba(SYSTEM_INK);
    expect([...machine.ppu.vram.subarray(OBJ_VRAM, OBJ_VRAM + block.length)]).toEqual([...block]);
  });

  it("points the two layers at the maps the renderer addresses", () => {
    const bg0 = machine.ppu.bgcnt[0] as number;
    const bg1 = machine.ppu.bgcnt[1] as number;
    expect(((bg0 >> 8) & 0x1f) * 0x800).toBe(MAP_BASE);
    expect(((bg1 >> 8) & 0x1f) * 0x800).toBe(HUD_BASE);
    // Both read 256-colour tiles from character block zero.
    expect(bg0 & 0x80).toBe(0x80);
    expect(bg1 & 0x80).toBe(0x80);
    expect((bg0 >> 2) & 3).toBe(0);
    expect((bg1 >> 2) & 3).toBe(0);
    // 64×64 for the picture, which is what leaves a scrolling scene somewhere
    // off screen to paint into; 32×32 for the HUD, which never scrolls.
    expect((bg0 >> 14) & 3).toBe(3);
    expect((bg1 >> 14) & 3).toBe(0);
    // The HUD is in front of the objects and the objects in front of the
    // picture, which is the whole reason it is a layer rather than sprites.
    expect(bg1 & 3).toBeLessThan(bg0 & 3);
  });

  it("comes up in mode 0 with both layers, the objects and one-dimensional mapping", () => {
    const dispcnt = machine.ppu.dispcnt;
    expect(dispcnt & 7).toBe(0);
    expect(dispcnt & 0x80).toBe(0); // no longer forced blank
    expect(dispcnt & 0x100).toBe(0x100);
    expect(dispcnt & 0x200).toBe(0x200);
    expect(dispcnt & 0x1000).toBe(0x1000);
    expect(dispcnt & 0x40).toBe(0x40);
  });

  it("holds the HUD layer still, for ever", () => {
    // The claim this backend rests on. The scroll registers of layer one are
    // written once at boot and never again, which is what makes a caption's cell
    // `floor(pos) − floor(camera)` rather than a pixel that can be off by seven.
    for (let frame = 0; frame < 8; frame += 1) machine.runFrame();
    expect(machine.ppu.bghofs[1]).toBe(0);
    expect(machine.ppu.bgvofs[1]).toBe(0);
  });

  it("keeps the last four colours of both palettes for the runtime's own ink", () => {
    // Paper, then three shades of ink. Four distinct values whatever the art
    // chose, because a caption on a layer over the picture has no one colour
    // behind it to be chosen against.
    for (const base of [0, 256]) {
      const ramp = [0, 1, 2, 3].map((index) => machine.ppu.palette[base + ART_COLORS + index]);
      expect(new Set(ramp).size).toBe(4);
    }
    expect(SYSTEM_PAPER).toBe(ART_COLORS);
  });

  it("draws something, rather than a screen of one colour", () => {
    for (let frame = 0; frame < 3; frame += 1) machine.runFrame();
    // Once, into a local: the getter renders the whole frame, so reading it in
    // the loop condition would draw the picture thirty-eight thousand times.
    const pixels = machine.framebuffer;
    const seen = new Set<string>();
    for (let at = 0; at < pixels.length; at += 4) {
      seen.add(`${pixels[at]},${pixels[at + 1]},${pixels[at + 2]}`);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("the map against the level", async () => {
  const levels = { "cavern.dmtl": read(join("games", "cavern.dmtl")) };
  const program = compile(read(join("games", "caves.dmt")), {
    profile: getProfile("gba"),
    levels,
  });
  const built = await buildGbaRom(program);

  /** Run the scene forward, pressing whatever the caller asks for. */
  function play(down: readonly string[], ticks: number): Gba {
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 4; frame += 1) machine.runFrame();
    machine.setButtons(down as never);
    for (let frame = 0; frame < ticks; frame += 1) machine.runFrame();
    return machine;
  }

  it("settles on a scrolled picture rather than repainting it every frame", () => {
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
    const camera = built.layout.camera as number;
    const pixels = (offset: number): number => {
      const bytes = machine.readMemory(camera + offset, 4);
      const value =
        (bytes[0] as number) |
        ((bytes[1] as number) << 8) |
        ((bytes[2] as number) << 16) |
        ((bytes[3] as number) << 24) |
        0;
      return (value >> 13) & 0x1ff;
    };
    // The source offset, not the amount the picture moves — this hardware
    // scrolls the other way round from a Mega Drive's horizontal register, so
    // the value that goes out is the camera itself rather than its negation.
    //
    // Within a frame rather than exactly, and that is the loop's shape rather
    // than slack: `UploadFrame` runs at the top of the frame and `BuildFrame` at
    // the bottom, so the register always carries what the camera was one frame
    // ago. A game moves at most a few pixels in that time.
    expect(machine.ppu.bghofs[0]).toBeGreaterThan(0);
    expect(Math.abs((machine.ppu.bghofs[0] as number) - pixels(0))).toBeLessThanOrEqual(8);
    expect(Math.abs((machine.ppu.bgvofs[0] as number) - pixels(4))).toBeLessThanOrEqual(8);
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
      const bytes = machine.readMemory(camera + offset, 4);
      return (
        ((bytes[0] as number) |
          ((bytes[1] as number) << 8) |
          ((bytes[2] as number) << 16) |
          ((bytes[3] as number) << 24) |
          0) >>
        16
      );
    };
    const originCol = originOf(0);
    const originRow = originOf(4);

    let checked = 0;
    for (let row = originRow; row < originRow + built.layout.memory.viewH; row += 1) {
      for (let column = originCol; column < originCol + built.layout.memory.viewW; column += 1) {
        if (column >= level.width || row >= level.height) continue;
        const cell = (level.rows[row] ?? "")[column] ?? " ";
        const tile = cellAt(machine, column, row) & 0x3ff;
        // An empty cell draws the transparent blank; a named one draws its
        // legend's pattern.
        if (cell === " ") expect(tile).toBe(GBA_BLANK);
        else expect(tile).toBeLessThan(GBA_BLANK);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("draws the level's patterns from the built-in bank", () => {
    // Nothing in this build has art, so every non-blank cell is a built-in
    // pattern — a cell pointing past the bank would be a tile nobody uploaded.
    const machine = play([], 90);
    let patterns = 0;
    for (let column = 0; column < 64; column += 1) {
      for (let row = 0; row < 64; row += 1) {
        const tile = cellAt(machine, column, row) & 0x3ff;
        if (tile === GBA_BLANK) continue;
        expect(tile).toBeLessThan(GBA_BUILTIN_TILES);
        patterns += 1;
      }
    }
    expect(patterns).toBeGreaterThan(0);
  });
});

describe("the edge painter", () => {
  // Wider and taller than the map, so both wraps are exercised rather than just
  // the arithmetic that would compute them — and wide enough that the camera
  // really does cross into the second and third screen blocks.
  const columns = 100;
  const rows = 80;
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
    "create mover walker in play (x 50, y 40)",
    "",
    "control walker left (xdirection -1) on hold",
    "control walker right (xdirection 1) on hold",
    "control walker up (ydirection -1) on hold",
    "control walker down (ydirection 1) on hold",
    "",
  ].join("\n");

  it("keeps the window and one cell past it painted from the grid, in every block", async () => {
    const program = compile(source, { profile: getProfile("gba"), levels });
    const built = await buildGbaRom(program);
    const { viewW, viewH } = built.layout.memory;
    const camera = built.layout.camera as number;
    const machine = boot(built.bytes, built.layout.booted);

    const originOf = (offset: number): number => {
      const bytes = machine.readMemory(camera + offset, 4);
      return (
        ((bytes[0] as number) |
          ((bytes[1] as number) << 8) |
          ((bytes[2] as number) << 16) |
          ((bytes[3] as number) << 24) |
          0) >>
        16
      );
    };

    /** Every visible cell agrees with the grid, block layout and all. */
    const check = (): number => {
      const originCol = originOf(0);
      const originRow = originOf(4);
      let checked = 0;
      for (let row = originRow; row < originRow + viewH; row += 1) {
        for (let column = originCol; column < originCol + viewW; column += 1) {
          if (column < 0 || row < 0 || column >= columns || row >= rows) continue;
          const want = (grid.split("\n")[row] ?? "")[column] ?? " ";
          const tile = cellAt(machine, column, row) & 0x3ff;
          if (want === " ") expect(tile).toBe(GBA_BLANK);
          else expect(tile).toBeLessThan(GBA_BLANK);
          checked += 1;
        }
      }
      return checked;
    };

    /** Which of the four screen blocks the painter has actually drawn into. */
    const blocksUsed = (): number => {
      let used = 0;
      for (let block = 0; block < 4; block += 1) {
        const base = MAP_BASE + block * 0x800;
        for (let at = base; at < base + 0x800; at += 2) {
          const cell =
            (machine.ppu.vram[at] as number) | ((machine.ppu.vram[at + 1] as number) << 8);
          // A cell the painter never touched still holds the blank the boot
          // filled the map with, so "used" is a cell that is something else.
          if ((cell & 0x3ff) !== GBA_BLANK) {
            used += 1;
            break;
          }
        }
      }
      return used;
    };

    for (let frame = 0; frame < 6; frame += 1) machine.runFrame();
    expect(check()).toBeGreaterThan(100);

    // Right and down far enough to cross column 32 and row 32, which is where a
    // reader that treated the map as a rectangle stops agreeing with the
    // hardware.
    machine.setButtons(["right", "down"]);
    for (let frame = 0; frame < 200; frame += 1) machine.runFrame();
    expect(originOf(0)).toBeGreaterThan(32);
    expect(originOf(4)).toBeGreaterThan(32);
    expect(check()).toBeGreaterThan(100);
    expect(blocksUsed()).toBe(4);

    // And back, which is the step the painter has to make rather than a no-op.
    machine.setButtons(["left", "up"]);
    for (let frame = 0; frame < 120; frame += 1) machine.runFrame();
    expect(check()).toBeGreaterThan(100);
  });
});

describe("the HUD layer", async () => {
  const levels = { "cavern.dmtl": read(join("games", "cavern.dmtl")) };
  const program = compile(read(join("games", "caves.dmt")), {
    profile: getProfile("gba"),
    levels,
  });
  const built = await buildGbaRom(program);

  it("keeps a camera-pinned caption on one cell while the picture scrolls", () => {
    // The reason this console has a HUD *layer*: on every other machine here a
    // scrolling scene has to draw its captions with sprites, because the
    // background moves as one piece. Here the layer stands still and the cell is
    // computed in whole cells on both sides, so it cannot drift by a pixel.
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 6; frame += 1) machine.runFrame();
    machine.setButtons(["right"]);

    const occupied = (): string => {
      const cells: string[] = [];
      for (let row = 0; row < 8; row += 1) {
        for (let column = 0; column < 32; column += 1) {
          if ((hudAt(machine, column, row) & 0x3ff) !== GBA_BLANK) cells.push(`${column},${row}`);
        }
      }
      return cells.join(" ");
    };

    for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
    const first = occupied();
    expect(first.length).toBeGreaterThan(0);
    for (let frame = 0; frame < 40; frame += 1) {
      machine.runFrame();
      // The counter's *digits* may change; which cells the HUD occupies may not.
      expect(occupied()).toBe(first);
    }
  });

  it("clears the layer at a scene change rather than wearing the last scene's", () => {
    // A caption belonging to the title screen has nothing to do with the level,
    // and the layer is not repainted from the grid the way the picture is — so
    // it is blanked outright.
    const machine = boot(built.bytes, built.layout.booted);
    let title = 0;
    for (let column = 0; column < 32; column += 1) {
      for (let row = 0; row < 32; row += 1) {
        if ((hudAt(machine, column, row) & 0x3ff) !== GBA_BLANK) title += 1;
      }
    }
    expect(title).toBeGreaterThan(0);

    machine.setButtons(["a"]);
    for (let frame = 0; frame < 30; frame += 1) machine.runFrame();
    machine.setButtons([]);
    for (let frame = 0; frame < 30; frame += 1) machine.runFrame();
    let occupied = 0;
    for (let column = 0; column < 32; column += 1) {
      for (let row = 0; row < 32; row += 1) {
        if ((hudAt(machine, column, row) & 0x3ff) !== GBA_BLANK) occupied += 1;
      }
    }
    // Fewer cells than the title screen used, and not the same ones: the level's
    // HUD is a counter, not a screen of captions.
    expect(occupied).toBeLessThan(title);
  });
});

describe("the object list", async () => {
  const built = await buildGbaRom(build("pong.dmt"));

  it("parks the entries a frame did not use, because there is no link to cut", () => {
    // A Mega Drive ends its sprite list with a link of zero; this hardware has
    // no link at all, so an entry the frame did not draw has to be *hidden* by
    // its own mode bits or it keeps whatever it held last time.
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 20; frame += 1) machine.runFrame();
    const count = machine.readMemory(built.layout.oamCount, 1)[0] as number;
    expect(count).toBeGreaterThan(0);
    for (let index = count; index < 128; index += 1) {
      const attr0 = machine.ppu.oam[index * 4] as number;
      // Mode 2 is "hidden", and it costs the per-line budget nothing.
      expect((attr0 >> 8) & 3).toBe(2);
    }
  });

  it("draws its objects as 256-colour 8×8 sprites", () => {
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 20; frame += 1) machine.runFrame();
    const count = machine.readMemory(built.layout.oamCount, 1)[0] as number;
    for (let index = 0; index < count; index += 1) {
      const attr0 = machine.ppu.oam[index * 4] as number;
      const attr1 = machine.ppu.oam[index * 4 + 1] as number;
      const attr2 = machine.ppu.oam[index * 4 + 2] as number;
      expect(attr0 & 0x2000).toBe(0x2000); // 256 colours
      expect((attr0 >> 14) & 3).toBe(0); // square
      expect((attr1 >> 14) & 3).toBe(0); // 8×8
      // A 256-colour object's tile number counts 32-byte units, so it is even.
      expect((attr2 & 0x3ff) % 2).toBe(0);
      expect((attr2 & 0x3ff) * 32).toBeLessThan(0x8000);
    }
  });

  it("gives the object bank a budget of its own", () => {
    // Not a share of the background's: this is the first console in the set
    // where a full-screen picture cannot starve the sprites.
    expect(GBA_TILE_BYTES).toBe(64);
    expect(0x8000 / GBA_TILE_BYTES).toBe(512);
  });
});
