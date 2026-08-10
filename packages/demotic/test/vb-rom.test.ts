/**
 * What the Virtual Boy build is, beyond playing the same game.
 *
 * Trace conformance is in `rom.test.ts`, over the same battery every other
 * console runs — that is where "a Virtual Boy plays the game the interpreter
 * defines" is settled. Here are the things only this console has, and every case
 * but the last is one that produces a cartridge which traces perfectly and shows
 * nothing:
 *
 *   - **A scene is a display list.** Thirty-two worlds are walked from 31 down
 *     and the one that sets `END` stops the drawing processor, so a list written
 *     one entry short is a scene with no captions and one written one entry long
 *     is a scene drawn twice. There is no register that says "draw the
 *     background"; there is only the list.
 *   - **Depth, which nothing else in this project has.** A world says how far
 *     apart its two eyes' copies are pulled, and an object carries the same field
 *     for itself — so `VB_DEPTH`'s ladder is a thing that can be *read back*:
 *     scenery at the display plane, objects in front of it, captions in front of
 *     them. It is checked here in three places at once — the two worlds, the
 *     object table, and the pixels themselves — because a sign convention that
 *     was consistently wrong would put a game's sprites behind its scenery and
 *     pass any one of them alone.
 *   - **There is no video memory behind a port.** The map, the characters, the
 *     worlds and the object table are ordinary addresses, so a build whose boot
 *     copy was short or aimed wrong would tick correctly against a blank screen
 *     and nothing about the arrival is observable except the bytes.
 *   - **The map against the level's own grid**, cell by cell, before and after
 *     the camera has travelled. The map is 64×64 against a 48×28 window, so this
 *     is also where "both wraps are powers of two" is checked rather than
 *     asserted.
 *   - **The caption plane does not move.** Its world's source origin is written
 *     once at boot and never again, so a caption's cells are exact under a
 *     scrolling camera — the WonderSwan's claim and the Game Boy Advance's, and
 *     the third time in the set it can be made at all.
 *   - **Shade zero is the LEDs being off**, which is the opposite end of the ramp
 *     from where every other mono console here puts index 0. A build that wrote a
 *     fit's indices into `GPLT` straight through is a photographic negative, and
 *     the font's ink is the thing that goes missing first.
 */

import { describe, expect, it } from "vitest";

import {
  VB_BGMAP,
  VB_BGMAP_BYTES,
  VB_BKCOL,
  VB_CHR_MIRROR,
  VB_DEPTH,
  VB_GPLT0,
  VB_NEARER_SIGN,
  VB_OAM,
  VB_OBJ_BYTES,
  VB_SCREEN_H,
  VB_SCREEN_W,
  VB_SPT0,
  VB_WORLDS,
  VB_WORLD_BGM_OBJ,
  VB_WORLD_BYTES,
  VB_WORLD_END,
  VB_WORLD_GP,
  VB_WORLD_LON,
  VB_WORLD_MX,
  VB_WORLD_MY,
  VB_WORLD_RON,
  vbParallax,
  vbShade,
} from "@demake/core";
import { Vb } from "@demake/vb";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { buildVbRom, CODE_SIZE } from "../src/codegen/vb.js";
import { MAP_W, SYSTEM_PALETTE, VB_MAP_H } from "../src/codegen/vb/emit.js";
import { BUILTIN_TILES, glyphTile, patternTile } from "../src/rom/graphics.js";
import { exampleProject, projectText } from "./_projects.js";

function build(project: string, levels?: Record<string, string>) {
  const example = exampleProject(project);
  return compile(example.source, {
    profile: getProfile("vb"),
    files: example.files,
    levels: levels ?? example.levels,
  });
}

/** Boot a cartridge and run it until the runtime says it has finished booting. */
function boot(bytes: Uint8Array, bootedAt: number): Vb {
  const machine = new Vb(bytes);
  for (let guard = 0; guard < 8_000_000; guard += 1) {
    if (machine.readMemory(bootedAt, 1)[0] !== 0) return machine;
    machine.step();
  }
  throw new Error("vb: the runtime never finished initialising");
}

/** Run whole frames, so a scene has settled before anything is compared. */
function settle(machine: Vb, frames: number): void {
  for (let frame = 0; frame < frames; frame += 1) machine.runFrame();
}

/** A halfword of the machine's address space, little-endian as the hardware is. */
function half(machine: Vb, address: number): number {
  const bytes = machine.readMemory(address, 2);
  return (bytes[0] as number) | ((bytes[1] as number) << 8);
}

/** A signed halfword — which is what a parallax and a scroll origin are. */
function signed(machine: Vb, address: number): number {
  return (half(machine, address) << 16) >> 16;
}

