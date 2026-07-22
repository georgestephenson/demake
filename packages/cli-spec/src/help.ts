/**
 * `--help` text generation (doc 05 §Single source of truth item 2).
 *
 * Rendered from {@link CLI_SPEC}, wrapped to ≤ 100 columns, with examples — so
 * help can never drift from the parser or the man pages. Both the top-level
 * overview and per-command help come from the same data.
 */

import { CLI_SPEC, type CommandSpec, type FlagSpec } from "./spec.js";

function flagUsage(flag: FlagSpec): string {
  const head = flag.short ? `-${flag.short}, --${flag.name}` : `    --${flag.name}`;
  const value =
    flag.type === "boolean" || flag.type === "count" ? "" : ` ${flag.metavar ?? "<value>"}`;
  return `${head}${value}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function renderFlags(flags: readonly FlagSpec[]): string {
  const rows = flags.map((f) => ({ left: flagUsage(f), help: helpFor(f) }));
  const width = Math.min(34, Math.max(...rows.map((r) => r.left.length)) + 2);
  return rows.map((r) => `  ${pad(r.left, width)}${r.help}`).join("\n");
}

function helpFor(flag: FlagSpec): string {
  let suffix = "";
  if (flag.default !== undefined && flag.type !== "boolean" && flag.type !== "count") {
    suffix = ` (default: ${String(flag.default)})`;
  }
  if (flag.required) suffix += " [required]";
  return flag.help + suffix;
}

/** Top-level `demake --help`. */
export function topHelp(): string {
  const commands = CLI_SPEC.commands
    .map((c) => `  ${pad(c.name, 12)}${c.summary}${c.planned ? " (planned)" : ""}`)
    .join("\n");
  const globals = renderFlags(CLI_SPEC.globalFlags);
  return `${CLI_SPEC.name} — ${CLI_SPEC.tagline}

Usage:
  ${CLI_SPEC.name} <command> [options] [input]

Commands:
${commands}

Options:
${globals}

Run '${CLI_SPEC.name} <command> --help' for command-specific options.
`;
}

/** Per-command help, e.g. `demake prep --help`. */
export function commandHelp(command: CommandSpec): string {
  const positional = command.positional ? ` [${command.positional.name}]` : "";
  const flags = command.flags.length > 0 ? `\nOptions:\n${renderFlags(command.flags)}\n` : "";
  const examples =
    command.examples.length > 0
      ? `\nExamples:\n${command.examples
          .map((e) => `  ${e.cmd}${e.note ? `\n      # ${e.note}` : ""}`)
          .join("\n")}\n`
      : "";
  const planned = command.planned
    ? `\nNote: '${command.name}' is planned — not implemented in this build.\n`
    : "";
  return `${CLI_SPEC.name} ${command.name} — ${command.summary}

Usage:
  ${CLI_SPEC.name} ${command.name} [options]${positional}
${flags}${examples}${planned}`;
}
