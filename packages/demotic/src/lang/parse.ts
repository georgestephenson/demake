/**
 * Parser: tokens → a flat statement list.
 *
 * Statements are one per line and never nest, so recovery is simple and total:
 * a malformed statement records a diagnostic, the cursor skips to the next
 * newline, and parsing continues. One run therefore reports every syntax error
 * in the file, which is the property that makes the language pleasant to
 * generate and patch programmatically.
 *
 * Argument lists accept both shapes from the design sketch:
 *
 *   (height 1, width 2)              -- named pairs (canonical)
 *   (height, width) as (1, 2)        -- positional pair-up (SQL INSERT style)
 *
 * They are distinguished by a single lookahead: an identifier followed by `,`
 * or `)` is a bare column name; an identifier followed by anything else starts
 * a `name <expression>` pair. That also disambiguates `(xdirection -1)` — the
 * name is consumed before the value is parsed, so it reads as `xdirection` set
 * to `-1`, never as the expression `xdirection - 1`.
 */

import type { Diagnostic } from "../errors.js";

import type {
  Assignment,
  BinaryOp,
  ControlMode,
  Event,
  Expr,
  ParsedProgram,
  Prop,
  Stmt,
  TargetRef,
  Unit,
} from "./ast.js";
import { lex, type Token } from "./lex.js";

/** Result of a parse: statements plus any recovered syntax errors. */
export interface ParseResult extends ParsedProgram {
  diagnostics: readonly Diagnostic[];
}

const CONTROL_MODES = new Set<string>(["hold", "press", "release"]);

/** Unit suffixes a numeric literal may carry (see {@link Unit}). */
const UNITS = new Set<string>(["cell", "cells", "vw", "vh", "vmin", "vmax"]);

/**
 * Builtin functions, with their arity.
 *
 * Deliberately tiny and all exactly representable in integer arithmetic — every
 * one of these has to be reimplementable in a page of 6502 (doc 14 §Runtime
 * model), so nothing transcendental will ever join them.
 */
const FUNCTIONS: Readonly<Record<string, number>> = { abs: 1, min: 2, max: 2, clamp: 3 };

/** Binding power per binary operator; higher binds tighter. */
const PRECEDENCE: Record<BinaryOp, number> = {
  "<": 1,
  ">": 1,
  "<=": 1,
  ">=": 1,
  "=": 1,
  "!=": 1,
  "+": 2,
  "-": 2,
  "*": 3,
  "/": 3,
};

/** Signals a statement-level parse failure; caught by the recovery loop. */
class ParseFailure extends Error {
  constructor(
    readonly diagnostic: Diagnostic,
    readonly hard = false,
  ) {
    super(diagnostic.message);
  }
}

class Cursor {
  private pos = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)] as Token;
  }

  next(): Token {
    const token = this.peek();
    if (token.kind !== "eof") this.pos += 1;
    return token;
  }

  atEnd(): boolean {
    return this.peek().kind === "eof";
  }

  /** True if the current token is an identifier with exactly this text. */
  atKeyword(word: string): boolean {
    const token = this.peek();
    return token.kind === "ident" && token.value === word;
  }

  eatKeyword(word: string): boolean {
    if (!this.atKeyword(word)) return false;
    this.next();
    return true;
  }

  atPunct(ch: string): boolean {
    const token = this.peek();
    return token.kind === "punct" && token.value === ch;
  }

  eatPunct(ch: string): boolean {
    if (!this.atPunct(ch)) return false;
    this.next();
    return true;
  }

  expectPunct(ch: string): Token {
    if (!this.atPunct(ch)) {
      throw this.fail("E_SYNTAX", `expected '${ch}' but found ${describe(this.peek())}`);
    }
    return this.next();
  }

  expectIdent(what: string): Token {
    const token = this.peek();
    if (token.kind !== "ident") {
      throw this.fail("E_SYNTAX", `expected ${what} but found ${describe(token)}`);
    }
    return this.next();
  }

  atStatementEnd(): boolean {
    const kind = this.peek().kind;
    return kind === "newline" || kind === "eof";
  }

  /** Skip past the end of the current line — the recovery primitive. */
  skipLine(): void {
    while (!this.atStatementEnd()) this.next();
    if (this.peek().kind === "newline") this.next();
  }

  skipBlankLines(): void {
    while (this.peek().kind === "newline") this.next();
  }

  fail(code: string, message: string, hint?: string): ParseFailure {
    return new ParseFailure({
      severity: "error",
      code,
      message,
      line: this.peek().line,
      ...(hint === undefined ? {} : { hint }),
    });
  }
}

