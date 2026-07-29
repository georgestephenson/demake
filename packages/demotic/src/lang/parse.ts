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
import { lex, type LexNote, type Token } from "./lex.js";
import { FUNCTION_ARITY, UNIT_NAMES } from "./spec.js";

/** Result of a parse: statements plus any recovered syntax errors. */
export interface ParseResult extends ParsedProgram {
  diagnostics: readonly Diagnostic[];
}

const CONTROL_MODES = new Set<string>(["hold", "press", "release"]);

// Units and builtins come from the language registry, so the lexer cannot
// accept something the reference does not document (AGENTS.md §Iron rules).
const UNITS = UNIT_NAMES;
const FUNCTIONS = FUNCTION_ARITY;

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

/** The units a numeric literal may carry, for a hint. */
const UNIT_LIST = [...UNITS].sort().join(", ");

/**
 * Turn the lexer's observations into diagnostics.
 *
 * Both are cases where the lexer's reading is defensible but probably not the
 * one that was meant, and where saying nothing costs the author far more than a
 * false positive does: the glued comment silently truncates a statement, and the
 * runaway string silently swallows the rest of the line, so the error that
 * eventually surfaces names a bracket somewhere downstream instead.
 */
function noteDiagnostic(note: LexNote): Diagnostic {
  if (note.kind === "glued-comment") {
    return {
      severity: "error",
      code: "E_GLUED_COMMENT",
      message: "`--` with nothing before it starts a comment, discarding the rest of the line",
      line: note.line,
      hint: "put a space before `--` for a comment, or write `- -` to subtract a negative",
    };
  }
  return {
    severity: "error",
    code: "E_UNTERMINATED_STRING",
    message: `${note.raw} has no closing quote before the end of the line`,
    line: note.line,
    hint: "strings do not span lines; close it on the line it opens",
  };
}

/** Parse source text into statements, recovering from per-line syntax errors. */
export function parse(source: string): ParseResult {
  const { tokens, notes } = lex(source);
  const cursor = new Cursor(tokens);
  const statements: Stmt[] = [];
  const diagnostics: Diagnostic[] = notes.map(noteDiagnostic);

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

  // Lexer notes are collected up front, so sort back into source order — a list
  // that jumps from line 40 to line 3 reads as two unrelated failures.
  diagnostics.sort((a, b) => a.line - b.line);
  return { statements, diagnostics };
}

function parseStatement(cursor: Cursor): Stmt {
  const token = cursor.peek();
  if (token.kind !== "ident") {
    throw cursor.fail("E_SYNTAX", `expected a statement keyword but found ${describe(token)}`);
  }

  switch (token.value) {
    case "start":
      return parseStart(cursor);
    case "scene":
      return parseScene(cursor);
    case "level":
      return parseLevelStatement(cursor);
    case "stream":
      return parseStream(cursor);
    case "seed":
      return parseSeed(cursor);
    case "camera":
      return parseCamera(cursor);
    case "backdrop":
      return parseBackdrop(cursor);
    case "music":
      return parseMusic(cursor);
    case "sound":
      return parseSound(cursor);
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
        "statements start with start, seed, scene, level, stream, backdrop, music, sound, camera, create, control, or when",
      );
  }
}

function parseStart(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();
  const scene = cursor.expectIdent("a scene name");
  return { kind: "start", scene: scene.value, line };
}

function parseScene(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();
  const name = cursor.expectIdent("a scene name");
  return { kind: "scene", name: name.value, line };
}

/** `level <name> [in <scene>] from <file.dmtl>` */
function parseLevelStatement(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();
  const name = cursor.expectIdent("a level name");
  let scene: string | undefined;
  if (cursor.eatKeyword("in")) scene = cursor.expectIdent("a scene name").value;
  if (!cursor.eatKeyword("from")) {
    throw cursor.fail("E_SYNTAX", "a level needs a file", "e.g. `level cavern from cavern.dmtl`");
  }
  const file = cursor.expectIdent("a .dmtl filename");
  return { kind: "level", name: name.value, ...(scene ? { scene } : {}), file: file.raw, line };
}

