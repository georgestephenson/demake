/**
 * The S-PPU's renderer, against pictures a test builds by hand.
 *
 * The counterpart of `packages/sms/test/vdp.test.ts`, and the cases are the
 * chip's own oddities rather than a sweep: each one here is something a
 * plausible renderer gets wrong, and each one produces a picture that is *nearly*
 * right — which is exactly the class of bug a framebuffer diff in an E2E finds
 * expensively and a unit test finds by name.
 */

import { describe, expect, it } from "vitest";

import { Ppu, SCREEN_HEIGHT, SCREEN_WIDTH, MASTER_PER_LINE } from "../src/ppu.js";

/** A colour, as this chip stores one. */
function bgr555(r: number, g: number, b: number): number {
  return ((b & 31) << 10) | ((g & 31) << 5) | (r & 31);
}

/** Put an 8×8 tile of one colour index at a word address. */
function solidTile(ppu: Ppu, wordBase: number, index: number): void {
  for (let row = 0; row < 8; row += 1) {
    const low = ((index & 1) !== 0 ? 0xff : 0) | ((index & 2) !== 0 ? 0xff00 : 0);
    const high = ((index & 4) !== 0 ? 0xff : 0) | ((index & 8) !== 0 ? 0xff00 : 0);
    ppu.vram[wordBase + row] = low;
    ppu.vram[wordBase + 8 + row] = high;
  }
}

/** A PPU with mode 1's BG1 on, its tilemap at zero and its characters at `$2000`. */
function ready(): Ppu {
  const ppu = new Ppu();
  ppu.writeRegister(0x2100, 0x0f); // picture on, full brightness
  ppu.writeRegister(0x2105, 0x01); // mode 1
  ppu.writeRegister(0x2107, 0x01); // tilemap at word 0, 64×32
  ppu.writeRegister(0x210b, 0x02); // BG1 characters at word $2000
  ppu.writeRegister(0x2101, 0x01); // objects from the same bank, 8×8
  ppu.writeRegister(0x212c, 0x11); // BG1 and objects on the main screen
  return ppu;
}

/** Render a whole frame's worth of scanlines. */
function frame(ppu: Ppu): void {
  for (let line = 0; line < 262; line += 1) ppu.step(MASTER_PER_LINE);
}

/** The pixel at (x, y), as r,g,b. */
function pixel(ppu: Ppu, x: number, y: number): [number, number, number] {
  const at = (y * SCREEN_WIDTH + x) * 4;
  return [
    ppu.framebuffer[at] as number,
    ppu.framebuffer[at + 1] as number,
    ppu.framebuffer[at + 2] as number,
  ];
}

