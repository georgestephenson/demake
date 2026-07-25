/**
 * Paint: flat colours and the two gradient kinds, evaluated per pixel.
 *
 * Interpolation is in non-linear sRGB, which is what browsers do for a
 * gradient with no `color-interpolation` override. That matters here because
 * the point of this rasteriser is to reproduce what the artist saw when they
 * drew the asset — not to be more correct than the thing they were looking at.
 */

/** Straight (non-premultiplied) linear-free sRGB with alpha, 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A gradient stop, at a position along the gradient's parameter. */
export interface Stop {
  offset: number;
  color: Rgba;
}

/** How a shape is filled: nothing, one colour, or a gradient. */
export type Paint =
  | { kind: "none" }
  | { kind: "flat"; color: Rgba }
  | {
      kind: "linear";
      stops: Stop[];
      /** Endpoints, in the unit square of the shape's bounding box. */
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | {
      kind: "radial";
      stops: Stop[];
      /** Centre and radius, in the unit square of the shape's bounding box. */
      cx: number;
      cy: number;
      r: number;
    };

/** The named colours SVG defines that a hand-drawn asset actually reaches for. */
const NAMED: Readonly<Record<string, string>> = {
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  white: "#ffffff",
  maroon: "#800000",
  red: "#ff0000",
  purple: "#800080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  green: "#008000",
  lime: "#00ff00",
  olive: "#808000",
  yellow: "#ffff00",
  navy: "#000080",
  blue: "#0000ff",
  teal: "#008080",
  aqua: "#00ffff",
  cyan: "#00ffff",
  orange: "#ffa500",
  transparent: "#00000000",
};

function hexDigit(text: string): number {
  const code = text.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

/** Parse a colour: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(…)` or a named colour. */
export function parseColor(text: string | undefined): Rgba | null {
  if (text === undefined) return null;
  const value = text.trim().toLowerCase();
  if (value === "" || value === "none") return null;
  const named = NAMED[value];
  const source = named ?? value;

  if (source.startsWith("#")) {
    const digits = source.slice(1);
    if (![3, 4, 6, 8].includes(digits.length)) return null;
    const nibbles = [...digits].map(hexDigit);
    if (nibbles.some((digit) => digit < 0)) return null;
    const short = digits.length <= 4;
    const channel = (index: number): number =>
      short
        ? ((nibbles[index] as number) * 17) / 255
        : (((nibbles[index * 2] as number) * 16 + (nibbles[index * 2 + 1] as number)) as number) /
          255;
    const hasAlpha = digits.length === 4 || digits.length === 8;
    return {
      r: channel(0),
      g: channel(1),
      b: channel(2),
      a: hasAlpha ? channel(3) : 1,
    };
  }

  const call = /^rgba?\(([^)]*)\)$/.exec(source);
  if (call) {
    const parts = (call[1] as string).split(/[\s,/]+/).filter((part) => part.length > 0);
    const component = (part: string | undefined, scale: number): number => {
      if (part === undefined) return 0;
      const number = Number.parseFloat(part);
      if (!Number.isFinite(number)) return 0;
      return part.endsWith("%") ? number / 100 : number / scale;
    };
    return {
      r: component(parts[0], 255),
      g: component(parts[1], 255),
      b: component(parts[2], 255),
      a: parts.length > 3 ? component(parts[3], 1) : 1,
    };
  }
  return null;
}

/** Colour at a position along a stop list, clamping past either end. */
function sampleStops(stops: readonly Stop[], t: number): Rgba {
  if (stops.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const first = stops[0] as Stop;
  const last = stops[stops.length - 1] as Stop;
  if (t <= first.offset) return first.color;
  if (t >= last.offset) return last.color;
  for (let index = 1; index < stops.length; index += 1) {
    const before = stops[index - 1] as Stop;
    const after = stops[index] as Stop;
    if (t > after.offset) continue;
    const span = after.offset - before.offset;
    const mix = span <= 0 ? 0 : (t - before.offset) / span;
    return {
      r: before.color.r + (after.color.r - before.color.r) * mix,
      g: before.color.g + (after.color.g - before.color.g) * mix,
      b: before.color.b + (after.color.b - before.color.b) * mix,
      a: before.color.a + (after.color.a - before.color.a) * mix,
    };
  }
  return last.color;
}

/** A shape's bounding box, which is the space gradients are defined in. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Evaluate a paint at a user-space point.
 *
 * Gradient coordinates are `objectBoundingBox` units, SVG's default: the
 * shape's own box is the unit square, so the same gradient definition works on
 * a ball and on a paddle without being restated.
 */
export function samplePaint(paint: Paint, x: number, y: number, bounds: Bounds): Rgba {
  if (paint.kind === "none") return { r: 0, g: 0, b: 0, a: 0 };
  if (paint.kind === "flat") return paint.color;

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const u = width === 0 ? 0 : (x - bounds.minX) / width;
  const v = height === 0 ? 0 : (y - bounds.minY) / height;

  if (paint.kind === "linear") {
    const dx = paint.x2 - paint.x1;
    const dy = paint.y2 - paint.y1;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : ((u - paint.x1) * dx + (v - paint.y1) * dy) / lengthSquared;
    return sampleStops(paint.stops, t);
  }

  const dx = u - paint.cx;
  const dy = v - paint.cy;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return sampleStops(paint.stops, paint.r === 0 ? 1 : distance / paint.r);
}
