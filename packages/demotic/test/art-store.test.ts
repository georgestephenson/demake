/**
 * The conversion store hands back exactly what it was given, or nothing.
 *
 * This is the test that stands between a fifth of the suite's conversion time and
 * the hazard AGENTS.md §Gotchas names about a machine description: a cache that is
 * **wrong and consistent** passes everything else in the repository, because both
 * sides of every comparison would read it. So what is checked here is not that
 * caching is faster — it plainly is — but that a cartridge built from a store is
 * the cartridge built without one, byte for byte, and that the store refuses
 * rather than guesses when it cannot answer.
 *
 * The values are real conversions rather than fixtures shaped like them, because
 * what makes this delicate is their *type*: a `Backdrop` is typed arrays inside
 * plain objects, and the reason `node:v8` is used rather than JSON is that JSON
 * turns a `Uint8Array` into an object with numeric keys — a value that is not the
 * value, and a different cartridge.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setArtStore } from "../src/codegen/art.js";
import { buildGame } from "../src/codegen/registry.js";
import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";

import { diskArtStore } from "./_art-store.js";
import { exampleProject } from "./_projects.js";

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "demake-art-store-test-"));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
  // The suite's own store is installed by `setupFiles`; put it back, because
  // every other file in this worker is entitled to it.
  setArtStore(diskArtStore(process.env["DEMAKE_ART_CACHE"] ?? directory));
});

describe("the conversion store", () => {
  it("round-trips a typed-array value exactly, where JSON would not", () => {
    const store = diskArtStore(join(directory, "round-trip"));
    const value = {
      tiles: new Uint8Array([0, 1, 254, 255]),
      map: new Uint16Array([0, 65535]),
      palettes: [{ codes: [1, 2, 3] }],
      nested: { attr: new Uint8Array([7]) },
    };
    store.set("a-key", value);
    const back = store.get("a-key") as typeof value;
    expect(back).toEqual(value);
    // `toEqual` is not enough on its own: an object with numeric keys compares
    // equal to a typed array in some matchers, and it is not one.
    expect(back.tiles).toBeInstanceOf(Uint8Array);
    expect(back.map).toBeInstanceOf(Uint16Array);
    expect(back.nested.attr).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(JSON.stringify(value)).tiles).not.toBeInstanceOf(Uint8Array);
  });

  it("answers nothing for a key it has never been given", () => {
    const store = diskArtStore(join(directory, "missing"));
    expect(store.get("never-set")).toBeUndefined();
  });

  it("answers nothing rather than guessing when the file is unreadable", () => {
    const path = join(directory, "corrupt");
    const store = diskArtStore(path);
    store.set("a-key", { tiles: new Uint8Array([1, 2, 3]) });
    // Whatever the file is called, overwrite every one of them with rubbish.
    for (const name of readdirSync(path)) writeFileSync(join(path, name), "not a v8 buffer");
    expect(store.get("a-key")).toBeUndefined();
  });

  /**
   * The property the whole thing rests on, checked on the artifact.
   *
   * `pong` on the NES, because that console's pictures are converted one at a
   * time against a budget the ones before them left — so a store that returned a
   * picture fitted to the *wrong* budget would produce a different cartridge, and
   * this is where that would show.
   */
  it("builds the cartridge a cold build builds", async () => {
    const { source, files, levels, assets } = exampleProject("pong");
    const program = compile(source, { profile: getProfile("nes"), files, levels });

    // No store and a cold module cache is the reference. It is built first so
    // that nothing it produced can have come from the store under test.
    setArtStore(undefined);
    const reference = await buildGame(program, { title: "pong", assets });

    // Now a store of its own, filled by a build and then read by one. The module
    // caches are already warm, so what this proves is that the store's *values*
    // reconstruct a cartridge — which is what a second worker process does with
    // them.
    const store = diskArtStore(join(directory, "cartridge"));
    setArtStore(store);
    const written = await buildGame(program, { title: "pong", assets });
    expect(written.bytes).toEqual(reference.bytes);

    // And read back through a fresh store over the same directory, so the values
    // come off the disk rather than out of the one that wrote them.
    setArtStore(diskArtStore(join(directory, "cartridge")));
    const read = await buildGame(program, { title: "pong", assets });
    expect(read.bytes).toEqual(reference.bytes);
    expect(read.stats).toEqual(reference.stats);
  }, 240_000);
});
