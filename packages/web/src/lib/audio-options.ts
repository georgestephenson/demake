/**
 * The audio option model (doc 07 §UX: "the UI mirrors the CLI's mental model").
 *
 * One record per command — `arrange` and `sfx` — with a field for every flag
 * doc 05 lists, plus the two translations that keep the page honest: into the
 * engine's own option objects, and into the *equivalent command line* the panes
 * display. Both derive from the same defaults, so the line shown is exactly what
 * the page just ran, including the omissions: a flag at its default is not
 * printed, as a person would type it.
 *
 * `--sample-rate` and `--loops` belong to `demake render` rather than to either
 * demaker, and that split is kept rather than smoothed over — the Listen pane
 * says which command each of its downloads corresponds to.
 */

import type { ArrangeOptions, PartRole, SfxOptions } from "@demake/audio";

import { shellQuote } from "./options.js";
import type { ArrangeOptionsUi, SfxOptionsUi } from "../worker/audio-protocol.js";

/** The rate everything is rendered at unless the audio device insists otherwise. */
export const DEFAULT_SAMPLE_RATE = 48000;

/** The defaults `demake arrange` itself applies (doc 05 §arrange). */
export const DEFAULT_ARRANGE: ArrangeOptionsUi = {
  console: "dmg",
  strategy: "auto",
  bpm: "",
  tempo: "exact",
  roles: {},
  drop: [],
  channels: "",
  reserve: [],
  effort: "default",
  strict: false,
  title: "",
  outputStage: "raw",
  sampleRate: String(DEFAULT_SAMPLE_RATE),
  loops: "0",
};

/** The defaults `demake sfx` itself applies (doc 05 §sfx). */
export const DEFAULT_SFX: SfxOptionsUi = {
  console: "dmg",
  strategy: "",
  maxLength: "5",
  effort: "default",
  title: "",
  outputStage: "raw",
  sampleRate: String(DEFAULT_SAMPLE_RATE),
  loops: "0",
};

