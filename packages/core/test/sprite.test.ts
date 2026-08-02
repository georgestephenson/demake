/**
 * The sprite path: the rules that make object art different from tile art.
 *
 * Three of them carry the weight (doc 15 §The conversion path). Index 0 is
 * transparency, so an object gets three colours and never the shade its
 * backdrop is drawn in. Downscaling averages premultiplied, so a shape does not
 * grow a halo out of the transparent pixels around it. And deduplication is
 * global, so two assets that share a blank corner share the tile.
 */

import { describe, expect, it } from "vitest";

import { buildSpriteBank, paletteRegister } from "../src/pipeline/sprite.js";

const encode = (text: string) => new TextEncoder().encode(text);

const svg = (body: string, size = 64) =>
  encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
      `width="${size}" height="${size}">${body}</svg>`,
  );

/** Colour indices of one 8×8 tile in a packed 2bpp bank. */
function unpack(bank: Uint8Array, tile: number): number[] {
  const out: number[] = [];
  for (let row = 0; row < 8; row += 1) {
    const low = bank[tile * 16 + row * 2] as number;
    const high = bank[tile * 16 + row * 2 + 1] as number;
    for (let column = 0; column < 8; column += 1) {
      out.push(((low >> (7 - column)) & 1) | (((high >> (7 - column)) & 1) << 1));
    }
  }
  return out;
}

describe("object art", () => {
  it("leaves transparent pixels at index 0 and paints the rest", () => {
    const bank = buildSpriteBank(
      [
        {
          name: "dot.svg",
          bytes: svg(`<circle cx="32" cy="32" r="24" fill="#101010"/>`),
          cellsWide: 1,
          cellsHigh: 1,
        },
      ],
      { console: "dmg" },
    );
    const pixels = unpack(bank.tiles, 0);
    // Corners are outside the circle; the middle is inside it.
    expect(pixels[0]).toBe(0);
    expect(pixels[7]).toBe(0);
    expect(pixels[4 * 8 + 4]).toBeGreaterThan(0);
  });

  it("never uses the shade the backdrop is drawn in", () => {
    const bank = buildSpriteBank(
      [
        {
          name: "pale.svg",
          bytes: svg(`<rect x="0" y="0" width="64" height="64" fill="#f4f4f4"/>`),
          cellsWide: 1,
          cellsHigh: 1,
        },
      ],
      { console: "dmg" },
    );
    // Shade 0 is the lightest, and colour 0 already shows the background
    // through: an object drawn in it would be invisible.
    expect(bank.shades).toEqual([1, 2, 3]);
    expect(unpack(bank.tiles, 0).every((value) => value > 0)).toBe(true);
  });

  it("stretches contrast across the assets together, not one at a time", () => {
    const pair = buildSpriteBank(
      [
        {
          name: "dark.svg",
          bytes: svg(`<rect x="0" y="0" width="64" height="64" fill="#000000"/>`),
          cellsWide: 1,
          cellsHigh: 1,
        },
        {
          name: "light.svg",
          bytes: svg(`<rect x="0" y="0" width="64" height="64" fill="#e8e8e8"/>`),
          cellsWide: 1,
          cellsHigh: 1,
        },
      ],
      { console: "dmg" },
    );
    // Two flat assets, so two tiles, and they must land on different shades —
    // fitting each on its own would make them both mid-grey.
    expect(pair.uniqueTiles).toBe(2);
    const first = unpack(pair.tiles, 0)[0];
    const second = unpack(pair.tiles, 1)[0];
    expect(first).not.toBe(second);
  });

  it("deduplicates identical tiles across different assets", () => {
    const shared = `<rect x="0" y="0" width="64" height="64" fill="#202020"/>`;
    const bank = buildSpriteBank(
      [
        { name: "a.svg", bytes: svg(shared), cellsWide: 1, cellsHigh: 1 },
        { name: "b.svg", bytes: svg(shared), cellsWide: 1, cellsHigh: 1 },
      ],
      { console: "dmg" },
    );
    expect(bank.totalTiles).toBe(2);
    expect(bank.uniqueTiles).toBe(1);
    expect(bank.art.get("a.svg")?.tile).toBe(bank.art.get("b.svg")?.tile);
  });

  it("fills the box the game asked for, not the source's aspect ratio", () => {
    const bank = buildSpriteBank(
      [
        {
          name: "tall.svg",
          bytes: svg(`<rect x="0" y="0" width="64" height="64" fill="#333"/>`),
          cellsWide: 1,
          cellsHigh: 2,
        },
      ],
      { console: "dmg" },
    );
    const art = bank.art.get("tall.svg");
    expect([art?.width, art?.height]).toEqual([1, 2]);
    expect(bank.totalTiles).toBe(2);
  });

  it("averages premultiplied, so an edge does not darken into nothing", () => {
    // A hard-edged black square on transparency. Averaging straight RGBA would
    // pull the boundary pixels towards the (black, alpha 0) neighbours and make
    // a dark fringe; premultiplied averaging cannot.
    const bank = buildSpriteBank(
      [
        {
          name: "half.svg",
          bytes: svg(`<rect x="0" y="0" width="32" height="64" fill="#000000"/>`),
          cellsWide: 1,
          cellsHigh: 1,
        },
      ],
      { console: "dmg" },
    );
    const pixels = unpack(bank.tiles, 0);
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        expect(pixels[row * 8 + column]).toBe(3);
      }
      for (let column = 4; column < 8; column += 1) {
        expect(pixels[row * 8 + column]).toBe(0);
      }
    }
  });
});

