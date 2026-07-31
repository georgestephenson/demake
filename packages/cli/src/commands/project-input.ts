/**
 * What a command was pointed at: a project folder, or one loose `.dmt`.
 *
 * Shared by `build` and `check` on purpose. Two commands that answered "what is
 * this folder?" differently would be two definitions of a project, and the folder
 * is meant to be the format (doc 19) — so the entry point, the Demakefile, the
 * level text and the asset bytes are all found here, once.
 */

import { dirname } from "node:path";

import {
  EMPTY_DEMAKEFILE,
  findEntry,
  formatDiagnostics,
  isIgnoredPath,
  isProject,
  levelFiles,
  parseDemakefile,
  resolveProject,
  type Demakefile,
  type Program,
  type ResolvedProject,
} from "@demake/demotic";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError, resolveInput } from "../io.js";

/**
 * What a build was pointed at: a project folder, or one loose `.dmt`.
 *
 * The folder is the format (doc 19), so `demake build ./pong` and
 * `demake build pong.dmt` are the same command reaching the same compiler —
 * they differ only in how much they can find. A project supplies a file list,
 * which is what lets `sprite ball` resolve to `art/ball.svg` and what makes an
 * ambiguous reference an error naming both candidates; a loose `.dmt` supplies
 * none, so every reference stands as written and nothing can be ambiguous. That
 * is not a degraded mode, it is the zero-config path (doc 15 §You do not need one).
 */
export interface Input {
  /** The `.dmt`, as the path a diagnostic should name. */
  path: string;
  source: string;
  /** The project root, when there is one. */
  root?: string;
  /** Every file in the project, relative to its root, sorted. */
  files: readonly string[];
  /** The project's Demakefile, parsed — empty when it has none (doc 15). */
  build: Demakefile;
  /** What the Demakefile and the folder between them decided. */
  plan: ResolvedProject;
}

/**
 * A path inside a project: the root, then a project-relative path.
 *
 * Joined with a slash rather than with the platform's separator, because a
 * project-relative path *is* `/`-separated — that is what `listFiles` promises
 * and what a `.dmt` reference is written with (doc 19 §The rule). Node's fs takes
 * forward slashes on Windows too, so one spelling reaches the filesystem, the
 * diagnostics and the `--json` report alike. Joining with `path.join` instead
 * spelled the same file two ways depending on the machine, which is how a suite
 * that passed everywhere else failed on Windows.
 */
export function at(root: string, path: string): string {
  const base = root.replace(/[/\\]+$/, "");
  return base === "" || base === "." ? path : `${base}/${path}`;
}

/**
 * Open whatever the positional named.
 *
 * A directory is a project. A file is a file. Nothing given at all is the
 * working directory *if it looks like a project* — checked with the engine's own
 * `isProject`, so the CLI and the page ask that question in one place — and
 * otherwise stdin, exactly as before.
 */
export function openInput(env: CliEnv, positionals: readonly string[]): Input {
  const named = positionals[0];
  const candidate = named === undefined || named === "-" ? "." : named;
  const listed = named === "-" ? null : env.listFiles(candidate);

  if (listed) {
    const files = listed.filter((path) => !isIgnoredPath(path));
    if (named === undefined && !isProject(files)) {
      // An empty `demake build` in a directory that is not a project falls
      // through to stdin rather than reporting a project error about a folder
      // nobody said was one.
      const { bytes, source } = resolveInput(env, [...positionals]);
      return {
        path: source,
        source: new TextDecoder().decode(bytes),
        files: [],
        build: EMPTY_DEMAKEFILE,
        plan: resolveProject(EMPTY_DEMAKEFILE, [], []),
      };
    }
    // The Demakefile, if the folder has one. Its diagnostics are errors here
    // rather than warnings: a build file nobody can read is a build nobody can
    // predict, and doc 15's whole point is that the plan is readable off it.
    const build = readDemakefile(env, candidate, files);
    const plan = resolveProject(build, files, []);
    const entry = plan.source ? { path: plan.source, candidates: [plan.source] } : findEntry(files);
    if (!entry.path) {
      throw new CliError(
        EXIT.NO_INPUT,
        "E_NO_SOURCE",
        entry.candidates.length === 0
          ? `no .dmt file in '${candidate}'`
          : `'${candidate}' holds ${String(entry.candidates.length)} games: ${entry.candidates.join(", ")}`,
        entry.candidates.length === 0
          ? "a project is a folder with a .dmt in it; see docs/19-projects.md."
          : "name the one to build: `demake build " + (entry.candidates[0] as string) + "`.",
      );
    }
    return {
      path: at(candidate, entry.path),
      source: new TextDecoder().decode(env.readFile(at(candidate, entry.path))),
      root: candidate,
      files,
      build,
      plan,
    };
  }

  const { bytes, source } = resolveInput(env, [...positionals]);
  return {
    path: source,
    source: new TextDecoder().decode(bytes),
    files: [],
    build: EMPTY_DEMAKEFILE,
    plan: resolveProject(EMPTY_DEMAKEFILE, [], []),
  };
}

