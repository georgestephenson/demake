import { encodeRgbaPng, decodePng } from "@demake/core";
import { describe, expect, it } from "vitest";

import type { CliEnv } from "../src/env.js";
import { EXIT } from "../src/exit-codes.js";
import { run } from "../src/run.js";

interface Harness {
  env: CliEnv;
  out: () => string;
  err: () => string;
  stdoutBytes: () => Uint8Array[];
  files: Map<string, Uint8Array>;
}

function harness(
  opts: { stdin?: Uint8Array | null; stdoutTTY?: boolean; files?: Record<string, Uint8Array> } = {},
): Harness {
  let out = "";
  let err = "";
  const stdoutBytes: Uint8Array[] = [];
  const files = new Map<string, Uint8Array>(Object.entries(opts.files ?? {}));
  const env: CliEnv = {
    out: (t) => {
      out += t;
    },
    errOut: (t) => {
      err += t;
    },
    writeStdout: (b) => {
      stdoutBytes.push(b);
    },
    readFile: (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT ${p}`);
      return f;
    },
    writeFileAtomic: (p, bytes, force) => {
      if (!force && files.has(p)) {
        const e = new Error("exists");
        (e as { code?: string }).code = "EEXIST";
        throw e;
      }
      files.set(p, bytes);
    },
    readStdin: () => opts.stdin ?? null,
    stdoutIsTTY: () => opts.stdoutTTY ?? false,
    stdinIsTTY: () => opts.stdin === undefined,
    env: {},
    which: () => null,
    run: () => ({ code: 127, stdout: "", stderr: "" }),
    makeTempDir: () => "/tmp/demake-test",
    removeDir: () => {},
    harnessDir: () => null,
  };
  return { env, out: () => out, err: () => err, stdoutBytes: () => stdoutBytes, files };
}

function samplePng(size = 32): Uint8Array {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      d[o] = Math.round((x / (size - 1)) * 255);
      d[o + 1] = Math.round((y / (size - 1)) * 255);
      d[o + 2] = 100;
      d[o + 3] = 255;
    }
  }
  return encodeRgbaPng(size, size, d);
}

describe("global flags", () => {
  it("--version prints a semver line and reports core", async () => {
    const h = harness();
    const code = await run(["--version"], h.env);
    expect(code).toBe(EXIT.OK);
    expect(h.out()).toMatch(/^demake \d+\.\d+\.\d+/);
    expect(h.out()).toContain("core ");
  });

  it("--help prints usage", async () => {
    const h = harness();
    expect(await run(["--help"], h.env)).toBe(EXIT.OK);
    expect(h.out()).toContain("Usage:");
    expect(h.out()).toContain("prep");
  });

  it("no args prints top help", async () => {
    const h = harness();
    expect(await run([], h.env)).toBe(EXIT.OK);
    expect(h.out()).toContain("Commands:");
  });

  it("unknown command exits 2", async () => {
    const h = harness();
    expect(await run(["frobnicate"], h.env)).toBe(EXIT.USAGE);
    expect(h.err()).toContain("unknown command");
  });

  it("planned commands exit UNAVAILABLE", async () => {
    const h = harness();
    expect(await run(["completion"], h.env)).toBe(EXIT.UNAVAILABLE);
  });
});

describe("command help", () => {
  it("prep --help lists options", async () => {
    const h = harness();
    expect(await run(["prep", "--help"], h.env)).toBe(EXIT.OK);
    expect(h.out()).toContain("--console");
    expect(h.out()).toContain("--dither");
  });
  it("help <cmd> works", async () => {
    const h = harness();
    await run(["help", "consoles"], h.env);
    expect(h.out()).toContain("consoles");
  });
});

describe("consoles", () => {
  it("prints a table", async () => {
    const h = harness();
    expect(await run(["consoles"], h.env)).toBe(EXIT.OK);
    expect(h.out()).toContain("gbc");
    expect(h.out()).toContain("dmg");
  });
  it("--json dumps specs with strategies", async () => {
    const h = harness();
    await run(["consoles", "--json"], h.env);
    const parsed = JSON.parse(h.out());
    expect(parsed.consoles.length).toBeGreaterThanOrEqual(2);
    expect(parsed.consoles[0].strategies.length).toBeGreaterThan(0);
  });
});

describe("prep", () => {
  it("converts a file to a compliant PNG and reports JSON", async () => {
    const h = harness({ files: { "in.png": samplePng() } });
    const code = await run(["prep", "in.png", "-c", "gbc", "-o", "out.png", "--json"], h.env);
    expect(code).toBe(EXIT.OK);
    expect(h.files.has("out.png")).toBe(true);
    const report = JSON.parse(h.out());
    expect(report.output).toBe("out.png");
    expect(report.tournament.winner).toBeTruthy();
    const decoded = decodePng(h.files.get("out.png")!);
    expect(decoded.width).toBe(32);
  });

  it("requires --console", async () => {
    const h = harness({ files: { "in.png": samplePng() } });
    expect(await run(["prep", "in.png"], h.env)).toBe(EXIT.USAGE);
    expect(h.err()).toContain("--console");
  });

  it("rejects an unknown console with usage exit", async () => {
    const h = harness({ files: { "in.png": samplePng() } });
    expect(await run(["prep", "in.png", "-c", "zzz"], h.env)).toBe(EXIT.USAGE);
  });

  it("refuses binary to a TTY without -o", async () => {
    const h = harness({ files: { "in.png": samplePng() }, stdoutTTY: true });
    const code = await run(["prep", "in.png", "-c", "gbc"], h.env);
    expect(code).toBe(EXIT.USAGE);
    expect(h.err()).toContain("terminal");
  });

  it("writes to stdout when piped (no -o)", async () => {
    const h = harness({ files: { "in.png": samplePng() }, stdoutTTY: false });
    const code = await run(["prep", "in.png", "-c", "gbc"], h.env);
    expect(code).toBe(EXIT.OK);
    expect(h.stdoutBytes().length).toBe(1);
  });

  it("reads from stdin with '-'", async () => {
    const h = harness({ stdin: samplePng() });
    const code = await run(["prep", "-", "-c", "dmg", "-o", "o.png"], h.env);
    expect(code).toBe(EXIT.OK);
    expect(h.files.has("o.png")).toBe(true);
  });

  it("--strategy list enumerates candidates without input", async () => {
    const h = harness();
    expect(await run(["prep", "-c", "gbc", "--strategy", "list"], h.env)).toBe(EXIT.OK);
    expect(h.out()).toContain("art-majority-flat");
  });

  it("emits a manifest sidecar on request", async () => {
    const h = harness({ files: { "in.png": samplePng() } });
    await run(["prep", "in.png", "-c", "gbc", "-o", "out.png", "--emit-manifest", "m.json"], h.env);
    expect(h.files.has("m.json")).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(h.files.get("m.json")!));
    expect(manifest.console).toBe("gbc");
    expect(Array.isArray(manifest.palettes)).toBe(true);
  });

  it("is deterministic across CLI runs", async () => {
    const png = samplePng();
    const a = harness({ files: { "in.png": png } });
    const b = harness({ files: { "in.png": png } });
    await run(["prep", "in.png", "-c", "gbc", "-o", "o.png"], a.env);
    await run(["prep", "in.png", "-c", "gbc", "-o", "o.png"], b.env);
    expect(Array.from(a.files.get("o.png")!)).toEqual(Array.from(b.files.get("o.png")!));
  });
});

describe("inspect", () => {
  it("reports compliance for a prepped image", async () => {
    const h = harness({ files: { "in.png": samplePng() } });
    await run(["prep", "in.png", "-c", "gbc", "-o", "out.png"], h.env);
    const code = await run(["inspect", "out.png", "-c", "gbc", "--json"], h.env);
    expect(code).toBe(EXIT.OK);
    const report = JSON.parse(h.out());
    expect(report.consoles[0].compliant).toBe(true);
  });

  it("judges fidelity with --source", async () => {
    const h = harness({ files: { "in.png": samplePng() } });
    await run(["prep", "in.png", "-c", "gbc", "-o", "out.png"], h.env);
    await run(["inspect", "out.png", "--source", "in.png", "--json"], h.env);
    const report = JSON.parse(h.out());
    expect(report.judge.aggregate).toBeGreaterThan(0);
  });
});