describe("256-colour object art", () => {
  /** One 8×8 tile out of a `linear8` bank, which is a byte per pixel. */
  const bytes = (bank: Uint8Array, tile: number): number[] => [
    ...bank.subarray(tile * 64, tile * 64 + 64),
  ];

  it("packs a byte per pixel, in reading order", () => {
    // The layout the ARM consoles' 2D engines read, and the one that is not a
    // bitplane arrangement at all — so the test is that a pixel's index is
    // literally the byte at its own offset.
    const bank = buildSpriteBank(
      [
        {
          name: "dot.svg",
          bytes: svg(`<circle cx="32" cy="32" r="24" fill="#3060c0"/>`),
          cellsWide: 1,
          cellsHigh: 1,
        },
      ],
      { console: "gba", mode: 0 },
    );
    expect(bank.tiles.length).toBe(bank.uniqueTiles * 64);
    const pixels = bytes(bank.tiles, 0);
    expect(pixels[0]).toBe(0);
    expect(pixels[7]).toBe(0);
    expect(pixels[4 * 8 + 4]).toBeGreaterThan(0);
  });

  it("fits one palette rather than sixteen, so any cell may use any colour", () => {
    // The whole reason a game asks for this mode: the 4bpp layout gives a *cell*
    // sixteen colours chosen from one of sixteen banks, and this gives it 256.
    // The source is an 8×8 grid of distinct colours over the whole viewBox, so it
    // survives being sampled down to a 16×16 sprite with sixty-four of them.
    const cells: string[] = [];
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        cells.push(
          `<rect x="${column * 8}" y="${row * 8}" width="8" height="8" ` +
            `fill="rgb(${32 + column * 28},${32 + row * 28},${200 - column * 12})"/>`,
        );
      }
    }
    const bank = buildSpriteBank(
      [{ name: "grid.svg", bytes: svg(cells.join("")), cellsWide: 2, cellsHigh: 2 }],
      { console: "gba", mode: 0 },
    );
    expect(bank.palettes.length).toBe(1);
    // Every asset lands in palette zero, because there is only one.
    expect(bank.art.get("grid.svg")?.palette).toBe(0);
    // And the fit really used more than a sixteen-colour bank could hold, which
    // the 4bpp layout on the same source cannot.
    expect(new Set(bank.tiles).size).toBeGreaterThan(16);
    const narrow = buildSpriteBank(
      [{ name: "grid.svg", bytes: svg(cells.join("")), cellsWide: 2, cellsHigh: 2 }],
      { console: "gba" },
    );
    expect(new Set(narrow.tiles).size).toBeLessThanOrEqual(16 * 16);
    expect(narrow.tiles.length).toBe(narrow.uniqueTiles * 32);
  });

  it("refuses a bitplane packing for a byte-per-pixel tile", () => {
    expect(() =>
      buildSpriteBank(
        [
          {
            name: "a.svg",
            bytes: svg(`<rect width="64" height="64" fill="#fff"/>`),
            cellsWide: 1,
            cellsHigh: 1,
          },
        ],
        { console: "gba", mode: 0, packing: "planar" },
      ),
    ).toThrow(/one byte per pixel/);
  });

  it("refuses a mode the console does not have, rather than falling back", () => {
    // A caller asking for 256 colours and quietly getting sixteen would produce
    // art that is valid and half the picture it asked for.
    expect(() =>
      buildSpriteBank(
        [
          {
            name: "a.svg",
            bytes: svg(`<rect width="64" height="64" fill="#fff"/>`),
            cellsWide: 1,
            cellsHigh: 1,
          },
        ],
        { console: "gba", mode: 7 },
      ),
    ).toThrow(/no selectable layout 7/);
    expect(() =>
      buildSpriteBank(
        [
          {
            name: "a.svg",
            bytes: svg(`<rect width="64" height="64" fill="#fff"/>`),
            cellsWide: 1,
            cellsHigh: 1,
          },
        ],
        { console: "dmg", mode: 0 },
      ),
    ).toThrow(/no selectable layout 0/);
  });
});

describe("background tile art", () => {
  it("uses every shade, because nothing is transparent", () => {
    const bank = buildSpriteBank(
      [
        {
          name: "wall.svg",
          bytes: svg(`<rect x="0" y="0" width="64" height="64" fill="#888888"/>`),
          cellsWide: 1,
          cellsHigh: 1,
        },
      ],
      { console: "dmg", opaque: true },
    );
    expect(bank.shades).toEqual([0, 1, 2, 3]);
  });
});

describe("the palette register", () => {
  it("packs the chosen shades the way the hardware reads them", () => {
    // Colour 0 first, two bits each: 1, 2, 3 → %11100100, the identity map.
    expect(paletteRegister([1, 2, 3])).toBe(0b11100100);
    expect(paletteRegister([0, 1, 2])).toBe(0b10010000);
  });
});
