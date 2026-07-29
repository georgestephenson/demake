/**
 * What the NES build is, beyond playing the same game.
 *
 * Trace conformance is in `rom.test.ts`, over the same battery both Game Boys
 * run — that is where "the NES plays the game the interpreter defines" is
 * settled. Here are the things only this console has, and each is here because
 * getting it wrong produces a cartridge that traces perfectly and looks wrong:
 *
 *   - **The cartridge's own shape.** There is no fixed entry point on a 6502: it
 *     takes the address from `$FFFC`, so six bytes at the top of the program are
 *     what makes a ROM boot at all. And mirroring is a wiring decision in the
 *     header, before a line of code runs — a game that scrolls sideways with the
 *     wrong one scrolls into a copy of itself.
 *   - **The nametable against the level grid.** A framebuffer comparison needs a
 *     libretro core (doc 10); what is available here is better for finding this
 *     class of bug anyway, because it names the cell. Every visible cell is
 *     checked against what the level says should be there, before and after the
 *     camera has moved — which is what catches an edge painter that walks the
 *     wrong column, or a wrap computed at the wrong modulus.
 *   - **A legible font.** Colour zero of every background palette is the one
 *     universal backdrop on this hardware, so the font's palette gets three
 *     colours and has to live with the fourth. The ink is chosen against that
 *     backdrop, and the test is that a caption is not the colour it is written on.
 */

import { describe, expect, it } from "vitest";

import {
  backendFor,
  getConsole,
  NES_CHR_OFFSET,
  NES_PRG_OFFSET,
  NES_PRG_SIZE,
  prep,
} from "@demake/core";
import { Nes } from "@demake/nes";

import { buildNesRom } from "../src/codegen/nes.js";
import { bindNesArt, BACKDROP_PALETTES } from "../src/codegen/nes-art.js";
import { packCells, SYSTEM_PALETTE } from "../src/codegen/nes/emit.js";
import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { BUILTIN_TILES, TILE_BYTES, type SelectedBank } from "../src/rom/graphics.js";
import { gameSource, projectBytes, projectText } from "./_projects.js";

function build(project: string, levels?: Record<string, string>) {
  return compile(gameSource(project), { profile: getProfile("nes"), levels });
}

describe("the NES cartridge", async () => {
  const built = await buildNesRom(build("pong"));

  it("is an iNES file describing NROM with vertical mirroring", () => {
    expect([...built.bytes.subarray(0, 4)]).toEqual([0x4e, 0x45, 0x53, 0x1a]);
    expect(built.bytes[4]).toBe(2); // two 16 KiB program banks
    expect(built.bytes[5]).toBe(1); // one 8 KiB character bank
    // Mapper 0, and bit 0 set: the two nametables side by side, which is what the
    // renderer's 64-column wrap is written for.
    expect(built.bytes[6]).toBe(0x01);
    expect(built.bytes[7]).toBe(0x00);
    expect(built.bytes.length).toBe(16 + 0x8000 + 0x2000);
  });

  it("points its three vectors at the routines they name", () => {
    const vector = (offset: number): number =>
      (built.bytes[NES_PRG_OFFSET + offset] as number) |
      ((built.bytes[NES_PRG_OFFSET + offset + 1] as number) << 8);
    expect(vector(NES_PRG_SIZE - 6)).toBe(built.symbols.get("Nmi"));
    expect(vector(NES_PRG_SIZE - 4)).toBe(built.symbols.get("Reset"));
    expect(vector(NES_PRG_SIZE - 2)).toBe(built.symbols.get("Irq"));
  });

  it("puts the built-in patterns in both tables, because the bank is fixed anyway", async () => {
    const bank = (await bindNesArt(build("pong"), new Map())).options.bank as SelectedBank;
    const background = built.bytes.subarray(NES_CHR_OFFSET, NES_CHR_OFFSET + bank.chr.length);
    const objects = built.bytes.subarray(
      NES_CHR_OFFSET + 0x1000,
      NES_CHR_OFFSET + 0x1000 + bank.chr.length,
    );
    expect([...background]).toEqual([...bank.chr]);
    expect([...objects]).toEqual([...bank.chr]);
    expect(bank.chr.length).toBe(bank.count * TILE_BYTES);
  });

  it("pulls the bank, so a game pays for the characters it draws", async () => {
    // The whole font is 59 glyphs and pong writes about a dozen. On a Game Boy
    // that costs nothing — 384 tiles is more than these games fill — and here it
    // comes out of the 256 a *picture* is fitted into.
    const bank = (await bindNesArt(build("pong"), new Map())).options.bank as SelectedBank;
    expect(bank.count).toBeLessThan(BUILTIN_TILES);
    // The blank stays at zero whatever else is in the bank: it is what an empty
    // cell draws, and the runtime writes that number rather than looking it up.
    expect(bank.glyph(" ")).toBe(0);
    expect(bank.glyph("?")).toBe(0); // not drawn by this game, so it is the blank
    // And what the game does draw is in it, at distinct indices — every character
    // of every caption it writes, taken from the program rather than guessed at.
    const program = build("pong");
    const captions = program.instances
      .filter((instance) => instance.className === "text")
      .flatMap((instance) => [...(instance.strings["text"] ?? "")])
      .map((character) => character.toUpperCase())
      .filter((character) => character !== " ");
    expect(captions.length).toBeGreaterThan(0);
    const tiles = [...new Set(captions)].map((character) => bank.glyph(character));
    expect(tiles.every((tile) => tile > 0)).toBe(true);
    expect(new Set(tiles).size).toBe(tiles.length);
  });
});

