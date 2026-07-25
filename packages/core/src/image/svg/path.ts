/**
 * Shapes to polygons: the whole of the geometry story.
 *
 * Everything a sprite is drawn with — rectangles, rounded rectangles, circles,
 * ellipses, lines, polygons and paths with curves — becomes a list of closed
 * polylines in user space. One representation downstream means one filler and
 * one stroker, which is what keeps a rasteriser this small honest: there is no
 * second code path that could disagree about a corner.
 *
 * Curves are flattened at a fixed subdivision count rather than an adaptive
 * tolerance. Adaptive flattening compares a floating-point error against a
 * threshold, so a value sitting on the boundary can subdivide on one engine and
 * not on another — the one place in this file where a 1-ulp difference would
 * become a different pixel. A fixed count cannot do that, and at the sizes
 * sprites are drawn the extra segments cost nothing.
 */

import { cos, sin } from "../../math/kernels.js";

/** A point in user space. */
export interface Point {
  x: number;
  y: number;
}

/** A closed polyline. The first point is not repeated at the end. */
export type Polygon = Point[];

/** Segments a full circle or an elliptical arc sweep of 2π is cut into. */
const CIRCLE_SEGMENTS = 64;

/** Segments each cubic or quadratic curve is flattened to. */
const CURVE_SEGMENTS = 16;

/** Signed area, doubled. Positive is counter-clockwise in SVG's y-down space. */
export function signedArea(polygon: Polygon): number {
  let sum = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index] as Point;
    const b = polygon[(index + 1) % polygon.length] as Point;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

/** Return the polygon wound counter-clockwise, reversing it if it is not. */
export function orient(polygon: Polygon): Polygon {
  return signedArea(polygon) < 0 ? [...polygon].reverse() : polygon;
}

/** An axis-aligned rectangle, optionally with rounded corners. */
export function rectPolygon(
  x: number,
  y: number,
  width: number,
  height: number,
  rx: number,
  ry: number,
): Polygon {
  const cx = Math.min(rx, width / 2);
  const cy = Math.min(ry, height / 2);
  if (cx <= 0 || cy <= 0) {
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
  }
  const points: Polygon = [];
  const quadrant = (centerX: number, centerY: number, from: number) => {
    const steps = CIRCLE_SEGMENTS / 4;
    for (let step = 0; step <= steps; step += 1) {
      const angle = from + (step / steps) * (Math.PI / 2);
      points.push({ x: centerX + cos(angle) * cx, y: centerY + sin(angle) * cy });
    }
  };
  // Clockwise in a y-down space, starting at the top-left corner's arc.
  quadrant(x + cx, y + cy, Math.PI);
  quadrant(x + width - cx, y + cy, -Math.PI / 2);
  quadrant(x + width - cx, y + height - cy, 0);
  quadrant(x + cx, y + height - cy, Math.PI / 2);
  return points;
}

/** An ellipse, as a polygon. */
export function ellipsePolygon(cx: number, cy: number, rx: number, ry: number): Polygon {
  const points: Polygon = [];
  for (let step = 0; step < CIRCLE_SEGMENTS; step += 1) {
    const angle = (step / CIRCLE_SEGMENTS) * 2 * Math.PI;
    points.push({ x: cx + cos(angle) * rx, y: cy + sin(angle) * ry });
  }
  return points;
}

/** A subpath as the stroker needs it: its points and whether it closed. */
export interface Subpath {
  points: Point[];
  closed: boolean;
}

const NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/y;

/** Split path data into commands and their numeric arguments. */
function tokenize(data: string): { op: string; args: number[] }[] {
  const out: { op: string; args: number[] }[] = [];
  let at = 0;
  let current: { op: string; args: number[] } | null = null;
  while (at < data.length) {
    const char = data[at] as string;
    if (char === "," || /\s/.test(char)) {
      at += 1;
      continue;
    }
    if (/[A-Za-z]/.test(char)) {
      current = { op: char, args: [] };
      out.push(current);
      at += 1;
      continue;
    }
    NUMBER.lastIndex = at;
    const match = NUMBER.exec(data);
    if (!match || !current) {
      // An unreadable byte ends the path rather than silently skipping ahead:
      // half a shape is a bug worth seeing.
      break;
    }
    current.args.push(Number.parseFloat(match[0]));
    at = NUMBER.lastIndex;
  }
  return out;
}

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, into: Point[]): void {
  for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
    const t = step / CURVE_SEGMENTS;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    into.push({
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    });
  }
}

