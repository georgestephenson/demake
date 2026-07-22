import { describe, expect, it } from "vitest";

import { CORE_VERSION, greeting } from "../src/index.js";

describe("greeting", () => {
  it("greets the world by default", () => {
    expect(greeting()).toBe("demake core says hello, world");
  });

  it("greets a named target", () => {
    expect(greeting("gbc")).toBe("demake core says hello, gbc");
  });

  it("is deterministic across calls", () => {
    expect(greeting("nes")).toBe(greeting("nes"));
  });
});

describe("CORE_VERSION", () => {
  it("is a semver-shaped string", () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
