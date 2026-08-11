/**
 * A Sega cartridge whose program does not fit the flat 48 KiB, and how it can be
 * wrong.
 *
 * Trace conformance is `rom.test.ts`'s — it runs `quest` on this console tick for
 * tick against the interpreter, which is the claim that the paging is invisible.
 * What a trace cannot see is where anything went, and on this console that is a
 * longer list than on the Super Nintendo, because a Z80 address carries no bank:
 * a routine at `$8000` is *whichever* bank slot 2 happens to hold, so the
 * difference between right and catastrophic is one `ld ($FFFF), a` that ran or
 * did not.
 *
 * So the cases below are about the split rather than about the game. What stays
 * in the fixed half, what does not, that a game which fits pages nothing at all,
 * and — the end-to-end one — that the cartridge boots and the tick advances.
 */

import { describe, expect, it } from "vitest";

import { SMS_HEADER_OFFSET, SMS_ROM_SIZES, SMS_SLOT2_BASE, segaChecksum } from "@demake/core";
import { Sms } from "@demake/sms";

import { buildSmsRom } from "../src/codegen/sms.js";
import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";

import { exampleProject, gameSource } from "./_projects.js";

/** `quest`, compiled for this console: the one example that outgrows a flat one. */
function quest() {
  const project = exampleProject("quest");
  return compile(project.source, {
    profile: getProfile("sms"),
    files: project.files,
    levels: project.levels,
  });
}

describe("a paged Sega cartridge", async () => {
  const built = await buildSmsRom(quest(), { title: "QUEST" });

  it("takes the smallest board that holds every bank it needs", () => {
    expect(SMS_ROM_SIZES).toContain(built.bytes.length);
    // Bigger than the largest flat board, or nothing was paged at all.
    expect(built.bytes.length).toBeGreaterThan(0xc000);
    // And not the largest: elastic in both directions (doc 14 §Elastic
    // cartridges), so a game that needs nine banks does not get thirty-two.
    expect(built.bytes.length).toBeLessThan(SMS_ROM_SIZES[SMS_ROM_SIZES.length - 1] as number);
  });

  it("puts a tick's steps in the window and the sequence that runs them below it", () => {
    // The shape of the whole scheme in two assertions. A scene's tick is a run of
    // calls in the fixed half — it has to be, because it is what *reaches* the
    // paged half — and each step it calls is at `$8000`, which is only an address
    // once slot 2 has been pointed somewhere.
    for (let scene = 0; scene < built.stats.scenes; scene += 1) {
      const tick = built.symbols.get(`SceneTick_${scene}`) as number;
      expect(tick, `scene ${scene}`).toBeLessThan(SMS_SLOT2_BASE);
      for (const step of ["controls", "integrate", "collisions", "camera"]) {
        const at = built.symbols.get(`Step_${scene}_${step}`);
        expect(at, `scene ${scene} ${step}`).toBeDefined();
        expect(at as number, `scene ${scene} ${step}`).toBeGreaterThanOrEqual(SMS_SLOT2_BASE);
      }
    }
  });

  it("keeps everything an always-mapped address reaches in the fixed half", () => {
    // The reason a paged build's data reads are the same instructions a flat
    // one's were: slots 0 and 1 never move, so a table down there is readable
    // from any bank. A table that had drifted into the window would be read as
    // whatever bank happened to be in slot 2 at the time — which is a game that
    // works until the scene changes.
    for (const name of ["Reset", "Main", "Tick", "TickDone", "SceneChange", "Defaults_0"]) {
      const at = built.symbols.get(name);
      expect(at, name).toBeDefined();
      expect(at as number, name).toBeLessThan(SMS_SLOT2_BASE);
    }
    // The audio driver and its schedules above all, because an *interrupt*
    // enters it: it has to be mapped whatever the game was doing, and there is no
    // moment at which the window is known.
    for (const name of ["AudioTick", "AudioTracks"]) {
      const at = built.symbols.get(name);
      if (at === undefined) continue;
      expect(at, name).toBeLessThan(SMS_SLOT2_BASE);
    }
  });

  it("pages the tile art, because the boot is the only thing that reads it", () => {
    // The one big thing the fixed half does not need: seven kilobytes uploaded to
    // video RAM once and never read again. Leaving it below would cost a fifth of
    // the space that cannot move, for nothing.
    expect(built.symbols.get("TileBank") as number).toBeGreaterThanOrEqual(SMS_SLOT2_BASE);
  });

  it("still has a header a BIOS would accept, in the fixed half", () => {
    const at = SMS_HEADER_OFFSET;
    expect(String.fromCharCode(...built.bytes.subarray(at, at + 8))).toBe("TMR SEGA");
    const sum = (built.bytes[at + 10] as number) | ((built.bytes[at + 11] as number) << 8);
    expect(sum).toBe(segaChecksum(built.bytes));
    // The size nibble follows the image, and the codes wrap — $F is 128 KiB —
    // so this is the one place a builder could describe the wrong board.
    const nibble = (built.bytes[at + 15] as number) & 0x0f;
    expect(nibble).toBe(built.bytes.length === 0x20000 ? 0x0f : 0x0e);
  });

  it("boots, and the tick advances across banks", async () => {
    // The end-to-end one. Everything above is about where bytes went; this is the
    // only case that says the processor got there and came back — a missing bank
    // write is a `call` into whatever the window happened to hold, which does not
    // return.
    const machine = new Sms(built.bytes);
    for (let frame = 0; frame < 30; frame += 1) machine.runFrame();
    const ticks = machine.readMemory(built.layout.tick, 2);
    expect((ticks[0] as number) | ((ticks[1] as number) << 8)).toBeGreaterThan(5);
  }, 60_000);
});

describe("a Sega cartridge that fits flat", () => {
  it("pages nothing, and is the cartridge it always was", async () => {
    // Every example but one is this. A build that split its scenes anyway would
    // trace identically and change every byte of every Sega cartridge in the
    // library, so this is the assertion that keeps the switch honest: with
    // nothing paged there are no step labels at all, because the tick is one run
    // of code rather than seven routines.
    const program = compile(gameSource("caves"), {
      profile: getProfile("sms"),
      levels: { "cavern.dmtl": exampleProject("caves").levels["levels/cavern.dmtl"] as string },
    });
    const built = await buildSmsRom(program, { title: "CAVES" });
    expect(built.bytes.length).toBeLessThanOrEqual(0xc000);
    expect([...built.symbols.keys()].some((name) => name.startsWith("Step_"))).toBe(false);
    expect(built.symbols.get("TileBank") as number).toBeLessThan(SMS_SLOT2_BASE);
  }, 60_000);
});
