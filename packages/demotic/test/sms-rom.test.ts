/**
 * What the Sega build is, beyond playing the same game.
 *
 * Trace conformance is in `rom.test.ts`, over the same battery every other
 * console runs — that is where "the Master System plays the game the interpreter
 * defines" is settled. Here are the things only this console has, and each is
 * here because getting it wrong produces a cartridge that traces perfectly and
 * looks wrong:
 *
 *   - **The tile bank has to arrive.** Characters are video RAM here, not
 *     cartridge, so boot uploads them. A build whose upload was short, or
 *     addressed the wrong place, would still tick correctly and draw nothing.
 *   - **The name table against the level grid.** A framebuffer comparison needs
 *     a libretro core (doc 10); what is available here is better for finding
 *     this class of bug anyway, because it names the cell. Every visible cell is
 *     checked against what the level says should be there, before and after the
 *     camera has travelled — which is what catches an edge painter that walks
 *     the wrong column, or a wrap computed at the wrong modulus.
 *   - **The seam, and the mask that hides it.** The name table is exactly as
 *     wide as a Master System's screen, so a scrolling scene there writes its new
 *     column into the cell straddling the left edge. The mask is what makes that
 *     invisible, and it must be off for a scene that does not scroll — and for a
 *     Game Gear, whose window is twenty of the same thirty-two columns and which
 *     therefore has no seam to hide.
 *   - **The reserved colours.** There is no third palette to keep back for the
 *     font, so three entries at the top of the sprite bank are the reservation —
 *     and a caption is only legible if the art's fit never reaches them.
 *   - **The two machines agree.** A Game Gear build is the same machine code as
 *     a Master System one; only the window and the width of a colour differ.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SMS_HEADER_OFFSET, SMS_ROM_SIZE, segaChecksum } from "@demake/core";
import { Sms } from "@demake/sms";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { builtinSega, BUILTIN_TILES, SEGA_TILE_BYTES } from "../src/rom/graphics.js";
import { bindSmsArt } from "../src/codegen/sms-art.js";
import { buildSmsRom, CODE_SIZE } from "../src/codegen/sms.js";
import { packCells, SYSTEM_INK } from "../src/codegen/sms/emit.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");
const asset = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));

function build(file: string, levels?: Record<string, string>, consoleId = "sms") {
  return compile(read(file), { profile: getProfile(consoleId), levels });
}

/** Boot a cartridge and run it until the runtime says it has finished booting. */
function boot(bytes: Uint8Array, bootedAt: number): Sms {
  const machine = new Sms(bytes);
  for (let guard = 0; guard < 4_000_000; guard += 1) {
    if (machine.readMemory(bootedAt, 1)[0] !== 0) return machine;
    machine.stepInstruction();
  }
  throw new Error("sms: the runtime never finished initialising");
}

/** The name-table entry at a cell: its tile number and its attribute byte. */
function entryAt(machine: Sms, column: number, row: number): { tile: number; attr: number } {
  const at = 0x3800 + ((row % 28) * 32 + (column % 32)) * 2;
  return {
    tile: (machine.vdp.vram[at] as number) | (((machine.vdp.vram[at + 1] as number) & 1) << 8),
    attr: machine.vdp.vram[at + 1] as number,
  };
}

