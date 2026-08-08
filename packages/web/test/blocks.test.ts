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

import { PROPERTIES } from "@demake/demotic";

import {
  addItem,
  assetKindOf,
  assignableProperties,
  dialectOf,
  insertRow,
  joinRows,
  moveRow,
  paletteFor,
  problemsOf,
  propertyOf,
  read,
  removeItem,
  removeRow,
  rowsOf,
  setSlot,
  slotValue,
  splitRows,
  templateFor,
  vocabularyOf,
  type Part,
  type Row,
} from "../src/lib/blocks.js";
import { VIEWS, type SourceView } from "../src/lib/views.js";

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
  return (
    row.indent + row.keyword + row.parts.map((part) => ("text" in part ? part.text : "")).join("")
  );
}

/** Only the parts that hold a value — the ⊕/⊖ controls are not text. */
function fields(row: Row): readonly Extract<Part, { kind: "slot" }>[] {
  if (row.kind !== "statement") return [];
  return row.parts.filter((part): part is Extract<Part, { kind: "slot" }> => part.kind === "slot");
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
    const slots = fields(row as Row).map((part) => [part.slot.kind, part.text]);
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
    const slot = fields(row).find((part) => part.slot.kind === "art")?.slot;
    expect(slot).toBeDefined();
    expect(setSlot(source, slot!, "court.svg")).toBe(
      "start title\nscene title\nbackdrop court.svg\n",
    );
  });

  it("will not let a field split a statement across two lines", () => {
    const row = rows(source)[0] as Extract<Row, { kind: "statement" }>;
    const slot = fields(row)[0]?.slot;
    expect(setSlot(source, slot!, "play\nscene sneaky")).toBe(
      "start play scene sneaky\nscene title\nbackdrop title.svg\n",
    );
  });

  it("will not let a field close the string it is inside", () => {
    const quoted = 'create text prompt (text "press a")\n';
    const row = rows(quoted)[0] as Extract<Row, { kind: "statement" }>;
    const slot = fields(row).find((part) => part.slot.kind === "string")?.slot;
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

  it("does nothing to a row index the file no longer has", () => {
    // The editor holds an index across a render, and a file can shrink under it
    // — a delete, or a change arriving from the text view. Naming a row that has
    // gone must be a no-op rather than a splice at some other position.
    for (const at of [-1, 3, 99]) {
      expect(moveRow(source, at, 0), `move ${String(at)}`).toBe(source);
      expect(removeRow(source, at), `remove ${String(at)}`).toBe(source);
    }
    // And a destination past the end lands at the end rather than off it.
    expect(moveRow(source, 0, 99)).toBe("scene title\nbackdrop title.svg\nstart title\n");
    expect(insertRow(source, 99, "seed 7")).toBe(
      "start title\nscene title\nbackdrop title.svg\nseed 7\n",
    );
    expect(insertRow(source, -1, "seed 7")).toBe(
      "seed 7\nstart title\nscene title\nbackdrop title.svg\n",
    );
  });

  it("keeps a blank line, because that is how a game is sectioned", () => {
    const spaced = "start title\n\nscene title\n";
    expect(rows(spaced)).toHaveLength(3);
    expect(joinRows(splitRows(spaced).lines, true)).toBe(spaced);
    expect(moveRow(spaced, 2, 0)).toBe("scene title\nstart title\n\n");
  });
});

/**
 * The parts of a statement that repeat.
 *
 * This is the half a slot cannot describe. A slot says "this word is a target";
 * it says nothing about there being any number of them, so an editor built on
 * slots alone draws exactly the targets already written and offers no way to a
 * third — which is a rule whose arity was decided by whoever typed the line
 * first. Every case here is one of those, and the last two are the reasons this
 * is not simply "splice a comma in": a positional `as` is one list written as
 * two halves that the language refuses to let drift apart, and a clause that is
 * *absent* has to bring its own keyword back with it.
 */
