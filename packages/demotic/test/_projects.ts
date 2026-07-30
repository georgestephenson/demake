/**
 * Reading an example project off disk (doc 19).
 *
 * The example library is a project folder per game — `src/`, `art/`, `music/`,
 * `sound/` and, where a game has them, `levels/` — and this is the one place a
 * test says how to walk one. Before the folders existed every reader built its
 * own `join(fixtures, name)`, which is exactly the drift the layout exists to
 * remove: a game's assets were found by sitting in the same directory as
 * somebody else's.
 *
 * What it hands back is what the compiler and the ROM builders want: a file list
 * for resolution (names only), asset bytes keyed by project-relative path, and
 * level text keyed the same way. That is deliberately the same shape the CLI's
 * `build <dir>` and the web app's project tree produce, because a fixture reader
 * that found files differently from the tools would be testing itself.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Where the example projects live. */
export const PROJECTS = join(import.meta.dirname, "..", "fixtures", "projects");

/** The example library, in the order the page lists it. Pong is first. */
export const EXAMPLES = [
  "pong",
  "breakout",
  "platformer",
  "dodger",
  "shooter",
  "caves",
  "runner",
  "quest",
] as const;

/** One example's name. */
export type Example = (typeof EXAMPLES)[number];

/** A project's root directory. */
export function projectRoot(name: string): string {
  return join(PROJECTS, name);
}

/**
 * Every file in a project, as relative paths with `/` separators, sorted.
 *
 * Sorted because resolution must not depend on readdir order (doc 19 §What does
 * not change), and `/` because a reference is written with forward slashes on
 * every platform.
 */
export function projectFiles(name: string): readonly string[] {
  const root = projectRoot(name);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** One file's text, by project-relative path. */
export function projectText(name: string, path: string): string {
  return readFileSync(join(projectRoot(name), path), "utf8");
}

/** One file's bytes, by project-relative path. */
export function projectBytes(name: string, path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(projectRoot(name), path)));
}

/** A game's source: `src/<name>.dmt`. */
export function gameSource(name: string): string {
  return projectText(name, `src/${name}.dmt`);
}

/** A game's test suite: `src/<name>.test.dmt`. */
export function gameTests(name: string): string {
  return projectText(name, `src/${name}.test.dmt`);
}

/**
 * Every asset in a project, as the source bytes a build takes, keyed by path.
 *
 * All of them rather than the ones a program names: an unused entry is never
 * asked for, and deciding which are needed is the compiler's job rather than a
 * test's.
 */
export function projectAssets(name: string): Map<string, Uint8Array> {
  const assets = new Map<string, Uint8Array>();
  for (const path of projectFiles(name)) {
    if (path.endsWith(".dmt") || path.endsWith(".trace")) continue;
    assets.set(path, projectBytes(name, path));
  }
  return assets;
}

/** Every `.dmtl` in a project, as text keyed by project-relative path. */
export function projectLevels(name: string): Record<string, string> {
  const levels: Record<string, string> = {};
  for (const path of projectFiles(name)) {
    if (path.endsWith(".dmtl")) levels[path] = projectText(name, path);
  }
  return levels;
}

/** Everything the compiler needs for one example: its source, levels and file list. */
export function exampleProject(name: string): {
  source: string;
  files: readonly string[];
  levels: Record<string, string>;
  assets: Map<string, Uint8Array>;
} {
  return {
    source: gameSource(name),
    files: projectFiles(name),
    levels: projectLevels(name),
    assets: projectAssets(name),
  };
}
