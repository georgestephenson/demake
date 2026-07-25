/**
 * Reading `.dmtl` files for the terminal runners.
 *
 * The compiler is platform-pure and never touches a filesystem, so resolving
 * paths is the edge's job — here, in the CLI, and in the web worker alike. Each
 * of them asks `levelFiles()` which files a game refers to, so they cannot
 * disagree about, say, whether `stream` chunks count.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const { levelFiles } = await import("../dist/index.js");

/** Every `.dmtl` a game names, read relative to the game file itself. */
export function loadLevels(gamePath, source) {
  const base = dirname(gamePath);
  return Object.fromEntries(
    levelFiles(source).map((file) => [file, readFileSync(resolve(base, file), "utf8")]),
  );
}
