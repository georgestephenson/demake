/**
 * Which file in a project is the game (doc 19 §The Demakefile, still optional).
 *
 * The pure half of `demake build <dir>`: an edge walks a directory its own way —
 * `node:fs` on one side, a `FileSystemDirectoryHandle` or an unzipped tree on the
 * other — and hands the paths here. Nothing in this file touches a filesystem, so
 * the CLI and the page cannot disagree about what a folder's entry point is.
 *
 * `src/` first, then the project root, because that is the order the canonical
 * layout implies and the order that keeps a flat folder working: a directory
 * holding `pong.dmt` and `ball.svg` side by side is a project too.
 */

/** Files a project holds that are sources rather than assets. */
const SOURCE = /\.dmt$/i;
const SUITE = /\.test\.dmt$/i;

/** What a project's entry point turned out to be. */
export interface EntryPoint {
  /** The game's source, when exactly one candidate was found. */
  path?: string;
  /**
   * Every `.dmt` that could have been it, in the order searched.
   *
   * Empty means the folder holds no game; more than one means the choice is the
   * Demakefile's `source` directive to make, and until there is one the build
   * says so rather than picking (`E_NO_SOURCE`).
   */
  candidates: readonly string[];
}

/** Whether a path is a `.test.dmt` suite rather than a game. */
export function isSuite(path: string): boolean {
  return SUITE.test(path);
}

/**
 * The `.dmt` a project builds, or the candidates when that is not one file.
 *
 * Test suites are never candidates: a `.test.dmt` is a program *about* a game and
 * builds to nothing, so a folder holding `pong.dmt` and `pong.test.dmt` has one
 * entry point rather than an ambiguity. That is also why the suite for a game is
 * found beside it rather than declared.
 */
export function findEntry(files: readonly string[]): EntryPoint {
  const games = [...files].sort().filter((path) => SOURCE.test(path) && !isSuite(path));
  const inSrc = games.filter((path) => path.startsWith("src/"));
  const atRoot = games.filter((path) => !path.includes("/"));
  const found = inSrc.length > 0 ? inSrc : atRoot.length > 0 ? atRoot : games;
  return found.length === 1
    ? { path: found[0] as string, candidates: found }
    : { candidates: found };
}

/**
 * The `.test.dmt` beside a game, if the project has one.
 *
 * By name rather than by directory listing order, because that is the convention
 * the example library uses and the one `demake test` will look for.
 */
export function suiteFor(entry: string, files: readonly string[]): string | undefined {
  const wanted = entry.replace(SOURCE, ".test.dmt");
  return files.includes(wanted) ? wanted : undefined;
}

/**
 * The game a suite is about — `suiteFor` read the other way.
 *
 * By name first, because that is the convention the example library uses and the
 * one `demake test` looks for. Where the names do not pair up, the project's own
 * entry point is the answer: a suite is a program *about* a game, a project has
 * one game, and a folder whose suite is called something else is still testing
 * it. Both halves are here so an editor opening a `.test.dmt` and a CLI running
 * one cannot disagree about what it is asserting against.
 */
export function gameFor(suite: string, files: readonly string[]): string | undefined {
  if (!isSuite(suite)) return undefined;
  const wanted = suite.replace(SUITE, ".dmt");
  return files.includes(wanted) ? wanted : findEntry(files).path;
}

/**
 * Whether a set of paths looks like a project at all.
 *
 * One question, asked in one place, so `demake build` with no argument and the
 * page's folder picker agree about what they are looking at. A directory with no
 * `.dmt` anywhere in it is not a project, and saying so beats compiling nothing.
 */
export function isProject(files: readonly string[]): boolean {
  return files.some((path) => SOURCE.test(path) && !isSuite(path));
}

/**
 * Paths a project's own tooling writes, which are never inputs.
 *
 * `build/` is the Demakefile's `out` default and holds generated artifacts, so
 * walking it would let a previous build's output become the next one's input
 * (doc 19 §`build/` is the CLI's). Dot-directories go for the ordinary reason.
 */
export function isIgnoredPath(path: string): boolean {
  return (
    path === "build" || path.startsWith("build/") || path.split("/").some((p) => p.startsWith("."))
  );
}
