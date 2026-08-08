/**
 * Managing files in a project (doc 19 §A file manager, after all).
 *
 * These are the operations the explorer offers, tested where they live rather
 * than through the browser: they are pure functions over an immutable map, and
 * the two that matter are the two that cannot be undone — a move that lands on
 * something, and a path that climbs out of the project.
 *
 * `route.ts`'s half is here too, because "which editor opens this path" is the
 * one question the explorer, the router and the lazy-import switch all ask, and
 * a wrong answer is a file that looks unopenable in the tree.
 */

import { describe, expect, it } from "vitest";

import {
  addFile,
  filesIn,
  folders,
  mediaTypeOf,
  moveFile,
  normalisePath,
  projectFiles,
  readText,
  removeFile,
  writeText,
  type Project,
} from "../src/lib/project.js";
import {
  fileHash,
  isBareHash,
  isTextFile,
  readRoute,
  readSection,
  sectionForFile,
  sectionHash,
  SECTIONS,
} from "../src/lib/route.js";
import { filterPaths, subsequence } from "../src/components/QuickOpen.js";
import { saveToFolder } from "../src/lib/disk.js";
import { fillBinaries } from "../src/lib/examples.js";

const encoder = new TextEncoder();

function project(...entries: [string, string][]): Project {
  let made: Project = { name: "demo", files: new Map() };
  for (const [path, text] of entries) made = addFile(made, path, encoder.encode(text));
  return made;
}

const PONG = project(
  ["src/pong.dmt", "start title\n"],
  ["art/ball.svg", "<svg/>"],
  ["music/rally.mid", "MThd"],
  ["Demakefile", "project pong\n"],
);

describe("moving a file", () => {
  it("is also how one is renamed", () => {
    const moved = moveFile(PONG, "art/ball.svg", "art/sphere.svg");
    expect(projectFiles(moved)).toContain("art/sphere.svg");
    expect(projectFiles(moved)).not.toContain("art/ball.svg");
    expect(readText(moved, "art/sphere.svg")).toBe("<svg/>");
  });

  it("moves between folders, because a folder is a prefix", () => {
    // The whole reason there is one operation rather than two: a project is a
    // flat map and `art/` is part of a name (doc 19 §The layout).
    const moved = moveFile(PONG, "art/ball.svg", "sprites/ball.svg");
    expect(folders(moved)).toContain("sprites");
    expect(folders(moved)).not.toContain("art");
    expect(filesIn(moved, "sprites")).toEqual(["sprites/ball.svg"]);
  });

  it("refuses to land on something, rather than replacing it", () => {
    const crowded = addFile(PONG, "art/paddle.svg", encoder.encode("<svg id=paddle/>"));
    const attempt = moveFile(crowded, "art/ball.svg", "art/paddle.svg");
    expect(attempt).toBe(crowded);
    expect(readText(attempt, "art/paddle.svg")).toBe("<svg id=paddle/>");
  });

  it("leaves the project alone when there is nothing to move", () => {
    expect(moveFile(PONG, "art/nothing.svg", "art/something.svg")).toBe(PONG);
    expect(moveFile(PONG, "art/ball.svg", "art/ball.svg")).toBe(PONG);
    expect(moveFile(PONG, "art/ball.svg", "")).toBe(PONG);
  });

  it("keeps the entry's own idea of its path in step with the map's key", () => {
    // Three things read `ProjectFile.path` back; a move that updated only the
    // key would hand them the old name.
    const moved = moveFile(PONG, "art/ball.svg", "art/sphere.svg");
    expect(moved.files.get("art/sphere.svg")?.path).toBe("art/sphere.svg");
  });
});

describe("removing a file", () => {
  it("takes it out of the project and leaves the rest", () => {
    const gone = removeFile(PONG, "music/rally.mid");
    expect(projectFiles(gone)).toEqual(["Demakefile", "art/ball.svg", "src/pong.dmt"]);
    expect(folders(gone)).not.toContain("music");
  });

  it("is a no-op for a path that is not there", () => {
    expect(removeFile(PONG, "nope")).toBe(PONG);
  });
});