/** `stream <name> [in <scene>] from <file>, <file>, … <n> wide|tall` */
function parseStream(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();
  const name = cursor.expectIdent("a level name");
  let scene: string | undefined;
  if (cursor.eatKeyword("in")) scene = cursor.expectIdent("a scene name").value;
  if (!cursor.eatKeyword("from")) {
    throw cursor.fail(
      "E_SYNTAX",
      "a stream needs chunks to draw from",
      "e.g. `stream course from gap.dmtl, pipe.dmtl 20 wide`",
    );
  }

  const files: string[] = [];
  do {
    files.push(cursor.expectIdent("a .dmtl filename").raw);
  } while (cursor.eatPunct(","));

  const count = cursor.peek();
  if (count.kind !== "number") {
    throw cursor.fail(
      "E_SYNTAX",
      `expected how many chunks to draw but found ${describe(count)}`,
      "e.g. `stream course from gap.dmtl, pipe.dmtl 20 wide`",
    );
  }
  cursor.next();

  // The axis is stated rather than inferred from the chunks' shape: a stack of
  // square chunks is ambiguous, and a game that reads "20 wide" says which way
  // it scrolls without the reader measuring anything.
  const axis = cursor.eatKeyword("wide") ? "wide" : cursor.eatKeyword("tall") ? "tall" : undefined;
  if (!axis) {
    throw cursor.fail("E_SYNTAX", "a stream is laid out `wide` or `tall`");
  }

  return {
    kind: "stream",
    name: name.value,
    ...(scene ? { scene } : {}),
    files,
    count: Math.trunc(Number(count.value)),
    axis,
    line,
  };
}

/** `seed <n>` */
function parseSeed(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();
  const value = cursor.peek();
  if (value.kind !== "number") {
    throw cursor.fail("E_SYNTAX", `expected a whole number but found ${describe(value)}`);
  }
  cursor.next();
  return { kind: "seed", value: Math.trunc(Number(value.value)), line };
}

/** `camera follows <object> [in <scene>]` */
function parseCamera(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();
  if (!cursor.eatKeyword("follows")) {
    throw cursor.fail("E_SYNTAX", "a camera follows something", "e.g. `camera follows player`");
  }
  const target = cursor.expectIdent("an object name");
  let scene: string | undefined;
  if (cursor.eatKeyword("in")) scene = cursor.expectIdent("a scene name").value;
  return { kind: "camera", target: target.value, ...(scene ? { scene } : {}), line };
}

/** `backdrop <file> [in <scene>]` */
function parseBackdrop(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();
  const file = cursor.expectIdent("an image filename");
  let scene: string | undefined;
  if (cursor.eatKeyword("in")) scene = cursor.expectIdent("a scene name").value;
  return { kind: "backdrop", file: file.raw, ...(scene ? { scene } : {}), line };
}

/** `music <file> [in <scene>]` */
function parseMusic(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();
  const file = cursor.expectIdent("a music filename");
  let scene: string | undefined;
  if (cursor.eatKeyword("in")) scene = cursor.expectIdent("a scene name").value;
  return { kind: "music", file: file.raw, ...(scene ? { scene } : {}), line };
}

/**
 * `sound <file> on <trigger> [in <scene>] [if <expr>]`
 *
 * The trigger is parsed by `when`'s own parser, so the two can never drift into
 * accepting different things — which is the point of reusing them rather than
 * inventing a smaller set for sounds.
 */
