/**
 * Syntax scopes for Demotic source, for any surface that wants to colour it.
 *
 * **The scope names are TextMate's**, the convention every editor, every theme
 * and every highlighting library already speaks (`keyword.control`,
 * `string.quoted`, `constant.numeric`, …). That is the whole reason to use it: a
 * theme matches on scope *prefixes*, so a consumer that knows nothing about this
 * language can colour it correctly, and a future editor extension or `.tmLanguage`
 * file is a translation of this table rather than a second grammar.
 *
 * **Grammar here, theme elsewhere.** This module says a token is a
 * `keyword.control`; it never says what colour that is. The web app's stylesheet
 * makes that call, which is what lets one grammar serve a light page, a dark page
 * and a terminal (doc 07 §The web app must never grow conversion logic — a
 * highlighter that lived in the page would be a second description of the
 * language, and the registry exists so there is only ever one).
 *
 * **It runs on the lexer, not on a regular expression.** Every word it knows
 * comes from `spec.ts` and every token boundary comes from `lex()`, so a keyword
 * added to the registry is highlighted the day it is added, and the one thing a
 * regex highlighter always gets wrong here — `y--1` is a comment, `y - -1` is
 * not — is decided in exactly one place (`lex.ts`).
 *
 * It is *lexical*, deliberately: it never compiles, so it colours a program that
 * does not parse, which is the state an editor spends most of its time in. Where
 * a word's meaning depends on position rather than spelling — `start` is a
 * statement and a button, `scene` is a statement and an assignment target,
 * `left` is a button and a derived property — it looks at the token before it
 * and no further.
 */

import {
  BUTTON_NAMES,
  CONSTANTS,
  DIRECTIONS,
  EDGE_NAMES,
  FUNCTION_ARITY,
  KEYWORD_NAMES,
  PROPERTIES,
  STATEMENT_KEYWORDS,
  TARGET_WORD_NAMES,
  UNIT_NAMES,
  VALUE_WORD_NAMES,
} from "./spec.js";
import { lex, type Token } from "./lex.js";

/**
 * Every scope this grammar emits, as TextMate spells them.
 *
 * Kept flat and small on purpose: a theme with a rule per entry is a dozen
 * lines, and prefix matching (`keyword`, `string`, `constant`) collapses it
 * further for anyone who wants fewer colours.
 *
 * **It is the repo's scope vocabulary, not this grammar's.** The Demakefile
 * highlighter (`demakefile/highlight.ts`) emits from the same union, so one
 * theme colours a game and its build file and neither surface needs a second
 * stylesheet. Only the comment syntax differs, which is why there are two of
 * those and one of everything else.
 */
export type Scope =
  | "comment.line.double-dash"
  | "comment.line.number-sign"
  | "constant.language"
  | "constant.numeric"
  | "entity.name.section"
  | "entity.name.type"
  | "keyword.control"
  | "keyword.operator"
  | "keyword.other"
  | "keyword.other.unit"
  | "punctuation"
  | "storage.type"
  | "string.quoted"
  | "string.unquoted"
  | "support.constant"
  | "support.function"
  | "variable.other"
  | "variable.other.property";

/**
 * One run of source text, with the scope it carries.
 *
 * Spans tile the source exactly — concatenating their `text` reproduces the
 * input character for character, whitespace and all — so a consumer renders
 * them in order and is done. `scope` is `null` for the parts that carry no
 * meaning of their own: spaces, newlines, and anything the lexer could not
 * make sense of.
 */
export interface HighlightSpan {
  text: string;
  scope: Scope | null;
}

/** Compass headings, which are values wherever they appear. */
const DIRECTION_NAMES: ReadonlySet<string> = new Set(DIRECTIONS.map((d) => d.name));

/** Assignable and derived property names, for the `variable.other.property` scope. */
const PROPERTY_NAMES: ReadonlySet<string> = new Set(PROPERTIES.map((p) => p.name));

/** Properties whose value is a filename, so the value after them is a string. */
const ASSET_PROPS: ReadonlySet<string> = new Set(
  PROPERTIES.filter((p) => p.kind === "asset").map((p) => p.name),
);

