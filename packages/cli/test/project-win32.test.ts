/**
 * A project's paths are the project's, on every platform (doc 19 §The layout).
 *
 * A project-relative path is `/`-separated by definition: that is what `.dmt`
 * references are written with, what `listFiles` hands back, and what a saved
 * folder or an exported zip carries. So the CLI must join a root and one of them
 * with a slash — never with the platform separator, which on Windows spells the
 * same file a second way and finds nothing.
 *
 * This is the guard, and it exists because the Linux and macOS runners cannot see
 * the bug at all: `path.join` is the identity there. Mocking `node:path` to its
 * win32 half makes the same suite ask the same questions with backslashes
 * available, so a `join` that creeps back into the project path arithmetic fails
 * here rather than on someone's Windows machine.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:path", async () => {
  const path = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...path.win32, win32: path.win32, posix: path.posix, default: path.win32 };
});

import type { CliEnv } from "../src/env.js";
import { EXIT } from "../src/exit-codes.js";
import { run } from "../src/run.js";

// Built from the module URL and joined with slashes by hand: `node:path` is the
// thing under test here, so the fixture reading must not go through it.
const PONG = fileURLToPath(new URL("../../demotic/fixtures/projects/pong", import.meta.url));

/** The project on disk, keyed the way a project is keyed: `/`, everywhere. */
function project(prefix = "pong", extra: Record<string, string> = {}): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const path of readdirSync(PONG, { recursive: true }) as string[]) {
    const full = `${PONG}/${path}`;
    if (!statSync(full).isFile()) continue;
    files[`${prefix}/${path}`] = new Uint8Array(readFileSync(full));
  }
  const encoder = new TextEncoder();
  for (const [path, text] of Object.entries(extra))
    files[`${prefix}/${path}`] = encoder.encode(text);
  return files;
}

function harness(files: Record<string, Uint8Array>) {
  let out = "";
  const written = new Map<string, Uint8Array>();
  /** Every path the command asked the environment for. */
  const asked: string[] = [];
  const sources = new Map(Object.entries(files));
  const env: CliEnv = {
    out: (t) => {
      out += t;
    },
    errOut: () => {},
    writeStdout: () => {},
    readFile: (p) => {
      asked.push(p);
      const found = sources.get(p) ?? written.get(p);
      if (!found) throw new Error(`ENOENT ${p}`);
      return found;
    },
    writeFileAtomic: (p, bytes) => {
      asked.push(p);
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
  return { env, out: () => out, written, asked };
}

// Skipped on Windows, where `node:path` already *is* win32 and this file would be
// mocking the platform to itself — `project.test.ts` is the coverage there.
describe.skipIf(process.platform === "win32")(
  "a project on a platform whose separator is a backslash",
  () => {
    it("reads its files by the paths the project itself uses", async () => {
      const h = harness(project());
      expect(await run(["check", "pong"], h.env)).toBe(EXIT.OK);
      // The source, the levels and every asset — asked for by name, not by
      // `pong\src\pong.dmt`, which is a file no project has.
      expect(h.asked.filter((one) => one.includes("\\"))).toEqual([]);
      expect(h.asked).toContain("pong/src/pong.dmt");
    });

    it("writes the Demakefile where the project is", async () => {
      const h = harness(project());
      expect(await run(["init", "pong"], h.env)).toBe(EXIT.OK);
      expect([...h.written.keys()]).toEqual(["pong/Demakefile", "pong/.gitignore"]);
    });

    it("builds a cartridge into the out directory the Demakefile names", async () => {
      // With a Demakefile, because that is the path this is about: `out` nests
      // artifacts by console, so the written path is a root and three segments.
      const h = harness(project("pong", { Demakefile: "targets gb\nout build\n" }));
      expect(await run(["build", "pong"], h.env)).toBe(EXIT.OK);
      expect([...h.written.keys()]).toEqual(["pong/build/gb/pong.gb"]);
    }, 60_000);
  },
);
