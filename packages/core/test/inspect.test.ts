import { describe, expect, it } from "vitest";

import { consoles, findConsole, getConsole } from "../src/consoles/registry.js";
import { encodeRgbaPng } from "../src/image/png/encode.js";
import { inspect } from "../src/inspect/inspect.js";
import { strategies } from "../src/strategies.js";

describe("console registry", () => {
  it("lists consoles sorted by tier then id", () => {
    const list = consoles();
    expect(list.map((c) => c.id)).toContain("gbc");
    expect(list.map((c) => c.id)).toContain("dmg");
  });
  it("resolves aliases case-insensitively", () => {
    expect(findConsole("cgb")?.id).toBe("gbc");
    expect(findConsole("GAMEBOY")?.id).toBe("dmg");
    expect(findConsole("nope")).toBeUndefined();
  });
  it("throws a typed error for unknown consoles", () => {
    expect(() => getConsole("nope")).toThrow(/unknown console/);
  });
  it("exposes a candidate portfolio per console", () => {
    expect(strategies("gbc").length).toBeGreaterThan(1);
    expect(strategies("dmg").map((s) => s.id)).toContain("mono-flat");
  });
});

describe("inspect compliance oracle", () => {
  it("flags an image with too many colors per cell", () => {
    // An 8×8 image where the single cell holds 16 distinct colors (> GBC's 4).
    const rgba = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 64; i += 1) {
      rgba[i * 4] = (i * 4) & 0xff;
      rgba[i * 4 + 1] = (i * 8) & 0xff;
      rgba[i * 4 + 2] = (i * 16) & 0xff;
      rgba[i * 4 + 3] = 255;
    }
    const png = encodeRgbaPng(8, 8, rgba);
    const report = inspect(png, { console: "gbc" });
    expect(report.consoles[0]!.compliant).toBe(false);
    expect(report.consoles[0]!.violations.some((v) => v.code === "E_CELL_COLORS")).toBe(true);
  });

  it("accepts a flat single-color image", () => {
    const rgba = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 64; i += 1) {
      rgba[i * 4 + 3] = 255; // opaque black — on every lattice as (0,0,0)? mono needs a shade
    }
    const png = encodeRgbaPng(8, 8, rgba);
    const report = inspect(png, { console: "gbc" });
    expect(report.consoles[0]!.compliant).toBe(true);
  });
});
