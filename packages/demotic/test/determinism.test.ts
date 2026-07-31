import { describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { Sim } from "../src/sim.js";
import { tape, trace } from "../src/trace.js";
import { gameSource, projectText } from "./_projects.js";

const PONG = gameSource("pong");
const GOLDEN = projectText("pong", "pong.gb.trace").trimEnd();

/** The tape the golden trace was recorded with. */
const TAPE = "1:a,90:,90:left,120:right";

function traceFor(consoleId: string, script = TAPE): string {
  const program = compile(PONG, { profile: getProfile(consoleId) });
  return trace(new Sim(program), tape(script));
}

describe("determinism", () => {
  it("produces the same trace every run", () => {
    expect(traceFor("gb")).toBe(traceFor("gb"));
  });

  it("matches the checked-in golden trace", () => {
    // This file is the conformance target. A console runtime is correct when
    // it emits these exact lines for this exact tape — which makes proving a
    // port a `diff`, not a judgement call. Changing it means the language's
    // semantics changed, and that should be a deliberate, reviewed act.
    expect(traceFor("gb")).toBe(GOLDEN);
  });

  it("emits raw fixed-point integers, never decimals", () => {
    // A decimal rendering would hide a one-bit disagreement, and a one-bit
    // disagreement in a velocity is what compounds into a visibly different
    // game a thousand ticks later.
    for (const line of traceFor("gb").split("\n")) {
      if (line.startsWith("#")) continue;
      for (const number of line.split(/[ =,]/).slice(2)) {
        if (number === "" || /^[a-z]/i.test(number)) continue;
        expect(Number.isInteger(Number(number)), `'${number}' in '${line}'`).toBe(true);
      }
    }
  });

  it("keeps every value inside the exact-integer range of the fixed-point type", () => {
    const limit = 1024 * 65536;
    for (const line of traceFor("gb").split("\n")) {
      if (line.startsWith("#")) continue;
      for (const number of line.split(/[ =,]/).slice(2)) {
        if (number === "" || /^[a-z]/i.test(number)) continue;
        expect(Math.abs(Number(number))).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("runs the same source on every console without recompilation of the source text", () => {
    for (const id of ["gb", "gbc", "nes", "sms", "gg", "md", "snes"]) {
      const output = traceFor(id, "1:a,60:");
      // Three header lines — the third names the audio field, which pong has
      // since it has music — plus one line per tick.
      expect(output.split("\n")).toHaveLength(3 + 61);
      expect(output).toContain(`console=${id}`);
    }
  });

  it("diverges between consoles only because the playfields differ", () => {
    // Same rules, same speeds, different geometry: the Mega Drive's taller
    // playfield means the ball simply has not reached the paddle yet.
    const short = traceFor("gb", "1:a,60:");
    const tall = traceFor("md", "1:a,60:");
    expect(short).not.toBe(tall);

    const lastOf = (text: string) => text.trimEnd().split("\n").at(-1) ?? "";
    expect(lastOf(short)).toContain("61 play");
    expect(lastOf(tall)).toContain("61 play");
  });
});
