import { describe, expect, it } from "vitest";

import { encodeRgbaPng } from "../src/image/png/encode.js";
import { decodePng } from "../src/image/png/decode.js";
import { prep } from "../src/pipeline/prep.js";
import { inspect } from "../src/inspect/inspect.js";
import { judge } from "../src/inspect/judge.js";
import { getConsole } from "../src/consoles/registry.js";

/** A colorful synthetic source: smooth gradients plus a few flat blocks. */
function makeSource(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      rgba[o] = Math.round((x / (width - 1)) * 255);
      rgba[o + 1] = Math.round((y / (height - 1)) * 255);
      rgba[o + 2] = Math.round(((x + y) / (width + height - 2)) * 255);
      rgba[o + 3] = 255;
      // A bright red accent block and a dark outline block.
      if (x > width * 0.6 && x < width * 0.7 && y > height * 0.3 && y < height * 0.5) {
        rgba[o] = 240;
        rgba[o + 1] = 30;
        rgba[o + 2] = 30;
      }
    }
  }
  return rgba;
}

const source = encodeRgbaPng(64, 64, makeSource(64, 64));

describe("prep → GBC", () => {
  it("produces a compliant, correctly sized indexed PNG", async () => {
    const result = await prep(source, { console: "gbc" });
    const decoded = decodePng(result.png);
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(64);

    // The engine's own structural oracle must accept it.
    const spec = getConsole("gbc");
    expect(result.image.palettes.length).toBeLessThanOrEqual(8);
    for (const pal of result.image.palettes) {
      expect(pal.colors.length).toBeLessThanOrEqual(4);
    }
    expect(spec.layout.kind).toBe("tiles");

    // The public oracle should also be able to prove compliance.
    const report = inspect(result.png, { console: "gbc" });
    expect(report.consoles[0]!.compliant).toBe(true);
    expect(report.colors).toBeLessThanOrEqual(32);
  });

  it("is deterministic: identical bytes across runs", async () => {
    const a = await prep(source, { console: "gbc" });
    const b = await prep(source, { console: "gbc" });
    expect(Array.from(a.png)).toEqual(Array.from(b.png));
    expect(a.tournament.winner).toBe(b.tournament.winner);
  });

  it("runs a tournament and reports a scoreboard", async () => {
    const result = await prep(source, { console: "gbc", effort: "default" });
    expect(result.tournament.candidates.length).toBeGreaterThan(1);
    const winner = result.tournament.candidates.find(
      (c) => c.strategy === result.tournament.winner,
    );
    expect(winner).toBeDefined();
    expect(winner!.aggregate).toBeGreaterThan(0);
  });

  it("honors a pinned strategy (single candidate, still compliant)", async () => {
    const result = await prep(source, { console: "gbc", strategy: "art-majority-flat" });
    expect(result.tournament.winner).toBe("art-majority-flat");
    expect(inspect(result.png, { console: "gbc" }).consoles[0]!.compliant).toBe(true);
  });

  it("respects an explicit size on the tile grid", async () => {
    const result = await prep(source, { console: "gbc", size: { w: 32, h: 32 }, effort: "fast" });
    const decoded = decodePng(result.png);
    expect(decoded.width).toBe(32);
    expect(decoded.height).toBe(32);
  });
});

describe("prep → DMG (mono path)", () => {
  it("produces a compliant 4-shade image", async () => {
    const result = await prep(source, { console: "dmg" });
    const decoded = decodePng(result.png);
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(64);
    const report = inspect(result.png, { console: "dmg" });
    expect(report.colors).toBeLessThanOrEqual(4);
    expect(report.consoles[0]!.compliant).toBe(true);
  });

  it("is deterministic", async () => {
    const a = await prep(source, { console: "dmg" });
    const b = await prep(source, { console: "dmg" });
    expect(Array.from(a.png)).toEqual(Array.from(b.png));
  });
});

describe("judge()", () => {
  it("scores prep output above a degenerate all-black image", async () => {
    const result = await prep(source, { console: "gbc", effort: "fast" });
    const black = encodeRgbaPng(64, 64, new Uint8Array(64 * 64 * 4).fill(0));
    const good = judge(source, result.png);
    const bad = judge(source, black);
    expect(good.aggregate).toBeGreaterThan(bad.aggregate);
    expect(good.rawMeanDeltaE).toBeLessThan(bad.rawMeanDeltaE);
  });
});
