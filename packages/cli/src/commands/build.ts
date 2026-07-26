/**
 * `demake build` — a Demotic game becomes a playable ROM (doc 14 §Runtime
 * model, doc 15).
 *
 * The build *compiles*: a game becomes SM83 machine code specialised to it, with
 * only the runtime routines something in it actually reaches. The assembler is
 * ours and written in TypeScript, so this needs no toolchain and the browser can
 * do the same job byte for byte (doc 07 §parity). RGBDS, when it happens to be
 * installed, is used for one optional thing only — stamping the Nintendo logo so
 * the cartridge boots on original hardware — and its absence is reported, never
 * guessed around.
 *
 * There is no Demakefile yet (doc 15 is the design; this is the zero-config
 * path it says must exist on its own). Flags stand in for the manifest, and the
 * defaults are the ones `demake init` will eventually write out.
 */

import { dirname, join } from "node:path";

import {
  buildGbRom,
  BuildError,
  compile,
  describeProgram,
  findProfile,
  formatDiagnostics,
  GameLangError,
  levelFiles,
  profiles,
  unsupportedFeatures,
  type Program,
} from "@demake/demotic";
import type { ParsedValue } from "@demake/cli-spec";

import type { CliEnv } from "../env.js";
import { EXIT, type ExitCode } from "../exit-codes.js";
import { CliError, resolveInput } from "../io.js";

function str(values: Record<string, ParsedValue>, key: string): string | undefined {
  return typeof values[key] === "string" ? (values[key] as string) : undefined;
}

/**
 * Consoles with a code-generation backend today. Everything else is an honest
 * error. `gbc` builds the same DMG-compatible cartridge as `gb` until the
 * colour work lands — the machine code is identical, so its trace is too.
 */
const RUNTIME_CONSOLES = ["gb", "gbc"] as const;

/** Derive a default output name and cartridge title from the source path. */
function stemFromSource(source: string): string {
  if (source === "<stdin>") return "game";
  const base = source.replace(/^.*[/\\]/, "").replace(/\.dmt$/i, "");
  return base.length > 0 ? base : "game";
}

/**
 * Load the `.dmtl` files a source references, relative to the source.
 *
 * Reading them here rather than in `@demake/demotic` is the platform-purity
 * rule (doc 02): the compiler takes level *text*, and finding the text is the
 * edge's job.
 */
function loadLevels(env: CliEnv, source: string, path: string): Record<string, string> {
  const levels: Record<string, string> = {};
  if (path === "<stdin>") return levels;
  const root = dirname(path);
  for (const file of levelFiles(source)) {
    try {
      levels[file] = new TextDecoder().decode(env.readFile(join(root, file)));
    } catch {
      // A missing level is the compiler's diagnostic to report, with the line
      // number and the name — better than a file-not-found from here.
    }
  }
  return levels;
}

/**
 * Load the assets a program names, next to the source that named it.
 *
 * Art, music and sound effects all arrive the same way, because the build
 * converts all three itself: the edge's only job is to find bytes for a name.
 *
 * Missing assets are not an error here: the build reports them and falls back —
 * to the built-in block for art, to silence for audio — which is a far better
 * outcome than refusing to produce a playable cartridge because one sprite was
 * renamed. What must never happen is a *different* fallback in the browser,
 * which is why both edges hand the same bytes to the same converters and
 * neither converts anything itself.
 */
function loadAssets(env: CliEnv, program: Program, path: string): Map<string, Uint8Array> {
  const assets = new Map<string, Uint8Array>();
  if (path === "<stdin>") return assets;
  const root = dirname(path);
  // `program.assets` rather than the art *requests*, because a request is per
  // box and backdrops make none — loading only what `artRequests` names is how
  // the CLI came to build cartridges with no title screen while the page built
  // them with one, which is exactly the divergence this file exists to prevent.
  const names = [...program.assets, ...program.tracks, ...program.sounds];
  for (const name of names) {
    try {
      assets.set(name, env.readFile(join(root, name)));
    } catch {
      // Reported by the build, with every missing name at once.
    }
  }
  return assets;
}

