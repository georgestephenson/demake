/**
 * The block editor's model (doc 19 §The block editor).
 *
 * What is checked here is the promise that makes the editor safe to open a
 * hand-written game with: **a row nobody touched comes back byte-identical.**
 * Everything else the editor does — the symbols, the drag, the pictures — is
 * chrome over these four operations, and each of them is a splice.
 *
 * The rows themselves are checked against the example library rather than
 * against samples written here, because the failure worth catching is a line
 * shape nobody thought of, and a line written in this file is a line somebody
 * thought of.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  dialectOf,
  insertRow,
  joinRows,
  moveRow,
  paletteFor,
  problemsOf,
  read,
  removeRow,
  rowsOf,
  setSlot,
  slotValue,
  splitRows,
  templateFor,
  vocabularyOf,
  type Row,
} from "../src/lib/blocks.js";

/**
 * The example library, read off disk.
 *
 * The real files rather than copies: what these tests are for is the shapes a
 * hand-written game actually contains, and a copy in this directory is a copy
 * that stops being one the next time a fixture is edited.
 */
const PROJECTS = dirname(
  createRequire(import.meta.url).resolve("@demake/demotic/fixtures/projects/pong/src/pong.dmt"),
);
const source = (name: string): string => readFileSync(join(PROJECTS, "..", "..", name), "utf8");
const PONG = { game: source("pong/src/pong.dmt"), tests: source("pong/src/pong.test.dmt") };
const QUEST = { game: source("quest/src/quest.dmt") };

/** Every row of a source, read the way the editor reads it. */
function rows(text: string, dialect: "game" | "suite" = "game"): readonly Row[] {
  return rowsOf(text, read(text, dialect));
}

/** A row's text rebuilt from what the editor draws. */
function drawn(row: Row): string {
  if (row.kind !== "statement") return row.text;
  return row.indent + row.keyword + row.parts.map((part) => part.text).join("");
}

describe("rows", () => {
  it("gives every line of a file exactly one row", () => {
    const source = "start title\n\n-- a note\nscene title\nnonsense here\n";
    expect(rows(source).map((row) => row.kind)).toEqual([
      "statement",
      "blank",
      "comment",
      "statement",
      "raw",
    ]);
  });

  it("draws every row of every example game as the line it came from", () => {
    for (const source of [PONG.game, QUEST.game]) {
      const { lines } = splitRows(source);
      expect(rows(source).map(drawn)).toEqual(lines);
    }
  });

  it("draws every row of a suite as the line it came from", () => {
    const { lines } = splitRows(PONG.tests);
    expect(rows(PONG.tests, "suite").map(drawn)).toEqual(lines);
  });

  it("keeps a comment written beside a statement on that statement's row", () => {
    const [row] = rows("backdrop title.svg -- the one with the net\n");
    expect(row?.kind).toBe("statement");
    expect(drawn(row as Row)).toBe("backdrop title.svg -- the one with the net");
  });

  it("shows a line it could not read as the text it could not read", () => {
    const [row] = rows("create ball\n");
    expect(row).toMatchObject({ kind: "raw", text: "create ball" });
  });

  it("names the statement the way the registry does", () => {
    const source = "create object ball (width 1 cell)\ncreate ball ball1 (x 0)\n";
    expect(rows(source).map((row) => (row.kind === "statement" ? row.keyword : ""))).toEqual([
      "create object",
      "create",
    ]);
  });

  it("offers a slot for every part of a statement a person would change", () => {
    const [row] = rows("create ball ball1 in play (sprite ball.svg, x centerx)\n");
    const slots = (row as Extract<Row, { kind: "statement" }>).parts
      .filter((part) => part.slot)
      .map((part) => [part.slot?.kind, part.text]);
    expect(slots).toEqual([
      ["class", "ball"],
      ["name", "ball1"],
      ["scene", "play"],
      ["property", "sprite"],
      ["art", "ball.svg"],
      ["property", "x"],
      ["expression", "centerx"],
    ]);
  });
});

describe("edits", () => {
  const source = "start title\nscene title\nbackdrop title.svg\n";

  it("changes one slot and no other byte of the file", () => {
    const row = rows(source)[2] as Extract<Row, { kind: "statement" }>;
    const slot = row.parts.find((part) => part.slot?.kind === "art")?.slot;
    expect(slot).toBeDefined();
    expect(setSlot(source, slot!, "court.svg")).toBe(
      "start title\nscene title\nbackdrop court.svg\n",
    );
  });

  it("will not let a field split a statement across two lines", () => {
    const row = rows(source)[0] as Extract<Row, { kind: "statement" }>;
    const slot = row.parts.find((part) => part.slot)?.slot;
    expect(setSlot(source, slot!, "play\nscene sneaky")).toBe(
      "start play scene sneaky\nscene title\nbackdrop title.svg\n",
    );
  });

  it("will not let a field close the string it is inside", () => {
    const quoted = 'create text prompt (text "press a")\n';
    const row = rows(quoted)[0] as Extract<Row, { kind: "statement" }>;
    const slot = row.parts.find((part) => part.slot?.kind === "string")?.slot;
    expect(setSlot(quoted, slot!, 'go", visible 0)')).toBe(
      'create text prompt (text "go, visible 0)")\n',
    );
  });

  it("moves a row without touching the rows it moved past", () => {
    expect(moveRow(source, 2, 0)).toBe("backdrop title.svg\nstart title\nscene title\n");
    expect(moveRow(source, 0, 3)).toBe("scene title\nbackdrop title.svg\nstart title\n");
    // A drop where it already is changes nothing at all.
    expect(moveRow(source, 1, 1)).toBe(source);
    expect(moveRow(source, 1, 2)).toBe(source);
  });

  it("keeps the file's own ending through every operation", () => {
    const noNewline = "start title\nscene title";
    expect(moveRow(noNewline, 0, 2)).toBe("scene title\nstart title");
    expect(insertRow(noNewline, 2, "seed 7")).toBe("start title\nscene title\nseed 7");
    expect(removeRow(source, 1)).toBe("start title\nbackdrop title.svg\n");
    expect(insertRow(source, 3, "seed 7")).toBe(
      "start title\nscene title\nbackdrop title.svg\nseed 7\n",
    );
  });

  it("keeps a blank line, because that is how a game is sectioned", () => {
    const spaced = "start title\n\nscene title\n";
    expect(rows(spaced)).toHaveLength(3);
    expect(joinRows(splitRows(spaced).lines, true)).toBe(spaced);
    expect(moveRow(spaced, 2, 0)).toBe("scene title\nstart title\n\n");
  });
});

