/**
 * Syntax scopes for a Demakefile, for any surface that wants to colour one.
 *
 * The counterpart of `lang/highlight.ts`, under the same two rules and for the
 * same reasons. **The scope names are TextMate's**, so a theme written for the
 * game source colours a build file too and the page keeps one stylesheet; and
 * **grammar here, theme elsewhere** — this module says a word is a
 * `storage.type` and never what colour that is.
 *
 * **Every word it knows comes from the parser's own lists** (`model.ts`), and
 * where a comment starts is `parse.ts`'s own `uncomment`. That is the whole of
 * why this can exist without becoming a second description of the format: a
 * directive added to the grammar is coloured the day it is added, and a file is
 * never coloured differently from how it is read.
 *
 * It is *lexical* and it never parses, so it colours a file that does not parse
 * — the state an editor spends most of its time in. The one piece of context it
 * keeps is the block a line sits inside, taken from indentation alone:
 * `strategy` under `art ball` is an option and `art` under `defaults` is a
 * domain, and nothing further up the file changes either answer.
 */

import type { HighlightSpan, Scope } from "../lang/highlight.js";
import {
  BLOCK_DIRECTIVES,
  DOMAINS,
  FOR_KEYWORD,
  SINGLE_DIRECTIVES,
  TARGET_FIELDS,
  TARGETS_DIRECTIVE,
} from "./model.js";
import { uncomment } from "./parse.js";

/** What a line opened, which is all the context a nested line needs. */
type Block =
  | "project"
  | "defaults"
  | "defaults-domain"
  | "target"
  | "target-header"
  | "asset"
  | "asset-for"
  | "unknown";

/** One block on the stack: what it was, and how far its header was indented. */
interface Frame {
  block: Block;
  columns: number;
}

/** A range of the source carrying one scope. */
interface Range {
  start: number;
  end: number;
  scope: Scope | null;
}

/** A word, with where it sat on the line. */
interface Word {
  text: string;
  start: number;
  end: number;
  /** True when the word was written in double quotes, which the parser strips. */
  quoted: boolean;
}

const NUMERIC = /^-?\d+(?:\.\d+)?$/;

const DOMAIN_WORDS: readonly string[] = DOMAINS;

/**
 * Scope a whole Demakefile.
 *
 * Never throws and never rejects input; the spans tile the source exactly, so
 * concatenating their `text` gives the file back character for character — the
 * same contract {@link HighlightSpan} states for the game language.
 */
export function highlightDemakefile(source: string): HighlightSpan[] {
  const ranges: Range[] = [];
  const stack: Frame[] = [];
  let at = 0;

  for (const raw of source.split("\n")) {
    scanLine(raw, at, stack, ranges);
    at += raw.length + 1; // the newline the split consumed
  }

  return toSpans(source, ranges);
}

/** Scope one physical line, and update the block stack it belongs to. */
function scanLine(raw: string, offset: number, stack: Frame[], ranges: Range[]): void {
  const code = uncomment(raw);

  // A trailing comment, and a whole-line one. Either way it belongs to whatever
  // comes next and opens nothing, so a comment never touches the stack.
  if (code.length < raw.length) {
    const hash = raw.indexOf("#", Math.max(0, code.length - 1));
    if (hash >= 0) {
      ranges.push({
        start: offset + hash,
        end: offset + raw.trimEnd().length,
        scope: "comment.line.number-sign",
      });
    }
  }
  if (code.trim() === "") return;

  const columns = (/^[\t ]*/.exec(code)?.[0] ?? "").length;
  while (stack.length > 0 && (stack[stack.length - 1] as Frame).columns >= columns) stack.pop();

  const line = splitWords(code, offset);
  if (line.length === 0) return;

  const opened =
    columns === 0
      ? scopeTopLevel(line, ranges)
      : scopeNested(stack[stack.length - 1]?.block ?? "unknown", line, ranges);
  if (opened !== null) stack.push({ block: opened, columns });
}

/**
 * Colour a line at column zero, and say which block it opened.
 *
 * Doc 15's top-level grammar, in the order that document introduces it: the
 * directives that take a value, the shorthand that declares targets, and the
 * six words that open a block.
 */
