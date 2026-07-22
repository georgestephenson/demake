/**
 * Public surface of `@demake/cli-spec` (doc 05 §Single source of truth).
 *
 * The typed CLI definition plus the generators that consume it (parser, help,
 * man pages). The CLI package imports the spec and parser at runtime; a
 * generate script uses the help/man generators to write checked-in artifacts.
 */

export {
  CLI_SPEC,
  findCommand,
  type CliSpec,
  type CommandSpec,
  type FlagSpec,
  type FlagType,
  type PositionalSpec,
  type ExampleSpec,
  type ExitCodeSpec,
} from "./spec.js";

export {
  parseCommand,
  missingRequired,
  ParseError,
  type ParseResult,
  type ParsedValue,
} from "./parser.js";

export { topHelp, commandHelp } from "./help.js";
export { allManPages, commandMan, topMan, type ManPage } from "./man.js";
