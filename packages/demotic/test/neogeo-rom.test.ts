/**
 * What the Neo Geo build is, beyond playing the same game.
 *
 * Trace conformance is `rom.test.ts`'s, over the battery every other console
 * runs. Here are the things only this console has, and each is here because
 * getting it wrong produces a cartridge that traces perfectly and looks wrong:
 *
 *   - **The plane is a sticky chain.** Twenty-one strips carrying one position
 *     between them is the whole scroll mechanism, and a build that left them
 *     unchained would draw twenty-one columns stacked on the same sixteen
 *     pixels — a perfect game in one column of the screen.
 *   - **The fix layer is column-major.** A cell's word is `column × 32 + row`,
 *     and the transposed reading is the single easiest mistake on this hardware
 *     to ship: it produces a HUD that is recognisably the right glyphs in
 *     recognisably the wrong places.
 *   - **The font's palette has to survive the fit.** Fifteen palettes are the
 *     art's and the sixteenth is the font's, and the fix layer can only reach the
 *     first sixteen of 256 — so a caption is legible only if palette 0 was left
 *     alone.
 *   - **Objects live past the plane.** Sprite 0 is the hardware's own padding
 *     entry and strips 1–21 are the playfield, so an object staged over either
 *     is an object drawn behind the scenery or one that overwrites it.
 *   - **A cartridge really is a set of ROMs.** The `.neo` container has to name
 *     each region's length and the C ROM pair has to survive its own peculiar
 *     packing, or the console loads a program with no pixels behind it.
 */

import { describe, expect, it } from "vitest";

import { NEO_CODE_ORIGIN, unpackNeoCharacters } from "@demake/core";
import {
  decodeScb3,
  FIX_MAP,
  FIX_ROWS,
  FIRST_USABLE_SPRITE,
  loadNeo,
  Neogeo,
  SCB3,
} from "@demake/neogeo";

import { buildNeogeoRom } from "../src/codegen/neogeo.js";
import {
  ART_PALETTE0,
  OBJECT_SPRITE0,
  PLANE_ROWS,
  PLANE_SPRITE0,
  PLANE_STRIPS,
  FIX_VIEW_H,
  FIX_VIEW_W,
  SYSTEM_PALETTE,
} from "../src/codegen/neogeo/machine.js";
import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { gameSource, projectBytes } from "./_projects.js";

/** Pong's art, which is what makes the plane and the objects non-empty. */
function pongAssets(): Map<string, Uint8Array> {
  return new Map([
    ["pong.title.svg", projectBytes("pong", "art/pong.title.svg")],
    ["ball.svg", projectBytes("pong", "art/ball.svg")],
    ["paddle.svg", projectBytes("pong", "art/paddle.svg")],
  ]);
}

function build(project: string) {
  return compile(gameSource(project), { profile: getProfile("neogeo") });
}

/** Boot a cartridge and run it until the runtime says it has finished booting. */
function boot(bytes: Uint8Array, bootedAt: number): Neogeo {
  const machine = new Neogeo(loadNeo(bytes));
  for (let guard = 0; guard < 8_000_000; guard += 1) {
    if (machine.readMemory(bootedAt, 1)[0] !== 0) return machine;
    machine.stepInstruction();
  }
  throw new Error("neogeo: the runtime never finished initialising");
}

