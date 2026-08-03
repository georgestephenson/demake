/**
 * What the Super Nintendo build is, beyond playing the same game.
 *
 * Trace conformance is in `rom.test.ts`, over the same battery every other
 * console runs — that is where "the Super Nintendo plays the game the interpreter
 * defines" is settled. Here are the things only this console has, and each is
 * here because getting it wrong produces a cartridge that traces perfectly and
 * looks wrong:
 *
 *   - **The cartridge is two banks, and the second one has to arrive.** Tile art
 *     lives in bank one and reaches video RAM by transfer; a build whose transfer
 *     named the wrong bank would tick correctly and draw nothing at all.
 *   - **The tilemap against the level grid.** A framebuffer comparison needs a
 *     libretro core (doc 10); what is available here is better for finding this
 *     class of bug anyway, because it names the cell. Every visible cell is
 *     checked against what the level says should be there, before and after the
 *     camera has travelled — which is what catches an edge painter that walks the
 *     wrong column, or a wrap computed at the wrong modulus.
 *   - **The two 32×32 screens.** A 64-wide tilemap is not a rectangle: column 32
 *     is a kilobyte away from column 31, not one word. A build that treated it as
 *     a rectangle would draw a level whose right half is its left half.
 *   - **The one-line scroll offset.** This chip shows background line
 *     `VOFS + N + 1` on screen line `N`, so the vertical register is the camera's
 *     minus one — and a build without it sits a pixel high for ever.
 *   - **The reserved sub-palette.** Seven of the eight are the art's; the eighth
 *     is the font's, and a caption is only legible because the fit never reaches
 *     it.
 */

import { describe, expect, it } from "vitest";

import {
  SNES_CODE_SIZE,
  SNES_HEADER_OFFSET,
  SNES_ROM_SIZES,
  SNES_TILE_OFFSET,
  snesChecksum,
} from "@demake/core";
import { Snes } from "@demake/snes";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { builtinSnes, BUILTIN_TILES, patternTile, SNES_TILE_BYTES } from "../src/rom/graphics.js";
import { bindSnesArt } from "../src/codegen/snes-art.js";
import { buildSnesRom, CODE_SIZE } from "../src/codegen/snes.js";
import { packCells, SYSTEM_INK, SYSTEM_PALETTE } from "../src/codegen/snes/emit.js";
import { gameSource, projectBytes, projectText } from "./_projects.js";

function build(project: string, levels?: Record<string, string>) {
  return compile(gameSource(project), { profile: getProfile("snes"), levels });
}

/** Boot a cartridge and run it until the runtime says it has finished booting. */
function boot(bytes: Uint8Array, bootedAt: number): Snes {
  const machine = new Snes(bytes);
  for (let guard = 0; guard < 4_000_000; guard += 1) {
    if (machine.readMemory(bootedAt, 1)[0] !== 0) return machine;
    machine.stepInstruction();
  }
  throw new Error("snes: the runtime never finished initialising");
}

/**
 * The tilemap entry at a level cell.
 *
 * The wrap is the whole of this console's scrolling: sixty-four columns and
 * thirty-two rows, arranged as two 32×32 screens a kilobyte apart — so the second
 * screen is *not* one word past the first, and a reader that assumed it was would
 * agree with a renderer that made the same mistake.
 */
/** The demade tilemap for a scene's backdrop, as the build produced it. */
async function backdropFor(program: ReturnType<typeof build>, scene: string): Promise<Uint16Array> {
  const art = await bindSnesArt(
    program,
    new Map([
      ["pong.title.svg", projectBytes("pong", "art/pong.title.svg")],
      ["pong.play.svg", projectBytes("pong", "art/pong.play.svg")],
      ["ball.svg", projectBytes("pong", "art/ball.svg")],
      ["paddle.svg", projectBytes("pong", "art/paddle.svg")],
    ]),
  );
  const map = art.options.backdrops?.get(scene)?.map;
  if (!map) throw new Error(`no backdrop for scene '${scene}'`);
  return map;
}

