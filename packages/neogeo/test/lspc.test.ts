/**
 * The LSPC's own tests, and every case is one the layer above cannot see.
 *
 * A trace is per tick and says nothing about pixels, so what has to be pinned
 * here is the arrangement the Demotic backend is about to be written against:
 * that a row of strips really is a tilemap, that the sticky bit really carries
 * one position between all of them, and that the fix layer really is in front
 * and really is column-major. Get any of those wrong and the backend above
 * compiles a perfect game onto a screen showing the wrong thing.
 */

import {
  decodeAttribute,
  decodeScb3,
  decodeScb4,
  encodeAttribute,
  encodeScb3,
  encodeScb4,
  expandColor,
  FIX_MAP,
  FIX_ROWS,
  Lspc,
  SCB1,
  SCB1_STRIDE,
  SCB3,
  SCB4,
} from "@demake/neogeo";
import { describe, expect, it } from "vitest";

/** One solid 16×16 tile of colour index `value`, at tile number `tile`. */
function characters(tile: number, value: number): Uint8Array {
  const rom = new Uint8Array((tile + 1) * 256);
  rom.fill(value, tile * 256, (tile + 1) * 256);
  return rom;
}

/** One solid 8×8 fix tile of colour index `value`. */
function fixCharacters(tile: number, value: number): Uint8Array {
  const rom = new Uint8Array((tile + 1) * 64);
  rom.fill(value, tile * 64, (tile + 1) * 64);
  return rom;
}

/**
 * The colours the cases below expect, taken from the decoder rather than written
 * out: `$0F00` is red at *five* bits (`0b11110`), so it expands to 247 and not
 * 255, and a hand-written 255 is a test asserting a lattice the console has not
 * got.
 */
const RED = expandColor(0x0f00);
const GREEN = expandColor(0x00f0);
const BLACK: [number, number, number] = [0, 0, 0];

function pixelAt(lspc: Lspc, x: number, y: number): [number, number, number] {
  const frame = lspc.render();
  const at = (y * frame.width + x) * 4;
  return [frame.data[at]!, frame.data[at + 1]!, frame.data[at + 2]!];
}

describe("SCB field encoding", () => {
  it("round-trips a strip's position through SCB3 and SCB4", () => {
    for (const y of [0, 1, 16, 100, 223, 495]) {
      for (const height of [0, 1, 16, 32, 63]) {
        for (const sticky of [false, true]) {
          const word = encodeScb3({ y, sticky, height });
          expect(decodeScb3(word)).toEqual({ y, sticky, height });
        }
      }
    }
    for (const x of [0, 1, 16, 320, 511]) expect(decodeScb4(encodeScb4(x))).toBe(x);
  });

  it("round-trips a tile's attribute word", () => {
    const attribute = { palette: 0xa5, tileHigh: 0xd, vflip: true, hflip: false };
    expect(decodeAttribute(encodeAttribute(attribute))).toEqual(attribute);
  });

  it("expands a colour word five bits a channel, high nibble first", () => {
    // Bits 11-8 are red's high four; bit 14 is its least significant.
    expect(expandColor(0x0f00)).toEqual([expand5(0b11110), 0, 0]);
    expect(expandColor(0x0f00)).toEqual([247, 0, 0]);
    expect(expandColor(0x4f00)).toEqual([expand5(0b11111), 0, 0]);
    expect(expandColor(0x000f)).toEqual([0, 0, expand5(0b11110)]);
    expect(expandColor(0x0000)).toEqual(BLACK);
  });
});

function expand5(value: number): number {
  return (value << 3) | (value >> 2);
}

