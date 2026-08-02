/**
 * What the Nintendo DS build is, beyond playing the same game.
 *
 * Trace conformance is in `rom.test.ts`, which runs the whole example library on
 * this console alongside the other eight — and on this one it settles something
 * sharper than usual, because the *instructions* are the Game Boy Advance's.
 * `codegen/gba/machine.ts` makes the second console a description rather than a
 * seventh backend, so a trace that matched on one machine and not the other
 * would mean part of that description had leaked into the code a tick runs. It
 * matches.
 *
 * What is here is the description itself, and every case is one that a Game Boy
 * Advance build would pass while a Nintendo DS cartridge sat dark:
 *
 *   - **A `.nds` holds two programs**, and only the header says which bytes are
 *     whose. The ARM9's binary is *copied* into main RAM rather than run from a
 *     cartridge bus, so the entry and load addresses are data a loader obeys
 *     rather than a convention.
 *   - **Video RAM is banked, and a bank has to be pointed somewhere.** On the
 *     other machine background and object characters are one array with the
 *     objects on top; here they are two banks with a control byte each, so
 *     "uploaded to the right place" is a question with a different answer and a
 *     build that used the first console's object address would fill nothing.
 *   - **The engine has to be switched on and told to show what it draws.**
 *     `POWCNT1` gates the LCDs and the engine; `DISPCNT`'s display-mode field
 *     decides whether its output reaches the screen at all.
 *   - **The window is bigger**: thirty-two cells by twenty-four against thirty
 *     by twenty. A build that kept the first console's window would leave two
 *     columns and four rows of every scene unpainted, and no trace could see it.
 *   - **The loop waits on the beam**, because this machine's interrupt vector is
 *     inside data TCM and its base is a CP15 setting rather than an address. A
 *     wait that never released, or one that released twice a frame, is a game
 *     running at the wrong speed — which is the one thing that design has to get
 *     right.
 */

import { describe, expect, it } from "vitest";

import { NDS_ARM7_RAM, NDS_ARM9_RAM, NDS_HEADER_SIZE, ndsCrc16 } from "@demake/core";
import { Nds } from "@demake/nds";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { builtinGba, GBA_BUILTIN_TILES, objectBlockGba } from "../src/rom/graphics.js";
import { buildGbaRom } from "../src/codegen/gba.js";
import { SYSTEM_INK, SYSTEM_PAPER } from "../src/codegen/gba/emit.js";
import { NDS_MEMORY } from "../src/codegen/layout.js";
import { gameSource, projectText } from "./_projects.js";

/** Where the emitter puts the two maps, as byte offsets into background memory. */
const MAP_BASE = 0xc000;
const HUD_BASE = 0xe000;

/** The tile an empty cell draws: a transparent blank, not the space glyph. */
const NDS_BLANK = GBA_BUILTIN_TILES - 1;

function build(project: string, levels?: Record<string, string>) {
  return compile(gameSource(project), { profile: getProfile("nds"), levels });
}

/** Boot a cartridge and run it until the runtime says it has finished booting. */
function boot(bytes: Uint8Array, bootedAt: number): Nds {
  const machine = new Nds(bytes);
  for (let guard = 0; guard < 20_000_000; guard += 1) {
    if (machine.readMemory(bootedAt, 1)[0] !== 0) return machine;
    machine.stepInstruction();
  }
  throw new Error("nds: the runtime never finished initialising");
}

/**
 * The scrolling map's cell at a position, with the hardware's own block layout.
 *
 * Not `(row * 64 + column) * 2`: a 64×64 map is four 32×32 screen blocks a
 * kilobyte apart, which is the same fact the Game Boy Advance's map has because
 * it is the same engine.
 */
function cellAt(machine: Nds, column: number, row: number): number {
  const col = column & 63;
  const line = row & 63;
  const block = (col >= 32 ? 1 : 0) + (line >= 32 ? 2 : 0);
  const at = MAP_BASE + block * 0x800 + ((line & 31) * 32 + (col & 31)) * 2;
  return (machine.bankA[at] as number) | ((machine.bankA[at + 1] as number) << 8);
}