function positive(text: string): number | undefined {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Translate the music UI record into the engine's `ArrangeOptions`. */
export function toArrangeOptions(ui: ArrangeOptionsUi): ArrangeOptions {
  const bpm = positive(ui.bpm);
  const channels = positive(ui.channels);
  const roles = Object.entries(ui.roles);
  return {
    console: ui.console,
    ...(ui.strategy !== "auto" ? { strategy: ui.strategy } : {}),
    ...(bpm === undefined ? {} : { bpm: Math.round(bpm) }),
    ...(ui.tempo === "snap" ? { tempo: "snap" as const } : {}),
    ...(roles.length > 0 ? { roles: Object.fromEntries(roles) as Record<string, PartRole> } : {}),
    ...(ui.drop.length > 0 ? { drop: [...ui.drop] } : {}),
    ...(channels === undefined ? {} : { channels: Math.round(channels) }),
    ...(ui.reserve.length > 0 ? { reserve: [...ui.reserve] } : {}),
    ...(ui.effort !== "default" ? { effort: ui.effort } : {}),
    ...(ui.strict ? { strict: true } : {}),
    ...(ui.title !== "" ? { title: ui.title } : {}),
  };
}

/** Translate the sound UI record into the engine's `SfxOptions`. */
export function toSfxOptions(ui: SfxOptionsUi): SfxOptions {
  const maxLength = positive(ui.maxLength);
  return {
    console: ui.console,
    ...(ui.strategy !== "" ? { strategy: ui.strategy } : {}),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(ui.effort !== "default" ? { effort: ui.effort } : {}),
    ...(ui.title !== "" ? { title: ui.title } : {}),
  };
}

/** The render options both Listen panes drive `demake render` with. */
export function toRenderOptions(ui: { outputStage: string; sampleRate: string; loops: string }): {
  sampleRate?: number;
  outputStage?: "board";
  loops?: number;
} {
  const rate = positive(ui.sampleRate);
  const loops = Number(ui.loops.trim());
  return {
    ...(rate === undefined ? {} : { sampleRate: Math.round(rate) }),
    ...(ui.outputStage === "board" ? { outputStage: "board" as const } : {}),
    ...(Number.isFinite(loops) && loops > 0 ? { loops: Math.round(loops) } : {}),
  };
}

/** The stem the CLI would derive from a source file name. */
export function stemOf(name: string): string {
  const base = name.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
  return base === "" ? "out" : base;
}

/**
 * The equivalent `demake arrange` line for the current settings.
 *
 * It names all three outputs the page offers, because the page really does
 * produce all three: pasting it into a terminal leaves you with the same `.vgm`,
 * the same WAV and the same sidecar.
 */
export function arrangeCommand(ui: ArrangeOptionsUi, sourceName: string): string {
  const stem = stemOf(sourceName);
  const parts = ["demake arrange", shellQuote(sourceName), "-c", ui.console];
  if (ui.strategy !== DEFAULT_ARRANGE.strategy) parts.push("--strategy", ui.strategy);
  if (ui.bpm !== "") parts.push("--bpm", ui.bpm);
  if (ui.tempo !== DEFAULT_ARRANGE.tempo) parts.push("--tempo", ui.tempo);
  // Parts are named by id rather than by position: an index shifts when another
  // part is dropped, and the CLI would then apply the role to the wrong voice.
  for (const [part, role] of Object.entries(ui.roles)) {
    parts.push("--role", shellQuote(`${part}=${role}`));
  }
  for (const part of ui.drop) parts.push("--drop", shellQuote(part));
  if (ui.channels !== "") parts.push("--channels", ui.channels);
  for (const channel of ui.reserve) parts.push("--reserve", channel);
  if (ui.effort !== DEFAULT_ARRANGE.effort) parts.push("--effort", ui.effort);
  if (ui.outputStage !== DEFAULT_ARRANGE.outputStage) parts.push("--output-stage", ui.outputStage);
  if (ui.strict) parts.push("--strict");
  if (ui.title !== "") parts.push("--title", shellQuote(ui.title));
  parts.push("-o", `${stem}.vgm`, "--preview", `${stem}.wav`, "--emit-manifest", `${stem}.json`);
  return parts.join(" ");
}

/** The equivalent `demake sfx` line for the current settings. */
export function sfxCommand(ui: SfxOptionsUi, sourceName: string): string {
  const stem = stemOf(sourceName);
  const parts = ["demake sfx", shellQuote(sourceName), "-c", ui.console];
  if (ui.strategy !== "") parts.push("--strategy", ui.strategy);
  if (ui.maxLength !== DEFAULT_SFX.maxLength) parts.push("--max-length", ui.maxLength);
  if (ui.effort !== DEFAULT_SFX.effort) parts.push("--effort", ui.effort);
  if (ui.outputStage !== DEFAULT_SFX.outputStage) parts.push("--output-stage", ui.outputStage);
  if (ui.title !== "") parts.push("--title", shellQuote(ui.title));
  parts.push("-o", `${stem}.vgm`, "--preview", `${stem}.wav`, "--emit-manifest", `${stem}.json`);
  return parts.join(" ");
}

/**
 * The command behind the WAV download.
 *
 * `--preview` writes the render at its defaults, so that is what the button says
 * while the Listen controls are at theirs. Change a rate or ask for a loop and
 * the honest answer is `demake render`, which is the command that takes them.
 */
export function wavCommand(
  ui: { outputStage: string; sampleRate: string; loops: string },
  sourceName: string,
): string {
  const stem = stemOf(sourceName);
  const rate = ui.sampleRate.trim();
  const loops = Number(ui.loops.trim()) || 0;
  if (rate === String(DEFAULT_SAMPLE_RATE) && loops === 0) {
    return `(written by --preview ${stem}.wav above)`;
  }
  const parts = ["demake render", `${stem}.json`, "-o", `${stem}.wav`];
  if (rate !== String(DEFAULT_SAMPLE_RATE)) parts.push("--sample-rate", rate);
  if (loops > 0) parts.push("--loops", String(loops));
  if (ui.outputStage === "board") parts.push("--output-stage", "board");
  return parts.join(" ");
}

/** The command behind the cartridge download. */
export function romCommand(consoleId: string, sourceName: string, suffix: string): string {
  const stem = stemOf(sourceName);
  return `demake gen ${stem}.json -c ${consoleId} --format rom -o ${stem}${suffix}`;
}
