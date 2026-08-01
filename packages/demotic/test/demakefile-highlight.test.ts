/**
 * The Demakefile highlighter (doc 19 §The Demakefile is also just a file).
 *
 * Two things are checked here and they are not the same thing. The first is the
 * property every consumer rests on — the spans tile the file exactly, so drawing
 * them behind a textarea cannot silently edit it. The second is that the grammar
 * it colours is the grammar the *parser* reads: the word lists come from
 * `model.ts` and this file asserts that every one of them is coloured, so a
 * directive added to the format cannot arrive uncoloured.
 */

import { describe, expect, it } from "vitest";

import { highlightDemakefile } from "../src/demakefile/highlight.js";
import { emitDemakefile } from "../src/demakefile/emit.js";
import { parseDemakefile } from "../src/demakefile/parse.js";
import {
  BLOCK_DIRECTIVES,
  DOMAINS,
  SINGLE_DIRECTIVES,
  TARGET_FIELDS,
  TARGETS_DIRECTIVE,
} from "../src/demakefile/model.js";
import type { Scope } from "../src/lang/highlight.js";

const FILE = `# Demakefile — how this game reaches real hardware.
project pong
  title  Pong
  author "A Person"

source  src/pong.dmt
out     build
targets gb nes md

target gbc
  console gbc
  region  ntsc
  output  rom pong.gbc
  header
    title  PONG

defaults
  art
    dither  bayer4
    effort  max
  music
    strategy auto

art ball.svg      # the ball, and nothing else
  dither  none
  for nes
    effort  fast
`;

/** The scopes a file produces, in order, ignoring the unscoped whitespace. */
function scopes(source: string): { text: string; scope: Scope }[] {
  return highlightDemakefile(source).flatMap((span) =>
    span.scope ? [{ text: span.text, scope: span.scope }] : [],
  );
}

/** The scope covering the first occurrence of a word. */
function scopeOf(source: string, text: string): Scope | undefined {
  return scopes(source).find((span) => span.text === text)?.scope;
}

describe("highlightDemakefile", () => {
  it("tiles the source exactly", () => {
    expect(
      highlightDemakefile(FILE)
        .map((span) => span.text)
        .join(""),
    ).toBe(FILE);
  });

  it("tiles an empty file, a file of comments and a file with no trailing newline", () => {
    for (const source of ["", "\n\n", "# just a note\n", "out build", "  \t \n"]) {
      expect(
        highlightDemakefile(source)
          .map((span) => span.text)
          .join(""),
        JSON.stringify(source),
      ).toBe(source);
    }
  });

  it("colours every directive the parser knows", () => {
    // The check that stops the two descriptions drifting: the highlighter's word
    // lists *are* the parser's, and a word with no scope here is a word the
    // editor would draw as plain text while the build acted on it.
    for (const name of [...SINGLE_DIRECTIVES]) {
      expect(scopeOf(`${name} something\n`, name), name).toBe("keyword.other");
    }
    for (const name of [...BLOCK_DIRECTIVES]) {
      expect(scopeOf(`${name} something\n`, name), name).toBe("storage.type");
    }
    expect(scopeOf(`${TARGETS_DIRECTIVE} gb nes\n`, TARGETS_DIRECTIVE)).toBe("keyword.other");
    for (const field of [...TARGET_FIELDS]) {
      const source = `target gb\n  ${field} value\n`;
      expect(scopeOf(source, field), field).toBe("keyword.other");
    }
    for (const domain of DOMAINS) {
      expect(scopeOf(`defaults\n  ${domain}\n    effort max\n`, domain), domain).toBe(
        "storage.type",
      );
    }
  });

  it("reads a word by where it sits, not by how it is spelled", () => {
    // `art` is a block at column zero and a domain under `defaults`; both are
    // `storage.type`. What must differ is `art` the *asset name* — a filename.
    expect(scopeOf("art ball.svg\n", "ball.svg")).toBe("string.unquoted");
    expect(scopeOf("target gb\n", "gb")).toBe("entity.name.section");
    expect(scopeOf("targets gb nes\n", "nes")).toBe("entity.name.section");
    expect(scopeOf("project pong\n", "pong")).toBe("entity.name.type");

    // An option is a property wherever it appears, and its value is a value.
    expect(scopeOf("art ball\n  dither none\n", "dither")).toBe("variable.other.property");
    expect(scopeOf("art ball\n  dither none\n", "none")).toBe("string.unquoted");
    expect(scopeOf("music theme\n  drop 4\n", "4")).toBe("constant.numeric");
    // Quotes are part of the span, because the spans have to tile the file —
    // the parser strips them, a highlighter drawn behind the text cannot.
    expect(scopeOf('project pong\n  title "Two Words"\n', '"Two Words"')).toBe("string.quoted");
  });

  it("scopes `for` as flow and the target it names as a target", () => {
    const source = "targets nes\nart ball\n  for nes\n    effort fast\n";
    expect(scopeOf(source, "for")).toBe("keyword.control");
    expect(
      scopes(source)
        .filter((s) => s.text === "nes")
        .at(-1)?.scope,
    ).toBe("entity.name.section");
  });

  it("colours a whole-line comment and a trailing one", () => {
    const found = scopes("# a note\nout build  # and another\n").filter(
      (span) => span.scope === "comment.line.number-sign",
    );
    expect(found.map((span) => span.text)).toEqual(["# a note", "# and another"]);
  });

  it("leaves a directive it does not know unscoped rather than guessing", () => {
    // The parser reports `E_UNKNOWN_DIRECTIVE` for this; a highlighter that
    // coloured it would be telling the reader it was fine.
    expect(scopeOf("nonsense value\n", "nonsense")).toBeUndefined();
  });

  it("colours what `demake init` writes, whitespace and all", () => {
    // A canonical file is what most Demakefiles in the wild will be, and it is
    // the one the page creates on the first changed option (doc 19).
    const canonical = emitDemakefile(parseDemakefile(FILE));
    expect(
      highlightDemakefile(canonical)
        .map((span) => span.text)
        .join(""),
    ).toBe(canonical);
  });
});
