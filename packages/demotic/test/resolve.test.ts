/**
 * Reference resolution (doc 19 §The rule).
 *
 * Every case here is one sentence of that section, because the rules are cheap
 * to state and each one of them is a way to silently build the wrong program:
 * a name matching two files, a name matching part of another name, a file that
 * cannot be named at all.
 */

import { describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { findEntry, gameFor, isIgnoredPath, isProject, suiteFor } from "../src/project/entry.js";
import { kindOf } from "../src/project/kinds.js";
import { resolveReference, shortestName } from "../src/project/resolve.js";
import { findProfile } from "../src/profiles.js";

const PROFILE = findProfile("gb") as NonNullable<ReturnType<typeof findProfile>>;

describe("kindOf", () => {
  it("maps each extension to the one kind that can name it", () => {
    expect(kindOf("art/ball.png")).toBe("art");
    expect(kindOf("ball.SVG")).toBe("art");
    expect(kindOf("music/rally.mid")).toBe("music");
    expect(kindOf("sound/bounce.wav")).toBe("sound");
    expect(kindOf("levels/cavern.dmtl")).toBe("level");
  });

  it("has no kind for what a program cannot name", () => {
    expect(kindOf("src/pong.dmt")).toBeUndefined();
    expect(kindOf("Demakefile")).toBeUndefined();
    expect(kindOf("notes")).toBeUndefined();
  });
});

describe("resolveReference", () => {
  const files = [
    "art/ball.png",
    "art/paddle.svg",
    "levels/cavern.dmtl",
    "music/rally.mid",
    "sound/bounce.wav",
  ];

  it("resolves a bare stem when one file of that kind has it", () => {
    expect(resolveReference("ball", "art", files).path).toBe("art/ball.png");
    expect(resolveReference("rally", "music", files).path).toBe("music/rally.mid");
    expect(resolveReference("cavern", "level", files).path).toBe("levels/cavern.dmtl");
  });

  it("resolves a name with its extension, and a partial path", () => {
    expect(resolveReference("ball.png", "art", files).path).toBe("art/ball.png");
    expect(resolveReference("art/ball.png", "art", files).path).toBe("art/ball.png");
    expect(resolveReference("art/ball", "art", files).path).toBe("art/ball.png");
  });

  it("filters by the kind the statement implies, so names never collide across kinds", () => {
    const shared = ["art/theme.png", "music/theme.mid", "sound/theme.wav"];
    expect(resolveReference("theme", "art", shared).path).toBe("art/theme.png");
    expect(resolveReference("theme", "music", shared).path).toBe("music/theme.mid");
    expect(resolveReference("theme", "sound", shared).path).toBe("sound/theme.wav");
  });

  it("matches whole segments, so a name is never a substring of another", () => {
    const near = ["art/pinball.png", "art/ball.png"];
    expect(resolveReference("ball", "art", near).path).toBe("art/ball.png");
    expect(resolveReference("all", "art", near).candidates).toEqual([]);
  });

  it("does not treat a leading segment as a suffix of a longer name", () => {
    const nested = ["art/foo/ball.png", "art/barfoo/ball.png"];
    expect(resolveReference("foo/ball", "art", nested).path).toBe("art/foo/ball.png");
  });

  it("reports every candidate when a stem is shared", () => {
    const both = ["art/ball.png", "art/ball.svg"];
    const found = resolveReference("ball", "art", both);
    expect(found.path).toBeUndefined();
    expect(found.candidates).toEqual(both);
    // …and the extension is what separates them.
    expect(resolveReference("ball.png", "art", both).path).toBe("art/ball.png");
  });

  it("reports every candidate when a name is in two directories", () => {
    const both = ["a/ball.png", "b/ball.png"];
    expect(resolveReference("ball.png", "art", both).candidates).toEqual(both);
    expect(resolveReference("a/ball.png", "art", both).path).toBe("a/ball.png");
  });

  it("matches case-insensitively, because the lexer folds identifiers", () => {
    const cased = ["Art/Ball.PNG"];
    expect(resolveReference("ball", "art", cased).path).toBe("Art/Ball.PNG");
    expect(resolveReference("art/ball.png", "art", cased).path).toBe("Art/Ball.PNG");
  });

  it("lets an exact whole path win, so every file can be named", () => {
    // `foo/ball.png` is also a suffix of `art/foo/ball.png`, so without the
    // exact-match rule the shorter file would be permanently unnameable.
    const shadowed = ["foo/ball.png", "art/foo/ball.png"];
    expect(resolveReference("foo/ball.png", "art", shadowed).path).toBe("foo/ball.png");
    expect(resolveReference("art/foo/ball.png", "art", shadowed).path).toBe("art/foo/ball.png");
  });

  it("tolerates a written path's decoration", () => {
    expect(resolveReference("./art/ball.png", "art", files).path).toBe("art/ball.png");
    expect(resolveReference("/art/ball.png", "art", files).path).toBe("art/ball.png");
    expect(resolveReference("art\\ball.png", "art", files).path).toBe("art/ball.png");
    expect(resolveReference("  ball  ", "art", files).path).toBe("art/ball.png");
  });

  it("finds nothing rather than guessing", () => {
    expect(resolveReference("missing", "art", files).candidates).toEqual([]);
  });

  it("does not depend on the order of the list", () => {
    const forward = resolveReference("ball", "art", files);
    const backward = resolveReference("ball", "art", [...files].reverse());
    expect(backward.path).toBe(forward.path);
  });
});

describe("shortestName", () => {
  it("is the stem where a stem is enough", () => {
    expect(shortestName("art/ball.png", ["art/ball.png", "music/rally.mid"])).toBe("ball");
  });

  it("grows to the extension, then to a path, exactly as far as it must", () => {
    expect(shortestName("art/ball.png", ["art/ball.png", "art/ball.svg"])).toBe("ball.png");
    expect(shortestName("a/ball.png", ["a/ball.png", "b/ball.png"])).toBe("a/ball.png");
  });

  it("round-trips through resolveReference for every file in a project", () => {
    const files = [
      "art/ball.png",
      "art/ball.svg",
      "art/foo/ball.png",
      "art/paddle.svg",
      "b/ball.png",
      "music/rally.mid",
      "sound/rally.wav",
    ];
    for (const file of files) {
      const kind = kindOf(file);
      expect(kind).toBeDefined();
      const name = shortestName(file, files);
      expect(resolveReference(name, kind as "art", files).path, `${file} → ${name}`).toBe(file);
    }
  });
});

describe("the compiler resolves a program's references", () => {
  const source = [
    "start play",
    "scene play",
    "backdrop court",
    "music rally",
    "create object ball (width 1 cell, height 1 cell, sprite ball)",
    "create ball b1 in play (x 4, y 4)",
    "sound bounce on b1 hits screenleft",
  ].join("\n");

  const files = [
    "art/ball.png",
    "art/court.svg",
    "music/rally.mid",
    "sound/bounce.wav",
    "src/pong.dmt",
  ];

  it("rewrites every reference to the file it names", () => {
    const program = compile(source, { profile: PROFILE, files });
    expect(program.assets).toEqual(["art/ball.png", "art/court.svg"]);
    expect(program.tracks).toEqual(["music/rally.mid"]);
    expect(program.sounds).toEqual(["sound/bounce.wav"]);
    expect(program.instances[0]?.strings["sprite"]).toBe("art/ball.png");
  });

  it("leaves references alone when there is no project to resolve against", () => {
    const program = compile(source, { profile: PROFILE });
    expect(program.assets).toEqual(["ball", "court"]);
    expect(program.tracks).toEqual(["rally"]);
    expect(program.sounds).toEqual(["bounce"]);
  });

  it("reports an ambiguous reference against the line that asked", () => {
    const ambiguous = [...files, "art/extra/ball.png"];
    let thrown: unknown;
    try {
      compile(source, { profile: PROFILE, files: ambiguous });
    } catch (error) {
      thrown = error;
    }
    const diagnostics = (thrown as { diagnostics?: readonly { code: string; line: number }[] })
      .diagnostics;
    const ambiguity = diagnostics?.filter((d) => d.code === "E_ASSET_AMBIGUOUS");
    expect(ambiguity?.length).toBe(1);
    // The `create object` line, not the `create ball` one or the top of the file.
    expect(ambiguity?.[0]?.line).toBe(5);
  });

  it("names the strings that would separate the candidates", () => {
    const ambiguous = [...files, "art/extra/ball.png"];
    try {
      compile(source, { profile: PROFILE, files: ambiguous });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as { diagnostics: readonly { hint?: string }[] }).diagnostics
        .map((d) => d.hint ?? "")
        .join(" ");
      expect(message).toContain("art/ball.png");
      expect(message).toContain("extra/ball.png");
    }
  });

  it("resolves a level and the art its legend names", () => {
    const withLevel = ["start play", "scene play", "level room from cavern"].join("\n");
    const levelFiles = ["levels/cavern.dmtl", "art/brick.png"];
    const grid = ["tile # wall solid brick", "", "map", ...Array(18).fill("#".repeat(20))].join(
      "\n",
    );
    const program = compile(withLevel, {
      profile: PROFILE,
      files: levelFiles,
      levels: { "levels/cavern.dmtl": grid },
    });
    expect(program.assets).toEqual(["art/brick.png"]);
  });
});

