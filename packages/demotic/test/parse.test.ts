import { describe, expect, it } from "vitest";

import { parse } from "../src/lang/parse.js";

/** Convenience: the statements of a source that must parse cleanly. */
function statements(source: string) {
  const result = parse(source);
  expect(result.diagnostics).toEqual([]);
  return result.statements;
}

describe("parse", () => {
  it("reads the named property form", () => {
    const [statement] = statements("create object ball (height 1, width 2, sprite ball.png)");
    expect(statement).toMatchObject({
      kind: "class",
      name: "ball",
      props: [{ name: "height" }, { name: "width" }, { name: "sprite" }],
    });
  });

  it("reads the positional `as` form and pairs it up", () => {
    const [statement] = statements("create object ball (height, width, speed) as (1, 1, 4)");
    expect(statement).toMatchObject({ kind: "class", name: "ball" });
    const props = (statement as { props: { name: string; value: { value: number } }[] }).props;
    expect(props.map((p) => [p.name, p.value.value])).toEqual([
      ["height", 1],
      ["width", 1],
      ["speed", 4],
    ]);
  });

  it("reports a name/value count mismatch in the positional form", () => {
    const result = parse("create object ball (height, width, speed) as (1, 1)");
    expect(result.diagnostics[0]).toMatchObject({ code: "E_ARITY", line: 1 });
  });

  it("does not mistake a negative value for a subtraction", () => {
    // `(xdirection -1)` is `xdirection = -1`, never `xdirection - 1`: the
    // property name is consumed before the value is parsed.
    const [statement] = statements("control paddle1 left (xdirection -1) on hold");
    expect(statement).toMatchObject({
      kind: "control",
      entity: "paddle1",
      action: "left",
      mode: "hold",
      assignments: [{ target: { prop: "xdirection" }, value: { kind: "unary", op: "-" } }],
    });
  });

  it("still parses an expression when the value needs one", () => {
    const [statement] = statements("create paddle p1 (y screenheight - 1)");
    const props = (statement as { props: { value: { kind: string } }[] }).props;
    expect(props[0]?.value).toMatchObject({ kind: "binary", op: "-" });
  });

  it("is case-insensitive for keywords and identifiers alike", () => {
    const [a] = statements("CREATE OBJECT Ball (Height 1)");
    const [b] = statements("create object ball (height 1)");
    expect(a).toEqual(b);
  });

  it("treats `--` as a comment to end of line", () => {
    expect(statements("start title -- enters here\n-- a whole comment line\n")).toHaveLength(1);
  });

  it("parses a collision list with several targets", () => {
    const [statement] = statements(
      "when ball hits screenleft, screenright then xdirection as flip",
    );
    expect(statement).toMatchObject({
      kind: "when",
      event: { kind: "hits", subject: "ball", others: ["screenleft", "screenright"] },
    });
  });

  it("parses a level predicate and an edge `reaches`", () => {
    const [predicate] = statements(
      "when ball1.x < paddle2.x in play then paddle2.xdirection as -1",
    );
    expect(predicate).toMatchObject({ kind: "when", event: { kind: "predicate" }, scene: "play" });

    const [reaches] = statements("when score1.value reaches 10 then score1.value as 0");
    expect(reaches).toMatchObject({ kind: "when", event: { kind: "reaches" } });
  });

  it("parses input edges", () => {
    const [statement] = statements("when start pressed then scene as play");
    expect(statement).toMatchObject({
      kind: "when",
      event: { kind: "input", action: "start", edge: "pressed" },
    });
  });

  it("recovers per line, so one bad statement does not hide the rest", () => {
    const result = parse(
      ["start title", "wibble wobble", "scene title", "create object ((", "scene play"].join("\n"),
    );
    expect(result.statements.map((s) => s.kind)).toEqual(["start", "scene", "scene"]);
    expect(result.diagnostics.map((d) => d.line)).toEqual([2, 4]);
  });

  it("rejects two statements on one line rather than silently joining them", () => {
    const result = parse("start title scene title");
    expect(result.diagnostics[0]?.hint).toContain("one per line");
  });
});

/**
 * Every case here parses to *something* under the obvious reading, which is the
 * only reason they need catching: a wrong program that compiles is found in an
 * emulator, three layers from its cause.
 */
describe("parse rejects what it would otherwise misread", () => {
  it("catches `--` glued to the token before it, which would eat the rest of the line", () => {
    const result = parse("when always then y as y--1");
    expect(result.diagnostics[0]).toMatchObject({ code: "E_GLUED_COMMENT", line: 1 });
    expect(result.diagnostics[0]?.hint).toContain("- -");
  });

  it("still allows a comment that starts a line or follows a space", () => {
    expect(statements("start title -- enters here\n--start play\n")).toHaveLength(1);
  });

  it("does not mistake a subtraction for a comment when the spaces are there", () => {
    const [statement] = statements("when always then y as y - -1");
    expect(statement).toMatchObject({
      assignments: [{ value: { kind: "binary", op: "-", right: { kind: "unary" } } }],
    });
  });

  it("catches a string with no closing quote instead of blaming a later bracket", () => {
    const result = parse('create text t in play (text "press a to play, x 1)');
    expect(result.diagnostics[0]).toMatchObject({ code: "E_UNTERMINATED_STRING", line: 1 });
  });

  it("catches a misspelled unit attached to a number", () => {
    const result = parse("create object ball (speed 40vmn)");
    expect(result.diagnostics[0]).toMatchObject({ code: "E_UNKNOWN_UNIT" });
    expect(result.diagnostics[0]?.hint).toContain("vmin");
  });

  it("tells a digit-leading filename to quote itself rather than calling it a unit", () => {
    const result = parse("create object ball (sprite 8bit.png)");
    expect(result.diagnostics[0]?.message).toContain("'8bit.png' is not a name");
    expect(result.diagnostics[0]?.hint).toContain('"8bit.png"');
    expect(statements('create object ball (sprite "8bit.png")')).toHaveLength(1);
  });

  it("leaves a spaced keyword after a number alone", () => {
    expect(statements("stream course from gap.dmtl, pipe.dmtl 20 wide")).toHaveLength(1);
    expect(statements("when score1.value reaches 10 in play then scene as gameover")).toHaveLength(
      1,
    );
  });

  it("catches one list setting the same property twice, in either form", () => {
    for (const source of [
      "create ball ball1 in play (x 1, y 2, x 9)",
      "create ball ball1 in play (x, y, x) as (1, 2, 9)",
      "when always in play then (ball1.x 1, ball1.x 9)",
    ]) {
      expect(parse(source).diagnostics[0], source).toMatchObject({ code: "E_DUPLICATE_PROP" });
    }
  });

  it("allows the same property on two different objects, and in then vs else", () => {
    expect(statements("when always in play then (ball1.x 1, ball2.x 9)")).toHaveLength(1);
    expect(statements("when ball1.x > 1 in play then ball1.y as 1 else ball1.y as 3")).toHaveLength(
      1,
    );
  });
});