/**
 * Read and parse the project's Demakefile, if it has one.
 *
 * Its own diagnostics stop the build. Everything else about it — the option
 * cascade, the targets, the header fields — is resolved by `@demake/demotic`, so
 * this function's whole job is finding the bytes (doc 02 §platform purity).
 */
export function readDemakefile(env: CliEnv, root: string, files: readonly string[]): Demakefile {
  const named = files.find((path) => path === "Demakefile" || path === "demakefile");
  if (named === undefined) return EMPTY_DEMAKEFILE;
  const text = new TextDecoder().decode(env.readFile(at(root, named)));
  const parsed = parseDemakefile(text);
  const errors = parsed.diagnostics.filter((one) => one.severity === "error");
  if (errors.length > 0) {
    throw new CliError(
      EXIT.BAD_INPUT,
      "E_BAD_DEMAKEFILE",
      `${named} has ${String(errors.length)} problem${errors.length === 1 ? "" : "s"}`,
      formatDiagnostics(errors),
    );
  }
  return parsed;
}

/**
 * Load the `.dmtl` files a source references.
 *
 * Reading them here rather than in `@demake/demotic` is the platform-purity
 * rule (doc 02): the compiler takes level *text*, and finding the text is the
 * edge's job. In a project every level goes in, keyed by its own path, because
 * the compiler resolves a reference to a path and looks it up by that; outside
 * one, `levelFiles` says which names to look for beside the source.
 */
export function loadLevels(env: CliEnv, input: Input): Record<string, string> {
  const levels: Record<string, string> = {};
  if (input.path === "<stdin>") return levels;
  if (input.root !== undefined) {
    for (const file of input.files) {
      if (!file.endsWith(".dmtl")) continue;
      try {
        levels[file] = new TextDecoder().decode(env.readFile(at(input.root, file)));
      } catch {
        // Listed but unreadable; the compiler reports the level it wanted.
      }
    }
    return levels;
  }
  const root = dirname(input.path);
  for (const file of levelFiles(input.source)) {
    try {
      levels[file] = new TextDecoder().decode(env.readFile(at(root, file)));
    } catch {
      // A missing level is the compiler's diagnostic to report, with the line
      // number and the name — better than a file-not-found from here.
    }
  }
  return levels;
}

/**
 * Load the assets a program names.
 *
 * Art, music and sound effects all arrive the same way, because the build
 * converts all three itself: the edge's only job is to find bytes for a name.
 *
 * Missing assets are not an error here: the build reports them and falls back —
 * to the built-in block for art, to silence for audio — which is a far better
 * outcome than refusing to produce a playable cartridge because one sprite was
 * renamed. What must never happen is a *different* fallback in the browser,
 * which is why both edges hand the same bytes to the same converters and
 * neither converts anything itself.
 */
export function loadAssets(env: CliEnv, program: Program, input: Input): Map<string, Uint8Array> {
  const assets = new Map<string, Uint8Array>();
  if (input.path === "<stdin>") return assets;
  // In a project the names are already resolved paths, relative to its root; for
  // a loose `.dmt` they are whatever the source wrote, found beside it.
  const root = input.root ?? dirname(input.path);
  // `program.assets` rather than the art *requests*, because a request is per
  // box and backdrops make none — loading only what `artRequests` names is how
  // the CLI came to build cartridges with no title screen while the page built
  // them with one, which is exactly the divergence this file exists to prevent.
  const names = [...program.assets, ...program.tracks, ...program.sounds];
  for (const name of names) {
    try {
      assets.set(name, env.readFile(at(root, name)));
    } catch {
      // Reported by the build, with every missing name at once.
    }
  }
  return assets;
}
