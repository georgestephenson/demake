/**
 * The spec-driven argument parser (doc 05 §UNIX compliance checklist).
 *
 * Generated behavior from {@link CommandSpec}: GNU/POSIX conventions — short
 * `-c` / long `--console`, `--` end-of-options, bundled short flags, `=`-or-
 * space option values, repeatable `-v`. There is no hand-written flag handling
 * in the CLI; it calls this. Parsing errors are structured so the CLI can map
 * them to usage exit codes and JSON error output.
 */

import type { CommandSpec, FlagSpec } from "./spec.js";

/** A parsed value: string, number, boolean, size, or repeat count. */
export type ParsedValue = string | number | boolean | { w: number; h: number } | string[];

/** Successful parse output. */
export interface ParseResult {
  values: Record<string, ParsedValue>;
  positionals: string[];
}

/** A structured parse error (mapped to exit code 2 by the CLI). */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

function flagByLong(command: CommandSpec, name: string): FlagSpec | undefined {
  return command.flags.find((f) => f.name === name);
}

function flagByShort(command: CommandSpec, short: string): FlagSpec | undefined {
  return command.flags.find((f) => f.short === short);
}

function coerce(flag: FlagSpec, raw: string): ParsedValue {
  switch (flag.type) {
    case "int": {
      const n = Number(raw);
      if (!Number.isInteger(n)) {
        throw new ParseError(`--${flag.name} expects an integer, got '${raw}'`);
      }
      return n;
    }
    case "size": {
      const m = /^(\d+)[xX](\d+)$/.exec(raw);
      if (!m) {
        throw new ParseError(`--${flag.name} expects WxH, got '${raw}'`);
      }
      return { w: Number(m[1]), h: Number(m[2]) };
    }
    case "enum": {
      if (flag.values && !flag.values.includes(raw)) {
        throw new ParseError(`--${flag.name} must be one of: ${flag.values.join(", ")}`);
      }
      return raw;
    }
    case "colorlist":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    case "color":
    case "string":
      return raw;
    default:
      return raw;
  }
}

function needsValue(flag: FlagSpec): boolean {
  return flag.type !== "boolean" && flag.type !== "count";
}

/** Parse `argv` (already sliced past the command) against a command spec. */
export function parseCommand(command: CommandSpec, argv: readonly string[]): ParseResult {
  const values: Record<string, ParsedValue> = {};
  const positionals: string[] = [];
  let endOfOptions = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (endOfOptions) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (arg === "-") {
      positionals.push(arg); // explicit stdin
      continue;
    }
    if (arg.startsWith("--")) {
      i = handleLong(command, arg, argv, i, values);
    } else if (arg.startsWith("-") && arg.length > 1) {
      i = handleShortBundle(command, arg, argv, i, values);
    } else {
      positionals.push(arg);
    }
  }

  applyDefaults(command, values);
  return { values, positionals };
}

function handleLong(
  command: CommandSpec,
  arg: string,
  argv: readonly string[],
  i: number,
  values: Record<string, ParsedValue>,
): number {
  const eq = arg.indexOf("=");
  const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
  const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
  const flag = flagByLong(command, name);
  if (!flag) {
    throw new ParseError(`unknown option '--${name}'`);
  }
  if (!needsValue(flag)) {
    if (inlineValue !== undefined) {
      throw new ParseError(`option '--${name}' takes no value`);
    }
    setBooleanOrCount(flag, values);
    return i;
  }
  let value = inlineValue;
  if (value === undefined) {
    value = argv[i + 1];
    if (value === undefined) {
      throw new ParseError(`option '--${name}' requires a value`);
    }
    values[flag.name] = coerce(flag, value);
    return i + 1;
  }
  values[flag.name] = coerce(flag, value);
  return i;
}

function handleShortBundle(
  command: CommandSpec,
  arg: string,
  argv: readonly string[],
  i: number,
  values: Record<string, ParsedValue>,
): number {
  // e.g. -vqc gbc, -o out.png, -vv
  const chars = arg.slice(1);
  for (let k = 0; k < chars.length; k += 1) {
    const ch = chars[k]!;
    const flag = flagByShort(command, ch);
    if (!flag) {
      throw new ParseError(`unknown option '-${ch}'`);
    }
    if (!needsValue(flag)) {
      setBooleanOrCount(flag, values);
      continue;
    }
    // Value flag: rest of the bundle is the value, else the next argv.
    const rest = chars.slice(k + 1);
    if (rest.length > 0) {
      const raw = rest.startsWith("=") ? rest.slice(1) : rest;
      values[flag.name] = coerce(flag, raw);
      return i;
    }
    const next = argv[i + 1];
    if (next === undefined) {
      throw new ParseError(`option '-${ch}' requires a value`);
    }
    values[flag.name] = coerce(flag, next);
    return i + 1;
  }
  return i;
}

function setBooleanOrCount(flag: FlagSpec, values: Record<string, ParsedValue>): void {
  if (flag.type === "count") {
    values[flag.name] = ((values[flag.name] as number | undefined) ?? 0) + 1;
  } else {
    values[flag.name] = true;
  }
}

function applyDefaults(command: CommandSpec, values: Record<string, ParsedValue>): void {
  for (const flag of command.flags) {
    if (values[flag.name] === undefined && flag.default !== undefined) {
      values[flag.name] = flag.default;
    }
  }
}

/** Validate required flags are present; returns the list of missing names. */
export function missingRequired(
  command: CommandSpec,
  values: Record<string, ParsedValue>,
): string[] {
  return command.flags.filter((f) => f.required && values[f.name] === undefined).map((f) => f.name);
}
