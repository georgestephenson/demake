#!/usr/bin/env node
/**
 * Which CI gates a change actually needs (doc 11 §Affected-only gates).
 *
 * The workspace dependency graph is read out of the packages themselves — never
 * from a hand-maintained path list. Changed files are mapped onto packages, the
 * set is closed over its *dependents*, and each job answers one question about
 * that set. Adding a dependency therefore widens the gate on its own, the same
 * reason `codegen/registry.ts` is the one list that says which consoles build.
 *
 * Two properties are what make it safe to skip a gate on this:
 *
 *   - **It fails open.** No base ref, a git that errors, a package.json that
 *     will not parse, a changed path this file has never heard of — every one
 *     of those runs everything. Only paths explicitly classified as inert can
 *     turn a gate off, so a new top-level directory is loud rather than silent.
 *
 *   - **It is coarse on purpose.** A package is affected if any file under it
 *     changed, and a job is on or off as a whole. The unit suite is never
 *     narrowed to a subset of its test files: `vitest.config.ts` aliases every
 *     `@demake/*` specifier to source, so a test can import a package its own
 *     package.json does not declare, and file-level selection would rest on a
 *     graph that is not the real one. Job-level gating only ever asks whether a
 *     package is in the closure, which that hazard cannot affect.
 *
 * Pushes to `main` pass no base ref and so run the whole matrix: the PR is what
 * gets fast, and the branch everything is cut from stays fully proven.
 *
 * Usage: node tools/ci/affected.mjs [--base <ref>] [--head <ref>]
 * Env:   DEMAKE_BASE_REF, DEMAKE_HEAD_REF (how the workflow passes them)
 *
 * Writes `key=value` job flags to $GITHUB_OUTPUT and a table to
 * $GITHUB_STEP_SUMMARY; prints the same table on stdout when run by hand.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Paths that cannot change what any gate proves.
 *
 * `docs/` is hand-authored design prose that nothing reads at test time — the
 * *generated* language reference lives in `packages/demotic/docs/`, inside the
 * package whose staleness test checks it. `lint` runs unconditionally, so the
 * Prettier check on these files never depends on this table.
 */
const INERT_PREFIXES = [
  "docs/",
  ".changeset/",
  ".github/ISSUE_TEMPLATE/",
  ".github/PULL_REQUEST_TEMPLATE",
  ".vscode/",
  ".claude/",
  "tools/prep-eval/", // `pnpm eval:prep` is a human's tool; no job runs it
];

const INERT_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "LICENSE",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
]);

/**
 * Paths only the ROM/emulator loop can be broken by: the display programs
 * `gen --format rom` assembles, the headless capturers, and the provisioners
 * that build them. Nothing in the unit suite reads any of it (every test that
 * does is a `*.e2e.test.ts`).
 */
const E2E_ONLY_PREFIXES = ["rom-harness/", "emu-harness/", "tools/toolchains/"];

/** Read every package manifest under `packages/` into `name -> { dir, deps }`. */
function readWorkspace() {
  const graph = new Map();
  const dirs = readdirSync(new URL("packages/", `file://${ROOT}`), { withFileTypes: true });
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(
      readFileSync(new URL(`packages/${entry.name}/package.json`, `file://${ROOT}`), "utf8"),
    );
    graph.set(manifest.name, {
      dir: `packages/${entry.name}/`,
      // devDependencies count: `@demake/dmg` is only ever a test dependency of
      // `@demake/demotic`, and a change to it can still turn that suite red.
      deps: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((d) =>
        d.startsWith("@demake/"),
      ),
    });
  }
  return graph;
}

/** Every package that depends on `seeds`, transitively, plus `seeds` itself. */
function closeOverDependents(graph, seeds) {
  const affected = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, { deps }] of graph) {
      if (affected.has(name)) continue;
      if (deps.some((d) => affected.has(d))) {
        affected.add(name);
        grew = true;
      }
    }
  }
  return affected;
}

