/**
 * The page's controls, written into the Demakefile (doc 19 §Options edit the
 * Demakefile).
 *
 * This is doc 15 §The equivalence contract ceasing to be a promise: the preview's
 * settings *are* a view of a build file, and the way to make that true rather
 * than aspirational is for there to be no second place they live. Change a
 * demaker's option with a project file open and the file changes; delete the file
 * and you are back to the defaults it was an escape from.
 *
 * Four rules, each of which is a way the feature could go wrong:
 *
 * - **The block written is the file you have open.** Never `defaults`, because a
 *   change made while looking at one asset must not silently retune every other
 *   one. Applying something to everything is a separate, deliberate control.
 * - **An option set back to what it inherits deletes its line.** Otherwise the
 *   file fills with directives that change nothing and doc 15's third round-trip
 *   property is false the first time anyone nudges a slider and nudges it back.
 * - **A project with no Demakefile gets one on the first changed option**, and it
 *   is the file `demake init` would have written. The file appearing is never a
 *   surprise.
 * - **Everything else in the file is left exactly as it was.** The model is
 *   ordered and comment-preserving, so a hand-authored file keeps its comments,
 *   its blank lines and its order — only the line that changed is rewritten.
 */

import {
  emitDemakefile,
  EMPTY_DEMAKEFILE,
  findEntry,
  parseDemakefile,
  resolveOptions,
  shortestName,
  type AssetBlock,
  type AssetKind,
  type Demakefile,
  type Domain,
  type Option,
} from "@demake/demotic";

import { projectFiles, readText, writeText, type Project } from "./project.js";

/** Where a project keeps its build file. */
export const DEMAKEFILE = "Demakefile";

/** The project's Demakefile, parsed — empty when it has none. */
export function buildFile(project: Project): Demakefile {
  const text = readText(project, DEMAKEFILE);
  return text === "" ? EMPTY_DEMAKEFILE : parseDemakefile(text);
}

/** Which domain a kind's options come from, or undefined for a level. */
export function domainOf(kind: AssetKind): Domain | undefined {
  return kind === "art" || kind === "music" || kind === "sound" ? kind : undefined;
}

/** Where a resolved option came from, which is what the pane shows beside it. */
export type Provenance = "asset" | "target" | "defaults" | "engine";

/** One option as the pane needs it: the value in force, and who supplied it. */
export interface Resolved {
  value?: string;
  from: Provenance;
}

/**
 * Resolve one option for one asset, and say which level of the cascade won.
 *
 * The provenance is not decoration. A four-level cascade you cannot see is a
 * cascade you debug by guessing, which is exactly what doc 15's `--dry-run --json`
 * exists to prevent on the command line.
 */
export function resolveOne(
  project: Project,
  path: string,
  kind: AssetKind,
  target: string,
  name: string,
): Resolved {
  const domain = domainOf(kind);
  if (domain === undefined) return { from: "engine" };
  const file = buildFile(project);
  const files = projectFiles(project);
  const all = resolveOptions(file, path, kind, target, files);
  const value = all[name];
  if (value === undefined) return { from: "engine" };

  // Which level set it, most specific first — the same order the cascade
  // resolves in, asked backwards.
  const block = findBlock(file, project, path, kind);
  if (block) {
    for (const per of block.per) {
      if (per.target === target && per.options.some((one) => one.name === name)) {
        return { value, from: "asset" };
      }
    }
    if (block.options.some((one) => one.name === name)) return { value, from: "asset" };
  }
  for (const one of file.targets) {
    if (one.name === target && one.options.some((option) => option.name === name)) {
      return { value, from: "target" };
    }
  }
  return { value, from: "defaults" };
}

/** The block for this asset, however the file happened to spell its name. */
function findBlock(
  file: Demakefile,
  project: Project,
  path: string,
  kind: AssetKind,
): AssetBlock | undefined {
  const domain = domainOf(kind);
  const files = projectFiles(project);
  return file.assetBlocks.find((block) => {
    if (block.domain !== domain) return false;
    // Matched the way a `.dmt` reference is, so a block written `art/ball.png`
    // and one written `ball` are the same block (doc 19 §The rule).
    const named = shortestName(path, files);
    return block.name === path || block.name === named;
  });
}

/**
 * Set — or clear — one option for one asset, returning the project.
 *
 * `value === undefined` removes the directive. When that empties the block, the
 * block goes too: a file left holding `art ball` with nothing under it says
 * something it does not mean.
 */
export function setAssetOption(
  project: Project,
  path: string,
  kind: AssetKind,
  name: string,
  value: string | undefined,
): Project {
  const domain = domainOf(kind);
  if (domain === undefined) return project;

  const existing = readText(project, DEMAKEFILE);
  const file = existing === "" ? scaffold(project) : parseDemakefile(existing);
  const files = projectFiles(project);
  // The shortest name that identifies the asset, which is what a `.dmt` writes
  // and therefore what a reader expects to see here (doc 19 §The rule).
  const named = shortestName(path, files);

  const blocks = [...file.assetBlocks];
  const at = blocks.findIndex(
    (block) => block.domain === domain && (block.name === path || block.name === named),
  );

  if (at < 0) {
    if (value === undefined) return project; // nothing to clear
    blocks.push({
      domain,
      name: named,
      options: [{ name, value, line: 0 }],
      per: [],
      line: 0,
    });
  } else {
    const block = blocks[at] as AssetBlock;
    const options = [...block.options];
    const found = options.findIndex((one) => one.name === name);
    if (value === undefined) {
      if (found < 0) return project;
      options.splice(found, 1);
    } else if (found < 0) {
      options.push({ name, value, line: 0 });
    } else {
      // Rewrite the one line, keeping whatever comment sat above it.
      options[found] = { ...(options[found] as Option), value };
    }
    if (options.length === 0 && block.per.length === 0) blocks.splice(at, 1);
    else blocks[at] = { ...block, options };
  }

  return writeText(project, DEMAKEFILE, emitDemakefile({ ...file, assetBlocks: blocks }));
}

/**
 * The Demakefile a project gets on its first changed option.
 *
 * Deliberately what `demake init` writes: the file that reproduces the defaults,
 * so the one that appears is the one the CLI would have made and nothing about
 * the build changes except the option just set.
 */
function scaffold(project: Project): Demakefile {
  const files = projectFiles(project);
  const entry = findEntry(files).path;
  const name =
    entry === undefined ? project.name : entry.replace(/^.*\//, "").replace(/\.dmt$/i, "");
  return {
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
  };
}
