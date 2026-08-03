/**
 * `demake build` — the game path's CLI edge.
 *
 * Two properties matter more than the flag handling: the command needs no
 * toolchain (the assembler is ours, in TypeScript), and it *refuses* rather than
 * building a cartridge that would play a different game from the preview.
 * Everything else here is the usual exit-code surface (doc 05).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { profiles, runtimeConsoles } from "@demake/demotic";

import type { CliEnv } from "../src/env.js";
import { EXIT } from "../src/exit-codes.js";
import { run } from "../src/run.js";

// Pong's source out of its project folder (doc 19). The CLI still takes a bare
// `.dmt` — that is the zero-config path — so this harness hands it one file and
// no project around it, which is exactly the case where a reference resolves to
// itself and nothing can be ambiguous.
const PONG = join(import.meta.dirname, "..", "..", "demotic", "fixtures", "projects", "pong");
const read = (name: string) => new Uint8Array(readFileSync(join(PONG, name)));

/** Every file under a directory, relative and `/`-separated. */
function listFilesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

function harness(files: Record<string, Uint8Array> = {}) {
  let out = "";
  let err = "";
  const written = new Map<string, Uint8Array>();
  const sources = new Map<string, Uint8Array>(Object.entries(files));
  const env: CliEnv = {
    out: (t) => {
      out += t;
    },
    errOut: (t) => {
      err += t;
    },
    writeStdout: () => {},
    readFile: (p) => {
      const found = sources.get(p) ?? written.get(p);
      if (!found) throw new Error(`ENOENT ${p}`);
      return found;
    },
    writeFileAtomic: (p, bytes) => {
      written.set(p, bytes);
    },
    readStdin: () => null,
    stdoutIsTTY: () => true,
    stdinIsTTY: () => false,
    env: {},
    // No toolchain anywhere: building a game ROM must not need one.
    which: () => null,
    run: () => ({ code: 127, stdout: "", stderr: "" }),
    makeTempDir: () => "/tmp/demake-test",
    removeDir: () => {},
    harnessDir: () => null,
    // A directory is any prefix the harness was given files under, which is
    // enough for `build` to treat it as a project: it asks for a listing and
    // gets one (doc 19 §The CLI keeps up).
    listFiles: (path) => {
      const prefix = path === "." ? "" : path.replace(/\/$/, "") + "/";
      const found = [...sources.keys(), ...written.keys()]
        .filter((one) => one.startsWith(prefix) && one.length > prefix.length)
        .map((one) => one.slice(prefix.length));
      return found.length > 0 ? found.sort() : null;
    },
  };
  return { env, out: () => out, err: () => err, written };
}

