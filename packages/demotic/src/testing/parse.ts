/**
 * `.test.dmt` — assertions about a game, written in the same language as the
 * game.
 *
 * The point is that one test file runs on *every* console. A Demotic program is
 * portable but its numbers are not — a Game Boy court is 20 cells wide and a
 * Mega Drive court is 40 — so an assertion has to be written in terms that port
 * too. It gets the whole expression language for free, including relative units
 * and screen constants, which is exactly the vocabulary that makes
 * `expect ball1.y > centery` mean the same thing on all of them.
 *
 * Same shape as Demotic: one statement per line, no nesting, `--` comments,
 * case-insensitive, and per-line error recovery so one pass reports everything.
 * A `test` line opens a case and every line after it belongs to that case until
 * the next `test`.
 */

import type { Diagnostic } from "../errors.js";
import type { Expr } from "../lang/ast.js";
import { parseExpression } from "../lang/parse.js";
import { ACTIONS, type Action } from "../program.js";

/**
 * How long a step lasts, in the unit it was written in.
 *
 * Unresolved on purpose: a *second* is a different number of ticks on different
 * consoles, and the parser has no console. The runner resolves it against the
 * profile's `fps`, which is the same place the compiler resolves a `speed`.
 */
export type Duration =
  /** `240 ticks` — the simulation's own quantum, and the same count everywhere. */
  | { unit: "ticks"; count: number }
  /** `4 seconds` — the same *duration* everywhere, whatever the console ticks at. */
  | { unit: "seconds"; count: number };

/**
 * A duration in ticks on a console that runs at `fps`.
 *
 * Rounded, because a console's rate need not divide a second's worth of them
 * evenly. Written in ticks it is the count as given — nothing to resolve.
 */
export function durationTicks(duration: Duration, fps: number): number {
  return duration.unit === "ticks" ? duration.count : Math.round(duration.count * fps);
}

/** One step in a test case. */
export type TestStep =
  /** `play 4 seconds` — advance with no input. */
  | { kind: "play"; duration: Duration; line: number }
  /** `press a` — one tick held, one released, so an edge rule sees it. */
  | { kind: "press"; action: Action; line: number }
  /** `hold left for 5 seconds` */
  | { kind: "hold"; action: Action; duration: Duration; line: number }
  /** `expect <expression>` — must evaluate non-zero. */
  | { kind: "expect"; expr: Expr; source: string; line: number }
  /** `expect scene <name>` — a readable special case of the above. */
  | { kind: "expectScene"; scene: string; line: number };

/** One named case. */
export interface TestCase {
  name: string;
  steps: TestStep[];
  line: number;
}

/** A parsed `.test.dmt` file. */
export interface TestFile {
  cases: TestCase[];
  diagnostics: Diagnostic[];
}

const ACTION_SET = new Set<string>(ACTIONS);

function stripComment(line: string): string {
  const at = line.indexOf("--");
  return (at < 0 ? line : line.slice(0, at)).trim();
}

/**
 * Parse `<n> seconds` or `<n> ticks`, tolerating the unit being left off.
 *
 * **Seconds are what a script that means a duration should say.** A tick count
 * is portable only while every console ticks at the same rate, and one does not:
 * a WonderSwan runs at 75.47 Hz, so `hold right for 42 ticks` covers three
 * quarters of the ground there that it covers on a Game Boy. That is the same
 * trap `speed` avoids by being cells per *second* (doc 14 §3), arriving one
 * layer up — and it stayed invisible for as long as every profile said sixty.
 *
 * Ticks are still a unit rather than a deprecation: a step that means "one more
 * tick" means exactly that, and a bare number still reads as ticks because it
 * always has.
 */
function parseDuration(rest: string): Duration | undefined {
  const match = /^(\d+(?:\.\d+)?)(?:\s+(ticks?|seconds?))?$/i.exec(rest.trim());
  if (!match) return undefined;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count < 0) return undefined;
  const unit = (match[2] ?? "ticks").toLowerCase();
  if (unit.startsWith("second")) return { unit: "seconds", count };
  // A fractional tick is not a thing the simulation has.
  return Number.isSafeInteger(count) ? { unit: "ticks", count } : undefined;
}

/** Parse a `.test.dmt` source file. Never throws. */
export function parseTests(source: string): TestFile {
  const cases: TestCase[] = [];
  const diagnostics: Diagnostic[] = [];
  let current: TestCase | undefined;

  const fail = (line: number, code: string, message: string, hint?: string): void => {
    diagnostics.push({
      severity: "error",
      code,
      message,
      line,
      ...(hint === undefined ? {} : { hint }),
    });
  };

  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const text = stripComment(lines[index] as string);
    if (text === "") continue;

    const space = text.search(/\s/);
    const keyword = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    const rest = space < 0 ? "" : text.slice(space + 1).trim();

    if (keyword === "test") {
      if (rest === "") {
        fail(
          line,
          "E_TEST_UNNAMED",
          "a `test` needs a name",
          "e.g. `test the ball serves downward`",
        );
        continue;
      }
      current = { name: rest, steps: [], line };
      cases.push(current);
      continue;
    }

    if (!current) {
      fail(
        line,
        "E_TEST_ORPHAN",
        `'${keyword}' appears before any \`test\``,
        "open a case first: `test <name>`",
      );
      continue;
    }

    switch (keyword) {
      case "play": {
        const duration = parseDuration(rest);
        if (duration === undefined) {
          fail(line, "E_SYNTAX", "`play` takes a duration", "e.g. `play 4 seconds`");
          break;
        }
        current.steps.push({ kind: "play", duration, line });
        break;
      }

      case "press": {
        const action = rest.toLowerCase();
        if (!ACTION_SET.has(action)) {
          fail(
            line,
            "E_UNKNOWN_ACTION",
            `'${rest}' is not a button`,
            `one of: ${ACTIONS.join(", ")}`,
          );
          break;
        }
        current.steps.push({ kind: "press", action: action as Action, line });
        break;
      }

      case "hold": {
        const match = /^(\w+)\s+for\s+(.+)$/i.exec(rest);
        if (!match) {
          fail(
            line,
            "E_SYNTAX",
            "`hold` takes a button and a duration",
            "e.g. `hold left for 5 seconds`",
          );
          break;
        }
        const action = (match[1] as string).toLowerCase();
        const duration = parseDuration(match[2] as string);
        if (!ACTION_SET.has(action)) {
          fail(
            line,
            "E_UNKNOWN_ACTION",
            `'${match[1]}' is not a button`,
            `one of: ${ACTIONS.join(", ")}`,
          );
          break;
        }
        if (duration === undefined) {
          fail(line, "E_SYNTAX", "`hold` needs a duration", "e.g. `hold left for 5 seconds`");
          break;
        }
        current.steps.push({ kind: "hold", action: action as Action, duration, line });
        break;
      }

      case "expect": {
        const sceneMatch = /^scene\s+(\w+)$/i.exec(rest);
        if (sceneMatch) {
          current.steps.push({
            kind: "expectScene",
            scene: (sceneMatch[1] as string).toLowerCase(),
            line,
          });
          break;
        }
        const { expr, error } = parseExpression(rest, line);
        if (error) {
          diagnostics.push(error);
          break;
        }
        current.steps.push({ kind: "expect", expr: expr as Expr, source: rest, line });
        break;
      }

      default:
        fail(
          line,
          "E_UNKNOWN_STATEMENT",
          `unknown statement '${keyword}'`,
          "statements are test, play, press, hold, expect",
        );
    }
  }

  return { cases, diagnostics };
}