/**
 * Headroom for two full-screen conversions.
 *
 * Demaking a picture for this console is the whole `prep` tournament, at 960 cells
 * rather than a Game Boy's 360 — the cost `demake prep -c nes` has always had. The
 * default timeout is written for tests that run one pipeline, and a loaded CI
 * runner is several times slower than a developer's machine.
 */
const ART_TIMEOUT = 120_000;

describe("the NES art budget", { timeout: ART_TIMEOUT }, async () => {
  const pongAssets = () =>
    new Map([
      ["pong.title.svg", projectBytes("pong", "art/pong.title.svg")],
      ["pong.play.svg", projectBytes("pong", "art/pong.play.svg")],
      ["ball.svg", projectBytes("pong", "art/ball.svg")],
      ["paddle.svg", projectBytes("pong", "art/paddle.svg")],
    ]);

  it("gives each picture a pattern table of its own", async () => {
    // The console has two, and `PPUCTRL` bit 4 chooses which one the background
    // reads — so two pictures do not have to share one. Sharing halved what each
    // got, and the fitter spent the difference merging cells.
    const bound = await bindNesArt(build("pong"), pongAssets());
    const fits = [...bound.backdropFits.values()];
    expect(fits.length).toBe(2);
    expect(new Set(fits.map((fit) => fit.table)).size).toBe(2);
    for (const fit of fits) expect(fit.budget).toBeGreaterThan(150);
  });

  it("still fits both, with the built-in bank in each table", async () => {
    const built = await buildNesRom(build("pong"), { assets: pongAssets() });
    expect(built.stats.missingArt).toEqual([]);
    expect(built.stats.artTiles).toBeGreaterThan(0);
    expect(built.bytes.length).toBe(16 + 0x8000 + 0x2000);
  });

  /**
   * The cartridge's picture is the art demaker's picture, cell for cell.
   *
   * Not "looks like": the same bytes. A game's backdrop goes through `prep`
   * and the `nes` image backend — the code `demake prep -c nes` is — so the only
   * thing a build may decide is the *budget*, and it decides it from what the
   * pattern table has left. This runs the picture through that path again at the
   * budget the build reports and compares the pattern behind every one of the 960
   * cells, which is what makes "no second art converter" checkable rather than a
   * claim about who calls what.
   */
  /**
   * The packed nametable reaches the PPU as the picture, byte for byte.
   *
   * A backdrop is stored as literals and runs, because 960 raw bytes a picture is
   * three per cent of an NROM cartridge and the shooter has nine aliens' worth of
   * collision code to fit beside two of them. What is guaranteed is not the
   * encoding but what comes out of it, so this boots the cartridge and reads the
   * PPU's own memory: the picture's own cells, and the attribute table that
   * colours them.
   *
   * The caption is painted over the picture afterwards, so the last rows are the
   * game's rather than the fit's — which is why the exact comparison stops above
   * them and what is asserted below them is that only a caption's worth of cells
   * moved.
   */
  it("unpacks a backdrop into exactly the cells the build produced", async () => {
    const program = build("pong");
    const assets = pongAssets();
    const built = await buildNesRom(program, { assets });
    const bound = await bindNesArt(program, assets);
    const machine = new Nes(built.bytes);
    for (let frame = 0; frame < 8; frame += 1) machine.runFrame();

    const title = bound.options.backdrops?.get("title");
    expect(title).toBeDefined();
    const { map, attr } = title as { map: Uint8Array; attr: Uint8Array };
    expect(map.length).toBe(32 * 30);
    const painted = machine.ppu.nametables;
    const clear = 24 * 32; // above anything the HUD writes
    expect([...painted.subarray(0, clear)]).toEqual([...map.subarray(0, clear)]);
    let differing = 0;
    for (let cell = clear; cell < map.length; cell += 1) {
      if (painted[cell] !== map[cell]) differing += 1;
    }
    expect(differing).toBeLessThan(64);
    // The attribute table is packed and unpacked the same way, and above the
    // caption it is the picture's own. The blocks the caption covers are switched
    // to its palette when the table is *built*, so those are the build's answer
    // rather than the fit's and are not compared here.
    expect([...painted.subarray(0x3c0, 0x3c0 + 48)]).toEqual([...attr.subarray(0, 48)]);
    // And the encoding is worth having: a picture that packed to its full size
    // would mean the walk was costing bytes rather than saving them.
    expect(packCells(map).length).toBeLessThan(map.length * 0.8);
  });

  it("draws exactly what `demake prep -c nes` would, at the budget it was given", async () => {
    const program = build("pong");
    const bound = await bindNesArt(program, pongAssets());
    const spec = getConsole("nes");
    const backend = backendFor("nes");
    expect(backend).toBeDefined();

    for (const scene of program.scenes) {
      const file = scene.backdrop;
      if (file === undefined) continue;
      const fit = bound.backdropFits.get(scene.name);
      const drawn = bound.options.backdrops?.get(scene.name);
      expect(fit, scene.name).toBeDefined();
      expect(drawn, scene.name).toBeDefined();

      const image = (
        await prep(projectBytes("pong", `art/${file}`), {
          console: "nes",
          // The game's screen, which is the overscan-safe twenty-eight rows and
          // not the raster's thirty — the picture's edges have to be the ones the
          // ball bounces off (`nes-art.ts` §`GAME_ROWS`).
          size: { w: 32 * 8, h: 28 * 8 },
          fit: "cover",
          maxSubPalettes: BACKDROP_PALETTES,
          maxTiles: (fit as { budget: number }).budget,
        })
      ).image;
      const artifacts = backend?.emitBin(image, spec, {
        symbol: "backdrop",
        header: [],
        mapBase: 0,
        tileBase: 0,
      });
      const find = (suffix: string): Uint8Array =>
        artifacts?.find((artifact) => artifact.suffix === suffix)?.bytes ?? new Uint8Array(0);
      const wantChr = find(".chr.bin");
      const wantMap = find(".nam.bin");
      const table = (drawn as { table: 0 | 1 }).table * 0x1000;
      const gotMap = (drawn as { map: Uint8Array }).map;

      // The name table is the picture plus the two overscan rows, which repeat
      // its last one rather than showing black.
      expect(gotMap.length, scene.name).toBe(32 * 30);
      expect(wantMap.length, scene.name).toBe(32 * 28);
      for (let row = 28; row < 30; row += 1) {
        expect([...gotMap.subarray(row * 32, row * 32 + 32)], `${scene.name} overscan row`).toEqual(
          [...gotMap.subarray(27 * 32, 28 * 32)],
        );
      }
      let differing = 0;
      for (let cell = 0; cell < wantMap.length; cell += 1) {
        const want = (wantMap[cell] as number) * TILE_BYTES;
        const got = table + (gotMap[cell] as number) * TILE_BYTES;
        for (let byte = 0; byte < TILE_BYTES; byte += 1) {
          if (bound.chr[got + byte] !== wantChr[want + byte]) {
            differing += 1;
            break;
          }
        }
      }
      expect(differing, `${scene.name} cells differing from prep's`).toBe(0);
      // And its attributes, which decide the colour of every one — the picture's
      // own for the seven block rows it covers, and the eighth synthesised from
      // row 27's so the repeated rows keep their palettes.
      const gotAttr = (drawn as { attr: Uint8Array }).attr;
      expect([...gotAttr.subarray(0, 56)]).toEqual([...find(".attr.bin").subarray(0, 56)]);
      for (let column = 0; column < 8; column += 1) {
        const above = gotAttr[48 + column] as number;
        const want = ((above >> 4) & 3) | (((above >> 6) & 3) << 2);
        expect(gotAttr[56 + column]! & 0x0f, `${scene.name} overscan attributes`).toBe(want);
      }
    }
  });
});