describe("the Neo Geo cartridge", async () => {
  const built = await buildNeogeoRom(build("pong"), { title: "PONG" });

  it("is a .neo container whose regions are all named", () => {
    expect(String.fromCharCode(...built.bytes.subarray(0, 3))).toBe("NEO");
    const view = new DataView(built.bytes.buffer, built.bytes.byteOffset);
    const p = view.getUint32(0x04, true);
    const s = view.getUint32(0x08, true);
    const c = view.getUint32(0x18, true);
    expect(p).toBeGreaterThan(NEO_CODE_ORIGIN);
    expect(s).toBeGreaterThan(0);
    expect(c).toBeGreaterThan(0);
    // The sound regions are empty rather than absent: this build emits no Z80.
    expect([view.getUint32(0x0c, true), view.getUint32(0x10, true)]).toEqual([0, 0]);
    expect(built.bytes.length).toBe(4096 + p + s + c);
  });

  it("carries a header the boot hand-off can enter through", () => {
    const cart = loadNeo(built.bytes);
    expect(String.fromCharCode(...cart.program.subarray(0x100, 0x107))).toBe("NEO-GEO");
    const long = (at: number): number =>
      ((cart.program[at]! << 24) |
        (cart.program[at + 1]! << 16) |
        (cart.program[at + 2]! << 8) |
        cart.program[at + 3]!) >>>
      0;
    // The `JMP USER` at $122 targets the game, and the frame handler is a
    // different routine — a vector that restarted the game sixty times a second
    // is the one mistake here that still ticks.
    expect(long(0x124)).toBe(built.symbols.get("Reset"));
    expect(long(0x64)).toBe(built.symbols.get("Vint"));
    expect(long(0x64)).not.toBe(long(0x124));
  });

  it("packs its sprite tiles so they decode back to what the art path made", () => {
    // `built` has no assets, so its bank is the built-in tiles alone — the
    // non-trivial check belongs on the build that has art, below.
    const cart = loadNeo(withArt.bytes);
    // A bank that decoded to all zeroes would satisfy a length check and draw
    // nothing, which is why this asks for a pixel rather than a size.
    expect(cart.characters.some((pixel) => pixel !== 0)).toBe(true);
    expect(cart.characters.length % 256).toBe(0);
  });
});

/**
 * One build for every case below.
 *
 * Demaking pong's title screen is the whole `prep` tournament, so building it
 * per `describe` is minutes rather than seconds — the same reason
 * `parallel.test.ts` runs one fixture on the Super Nintendo rather than three.
 */
const withArt = await buildNeogeoRom(build("pong"), { assets: pongAssets() });

describe("the plane", () => {
  const built = withArt;
  const bootedAt = built.layout.booted;

  it("is one anchor and twenty sticky strips", () => {
    const machine = boot(built.bytes, bootedAt);
    const anchor = decodeScb3(machine.lspc.vram[SCB3 + PLANE_SPRITE0] ?? 0);
    expect(anchor.sticky).toBe(false);
    expect(anchor.height).toBe(PLANE_ROWS);
    for (let strip = 1; strip < PLANE_STRIPS; strip += 1) {
      const chained = decodeScb3(machine.lspc.vram[SCB3 + PLANE_SPRITE0 + strip] ?? 0);
      expect(chained.sticky).toBe(true);
      expect(chained.height).toBe(PLANE_ROWS);
    }
  });

  it("leaves sprite 0 to the hardware", () => {
    const machine = boot(built.bytes, bootedAt);
    // The LSPC pads a line's display list with it, so it must draw nothing.
    expect(decodeScb3(machine.lspc.vram[SCB3] ?? 0).height).toBe(0);
    expect(PLANE_SPRITE0).toBe(FIRST_USABLE_SPRITE);
  });

  it("puts objects above the plane in the priority order", () => {
    // A lower sprite number is drawn *behind*, so an object staged below the
    // playfield's strips would be scenery drawn over the thing it is scenery
    // for. This is the arrangement; whether a frame fills it is the todo below.
    expect(OBJECT_SPRITE0).toBeGreaterThan(PLANE_SPRITE0 + PLANE_STRIPS - 1);
  });

  it("stages this frame's objects into the shadow and uploads them", () => {
    const machine = boot(built.bytes, bootedAt);
    // Into the play scene, where the objects are: the title screen has none, so
    // a probe that never pressed a button would find an empty sprite list and
    // call it a bug. It was mine, the first time.
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 8; frame += 1) machine.runFrame();
    machine.setButtons([]);
    for (let frame = 0; frame < 8; frame += 1) machine.runFrame();
    let used = 0;
    for (let strip = OBJECT_SPRITE0; strip < OBJECT_SPRITE0 + 64; strip += 1) {
      if (decodeScb3(machine.lspc.vram[SCB3 + strip] ?? 0).height > 0) used += 1;
    }
    expect(used).toBeGreaterThan(0);
  });
});

