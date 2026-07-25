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
 * becomes a `punct` token that the parser reports in context, which keeps
 * error recovery a parser concern rather than something split across two
 * phases.
 */
export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;

  const push = (kind: TokenKind, value: string, raw = value): void => {
    tokens.push({ kind, value, raw, line });
  };

  while (i < source.length) {
    const c = source[i] as string;

    if (c === "\n") {
      push("newline", "\n");
      i += 1;
      line += 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i += 1;
      continue;
    }

    // `--` comment to end of line.
    if (c === "-" && source[i + 1] === "-") {
      while (i < source.length && source[i] !== "\n") i += 1;
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
      push("string", text, source.slice(i, Math.min(j + 1, source.length)));
      i = source[j] === quote ? j + 1 : j;
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

  push("eof", "");
  return tokens;
}
