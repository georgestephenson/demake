import { CORE_VERSION } from "@demake/core";

import { EXIT, type ExitCode } from "./exit-codes.js";
import { CLI_VERSION, PLANNED_COMMANDS } from "./meta.js";

/**
 * Output sink for a CLI run. Injecting the streams keeps {@link run} a pure,
 * synchronous function of its arguments — trivial to unit-test without spawning
 * a process or capturing global stdio.
 */
export interface Io {
  /** Write to standard output (the product stream). */
  out: (text: string) => void;
  /** Write to standard error (diagnostics only — never the product). */
  err: (text: string) => void;
}

const HELP = `demake — hardware-compliant retro art & code from any image

Usage:
  demake <command> [options] [input]

Commands (arriving in Phase 1 — not yet implemented):
  prep        Convert any image into a hardware-compliant image for a console
  gen         Convert an image into console data/code/ROM
  consoles    List supported consoles and their constraints
  inspect     Analyze an image: is it compliant, for which consoles, and why not
  completion  Emit shell completion (bash/zsh/fish)

Options:
  -h, --help     Show this help and exit
  -V, --version  Print version and exit

Examples (planned surface, see docs/05-cli-spec.md):
  demake prep photo.jpg --console gbc -o portrait.png
  demake gen out.png -c md --format c -o image.c
  demake consoles --json

This is a Phase 0 scaffold: only --help and --version are wired up so far.
`;

function versionLine(): string {
  return `demake ${CLI_VERSION} (core ${CORE_VERSION})`;
}

function isPlanned(command: string): boolean {
  return (PLANNED_COMMANDS as readonly string[]).includes(command);
}

/**
 * Execute the CLI against a pre-sliced argument vector (no `node`/script path).
 *
 * @param argv - Arguments, e.g. `["prep", "photo.jpg", "-c", "gbc"]`.
 * @param io - Where to send stdout/stderr text.
 * @returns The process exit code to use (see {@link EXIT}).
 */
export function run(argv: readonly string[], io: Io): ExitCode {
  // Absorb a single leading `--` end-of-options separator. This is what the
  // documented `pnpm cli -- <args>` workflow (doc 12) forwards to the binary.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const first = args[0];

  if (first === undefined || first === "-h" || first === "--help" || first === "help") {
    io.out(HELP);
    return EXIT.OK;
  }

  if (first === "-V" || first === "--version") {
    io.out(`${versionLine()}\n`);
    return EXIT.OK;
  }

  if (isPlanned(first)) {
    io.err(
      `demake: '${first}' is not available yet — the conversion engine lands in ` +
        `Phase 1.\nSee docs/13-roadmap.md for status.\n`,
    );
    return EXIT.UNAVAILABLE;
  }

  io.err(`demake: unknown command '${first}'\nRun 'demake --help' for usage.\n`);
  return EXIT.USAGE;
}
