/**
 * The HuC6270 and the HuC6260, as a renderer.
 *
 * The picture is what a trace cannot see, so this is where the display half of
 * the core is pinned — and what it pins is chosen the way `packages/sms/test/
 * vdp.test.ts` chooses: the facts a demade cartridge depends on, each of which
 * would produce a game that ticks perfectly and shows the wrong thing.
 *
 * Four of them are this chip's rather than any other's. Video RAM is *words*
 * behind a port; a background cell carries its own sub-palette and reads colour
 * zero from one shared entry whatever palette it named; sprites are 16×16 with a
 * position bias that lets them hang off the top and the left; and the sprite
 * table is *copied* out of video RAM at the top of a blank rather than read from
 * it.
 */

import { describe, expect, it } from "vitest";

import { expandColor, MASTER_PER_LINE, REG, Vdc } from "../src/vdc.js";

/** Point the data port at a word address and write a run of words. */
function poke(vdc: Vdc, address: number, words: readonly number[]): void {
  vdc.writeVdc(0, REG.MAWR);
  vdc.writeVdc(2, address & 0xff);
  vdc.writeVdc(3, (address >> 8) & 0xff);
  vdc.writeVdc(0, REG.VRR);
  for (const word of words) {
    vdc.writeVdc(2, word & 0xff);
    vdc.writeVdc(3, (word >> 8) & 0xff);
  }
}

/** Write one register as a whole word. */
function reg(vdc: Vdc, register: number, value: number): void {
  vdc.writeVdc(0, register);
  vdc.writeVdc(2, value & 0xff);
  vdc.writeVdc(3, (value >> 8) & 0xff);
}

/** Set one colour-table entry. */
function colour(vdc: Vdc, entry: number, code: number): void {
  vdc.writeVce(2, entry & 0xff);
  vdc.writeVce(3, (entry >> 8) & 1);
  vdc.writeVce(4, code & 0xff);
  vdc.writeVce(5, (code >> 8) & 1);
}

/** A chip programmed for the frame a demade cartridge asks for. */
function display(): Vdc {
  const vdc = new Vdc();
  reg(vdc, REG.MWR, 0x0010); // a 64x32 map
  reg(vdc, REG.HDR, 0x031f); // 256 pixels wide
  reg(vdc, REG.VDW, 0x00df); // 224 lines
  reg(vdc, REG.BXR, 0);
  reg(vdc, REG.BYR, 0);
  return vdc;
}

/** The pixel at a screen position, as RGB. */
function pixelAt(vdc: Vdc, x: number, y: number): readonly [number, number, number] {
  const at = (y * 256 + x) * 4;
  return [
    vdc.framebuffer[at] as number,
    vdc.framebuffer[at + 1] as number,
    vdc.framebuffer[at + 2] as number,
  ];
}

/** Run one whole frame, so every visible line has been rendered. */
function frame(vdc: Vdc): void {
  const target = vdc.frames + 1;
  let guard = 0;
  while (vdc.frames < target) {
    vdc.step(MASTER_PER_LINE);
    if ((guard += 1) > 1000) throw new Error("pce: the raster never wrapped");
  }
}

/** A character whose every pixel is colour index `index`. */
function solidChar(index: number): number[] {
  const words: number[] = new Array(16).fill(0);
  for (let row = 0; row < 8; row += 1) {
    words[row] = ((index & 2 ? 0xff : 0) << 8) | (index & 1 ? 0xff : 0);
    words[8 + row] = ((index & 8 ? 0xff : 0) << 8) | (index & 4 ? 0xff : 0);
  }
  return words;
}

describe("the colour encoder", () => {
  it("packs green above red above blue, which is the format's one surprise", () => {
    expect(expandColor((7 << 6) | (0 << 3) | 0)).toEqual([0, 255, 0]);
    expect(expandColor((0 << 6) | (7 << 3) | 0)).toEqual([255, 0, 0]);
    expect(expandColor((0 << 6) | (0 << 3) | 7)).toEqual([0, 0, 255]);
    expect(expandColor(0)).toEqual([0, 0, 0]);
    expect(expandColor(0x1ff)).toEqual([255, 255, 255]);
  });

  it("replicates three bits into eight, which is the spec's DAC model", () => {
    // `linear` in `consoles/pce.ts`: the top bits repeat downward, so a code of
    // four is not 128 but 146.
    expect(expandColor(4 << 3)[0]).toBe(0x92);
  });
});

