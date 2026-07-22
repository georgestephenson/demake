/**
 * The single source of truth for the demake CLI (doc 05 §Single source of
 * truth).
 *
 * One typed definition of every command, flag, type, default, and example. From
 * this we generate the runtime argument parser, `--help` text, and roff man
 * pages — so docs and behavior can never drift (a CI check regenerates and fails
 * on diff). Shell completions and the `help --json` schema derive from the same
 * data.
 *
 * This module is pure data + types (no I/O), so it is safe to import from core-
 * adjacent tooling and to snapshot in tests.
 */

/** The value type a flag parses into. */
export type FlagType =
  "string" | "boolean" | "int" | "enum" | "size" | "color" | "colorlist" | "count";

/** One command-line flag. */
export interface FlagSpec {
  /** Long name without dashes, e.g. `console`. */
  name: string;
  /** Optional single-character short alias, e.g. `c`. */
  short?: string;
  type: FlagType;
  /** Allowed values for `enum` flags. */
  values?: readonly string[];
  /** Default value (shown in help/man). */
  default?: string | number | boolean;
  required?: boolean;
  /** Placeholder shown in usage, e.g. `<id>` or `WxH`. */
  metavar?: string;
  help: string;
}

/** A positional argument. */
export interface PositionalSpec {
  name: string;
  help: string;
  optional?: boolean;
}

/** A worked example for help/man. */
export interface ExampleSpec {
  cmd: string;
  note?: string;
}

/** One subcommand. */
export interface CommandSpec {
  name: string;
  summary: string;
  positional?: PositionalSpec;
  flags: readonly FlagSpec[];
  examples: readonly ExampleSpec[];
  /** Marked when the command is advertised but not yet implemented. */
  planned?: boolean;
}

/** An enumerated, stable exit code (doc 05 §Exit codes). */
export interface ExitCodeSpec {
  code: number;
  name: string;
  help: string;
}

/** The whole CLI. */
export interface CliSpec {
  name: string;
  tagline: string;
  globalFlags: readonly FlagSpec[];
  commands: readonly CommandSpec[];
  exitCodes: readonly ExitCodeSpec[];
}

const OUTPUT_FLAGS: readonly FlagSpec[] = [
  {
    name: "output",
    short: "o",
    type: "string",
    metavar: "<file>",
    help: "Write the artifact to <file> (default: stdout when piped).",
  },
  {
    name: "json",
    type: "boolean",
    help: "Emit a single JSON object on stdout (product goes to -o).",
  },
  { name: "verbose", short: "v", type: "count", help: "Increase diagnostic detail (repeatable)." },
  { name: "quiet", short: "q", type: "boolean", help: "Suppress warnings." },
  { name: "force", short: "f", type: "boolean", help: "Overwrite an existing output file." },
];

const PREP_FLAGS: readonly FlagSpec[] = [
  {
    name: "console",
    short: "c",
    type: "string",
    required: true,
    metavar: "<id>",
    help: "Target console id or alias (e.g. gbc, dmg).",
  },
  {
    name: "strategy",
    type: "string",
    default: "auto",
    metavar: "auto|<name>|list",
    help: "Tournament control: auto (default), a candidate name, or list.",
  },
  {
    name: "size",
    type: "size",
    metavar: "WxH",
    help: "Target size (omit for auto: keep dims or largest aspect-fit).",
  },
  {
    name: "fit",
    type: "enum",
    values: ["contain", "cover", "stretch", "pad"],
    default: "contain",
    help: "How to fit an explicit --size.",
  },
  {
    name: "scale",
    type: "enum",
    values: ["auto", "majority", "lanczos3", "box", "nearest"],
    default: "auto",
    help: "Downscale kernel.",
  },
  {
    name: "dither",
    type: "string",
    metavar: "<alg>[:strength]",
    help: "none/bayer2/4/8/floyd-steinberg/atkinson/riemersma/ramp[:0-100].",
  },
  {
    name: "profile",
    type: "enum",
    values: ["auto", "art", "photo"],
    default: "auto",
    help: "Force the source-analysis profile.",
  },
  {
    name: "effort",
    type: "enum",
    values: ["fast", "default", "max"],
    default: "default",
    help: "Optimizer budget (restarts / refinement).",
  },
  {
    name: "protect",
    type: "colorlist",
    metavar: "<colors>",
    help: "Comma-separated colors guaranteed to survive quantization.",
  },
  { name: "no-protect", type: "boolean", help: "Disable automatic highlight/outline protection." },
  {
    name: "metric",
    type: "enum",
    values: ["oklab", "wrgb"],
    default: "oklab",
    help: "Perceptual metric (wrgb is planned).",
  },
  {
    name: "seed",
    type: "int",
    metavar: "N",
    help: "PRNG seed for reproducible restarts (default fixed).",
  },
  {
    name: "background",
    type: "color",
    metavar: "<color>",
    default: "#000000",
    help: "Matte color for compositing transparency.",
  },
  {
    name: "raw-colors",
    type: "boolean",
    help: "Store naive-expansion colors instead of DAC-decoded.",
  },
  { name: "strict", type: "boolean", help: "Fail rather than degrade (no tile merging)." },
  {
    name: "preview",
    type: "string",
    metavar: "<file>[@N]",
    help: "Also write an N× nearest-neighbor preview PNG.",
  },
  {
    name: "emit-manifest",
    type: "string",
    metavar: "[path]",
    help: "Write a sidecar JSON of palettes/assignments/provenance.",
  },
  ...OUTPUT_FLAGS,
];