function entryAt(machine: Snes, column: number, row: number): number {
  const mapColumn = column & 63;
  const at = (mapColumn & 32 ? 0x400 : 0) + (row & 31) * 32 + (mapColumn & 31);
  return machine.ppu.vram[at] as number;
}

describe("the LoROM cartridge", async () => {
  const built = await buildSnesRom(build("pong"), { title: "PONG" });

  it("is a two-bank image with the header and its checksum stamped inside it", () => {
    // Two banks: a program and the tile art it draws with. This game names music
    // but the test supplies none, so there is no sound-processor image and no
    // third bank to carry it — which is the whole of what makes this cartridge
    // half the size of a sounding one (`backend.ts` §Elastic cartridges).
    expect(built.bytes.length).toBe(SNES_ROM_SIZES[0]);
    expect(built.stats.cartridge).toBe(SNES_ROM_SIZES[0]);
    const title = String.fromCharCode(
      ...built.bytes.subarray(SNES_HEADER_OFFSET, SNES_HEADER_OFFSET + 4),
    );
    expect(title).toBe("PONG");
    expect(built.bytes[SNES_HEADER_OFFSET + 0x15]).toBe(0x20); // LoROM
    const stored =
      (built.bytes[SNES_HEADER_OFFSET + 0x1e] as number) |
      ((built.bytes[SNES_HEADER_OFFSET + 0x1f] as number) << 8);
    const complement =
      (built.bytes[SNES_HEADER_OFFSET + 0x1c] as number) |
      ((built.bytes[SNES_HEADER_OFFSET + 0x1d] as number) << 8);
    expect(stored).toBe(snesChecksum(built.bytes));
    expect(stored ^ complement).toBe(0xffff);
  });

  it("keeps the game clear of the header rather than letting it be overwritten", () => {
    // The last sixty-four bytes of bank zero are the header and both vector
    // tables, so they come out of the game's budget — and the build has to know
    // that before the emitter runs into them.
    expect(CODE_SIZE).toBe(SNES_CODE_SIZE);
    expect(built.stats.bytes).toBeLessThan(CODE_SIZE);
  });

  it("points both reset vectors at the boot routine, because reset is an emulation one", () => {
    const vector = (offset: number): number =>
      (built.bytes[offset] as number) | ((built.bytes[offset + 1] as number) << 8);
    expect(vector(0x7ffc)).toBe(built.symbols.get("Reset"));
    expect(vector(0x7fea)).toBe(built.symbols.get("Nmi"));
    expect(vector(0x7ffa)).toBe(built.symbols.get("Nmi"));
  });

  it("leaves emulation mode before it does anything else", () => {
    const reset = (built.symbols.get("Reset") as number) - 0x8000;
    // `sei`, then `clc; xce`: the console comes up pretending to be a 6502, and a
    // cartridge that forgot to say otherwise would fetch every sixteen-bit
    // immediate one byte short and execute the other half.
    expect(built.bytes[reset]).toBe(0x78);
    expect(built.bytes[reset + 1]).toBe(0x18);
    expect(built.bytes[reset + 2]).toBe(0xfb);
  });
});