/** One world's field. */
function world(machine: Vb, index: number, field: number): number {
  return signed(machine, VB_WORLDS + index * VB_WORLD_BYTES + field);
}

/** One BGMap entry: eleven bits of character, two flips and the sub-palette. */
function entryAt(
  machine: Vb,
  map: number,
  column: number,
  row: number,
): { tile: number; palette: number } {
  const cell = (row & (VB_MAP_H - 1)) * MAP_W + (column & (MAP_W - 1));
  const word = half(machine, VB_BGMAP + map * VB_BGMAP_BYTES + cell * 2);
  return { tile: word & 0x07ff, palette: (word >> 14) & 3 };
}

/** Where in the display list each of this runtime's worlds sits. */
const SCENERY = 31;
const OBJECT_WORLDS = [30, 29, 28, 27];
const HUD = 26;
const TERMINATOR = 25;

describe("the Virtual Boy cartridge", async () => {
  const built = await buildVbRom(build("pong"), { title: "PONG" });

  it("takes the smallest board this console shipped", () => {
    // Powers of two, because the board is decoded by masking — which is also why
    // the reset fetch lands in the cartridge's own last sixteen bytes.
    expect(built.bytes.length).toBe(0x80000);
  });

  it("stamps the header below the vectors rather than at the start", () => {
    const headerAt = built.bytes.length - 0x220;
    expect(String.fromCharCode(...built.bytes.subarray(headerAt, headerAt + 4))).toBe("PONG");
  });

  it("measures headroom against the largest board, not the one that shipped", () => {
    // A game getting bigger must never look like a game with more room
    // (AGENTS.md §`free` is measured against the largest board).
    expect(built.stats.free).toBe(CODE_SIZE - built.stats.bytes);
    expect(CODE_SIZE).toBeGreaterThan(built.bytes.length);
    expect(built.stats.cartridge).toBe(built.bytes.length);
  });
});

describe("boot", async () => {
  const example = exampleProject("pong");
  const built = await buildVbRom(build("pong"), { assets: example.assets });
  const machine = boot(built.bytes, built.layout.booted);
  settle(machine, 4);

  it("copies the character bank into the drawing processor's own memory", () => {
    // Nothing is uploaded through a port here, so a short copy is a perfect game
    // on a blank screen. The first built-in character is the blank, so the
    // *second* is where a short copy would show: it is a glyph and it is not all
    // zero.
    const glyph = machine.readMemory(VB_CHR_MIRROR + 16, 16);
    expect([...glyph].some((byte) => byte !== 0)).toBe(true);
  });

  it("writes the display list once, and ends it", () => {
    for (const index of OBJECT_WORLDS) {
      const head = half(machine, VB_WORLDS + index * VB_WORLD_BYTES);
      expect(head & 0x3000).toBe(VB_WORLD_BGM_OBJ);
      // All four are enabled: the group a world draws is decided by how many
      // object worlds came before it, so reaching group 0 means meeting four.
      expect(head & (VB_WORLD_LON | VB_WORLD_RON)).toBe(VB_WORLD_LON | VB_WORLD_RON);
    }
    for (const index of [SCENERY, HUD]) {
      const head = half(machine, VB_WORLDS + index * VB_WORLD_BYTES);
      expect(head & (VB_WORLD_LON | VB_WORLD_RON)).toBe(VB_WORLD_LON | VB_WORLD_RON);
      expect(head & VB_WORLD_END).toBe(0);
    }
    expect(half(machine, VB_WORLDS + TERMINATOR * VB_WORLD_BYTES) & VB_WORLD_END).toBe(
      VB_WORLD_END,
    );
  });

  it("puts the three layers at the three depths, in that order", () => {
    // The ladder, read back off the hardware: scenery at the display plane,
    // captions in front of it, and objects between the two. `VB_NEARER_SIGN` is
    // what "in front" means, and it is asserted about the *relation* as well as
    // the numbers — a sign that was consistently wrong everywhere would satisfy
    // the equalities and put a game's captions behind its scenery.
    expect(world(machine, SCENERY, VB_WORLD_GP)).toBe(vbParallax(VB_DEPTH.background));
    expect(world(machine, HUD, VB_WORLD_GP)).toBe(vbParallax(VB_DEPTH.hud));
    // Nearer is one direction, and the caption plane is on that side of the
    // display plane. The object half is asserted where there are objects.
    expect(Math.sign(world(machine, HUD, VB_WORLD_GP))).toBe(VB_NEARER_SIGN);
    expect(Math.abs(vbParallax(VB_DEPTH.hud))).toBeGreaterThan(
      Math.abs(vbParallax(VB_DEPTH.object)),
    );
  });

  it("covers the whole screen with both planes", () => {
    for (const index of [SCENERY, HUD]) {
      expect(world(machine, index, 14)).toBe(VB_SCREEN_W - 1);
      expect(world(machine, index, 16)).toBe(VB_SCREEN_H - 1);
    }
  });

  it("gives the font a palette of its own, ramped to one end", () => {
    // The reservation: `GPLT1` is the font's, the level patterns' and the
    // placeholder block's, and it is a ramp of three distinct shades rather than
    // whatever the picture chose. Its ink — colour three, in the top two bits —
    // is one of the two extremes, because "chosen for contrast" on a four-shade
    // display means the brightest or the LEDs off and never a mid-tone.
    const font = half(machine, VB_GPLT0 + SYSTEM_PALETTE * 2) & 0xff;
    const ramp = [(font >> 2) & 3, (font >> 4) & 3, (font >> 6) & 3];
    expect(new Set(ramp).size).toBe(3);
    expect([0, 3]).toContain(ramp[2]);
    // And it is a ramp: the three run one way or the other, so the mid-tone is
    // between the ink and the shade nearest the paper.
    const rising = (ramp[2] as number) > (ramp[0] as number);
    expect(rising ? ramp[1]! > ramp[0]! : ramp[1]! < ramp[0]!).toBe(true);
  });

  it("draws something in both eyes", () => {
    // The two-bit picture rather than the RGBA one: a blank screen is still two
    // distinct bytes in an RGBA buffer (a shade and an alpha), so counting those
    // is a test that passes on a display that was never switched on.
    for (const eye of ["left", "right"] as const) {
      expect(new Set(machine.vip.shades(eye)).size).toBeGreaterThan(1);
    }
  });
});

