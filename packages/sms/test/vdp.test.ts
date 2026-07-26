/**
 * The VDP, as a renderer, and the console around it.
 *
 * These are the assertions the Demotic backend's art path will be written
 * against, so they are stated in the backend's terms: a character in the format
 * the image engine packs, a name-table entry with its flip and palette bits, a
 * sprite that stops where the list terminator says it does, and the two scroll
 * registers with the sign the hardware gives them.
 *
 * The colour checks are the ones that decide whether a demade picture arrives
 * looking like itself: two bits expand by replication on a Master System and
 * four do on a Game Gear, which is `linear` in the console spec's DAC field and
 * has to be the same arithmetic in both places.
 */

import { SMS_ROM_SIZE, packSegaRom } from "@demake/core";
import { describe, expect, it } from "vitest";

import { Sms } from "../src/machine.js";
import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  GG_HEIGHT,
  GG_LEFT,
  GG_TOP,
  GG_WIDTH,
  Vdp,
} from "../src/vdp.js";

/** Set a VDP register through the control port's two-byte protocol. */
function setRegister(vdp: Vdp, register: number, value: number): void {
  vdp.writeControl(value);
  vdp.writeControl(0x80 | register);
}

/** Point the data port at a VRAM address for writing. */
function addressVram(vdp: Vdp, address: number): void {
  vdp.writeControl(address & 0xff);
  vdp.writeControl(0x40 | ((address >> 8) & 0x3f));
}

/** Point the data port at colour RAM. */
function addressCram(vdp: Vdp, entry: number): void {
  vdp.writeControl(entry);
  vdp.writeControl(0xc0);
}

/**
 * A character whose every pixel is `value`, in the row-interleaved 4bpp format.
 *
 * Four bytes a row, one per bitplane, and the left pixel is the high bit — which
 * is the layout `packPlanar` produces for this family.
 */
function solidTile(value: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let row = 0; row < 8; row += 1) {
    for (let plane = 0; plane < 4; plane += 1) {
      bytes[row * 4 + plane] = (value >> plane) & 1 ? 0xff : 0x00;
    }
  }
  return bytes;
}

/** A character with the left half `left` and the right half `right`. */
function splitTile(left: number, right: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let row = 0; row < 8; row += 1) {
    for (let plane = 0; plane < 4; plane += 1) {
      bytes[row * 4 + plane] = ((left >> plane) & 1 ? 0xf0 : 0) | ((right >> plane) & 1 ? 0x0f : 0);
    }
  }
  return bytes;
}

function writeVram(vdp: Vdp, address: number, bytes: ArrayLike<number>): void {
  addressVram(vdp, address);
  for (let index = 0; index < bytes.length; index += 1) vdp.writeData(bytes[index] as number);
}

/** A VDP set up the way a generated game sets one up, then run for one frame. */
function display(build: (vdp: Vdp) => void, variant: "sms" | "gg" = "sms"): Vdp {
  const vdp = new Vdp(variant);
  setRegister(vdp, 0, 0x06); // mode 4, no line interrupt
  setRegister(vdp, 1, 0x60); // display on, frame interrupt on
  setRegister(vdp, 2, 0xff); // name table at $3800
  setRegister(vdp, 5, 0xff); // sprite table at $3F00
  setRegister(vdp, 6, 0xfb); // sprite characters at $0000
  build(vdp);
  vdp.step(262 * 228);
  return vdp;
}

/** The palette index the VDP put at a pixel. */
function indexAt(vdp: Vdp, x: number, y: number): number {
  return vdp.indices[y * FRAME_WIDTH + x] as number;
}

