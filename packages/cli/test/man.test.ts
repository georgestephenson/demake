import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { allManPages } from "@demake/cli-spec";
import { describe, expect, it } from "vitest";

/**
 * Man pages are generated, never hand-edited (doc 05 §Single source of truth).
 * This is the staleness guard: the checked-in `packages/cli/man/*.1` must match
 * what the generator produces from the spec, so a flag change that forgets to
 * `pnpm --filter demake gen:man` fails CI instead of shipping stale docs.
 */
describe("man page staleness", () => {
  for (const page of allManPages()) {
    it(`${page.filename} matches the generator`, () => {
      const path = fileURLToPath(new URL(`../man/${page.filename}`, import.meta.url));
      const onDisk = readFileSync(path, "utf8");
      expect(onDisk).toBe(page.content);
    });
  }
});