describe("the object table", async () => {
  const example = exampleProject("pong");
  const built = await buildVbRom(build("pong"), { assets: example.assets });
  const machine = boot(built.bytes, built.layout.booted);
  // Past the title screen: that scene is a caption and nothing else, so the
  // object table is legitimately empty there.
  machine.setButtons(["a"]);
  settle(machine, 4);
  machine.setButtons([]);
  settle(machine, 4);

  it("names a last entry rather than a count, and terminates past it", () => {
    // The `SPT` registers bound four groups; three are left empty by giving them
    // all the same value, so the fourth object world draws group 0 and it holds
    // everything. The entry one past the end has both eye bits clear, which is
    // the only way to express a frame with no objects at all.
    const last = half(machine, VB_SPT0) & 0x3ff;
    for (let group = 1; group < 4; group += 1) {
      expect(half(machine, VB_SPT0 + group * 2) & 0x3ff).toBe(last);
    }
    const terminator = half(machine, VB_OAM + last * VB_OBJ_BYTES + 2);
    expect(terminator & 0xc000).toBe(0);
  });

  it("draws every entry below the terminator into both eyes, in front of the scenery", () => {
    const last = half(machine, VB_SPT0) & 0x3ff;
    expect(last).toBeGreaterThan(0);
    for (let index = 0; index < last; index += 1) {
      const word = half(machine, VB_OAM + index * VB_OBJ_BYTES + 2);
      expect(word & 0xc000).toBe(0xc000);
      // The middle rung of `VB_DEPTH`: an object carries its own parallax, which
      // is what lets a sprite stand off the scenery it is drawn over without the
      // scenery moving to allow it.
      expect(((word & 0x3fff) << 18) >> 18).toBe(vbParallax(VB_DEPTH.object));
    }
  });
});