describe("the Sega VDP", () => {
  it("draws a character from the name table in the packed 4bpp format", () => {
    const vdp = display((chip) => {
      writeVram(chip, 0x0020, solidTile(5)); // character 1
      writeVram(chip, 0x3800, [0x01, 0x00]); // cell (0,0) → character 1, palette 0
    });
    expect(indexAt(vdp, 0, 0)).toBe(5);
    expect(indexAt(vdp, 7, 7)).toBe(5);
    // The cell beside it was never written, so it is character 0 — all zeroes,
    // which is transparent, which shows the backdrop.
    expect(indexAt(vdp, 8, 0)).toBe(16);
  });

  it("selects the second palette from the name-table entry's own bit", () => {
    const vdp = display((chip) => {
      writeVram(chip, 0x0020, solidTile(3));
      writeVram(chip, 0x3800, [0x01, 0x08]); // palette select set
    });
    expect(indexAt(vdp, 0, 0)).toBe(16 + 3);
  });

  it("flips a character horizontally and vertically from the map", () => {
    const vdp = display((chip) => {
      writeVram(chip, 0x0020, splitTile(1, 2));
      writeVram(chip, 0x3800, [0x01, 0x00]); // plain
      writeVram(chip, 0x3802, [0x01, 0x02]); // horizontal flip
    });
    expect(indexAt(vdp, 0, 0)).toBe(1);
    expect(indexAt(vdp, 7, 0)).toBe(2);
    expect(indexAt(vdp, 8, 0)).toBe(2);
    expect(indexAt(vdp, 15, 0)).toBe(1);
  });

  it("scrolls the picture right as the horizontal register rises", () => {
    // The sign that catches people out: `R8` moves the *background*, so a cell
    // drawn at column 0 appears further right as the register grows.
    const vdp = display((chip) => {
      writeVram(chip, 0x0020, solidTile(7));
      writeVram(chip, 0x3800, [0x01, 0x00]);
      setRegister(chip, 8, 16);
    });
    expect(indexAt(vdp, 0, 0)).toBe(16); // backdrop where the cell used to be
    expect(indexAt(vdp, 16, 0)).toBe(7);
    expect(indexAt(vdp, 23, 0)).toBe(7);
  });

  it("wraps vertical scrolling at the map's twenty-eight rows, not the screen's", () => {
    // The inheritance from the TMS9918 that a renderer written against the
    // screen's height gets wrong by four rows.
    const vdp = display((chip) => {
      writeVram(chip, 0x0020, solidTile(9));
      // The last row of the map, which the screen never shows unscrolled.
      writeVram(chip, 0x3800 + 27 * 32 * 2, [0x01, 0x00]);
      setRegister(chip, 9, 27 * 8);
    });
    expect(indexAt(vdp, 0, 0)).toBe(9);
  });

  it("draws sprites from palette one and stops at the list terminator", () => {
    const vdp = display((chip) => {
      writeVram(chip, 0x0020, solidTile(4)); // character 1
      // Sprite 0 at (16, 32); sprite 1 would be at (64, 32) but the list ends first.
      writeVram(chip, 0x3f00, [31, 0xd0]);
      writeVram(chip, 0x3f80, [16, 0x01, 64, 0x01]);
    });
    expect(indexAt(vdp, 16, 32)).toBe(16 + 4);
    expect(indexAt(vdp, 23, 39)).toBe(16 + 4);
    expect(indexAt(vdp, 64, 32)).toBe(16); // never drawn
  });

  it("draws eight sprites on a line and flags the ninth", () => {
    const vdp = display((chip) => {
      writeVram(chip, 0x0020, solidTile(2));
      const y = new Uint8Array(64).fill(0xd0);
      const xt: number[] = [];
      for (let index = 0; index < 9; index += 1) {
        y[index] = 31;
        xt.push(index * 8, 0x01);
      }
      writeVram(chip, 0x3f00, y);
      writeVram(chip, 0x3f80, xt);
    });
    expect(indexAt(vdp, 0, 32)).toBe(16 + 2);
    expect(indexAt(vdp, 56, 32)).toBe(16 + 2); // the eighth
    expect(indexAt(vdp, 64, 32)).toBe(16); // the ninth is dropped
  });

  it("lets a priority background cell cover a sprite, but only where it is opaque", () => {
    const vdp = display((chip) => {
      writeVram(chip, 0x0020, splitTile(6, 0)); // left half opaque, right transparent
      writeVram(chip, 0x3800, [0x01, 0x10]); // priority
      writeVram(chip, 0x0040, solidTile(3)); // character 2, for the sprite
      writeVram(chip, 0x3f00, [0xff, 0xd0]); // y = 255 → line 0
      writeVram(chip, 0x3f80, [0, 0x02]);
    });
    expect(indexAt(vdp, 0, 0)).toBe(6); // background wins
    expect(indexAt(vdp, 4, 0)).toBe(16 + 3); // sprite shows through the hole
  });

  it("expands a Master System colour by replicating two bits", () => {
    const vdp = display((chip) => {
      writeVram(chip, 0x0020, solidTile(1));
      writeVram(chip, 0x3800, [0x01, 0x00]);
      addressCram(chip, 1);
      chip.writeData(0b00_11_10_01); // B=3, G=2, R=1
    });
    const at = 0;
    expect(vdp.framebuffer[at]).toBe(85); // R: 1 → 0x55
    expect(vdp.framebuffer[at + 1]).toBe(170); // G: 2 → 0xAA
    expect(vdp.framebuffer[at + 2]).toBe(255); // B: 3 → 0xFF
  });

  it("expands a Game Gear colour by replicating four bits, from two bytes", () => {
    const vdp = display((chip) => {
      writeVram(chip, 0x0020, solidTile(1));
      writeVram(chip, 0x3800, [0x01, 0x00]);
      addressCram(chip, 2); // entry 1 is two bytes in
      chip.writeData(0x81); // ----GGGGRRRR → G=8, R=1
      chip.writeData(0x0f); // ----BBBB → B=15
    }, "gg");
    expect(vdp.framebuffer[0]).toBe(17); // R: 1 → 1*17
    expect(vdp.framebuffer[1]).toBe(136); // G: 8 → 8*17
    expect(vdp.framebuffer[2]).toBe(255); // B: 15 → 255
  });

  it("shows a Game Gear the middle of the frame the VDP rendered", () => {
    const vdp = display((chip) => {
      writeVram(chip, 0x0020, solidTile(1));
      // A cell in the middle of the frame, which the small window does show.
      const column = GG_LEFT >> 3;
      const row = GG_TOP >> 3;
      writeVram(chip, 0x3800 + (row * 32 + column) * 2, [0x01, 0x00]);
      addressCram(chip, 2);
      chip.writeData(0x0f);
      chip.writeData(0x00);
    }, "gg");
    const view = vdp.view();
    expect(view.width).toBe(GG_WIDTH);
    expect(view.height).toBe(GG_HEIGHT);
    expect(view.pixels[0]).toBe(255); // the cell's red, at the window's origin
  });

  it("raises the frame interrupt once the active display is over", () => {
    const vdp = new Vdp();
    setRegister(vdp, 1, 0x60); // display and frame interrupt on
    vdp.step(FRAME_HEIGHT * 228);
    expect(vdp.frameIrq).toBe(false);
    vdp.step(228);
    expect(vdp.frameIrq).toBe(true);
    expect(vdp.irq).toBe(true);
    // Reading the status is how a handler acknowledges it.
    expect(vdp.readControl() & 0x80).toBe(0x80);
    expect(vdp.irq).toBe(false);
  });

  it("counts down the line interrupt from R10", () => {
    const vdp = new Vdp();
    setRegister(vdp, 0, 0x16); // line interrupts on
    setRegister(vdp, 10, 3); // every fourth line
    vdp.step(228 * 4);
    expect(vdp.lineIrq).toBe(true);
  });
});