describe("a strip is a column of a tilemap", () => {
  /** A plane whose cell (column, row) can be written and read back as a pixel. */
  function plane(): Lspc {
    const lspc = new Lspc({ characters: characters(1, 3), fixCharacters: new Uint8Array(64) });
    lspc.palettes[0]![3] = 0x0f00; // palette 0, index 3 — red.
    return lspc;
  }

  it("draws the tile a cell names, at the cell's own place", () => {
    const lspc = plane();
    // One strip at the origin, sixteen tiles tall, with row 2 carrying tile 1.
    lspc.vram[SCB3] = encodeScb3({ y: 0, sticky: false, height: 16 });
    lspc.vram[SCB4] = encodeScb4(0);
    lspc.vram[SCB1 + 2 * 2] = 1;
    lspc.vram[SCB1 + 2 * 2 + 1] = encodeAttribute({
      palette: 0,
      tileHigh: 0,
      vflip: false,
      hflip: false,
    });

    // Row 2 of a 16-pixel grid is y 32..47, and the strip is 16 wide.
    expect(pixelAt(lspc, 0, 32)).toEqual(RED);
    expect(pixelAt(lspc, 15, 47)).toEqual(RED);
    // Its neighbours are backdrop, because no other cell was written.
    expect(pixelAt(lspc, 16, 32)).toEqual(BLACK);
    expect(pixelAt(lspc, 0, 31)).toEqual(BLACK);
  });

  it("carries one position across a sticky chain, which is the scroll", () => {
    const lspc = plane();
    // An anchor and two strips stuck to it: three columns, one position.
    lspc.vram[SCB3] = encodeScb3({ y: 0, sticky: false, height: 16 });
    lspc.vram[SCB4] = encodeScb4(0);
    for (let strip = 1; strip <= 2; strip += 1) {
      lspc.vram[SCB3 + strip] = encodeScb3({ y: 0, sticky: true, height: 16 });
      // Deliberately a wrong X: a sticky strip must ignore its own.
      lspc.vram[SCB4 + strip] = encodeScb4(300);
    }
    for (let strip = 0; strip <= 2; strip += 1) {
      lspc.vram[SCB1 + strip * SCB1_STRIDE] = 1;
      lspc.vram[SCB1 + strip * SCB1_STRIDE + 1] = 0;
    }

    // Three strips, side by side, from the anchor's X.
    expect(pixelAt(lspc, 0, 0)).toEqual(RED);
    expect(pixelAt(lspc, 16, 0)).toEqual(RED);
    expect(pixelAt(lspc, 32, 0)).toEqual(RED);
    expect(pixelAt(lspc, 48, 0)).toEqual(BLACK);

    // Move the anchor alone: the whole chain follows. That is the property the
    // backend's camera rests on — one write scrolls the plane.
    lspc.vram[SCB4] = encodeScb4(8);
    expect(pixelAt(lspc, 0, 0)).toEqual(BLACK);
    expect(pixelAt(lspc, 8, 0)).toEqual(RED);
    expect(pixelAt(lspc, 40, 0)).toEqual(RED);

    // And vertically, from the same anchor.
    lspc.vram[SCB3] = encodeScb3({ y: 4, sticky: false, height: 16 });
    expect(pixelAt(lspc, 8, 0)).toEqual(BLACK);
    expect(pixelAt(lspc, 8, 4)).toEqual(RED);
    expect(pixelAt(lspc, 40, 4)).toEqual(RED);
  });

  it("honours the horizontal flip bit, so one tile stands for two", () => {
    // Half a tile: the left eight pixels only.
    const rom = new Uint8Array(512);
    for (let row = 0; row < 16; row += 1) rom.fill(3, 256 + row * 16, 256 + row * 16 + 8);
    const lspc = new Lspc({ characters: rom, fixCharacters: new Uint8Array(64) });
    lspc.palettes[0]![3] = 0x0f00;
    lspc.vram[SCB3] = encodeScb3({ y: 0, sticky: false, height: 1 });
    lspc.vram[SCB4] = encodeScb4(0);
    lspc.vram[SCB1] = 1;

    lspc.vram[SCB1 + 1] = 0;
    expect(pixelAt(lspc, 2, 0)).toEqual(RED);
    expect(pixelAt(lspc, 13, 0)).toEqual(BLACK);

    lspc.vram[SCB1 + 1] = encodeAttribute({
      palette: 0,
      tileHigh: 0,
      vflip: false,
      hflip: true,
    });
    expect(pixelAt(lspc, 2, 0)).toEqual(BLACK);
    expect(pixelAt(lspc, 13, 0)).toEqual(RED);
  });
});

describe("the fix layer", () => {
  function withFix(): Lspc {
    const lspc = new Lspc({ characters: characters(1, 3), fixCharacters: fixCharacters(5, 2) });
    lspc.palettes[0]![3] = 0x0f00; // sprite red
    lspc.palettes[0]![2] = 0x00f0; // fix green
    return lspc;
  }

  it("is stored column-major, which is not how a tilemap is stored", () => {
    const lspc = withFix();
    // Cell (column 3, row 1). Column-major means column × 32 + row.
    lspc.vram[FIX_MAP + 3 * FIX_ROWS + 1] = 5;
    expect(pixelAt(lspc, 3 * 8 + 2, 1 * 8 + 2)).toEqual(GREEN);
    // The transposed reading would have put it here instead.
    expect(pixelAt(lspc, 1 * 8 + 2, 3 * 8 + 2)).toEqual(BLACK);
  });

  it("draws in front of every sprite, which is what makes it the HUD layer", () => {
    const lspc = withFix();
    lspc.vram[SCB3] = encodeScb3({ y: 0, sticky: false, height: 16 });
    lspc.vram[SCB4] = encodeScb4(0);
    lspc.vram[SCB1] = 1;
    lspc.vram[SCB1 + 1] = 0;
    expect(pixelAt(lspc, 2, 2)).toEqual(RED);

    lspc.vram[FIX_MAP] = 5;
    expect(pixelAt(lspc, 2, 2)).toEqual(GREEN);
  });
});
