/**
 * `demake arrange`, `demake sfx` and `demake render` (docs 16, 17, 18).
 *
 * Thin over `@demake/audio`, on the same terms every other command is thin over
 * `core`: the CLI parses flags, reads bytes, writes bytes, and reports. It makes
 * no decision about music, and — importantly — it makes no sound of its own. A
 * preview is `render()`'s output encoded, which is the whole of doc 16 §Claim 3
 * as far as this layer is concerned.
 */

import {
  arrangeScore,
  candidates,
  demakeSfx,
  encodeWav,
  parseMidi,
  render,
  scriptSeconds,
  type ArrangeOptions,
  type ChipScript,
  type PartRole,
  type SfxOptions,
} from "@demake/audio";
import type { ParsedValue } from "@demake/cli-spec";
import { getConsole } from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT, type ExitCode } from "../exit-codes.js";
import { CliError, emitProduct, resolveInput } from "../io.js";

function str(values: Record<string, ParsedValue>, key: string): string | undefined {
  return typeof values[key] === "string" ? (values[key] as string) : undefined;
}

/**
 * Read a chip schedule out of input bytes, or `null` if that is not what it is.
 *
 * Both `render` and `gen` dispatch on this, which is why it lives here rather
 * than in either of them: the two commands must agree exactly about what counts
 * as a chip artifact, or `gen` would decline something `render` plays.
 *
 * It reads the manifest sidecar rather than a `.vgm` because a VGM's timing is
 * quantized to its 44.1 kHz timebase (doc 16 §Artifacts) — the schedule is the
 * exact thing, and the driver has to write it exactly.
 */
export function readChipScript(bytes: Uint8Array): ChipScript | null {
  // A JSON document starts with `{` after any whitespace; a PNG or a MIDI file
  // does not, so this rejects an image in one byte instead of on a decode.
  let at = 0;
  while (at < bytes.length && bytes[at]! <= 0x20) at += 1;
  if (bytes[at] !== 0x7b) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const script = (
    parsed !== null && typeof parsed === "object" && "script" in parsed
      ? (parsed as { script: unknown }).script
      : parsed
  ) as ChipScript | null;
  if (!script || typeof script !== "object") return null;
  if (!Array.isArray(script.ticks) || !script.driver || typeof script.console !== "string") {
    return null;
  }
  return script;
}

function list(values: Record<string, ParsedValue>, key: string): string[] {
  const value = values[key];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}

function requireConsole(values: Record<string, ParsedValue>): string {
  const consoleId = str(values, "console");
  if (!consoleId) {
    throw new CliError(
      EXIT.USAGE,
      "E_MISSING_CONSOLE",
      "missing required --console",
      "e.g. --console gb",
    );
  }
  return consoleId;
}

/** `--role 3=bass`, repeatable, into the option shape. */
function parseRoles(entries: readonly string[]): Record<string, PartRole> {
  const roles: PartRole[] = ["percussion", "bass", "lead", "harmony", "pad", "arp", "fx"];
  const out: Record<string, PartRole> = {};
  for (const entry of entries) {
    const at = entry.indexOf("=");
    const part = at < 0 ? "" : entry.slice(0, at);
    const role = at < 0 ? "" : entry.slice(at + 1);
    if (!part || !roles.includes(role as PartRole)) {
      throw new CliError(
        EXIT.USAGE,
        "E_INVALID_OPTION",
        `--role expects <part>=<role>, got '${entry}'`,
        `roles are: ${roles.join(", ")}`,
      );
    }
    out[part] = role as PartRole;
  }
  return out;
}

/** Write the exact render, when `--preview` asks for it. */
function writePreview(
  env: CliEnv,
  script: ChipScript,
  values: Record<string, ParsedValue>,
): string | null {
  const path = str(values, "preview");
  if (!path) return null;
  const format = str(values, "preview-format") ?? "wav";
  if (format !== "wav") {
    throw new CliError(
      EXIT.UNAVAILABLE,
      "E_PREVIEW_FORMAT",
      `--preview-format ${format} is not available yet`,
      "WAV is sample-exact and carries the guarantee; the other encoders land with their WASM builds.",
    );
  }
  const stage = str(values, "output-stage");
  const pcm = render(script, {
    ...(stage === "board" ? { outputStage: "board" as const } : {}),
  });
  env.writeFileAtomic(path, encodeWav(pcm), values.force === true);
  return path;
}

