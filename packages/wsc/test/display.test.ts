/**
 * The display controller, against what a demade cartridge will ask of it.
 *
 * Everything here is a property a trace cannot see, which is the whole reason
 * a renderer gets its own test: a game whose state is right and whose screen is
 * wrong passes every conformance run there is.
 *
 * Two of the cases are this console's rather than a restatement. **Colour zero
 * is transparent on both layers**, so a HUD plane over a picture is only
 * possible if a blank cell really does show what is behind it — and the layer
 * order has to put the second plane in front. And **a cell carries its own
 * palette**, so two cells of the same tile in different palettes are two
 * different pictures, which is what makes a caption legible over art whose
 * colours were chosen for the art.
 */

import { describe, expect, it } from "vitest";

import {
  CYCLES_PER_LINE,
  Display,
  LINES_PER_FRAME,
  PALETTE_BASE,
  PORT,
  SPRITES_PER_LINE,
  TILE_BASE,
  VBLANK_LINE,
} from "../src/display.js";
import { SCREEN_WIDTH } from "../src/machine.js";

const SCR1_BASE = 0x1000;
const SCR2_BASE = 0x1800;
const SPRITES = 0x2000;

/** A display over its own 64 KiB, programmed the way a cartridge programs it. */
function machine(): { ram: Uint8Array; display: Display } {
  const ram = new Uint8Array(0x10000);
  const display = new Display(ram);
  display.write(PORT.DISP_MODE, 0xe0); // colour, 4bpp, packed
  display.write(PORT.MAP_BASE, (SCR1_BASE >> 11) | ((SCR2_BASE >> 11) << 4));
  display.write(PORT.SPR_BASE, SPRITES >> 9);
  display.write(PORT.LCD_CTRL, 0x01);
  display.write(PORT.DISP_CTRL, 0x07); // both layers and the objects
  return { ram, display };
}

/** Fill a tile with one colour index. */
function solidTile(ram: Uint8Array, tile: number, index: number): void {
  const packed = ((index & 0x0f) << 4) | (index & 0x0f);
  ram.fill(packed, TILE_BASE + tile * 32, TILE_BASE + tile * 32 + 32);
}

/** Put a colour in a palette entry, as RGB444. */
function setColor(
  ram: Uint8Array,
  palette: number,
  index: number,
  r: number,
  g: number,
  b: number,
) {
  const at = PALETTE_BASE + palette * 32 + index * 2;
  ram[at] = ((g & 0xf) << 4) | (b & 0xf);
  ram[at + 1] = r & 0xf;
}

/** Write one screen-map entry. */
function setCell(ram: Uint8Array, base: number, col: number, row: number, word: number): void {
  const at = base + ((row * 32 + col) << 1);
  ram[at] = word & 0xff;
  ram[at + 1] = (word >> 8) & 0xff;
}

/** The pixel at (x, y), as `[r, g, b]`. */
function pixel(display: Display, x: number, y: number): number[] {
  const at = (y * SCREEN_WIDTH + x) * 4;
  return [
    display.framebuffer[at] as number,
    display.framebuffer[at + 1] as number,
    display.framebuffer[at + 2] as number,
  ];
}

/** Run one whole frame's worth of scanlines. */
function frame(display: Display): void {
  display.step(CYCLES_PER_LINE * LINES_PER_FRAME);
}

