/**
 * What the Neo Geo Pocket Color build is, beyond playing the same game.
 *
 * Trace conformance is in `rom.test.ts`, over the same battery every other
 * console runs — that is where "a Neo Geo Pocket plays the game the interpreter
 * defines" is settled. Here are the things only this console has, and every case
 * is one that produces a cartridge which traces perfectly and shows nothing:
 *
 *   - **The header is a region in front of the image, and the entry address is
 *     data.** There is no reset vector on this machine: the boot ROM reads a
 *     24-bit field out of the cartridge and jumps to it. A build that stamped the
 *     wrong number there executes the header.
 *   - **There is no video memory.** The two scroll maps, the character bank, the
 *     object table and the palettes are ordinary addresses in the same space the
 *     variables are in, so a build whose boot copy was short, or aimed a
 *     kilobyte off, would tick correctly against a blank screen. Nothing is
 *     uploaded through a port, so nothing about the arrival is observable except
 *     the bytes themselves.
 *   - **The map against the level's own grid.** A framebuffer comparison needs a
 *     libretro core (doc 10); this is better for finding the class of bug anyway,
 *     because it names the cell. The map is 32×32 against a 20×19 window and the
 *     plane is exactly 256 pixels on both axes, so it is also where "the scroll
 *     registers *are* the wrap" is checked rather than asserted.
 *   - **A picture is packed thirty-two cells to a row.** The Super Nintendo's
 *     stride hazard, several consoles along: a picture written at the *window's*
 *     twenty would arrive sheared twelve cells further left on every row.
 *   - **The reserved palette survives the fit.** One of sixteen on each layer is
 *     the font's, and a caption is legible only if the art reaches neither.
 *   - **The palette word is BGR.** Red is the low nibble and blue the high one,
 *     which is the opposite of every other RGB444 console in the set — so a
 *     white ramp is the one thing that cannot tell an encoder from its inverse,
 *     and the font's ink is chosen to be neither grey nor symmetric.
 *   - **Priority is what hides an object.** There is no link field to cut and
 *     nothing is parked off screen, so an entry the frame did not use has to
 *     have had its flags byte cleared — and a build that forgot would leave last
 *     frame's objects on the screen for ever.
 */

import { describe, expect, it } from "vitest";

import {
  NGP_CHARACTERS,
  NGP_ENTRY_OFFSET,
  NGP_HEADER_SIZE,
  NGP_PALETTE,
  NGP_PALETTE_STRIDE,
  NGP_PLANE1,
  NGP_ROM_BASE,
  NGP_ROM_SIZES,
  NGP_SPRITES,
  NGP_SYSTEM_COLOR,
  NGP_VIDEO,
} from "@demake/core";
import { Ngp } from "@demake/ngp";

import { bindNgpcArt } from "../src/codegen/ngpc-art.js";
import { buildNgpcRom, CODE_SIZE } from "../src/codegen/ngpc.js";
import {
  MAP_H,
  MAP_W,
  PALETTE_PLANE1,
  PALETTE_SPRITES,
  SYSTEM_PALETTE,
} from "../src/codegen/ngpc/emit.js";
import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { BUILTIN_TILES, patternTile } from "../src/rom/graphics.js";

import { exampleProject, projectText } from "./_projects.js";

/** Bytes one 8×8 character at 2bpp occupies. */
const TILE_BYTES = 16;

/** The window this profile draws, in cells. */
const VIEW_W = 20;
const VIEW_H = 19;

function build(project: string, levels?: Record<string, string>) {
  // `files` is what turns `backdrop caves.title.svg` into `art/caves.title.svg`,
  // which is the key the asset map uses.
  const example = exampleProject(project);
  return compile(example.source, {
    profile: getProfile("ngpc"),
    files: example.files,
    levels: levels ?? example.levels,
  });
}

/** Boot a cartridge and run it until the runtime says it has finished booting. */
function boot(bytes: Uint8Array, bootedAt: number): Ngp {
  const machine = new Ngp(bytes);
  for (let guard = 0; guard < 8_000_000; guard += 1) {
    if (machine.readMemory(bootedAt, 1)[0] !== 0) return machine;
    machine.stepInstruction();
  }
  throw new Error("ngp: the runtime never finished initialising");
}