export async function runArrange(
  env: CliEnv,
  values: Record<string, ParsedValue>,
  positionals: string[],
): Promise<ExitCode> {
  const json = values.json === true;
  const consoleId = requireConsole(values);

  // `--strategy list` needs no input, exactly as it does for images.
  if (str(values, "strategy") === "list") {
    const spec = getConsole(consoleId).audio;
    if (!spec) {
      throw new CliError(
        EXIT.USAGE,
        "E_NO_AUDIO_SPEC",
        `${consoleId} has no audio spec yet`,
        "see docs/16-audio-engine.md §The chips.",
      );
    }
    const portfolio = candidates(spec);
    if (json) {
      env.out(
        JSON.stringify({ schemaVersion: 1, console: consoleId, strategies: portfolio }, null, 2) +
          "\n",
      );
    } else {
      for (const entry of portfolio) env.out(`  ${entry.id}  — ${entry.summary}\n`);
    }
    return EXIT.OK;
  }

  const { bytes } = resolveInput(env, positionals);
  const options: ArrangeOptions = { console: consoleId };
  const strategy = str(values, "strategy");
  if (strategy) options.strategy = strategy;
  if (typeof values.bpm === "number") options.bpm = values.bpm;
  const tempo = str(values, "tempo");
  if (tempo === "snap") options.tempo = "snap";
  const roles = parseRoles(list(values, "role"));
  if (Object.keys(roles).length > 0) options.roles = roles;
  const drop = list(values, "drop");
  if (drop.length > 0) options.drop = drop;
  if (typeof values.channels === "number") options.channels = values.channels;
  const reserve = list(values, "reserve");
  if (reserve.length > 0) options.reserve = reserve;
  const effort = str(values, "effort");
  if (effort) options.effort = effort as "fast" | "default" | "max";
  if (values.strict === true) options.strict = true;
  const title = str(values, "title");
  if (title) options.title = title;

  const result = arrangeScore(parseMidi(bytes), options);
  const emit = emitProduct(
    env,
    result.artifact,
    str(values, "output"),
    values.force === true,
    json,
  );
  const preview = writePreview(env, result.script, values);
  // The sidecar carries the *whole* schedule, exact tick timing included, which
  // is what doc 16 §Artifacts asks of it and what lets `render` reproduce this
  // audio rather than the VGM's 44.1 kHz-quantized approximation of it.
  const manifest = writeManifest(env, values, {
    schemaVersion: 1,
    script: result.script,
    dropped: result.dropped,
    diagnostics: result.diagnostics,
    tournament: result.tournament,
  });

  if (json) {
    env.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          output: emit.wroteTo,
          preview,
          manifest,
          seconds: scriptSeconds(result.script),
          timing: result.timing,
          parts: result.score.parts.map((part) => ({
            id: part.id,
            name: part.name,
            role: part.role,
            roleConfidence: part.roleConfidence,
            notes: part.notes.length,
            polyphony: part.polyphony,
          })),
          channels: result.script.channels,
          dropped: result.dropped,
          budgets: result.script.budgets,
          diagnostics: result.diagnostics,
          tournament: result.tournament,
        },
        null,
        2,
      ) + "\n",
    );
    return EXIT.OK;
  }

  if (values.quiet !== true) {
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.severity === "info" && (values.verbose ?? 0) === 0) continue;
      env.errOut(`demake: ${diagnostic.severity}: ${diagnostic.message}\n`);
    }
  }
  return EXIT.OK;
}

