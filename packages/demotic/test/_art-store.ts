/**
 * A conversion store on disk, so one worker's demake is not every worker's.
 *
 * A test file is the unit Vitest schedules, so the suite is twenty-odd
 * processes, and each of them starts with an empty conversion cache — a picture
 * demade in `audio-nes.test.ts` is demade again in `nes-rom.test.ts` and again in
 * `parallel-nes.test.ts`. Measured over seven of those files that was 52 of 246
 * seconds of conversion time spent re-deciding something another process had
 * already decided. Art is most of what this suite costs (doc 11 §the unit
 * suite), so this is most of the duplication in it.
 *
 * Installed by `setupFiles` in every worker and by nothing in production: the
 * CLI and the page each rebuild inside a process that is already warm, and the
 * `ArtStore` seam exists so that this file — which has a disk — is the only place
 * `node:fs` appears (`@demake/demotic` keeps none, exactly as `core` does).
 *
 * ## Why this cannot be wrong quietly
 *
 * The hazard is the one AGENTS.md §Gotchas states about a machine description: a
 * cache that is **wrong and consistent** passes everything, because both sides of
 * a comparison read it. Three things answer that, and none of them is a
 * convention somebody has to remember.
 *
 *   - **The key carries the engine that produced the value.** `DEMAKE_ART_CACHE`
 *     is a digest of every source file under `packages/core/src` and
 *     `packages/demotic/src`, computed once per run by `globalSetup` — so a change
 *     to a fitter, a console spec or an art module is a different cache, and a
 *     stale entry is unreachable rather than merely unlikely. There is no version
 *     number for anyone to forget to bump.
 *   - **It is scoped to one run.** The directory is named for that digest and the
 *     run's own start, and it is removed when the run ends, so nothing persists
 *     to be trusted later. What it saves is duplication *within* a run, which is
 *     where the duplication is.
 *   - **A value round-trips exactly or not at all.** `v8.serialize` is used
 *     rather than JSON because these values are typed arrays: JSON would turn a
 *     `Uint8Array` into an object with numeric keys, which is not the same value
 *     and would be a different cartridge. `art-store.test.ts` is what says the
 *     round trip is exact, on a real conversion rather than on a fixture of one.
 *
 * A store that fails — no directory, a half-written file, a value it cannot read
 * — answers `undefined` and the conversion happens. It is a speed optimisation
 * over a pure function, never a correctness one.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";

import { setArtStore, type ArtStore } from "../src/codegen/art.js";

/** The run's cache directory, or nothing — set by `globalSetup`. */
const DIRECTORY = process.env["DEMAKE_ART_CACHE"];

/** A file name for a key: the key is not one, and two keys must never collide. */
function fileFor(key: string): string {
  // FNV-1a is not enough on its own — a collision would serve one picture's
  // pixels for another — so the key is stored beside the value and checked.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}-${key.length}.v8`;
}

/** A store over one directory. Exported for `art-store.test.ts`. */
export function diskArtStore(directory: string): ArtStore {
  mkdirSync(directory, { recursive: true });
  return {
    get(key) {
      try {
        const held = deserialize(readFileSync(join(directory, fileFor(key)))) as {
          key: string;
          value: unknown;
        };
        // The key itself, not just its digest: a hash collision would otherwise
        // hand back a different picture, which is the one way this could be
        // wrong and consistent at the same time.
        return held.key === key ? held.value : undefined;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        // Written beside and renamed into place: workers share this directory, so
        // a reader must never meet a half-written file.
        const target = join(directory, fileFor(key));
        const temporary = `${target}.${process.pid}.tmp`;
        writeFileSync(temporary, serialize({ key, value }));
        renameSync(temporary, target);
      } catch {
        // A store that cannot store is a store that does nothing.
      }
    },
  };
}

if (DIRECTORY !== undefined && DIRECTORY !== "") setArtStore(diskArtStore(DIRECTORY));
