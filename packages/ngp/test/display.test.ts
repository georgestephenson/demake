/**
 * The K1GE/K2GE display controller and the machine around it.
 *
 * What gets the attention is what this hardware does that the other nine cores'
 * do not, because everything else here is a tilemap renderer like any other.
 *
 *   - **Three sprite priorities interleave with two planes**, so an object can
 *     be *between* two background layers. That is six-deep compositing decided
 *     by two bits and one register, and getting the order wrong still produces a
 *     picture.
 *   - **An object's position can be an offset from the previous object's**, so a
 *     16×16 character is one absolute entry and three relative ones — and a
 *     renderer that resolved each object on its own would draw all four in the
 *     same place.
 *   - **The leftmost pixel of a character is in the *highest* bit pair**, which
 *     is the opposite way round from every packed format in this project.
 *   - **The two machines differ only in the palette**, so the same map and the
 *     same object table have to come out as grey shades on one and RGB444 on the
 *     other.
 *
 * The boot half is checked through {@link Ngp} rather than in isolation: the
 * entry address is a header field rather than a vector, and a vertical-blank
 * handler is a pointer a cartridge writes into RAM, so both are things a
 * cartridge can only get wrong end to end.
 *
 * Sources: the Neo Geo Pocket Color technical reference (`ngpcspec.txt`,
 * devrs.com).
 */

import {
  Asm900,
  NGP_BGC,
  NGP_CHARACTERS,
  NGP_PALETTE,
  NGP_PLANE_PRIORITY,
  NGP_PLANE1,
  NGP_PLANE2,
  NGP_SPRITE_PALETTES,
  NGP_SPRITES,
  NGP_VECTOR_VBLANK,
  NGP_VIDEO,
  NGP_WSI_H,
  NGP_WSI_V,
  packNgpRom,
  t9Abs as abs,
} from "@demake/core";
import { describe, expect, it } from "vitest";

import { Display, MONO_SHADES, SCREEN_WIDTH, VIDEO_SIZE, type NgpModel } from "../src/display.js";
import { Ngp } from "../src/machine.js";

const RED = 0x00f;
const GREEN = 0x0f0;
const BLUE = 0xf00;

/** A display over its own video memory, with the picture switched on. */
function screen(model: NgpModel = "ngpc"): { display: Display; video: Uint8Array } {
  const video = new Uint8Array(VIDEO_SIZE);
  const display = new Display(model, video);
  const put = (address: number, value: number): void => {
    video[address - NGP_VIDEO] = value;
  };
  // The whole panel is the window, and the backdrop is on and black.
  put(NGP_WSI_H, 160);
  put(NGP_WSI_V, 152);
  put(NGP_BGC, 0x80);
  return { display, video };
}

/** Write a byte into video memory by its console address. */
function poke(video: Uint8Array, address: number, value: number): void {
  video[address - NGP_VIDEO] = value & 0xff;
}

function pokeWord(video: Uint8Array, address: number, value: number): void {
  poke(video, address, value);
  poke(video, address + 1, value >> 8);
}

/** Fill a character with one colour index, in the hardware's own bit order. */
function solidTile(video: Uint8Array, tile: number, index: number): void {
  let row = 0;
  for (let x = 0; x < 8; x += 1) row |= index << ((7 - x) * 2);
  for (let y = 0; y < 8; y += 1) pokeWord(video, NGP_CHARACTERS + tile * 16 + y * 2, row);
}

/** The RGB at a screen position, as a number. */
function pixel(display: Display, x: number, y: number): number {
  const at = (y * SCREEN_WIDTH + x) * 4;
  return (
    ((display.framebuffer[at] as number) << 16) |
    ((display.framebuffer[at + 1] as number) << 8) |
    (display.framebuffer[at + 2] as number)
  );
}

/** Render every visible line. */
function paint(display: Display): void {
  display.line = 0;
  display.step(515 * 152);
}

