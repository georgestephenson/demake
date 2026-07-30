/**
 * The Demakefile (doc 15, doc 19 §The Demakefile, still optional).
 *
 * Two things are being checked, and the second is the one that matters. The
 * format works — indentation, blocks, quoting, the cascade. And the *invariant*
 * holds: a Demakefile cannot change how a game plays, which is what the whole
 * split between doc 14 and doc 15 exists to protect.
 */

import { describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { emitDemakefile } from "../src/demakefile/emit.js";
import { parseDemakefile } from "../src/demakefile/parse.js";
import { outputPath, resolveOptions, resolveProject } from "../src/demakefile/resolve.js";
import { getProfile } from "../src/profiles.js";
import { Sim } from "../src/sim.js";
import { tape, trace } from "../src/trace.js";
import { exampleProject } from "./_projects.js";

/** Parse, dropping the diagnostics — for the cases that are meant to be clean. */
function parse(text: string) {
  const file = parseDemakefile(text);
  expect(file.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return file;
}

const FULL = `# Demakefile — how Pong reaches real hardware.
# The game itself is in src/pong.dmt and knows none of this.

project pong
  title Pong
  author George Stephenson
  version 1.0.0

source src/pong.dmt
out build

defaults
  art
    strategy auto
    dither none
  music
    effort default

targets gb gbc nes

target md
  region ntsc
  output rom pong.bin
  header
    title PONG
    serial GM 00000000-00

art ball
  dither none
  for md
    use ball-hd.svg

music rally
  role 1 lead
`;

describe("parsing", () => {
  it("reads every kind of directive", () => {
    const file = parse(FULL);
    expect(file.project?.name).toBe("pong");
    expect(file.source?.value).toBe("src/pong.dmt");
    expect(file.out?.value).toBe("build");
    expect(file.defaults.art?.map((one) => one.name)).toEqual(["strategy", "dither"]);
    expect(file.defaults.music?.map((one) => one.name)).toEqual(["effort"]);
    expect(file.targets.map((one) => one.name)).toEqual(["gb", "gbc", "nes", "md"]);
    expect(file.assetBlocks.map((one) => `${one.domain} ${one.name}`)).toEqual([
      "art ball",
      "music rally",
    ]);
  });

  it("lets the final field absorb the rest of the line, so nothing needs quotes", () => {
    const file = parse("project pong\n  title  Pong Deluxe\n");
    expect(file.project?.fields[0]?.value).toBe("Pong Deluxe");
  });

  it("keeps a hash that is part of a value", () => {
    // Doc 15's example: `serial GM-00000000#2` keeps its hash, because a comment
    // needs a space before it.
    const file = parse("target md\n  header\n    serial GM-00000000#2\n");
    expect(file.targets[0]?.header[0]?.value).toBe("GM-00000000#2");
  });

  it("takes a target's console from its own name unless told otherwise", () => {
    const plan = resolveProject(parse("targets gb nes\n"));
    expect(plan.targets.map((one) => one.console)).toEqual(["gb", "nes"]);
    const named = resolveProject(parse("target md-pal\n  console md\n  region pal\n"));
    expect(named.targets[0]?.console).toBe("md");
    expect(named.targets[0]?.region).toBe("pal");
  });

  it("lets a target block refine the shorthand rather than clashing with it", () => {
    const file = parse("targets gb nes\n\ntarget nes\n  output rom custom.nes\n");
    expect(file.targets.map((one) => one.name)).toEqual(["gb", "nes"]);
    expect(file.targets[1]?.outputs[0]?.path).toBe("custom.nes");
  });

  it("treats bare options under `defaults` as art's", () => {
    // What doc 15 documented before there were three domains.
    const file = parse("defaults\n  dither none\n");
    expect(file.defaults.art?.map((one) => one.name)).toEqual(["dither"]);
  });
});

describe("diagnostics", () => {
  const codes = (text: string) => parseDemakefile(text).diagnostics.map((d) => d.code);

  it("names both offending lines when tabs and spaces are mixed", () => {
    const found = parseDemakefile("project a\n\ttitle A\ntarget gb\n  region ntsc\n");
    expect(found.diagnostics[0]?.code).toBe("E_MIXED_INDENT");
    expect(found.diagnostics[0]?.message).toMatch(/line 2/);
    expect(found.diagnostics[0]?.message).toMatch(/line 4/);
  });

  it("rejects indentation that is not a multiple of the file's unit", () => {
    expect(codes("project a\n  title A\n   author B\n")).toContain("E_BAD_INDENT");
  });

  it("names an unknown directive, and does not hide what follows it", () => {
    const found = parseDemakefile("frobnicate yes\nsourc src/a.dmt\n");
    expect(found.diagnostics.map((d) => d.code)).toEqual([
      "E_UNKNOWN_DIRECTIVE",
      "E_UNKNOWN_DIRECTIVE",
    ]);
  });

  it("reports a non-repeatable directive set twice, naming both lines", () => {
    const found = parseDemakefile("source a.dmt\nsource b.dmt\n");
    expect(found.diagnostics[0]?.code).toBe("E_DUPLICATE_DIRECTIVE");
    expect(found.diagnostics[0]?.message).toMatch(/lines 1 and 2/);
  });

  it("allows `assets` twice, because it is the repeatable one", () => {
    expect(codes("assets shared/\nassets vendor/\n")).toEqual([]);
  });

  it("reports the wrong number of fields", () => {
    expect(codes("source\n")).toContain("E_ARITY");
    expect(codes("target gb\n  output rom\n")).toContain("E_ARITY");
  });

  it("reports a `for` naming no declared target", () => {
    expect(codes("targets gb\n\nart ball\n  for nes\n    dither none\n")).toContain(
      "E_UNKNOWN_TARGET",
    );
  });
});

describe("the equivalence contract", () => {
  // Doc 15 §The equivalence contract, as three executable properties.
  const fmt = (text: string) => emitDemakefile(parseDemakefile(text));

  it("1. formatting is idempotent", () => {
    const once = fmt(FULL);
    expect(fmt(once)).toBe(once);
  });

  it("2. the model round-trips through text", () => {
    expect(emitDemakefile(parseDemakefile(fmt(FULL)))).toBe(fmt(FULL));
  });

  it("3. a canonical file comes back byte-identical", () => {
    // Including its comments and its blank lines, which is what lets the web
    // app's controls write into a hand-authored file (doc 19).
    expect(fmt(FULL)).toBe(FULL);
  });

  it("keeps a comment attached to the directive below it", () => {
    const text = "# about the source\nsource src/pong.dmt\n";
    expect(fmt(text)).toBe(text);
  });

  it("normalises indentation to two spaces, and alignment to one", () => {
    // Two spaces per level is doc 15's rule. Column alignment is *not* preserved:
    // a formatter with one answer cannot also keep everyone's alignment, and a
    // value is separated from its directive by exactly one space.
    expect(fmt("project a\n    title A\n")).toBe("project a\n  title A\n");
    expect(fmt("project a\n  title    A\n  author   B\n")).toBe(
      "project a\n  title A\n  author B\n",
    );
  });

  it("quotes only a value that would not survive being read back", () => {
    const file = parseDemakefile("project a\n  title  Pong\n");
    expect(emitDemakefile(file)).toBe("project a\n  title Pong\n");
    // Trailing space is the case that needs quotes; doc 15 §Format.
    const spaced = parseDemakefile('project a\n  title "Pong "\n');
    expect(emitDemakefile(spaced)).toContain('"Pong "');
  });

  it("emits nothing for an empty file", () => {
    expect(emitDemakefile(parseDemakefile(""))).toBe("");
  });
});

describe("resolution", () => {
  const files = ["src/pong.dmt", "art/ball.svg", "music/rally.mid"];

  it("takes the folder's defaults where the file is silent", () => {
    const plan = resolveProject(parseDemakefile(""), files, ["gb"]);
    expect(plan.source).toBe("src/pong.dmt");
    expect(plan.out).toBe("build");
    expect(plan.name).toBe("pong");
    expect(plan.targets.map((one) => one.console)).toEqual(["gb"]);
  });

  it("cascades most-specific-wins, per domain", () => {
    const file = parse(
      [
        "targets gb nes",
        "",
        "defaults",
        "  art",
        "    dither none",
        "    effort default",
        "",
        "target nes",
        "  effort max",
        "",
        "art ball",
        "  dither bayer4",
        "  for nes",
        "    dither ordered",
      ].join("\n"),
    );
    // defaults only
    expect(resolveOptions(file, "art/paddle.svg", "art", "gb", files)["dither"]).toBe("none");
    // asset block beats defaults
    expect(resolveOptions(file, "art/ball.svg", "art", "gb", files)["dither"]).toBe("bayer4");
    // target beats defaults
    expect(resolveOptions(file, "art/paddle.svg", "art", "nes", files)["effort"]).toBe("max");
    // `for <target>` beats the asset block
    expect(resolveOptions(file, "art/ball.svg", "art", "nes", files)["dither"]).toBe("ordered");
  });

  it("matches an asset block however it spells the asset", () => {
    // `art ball`, `art ball.svg` and `art art/ball.svg` are the same asset, for
    // the same reason a `.dmt` can write any of them (doc 19 §The rule).
    for (const spelling of ["ball", "ball.svg", "art/ball.svg"]) {
      const file = parse(
        `${spelling === "ball" ? "art ball" : `art ${spelling}`}\n  dither none\n`,
      );
      expect(resolveOptions(file, "art/ball.svg", "art", "gb", files)["dither"], spelling).toBe(
        "none",
      );
    }
  });

  it("keeps the domains apart, so a track's options never reach a sprite", () => {
    const file = parse("defaults\n  art\n    effort max\n  music\n    effort fast\n");
    expect(resolveOptions(file, "art/ball.svg", "art", "gb", files)["effort"]).toBe("max");
    expect(resolveOptions(file, "music/rally.mid", "music", "gb", files)["effort"]).toBe("fast");
  });

  it("fills an output path from the template, or takes the one given", () => {
    const plan = resolveProject(parse("targets gb\n"), files, []);
    const target = plan.targets[0]!;
    expect(outputPath(plan, target, "gb")).toBe("build/gb/pong.gb");
    expect(outputPath(plan, target, "gb", "{project}-{console}.{ext}")).toBe("build/pong-gb.gb");
    // A path escaping `out` says so with a leading `./` or `/`.
    expect(outputPath(plan, target, "gb", "./release/pong.gb")).toBe("./release/pong.gb");
  });
});

describe("the gameplay invariant", () => {
  it("a Demakefile cannot change how a game plays", () => {
    // Doc 15's fourth property, and the one the whole split exists to protect:
    // `trace(dmt, console, region)` is byte-identical with and without any build
    // file. Resolution is the only thing a Demakefile touches, and a trace is
    // downstream of nothing it can reach.
    const { source, files, levels } = exampleProject("caves");
    const options = { profile: getProfile("gb"), files, levels };
    const script = tape("240:,42:right,1:a,18:,26:left,60:");
    const bare = trace(new Sim(compile(source, options)), script);

    // The most opinionated Demakefile the format allows for this project.
    const file = parse(
      [
        "project caves",
        "  title Caves",
        "source src/caves.dmt",
        "out artifacts",
        "targets gb nes md",
        "",
        "defaults",
        "  art",
        "    dither bayer4",
        "    effort max",
        "  music",
        "    effort max",
        "",
        "art hero",
        "  dither none",
      ].join("\n"),
    );
    const plan = resolveProject(file, files, []);
    expect(plan.out).toBe("artifacts");
    expect(resolveOptions(file, "art/hero.svg", "art", "gb", files)["dither"]).toBe("none");

    const withFile = trace(
      new Sim(compile(source, options)),
      tape("240:,42:right,1:a,18:,26:left,60:"),
    );
    expect(withFile).toBe(bare);
  });
});