describe("demake build", () => {
  it("writes a 32 KiB cartridge with no toolchain installed", async () => {
    const h = harness({ "pong.dmt": read("src/pong.dmt") });
    const code = await run(["build", "pong.dmt", "-o", "pong.gb", "--title", "PONG"], h.env);
    expect(code).toBe(EXIT.OK);
    const rom = h.written.get("pong.gb") as Uint8Array;
    expect(rom.length).toBe(0x8000);
    expect(String.fromCharCode(...rom.subarray(0x134, 0x138))).toBe("PONG");
    expect(h.err()).toContain("Game Boy (gb)");
  });

  it("reports what it built as JSON", async () => {
    const h = harness({ "pong.dmt": read("src/pong.dmt") });
    expect(await run(["build", "pong.dmt", "-o", "pong.gb", "--json"], h.env)).toBe(EXIT.OK);
    const report = JSON.parse(h.out()) as {
      console: string;
      bytes: number;
      rom: { rules: number; free: number; ram: number; helpers: string[] };
    };
    expect(report.console).toBe("gb");
    expect(report.bytes).toBe(0x8000);
    expect(report.rom.rules).toBeGreaterThan(0);
    expect(report.rom.free).toBeGreaterThan(0);
    expect(report.rom.ram).toBeGreaterThan(0);
    // Pong divides, multiplies, and draws (the opponent's wandering aim).
    expect(report.rom.helpers).toContain("Div32");
    expect(report.rom.helpers).toContain("Mul32");
    expect(report.rom.helpers).toContain("RngPick");
  });

  it("emits the symbol map of the code it generated when asked", async () => {
    const h = harness({ "pong.dmt": read("src/pong.dmt") });
    expect(await run(["build", "pong.dmt", "--format", "sym", "-o", "p.sym"], h.env)).toBe(EXIT.OK);
    const map = new TextDecoder().decode(h.written.get("p.sym") as Uint8Array);
    // The no-bank RGBDS format, so a profiler can bucket cycles by rule.
    expect(map).toMatch(/^00:[0-9a-f]{4} \S+$/m);
    expect(map).toContain("Main");
  });

  it("builds a level game with a camera, which the fixed engine could not", async () => {
    const caves = join(import.meta.dirname, "..", "..", "demotic", "fixtures", "projects", "caves");
    const h = harness({
      "caves.dmt": new Uint8Array(readFileSync(join(caves, "src", "caves.dmt"))),
      // Beside the source, because that is where `build` looks for a level given
      // a bare `.dmt` rather than a project folder.
      "cavern.dmtl": new Uint8Array(readFileSync(join(caves, "levels", "cavern.dmtl"))),
    });
    expect(await run(["build", "caves.dmt", "-o", "caves.gb"], h.env)).toBe(EXIT.OK);
    expect((h.written.get("caves.gb") as Uint8Array).length).toBe(0x8000);
  });

  // This was a test that a console with no backend refuses itself, and its
  // example moved as backends landed — `md` until the Mega Drive built, then
  // `snes`. It has run out of consoles: every Demotic profile now has a backend,
  // so `build`'s `E_NO_RUNTIME` branch cannot be reached through the CLI at all.
  //
  // Deleting it would drop the rule rather than the example, so what it asserts
  // is the fact that made it unsatisfiable. The day someone adds a profile ahead
  // of its backend — which is the normal order, since a profile is what a backend
  // is written against — this fails, and that is exactly when the refusal it used
  // to check becomes reachable again and wants an example naming that console.
  //
  // The neighbouring `E_UNKNOWN_CONSOLE` path is a different branch and is still
  // covered directly, in `run.test.ts`.
  it("has a backend for every console a game can be compiled for", () => {
    expect([...profiles].map((profile) => profile.id).sort()).toEqual([...runtimeConsoles].sort());
  });

  it("builds a Mega Drive cartridge, vectors and header and all", async () => {
    const h = harness({ "pong.dmt": read("src/pong.dmt") });
    expect(await run(["build", "pong.dmt", "-c", "md", "-o", "pong.md"], h.env)).toBe(EXIT.OK);
    const rom = h.written.get("pong.md") as Uint8Array;
    // One megabit, which is the smallest board this console came on: a demade
    // game is twenty-odd kilobytes, so the half-megabyte image this used to be
    // was four hundred and eighty kilobytes of zeros. The ROM-end field is an
    // *address*, so it says one less than the length.
    expect(rom.length).toBe(0x20000);
    expect([...rom.subarray(0x1a4, 0x1a8)]).toEqual([0x00, 0x01, 0xff, 0xff]);
    expect(String.fromCharCode(...rom.subarray(0x100, 0x110))).toBe("SEGA MEGA DRIVE ");
    expect(h.err()).toContain("128 KiB cartridge");
  });

  it("reports every compile diagnostic instead of the first", async () => {
    const h = harness({
      "bad.dmt": new TextEncoder().encode("start play\nscene play\ncreate object d (wibble 1)\n"),
    });
    expect(await run(["build", "bad.dmt", "-o", "bad.gb"], h.env)).toBe(EXIT.BAD_INPUT);
    expect(h.err()).toContain("E_UNKNOWN_PROP");
  });

  it("needs rgbfix for --boot-logo, and says so", async () => {
    const h = harness({ "pong.dmt": read("src/pong.dmt") });
    expect(await run(["build", "pong.dmt", "-o", "pong.gb", "--boot-logo"], h.env)).toBe(
      EXIT.UNAVAILABLE,
    );
    expect(h.err()).toContain("rgbfix");
  });
});