describe("the Sega cartridge", async () => {
  const built = await buildSmsRom(build("pong.dmt"));

  it("is a 32 KiB image with the header stamped inside it", () => {
    expect(built.bytes.length).toBe(SMS_ROM_SIZE);
    const magic = String.fromCharCode(
      ...built.bytes.subarray(SMS_HEADER_OFFSET, SMS_HEADER_OFFSET + 8),
    );
    expect(magic).toBe("TMR SEGA");
    const stored =
      (built.bytes[SMS_HEADER_OFFSET + 10] as number) |
      ((built.bytes[SMS_HEADER_OFFSET + 11] as number) << 8);
    expect(segaChecksum(built.bytes)).toBe(stored);
  });

  it("keeps the game clear of the header rather than letting it be overwritten", () => {
    // The sixteen bytes at $7FF0 are inside the address space, so they come out
    // of the game's budget — and the build has to know that before the emitter
    // runs into them.
    expect(CODE_SIZE).toBe(SMS_HEADER_OFFSET);
    expect(built.stats.bytes).toBeLessThan(CODE_SIZE);
  });

  it("puts its two handlers on the vectors the hardware dispatches to", () => {
    expect(built.symbols.get("Irq")).toBe(0x0038);
    expect(built.symbols.get("Nmi")).toBe(0x0066);
    // And the first instruction is a jump over them, because the Z80 resets to
    // zero rather than taking an entry point from a table.
    expect(built.bytes[0]).toBe(0xf3); // di
    expect(built.bytes[1]).toBe(0xc3); // jp
  });

  it("declares a Master System or a Game Gear from the console it was built for", async () => {
    expect((built.bytes[SMS_HEADER_OFFSET + 15] as number) >> 4).toBe(4); // export SMS
    const gg = await buildSmsRom(build("pong.dmt", undefined, "gg"));
    expect((gg.bytes[SMS_HEADER_OFFSET + 15] as number) >> 4).toBe(7); // international GG
    expect(new Sms(gg.bytes).gameGear).toBe(true);
    expect(new Sms(built.bytes).gameGear).toBe(false);
  });
});

