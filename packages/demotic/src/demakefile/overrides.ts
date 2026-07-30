/**
 * Turning a Demakefile's option strings into `prep` options (doc 15 §Resolution).
 *
 * The cascade in `resolve.ts` produces `Record<string, string>` — text, because a
 * build file is text. This is where that becomes typed options the image engine
 * takes, and it is the one place that decides **which options a build file may
 * set at all**.
 *
 * That list is a whitelist, and the reason is the rule the whole split rests on:
 * a Demakefile says *how* a picture is demade and never *what* the hardware is.
 * `size`, `fit`, `maxTiles`, `maxSubPalettes` and `console` are the build's own
 * arithmetic — what a window is, what a pattern table holds, what the font has
 * already taken — so a file that could set them could hand the fitter a budget
 * the cartridge does not have and produce art that does not fit. They are absent
 * from the whitelist rather than filtered later, and `applyArtOverrides` puts the
 * build's values back on top regardless, so there are two independent reasons a
 * build file cannot reach them.
 *
 * An unknown option or an unusable value is a **diagnostic**, never a silent
 * ignore: a build file whose settings quietly did nothing would be the worst of
 * the three possible behaviours.
 */

import { DITHER_ALGS, EFFORTS, METRICS, SCALE_KERNELS, strategies } from "@demake/core";
import type { PrepOptions } from "@demake/core";

import type { Diagnostic } from "../errors.js";

/**
 * The `prep` options a Demakefile may set, and how each one is read.
 *
 * `dither` takes an algorithm and an optional strength as `bayer4:50` — the
 * spelling doc 05 gives the flag, because doc 15 says a block's values are
 * "identical names and values to the doc-05 flags". Everything else is a plain
 * value from a closed set, so a typo is caught rather than passed through.
 */
const ART_OPTIONS = new Set([
  "strategy",
  "dither",
  "scale",
  "effort",
  "metric",
  "palette",
  "protect",
  "use",
]);

/** Audio's, per domain. Kept here so one file answers "what may a block say?". */
const MUSIC_OPTIONS = new Set([
  "strategy",
  "effort",
  "channels",
  "reserve",
  "loops",
  "tempo",
  "bpm",
  "role",
  "drop",
  "max-length",
  "use",
]);
const SOUND_OPTIONS = new Set(["strategy", "effort", "gesture", "max-length", "class", "use"]);

/** Which options a domain accepts. */
export function optionsFor(domain: "art" | "music" | "sound"): ReadonlySet<string> {
  return domain === "art" ? ART_OPTIONS : domain === "music" ? MUSIC_OPTIONS : SOUND_OPTIONS;
}

/** A validated set of `prep` overrides, plus whatever could not be read. */
export interface ArtOverride {
  options: Partial<PrepOptions>;
  diagnostics: readonly Diagnostic[];
}

function bad(name: string, value: string, allowed: readonly string[], line: number): Diagnostic {
  return {
    severity: "error",
    code: "E_BAD_OPTION",
    message: `'${value}' is not a value for '${name}'`,
    line,
    hint: `try one of: ${[...allowed].sort().join(", ")}.`,
  };
}

/**
 * Read one asset's resolved options as `prep` options.
 *
 * `line` is the Demakefile's, for a diagnostic that can be pointed at. `use` is
 * recognised and skipped: substituting a different source file is the *edge's*
 * job — it decides which bytes to load — and by the time these reach `prep` the
 * bytes have already been chosen.
 */
export function artOverrides(
  resolved: Readonly<Record<string, string>>,
  line = 1,
  consoleId?: string,
): ArtOverride {
  const options: Partial<PrepOptions> = {};
  const diagnostics: Diagnostic[] = [];
  // A console's portfolio is a console's own, so a strategy can only be checked
  // where the target is known. Without one it passes through and `prep` reports
  // it — better than a converter that guessed at the list.
  const names = consoleId === undefined ? undefined : strategies(consoleId).map((one) => one.id);

  for (const [name, value] of Object.entries(resolved)) {
    if (name === "use") continue;
    if (!ART_OPTIONS.has(name)) {
      diagnostics.push({
        severity: "error",
        code: "E_UNKNOWN_OPTION",
        message: `'${name}' is not an option an art block may set`,
        line,
        hint: `art blocks take: ${[...ART_OPTIONS].sort().join(", ")}.`,
      });
      continue;
    }
    switch (name) {
      case "strategy": {
        // `auto` is the absence of a choice, which is what `prep` does by default.
        if (value === "auto") break;
        if (names !== undefined && !names.includes(value)) {
          diagnostics.push(bad(name, value, names, line));
        } else options.strategy = value;
        break;
      }
      case "dither": {
        const [alg, strength] = value.split(":");
        if (!(DITHER_ALGS as readonly string[]).includes(alg ?? "")) {
          diagnostics.push(bad(name, value, DITHER_ALGS, line));
          break;
        }
        const amount = strength === undefined ? undefined : Number(strength);
        if (amount !== undefined && !(Number.isFinite(amount) && amount >= 0 && amount <= 100)) {
          diagnostics.push({
            severity: "error",
            code: "E_BAD_OPTION",
            message: `dither strength '${strength ?? ""}' is not between 0 and 100`,
            line,
            hint: "write it as `bayer4:50`, exactly as `--dither` takes it.",
          });
          break;
        }
        options.dither = {
          alg: alg as (typeof DITHER_ALGS)[number],
          ...(amount === undefined ? {} : { strength: amount }),
        };
        break;
      }
      case "scale": {
        if (!(SCALE_KERNELS as readonly string[]).includes(value)) {
          diagnostics.push(bad(name, value, SCALE_KERNELS, line));
        } else options.scale = value as (typeof SCALE_KERNELS)[number];
        break;
      }
      case "effort": {
        if (!(EFFORTS as readonly string[]).includes(value)) {
          diagnostics.push(bad(name, value, EFFORTS, line));
        } else options.effort = value as (typeof EFFORTS)[number];
        break;
      }
      case "metric": {
        if (!(METRICS as readonly string[]).includes(value)) {
          diagnostics.push(bad(name, value, METRICS, line));
        } else options.metric = value as (typeof METRICS)[number];
        break;
      }
      case "palette": {
        options.palette = value.split(",").map((one) => one.trim());
        break;
      }
      case "protect": {
        options.protect = value === "none" ? false : value.split(",").map((one) => one.trim());
        break;
      }
      default:
        break;
    }
  }
  return { options, diagnostics };
}

/**
 * Merge a build file's overrides under the build's own decisions.
 *
 * The order is the point: the overrides go in *first* and the build's options
 * on top, so `size`, `fit`, `maxTiles`, `maxSubPalettes` and `console` cannot be
 * displaced even if something upstream let them through. A file may change how a
 * picture is fitted; it may not change what it is being fitted into.
 */
export function applyArtOverrides(
  own: PrepOptions,
  overrides: Partial<PrepOptions> | undefined,
): PrepOptions {
  return overrides === undefined ? own : { ...overrides, ...own };
}