describe("the parts of a statement that repeat", () => {
  /** The one statement on a line, with its lists. */
  function only(text: string): Extract<Row, { kind: "statement" }> {
    const [row] = rows(text);
    expect(row?.kind).toBe("statement");
    return row as Extract<Row, { kind: "statement" }>;
  }

  /** Every list of a line, as the text of its items. */
  function items(text: string): string[][] {
    const row = only(text);
    return row.span.lists.map((list) => list.items.map((item) => text.slice(item.start, item.end)));
  }

  it("sees the list in a collision rule, and its sides", () => {
    // Two lists and not three: `then y as 0` is the bracket-less assignment
    // form, which is exactly one property by construction.
    expect(
      items("when ball hits paddle1, paddle2, screenleft from above, left then y as 0\n"),
    ).toEqual([
      ["paddle1", "paddle2", "screenleft"],
      ["above", "left"],
    ]);
  });

  it("adds a target to a rule that has one, and takes it away again", () => {
    const one = "when ball hits paddle then ydirection as flip\n";
    const two = addItem(one, only(one).span, 0);
    expect(two).toBe("when ball hits paddle, screenleft then ydirection as flip\n");
    expect(removeItem(two, only(two).span, 0, 1)).toBe(one);
    // And the first is as removable as the second: an item takes the separator
    // on whichever side of it the separator is.
    expect(removeItem(two, only(two).span, 0, 0)).toBe(
      "when ball hits screenleft then ydirection as flip\n",
    );
  });

  it("will not take the last target, because a rule needs something to hit", () => {
    const one = "when ball hits paddle then ydirection as flip\n";
    expect(removeItem(one, only(one).span, 0, 0)).toBe(one);
  });

  it("writes a `from` clause that was not there, and takes the word back with it", () => {
    const bare = "when hero touches ledge then footing.value as 1\n";
    const sides = only(bare).span.lists.findIndex((list) => list.kind === "side");
    expect(sides).toBeGreaterThanOrEqual(0);
    expect(only(bare).span.lists[sides]?.items).toHaveLength(0);

    const narrowed = addItem(bare, only(bare).span, sides);
    expect(narrowed).toBe("when hero touches ledge from above then footing.value as 1\n");

    const both = addItem(narrowed, only(narrowed).span, sides);
    expect(both).toBe("when hero touches ledge from above, above then footing.value as 1\n");

    // Down to none, the word that introduced them goes too — otherwise the file
    // is left saying `from` with nothing after it.
    expect(removeItem(narrowed, only(narrowed).span, sides, 0)).toBe(bare);
  });

  it("gives a property list to a `create` that has none, and grows one that has", () => {
    const bare = "create ball ball1 in play\n";
    expect(addItem(bare, only(bare).span, 0)).toBe("create ball ball1 in play (x 0)\n");

    // The entry is the first property the list does not already set, at its own
    // default — so it parses, compiles, and changes nothing until it is typed in.
    // A fixed one would be `E_DUPLICATE_PROP` on every list that already had it.
    const one = "create object ball (sprite ball.svg)\n";
    expect(addItem(one, only(one).span, 0)).toBe("create object ball (sprite ball.svg, x 0)\n");
    const taken = "create object ball (x 1, y 2)\n";
    expect(addItem(taken, only(taken).span, 0)).toBe("create object ball (x 1, y 2, width 1)\n");
  });

  it("moves a name and its value together, because they are one entry", () => {
    const two = "create object ball (sprite ball.svg, width 1 cell)\n";
    expect(removeItem(two, only(two).span, 0, 0)).toBe("create object ball (width 1 cell)\n");
    expect(removeItem(two, only(two).span, 0, 1)).toBe("create object ball (sprite ball.svg)\n");
  });

  it("keeps a positional `as` in step, because the language refuses to let it drift", () => {
    const rule = "when hero hits coin then (coin.visible, coins.value) as (0, coins.value + 1)\n";
    const row = only(rule);
    const names = row.span.lists.findIndex(
      (list) => list.kind === "property" && list.pair !== undefined,
    );
    expect(names).toBeGreaterThanOrEqual(0);

    // Both halves gain an entry, in one edit: a file that had three names and
    // two values would be `E_ARITY` and nothing on screen would say why.
    expect(addItem(rule, row.span, names)).toBe(
      "when hero hits coin then (coin.visible, coins.value, x) as (0, coins.value + 1, 0)\n",
    );
    expect(removeItem(rule, row.span, names, 0)).toBe(
      "when hero hits coin then (coins.value) as (coins.value + 1)\n",
    );
    // And asking the *other* half does the same thing, since it is the same list.
    const values = row.span.lists[names]?.pair as number;
    expect(removeItem(rule, row.span, values, 1)).toBe(
      "when hero hits coin then (coin.visible) as (0)\n",
    );
  });

  it("offers a control at the end of each item and one for the clause", () => {
    const row = only("when ball hits paddle1, paddle2 then ydirection as flip\n");
    const controls = row.parts.filter((part) => part.kind === "add" || part.kind === "drop");
    // Two targets, so both may go; the side clause is empty, so it has an add
    // and no drops; the assignment is a single bare `x as y` and has no list.
    expect(controls.filter((part) => part.kind === "drop")).toHaveLength(2);
    expect(controls.filter((part) => part.kind === "add")).toHaveLength(2);

    // A drop sits after the item it removes, which is what makes it readable as
    // belonging to that item rather than to the row.
    const order = row.parts.flatMap((part) =>
      part.kind === "slot" ? [part.text] : part.kind === "drop" ? ["drop"] : [],
    );
    expect(order).toEqual([
      "ball",
      "hits",
      "paddle1",
      "drop",
      "paddle2",
      "drop",
      "ydirection",
      "flip",
    ]);
  });

  it("says which item each field belongs to, so a new one can be typed into", () => {
    const row = only("when ball hits paddle1, paddle2 then ydirection as flip\n");
    const held = fields(row).map((part) => [part.text, part.in?.item]);
    expect(held).toEqual([
      ["ball", undefined],
      ["hits", undefined],
      ["paddle1", 0],
      ["paddle2", 1],
      ["ydirection", undefined],
      ["flip", undefined],
    ]);
  });

  it("draws every example game as the line it came from, controls and all", () => {
    // The reassembly property the whole editor rests on, restated now that a row
    // holds parts that are not text: a control contributes nothing to the line.
    for (const text of [PONG.game, QUEST.game]) {
      const { lines } = splitRows(text);
      expect(rows(text).map(drawn)).toEqual(lines);
    }
  });

  it("leaves a program that parsed still parsing after any single add", () => {
    // Every list in the library, grown by one. A template that did not parse
    // would be a button that breaks the file it is in, and the failure would be
    // a diagnostic on a row the author did not touch.
    for (const text of [PONG.game, QUEST.game]) {
      for (const row of rows(text)) {
        if (row.kind !== "statement") continue;
        row.span.lists.forEach((_, at) => {
          const grown = addItem(text, row.span, at);
          expect(grown, `line ${String(row.line)} list ${String(at)}`).not.toBe(text);
          expect(
            read(grown, "game").diagnostics,
            `line ${String(row.line)} list ${String(at)}: ${grown.split("\n")[row.line - 1] ?? ""}`,
          ).toEqual([]);
        });
      }
    }
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

  it("takes a name only from the statements that declare one", () => {
    // A `level` names itself and is neither a scene nor a class, so it must not
    // turn up in any of the three lists — and a statement with no name slot at
    // all contributes nothing rather than an empty string.
    const named = [
      "scene play",
      "level cavern from cavern.dmtl",
      "stream course from a.dmtl 4 wide",
      "backdrop title.svg",
      "start play",
    ].join("\n");
    const vocabulary = vocabularyOf(named, read(named, "game"));
    expect(vocabulary.scenes).toEqual(["play"]);
    expect(vocabulary.classes).toEqual(["number", "text"]);
    expect(vocabulary.instances).toEqual([]);
    for (const name of ["cavern", "course", "title.svg", ""]) {
      expect(vocabulary.entities, name).not.toContain(name);
    }
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

describe("what a field is offered", () => {
  it("says which kind of file a slot names, and nothing for the rest", () => {
    // The names are `AssetKind`s so a caller can filter the project by one
    // directly rather than translating.
    expect(assetKindOf("art")).toBe("art");
    expect(assetKindOf("music")).toBe("music");
    expect(assetKindOf("sound")).toBe("sound");
    expect(assetKindOf("level")).toBe("level");
    // A scene is not a file, and neither is anything else the parser marks.
    for (const kind of ["scene", "entity", "property", "expression", "button"] as const) {
      expect(assetKindOf(kind), kind).toBeUndefined();
    }
  });

  it("finds the property a value belongs to, which decides its control", () => {
    const slot = { kind: "expression", line: 1, start: 0, end: 1, prop: "sprite" } as const;
    expect(propertyOf(slot)?.kind).toBe("asset");
    expect(propertyOf({ ...slot, prop: "text" })?.kind).toBe("text");
    expect(propertyOf({ ...slot, prop: "x" })?.kind).toBe("number");
    // A slot that belongs to no property — a scene name, a button — has none,
    // and a property the registry does not document is not invented.
    expect(propertyOf({ kind: "scene", line: 1, start: 0, end: 1 })).toBeUndefined();
    expect(propertyOf({ ...slot, prop: "nonsense" })).toBeUndefined();
  });

  it("offers every property except the ones that cannot be written", () => {
    const offered = assignableProperties().map((property) => property.name);
    // Derived properties are readable and never assignable, so offering one
    // would be offering `E_UNKNOWN_PROP`.
    for (const derived of ["centerx", "centery", "left", "right", "top", "bottom"]) {
      expect(offered, derived).not.toContain(derived);
    }
    // Everything else is offered, `createOnly` included: whether *this*
    // statement is a creation is a question about the row, and `check()`
    // answers it either way.
    for (const name of ["x", "y", "speed", "visible", "sprite", "text", "direction"]) {
      expect(offered, name).toContain(name);
    }
    expect(offered).toEqual(PROPERTIES.filter((p) => !p.derived).map((p) => p.name));
  });
});

describe("the views a source file has", () => {
  it("offers the text and the blocks, and no third", () => {
    // Side by side went: two views earn a split screen when they show different
    // things, and these show the same thing twice.
    expect(VIEWS.map((view) => view.id)).toEqual(["text", "blocks"]);
  });

  it("lists the text first, because it is the default", () => {
    // The claim the game section makes is that a whole game is sixty readable
    // lines, and somebody who arrives at a form cannot see that.
    expect(VIEWS[0]?.id).toBe("text");
    // Every id is a `SourceView`, so the picker cannot offer a view nothing
    // renders.
    const ids: SourceView[] = VIEWS.map((view) => view.id);
    expect(new Set(ids).size).toBe(VIEWS.length);
    expect(VIEWS.every((view) => view.label.length > 0)).toBe(true);
  });
});
