/**
 * A deterministic SVG rasteriser (doc 15 §The conversion path, step 2).
 *
 * Doc 15 recorded this step as missing and gave the reason: "deterministic SVG
 * rasterisation across Node and browsers fights the byte-determinism rule". The
 * fight is with the *host's* rasteriser, not with the problem — a canvas is
 * free to antialias how it likes, and two engines will disagree in the low bits
 * of an edge pixel. Ours cannot, because it is arithmetic we wrote, in a file a
 * test can pin.
 *
 * The subset is the one vector art is actually drawn in: `rect` (rounded or
 * not), `circle`, `ellipse`, `line`, `polyline`, `polygon`, `path` with the
 * line and curve commands, `g`, `use`, `defs`, and linear and radial gradients.
 * Absent, and absent loudly rather than silently: elliptical arcs, text,
 * filters, clip paths, masks and patterns. A file that needs those gets a typed
 * error naming the element, because a sprite that quietly lost its mask is a
 * worse outcome than a build that stops.
 *
 * The output is an {@link RgbaImage} with real alpha, which is exactly what the
 * sprite path wants: transparency is a colour index on this hardware, so it has
 * to survive the raster to be quantised deliberately later.
 */

import { DemakeError } from "../../errors.js";
import { cos as rotationCos, sin as rotationSin } from "../../math/kernels.js";
import type { RgbaImage } from "../rgba.js";

import { parseXml, type XmlNode } from "./xml.js";
import {
  dedupe,
  ellipsePolygon,
  parsePath,
  rectPolygon,
  strokePolygons,
  type Point,
  type Polygon,
  type Subpath,
} from "./path.js";
import { parseColor, type Paint, type Rgba, type Stop } from "./paint.js";
import { boundsOf, fillPolygons, makeCanvas, toRgbaBytes } from "./raster.js";
import { decodeUtf8 } from "./utf8.js";

/** How big to rasterise. Defaults to the document's own size. */
export interface RasterizeOptions {
  /** Output width in pixels; the height follows the aspect ratio if omitted. */
  width?: number;
  height?: number;
}

/** Elements this rasteriser knows about; anything else is an error. */
const SHAPES = new Set(["rect", "circle", "ellipse", "line", "polyline", "polygon", "path"]);
const CONTAINERS = new Set(["svg", "g", "a", "switch"]);
const IGNORED = new Set(["title", "desc", "metadata", "style", "script"]);

/** A 2×3 affine transform, applied to user-space points. */
interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(outer: Matrix, inner: Matrix): Matrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

function apply(matrix: Matrix, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

/** The uniform scale a matrix applies, for widening a stroke by it. */
function matrixScale(matrix: Matrix): number {
  return Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
}

const TRANSFORM = /([a-zA-Z]+)\s*\(([^)]*)\)/g;

function parseTransform(text: string | undefined): Matrix {
  if (!text) return IDENTITY;
  let result = IDENTITY;
  TRANSFORM.lastIndex = 0;
  for (let match = TRANSFORM.exec(text); match; match = TRANSFORM.exec(text)) {
    const name = (match[1] as string).toLowerCase();
    const args = (match[2] as string)
      .split(/[\s,]+/)
      .filter((part) => part.length > 0)
      .map((part) => Number.parseFloat(part))
      .map((value) => (Number.isFinite(value) ? value : 0));
    const number = (index: number, fallback = 0) => args[index] ?? fallback;
    let step: Matrix = IDENTITY;
    if (name === "translate") step = { ...IDENTITY, e: number(0), f: number(1) };
    else if (name === "scale") step = { ...IDENTITY, a: number(0, 1), d: number(1, number(0, 1)) };
    else if (name === "matrix") {
      step = {
        a: number(0, 1),
        b: number(1),
        c: number(2),
        d: number(3, 1),
        e: number(4),
        f: number(5),
      };
    } else if (name === "rotate") {
      // Trigonometry goes through the kernels, never `Math`, so a rotated
      // asset produces the same pixels on every engine (doc 02 §Determinism).
      const radians = (number(0) * Math.PI) / 180;
      const cosine = rotationCos(radians);
      const sine = rotationSin(radians);
      const spin: Matrix = { a: cosine, b: sine, c: -sine, d: cosine, e: 0, f: 0 };
      const cx = number(1);
      const cy = number(2);
      step =
        cx === 0 && cy === 0
          ? spin
          : multiply(multiply({ ...IDENTITY, e: cx, f: cy }, spin), {
              ...IDENTITY,
              e: -cx,
              f: -cy,
            });
    } else if (name === "skewx" || name === "skewy") {
      const radians = (number(0) * Math.PI) / 180;
      const tangent = rotationSin(radians) / (rotationCos(radians) || 1);
      step = name === "skewx" ? { ...IDENTITY, c: tangent } : { ...IDENTITY, b: tangent };
    }
    result = multiply(result, step);
  }
  return result;
}