/** `git diff --name-only base...head`, or null if git cannot answer. */
function changedFiles(base, head) {
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch (err) {
    console.error(`git diff ${base}...${head} failed: ${err.message}`);
    return null;
  }
}

/**
 * Sort changed files into the three buckets a gate can be decided from.
 * Anything unrecognised sets `everything`, which is the fail-open path.
 */
function classify(files, graph) {
  const byDir = [...graph.entries()].map(([name, { dir }]) => [dir, name]);
  const seeds = new Set();
  const reasons = new Set();
  let everything = false;
  let e2eOnly = false;

  for (const file of files) {
    if (INERT_FILES.has(file) || INERT_PREFIXES.some((p) => file.startsWith(p))) continue;

    const pkg = byDir.find(([dir]) => file.startsWith(dir));
    if (pkg) {
      seeds.add(pkg[1]);
      continue;
    }
    if (E2E_ONLY_PREFIXES.some((p) => file.startsWith(p))) {
      e2eOnly = true;
      reasons.add("ROM/emulator harness or toolchain changed");
      continue;
    }
    everything = true;
    reasons.add(`\`${file}\` is not a package or a known inert path`);
  }
  return { seeds, everything, e2eOnly, reasons };
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const base = flag("base") ?? process.env["DEMAKE_BASE_REF"];
  const head = flag("head") ?? process.env["DEMAKE_HEAD_REF"] ?? "HEAD";

  let gates = { unit: true, browser: true, lighthouse: true, e2e: true };
  let affected = null;
  let why = "no base ref — running every gate";

  if (base) {
    const files = changedFiles(base, head);
    let graph = null;
    try {
      graph = readWorkspace();
    } catch (err) {
      console.error(`could not read the workspace graph: ${err.message}`);
    }

    if (files && graph) {
      const { seeds, everything, e2eOnly, reasons } = classify(files, graph);
      affected = [...closeOverDependents(graph, seeds)].sort();

      if (everything) {
        why = `running every gate: ${[...reasons].join("; ")}`;
      } else {
        gates = {
          unit: affected.length > 0,
          browser: affected.includes("@demake/web"),
          lighthouse: affected.includes("@demake/web"),
          e2e: affected.includes("demake") || e2eOnly,
        };
        why =
          affected.length || e2eOnly
            ? `${files.length} file(s) changed; affected packages: ${affected.join(", ") || "none"}`
            : `${files.length} file(s) changed, none of which any gate covers`;
      }
    } else {
      why = "could not compute the change set — running every gate";
    }
  }

  const rows = [
    // Two jobs on a pull request (Node 22 and 24 on ubuntu), six on `main`,
    // where the other two operating systems join them — the workflow decides
    // that from the event, not from anything here.
    ["Unit (Node 22/24)", gates.unit],
    ["Browser (3 engines)", gates.browser],
    ["Web budget + Lighthouse", gates.lighthouse],
    ["Pixel-perfect E2E", gates.e2e],
  ];
  const summary = [
    "### Affected gates",
    "",
    `${why}`,
    "",
    "| Job | Runs |",
    "| --- | --- |",
    ...rows.map(([name, on]) => `| ${name} | ${on ? "yes" : "**skipped**"} |`),
    "",
    "`lint` always runs: it is 40 seconds and it covers every file in the repo.",
    "",
  ].join("\n");

  console.log(summary);
  if (process.env["GITHUB_STEP_SUMMARY"]) {
    appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${summary}\n`);
  }
  if (process.env["GITHUB_OUTPUT"]) {
    const out = Object.entries(gates)
      .map(([k, v]) => `${k}=${v}`)
      .concat(`affected=${affected ? affected.join(",") : "all"}`)
      .join("\n");
    appendFileSync(process.env["GITHUB_OUTPUT"], `${out}\n`);
  }
}

main();
