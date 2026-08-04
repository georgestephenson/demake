/**
 * What the WonderSwan Color build is, beyond playing the same game.
 *
 * Trace conformance is in `rom.test.ts`, over the same battery every other
 * console runs — that is where "a WonderSwan plays the game the interpreter
 * defines" is settled. Here are the things only this console has, and every case
 * is one that produces a cartridge which traces perfectly and shows nothing:
 *
 *   - **There is no video memory.** The screen maps, the tile bank, the object
 *     table and palette RAM are addresses in the same 64 KiB the game's
 *     variables are in, so a build whose boot copy was short, or aimed a
 *     kilobyte off, would tick correctly against a blank screen. Nothing is
 *     uploaded through a port, so nothing about the arrival is observable except
 *     the bytes themselves.
 *   - **The map against the level's own grid.** A framebuffer comparison needs a
 *     libretro core (doc 10); this is better for finding the class of bug anyway,
 *     because it names the cell. The map is 32×32 against a 28×18 window, so it
 *     is also where "both wraps are powers of two" is checked rather than
 *     asserted.
 *   - **A picture is packed thirty-two cells to a row.** The Super Nintendo's
 *     stride hazard, two consoles along: a picture written at the *window's*
 *     twenty-eight would arrive sheared one cell further left on every row. It
 *     shipped that way on the other machine, which is why it is a test here.
 *   - **The HUD has a plane of its own, and it does not move.** `SCR2` draws in
 *     front of `SCR1` and scrolls independently, so a caption's cells are
 *     written once and its scroll registers never again — which is the claim the
 *     whole HUD design rests on, and the one property no 8-bit backend here can
 *     have. Only the Game Boy Advance has had it before.
 *   - **The object table is the hardware's own.** There is no shadow the chip
 *     copies and no link field to cut: port `$06` says how many entries to look
 *     at, so a frame that used fewer simply says so. A build that wrote its
 *     objects somewhere else would put them nowhere.
 *   - **Two reserved palettes, not one.** An object's palette field is three bits
 *     and selects among 8–15, so the background half and the object half cannot
 *     share a font palette. A caption is legible only if the fit reaches neither.
 */

import { describe, expect, it } from "vitest";

import { WS_CODE_SIZE, WS_ENTRY_OFFSET, WS_ROM_SIZE, wsChecksum } from "@demake/core";
import { PORT, Wsc } from "@demake/wsc";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { buildWscRom, CODE_SIZE } from "../src/codegen/wsc.js";
import { bindWscArt } from "../src/codegen/wsc-art.js";
import {
  MAP_H,
  MAP_W,
  RAM,
  SYSTEM_OBJECT_PALETTE,
  SYSTEM_PALETTE,
} from "../src/codegen/wsc/emit.js";
import { BUILTIN_TILES, patternTile } from "../src/rom/graphics.js";
import { exampleProject, projectText } from "./_projects.js";

function build(project: string, levels?: Record<string, string>) {
  // `files` is what turns `backdrop caves.title.svg` into `art/caves.title.svg`,
  // which is the key the asset map uses.
  const example = exampleProject(project);
  return compile(example.source, {
    profile: getProfile("wsc"),
    files: example.files,
    levels: levels ?? example.levels,
  });
}

/** Boot a cartridge and run it until the runtime says it has finished booting. */
function boot(bytes: Uint8Array, bootedAt: number): Wsc {
  const machine = new Wsc(bytes);
  for (let guard = 0; guard < 8_000_000; guard += 1) {
    if (machine.readMemory(bootedAt, 1)[0] !== 0) return machine;
    machine.stepInstruction();
  }
  throw new Error("wsc: the runtime never finished initialising");
}

/** Run whole frames, so a scene has settled before anything is compared. */
function settle(machine: Wsc, frames: number): void {
  for (let frame = 0; frame < frames; frame += 1) machine.runFrame();
}

/** A screen map entry: nine bits of tile, then the palette, the bank and flips. */
function entryAt(
  machine: Wsc,
  base: number,
  column: number,
  row: number,
): { tile: number; palette: number } {
  const at = base + ((row % MAP_H) * MAP_W + (column % MAP_W)) * 2;
  const word = (machine.ram[at] as number) | ((machine.ram[at + 1] as number) << 8);
  return { tile: word & 0x1ff, palette: (word >> 9) & 0x0f };
}

