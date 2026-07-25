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
    expect(statements("loop title -- enters here\n-- a whole comment line\n")).toHaveLength(1);
  });

  it("parses a collision list with several targets", () => {
    const [statement] = statements("when ball hits screenleft, screenright (xdirection) as flip");
    expect(statement).toMatchObject({
      kind: "when",
      event: { kind: "hits", subject: "ball", others: ["screenleft", "screenright"] },
    });
  });

  it("parses a level predicate and an edge `reaches`", () => {
    const [predicate] = statements("when ball1.x < paddle2.x in play (paddle2.xdirection) as -1");
    expect(predicate).toMatchObject({ kind: "when", event: { kind: "predicate" }, scene: "play" });

    const [reaches] = statements("when score1.value reaches 10 (score1.value) as 0");
    expect(reaches).toMatchObject({ kind: "when", event: { kind: "reaches" } });
  });

  it("parses input edges", () => {
    const [statement] = statements("when start pressed (scene) as play");
    expect(statement).toMatchObject({
      kind: "when",
      event: { kind: "input", action: "start", edge: "pressed" },
    });
  });

  it("recovers per line, so one bad statement does not hide the rest", () => {
    const result = parse(
      ["loop title", "wibble wobble", "scene title", "create object ((", "scene play"].join("\n"),
    );
    expect(result.statements.map((s) => s.kind)).toEqual(["loop", "scene", "scene"]);
    expect(result.diagnostics.map((d) => d.line)).toEqual([2, 4]);
  });

  it("rejects two statements on one line rather than silently joining them", () => {
    const result = parse("loop title scene title");
    expect(result.diagnostics[0]?.hint).toContain("one per line");
  });
});
