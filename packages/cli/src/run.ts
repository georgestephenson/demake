/**
 * The CLI dispatcher (doc 05).
 *
 * Routes the argument vector to a command handler using the generated
 * {@link CLI_SPEC} and its parser — there is no hand-written flag handling here.
 * Global `--help`/`--version`, per-command `--help`, `help <cmd>`, unknown
 * commands, planned-but-unavailable commands, and parse/usage errors are all
 * mapped to the stable exit codes. Everything runs against an injectable
 * {@link CliEnv}, so the whole surface is unit-testable without a real process.
 */

import {
  commandHelp,
  findCommand,
  missingRequired,
  ParseError,
  parseCommand,
  topHelp,
} from "@demake/cli-spec";
import { CORE_VERSION } from "@demake/core";

import { runConsoles } from "./commands/consoles.js";
import { runGen } from "./commands/gen.js";
import { runInspect } from "./commands/inspect.js";
import { runPrep } from "./commands/prep.js";
import type { CliEnv } from "./env.js";
import { EXIT, type ExitCode } from "./exit-codes.js";
import { CliError, reportError } from "./io.js";
import { CLI_VERSION } from "./meta.js";

function versionLine(): string {
  return `demake ${CLI_VERSION} (core ${CORE_VERSION})`;
}

function hasHelpFlag(args: readonly string[]): boolean {
  return args.includes("-h") || args.includes("--help");
}

/** Execute the CLI against a pre-sliced argument vector. */
export async function run(argv: readonly string[], env: CliEnv): Promise<ExitCode> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const first = args[0];

  if (first === undefined || first === "-h" || first === "--help") {
    env.out(topHelp());
    return EXIT.OK;
  }
  if (first === "-V" || first === "--version") {
    env.out(`${versionLine()}\n`);
    return EXIT.OK;
  }
  if (first === "help") {
    const target = args[1] ? findCommand(args[1]) : undefined;
    env.out(target ? commandHelp(target) : topHelp());
    return EXIT.OK;
  }

  const command = findCommand(first);
  if (!command) {
    env.errOut(`demake: unknown command '${first}'\nRun 'demake --help' for usage.\n`);
    return EXIT.USAGE;
  }

  const rest = args.slice(1);
  if (hasHelpFlag(rest)) {
    env.out(commandHelp(command));
    return EXIT.OK;
  }
  if (command.planned) {
    env.errOut(
      `demake: '${command.name}' is not available yet — it lands in a later phase.\n` +
        `See docs/13-roadmap.md for status.\n`,
    );
    return EXIT.UNAVAILABLE;
  }

  const json = rest.includes("--json");
  try {
    const parsed = parseCommand(command, rest);
    const missing = missingRequired(command, parsed.values);
    if (missing.length > 0) {
      throw new CliError(
        EXIT.USAGE,
        "E_MISSING_OPTION",
        `missing required option(s): ${missing.map((m) => `--${m}`).join(", ")}`,
        `run 'demake ${command.name} --help' for usage.`,
      );
    }
    switch (command.name) {
      case "consoles":
        return runConsoles(env, parsed.values.json === true);
      case "inspect":
        return runInspect(env, parsed.values, parsed.positionals);
      case "prep":
        return await runPrep(env, parsed.values, parsed.positionals);
      case "gen":
        return await runGen(env, parsed.values, parsed.positionals);
      default:
        env.errOut(`demake: '${command.name}' is not implemented.\n`);
        return EXIT.UNAVAILABLE;
    }
  } catch (error) {
    if (error instanceof ParseError) {
      env.errOut(`demake: ${error.message}\nRun 'demake ${command.name} --help' for usage.\n`);
      return EXIT.USAGE;
    }
    return reportError(env, error, json);
  }
}
