import { describe, expect, it } from "vitest";

import {
  allManPages,
  commandHelp,
  findCommand,
  missingRequired,
  ParseError,
  parseCommand,
  topHelp,
  topMan,
} from "../src/index.js";

const prep = findCommand("prep")!;

describe("parser", () => {
  it("parses long options with space or = values", () => {
    const a = parseCommand(prep, ["--console", "gbc"]);
    const b = parseCommand(prep, ["--console=gbc"]);
    expect(a.values.console).toBe("gbc");
    expect(b.values.console).toBe("gbc");
  });

  it("parses short options and bundles", () => {
    const r = parseCommand(prep, ["-c", "gbc", "-vv"]);
    expect(r.values.console).toBe("gbc");
    expect(r.values.verbose).toBe(2);
  });

  it("takes a value from the tail of a short bundle", () => {
    const r = parseCommand(prep, ["-cgbc"]);
    expect(r.values.console).toBe("gbc");
  });

  it("parses WxH sizes and rejects bad ones", () => {
    expect(parseCommand(prep, ["-c", "gbc", "--size", "128x112"]).values.size).toEqual({
      w: 128,
      h: 112,
    });
    expect(() => parseCommand(prep, ["-c", "gbc", "--size", "big"])).toThrow(ParseError);
  });

  it("validates enum values", () => {
    expect(() => parseCommand(prep, ["-c", "gbc", "--effort", "turbo"])).toThrow(/one of/);
    expect(parseCommand(prep, ["-c", "gbc", "--effort", "max"]).values.effort).toBe("max");
  });

  it("honors -- end of options", () => {
    const r = parseCommand(prep, ["-c", "gbc", "--", "-weird-name.png"]);
    expect(r.positionals).toEqual(["-weird-name.png"]);
  });

  it("treats - as a positional (stdin)", () => {
    const r = parseCommand(prep, ["-c", "gbc", "-"]);
    expect(r.positionals).toEqual(["-"]);
  });

  it("rejects unknown options", () => {
    expect(() => parseCommand(prep, ["--nope"])).toThrow(/unknown option/);
  });

  it("reports missing required flags", () => {
    const r = parseCommand(prep, []);
    expect(missingRequired(prep, r.values)).toContain("console");
  });

  it("applies defaults", () => {
    const r = parseCommand(prep, ["-c", "gbc"]);
    expect(r.values.strategy).toBe("auto");
    expect(r.values.effort).toBe("default");
  });
});

describe("help generation", () => {
  it("top help lists commands and stays within 100 cols", () => {
    const text = topHelp();
    expect(text).toContain("prep");
    expect(text).toContain("consoles");
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });
  it("command help lists flags and examples", () => {
    const text = commandHelp(prep);
    expect(text).toContain("--console");
    expect(text).toContain("Examples:");
  });
});

describe("man generation", () => {
  it("is deterministic (no timestamps)", () => {
    expect(topMan().content).toBe(topMan().content);
    expect(allManPages().map((p) => p.filename)).toEqual([
      "demake.1",
      "demake-prep.1",
      "demake-consoles.1",
      "demake-inspect.1",
    ]);
  });
  it("emits roff with the expected sections", () => {
    const man = topMan().content;
    expect(man).toContain(".TH DEMAKE 1");
    expect(man).toContain(".SH EXIT STATUS");
    expect(man).toContain(".SH COMMANDS");
  });
});