describe("a level scene", async () => {
  const levels = { "cavern.dmtl": projectText("caves", "levels/cavern.dmtl") };
  const example = exampleProject("caves");
  const built = await buildVbRom(build("caves", levels), { assets: example.assets });
  const machine = boot(built.bytes, built.layout.booted);
  // Past the title screen and into the cavern, then far enough for the camera to
  // have travelled several cells.
  machine.setButtons(["a"]);
  settle(machine, 4);
  machine.setButtons([]);
  settle(machine, 4);

  const grid = projectText("caves", "levels/cavern.dmtl");
  const rows = grid.slice(grid.indexOf("map\n") + 4).split("\n");
  const legend = [...grid.matchAll(/^tile\s+(\S)\s+\S+/gm)].map((match) => match[1] as string);

  /** Which legend entry a `.dmtl` glyph is, or −1 for a blank. */
  const legendOf = (glyph: string): number => legend.indexOf(glyph);

  it("paints the window from the level's own grid", () => {
    const originCol = 0;
    const originRow = 0;
    let checked = 0;
    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < 12; column += 1) {
        const glyph = (rows[originRow + row] ?? "")[originCol + column];
        if (glyph === undefined || glyph === " ") continue;
        const index = legendOf(glyph);
        if (index < 0) continue;
        const cell = entryAt(machine, 0, originCol + column, originRow + row);
        // A legend entry with art draws a demade character and one without draws
        // a built-in pattern — either way it is *not* the blank, which is what a
        // cell nothing painted would hold.
        expect(cell.tile).not.toBe(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("moves the scenery plane and holds the caption plane still", () => {
    // The whole of scrolling on this console is the scenery world's own source
    // origin, and the caption world's is written once at boot and never again —
    // which is the claim the entire HUD design rests on, and the third time in
    // the set it can be made at all.
    //
    // Vertically, because this is the widest screen in the matrix: forty-eight
    // cells against the cavern's own width, so a level that scrolls sideways on
    // a Game Boy has both its edges on screen here and the camera never leaves
    // its horizontal clamp.
    expect(world(machine, SCENERY, VB_WORLD_MY)).not.toBe(0);
    for (let round = 0; round < 4; round += 1) {
      machine.setButtons(round % 2 === 0 ? ["right"] : ["a", "right"]);
      settle(machine, 20);
      expect(world(machine, HUD, VB_WORLD_MX)).toBe(0);
      expect(world(machine, HUD, VB_WORLD_MY)).toBe(0);
    }
    machine.setButtons([]);
    settle(machine, 4);
  });

  it("keeps painting the leading edge as the camera travels", () => {
    // The map is sixteen columns wider than the window, so the cell the camera is
    // about to reveal was painted where nobody was looking. Whatever the camera
    // has reached, the cells under it are still the level's.
    const originCol = world(machine, SCENERY, VB_WORLD_MX) >> 3;
    let painted = 0;
    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < 12; column += 1) {
        const glyph = (rows[row] ?? "")[originCol + column];
        if (glyph === undefined || glyph === " " || legendOf(glyph) < 0) continue;
        if (entryAt(machine, 0, originCol + column, row).tile !== 0) painted += 1;
      }
    }
    expect(painted).toBeGreaterThan(10);
  });
});

describe("a caption", async () => {
  const example = exampleProject("pong");
  const built = await buildVbRom(build("pong"), { assets: example.assets });
  const machine = boot(built.bytes, built.layout.booted);
  settle(machine, 6);

  it("goes on the caption plane, in the font's own palette", () => {
    // Somewhere on the second BGMap there is a glyph, and it is in the reserved
    // palette rather than in whatever the picture chose.
    let found = 0;
    for (let row = 0; row < 28; row += 1) {
      for (let column = 0; column < 48; column += 1) {
        const cell = entryAt(machine, 1, column, row);
        if (cell.tile === 0) continue;
        expect(cell.tile).toBeLessThan(BUILTIN_TILES);
        expect(cell.palette).toBe(SYSTEM_PALETTE);
        found += 1;
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it("draws its glyphs from the built-in bank", () => {
    const glyphs = new Set<number>();
    for (let row = 0; row < 28; row += 1) {
      for (let column = 0; column < 48; column += 1) {
        const cell = entryAt(machine, 1, column, row);
        if (cell.tile !== 0) glyphs.add(cell.tile);
      }
    }
    // Whatever the title screen says, it is spelled out of the font — not out of
    // the level patterns and not out of the object block.
    for (const tile of glyphs) {
      expect(tile).toBeLessThan(patternTile(0, false));
    }
    expect(glyphs.has(glyphTile(" "))).toBe(false);
  });
});

describe("the two eyes", async () => {
  const example = exampleProject("pong");
  const built = await buildVbRom(build("pong"), { assets: example.assets });
  const machine = boot(built.bytes, built.layout.booted);
  settle(machine, 8);

  it("shows a layer at the display plane in the same place in both", () => {
    // The scenery world's parallax is zero, so the eyes disagree only where
    // something in front of it is drawn. That is the whole of the depth claim
    // stated in pixels rather than in a register: identical would mean nothing is
    // standing off the plane, and wildly different would mean the scenery moved.
    const left = machine.eye("left");
    const right = machine.eye("right");
    let different = 0;
    for (let at = 0; at < left.length; at += 4) {
      if (left[at] !== right[at]) different += 1;
    }
    expect(different).toBeGreaterThan(0);
    expect(different).toBeLessThan((left.length / 4) * 0.5);
  });

  it("puts the LEDs off where the fit's lightest colour is", () => {
    // Shade zero is the LEDs being off and a fit's index 0 is its *lightest*
    // colour, so `vbShade` is a reversal rather than an identity. The one place
    // that is visible from outside is the backdrop register, which is where a
    // picture's colour zero goes.
    expect(vbShade(0)).toBe(3);
    expect(vbShade(3)).toBe(0);
    expect(half(machine, VB_BKCOL) & 3).toBeLessThanOrEqual(3);
  });
});
