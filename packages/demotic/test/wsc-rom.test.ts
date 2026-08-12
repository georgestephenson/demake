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
 *   - **The digits themselves.** This is the one backend whose decimal renderer
 *     divides rather than subtracting in a loop, and no fixture reaches an
 *     interior zero, the widest value the language allows and a negative number
 *     in one run — so the numbers are put on the screen deliberately and read
 *     back off it.
 */

import { describe, expect, it } from "vitest";

import {
  wsChecksum,
  wsSaveCode,
  WS_CODE_SIZE,
  WS_ENTRY_OFFSET,
  WS_ROM_SIZE,
  WS_SAVE_SEGMENT,
} from "@demake/core";
import { PORT, Wsc } from "@demake/wsc";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { buildWscRom, CARTRIDGE_SIZE } from "../src/codegen/wsc.js";
import { bindWscArt } from "../src/codegen/wsc-art.js";
import { MAP_H, MAP_W, SYSTEM_OBJECT_PALETTE, SYSTEM_PALETTE } from "../src/codegen/wsc/emit.js";
import { WS_MACHINE, WSC_MACHINE } from "../src/codegen/wsc/machine.js";

/** Where the colour machine keeps everything the display reads. */
const RAM = WSC_MACHINE.ram;
/** And where its palettes go — RAM here, ports on the mono machine. */
const PALETTE_RAM = "ram" in WSC_MACHINE.palette ? WSC_MACHINE.palette.ram : 0;
import { BUILTIN_TILES, glyphTile, patternTile } from "../src/rom/graphics.js";
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

  it("measures headroom against the whole cartridge, not the mapped bank", () => {
    // It used to be the bank, and that was right for as long as a game bigger
    // than one segment was refused. A game bigger than one segment now spreads
    // across the ones below it (doc 13 §Banked cartridges), so a figure that
    // stopped at `$FFF0` would report a game getting bigger as a game with less
    // room and then jump by most of a megabyte when it crossed.
    expect(CARTRIDGE_SIZE).toBe(WS_ROM_SIZE - 16);
    expect(built.stats.bytes).toBeLessThan(CARTRIDGE_SIZE);
    expect(built.stats.free).toBe(CARTRIDGE_SIZE - built.stats.bytes);
    expect(built.stats.cartridge).toBe(WS_ROM_SIZE);
  });

  it("keeps this game inside the one segment it resets into", () => {
    // Which is the number that still bites: a fixture that outgrew `WS_CODE_SIZE`
    // would start spreading across segments — three assembly passes and a copy of
    // its tables per segment — for a game the library says should fit one.
    expect(built.stats.bytes).toBeLessThan(WS_CODE_SIZE);
    expect(WS_CODE_SIZE - built.stats.bytes).toBeGreaterThan(1024);
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
      const at = PALETTE_RAM + palette * 32;
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
    // half the window, which at 75.47 Hz is most of two seconds. Long enough for
    // that and no longer — the spikes are twenty-six cells along, and a hero that
    // reaches them is a `gameover` scene with no level in it.
    machine.setButtons(["right"]);
    settle(machine, 130);
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
    for (let frame = 0; frame < 130; frame += 1) {
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
    // Back the way it came, so the camera moves without walking the hero into
    // the spikes the previous case stopped short of.
    machine.setButtons(["left"]);
    settle(machine, 40);
    machine.setButtons([]);
    settle(machine, 2);
    expect(machine.readPort(PORT.SCR1_X)).not.toBe(scrolled);
    expect(occupied()).toBe(before);
  });
});