export async function runSfx(
  env: CliEnv,
  values: Record<string, ParsedValue>,
  positionals: string[],
): Promise<ExitCode> {
  const json = values.json === true;
  const consoleId = requireConsole(values);
  const { bytes } = resolveInput(env, positionals);

  const options: SfxOptions = { console: consoleId };
  const maxLength = str(values, "max-length");
  if (maxLength !== undefined) {
    const seconds = Number(maxLength);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new CliError(EXIT.USAGE, "E_INVALID_OPTION", `--max-length must be a positive number`);
    }
    options.maxLength = seconds;
  }
  const strategy = str(values, "strategy");
  if (strategy && strategy !== "auto") options.strategy = strategy;
  const effort = str(values, "effort");
  if (effort) options.effort = effort as "fast" | "default" | "max";
  const title = str(values, "title");
  if (title) options.title = title;

  const result = demakeSfx(bytes, options);
  const emit = emitProduct(
    env,
    result.artifact,
    str(values, "output"),
    values.force === true,
    json,
  );
  const preview = writePreview(env, result.script, values);
  // The same sidecar `arrange` writes, and for the same reason: it carries the
  // exact schedule, which is what `render` and `gen --format rom` both read.
  const manifest = writeManifest(env, values, {
    schemaVersion: 1,
    script: result.script,
    soundClass: result.soundClass,
    placement: result.placement,
    diagnostics: result.diagnostics,
    tournament: result.tournament,
  });

  if (json) {
    env.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          output: emit.wroteTo,
          preview,
          manifest,
          soundClass: result.soundClass,
          seconds: scriptSeconds(result.script),
          placement: result.placement,
          budgets: result.script.budgets,
          diagnostics: result.diagnostics,
          tournament: result.tournament,
        },
        null,
        2,
      ) + "\n",
    );
    return EXIT.OK;
  }
  if (values.quiet !== true) {
    for (const diagnostic of result.diagnostics) {
      env.errOut(`demake: ${diagnostic.severity}: ${diagnostic.message}\n`);
    }
  }
  return EXIT.OK;
}

/**
 * `demake render` — hear a compliant artifact as the hardware plays it.
 *
 * Reads the manifest sidecar rather than the `.vgm` itself: a VGM's timing is
 * quantized to its 44.1 kHz timebase (doc 16 §Artifacts), and rendering from
 * the exact schedule is what makes this the same audio `arrange` would preview.
 */
export async function runRender(
  env: CliEnv,
  values: Record<string, ParsedValue>,
  positionals: string[],
): Promise<ExitCode> {
  const { bytes, source } = resolveInput(env, positionals);
  const script = readChipScript(bytes);
  if (!script) {
    throw new CliError(
      EXIT.BAD_INPUT,
      "E_UNSUPPORTED_ARTIFACT",
      `cannot render '${source}'`,
      "render reads the schedule manifest that --emit-manifest writes; reading .vgm back lands with the artifact importer.",
    );
  }

  const stage = str(values, "output-stage");
  const pcm = render(script, {
    ...(typeof values["sample-rate"] === "number" ? { sampleRate: values["sample-rate"] } : {}),
    ...(stage === "board" ? { outputStage: "board" as const } : {}),
    ...(typeof values.loops === "number" ? { loops: values.loops } : {}),
  });
  const wav = encodeWav(pcm);
  const emit = emitProduct(
    env,
    wav,
    str(values, "output"),
    values.force === true,
    values.json === true,
  );
  if (values.json === true) {
    env.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          output: emit.wroteTo,
          sampleRate: pcm.sampleRate,
          seconds: (pcm.channels[0]?.length ?? 0) / pcm.sampleRate,
        },
        null,
        2,
      ) + "\n",
    );
  }
  return EXIT.OK;
}

function writeManifest(
  env: CliEnv,
  values: Record<string, ParsedValue>,
  payload: unknown,
): string | null {
  const raw = values["emit-manifest"];
  if (raw === undefined) return null;
  const output = str(values, "output");
  const path =
    typeof raw === "string" && raw.length > 0
      ? raw
      : output
        ? output.replace(/\.[^.]+$/, "") + ".json"
        : "manifest.json";
  env.writeFileAtomic(
    path,
    new TextEncoder().encode(JSON.stringify(payload, null, 2) + "\n"),
    values.force === true,
  );
  return path;
}
