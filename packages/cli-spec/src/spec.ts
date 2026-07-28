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
  "string" | "boolean" | "int" | "enum" | "size" | "color" | "colorlist" | "list" | "count";

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

/**
 * How many candidates a tournament may fit at once (doc 04 §Running the
 * tournament).
 *
 * On the commands that run one — everything that fits an image or a sound. It is
 * a speed control and nothing else: the winner is decided in portfolio order
 * whatever ran where, so `--jobs 1` and `--jobs 16` write the same file. That is
 * exactly why it can be a flag rather than a decision, and why `--json` does not
 * report it: it is not part of what was produced.
 */
const PARALLEL_FLAGS: readonly FlagSpec[] = [
  {
    name: "jobs",
    short: "j",
    type: "string",
    metavar: "<n>",
    default: "auto",
    help: "Candidates to fit at once: a number, or auto for one per core.",
  },
];

const PREP_FLAGS: readonly FlagSpec[] = [
  ...PARALLEL_FLAGS,
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
    help: "Force raw lattice-expansion colors (the default on panel-filter consoles like GBC).",
  },
  {
    name: "dac-colors",
    type: "boolean",
    help: "Store DAC-simulated display colors (hardware screen preview) instead of raw.",
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
  ...PARALLEL_FLAGS,
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

const BUILD_FLAGS: readonly FlagSpec[] = [
  ...PARALLEL_FLAGS,
  {
    name: "console",
    short: "c",
    type: "string",
    default: "gb",
    metavar: "<id>",
    help: "Target console (a backend must exist; today: gb, gbc, nes, sms, gg, snes).",
  },
  {
    name: "format",
    type: "enum",
    values: ["rom", "sym"],
    default: "rom",
    help: "Output a playable ROM, or the symbol map for profiling.",
  },
  {
    name: "title",
    type: "string",
    metavar: "<text>",
    help: "Cartridge title (default: the source file's name).",
  },
  {
    name: "boot-logo",
    type: "boolean",
    help: "Stamp the boot logo via rgbfix, so the ROM boots on real hardware.",
  },
  ...OUTPUT_FLAGS,
];

/**
 * Flags the audio demakers share (docs 16, 17, 18).
 *
 * `--preview-format` is the one worth reading twice: `wav` is sample-exact and
 * carries the doc-16 guarantee that the file sounds like the cartridge, and the
 * lossy formats cannot, so they say so in `--json` rather than being quietly
 * treated as equivalent.
 */
const AUDIO_COMMON_FLAGS: readonly FlagSpec[] = [
  {
    name: "console",
    short: "c",
    type: "string",
    required: true,
    metavar: "<id>",
    help: "Target console id or alias (e.g. gb, nes, sms).",
  },
  {
    name: "preview",
    type: "string",
    metavar: "<file>",
    help: "Also write a playable audio file of the exact result.",
  },
  {
    name: "preview-format",
    type: "enum",
    values: ["wav"],
    default: "wav",
    help: "Preview encoding. WAV is sample-exact; lossy formats land with their encoders.",
  },
  {
    name: "output-stage",
    type: "enum",
    values: ["raw", "board"],
    default: "raw",
    help: "Raw chip output, or the console's analog stage simulated.",
  },
  {
    name: "effort",
    type: "enum",
    values: ["fast", "default", "max"],
    default: "default",
    help: "Search budget: one candidate, a pruned portfolio, or the full one.",
  },
  {
    name: "strategy",
    type: "string",
    default: "auto",
    metavar: "auto|<name>|list",
    help: "Tournament control: auto (default), a candidate name, or list.",
  },
  { name: "strict", type: "boolean", help: "Fail rather than degrade." },
  {
    name: "emit-manifest",
    type: "string",
    metavar: "[path]",
    help: "Also write the sidecar JSON: channel plan, timing, budgets, provenance.",
  },
];

const ARRANGE_FLAGS: readonly FlagSpec[] = [
  ...AUDIO_COMMON_FLAGS,
  {
    name: "bpm",
    type: "int",
    metavar: "<n>",
    help: "Override the detected tempo.",
  },
  {
    name: "tempo",
    type: "enum",
    values: ["exact", "snap"],
    default: "exact",
    help: "Hold the source tempo, or let the bounded tempo grade pick a cheaper grid.",
  },
  {
    name: "role",
    type: "list",
    metavar: "<part>=<role>",
    help: "Override a part's role (percussion|bass|lead|harmony|pad|arp|fx); repeatable.",
  },
  {
    name: "drop",
    type: "list",
    metavar: "<part>",
    help: "Exclude a part outright; repeatable.",
  },
  {
    name: "channels",
    type: "int",
    metavar: "<n>",
    help: "Cap the channels used; the rest stay silent.",
  },
  {
    name: "reserve",
    type: "list",
    metavar: "<channel>",
    help: "Keep a channel free for sound effects; repeatable.",
  },
  { name: "title", type: "string", metavar: "<text>", help: "Track title, stored in the file." },
  ...OUTPUT_FLAGS,
];

const SFX_FLAGS: readonly FlagSpec[] = [
  ...AUDIO_COMMON_FLAGS,
  ...PARALLEL_FLAGS,
  {
    name: "max-length",
    type: "string",
    metavar: "<seconds>",
    default: "5",
    help: "The effect's length budget (doc 18 §The five-second rule).",
  },
  { name: "title", type: "string", metavar: "<text>", help: "Effect name, stored in the file." },
  ...OUTPUT_FLAGS,
];

const RENDER_FLAGS: readonly FlagSpec[] = [
  {
    name: "output-stage",
    type: "enum",
    values: ["raw", "board"],
    default: "raw",
    help: "Raw chip output, or the console's analog stage simulated.",
  },
  {
    name: "sample-rate",
    type: "int",
    default: 48000,
    metavar: "<hz>",
    help: "Delivery rate; 48000 unless you have a reason.",
  },
  {
    name: "loops",
    type: "int",
    default: 0,
    metavar: "<n>",
    help: "Repeat from the loop point this many extra times.",
  },
  ...OUTPUT_FLAGS,
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
      summary: "Convert an image or a chip schedule into console data/code",
      positional: {
        name: "input",
        help: "Compliant or raw image, or an arrange/sfx schedule manifest (path, or - for stdin).",
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
        {
          cmd: "demake gen song.json -c dmg --format rom -o song.gb",
          note: "a cartridge that plays the track",
        },
      ],
    },
    {
      name: "build",
      summary: "Build a Demotic game (.dmt) into a playable ROM",
      positional: {
        name: "input",
        help: "Demotic source (path, or - for stdin).",
        optional: true,
      },
      flags: BUILD_FLAGS,
      examples: [
        { cmd: "demake build pong.dmt -o pong.gb", note: "a playable Game Boy cartridge" },
        { cmd: "demake build pong.dmt --title PONG --json", note: "report what went in it" },
        {
          cmd: "demake build pong.dmt --format sym -o pong.sym",
          note: "symbols, for a cycle profile",
        },
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
      name: "arrange",
      summary: "Convert any track into hardware-compliant chip music",
      positional: {
        name: "input",
        help: "MIDI file (path, or - for stdin).",
        optional: true,
      },
      flags: ARRANGE_FLAGS,
      examples: [
        {
          cmd: "demake arrange song.mid -c gb -o song.vgm --preview song.wav",
          note: "chip music, plus audio that is exactly what the cartridge plays",
        },
        {
          cmd: "demake arrange track.mid -c nes --bpm 128 --role 3=bass",
          note: "pin the tempo, correct a role",
        },
        {
          cmd: "demake arrange song.mid -c sms --json",
          note: "channel plan, timing, drops, scoreboard",
        },
      ],
    },
    {
      name: "sfx",
      summary: "Convert any sound into a hardware-compliant chip sound effect",
      positional: {
        name: "input",
        help: "WAV file (path, or - for stdin).",
        optional: true,
      },
      flags: SFX_FLAGS,
      examples: [
        { cmd: "demake sfx coin.wav -c gb --max-length 1.5 -o coin.vgm" },
        { cmd: "demake sfx explosion.wav -c nes --preview boom.wav" },
      ],
    },
    {
      name: "render",
      summary: "Render a compliant audio artifact to a playable audio file",
      positional: {
        name: "input",
        help: "Chip audio artifact (path, or - for stdin).",
        optional: true,
      },
      flags: RENDER_FLAGS,
      examples: [
        { cmd: "demake render song.vgm -o song.wav", note: "hear it as the hardware plays it" },
        { cmd: "demake render song.vgm --loops 2 -o song.wav" },
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
