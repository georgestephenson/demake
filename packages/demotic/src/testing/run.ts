/**
 * Running `.test.dmt` cases against the reference interpreter.
 *
 * Each case gets a fresh {@link Sim}, so cases cannot leak state into each
 * other, and each is run once per console. That is the whole point: the same
 * assertions, in the same relative vocabulary, checked against every playfield
 * the game will actually ship on.
 *
 * A failure reports both sides of the comparison in cells, because "expected
 * `ball1.y > centery`" on its own tells you nothing you did not already know.
 */

import { applyBinary, applyBuiltin, resolveUnit, screenConstant } from "../compile.js";
import { formatFixed, type Fixed, fromInt, ONE } from "../fixed.js";
import type { Expr } from "../lang/ast.js";
import type { CBinaryOp, Program, PureBuiltinFn } from "../program.js";
import { Sim, type InputState } from "../sim.js";

import { durationTicks, type Duration, type TestCase, type TestFile } from "./parse.js";

/** Outcome of one assertion. */
export interface AssertionResult {
  passed: boolean;
  /** The assertion as written. */
  source: string;
  line: number;
  /** Both sides of a comparison, in cells, when the assertion was one. */
  detail?: string;
}

/** Outcome of one case on one console. */
export interface CaseResult {
  name: string;
  console: string;
  passed: boolean;
  assertions: AssertionResult[];
  /** Ticks the case ran for. */
  ticks: number;
}

/** Outcome of a whole file on one console. */
export interface RunResult {
  console: string;
  cases: CaseResult[];
  passed: boolean;
}

/** Thrown internally when an assertion names something that does not exist. */
class EvalError extends Error {}

/** Run every case in `file` against `program`. */
export function runTests(file: TestFile, program: Program): RunResult {
  const cases = file.cases.map((testCase) => runCase(testCase, program));
  return {
    console: program.profile.id,
    cases,
    passed: cases.every((result) => result.passed),
  };
}

function runCase(testCase: TestCase, program: Program): CaseResult {
  const sim = new Sim(program);
  const assertions: AssertionResult[] = [];
  // A duration written in seconds is a different number of ticks per console,
  // which is the whole point of it: this is the one place the profile's rate
  // enters a test script.
  const ticksOf = (duration: Duration): number => durationTicks(duration, program.profile.fps);

  for (const step of testCase.steps) {
    switch (step.kind) {
      case "play":
        for (let i = 0; i < ticksOf(step.duration); i += 1) sim.step({});
        break;

      case "press":
        // One tick held then one released, so both edges are observable — a
        // press that never comes up would leave `on hold` bindings engaged.
        sim.step({ [step.action]: true } as InputState);
        sim.step({});
        break;

      case "hold": {
        const input = { [step.action]: true } as InputState;
        for (let i = 0; i < ticksOf(step.duration); i += 1) sim.step(input);
        sim.step({});
        break;
      }

      case "expectScene":
        assertions.push({
          passed: sim.scene === step.scene,
          source: `scene ${step.scene}`,
          line: step.line,
          detail: `scene is ${sim.scene}`,
        });
        break;

      case "expect":
        assertions.push(evaluateAssertion(step.expr, step.source, step.line, sim));
        break;
    }
  }

  return {
    name: testCase.name,
    console: program.profile.id,
    passed: assertions.length > 0 && assertions.every((a) => a.passed),
    assertions,
    ticks: sim.tick,
  };
}

function evaluateAssertion(expr: Expr, source: string, line: number, sim: Sim): AssertionResult {
  try {
    const passed = evaluate(expr, sim) !== 0;
    const detail = describeComparison(expr, sim);
    return { passed, source, line, ...(detail === undefined ? {} : { detail }) };
  } catch (error) {
    if (!(error instanceof EvalError)) throw error;
    return { passed: false, source, line, detail: error.message };
  }
}

/** For a top-level comparison, report both sides — the useful half of a failure. */
function describeComparison(expr: Expr, sim: Sim): string | undefined {
  if (expr.kind !== "binary") return undefined;
  if (!["<", ">", "<=", ">=", "=", "!="].includes(expr.op)) return undefined;
  try {
    const left = evaluate(expr.left, sim);
    const right = evaluate(expr.right, sim);
    return `${formatFixed(left)} ${expr.op} ${formatFixed(right)}`;
  } catch {
    return undefined;
  }
}

