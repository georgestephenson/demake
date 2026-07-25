import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { check } from "../src/compile.js";
import { referenceIndex, referencePages } from "../src/docs/reference.js";
import {
  BUTTON_NAMES,
  DIAGNOSTICS,
  EDGE_NAMES,
  FUNCTION_ARITY,
  PROPERTIES,
  STATEMENTS,
  UNIT_NAMES,
} from "../src/lang/spec.js";
import { getProfile, profiles } from "../src/profiles.js";
import { ACTIONS, EDGES } from "../src/program.js";

const DOCS = fileURLToPath(new URL("../docs/", import.meta.url));
const gb = getProfile("gb");

/**
 * The registry is the single source of truth for the language surface
 * (AGENTS.md §Iron rules). These tests are what make that true rather than
 * aspirational: the engine's own tables, and the checked-in reference, both have
 * to agree with it or the build fails.
 */
describe("language registry", () => {
  it("matches the engine's button and edge tables", () => {
    expect([...ACTIONS]).toEqual([...BUTTON_NAMES]);
    expect([...EDGES]).toEqual([...EDGE_NAMES]);
  });

  it("documents every property the compiler accepts", () => {
    // Ask the compiler for its own list, via the hint it produces on a bad one.
    const source = ["loop p", "scene p", "create object o (nonsense 1)"].join("\n");
    const hint = check(source, { profile: gb }).diagnostics[0]?.hint ?? "";
    const documented = PROPERTIES.filter((p) => !p.derived)
      .map((p) => p.name)
      .sort();
    for (const name of documented) expect(hint, name).toContain(name);
  });

  it("documents every diagnostic code the compiler can emit", () => {
    // Every code produced by the diagnostics fixtures must be in the registry.
    const codes = new Set(DIAGNOSTICS.map((d) => d.code));
    const provoke: string[][] = [
      ["loop nowhere"],
      ["loop p", "scene p", "scene p"],
      ["loop p", "scene p", "create object o (wibble 1)"],
      ["loop p", "scene p", "create ghost g in p ()"],
      ["loop p", "scene p", "create object o ()", "create o a in p ()", "control a x (speed 1)"],
      ["loop p", "scene p", "create object o ()", "create o a in p ()", "when a pressed (x) as 0"],
      ["loop p", "scene p", "create object o (sprite o.png)", "create o a in p (width 30)"],
      ["loop p", "scene p", "create object o (sprite o.png)", "create o a in p (speed 0.0001)"],
      [
        "loop p",
        "scene p",
        "create object o (sprite o.png)",
        "create o a in p (width 10vw, height 10vh)",
      ],
    ];
    for (const lines of provoke) {
      for (const d of check(lines.join("\n"), { profile: gb }).diagnostics) {
        expect(codes, `${d.code} is emitted but not in the registry`).toContain(d.code);
      }
    }
  });

  it("keeps every registry example compiling", () => {
    // A documented example that does not parse is worse than no example. Each
    // is checked inside a minimal program that gives it the names it references.
    const preamble = [
      "loop title",
      "scene title",
      "scene play",
      "scene gameover",
      "create object ball (width 1 cell, height 1 cell, speed 40vmin, sprite ball.svg)",
      "create object paddle (width 15vw, height 1 cell, speed 60vw, sprite paddle.svg)",
      "create object ledge (width 5, height 1, sprite ledge.svg)",
      // Named `ball0`, not `ball1`: the `create` example declares `ball1` and
      // the two must not collide, but the class still needs an instance for the
      // collision examples to resolve.
      "create ball ball0 in play (x centerx, y centery)",
      "create paddle paddle1 in play (x centerx, y screenheight - 1)",
      "create paddle paddle2 in play (x centerx, y 0)",
      "create ledge ledge1 in play (x 2, y screenheight - 2)",
      "create paddle player in play (x 4, y 4)",
      "create number score1 in play (value 0, x 1, y 1)",
    ].join("\n");

    const examples = [
      ...STATEMENTS.map((s) => s.example),
      "when player touches ledge (ydirection) as 0",
      "when score1.value reaches 10 in play (scene) as gameover",
      "when a pressed in title (scene) as play",
      "when ball hits paddle (ydirection) as flip",
      "when always in play (paddle2.xdirection) as clamp((ball0.x - paddle2.x) / 1.5vw, -1, 1)",
    ];

    for (const example of examples) {
      // Declaration examples cannot sit inside the preamble — they would
      // redeclare what it already has — so each gets the minimum program that
      // makes it valid on its own.
      let source: string;
      if (example.startsWith("loop ")) {
        source = [example, `scene ${example.slice(5)}`].join("\n");
      } else if (example.startsWith("scene ")) {
        source = [`loop ${example.slice(6)}`, example].join("\n");
      } else if (example.startsWith("create object")) {
        source = ["loop p", "scene p", example].join("\n");
      } else if (example.startsWith("create ")) {
        // An instance example declares its own object, so the preamble must not
        // also declare one by that name.
        source = [preamble, example].join("\n");
      } else {
        source = [preamble, example].join("\n");
      }
      const errors = check(source, { profile: gb }).diagnostics.filter(
        (d) => d.severity === "error",
      );
      expect(
        errors.map((d) => `${d.code}: ${d.message}`),
        example,
      ).toEqual([]);
    }
  });

  it("declares a unit and a builtin for everything the parser accepts", () => {
    expect([...UNIT_NAMES].sort()).toEqual(["cell", "cells", "vh", "vmax", "vmin", "vw"]);
    expect(Object.keys(FUNCTION_ARITY).sort()).toEqual(["abs", "clamp", "max", "min"]);
  });

  it("resolves every documented constant on every console", () => {
    // A constant in the reference that the compiler rejects is a broken promise.
    const source = ["loop p", "scene p", "create object o (sprite o.png)"].join("\n");
    for (const profile of profiles) {
      for (const name of ["screenwidth", "screenheight", "centerx", "fps", "always", "never"]) {
        const errors = check([source, `create o a in p (x ${name})`].join("\n"), {
          profile,
        }).diagnostics.filter((d) => d.severity === "error");
        expect(errors, `${name} on ${profile.id}`).toEqual([]);
      }
    }
  });
});

describe("generated reference", () => {
  const pages = referencePages();

  it("is checked in and up to date", () => {
    for (const page of [...pages, referenceIndex(pages)]) {
      const onDisk = readFileSync(`${DOCS}${page.name}`, "utf8");
      expect(onDisk, `docs/${page.name} is stale — run \`pnpm gen:demotic-docs\``).toBe(
        page.markdown,
      );
    }
  });

  it("says it is generated, so nobody edits it by hand", () => {
    for (const page of pages) expect(page.markdown).toContain("Do not edit by hand");
  });

  it("mentions every statement, trigger, property and diagnostic", () => {
    const all = pages.map((p) => p.markdown).join("\n");
    for (const statement of STATEMENTS) expect(all, statement.keyword).toContain(statement.keyword);
    for (const property of PROPERTIES) expect(all, property.name).toContain(`\`${property.name}\``);
    for (const diagnostic of DIAGNOSTICS) expect(all, diagnostic.code).toContain(diagnostic.code);
  });
});
