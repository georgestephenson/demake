/**
 * The option model (doc 07 §UX: "the UI mirrors the CLI's mental model").
 *
 * One record with a field per `demake prep` flag, plus the two translations that
 * keep the app honest: into `PrepOptions` for the engine, and into the
 * *equivalent command line* the UI displays. Both derive from the same defaults,
 * so the shown command is always exactly what the app just ran — including the
 * omissions (a flag at its default is not printed, as a person would type it).
 */

import type { DitherAlg, PrepOptions, ScaleKernel } from "@demake/core";

import type { PrepOptionsUi } from "../worker/protocol.js";

/** The defaults `demake prep` itself applies (doc 05 §prep). */
export const DEFAULT_OPTIONS: PrepOptionsUi = {
  console: "gbc",
  strategy: "auto",
  size: "",
  fit: "contain",
  scale: "auto",
  dither: "",
  profile: "auto",
  effort: "default",
  metric: "oklab",
  seed: "",
  background: "#000000",
  protect: "",
  noProtect: false,
  rawColors: false,
  dacColors: false,
  strict: false,
};

function parseSize(text: string): { w: number; h: number } | null {
  const m = /^(\d+)x(\d+)$/i.exec(text.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

function parseDither(text: string): { alg: DitherAlg; strength?: number } | null {
  const raw = text.trim();
  if (raw === "") return null;
  const [alg, strength] = raw.split(":");
  if (!alg) return null;
  const value: { alg: DitherAlg; strength?: number } = { alg: alg as DitherAlg };
  if (strength !== undefined && strength !== "") {
    const n = Number(strength);
    if (Number.isFinite(n)) value.strength = n;
  }
  return value;
}

/** Translate the UI record into the engine's `PrepOptions`. */
export function toPrepOptions(ui: PrepOptionsUi): PrepOptions {
  const size = parseSize(ui.size);
  const dither = parseDither(ui.dither);
  const seed = ui.seed.trim() === "" ? null : Number(ui.seed);
  const protect = ui.protect
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return {
    console: ui.console,
    ...(ui.strategy !== "auto" ? { strategy: ui.strategy } : {}),
    ...(size ? { size, fit: ui.fit } : {}),
    ...(ui.scale !== "auto" ? { scale: ui.scale as ScaleKernel } : {}),
    ...(dither ? { dither } : {}),
    ...(ui.profile !== "auto" ? { profile: ui.profile } : {}),
    ...(ui.effort !== "default" ? { effort: ui.effort } : {}),
    ...(ui.metric !== "oklab" ? { metric: ui.metric } : {}),
    ...(seed !== null && Number.isFinite(seed) ? { seed } : {}),
    ...(ui.background !== DEFAULT_OPTIONS.background ? { background: ui.background } : {}),
    ...(ui.noProtect ? { protect: false as const } : protect.length > 0 ? { protect } : {}),
    ...(ui.rawColors ? { rawColors: true } : {}),
    ...(ui.dacColors ? { dacColors: true } : {}),
    ...(ui.strict ? { strict: true } : {}),
  };
}

/** Quote a value for a shell command line only when it needs it. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The equivalent CLI command for the current settings (doc 07 §UX).
 *
 * Only non-default flags appear, in the order `demake prep --help` lists them,
 * so the line reads like something a person would have typed — and pasting it
 * into a terminal reproduces exactly what the page is showing.
 */
export function equivalentCommand(
  ui: PrepOptionsUi,
  sourceName: string,
  command: "prep" | "gen" = "prep",
  format?: string,
): string {
  const parts = [`demake ${command}`, shellQuote(sourceName), "-c", ui.console];
  if (command === "gen" && format) parts.push("--format", format);
  if (ui.strategy !== DEFAULT_OPTIONS.strategy) parts.push("--strategy", ui.strategy);
  if (ui.size !== "") {
    parts.push("--size", ui.size);
    if (ui.fit !== DEFAULT_OPTIONS.fit) parts.push("--fit", ui.fit);
  }
  if (ui.scale !== DEFAULT_OPTIONS.scale) parts.push("--scale", ui.scale);
  if (ui.dither !== "") parts.push("--dither", ui.dither);
  if (ui.profile !== DEFAULT_OPTIONS.profile) parts.push("--profile", ui.profile);
  if (ui.effort !== DEFAULT_OPTIONS.effort) parts.push("--effort", ui.effort);
  if (ui.noProtect) parts.push("--no-protect");
  else if (ui.protect !== "") parts.push("--protect", shellQuote(ui.protect));
  if (ui.metric !== DEFAULT_OPTIONS.metric) parts.push("--metric", ui.metric);
  if (ui.seed !== "") parts.push("--seed", ui.seed);
  if (ui.background !== DEFAULT_OPTIONS.background) parts.push("--background", ui.background);
  if (ui.rawColors) parts.push("--raw-colors");
  if (ui.dacColors) parts.push("--dac-colors");
  if (ui.strict) parts.push("--strict");
  return parts.join(" ");
}
