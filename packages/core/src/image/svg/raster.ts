/**
 * Filling polygons, with coverage.
 *
 * Sampling is a fixed grid of sub-scanlines per pixel row and exact horizontal
 * span arithmetic within each: vertical resolution comes from the sample count,
 * horizontal resolution is analytic. That asymmetry is deliberate — a stroke's
 * long near-horizontal edges are where a sprite's shape actually lives, and
 * exact horizontal coverage costs nothing once the crossings are sorted.
 *
 * Everything is add, multiply, compare and one square root; no transcendentals,
 * no adaptive thresholds, no iteration counts that depend on a float compare.
 * The same input therefore produces the same bytes on every engine, which is
 * the whole reason this exists rather than a canvas call (doc 14 §Known gaps).
 */

import { orient, type Polygon } from "./path.js";
import { samplePaint, type Bounds, type Paint } from "./paint.js";

/** Sub-scanlines per pixel row. Sixteen coverage levels is past visible. */
const SAMPLES = 16;

/** An accumulation buffer in premultiplied sRGB, 0–1 per channel. */
export interface Canvas {
  width: number;
  height: number;
  /** Premultiplied r,g,b,a per pixel, row-major. */
  data: Float64Array;
}

/** A blank (fully transparent) canvas. */
export function makeCanvas(width: number, height: number): Canvas {
  return { width, height, data: new Float64Array(width * height * 4) };
}

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** +1 when the edge runs downwards, −1 upwards: the winding contribution. */
  winding: number;
}

function edgesOf(polygons: readonly Polygon[]): Edge[] {
  const edges: Edge[] = [];
  for (const polygon of polygons) {
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index] as { x: number; y: number };
      const b = polygon[(index + 1) % polygon.length] as { x: number; y: number };
      if (a.y === b.y) continue;
      edges.push(
        a.y < b.y
          ? { x0: a.x, y0: a.y, x1: b.x, y1: b.y, winding: 1 }
          : { x0: b.x, y0: b.y, x1: a.x, y1: a.y, winding: -1 },
      );
    }
  }
  return edges;
}

/** The bounding box of a set of polygons, in user space. */
export function boundsOf(polygons: readonly Polygon[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const point of polygon) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (minX > maxX) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** A device-space transform: uniform scale then translate (the viewBox map). */
export interface Transform {
  scale: number;
  dx: number;
  dy: number;
}

/**
 * Composite `polygons` onto the canvas with the given paint.
 *
 * `rule` is the fill rule for the shape's own outline; stroke outlines always
 * come through as `nonzero` because {@link strokePolygons} emits consistently
 * wound pieces whose union is the stroke.
 */
export function fillPolygons(
  canvas: Canvas,
  polygons: readonly Polygon[],
  paint: Paint,
  opacity: number,
  rule: "nonzero" | "evenodd",
  transform: Transform,
  gradientBounds: Bounds,
): void {
  if (paint.kind === "none" || opacity <= 0) return;
  const device = polygons.map((polygon) =>
    polygon.map((point) => ({
      x: point.x * transform.scale + transform.dx,
      y: point.y * transform.scale + transform.dy,
    })),
  );
  const edges = edgesOf(device);
  if (edges.length === 0) return;

  const box = boundsOf(device);
  const firstRow = Math.max(0, Math.floor(box.minY));
  const lastRow = Math.min(canvas.height - 1, Math.ceil(box.maxY));
  if (lastRow < firstRow) return;

  // Coverage for one row at a time, so the buffer is a scanline not a plane.
  const coverage = new Float64Array(canvas.width);
  const crossings: { x: number; winding: number }[] = [];
  const share = 1 / SAMPLES;

  for (let row = firstRow; row <= lastRow; row += 1) {
    coverage.fill(0);
    let touched = false;

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const y = row + (sample + 0.5) / SAMPLES;
      crossings.length = 0;
      for (const edge of edges) {
        if (y < edge.y0 || y >= edge.y1) continue;
        const t = (y - edge.y0) / (edge.y1 - edge.y0);
        crossings.push({ x: edge.x0 + (edge.x1 - edge.x0) * t, winding: edge.winding });
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a.x - b.x);

      let winding = 0;
      for (let index = 0; index < crossings.length - 1; index += 1) {
        winding += (crossings[index] as { winding: number }).winding;
        const inside = rule === "nonzero" ? winding !== 0 : (index & 1) === 0;
        if (!inside) continue;
        const from = (crossings[index] as { x: number }).x;
        const to = (crossings[index + 1] as { x: number }).x;
        if (to <= from) continue;
        touched = true;
        addSpan(coverage, from, to, share, canvas.width);
      }
    }
    if (!touched) continue;

    for (let column = 0; column < canvas.width; column += 1) {
      const alpha = coverage[column] as number;
      if (alpha <= 0) continue;
      const centreX = (column + 0.5 - transform.dx) / transform.scale;
      const centreY = (row + 0.5 - transform.dy) / transform.scale;
      const color = samplePaint(paint, centreX, centreY, gradientBounds);
      const a = Math.min(1, alpha) * color.a * opacity;
      if (a <= 0) continue;
      blend(canvas, column, row, color.r, color.g, color.b, a);
    }
  }
}

/** Add a horizontal span's exact coverage into a scanline accumulator. */
function addSpan(
  coverage: Float64Array,
  from: number,
  to: number,
  share: number,
  width: number,
): void {
  const start = Math.max(0, from);
  const end = Math.min(width, to);
  if (end <= start) return;
  const firstColumn = Math.floor(start);
  const lastColumn = Math.min(width - 1, Math.floor(end - 1e-12));
  if (firstColumn === lastColumn) {
    coverage[firstColumn] = (coverage[firstColumn] as number) + (end - start) * share;
    return;
  }
  coverage[firstColumn] = (coverage[firstColumn] as number) + (firstColumn + 1 - start) * share;
  for (let column = firstColumn + 1; column < lastColumn; column += 1) {
    coverage[column] = (coverage[column] as number) + share;
  }
  coverage[lastColumn] = (coverage[lastColumn] as number) + (end - lastColumn) * share;
}

/** Source-over, in premultiplied sRGB. */
function blend(
  canvas: Canvas,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const at = (y * canvas.width + x) * 4;
  const inverse = 1 - a;
  const data = canvas.data;
  data[at] = r * a + (data[at] as number) * inverse;
  data[at + 1] = g * a + (data[at + 1] as number) * inverse;
  data[at + 2] = b * a + (data[at + 2] as number) * inverse;
  data[at + 3] = a + (data[at + 3] as number) * inverse;
}

/** Un-premultiply into 8-bit non-premultiplied RGBA, the pipeline's currency. */
export function toRgbaBytes(canvas: Canvas): Uint8Array {
  const out = new Uint8Array(canvas.width * canvas.height * 4);
  for (let index = 0; index < canvas.width * canvas.height; index += 1) {
    const at = index * 4;
    const alpha = canvas.data[at + 3] as number;
    if (alpha <= 0) continue;
    const scale = 1 / alpha;
    out[at] = clamp8((canvas.data[at] as number) * scale);
    out[at + 1] = clamp8((canvas.data[at + 1] as number) * scale);
    out[at + 2] = clamp8((canvas.data[at + 2] as number) * scale);
    out[at + 3] = clamp8(alpha);
  }
  return out;
}

function clamp8(value: number): number {
  const scaled = Math.round(value * 255);
  return scaled < 0 ? 0 : scaled > 255 ? 255 : scaled;
}

export { orient };
