/**
 * The machine: the boot hand-off, the watchdog, and a cartridge that really
 * carries hardware bytes.
 *
 * The last of those is the point of the graphics case. `packNeoCharacters` has a
 * right-half-before-left block order that nothing would exercise if the core
 * were handed decoded pixels, so the round trip is run end to end here — pack a
 * tile into a `.neo`, load it the way a harness will, and check the pixel lands
 * where the picture says. `packages/core/test/neo-cart.test.ts` pins the encoder
 * against hand-computed offsets; this pins that the console agrees.
 */

import { packNeoCharacters, packNeoFix, packNeoHeader, packNeoRom } from "@demake/core";
import {
  encodeScb3,
  encodeScb4,
  expandColor,
  loadNeo,
  Neogeo,
  SCB1,
  SCB3,
  SCB4,
  USER_ENTRY,
  WATCHDOG_FRAMES,
} from "@demake/neogeo";
import { describe, expect, it } from "vitest";

/** Where a test program's own code starts, past the vectors and the header. */
const CODE = 0x200;

/** A P ROM whose `USER` entry runs `code`, which defaults to a halt loop. */
function program(code: readonly number[] = [0x60, 0xfe]): Uint8Array {
  const size = CODE + Math.max(code.length, 2);
  const rom = new Uint8Array(size);
  rom.set(packNeoHeader(size, { stack: 0x10f300, user: CODE, vblank: CODE }), 0);
  rom.set(code, CODE);
  return rom;
}

/** A whole cartridge: a program, one sprite tile and one fix tile. */
function cartridge(options: { code?: readonly number[]; pixel?: [number, number] } = {}) {
  const sprite = new Uint8Array(512);
  if (options.pixel) {
    const [x, y] = options.pixel;
    // Tile 1, so tile 0 stays blank the way a real bank's does.
    sprite[256 + y * 16 + x] = 3;
  }
  const { c1, c2 } = packNeoCharacters(sprite);
  return packNeoRom({
    p: program(options.code),
    s: packNeoFix(new Uint8Array(64)),
    c1,
    c2,
  });
}

describe("the boot hand-off", () => {
  it("enters at the header's USER vector, not the reset vector's target", () => {
    const machine = new Neogeo(loadNeo(cartridge()));
    expect(machine.cpu.pc).toBe(USER_ENTRY);
    // The first instruction executed is the header's own `jmp`, which lands on
    // the game. That is the whole of what the system ROM would have done.
    machine.stepInstruction();
    expect(machine.cpu.pc).toBe(CODE);
  });

  it("takes the stack pointer from the cartridge's first longword", () => {
    const machine = new Neogeo(loadNeo(cartridge()));
    expect(machine.cpu.sp).toBe(0x10f300);
  });

  it("refuses an image that is not a .neo container", () => {
    expect(() => loadNeo(new Uint8Array(8192))).toThrow(/not a \.neo cartridge/);
  });
});

describe("the watchdog", () => {
  it("reboots a cartridge that never kicks it", () => {
    const machine = new Neogeo(loadNeo(cartridge()));
    for (let frame = 0; frame <= WATCHDOG_FRAMES; frame += 1) machine.runFrame();
    expect(machine.watchdogTripped).toBe(true);
  });

  it("leaves a cartridge alone while it does", () => {
    // `move.b d0, $300001` then branch to self: a loop that kicks every pass.
    const machine = new Neogeo(
      loadNeo(cartridge({ code: [0x13, 0xc0, 0x00, 0x30, 0x00, 0x01, 0x60, 0xf8] })),
    );
    for (let frame = 0; frame <= WATCHDOG_FRAMES * 2; frame += 1) machine.runFrame();
    expect(machine.watchdogTripped).toBe(false);
  });
});

describe("a cartridge carries hardware bytes", () => {
  it("round-trips a sprite tile through the packed C ROM pair and draws it", () => {
    // The pixel is in the tile's *left* half, which is the half the C ROM stores
    // second — so a block order that was written the obvious way round would put
    // this sixteen bytes off and draw nothing here.
    const machine = new Neogeo(loadNeo(cartridge({ pixel: [2, 3] })));
    machine.lspc.palettes[0]![3] = 0x0f00;
    machine.lspc.vram[SCB3] = encodeScb3({ y: 0, sticky: false, height: 1 });
    machine.lspc.vram[SCB4] = encodeScb4(0);
    machine.lspc.vram[SCB1] = 1;
    machine.lspc.vram[SCB1 + 1] = 0;

    const frame = machine.render();
    const at = (3 * frame.width + 2) * 4;
    expect([frame.data[at], frame.data[at + 1], frame.data[at + 2]]).toEqual(expandColor(0x0f00));
    // And its neighbour is backdrop, so the whole tile did not come out solid.
    const next = (3 * frame.width + 3) * 4;
    expect([frame.data[next], frame.data[next + 1], frame.data[next + 2]]).toEqual([0, 0, 0]);
  });
});
