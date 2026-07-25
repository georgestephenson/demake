/**
 * The SVG rasteriser: geometry, paint, and the promise that makes it usable.
 *
 * The promise is determinism (doc 02 §Determinism, doc 15 §The conversion
 * path). A host rasteriser would be faster and would also make the browser and
 * the CLI disagree about a ROM's bytes, which is the one thing the whole game
 * pipeline is built not to do. So the tests here check the arithmetic, not the
 * appearance: coverage where an edge cuts a pixel, alpha where nothing is
 * drawn, and identical output twice from the same source.
 */

import { describe, expect, it } from "vitest";

import { DemakeError } from "../src/errors.js";
import { detectFormat, decodeImage } from "../src/image/decode.js";
import { rasterizeSvg } from "../src/image/svg/index.js";
import { parsePath } from "../src/image/svg/path.js";
import { parseColor } from "../src/image/svg/paint.js";
import { parseXml } from "../src/image/svg/xml.js";
import { decodeUtf8 } from "../src/image/svg/utf8.js";

const doc = (body: string, size = 8) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${body}</svg>`;

const at = (image: { width: number; data: Uint8Array }, x: number, y: number) => {
  const offset = (y * image.width + x) * 4;
  return [...image.data.subarray(offset, offset + 4)];
};

describe("the XML reader", () => {
  it("reads nesting, attributes, comments and self-closing tags", () => {
    const root = parseXml(`<a x="1"><!-- skip --><b y='2'/><c>text</c></a>`);
    expect(root.tag).toBe("a");
    expect(root.attrs["x"]).toBe("1");
    expect(root.children.map((child) => child.tag)).toEqual(["b", "c"]);
    expect(root.children[0]?.attrs["y"]).toBe("2");
  });

  it("expands the predefined entities and numeric references", () => {
    const root = parseXml(`<a t="&lt;&amp;&gt;&#65;&#x42;"/>`);
    expect(root.attrs["t"]).toBe("<&>AB");
  });

  it("refuses a mismatched closing tag rather than guessing", () => {
    expect(() => parseXml("<a><b></a></b>")).toThrow(DemakeError);
    expect(() => parseXml("<a><b></b>")).toThrow(/never closed/);
  });
});

describe("colour parsing", () => {
  it("reads every form an asset is authored in", () => {
    expect(parseColor("#fff")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseColor("#000000")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor("#ff000080")?.a).toBeCloseTo(128 / 255, 6);
    expect(parseColor("rgb(255, 0, 0)")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor("red")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor("none")).toBeNull();
  });
});

describe("path data", () => {
  it("flattens the line commands, absolute and relative", () => {
    const [subpath] = parsePath("M1 1 L3 1 l0 2 H1 V1 Z");
    expect(subpath?.closed).toBe(true);
    expect(subpath?.points.slice(0, 5)).toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 1, y: 3 },
      { x: 1, y: 1 },
    ]);
  });

  it("flattens curves into segments, ending exactly on the endpoint", () => {
    const [subpath] = parsePath("M0 0 C0 4 8 4 8 0");
    const last = subpath?.points[(subpath?.points.length ?? 1) - 1];
    expect(last).toEqual({ x: 8, y: 0 });
  });
});

describe("rasterising", () => {
  it("fills a pixel-aligned rectangle exactly, with nothing outside it", () => {
    const image = rasterizeSvg(doc(`<rect x="2" y="2" width="4" height="4" fill="#ff0000"/>`));
    expect(at(image, 3, 3)).toEqual([255, 0, 0, 255]);
    expect(at(image, 1, 3)).toEqual([0, 0, 0, 0]);
    expect(at(image, 6, 3)).toEqual([0, 0, 0, 0]);
  });

  it("gives a half-covered pixel half the alpha", () => {
    const image = rasterizeSvg(doc(`<rect x="0" y="0" width="4.5" height="8" fill="#000000"/>`));
    // Column 4 is covered from its left edge to its middle.
    expect(at(image, 4, 4)[3]).toBe(128);
    expect(at(image, 3, 4)[3]).toBe(255);
    expect(at(image, 5, 4)[3]).toBe(0);
  });

  it("composites source-over, so a later shape wins", () => {
    const image = rasterizeSvg(
      doc(
        `<rect x="0" y="0" width="8" height="8" fill="#ff0000"/>` +
          `<rect x="0" y="0" width="8" height="8" fill="#0000ff" opacity="0.5"/>`,
      ),
    );
    const [r, g, b, a] = at(image, 4, 4) as [number, number, number, number];
    expect(a).toBe(255);
    expect(g).toBe(0);
    expect(r).toBeGreaterThan(100);
    expect(b).toBeGreaterThan(100);
  });

  it("interpolates a linear gradient across the shape's own box", () => {
    const image = rasterizeSvg(
      doc(
        `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">` +
          `<stop offset="0%" stop-color="#000000"/><stop offset="100%" stop-color="#ffffff"/>` +
          `</linearGradient></defs>` +
          `<rect x="0" y="0" width="8" height="8" fill="url(#g)"/>`,
      ),
    );
    const left = at(image, 0, 4)[0] as number;
    const middle = at(image, 4, 4)[0] as number;
    const right = at(image, 7, 4)[0] as number;
    expect(left).toBeLessThan(middle);
    expect(middle).toBeLessThan(right);
    expect(middle).toBeGreaterThan(100);
    expect(middle).toBeLessThan(160);
  });

  it("strokes a line with its width centred on the path", () => {
    const image = rasterizeSvg(
      doc(`<path d="M0 4 L8 4" fill="none" stroke="#000000" stroke-width="2"/>`),
    );
    expect(at(image, 4, 3)[3]).toBe(255);
    expect(at(image, 4, 4)[3]).toBe(255);
    expect(at(image, 4, 2)[3]).toBe(0);
    expect(at(image, 4, 5)[3]).toBe(0);
  });

  it("honours the viewBox rather than the pixel size", () => {
    const svg = `<svg viewBox="0 0 4 4" width="16" height="16"><rect x="0" y="0" width="2" height="4" fill="#000"/></svg>`;
    const image = rasterizeSvg(svg);
    expect(image.width).toBe(16);
    expect(at(image, 7, 8)[3]).toBe(255);
    expect(at(image, 8, 8)[3]).toBe(0);
  });

  it("resizes to a requested width, keeping the aspect ratio", () => {
    const image = rasterizeSvg(doc(`<rect x="0" y="0" width="8" height="8" fill="#000"/>`, 8), {
      width: 24,
    });
    expect([image.width, image.height]).toEqual([24, 24]);
  });

  it("names an element it cannot draw instead of dropping it", () => {
    expect(() => rasterizeSvg(doc(`<text x="0" y="0">hi</text>`))).toThrow(
      /<text> is not supported/,
    );
  });

  it("produces the same bytes every time", () => {
    const source = doc(
      `<defs><radialGradient id="r" cx="35%" cy="30%" r="75%">` +
        `<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#036"/>` +
        `</radialGradient></defs>` +
        `<circle cx="4" cy="4" r="3.5" fill="url(#r)" stroke="#000" stroke-width="0.7"/>`,
      8,
    );
    expect([...rasterizeSvg(source).data]).toEqual([...rasterizeSvg(source).data]);
  });
});

describe("the decoder's SVG path", () => {
  it("sniffs SVG and rasterises it through the ordinary entry point", () => {
    const bytes = new TextEncoder().encode(
      doc(`<rect x="0" y="0" width="8" height="8" fill="#00ff00"/>`),
    );
    expect(detectFormat(bytes)).toBe("svg");
    expect(at(decodeImage(bytes), 4, 4)).toEqual([0, 255, 0, 255]);
  });

  it("decodes UTF-8 without a platform API, byte-order mark and all", () => {
    const bytes = new TextEncoder().encode("héllo — 😀");
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]);
    expect(decodeUtf8(withBom)).toBe("héllo — 😀");
  });
});