/**
 * Evaluate an assertion against live simulator state.
 *
 * Unit and constant resolution come from the compiler's own exported helpers, so
 * `40vmin` and `centery` cannot mean one thing in a game and another in a test.
 */
function evaluate(expr: Expr, sim: Sim): Fixed {
  const profile = sim.program.profile;

  switch (expr.kind) {
    case "number":
      return resolveUnit(Math.round(expr.value * ONE), expr.unit, profile);

    case "string":
      throw new EvalError("a quoted string is not a number");

    case "unary":
      return -evaluate(expr.operand, sim);

    case "binary":
      return applyBinary(expr.op as CBinaryOp, evaluate(expr.left, sim), evaluate(expr.right, sim));

    case "call":
      // An assertion may not draw: doing so would advance the game's generator
      // and make the run depend on whether the test was there. A test that wants
      // to talk about randomness asserts on what the draw *did*.
      if (expr.name === "random") {
        throw new EvalError("`random` cannot be used in an assertion — it would change the game");
      }
      return applyBuiltin(
        expr.name as PureBuiltinFn,
        expr.args.map((arg) => evaluate(arg, sim)),
      );

    case "name": {
      if (expr.parts.length === 2 && expr.parts[0] === "camera") {
        return expr.parts[1] === "y" ? sim.camera.y : sim.camera.x;
      }
      if (expr.parts.length === 1) {
        // The playfield is the running scene's, which is its level's size when
        // it has one — so an assertion about "the end of the level" is true on
        // every console, which is the whole point of writing it that way.
        const name = expr.parts[0] as string;
        if (name === "levelwidth") return fromInt(sim.bounds.width);
        if (name === "levelheight") return fromInt(sim.bounds.height);
        const constant = screenConstant(name, profile);
        if (constant === undefined) {
          throw new EvalError(`'${expr.raw}' is not a value — did you mean <object>.<property>?`);
        }
        return constant;
      }
      const owner = expr.parts.slice(0, -1).join(".");
      const prop = expr.parts[expr.parts.length - 1] as string;
      const entity = sim.entity(owner);
      if (!entity) throw new EvalError(`no object named '${owner}'`);
      return readProp(entity.numbers, prop);
    }
  }
}

/** Mirrors the simulator's derived properties (doc 14 §Properties). */
function readProp(numbers: Readonly<Record<string, Fixed>>, prop: string): Fixed {
  const x = numbers["x"] ?? 0;
  const y = numbers["y"] ?? 0;
  const width = numbers["width"] ?? 0;
  const height = numbers["height"] ?? 0;
  switch (prop) {
    case "centerx":
      return x + Math.floor(width / 2);
    case "centery":
      return y + Math.floor(height / 2);
    case "left":
      return x;
    case "right":
      return x + width;
    case "top":
      return y;
    case "bottom":
      return y + height;
    default:
      return numbers[prop] ?? 0;
  }
}

/** Render results as a report. `verbose` also lists passing assertions. */
export function formatResults(results: readonly RunResult[], verbose = false): string {
  const lines: string[] = [];

  for (const result of results) {
    const failed = result.cases.filter((c) => !c.passed).length;
    lines.push(
      `${result.passed ? "ok  " : "FAIL"} ${result.console.padEnd(6)} ` +
        `${result.cases.length} case${result.cases.length === 1 ? "" : "s"}` +
        `${failed > 0 ? `, ${failed} failed` : ""}`,
    );

    for (const testCase of result.cases) {
      if (testCase.passed && !verbose) continue;
      lines.push(
        `     ${testCase.passed ? "ok" : "FAIL"} ${testCase.name}  (${testCase.ticks} ticks)`,
      );
      for (const assertion of testCase.assertions) {
        if (assertion.passed && !verbose) continue;
        const detail = assertion.detail ? `  [${assertion.detail}]` : "";
        lines.push(
          `          ${assertion.passed ? "ok" : "FAIL"} line ${assertion.line}: ${assertion.source}${detail}`,
        );
      }
    }
  }

  return lines.join("\n");
}
