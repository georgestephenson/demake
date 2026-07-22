/**
 * `demake inspect` — compliance analysis and optional fidelity judging (doc 05).
 *
 * Reports whether an image is compliant, for which consoles, and why not. With
 * `--source`, it also runs the tournament's own judge to score fidelity metrics
 * against the source. `--json` emits a single stable object.
 */

import { inspect, judge } from "@demake/core";
import type { ParsedValue } from "@demake/cli-spec";

import type { CliEnv } from "../env.js";
import { EXIT, type ExitCode } from "../exit-codes.js";
import { resolveInput } from "../io.js";

export function runInspect(
  env: CliEnv,
  values: Record<string, ParsedValue>,
  positionals: string[],
): ExitCode {
  const json = values.json === true;
  const consoleId = typeof values.console === "string" ? values.console : undefined;
  const { bytes } = resolveInput(env, positionals);

  const report = inspect(bytes, consoleId ? { console: consoleId } : {});
  const sourcePath = typeof values.source === "string" ? values.source : undefined;
  const judged = sourcePath ? judge(env.readFile(sourcePath), bytes) : undefined;

  if (json) {
    env.out(
      JSON.stringify(
        { schemaVersion: 1, ...report, ...(judged ? { judge: judged } : {}) },
        null,
        2,
      ) + "\n",
    );
    return EXIT.OK;
  }

  env.out(`${report.width}x${report.height}, ${report.colors} colors\n`);
  for (const c of report.consoles) {
    const mark = c.compliant ? "OK " : "no ";
    env.out(`  [${mark}] ${c.console}\n`);
    if (!c.compliant) {
      for (const v of c.violations) {
        env.out(`         - ${v.code}: ${v.message}\n`);
      }
    }
  }
  if (judged) {
    env.out(`\nfidelity vs source (aggregate ${judged.aggregate.toFixed(3)}):\n`);
    for (const [id, score] of Object.entries(judged.metrics)) {
      env.out(`  ${id}: ${score.toFixed(3)}\n`);
    }
    env.out(
      `  mean ΔE: ${judged.rawMeanDeltaE.toFixed(4)}  p95 ΔE: ${judged.rawP95DeltaE.toFixed(4)}\n`,
    );
  }
  return EXIT.OK;
}