describe("the palette", () => {
  it("offers exactly the statements each registry lists", () => {
    expect(paletteFor("game").map((spec) => spec.keyword)).toContain("create object");
    expect(paletteFor("suite").map((spec) => spec.keyword)).toEqual([
      "test",
      "play",
      "press",
      "hold",
      "expect",
    ]);
  });

  it("drops a line that reads back as the statement it offered", () => {
    for (const dialect of ["game", "suite"] as const) {
      // A suite's steps belong to a case, so each is dropped under one — which is
      // the grammar rather than the palette: a `play` on its own is `E_TEST_ORPHAN`
      // and shows as one against the row it was dropped on.
      const above = dialect === "suite" ? "test a case\n" : "";
      for (const spec of paletteFor(dialect)) {
        const line = templateFor(spec);
        const dropped = rows(above + line, dialect)[above === "" ? 0 : 1];
        expect(dropped, `${spec.keyword} drops a readable row`).toMatchObject({
          kind: "statement",
          keyword: spec.keyword,
        });
      }
    }
  });
});

describe("dialects", () => {
  it("tells a suite from a game by the one thing that distinguishes them", () => {
    expect(dialectOf("src/pong.dmt")).toBe("game");
    expect(dialectOf("src/pong.test.dmt")).toBe("suite");
  });
});

describe("what a program calls things", () => {
  const source = [
    "scene title",
    "scene play",
    "create object ball (width 1 cell)",
    "create ball ball1 in play (x 0)",
  ].join("\n");

  it("offers a program its own names, read off the rows rather than a compile", () => {
    const vocabulary = vocabularyOf(source, read(source, "game"), ["ledge"]);
    expect(vocabulary.scenes).toEqual(["play", "title"]);
    // `number` and `text` are classes every program has without declaring them.
    expect(vocabulary.classes).toEqual(["ball", "number", "text"]);
    expect(vocabulary.instances).toEqual(["ball1"]);
    // Whatever a collision may name: objects, classes, a level's tiles, and the
    // screen edges the language supplies.
    expect(vocabulary.entities).toContain("ledge");
    expect(vocabulary.entities).toContain("screenleft");
    expect(vocabulary.entities).toContain("ball1");
  });

  it("still offers them while a line below is half-typed", () => {
    // The whole reason it reads the spans rather than a compile: a file being
    // edited does not compile every second keystroke, and a dropdown that
    // emptied itself mid-word is a dropdown nobody can use.
    const broken = `${source}\ncreate ball`;
    expect(vocabularyOf(broken, read(broken, "game")).scenes).toEqual(["play", "title"]);
  });
});

describe("where a problem goes", () => {
  const diagnostics = [
    { severity: "error", code: "E_ONE", message: "on the first row", line: 1 },
    { severity: "warning", code: "W_TWO", message: "on the second", line: 2 },
    { severity: "error", code: "E_TWO", message: "also the second", line: 2 },
    { severity: "error", code: "E_GAME", message: "about another file", line: 0 },
    { severity: "error", code: "E_PAST", message: "past the end", line: 99 },
  ] as const;

  it("sorts each diagnostic onto the row it names", () => {
    const problems = problemsOf(diagnostics, 3);
    expect([...(problems.byRow.get(0) ?? [])].map((one) => one.code)).toEqual(["E_ONE"]);
    expect([...(problems.byRow.get(1) ?? [])].map((one) => one.code)).toEqual(["W_TWO", "E_TWO"]);
    expect(problems.byRow.has(2)).toBe(false);
  });

  it("keeps the ones that name no row rather than dropping them", () => {
    // This is how a suite says the *game* under it will not compile — a real
    // reason it can never pass, naming no row in the file on screen.
    const problems = problemsOf(diagnostics, 3);
    expect(problems.loose.map((one) => one.code)).toEqual(["E_GAME", "E_PAST"]);
    expect(problems.errors).toBe(4);
    expect(problems.warnings).toBe(1);
  });

  it("names the rows an error is on, in order, for `go to the first`", () => {
    expect(problemsOf(diagnostics, 3).rowsWithErrors).toEqual([0, 1]);
    // A row with only a warning is not one of them.
    const warned = [{ severity: "warning", code: "W", message: "", line: 3 }] as const;
    expect(problemsOf(warned, 3).rowsWithErrors).toEqual([]);
  });
});

describe("what a field may write", () => {
  it("takes out what would change the program rather than the value", () => {
    // A newline would split a statement across two lines, and the language is
    // one statement per line; a quote would close a string it is inside of.
    expect(slotValue("press a\nto play")).toBe("press a to play");
    expect(slotValue('go", visible 0')).toBe("go, visible 0");
    // And it is exported so the editor can *see* that it did something, rather
    // than a character silently vanishing as it is typed.
    expect(slotValue("press a")).toBe("press a");
  });
});
