/**
 * `demake check` and `demake init` (doc 19 §The CLI keeps up).
 *
 * The two halves of "the CLI takes a folder" that are not `build`: one reports
 * what a build would do without doing it, and the other writes the file that
 * makes the defaults explicit without changing them.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { emitDemakefile, parseDemakefile, resolveProject } from "@demake/demotic";

import type { CliEnv } from "../src/env.js";
import { EXIT } from "../src/exit-codes.js";
import { run } from "../src/run.js";

const PONG = join(import.meta.dirname, "..", "..", "demotic", "fixtures", "projects", "pong");

function listFilesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

function harness(files: Record<string, Uint8Array | string> = {}) {
  let out = "";
  let err = "";
  const written = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const sources = new Map<string, Uint8Array>(
    Object.entries(files).map(([path, value]) => [
      path,
      typeof value === "string" ? encoder.encode(value) : value,
    ]),
  );
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
    which: () => null,
    run: () => ({ code: 127, stdout: "", stderr: "" }),
    makeTempDir: () => "/tmp/demake-test",
    removeDir: () => {},
    harnessDir: () => null,
    listFiles: (path) => {
      const prefix = path === "." ? "" : `${path.replace(/\/$/, "")}/`;
      const found = [...sources.keys(), ...written.keys()]
        .filter((one) => one.startsWith(prefix) && one.length > prefix.length)
        .map((one) => one.slice(prefix.length));
      return found.length > 0 ? found.sort() : null;
    },
  };
  return { env, out: () => out, err: () => err, written };
}

/** Pong's project folder, under a prefix. */
function project(prefix = "pong", extra: Record<string, string> = {}) {
  const files: Record<string, Uint8Array | string> = {};
  const at = prefix === "." ? "" : `${prefix}/`;
  for (const one of listFilesUnder(PONG)) {
    files[`${at}${one}`] = new Uint8Array(readFileSync(join(PONG, one)));
  }
  for (const [path, text] of Object.entries(extra)) files[`${at}${path}`] = text;
  return files;
}

describe("demake check", () => {
  it("reports the resolution, so a reference's target is visible", async () => {
    const h = harness(project());
    expect(await run(["check", "pong"], h.env)).toBe(EXIT.OK);
    // The paths, not the names the source wrote: what a reference *resolved to*
    // is the one thing a reader cannot work out from the source (doc 19 §The rule).
    expect(h.out()).toContain("art/ball.svg");
    expect(h.out()).toContain("music/rally.mid");
    expect(h.out()).toContain("sound/bounce.wav");
    expect(h.out()).toContain("project pong");
  });

  it("checks every console with a backend when the project names none", async () => {
    const h = harness(project());
    expect(await run(["check", "pong"], h.env)).toBe(EXIT.OK);
    for (const consoleId of ["gb", "gbc", "nes", "sms", "snes", "md"]) {
      expect(h.out(), consoleId).toContain(consoleId);
    }
  });

  it("checks only the targets a Demakefile declares", async () => {
    const h = harness(project("pong", { Demakefile: "targets gb nes\n" }));
    expect(await run(["check", "pong", "--json"], h.env)).toBe(EXIT.OK);
    const report = JSON.parse(h.out()) as { targets: { console: string }[] };
    expect(report.targets.map((one) => one.console)).toEqual(["gb", "nes"]);
  });

  it("says where each target would write", async () => {
    const h = harness(project("pong", { Demakefile: "targets gb\nout artifacts\n" }));
    expect(await run(["check", "pong", "--json"], h.env)).toBe(EXIT.OK);
    const report = JSON.parse(h.out()) as { targets: { output?: string }[] };
    expect(report.targets[0]?.output).toBe("artifacts/gb/pong.gb");
  });

  it("writes nothing at all — that is the whole difference from build", async () => {
    const h = harness(project());
    await run(["check", "pong"], h.env);
    expect([...h.written.keys()]).toEqual([]);
  });

  it("reports an ambiguous reference once, not once per console", async () => {
    // An ambiguity is a fact about the *source*, so eight copies of it would bury
    // the line that differs between targets.
    const files = project();
    files["pong/art/extra/ball.svg"] = files["pong/art/ball.svg"] as Uint8Array;
    const h = harness(files);
    expect(await run(["check", "pong"], h.env)).toBe(EXIT.BAD_INPUT);
    const occurrences = h.out().split("E_ASSET_AMBIGUOUS").length - 1;
    expect(occurrences).toBe(1);
    expect(h.out()).toContain("every target reports the error above");
  });

  it("fails when a target would not build", async () => {
    const h = harness(project("pong", { Demakefile: "targets gb\n" }));
    const files = project();
    files["pong/src/pong.dmt"] = "start nowhere\n";
    const broken = harness(files);
    expect(await run(["check", "pong"], broken.env)).toBe(EXIT.BAD_INPUT);
    // …and passes when they would.
    expect(await run(["check", "pong"], h.env)).toBe(EXIT.OK);
  });

  it("takes a bare .dmt too, with no project around it", async () => {
    const h = harness({ "pong.dmt": new Uint8Array(readFileSync(join(PONG, "src/pong.dmt"))) });
    expect(await run(["check", "pong.dmt", "-c", "gb"], h.env)).toBe(EXIT.OK);
    // No file list, so references stand as written rather than resolving.
    expect(h.out()).toContain("ball.svg");
    expect(h.out()).not.toContain("art/ball.svg");
  });
});

