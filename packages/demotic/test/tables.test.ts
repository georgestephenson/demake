/**
 * The program tables are output bytes (doc 09 §Stability), and the runtime
 * reads them by fixed offset — so what is checked here is the contract, not the
 * behaviour: determinism, the header's shape, the record sizes the assembly
 * hard-codes, and the limits that turn "it silently misbehaved on hardware"
 * into a build error.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import {
  CONTROL,
  DATA_BASE,
  ENTITY_SIZE,
  FORMAT_VERSION,
  HEADER,
  INSTANCE,
  MAGIC,
  PROP_IDS,
  RULE,
  SCENE,
} from "../src/rom/format.js";
import { BUILTIN_TILES, builtinTiles, TILE_BYTES } from "../src/rom/graphics.js";
import { emitTables, LIMITS, TableError } from "../src/rom/tables.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const PONG = readFileSync(join(fixtures, "pong.dmt"), "utf8");

function program(source = PONG, consoleId = "gb") {
  return compile(source, { profile: getProfile(consoleId) });
}

function word(bytes: Uint8Array, at: number): number {
  return (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
}

describe("program tables", () => {
  it("emits identical bytes for identical input", () => {
    expect(emitTables(program()).bytes).toEqual(emitTables(program()).bytes);
  });

  it("starts with the magic and version the runtime checks", () => {
    const { bytes } = emitTables(program());
    expect([...bytes.subarray(0, 4)]).toEqual([...MAGIC]);
    expect(bytes[HEADER.version]).toBe(FORMAT_VERSION);
    expect(bytes[HEADER.fps]).toBe(60);
    expect(bytes[HEADER.screenWidth]).toBe(20);
    expect(bytes[HEADER.screenHeight]).toBe(18);
  });

  it("points every table inside the ROM's data window", () => {
    const { bytes, stats } = emitTables(program());
    for (const field of ["scenes", "instances", "controls", "rules", "tiles"] as const) {
      const address = word(bytes, HEADER[field]);
      expect(address).toBeGreaterThanOrEqual(DATA_BASE);
      expect(address).toBeLessThan(DATA_BASE + bytes.length);
    }
    expect(word(bytes, HEADER.end)).toBe(DATA_BASE + bytes.length);
    expect(stats.bytes + stats.free).toBe(0x4000);
  });

  it("keeps the record sizes the assembly hard-codes", () => {
    // runtime-harness/gb/main.asm indexes these tables with a shift-and-add, so
    // a size change there and here has to happen in the same commit.
    expect(SCENE.size).toBe(8);
    expect(CONTROL.size).toBe(8);
    expect(RULE.size).toBe(16);
    expect(INSTANCE.size).toBe(40);
    expect(ENTITY_SIZE).toBe(36);
    expect(PROP_IDS["value"]).toBe(8);
    expect(PROP_IDS["centerx"]).toBe(9);
  });

  it("emits the built-in tile bank the header advertises", () => {
    const { bytes } = emitTables(program());
    expect(word(bytes, HEADER.tileCount)).toBe(BUILTIN_TILES);
    expect(builtinTiles().length).toBe(BUILTIN_TILES * TILE_BYTES);
    const at = word(bytes, HEADER.tiles) - DATA_BASE;
    expect(bytes.subarray(at, at + BUILTIN_TILES * TILE_BYTES)).toEqual(builtinTiles());
  });

  it("scales with the game rather than with the console", () => {
    // Retargeting folds different constants, but the table *shape* is the same:
    // the tables are console-specific only in that literals are resolved.
    const small = emitTables(program(PONG, "gb")).stats;
    const large = emitTables(program(PONG, "md")).stats;
    expect(large.rules).toBe(small.rules);
    expect(large.instances).toBe(small.instances);
  });

  it("refuses a game that would not fit the runtime's fixed state", () => {
    // Background-drawn objects cost no hardware sprites, so this gets past the
    // compiler's budget diagnostic and lands on the runtime's own limit —
    // which is the one this test is about.
    const many = [
      "start play",
      "scene play",
      ...Array.from(
        { length: LIMITS.instances + 4 },
        (_, index) => `create number n${index} in play (x 0, y 0, value ${index})`,
      ),
    ].join("\n");
    expect(() => emitTables(program(many))).toThrow(TableError);
    expect(() => emitTables(program(many))).toThrow(/objects/);
  });
});