describe("video RAM", () => {
  it("is words behind a port, and the address steps when the high half lands", () => {
    const vdc = new Vdc();
    poke(vdc, 0x0100, [0x1234, 0x5678]);
    expect(vdc.vram[0x0100]).toBe(0x1234);
    expect(vdc.vram[0x0101]).toBe(0x5678);
  });

  it("steps by a whole map row when `CR` says so", () => {
    const vdc = new Vdc();
    // Increment select 10, in bits 12 and 11: sixty-four words, which is exactly
    // a row of the map a demade cartridge programs — and is what makes a scrolled
    // column one run. One bit out and it steps thirty-two.
    reg(vdc, REG.CR, 0x1000);
    poke(vdc, 0x0000, [1, 2, 3]);
    expect(vdc.vram[0x0000]).toBe(1);
    expect(vdc.vram[0x0040]).toBe(2);
    expect(vdc.vram[0x0080]).toBe(3);
  });
});

describe("the background plane", () => {
  it("takes a cell's sub-palette from the cell", () => {
    const vdc = display();
    // Two cells, same character, different palettes — which on this console is
    // one word each and needs no attribute table at all.
    poke(vdc, 128 * 16, solidChar(1));
    poke(vdc, 0x0000, [128 | (0 << 12), 128 | (3 << 12)]);
    colour(vdc, 0 * 16 + 1, (7 << 6) | 0 | 0); // palette 0, index 1: green
    colour(vdc, 3 * 16 + 1, 0 | (7 << 3) | 0); // palette 3, index 1: red
    reg(vdc, REG.CR, 0x0080); // background on
    frame(vdc);
    expect(pixelAt(vdc, 0, 0)).toEqual([0, 255, 0]);
    expect(pixelAt(vdc, 8, 0)).toEqual([255, 0, 0]);
  });

  it("shows the one shared backdrop for colour zero, whatever palette a cell named", () => {
    const vdc = display();
    poke(vdc, 128 * 16, solidChar(0));
    poke(vdc, 0x0000, [128 | (5 << 12)]);
    colour(vdc, 0, 0 | (7 << 3) | 0); // the backdrop: red
    colour(vdc, 5 * 16, (7 << 6) | 0 | 0); // palette 5's own entry zero: green
    reg(vdc, REG.CR, 0x0080);
    frame(vdc);
    // Red, because index zero reads entry zero and not the palette's own.
    expect(pixelAt(vdc, 0, 0)).toEqual([255, 0, 0]);
  });

  it("wraps the map at sixty-four columns and thirty-two rows", () => {
    const vdc = display();
    poke(vdc, 128 * 16, solidChar(1));
    colour(vdc, 1, (7 << 6) | 0 | 0);
    // One cell at map column 0, and a scroll that brings column 64 into view.
    poke(vdc, 0x0000, [128]);
    reg(vdc, REG.BXR, 64 * 8);
    reg(vdc, REG.CR, 0x0080);
    frame(vdc);
    expect(pixelAt(vdc, 0, 0)).toEqual([0, 255, 0]);
  });
});