function parseSound(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();
  const file = cursor.expectIdent("a sound filename");
  if (!cursor.eatKeyword("on")) {
    throw cursor.fail(
      "E_SYNTAX",
      "a sound needs something to fire it",
      "e.g. `sound bounce.wav on ball hits paddle`",
    );
  }
  const event = parseEvent(cursor);

  let scene: string | undefined;
  if (cursor.eatKeyword("in")) scene = cursor.expectIdent("a scene name").value;

  let guard: Expr | undefined;
  if (cursor.eatKeyword("if")) guard = parseExpr(cursor, 0);

  return {
    kind: "sound",
    file: file.raw,
    event,
    ...(scene ? { scene } : {}),
    ...(guard === undefined ? {} : { guard }),
    line,
  };
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

/**
 * `when <trigger> [in <scene>] [if <expr>] then <assignments> [else <assignments>]`
 *
 * `then` is required and `else` is optional. The keyword costs a word and buys
 * a clear seam between the condition and the consequence — which matters most
 * on the long rules, where the trigger and the assignment list would otherwise
 * run together with nothing but a bracket between them.
 */
function parseWhen(cursor: Cursor): Stmt {
  const line = cursor.peek().line;
  cursor.next();

  const event = parseEvent(cursor);

  let scene: string | undefined;
  if (cursor.eatKeyword("in")) {
    scene = cursor.expectIdent("a scene name").value;
  }

  let guard: Expr | undefined;
  if (cursor.eatKeyword("if")) {
    guard = parseExpr(cursor, 0);
  }

  if (!cursor.eatKeyword("then")) {
    throw cursor.fail(
      "E_SYNTAX",
      `expected \`then\` but found ${describe(cursor.peek())}`,
      "a rule reads `when <trigger> then <assignments>`",
    );
  }
  const assignments = parseAssignmentList(cursor);

  let otherwise: Assignment[] | undefined;
  if (cursor.eatKeyword("else")) {
    otherwise = parseAssignmentList(cursor);
  }

  return {
    kind: "when",
    event,
    ...(scene === undefined ? {} : { scene }),
    ...(guard === undefined ? {} : { guard }),
    assignments,
    ...(otherwise === undefined ? {} : { otherwise }),
    line,
  };
}

function parseEvent(cursor: Cursor): Event {
  const first = cursor.peek();
  const second = cursor.peek(1);

  // `when <subject> hits|touches <a>, <b>, ...`
  if (
    first.kind === "ident" &&
    second.kind === "ident" &&
    (second.value === "hits" || second.value === "touches")
  ) {
    const level = second.value === "touches";
    cursor.next();
    cursor.next();
    const others: string[] = [];
    do {
      others.push(cursor.expectIdent("something to collide with").value);
    } while (cursor.eatPunct(","));
    // `from above, left` narrows the rule to contacts resolved on those sides.
    // It is parsed here rather than as part of the target list because a target
    // and a side are different vocabularies, and `from` is what separates them —
    // the same word `level ... from <file>` already uses for "drawn from".
    const sides: string[] = [];
    if (cursor.eatKeyword("from")) {
      do {
        sides.push(cursor.expectIdent("a side: above, below, left or right").value);
      } while (cursor.eatPunct(","));
    }
    return { kind: "hits", subject: first.value, others, level, sides };
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
    return noDuplicates(
      cursor,
      names.map((name, index) => {
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
      }),
    );
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

  return noDuplicates(
    cursor,
    columns.map((name, index) => ({
      name,
      value: provided[index] as Expr,
      line: lines[index] ?? 0,
    })),
  );
}

/**
 * Reject a list that names the same thing twice.
 *
 * `(x 1, x 9)` has an obvious reading — the last one wins — and that is exactly
 * why it has to be an error: the losing value is written down, in the file, and
 * does nothing. Every other "two of a thing that should be one" in the language
 * is an error already (`E_DUPLICATE_SCENE`, `E_DUPLICATE_INSTANCE`, and the
 * rest), and a property list is the one place where the mistake is easiest to
 * make, because the list is long and horizontal.
 *
 * The comparison is on the name as written, so `(ball1.x 1, ball2.x 9)` is two
 * different targets and fine. `direction` is not expanded here: it sets
 * `xdirection` and `ydirection`, but writing one of those next to it is a
 * legitimate way to say "south-west, but faster across", and the last write
 * wins in an order the reader can see on one line.
 */
function noDuplicates(cursor: Cursor, pairs: Prop[]): Prop[] {
  const seen = new Map<string, number>();
  for (const pair of pairs) {
    const first = seen.get(pair.name);
    if (first !== undefined) {
      throw cursor.fail(
        "E_DUPLICATE_PROP",
        `'${pair.name}' is set twice in one list`,
        first === pair.line
          ? "the second value wins and the first does nothing"
          : `already set on line ${first}; the second value wins and the first does nothing`,
      );
    }
    seen.set(pair.name, pair.line);
  }
  return pairs;
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

/**
 * Assignments after `then` or `else`.
 *
 * Brackets are optional for a single `name as value`, because `then xdirection
 * as flip` is the common case and the brackets add nothing. They stay required
 * for the `(name value)` pair form, where they are what marks the boundary
 * between one pair and the next.
 */
function parseAssignmentList(cursor: Cursor): Assignment[] {
  if (cursor.atStatementEnd()) return [];

  if (!cursor.atPunct("(")) {
    const name = cursor.expectIdent("a property to set");
    if (!cursor.eatKeyword("as")) {
      throw cursor.fail(
        "E_SYNTAX",
        `expected \`as\` after '${name.raw}'`,
        "without brackets a rule sets exactly one property: `then speed as 0`",
      );
    }
    return [{ target: splitTarget(name.value, name.line), value: parseExpr(cursor, 0) }];
  }

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
    // Attached and *not* a unit: nothing else in the language runs a word onto
    // the end of a number, so this is a typo the parser can name. Left alone it
    // surfaces as a stray token later and the error blames the bracket that
    // noticed it. A dot in the word means an asset was meant — `8bit.png` is one
    // filename to a reader and a number to the lexer, because a name has to
    // start with a letter — and quoting it is the fix, not a unit.
    if (next.kind === "ident" && !next.spaceBefore) {
      const glued = `${token.raw}${next.raw}`;
      if (next.value.includes(".")) {
        throw cursor.fail(
          "E_SYNTAX",
          `'${glued}' is not a name; names start with a letter or an underscore`,
          `quote it if it is a filename: "${glued}"`,
        );
      }
      throw cursor.fail(
        "E_UNKNOWN_UNIT",
        `'${next.raw}' is not a unit`,
        `units are: ${UNIT_LIST} — or leave it off for cells`,
      );
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
  const { tokens, notes } = lex(source);
  const note = notes[0];
  if (note) return { error: { ...noteDiagnostic(note), line } };
  const cursor = new Cursor(tokens);
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