describe("normalising a typed path", () => {
  it("tidies what a person types", () => {
    expect(normalisePath("  art/ball.svg  ")).toBe("art/ball.svg");
    expect(normalisePath("/art//ball.svg")).toBe("art/ball.svg");
    expect(normalisePath("art\\ball.svg")).toBe("art/ball.svg");
    expect(normalisePath("./art/./ball.svg")).toBe("art/ball.svg");
  });

  it("refuses a path that climbs out of the project", () => {
    // A project is a folder, so a path outside it is not a path in it. The same
    // call `importZip` makes about an archive entry — resolving it would be the
    // one that surprises somebody.
    expect(normalisePath("../secrets")).toBeUndefined();
    expect(normalisePath("art/../../secrets")).toBeUndefined();
    expect(normalisePath("   ")).toBeUndefined();
    expect(normalisePath("/")).toBeUndefined();
  });
});

describe("which editor opens a path", () => {
  it("routes each demaker's own kinds", () => {
    expect(sectionForFile("src/pong.dmt")).toBe("game");
    expect(sectionForFile("art/ball.svg")).toBe("art");
    expect(sectionForFile("art/title.png")).toBe("art");
    expect(sectionForFile("music/rally.mid")).toBe("music");
    expect(sectionForFile("sound/bounce.wav")).toBe("sound");
    expect(sectionForFile("levels/cavern.dmtl")).toBe("level");
  });

  it("gives the text editor the project's other files", () => {
    // Doc 19 promises the Demakefile is "also just a file in the explorer",
    // which was not true while nothing opened one.
    expect(sectionForFile("Demakefile")).toBe("text");
    expect(sectionForFile("README.md")).toBe("text");
    expect(sectionForFile("pong.gb.trace")).toBe("text");
    expect(sectionForFile(".gitignore")).toBe("text");
    expect(sectionForFile("LICENSE")).toBe("text");
  });

  it("opens nothing for a binary it has no editor for", () => {
    // Listed in the tree, greyed out — a file you cannot see is one you think
    // you lost — but a `.gb` in a textarea is a corrupted `.gb`.
    expect(sectionForFile("build/pong.gb")).toBeUndefined();
    expect(sectionForFile("cover.mp3")).toBeUndefined();
    expect(isTextFile("build/pong.gb")).toBe(false);
  });
});

describe("the hash", () => {
  it("calls only an empty one bare", () => {
    // This is what decides where a cold visit lands. An option permalink names
    // neither a file nor a section and must *not* count as bare, or a shared
    // art link would open the project's game instead.
    expect(isBareHash("")).toBe(true);
    expect(isBareHash("#")).toBe(true);
    expect(isBareHash("#console=snes&dither=bayer4")).toBe(false);
    expect(isBareHash("#file=src%2Fpong.dmt")).toBe(false);
    expect(isBareHash("#section=art")).toBe(false);
  });

  it("reads a file out of it, and the editor from the file's own extension", () => {
    // The route names a *file* and the section is derived, which is the one
    // thing that stops the two disagreeing about what is on screen.
    expect(readRoute("#file=src%2Fpong.dmt")).toEqual({ section: "game", file: "src/pong.dmt" });
    expect(readRoute("#file=src%2Fpong.test.dmt")).toEqual({
      section: "tests",
      file: "src/pong.test.dmt",
    });
    expect(readRoute("#file=art%2Fball.svg")).toEqual({ section: "art", file: "art/ball.svg" });
  });

  it("ignores a file it has no editor for rather than opening an empty pane", () => {
    // A built cartridge is in the project and nothing edits it. Naming one is a
    // link to nowhere, so it falls through to the section rules instead.
    expect(readRoute("#file=build%2Fpong.gb")).toEqual({ section: "art" });
    expect(readRoute("#file=")).toEqual({ section: "art" });
  });

  it("still reads a bare section, because every old permalink carries one", () => {
    for (const section of SECTIONS) {
      expect(readRoute(sectionHash(section))).toEqual({ section });
      expect(readSection(sectionHash(section))).toBe(section);
    }
    // Anything it does not recognise lands on the art demaker, which is what an
    // option permalink — naming neither a file nor a section — has to do.
    expect(readRoute("#section=nonsense")).toEqual({ section: "art" });
    expect(readRoute("#console=snes&dither=bayer4")).toEqual({ section: "art" });
    expect(readRoute("")).toEqual({ section: "art" });
  });

  it("prefers the file when a hash carries both", () => {
    // The file is the better answer for "what is on screen", which is why the
    // section tabs went (doc 07 §The workbench).
    expect(readRoute("#section=music&file=src%2Fpong.dmt")).toEqual({
      section: "game",
      file: "src/pong.dmt",
    });
  });

  it("writes a hash that reads back as the thing it names", () => {
    // The round trip is the property: a path with a slash, a space or a `#` in
    // it has to survive being put in a URL and taken out again.
    for (const path of ["src/pong.dmt", "art/a b.svg", "levels/#odd.dmtl", "src/pong.test.dmt"]) {
      expect(readRoute(fileHash(path)).file).toBe(path);
    }
    expect(fileHash("src/pong.dmt")).toBe("#file=src%2Fpong.dmt");
  });

  it("never writes a bare `#` for a section", () => {
    // It used to, for the default one — and "no hash" now means "open the
    // project", so a section with no file has to say which one it is.
    for (const section of SECTIONS) {
      expect(isBareHash(sectionHash(section))).toBe(false);
    }
  });
});