describe("the object layer", () => {
  /** A 16×16 pattern whose every pixel is colour index 1. */
  function solidPattern(): number[] {
    const words: number[] = new Array(64).fill(0);
    for (let row = 0; row < 16; row += 1) words[row] = 0xffff;
    return words;
  }

  /** Put one sprite in the table and let the chip fetch it. */
  function sprite(vdc: Vdc, y: number, x: number, pattern: number, attr: number): void {
    poke(vdc, 0x7f00, [y, x, pattern << 1, attr]);
    reg(vdc, REG.DVSSR, 0x7f00);
  }

  it("draws a 16x16 object where the position's bias puts it", () => {
    const vdc = display();
    poke(vdc, 224 * 64, solidPattern());
    colour(vdc, 256 + 1, (7 << 6) | 0 | 0);
    // The bias is 64 lines and 32 pixels, so this is screen (0, 0).
    sprite(vdc, 64, 32, 224, 0x0080);
    reg(vdc, REG.CR, 0x0040); // objects on
    frame(vdc);
    frame(vdc); // the table is fetched at the top of a blank, so the next frame shows it
    expect(pixelAt(vdc, 0, 0)).toEqual([0, 255, 0]);
    expect(pixelAt(vdc, 15, 15)).toEqual([0, 255, 0]);
    expect(pixelAt(vdc, 16, 16)).toEqual([0, 0, 0]);
  });

  it("lets an object hang off the top and the left, which no other console here does", () => {
    const vdc = display();
    poke(vdc, 224 * 64, solidPattern());
    colour(vdc, 256 + 1, (7 << 6) | 0 | 0);
    // Eight lines above the screen and eight pixels left of it: the bias makes
    // that an ordinary position rather than one the hardware cannot express.
    sprite(vdc, 64 - 8, 32 - 8, 224, 0x0080);
    reg(vdc, REG.CR, 0x0040);
    frame(vdc);
    frame(vdc);
    expect(pixelAt(vdc, 0, 0)).toEqual([0, 255, 0]);
    expect(pixelAt(vdc, 7, 7)).toEqual([0, 255, 0]);
    expect(pixelAt(vdc, 8, 8)).toEqual([0, 0, 0]);
  });

  it("treats an object's colour zero as transparency and the background's as the backdrop", () => {
    const vdc = display();
    poke(vdc, 128 * 16, solidChar(2));
    poke(vdc, 0x0000, [128]);
    colour(vdc, 2, 0 | (7 << 3) | 0); // the background cell: red
    // A pattern of all zeroes, over that cell.
    poke(vdc, 224 * 64, new Array(64).fill(0));
    sprite(vdc, 64, 32, 224, 0x0080);
    reg(vdc, REG.CR, 0x00c0);
    frame(vdc);
    frame(vdc);
    expect(pixelAt(vdc, 0, 0)).toEqual([255, 0, 0]);
  });

  it("fetches its table rather than reading it, so a write lands a frame later", () => {
    const vdc = display();
    poke(vdc, 224 * 64, solidPattern());
    colour(vdc, 256 + 1, (7 << 6) | 0 | 0);
    reg(vdc, REG.DCR, 0x0010); // fetch every blank
    reg(vdc, REG.CR, 0x0040);
    poke(vdc, 0x7f00, [64, 32, 224 << 1, 0x0080]);
    reg(vdc, REG.DVSSR, 0x7f00);
    // The frame the write happened in still shows nothing: the fetch is at its
    // *end*, which is the whole reason the runtime uploads during display.
    frame(vdc);
    expect(pixelAt(vdc, 0, 0)).toEqual([0, 0, 0]);
    frame(vdc);
    expect(pixelAt(vdc, 0, 0)).toEqual([0, 255, 0]);
  });

  it("stops after sixteen objects on a line, which is the budget the compiler warns about", () => {
    const vdc = display();
    poke(vdc, 224 * 64, solidPattern());
    colour(vdc, 256 + 1, (7 << 6) | 0 | 0);
    // Twenty objects on one line, overlapping by half so that the far right of
    // the row is reachable *only* by ones past the limit.
    const table: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      table.push(64, 32 + index * 8, 224 << 1, 0x0080);
    }
    poke(vdc, 0x7f00, table);
    reg(vdc, REG.DVSSR, 0x7f00);
    reg(vdc, REG.CR, 0x0040);
    frame(vdc);
    frame(vdc);
    // Screen x 120 is the fifteenth object's, and x 160 is the twentieth's alone.
    expect(pixelAt(vdc, 120, 0)).toEqual([0, 255, 0]);
    expect(pixelAt(vdc, 160, 0)).toEqual([0, 0, 0]);
  });
});

describe("the interrupt", () => {
  it("is raised at the top of the blank and cleared by reading the status", () => {
    const vdc = display();
    reg(vdc, REG.CR, 0x0088); // background on, vertical blank interrupt enabled
    expect(vdc.irq).toBe(false);
    frame(vdc);
    expect(vdc.irq).toBe(true);
    // Reading the status is the whole of the acknowledgement on this chip.
    expect(vdc.readVdc(0) & 0x20).toBe(0x20);
    expect(vdc.irq).toBe(false);
  });

  it("stays quiet when `CR` did not ask for it", () => {
    const vdc = display();
    reg(vdc, REG.CR, 0x0080);
    frame(vdc);
    expect(vdc.irq).toBe(false);
  });
});