export async function runBuild(
  env: CliEnv,
  values: Record<string, ParsedValue>,
  positionals: readonly string[],
): Promise<ExitCode> {
  const json = values.json === true;
  const quiet = values.quiet === true;
  const consoleId = str(values, "console") ?? "gb";

  const profile = findProfile(consoleId);
  if (!profile) {
    throw new CliError(
      EXIT.USAGE,
      "E_UNKNOWN_CONSOLE",
      `unknown console '${consoleId}'`,
      `Demotic targets: ${profiles.map((profile) => profile.id).join(", ")}`,
    );
  }
  if (!(RUNTIME_CONSOLES as readonly string[]).includes(profile.id)) {
    throw new CliError(
      EXIT.UNAVAILABLE,
      "E_NO_RUNTIME",
      `no console runtime exists for '${profile.id}' yet`,
      `today only ${RUNTIME_CONSOLES.join(", ")} can be built; see docs/13-roadmap.md §D4.`,
    );
  }

  const { bytes, source: sourcePath } = resolveInput(env, [...positionals]);
  const source = new TextDecoder().decode(bytes);

  let program: Program;
  try {
    program = compile(source, {
      profile,
      levels: loadLevels(env, source, sourcePath),
    });
  } catch (error) {
    if (error instanceof GameLangError) {
      throw new CliError(
        EXIT.BAD_INPUT,
        "E_COMPILE_FAILED",
        `${sourcePath} did not compile for ${profile.id}`,
        formatDiagnostics(error.diagnostics),
      );
    }
    throw error;
  }

  const missing = unsupportedFeatures(program);
  if (missing.length > 0) {
    throw new CliError(
      EXIT.UNAVAILABLE,
      "E_RUNTIME_UNSUPPORTED",
      `the ${profile.id} backend cannot build ${missing.join(" or ")} yet`,
      "the preview plays it correctly; a ROM would not, so the build stops rather than " +
        "shipping a different game. See docs/13-roadmap.md §D6.",
    );
  }

  const stem = stemFromSource(sourcePath);
  const title = str(values, "title") ?? stem;
  const format = str(values, "format") ?? "rom";

  let product: Uint8Array;
  let stats;
  let symbols: ReadonlyMap<string, number>;
  try {
    const built = buildGbRom(program, { title, assets: loadAssets(env, program, sourcePath) });
    stats = built.stats;
    symbols = built.symbols;
    product = format === "sym" ? new TextEncoder().encode(formatSymbols(symbols)) : built.bytes;
  } catch (error) {
    if (error instanceof BuildError) {
      throw new CliError(EXIT.FAILURE, error.code, error.message, error.hint);
    }
    throw error;
  }

  const extension = format === "sym" ? "sym" : profile.id === "gbc" ? "gbc" : "gb";
  const output = str(values, "output");
  const target = output ?? (env.stdoutIsTTY() ? `${stem}.${extension}` : undefined);

  if (target === undefined) {
    env.writeStdout(product);
  } else {
    env.writeFileAtomic(target, product, values.force === true);
  }

  // Stamping is opt-in so the default output is byte-identical to what the
  // browser produces for the same source — the doc-07 parity contract, restated
  // for games. The logo is Nintendo's, so we never ship it ourselves.
  const wantsLogo = values["boot-logo"] === true;
  if (wantsLogo && (target === undefined || format !== "rom")) {
    throw new CliError(
      EXIT.USAGE,
      "E_BAD_OPTION",
      "--boot-logo needs a ROM written to a file",
      "give -o <file> and leave --format at rom.",
    );
  }
  if (wantsLogo) stampLogo(env, target as string);

  if (json) {
    env.out(
      `${JSON.stringify(
        {
          source: sourcePath,
          console: profile.id,
          format,
          output: target ?? "<stdout>",
          bytes: product.length,
          title: format === "rom" ? title.toUpperCase().slice(0, 15) : undefined,
          rom: stats,
          bootLogo: wantsLogo,
          warnings: program.warnings,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }

  if (!quiet) {
    env.errOut(`${describeProgram(program)}\n`);
    env.errOut(
      `code ${stats.bytes} bytes (${stats.free} free in ROM), ${stats.ram} bytes of work RAM\n`,
    );
    env.errOut(
      `runtime helpers: ${stats.helpers.length > 0 ? stats.helpers.join(", ") : "none — every one was compiled away"}\n`,
    );
    if (stats.artTiles > 0) {
      env.errOut(`art: ${stats.artTiles} tiles demade from the program's sources\n`);
    }
    if (stats.missingArt.length > 0) {
      env.errOut(
        `note: no art found for ${stats.missingArt.join(", ")}; those objects draw as blocks\n`,
      );
    }
    if (stats.audio) {
      const { audio } = stats;
      env.errOut(
        `audio: ${audio.tracks} track(s), ${audio.effects} effect(s) at ` +
          `${audio.rateHz.toFixed(2)} Hz — ${audio.code} bytes of driver, ${audio.data} of schedule\n`,
      );
      for (const note of audio.notes) env.errOut(`  ${note}\n`);
    }
    if (stats.missingAudio.length > 0) {
      env.errOut(
        `note: no audio found for ${stats.missingAudio.join(", ")}; the game plays without it\n`,
      );
    }
    if (program.warnings.length > 0) {
      env.errOut(`${formatDiagnostics(program.warnings)}\n`);
    }
    if (!wantsLogo && format === "rom") {
      env.errOut(
        "note: the boot-logo area is blank, so this runs in emulators that direct boot but " +
          "not on original hardware. Pass --boot-logo (needs RGBDS) for a hardware cartridge.\n",
      );
    }
  }
  return EXIT.OK;
}

/**
 * The symbol map, in the no-bank RGBDS format a profiler or a debugger reads.
 *
 * Emitting it matters more here than for a fixed engine: the code is *specific
 * to this game*, so a cycle histogram bucketed by these symbols says which of
 * its rules is expensive, not which part of an interpreter is.
 */
function formatSymbols(symbols: ReadonlyMap<string, number>): string {
  const lines = [...symbols]
    .filter(([, address]) => address < 0x8000)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([name, address]) => `00:${address.toString(16).padStart(4, "0")} ${name}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Ask `rgbfix` to stamp the boot logo and re-fix the header.
 *
 * We do not ship the logo ourselves — it is Nintendo's, and doc 06 already
 * takes that position for the NDS builder — so this is the one step that needs
 * a toolchain, and it is the one step that is optional.
 */
function stampLogo(env: CliEnv, path: string): void {
  if (!env.which("rgbfix")) {
    throw new CliError(
      EXIT.UNAVAILABLE,
      "E_TOOLCHAIN_MISSING",
      "--boot-logo needs rgbfix, which is not on PATH",
      "install RGBDS (tools/toolchains/install-rgbds.sh, or `pnpm toolchains`), or drop the flag.",
    );
  }
  const result = env.run("rgbfix", ["-v", "-p", "0xFF", path], ".");
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(0, 3).join("; ");
    throw new CliError(
      EXIT.FAILURE,
      "E_ROM_BUILD_FAILED",
      `rgbfix failed (exit ${result.code})${detail ? `: ${detail}` : ""}`,
    );
  }
}
