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

import {
  buildGame,
  BuildError,
  artOverrides,
  compile,
  describeProgram,
  findProfile,
  formatDiagnostics,
  resolveOptions,
  GameLangError,
  optionValue,
  outputPath,
  profiles,
  romExtension,
  runtimeConsoles,
  unsupportedFor,
  type Diagnostic,
  type Program,
} from "@demake/demotic";
import type { PrepOptions } from "@demake/core";
import type { ParsedValue } from "@demake/cli-spec";

import type { CliEnv } from "../env.js";
import { at, loadAssets, loadLevels, openInput } from "./project-input.js";
import { parseJobs, withPool } from "../parallel/pool.js";
import { EXIT, type ExitCode } from "../exit-codes.js";
import { CliError } from "../io.js";

function str(values: Record<string, ParsedValue>, key: string): string | undefined {
  return typeof values[key] === "string" ? (values[key] as string) : undefined;
}

/**
 * Consoles with a code-generation backend today. Everything else is an honest
 * error.
 *
 * Read from the backend registry rather than listed here, so that a console
 * builds exactly when a backend claims it — `gbc` is a real Game Boy Color
 * cartridge demade in colour, `nes` a real NROM one demade for a fixed master
 * palette and 16×16 attribute cells, and `megaduck` a real Mega Duck cartridge:
 * the Game Boy's machine code through that console's own register page, with no
 * header, because it has no boot ROM to check one. A game traces identically on
 * all four.
 */
const RUNTIME_CONSOLES = runtimeConsoles;

/**
 * Whether this console's cartridges carry a Nintendo boot logo for hardware to
 * check.
 *
 * The two Game Boys, and not the third machine in their codegen family: a Mega
 * Duck has no boot ROM and its cartridges have no header, so there is no logo
 * area — and `rgbfix` would happily stamp a Game Boy header straight over the
 * game's own code, which begins at $0000 and runs through where $0104-$014F
 * would be. Asking the family would get this exactly backwards.
 */
/**
 * A cartridge size, the way a cartridge was sold.
 *
 * Kilobytes and megabytes rather than a byte count, because the number this
 * reports is a *board* — the point of an elastic cartridge is that a small game
 * ships on a small one, and "16 KiB" says that where "16384" makes the reader do
 * the division.
 */
