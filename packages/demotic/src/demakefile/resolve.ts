/**
 * What a Demakefile actually asks for (doc 15 §Resolution, doc 19).
 *
 * The cascade, most specific winning, per domain:
 *
 *     defaults/<domain>  <  target  <  <domain> <name>  <  <domain> <name>/for <target>
 *
 * Everything here is pure: a file tree's names, a parsed Demakefile, and out
 * comes the plan. That is what lets `demake check` print it, `demake build`
 * execute it and the web app display it without three answers — and it is why
 * nothing in this file reads a file or knows a console's capabilities.
 */

import { resolveReference } from "../project/resolve.js";
import { findEntry } from "../project/entry.js";
import type { AssetKind } from "../project/kinds.js";
import {
  type Demakefile,
  type Domain,
  EMPTY_DEMAKEFILE,
  optionValue,
  type Options,
} from "./model.js";

/** The default output root, and the one `demake init` writes (doc 19). */
export const DEFAULT_OUT = "build";

/** One target, with everything about it decided. */
export interface ResolvedTarget {
  /** The target's name, which is its console unless it said otherwise. */
  name: string;
  console: string;
  region: string;
  /** Artifacts to write, as `{format, path}` relative to `out`. */
  outputs: readonly { format: string; path: string }[];
  /** ROM header fields, as written. */
  header: Readonly<Record<string, string>>;
}

/** A whole build. */
export interface ResolvedProject {
  /** The project's name: `project <name>`, else the entry file's stem. */
  name: string;
  /** The `.dmt` to compile, relative to the project root. */
  source?: string;
  /** Extra asset roots, outside the project (doc 19 §The Demakefile). */
  assetRoots: readonly string[];
  out: string;
  targets: readonly ResolvedTarget[];
}

/** Turn an options list into a plain record, last write winning. */
function record(options: Options): Record<string, string> {
  const out: Record<string, string> = {};
  for (const option of options) out[option.name] = option.value;
  return out;
}

/**
 * The project's shape, with the folder supplying what the file left out.
 *
 * `source` defaults to the single `.dmt` the folder holds, `out` to `build/`, and
 * the target list to whatever the file declared. A project with no Demakefile at
 * all resolves to exactly the zero-config path (doc 15 §You do not need one), so
 * `demake build` needs no branch for "has a build file".
 */
export function resolveProject(
  file: Demakefile = EMPTY_DEMAKEFILE,
  files: readonly string[] = [],
  fallbackTargets: readonly string[] = [],
): ResolvedProject {
  const entry = file.source?.value ?? findEntry(files).path;
  const stem = (entry ?? "game").replace(/^.*\//, "").replace(/\.dmt$/i, "");
  const declared = file.targets.map((target) => {
    const consoleId = target.console ?? target.name;
    return {
      name: target.name,
      console: consoleId,
      region: target.region ?? "ntsc",
      outputs: target.outputs.map((one) => ({ format: one.format, path: one.path })),
      header: record(target.header),
    };
  });
  return {
    name: file.project?.name ?? stem,
    ...(entry === undefined ? {} : { source: entry }),
    assetRoots: file.assets.map((one) => one.value),
    out: file.out?.value ?? DEFAULT_OUT,
    targets:
      declared.length > 0
        ? declared
        : fallbackTargets.map((consoleId) => ({
            name: consoleId,
            console: consoleId,
            region: "ntsc",
            outputs: [],
            header: {},
          })),
  };
}

/** Which domain an asset of this kind takes its options from. */
function domainOf(kind: AssetKind): Domain | undefined {
  return kind === "art"
    ? "art"
    : kind === "music"
      ? "music"
      : kind === "sound"
        ? "sound"
        : undefined;
}

/**
 * The options one asset is demade with, for one target.
 *
 * The asset is named by its **resolved path**, because that is what a `Program`
 * carries — and the blocks in the file are matched against it with the same
 * `resolveReference` a `.dmt` reference uses, so `art art/ball.png` and
 * `art ball` reach the same asset and neither has to be spelled the way the game
 * spelled it (doc 19 §The rule).
 */
export function resolveOptions(
  file: Demakefile,
  path: string,
  kind: AssetKind,
  target: string,
  files: readonly string[] = [],
): Readonly<Record<string, string>> {
  const domain = domainOf(kind);
  if (domain === undefined) return {};
  const out: Record<string, string> = { ...record(file.defaults[domain] ?? []) };

  for (const one of file.targets) {
    if (one.name === target) Object.assign(out, record(one.options));
  }

  for (const block of file.assetBlocks) {
    if (block.domain !== domain) continue;
    const named = resolveReference(block.name, kind, files).path ?? block.name;
    if (named !== path && block.name !== path) continue;
    Object.assign(out, record(block.options));
    for (const per of block.per) {
      if (per.target === target) Object.assign(out, record(per.options));
    }
  }
  return out;
}

/** A `use <file>` substitution for one asset and target, if the file states one. */
export function resolveSubstitute(
  file: Demakefile,
  path: string,
  kind: AssetKind,
  target: string,
  files: readonly string[] = [],
): string | undefined {
  const options = resolveOptions(file, path, kind, target, files);
  return options["use"];
}

/**
 * Where one target's artifact lands.
 *
 * `{out}/{console}/{project}.{ext}` is the zero-config default expressed as a
 * template, which is doc 15's own description of it. A path the file gave stands
 * as written; one starting with `/` or `./` escapes `out`.
 */
export function outputPath(
  plan: ResolvedProject,
  target: ResolvedTarget,
  extension: string,
  stated?: string,
): string {
  const template = stated ?? `{out}/{console}/{project}.{ext}`;
  const filled = template
    .replace(/\{out\}/g, plan.out)
    .replace(/\{project\}/g, plan.name)
    .replace(/\{target\}/g, target.name)
    .replace(/\{console\}/g, target.console)
    .replace(/\{region\}/g, target.region)
    .replace(/\{ext\}/g, extension);
  if (stated === undefined) return filled;
  return filled.startsWith("/") || filled.startsWith("./") ? filled : `${plan.out}/${filled}`;
}

/** Read one option out of a resolved set, for a caller that wants just one. */
export function option(options: Options, name: string): string | undefined {
  return optionValue(options, name);
}
