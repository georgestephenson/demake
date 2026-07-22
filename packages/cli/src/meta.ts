/**
 * CLI version string.
 *
 * Phase 0 scaffold: a hand-maintained constant kept in sync with
 * `packages/cli/package.json`. Release tooling (doc 11) becomes the source of
 * truth in a later phase.
 */
export const CLI_VERSION = "0.0.0";

/**
 * Subcommands the finished CLI will expose (doc 05). They are advertised in
 * `--help` but not implemented in Phase 0; invoking one exits `UNAVAILABLE`
 * rather than pretending to work.
 */
export const PLANNED_COMMANDS = ["prep", "gen", "consoles", "inspect", "completion"] as const;