describe("the WonderSwan cartridge", async () => {
  const built = await buildWscRom(build("pong"));

  it("is the one board this console's header can describe", () => {
    // 4 Mbit, because the size byte's vocabulary starts there (`ws-cart.ts`):
    // nothing to choose, the way a Game Boy ROM-only cartridge is 32 KiB.
    expect(built.bytes.length).toBe(WS_ROM_SIZE);
  });

  it("puts the far jump the processor resets into where it fetches", () => {
    const entry = WS_ROM_SIZE - 0x10000 + WS_ENTRY_OFFSET;
    // `jmp $F000:$0000` — the last bank answers segment $F000 from reset, so the
    // program starts at the bank's first byte and reset lands past its end.
    expect([...built.bytes.subarray(entry, entry + 5)]).toEqual([0xea, 0x00, 0x00, 0x00, 0xf0]);
  });

  it("checksums every byte of the finished image but its own two", () => {
    const stored =
      (built.bytes[WS_ROM_SIZE - 2] as number) | ((built.bytes[WS_ROM_SIZE - 1] as number) << 8);
    expect(stored).toBe(wsChecksum(built.bytes));
  });

  it("measures headroom against the mapped bank rather than against the file", () => {
    // Half a megabyte of cartridge and 64 KiB the processor answers, minus the
    // entry jump — so `free` is about the bank, which is the number a size
    // regression actually moves.
    expect(CODE_SIZE).toBe(WS_CODE_SIZE);
    expect(built.stats.bytes).toBeLessThan(CODE_SIZE);
    expect(built.stats.free).toBe(CODE_SIZE - built.stats.bytes);
    expect(built.stats.cartridge).toBe(WS_ROM_SIZE);
  });

  it("leaves room for a game to grow", () => {
    expect(built.stats.free).toBeGreaterThan(1024);
  });
});

describe("boot", async () => {
  const built = await buildWscRom(build("pong"), { assets: exampleProject("pong").assets });
  const machine = boot(built.bytes, built.layout.booted);
  settle(machine, 4);

  it("describes the machine the renderer was written for", () => {
    // Colour, 4bpp, packed tiles: anything less and the tile bank the build
    // copied in decodes as a different picture entirely.
    expect(machine.readPort(PORT.DISP_MODE)).toBe(0xe0);
    // Both planes and the objects, once the first redraw has finished.
    expect(machine.readPort(PORT.DISP_CTRL) & 0x07).toBe(0x07);
  });

  it("points the display at the memory the runtime writes", () => {
    // A nibble each, in units of 2 KiB — and the object table in units of 512
    // bytes, which is why it is aligned where it is.
    expect(machine.readPort(PORT.MAP_BASE)).toBe((RAM.SCR1 >> 11) | ((RAM.SCR2 >> 11) << 4));
    expect(machine.readPort(PORT.SPR_BASE)).toBe(RAM.OAM >> 9);
  });

  it("copies the tile bank into RAM, because there is nowhere else to put it", () => {
    // The first built-in tile is the blank, so the *second* is where a short copy
    // would show: it is a glyph and it is not all zero.
    const glyph = machine.ram.subarray(RAM.TILES + 32, RAM.TILES + 64);
    expect(glyph.some((byte) => byte !== 0)).toBe(true);
    // And the art past the built-ins arrived too — a copy that stopped at the
    // built-in bank would draw a title screen made entirely of blanks.
    const art = machine.ram.subarray(
      RAM.TILES + BUILTIN_TILES * 32,
      RAM.TILES + (BUILTIN_TILES + 8) * 32,
    );
    expect(art.some((byte) => byte !== 0)).toBe(true);
  });

  it("copies palette RAM, and keeps a palette of each kind for the font", () => {
    // Two reservations rather than one, because an object's palette field is
    // three bits: 0–6 and 8–14 are the art's, 7 and 15 are the font's.
    for (const palette of [SYSTEM_PALETTE, SYSTEM_OBJECT_PALETTE]) {
      const at = RAM.PALETTE + palette * 32;
      const entries = machine.ram.subarray(at, at + 32);
      expect(
        entries.some((byte) => byte !== 0),
        `palette ${palette}`,
      ).toBe(true);
    }
  });
});

