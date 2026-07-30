/**
 * The project zip (doc 19 §Opening, saving, and the parity claim).
 *
 * The property that matters is not "it produces a zip" — it is that a project
 * which made the round trip through one is the *same project*. That is what makes
 * the zip the other half of opening a folder rather than a lossy fallback, and it
 * is the closest thing to a test of the parity claim that runs without a browser.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { exportZip, importZip } from "../src/lib/disk.js";
import { addFile, projectFiles, readText, type Project } from "../src/lib/project.js";
import { readZip, writeZip, ZipError } from "../src/lib/zip.js";

/** Pong's project folder, off disk — the same one the CLI builds. */
function pongOnDisk(): Project {
  const root = join(
    createRequire(import.meta.url).resolve("@demake/demotic/fixtures/projects/pong/src/pong.dmt"),
    "..",
    "..",
  );
  let project: Project = { name: "pong", files: new Map() };
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
    project = addFile(project, path, new Uint8Array(readFileSync(join(root, path))));
  }
  return project;
}

describe("writeZip and readZip", () => {
  it("round-trips a file's bytes exactly", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 0, 0, 255]);
    const zip = writeZip("proj", [{ path: "art/ball.svg", bytes }]);
    const read = readZip(zip);
    expect(read.folder).toBe("proj");
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]?.path).toBe("art/ball.svg");
    expect([...(read.entries[0]?.bytes ?? [])]).toEqual([...bytes]);
  });

  it("puts everything under one folder, so an export unzips to a project", () => {
    const zip = writeZip("pong", [
      { path: "src/pong.dmt", bytes: new Uint8Array([1]) },
      { path: "art/ball.svg", bytes: new Uint8Array([2]) },
    ]);
    // The names in the archive carry the folder; reading strips it again.
    const text = new TextDecoder().decode(zip);
    expect(text).toContain("pong/src/pong.dmt");
    expect(
      readZip(zip)
        .entries.map((one) => one.path)
        .sort(),
    ).toEqual(["art/ball.svg", "src/pong.dmt"]);
  });

  it("is deterministic: the same project twice gives the same bytes", () => {
    // No wall clock anywhere in it — every entry takes the DOS epoch — so an
    // export is reproducible the way everything else the engine writes is.
    const entries = [{ path: "src/a.dmt", bytes: new Uint8Array([7, 7]) }];
    expect([...writeZip("p", entries)]).toEqual([...writeZip("p", entries)]);
  });

  it("does not depend on the order it was handed the files", () => {
    const a = [
      { path: "src/a.dmt", bytes: new Uint8Array([1]) },
      { path: "art/b.svg", bytes: new Uint8Array([2]) },
    ];
    expect([...writeZip("p", a)]).toEqual([...writeZip("p", [...a].reverse())]);
  });

  it("refuses something that is not a zip, rather than returning nothing", () => {
    expect(() => readZip(new Uint8Array([1, 2, 3, 4]))).toThrow(ZipError);
  });

  it("skips a path that climbs out of the archive", () => {
    // A zip is untrusted input: an entry named `../../etc/x` must not become a
    // file in the project, which is the one way a container can do harm.
    const zip = writeZip("p", [
      { path: "../escape.dmt", bytes: new Uint8Array([1]) },
      { path: "src/ok.dmt", bytes: new Uint8Array([2]) },
    ]);
    expect(readZip(zip).entries.map((one) => one.path)).toEqual(["src/ok.dmt"]);
  });
});

describe("a project through a zip", () => {
  it("is the same project, file for file and byte for byte", () => {
    const before = pongOnDisk();
    const after = importZip("pong.zip", exportZip(before));

    expect(after.name).toBe(before.name);
    expect(projectFiles(after)).toEqual(projectFiles(before));
    for (const path of projectFiles(before)) {
      expect([...(after.files.get(path)?.bytes ?? [])], path).toEqual([
        ...(before.files.get(path)?.bytes ?? []),
      ]);
    }
    // And the game is still the game.
    expect(readText(after, "src/pong.dmt")).toBe(readText(before, "src/pong.dmt"));
  });

  it("carries the folders the layout uses", () => {
    const after = importZip("pong.zip", exportZip(pongOnDisk()));
    const paths = projectFiles(after);
    for (const folder of ["src/", "art/", "music/", "sound/"]) {
      expect(
        paths.some((path) => path.startsWith(folder)),
        folder,
      ).toBe(true);
    }
  });

  it("leaves a build directory out, in both directions", () => {
    // `build/` is generated (doc 19 §`build/` is the CLI's), so it is neither
    // exported nor imported — a project that carried one would make a stale
    // artifact travel with the sources.
    let project = pongOnDisk();
    project = addFile(project, "build/gb/pong.gb", new Uint8Array([1, 2, 3]));
    const zip = exportZip(project);
    // Not in the archive at all, rather than filtered out on the way back in.
    expect(new TextDecoder().decode(zip)).not.toContain("build/gb");
    expect(readZip(zip).entries.some((one) => one.path.startsWith("build/"))).toBe(false);
    // And an archive somebody else built with one in it is still refused entry.
    const hostile = writeZip("pong", [{ path: "build/x.gb", bytes: new Uint8Array([9]) }]);
    expect(projectFiles(importZip("pong.zip", hostile))).toEqual([]);
  });
});