describe("the display controller", () => {
  it("draws a scroll plane cell through the palette its map entry names", () => {
    const { display, video } = screen();
    solidTile(video, 1, 2);
    // Palette 3, colour 2 — set through the plane-1 block, which is the second.
    pokeWord(video, NGP_PALETTE + 1 * 0x80 + 3 * 8 + 2 * 2, RED);
    // Tile 1, colour palette 3: the palette sits in bits 9-12 of the entry.
    pokeWord(video, NGP_PLANE1, 1 | (3 << 9));
    paint(display);
    expect(pixel(display, 0, 0)).toBe(0xff0000);
    // The cell next door was never written, so it is character zero: all
    // index-zero pixels, which are transparent, so the backdrop shows.
    expect(pixel(display, 8, 0)).toBe(0x000000);
  });

  it("puts the leftmost pixel of a character in the highest bit pair", () => {
    const { display, video } = screen();
    // One row where only the leftmost pixel is colour 1.
    pokeWord(video, NGP_CHARACTERS + 16, 1 << 14);
    pokeWord(video, NGP_PALETTE + 0x80 + 2, GREEN);
    pokeWord(video, NGP_PLANE1, 1);
    paint(display);
    expect(pixel(display, 0, 0)).toBe(0x00ff00);
    expect(pixel(display, 1, 0)).toBe(0x000000);
  });

  it("flips a cell both ways", () => {
    const { display, video } = screen();
    pokeWord(video, NGP_CHARACTERS + 16, 1 << 14); // top-left pixel only
    pokeWord(video, NGP_PALETTE + 0x80 + 2, GREEN);
    pokeWord(video, NGP_PLANE1, 1 | 0x8000 | 0x4000);
    paint(display);
    // Flipped both ways, the one lit pixel is the bottom-right of the cell.
    expect(pixel(display, 7, 7)).toBe(0x00ff00);
    expect(pixel(display, 0, 0)).toBe(0x000000);
  });

  it("scrolls a plane by whole pixels, wrapping at the map's edge", () => {
    const { display, video } = screen();
    solidTile(video, 1, 1);
    pokeWord(video, NGP_PALETTE + 0x80 + 2, RED);
    pokeWord(video, NGP_PLANE1, 1);
    poke(video, 0x8032, 4); // S1SO.H
    paint(display);
    // The cell has slid four pixels left, so the first four columns show what
    // was under its right-hand half and the rest is the empty cell beside it.
    expect(pixel(display, 3, 0)).toBe(0xff0000);
    expect(pixel(display, 4, 0)).toBe(0x000000);
  });

  describe("priority", () => {
    /** Both planes covered by a solid cell, plus one object over the origin. */
    function layered(spritePriority: number, frontPlane: 1 | 2): Display {
      const { display, video } = screen();
      solidTile(video, 1, 1);
      pokeWord(video, NGP_PALETTE + 0x80 + 2, RED); // plane 1 colour 1
      pokeWord(video, NGP_PALETTE + 0x100 + 2, GREEN); // plane 2 colour 1
      pokeWord(video, NGP_PALETTE + 2, BLUE); // sprite colour 1
      pokeWord(video, NGP_PLANE1, 1);
      pokeWord(video, NGP_PLANE2, 1);
      poke(video, NGP_PLANE_PRIORITY, frontPlane === 2 ? 0x80 : 0x00);
      poke(video, NGP_SPRITES, 1); // tile 1
      poke(video, NGP_SPRITES + 1, spritePriority << 3);
      poke(video, NGP_SPRITES + 2, 0);
      poke(video, NGP_SPRITES + 3, 0);
      poke(video, NGP_SPRITE_PALETTES, 0);
      paint(display);
      return display;
    }

    it("hides an object whose priority is zero", () => {
      expect(pixel(layered(0, 1), 0, 0)).toBe(0xff0000);
    });

    it("puts an object between the two planes", () => {
      // Plane 2 in front, so the middle object is over plane 1 and under plane 2.
      expect(pixel(layered(2, 2), 0, 0)).toBe(0x00ff00);
      // ...and with plane 1 in front, the middle object is under plane 1.
      expect(pixel(layered(2, 1), 0, 0)).toBe(0xff0000);
    });

    it("puts an object in front of both planes", () => {
      expect(pixel(layered(3, 1), 0, 0)).toBe(0x0000ff);
      expect(pixel(layered(3, 2), 0, 0)).toBe(0x0000ff);
    });

    it("lets the front plane win over the furthest objects", () => {
      expect(pixel(layered(1, 1), 0, 0)).toBe(0xff0000);
    });
  });

  it("chains an object's position onto the one before it", () => {
    const { display, video } = screen();
    solidTile(video, 1, 1);
    pokeWord(video, NGP_PALETTE + 2, BLUE);
    // Object 0 at (40, 40), absolute.
    poke(video, NGP_SPRITES, 1);
    poke(video, NGP_SPRITES + 1, 3 << 3);
    poke(video, NGP_SPRITES + 2, 40);
    poke(video, NGP_SPRITES + 3, 40);
    // Object 1 eight pixels to its right, and it says so as an *offset*.
    poke(video, NGP_SPRITES + 4, 1);
    poke(video, NGP_SPRITES + 5, (3 << 3) | 0x04 | 0x02);
    poke(video, NGP_SPRITES + 6, 8);
    poke(video, NGP_SPRITES + 7, 0);
    paint(display);
    expect(pixel(display, 44, 44)).toBe(0x0000ff);
    // The chained half is at 48, which is where a renderer that read the offset
    // as an absolute position would have drawn nothing.
    expect(pixel(display, 52, 44)).toBe(0x0000ff);
    expect(pixel(display, 60, 44)).toBe(0x000000);
  });

  it("shows the out-of-window colour outside the window", () => {
    const { display, video } = screen();
    poke(video, NGP_WSI_H, 8);
    poke(video, NGP_WSI_V, 8);
    // The out-of-window colour is index 1 of the background palette.
    poke(video, 0x8012, 1);
    pokeWord(video, 0x83e2, RED);
    paint(display);
    expect(pixel(display, 0, 0)).toBe(0x000000);
    expect(pixel(display, 9, 0)).toBe(0xff0000);
    expect(pixel(display, 0, 9)).toBe(0xff0000);
  });

  it("keeps the screen black until the background register says otherwise", () => {
    const video = new Uint8Array(VIDEO_SIZE);
    const display = new Display("ngpc", video);
    poke(video, NGP_WSI_H, 160);
    poke(video, NGP_WSI_V, 152);
    pokeWord(video, 0x83e0, RED); // which the register has not enabled
    paint(display);
    expect(pixel(display, 80, 76)).toBe(0x000000);
  });

  it("renders the same map as grey shades on the mono machine", () => {
    const { display, video } = screen("ngp");
    solidTile(video, 1, 2);
    // The mono palette is three shades in a table of four bytes, and the plane's
    // block is the second of three.
    poke(video, 0x8108 + 2, 3);
    pokeWord(video, NGP_PLANE1, 1);
    paint(display);
    expect(pixel(display, 0, 0)).toBe(MONO_SHADES[3]);
    // A second palette code selects the other table, which is one register bit
    // rather than the Color's four.
    poke(video, 0x810c + 2, 6);
    pokeWord(video, NGP_PLANE1, 1 | (1 << 13));
    paint(display);
    expect(pixel(display, 0, 0)).toBe(MONO_SHADES[6]);
  });
});