describe("the background plane", async () => {
  const program = build("caves", { "cavern.dmtl": projectText("caves", "levels/cavern.dmtl") });
  const built = await buildWscRom(program);
  const machine = boot(built.bytes, built.layout.booted);
  // Through the title screen, which is where every example starts, and then far
  // enough for the level's own redraw to have happened.
  machine.setButtons(["a"]);
  settle(machine, 4);
  machine.setButtons([]);
  settle(machine, 12);

  const level = program.scenes.find((scene) => scene.level)?.level;

  it("matches the level's own grid, cell for cell", () => {
    expect(level).toBeDefined();
    const grid = level as NonNullable<typeof level>;
    const scrollX = machine.readPort(PORT.SCR1_X);
    const scrollY = machine.readPort(PORT.SCR1_Y);
    for (let row = 0; row < 18; row += 1) {
      for (let column = 0; column < 28; column += 1) {
        const mapColumn = (scrollX >> 3) + column;
        const mapRow = (scrollY >> 3) + row;
        const character = (grid.rows[mapRow] ?? "")[mapColumn] ?? " ";
        const legend = grid.tiles.findIndex((tile) => tile.char === character);
        const want = legend < 0 ? 0 : patternTile(legend, grid.tiles[legend]?.solid ?? false);
        expect(
          entryAt(machine, RAM.SCR1, mapColumn, mapRow).tile,
          `cell ${mapColumn},${mapRow}`,
        ).toBe(want);
      }
    }
  });

  it("scrolls by painting a leading edge nobody is looking at", () => {
    // 32×32 of map against 28×18 of window, so the four spare columns and
    // fourteen spare rows are where the next step's cells go. Run the camera far
    // enough to cross the wrap and check the grid again from the other side.
    // A hero eleven cells a second, a window twenty-eight wide and a camera that
    // centres on it: the camera does not move at all until the player has crossed
    // half the window, which at 75.47 Hz is most of two seconds.
    machine.setButtons(["right"]);
    settle(machine, 220);
    machine.setButtons([]);
    settle(machine, 2);
    const grid = level as NonNullable<typeof level>;
    const scrollX = machine.readPort(PORT.SCR1_X);
    const scrollY = machine.readPort(PORT.SCR1_Y);
    expect(scrollX).toBeGreaterThan(0);
    for (let row = 0; row < 18; row += 1) {
      for (let column = 0; column < 28; column += 1) {
        const mapColumn = (scrollX >> 3) + column;
        const mapRow = (scrollY >> 3) + row;
        const character = (grid.rows[mapRow] ?? "")[mapColumn] ?? " ";
        const legend = grid.tiles.findIndex((tile) => tile.char === character);
        const want = legend < 0 ? 0 : patternTile(legend, grid.tiles[legend]?.solid ?? false);
        expect(
          entryAt(machine, RAM.SCR1, mapColumn, mapRow).tile,
          `cell ${mapColumn},${mapRow}`,
        ).toBe(want);
      }
    }
  });
});

describe("the HUD plane", async () => {
  const program = build("caves", { "cavern.dmtl": projectText("caves", "levels/cavern.dmtl") });
  const built = await buildWscRom(program);
  const machine = boot(built.bytes, built.layout.booted);
  machine.setButtons(["a"]);
  settle(machine, 4);
  machine.setButtons([]);
  settle(machine, 12);

  it("is written once at boot and never scrolled again", () => {
    // The claim the whole design rests on: a caption's cell is held still by the
    // plane it is on rather than by pinning a sprite to the pixel. `caves`
    // scrolls in both directions, so both registers are exercised.
    machine.setButtons(["right"]);
    let moved = 0;
    for (let frame = 0; frame < 240; frame += 1) {
      machine.runFrame();
      if (machine.readPort(PORT.SCR1_X) !== 0) moved += 1;
      expect(machine.readPort(PORT.SCR2_X)).toBe(0);
      expect(machine.readPort(PORT.SCR2_Y)).toBe(0);
    }
    expect(moved).toBeGreaterThan(0);
  });

  it("keeps the caption in the same cells while the picture slides under it", () => {
    // The counter's own cells change as the number does; what may not change is
    // *which* cells the caption occupies. `caves` pins its HUD to the camera, so
    // on any other console this is the sprite HUD's pixel-pinning argument.
    machine.setButtons([]);
    settle(machine, 2);
    const occupied = (): string => {
      const cells: string[] = [];
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 28; column += 1) {
          if (entryAt(machine, RAM.SCR2, column, row).tile !== 0) cells.push(`${column},${row}`);
        }
      }
      return cells.join(" ");
    };
    const before = occupied();
    expect(before.length).toBeGreaterThan(0);
    const scrolled = machine.readPort(PORT.SCR1_X);
    machine.setButtons(["right"]);
    settle(machine, 40);
    machine.setButtons([]);
    settle(machine, 2);
    expect(machine.readPort(PORT.SCR1_X)).not.toBe(scrolled);
    expect(occupied()).toBe(before);
  });
});

