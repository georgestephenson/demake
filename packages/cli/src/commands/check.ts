/**
 * `demake check` — is this source valid, will it fit, and what will a build do?
 *
 * Doc 19 §The CLI keeps up: "resolves the whole project: every source, every
 * asset, every target, every path that will be written". Doc 15 asks for the same
 * thing under a different name — "nothing about a build should require reading the
 * resolver to predict" — and this is where that promise is kept.
 *
 * **It writes nothing.** Not a cartridge, not a `build/` directory, not a
 * temporary file. That is the difference between this and `demake build`, and it
 * is why the command has no `--output`: the answer is the report.
 *
 * It is also the fastest way to be told a reference is ambiguous, because it
 * compiles for every target the project declares rather than for one console —
 * a `.dmt` that resolves on a Game Boy resolves everywhere, but a *budget* does
 * not, and neither does a sprite that overflows a per-scanline limit.
 */

import {
  compile,
  describeProgram,
  findProfile,
  formatDiagnostics,
  GameLangError,
  hasRuntime,
  profiles,
  romExtension,
  unsupportedFor,
  outputPath,
  type Program,
} from "@demake/demotic";
import type { ParsedValue } from "@demake/cli-spec";

import type { CliEnv } from "../env.js";
import { EXIT, type ExitCode } from "../exit-codes.js";
import { CliError } from "../io.js";
import { loadLevels, openInput, type Input } from "./project-input.js";

/** What checking one target found. */
interface TargetReport {
  console: string;
  region: string;
  /** Where a `rom` build would write, when the project says. */
  output?: string;
  ok: boolean;
  /** Diagnostics, formatted the way `build` formats them. */
  errors: readonly { code: string; line: number; message: string }[];
  warnings: readonly { code: string; line: number; message: string }[];
  /** Language features this console's backend cannot compile. */
  unsupported: readonly string[];
  budget?: { sprites: number; spriteLimit: number };
}

function plain(
  diagnostics: readonly { code: string; line: number; message: string }[],
): readonly { code: string; line: number; message: string }[] {
  return diagnostics.map((one) => ({ code: one.code, line: one.line, message: one.message }));
}

/** Compile for one console and describe what came back. */
function checkTarget(
  input: Input,
  consoleId: string,
  region: string,
  levels: Record<string, string>,
): TargetReport {
  const profile = findProfile(consoleId);
  if (!profile) {
    return {
      console: consoleId,
      region,
      ok: false,
      errors: [{ code: "E_UNKNOWN_CONSOLE", line: 1, message: `unknown console '${consoleId}'` }],
      warnings: [],
      unsupported: [],
    };
  }

  let program: Program;
  try {
    program = compile(input.source, { profile, files: input.files, levels });
  } catch (error) {
    if (error instanceof GameLangError) {
      return {
        console: consoleId,
        region,
        ok: false,
        errors: plain(error.diagnostics.filter((one) => one.severity === "error")),
        warnings: plain(error.diagnostics.filter((one) => one.severity === "warning")),
        unsupported: [],
      };
    }
    throw error;
  }

  const unsupported = hasRuntime(profile.id) ? unsupportedFor(program) : ["a console backend"];
  const target = input.plan.targets.find((one) => one.console === profile.id);
  const stated = target?.outputs.find((one) => one.format === "rom")?.path;
  return {
    console: profile.id,
    region,
    ...(input.root !== undefined && target !== undefined
      ? { output: outputPath(input.plan, target, romExtension(program), stated) }
      : {}),
    ok: unsupported.length === 0,
    errors: [],
    warnings: plain(program.warnings),
    unsupported,
    budget: { sprites: program.budget.peakSprites, spriteLimit: program.budget.spriteLimit },
  };
}