describe("the machine", () => {
  it("boots a cartridge from the entry address in its header", () => {
    const asm = new Asm900(0x200040);
    asm.ldn("a", 0x5a);
    asm.stm(abs(0x4000), "a");
    asm.label("Stop");
    asm.jr("t", "Stop");
    const ngp = new Ngp();
    ngp.load(packNgpRom(asm.assemble()));
    for (let step = 0; step < 100; step += 1) ngp.step();
    expect(ngp.ram[0]).toBe(0x5a);
  });

  it("calls the handler a cartridge writes into the vertical-blank vector", () => {
    const asm = new Asm900(0x200040);
    // Install the handler, then spin. The pointer is four bytes in RAM rather
    // than a vector in the processor's own table, because the boot ROM owns
    // that one.
    asm.ldn("xwa", "Handler");
    asm.stm(abs(NGP_VECTOR_VBLANK), "xwa");
    asm.label("Spin");
    asm.jr("t", "Spin");
    asm.label("Handler");
    asm.ldm("a", abs(0x4000));
    asm.inc(1, "a");
    asm.stm(abs(0x4000), "a");
    asm.reti();
    const ngp = new Ngp();
    ngp.load(packNgpRom(asm.assemble()));
    for (let frame = 0; frame < 5; frame += 1) ngp.runFrame();
    expect(ngp.frames).toBe(5);
    // Four, not five: the last frame's interrupt has been *scheduled* — the
    // program counter is sitting on the handler's first instruction — and
    // `runFrame` stopped at the boundary that scheduled it. A handler that had
    // run five times would mean the machine was executing it before the frame
    // it belongs to had ended.
    expect(ngp.ram[0]).toBe(4);
  });

  it("reads an address past the end of the board as erased flash", () => {
    const ngp = new Ngp();
    ngp.load(packNgpRom(Uint8Array.of(0x00)));
    expect(ngp.read(0x3fffff)).toBe(0xff);
  });
});