/** Constants and screen edges — bare names the compiler resolves to numbers. */
const SUPPORT_NAMES: ReadonlySet<string> = new Set([
  ...CONSTANTS.map((c) => c.name),
  ...EDGE_NAMES,
]);

/** Statements whose word immediately after the keyword is a filename. */
const FILE_STATEMENTS: ReadonlySet<string> = new Set(["backdrop", "music", "sound"]);

/** Statements whose filenames come after `from`. */
const FROM_STATEMENTS: ReadonlySet<string> = new Set(["level", "stream"]);

/** Statement keywords that read as flow rather than as a declaration. */
const CONTROL_STATEMENTS: ReadonlySet<string> = new Set(["when"]);

/** Clause keywords that read as flow rather than as glue. */
const CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "else",
  "hits",
  "touches",
  "pressed",
  "released",
  "reaches",
]);

/** Where in a statement the scanner is, which is all the context it keeps. */
interface Context {
  /** The statement's leading keyword, or "" on a line that starts otherwise. */
  statement: string;
  /** Index of this token within the statement, newlines excluded. */
  index: number;
  /** The previous non-newline token, or undefined at the start of a statement. */
  previous: Token | undefined;
  /** The token before that. */
  before: Token | undefined;
  /** True once `from` has been seen on this line. */
  afterFrom: boolean;
}

/**
 * Scope a whole source file.
 *
 * Never throws and never rejects input: the lexer does not fail, and anything it
 * cannot classify comes back as an unscoped span. Half-typed source is the
 * normal case for an editor, not an error.
 */
export function highlight(source: string): HighlightSpan[] {
  const { tokens, comments } = lex(source);

  // Tokens and comments interleave by offset. Comments never overlap a token —
  // the lexer consumed them as whitespace — so a merge by start offset is a
  // total order, and the gaps between are the whitespace.
  const ranges: { start: number; end: number; scope: Scope | null }[] = [];
  for (const comment of comments) {
    ranges.push({ start: comment.start, end: comment.end, scope: "comment.line.double-dash" });
  }

  const context: Context = {
    statement: "",
    index: 0,
    previous: undefined,
    before: undefined,
    afterFrom: false,
  };

  for (const token of tokens) {
    if (token.kind === "eof") continue;
    if (token.kind === "newline") {
      context.statement = "";
      context.index = 0;
      context.previous = undefined;
      context.before = undefined;
      context.afterFrom = false;
      continue;
    }
    if (context.index === 0 && token.kind === "ident" && STATEMENT_KEYWORDS.has(token.value)) {
      context.statement = token.value;
    }
    ranges.push({ start: token.start, end: token.end, scope: scopeOf(token, context) });
    if (token.kind === "ident" && token.value === "from") context.afterFrom = true;
    context.before = context.previous;
    context.previous = token;
    context.index += 1;
  }

  ranges.sort((a, b) => a.start - b.start);

  const spans: HighlightSpan[] = [];
  let cursor = 0;
  const push = (text: string, scope: Scope | null): void => {
    if (text.length === 0) return;
    const last = spans[spans.length - 1];
    // Merge neighbours that agree, so a run of whitespace and newlines is one
    // span rather than one per character.
    if (last && last.scope === scope) last.text += text;
    else spans.push({ text, scope });
  };

  for (const range of ranges) {
    push(source.slice(cursor, range.start), null);
    // A dotted name is several things at once — `ball1.centerx` is an object and
    // a property — so it is the one token that becomes more than one span.
    if (range.scope === "variable.other") {
      pushDotted(push, source.slice(range.start, range.end));
    } else {
      push(source.slice(range.start, range.end), range.scope);
    }
    cursor = range.end;
  }
  push(source.slice(cursor), null);
  return spans;
}

/** Split `a.b.c` so the last part can be a property and the dots punctuation. */
function pushDotted(push: (text: string, scope: Scope | null) => void, text: string): void {
  if (!text.includes(".")) {
    push(text, "variable.other");
    return;
  }
  const parts = text.split(".");
  parts.forEach((part, i) => {
    if (i > 0) push(".", "punctuation");
    const last = i === parts.length - 1;
    push(
      part,
      last && PROPERTY_NAMES.has(part.toLowerCase()) ? "variable.other.property" : "variable.other",
    );
  });
}