/**
 * Flatten path data into subpaths.
 *
 * Supports the moveto/lineto/curveto/closepath families and the horizontal and
 * vertical shorthands, absolute and relative. Elliptical arcs (`A`) are not
 * here: they need a parameter-recovery step whose square roots are a genuine
 * determinism risk at the degenerate cases, and no shape a sprite needs
 * requires one that a curve cannot draw.
 */
export function parsePath(data: string): Subpath[] {
  const subpaths: Subpath[] = [];
  let points: Point[] = [];
  let closed = false;
  let cursor: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let lastControl: Point | null = null;

  const flush = () => {
    if (points.length > 0) subpaths.push({ points, closed });
    points = [];
    closed = false;
  };

  for (const { op, args } of tokenize(data)) {
    const relative = op === op.toLowerCase();
    const command = op.toUpperCase();
    const at = (index: number): Point =>
      relative
        ? { x: cursor.x + (args[index] ?? 0), y: cursor.y + (args[index + 1] ?? 0) }
        : { x: args[index] ?? 0, y: args[index + 1] ?? 0 };

    switch (command) {
      case "M": {
        flush();
        cursor = at(0);
        start = cursor;
        points.push(cursor);
        // Extra pairs after a moveto are implicit linetos, per the grammar.
        for (let index = 2; index + 1 < args.length; index += 2) {
          cursor = at(index);
          points.push(cursor);
        }
        lastControl = null;
        break;
      }
      case "L": {
        for (let index = 0; index + 1 < args.length; index += 2) {
          cursor = at(index);
          points.push(cursor);
        }
        lastControl = null;
        break;
      }
      case "H": {
        for (const value of args) {
          cursor = { x: relative ? cursor.x + value : value, y: cursor.y };
          points.push(cursor);
        }
        lastControl = null;
        break;
      }
      case "V": {
        for (const value of args) {
          cursor = { x: cursor.x, y: relative ? cursor.y + value : value };
          points.push(cursor);
        }
        lastControl = null;
        break;
      }
      case "C": {
        for (let index = 0; index + 5 < args.length; index += 6) {
          const c1 = at(index);
          const c2 = at(index + 2);
          const end = at(index + 4);
          cubic(cursor, c1, c2, end, points);
          cursor = end;
          lastControl = c2;
        }
        break;
      }
      case "S": {
        for (let index = 0; index + 3 < args.length; index += 4) {
          const c1 = lastControl
            ? { x: 2 * cursor.x - lastControl.x, y: 2 * cursor.y - lastControl.y }
            : cursor;
          const c2 = at(index);
          const end = at(index + 2);
          cubic(cursor, c1, c2, end, points);
          cursor = end;
          lastControl = c2;
        }
        break;
      }
      case "Q": {
        for (let index = 0; index + 3 < args.length; index += 4) {
          const control = at(index);
          const end = at(index + 2);
          // A quadratic is the cubic with controls a third of the way in.
          cubic(
            cursor,
            {
              x: cursor.x + (2 / 3) * (control.x - cursor.x),
              y: cursor.y + (2 / 3) * (control.y - cursor.y),
            },
            { x: end.x + (2 / 3) * (control.x - end.x), y: end.y + (2 / 3) * (control.y - end.y) },
            end,
            points,
          );
          cursor = end;
          lastControl = control;
        }
        break;
      }
      case "T": {
        for (let index = 0; index + 1 < args.length; index += 2) {
          const control: Point = lastControl
            ? { x: 2 * cursor.x - lastControl.x, y: 2 * cursor.y - lastControl.y }
            : cursor;
          const end = at(index);
          cubic(
            cursor,
            {
              x: cursor.x + (2 / 3) * (control.x - cursor.x),
              y: cursor.y + (2 / 3) * (control.y - cursor.y),
            },
            { x: end.x + (2 / 3) * (control.x - end.x), y: end.y + (2 / 3) * (control.y - end.y) },
            end,
            points,
          );
          cursor = end;
          lastControl = control;
        }
        break;
      }
      case "Z": {
        closed = true;
        flush();
        cursor = start;
        points.push(cursor);
        lastControl = null;
        break;
      }
      default:
        // An unknown command is skipped, not guessed at.
        break;
    }
  }
  // A trailing `Z` leaves a one-point stub behind; it draws nothing.
  if (points.length > 1) flush();
  return subpaths;
}

/** Drop consecutive duplicate points, which make zero-length segments. */
export function dedupe(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    out.push(point);
  }
  return out;
}

/**
 * Outline a stroked subpath as a set of polygons whose union is the stroke.
 *
 * Each segment becomes a quad and each join a wedge, all wound the same way, so
 * a nonzero fill of the whole set is exactly their union — no polygon boolean
 * algebra, and no seams where two pieces meet. That trick is why this file has
 * one filler instead of a filler and a stroker.
 */