describe("what boot leaves in the video hardware", async () => {
  const built = await buildSmsRom(build("pong.dmt"));
  const machine = boot(built.bytes, built.layout.booted);

  it("uploads the built-in bank to the address the registers point at", () => {
    const builtin = builtinSega(SYSTEM_INK);
    expect([...machine.vdp.vram.subarray(0, builtin.length)]).toEqual([...builtin]);
  });

  it("points the three tables where the renderer addresses them", () => {
    expect(((machine.vdp.registers[2] as number) & 0x0e) << 10).toBe(0x3800);
    expect(((machine.vdp.registers[5] as number) & 0x7e) << 7).toBe(0x3f00);
    // Sprites share the background's bank, which is what lets a HUD glyph be the
    // same tile on either layer.
    expect(((machine.vdp.registers[6] as number) & 0x04) << 11).toBe(0x0000);
  });

  it("turns the display and the frame interrupt on, and the line counter off", () => {
    expect((machine.vdp.registers[1] as number) & 0x60).toBe(0x60);
    expect((machine.vdp.registers[0] as number) & 0x10).toBe(0x00);
  });

  it("reserves the top of the sprite bank for the font, whatever the art chose", async () => {
    // Objects only: the reservation is the *sprite* fit's, and a backdrop would
    // put the whole `prep` tournament in a unit test for nothing.
    const art = await buildSmsRom(build("pong.dmt"), {
      assets: new Map([
        ["ball.svg", asset("ball.svg")],
        ["paddle.svg", asset("paddle.svg")],
      ]),
    });
    const withArt = boot(art.bytes, art.layout.booted);
    const ramp = [16 + SYSTEM_INK - 2, 16 + SYSTEM_INK - 1, 16 + SYSTEM_INK].map(
      (entry) => withArt.vdp.cram[entry] as number,
    );
    // A rising ramp, and the ink brighter than anything below it — which is the
    // whole of "a caption stays legible over art whose palette was chosen for
    // the art".
    expect(ramp[0]).toBeLessThan(ramp[1] as number);
    expect(ramp[1]).toBeLessThan(ramp[2] as number);
    expect(ramp[2]).toBe(0x3f);
  });

  it("draws something, rather than a screen of one colour", () => {
    // Three frames, not one: `runFrame` stops at the *next* frame boundary, so
    // the first call after boot renders only the lines below wherever the boot
    // sequence happened to leave the beam. Everything above them is still the
    // blank the display-off period drew.
    for (let frame = 0; frame < 3; frame += 1) machine.runFrame();
    const seen = new Set<string>();
    for (let at = 0; at < machine.framebuffer.length; at += 4) {
      seen.add(`${machine.framebuffer[at]},${machine.framebuffer[at + 1]}`);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("the name table against the level", async () => {
  const levels = { "cavern.dmtl": read(join("games", "cavern.dmtl")) };
  const source = read(join("games", "caves.dmt"));
  const program = compile(source, { profile: getProfile("sms"), levels });
  const built = await buildSmsRom(program);

  /** Run the scene forward, pressing whatever the caller asks for. */
  function play(down: readonly string[], ticks: number): Sms {
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["start"]);
    machine.runFrame();
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 4; frame += 1) machine.runFrame();
    machine.setButtons(down as never);
    for (let frame = 0; frame < ticks; frame += 1) machine.runFrame();
    return machine;
  }

  it("masks the seam column only where the level really scrolls sideways", async () => {
    const scrolling = play(["right"], 60);
    expect((scrolling.vdp.registers[0] as number) & 0x20).toBe(0x20);
    // Pong's court is exactly the screen, so nothing is masked there.
    const still = await buildSmsRom(build("pong.dmt"));
    const stillMachine = boot(still.bytes, still.layout.booted);
    stillMachine.runFrame();
    expect((stillMachine.vdp.registers[0] as number) & 0x20).toBe(0x00);
  });

  it("settles on a scrolled picture rather than repainting it every frame", () => {
    // The renderer only repaints everything when the camera jumps further than
    // it can walk. A HUD counter that scribbled on the map origin made *every*
    // frame look like a teleport — the game played correctly and turned the
    // display off and on sixty times a second.
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
    // The horizontal register carries the negated camera, so a camera that has
    // travelled right leaves a register below 256 and above zero.
    const scrollX = machine.vdp.registers[8] as number;
    const camera = built.layout.camera as number;
    const cameraPixels = Math.floor(
      (((machine.readMemory(camera + 2, 1)[0] as number) |
        ((machine.readMemory(camera + 3, 1)[0] as number) << 8)) *
        8) %
        256,
    );
    expect(scrollX).toBe((-cameraPixels + 512) & 0xff);
  });

  it("draws every visible cell from the level's own grid", () => {
    // Ninety frames, not four: the scene opens with the player falling, and a
    // camera moving more than four cells in a tick is a teleport rather than a
    // scroll — the renderer asks for a full redraw next frame instead of tearing.
    // Comparing before it has settled would be comparing against a picture the
    // runtime has already decided to throw away.
    const machine = play([], 90);
    const scene = program.scenes.find((entry) => entry.level !== undefined);
    const level = scene?.level;
    expect(level).toBeDefined();
    if (!level) return;

    // The window the renderer painted, in level cells. Both origins come from
    // the camera, because a level bigger than the screen scrolls on both axes
    // and checking rows from zero would compare cells nothing ever drew.
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
        // An empty cell draws tile zero; a named one draws its legend's pattern.
        const entry = entryAt(machine, column, row);
        if (cell === " ") expect(entry.tile).toBe(0);
        else expect(entry.tile).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("draws the built-in patterns in the font's colour bank and art in the other", () => {
    const machine = play([], 90);
    // Nothing in this build has art, so every non-blank cell is a built-in
    // pattern and every one of them names bank 1.
    let patterns = 0;
    for (let column = 0; column < 32; column += 1) {
      for (let row = 0; row < 24; row += 1) {
        const entry = entryAt(machine, column, row);
        if (entry.tile === 0) continue;
        expect(entry.tile).toBeLessThan(BUILTIN_TILES);
        expect(entry.attr & 0x08).toBe(0x08);
        patterns += 1;
      }
    }
    expect(patterns).toBeGreaterThan(0);
  });
});

/**
 * The edge painter, on a level that scrolls both ways on both machines.
 *
 * Written here rather than taken from the example library for the same reason
 * the NES suite writes its own: the caves are the only level that scrolls, and a
 * hero that falls into spikes cannot be walked back the way it came — so
 * *leaving* a column behind and coming back to it was the one direction nothing
 * exercised. It is also the direction the two machines disagree about.
 *
 * What is checked is one cell past the window as well as the window itself,
 * because the scroll registers move by pixels: any camera that is not a whole
 * number of cells along shows a sliver of the next column and the next row, and
 * a cell nothing ever painted shows whatever the last scene left there. A Master
 * System's near column is the exception and is skipped — it shares its cell with
 * the far sliver and is masked for exactly that reason.
 */
describe("the edge painter on both machines", () => {
  const columns = 80;
  const rows = 30;
  // A pattern with a long period on both axes, so a column painted one cell out
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
    "create mover walker in play (x 40, y 15)",
    "",
    "control walker left (xdirection -1) on hold",
    "control walker right (xdirection 1) on hold",
    "control walker up (ydirection -1) on hold",
    "control walker down (ydirection 1) on hold",
    "",
  ].join("\n");

  for (const consoleId of ["sms", "gg"] as const) {
    it(`keeps every cell the ${consoleId} window can show painted from the grid`, async () => {
      const program = compile(source, { profile: getProfile(consoleId), levels });
      const built = await buildSmsRom(program);
      const { viewW, viewH } = built.layout.memory;
      const camera = built.layout.camera as number;
      const machine = boot(built.bytes, built.layout.booted);

      const originOf = (offset: number): number =>
        (machine.readMemory(camera + offset + 2, 1)[0] as number) |
        ((machine.readMemory(camera + offset + 3, 1)[0] as number) << 8);

      // A Master System's screen is the whole name table, so the near column and
      // the far sliver are one cell — masked, and holding whichever of the two the
      // last paint put there. Both are therefore skipped, which leaves exactly the
      // columns the screen really shows. A Game Gear has a cell for each.
      const spare = viewW < 32;
      const first = spare ? 0 : 1;
      const last = spare ? viewW : viewW - 1;

      const check = (where: string): void => {
        const originCol = originOf(0);
        const originRow = originOf(4);
        for (let row = originRow; row <= originRow + viewH; row += 1) {
          for (let column = originCol + first; column <= originCol + last; column += 1) {
            if (column >= columns || row >= rows) continue;
            const blank = (grid.split("\n")[row] ?? "")[column] === " ";
            const entry = entryAt(machine, column, row);
            const drawn = entry.tile !== 0;
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
        // A full redraw runs with the display off and spans several frames, so a
        // scene is compared once it has settled rather than part-way through the
        // picture the runtime is still painting.
        machine.setButtons([] as never);
        for (let frame = 0; frame < 40; frame += 1) machine.runFrame();
      };

      travel([], 20);
      check("at rest");
      // Out and back on each axis in turn, then both at once: a diagonal step
      // paints a column and a row in the same tick, which is the case the queue
      // is sized for.
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
  }
});

describe("objects", async () => {
  const built = await buildSmsRom(build("pong.dmt"));

  it("ends the sprite list where the frame stopped filling it", () => {
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
    const sat = 0x3f00;
    let drawn = 0;
    while (drawn < 64 && (machine.vdp.vram[sat + drawn] as number) !== 0xd0) drawn += 1;
    // Pong in play is a ball and two paddles: one cell and three cells each.
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(64);
    // Everything the frame drew has a tile number inside the bank.
    for (let index = 0; index < drawn; index += 1) {
      const tile = machine.vdp.vram[sat + 0x80 + index * 2 + 1] as number;
      expect(tile).toBeLessThan(256);
    }
  });

  it("puts the art the image engine demade in the bank, not the placeholder block", async () => {
    const art = await buildSmsRom(build("pong.dmt"), {
      assets: new Map([
        ["ball.svg", asset("ball.svg")],
        ["paddle.svg", asset("paddle.svg")],
      ]),
    });
    expect(art.stats.artTiles).toBeGreaterThan(0);
    const machine = boot(art.bytes, art.layout.booted);
    // The bank past the built-in tiles is not blank, which is what says the
    // upload carried the demade art rather than stopping at the font.
    const start = BUILTIN_TILES * SEGA_TILE_BYTES;
    const end = start + art.stats.artTiles * SEGA_TILE_BYTES;
    const ink = machine.vdp.vram.subarray(start, end).some((byte) => byte !== 0);
    expect(ink).toBe(true);
  });
});

describe("a demade backdrop", async () => {
  // The one place in this file that pays for a real `prep` tournament, because
  // there is no cheaper oracle for it: what reaches the name table is the picture
  // after a pool, an encoding and an unpacker, and every one of those has been
  // wrong. A Game Gear, because its window is the smaller picture of the two.
  const assets = new Map([
    ["pong.title.svg", asset("pong.title.svg")],
    ["ball.svg", asset("ball.svg")],
    ["paddle.svg", asset("paddle.svg")],
  ]);
  const built = await buildSmsRom(build("pong.dmt", undefined, "gg"), { assets });
  const art = await bindSmsArt(build("pong.dmt", undefined, "gg"), assets, "gg");
  const machine = boot(built.bytes, built.layout.booted);
  for (let frame = 0; frame < 4; frame += 1) machine.runFrame();

  it("puts the picture in the name table, flips and all", () => {
    // Cell for cell against the map the build produced — the *whole* entry, not
    // just the tile number. This layout is flip-aware, so the fitter stores one
    // tile for up to four orientations and says which in bits 1 and 2; dropping
    // them costs the right-hand end of every mirrored brick, ledge and letter.
    // The encoding between the two is deliberately not checked: what is
    // guaranteed is the bytes that reach the VDP.
    const map = art.options.backdrops?.get("title")?.map;
    expect(map).toBeDefined();
    if (!map) return;
    let flipped = 0;
    for (let row = 0; row < built.layout.memory.viewH; row += 1) {
      for (let column = 0; column < built.layout.memory.viewW; column += 1) {
        const cell = (row * 32 + column) * 2;
        const at = 0x3800 + cell;
        // The caption the title screen writes over the picture is the runtime's,
        // so only the cells the picture owns are compared.
        if ((machine.vdp.vram[at + 1] as number) & 0x08) continue;
        expect([machine.vdp.vram[at], machine.vdp.vram[at + 1]]).toEqual([
          map[cell],
          map[cell + 1],
        ]);
        if (((map[cell + 1] as number) & 0x06) !== 0) flipped += 1;
      }
    }
    // And the picture really does use them, or the check above proves nothing.
    expect(flipped).toBeGreaterThan(0);
  });

  it("stores that picture packed, because a name table is cartridge", () => {
    // The counterpart of the NES's assertion, and the reason the check above
    // reads the VDP rather than the ROM: two screenfuls stored raw were a tenth
    // of a mapper-less Sega cartridge.
    const map = art.options.backdrops?.get("title")?.map as Uint8Array;
    expect(packCells(map).length).toBeLessThan(map.length * 0.8);
  });

  it("uploads both colour banks, in the bytes this machine spends on a colour", () => {
    // A Game Gear colour is two bytes, so counting *colours* into a Master
    // System-sized loop leaves the whole sprite bank — every object in the game,
    // and the paper a caption is read on — unwritten.
    const palette = art.options.scenePalettes?.get("title");
    expect(palette?.length).toBe(64);
    expect([...machine.vdp.cram]).toEqual([...(palette as Uint8Array)]);
  });

  it("gives a scene without a picture the build's own palette, not the last one's", () => {
    // Pong's ending scenes have no backdrop. Uploading nothing there would leave
    // colour RAM holding whichever title screen the player arrived from, which is
    // how a level comes out in a title screen's colours.
    const ending = new Sms(built.bytes);
    for (let guard = 0; guard < 4_000_000; guard += 1) {
      if (ending.readMemory(built.layout.booted, 1)[0] !== 0) break;
      ending.stepInstruction();
    }
    ending.setButtons(["a"]);
    for (let frame = 0; frame < 4; frame += 1) ending.runFrame();
    expect([...ending.vdp.cram]).not.toEqual([...(art.options.scenePalettes?.get("title") ?? [])]);
    expect([...ending.vdp.cram]).toEqual([...(art.options.palette as Uint8Array)]);
  });
}, 120_000);

describe("the two machines", async () => {
  it("compile to the same code, and differ only in the window and the colours", async () => {
    const sms = await buildSmsRom(build("pong.dmt"));
    const gg = await buildSmsRom(build("pong.dmt", undefined, "gg"));
    // Not byte-identical — the window's size reaches the renderer as constants,
    // and the header declares a different machine — but the same size to within
    // the handful of immediates that differ.
    expect(Math.abs(sms.stats.bytes - gg.stats.bytes)).toBeLessThan(200);
    expect(sms.stats.ram).toBe(gg.stats.ram);
    // And the Game Gear's colour RAM is twice as wide, which is the one place
    // the emitter asks which console it is.
    expect(new Sms(gg.bytes).vdp.cram.length).toBe(64);
    expect(new Sms(sms.bytes).vdp.cram.length).toBe(32);
  });
});