describe("what the NES actually draws", async () => {
  /**
   * Every visible cell against the level grid the ROM carries.
   *
   * The tables are read out of the cartridge rather than recomputed here, so this
   * checks the *renderer* — where a cell was put — and not the level format, which
   * `shape.ts` emits for both consoles and `level.test.ts` already covers.
   *
   * All thirty rows, not the game's twenty-eight: the last two are the overscan a
   * television would crop, and they are exactly where this console goes wrong. A
   * level the nametable holds whole cannot scroll vertically — thirty rows of map
   * against thirty of raster leave nothing to scroll into but the level's own top
   * — so the renderer pins the vertical scroll, and the rows the game camera has
   * "scrolled past" have to still show the level's own bottom.
   */
  function mismatches(
    machine: Nes,
    rom: Uint8Array,
    tables: { grid: number; tiles: number },
    size: { width: number; height: number },
    camera: { column: number; row: number },
  ): number {
    const prg = (address: number): number => rom[16 + (address - 0x8000)] as number;
    const expected = (column: number, row: number): number => {
      if (column < 0 || row < 0 || column >= size.width || row >= size.height) return 0;
      const legend = prg(tables.grid + row * size.width + column);
      return legend === 0xff ? 0 : prg(tables.tiles + legend);
    };
    // The renderer's origin, which is the camera's only where the level is tall
    // enough to scroll a row into.
    const originRow = size.height > 30 ? camera.row : 0;
    let bad = 0;
    for (let screenRow = 0; screenRow < 30; screenRow += 1) {
      for (let screenColumn = 0; screenColumn < 32; screenColumn += 1) {
        const column = camera.column + screenColumn;
        const row = originRow + screenRow;
        const mapColumn = column % 64;
        const table = mapColumn >= 32 ? 1 : 0;
        const got = machine.ppu.nametables[table * 0x400 + (row % 30) * 32 + (mapColumn % 32)];
        if (got !== expected(column, row)) bad += 1;
      }
    }
    return bad;
  }

  /** The vertical scroll the PPU is actually being given. */
  function scrollRow(machine: Nes): number {
    return Math.floor(machine.ppu.scrollY / 8);
  }

  /** Where the camera is, in whole cells, read out of the runtime's own state. */
  function cameraCells(machine: Nes, address: number): { column: number; row: number } {
    const bytes = machine.readMemory(address, 8);
    const axis = (at: number): number =>
      Math.floor(
        ((bytes[at] as number) |
          ((bytes[at + 1] as number) << 8) |
          ((bytes[at + 2] as number) << 16) |
          ((bytes[at + 3] as number) << 24) |
          0) /
          65536,
      );
    return { column: axis(0), row: axis(4) };
  }

  it("paints a level that fits the nametable pair once, and scrolls it with registers", async () => {
    const program = build("caves", {
      "cavern.dmtl": projectText("caves", "levels/cavern.dmtl"),
    });
    const built = await buildNesRom(program);
    const machine = new Nes(built.bytes);
    for (let frame = 0; frame < 30; frame += 1) machine.runFrame();
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 6; frame += 1) machine.runFrame();
    machine.setButtons([]);
    for (let frame = 0; frame < 60; frame += 1) machine.runFrame();

    const level = program.scenes.find((scene) => scene.level)?.level;
    expect(level).toBeDefined();
    const tables = {
      grid: built.symbols.get("LevelGrid_0") as number,
      tiles: built.symbols.get("LevelTiles_0") as number,
    };
    const size = { width: level?.width ?? 0, height: level?.height ?? 0 };
    const camera = built.layout.camera as number;
    expect(mismatches(machine, built.bytes, tables, size, cameraCells(machine, camera))).toBe(0);

    // And again after the camera has travelled, which is where a wrap computed at
    // the wrong modulus would show.
    machine.setButtons(["right"]);
    for (let frame = 0; frame < 120; frame += 1) machine.runFrame();
    machine.setButtons([]);
    for (let frame = 0; frame < 4; frame += 1) machine.runFrame();
    const moved = cameraCells(machine, camera);
    expect(moved.column).toBeGreaterThan(0);
    expect(mismatches(machine, built.bytes, tables, size, moved)).toBe(0);

    // The game camera really has travelled down this level — it is thirty rows
    // against a twenty-eight-row screen — and the PPU has not, which is the whole
    // of why the bottom of the screen is the cavern's floor and not its ceiling.
    expect(moved.row).toBeGreaterThan(0);
    expect(scrollRow(machine)).toBe(0);
  });

  it("keeps a level wider than the pair correct as the edge painter walks it", async () => {
    // Written here rather than taken from the example library, because none of
    // those levels is wider than the nametable pair — the caves fit it, and the
    // runner's course is wide but its bird never flies far enough for the camera
    // to leave the clamp. So the edge painter, which is the whole of NES
    // scrolling, would otherwise be the one path nothing exercised.
    const columns = 80;
    const rows = 30;
    const grid = Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (_, column) =>
        // A pattern with a long period on both axes, so a column painted one cell
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
      "create mover walker in play (x 2, y 15, xdirection 1)",
      "",
    ].join("\n");

    const program = compile(source, {
      profile: getProfile("nes"),
      levels: { "wide.dmtl": level },
    });
    const built = await buildNesRom(program);
    expect(program.scenes[0]?.level?.width).toBeGreaterThan(64);

    const machine = new Nes(built.bytes);
    for (let frame = 0; frame < 40; frame += 1) machine.runFrame();
    const tables = {
      grid: built.symbols.get("LevelGrid_0") as number,
      tiles: built.symbols.get("LevelTiles_0") as number,
    };
    const size = { width: columns, height: rows };
    const camera = built.layout.camera as number;
    let travelled = 0;
    for (let step = 0; step < 32; step += 1) {
      for (let frame = 0; frame < 8; frame += 1) machine.runFrame();
      const where = cameraCells(machine, camera);
      travelled = Math.max(travelled, where.column);
      expect(
        mismatches(machine, built.bytes, tables, size, where),
        `camera at column ${where.column}`,
      ).toBe(0);
    }
    // The camera really did cross into the second nametable and out the far side,
    // which is what makes the wrap part of what was checked.
    expect(travelled).toBeGreaterThan(32);
  });

  it("writes a caption in an ink the backdrop it sits on is not", async () => {
    const program = build("caves", {
      "cavern.dmtl": projectText("caves", "levels/cavern.dmtl"),
    });
    const assets = new Map(
      ["hero", "coin", "rockwall", "spikes", "exit", "stone", "air"].map((name) => [
        `${name}.svg`,
        projectBytes("caves", `art/${name}.svg`),
      ]),
    );
    const built = await buildNesRom(program, { assets });
    const machine = new Nes(built.bytes);
    for (let frame = 0; frame < 40; frame += 1) machine.runFrame();
    // No palette is reserved for the font any more — the caption goes in whichever
    // one the picture left a colour slot in — so the test asks the build which it
    // chose rather than assuming the last. The ink is colour three of it, and the
    // backdrop every palette shares is colour zero.
    // This build supplies object art but no title picture, so there is no palette
    // pressure and the font keeps the reserved one; a scene *with* a picture is
    // told which palette the fit left room in.
    const bound = await bindNesArt(program, assets);
    const font = bound.options.backdrops?.get("title")?.fontPalette ?? SYSTEM_PALETTE;
    const backdrop = machine.ppu.palette[0] as number;
    const ink = machine.ppu.palette[font * 4 + 3] as number;
    expect(ink).not.toBe(backdrop);
    // And it is a real difference, not a neighbouring shade of the same colour.
    expect(contrast(ink, backdrop)).toBeGreaterThan(60);
  });
});

/** How far apart two master-palette entries look, as Rec. 601 luma. */
function contrast(a: number, b: number): number {
  const master = getConsole("nes").color.masterPalette ?? [];
  const luma = (code: number): number => {
    const colour = master[code & 0x3f];
    return colour ? 0.299 * colour.r + 0.587 * colour.g + 0.114 * colour.b : 0;
  };
  return Math.abs(luma(a) - luma(b));
}