describe("the Nintendo DS cartridge", async () => {
  const built = await buildGbaRom(build("pong"), { title: "PONG" });
  const rom = built.bytes;
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);

  it("names both programs, and puts the ARM9's where the header says", () => {
    expect(view.getUint32(0x020, true)).toBe(NDS_HEADER_SIZE);
    expect(view.getUint32(0x024, true)).toBe(NDS_ARM9_RAM);
    expect(view.getUint32(0x028, true)).toBe(NDS_ARM9_RAM);
    expect(view.getUint32(0x02c, true)).toBeGreaterThan(0);
    // The second program exists and is not the first one's bytes: a cartridge
    // whose ARM7 length was zero would boot a processor into whatever the image
    // happened to hold there.
    expect(view.getUint32(0x038, true)).toBe(NDS_ARM7_RAM);
    expect(view.getUint32(0x03c, true)).toBeGreaterThan(0);
  });

  it("starts with the reset routine rather than a branch over a header", () => {
    // The one place this differs from the machine it shares an emitter with. A
    // Game Boy Advance's first word is a branch over its own 192-byte header;
    // here the header is a region in *front* of the image, so the first
    // instruction is the program's.
    expect(built.symbols.get("Reset")).toBe(NDS_ARM9_RAM);
  });

  it("carries a header CRC a loader will accept", () => {
    expect(view.getUint16(0x15e, true)).toBe(ndsCrc16(rom.subarray(0, 0x15e)));
  });

  it("ships no Nintendo logo, so the area is exactly zero", () => {
    expect([...rom.subarray(0x0c0, 0x15c)].every((byte) => byte === 0)).toBe(true);
  });
});

