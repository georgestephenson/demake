/**
 * Lexer.
 *
 * Line-oriented: newlines are significant (they terminate statements) and
 * `--` starts a comment that runs to end of line. Identifiers are folded to
 * lower case — the language is case-insensitive throughout, keywords and
 * identifiers alike — but the original spelling is kept for diagnostics.
 *
 * Dotted names (`ball1.x`, `ball.png`) lex as a single identifier token. That
 * is what lets an unquoted asset filename work as a value: the *compiler*
 * decides, from the property being assigned, whether `ball.png` means "the `png`
 * property of `ball`" or the literal string `"ball.png"` (see `compile.ts`).
 *
 * **A comment must be preceded by a space, or start the line.** `--` shares its
 * spelling with two minus signs, so `y--1` is a comment where the author almost
 * certainly meant `y - -1`, and the statement quietly loses its tail rather than
 * failing. The lexer cannot know which was meant, so it does the one thing that
 * is always safe: it lexes the comment and *records* that it was glued to the
 * token before it, leaving the parser to report it. Notes work the same way for
 * a string with no closing quote, which would otherwise be blamed on whatever
 * token the runaway string swallowed.
 *
 * Tokens carry their source offsets and comments are kept as ranges, neither of
 * which the parser reads. Both are here so `highlight.ts` can colour source
 * without a second scanner — and a second scanner is exactly how the `y--1`
 * rule above would come to have two answers.
 */

/** Token kinds produced by {@link lex}. */
export type TokenKind = "ident" | "number" | "string" | "punct" | "op" | "newline" | "eof";

/** A lexed token. */
export interface Token {
  kind: TokenKind;
  /** Lower-cased text for `ident`; raw text otherwise. */
  value: string;
  /** Original source spelling, for diagnostics. */
  raw: string;
  /** 1-indexed source line. */
  line: number;
  /**
   * Whitespace, a comment, or the start of a line separates this token from the
   * one before it. `40vmn` is a number and an identifier with nothing between
   * them, which is what tells the parser a unit was meant.
   */
  spaceBefore: boolean;
  /** Offset of the token's first character in the source. */
  start: number;
  /** Offset one past its last character. */
  end: number;
}

/** Something the lexer noticed that only the parser can judge. */
export type LexNoteKind = "glued-comment" | "unterminated-string";

/** A lexer observation, reported as a diagnostic by {@link parse}. */
export interface LexNote {
  kind: LexNoteKind;
  /** 1-indexed source line. */
  line: number;
  /** The source text the note is about, for the message. */
  raw: string;
}

/**
 * A comment, as a source range.
 *
 * The parser has no use for these — a comment is whitespace to it — but the
 * highlighter does, and a second scanner that had to re-decide where a comment
 * starts would be a second answer to `y--1` (see the note above). Keeping them
 * here costs one array and makes the lexer the only thing in the package that
 * knows what a comment looks like.
 */
export interface Comment {
  start: number;
  end: number;
  line: number;
}

/** Tokens, plus whatever the lexer noticed on the way. */
export interface LexResult {
  tokens: Token[];
  notes: LexNote[];
  comments: Comment[];
}

const PUNCT = new Set(["(", ")", ","]);

/** Multi-character operators, longest first so `<=` beats `<`. */
const OPERATORS = ["<=", ">=", "!=", "<>", "+", "-", "*", "/", "<", ">", "="];

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}

function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_.]/.test(c);
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/**
 * Tokenize source text. The lexer never fails: an unrecognized character
 * becomes a `punct` token that the parser reports in context, and anything it
 * merely finds suspicious becomes a {@link LexNote}. Either way the judgement
 * is the parser's, which keeps error recovery one phase's concern rather than
 * something split across two.
 */
export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const notes: LexNote[] = [];
  const comments: Comment[] = [];
  let i = 0;
  let line = 1;
  // True when whitespace, a comment or a line start separates the next token
  // from the previous one. The start of the file counts.
  let gap = true;
  // Where the token being pushed began. Set by each branch before it pushes,
  // since `i` has usually already run past the token by then.
  let from = 0;

  const push = (kind: TokenKind, value: string, raw = value): void => {
    tokens.push({ kind, value, raw, line, spaceBefore: gap, start: from, end: from + raw.length });
    gap = false;
  };

  while (i < source.length) {
    const c = source[i] as string;
    from = i;

    if (c === "\n") {
      push("newline", "\n");
      i += 1;
      line += 1;
      gap = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i += 1;
      gap = true;
      continue;
    }

    // `--` comment to end of line. Glued to the token before it, this is far
    // more likely to be a subtraction the author is about to lose than a
    // comment they meant, so the parser is told either way.
    if (c === "-" && source[i + 1] === "-") {
      const start = i;
      while (i < source.length && source[i] !== "\n") i += 1;
      if (!gap) notes.push({ kind: "glued-comment", line, raw: source.slice(start, i) });
      comments.push({ start, end: i, line });
      gap = true;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let text = "";
      while (j < source.length && source[j] !== quote && source[j] !== "\n") {
        text += source[j];
        j += 1;
      }
      const closed = source[j] === quote;
      push("string", text, source.slice(i, Math.min(j + 1, source.length)));
      if (!closed) notes.push({ kind: "unterminated-string", line, raw: source.slice(i, j) });
      i = closed ? j + 1 : j;
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      let j = i;
      while (j < source.length && (isDigit(source[j] as string) || source[j] === ".")) j += 1;
      const raw = source.slice(i, j);
      push("number", raw);
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < source.length && isIdentPart(source[j] as string)) j += 1;
      const raw = source.slice(i, j);
      push("ident", raw.toLowerCase(), raw);
      i = j;
      continue;
    }

    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (op) {
      push("op", op === "<>" ? "!=" : op, op);
      i += op.length;
      continue;
    }

    if (PUNCT.has(c)) {
      push("punct", c);
      i += 1;
      continue;
    }

    // Unknown character: emit it so the parser can produce a located error.
    push("punct", c);
    i += 1;
  }

  from = source.length;
  push("eof", "");
  return { tokens, notes, comments };
}
