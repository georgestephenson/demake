import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { highlight, type Scope } from "../src/lang/highlight.js";
import {
  BUTTON_NAMES,
  CONSTANTS,
  DIRECTIONS,
  FUNCTIONS,
  KEYWORDS,
  PROPERTIES,
  STATEMENTS,
  UNITS,
} from "../src/lang/spec.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

const GAMES = [
  "pong.dmt",
  "games/breakout.dmt",
  "games/platformer.dmt",
  "games/dodger.dmt",
  "games/shooter.dmt",
  "games/caves.dmt",
  "games/runner.dmt",
];

/** The scopes a source produces, in order, ignoring the unscoped whitespace. */
function scopes(source: string): { text: string; scope: Scope }[] {
  return highlight(source).flatMap((span) =>
    span.scope ? [{ text: span.text, scope: span.scope }] : [],
  );
}

/** The scope covering the first occurrence of a word. */
function scopeOf(source: string, text: string): Scope | undefined {
  return scopes(source).find((span) => span.text === text)?.scope;
}

describe("highlight", () => {
  it("tiles the source exactly", () => {
    // The one property every consumer depends on: rendering the spans in order
    // reproduces the file. A highlighter that drops a character silently edits
    // whatever it is drawn behind.
    for (const game of GAMES) {
      const source = readFileSync(`${FIXTURES}${game}`, "utf8");
      expect(
        highlight(source)
          .map((span) => span.text)
          .join(""),
        game,
      ).toBe(source);
    }
  });

  it("survives half-typed and malformed source", () => {
    // An editor spends most of its time here, so this must not throw and must
    // still round-trip.
    for (const source of [
      "",
      "\n\n",
      "when",
      "create object ball (width",
      'create text t in p (text "unterminated',
      "y--1",
      "when ball hits @@@ then x as 1",
      "  \t  ",
      "-- just a comment",
    ]) {
      expect(
        highlight(source)
          .map((span) => span.text)
          .join(""),
        JSON.stringify(source),
      ).toBe(source);
    }
  });

  it("merges neighbouring spans that agree", () => {
    // Two spaces and a newline are one span, not four. Consumers emit an element
    // per span, so this is the difference between a tidy DOM and a huge one.
    const spans = highlight("start title\n\n\nscene title");
    expect(
      spans.filter((span) => span.scope === null).every((span) => span.text.trim() === ""),
    ).toBe(true);
    expect(spans.some((span) => span.text === "\n\n\n")).toBe(true);
  });

  it("scopes a comment to end of line, and only that", () => {
    const source = "-- a note\nstart title -- trailing\n";
    const comments = scopes(source).filter((s) => s.scope === "comment.line.double-dash");
    expect(comments.map((c) => c.text)).toEqual(["-- a note", "-- trailing"]);
    expect(scopeOf(source, "start")).toBe("storage.type");
  });

  it("treats a glued `--` as the comment the lexer says it is", () => {
    // `y--1` is a comment to the lexer and an error to the parser (E_GLUED_COMMENT).
    // The highlighter must agree with the lexer, or the colour would argue with
    // the diagnostic underneath it.
    expect(scopeOf("when always then y as y--1", "--1")).toBe("comment.line.double-dash");
  });

  it("separates strings, filenames and numbers", () => {
    const source = [
      "backdrop title.svg",
      "music theme.mid in play",
      "sound bounce.wav on ball hits paddle",
      "level cavern from cavern.dmtl",
      "stream course from gap.dmtl, low.dmtl 24 wide",
      "create object ball (sprite ball.svg, speed 40vmin)",
      'create text hello in play (text "press a")',
    ].join("\n");
    expect(scopeOf(source, "title.svg")).toBe("string.unquoted");
    expect(scopeOf(source, "theme.mid")).toBe("string.unquoted");
    expect(scopeOf(source, "bounce.wav")).toBe("string.unquoted");
    expect(scopeOf(source, "cavern.dmtl")).toBe("string.unquoted");
    expect(scopeOf(source, "gap.dmtl")).toBe("string.unquoted");
    expect(scopeOf(source, "low.dmtl")).toBe("string.unquoted");
    expect(scopeOf(source, "ball.svg")).toBe("string.unquoted");
    expect(scopeOf(source, '"press a"')).toBe("string.quoted");
    expect(scopeOf(source, "24")).toBe("constant.numeric");
    // The word that closes a `stream` is a keyword, not one more file.
    expect(scopeOf(source, "wide")).toBe("keyword.other");
  });

  it("splits a dotted name into its object and its property", () => {
    const spans = scopes("when always then paddle2.xdirection as ball1.centerx");
    expect(spans.map((s) => [s.text, s.scope])).toEqual([
      ["when", "keyword.control"],
      ["always", "support.constant"],
      ["then", "keyword.control"],
      ["paddle2", "variable.other"],
      [".", "punctuation"],
      ["xdirection", "variable.other.property"],
      ["as", "keyword.other"],
      ["ball1", "variable.other"],
      [".", "punctuation"],
      ["centerx", "variable.other.property"],
    ]);
  });

  it("reads a word by its position when the word has two meanings", () => {
    // Four words in the language are two things depending on where they sit.
    // Getting these right is the whole reason this runs on the lexer's tokens
    // rather than on a list of words.
    expect(scopeOf("start title", "start")).toBe("storage.type");
    expect(scopeOf("when start pressed then scene as play", "start")).toBe("support.constant");

    expect(scopeOf("scene play", "scene")).toBe("storage.type");
    expect(scopeOf("when a pressed then scene as play", "scene")).toBe("variable.other.property");

    expect(scopeOf("control p left (xdirection -1) on hold", "left")).toBe("support.constant");
    expect(scopeOf("when always then x as ball.left", "left")).toBe("variable.other.property");

    // A unit is a unit because a number precedes it, not because of its spelling.
    expect(scopeOf("create object o (speed 40vmin)", "vmin")).toBe("keyword.other.unit");
    expect(scopeOf("scene vmin", "vmin")).toBe("entity.name.section");
  });

  it("names scenes, classes and instances", () => {
    const source = [
      "start title",
      "scene play",
      "create object ball (width 1 cell)",
      "create ball ball1 in play (x centerx)",
    ].join("\n");
    const seen = scopes(source);
    expect(seen.filter((s) => s.scope === "entity.name.section").map((s) => s.text)).toEqual([
      "title",
      "play",
      "play",
    ]);
    expect(seen.filter((s) => s.scope === "entity.name.type").map((s) => s.text)).toEqual([
      "ball",
      "ball",
    ]);
    expect(scopeOf(source, "ball1")).toBe("variable.other");
    expect(scopeOf(source, "cell")).toBe("keyword.other.unit");
  });

  it("scopes builtins, value words and operators", () => {
    const source = "when always then x as clamp(ball.centerx - 1, -1, 1)";
    expect(scopeOf(source, "clamp")).toBe("support.function");
    expect(scopeOf(source, "-")).toBe("keyword.operator");
    expect(scopeOf(source, "(")).toBe("punctuation");
    expect(scopeOf("create ball b in p (direction southwest)", "southwest")).toBe(
      "constant.language",
    );
    expect(scopeOf("when ball hits paddle then ydirection as flip", "flip")).toBe(
      "constant.language",
    );
  });
});