function describe(token: Token): string {
  if (token.kind === "eof") return "end of file";
  if (token.kind === "newline") return "end of line";
  return `'${token.raw}'`;
}

/** Parse source text into statements, recovering from per-line syntax errors. */
export function parse(source: string): ParseResult {
  const cursor = new Cursor(lex(source));
  const statements: Stmt[] = [];
  const diagnostics: Diagnostic[] = [];

  cursor.skipBlankLines();
  while (!cursor.atEnd()) {
    try {
      const statement = parseStatement(cursor);
      if (!cursor.atStatementEnd()) {
        throw cursor.fail(
          "E_SYNTAX",
          `unexpected ${describe(cursor.peek())} after the end of the statement`,
          "statements are one per line; start a new line for the next one",
        );
      }
      statements.push(statement);
    } catch (error) {
      if (!(error instanceof ParseFailure)) throw error;
      diagnostics.push(error.diagnostic);
    }
    cursor.skipLine();
    cursor.skipBlankLines();
  }

  return { statements, diagnostics };
}

function parseStatement(cursor: Cursor): Stmt {
  const token = cursor.peek();
  if (token.kind !== "ident") {
    throw cursor.fail("E_SYNTAX", `expected a statement keyword but found ${describe(token)}`);
  }

  switch (token.value) {
    case "loop":
      return parseLoop(cursor);
    case "scene":
      return parseScene(cursor);
    case "create":
      return parseCreate(cursor);
    case "control":
      return parseControl(cursor);
    case "when":
      return parseWhen(cursor);
    default:
      throw cursor.fail(
        "E_UNKNOWN_STATEMENT",
        `unknown statement '${token.raw}'`,
        "statements start with loop, scene, create, control, or when",
      );
  }
}

function parseLoop(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();
  const scene = cursor.expectIdent("a scene name");
  return { kind: "loop", scene: scene.value, line };
}

function parseScene(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();
  const name = cursor.expectIdent("a scene name");
  return { kind: "scene", name: name.value, line };
}

function parseCreate(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();

  if (cursor.eatKeyword("object")) {
    const name = cursor.expectIdent("a class name");
    const props = parsePropList(cursor);
    return { kind: "class", name: name.value, props, line };
  }

  const className = cursor.expectIdent("a class name");
  const name = cursor.expectIdent("an instance name");
  let scene: string | undefined;
  if (cursor.eatKeyword("in")) {
    scene = cursor.expectIdent("a scene name").value;
  }
  const props = parsePropList(cursor);
  return {
    kind: "instance",
    className: className.value,
    name: name.value,
    ...(scene === undefined ? {} : { scene }),
    props,
    line,
  };
}

function parseControl(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();
  const entity = cursor.expectIdent("an entity name");
  const action = cursor.expectIdent("a button name");
  const assignments = parseAssignmentList(cursor);

  let mode: ControlMode = "hold";
  if (cursor.eatKeyword("on")) {
    const word = cursor.expectIdent("hold, press, or release");
    if (!CONTROL_MODES.has(word.value)) {
      throw cursor.fail(
        "E_SYNTAX",
        `unknown control mode '${word.raw}'`,
        "use `on hold`, `on press`, or `on release`",
      );
    }
    mode = word.value as ControlMode;
  }

  return { kind: "control", entity: entity.value, action: action.value, assignments, mode, line };
}

function parseWhen(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();

  const event = parseEvent(cursor);
  let scene: string | undefined;
  if (cursor.eatKeyword("in")) {
    scene = cursor.expectIdent("a scene name").value;
  }
  const assignments = parseAssignmentList(cursor);
  return {
    kind: "when",
    event,
    ...(scene === undefined ? {} : { scene }),
    assignments,
    line,
  };
}

