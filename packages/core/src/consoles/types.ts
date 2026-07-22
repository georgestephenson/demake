/**
 * The `ConsoleSpec` schema (doc 03 §The ConsoleSpec schema).
 *
 * Each console in scope is one declarative object. The *generic* pipeline
 * consumes these — consoles do not get custom quantizers unless a constraint
 * genuinely cannot be expressed as data (doc 02 §Extensibility model). This is
 * the load-bearing idea inherited from the predecessor tools: the constraint
 * model is data, the optimizer is generic.
 *
 * The schema is intentionally wider than the two Phase-1 consoles need (fixed-
 * master palettes, framebuffer/scanline layouts, selectable modes) so later
 * tiers add a file, not a schema change.
 */

import type { ChannelBits } from "../color/lattice.js";
import type { DacModel } from "../image/dac.js";

/** An 8-bit-per-channel color. */
export interface RGB8 {
  r: number;
  g: number;
  b: number;
}

/** An integer ratio, e.g. pixel aspect `[32, 35]`. */
export type Ratio = readonly [number, number];

/** A rectangle in pixels (used for overscan-safe guidance). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A named alternate display geometry (256-wide MD, dual-screen DS, …). */
export interface DisplayMode {
  name: string;
  width: number;
  height: number;
}

/** Display geometry (doc 03 schema `display`). */
export interface DisplaySpec {
  /** Canonical full-screen target. */
  width: number;
  height: number;
  altModes?: readonly DisplayMode[];
  overscanSafe?: Rect;
  /** Non-square hardware pixel aspect for correct preview/aspect-fit math. */
  pixelAspect: Ratio;
}

/** Color capability (doc 03 schema `color`). */
export interface ColorSpec {
  /**
   * - `rgb` — colors live on an RGB lattice (GBC/SNES/MD).
   * - `fixed-master` — a fixed hardware color list (NES/TMS).
   * - `mono` — a small fixed shade ramp displayed through a tint (DMG/VB/WS).
   */
  model: "rgb" | "fixed-master" | "mono";
  /** For `fixed-master`: the master color list. */
  masterPalette?: readonly RGB8[];
  /** For `rgb`: per-channel bit depths, e.g. `[5,5,5]`. */
  bitsPerChannel?: ChannelBits;
  /** For `mono`: number of shades (4 = 2bpp DMG, 2 = 1bpp). */
  shades?: number;
  /** Console→sRGB curve for preview and emulator comparison (doc 10). */
  dac: DacModel;
}

/** Sub-palette structure of a tiled layout. */
export interface SubPalettes {
  /** Number of selectable sub-palettes. */
  count: number;
  /** Colors per sub-palette. */
  size: number;
  /** Whether index 0 is a shared backdrop / transparent slot. */
  sharedIndex0?: "backdrop" | "transparent";
}

/** A tiled background layout (GBC, NES, SNES m1, MD, …). */
export interface TileLayout {
  kind: "tiles";
  tileW: 8;
  tileH: 8;
  bpp: 1 | 2 | 3 | 4 | 8;
  subPalettes: SubPalettes;
  /** Palette-choice granularity in px (NES: 16×16, i.e. cell ≠ tile). */
  attribute: { w: number; h: number };
  /** Unique tiles that fit VRAM; enforced by the tile-budget stage. */
  tileBudget?: number;
  /** Whether hardware supports H/V flip for tile dedup (MD/SNES/GBC: yes). */
  flip?: boolean;
}

/** A framebuffer layout (Lynx, GBA/DS bitmap modes). */
export interface FramebufferLayout {
  kind: "framebuffer";
  bpp: number;
  palette?: { size: number };
  perScanlinePalette?: boolean;
}

/** A racing-the-beam / display-list layout (TMS9918, 2600, 7800). */
export interface ScanlineLayout {
  kind: "scanline";
  strategy: "tms-rowpair" | "a2600-kernel" | "a7800-displaylist";
}

/** Exactly one layout kind per spec (or per selectable mode). */
export type LayoutSpec = TileLayout | FramebufferLayout | ScanlineLayout;

/** Output artifact formats a codegen family can emit (doc 06; Phase 2+). */
export type CodegenFormat = "bin" | "asm" | "c" | "rom";

/** A complete console definition. */
export interface ConsoleSpec {
  id: string;
  name: string;
  aliases: readonly string[];
  tier: 1 | 2 | 3;
  display: DisplaySpec;
  color: ColorSpec;
  layout: LayoutSpec;
  /** Selectable modes (SNES 1/3/7, GBA 0/3/4, ANTIC/GTIA). */
  modes?: readonly LayoutSpec[];
  codegen: { family: string; formats: readonly CodegenFormat[] };
  /** Primary references the numbers came from (doc 03 verification task). */
  docs: { sources: readonly string[] };
}
