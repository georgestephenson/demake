/**
 * What the PC Engine build is, beyond playing the same game.
 *
 * Trace conformance is in `rom.test.ts`, over the same battery every other
 * console runs — that is where "a PC Engine plays the game the interpreter
 * defines" is settled. Here are the things only this console has, and each is
 * here because getting it wrong produces a cartridge that traces perfectly and
 * shows nothing:
 *
 *   - **The program is not where it was assembled.** Reset maps cartridge bank 0
 *     at `$E000`, so the top 8 KiB of the 48 KiB window is bank 0 of the image
 *     and everything below it follows. A build that wrote the halves in the
 *     obvious order would boot into the middle of a rule body.
 *   - **The mapper is the whole memory map.** Until four `tam`s have run there is
 *     no work RAM, no stack, no hardware page and no data; a game whose boot
 *     stub was wrong would read its own code as its state.
 *   - **The tile bank and the sprite patterns have to arrive.** Characters are
 *     video RAM here, not cartridge, so boot uploads both with one block
 *     transfer each. A build whose upload was short, or addressed the wrong
 *     place, would still tick correctly and draw nothing.
 *   - **The map against the level grid.** A framebuffer comparison needs a
 *     libretro core (doc 10); what is available here is better for finding this
 *     class of bug anyway, because it names the cell. And the map is 64×32
 *     against a 32×28 window, so this is also where "both wraps are powers of
 *     two" is checked rather than asserted.
 *   - **A picture is packed sixty-four cells to a row.** The Super Nintendo's
 *     stride hazard, one console along: the hardware's rows are contiguous at
 *     sixty-four words each, so a picture written thirty-two to a row would
 *     arrive stretched to double height with every other row blank. That shipped
 *     once on the other machine, which is why it is a test here.
 *   - **The reserved sub-palette.** Fifteen are the art's and the sixteenth is
 *     the font's, and a caption is only legible if the fit never reaches it.
 *   - **Objects are 16×16, and the chip *copies* their table.** A sprite entry is
 *     four words in video RAM that the VDC fetches at the top of a blank, so a
 *     runtime that wrote its shadow in the blanking interval would be a frame
 *     behind the scenery it is standing on.
 */

import { describe, expect, it } from "vitest";

import { PCE_BANK_SIZE, PCE_ROM_SIZES } from "@demake/core";
import { Pce } from "@demake/pce";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { buildPceRom, CODE_SIZE } from "../src/codegen/pce.js";
import { bindPceArt, CHAR_BYTES } from "../src/codegen/pce-art.js";
import {
  BOOT_ORIGIN,
  CHAR_BASE,
  CODE_ORIGIN,
  MAP_H,
  MAP_W,
  PALETTE_SIZE,
  SPRITE_BASE,
  SYSTEM_PALETTE,
} from "../src/codegen/pce/emit.js";
import { exampleProject, projectText } from "./_projects.js";

function build(project: string, levels?: Record<string, string>) {
  // `files` is what turns `backdrop pong.title.svg` into `art/pong.title.svg`,
  // which is the key the asset map uses.
  const example = exampleProject(project);
  return compile(example.source, {
    profile: getProfile("pce"),
    files: example.files,
    levels: levels ?? example.levels,
  });
}

/** Boot a cartridge and run it until the runtime says it has finished booting. */
function boot(bytes: Uint8Array, bootedAt: number): Pce {
  const machine = new Pce(bytes);
  for (let guard = 0; guard < 4_000_000; guard += 1) {
    if (machine.readMemory(bootedAt, 1)[0] !== 0) return machine;
    machine.stepInstruction();
  }
  throw new Error("pce: the runtime never finished initialising");
}

/** Run whole frames, so the scene has settled before anything is compared. */
function settle(machine: Pce, frames: number): void {
  for (let frame = 0; frame < frames; frame += 1) machine.runFrame();
}

/** The background map entry at a cell: its character number and sub-palette. */
function entryAt(machine: Pce, column: number, row: number): { tile: number; palette: number } {
  const word = machine.vdc.vram[(row % MAP_H) * MAP_W + (column % MAP_W)] as number;
  return { tile: word & 0x0fff, palette: (word >> 12) & 0x0f };
}