describe("the console", () => {
  /** A cartridge whose reset code writes a byte and halts. */
  function cartridge(build: (rom: Uint8Array) => void, region: "sms" | "gg"): Uint8Array {
    const image = new Uint8Array(SMS_ROM_SIZE);
    build(image);
    return packSegaRom(image, { region: region === "gg" ? "gg-international" : "sms-export" });
  }

  it("decides which machine it is from the cartridge's region nibble", () => {
    const sms = new Sms(cartridge(() => {}, "sms"));
    expect(sms.gameGear).toBe(false);
    expect(sms.vdp.cram.length).toBe(32);
    const gg = new Sms(cartridge(() => {}, "gg"));
    expect(gg.gameGear).toBe(true);
    expect(gg.vdp.cram.length).toBe(64);
    expect(gg.framebuffer.length).toBe(GG_WIDTH * GG_HEIGHT * 4);
  });

  it("runs a cartridge's reset code from address zero", () => {
    const rom = cartridge((image) => {
      // ld a,$5A ; ld ($C000),a ; halt
      image.set([0x3e, 0x5a, 0x32, 0x00, 0xc0, 0x76], 0);
    }, "sms");
    const console_ = new Sms(rom);
    for (let steps = 0; steps < 10; steps += 1) console_.stepInstruction();
    expect(console_.ram[0]).toBe(0x5a);
  });

  it("reports the pad on port $DC, active low", () => {
    const console_ = new Sms(cartridge(() => {}, "sms"));
    console_.setButtons(["up", "a"]);
    // up is bit 0 and `a` is bit 4, both pulled low.
    expect(console_.in(0xdc)).toBe(0xff & ~0x11);
    console_.setButtons([]);
    expect(console_.in(0xdc)).toBe(0xff);
  });

  it("makes Start a Pause interrupt on a Master System and a port bit on a Game Gear", () => {
    const sms = new Sms(
      cartridge((image) => {
        // ld sp,$DFF0 ; jr $ — the idle loop a title screen sits in.
        image.set([0x31, 0xf0, 0xdf, 0x18, 0xfe], 0);
        // At the Pause vector: ld a,$77 ; ld ($C001),a ; retn
        image.set([0x3e, 0x77, 0x32, 0x01, 0xc0, 0xed, 0x45], 0x0066);
      }, "sms"),
    );
    for (let steps = 0; steps < 4; steps += 1) sms.stepInstruction();
    expect(sms.ram[1]).toBe(0);
    sms.setButtons(["start"]);
    for (let steps = 0; steps < 6; steps += 1) sms.stepInstruction();
    expect(sms.ram[1]).toBe(0x77);
    // The handler returned to the loop it interrupted, not to the vector.
    expect(sms.cpu.pc).toBeLessThan(0x0010);

    const gg = new Sms(cartridge(() => {}, "gg"));
    expect(gg.in(0x00) & 0x80).toBe(0x80);
    gg.setButtons(["start"]);
    expect(gg.in(0x00) & 0x80).toBe(0x00);
  });

  it("keeps the mapper's registers out of the game's reach", () => {
    const console_ = new Sms(cartridge(() => {}, "sms"));
    console_.write(0xffff, 0x02);
    // The write lands in RAM as well as in the mapper, which is the hardware's
    // behaviour and the reason the allocator stops short of these four bytes.
    expect(console_.ram[0x1fff]).toBe(0x02);
  });

  it("refuses something that is not a cartridge", () => {
    expect(() => new Sms(new Uint8Array(16))).toThrow(/32 KiB/);
  });

  it("renders a whole frame without the guard firing", () => {
    // `jr $` — a two-byte spin, which is what a game's idle loop looks like.
    const rom = cartridge((image) => image.set([0x18, 0xfe], 0), "sms");
    const console_ = new Sms(rom);
    expect(console_.runFrame()).toBe(1);
    expect(console_.framebuffer.length).toBe(FRAME_WIDTH * FRAME_HEIGHT * 4);
  });
});
