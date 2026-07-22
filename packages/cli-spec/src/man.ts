/**
 * roff man-page generation (doc 05 §Single source of truth item 3).
 *
 * Man pages are generated, never hand-edited: `demake(1)`, `demake-prep(1)`,
 * `demake-consoles(1)`, `demake-inspect(1)`. The CLI's build writes these into
 * `packages/cli/man/` and a CI check fails on drift from this generator. The
 * output is deterministic — no dates or version stamps — so the checked-in files
 * change only when the spec does.
 */

import { CLI_SPEC, type CommandSpec, type FlagSpec } from "./spec.js";

/** A generated man page: filename + roff content. */
export interface ManPage {
  filename: string;
  content: string;
}

function esc(text: string): string {
  // Escape roff control characters: leading dots and backslashes/hyphens.
  return text.replace(/\\/g, "\\\\").replace(/-/g, "\\-");
}

function header(name: string, section: number, title: string): string {
  // No date argument → deterministic output.
  return `.TH ${name.toUpperCase().replace(/-/g, "\\-")} ${section} "" "" "${esc(title)}"`;
}

function flagRoff(flag: FlagSpec): string {
  const names = flag.short
    ? `\\fB\\-${flag.short}\\fR, \\fB\\-\\-${flag.name}\\fR`
    : `\\fB\\-\\-${flag.name}\\fR`;
  const value =
    flag.type === "boolean" || flag.type === "count"
      ? ""
      : ` \\fI${esc(flag.metavar ?? "value")}\\fR`;
  let help = esc(flag.help);
  if (flag.default !== undefined && flag.type !== "boolean" && flag.type !== "count") {
    help += ` (default: ${esc(String(flag.default))})`;
  }
  if (flag.required) help += " [required]";
  return `.TP\n${names}${value}\n${help}`;
}

/** Generate the man page for one subcommand. */
export function commandMan(command: CommandSpec): ManPage {
  const cmdName = `${CLI_SPEC.name}-${command.name}`;
  const positional = command.positional ? ` [\\fI${esc(command.positional.name)}\\fR]` : "";
  const flags = command.flags.map(flagRoff).join("\n");
  const examples = command.examples
    .map((e) => `.PP\n${esc(e.cmd)}${e.note ? `\n.br\n${esc(e.note)}` : ""}`)
    .join("\n");
  const content = `${header(cmdName, 1, command.summary)}
.SH NAME
${cmdName} \\- ${esc(command.summary)}
.SH SYNOPSIS
\\fB${CLI_SPEC.name} ${command.name}\\fR [\\fIoptions\\fR]${positional}
.SH DESCRIPTION
${esc(command.summary)}.${command.planned ? " This command is planned and not yet implemented." : ""}
.SH OPTIONS
${flags}
.SH EXAMPLES
${examples}
.SH SEE ALSO
\\fB${CLI_SPEC.name}\\fR(1)
`;
  return { filename: `${cmdName}.1`, content };
}

/** Generate the top-level `demake(1)` page. */
export function topMan(): ManPage {
  const commands = CLI_SPEC.commands
    .map((c) => `.TP\n\\fB${c.name}\\fR\n${esc(c.summary)}${c.planned ? " (planned)" : ""}`)
    .join("\n");
  const exit = CLI_SPEC.exitCodes.map((e) => `.TP\n\\fB${e.code}\\fR\n${esc(e.help)}`).join("\n");
  const globals = CLI_SPEC.globalFlags.map(flagRoff).join("\n");
  const content = `${header(CLI_SPEC.name, 1, CLI_SPEC.tagline)}
.SH NAME
${CLI_SPEC.name} \\- ${esc(CLI_SPEC.tagline)}
.SH SYNOPSIS
\\fB${CLI_SPEC.name}\\fR \\fIcommand\\fR [\\fIoptions\\fR] [\\fIinput\\fR]
.SH DESCRIPTION
${esc(CLI_SPEC.name)} converts arbitrary images into hardware\\-compliant art and code for retro consoles.
.SH COMMANDS
${commands}
.SH OPTIONS
${globals}
.SH EXIT STATUS
${exit}
.SH SEE ALSO
${CLI_SPEC.commands
  .filter((c) => !c.planned)
  .map((c) => `\\fB${CLI_SPEC.name}-${c.name}\\fR(1)`)
  .join(", ")}
`;
  return { filename: `${CLI_SPEC.name}.1`, content };
}

/** Generate every man page (top-level + each non-planned command). */
export function allManPages(): ManPage[] {
  const pages = [topMan()];
  for (const command of CLI_SPEC.commands) {
    if (!command.planned) {
      pages.push(commandMan(command));
    }
  }
  return pages;
}