describe("the S-PPU", () => {
  it("shows the fixed backdrop through a transparent background pixel", () => {
    const ppu = ready();
    ppu.cgram[0] = bgr555(31, 0, 0);
    // Tile zero is all index zero, and the map is all tile zero.
    frame(ppu);
    expect(pixel(ppu, 10, 10)).toEqual([255, 0, 0]);
  });

  it("draws a background cell from the tile the map names, in the palette it names", () => {
    const ppu = ready();
    ppu.cgram[0] = bgr555(0, 0, 0);
    ppu.cgram[3 * 16 + 5] = bgr555(0, 31, 0);
    solidTile(ppu, 0x2000 + 1 * 16, 5);
    // Cell (2, 3): tile 1, palette 3.
    ppu.vram[3 * 32 + 2] = 1 | (3 << 10);
    frame(ppu);
    expect(pixel(ppu, 2 * 8 + 4, 3 * 8 + 4)).toEqual([0, 255, 0]);
  });

  it("shows background line VOFS + N + 1 on screen line N, which is why a build writes -1", () => {
    const ppu = ready();
    ppu.cgram[0] = bgr555(0, 0, 0);
    ppu.cgram[1] = bgr555(31, 31, 31);
    solidTile(ppu, 0x2000 + 1 * 16, 1);
    // A single cell on background row 0.
    ppu.vram[0] = 1;
    frame(ppu);
    // With no offset, background line 1 is on screen line 0 — so the cell's top
    // row is missing and its bottom is at screen line 6.
    expect(pixel(ppu, 4, 6)).toEqual([255, 255, 255]);
    expect(pixel(ppu, 4, 7)).toEqual([0, 0, 0]);
    // Written as minus one, the cell lands where it was drawn.
    ppu.writeRegister(0x210e, 0xff);
    ppu.writeRegister(0x210e, 0x03);
    frame(ppu);
    expect(pixel(ppu, 4, 0)).toEqual([255, 255, 255]);
    expect(pixel(ppu, 4, 7)).toEqual([255, 255, 255]);
    expect(pixel(ppu, 4, 8)).toEqual([0, 0, 0]);
  });

  it("puts the second 32×32 screen a kilobyte away, not one cell", () => {
    const ppu = ready();
    ppu.cgram[0] = bgr555(0, 0, 0);
    ppu.cgram[1] = bgr555(31, 31, 31);
    solidTile(ppu, 0x2000 + 1 * 16, 1);
    // Column 32 of a 64-wide map, which is word $400 rather than word 32.
    ppu.vram[0x400] = 1;
    ppu.writeRegister(0x210d, 0x00);
    ppu.writeRegister(0x210d, 0x01); // scroll right 256 pixels: column 32 at x = 0
    ppu.writeRegister(0x210e, 0xff);
    ppu.writeRegister(0x210e, 0x03);
    frame(ppu);
    expect(pixel(ppu, 4, 4)).toEqual([255, 255, 255]);
  });

  it("reads a 4bpp tile as two 2bpp tiles stacked", () => {
    const ppu = ready();
    ppu.cgram[0] = bgr555(0, 0, 0);
    ppu.cgram[9] = bgr555(0, 0, 31);
    // Index 9 is planes 0 and 3, which live sixteen bytes apart.
    ppu.vram[0x2000] = 0x00ff; // plane 0, row 0
    ppu.vram[0x2008] = 0xff00; // plane 3, row 0 — sixteen bytes on, not one word
    ppu.vram[0] = 0;
    ppu.writeRegister(0x210e, 0xff);
    ppu.writeRegister(0x210e, 0x03);
    frame(ppu);
    expect(pixel(ppu, 0, 0)).toEqual([0, 0, 255]);
  });

  it("draws objects in front of the background, and entry zero in front of entry one", () => {
    const ppu = ready();
    ppu.cgram[0] = bgr555(0, 0, 0);
    ppu.cgram[128 + 1] = bgr555(31, 0, 0);
    ppu.cgram[128 + 16 + 1] = bgr555(0, 31, 0);
    solidTile(ppu, 0x2000 + 2 * 16, 1);
    // Two objects at the same place: entry one in green, entry zero in red.
    const put = (index: number, x: number, y: number, palette: number): void => {
      ppu.oam[index * 4] = x;
      ppu.oam[index * 4 + 1] = y;
      ppu.oam[index * 4 + 2] = 2;
      ppu.oam[index * 4 + 3] = 0x20 | (palette << 1);
    };
    put(0, 16, 16, 0);
    put(1, 16, 16, 1);
    frame(ppu);
    expect(pixel(ppu, 20, 20)).toEqual([255, 0, 0]);
  });

  it("evaluates thirty-two objects a line and no more", () => {
    const ppu = ready();
    ppu.cgram[0] = bgr555(0, 0, 0);
    ppu.cgram[128 + 1] = bgr555(31, 31, 31);
    solidTile(ppu, 0x2000 + 2 * 16, 1);
    for (let index = 0; index < 40; index += 1) {
      ppu.oam[index * 4] = index * 6;
      ppu.oam[index * 4 + 1] = 100;
      ppu.oam[index * 4 + 2] = 2;
      ppu.oam[index * 4 + 3] = 0x20;
    }
    frame(ppu);
    // The first thirty-two are drawn; the ones past them are dropped, which is
    // what the hardware does and what the profile's `perLine` promises.
    expect(pixel(ppu, 31 * 6 + 2, 102)).toEqual([255, 255, 255]);
    expect(pixel(ppu, 38 * 6 + 2, 102)).toEqual([0, 0, 0]);
  });

  it("draws nothing at all under forced blank", () => {
    const ppu = ready();
    ppu.cgram[0] = bgr555(31, 31, 31);
    ppu.writeRegister(0x2100, 0x80);
    frame(ppu);
    expect(pixel(ppu, 10, 10)).toEqual([0, 0, 0]);
  });

  it("increments the video-RAM address after the high byte, which is what a word store needs", () => {
    const ppu = ready();
    ppu.writeRegister(0x2115, 0x80);
    ppu.writeRegister(0x2116, 0x10);
    ppu.writeRegister(0x2117, 0x00);
    ppu.writeRegister(0x2118, 0x34);
    ppu.writeRegister(0x2119, 0x12);
    ppu.writeRegister(0x2118, 0x78);
    ppu.writeRegister(0x2119, 0x56);
    expect(ppu.vram[0x10]).toBe(0x1234);
    expect(ppu.vram[0x11]).toBe(0x5678);
  });

  it("raises the vertical blank once a frame, after the last visible line", () => {
    const ppu = ready();
    let starts = 0;
    for (let line = 0; line < 262 * 2; line += 1) {
      ppu.step(MASTER_PER_LINE);
      if (ppu.vblankStarted) {
        ppu.vblankStarted = false;
        starts += 1;
        expect(ppu.line).toBe(SCREEN_HEIGHT + 1);
      }
    }
    expect(starts).toBe(2);
  });
});
