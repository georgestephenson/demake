/**
 * A 48 KiB Sega cartridge boots and plays the game the interpreter defines.
 *
 * Forty-eight kilobytes is flat address space on this hardware, which looks like
 * it should not be: the mapper is in the cartridge rather than the console, and it
 * comes up with its three slots holding banks 0, 1 and 2 — so `$0000`–`$BFFF` is
 * already mapped and a program that never writes a bank register sees one
 * continuous image. This is the test that says so, because "the numbers add up"
 * and "the console runs it" are different claims.
 *
 * Two things it pins that nothing else can:
 *
 *   - the **size nibble** in the `TMR SEGA` header follows the image, so a 48 KiB
 *     cartridge does not describe itself as a 32 KiB one;
 *   - the **header hole** at `$7FF0` is padded across rather than written over.
 *     The header is sixteen bytes *inside* the image, so a program that ran
 *     through it would have those bytes replaced by the stamp — and the symptom
 *     would be a table with sixteen bytes of header in the middle of it.
 *
 * The game is generated rather than taken from the library, because no example
 * lands in the window: the library's biggest Sega build is 29 KiB and the one
 * that does not fit needs 118 (doc 13 §Banked cartridges).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SMS_HEADER_OFFSET, SMS_HEADER_SIZE } from "@demake/core";

import { buildGame } from "../src/codegen/registry.js";
import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { Sim } from "../src/sim.js";
import { tape, trace } from "../src/trace.js";

import { romTrace, smsTarget } from "./_rom-harness.js";

const fixtures = join(import.meta.dirname, "..", "fixtures", "games");

/**
 * A game whose code ends just below the header and whose data pushes it over.
 *
 * Thirty-two rocks, each with its own collision rule so the code grows rather
 * than folding into a loop. That is a deliberately silly program, and it is the
 * right shape for this: what is under test is the cartridge, not the game.
 */
function source(rocks: number): string {
  const lines = [
    "start play",
    "scene play",
    "create object hero (width 1 cell, height 2 cells, speed 11, sprite hero.svg)",
    "create object rock (width 1 cell, height 1 cell, speed 7, sprite quest.crawler.svg)",
    "create hero p in play (x 2, y 2)",
    "create number hits in play (value 0, x 1, y 1)",
    "control p left (xdirection -1) on hold",
    "control p right (xdirection 1) on hold",
  ];
  for (let i = 0; i < rocks; i += 1) {
    lines.push(`create rock r${i} in play (x ${2 + (i % 20)}, y ${3 + (i % 10)}, direction east)`);
  }
  for (let i = 0; i < rocks; i += 1) {
    lines.push(`when p hits r${i} then (r${i}.visible, hits.value) as (0, hits.value + ${i + 1})`);
    lines.push(`when r${i} hits screenleft, screenright then xdirection as flip`);
  }
  return lines.join("\n");
}

const assets = new Map<string, Uint8Array>(
  ["hero.svg", "quest.crawler.svg"].map((name) => [
    name,
    new Uint8Array(readFileSync(join(fixtures, name))),
  ]),
);

const SCRIPT = "20:,30:right,40:left,60:right,30:";

describe("a flat 48 KiB Sega cartridge", () => {
  it("grows past 32 KiB, and says which size it is", async () => {
    const program = compile(source(32), { profile: getProfile("sms") });
    const built = await buildGame(program, { title: "FLAT48", assets });
    expect(built.bytes.length).toBe(0xc000);

    // `TMR SEGA`, then the size nibble: $D is 48 KiB, $C is 32. A cartridge that
    // described itself as the smaller one would checksum-fail on a real BIOS.
    const at = SMS_HEADER_OFFSET;
    expect(String.fromCharCode(...built.bytes.subarray(at, at + 8))).toBe("TMR SEGA");
    expect((built.bytes[at + 15] as number) & 0x0f).toBe(0x0d);
  });

  it("stays 32 KiB for a game that fits, unchanged", async () => {
    const program = compile(source(24), { profile: getProfile("sms") });
    const built = await buildGame(program, { title: "FLAT32", assets });
    expect(built.bytes.length).toBe(0x8000);
    expect((built.bytes[SMS_HEADER_OFFSET + 15] as number) & 0x0f).toBe(0x0c);
  });

  // The one that would bite: the header is *inside* the image, so a program that
  // ran through `$7FF0` would have sixteen of its bytes replaced by the stamp.
  // Padding across the hole is what stops that, and this is how you tell — the
  // sixteen bytes before the header are the filler, not the tail of a table.
  it("pads across the header rather than being written over", async () => {
    const program = compile(source(32), { profile: getProfile("sms") });
    const built = await buildGame(program, { title: "FLAT48", assets });
    const filler = built.bytes.subarray(SMS_HEADER_OFFSET - SMS_HEADER_SIZE, SMS_HEADER_OFFSET);
    expect([...filler].every((byte) => byte === 0)).toBe(true);
    // And there is real data on the far side of it, or the padding proved nothing.
    const beyond = built.bytes.subarray(0x8000);
    expect([...beyond].some((byte) => byte !== 0)).toBe(true);
  });

  // The claim the rest of it rests on: three banks mapped from reset means the
  // console runs the whole image without the program ever paging anything. Same
  // oracle every other backend answers to — the interpreter, tick for tick.
  it("plays the same game the interpreter does, all 48 KiB of it", async () => {
    const program = compile(source(32), { profile: getProfile("sms") });
    const frames = tape(SCRIPT);
    expect(await romTrace(program, frames, assets, smsTarget)).toBe(
      trace(new Sim(program), frames),
    );
  }, 120_000);

  it("refuses a game whose code runs past the header, and names why", async () => {
    const program = compile(source(36), { profile: getProfile("sms") });
    await expect(buildGame(program, { title: "TOOBIG", assets })).rejects.toThrow(/past \$7FF0/);
  });
});