describe("the decimal renderer", async () => {
  // Its own program rather than a fixture's counter, because what has to be
  // checked is the *digits* — and no example game reaches an interior zero, the
  // widest value the language allows, or a negative number in the same run. A
  // `number` whose value nothing can change is painted once with the display off,
  // through the same routine the per-frame HUD calls, so one still frame proves
  // both. 1024 is the widest there is: every value is clamped to ±1024 cells
  // (doc 14 §3), so four digits and a sign is the whole vocabulary.
  const source = [
    "start play",
    "scene play",
    "create number small in play (value 7, x 1, y 1)",
    "create number wide in play (value 1024, x 1, y 3)",
    "create number down in play (value -915, x 1, y 5)",
    "create number none in play (value 0, x 1, y 7)",
  ].join("\n");
  const built = await buildWscRom(compile(source, { profile: getProfile("wsc") }));
  const machine = boot(built.bytes, built.layout.booted);
  settle(machine, 4);

  /** The glyphs painted along a row of the HUD plane, as the string they spell. */
  function readRow(row: number, length: number): string {
    let out = "";
    for (let column = 1; column <= length; column += 1) {
      const tile = entryAt(machine, RAM.SCR2, column, row).tile;
      const found = [..."-0123456789"].find((c) => glyphTile(c) === tile);
      out += found ?? "?";
    }
    return out;
  }

  it("prints a number with no leading zero and no missing one", () => {
    // Four cases the subtraction loop this replaced got right by suppressing
    // leading zeroes, and the division loop gets right by never producing them:
    // a single digit, four with an interior zero, a sign, and zero itself.
    expect(readRow(1, 1)).toBe("7");
    expect(readRow(3, 4)).toBe("1024");
    expect(readRow(5, 4)).toBe("-915");
    expect(readRow(7, 1)).toBe("0");
  });

  it("leaves the cell after the last digit alone", () => {
    // The pen advances once per glyph, so a number that got shorter must not
    // leave the tail of the longer one behind it — and a shorter number must not
    // have painted past its own end in the first place.
    expect(entryAt(machine, RAM.SCR2, 2, 1).tile).toBe(0);
    expect(entryAt(machine, RAM.SCR2, 5, 5).tile).toBe(0);
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

/**
 * The mono machine, and every case here is one it alone can get wrong.
 *
 * The instructions are the colour machine's — `rom.test.ts` runs the whole
 * example library on both and says so tick for tick — so what is left to check
 * is the four things `codegen/wsc/machine.ts` describes: where everything lives
 * in sixteen kilobytes rather than sixty-four, that a tile is planar 2bpp,
 * that palettes are *ports* rather than RAM, and that the footer says a mono
 * console can run this.
 */
describe("the mono WonderSwan", async () => {
  const monoRam = WS_MACHINE.ram;

  function buildMono(project: string) {
    const example = exampleProject(project);
    return compile(example.source, {
      profile: getProfile("ws"),
      files: example.files,
      levels: example.levels,
    });
  }

  /** Boot a mono cartridge, in the core told which machine it is. */
  function bootMono(bytes: Uint8Array, bootedAt: number): Wsc {
    const machine = new Wsc(bytes, "ws");
    for (let guard = 0; guard < 8_000_000; guard += 1) {
      if (machine.readMemory(bootedAt, 1)[0] !== 0) return machine;
      machine.stepInstruction();
    }
    throw new Error("ws: the runtime never finished initialising");
  }

  const built = await buildWscRom(buildMono("pong"), {
    assets: exampleProject("pong").assets,
  });

  it("says in its footer that a mono console can run it", () => {
    // The minimum-system byte is this console's `$C0`: a colour cartridge
    // refuses to run on a mono machine, and this one must not.
    const footer = WS_ROM_SIZE - 16;
    expect(built.bytes[footer + 1]).toBe(0);
  });

  it("keeps everything the display reads inside sixteen kilobytes", () => {
    // The whole reason this machine needs its own map: the colour one's tile
    // bank starts where this one's memory ends. Anything above `$3FFF` would be
    // written into an address the RAM chip does not decode.
    for (const address of Object.values(monoRam)) {
      expect(address).toBeLessThan(0x4000);
    }
    expect(monoRam.TILES + 512 * WS_MACHINE.tileBytes).toBe(0x4000);
    expect(WS_MACHINE.memory.heapEnd).toBeLessThanOrEqual(WS_MACHINE.stackTop);
  });

  it("copies a planar 2bpp bank into the top half of its RAM", () => {
    const machine = bootMono(built.bytes, built.layout.booted);
    settle(machine, 4);
    let written = 0;
    for (let at = monoRam.TILES; at < 0x4000; at += 1) {
      if ((machine.ram[at] as number) !== 0) written += 1;
    }
    // Nothing is uploaded through a port on this console, so a short copy is a
    // perfect game on a blank screen — which no trace can see.
    expect(written).toBeGreaterThan(200);
  });

  it("writes its palettes to ports, because it has no palette RAM", () => {
    const machine = bootMono(built.bytes, built.layout.booted);
    settle(machine, 4);
    // The shade pool at $1C-$1F and the sixteen palettes at $20-$3F. A pool of
    // all zeroes is eight copies of white, which is a screen with one shade on
    // it — the failure this asserts against, and one a register-free check for
    // "did anything get written" would miss.
    const pool: number[] = [];
    for (let port = 0x1c; port < 0x20; port += 1) {
      const byte = machine.readPort(port);
      pool.push(byte & 0x0f, (byte >> 4) & 0x0f);
    }
    expect(new Set(pool).size).toBe(8);
    for (const level of pool) expect(level).toBeLessThan(16);

    let palettes = 0;
    for (let port = 0x20; port < 0x40; port += 1) {
      if (machine.readPort(port) !== 0) palettes += 1;
    }
    expect(palettes).toBeGreaterThan(0);
  });

  it("keeps a palette of each kind for the font, as the colour machine does", async () => {
    const art = await bindWscArt(
      buildMono("pong"),
      exampleProject("pong").assets,
      undefined,
      undefined,
      WS_MACHINE,
    );
    for (const [name, block] of art.options.scenePalettes ?? []) {
      // Four pool bytes, then two bytes a palette: the font's two must carry an
      // ink whatever the picture wanted, or a caption is the colour it is
      // written on.
      for (const palette of [SYSTEM_PALETTE, SYSTEM_OBJECT_PALETTE]) {
        const at = 4 + palette * 2;
        expect(
          (block[at] as number) !== 0 || (block[at + 1] as number) !== 0,
          `${name} palette ${palette}`,
        ).toBe(true);
      }
    }
  }, 120000);

  it("brings a pool of its own for every scene with a picture", async () => {
    // The fact that makes this console's art work at all: the eight levels are
    // a *global* choice, so a scene's picture chooses them and the objects and
    // the font drawn over it ride along in whatever it picked. Two scenes with
    // different pictures must therefore differ in the first four bytes.
    const art = await bindWscArt(
      buildMono("pong"),
      exampleProject("pong").assets,
      undefined,
      undefined,
      WS_MACHINE,
    );
    const pools = [...(art.options.scenePalettes ?? []).values()].map((block) =>
      [...block.subarray(0, 4)].join(","),
    );
    expect(pools.length).toBeGreaterThan(1);
    for (const pool of pools) expect(pool).not.toBe("0,0,0,0");
  }, 120000);

  it("paints the picture at the hardware's row, as the colour machine does", () => {
    const machine = bootMono(built.bytes, built.layout.booted);
    settle(machine, 4);
    for (let row = 0; row < 18; row += 1) {
      for (let column = 28; column < MAP_W; column += 1) {
        const at = monoRam.SCR1 + ((row % MAP_H) * MAP_W + column) * 2;
        const word = (machine.ram[at] as number) | ((machine.ram[at + 1] as number) << 8);
        expect(word & 0x1ff, `row ${row} column ${column}`).toBe(0);
      }
    }
    let painted = 0;
    for (let row = 0; row < 18; row += 1) {
      for (let column = 0; column < 28; column += 1) {
        const at = monoRam.SCR1 + (row * MAP_W + column) * 2;
        const word = (machine.ram[at] as number) | ((machine.ram[at + 1] as number) << 8);
        if ((word & 0x1ff) !== 0) painted += 1;
      }
    }
    expect(painted).toBeGreaterThan(100);
  });

  it("draws more than one shade on the panel", () => {
    // The end-to-end claim: tiles in the right format, a pool that is a pool,
    // palettes that reached their ports. Any one of them wrong is a screen of
    // one colour, and every check above it passes on a picture nobody can see.
    const machine = bootMono(built.bytes, built.layout.booted);
    settle(machine, 8);
    const shades = new Set<number>();
    for (let at = 0; at < machine.framebuffer.length; at += 4) {
      shades.add(machine.framebuffer[at] as number);
    }
    expect(shades.size).toBeGreaterThan(3);
  });
});

/**
 * A game spread across segments, which is what `quest` is on this console.
 *
 * Every case here is one a trace cannot reach. The example tape enters one level
 * and a level's routines are all in the *first* paged segment, so a scene in the
 * second is compiled, placed, and never executed by any test that plays the game
 * — which is exactly where a wrong segment number hides. So this reads the
 * dispatches out of the finished cartridge and follows each of them.
 */
describe("a program bigger than one segment", async () => {
  const example = exampleProject("quest");
  const built = await buildWscRom(
    compile(example.source, {
      profile: getProfile("wsc"),
      files: example.files,
      levels: example.levels,
    }),
  );
  /** Where a segment's bytes are in the file, the way the hardware decodes it. */
  const fileAt = (segment: number, offset: number): number =>
    (((segment << 4) + offset) & (built.bytes.length - 1)) >>> 0;

  /**
   * Every far jump in the fixed segment, as (segment, offset).
   *
   * `$EA` is the only opcode this backend emits with an absolute far target, and
   * the dispatches are the only things that emit it — so scanning for it finds
   * exactly the transfers a scene is reached through, without the test having to
   * know where the four dispatch tables are.
   */
  const farJumps = (): { segment: number; offset: number }[] => {
    const base = built.bytes.length - 0x10000;
    const out: { segment: number; offset: number }[] = [];
    for (let at = 0; at < 0xfff0 - 5; at += 1) {
      if (built.bytes[base + at] !== 0xea) continue;
      const offset =
        (built.bytes[base + at + 1] as number) | ((built.bytes[base + at + 2] as number) << 8);
      const segment =
        (built.bytes[base + at + 3] as number) | ((built.bytes[base + at + 4] as number) << 8);
      // A paged segment is a whole bank below the fixed one, so it is a multiple
      // of `$1000` in `$8000`–`$EFFF`. Without that filter this finds every `$EA`
      // byte that happens to sit inside a table or another instruction's operand.
      if (segment >= 0x8000 && segment < 0xf000 && (segment & 0x0fff) === 0) {
        out.push({ segment, offset });
      }
    }
    return out;
  };

  it("spreads it across more than one segment, or this proves nothing", () => {
    // The premise. `quest` is 97 KiB against a 64 KiB segment; if it ever fits
    // one again, these cases stop testing anything and should be re-pointed.
    const segments = new Set(farJumps().map((jump) => jump.segment));
    expect(segments.size).toBeGreaterThan(1);
  });

  it("aims every far jump at code rather than at padding", () => {
    // The failure this is for: a segment number off by one lands sixteen bytes
    // into the right bank, and off by `$1000` lands in the wrong one — both of
    // which read as a scene that ticks perfectly until it is entered. A paged
    // segment is padded with `$FF`, which decodes as an invalid opcode, so
    // "the byte here is not padding" is the whole check and it is enough.
    const jumps = farJumps();
    expect(jumps.length).toBeGreaterThan(4);
    for (const { segment, offset } of jumps) {
      const byte = built.bytes[fileAt(segment, offset)] as number;
      expect(
        byte,
        `far jump to $${segment.toString(16)}:$${offset.toString(16)} lands on padding`,
      ).not.toBe(0xff);
    }
  });

  it("gives every segment its own copy of the tables its code reads", () => {
    // A segment reads a level grid and a pooled constant with a `cs:` override,
    // so a copy per segment is not an optimisation — it is the only thing those
    // reads can reach. The suffix is what tells the copies apart.
    const names = [...built.symbols.keys()];
    for (const stem of ["LevelGrid_0", "Defaults_0"]) {
      const copies = names.filter((name) => name === stem || name.startsWith(`${stem}_s`));
      expect(copies.length, `${stem} has ${copies.length} copies`).toBeGreaterThan(1);
    }
  });
});

/**
 * The one console in the set whose wall was work RAM rather than cartridge.
 *
 * A mono WonderSwan has sixteen kilobytes, of which the tile bank is the top
 * half and the display's own structures are most of the rest — 2 KiB of heap for
 * a game that wants six. No size of cartridge fixes that, so a game too big for
 * it puts its **whole heap** in the cartridge's save RAM at segment `$1` and
 * points `DS` and `ES` there (`codegen/layout.ts` §WS_SAVE_MEMORY).
 *
 * Trace conformance for that build is `rom.test.ts`'s, and it settles rather a
 * lot: the game's variables are in a different memory from its picture, so every
 * property read, every collision box staged and every cell walked is in the
 * cartridge while the six operands the display decodes are not. What is here is
 * what a trace cannot see — that the split really happened, that the cartridge
 * says so in the byte a console reads to decide whether there is a chip at
 * segment `$1` at all, and that nothing the *display* reads moved with it.
 *
 * This is also the build that is banked and has a picture, which is the pair no
 * other case in this file makes: `quest` is bigger than a segment on both
 * machines, and a backdrop is read by a helper in the fixed half rather than by
 * the scene that asked for it.
 */
describe("a game the console's own memory cannot hold", async () => {
  const example = exampleProject("quest");
  // Art only. The audio demakers are minutes on this fixture and prove nothing
  // here — `audio-ws.test.ts` runs the whole register battery on this same
  // build — but a *picture* is exactly what the backdrop case below needs.
  const art = new Map(
    [...example.assets].filter(([name]) => name.endsWith(".svg") || name.endsWith(".png")),
  );
  const built = await buildWscRom(
    compile(example.source, {
      profile: getProfile("ws"),
      files: example.files,
      levels: example.levels,
    }),
    { assets: art },
  );
  const machine = new Wsc(built.bytes, "ws");
  settle(machine, 16);

  it("puts its heap in the cartridge's save RAM, or nothing below is about that", () => {
    // The premise. If this game ever fits the console's own memory again these
    // cases stop testing anything and should be re-pointed.
    expect(built.layout.memory.heapSegment).toBe(WS_SAVE_SEGMENT);
    expect(built.layout.used).toBeGreaterThan(
      WS_MACHINE.memory.heapEnd - WS_MACHINE.memory.heapStart,
    );
  });

  it("declares the smallest save RAM the footer can name that holds it", async () => {
    // The elastic-board rule reaching the RAM: a board brings what the game
    // needs, not the largest thing the header can say. The footer's save byte is
    // at offset `$05` of the ten at the top of the cartridge.
    const footer = built.bytes.length - 10;
    expect(built.bytes[footer + 5]).toBe(wsSaveCode(built.layout.used));
    expect(built.bytes[footer + 5]).not.toBe(0x00);
    // And a game that fits declares none, which is what keeps every cartridge
    // that fitted before byte-identical.
    const small = await buildWscRom(
      compile(exampleProject("pong").source, {
        profile: getProfile("ws"),
        files: exampleProject("pong").files,
        levels: exampleProject("pong").levels,
      }),
    );
    expect(small.layout.memory.heapSegment).toBeUndefined();
    expect(small.bytes[small.bytes.length - 10 + 5]).toBe(0x00);
  });

  it("leaves everything the display reads in the console's own memory", () => {
    // What must *not* have moved with the heap: these are addresses the chip
    // decodes rather than addresses a program chooses. The registers are the
    // hardware's own record of where it is looking, so this asks the display
    // rather than the build.
    const monoRam = WS_MACHINE.ram;
    expect(machine.readPort(PORT.MAP_BASE)).toBe(
      (monoRam.SCR1 >> 11) | ((monoRam.SCR2 >> 11) << 4),
    );
    expect(machine.readPort(PORT.SPR_BASE)).toBe(monoRam.OAM >> 9);
    // And the tile bank arrived where the chip looks, in the console's memory —
    // a copy that followed the heap would leave the top half of sixteen
    // kilobytes as it powered up, which is a game nobody can see.
    const bank = machine.readMemory(monoRam.TILES, 0x2000);
    expect([...bank].some((byte) => byte !== 0)).toBe(true);
  });

  it("keeps a backdrop in the fixed half, where the routine that reads it is", () => {
    // A banked build gives each segment a copy of the tables its own code reads,
    // and what decides that is *who reads it* — which for a backdrop is not the
    // scene. `BlitBackdrop` is pulled like any other helper, so it lives in the
    // fixed segment and its `cs:` means the fixed segment however the scene that
    // called it got there. A copy in the scene's own segment sits at an offset
    // the helper cannot reach.
    const names = [...built.symbols.keys()];
    const copies = names.filter((name) => /^Backdrop_\d+(_s[0-9a-f])?$/.test(name));
    expect(copies.length).toBeGreaterThan(0);
    expect(copies.filter((name) => name.includes("_s"))).toEqual([]);
  });

  it("unpacks that picture into the plane rather than over the stack", () => {
    // The case above, end to end, and the failure it is for. Pointed at a paged
    // copy the blit read the fixed segment at that copy's offset — `$FF` padding
    // on this cartridge — and `$FF` is a run control byte, so it unpacked runs of
    // `$FFFF` upward through the screen maps and over the stack until the return
    // address was gone. The symptom was a wild jump several routines later, and
    // no trace could see it, because a picture is not state.
    const monoRam = WS_MACHINE.ram;
    const stack = machine.readMemory(WS_MACHINE.stackTop - 0x40, 0x40);
    expect([...stack].every((byte) => byte !== 0xff)).toBe(true);
    // And the picture really arrived: a title screen shows many distinct map
    // words where a blank plane shows one, and a blit that stopped early shows
    // them only in its first rows.
    const words = new Set<number>();
    const plane = machine.readMemory(monoRam.SCR1, MAP_W * MAP_H * 2);
    for (let row = 0; row < 18; row += 1) {
      for (let column = 0; column < 28; column += 1) {
        const at = (row * MAP_W + column) * 2;
        words.add((plane[at] as number) | ((plane[at + 1] as number) << 8));
      }
    }
    expect(words.size).toBeGreaterThan(16);
    const lastRow = 17 * MAP_W * 2;
    const bottom = new Set<number>();
    for (let column = 0; column < 28; column += 1) {
      const at = lastRow + column * 2;
      bottom.add((plane[at] as number) | ((plane[at + 1] as number) << 8));
    }
    expect(bottom.size).toBeGreaterThan(1);
  });
});