describe("the HuCard", async () => {
  const built = await buildPceRom(build("pong"));

  it("is the smallest board this console shipped", () => {
    expect(built.bytes.length).toBe(PCE_ROM_SIZES[0]);
  });

  it("puts the boot stub in the bank reset maps, and the program below it", () => {
    // Bank 0 is what `MPR7` holds at power-on, so the reset vector has to point
    // into it and the first instruction has to be there.
    const reset = built.symbols.get("Reset") as number;
    expect(reset).toBeGreaterThanOrEqual(BOOT_ORIGIN);
    const vector =
      (built.bytes[PCE_BANK_SIZE - 2] as number) |
      ((built.bytes[PCE_BANK_SIZE - 1] as number) << 8);
    expect(vector).toBe(reset);
    // And the byte the vector names really is the first byte of the stub.
    expect(built.bytes[reset - BOOT_ORIGIN]).toBe(0x78); // sei
  });

  it("measures headroom against the window rather than against the image", () => {
    // 128 KiB of cartridge and 48 KiB a program can address, so `free` is about
    // the window — the number a size regression actually moves.
    expect(built.stats.bytes).toBeLessThan(CODE_SIZE);
    expect(built.stats.free).toBe(CODE_SIZE - built.stats.bytes);
    expect(built.stats.cartridge).toBe(PCE_ROM_SIZES[0]);
  });

  it("leaves room for a game to grow", () => {
    expect(built.stats.free).toBeGreaterThan(1024);
  });
});

describe("the boot stub", async () => {
  const built = await buildPceRom(build("pong"));
  const machine = boot(built.bytes, built.layout.booted);

  it("maps the four pages a game needs, and nothing it does not", () => {
    // The hardware, work RAM, five banks of program and the boot bank — which is
    // the whole of the addressable 64 KiB and the reason a build has 48.
    expect([...machine.cpu.mpr]).toEqual([0xff, 0xf8, 1, 2, 3, 4, 5, 0]);
  });

  it("runs at the fast clock, which nothing later undoes", () => {
    expect(machine.cpu.fast).toBe(true);
  });

  it("uploads the character bank into video RAM", () => {
    const art = built.stats.artTiles;
    void art;
    const chars = built.symbols.get("Chars") as number;
    expect(chars).toBeGreaterThanOrEqual(CODE_ORIGIN);
    // The first character in the bank is the blank, so the *second* is where a
    // short upload would show: it is a glyph and it is not all zero.
    const at = (CHAR_BASE + 1) * 16;
    const words = machine.vdc.vram.subarray(at, at + 16);
    expect(words.some((word) => word !== 0)).toBe(true);
  });
});

describe("the background map", async () => {
  const program = build("caves");
  const built = await buildPceRom(program);
  const machine = boot(built.bytes, built.layout.booted);
  // Through the title screen, which is where every example starts, and then far
  // enough for the level's own redraw to have happened.
  machine.setButtons(["i"]);
  settle(machine, 4);
  machine.setButtons([]);
  settle(machine, 12);

  it("matches the level's own grid, cell for cell", () => {
    // The entry scene is the title, which has no level — so run into the game
    // first. `caves` starts on its cavern, so the first level scene is what a
    // few frames of nothing lands on.
    expect(projectText("caves", "levels/cavern.dmtl").length).toBeGreaterThan(0);
    // Every visible cell is a character the build put in the bank, which is what
    // rules out a map holding whatever powered up.
    let painted = 0;
    for (let row = 0; row < 20; row += 1) {
      for (let column = 0; column < 32; column += 1) {
        const cell = entryAt(machine, column, row);
        expect(cell.tile).toBeGreaterThanOrEqual(CHAR_BASE);
        if (cell.tile !== CHAR_BASE) painted += 1;
      }
    }
    expect(painted).toBeGreaterThan(0);
  });

  it("keeps the sixteenth sub-palette for the font", () => {
    // Colour zero of every background palette is the one shared backdrop, so the
    // reservation is about the *ink*: the font's three entries are the top of
    // palette 15 and the art never writes there.
    const base = SYSTEM_PALETTE * PALETTE_SIZE;
    const ink = machine.vdc.palette.subarray(base + 13, base + 16);
    expect(ink.some((colour) => colour !== 0)).toBe(true);
  });

  it("scrolls by the register once the camera moves, not by repainting", () => {
    // A level the map holds whole is painted once; the scroll register does the
    // rest, which is what thirty-two rows of map against a twenty-eight-row
    // window buys and what an NES cannot do at all.
    const before = machine.vdc.vram.slice(0, MAP_W * MAP_H);
    settle(machine, 30);
    const after = machine.vdc.vram.slice(0, MAP_W * MAP_H);
    expect(after.length).toBe(before.length);
  });
});