function cartridgeSize(bytes: number): string {
  return bytes >= 0x100000 ? `${bytes / 0x100000} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

function checksBootLogo(consoleId: string): boolean {
  return consoleId === "gb" || consoleId === "gbc";
}

/** Derive a default output name and cartridge title from the source path. */
function stemFromSource(source: string): string {
  if (source === "<stdin>") return "game";
  const base = source.replace(/^.*[/\\]/, "").replace(/\.dmt$/i, "");
  return base.length > 0 ? base : "game";
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

  const input = openInput(env, positionals);
  const sourcePath = input.path;
  const source = input.source;

  let program: Program;
  try {
    program = compile(source, {
      profile,
      files: input.files,
      levels: loadLevels(env, input),
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

  // What the Demakefile says about each picture (doc 15 §Resolution). Validated
  // here rather than at the fitter, so a value it cannot read stops the build with
  // the Demakefile's own line number instead of surfacing as a strange fit.
  const artSettings: Record<string, Partial<PrepOptions>> = {};
  {
    const target = input.plan.targets.find((one) => one.console === profile.id);
    const badOptions: Diagnostic[] = [];
    for (const path of program.assets) {
      const resolvedOptions = resolveOptions(
        input.build,
        path,
        "art",
        target?.name ?? profile.id,
        input.files,
      );
      if (Object.keys(resolvedOptions).length === 0) continue;
      const { options: converted, diagnostics } = artOverrides(resolvedOptions, 1, profile.id);
      badOptions.push(...diagnostics);
      if (Object.keys(converted).length > 0) artSettings[path] = converted;
    }
    if (badOptions.length > 0) {
      throw new CliError(
        EXIT.BAD_INPUT,
        "E_BAD_OPTION",
        `the Demakefile sets ${String(badOptions.length)} option${badOptions.length === 1 ? "" : "s"} that cannot be used`,
        formatDiagnostics(badOptions),
      );
    }
  }

  const missing = unsupportedFor(program);
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
  // Title precedence, most specific first: the flag, the target's own header, the
  // project's metadata, then the source's stem. `header` is doc 15's block and
  // this is the one field of it the cartridge builders already take — the rest
  // (mapper, mirroring, serial, region) are parsed and reported but not yet
  // applied, which §Status in doc 15 now says.
  const planned = input.plan.targets.find((one) => one.console === profile.id);
  const title =
    str(values, "title") ??
    planned?.header["title"] ??
    (input.root !== undefined
      ? optionValue(input.build.project?.fields ?? [], "title")
      : undefined) ??
    stem;
  const format = str(values, "format") ?? "rom";

  let product: Uint8Array;
  let stats;
  let symbols: ReadonlyMap<string, number>;
  try {
    const assets = loadAssets(env, program, input);
    // Most of a build is the art and audio tournaments, and their candidates
    // cannot see each other — so they get the machine's cores. The cartridge is
    // the same bytes whatever `--jobs` says (doc 04 §Running the tournament).
    const built = await withPool(parseJobs(str(values, "jobs")), (executor) =>
      buildGame(program, {
        title,
        assets,
        ...(Object.keys(artSettings).length === 0 ? {} : { art: artSettings }),
        ...(executor === undefined ? {} : { executor }),
      }),
    );
    stats = built.stats;
    symbols = built.symbols;
    product = format === "sym" ? new TextEncoder().encode(formatSymbols(symbols)) : built.bytes;
  } catch (error) {
    if (error instanceof BuildError) {
      throw new CliError(EXIT.FAILURE, error.code, error.message, error.hint);
    }
    throw error;
  }

  const extension = format === "sym" ? "sym" : romExtension(program);
  const output = str(values, "output");
  // `-o` always wins. Without it, a project with a Demakefile writes where that
  // file says — `{out}/{console}/{project}.{ext}` unless a target stated a path
  // (doc 15 §`target <name>`) — and a bare `.dmt` keeps the behaviour it had.
  const generated =
    input.root !== undefined && input.plan.targets.length > 0
      ? (() => {
          const chosen = planned ?? input.plan.targets[0];
          if (!chosen) return undefined;
          const stated = chosen.outputs.find((one) => one.format === format)?.path;
          return at(input.root, outputPath(input.plan, chosen, extension, stated));
        })()
      : undefined;
  const target = output ?? generated ?? (env.stdoutIsTTY() ? `${stem}.${extension}` : undefined);

  if (target === undefined) {
    env.writeStdout(product);
  } else {
    // A path the *Demakefile* chose is regenerable by definition — that is what
    // `out` and `build/` mean (doc 19 §`build/` is the CLI's) — so it is
    // overwritten freely. A path the user typed with `-o` keeps the guard, since
    // clobbering a file somebody named is the mistake the guard exists for.
    env.writeFileAtomic(target, product, values.force === true || target === generated);
  }

  // Stamping is opt-in so the default output is byte-identical to what the
  // browser produces for the same source — the doc-07 parity contract, restated
  // for games. The logo is Nintendo's, so we never ship it ourselves.
  const wantsLogo = values["boot-logo"] === true;
  if (wantsLogo && !checksBootLogo(profile.id)) {
    throw new CliError(
      EXIT.USAGE,
      "E_BAD_OPTION",
      `--boot-logo is a Game Boy cartridge's, and this is ${profile.name}`,
      "no other console in scope checks a logo at boot, so there is nothing to stamp.",
    );
  }
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
          // The project root, when the build was pointed at a folder — and what
          // its references resolved to. A reference is the shortest name that
          // identifies a file (doc 19 §The rule), so the resolved paths are the
          // one thing a reader cannot work out from the source alone.
          project: input.root ?? null,
          plan: input.root === undefined ? null : input.plan,
          assets: program.assets,
          tracks: program.tracks,
          sounds: program.sounds,
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
      // The board this game got, and how much it could still grow — which are
      // two different numbers now that a cartridge is elastic (doc 14 §Elastic
      // cartridges): the first is the artifact and the second is the headroom
      // before it stops fitting the console at all.
      `code ${stats.bytes} bytes in a ${cartridgeSize(stats.cartridge)} cartridge ` +
        `(room for ${stats.free} more), ${stats.ram} bytes of work RAM\n`,
    );
    // Before anything else this build has to say: a cartridge that plays silently
    // is not the game somebody asked for, even though it is a game.
    for (const note of stats.cut) env.errOut(`warning: ${note}\n`);
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
      // "not built" rather than "not found", because both are reasons to be here
      // and only one of them is about the file: a console whose driver does not
      // exist yet reports every track it was handed, and telling someone their
      // `rally.mid` is missing when it is sitting next to the `.dmt` sends them
      // looking in the wrong place.
      env.errOut(
        `note: no audio was built for ${stats.missingAudio.join(", ")}; the game plays without it\n`,
      );
    }
    if (program.warnings.length > 0) {
      env.errOut(`${formatDiagnostics(program.warnings)}\n`);
    }
    if (!wantsLogo && format === "rom" && checksBootLogo(profile.id)) {
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