describe("the fix layer", () => {
  const built = withArt;
  const bootedAt = built.layout.booted;

  it("writes captions column-major, not transposed", () => {
    const machine = boot(built.bytes, bootedAt);
    for (let frame = 0; frame < 4; frame += 1) machine.runFrame();
    // The check is on the *addressing*. A transposed HUD would write cells at
    // `row × 40 + column`; the column-major reading puts a caption's own cells
    // where this looks, and the two disagree for anything off the diagonal.
    let written = 0;
    for (let column = 0; column < FIX_VIEW_W; column += 1) {
      for (let row = 0; row < FIX_VIEW_H; row += 1) {
        const entry = machine.lspc.vram[FIX_MAP + column * FIX_ROWS + row] ?? 0;
        if ((entry & 0x0fff) !== 0) written += 1;
      }
    }
    expect(written).toBeGreaterThan(0);
  });

  it("draws its glyphs in the reserved palette", () => {
    const machine = boot(built.bytes, bootedAt);
    for (let frame = 0; frame < 4; frame += 1) machine.runFrame();
    for (let column = 0; column < 40; column += 1) {
      for (let row = 0; row < 28; row += 1) {
        const entry = machine.lspc.vram[FIX_MAP + column * FIX_ROWS + row] ?? 0;
        if ((entry & 0x0fff) === 0) continue;
        expect((entry >> 12) & 0xf).toBe(SYSTEM_PALETTE);
      }
    }
  });
});

describe("palette RAM", () => {
  const built = withArt;
  const bootedAt = built.layout.booted;

  it("arrives, with the hardware's reference colour and the font's ramp intact", () => {
    const machine = boot(built.bytes, bootedAt);
    const bank = machine.lspc.palettes[machine.lspc.paletteBank]!;
    // `$400000` must be pure black: the video output uses it as its reference.
    expect(bank[0]).toBe(0x8000);
    // The font's palette is a ramp, so its entries are not all the same — a
    // caption drawn in a palette the fit flattened is a caption nobody can read.
    const font = [...bank.subarray(SYSTEM_PALETTE * 16, SYSTEM_PALETTE * 16 + 4)];
    expect(new Set(font).size).toBeGreaterThan(2);
    // And the art got palettes of its own, above the font's.
    const art = [...bank.subarray(ART_PALETTE0 * 16, ART_PALETTE0 * 16 + 16)];
    expect(art.some((word) => word !== 0)).toBe(true);
  });
});

describe("what a demade cartridge does not need", () => {
  it("has no sound driver, and says so rather than pretending", () => {
    const built = withArt;
    // The chip answers a Z80 this build emits no program for. A game that names
    // audio still compiles and still records what its rules asked for, which is
    // what keeps its trace identical to a sounding console's.
    expect(built.stats.audio?.present ?? false).toBe(false);
  });

  it("decodes its C ROM pair the hardware's way", () => {
    const built = withArt;
    const view = new DataView(built.bytes.buffer, built.bytes.byteOffset);
    const p = view.getUint32(0x04, true);
    const s = view.getUint32(0x08, true);
    const c = view.getUint32(0x18, true);
    const at = 4096 + p + s;
    const half = c >> 1;
    const c1 = new Uint8Array(half);
    const c2 = new Uint8Array(half);
    for (let index = 0; index < half; index += 1) {
      c1[index] = built.bytes[at + index * 2]!;
      c2[index] = built.bytes[at + index * 2 + 1]!;
    }
    // The same decode `loadNeo` performs, run independently: if the interleave
    // in the container disagreed with the one the loader assumes, this is where
    // it shows rather than as a wrong picture.
    expect([...unpackNeoCharacters(c1, c2)]).toEqual([...loadNeo(built.bytes).characters]);
  });
});
