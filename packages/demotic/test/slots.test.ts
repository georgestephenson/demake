/**
 * The parsers' slot side channel (`lang/slots.ts`, doc 19 §The block editor).
 *
 * Two properties carry the whole thing, and both are checked against every real
 * file in the repository rather than against a handful of samples — because the
 * failure this file exists to catch is a statement shape somebody added a slot
 * for and got half right, which a written-here example would agree with.
 *
 * 1. **Slots tile the statement.** They are in source order, they never overlap,
 *    and reassembling the line from its slots and the text between them gives the
 *    line back byte for byte. That is what makes an edit a splice: the editor puts
 *    a new value in one slot and everything else is the bytes that were there.
 * 2. **A slot's text is what it claims to be.** A `scene` slot holds the name the
 *    AST recorded, an `art` slot holds the file the statement named, and so on —
 *    so a slot marked on the wrong token fails here rather than in a browser.
 */

import { describe, expect, it } from "vitest";

import { parse } from "../src/lang/parse.js";
import { SLOT_CHOICES, type StatementSpan } from "../src/lang/slots.js";
import { BUTTONS, DIRECTIONS, KEYWORD_NAMES, SIDES, STATEMENTS } from "../src/lang/spec.js";
import { parseTests } from "../src/testing/parse.js";
import { TEST_KEYWORDS } from "../src/testing/spec.js";
import { EXAMPLES, projectFiles, projectText } from "./_projects.js";

/** Every `.dmt` in an example project — the game and its suite. */
function sourcesOf(name: string): readonly string[] {
  return projectFiles(name).filter((path) => path.endsWith(".dmt"));
}

/** Check that a span's slots tile the source they cover. */
function tiles(source: string, span: StatementSpan): void {
  let at = span.start;
  const pieces: string[] = [];
  for (const slot of span.slots) {
    expect(slot.start).toBeGreaterThanOrEqual(at);
    expect(slot.end).toBeGreaterThanOrEqual(slot.start);
    expect(slot.end).toBeLessThanOrEqual(span.end);
    expect(slot.line).toBe(span.line);
    pieces.push(source.slice(at, slot.start), source.slice(slot.start, slot.end));
    at = slot.end;
  }
  pieces.push(source.slice(at, span.end));
  expect(pieces.join("")).toBe(source.slice(span.start, span.end));
}

/** Every span's slot texts, keyed by kind, for the classification checks. */
function textOf(source: string, span: StatementSpan, kind: string): string[] {
  return span.slots.filter((slot) => slot.kind === kind).map((s) => source.slice(s.start, s.end));
}

