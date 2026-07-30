/**
 * The art demaker's controls ⇄ a Demakefile's `art` block (doc 19 §Options edit
 * the Demakefile).
 *
 * Two vocabularies for the same settings: `PrepOptionsUi`, which is what the
 * controls hold, and the build file's strings, which are the doc-05 flag values.
 * This translates between them and nothing else — the *writing* is
 * `demakefile.ts`'s and the *meaning* is `@demake/demotic`'s validator, so a
 * value this file produces is one the CLI would accept from a hand-written file.
 *
 * Only a subset of the pane's controls appear here, and the subset is the point:
 * `size`, `fit` and the console are the build's own arithmetic and a build file
 * may not set them (doc 15 §`art <name>`). The pane still offers them, because
 * they are meaningful for a one-off conversion you are about to download — they
 * simply do not travel into the project.
 */

import { resolveOptions, shortestName } from "@demake/demotic";

import { buildFile } from "./demakefile.js";
import { projectFiles, type Project } from "./project.js";
import type { PrepOptionsUi } from "../worker/protocol.js";

/**
 * The options a control may write into an `art` block.
 *
 * Named here rather than derived, because it is a *product* decision about which
 * controls travel with a project — and the engine-side whitelist in
 * `demakefile/overrides.ts` is the one that decides what is legal. These are a
 * subset of that: `palette` and `protect` are legal in a file but have no single
 * control to hang off, so they are left to be typed.
 */
export const DEMAKEFILE_OPTIONS = ["strategy", "dither", "scale", "effort", "metric"] as const;

/** One of them. */
export type DemakefileOption = (typeof DEMAKEFILE_OPTIONS)[number];

/**
 * What one control should write, or `undefined` where it says nothing.
 *
 * The pane's "auto"/"" spellings are absences, not values: `strategy auto` is the
 * absence of a choice and `dither ""` is the absence of a dither, so neither is
 * written as a directive.
 */
export function uiToDemakefile(name: DemakefileOption, ui: PrepOptionsUi): string | undefined {
  switch (name) {
    case "strategy":
      return ui.strategy === "" || ui.strategy === "auto" ? undefined : ui.strategy;
    case "dither":
      return ui.dither === "" ? undefined : ui.dither;
    case "scale":
      return ui.scale === "auto" ? undefined : ui.scale;
    case "effort":
      return ui.effort === "default" ? undefined : ui.effort;
    case "metric":
      return ui.metric === "oklab" ? undefined : ui.metric;
    default:
      return undefined;
  }
}

/** The pane's spelling of one option, as read out of a build file. */
function demakefileToUi(name: DemakefileOption, value: string): Partial<PrepOptionsUi> {
  switch (name) {
    case "strategy":
      return { strategy: value };
    case "dither":
      return { dither: value };
    case "scale":
      return { scale: value as PrepOptionsUi["scale"] };
    case "effort":
      return { effort: value as PrepOptionsUi["effort"] };
    case "metric":
      return { metric: value as PrepOptionsUi["metric"] };
    default:
      return {};
  }
}

/** The pane's defaults for the options a build file can set. */
const UNSET: Readonly<Record<DemakefileOption, Partial<PrepOptionsUi>>> = {
  strategy: { strategy: "" },
  dither: { dither: "" },
  scale: { scale: "auto" },
  effort: { effort: "default" },
  metric: { metric: "oklab" },
};

/**
 * The controls, as this project's Demakefile resolves them for one asset.
 *
 * `withoutAsset` asks what the asset would inherit if its own block said nothing —
 * which is how a control decides whether the value it is about to write is a real
 * choice or a restatement of what it would get anyway.
 */
export function settingsFor(
  project: Project,
  path: string,
  target: string,
  withoutAsset = false,
): Partial<PrepOptionsUi> {
  const file = buildFile(project);
  const files = projectFiles(project);
  const named = shortestName(path, files);
  const source = withoutAsset
    ? {
        ...file,
        assetBlocks: file.assetBlocks.filter((one) => one.name !== named && one.name !== path),
      }
    : file;
  const resolved = resolveOptions(source, path, "art", target, files);

  const out: Partial<PrepOptionsUi> = {};
  for (const name of DEMAKEFILE_OPTIONS) {
    const value = resolved[name];
    Object.assign(out, value === undefined ? UNSET[name] : demakefileToUi(name, value));
  }
  return out;
}
