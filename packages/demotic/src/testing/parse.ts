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
import type { Comment } from "../lang/lex.js";
import { parseExpression } from "../lang/parse.js";
import type { SlotKind, SourceSlot, StatementSpan } from "../lang/slots.js";
import { ACTIONS, type Action } from "../program.js";
import { TEST_KEYWORDS } from "./spec.js";

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
  /**
   * Where each statement's editable parts are (`lang/slots.ts`).
   *
   * The same side channel the game parser keeps, for the same reason and in the
   * same shape: a block editor works on a suite exactly as it works on a game,
   * over one component that knows nothing about either grammar.
   */
  spans: StatementSpan[];
  /**
   * Comments, as source ranges — the lexer's own habit, one grammar along.
   *
   * `lex.ts` keeps them because the highlighter would otherwise have to re-decide
   * where a comment starts; this keeps them because a block editor would. A suite
   * is not lexed at all, so without these the page would be matching `--` itself,
   * and the two files disagree about the rule: a game needs a space before it (so
   * `y--1` is arithmetic), a suite has no arithmetic to protect.
   */
  comments: Comment[];
}

const ACTION_SET = new Set<string>(ACTIONS);

/** A duration, and where its parts sit in the text it was read from. */
interface ReadDuration {
  duration: Duration;
  /** Length of the count, which always starts the text. */
  countLength: number;
  /** Where the unit word sits, when one was written. */
  unitAt?: number;
  unitLength?: number;
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
function parseDuration(rest: string): ReadDuration | undefined {
  const text = rest.trim();
  const match = /^(\d+(?:\.\d+)?)(?:\s+(ticks?|seconds?))?$/i.exec(text);
  if (!match) return undefined;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count < 0) return undefined;
  const written = match[2];
  const unit = (written ?? "ticks").toLowerCase();
  // A fractional tick is not a thing the simulation has.
  if (!unit.startsWith("second") && !Number.isSafeInteger(count)) return undefined;
  const duration: Duration = unit.startsWith("second")
    ? { unit: "seconds", count }
    : { unit: "ticks", count };
  const countLength = (match[1] as string).length;
  return written === undefined
    ? { duration, countLength }
    : { duration, countLength, unitAt: text.length - written.length, unitLength: written.length };
}

/** Parse a `.test.dmt` source file. Never throws. */
export function parseTests(source: string): TestFile {
  const cases: TestCase[] = [];
  const diagnostics: Diagnostic[] = [];
  const spans: StatementSpan[] = [];
  const comments: Comment[] = [];
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
  // Where the line being read starts in the file. Slots are offsets into the
  // whole source, because an editor splices the file rather than the line.
  let lineStart = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const raw = lines[index] as string;
    const start = lineStart;
    lineStart += raw.length + 1;

    const comment = raw.indexOf("--");
    const body = comment < 0 ? raw : raw.slice(0, comment);
    if (comment >= 0) comments.push({ start: start + comment, end: start + raw.length, line });
    const text = body.trim();
    if (text === "") continue;
    const at = start + (body.length - body.trimStart().length);

    const space = text.search(/\s/);
    const keyword = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    const tail = space < 0 ? "" : text.slice(space + 1);
    const rest = tail.trim();
    const restAt =
      at + (space < 0 ? text.length : space + 1 + tail.length - tail.trimStart().length);

    // Slots are recorded against `rest`, which is where everything editable is:
    // the keyword itself is what the row *is*, and it is changed by replacing the
    // row rather than by typing over the word.
    const slots: SourceSlot[] = [];
    const mark = (kind: SlotKind, from: number, length: number): void => {
      slots.push({ kind, line, start: restAt + from, end: restAt + from + length });
    };
    const record = (): void => {
      spans.push({
        keyword,
        line,
        start: at,
        end: at + text.length,
        keywordEnd: at + keyword.length,
        slots,
        // No statement in this grammar repeats a part: a suite holds one button,
        // one scene, one claim per line. The field is here so a caller is written
        // against `StatementSpan` rather than against whichever of the two
        // languages it happens to have open.
        lists: [],
      });
    };

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
      mark("title", 0, rest.length);
      record();
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
        const read = parseDuration(rest);
        if (read === undefined) {
          fail(line, "E_SYNTAX", "`play` takes a duration", "e.g. `play 4 seconds`");
          break;
        }
        current.steps.push({ kind: "play", duration: read.duration, line });
        markDuration(mark, read, 0);
        record();
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
        mark("button", 0, rest.length);
        record();
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
        const written = match[2] as string;
        const read = parseDuration(written);
        if (!ACTION_SET.has(action)) {
          fail(
            line,
            "E_UNKNOWN_ACTION",
            `'${match[1]}' is not a button`,
            `one of: ${ACTIONS.join(", ")}`,
          );
          break;
        }
        if (read === undefined) {
          fail(line, "E_SYNTAX", "`hold` needs a duration", "e.g. `hold left for 5 seconds`");
          break;
        }
        current.steps.push({
          kind: "hold",
          action: action as Action,
          duration: read.duration,
          line,
        });
        mark("button", 0, action.length);
        // `for` may be spaced any way at all, so the duration is found by where
        // the tail of the line begins rather than by counting the words.
        markDuration(mark, read, rest.length - written.length);
        record();
        break;
      }

      case "expect": {
        const sceneMatch = /^scene\s+(\w+)$/i.exec(rest);
        if (sceneMatch) {
          const name = sceneMatch[1] as string;
          current.steps.push({ kind: "expectScene", scene: name.toLowerCase(), line });
          mark("scene", rest.length - name.length, name.length);
          record();
          break;
        }
        const { expr, error } = parseExpression(rest, line);
        if (error) {
          diagnostics.push(error);
          break;
        }
        current.steps.push({ kind: "expect", expr: expr as Expr, source: rest, line });
        mark("expression", 0, rest.length);
        record();
        break;
      }

      default:
        fail(
          line,
          "E_UNKNOWN_STATEMENT",
          `unknown statement '${keyword}'`,
          `statements are ${TEST_KEYWORDS.join(", ")}`,
        );
    }
  }

  return { cases, diagnostics, spans, comments };
}

/** Record a duration's count and, where one was written, its unit. */
function markDuration(
  mark: (kind: SlotKind, from: number, length: number) => void,
  read: ReadDuration,
  from: number,
): void {
  mark("number", from, read.countLength);
  if (read.unitAt !== undefined && read.unitLength !== undefined) {
    mark("duration-unit", from + read.unitAt, read.unitLength);
  }
}