/** The scope for one token, given where in its statement it sits. */
function scopeOf(token: Token, context: Context): Scope | null {
  switch (token.kind) {
    case "string":
      return "string.quoted";
    case "number":
      return "constant.numeric";
    case "op":
      return "keyword.operator";
    case "punct":
      return "punctuation";
    case "ident":
      return identScope(token, context);
    default:
      return null;
  }
}

function identScope(token: Token, context: Context): Scope {
  const word = token.value;
  const previous = context.previous;
  const previousWord = previous?.kind === "ident" ? previous.value : undefined;

  // A filename, decided by the slot it sits in rather than by its extension —
  // which is the compiler's own rule (see `compile.ts`), and the reason
  // `sprite ball.svg` needs no quotes.
  if (isFilename(context)) return "string.unquoted";

  // First position: a statement keyword is a keyword only here.
  if (context.index === 0 && STATEMENT_KEYWORDS.has(word)) {
    return CONTROL_STATEMENTS.has(word) ? "keyword.control" : "storage.type";
  }

  // A unit is a word stuck to a number — `15vw` or `15 vw`. Testing the token
  // before it rather than the spelling is what stops a scene called `vw` from
  // turning blue.
  if (previous?.kind === "number" && UNIT_NAMES.has(word)) return "keyword.other.unit";

  if (word === "object" && context.statement === "create" && context.index === 1) {
    return "storage.type";
  }

  if (KEYWORD_NAMES.has(word)) {
    return CONTROL_KEYWORDS.has(word) ? "keyword.control" : "keyword.other";
  }

  // A scene's name: the thing `scene` and `start` declare, what `in` narrows to,
  // and what `scene as` switches to.
  if (previousWord === "in") return "entity.name.section";
  if (context.index === 1 && (context.statement === "scene" || context.statement === "start")) {
    return "entity.name.section";
  }
  if (previousWord === "as" && context.before?.value === "scene") return "entity.name.section";

  // A class: what `create object` declares and what `create` instantiates.
  if (context.statement === "create") {
    if (context.index === 1) return "entity.name.type";
    if (context.index === 2 && previousWord === "object") return "entity.name.type";
  }

  if (word in FUNCTION_ARITY) return "support.function";
  if (VALUE_WORD_NAMES.has(word) || DIRECTION_NAMES.has(word)) return "constant.language";

  // A button, in the two places one can appear: before `pressed`/`released`, and
  // as a `control`'s second argument. Both matter because four of the seven are
  // also derived properties.
  if (BUTTON_NAMES.includes(word) && isButtonSlot(context)) return "support.constant";

  if (SUPPORT_NAMES.has(word)) return "support.constant";
  if (TARGET_WORD_NAMES.has(word)) return "variable.other.property";
  if (PROPERTY_NAMES.has(word)) return "variable.other.property";
  return "variable.other";
}

/** True where the grammar expects a filename rather than a name. */
function isFilename(context: Context): boolean {
  if (FILE_STATEMENTS.has(context.statement) && context.index === 1) return true;
  const previous = context.previous;
  // A `stream` takes a comma-separated list, so the slot is "just after `from`
  // or just after a comma" rather than "anywhere after `from`" — otherwise the
  // `wide` that closes the statement reads as one more file.
  if (FROM_STATEMENTS.has(context.statement) && context.afterFrom) {
    if (previous?.value === "from" || previous?.value === ",") return true;
  }
  return previous?.kind === "ident" && ASSET_PROPS.has(previous.value);
}

/** True where a button name is the thing being read, not a property. */
function isButtonSlot(context: Context): boolean {
  if (context.statement === "control" && context.index === 2) return true;
  // `when a pressed` — the trigger word follows, so the previous token is what
  // the button sits between. The scanner has no lookahead, so this reads the
  // other way round: `pressed`/`released` are keywords wherever they appear, and
  // a button is whatever came directly before one at the head of a `when`.
  return context.statement === "when" && context.index === 1;
}