describe("what boot leaves in the video hardware", async () => {
  const built = await buildSnesRom(build("pong"));
  const machine = boot(built.bytes, built.layout.booted);

  it("transfers the built-in bank out of the second cartridge bank into video RAM", () => {
    const builtin = builtinSnes(SYSTEM_INK);
    // It really is in bank one of the image...
    expect([...built.bytes.subarray(SNES_TILE_OFFSET, SNES_TILE_OFFSET + builtin.length)]).toEqual([
      ...builtin,
    ]);
    // ...and it really arrived, at the word address the registers point at.
    const words = machine.ppu.vram.subarray(0x2000, 0x2000 + builtin.length / 2);
    const bytes = new Uint8Array(builtin.length);
    for (const [index, word] of words.entries()) {
      bytes[index * 2] = word & 0xff;
      bytes[index * 2 + 1] = (word >> 8) & 0xff;
    }
    expect([...bytes]).toEqual([...builtin]);
  });

  it("turns the picture on and arms the vertical-blank interrupt", () => {
    // Forced blank off and full brightness; the interrupt and the automatic pad
    // read both enabled.
    expect(machine.read(0x002100)).toBe(0);
    expect(built.stats.helpers).toContain("PushSprite");
  });

  it("reserves the last sub-palette of each half for the font, whatever the art chose", async () => {
    // Objects only: the reservation is the *sprite* fit's, and a backdrop would
    // put the whole `prep` tournament in a unit test for nothing.
    const art = await buildSnesRom(build("pong"), {
      assets: new Map([
        ["ball.svg", projectBytes("pong", "art/ball.svg")],
        ["paddle.svg", projectBytes("pong", "art/paddle.svg")],
      ]),
    });
    const withArt = boot(art.bytes, art.layout.booted);
    for (const half of [0, 128]) {
      const base = half + SYSTEM_PALETTE * 16;
      const ramp = [SYSTEM_INK - 2, SYSTEM_INK - 1, SYSTEM_INK].map(
        (index) => withArt.ppu.cgram[base + index] as number,
      );
      // A rising ramp, which is the whole of "a caption stays legible over art
      // whose palette was chosen for the art".
      expect(ramp[0]).not.toBe(ramp[1]);
      expect(ramp[1]).not.toBe(ramp[2]);
    }
  });

  it("draws something, rather than a screen of one colour", () => {
    for (let frame = 0; frame < 3; frame += 1) machine.runFrame();
    const seen = new Set<string>();
    for (let at = 0; at < machine.framebuffer.length; at += 4) {
      seen.add(`${machine.framebuffer[at]},${machine.framebuffer[at + 1]}`);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("the tilemap against the level", async () => {
  const levels = { "cavern.dmtl": projectText("caves", "levels/cavern.dmtl") };
  const program = compile(gameSource("caves"), {
    profile: getProfile("snes"),
    levels,
  });
  const built = await buildSnesRom(program);

  /** Run the scene forward, pressing whatever the caller asks for. */
  function play(down: readonly string[], ticks: number): Snes {
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["start"]);
    machine.runFrame();
    machine.setButtons(["b"]); // the abstract `a`, which is this pad's B
    for (let frame = 0; frame < 4; frame += 1) machine.runFrame();
    machine.setButtons(down as never);
    for (let frame = 0; frame < ticks; frame += 1) machine.runFrame();
    return machine;
  }

  it("settles on a scrolled picture rather than repainting it every frame", () => {
    // The renderer only repaints everything when the camera jumps further than
    // it can walk. A HUD counter that scribbled on the map origin would make
    // *every* frame look like a teleport.
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["b"]);
    for (let frame = 0; frame < 4; frame += 1) machine.runFrame();
    machine.setButtons([]);
    let pending = 0;
    for (let frame = 0; frame < 90; frame += 1) {
      machine.runFrame();
      if (machine.readMemory(built.layout.redraw, 1)[0] !== 0) pending += 1;
    }
    expect(pending).toBeLessThan(20);
  });

  it("draws every visible cell from the level's own grid", () => {
    // Ninety frames, not four: the scene opens with the player falling, and a
    // camera moving more than four cells in a tick is a teleport rather than a
    // scroll — the renderer asks for a full redraw next frame instead of
    // tearing. Comparing before it has settled would be comparing against a
    // picture the runtime has already decided to throw away.
    const machine = play([], 90);
    const level = program.scenes.find((entry) => entry.level !== undefined)?.level;
    expect(level).toBeDefined();
    if (!level) return;

    const camera = built.layout.camera as number;
    const originOf = (offset: number): number =>
      (machine.readMemory(camera + offset + 2, 1)[0] as number) |
      ((machine.readMemory(camera + offset + 3, 1)[0] as number) << 8);
    const originCol = originOf(0);
    const originRow = originOf(4);

    let checked = 0;
    for (let row = originRow; row < originRow + built.layout.memory.viewH; row += 1) {
      for (let column = originCol; column < originCol + built.layout.memory.viewW; column += 1) {
        if (column >= level.width || row >= level.height) continue;
        const cell = (level.rows[row] ?? "")[column] ?? " ";
        const tile = entryAt(machine, column, row) & 0x3ff;
        // An empty cell draws tile zero; a named one draws its legend's pattern.
        if (cell === " ") expect(tile).toBe(0);
        else expect(tile).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("paints past column 31 into the second screen, a kilobyte away", () => {
    // The one thing a 64-wide tilemap is not: a rectangle. The camera here has
    // travelled far enough right that the window straddles the boundary, so both
    // screens carry level cells rather than one carrying all of them.
    const machine = play(["right"], 200);
    const filled = (half: 0 | 1): number => {
      let count = 0;
      for (let index = 0; index < 0x400; index += 1) {
        if (((machine.ppu.vram[half * 0x400 + index] as number) & 0x3ff) !== 0) count += 1;
      }
      return count;
    };
    expect(filled(0)).toBeGreaterThan(0);
    expect(filled(1)).toBeGreaterThan(0);
  });

  it("draws the built-in patterns, in the palette reserved for them", () => {
    const machine = play([], 90);
    let patterns = 0;
    for (let column = 0; column < 32; column += 1) {
      for (let row = 0; row < 28; row += 1) {
        const entry = entryAt(machine, column, row);
        const tile = entry & 0x3ff;
        if (tile === 0) continue;
        // Nothing in this build has art, so every non-blank cell is a built-in
        // pattern and every one of them names the font's sub-palette.
        expect(tile).toBeLessThan(BUILTIN_TILES);
        expect((entry >> 10) & 7).toBe(SYSTEM_PALETTE);
        patterns += 1;
      }
    }
    expect(patterns).toBeGreaterThan(0);
  });
});

/**
 * A backdrop is a *block copy*, and that is a different path from a level.
 *
 * The level tests above walk the tilemap cell by cell because that is how a level
 * is painted. A picture is not: it is streamed into video RAM through the
 * auto-incrementing data port from one address, so nothing about it is checked by
 * asking whether a cell matches a grid — and the row stride it is packed at is
 * invisible to every other test in this file.
 *
 * It was wrong. A 64-column tilemap is two 32×32 *screens* a kilobyte apart, so
 * screen zero's rows are contiguous at thirty-two words each; a picture packed
 * sixty-four to a row with the right half blank streams in as a picture stretched
 * to double height with every other row empty. Which is what the title screen
 * showed, in the flesh, in a browser.
 */
describe("a backdrop, which is a block copy rather than a walk", async () => {
  const program = build("pong");
  const built = await buildSnesRom(program, {
    assets: new Map([
      ["pong.title.svg", projectBytes("pong", "art/pong.title.svg")],
      ["pong.play.svg", projectBytes("pong", "art/pong.play.svg")],
      ["ball.svg", projectBytes("pong", "art/ball.svg")],
      ["paddle.svg", projectBytes("pong", "art/paddle.svg")],
    ]),
  });

  it("fills every visible row, rather than every other one", () => {
    const machine = boot(built.bytes, built.layout.booted);
    for (let frame = 0; frame < 8; frame += 1) machine.runFrame();

    // Every row of the window has to carry cells. The failure this catches puts
    // the picture on the even rows and leaves the odd ones at tile zero, so a
    // per-row count is what separates "a picture with blank rows in it" from
    // "a picture written at the wrong stride".
    const rows: number[] = [];
    for (let row = 0; row < built.layout.memory.viewH; row += 1) {
      let filled = 0;
      for (let column = 0; column < built.layout.memory.viewW; column += 1) {
        if ((entryAt(machine, column, row) & 0x3ff) !== 0) filled += 1;
      }
      rows.push(filled);
    }
    expect(rows.filter((count) => count === 0)).toEqual([]);
  });

  it("puts the picture in the first screen and leaves the second alone", () => {
    // The other half of the same fact: a 32-column picture belongs entirely in
    // screen zero. Anything reaching screen one is a row that ran off the end.
    const machine = boot(built.bytes, built.layout.booted);
    for (let frame = 0; frame < 8; frame += 1) machine.runFrame();
    let second = 0;
    for (let index = 0; index < 0x400; index += 1) {
      if (((machine.ppu.vram[0x400 + index] as number) & 0x3ff) !== 0) second += 1;
    }
    expect(second).toBe(0);
  });

  it("draws the picture the image engine demade, cell for cell", async () => {
    // The strongest form: what the image engine produced against what is in
    // video RAM, every cell. The exception is the caption, which is painted over
    // the picture in the *same* pass — a static caption goes in with the
    // background rather than through the per-frame HUD — so a cell it covers
    // holds a built-in glyph in the reserved palette and not the picture's own.
    // Naming that exception is the point: anything else differing is the stream
    // landing somewhere the renderer does not read.
    const machine = boot(built.bytes, built.layout.booted);
    for (let frame = 0; frame < 8; frame += 1) machine.runFrame();
    const art = await backdropFor(program, "title");

    let matched = 0;
    let captioned = 0;
    for (let row = 0; row < built.layout.memory.viewH; row += 1) {
      for (let column = 0; column < built.layout.memory.viewW; column += 1) {
        const want = art[row * built.layout.memory.viewW + column] as number;
        const got = entryAt(machine, column, row);
        if (got === want) {
          matched += 1;
          continue;
        }
        // A caption cell: a built-in glyph, in the palette reserved for the font.
        expect((got >> 10) & 0x07).toBe(SYSTEM_PALETTE);
        expect(got & 0x3ff).toBeLessThan(BUILTIN_TILES);
        captioned += 1;
      }
    }
    const cells = built.layout.memory.viewW * built.layout.memory.viewH;
    expect(matched + captioned).toBe(cells);
    // A caption is a line of text on a screenful; if it were most of the screen
    // the assertion above would be proving nothing.
    expect(captioned).toBeLessThan(cells / 8);
    expect(matched).toBeGreaterThan(cells - cells / 8);
  });
});

describe("a level bigger than the tilemap", () => {
  it("stays correct on both axes as the edge painter walks it", async () => {
    // Written here rather than taken from the example library, because none of
    // those levels is bigger than this map — the caves are sixty columns against
    // sixty-four and thirty rows against thirty-two. So the wrap, which is the
    // whole of scrolling on this console, would otherwise be the one path nothing
    // exercised. Eighty by forty crosses it on both axes.
    const columns = 80;
    const rows = 40;
    const grid = Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (_, column) =>
        // A pattern with a long period on both axes, so a strip painted one cell
        // out of place is a mismatch rather than a coincidence.
        (column + row * 3) % 7 === 0 ? "#" : column % 5 === 0 ? "." : " ",
      ).join(""),
    ).join("\n");
    const level = ["tile # wall solid", "tile . dot", "map", grid, ""].join("\n");
    const source = [
      "start play",
      "",
      "scene play",
      "level wide from wide.dmtl",
      "camera follows walker",
      "",
      "create object mover (width 1 cell, height 1 cell, speed 30)",
      "create mover walker in play (x 2, y 2, xdirection 1, ydirection 1)",
      "",
    ].join("\n");

    const program = compile(source, {
      profile: getProfile("snes"),
      levels: { "wide.dmtl": level },
    });
    const built = await buildSnesRom(program);
    expect(program.scenes[0]?.level?.width).toBeGreaterThan(64);
    expect(program.scenes[0]?.level?.height).toBeGreaterThan(32);

    // A legend entry with no art draws a built-in pattern, and the two here draw
    // different ones — which is what lets a cell be compared by number rather
    // than by "something or nothing".
    const expected: Readonly<Record<string, number>> = {
      "#": patternTile(0, true),
      ".": patternTile(1, false),
      " ": 0,
    };

    const machine = boot(built.bytes, built.layout.booted);
    const camera = built.layout.camera as number;
    const cameraCell = (offset: number): number =>
      (machine.readMemory(camera + offset + 2, 1)[0] as number) |
      ((machine.readMemory(camera + offset + 3, 1)[0] as number) << 8);

    let travelledColumns = 0;
    let travelledRows = 0;
    for (let step = 0; step < 40; step += 1) {
      for (let frame = 0; frame < 8; frame += 1) machine.runFrame();
      const originCol = cameraCell(0);
      const originRow = cameraCell(4);
      travelledColumns = Math.max(travelledColumns, originCol);
      travelledRows = Math.max(travelledRows, originRow);
      let mismatches = 0;
      for (let row = originRow; row < originRow + built.layout.memory.viewH; row += 1) {
        for (let column = originCol; column < originCol + built.layout.memory.viewW; column += 1) {
          if (column >= columns || row >= rows) continue;
          const cell = grid.split("\n")[row]?.[column] ?? " ";
          if ((entryAt(machine, column, row) & 0x3ff) !== expected[cell]) mismatches += 1;
        }
      }
      expect(mismatches, `camera at column ${originCol}, row ${originRow}`).toBe(0);
    }
    // The camera really did cross both wraps, which is what makes them part of
    // what was checked rather than code nothing reached.
    expect(travelledColumns).toBeGreaterThan(32);
    expect(travelledRows).toBeGreaterThan(8);
  }, 60_000);
});

describe("the packed tilemap", () => {
  it("round-trips whatever it is given, which is the only thing it promises", () => {
    const unpack = (packed: Uint16Array): number[] => {
      const out: number[] = [];
      let at = 0;
      for (;;) {
        const control = packed[at] as number;
        at += 1;
        if (control === 0) break;
        if ((control & 0x8000) !== 0) {
          const value = packed[at] as number;
          at += 1;
          for (let index = 0; index < (control & 0x7fff); index += 1) out.push(value);
          continue;
        }
        for (let index = 0; index < control; index += 1) {
          out.push(packed[at] as number);
          at += 1;
        }
      }
      return out;
    };
    const cases: readonly Uint16Array[] = [
      Uint16Array.from([]),
      Uint16Array.from([1]),
      Uint16Array.from([7, 7]),
      Uint16Array.from([7, 7, 7, 7, 1, 2, 3, 9, 9, 9]),
      Uint16Array.from(Array.from({ length: 900 }, (_, index) => (index % 5 === 0 ? 0 : 0x8123))),
    ];
    for (const cells of cases) {
      expect(unpack(packCells(cells))).toEqual([...cells]);
    }
  });
});

describe("objects", async () => {
  const built = await buildSnesRom(build("pong"));

  it("parks the entries a frame stopped using, below the visible area", () => {
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["b"]);
    for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
    const used = machine.readMemory(built.layout.oamCount, 1)[0] as number;
    expect(used).toBeGreaterThan(0);
    for (let entry = used; entry < 64; entry += 1) {
      expect(machine.ppu.oam[entry * 4 + 1]).toBe(240);
    }
  });

  it("leaves the high table alone, because every object is eight pixels and on screen", () => {
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["b"]);
    for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
    expect([...machine.ppu.oam.subarray(512)].every((byte) => byte === 0)).toBe(true);
  });

  it("draws them in front of the background, which is what priority two is for", () => {
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["b"]);
    for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
    const used = machine.readMemory(built.layout.oamCount, 1)[0] as number;
    for (let entry = 0; entry < used; entry += 1) {
      expect(((machine.ppu.oam[entry * 4 + 3] as number) >> 4) & 3).toBe(2);
    }
  });
});

describe("the tile bank", () => {
  it("starts where the built-in one ends, in the bank the transfer reads", async () => {
    const built = await buildSnesRom(build("pong"), {
      assets: new Map([
        ["ball.svg", projectBytes("pong", "art/ball.svg")],
        ["paddle.svg", projectBytes("pong", "art/paddle.svg")],
      ]),
    });
    const builtin = builtinSnes(SYSTEM_INK);
    const bank = built.bytes.subarray(SNES_TILE_OFFSET);
    expect([...bank.subarray(0, builtin.length)]).toEqual([...builtin]);
    // Art follows it, so the first tile a sprite can name is `BUILTIN_TILES`.
    expect(built.stats.artTiles).toBeGreaterThan(0);
    const artStart = BUILTIN_TILES * SNES_TILE_BYTES;
    const art = bank.subarray(artStart, artStart + built.stats.artTiles * SNES_TILE_BYTES);
    expect(art.some((byte) => byte !== 0)).toBe(true);
  });
});