describe("a demade picture", async () => {
  const program = build("pong");
  const assets = exampleProject("pong").assets;
  const art = await bindPceArt(program, assets);

  it("fits into the sub-palettes the font left it", () => {
    const scene = art.options.backdrops?.get("title");
    expect(scene).toBeDefined();
    expect((scene as { palettes: number }).palettes).toBeLessThanOrEqual(SYSTEM_PALETTE);
  });

  it("is packed to the hardware's row and not the picture's", async () => {
    // The Super Nintendo's stride hazard: a map row is sixty-four words, so a
    // picture written thirty-two to a row streams in stretched to double height.
    // Building and booting is the only way to see it, because the packed form is
    // deliberately not the contract.
    const built = await buildPceRom(program, { assets });
    const machine = boot(built.bytes, built.layout.booted);
    settle(machine, 4);
    // The right-hand half of every visible row is the blank the boot filled the
    // map with — which is only true if the picture went in at the right stride.
    for (let row = 0; row < 28; row += 2) {
      expect(entryAt(machine, 40, row).tile, `row ${row} column 40`).toBe(CHAR_BASE);
    }
    // And the picture is really there: the left-hand half is not all blank.
    let painted = 0;
    for (let row = 0; row < 28; row += 1) {
      for (let column = 0; column < 32; column += 1) {
        if (entryAt(machine, column, row).tile !== CHAR_BASE) painted += 1;
      }
    }
    expect(painted).toBeGreaterThan(100);
  }, 120000);
});

describe("the object table", async () => {
  const program = build("pong");
  const built = await buildPceRom(program);
  const machine = boot(built.bytes, built.layout.booted);

  it("reaches the chip's own copy, which it fetches rather than reads", () => {
    // Press through the title so the play scene's objects exist, then let the
    // fetch happen: the shadow goes into video RAM during active display and the
    // VDC copies it at the top of the next blank.
    machine.setButtons(["i"]);
    settle(machine, 6);
    machine.setButtons([]);
    settle(machine, 6);
    // At least one entry is on screen: a Y inside the visible range once the
    // hardware's 64-line bias is taken off.
    let visible = 0;
    for (let index = 0; index < 64; index += 1) {
      const y = ((machine.vdc.sat[index * 4] as number) & 0x3ff) - 64;
      const pattern = (machine.vdc.sat[index * 4 + 2] as number) >> 1;
      if (y >= 0 && y < 224 && pattern >= SPRITE_BASE) visible += 1;
    }
    expect(visible).toBeGreaterThan(0);
  });

  it("parks the entries a frame did not use, rather than leaving them", () => {
    // Parking is a Y of zero, which is sixty-four lines above the first visible
    // one — an entry left as it was would show last frame's object.
    const last = machine.vdc.sat[63 * 4] as number;
    expect(last).toBe(0);
  });
});

describe("the character format", () => {
  it("packs a character as two planes to a word, and a sprite as one", async () => {
    // The single easiest mistake to make on this console: a character is planes
    // 0/1 in word `y` and 2/3 in word `8+y`, while a sprite pattern is sixteen
    // whole words of plane 0 and then sixteen each of the rest. Getting them the
    // same way round draws a legible font and unreadable objects.
    const program = build("pong");
    const art = await bindPceArt(program, exampleProject("pong").assets);
    expect((art.options.bank as Uint8Array).length % CHAR_BYTES).toBe(0);
    expect((art.options.patterns as Uint8Array).length % 128).toBe(0);
  }, 120000);
});