describe("demake build <dir>", () => {
  /** Pong's project folder, exactly as it is on disk (doc 19). */
  function project(prefix = "pong"): Record<string, Uint8Array> {
    const files: Record<string, Uint8Array> = {};
    // `.` is the working directory, whose files have no prefix at all — which is
    // also how `join(".", "src/pong.dmt")` names them.
    const at = prefix === "." ? "" : `${prefix}/`;
    for (const one of listFilesUnder(PONG)) {
      files[`${at}${one}`] = new Uint8Array(readFileSync(join(PONG, one)));
    }
    return files;
  }

  it("builds a project folder, finding its game and its art", async () => {
    const h = harness(project());
    expect(await run(["build", "pong", "-o", "pong.gb"], h.env)).toBe(EXIT.OK);
    const rom = h.written.get("pong.gb") as Uint8Array;
    expect(rom.length).toBe(0x8000);
    // Byte-identical to the same project built from its `.dmt` with the assets
    // beside it would *not* hold — the folder resolves `sprite ball` to
    // `art/ball.svg`, so the cartridge has art the flat build cannot find. That
    // is the point of the folder, and this is the cheapest way to see it: a
    // cartridge with demade art in it is bigger than one without.
    const flat = harness({ "pong.dmt": read("src/pong.dmt") });
    expect(await run(["build", "pong.dmt", "-o", "flat.gb"], flat.env)).toBe(EXIT.OK);
    const without = flat.written.get("flat.gb") as Uint8Array;
    expect(rom).not.toEqual(without);
  });

  it("reports what it resolved, with paths rather than bare names", async () => {
    const h = harness(project());
    expect(await run(["build", "pong", "-o", "pong.gb", "--json"], h.env)).toBe(EXIT.OK);
    const report = JSON.parse(h.out()) as { assets?: string[] };
    expect(report.assets ?? []).toContain("art/ball.svg");
  });

  it("builds the working directory when given nothing", async () => {
    const h = harness(project("."));
    expect(await run(["build", "-o", "pong.gb"], h.env)).toBe(EXIT.OK);
    expect((h.written.get("pong.gb") as Uint8Array).length).toBe(0x8000);
  });

  it("refuses a folder with no game rather than compiling nothing", async () => {
    const h = harness({ "empty/art/ball.svg": read("art/ball.svg") });
    expect(await run(["build", "empty", "-o", "x.gb"], h.env)).toBe(EXIT.NO_INPUT);
    expect(h.err()).toContain("no .dmt file");
  });

  it("names both games rather than picking one", async () => {
    const h = harness({
      ...project(),
      "pong/src/other.dmt": read("src/pong.dmt"),
    });
    expect(await run(["build", "pong", "-o", "x.gb"], h.env)).toBe(EXIT.NO_INPUT);
    expect(h.err()).toContain("holds 2 games");
    // And it says what to type instead.
    expect(h.err()).toContain("src/other.dmt");
  });

  it("does not treat a previous build's output as input", async () => {
    // `build/` is generated (doc 19 §`build/` is the CLI's), so a stray `.dmt`
    // in it must not become a second candidate — which would turn the second run
    // of an ordinary build into an ambiguity error.
    const h = harness({ ...project(), "pong/build/leftover.dmt": read("src/pong.dmt") });
    expect(await run(["build", "pong", "-o", "pong.gb"], h.env)).toBe(EXIT.OK);
  });
});