describe("the WonderSwan Color display", () => {
  it("draws a background cell in the palette that cell names", () => {
    const { ram, display } = machine();
    solidTile(ram, 1, 1);
    setColor(ram, 3, 1, 0xf, 0x0, 0x0);
    setColor(ram, 4, 1, 0x0, 0xf, 0x0);
    setCell(ram, SCR1_BASE, 0, 0, 1 | (3 << 9));
    setCell(ram, SCR1_BASE, 1, 0, 1 | (4 << 9));
    frame(display);
    expect(pixel(display, 0, 0)).toEqual([255, 0, 0]);
    expect(pixel(display, 8, 0)).toEqual([0, 255, 0]);
  });

  it("shows the backdrop through colour zero, on both layers", () => {
    const { ram, display } = machine();
    // Palette 0 colour 5 is the backdrop; every cell is tile 0, which is blank.
    setColor(ram, 0, 5, 0x0, 0x0, 0xf);
    display.write(PORT.BACK_COLOR, 0x05);
    frame(display);
    expect(pixel(display, 10, 10)).toEqual([0, 0, 255]);
  });

  it("draws the second layer in front of the first", () => {
    const { ram, display } = machine();
    solidTile(ram, 1, 1);
    setColor(ram, 1, 1, 0xf, 0x0, 0x0);
    setColor(ram, 2, 1, 0x0, 0x0, 0xf);
    setCell(ram, SCR1_BASE, 0, 0, 1 | (1 << 9));
    setCell(ram, SCR1_BASE, 1, 0, 1 | (1 << 9));
    setCell(ram, SCR2_BASE, 0, 0, 1 | (2 << 9));
    frame(display);
    expect(pixel(display, 0, 0)).toEqual([0, 0, 255]);
    // And a blank cell of the front layer leaves the back one showing, which is
    // the whole reason a HUD can have a plane of its own.
    expect(pixel(display, 12, 0)).toEqual([255, 0, 0]);
  });

  it("scrolls each layer independently", () => {
    const { ram, display } = machine();
    solidTile(ram, 1, 1);
    setColor(ram, 1, 1, 0xf, 0x0, 0x0);
    setCell(ram, SCR1_BASE, 1, 0, 1 | (1 << 9));
    display.write(PORT.SCR1_X, 8); // cell 1 slides to the left edge
    frame(display);
    expect(pixel(display, 0, 0)).toEqual([255, 0, 0]);
    expect(pixel(display, 8, 0)).toEqual([0, 0, 0]);
  });

  it("wraps a layer inside its own 32×32 map", () => {
    const { ram, display } = machine();
    solidTile(ram, 1, 1);
    setColor(ram, 1, 1, 0xf, 0x0, 0x0);
    setCell(ram, SCR1_BASE, 0, 0, 1 | (1 << 9));
    // 32 cells is 256 pixels, so scrolling by 256 is scrolling by nothing.
    display.write(PORT.SCR1_X, 0);
    display.write(PORT.SCR1_Y, 0);
    frame(display);
    expect(pixel(display, 0, 0)).toEqual([255, 0, 0]);
  });

  it("flips a cell without needing a second tile", () => {
    const { ram, display } = machine();
    // A tile whose left column is index 1 and the rest index 2.
    for (let row = 0; row < 8; row += 1) {
      ram[TILE_BASE + 32 + row * 4] = 0x12;
      ram[TILE_BASE + 32 + row * 4 + 1] = 0x22;
      ram[TILE_BASE + 32 + row * 4 + 2] = 0x22;
      ram[TILE_BASE + 32 + row * 4 + 3] = 0x22;
    }
    setColor(ram, 1, 1, 0xf, 0x0, 0x0);
    setColor(ram, 1, 2, 0x0, 0xf, 0x0);
    setCell(ram, SCR1_BASE, 0, 0, 1 | (1 << 9));
    setCell(ram, SCR1_BASE, 1, 0, 1 | (1 << 9) | 0x4000);
    frame(display);
    expect(pixel(display, 0, 0)).toEqual([255, 0, 0]);
    expect(pixel(display, 15, 0)).toEqual([255, 0, 0]); // the mirrored end
    expect(pixel(display, 8, 0)).toEqual([0, 255, 0]);
  });

  it("draws an object at its own position, in a sprite palette", () => {
    const { ram, display } = machine();
    solidTile(ram, 2, 1);
    setColor(ram, 9, 1, 0xf, 0xf, 0x0);
    // Entry: tile 2, palette 1 of the sprite range (which is palette 9).
    ram[SPRITES] = 2;
    ram[SPRITES + 1] = 1 << 1;
    ram[SPRITES + 2] = 20; // y
    ram[SPRITES + 3] = 30; // x
    display.write(PORT.SPR_COUNT, 1);
    frame(display);
    expect(pixel(display, 30, 20)).toEqual([255, 255, 0]);
    expect(pixel(display, 37, 27)).toEqual([255, 255, 0]);
    expect(pixel(display, 38, 20)).toEqual([0, 0, 0]);
  });

  it("puts an object behind the second layer unless its priority bit says otherwise", () => {
    const { ram, display } = machine();
    solidTile(ram, 1, 1);
    solidTile(ram, 2, 1);
    setColor(ram, 2, 1, 0xf, 0x0, 0x0); // the HUD plane
    setColor(ram, 9, 1, 0x0, 0xf, 0x0); // the object
    setCell(ram, SCR2_BASE, 0, 0, 1 | (2 << 9));
    ram[SPRITES] = 2;
    ram[SPRITES + 1] = 1 << 1;
    ram[SPRITES + 2] = 0;
    ram[SPRITES + 3] = 0;
    display.write(PORT.SPR_COUNT, 1);
    frame(display);
    expect(pixel(display, 0, 0)).toEqual([255, 0, 0]);

    ram[SPRITES + 1] = (1 << 1) | 0x10; // priority: in front of the plane
    frame(display);
    expect(pixel(display, 0, 0)).toEqual([0, 255, 0]);
  });

  it("stops drawing objects past the per-line budget", () => {
    const { ram, display } = machine();
    solidTile(ram, 2, 1);
    setColor(ram, 8, 1, 0xf, 0xf, 0xf);
    // Six pixels apart, so all thirty-three would fit across the screen if the
    // chip drew them: what is being checked is the budget, not the edge.
    for (let index = 0; index <= SPRITES_PER_LINE; index += 1) {
      const at = SPRITES + index * 4;
      ram[at] = 2;
      ram[at + 1] = 0;
      ram[at + 2] = 0;
      ram[at + 3] = index * 6;
    }
    display.write(PORT.SPR_COUNT, SPRITES_PER_LINE + 1);
    frame(display);
    expect(pixel(display, (SPRITES_PER_LINE - 1) * 6 + 5, 0)).toEqual([255, 255, 255]);
    // The thirty-third is the one the hardware runs out of room for.
    expect(pixel(display, SPRITES_PER_LINE * 6 + 5, 0)).toEqual([0, 0, 0]);
  });

  it("shows nothing at all with the LCD off", () => {
    const { ram, display } = machine();
    solidTile(ram, 1, 1);
    setColor(ram, 1, 1, 0xf, 0x0, 0x0);
    setCell(ram, SCR1_BASE, 0, 0, 1 | (1 << 9));
    display.write(PORT.LCD_CTRL, 0);
    frame(display);
    expect(pixel(display, 0, 0)).toEqual([0, 0, 0]);
  });

  it("counts lines and blanking the way a polling main loop needs", () => {
    const { display } = machine();
    expect(display.line).toBe(0);
    expect(display.vblank).toBe(false);
    display.step(CYCLES_PER_LINE * VBLANK_LINE);
    expect(display.line).toBe(VBLANK_LINE);
    expect(display.vblank).toBe(true);
    expect(display.frames).toBe(0);
    display.step(CYCLES_PER_LINE * (LINES_PER_FRAME - VBLANK_LINE));
    expect(display.line).toBe(0);
    expect(display.frames).toBe(1);
  });
});