const GEN_FLAGS: readonly FlagSpec[] = [
  {
    name: "console",
    short: "c",
    type: "string",
    required: true,
    metavar: "<id>",
    help: "Target console id or alias (e.g. gbc, dmg).",
  },
  {
    name: "format",
    type: "enum",
    values: ["bin", "asm", "c", "rom"],
    default: "asm",
    help: "Output format: raw blobs, assembler source, C arrays, or ROM.",
  },
  {
    name: "symbol",
    type: "string",
    metavar: "<name>",
    help: "Identifier/label prefix for asm/c (default: from the input name).",
  },
  {
    name: "manifest",
    type: "string",
    metavar: "<file>",
    help: "Pin palette order from a prep --emit-manifest sidecar.",
  },
  {
    name: "strict",
    type: "boolean",
    help: "Require already-compliant input; do not implicitly prep.",
  },
  {
    name: "tile-base",
    type: "int",
    metavar: "N",
    default: 0,
    help: "Add N to every emitted map tile index (VRAM tile offset).",
  },
  {
    name: "map-base",
    type: "int",
    metavar: "N",
    default: 0,
    help: "Map origin offset (recorded in the header; used by the ROM harness).",
  },
  ...OUTPUT_FLAGS,
];

const INSPECT_FLAGS: readonly FlagSpec[] = [
  {
    name: "console",
    short: "c",
    type: "string",
    metavar: "<id>",
    help: "Check compliance for one console (default: all).",
  },
  {
    name: "source",
    short: "s",
    type: "string",
    metavar: "<file>",
    help: "Also judge fidelity metrics vs this source image.",
  },
  { name: "json", type: "boolean", help: "Emit a single JSON object on stdout." },
  { name: "verbose", short: "v", type: "count", help: "Increase diagnostic detail (repeatable)." },
];

const CONSOLES_FLAGS: readonly FlagSpec[] = [
  { name: "json", type: "boolean", help: "Emit every ConsoleSpec as a single JSON object." },
];

/** The demake CLI specification. */
export const CLI_SPEC: CliSpec = {
  name: "demake",
  tagline: "hardware-compliant retro art & code from any image",
  globalFlags: [
    { name: "help", short: "h", type: "boolean", help: "Show help and exit." },
    { name: "version", short: "V", type: "boolean", help: "Print version and exit." },
  ],
  commands: [
    {
      name: "prep",
      summary: "Convert any image into a hardware-compliant image for a console",
      positional: { name: "input", help: "Source image (path, or - for stdin).", optional: true },
      flags: PREP_FLAGS,
      examples: [
        {
          cmd: "demake prep photo.jpg --console gbc -o portrait.png",
          note: "auto-sized GBC image",
        },
        { cmd: "demake prep art.png -c dmg --dither floyd-steinberg -o out.png" },
        { cmd: "demake prep photo.png -c gbc --strategy list", note: "see the candidates" },
        { cmd: "curl -s $URL | demake prep - -c gbc > out.png", note: "stdin → stdout filter" },
      ],
    },
    {
      name: "gen",
      summary: "Convert an image into console data/code (bin/asm/c)",
      positional: {
        name: "input",
        help: "Compliant or raw image (path, or - for stdin).",
        optional: true,
      },
      flags: GEN_FLAGS,
      examples: [
        {
          cmd: "demake gen portrait.png -c gbc --format asm -o portrait.asm",
          note: "RGBDS source",
        },
        {
          cmd: "demake gen photo.jpg -c gbc --format c -o gfx",
          note: "implicit prep, then C arrays",
        },
        { cmd: "demake gen tiles.png -c dmg --format bin -o tiles", note: "raw blobs for incbin" },
      ],
    },
    {
      name: "consoles",
      summary: "List supported consoles and their constraints",
      flags: CONSOLES_FLAGS,
      examples: [
        { cmd: "demake consoles" },
        { cmd: "demake consoles --json", note: "machine-readable ConsoleSpecs" },
      ],
    },
    {
      name: "inspect",
      summary: "Analyze an image: is it compliant, for which consoles, and why not",
      positional: {
        name: "input",
        help: "Image to analyze (path, or - for stdin).",
        optional: true,
      },
      flags: INSPECT_FLAGS,
      examples: [
        { cmd: "demake inspect out.png --json" },
        { cmd: "demake inspect out.png --source photo.jpg --json", note: "also score fidelity" },
      ],
    },
    {
      name: "completion",
      summary: "Emit shell completion (bash/zsh/fish)",
      positional: { name: "shell", help: "bash | zsh | fish", optional: true },
      flags: [],
      examples: [{ cmd: "demake completion bash > /etc/bash_completion.d/demake" }],
      planned: true,
    },
  ],
  exitCodes: [
    { code: 0, name: "OK", help: "Success." },
    { code: 1, name: "FAILURE", help: "A conversion ran but failed." },
    { code: 2, name: "USAGE", help: "Wrong flags or bad command line." },
    { code: 65, name: "BAD_INPUT", help: "Input data was malformed (EX_DATAERR)." },
    { code: 66, name: "NO_INPUT", help: "A required input was missing (EX_NOINPUT)." },
    { code: 69, name: "UNAVAILABLE", help: "A requested feature is not available yet." },
    { code: 70, name: "INTERNAL", help: "An internal invariant broke (EX_SOFTWARE)." },
    { code: 73, name: "CANNOT_CREATE", help: "The output could not be created (EX_CANTCREAT)." },
  ],
};

/** Look up a command spec by name. */
export function findCommand(name: string): CommandSpec | undefined {
  return CLI_SPEC.commands.find((c) => c.name === name);
}
