/**
 * A cartridge whose program does not fit one bank, and the ways that goes wrong.
 *
 * Trace conformance is `rom.test.ts`'s — it runs `quest` on this console tick for
 * tick against the interpreter, which is the claim that the banking is invisible.
 * What a trace cannot see is everything below: which bank a scene ended up in,
 * whether the board is the smallest one that holds it, and whether a game that
 * *fits* was left exactly as it was. Each of those is a way a banked build can be
 * perfectly playable and still wrong.
 *
 * The sharpest of them is the last. Banking changes every call in the program
 * from `jsr` to `jsl` and every return from `rts` to `rtl`, so the switch has to
 * be all-or-nothing *and* has to stay off for the games that do not need it — a
 * build that turned it on for everything would still play, and would quietly
 * re-baseline every Super Nintendo cartridge this project has ever produced.
 */

import { describe, expect, it } from "vitest";

import {
  SNES_BANK_SIZE,
  SNES_HEADER_OFFSET,
  SNES_ROM_SIZES,
  SNES_SPC_BANK,
  SNES_TILE_BANK,
  snesChecksum,
} from "@demake/core";
import { Snes } from "@demake/snes";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { buildSnesRom } from "../src/codegen/snes.js";

import { exampleProject, gameSource } from "./_projects.js";

/** `quest`, compiled for this console: the one example that outgrows a bank. */
function quest() {
  const project = exampleProject("quest");
  return compile(project.source, {
    profile: getProfile("snes"),
    files: project.files,
    levels: project.levels,
  });
}

/** The opcode at an address in the cartridge image, LoROM. */
function opcodeAt(rom: Uint8Array, address: number): number {
  const bank = (address >> 16) & 0xff;
  return rom[bank * SNES_BANK_SIZE + ((address & 0xffff) - 0x8000)] as number;
}