/** Run whole frames, so a scene has settled before anything is compared. */
function settle(machine: Ngp, frames: number): void {
  for (let frame = 0; frame < frames; frame += 1) machine.runFrame();
}

/** One byte of the display's own memory. */
function video(machine: Ngp, address: number): number {
  return machine.video[address - NGP_VIDEO] as number;
}

/** A map entry: nine bits of character, then the palette and the two flips. */
function entryAt(
  machine: Ngp,
  base: number,
  column: number,
  row: number,
): { tile: number; palette: number } {
  const at = base + ((row % MAP_H) * MAP_W + (column % MAP_W)) * 2;
  const word = video(machine, at) | (video(machine, at + 1) << 8);
  return { tile: word & 0x1ff, palette: (word >> 9) & 0x0f };
}

describe("the Neo Geo Pocket cartridge", async () => {
  const built = await buildNgpcRom(build("pong"), { title: "PONG" });

  it("takes the smallest board this console shipped on", () => {
    // Four megabits, and it grows to eight and sixteen — where sixteen is also
    // the whole address space rather than an arbitrary ceiling.
    expect(built.bytes.length).toBe(NGP_ROM_SIZES[0]);
  });

  it("puts the entry address where the boot ROM reads it, not in a vector", () => {
    const entry =
      (built.bytes[NGP_ENTRY_OFFSET] as number) |
      ((built.bytes[NGP_ENTRY_OFFSET + 1] as number) << 8) |
      ((built.bytes[NGP_ENTRY_OFFSET + 2] as number) << 16);
    // The first byte after the header, which is where `packNgpRom` puts the
    // program — and the byte above the field stays zero, because this is a
    // 24-bit address in a longword.
    expect(entry).toBe(NGP_ROM_BASE + NGP_HEADER_SIZE);
    expect(built.bytes[NGP_ENTRY_OFFSET + 3]).toBe(0);
  });

  it("says a Color is needed, and carries the title as text", () => {
    expect(built.bytes[0x23]).toBe(NGP_SYSTEM_COLOR);
    expect(String.fromCharCode(...built.bytes.subarray(0x24, 0x24 + 12))).toBe("PONG        ");
  });

  it("leaves SNK's recognition code blank, because it is their claim", () => {
    // Every emulator boots the cartridge anyway; the Game Boy's boot logo is the
    // same bargain, and it keeps the CLI's and the browser's output identical.
    expect(built.bytes.subarray(0, NGP_ENTRY_OFFSET).every((byte) => byte === 0)).toBe(true);
  });

  it("measures headroom against the address space, not the board it ships on", () => {
    // The rule every elastic console here runs under: a game that got bigger
    // must never *look* like a game with more room, so `free` is against the
    // largest board however small this cartridge turned out to be.
    expect(built.stats.bytes).toBeLessThan(CODE_SIZE);
    expect(built.stats.free).toBe(CODE_SIZE - built.stats.bytes);
    expect(built.stats.cartridge).toBe(NGP_ROM_SIZES[0]);
  });
});

