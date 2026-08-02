/**
 * What the *trace* says about sound, which is the one thing the interpreter knows.
 *
 * The simulator says *when* a sound is asked for and nothing about chips,
 * channels or registers — a `.dmt` names none of them (doc 16 §Sound is the
 * cartridge's). So this is cheap, console-free, and deliberately nowhere near
 * the per-machine batteries.
 */

import { describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { Sim } from "../src/sim.js";
import { tape, trace } from "../src/trace.js";

import { romTrace } from "./_rom-harness.js";
import { gameSource, projectAssets } from "./_projects.js";

describe("audio in the trace", async () => {
  it("records what the game asked for, with or without the files", async () => {
    // A build with no audio bytes still records the request, so the conformance
    // suite can run without loading a megabyte of fixtures and still be
    // comparing the same game.
    const source = gameSource("pong");
    const program = compile(source, { profile: getProfile("gb") });
    const frames = tape("1:a,90:,90:left,120:right");
    const silent = await romTrace(program, frames);
    const sounding = await romTrace(program, frames, { assets: projectAssets("pong") });
    expect(sounding).toBe(silent);
    expect(silent).toBe(trace(new Sim(program), frames));
  });

  it("names the track a scene asks for, and -1 for a silent one", () => {
    const source = gameSource("pong");
    const program = compile(source, { profile: getProfile("gb") });
    const lines = trace(new Sim(program), tape("2:,3:a,3:")).split("\n");
    // The title screen is silent; the play scene asks for track 0.
    expect(lines.find((line) => line.includes(" title "))).toContain("audio=-1,-1");
    expect(lines.find((line) => line.includes(" play "))).toContain("audio=0,-1");
  });
});