function scopeTopLevel(line: readonly Word[], ranges: Range[]): Block | null {
  const first = line[0] as Word;
  const rest = line.slice(1);
  const keyword = first.text.toLowerCase();

  if (SINGLE_DIRECTIVES.has(keyword)) {
    push(ranges, first, "keyword.other");
    for (const word of rest) push(ranges, word, "string.unquoted");
    return null;
  }

  if (keyword === TARGETS_DIRECTIVE) {
    push(ranges, first, "keyword.other");
    for (const word of rest) push(ranges, word, "entity.name.section");
    return null;
  }

  if (BLOCK_DIRECTIVES.has(keyword)) {
    push(ranges, first, "storage.type");
    // What the name *is* differs by block, and the distinction is worth drawing:
    // an asset block names a file, a target names a console, a project itself.
    const scope: Scope =
      keyword === "target"
        ? "entity.name.section"
        : keyword === "project"
          ? "entity.name.type"
          : "string.unquoted";
    if (keyword !== "defaults") for (const word of rest) push(ranges, word, scope);
    if (keyword === "project") return "project";
    if (keyword === "defaults") return "defaults";
    if (keyword === "target") return "target";
    return "asset";
  }

  // A word that opens nothing the grammar knows: left unscoped rather than
  // guessed at, and `E_UNKNOWN_DIRECTIVE` is what says so properly.
  for (const word of line) push(ranges, word, null);
  return "unknown";
}

/** Colour an indented line, given the block it sits in. */
function scopeNested(parent: Block, line: readonly Word[], ranges: Range[]): Block | null {
  const first = line[0] as Word;
  const rest = line.slice(1);
  const keyword = first.text.toLowerCase();

  if (parent === "defaults" && line.length === 1 && DOMAIN_WORDS.includes(keyword)) {
    push(ranges, first, "storage.type");
    return "defaults-domain";
  }

  if (parent === "target" && TARGET_FIELDS.has(keyword)) {
    push(ranges, first, "keyword.other");
    if (keyword === "output") {
      if (rest[0]) push(ranges, rest[0], "constant.language");
      for (const word of rest.slice(1)) push(ranges, word, "string.unquoted");
    } else {
      scopeValue(ranges, rest);
    }
    return keyword === "header" ? "target-header" : null;
  }

  if (parent === "asset" && keyword === FOR_KEYWORD) {
    push(ranges, first, "keyword.control");
    for (const word of rest) push(ranges, word, "entity.name.section");
    return "asset-for";
  }

  // Everything else nested is an option: a name, and a value absorbing the rest.
  push(ranges, first, "variable.other.property");
  scopeValue(ranges, rest);
  return null;
}

/** The value half of an option, which is a number, a quoted string, or a word. */
function scopeValue(ranges: Range[], words: readonly Word[]): void {
  for (const word of words) {
    push(
      ranges,
      word,
      word.quoted
        ? "string.quoted"
        : NUMERIC.test(word.text)
          ? "constant.numeric"
          : "string.unquoted",
    );
  }
}

function push(ranges: Range[], word: Word, scope: Scope | null): void {
  ranges.push({ start: word.start, end: word.end, scope });
}

/**
 * Split a line into words, keeping each one's offset.
 *
 * The parser's own rule — whitespace separates, a double-quoted run is one word
 * — with the positions it throws away kept, because a highlighter needs them and
 * a parser does not.
 */
function splitWords(text: string, offset: number): Word[] {
  const out: Word[] = [];
  let at = 0;
  while (at < text.length) {
    while (at < text.length && /\s/.test(text[at] as string)) at += 1;
    if (at >= text.length) break;
    if (text[at] === '"') {
      const close = text.indexOf('"', at + 1);
      const end = close < 0 ? text.length : close + 1;
      out.push({
        text: text.slice(at + 1, close < 0 ? end : close),
        start: offset + at,
        end: offset + end,
        quoted: true,
      });
      at = end;
      continue;
    }
    let end = at;
    while (end < text.length && !/\s/.test(text[end] as string)) end += 1;
    out.push({ text: text.slice(at, end), start: offset + at, end: offset + end, quoted: false });
    at = end;
  }
  return out;
}

/** Turn scoped ranges into spans that tile the source, merging neighbours. */
function toSpans(source: string, ranges: Range[]): HighlightSpan[] {
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const spans: HighlightSpan[] = [];
  let cursor = 0;
  const add = (text: string, scope: Scope | null): void => {
    if (text.length === 0) return;
    const last = spans[spans.length - 1];
    // Merge neighbours that agree, so a run of indentation is one span rather
    // than one per character.
    if (last && last.scope === scope) last.text += text;
    else spans.push({ text, scope });
  };
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    add(source.slice(cursor, range.start), null);
    add(source.slice(Math.max(cursor, range.start), range.end), range.scope);
    cursor = range.end;
  }
  add(source.slice(cursor), null);
  return spans;
}