describe("what boot leaves in the video hardware", async () => {
  const built = await buildGbaRom(build("pong"));
  const machine = boot(built.bytes, built.layout.booted);

  it("maps a bank to background memory and a second one to objects", () => {
    // The core refuses any other arrangement, so reaching here at all is most of
    // the assertion; this says *which* two, because a build that mapped one bank
    // twice would draw scenery and no sprites.
    expect(machine.readMemory(0x04000240, 1)[0]).toBe(0x81);
    expect(machine.readMemory(0x04000241, 1)[0]).toBe(0x82);
  });

  it("uploads the background bank to one of them and the object bank to the other", () => {
    const builtin = builtinGba(SYSTEM_INK, SYSTEM_PAPER);
    expect([...machine.bankA.subarray(0, builtin.length)]).toEqual([...builtin]);
    const block = objectBlockGba(SYSTEM_INK);
    expect([...machine.bankB.subarray(0, block.length)]).toEqual([...block]);
    // And they really are two memories: the object bank is not a window into the
    // background one, which is what the other machine's is.
    expect(machine.bankA).not.toBe(machine.bankB);
  });

  it("powers the screen and the engine, and shows what the engine draws", () => {
    const powcnt = machine.readMemory(0x04000304, 2);
    expect((powcnt[0] as number) & 1).toBe(1); // the LCDs
    expect((powcnt[0] as number) & 2).toBe(2); // 2D engine A
    // Display mode 1: the engine's own graphics. Zero blanks the screen, and the
    // other two show a video RAM bank or the capture unit.
    expect((machine.ppu.dispcnt >>> 16) & 3).toBe(1);
    expect(machine.ppu.dispcnt & 0x80).toBe(0); // no longer forced blank
  });

  it("comes up in mode 0 with both layers, the objects and one-dimensional mapping", () => {
    const dispcnt = machine.ppu.dispcnt;
    expect(dispcnt & 7).toBe(0);
    expect(dispcnt & 0x100).toBe(0x100);
    expect(dispcnt & 0x200).toBe(0x200);
    expect(dispcnt & 0x1000).toBe(0x1000);
    expect(dispcnt & 0x40).toBe(0x40);
  });

  it("points the two layers at the maps the renderer addresses", () => {
    const bg0 = machine.ppu.bgcnt[0] as number;
    const bg1 = machine.ppu.bgcnt[1] as number;
    expect(((bg0 >> 8) & 0x1f) * 0x800).toBe(MAP_BASE);
    expect(((bg1 >> 8) & 0x1f) * 0x800).toBe(HUD_BASE);
    expect(bg0 & 0x80).toBe(0x80);
    expect(bg1 & 0x80).toBe(0x80);
    expect(bg1 & 3).toBeLessThan(bg0 & 3);
  });

  it("draws something, rather than a screen of one colour", () => {
    // The case that found the bug this whole arrangement is exposed to: the
    // engine and the machine each owning a video RAM array, so a picture is
    // uploaded to one and read from the other. Every register is right and the
    // screen is black, which no other assertion here can see.
    //
    // Once, into a local: the getter renders the whole frame, so reading it in
    // the loop condition would draw the picture sixty thousand times.
    const pixels = machine.framebuffer;
    const seen = new Set<string>();
    for (let at = 0; at < pixels.length; at += 4) {
      seen.add(`${pixels[at]},${pixels[at + 1]},${pixels[at + 2]}`);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("the bigger window", async () => {
  const levels = { "cavern.dmtl": projectText("caves", "levels/cavern.dmtl") };
  const program = compile(gameSource("caves"), { profile: getProfile("nds"), levels });
  const built = await buildGbaRom(program);

  it("is thirty-two cells by twenty-four, and the plan and the profile agree", () => {
    // Two statements of one number, and the fit's box is a third
    // (`gba-art.ts` §planFor). A build that kept the other machine's window
    // would leave two columns and four rows of every scene unpainted.
    expect(built.layout.memory.viewW).toBe(NDS_MEMORY.viewW);
    expect(built.layout.memory.viewH).toBe(NDS_MEMORY.viewH);
    expect(NDS_MEMORY.viewW * 8).toBe(256);
    expect(NDS_MEMORY.viewH * 8).toBe(192);
  });

  it("draws every visible cell from the level's own grid, to the last row", () => {
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 4; frame += 1) machine.runFrame();
    machine.setButtons([]);
    // Ninety frames, for the reason the Game Boy Advance's oracle gives: the
    // scene opens with the player falling, and a camera moving more than four
    // cells in a tick asks for a full redraw next frame rather than tearing.
    for (let frame = 0; frame < 90; frame += 1) machine.runFrame();

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
    let lastRow = 0;
    for (let row = originRow; row < originRow + built.layout.memory.viewH; row += 1) {
      for (let column = originCol; column < originCol + built.layout.memory.viewW; column += 1) {
        if (column >= level.width || row >= level.height) continue;
        const cell = (level.rows[row] ?? "")[column] ?? " ";
        const tile = cellAt(machine, column, row) & 0x3ff;
        if (cell === " ") expect(tile).toBe(NDS_BLANK);
        else expect(tile).toBeLessThan(NDS_BLANK);
        checked += 1;
        lastRow = Math.max(lastRow, row - originRow);
      }
    }
    expect(checked).toBeGreaterThan(100);
    // The four rows the other machine's window does not have are painted too,
    // which is the whole point of asserting this here as well as there.
    expect(lastRow).toBeGreaterThan(19);
  });
});

describe("waiting on the beam", async () => {
  const built = await buildGbaRom(build("pong"));

  it("runs exactly one game tick per frame", async () => {
    // The claim the whole `frame: "beam"` design rests on. A wait that never
    // released would hang; one that released twice in a blanking interval would
    // run the game at double speed and still trace perfectly, because a trace is
    // a sequence of ticks and says nothing about when they happened.
    const machine = boot(built.bytes, built.layout.booted);
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
    machine.setButtons([]);
    for (let frame = 0; frame < 30; frame += 1) machine.runFrame();

    const readReady = (): number => machine.readMemory(built.layout.ready, 1)[0] as number;
    let ticks = 0;
    let last = readReady();
    const frames = 120;
    for (let frame = 0; frame < frames; frame += 1) {
      machine.runFrame();
      const now = readReady();
      if (now !== last) {
        last = now;
        ticks += 1;
      }
    }
    expect(ticks).toBeGreaterThan(0);
    expect(frames / ticks).toBeLessThan(1.2);
  }, 120_000);
});