describe("a demade picture", async () => {
  const program = build("pong");
  const assets = exampleProject("pong").assets;

  it("fits into the sub-palettes the font left it", async () => {
    const art = await bindWscArt(program, assets);
    for (const [name, scene] of art.options.scenePalettes ?? []) {
      // The font's two palettes are the build's, whatever the picture wanted.
      for (const palette of [SYSTEM_PALETTE, SYSTEM_OBJECT_PALETTE]) {
        const at = palette * 32;
        const entries = scene.subarray(at, at + 32);
        expect(
          entries.some((byte) => byte !== 0),
          `${name} palette ${palette}`,
        ).toBe(true);
      }
    }
  }, 120000);

  it("is packed at the hardware's row and not the window's", async () => {
    // The Super Nintendo's stride hazard, two consoles along: a map row is
    // thirty-two entries and the window is twenty-eight, so a picture packed at
    // the window's width arrives sheared a cell further left on every row.
    // Building and booting is the only way to see it, because the packed form is
    // deliberately not the contract.
    const built = await buildWscRom(program, { assets });
    const machine = boot(built.bytes, built.layout.booted);
    settle(machine, 4);
    // The four columns past the window are the blank the redraw filled the plane
    // with — which is only true if the picture went in at the right stride.
    for (let row = 0; row < 18; row += 1) {
      for (let column = 28; column < MAP_W; column += 1) {
        expect(entryAt(machine, RAM.SCR1, column, row).tile, `row ${row} column ${column}`).toBe(0);
      }
    }
    // And the picture is really there: the window is not all blank.
    let painted = 0;
    for (let row = 0; row < 18; row += 1) {
      for (let column = 0; column < 28; column += 1) {
        if (entryAt(machine, RAM.SCR1, column, row).tile !== 0) painted += 1;
      }
    }
    expect(painted).toBeGreaterThan(100);
  }, 120000);
});

describe("the object table", async () => {
  const program = build("pong");
  const built = await buildWscRom(program);
  const machine = boot(built.bytes, built.layout.booted);
  machine.setButtons(["a"]);
  settle(machine, 6);
  machine.setButtons([]);
  settle(machine, 6);

  it("is the table the display reads, with no copy in between", () => {
    // Port `$04` names this address and the chip reads it where it lies, so the
    // bytes the runtime wrote *are* the objects. At least one is on screen.
    let visible = 0;
    const count = machine.readPort(PORT.SPR_COUNT);
    for (let index = 0; index < count; index += 1) {
      const at = RAM.OAM + index * 4;
      const y = machine.ram[at + 2] as number;
      const x = machine.ram[at + 3] as number;
      const tile = (machine.ram[at] as number) | (((machine.ram[at + 1] as number) & 1) << 8);
      if (y < 144 && x < 224 && tile !== 0) visible += 1;
    }
    expect(count).toBeGreaterThan(0);
    expect(visible).toBeGreaterThan(0);
  });

  it("says how many entries a frame used rather than parking the rest", () => {
    // This hardware has neither the Mega Drive's link field nor the Sega's
    // terminator: port `$06` is the count, so an unused entry needs no hiding
    // and the table past it is nobody's business.
    expect(machine.readPort(PORT.SPR_COUNT)).toBeLessThanOrEqual(built.layout.memory.oamEntries);
    expect(machine.readPort(PORT.SPR_FIRST)).toBe(0);
  });
});