describe("demake build with a Demakefile", () => {
  function project(extra: Record<string, string> = {}): Record<string, Uint8Array> {
    const files: Record<string, Uint8Array> = {};
    for (const one of listFilesUnder(PONG)) {
      files[`pong/${one}`] = new Uint8Array(readFileSync(join(PONG, one)));
    }
    for (const [path, text] of Object.entries(extra)) {
      files[`pong/${path}`] = new TextEncoder().encode(text);
    }
    return files;
  }

  it("takes the entry point from `source`", async () => {
    // Two games in the folder would be ambiguous; `source` is how a Demakefile
    // resolves that (doc 15 §Top level).
    const h = harness(
      project({
        "src/other.dmt": "start play\nscene play\n",
        Demakefile: "source src/pong.dmt\ntargets gb\n",
      }),
    );
    expect(await run(["build", "pong", "-o", "pong.gb"], h.env)).toBe(EXIT.OK);
    expect((h.written.get("pong.gb") as Uint8Array).length).toBe(0x8000);
  });

  it("puts the artifact under `out` when -o is absent", async () => {
    const h = harness(project({ Demakefile: "project pong\ntargets gb\nout artifacts\n" }));
    expect(await run(["build", "pong"], h.env)).toBe(EXIT.OK);
    expect(h.written.has("pong/artifacts/gb/pong.gb")).toBe(true);
  });

  it("honours a target's own output path", async () => {
    const h = harness(project({ Demakefile: "targets gb\n\ntarget gb\n  output rom cart.gb\n" }));
    expect(await run(["build", "pong"], h.env)).toBe(EXIT.OK);
    expect(h.written.has("pong/build/cart.gb")).toBe(true);
  });

  it("refuses a Demakefile it cannot read, rather than ignoring it", async () => {
    const h = harness(project({ Demakefile: "frobnicate yes\n" }));
    expect(await run(["build", "pong", "-o", "x.gb"], h.env)).toBe(EXIT.BAD_INPUT);
    expect(h.err()).toContain("E_UNKNOWN_DIRECTIVE");
  });

  it("takes the cartridge title from the header, then from the project", async () => {
    const withHeader = harness(
      project({ Demakefile: "targets gb\n\ntarget gb\n  header\n    title HEADER\n" }),
    );
    expect(await run(["build", "pong", "-o", "a.gb"], withHeader.env)).toBe(EXIT.OK);
    const a = withHeader.written.get("a.gb") as Uint8Array;
    expect(String.fromCharCode(...a.subarray(0x134, 0x13a))).toBe("HEADER");

    const withProject = harness(
      project({ Demakefile: "project pong\n  title FROMPROJ\ntargets gb\n" }),
    );
    expect(await run(["build", "pong", "-o", "b.gb"], withProject.env)).toBe(EXIT.OK);
    const b = withProject.written.get("b.gb") as Uint8Array;
    expect(String.fromCharCode(...b.subarray(0x134, 0x13c))).toBe("FROMPROJ");

    // …and the flag still wins over both.
    const flagged = harness(
      project({ Demakefile: "project pong\n  title FROMPROJ\ntargets gb\n" }),
    );
    expect(await run(["build", "pong", "-o", "c.gb", "--title", "FLAG"], flagged.env)).toBe(
      EXIT.OK,
    );
    const c = flagged.written.get("c.gb") as Uint8Array;
    expect(String.fromCharCode(...c.subarray(0x134, 0x138))).toBe("FLAG");
  });

  it("reports the resolved plan under --json", async () => {
    const h = harness(project({ Demakefile: "project pong\ntargets gb nes\nout artifacts\n" }));
    expect(await run(["build", "pong", "-o", "x.gb", "--json"], h.env)).toBe(EXIT.OK);
    const report = JSON.parse(h.out()) as {
      plan?: { out: string; targets: { console: string }[] };
    };
    expect(report.plan?.out).toBe("artifacts");
    expect(report.plan?.targets.map((one) => one.console)).toEqual(["gb", "nes"]);
  });
});
