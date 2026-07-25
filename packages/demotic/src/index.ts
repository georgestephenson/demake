/**
 * `@demake/demotic` — Demotic, the declarative cross-console game language.
 *
 * The bet this package exists to test: a game can be *declared* — objects,
 * their sizes in cells, their speeds in cells per second, and the rules that
 * fire when things collide — and then run identically on every console in the
 * target set, because the simulation is integer fixed point on a fixed logical
 * tick and only the rendering is platform-specific.
 *
 * What is here: the language front end (lex → parse → compile), the reference
 * interpreter that defines its semantics, and the trace format that lets a
 * console runtime prove it agrees. What is deliberately *not* here: any
 * assembly, any ROM building, any art conversion. Those hang off the existing
 * `prep`/`gen`/`rom` machinery once the semantics are settled — which is the
 * point of settling them first.
 *
 * Platform-pure and deterministic, on the same terms as `@demake/core`: no
 * `fs`, no DOM, no wall clock, no RNG, no floats in the simulation. `dist/` is
 * plain ESM with no dependencies, so the browser preview loads it directly with
 * no bundler.
 */

export { compile, check, applyBinary, applyBuiltin, type CompileOptions } from "./compile.js";
export { GameLangError, formatDiagnostics, type Diagnostic, type Severity } from "./errors.js";
export {
  ONE,
  MAX_UNITS,
  FRAC_BITS,
  clamp,
  clampFixed,
  div,
  floorToInt,
  formatFixed,
  fromDecimal,
  fromInt,
  mul,
  roundToInt,
  toNumber,
  type Fixed,
} from "./fixed.js";
export { parse, type ParseResult } from "./lang/parse.js";
export { lex, type Token, type TokenKind } from "./lang/lex.js";
export type * from "./lang/ast.js";
export {
  findProfile,
  getProfile,
  profiles,
  type ConsoleProfile,
  type SpriteLimits,
  type StartMapping,
} from "./profiles.js";
export {
  ACTIONS,
  EDGES,
  type Action,
  type BudgetReport,
  type CAssignment,
  type CBinaryOp,
  type BuiltinFn,
  type CEvent,
  type CExpr,
  type CTarget,
  type ControlDef,
  type Edge,
  type EntityRef,
  type InstanceDef,
  type Program,
  type RuleDef,
  type SceneDef,
} from "./program.js";
export {
  Sim,
  type EntityState,
  type InputState,
  type InputTape,
  type RuntimeBudget,
} from "./sim.js";
export { trace, traceLine, tape, describeProgram } from "./trace.js";
export { renderAscii, type AsciiOptions } from "./render/ascii.js";
export { parseTests, type TestCase, type TestFile, type TestStep } from "./testing/parse.js";
export {
  runTests,
  formatResults,
  type AssertionResult,
  type CaseResult,
  type RunResult,
} from "./testing/run.js";
export { referencePages, referenceIndex, type ReferencePage } from "./docs/reference.js";
export * from "./lang/spec.js";
