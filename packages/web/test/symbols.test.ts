/**
 * Every statement has a symbol (doc 19 §The palette is generated, and so are the
 * choices).
 *
 * The palette is generated from the language's own registries, and the symbols
 * are the page's — so the one thing that can go wrong is the registry growing and
 * the page not keeping up, which draws a blank square in a palette nobody looks
 * at twice. That is exactly the failure `spec.test.ts` exists to prevent one layer
 * down, and this is its counterpart: a statement added to `STATEMENTS` or
 * `TEST_STATEMENTS` fails here until it has been drawn.
 *
 * It goes the other way too. A symbol for a keyword no registry lists is a
 * statement that was removed and left a picture behind, which is how a palette
 * comes to advertise something the parser rejects.
 */

import { describe, expect, it } from "vitest";

import { STATEMENTS, TEST_STATEMENTS } from "@demake/demotic";

import { hasSymbol, KEYWORDS_DRAWN } from "../src/components/StatementSymbol.js";

describe("statement symbols", () => {
  it("draws every statement both registries list", () => {
    for (const spec of [...STATEMENTS, ...TEST_STATEMENTS]) {
      expect(hasSymbol(spec.keyword), `${spec.keyword} has a symbol`).toBe(true);
    }
  });

  it("draws nothing the registries do not list", () => {
    const known = new Set([...STATEMENTS, ...TEST_STATEMENTS].map((spec) => spec.keyword));
    for (const keyword of KEYWORDS_DRAWN) {
      expect(known, `${keyword} is a statement`).toContain(keyword);
    }
  });
});