/** Attributes that inherit down the tree, in the SVG presentation-attribute way. */
interface Style {
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: "butt" | "round" | "square";
  strokeLinejoin: "miter" | "round" | "bevel";
  miterLimit: number;
  fillRule: "nonzero" | "evenodd";
  opacity: number;
  fillOpacity: number;
  strokeOpacity: number;
}

const ROOT_STYLE: Style = {
  fill: "black",
  stroke: "none",
  strokeWidth: 1,
  strokeLinecap: "butt",
  strokeLinejoin: "miter",
  miterLimit: 4,
  fillRule: "nonzero",
  opacity: 1,
  fillOpacity: 1,
  strokeOpacity: 1,
};

function number(attrs: Readonly<Record<string, string>>, name: string, fallback: number): number {
  const raw = attrs[name];
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Read one declaration out of a `style="…"` attribute, if present. */
function styleProperty(attrs: Readonly<Record<string, string>>, name: string): string | undefined {
  const inline = attrs["style"];
  if (inline === undefined) return undefined;
  for (const declaration of inline.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    if (declaration.slice(0, colon).trim() !== name) continue;
    return declaration.slice(colon + 1).trim();
  }
  return undefined;
}

function property(attrs: Readonly<Record<string, string>>, name: string): string | undefined {
  return styleProperty(attrs, name) ?? attrs[name];
}

function inherit(parent: Style, attrs: Readonly<Record<string, string>>): Style {
  const text = (name: string, fallback: string) => property(attrs, name) ?? fallback;
  const size = (name: string, fallback: number) => {
    const raw = property(attrs, name);
    if (raw === undefined) return fallback;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const cap = text("stroke-linecap", parent.strokeLinecap);
  const join = text("stroke-linejoin", parent.strokeLinejoin);
  const rule = text("fill-rule", parent.fillRule);
  return {
    fill: text("fill", parent.fill),
    stroke: text("stroke", parent.stroke),
    strokeWidth: size("stroke-width", parent.strokeWidth),
    strokeLinecap: cap === "round" || cap === "square" ? cap : "butt",
    strokeLinejoin: join === "round" || join === "bevel" ? join : "miter",
    miterLimit: size("stroke-miterlimit", parent.miterLimit),
    fillRule: rule === "evenodd" ? "evenodd" : "nonzero",
    // `opacity` is a group property: it multiplies, it does not inherit as-is.
    opacity: parent.opacity * size("opacity", 1),
    fillOpacity: size("fill-opacity", parent.fillOpacity),
    strokeOpacity: size("stroke-opacity", parent.strokeOpacity),
  };
}

/** Gradients and shapes, collected by id so `url(#…)` and `use` can find them. */
interface Defs {
  gradients: Map<string, XmlNode>;
  elements: Map<string, XmlNode>;
}

function collectDefs(node: XmlNode, into: Defs): void {
  const id = node.attrs["id"];
  if (id !== undefined) {
    into.elements.set(id, node);
    if (node.tag === "linearGradient" || node.tag === "radialGradient") {
      into.gradients.set(id, node);
    }
  }
  for (const child of node.children) collectDefs(child, into);
}

/** Resolve a gradient's stops, following one level of `href` inheritance. */
function stopsOf(node: XmlNode, defs: Defs): Stop[] {
  const href = node.attrs["href"] ?? node.attrs["xlink:href"];
  const inherited = href && href.startsWith("#") ? defs.gradients.get(href.slice(1)) : undefined;
  const source = node.children.some((child) => child.tag === "stop") ? node : (inherited ?? node);

  const stops: Stop[] = [];
  for (const child of source.children) {
    if (child.tag !== "stop") continue;
    const raw = property(child.attrs, "offset") ?? "0";
    const offset = raw.trim().endsWith("%") ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
    const color =
      parseColor(property(child.attrs, "stop-color")) ?? ({ r: 0, g: 0, b: 0, a: 1 } as Rgba);
    const alpha = property(child.attrs, "stop-opacity");
    const scale = alpha === undefined ? 1 : Number.parseFloat(alpha);
    stops.push({
      offset: Number.isFinite(offset) ? offset : 0,
      color: { ...color, a: color.a * (Number.isFinite(scale) ? scale : 1) },
    });
  }
  // Stable by offset: two stops at the same place keep their document order,
  // which is what makes a hard colour boundary work.
  return stops
    .map((stop, index) => ({ stop, index }))
    .sort((a, b) => a.stop.offset - b.stop.offset || a.index - b.index)
    .map((entry) => entry.stop);
}

/** Turn a paint attribute into a {@link Paint}. */
function resolvePaint(value: string, opacity: number, defs: Defs): Paint {
  const trimmed = value.trim();
  const reference = /^url\(\s*#([^)\s]+)\s*\)/.exec(trimmed);
  if (reference) {
    const node = defs.gradients.get(reference[1] as string);
    if (!node) return { kind: "none" };
    const stops = stopsOf(node, defs).map((stop) => ({
      ...stop,
      color: { ...stop.color, a: stop.color.a * opacity },
    }));
    if (stops.length === 0) return { kind: "none" };
    const fraction = (name: string, fallback: number): number => {
      const raw = node.attrs[name];
      if (raw === undefined) return fallback;
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed)) return fallback;
      return raw.trim().endsWith("%") ? parsed / 100 : parsed;
    };
    if (node.tag === "linearGradient") {
      return {
        kind: "linear",
        stops,
        x1: fraction("x1", 0),
        y1: fraction("y1", 0),
        x2: fraction("x2", 1),
        y2: fraction("y2", 0),
      };
    }
    return {
      kind: "radial",
      stops,
      cx: fraction("cx", 0.5),
      cy: fraction("cy", 0.5),
      r: fraction("r", 0.5),
    };
  }
  const color = parseColor(trimmed);
  if (!color) return { kind: "none" };
  return { kind: "flat", color: { ...color, a: color.a * opacity } };
}

/** A shape's geometry: what to fill, and what to stroke. */
interface Geometry {
  fill: Polygon[];
  outline: Subpath[];
}

function points(attrs: Readonly<Record<string, string>>): Point[] {
  const numbers = (attrs["points"] ?? "")
    .split(/[\s,]+/)
    .filter((part) => part.length > 0)
    .map((part) => Number.parseFloat(part));
  const out: Point[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    out.push({ x: numbers[index] as number, y: numbers[index + 1] as number });
  }
  return out;
}

function geometryOf(node: XmlNode): Geometry {
  const attrs = node.attrs;
  switch (node.tag) {
    case "rect": {
      const rx = number(attrs, "rx", number(attrs, "ry", 0));
      const ry = number(attrs, "ry", rx);
      const polygon = rectPolygon(
        number(attrs, "x", 0),
        number(attrs, "y", 0),
        number(attrs, "width", 0),
        number(attrs, "height", 0),
        rx,
        ry,
      );
      return { fill: [polygon], outline: [{ points: polygon, closed: true }] };
    }
    case "circle": {
      const r = number(attrs, "r", 0);
      const polygon = ellipsePolygon(number(attrs, "cx", 0), number(attrs, "cy", 0), r, r);
      return { fill: [polygon], outline: [{ points: polygon, closed: true }] };
    }
    case "ellipse": {
      const polygon = ellipsePolygon(
        number(attrs, "cx", 0),
        number(attrs, "cy", 0),
        number(attrs, "rx", 0),
        number(attrs, "ry", 0),
      );
      return { fill: [polygon], outline: [{ points: polygon, closed: true }] };
    }
    case "line": {
      const segment = [
        { x: number(attrs, "x1", 0), y: number(attrs, "y1", 0) },
        { x: number(attrs, "x2", 0), y: number(attrs, "y2", 0) },
      ];
      return { fill: [], outline: [{ points: segment, closed: false }] };
    }
    case "polyline": {
      const list = points(attrs);
      return { fill: [list], outline: [{ points: list, closed: false }] };
    }
    case "polygon": {
      const list = points(attrs);
      return { fill: [list], outline: [{ points: list, closed: true }] };
    }
    default: {
      const subpaths = parsePath(attrs["d"] ?? "");
      return { fill: subpaths.map((sub) => sub.points), outline: subpaths };
    }
  }
}

/** One thing to draw, with its geometry already in root user space. */
interface Draw {
  fill: Polygon[];
  outline: Subpath[];
  style: Style;
  strokeScale: number;
}

function walk(node: XmlNode, style: Style, matrix: Matrix, defs: Defs, into: Draw[]): void {
  if (IGNORED.has(node.tag)) return;
  const own = inherit(style, node.attrs);
  const here = multiply(matrix, parseTransform(node.attrs["transform"]));

  if (node.tag === "defs") return;
  if (node.tag === "use") {
    const href = node.attrs["href"] ?? node.attrs["xlink:href"] ?? "";
    const target = href.startsWith("#") ? defs.elements.get(href.slice(1)) : undefined;
    if (!target) return;
    const shifted = multiply(here, {
      ...IDENTITY,
      e: number(node.attrs, "x", 0),
      f: number(node.attrs, "y", 0),
    });
    walk(target, own, shifted, defs, into);
    return;
  }
  if (CONTAINERS.has(node.tag)) {
    for (const child of node.children) walk(child, own, here, defs, into);
    return;
  }
  if (node.tag === "linearGradient" || node.tag === "radialGradient" || node.tag === "stop") return;
  if (!SHAPES.has(node.tag)) {
    throw new DemakeError(
      "E_UNSUPPORTED_FORMAT",
      `<${node.tag}> is not supported by the SVG reader`,
      {
        hint: "draw the shape with rect, circle, ellipse, line, polygon or path; text, filters, clip paths and masks are not rasterised",
      },
    );
  }

  const geometry = geometryOf(node);
  into.push({
    fill: geometry.fill.map((polygon) => polygon.map((point) => apply(here, point))),
    outline: geometry.outline.map((sub) => ({
      points: dedupe(sub.points.map((point) => apply(here, point))),
      closed: sub.closed,
    })),
    style: own,
    strokeScale: matrixScale(here),
  });
}

/** Parse the `viewBox`, falling back to the document's declared size. */
function viewBoxOf(root: XmlNode): { x: number; y: number; w: number; h: number } {
  const raw = root.attrs["viewBox"];
  if (raw) {
    const parts = raw
      .split(/[\s,]+/)
      .filter((part) => part.length > 0)
      .map((part) => Number.parseFloat(part));
    if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
      const [x, y, w, h] = parts as [number, number, number, number];
      if (w > 0 && h > 0) return { x, y, w, h };
    }
  }
  const w = number(root.attrs, "width", 0);
  const h = number(root.attrs, "height", 0);
  if (w > 0 && h > 0) return { x: 0, y: 0, w, h };
  throw new DemakeError("E_BAD_INPUT", "the <svg> has neither a viewBox nor a width and height", {
    hint: 'add viewBox="0 0 W H" so the drawing has a coordinate system',
  });
}