describe("go to file", () => {
  it("matches a subsequence of the path, which is what every editor does", () => {
    expect(subsequence("pbs", "art/pong.breakout.svg")).toBe(true);
    expect(subsequence("zzz", "art/ball.svg")).toBe(false);
    expect(subsequence("", "anything")).toBe(true);
  });

  it("keeps the list's own order rather than ranking", () => {
    // The same query always offers the same first answer; a scoring function
    // nobody can predict is worse than an order everybody can.
    const paths = projectFiles(PONG);
    expect(filterPaths(paths, "")).toEqual(paths);
    expect(filterPaths(paths, "SRC")).toEqual(["src/pong.dmt"]);
    expect(filterPaths(paths, "ball")).toEqual(["art/ball.svg"]);
  });
});

describe("blob media types", () => {
  it("names the ones something points a browser at", () => {
    // The bug this table exists for: a typeless blob is a broken `<img>`,
    // because a browser believes the type and does not sniff for SVG.
    expect(mediaTypeOf("art/ball.svg")).toBe("image/svg+xml");
    expect(mediaTypeOf("art/TITLE.PNG")).toBe("image/png");
    expect(mediaTypeOf("music/rally.mid")).toBeUndefined();
  });
});

/**
 * Saving to a real folder, over a fake File System Access API.
 *
 * Here because the explorer's delete and its move are only half-real without it:
 * a save that only ever *wrote* would leave a renamed file behind under both
 * names, and the next build would resolve `sprite ball` to two files and refuse.
 */