function parseEvent(cursor: Cursor): Event {
  const first = cursor.peek();
  const second = cursor.peek(1);

  // `when <subject> hits <a>, <b>, ...`
  if (first.kind === "ident" && second.kind === "ident" && second.value === "hits") {
    cursor.next();
    cursor.next();
    const others: string[] = [];
    do {
      others.push(cursor.expectIdent("something to collide with").value);
    } while (cursor.eatPunct(","));
    return { kind: "hits", subject: first.value, others };
  }

  // `when <action> pressed | released`
  if (
    first.kind === "ident" &&
    second.kind === "ident" &&
    (second.value === "pressed" || second.value === "released")
  ) {
    cursor.next();
    cursor.next();
    return { kind: "input", action: first.value, edge: second.value };
  }

  const left = parseExpr(cursor, 0);
  if (cursor.eatKeyword("reaches")) {
    const right = parseExpr(cursor, 0);
    return { kind: "reaches", left, right };
  }
  return { kind: "predicate", test: left };
}

/**
 * Parse `( ... )` in either the named or the positional-`as` shape, returning
 * name/value pairs. Shared by `create` (properties) and `when`/`control`
 * (assignments), which differ only in how the names are later resolved.
 */
function parsePairs(cursor: Cursor): Prop[] {
  cursor.expectPunct("(");

  const names: (string | undefined)[] = [];
  const values: (Expr | undefined)[] = [];
  const lines: number[] = [];

  if (!cursor.atPunct(")")) {
    do {
      const token = cursor.peek();
      lines.push(token.line);
      if (token.kind === "ident" && token.value in FUNCTIONS && cursor.peek(1).value === "(") {
        names.push(undefined);
        values.push(parseExpr(cursor, 0));
      } else if (token.kind === "ident" && isBareColumn(cursor)) {
        cursor.next();
        names.push(token.value);
        values.push(undefined);
      } else if (token.kind === "ident") {
        cursor.next();
        names.push(token.value);
        values.push(parseExpr(cursor, 0));
      } else {
        names.push(undefined);
        values.push(parseExpr(cursor, 0));
      }
    } while (cursor.eatPunct(","));
  }
  cursor.expectPunct(")");

  if (!cursor.eatKeyword("as")) {
    return names.map((name, index) => {
      const value = values[index];
      const line = lines[index] ?? 0;
      if (name === undefined || value === undefined) {
        throw cursor.fail(
          "E_SYNTAX",
          "each entry needs a name and a value, e.g. `(x 8, y 4)`",
          "or use the positional form: `(x, y) as (8, 4)`",
        );
      }
      return { name, value, line };
    });
  }

  // Positional form: the group just parsed was a column list; values follow.
  const columns = names.map((name, index) => {
    if (name === undefined || values[index] !== undefined) {
      throw cursor.fail(
        "E_SYNTAX",
        "the list before `as` must be plain property names, e.g. `(x, y) as (8, 4)`",
      );
    }
    return name;
  });

  const provided = parseValueList(cursor);
  if (provided.length !== columns.length) {
    throw cursor.fail(
      "E_ARITY",
      `${columns.length} name${columns.length === 1 ? "" : "s"} before \`as\` but ${provided.length} value${provided.length === 1 ? "" : "s"} after it`,
      "the named form `(x 8, y 4)` cannot drift out of step this way",
    );
  }

  return columns.map((name, index) => ({
    name,
    value: provided[index] as Expr,
    line: lines[index] ?? 0,
  }));
}

/** True when the identifier at the cursor is a bare column name (`,` or `)` next). */
function isBareColumn(cursor: Cursor): boolean {
  const after = cursor.peek(1);
  return after.kind === "punct" && (after.value === "," || after.value === ")");
}

/**
 * True when this identifier begins a function call rather than a name.
 *
 * Only builtin names count, so `(y (screenheight - 1))` stays a named pair whose
 * value happens to be parenthesised — the check is on the name, not merely on a
 * following `(`.
 */
function isCall(name: string, cursor: Cursor): boolean {
  return name in FUNCTIONS && cursor.atPunct("(");
}

/** Parse the value side of `as`: either `( a, b )` or a single bare expression. */
function parseValueList(cursor: Cursor): Expr[] {
  if (!cursor.atPunct("(")) return [parseExpr(cursor, 0)];

  cursor.expectPunct("(");
  const values: Expr[] = [];
  if (!cursor.atPunct(")")) {
    do {
      values.push(parseExpr(cursor, 0));
    } while (cursor.eatPunct(","));
  }
  cursor.expectPunct(")");
  return values;
}