/** Rasterise an SVG document into an 8-bit RGBA raster with real alpha. */
export function rasterizeSvg(text: string, options: RasterizeOptions = {}): RgbaImage {
  const root = parseXml(text);
  if (root.tag !== "svg") {
    throw new DemakeError("E_BAD_INPUT", `the root element is <${root.tag}>, not <svg>`);
  }

  const view = viewBoxOf(root);
  const declaredW = number(root.attrs, "width", view.w);
  const declaredH = number(root.attrs, "height", view.h);
  let width = options.width ?? Math.round(declaredW > 0 ? declaredW : view.w);
  let height = options.height ?? Math.round(declaredH > 0 ? declaredH : view.h);
  if (options.width !== undefined && options.height === undefined) {
    height = Math.max(1, Math.round((options.width * view.h) / view.w));
  }
  if (options.height !== undefined && options.width === undefined) {
    width = Math.max(1, Math.round((options.height * view.w) / view.h));
  }
  width = Math.max(1, width);
  height = Math.max(1, height);

  const defs: Defs = { gradients: new Map(), elements: new Map() };
  collectDefs(root, defs);

  const draws: Draw[] = [];
  walk(root, ROOT_STYLE, IDENTITY, defs, draws);

  // `meet`: the whole viewBox is visible, centred, aspect preserved — the
  // default `preserveAspectRatio`, and the only one a sprite wants.
  const scale = Math.min(width / view.w, height / view.h);
  const transform = {
    scale,
    dx: (width - view.w * scale) / 2 - view.x * scale,
    dy: (height - view.h * scale) / 2 - view.y * scale,
  };

  const canvas = makeCanvas(width, height);
  for (const draw of draws) {
    const bounds = boundsOf(draw.fill.length > 0 ? draw.fill : draw.outline.map((s) => s.points));
    if (draw.fill.length > 0) {
      const paint = resolvePaint(draw.style.fill, draw.style.fillOpacity, defs);
      fillPolygons(
        canvas,
        draw.fill,
        paint,
        draw.style.opacity,
        draw.style.fillRule,
        transform,
        bounds,
      );
    }
    const strokeWidth = draw.style.strokeWidth * draw.strokeScale;
    if (draw.style.stroke.trim() !== "none" && strokeWidth > 0) {
      const paint = resolvePaint(draw.style.stroke, draw.style.strokeOpacity, defs);
      const outline: Polygon[] = [];
      for (const sub of draw.outline) {
        outline.push(
          ...strokePolygons(
            sub,
            strokeWidth,
            draw.style.strokeLinecap,
            draw.style.strokeLinejoin,
            draw.style.miterLimit,
          ),
        );
      }
      fillPolygons(canvas, outline, paint, draw.style.opacity, "nonzero", transform, bounds);
    }
  }

  return { width, height, data: toRgbaBytes(canvas) };
}

/** Whether a byte string looks like an SVG document. */
export function isSvg(bytes: Uint8Array): boolean {
  // Look only at the head: an SVG's root tag is always in the first few hundred
  // bytes, and decoding a megabyte to answer a yes/no question is wasteful.
  const head = decodeUtf8(bytes.subarray(0, 512)).trimStart();
  if (head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!DOCTYPE svg")) {
    return /<svg[\s>]/.test(head);
  }
  return false;
}