export function runCheck(
  env: CliEnv,
  values: Record<string, ParsedValue>,
  positionals: readonly string[],
): ExitCode {
  const json = values.json === true;
  const only = typeof values.console === "string" ? values.console : undefined;

  const input = openInput(env, positionals);
  const levels = loadLevels(env, input);

  // Which consoles to check: the flag, else the project's declared targets, else
  // every console with a backend. The last is what a bare `.dmt` gets, and it is
  // the honest default — a game with no build file targets everything (doc 15).
  const wanted: readonly { console: string; region: string }[] =
    only !== undefined
      ? [{ console: only, region: "ntsc" }]
      : input.plan.targets.length > 0
        ? input.plan.targets.map((one) => ({ console: one.console, region: one.region }))
        : profiles
            .filter((one) => hasRuntime(one.id))
            .map((one) => ({ console: one.id, region: "ntsc" }));

  const reports = wanted.map((one) => checkTarget(input, one.console, one.region, levels));
  const failed = reports.filter((one) => one.errors.length > 0 || !one.ok);

  if (json) {
    env.out(
      `${JSON.stringify(
        {
          source: input.path,
          project: input.root ?? null,
          plan: input.root === undefined ? null : input.plan,
          assets: reports.length > 0 ? undefined : [],
          targets: reports,
          ok: failed.length === 0,
        },
        null,
        2,
      )}\n`,
    );
    return failed.length === 0 ? EXIT.OK : EXIT.BAD_INPUT;
  }

  const lines: string[] = [];
  lines.push(`${input.path}${input.root === undefined ? "" : ` (project ${input.plan.name})`}`);
  if (input.root !== undefined) {
    lines.push(`  out       ${input.plan.out}/`);
    lines.push(`  files     ${String(input.files.length)}`);
  }

  // An error every target reports is an error about the *source*, not about any
  // console: an ambiguous reference or a syntax error is the same on all eight, so
  // printing it eight times buries the one line that differs. Only what is not
  // shared stays under its target.
  const key = (one: { code: string; line: number; message: string }) =>
    `${one.code}\u0000${String(one.line)}\u0000${one.message}`;
  const shared =
    reports.length > 1
      ? (reports[0]?.errors ?? []).filter((one) =>
          reports.every((report) => report.errors.some((other) => key(other) === key(one))),
        )
      : [];
  const sharedKeys = new Set(shared.map(key));
  if (shared.length > 0) {
    lines.push(
      formatDiagnostics(shared.map((one) => ({ ...one, severity: "error" as const })))
        .split("\n")
        .map((line) => (line === "" ? line : `  ${line}`))
        .join("\n"),
    );
    lines.push(`  every target reports the ${shared.length === 1 ? "error" : "errors"} above`);
  }

  // The resolution, which is the thing a reader cannot work out from the source:
  // a reference is the shortest name that identifies a file, so what it *resolved
  // to* is the only way to be sure it found the one you meant (doc 19 §The rule).
  const resolved = reports.find((one) => one.errors.length === 0);
  if (resolved) {
    try {
      const profile = findProfile(resolved.console);
      if (profile) {
        const program = compile(input.source, { profile, files: input.files, levels });
        for (const [label, list] of [
          ["art", program.assets],
          ["music", program.tracks],
          ["sound", program.sounds],
        ] as const) {
          if (list.length > 0) lines.push(`  ${label.padEnd(9)} ${list.join(", ")}`);
        }
        lines.push(`  ${describeProgram(program)}`);
      }
    } catch {
      // Already reported per target below; this block is the summary, not the check.
    }
  }

  for (const report of reports) {
    const own = report.errors.filter((one) => !sharedKeys.has(key(one)));
    const state = report.errors.length > 0 ? "error" : report.ok ? "ok" : "unsupported";
    const where = report.output === undefined ? "" : ` → ${report.output}`;
    lines.push(`  ${report.console.padEnd(9)} ${state}${where}`);
    if (report.budget) {
      lines.push(
        `    sprites ${String(report.budget.sprites)}/${String(report.budget.spriteLimit)}`,
      );
    }
    for (const one of report.unsupported) lines.push(`    needs ${one}`);
    if (own.length > 0) {
      lines.push(
        formatDiagnostics(own.map((one) => ({ ...one, severity: "error" as const })))
          .split("\n")
          .map((line) => (line === "" ? line : `    ${line}`))
          .join("\n"),
      );
    }
    for (const one of report.warnings) {
      lines.push(`    warning ${one.code} line ${String(one.line)}: ${one.message}`);
    }
  }

  env.out(`${lines.join("\n")}\n`);
  if (failed.length === 0) return EXIT.OK;
  throw new CliError(
    EXIT.BAD_INPUT,
    "E_CHECK_FAILED",
    `${String(failed.length)} of ${String(reports.length)} target${reports.length === 1 ? "" : "s"} would not build`,
    "the report above names what each one needs.",
  );
}
