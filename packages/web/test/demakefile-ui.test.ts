/**
 * The page's controls writing the Demakefile (doc 19 §Options edit the
 * Demakefile).
 *
 * Every case here is one of the four rules that make the feature honest rather
 * than merely present — because each is a way it could be worse than not having
 * it at all: writing to the wrong block, filling a file with directives that
 * change nothing, surprising someone with a file, or reformatting the file they
 * wrote by hand.
 */

import { describe, expect, it } from "vitest";

import { parseDemakefile, resolveOptions } from "@demake/demotic";

import { DEMAKEFILE, resolveOne, setAssetOption } from "../src/lib/demakefile.js";
import { addFile, projectFiles, readText, type Project } from "../src/lib/project.js";

const encoder = new TextEncoder();

function projectWith(demakefile?: string): Project {
  let project: Project = { name: "pong", files: new Map() };
  for (const path of [
    "src/pong.dmt",
    "art/ball.svg",
    "art/paddle.svg",
    "art/pong.title.svg",
    "music/rally.mid",
  ]) {
    project = addFile(
      project,
      path,
      encoder.encode(path === "src/pong.dmt" ? "start play\n" : "x"),
    );
  }
  return demakefile === undefined
    ? project
    : addFile(project, DEMAKEFILE, encoder.encode(demakefile));
}

describe("writing an option", () => {
  it("writes the block for the asset you have open, never `defaults`", () => {
    // The rule that matters most: a change made while looking at one asset must
    // not silently retune every other one.
    const after = setAssetOption(projectWith(), "art/ball.svg", "art", "dither", "bayer4");
    const text = readText(after, DEMAKEFILE);
    expect(text).toContain("art ball");
    expect(text).toContain("dither bayer4");
    expect(text).not.toContain("defaults");
    // …and the other asset is untouched by it.
    const files = projectFiles(after);
    const file = parseDemakefile(text);
    expect(resolveOptions(file, "art/paddle.svg", "art", "gb", files)).toEqual({});
  });

  it("names the asset the way a .dmt would", () => {
    // The shortest string that identifies the file (doc 19 §The rule), so the
    // block reads like the `sprite` line it belongs to.
    const after = setAssetOption(projectWith(), "art/pong.title.svg", "art", "effort", "max");
    expect(readText(after, DEMAKEFILE)).toContain("art pong.title\n");
  });

  it("creates the Demakefile on the first changed option", () => {
    const before = projectWith();
    expect(projectFiles(before)).not.toContain(DEMAKEFILE);
    const after = setAssetOption(before, "art/ball.svg", "art", "effort", "max");
    const text = readText(after, DEMAKEFILE);
    // The file `demake init` would have written, so its appearing is not a
    // surprise and nothing about the build changes except the option just set.
    expect(text).toContain("project pong");
    expect(text).toContain("source src/pong.dmt");
    expect(text).toContain("out build");
  });

  it("removes the line when an option is cleared, and the block with it", () => {
    let project = setAssetOption(projectWith(), "art/ball.svg", "art", "dither", "bayer4");
    expect(readText(project, DEMAKEFILE)).toContain("art ball");
    project = setAssetOption(project, "art/ball.svg", "art", "dither", undefined);
    const text = readText(project, DEMAKEFILE);
    expect(text).not.toContain("dither");
    // An `art ball` with nothing under it says something it does not mean.
    expect(text).not.toContain("art ball");
  });

  it("keeps the rest of a hand-written file exactly as it was", () => {
    const hand = [
      "# Pong, and how it reaches hardware.",
      "",
      "project pong",
      "  title Pong",
      "",
      "# Every console with a backend.",
      "targets gb nes",
      "",
      "art paddle",
      "  effort max",
      "",
    ].join("\n");
    const after = setAssetOption(projectWith(hand), "art/ball.svg", "art", "dither", "bayer4");
    const text = readText(after, DEMAKEFILE);
    // Comments, blank lines, order and the other block all survive: only the
    // line that changed is written.
    expect(text).toContain("# Pong, and how it reaches hardware.");
    expect(text).toContain("# Every console with a backend.");
    expect(text).toContain("targets gb nes");
    expect(text).toContain("art paddle\n  effort max");
    expect(text).toContain("art ball\n  dither bayer4");
  });

  it("rewrites an option rather than adding a second one", () => {
    let project = setAssetOption(projectWith(), "art/ball.svg", "art", "effort", "max");
    project = setAssetOption(project, "art/ball.svg", "art", "effort", "fast");
    const text = readText(project, DEMAKEFILE);
    expect(text.match(/effort/g)).toHaveLength(1);
    expect(text).toContain("effort fast");
  });

  it("finds the block however the file spelled the asset", () => {
    // A file written by hand as `art art/ball.svg` is the same block as one the
    // page would have written as `art ball`.
    const hand = "targets gb\n\nart art/ball.svg\n  effort max\n";
    const after = setAssetOption(projectWith(hand), "art/ball.svg", "art", "effort", "fast");
    const text = readText(after, DEMAKEFILE);
    expect(text.match(/^art /gm)).toHaveLength(1);
    expect(text).toContain("effort fast");
  });

  it("does nothing when clearing an option that was never set", () => {
    const before = projectWith();
    expect(setAssetOption(before, "art/ball.svg", "art", "dither", undefined)).toBe(before);
  });
});

describe("where a value came from", () => {
  const file = [
    "targets gb",
    "",
    "defaults",
    "  art",
    "    effort max",
    "",
    "art ball",
    "  dither bayer4",
  ].join("\n");

  it("says which level of the cascade won", () => {
    const project = projectWith(file);
    expect(resolveOne(project, "art/ball.svg", "art", "gb", "dither")).toEqual({
      value: "bayer4",
      from: "asset",
    });
    expect(resolveOne(project, "art/ball.svg", "art", "gb", "effort")).toEqual({
      value: "max",
      from: "defaults",
    });
    // Nothing set it, so the engine's own default is in force.
    expect(resolveOne(project, "art/paddle.svg", "art", "gb", "dither").from).toBe("engine");
  });

  it("attributes a per-target override to the asset that carries it", () => {
    const project = projectWith("targets gb nes\n\nart ball\n  for nes\n    dither none\n");
    expect(resolveOne(project, "art/ball.svg", "art", "nes", "dither")).toEqual({
      value: "none",
      from: "asset",
    });
    expect(resolveOne(project, "art/ball.svg", "art", "gb", "dither").from).toBe("engine");
  });
});