describe("demake init", () => {
  it("writes a Demakefile and a .gitignore", async () => {
    const h = harness(project());
    expect(await run(["init", "pong"], h.env)).toBe(EXIT.OK);
    expect(h.written.has("pong/Demakefile")).toBe(true);
    expect(new TextDecoder().decode(h.written.get("pong/.gitignore"))).toContain("build/");
  });

  it("writes the file that reproduces the defaults, and nothing more", async () => {
    const h = harness(project());
    await run(["init", "pong"], h.env);
    const text = new TextDecoder().decode(h.written.get("pong/Demakefile"));
    const file = parseDemakefile(text);
    expect(file.diagnostics).toEqual([]);

    // The project's name is the *entry file's stem*, because that is what
    // `resolveProject` defaults to — a name taken from the directory would change
    // the cartridge title, which would make `init` a decision rather than a
    // starting point (doc 15 §You do not need one).
    const plan = resolveProject(file, Object.keys(project(".")), []);
    const bare = resolveProject(undefined, Object.keys(project(".")), []);
    expect(plan.name).toBe(bare.name);
    expect(plan.source).toBe(bare.source);
    expect(plan.out).toBe(bare.out);
  });

  it("writes what the emitter would, so it is already canonical", async () => {
    const h = harness(project());
    await run(["init", "pong"], h.env);
    const text = new TextDecoder().decode(h.written.get("pong/Demakefile"));
    expect(emitDemakefile(parseDemakefile(text))).toBe(text);
  });

  it("refuses to replace an existing Demakefile without --force", async () => {
    const h = harness(project("pong", { Demakefile: "targets gb\n" }));
    expect(await run(["init", "pong"], h.env)).toBe(EXIT.CANNOT_CREATE);
    expect(h.err()).toContain("already exists");
    expect(await run(["init", "pong", "--force"], h.env)).toBe(EXIT.OK);
  });

  it("scaffolds a folder with no game in it, and says so", async () => {
    const h = harness({ "empty/notes.txt": "nothing here" });
    expect(await run(["init", "empty", "--json"], h.env)).toBe(EXIT.OK);
    const report = JSON.parse(h.out()) as { source: string | null; folders: string[] };
    expect(report.source).toBeNull();
    expect(report.folders).toContain("src");
    // With no entry the file has no `source` line — the folder decides once a
    // `.dmt` lands in `src/`.
    const text = new TextDecoder().decode(h.written.get("empty/Demakefile"));
    expect(text).not.toContain("source ");
  });

  it("names every console with a backend as a target", async () => {
    const h = harness(project());
    await run(["init", "pong", "--json"], h.env);
    const report = JSON.parse(h.out()) as { targets: string[] };
    expect(report.targets).toContain("gb");
    expect(report.targets).toContain("snes");
    const text = new TextDecoder().decode(h.written.get("pong/Demakefile"));
    // As the shorthand, which is what `fmt` keeps (doc 19 §A shorthand).
    expect(text).toMatch(/^targets .*gb.*$/m);
  });
});
