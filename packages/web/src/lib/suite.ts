/**
 * Running a `.test.dmt` against every console at once.
 *
 * A suite is compared against *all* of them because that is what makes it a
 * **balance** check rather than a mechanical one (doc 14 §Testing a game): a Game
 * Boy court is 20 cells wide and a Mega Drive court is 40, so an assertion
 * written in the relative vocabulary — `expect ball1.y > centery` — means the same
 * thing on both, and one written in absolute cells does not and shows it here.
 *
 * One implementation, two callers: the suite editor and the *Run tests* button
 * the game section keeps. Both compile the same game against the same profiles
 * and both report the same numbers, which they would eventually stop doing if
 * each ran the loop itself.
 */

import {
  check,
  formatResults,
  parseTests,
  profiles,
  runTests,
  type RunResult,
} from "@demake/demotic";

/** What one run of a suite comes to. */
export interface SuiteRun {
  results: readonly RunResult[];
  /** Assertions, counted across every console the game compiled for. */
  cases: number;
  failed: number;
  /** Consoles the game would not compile for, which are silently not run. */
  skipped: number;
  /** The whole thing, as the CLI would print it. */
  report: string;
}

/** Run `suite` against `game`, on every console the game compiles for. */
export function runSuite(
  game: string,
  suite: string,
  options: { files: readonly string[]; levels: Record<string, string> },
): SuiteRun {
  const file = parseTests(suite);
  const results: RunResult[] = [];
  let skipped = 0;
  for (const profile of profiles) {
    try {
      const compiled = check(game, { profile, files: options.files, levels: options.levels });
      if (compiled.program) results.push(runTests(file, compiled.program));
      else skipped += 1;
    } catch {
      // A console this game cannot target is reported by its own diagnostics in
      // the editor beside this; a run is not the place to say it a second time.
      skipped += 1;
    }
  }

  const cases = results.reduce((sum, one) => sum + one.cases.length, 0);
  const failed = results.reduce(
    (sum, one) => sum + one.cases.filter((each) => !each.passed).length,
    0,
  );
  return { results, cases, failed, skipped, report: formatResults(results) };
}

/** The one-line verdict, which is what a status bar has room for. */
export function summarise(run: SuiteRun): string {
  if (run.results.length === 0) return "nothing ran — the game did not compile for any console";
  const consoles = `${String(run.results.length)} console${run.results.length === 1 ? "" : "s"}`;
  return `${String(run.cases - run.failed)}/${String(run.cases)} cases passed across ${consoles}`;
}
