import { describe, expect, it } from "vitest";

import { EXIT } from "../src/exit-codes.js";
import { run } from "../src/run.js";

/** Collect stdout/stderr from a single {@link run} invocation. */
function capture(argv: readonly string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = run(argv, {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
  });
  return { code, out, err };
}

describe("--version", () => {
  it("prints a semver line to stdout and exits 0", () => {
    const { code, out, err } = capture(["--version"]);
    expect(code).toBe(EXIT.OK);
    expect(out).toMatch(/^demake \d+\.\d+\.\d+/);
    expect(err).toBe("");
  });

  it("accepts the -V short flag", () => {
    const { code, out } = capture(["-V"]);
    expect(code).toBe(EXIT.OK);
    expect(out).toMatch(/^demake \d+\.\d+\.\d+/);
  });

  it("reports the core version it imported (proves the workspace link)", () => {
    const { out } = capture(["--version"]);
    expect(out).toContain("core ");
  });
});

describe("--help", () => {
  it("prints usage to stdout and exits 0", () => {
    const { code, out, err } = capture(["--help"]);
    expect(code).toBe(EXIT.OK);
    expect(out).toContain("Usage:");
    expect(err).toBe("");
  });

  it("responds to -h, the help subcommand, and no arguments", () => {
    for (const argv of [["-h"], ["help"], []]) {
      const { code, out } = capture(argv);
      expect(code).toBe(EXIT.OK);
      expect(out).toContain("Usage:");
    }
  });

  it("keeps every help line within 100 columns", () => {
    const { out } = capture(["--help"]);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("-- end-of-options separator", () => {
  it("absorbs a leading -- (the pnpm cli -- <args> workflow)", () => {
    expect(capture(["--", "--version"]).code).toBe(EXIT.OK);
    expect(capture(["--", "--version"]).out).toMatch(/^demake \d+\.\d+\.\d+/);
    expect(capture(["--", "--help"]).out).toContain("Usage:");
    expect(capture(["--", "prep"]).code).toBe(EXIT.UNAVAILABLE);
  });
});

describe("errors", () => {
  it("rejects an unknown command with a usage error (exit 2)", () => {
    const { code, out, err } = capture(["frobnicate"]);
    expect(code).toBe(EXIT.USAGE);
    expect(out).toBe("");
    expect(err).toContain("unknown command");
  });

  it("reports planned-but-unbuilt commands as unavailable (exit 69)", () => {
    for (const command of ["prep", "gen", "consoles", "inspect", "completion"]) {
      const { code, err } = capture([command]);
      expect(code).toBe(EXIT.UNAVAILABLE);
      expect(err).toContain("not available yet");
    }
  });
});
