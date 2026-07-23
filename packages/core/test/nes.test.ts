import { describe, expect, it } from "vitest";

import { encodeRgbaPng } from "../src/image/png/encode.js";
import { decodeImage } from "../src/image/decode.js";
import { prep } from "../src/pipeline/prep.js";
import { inspect } from "../src/inspect/inspect.js";
import { consoles, getConsole } from "../src/consoles/registry.js";
import { nes } from "../src/consoles/nes.js";

function makeSource(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      rgba[o] = Math.round((x / (width - 1)) * 255);
      rgba[o + 1] = Math.round((y / (height - 1)) * 255);
      rgba[o + 2] = Math.round(((x + y) / (width + height - 2)) * 255);
      rgba[o + 3] = 255;
      if (x > width * 0.6 && x < width * 0.7 && y > height * 0.3 && y < height * 0.5) {
        rgba[o] = 240;
        rgba[o + 1] = 30;
        rgba[o + 2] = 30;
      }
    }
  }
  return encodeRgbaPng(width, height, rgba);
}

const source = makeSource(96, 96);

describe("nes registration", () => {
  it("is a registered Tier-1 console with aliases", () => {
    expect(consoles().some((c) => c.id === "nes")).toBe(true);
    expect(getConsole("famicom").id).toBe("nes");
    expect(nes.color.model).toBe("fixed-master");
    expect(nes.color.masterPalette).toHaveLength(64);
    expect(nes.layout.kind === "tiles" && nes.layout.attribute).toEqual({ w: 16, h: 16 });
  });
});

describe("prep → NES (fixed-master + 16×16 cells + shared backdrop)", () => {
  it("produces a compliant image the oracle accepts", async () => {
    const result = await prep(source, { console: "nes" });
    const report = inspect(result.png, { console: "nes" });
    expect(report.consoles[0]!.compliant).toBe(true);
    // ≤ 4 sub-palettes of ≤ 4 colors.
    expect(result.image.palettes.length).toBeLessThanOrEqual(4);
    for (const p of result.image.palettes) expect(p.colors.length).toBeLessThanOrEqual(4);
  });

  it("shares color 0 (the universal backdrop) across every sub-palette", async () => {
    const result = await prep(source, { console: "nes" });
    const zero = new Set(result.image.palettes.map((p) => p.colors[0]!.codes.join(",")));
    expect(zero.size).toBe(1);
    // Backdrop is a single master-palette index.
    expect(result.image.palettes[0]!.colors[0]!.codes).toHaveLength(1);
  });

  it("uses at most 13 background colors (backdrop + 4×3)", async () => {
    const result = await prep(source, { console: "nes" });
    expect(inspect(result.png, { console: "nes" }).colors).toBeLessThanOrEqual(13);
  });

  it("only uses colors on the NES master palette", async () => {
    const result = await prep(source, { console: "nes" });
    const master = new Set(nes.color.masterPalette!.map((c) => (c.r << 16) | (c.g << 8) | c.b));
    const img = decodeImage(result.png);
    for (let i = 0; i < img.data.length; i += 4) {
      expect(master.has((img.data[i]! << 16) | (img.data[i + 1]! << 8) | img.data[i + 2]!)).toBe(
        true,
      );
    }
  });

  it("snaps output dimensions to the 16×16 attribute grid", async () => {
    // 100×90 is a multiple of neither 16; prep must floor to multiples of 16.
    const result = await prep(makeSource(100, 90), { console: "nes" });
    const img = decodeImage(result.png);
    expect(img.width % 16).toBe(0);
    expect(img.height % 16).toBe(0);
  });

  it("is deterministic across runs", async () => {
    const a = await prep(source, { console: "nes" });
    const b = await prep(source, { console: "nes" });
    expect(Array.from(a.png)).toEqual(Array.from(b.png));
  });

  it("still passes the engine's own structural oracle for GB consoles (no regression)", async () => {
    for (const id of ["gbc", "dmg"]) {
      const r = await prep(source, { console: id, effort: "fast" });
      expect(inspect(r.png, { console: id }).consoles[0]!.compliant).toBe(true);
    }
  });
});
