/**
 * The proof: a ROM built from a `.dmt` plays the game the interpreter defines.
 *
 * This is doc 13's D3 acceptance in a unit test — same input tape, byte-identical
 * fixed-point state per tick, against the checked-in golden trace and against
 * the reference interpreter for every fixture the runtime supports. It runs with
 * no toolchain and no emulator install, because the ROM is patched rather than
 * assembled and `@demake/dmg` is ours.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { buildGbRom, HEADER_OFFSETS, ROM_SIZE, unsupportedFeatures } from "../src/rom/gb.js";
import { Sim } from "../src/sim.js";
import { tape, trace } from "../src/trace.js";

import { romTrace } from "./_rom-harness.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

/** The tape the golden trace was recorded with (see determinism.test.ts). */
const PONG_TAPE = "1:a,90:,90:left,120:right";

function build(source: string) {
  return compile(source, { profile: getProfile("gb") });
}

describe("gb ROM", () => {
  it("is a valid 32 KiB cartridge with correct checksums", () => {
    const { bytes } = buildGbRom(build(read("pong.dmt")), { title: "PONG" });
    expect(bytes.length).toBe(ROM_SIZE);
    let header = 0;
    for (let at = 0x0134; at <= 0x014c; at += 1)
      header = (header - (bytes[at] as number) - 1) & 0xff;
    expect(bytes[HEADER_OFFSETS.headerChecksum]).toBe(header);
    expect(bytes[HEADER_OFFSETS.cartridgeType]).toBe(0x00);
    expect(String.fromCharCode(...bytes.subarray(0x134, 0x138))).toBe("PONG");
  });

  it("reproduces the checked-in golden trace tick for tick", () => {
    const program = build(read("pong.dmt"));
    expect(romTrace(program, tape(PONG_TAPE))).toBe(read("pong.gb.trace").trimEnd());
  });

  it("refuses a game whose features the runtime does not implement", () => {
    const program = compile(read(join("games", "caves.dmt")), {
      profile: getProfile("gb"),
      levels: { "cavern.dmtl": read(join("games", "cavern.dmtl")) },
    });
    expect(unsupportedFeatures(program).length).toBeGreaterThan(0);
    expect(() => buildGbRom(program)).toThrow(/does not implement/);
  });
});

describe("gb ROM conformance across the example library", () => {
  const cases = [
    ["pong.dmt", "1:a,90:,90:left,120:right"],
    [join("games", "breakout.dmt"), "30:,20:a,50:,60:left,60:right,80:"],
    [join("games", "platformer.dmt"), "20:,15:a,40:right,20:a+right,60:right,45:"],
    [join("games", "dodger.dmt"), "20:,20:a,60:left,60:right,40:"],
    [join("games", "shooter.dmt"), "20:,20:a,40:left,20:a,60:right,40:"],
  ] as const;

  for (const [file, script] of cases) {
    it(`matches the interpreter for ${file}`, () => {
      const program = build(read(file));
      const script2 = tape(script);
      expect(romTrace(program, script2)).toBe(trace(new Sim(program), script2));
    });
  }
});