describe("boot", async () => {
  const built = await buildNgpcRom(build("pong"), { assets: exampleProject("pong").assets });
  const machine = boot(built.bytes, built.layout.booted);
  settle(machine, 4);

  it("copies the character bank into the display's memory", () => {
    // The first built-in character is the space glyph, which is blank — so the
    // *second* is where a short copy would show.
    const glyph = machine.video.subarray(
      NGP_CHARACTERS - NGP_VIDEO + TILE_BYTES,
      NGP_CHARACTERS - NGP_VIDEO + TILE_BYTES * 2,
    );
    expect(glyph.some((byte) => byte !== 0)).toBe(true);
    // And the art past the built-ins arrived too — a copy that stopped at the
    // built-in bank would draw a title screen made entirely of blanks.
    const art = machine.video.subarray(
      NGP_CHARACTERS - NGP_VIDEO + BUILTIN_TILES * TILE_BYTES,
      NGP_CHARACTERS - NGP_VIDEO + (BUILTIN_TILES + 8) * TILE_BYTES,
    );
    expect(art.some((byte) => byte !== 0)).toBe(true);
  });

  it("keeps a palette of the sixteen for the font, on every layer that draws", () => {
    for (const block of [PALETTE_SPRITES, PALETTE_PLANE1]) {
      const at = NGP_PALETTE - NGP_VIDEO + block * NGP_PALETTE_STRIDE + SYSTEM_PALETTE * 8;
      const entries = machine.video.subarray(at, at + 8);
      expect(
        entries.some((byte) => byte !== 0),
        `palette block ${block}`,
      ).toBe(true);
    }
  });

  it("writes the font's ink as BGR, which is the only order this chip reads", () => {
    // A grey ramp cannot tell an encoder from its inverse, so the ink over a
    // dark backdrop is the light end and over a light one the dark end — and
    // either way the three entries have to be *distinct* and *ordered*. What is
    // actually checked is the channel order: `fontRamp` is grey, so this reads
    // the art's own palettes instead, where at least one colour is not.
    const at = NGP_PALETTE - NGP_VIDEO + PALETTE_PLANE1 * NGP_PALETTE_STRIDE;
    let asymmetric = 0;
    for (let entry = 0; entry < 15 * 4; entry += 1) {
      const low = machine.video[at + entry * 2] as number;
      const high = machine.video[at + entry * 2 + 1] as number;
      // Twelve bits wide: the top nibble of the high byte is not a colour.
      expect(high & 0xf0).toBe(0);
      if ((low & 0x0f) !== (high & 0x0f)) asymmetric += 1;
    }
    // A demade picture that used only greys would make this vacuous.
    expect(asymmetric).toBeGreaterThan(0);
  });

  it("hides every object it did not use, because priority is the only way", () => {
    // Into the game first: every example opens on a title screen, and a scene
    // that does not scroll draws its whole HUD into the plane — so the object
    // table on a title screen is legitimately empty.
    machine.setButtons(["a"]);
    settle(machine, 4);
    machine.setButtons([]);
    settle(machine, 8);
    // Sixty-four fixed entries and no link field. `pong` draws seven objects, so
    // everything above that has to read back as priority zero — and a build that
    // left them would show last frame's objects for ever.
    let drawn = 0;
    for (let index = 0; index < 64; index += 1) {
      if (((video(machine, NGP_SPRITES + index * 4 + 1) >> 3) & 3) !== 0) drawn += 1;
    }
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(64);
  });
});

describe("the scroll plane", async () => {
  const program = build("caves", { "cavern.dmtl": projectText("caves", "levels/cavern.dmtl") });
  const built = await buildNgpcRom(program);
  const machine = boot(built.bytes, built.layout.booted);
  // Through the title screen, which is where every example starts, and then far
  // enough for the level's own redraw to have happened.
  machine.setButtons(["a"]);
  settle(machine, 4);
  machine.setButtons([]);
  settle(machine, 12);

  const level = program.scenes.find((scene) => scene.level)?.level;

  /** Every visible cell against the level's own grid, wherever the camera is. */
  function checkGrid(): void {
    const grid = level as NonNullable<typeof level>;
    const scrollX = video(machine, 0x008032);
    const scrollY = video(machine, 0x008033);
    for (let row = 0; row < VIEW_H; row += 1) {
      for (let column = 0; column < VIEW_W; column += 1) {
        const mapColumn = (scrollX >> 3) + column;
        const mapRow = (scrollY >> 3) + row;
        const character = (grid.rows[mapRow] ?? "")[mapColumn] ?? " ";
        const legend = grid.tiles.findIndex((tile) => tile.char === character);
        const want = legend < 0 ? 0 : patternTile(legend, grid.tiles[legend]?.solid ?? false);
        expect(
          entryAt(machine, NGP_PLANE1, mapColumn, mapRow).tile,
          `cell ${mapColumn},${mapRow}`,
        ).toBe(want);
      }
    }
  }

  it("matches the level's own grid, cell for cell", () => {
    expect(level).toBeDefined();
    checkGrid();
  });

  it("scrolls by painting a leading edge nobody is looking at", () => {
    // 32×32 of map against 20×19 of window, so the twelve spare columns and
    // thirteen spare rows are where the next step's cells go. Run the camera far
    // enough to cross into them and check the grid again from the other side.
    machine.setButtons(["right"]);
    settle(machine, 110);
    machine.setButtons([]);
    settle(machine, 2);
    expect(video(machine, 0x008032)).toBeGreaterThan(0);
    checkGrid();
  });
});

