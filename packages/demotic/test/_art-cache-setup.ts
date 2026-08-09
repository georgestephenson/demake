/**
 * Own the conversion store's lifetime, and decide which engine it belongs to.
 *
 * `globalSetup` runs once per run in the main process, where `setupFiles` runs
 * once per worker — and both halves are needed: the digest has to be computed
 * once (it reads the whole engine) and the directory has to be removed once,
 * while the store itself has to be installed in every worker that demakes
 * anything. The digest reaches the workers through the environment, which forks
 * inherit.
 *
 * See `_art-store.ts` for why the key carries the engine's own source and why the
 * directory does not outlive the run.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Every source file that can change what a conversion produces. */
const ENGINE = ["packages/core/src", "packages/demotic/src"];

/** A digest of the engine's source, in a fixed order so two runs agree. */
function engineDigest(): string {
  const hash = createHash("sha256");
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".ts")) {
        hash.update(path.slice(ROOT.length));
        hash.update(readFileSync(path));
      }
    }
  };
  for (const directory of ENGINE) walk(join(ROOT, directory));
  return hash.digest("hex").slice(0, 16);
}

let directory: string | undefined;

export function setup(): void {
  // A run of its own, named for the engine that will fill it: a source change
  // cannot reach a previous run's answers, and nothing here is trusted later.
  directory = mkdtempSync(join(tmpdir(), `demake-art-${engineDigest()}-`));
  process.env["DEMAKE_ART_CACHE"] = directory;
}

export function teardown(): void {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
}