/**
 * The grammar is generated from the registry, so nothing in the registry may go
 * uncoloured. These are what make "add a keyword and it highlights" true rather
 * than aspirational (AGENTS.md §Iron rules).
 */
describe("highlight covers the registry", () => {
  it("scopes every statement keyword", () => {
    for (const statement of STATEMENTS) {
      const word = statement.keyword.split(" ")[0] as string;
      const scope = scopeOf(`${statement.example}`, word);
      expect([`keyword.control`, `storage.type`], statement.keyword).toContain(scope);
    }
  });

  it("scopes every clause keyword", () => {
    // Each keyword is exercised in the statement whose syntax line names it.
    const uses: Record<string, string> = {
      object: "create object ball (width 1)",
      in: "create ball b in play (x 1)",
      from: "level cavern from cavern.dmtl",
      follows: "camera follows player",
      wide: "stream c from a.dmtl 24 wide",
      tall: "stream c from a.dmtl 24 tall",
      on: "control p left (xdirection -1) on hold",
      hold: "control p left (xdirection -1) on hold",
      press: "control p left (xdirection -1) on press",
      release: "control p left (xdirection -1) on release",
      if: "when a pressed if shot.visible = 0 then x as 1",
      then: "when a pressed then x as 1",
      else: "when b.y > 1 then x as 1 else x as 2",
      as: "when a pressed then x as 1",
      hits: "when ball hits paddle then x as 1",
      touches: "when ball touches paddle then x as 1",
      pressed: "when a pressed then x as 1",
      released: "when a released then x as 1",
      reaches: "when score.value reaches 10 then x as 1",
    };
    for (const keyword of KEYWORDS) {
      const source = uses[keyword.name];
      expect(source, `${keyword.name} has no example in this test`).toBeDefined();
      const scope = scopeOf(source as string, keyword.name);
      expect(["keyword.control", "keyword.other", "storage.type"], keyword.name).toContain(scope);
    }
  });

  it("scopes every unit, builtin, constant, button and direction", () => {
    for (const unit of UNITS) {
      for (const name of [unit.name, ...(unit.aliases ?? [])]) {
        expect(scopeOf(`create object o (width 1 ${name})`, name), name).toBe("keyword.other.unit");
      }
    }
    for (const fn of FUNCTIONS) {
      const args = Array(fn.arity).fill("1").join(", ");
      expect(scopeOf(`when always then x as ${fn.name}(${args})`, fn.name), fn.name).toBe(
        "support.function",
      );
    }
    for (const constant of CONSTANTS) {
      expect(scopeOf(`when always then x as ${constant.name}`, constant.name), constant.name).toBe(
        "support.constant",
      );
    }
    for (const button of BUTTON_NAMES) {
      expect(scopeOf(`when ${button} pressed then x as 1`, button), button).toBe(
        "support.constant",
      );
    }
    for (const direction of DIRECTIONS) {
      expect(
        scopeOf(`create o a in p (direction ${direction.name})`, direction.name),
        direction.name,
      ).toBe("constant.language");
    }
  });

  it("scopes every assignable property", () => {
    for (const property of PROPERTIES) {
      if (property.derived) continue;
      const source = `create object o (${property.name} 1)`;
      expect(scopeOf(source, property.name), property.name).toBe("variable.other.property");
    }
  });

  it("leaves nothing in the example library unscoped but whitespace", () => {
    // The real test of coverage: a word in a shipped game that comes back as a
    // bare `variable.other` is fine (it is someone's name), but nothing may come
    // back with no scope at all except space.
    for (const game of GAMES) {
      const source = readFileSync(`${FIXTURES}${game}`, "utf8");
      for (const span of highlight(source)) {
        if (span.scope === null) expect(span.text.trim(), `${game}: ${span.text}`).toBe("");
      }
    }
  });
});