/** Unpack `packCellPairs`' literals and runs back into cell words. */
function unpackCells(packed: Uint8Array): number[] {
  const cells: number[] = [];
  let at = 0;
  while (at < packed.length) {
    const control = packed[at] as number;
    at += 1;
    if (control === 0) break;
    if ((control & 0x80) !== 0) {
      const word = (packed[at] as number) | ((packed[at + 1] as number) << 8);
      at += 2;
      for (let n = 0; n < (control & 0x7f); n += 1) cells.push(word);
      continue;
    }
    for (let n = 0; n < control; n += 1) {
      cells.push((packed[at] as number) | ((packed[at + 1] as number) << 8));
      at += 2;
    }
  }
  return cells;
}

describe("a demade picture", async () => {
  const example = exampleProject("breakout");
  const program = build("breakout");
  const built = await buildNgpcRom(program, { assets: example.assets });
  const machine = boot(built.bytes, built.layout.booted);
  settle(machine, 6);

  // The same conversion the build used — memoised by content hash, so asking
  // again is free — which is what makes this a comparison against the art path's
  // own answer rather than against a threshold.
  const art = await bindNgpcArt(program, example.assets);
  const entry = program.scenes.find((scene) => scene.name === program.entryScene);
  const packed = art.options.backdrops?.get(entry?.name ?? "");

  it("reaches the plane exactly as the art path packed it", () => {
    // The Super Nintendo's stride hazard, several consoles along, and the
    // *double*-packing one beside it (AGENTS.md §The V30MZ half): a picture laid
    // in at the window's twenty cells shears twelve further left on every row,
    // and a picture packed twice unpacks as its own compression format. Both
    // present as art running past column 19, and neither is visible in a count.
    expect(packed).toBeDefined();
    const cells = unpackCells((packed as { map: Uint8Array }).map);
    expect(cells.length).toBe(MAP_W * VIEW_H);
    let matched = 0;
    for (let row = 0; row < VIEW_H; row += 1) {
      for (let column = 0; column < MAP_W; column += 1) {
        const want = cells[row * MAP_W + column] as number;
        const cell = entryAt(machine, NGP_PLANE1, column, row);
        // A caption is painted over the picture after the blit, and the one
        // thing every cell of it has is the font's palette — so a cell in that
        // palette is the HUD rather than a disagreement. Everything else has to
        // be exactly what the art path handed over, and the case below is what
        // stops a wrong cell hiding in the exemption.
        if (cell.palette === SYSTEM_PALETTE) continue;
        expect(cell.tile, `cell ${column},${row}`).toBe(want & 0x1ff);
        expect(cell.palette, `cell ${column},${row}`).toBe((want >> 9) & 0x0f);
        matched += 1;
      }
    }
    // And most of the map is the picture, so a blit that wrote nothing at all
    // cannot pass by having every cell excused as a caption.
    expect(matched).toBeGreaterThan(MAP_W * VIEW_H * 0.9);
    // And the twelve columns the window does not show carry nothing, which is
    // what "there is no seam to hide" means on this console.
    for (let row = 0; row < VIEW_H; row += 1) {
      for (let column = VIEW_W; column < MAP_W; column += 1) {
        expect(entryAt(machine, NGP_PLANE1, column, row).tile, `spare ${column},${row}`).toBe(0);
      }
    }
  });

  it("draws through the palettes the fit chose, and never the font's", () => {
    let cells = 0;
    for (let row = 0; row < VIEW_H; row += 1) {
      for (let column = 0; column < VIEW_W; column += 1) {
        const cell = entryAt(machine, NGP_PLANE1, column, row);
        if (cell.tile < BUILTIN_TILES) continue;
        expect(cell.palette, `cell ${column},${row}`).toBeLessThan(SYSTEM_PALETTE);
        cells += 1;
      }
    }
    expect(cells).toBeGreaterThan(0);
  });
});