describe("statement slots", () => {
  it("names every statement the way the registry spells it", () => {
    const source = [
      "start title",
      "seed 7",
      "scene title",
      "create object ball (width 1 cell)",
      "create ball ball1 in title (x 0)",
      "level cavern from cavern.dmtl",
      "stream course from a.dmtl, b.dmtl 4 wide",
      "backdrop title.svg",
      "music theme.mid in title",
      "sound blip.wav on a pressed",
      "camera follows ball1",
      "control ball1 left (xdirection -1) on hold",
      "when a pressed then scene as title",
    ].join("\n");
    const spans = parse(source).spans;
    expect(spans.map((span) => span.keyword)).toEqual(STATEMENTS.map((s) => s.keyword));
  });

  it("marks each reference with what may go in it", () => {
    const source = "create ball ball1 in play (x centerx, sprite ball.svg, direction southwest)";
    const [span] = parse(source).spans;
    expect(span).toBeDefined();
    expect(
      (span as StatementSpan).slots.map((slot) => [slot.kind, source.slice(slot.start, slot.end)]),
    ).toEqual([
      ["class", "ball"],
      ["name", "ball1"],
      ["scene", "play"],
      ["property", "x"],
      ["expression", "centerx"],
      ["property", "sprite"],
      ["art", "ball.svg"],
      ["property", "direction"],
      ["direction", "southwest"],
    ]);
  });

  it("edits a quoted value without making the author retype its quotes", () => {
    const source = 'create text prompt (text "press a to play")';
    const [span] = parse(source).spans;
    const slot = (span as StatementSpan).slots.find((s) => s.kind === "string");
    expect(slot).toBeDefined();
    expect(source.slice((slot as { start: number }).start, (slot as { end: number }).end)).toBe(
      "press a to play",
    );
    // The splice an editor would make: only the contents move.
    const next = `${source.slice(0, (slot as { start: number }).start)}go${source.slice((slot as { end: number }).end)}`;
    expect(next).toBe('create text prompt (text "go")');
  });

  it("marks the parts of a collision rule", () => {
    const source = "when hero touches ledge, wall from above then ydirection as 0";
    const [span] = parse(source).spans;
    expect(
      (span as StatementSpan).slots.map((s) => [s.kind, source.slice(s.start, s.end)]),
    ).toEqual([
      ["entity", "hero"],
      ["verb", "touches"],
      ["entity", "ledge"],
      ["entity", "wall"],
      ["side", "above"],
      ["property", "ydirection"],
      ["expression", "0"],
    ]);
  });

  it("gives a positional value list the property it sets", () => {
    const source = "create ball ball1 (x, sprite) as (4, ball.svg)";
    const [span] = parse(source).spans;
    const slots = (span as StatementSpan).slots;
    expect(slots.map((s) => s.kind)).toEqual([
      "class",
      "name",
      "property",
      "property",
      "expression",
      "art",
    ]);
    expect(slots[5]?.prop).toBe("sprite");
  });

  it("leaves no slots behind on a line it could not read", () => {
    const result = parse("backdrop title.svg\ncreate ball\nmusic theme.mid");
    expect(result.spans.map((span) => span.keyword)).toEqual(["backdrop", "music"]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("tiles every statement of every example game", () => {
    for (const name of EXAMPLES) {
      for (const path of sourcesOf(name)) {
        const source = projectText(name, path);
        const result = path.endsWith(".test.dmt") ? parseTests(source) : parse(source);
        expect(result.spans.length, `${path} has statements`).toBeGreaterThan(0);
        for (const span of result.spans) tiles(source, span);
      }
    }
  });

  it("finds the file every asset statement names, in every example game", () => {
    for (const name of EXAMPLES) {
      for (const path of sourcesOf(name).filter((p) => !p.endsWith(".test.dmt"))) {
        const source = projectText(name, path);
        const result = parse(source);
        for (const span of result.spans) {
          const statement = result.statements.find((s) => s.line === span.line);
          if (span.keyword === "backdrop") {
            expect(textOf(source, span, "art")).toEqual([(statement as { file: string }).file]);
          }
          if (span.keyword === "music") {
            expect(textOf(source, span, "music")).toEqual([(statement as { file: string }).file]);
          }
          if (span.keyword === "sound") {
            expect(textOf(source, span, "sound")).toEqual([(statement as { file: string }).file]);
          }
        }
      }
    }
  });
});

/**
 * The other half of the side channel: the parts of a statement that repeat.
 *
 * A slot describes a statement of fixed shape, and half the grammar is not that
 * shape — `when ball hits a, b, c` has as many targets as the author wrote. The
 * properties here are what make a list safe to *edit* through, and the second is
 * the one that is easy to get subtly wrong: an item's range has to contain the
 * slots inside it exactly, or removing the item leaves half a field behind.
 */
describe("statement lists", () => {
  /** Check a list against the statement it belongs to. */
  function encloses(source: string, span: StatementSpan): void {
    for (const list of span.lists) {
      expect(list.start).toBeGreaterThanOrEqual(span.start);
      expect(list.end).toBeLessThanOrEqual(span.end);
      expect(list.line).toBe(span.line);
      let at = list.start;
      for (const item of list.items) {
        // In order, inside the clause, and never overlapping the one before.
        expect(item.start).toBeGreaterThanOrEqual(at);
        expect(item.end).toBeGreaterThan(item.start);
        expect(item.end).toBeLessThanOrEqual(list.end);
        // And an item is made of whole slots: at least one starts and ends in it.
        const held = span.slots.filter((slot) => slot.start >= item.start && slot.end <= item.end);
        expect(held.length, source.slice(item.start, item.end)).toBeGreaterThan(0);
        at = item.end;
      }
      // A pairing is mutual and names a list of this same statement.
      if (list.pair === undefined) continue;
      const twin = span.lists[list.pair];
      expect(twin).toBeDefined();
      expect((twin as { pair?: number }).pair).toBe(span.lists.indexOf(list));
      expect((twin as { items: unknown[] }).items).toHaveLength(list.items.length);
    }
  }

  it("records the lists in a collision rule, and the one that is not there", () => {
    const source = "when hero touches ledge, wall from above then ydirection as 0";
    const [span] = parse(source).spans;
    const lists = (span as StatementSpan).lists;
    expect(
      lists.map((list) => [list.kind, list.items.map((i) => source.slice(i.start, i.end))]),
    ).toEqual([
      ["entity", ["ledge", "wall"]],
      ["side", ["above"]],
    ]);
    // The side clause starts before `from`, so removing its last side takes the
    // word with it rather than leaving `from` with nothing after it.
    expect(source.slice(lists[1]?.start ?? 0, lists[1]?.end ?? 0)).toBe(" from above");
  });

  it("gives a rule with no `from` an empty side list to grow", () => {
    const source = "when hero touches ledge then ydirection as 0";
    const [span] = parse(source).spans;
    const sides = (span as StatementSpan).lists.find((list) => list.kind === "side");
    expect(sides?.items).toEqual([]);
    expect(sides?.start).toBe(sides?.end);
    expect(source.slice(0, sides?.start)).toBe("when hero touches ledge");
    expect(sides?.opener).toBe(" from above");
  });

  it("pairs the two halves of a positional `as`", () => {
    const source = "create ball ball1 (x, sprite) as (4, ball.svg)";
    const [span] = parse(source).spans;
    const lists = (span as StatementSpan).lists;
    expect(lists).toHaveLength(2);
    expect(lists[0]?.pair).toBe(1);
    expect(lists[1]?.pair).toBe(0);
    encloses(source, span as StatementSpan);
  });

  it("fills a new property entry with one the list does not already set", () => {
    // `noDuplicates` is what makes this necessary: a fixed template would be
    // `E_DUPLICATE_PROP` on every list that already named it.
    const taken = parse("create object ball (x 1, y 2)").spans[0] as StatementSpan;
    expect(taken.lists[0]?.template).toBe("width 1");
    const free = parse("create object ball (sprite ball.svg)").spans[0] as StatementSpan;
    expect(free.lists[0]?.template).toBe("x 0");
  });

  it("encloses its slots, in every example game", () => {
    for (const name of EXAMPLES) {
      for (const path of sourcesOf(name).filter((p) => !p.endsWith(".test.dmt"))) {
        const source = projectText(name, path);
        for (const span of parse(source).spans) encloses(source, span);
      }
    }
  });

  it("leaves no lists behind on a line it could not read", () => {
    // The same rewind slots get: a row an editor cannot read must offer nothing,
    // never a control built from the half of the line that parsed.
    const result = parse("when hero hits ledge then y as 0\nwhen hero hits\nbackdrop title.svg");
    expect(result.spans.map((span) => span.keyword)).toEqual(["when", "backdrop"]);
    expect(result.spans[1]?.lists).toEqual([]);
  });
});

describe("slot choices", () => {
  it("takes a set the registry already holds from the registry", () => {
    expect(SLOT_CHOICES.button).toEqual(BUTTONS.map((one) => one.name));
    expect(SLOT_CHOICES.side).toEqual(SIDES.map((one) => one.name));
    expect(SLOT_CHOICES.direction).toEqual(DIRECTIONS.map((one) => one.name));
  });

  it("offers only connective words the reference documents", () => {
    // The four sets the grammar itself decides are written out where they are
    // declared, so each has to be a `KEYWORDS` entry — a picker cannot offer a
    // word the language does not have. A suite's duration units are the one
    // exception and say so beside them.
    for (const kind of ["verb", "edge", "mode", "axis"] as const) {
      for (const word of SLOT_CHOICES[kind] ?? []) {
        expect(KEYWORD_NAMES, `${kind}: ${word}`).toContain(word);
      }
    }
  });

  it("is what the parser itself accepts", () => {
    for (const mode of SLOT_CHOICES.mode ?? []) {
      const result = parse(`control paddle1 left (xdirection -1) on ${mode}`);
      expect(result.diagnostics, mode).toEqual([]);
    }
    for (const axis of SLOT_CHOICES.axis ?? []) {
      const result = parse(`stream course from a.dmtl 4 ${axis}`);
      expect(result.diagnostics, axis).toEqual([]);
    }
  });
});

describe("test-suite slots", () => {
  const source = [
    "test the paddle reaches the wall",
    "press a",
    "hold left for 5 seconds",
    "play 12 ticks",
    "expect paddle1.x = 0",
    "expect scene play",
  ].join("\n");

  it("names every statement the way its registry spells it", () => {
    const spans = parseTests(source).spans;
    expect([...new Set(spans.map((span) => span.keyword))].sort()).toEqual(
      [...TEST_KEYWORDS].sort(),
    );
  });

  it("marks the parts of each step", () => {
    const spans = parseTests(source).spans;
    expect(
      spans.map((span) => span.slots.map((s) => [s.kind, source.slice(s.start, s.end)])),
    ).toEqual([
      [["title", "the paddle reaches the wall"]],
      [["button", "a"]],
      [
        ["button", "left"],
        ["number", "5"],
        ["duration-unit", "seconds"],
      ],
      [
        ["number", "12"],
        ["duration-unit", "ticks"],
      ],
      [["expression", "paddle1.x = 0"]],
      [["scene", "play"]],
    ]);
  });

  it("keeps a comment and its spacing out of the slots", () => {
    const commented = "test a rally\n  play 4 seconds   -- long enough to concede\n";
    const span = parseTests(commented).spans[1] as StatementSpan;
    expect(commented.slice(span.start, span.end)).toBe("play 4 seconds");
    tiles(commented, span);
  });

  it("says nothing about a line it could not read", () => {
    const broken = "test a case\nplay sideways\npress a";
    const result = parseTests(broken);
    expect(result.spans.map((span) => span.keyword)).toEqual(["test", "press"]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("reads a case name back out of the file it was written in", () => {
    for (const name of EXAMPLES) {
      const path = `src/${name}.test.dmt`;
      if (!projectFiles(name).includes(path)) continue;
      const text = projectText(name, path);
      const result = parseTests(text);
      const titles = result.spans
        .filter((span) => span.keyword === "test")
        .map((span) => text.slice(span.slots[0]?.start ?? 0, span.slots[0]?.end ?? 0));
      expect(titles).toEqual(result.cases.map((one) => one.name));
    }
  });
});
