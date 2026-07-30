/**
 * `demake init` — scaffold a project, and write the Demakefile that changes nothing.
 *
 * Doc 15's framing is the whole design: "`demake init` writes the Demakefile that
 * reproduces exactly what the defaults already do — so the zero-config path and
 * the file are the same object, one of them just implicit." A file that read
 * differently from the defaults it replaced would make `init` a decision rather
 * than a starting point.
 *
 * So what it emits goes through the Demakefile *emitter* rather than being
 * assembled as text: the emitter is the one thing that knows the canonical
 * spelling, and the round-trip properties in `demakefile.test.ts` already say it
 * is faithful. Parsing what `init` writes gives back the defaults it started
 * from, which is the property that makes the file and the zero-config path the
 * same object.
 */

import { join } from "node:path";

import {
  emitDemakefile,
  EMPTY_DEMAKEFILE,
  findEntry,
  hasRuntime,
  isIgnoredPath,
  profiles,
  type Demakefile,
} from "@demake/demotic";
import type { ParsedValue } from "@demake/cli-spec";

import type { CliEnv } from "../env.js";
import { EXIT, type ExitCode } from "../exit-codes.js";
import { CliError } from "../io.js";

/** The folders a project keeps its sources in, in the order the docs list them. */
const FOLDERS = ["src", "art", "music", "sound", "levels"] as const;

/**
 * What `build/` is, said in the one file git reads.
 *
 * Written because `out` defaults there and the directory is generated: a project
 * that committed its cartridges would carry a stale one to whoever cloned it
 * (doc 19 §`build/` is the CLI's).
 */
const GITIGNORE = "# Artifacts `demake build` writes.\nbuild/\n";

/** The Demakefile that reproduces the defaults for this project. */
function scaffold(name: string, entry: string | undefined, consoles: readonly string[]): string {
  // Built as a model and emitted, rather than assembled as text: the emitter is
  // the one thing that knows the canonical spelling, and a second writer here
  // would be a second answer (doc 15 §The equivalence contract).
  const file: Demakefile = {
    ...EMPTY_DEMAKEFILE,
    project: {
      name,
      fields: [{ name: "title", value: name, line: 0 }],
      leading: [
        "# Demakefile — how this game reaches real hardware.",
        `# The game itself is in ${entry ?? "src/"} and knows none of this.`,
      ],
      line: 0,
    },
    ...(entry === undefined ? {} : { source: { name: "source", value: entry, line: 0 } }),
    out: { name: "out", value: "build", line: 0 },
    targets: consoles.map((consoleId) => ({
      name: consoleId,
      outputs: [],
      header: [],
      options: [],
      shorthand: true,
      line: 0,
    })),
  };
  return emitDemakefile(file);
}

export function runInit(
  env: CliEnv,
  values: Record<string, ParsedValue>,
  positionals: readonly string[],
): ExitCode {
  const json = values.json === true;
  const force = values.force === true;
  const root = positionals[0] ?? ".";

  const listed = env.listFiles(root) ?? [];
  const files = listed.filter((path) => !isIgnoredPath(path));

  const existing = files.find((path) => path === "Demakefile" || path === "demakefile");
  if (existing !== undefined && !force) {
    throw new CliError(
      EXIT.CANNOT_CREATE,
      "E_EXISTS",
      `${join(root, existing)} already exists`,
      "pass --force to replace it, or edit it directly — it is a text file.",
    );
  }

  // The entry point, if the folder already holds a game. `init` in an empty
  // directory is scaffolding a project that has none yet, which is fine: the
  // Demakefile it writes simply has no `source` line, and the folder decides
  // once a `.dmt` lands in `src/`.
  const entry = findEntry(files).path;
  const consoles = profiles.filter((one) => hasRuntime(one.id)).map((one) => one.id);
  // The project's name is the *entry file's stem*, not the directory's — because
  // that is what `resolveProject` defaults to, and a name that differed would
  // change the cartridge title. `init` writes the file that reproduces the
  // defaults (doc 15 §You do not need one); a file that renamed the game would
  // make it a decision instead, and this is exactly the way that went wrong the
  // first time it was run against a real folder.
  const named =
    entry !== undefined
      ? (entry.replace(/^.*\//, "").replace(/\.dmt$/i, "") as string)
      : root === "."
        ? "game"
        : (root
            .replace(/[/\\]+$/, "")
            .split(/[/\\]/)
            .pop() as string);
  const text = scaffold(named, entry, consoles);

  const written: string[] = [];
  const encoder = new TextEncoder();

  env.writeFileAtomic(join(root, "Demakefile"), encoder.encode(text), true);
  written.push("Demakefile");

  if (!files.includes(".gitignore")) {
    env.writeFileAtomic(join(root, ".gitignore"), encoder.encode(GITIGNORE), true);
    written.push(".gitignore");
  }

  // Only the folders a project has something to put in, plus `src/` — a tree of
  // four empty directories teaches nothing about the project (doc 19 §The
  // layout), and a `.gitkeep` in each would be four files nobody wanted. So the
  // existing folders are left alone and the missing ones are simply named.
  const present = new Set(files.map((path) => path.split("/")[0]));
  const missing = FOLDERS.filter((folder) => !present.has(folder));

  if (json) {
    env.out(
      `${JSON.stringify(
        { directory: root, written, source: entry ?? null, targets: consoles, folders: missing },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }

  env.errOut(`wrote ${written.map((one) => join(root, one)).join(", ")}\n`);
  if (entry === undefined) {
    env.errOut(`no .dmt found: put one in ${join(root, "src")}/ and it becomes the game\n`);
  }
  if (missing.length > 0) {
    env.errOut(`folders this project has not needed yet: ${missing.join(", ")}\n`);
  }
  return EXIT.OK;
}
