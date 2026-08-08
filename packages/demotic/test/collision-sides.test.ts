/**
 * `from above` on every console with a backend.
 *
 * The clause has been in the language and in the interpreter since collisions
 * were; what it had not been is *buildable*, so a program using it previewed and
 * traced and then refused to become a cartridge. This file is the proof that it
 * does now, on the terms every other backend claim here is made on: the same
 * program, on every machine, diffed against the reference interpreter tick for
 * tick.
 *
 * Three things about the program below are deliberate and worth not undoing.
 *
 * **Every probe starts already overlapping.** A side is decided by where two
 * boxes *sit*, not by which way either was travelling, so a stationary overlap
 * is the whole question and a moving one only adds a console-dependent number of
 * ticks before it. The screens in this set differ fourfold in area and their
 * tick rates by a quarter, so a probe that had to travel would arrive on a
 * different tick on every machine — and a case that never arrives compares zero
 * against zero and passes.
 *
 * **Each probe carries a rule for the side it is on and one for a side it is
 * not**, counting one and sixteen into the same number. The interpreter is the
 * oracle for both, so a backend that ignored the clause would come out at
 * seventeen and one that inverted it at sixteen. Without the negative case a
 * cartridge that fired everything would still pass.
 *
 * **The probes are placed so the axis they name is the shallower one.** Which
 * side a contact resolved on is which axis separation would push along, so a
 * probe centred on the perpendicular axis and overlapping by a quarter cell on
 * the named one can only answer one way.
 */

import { describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { fromInt } from "../src/fixed.js";
import { getProfile } from "../src/profiles.js";
import { unsupportedFor } from "../src/codegen/registry.js";
import { Sim } from "../src/sim.js";
import { tape, trace } from "../src/trace.js";

import { romTrace, TARGETS } from "./_rom-harness.js";

/**
 * Four solid cells with nothing beside them.
 *
 * Each probe overlaps its own cell and one empty neighbour, which is what makes
 * the answer readable: a box straddling two named cells would resolve against
 * both and the trace could not say which side either was. Bigger than any screen
 * in the set, because a level smaller than one is refused by name — and
 * everything below sits inside the smallest, so no console needs a camera.
 */
const LEVEL = ((): string => {
  const width = 64;
  const height = 32;
  const stones = new Set(["4,8", "8,8", "12,8", "16,8"]);
  const rows: string[] = [];
  for (let row = 0; row < height; row += 1) {
    let line = "";
    for (let column = 0; column < width; column += 1) {
      line += stones.has(`${column},${row}`) ? "#" : ".";
    }
    rows.push(line);
  }
  return ["tile # stone solid", "tile . air", "map", ...rows, ""].join("\n");
})();

/**
 * The program: four probes against an object, four against a tile.
 *
 * Positions are absolute cells throughout, because this is a test of geometry
 * rather than of layout — a relative size would put the probes somewhere
 * different on every console and the sides with them.
 */
const SOURCE = [
  "start play",
  "",
  "scene play",
  "level room from room.dmtl",
  "",
  "create object slab (width 2 cells, height 2 cells)",
  "create object probe (width 1 cell, height 1 cell)",
  "create slab wall in play (x 2, y 2)",
  "",
  "create probe pleft in play (x 1.5, y 2.5)",
  "create probe pright in play (x 3.5, y 2.5)",
  "create probe pabove in play (x 2.5, y 1.5)",
  "create probe pbelow in play (x 2.5, y 3.5)",
  "",
  "create probe tleft in play (x 3.75, y 8)",
  "create probe tright in play (x 8.75, y 8)",
  "create probe tabove in play (x 12, y 7.75)",
  "create probe tbelow in play (x 16, y 8.75)",
  "",
  // One counter per probe rather than two: the named side adds one and the
  // wrong side adds sixteen, so a single number says which rules fired and the
  // program still fits the tightest work RAM in the set.
  "create number nleft in play (value 0, visible 0)",
  "create number nright in play (value 0, visible 0)",
  "create number nabove in play (value 0, visible 0)",
  "create number nbelow in play (value 0, visible 0)",
  "create number tnleft in play (value 0, visible 0)",
  "create number tnright in play (value 0, visible 0)",
  "create number tnabove in play (value 0, visible 0)",
  "create number tnbelow in play (value 0, visible 0)",
  "",
  // `hits` rather than `touches`, so each contact is one event and the counter
  // is a verdict rather than a tick count.
  //
  // The wrong side comes *first* in every pair, and that ordering is the whole
  // test. A contact the clause admits is also separated, so a second rule
  // written after one that fired would find the boxes already pushed apart and
  // stay silent whether or not it was narrowed — which reads as a pass on a
  // backend that never looked at the clause at all.
  "when pleft hits wall from above then nleft.value as nleft.value + 16",
  "when pleft hits wall from left then nleft.value as nleft.value + 1",
  "when pright hits wall from below then nright.value as nright.value + 16",
  "when pright hits wall from right then nright.value as nright.value + 1",
  "when pabove hits wall from right then nabove.value as nabove.value + 16",
  "when pabove hits wall from above then nabove.value as nabove.value + 1",
  "when pbelow hits wall from left then nbelow.value as nbelow.value + 16",
  "when pbelow hits wall from below then nbelow.value as nbelow.value + 1",
  "",
  "when tleft hits stone from left then tnleft.value as tnleft.value + 1",
  "when tleft hits stone from above then tnleft.value as tnleft.value + 16",
  "when tright hits stone from right then tnright.value as tnright.value + 1",
  "when tright hits stone from below then tnright.value as tnright.value + 16",
  "when tabove hits stone from above then tnabove.value as tnabove.value + 1",
  "when tabove hits stone from left then tnabove.value as tnabove.value + 16",
  "when tbelow hits stone from below then tnbelow.value as tnbelow.value + 1",
  "when tbelow hits stone from right then tnbelow.value as tnbelow.value + 16",
  "",
].join("\n");

const LEVELS = { "room.dmtl": LEVEL };

function build(consoleId: string) {
  return compile(SOURCE, { profile: getProfile(consoleId), levels: LEVELS });
}

/** What each `number` in the program holds after the interpreter has run it. */
function values(consoleId: string): Record<string, number> {
  const program = build(consoleId);
  const sim = new Sim(program);
  sim.run(tape("8:"));
  const out: Record<string, number> = {};
  for (const instance of program.instances) {
    const entity = sim.entity(instance.name);
    if (entity) out[instance.name] = entity.numbers["value"] ?? 0;
  }
  return out;
}

describe("`from <side>` narrows a contact", () => {
  it("names the side the pair sits on, and only that one", () => {
    // The semantic half, asserted against the interpreter alone: without it the
    // conformance battery below would be comparing eight zeroes with eight
    // zeroes on a backend that dropped the clause and every rule with it.
    const state = values("gb");
    for (const side of ["left", "right", "above", "below"]) {
      expect([side, state[`n${side}`]]).toEqual([side, fromInt(1)]);
    }
  });

  it("names the side of the cell an object sat on, and only that one", () => {
    const state = values("gb");
    for (const side of ["left", "right", "above", "below"]) {
      expect([side, state[`tn${side}`]]).toEqual([side, fromInt(1)]);
    }
  });

  it("is no longer a gap any backend has to refuse", () => {
    // The list this file exists to empty. It named `from` for every console at
    // once, because the gap was in the emitters as a group rather than a
    // difference between them.
    for (const target of TARGETS) {
      expect([target.console, unsupportedFor(build(target.console))]).toEqual([target.console, []]);
    }
  });
});

describe("`from <side>` conformance across every backend", () => {
  const frames = tape("8:");
  for (const target of TARGETS) {
    it(`matches the interpreter on ${target.console}`, async () => {
      const program = build(target.console);
      expect(await romTrace(program, frames, {}, target)).toBe(trace(new Sim(program), frames));
    });
  }
});
