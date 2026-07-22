import { encodeRgbaPng, prep } from "@demake/core";
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

const utf8 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};

describe("demake gen", () => {
  it("requires --console", async () => {
    const h = harness({ files: { "in.png": samplePng() } });
    expect(await run(["gen", "in.png"], h.env)).toBe(EXIT.USAGE);
  });

  it("writes an asm file for a raw image (implicit prep)", async () => {
    const h = harness({ files: { "in.png": samplePng() } });
    const code = await run(
      ["gen", "in.png", "-c", "gbc", "--format", "asm", "-o", "portrait.asm"],
      h.env,
    );
    expect(code).toBe(EXIT.OK);
    const asm = utf8(h.files.get("portrait.asm")!);
    expect(asm).toContain("_tiles::");
    expect(asm).toContain("do not edit by hand");
  });

  it("writes c + h under a stem", async () => {
    const h = harness({ files: { "in.png": samplePng() } });
    expect(await run(["gen", "in.png", "-c", "gbc", "--format", "c", "-o", "gfx"], h.env)).toBe(
      EXIT.OK,
    );
    expect(h.files.has("gfx.c")).toBe(true);
    expect(h.files.has("gfx.h")).toBe(true);
  });

  it("writes bin blobs under a stem derived from the input", async () => {
    const h = harness({ files: { "tiles.png": samplePng() } });
    expect(await run(["gen", "tiles.png", "-c", "gbc", "--format", "bin"], h.env)).toBe(EXIT.OK);
    expect(h.files.has("tiles.tiles.bin")).toBe(true);
    expect(h.files.has("tiles.map.bin")).toBe(true);
    expect(h.files.has("tiles.attr.bin")).toBe(true);
    expect(h.files.has("tiles.pal.bin")).toBe(true);
  });

  it("streams a single asm blob to stdout when piped", async () => {
    const png = samplePng();
    const h = harness({ stdin: png, stdoutTTY: false });
    expect(await run(["gen", "-", "-c", "gbc", "--format", "asm"], h.env)).toBe(EXIT.OK);
    expect(h.stdoutBytes().length).toBe(1);
    expect(utf8(h.stdoutBytes()[0]!)).toContain("_tiles::");
  });

  it("emits a JSON report of files with hashes", async () => {
    const h = harness({ files: { "in.png": samplePng() } });
    expect(
      await run(["gen", "in.png", "-c", "gbc", "--format", "bin", "-o", "g", "--json"], h.env),
    ).toBe(EXIT.OK);
    const report = JSON.parse(h.out());
    expect(report.format).toBe("bin");
    expect(report.path).toBe("prepped");
    expect(report.files.length).toBe(4);
    expect(report.files[0].hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("takes the exact path on already-compliant input", async () => {
    const prepped = await prep(samplePng(), { console: "gbc" });
    const h = harness({ files: { "c.png": prepped.png } });
    expect(
      await run(["gen", "c.png", "-c", "gbc", "--format", "asm", "-o", "x.asm", "--json"], h.env),
    ).toBe(EXIT.OK);
    expect(JSON.parse(h.out()).path).toBe("compliant");
  });

  it("fails under --strict when the input is not compliant", async () => {
    const h = harness({ files: { "in.png": samplePng() } });
    const code = await run(["gen", "in.png", "-c", "gbc", "--strict", "-o", "x.asm"], h.env);
    expect(code).toBe(EXIT.FAILURE);
  });

  it("rejects --format rom with the toolchain exit code", async () => {
    const prepped = await prep(samplePng(), { console: "gbc" });
    const h = harness({ files: { "c.png": prepped.png } });
    const code = await run(["gen", "c.png", "-c", "gbc", "--format", "rom", "-o", "x.gb"], h.env);
    expect(code).toBe(EXIT.UNAVAILABLE);
  });

  it("refuses to overwrite without --force", async () => {
    const h = harness({ files: { "in.png": samplePng(), "out.asm": new Uint8Array([1]) } });
    const code = await run(
      ["gen", "in.png", "-c", "gbc", "--format", "asm", "-o", "out.asm"],
      h.env,
    );
    expect(code).toBe(EXIT.CANNOT_CREATE);
  });

  it("consumes a matching manifest (pinned palette order)", async () => {
    const prepped = await prep(samplePng(), { console: "gbc" });
    const manifest = {
      schemaVersion: 1,
      console: "gbc",
      width: prepped.image.width,
      height: prepped.image.height,
      palettes: prepped.image.palettes.map((p) =>
        p.colors.map((c) => ({ codes: c.codes, display: c.display })),
      ),
    };
    const manifestBytes = new Uint8Array([...JSON.stringify(manifest)].map((c) => c.charCodeAt(0)));
    const h = harness({ files: { "c.png": prepped.png, "m.json": manifestBytes } });
    const code = await run(
      [
        "gen",
        "c.png",
        "-c",
        "gbc",
        "--manifest",
        "m.json",
        "--format",
        "asm",
        "-o",
        "x.asm",
        "--json",
      ],
      h.env,
    );
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(h.out()).path).toBe("manifest");
  });
});