function parsePropList(cursor: Cursor): Prop[] {
  if (cursor.atStatementEnd()) return [];
  return parsePairs(cursor);
}

function parseAssignmentList(cursor: Cursor): Assignment[] {
  if (cursor.atStatementEnd()) return [];
  return parsePairs(cursor).map((pair) => ({
    target: splitTarget(pair.name, pair.line),
    value: pair.value,
  }));
}

/** Split `paddle2.xdirection` into an entity qualifier and a property name. */
function splitTarget(name: string, line: number): TargetRef {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return { prop: name, line };
  return { entity: name.slice(0, dot), prop: name.slice(dot + 1), line };
}

/** Pratt expression parser. `minPower` is the caller's binding power. */
function parseExpr(cursor: Cursor, minPower: number): Expr {
  let left = parsePrefix(cursor);

  for (;;) {
    const token = cursor.peek();
    if (token.kind !== "op") break;
    const op = token.value as BinaryOp;
    const power = PRECEDENCE[op];
    if (power === undefined || power < minPower) break;
    cursor.next();
    const right = parseExpr(cursor, power + 1);
    left = { kind: "binary", op, left, right, line: token.line };
  }

  return left;
}

function parsePrefix(cursor: Cursor): Expr {
  const token = cursor.peek();

  if (token.kind === "op" && token.value === "-") {
    cursor.next();
    return { kind: "unary", op: "-", operand: parsePrefix(cursor), line: token.line };
  }

  if (token.kind === "number") {
    cursor.next();
    const value = Number(token.value);
    if (!Number.isFinite(value)) {
      throw cursor.fail("E_SYNTAX", `'${token.raw}' is not a valid number`);
    }
    // A unit suffix may be attached (`15vw`) or spaced (`15 vw`) — the lexer
    // splits them identically, so one lookahead covers both.
    const next = cursor.peek();
    if (next.kind === "ident" && UNITS.has(next.value)) {
      cursor.next();
      const unit = (next.value === "cell" ? "cells" : next.value) as Unit;
      return { kind: "number", value, unit, line: token.line };
    }
    return { kind: "number", value, line: token.line };
  }

  if (token.kind === "string") {
    cursor.next();
    return { kind: "string", value: token.value, line: token.line };
  }

  if (token.kind === "ident") {
    cursor.next();
    if (isCall(token.value, cursor)) {
      cursor.expectPunct("(");
      const args: Expr[] = [];
      if (!cursor.atPunct(")")) {
        do {
          args.push(parseExpr(cursor, 0));
        } while (cursor.eatPunct(","));
      }
      cursor.expectPunct(")");
      const arity = FUNCTIONS[token.value] as number;
      if (args.length !== arity) {
        throw cursor.fail(
          "E_ARITY",
          `${token.raw} takes ${arity} argument${arity === 1 ? "" : "s"}, not ${args.length}`,
        );
      }
      return { kind: "call", name: token.value, args, line: token.line };
    }
    return {
      kind: "name",
      parts: token.value.split("."),
      raw: token.raw,
      line: token.line,
    };
  }

  if (token.kind === "punct" && token.value === "(") {
    cursor.next();
    const inner = parseExpr(cursor, 0);
    cursor.expectPunct(")");
    return inner;
  }

  throw cursor.fail("E_SYNTAX", `expected a value but found ${describe(token)}`);
}

/**
 * Parse one standalone expression — the `.test.dmt` runner's entry point, so an
 * assertion is written in exactly the expression language the game is.
 */
export function parseExpression(source: string, line = 1): { expr?: Expr; error?: Diagnostic } {
  const cursor = new Cursor(lex(source));
  try {
    const expr = parseExpr(cursor, 0);
    if (!cursor.atStatementEnd()) {
      throw cursor.fail("E_SYNTAX", `unexpected ${describe(cursor.peek())} after the expression`);
    }
    return { expr: { ...expr, line } };
  } catch (error) {
    if (!(error instanceof ParseFailure)) throw error;
    return { error: { ...error.diagnostic, line } };
  }
}