describe("saving to a folder", () => {
  /** The smallest fake directory tree the saver actually uses. */
  function fakeFolder(initial: Record<string, string>) {
    const disk = new Map(Object.entries(initial));
    const handleFor = (prefix: string): unknown => ({
      name: prefix === "" ? "demo" : prefix.slice(0, -1),
      async *values() {
        const seen = new Set<string>();
        for (const path of disk.keys()) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash < 0) {
            yield {
              kind: "file",
              name: rest,
              getFile: () => Promise.resolve({ arrayBuffer: () => new ArrayBuffer(0) }),
            };
          } else if (!seen.has(rest.slice(0, slash))) {
            seen.add(rest.slice(0, slash));
            yield {
              kind: "directory",
              ...(handleFor(`${prefix}${rest.slice(0, slash)}/`) as object),
            };
          }
        }
      },
      getDirectoryHandle: (name: string) => Promise.resolve(handleFor(`${prefix}${name}/`)),
      getFileHandle: (name: string) =>
        Promise.resolve({
          kind: "file",
          name,
          getFile: () => Promise.resolve({ arrayBuffer: () => new ArrayBuffer(0) }),
          createWritable: () =>
            Promise.resolve({
              write: () => {
                disk.set(`${prefix}${name}`, "written");
                return Promise.resolve();
              },
              close: () => Promise.resolve(),
            }),
        }),
      removeEntry: (name: string) => {
        disk.delete(`${prefix}${name}`);
        return Promise.resolve();
      },
    });
    return { disk, handle: handleFor("") };
  }

  it("removes what the project no longer has, so a move is a move", async () => {
    const { disk, handle } = fakeFolder({
      "src/pong.dmt": "a",
      "art/ball.svg": "b",
      "art/old.svg": "c",
    });
    await saveToFolder(handle, project(["src/pong.dmt", "a"], ["art/sphere.svg", "b"]));
    expect([...disk.keys()].sort()).toEqual(["art/sphere.svg", "src/pong.dmt"]);
  });

  it("never touches what it would not have read", async () => {
    // `build/` and the dot-directories are the CLI's (doc 19), skipped on the
    // way in — so they must be skipped on the way out rather than deleted for
    // being absent from a project that was never shown them.
    const { disk, handle } = fakeFolder({
      "src/pong.dmt": "a",
      "build/pong.gb": "rom",
      ".git/HEAD": "ref",
    });
    await saveToFolder(handle, project(["src/pong.dmt", "a"]));
    expect([...disk.keys()].sort()).toEqual([".git/HEAD", "build/pong.gb", "src/pong.dmt"]);
  });
});

/**
 * Filling an example's art in after the project is already open.
 *
 * Here because the failure it guards against is a *race*, and a race is the one
 * thing a browser test cannot be trusted to catch: the fetch lands in about a
 * hundred milliseconds on a developer's machine and rather later on a loaded CI
 * runner, so the bug passed four browser runs and then ate a file on the fifth.
 * What went wrong was a whole-project swap — the arriving bytes came wrapped in
 * a freshly built skeleton, and assigning it discarded everything done in the
 * meantime.
 */
describe("filling in an example's binaries", () => {
  const BINARIES = new Map([
    ["art/ball.svg", encoder.encode("<svg>real</svg>")],
    ["music/rally.mid", encoder.encode("MThd-real")],
  ]);

  /** A project as it opens: text present, every binary an empty placeholder. */
  const opened = project(
    ["src/pong.dmt", "start title\n"],
    ["art/ball.svg", ""],
    ["music/rally.mid", ""],
  );

  it("fills the placeholders", () => {
    const filled = fillBinaries(opened, BINARIES);
    expect(readText(filled, "art/ball.svg")).toBe("<svg>real</svg>");
    expect(readText(filled, "music/rally.mid")).toBe("MThd-real");
  });

  it("keeps a file created while the fetch was in flight", () => {
    const busy = addFile(opened, "notes/todo.md", encoder.encode("remember the milk"));
    const filled = fillBinaries(busy, BINARIES);
    expect(readText(filled, "notes/todo.md")).toBe("remember the milk");
    expect(readText(filled, "art/ball.svg")).toBe("<svg>real</svg>");
  });

  it("keeps a rename, and does not resurrect the old name", () => {
    const busy = moveFile(opened, "art/ball.svg", "art/sphere.svg");
    const filled = fillBinaries(busy, BINARIES);
    expect(projectFiles(filled)).toContain("art/sphere.svg");
    expect(projectFiles(filled)).not.toContain("art/ball.svg");
  });

  it("keeps a deletion deleted", () => {
    const busy = removeFile(opened, "music/rally.mid");
    expect(projectFiles(fillBinaries(busy, BINARIES))).not.toContain("music/rally.mid");
  });

  it("never overwrites bytes somebody put there", () => {
    // A dropped-in replacement is not a placeholder, and the fetch must not win
    // a race against a deliberate act.
    const busy = addFile(opened, "art/ball.svg", encoder.encode("<svg>mine</svg>"));
    expect(readText(fillBinaries(busy, BINARIES), "art/ball.svg")).toBe("<svg>mine</svg>");
  });

  it("leaves a text edit alone", () => {
    const busy = writeText(opened, "src/pong.dmt", "start play\n");
    expect(readText(fillBinaries(busy, BINARIES), "src/pong.dmt")).toBe("start play\n");
  });
});