describe("a banked LoROM cartridge", async () => {
  const built = await buildSnesRom(quest(), { title: "QUEST" });

  it("takes the smallest board that holds every bank it needs", () => {
    // Elastic in both directions (doc 14 §Elastic cartridges): a mask ROM was a
    // power of two, so the answer is the first size on the list that fits rather
    // than the number of banks in use — and it is emphatically not the largest.
    expect(SNES_ROM_SIZES).toContain(built.bytes.length);
    expect(built.bytes.length).toBeGreaterThan(SNES_ROM_SIZES[0] as number);
    const banks = built.bytes.length / SNES_BANK_SIZE;
    const previous = SNES_ROM_SIZES[SNES_ROM_SIZES.indexOf(built.bytes.length) - 1] as number;
    // The board below this one really would not have done, or the cartridge is
    // bigger than the game needs.
    expect(banks * SNES_BANK_SIZE).toBeGreaterThan(previous);
  });

  it("puts scenes above the reserved banks and leaves bank zero its own", () => {
    const at = (name: string) => built.symbols.get(name) as number;
    const banks = new Set<number>();
    for (let scene = 0; scene < built.stats.scenes; scene += 1) {
      banks.add((at(`SceneTick_${scene}`) >> 16) & 0xff);
    }
    // Some scenes stayed in bank zero and some did not, which is the whole point
    // of a plan that fills bank zero first rather than emptying it.
    expect(banks.has(0)).toBe(true);
    expect(banks.size).toBeGreaterThan(1);
    // And none landed on the tile art, which is the one bank every build spends.
    expect(banks.has(SNES_TILE_BANK)).toBe(false);
    const art = built.bytes.subarray(
      SNES_TILE_BANK * SNES_BANK_SIZE,
      (SNES_TILE_BANK + 1) * SNES_BANK_SIZE,
    );
    expect(art.some((byte) => byte !== 0)).toBe(true);

    // Bank two *is* program here, and that is the elasticity rather than a bug:
    // this build is handed no asset bytes, so there is no sound processor's image
    // and nothing to reserve a bank for. A cartridge that kept the bank empty
    // anyway would be bigger than the game needs (doc 14 §Elastic cartridges).
    expect(built.stats.audio).toBeUndefined();
    expect(banks.has(SNES_SPC_BANK)).toBe(true);
  });

  it("keeps the shared code, the helpers and every table in bank zero", () => {
    // The reason a banked build's *data* reads are the same instructions an
    // unbanked one's were: the data bank register stays at zero, so anything an
    // absolute address reaches has to be down there. A table that had drifted
    // into a high bank would be read as whatever bank zero has at that offset.
    for (const name of ["Reset", "Nmi", "Main", "Tick", "TickDone", "Palette", "Defaults_0"]) {
      const address = built.symbols.get(name);
      expect(address, name).toBeDefined();
      expect((address as number) >> 16, name).toBe(0);
      expect((address as number) & 0xffff, name).toBeLessThan(SNES_HEADER_OFFSET + 0x8000);
    }
  });

  it("calls with jsl, because a call now crosses banks", () => {
    // Read at a label rather than scanned for, so this is a decode of one
    // instruction and not a search that a data byte could satisfy: `TickDone`'s
    // first instruction is the call to `SceneChange`, so the byte *at* that label
    // is the call's own opcode. A build that banked its scenes and kept `jsr`
    // would call the right offset of whichever bank it happened to be in.
    expect(opcodeAt(built.bytes, built.symbols.get("TickDone") as number)).toBe(0x22); // jsl
  });

  it("still has a header a console would accept, at the top of bank zero", () => {
    const sum =
      (built.bytes[SNES_HEADER_OFFSET + 0x1e] as number) |
      ((built.bytes[SNES_HEADER_OFFSET + 0x1f] as number) << 8);
    expect(sum).toBe(snesChecksum(built.bytes));
    // The size code is `log2(kilobytes)`, so it follows the image and cannot
    // describe a board the builder did not produce.
    const code = built.bytes[SNES_HEADER_OFFSET + 0x17] as number;
    expect(1024 << code).toBe(built.bytes.length);
  });

  it("boots, and the picture comes on", async () => {
    // The end-to-end one. Every assertion above is about where bytes went; this
    // is the only one that says the processor got there — a wrong bank in a
    // `jsl` is a cartridge that runs into padding and never reaches the code
    // that switches the screen on.
    const machine = new Snes(built.bytes);
    for (let guard = 0; guard < 8_000_000; guard += 1) {
      if ((machine.readMemory(built.layout.booted, 1)[0] as number) !== 0) break;
      machine.stepInstruction();
    }
    expect(machine.readMemory(built.layout.booted, 1)[0]).not.toBe(0);
    for (let frame = 0; frame < 8; frame += 1) machine.runFrame();
    // The tick counter has moved, so the game is running rather than parked.
    const ticks = machine.readMemory(built.layout.tick, 2);
    expect((ticks[0] as number) | ((ticks[1] as number) << 8)).toBeGreaterThan(0);
  }, 60_000);
});

describe("a cartridge that fits one bank", () => {
  it("is not banked at all, and says so in its own instructions", async () => {
    // Pong is a few kilobytes. A build that switched to long calls anyway would
    // trace identically and change every byte of every Super Nintendo cartridge
    // in the library, so this is the assertion that keeps the switch honest.
    const program = compile(gameSource("pong"), { profile: getProfile("snes") });
    const built = await buildSnesRom(program, { title: "PONG" });
    expect(built.bytes.length).toBe(SNES_ROM_SIZES[0] as number);
    expect(opcodeAt(built.bytes, built.symbols.get("TickDone") as number)).toBe(0x20); // jsr
    for (let scene = 0; scene < built.stats.scenes; scene += 1) {
      expect((built.symbols.get(`SceneTick_${scene}`) as number) >> 16).toBe(0);
    }
  });
});