export function strokePolygons(
  subpath: Subpath,
  width: number,
  cap: "butt" | "round" | "square",
  join: "miter" | "round" | "bevel",
  miterLimit: number,
): Polygon[] {
  const half = width / 2;
  const points = dedupe(subpath.points);
  const polygons: Polygon[] = [];

  if (points.length < 2) {
    // A degenerate subpath draws only if its caps are round or square.
    const only = points[0];
    if (!only || cap === "butt") return polygons;
    polygons.push(
      orient(
        cap === "round"
          ? ellipsePolygon(only.x, only.y, half, half)
          : rectPolygon(only.x - half, only.y - half, width, width, 0, 0),
      ),
    );
    return polygons;
  }

  const closed = subpath.closed;
  const count = points.length;
  const segments = closed ? count : count - 1;

  for (let index = 0; index < segments; index += 1) {
    const a = points[index] as Point;
    const b = points[(index + 1) % count] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length === 0) continue;
    const nx = (-dy / length) * half;
    const ny = (dx / length) * half;
    let ax = a.x;
    let ay = a.y;
    let bx = b.x;
    let by = b.y;
    // A square cap is a butt cap on a segment extended by half a width.
    if (cap === "square" && !closed) {
      if (index === 0) {
        ax -= (dx / length) * half;
        ay -= (dy / length) * half;
      }
      if (index === segments - 1) {
        bx += (dx / length) * half;
        by += (dy / length) * half;
      }
    }
    polygons.push(
      orient([
        { x: ax + nx, y: ay + ny },
        { x: bx + nx, y: by + ny },
        { x: bx - nx, y: by - ny },
        { x: ax - nx, y: ay - ny },
      ]),
    );
  }

  const joinAt = (index: number) => {
    const previous = points[(index - 1 + count) % count] as Point;
    const vertex = points[index] as Point;
    const next = points[(index + 1) % count] as Point;
    if (join === "round") {
      polygons.push(orient(ellipsePolygon(vertex.x, vertex.y, half, half)));
      return;
    }
    const d1x = vertex.x - previous.x;
    const d1y = vertex.y - previous.y;
    const d2x = next.x - vertex.x;
    const d2y = next.y - vertex.y;
    const l1 = Math.sqrt(d1x * d1x + d1y * d1y);
    const l2 = Math.sqrt(d2x * d2x + d2y * d2y);
    if (l1 === 0 || l2 === 0) return;
    // The outer side is the one the turn bends away from.
    const cross = d1x * d2y - d1y * d2x;
    if (cross === 0) return;
    const side = cross > 0 ? -1 : 1;
    const n1x = (-d1y / l1) * half * side;
    const n1y = (d1x / l1) * half * side;
    const n2x = (-d2y / l2) * half * side;
    const n2y = (d2x / l2) * half * side;
    const p1 = { x: vertex.x + n1x, y: vertex.y + n1y };
    const p2 = { x: vertex.x + n2x, y: vertex.y + n2y };
    const bevel: Polygon = [{ x: vertex.x, y: vertex.y }, p1, p2];

    if (join === "bevel") {
      polygons.push(orient(bevel));
      return;
    }
    // Miter: extend to where the two offset edges meet, unless that spike is
    // longer than the limit allows — in which case SVG says fall back to bevel.
    const mx = n1x + n2x;
    const my = n1y + n2y;
    const mLength = Math.sqrt(mx * mx + my * my);
    if (mLength === 0) {
      polygons.push(orient(bevel));
      return;
    }
    const dot = (mx / mLength) * (n1x / half) + (my / mLength) * (n1y / half);
    if (dot <= 0 || 1 / dot > miterLimit) {
      polygons.push(orient(bevel));
      return;
    }
    const reach = half / dot;
    const tip = { x: vertex.x + (mx / mLength) * reach, y: vertex.y + (my / mLength) * reach };
    polygons.push(orient([{ x: vertex.x, y: vertex.y }, p1, tip, p2]));
  };

  const first = closed ? 0 : 1;
  const last = closed ? count - 1 : count - 2;
  for (let index = first; index <= last; index += 1) joinAt(index);

  if (!closed && cap === "round") {
    const head = points[0] as Point;
    const tail = points[count - 1] as Point;
    polygons.push(orient(ellipsePolygon(head.x, head.y, half, half)));
    polygons.push(orient(ellipsePolygon(tail.x, tail.y, half, half)));
  }
  return polygons;
}
