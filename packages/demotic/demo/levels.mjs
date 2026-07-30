/**
 * Reading a project's files for the terminal runners.
 *
 * The compiler is platform-pure and never touches a filesystem, so finding files
 * is the edge's job — here, in the CLI, and in the web worker alike. What each of
 * them hands the compiler is the same two things: the project's **file list**, so
 * a bare `sprite ball` resolves to the file that is actually there (doc 19 §The
 * rule), and every `.dmtl` it holds, keyed by project-relative path.
 *
 * A game in `src/` means the project is the folder above it. That is the only
 * layout knowledge here, and it is a default rather than a rule: a `.dmt` sitting
 * on its own is its own project, exactly as it was before folders existed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** The project a game file belongs to: the folder above `src/`, else its own. */
export function projectRoot(gamePath) {
  const dir = dirname(resolve(gamePath));
  return dir.endsWith(`${sep}src`) ? dirname(dir) : dir;
}

/** Every file in the project, relative and `/`-separated, sorted. */
export function projectFiles(gamePath) {
  const root = projectRoot(gamePath);
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === "build" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(path);
      else out.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** Every `.dmtl` in the project, as text keyed by project-relative path. */
export function loadLevels(gamePath) {
  const root = projectRoot(gamePath);
  const levels = {};
  for (const file of projectFiles(gamePath)) {
    if (file.endsWith(".dmtl")) levels[file] = readFileSync(join(root, file), "utf8");
  }
  return levels;
}