describe("findEntry", () => {
  it("prefers src/, then the project root", () => {
    expect(findEntry(["src/pong.dmt", "art/ball.svg"]).path).toBe("src/pong.dmt");
    expect(findEntry(["pong.dmt", "art/ball.svg"]).path).toBe("pong.dmt");
    // A flat folder is still a project, which is the zero-config path.
    expect(findEntry(["pong.dmt", "ball.svg", "rally.mid"]).path).toBe("pong.dmt");
  });

  it("does not count a test suite as a game", () => {
    // Otherwise every project in the library would be ambiguous, since each ships
    // its `.test.dmt` beside its source.
    expect(findEntry(["src/pong.dmt", "src/pong.test.dmt"]).path).toBe("src/pong.dmt");
  });

  it("names every candidate rather than picking one", () => {
    const found = findEntry(["src/pong.dmt", "src/other.dmt"]);
    expect(found.path).toBeUndefined();
    expect(found.candidates).toEqual(["src/other.dmt", "src/pong.dmt"]);
  });

  it("finds nothing in a folder with no game", () => {
    expect(findEntry(["art/ball.svg", "music/rally.mid"]).candidates).toEqual([]);
    expect(isProject(["art/ball.svg"])).toBe(false);
    expect(isProject(["src/pong.dmt"])).toBe(true);
    // A folder holding only a suite is not a project either: there is nothing to
    // build, and saying so beats compiling a program about a game that is absent.
    expect(isProject(["src/pong.test.dmt"])).toBe(false);
  });

  it("ignores what a build writes", () => {
    // `build/` is generated, so a leftover cartridge source in it must never
    // become a second candidate — that would make the *second* run of an
    // ordinary build an ambiguity error.
    expect(isIgnoredPath("build/pong.gb")).toBe(true);
    expect(isIgnoredPath("build")).toBe(true);
    expect(isIgnoredPath(".git/config")).toBe(true);
    expect(isIgnoredPath("src/pong.dmt")).toBe(false);
    expect(isIgnoredPath("art/rebuild.svg")).toBe(false);
  });

  it("finds the suite beside a game, by name", () => {
    const files = ["src/pong.dmt", "src/pong.test.dmt", "src/other.dmt"];
    expect(suiteFor("src/pong.dmt", files)).toBe("src/pong.test.dmt");
    expect(suiteFor("src/other.dmt", files)).toBeUndefined();
  });

  it("finds the game a suite is about, which is `suiteFor` read backwards", () => {
    const files = ["src/pong.dmt", "src/pong.test.dmt", "art/ball.svg"];
    expect(gameFor("src/pong.test.dmt", files)).toBe("src/pong.dmt");
  });

  it("falls back to the project's entry point when the names do not pair", () => {
    // A suite is a program *about* a game and a project has one game, so a
    // folder whose suite is named differently is still testing it.
    const files = ["src/pong.dmt", "src/balance.test.dmt"];
    expect(gameFor("src/balance.test.dmt", files)).toBe("src/pong.dmt");
  });

  it("has no answer where there is no game, or where it was not asked about a suite", () => {
    expect(gameFor("src/pong.test.dmt", ["src/pong.test.dmt"])).toBeUndefined();
    // A `.dmt` that is not a suite *is* the game; there is nothing to pair.
    expect(gameFor("src/pong.dmt", ["src/pong.dmt"])).toBeUndefined();
  });
});
