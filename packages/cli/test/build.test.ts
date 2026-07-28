/**
 * `demake build` — the game path's CLI edge.
 *
 * Two properties matter more than the flag handling: the command needs no
 * toolchain (the assembler is ours, in TypeScript), and it *refuses* rather than
 * building a cartridge that would play a different game from the preview.
 * Everything else here is the usual exit-code surface (doc 05).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CliEnv } from "../src/env.js";
import { EXIT } from "../src/exit-codes.js";
import { run } from "../src/run.js";

const fixtures = join(import.meta.dirname, "..", "..", "demotic", "fixtures");
const read = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));

function harness(files: Record<string, Uint8Array> = {}) {
  let out = "";
  let err = "";
  const written = new Map<string, Uint8Array>();
  const sources = new Map<string, Uint8Array>(Object.entries(files));
  const env: CliEnv = {
    out: (t) => {
      out += t;
    },
    errOut: (t) => {
      err += t;
    },
    writeStdout: () => {},
    readFile: (p) => {
      const found = sources.get(p) ?? written.get(p);
      if (!found) throw new Error(`ENOENT ${p}`);
      return found;
    },
    writeFileAtomic: (p, bytes) => {
      written.set(p, bytes);
    },
    readStdin: () => null,
    stdoutIsTTY: () => true,
    stdinIsTTY: () => false,
    env: {},
    // No toolchain anywhere: building a game ROM must not need one.
    which: () => null,
    run: () => ({ code: 127, stdout: "", stderr: "" }),
    makeTempDir: () => "/tmp/demake-test",
    removeDir: () => {},
    harnessDir: () => null,
  };
  return { env, out: () => out, err: () => err, written };
}

describe("demake build", () => {
  it("writes a 32 KiB cartridge with no toolchain installed", async () => {
    const h = harness({ "pong.dmt": read("pong.dmt") });
    const code = await run(["build", "pong.dmt", "-o", "pong.gb", "--title", "PONG"], h.env);
    expect(code).toBe(EXIT.OK);
    const rom = h.written.get("pong.gb") as Uint8Array;
    expect(rom.length).toBe(0x8000);
    expect(String.fromCharCode(...rom.subarray(0x134, 0x138))).toBe("PONG");
    expect(h.err()).toContain("Game Boy (gb)");
  });

  it("reports what it built as JSON", async () => {
    const h = harness({ "pong.dmt": read("pong.dmt") });
    expect(await run(["build", "pong.dmt", "-o", "pong.gb", "--json"], h.env)).toBe(EXIT.OK);
    const report = JSON.parse(h.out()) as {
      console: string;
      bytes: number;
      rom: { rules: number; free: number; ram: number; helpers: string[] };
    };
    expect(report.console).toBe("gb");
    expect(report.bytes).toBe(0x8000);
    expect(report.rom.rules).toBeGreaterThan(0);
    expect(report.rom.free).toBeGreaterThan(0);
    expect(report.rom.ram).toBeGreaterThan(0);
    // Pong divides, multiplies, and draws (the opponent's wandering aim).
    expect(report.rom.helpers).toContain("Div32");
    expect(report.rom.helpers).toContain("Mul32");
    expect(report.rom.helpers).toContain("RngPick");
  });

  it("emits the symbol map of the code it generated when asked", async () => {
    const h = harness({ "pong.dmt": read("pong.dmt") });
    expect(await run(["build", "pong.dmt", "--format", "sym", "-o", "p.sym"], h.env)).toBe(EXIT.OK);
    const map = new TextDecoder().decode(h.written.get("p.sym") as Uint8Array);
    // The no-bank RGBDS format, so a profiler can bucket cycles by rule.
    expect(map).toMatch(/^00:[0-9a-f]{4} \S+$/m);
    expect(map).toContain("Main");
  });

  it("builds a level game with a camera, which the fixed engine could not", async () => {
    const h = harness({
      "caves.dmt": read(join("games", "caves.dmt")),
      "cavern.dmtl": read(join("games", "cavern.dmtl")),
    });
    expect(await run(["build", "caves.dmt", "-o", "caves.gb"], h.env)).toBe(EXIT.OK);
    expect((h.written.get("caves.gb") as Uint8Array).length).toBe(0x8000);
  });

  it("refuses a console with no backend, naming the ones that have one", async () => {
    // `snes` is the one profile left without a backend, and the example moves as
    // backends land: this said `md` until the Mega Drive built.
    const h = harness({ "pong.dmt": read("pong.dmt") });
    expect(await run(["build", "pong.dmt", "-c", "snes", "-o", "pong.bin"], h.env)).toBe(
      EXIT.UNAVAILABLE,
    );
    expect(h.err()).toContain("no console runtime");
  });

  it("builds a Mega Drive cartridge, vectors and header and all", async () => {
    const h = harness({ "pong.dmt": read("pong.dmt") });
    expect(await run(["build", "pong.dmt", "-c", "md", "-o", "pong.md"], h.env)).toBe(EXIT.OK);
    const rom = h.written.get("pong.md") as Uint8Array;
    expect(rom.length).toBe(0x80000);
    expect(String.fromCharCode(...rom.subarray(0x100, 0x110))).toBe("SEGA MEGA DRIVE ");
  });

  it("reports every compile diagnostic instead of the first", async () => {
    const h = harness({
      "bad.dmt": new TextEncoder().encode("start play\nscene play\ncreate object d (wibble 1)\n"),
    });
    expect(await run(["build", "bad.dmt", "-o", "bad.gb"], h.env)).toBe(EXIT.BAD_INPUT);
    expect(h.err()).toContain("E_UNKNOWN_PROP");
  });

  it("needs rgbfix for --boot-logo, and says so", async () => {
    const h = harness({ "pong.dmt": read("pong.dmt") });
    expect(await run(["build", "pong.dmt", "-o", "pong.gb", "--boot-logo"], h.env)).toBe(
      EXIT.UNAVAILABLE,
    );
    expect(h.err()).toContain("rgbfix");
  });
});
