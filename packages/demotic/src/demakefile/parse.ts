/**
 * Reading a Demakefile (doc 15 §Format).
 *
 * Indentation-significant and block-structured, with the Make footgun disarmed:
 * a file mixing tabs and spaces is an error naming both offending lines rather
 * than a file that means something different from how it looks. Otherwise the
 * rules are the ones doc 15 states — `key value…` with the last field absorbing
 * the rest of the line, `#` comments, optional quotes, case-insensitive directive
 * names and literal values.
 *
 * One pass reports every problem, the way the Demotic front end does: a bad
 * directive does not hide the six after it.
 */

import type { Diagnostic } from "../errors.js";
import {
  BLOCK_DIRECTIVES,
  DOMAINS,
  SINGLE_DIRECTIVES,
  type AssetBlock,
  type Demakefile,
  type Domain,
  type Option,
  type Output,
  type Target,
} from "./model.js";

/** What one physical line turned out to be. */
interface Line {
  /** Indentation depth in units, or -1 for a comment or blank line. */
  depth: number;
  /** The line's words: the directive and its fields. */
  words: string[];
  /** The rest of the line after the first word, trimmed — the absorbing field. */
  rest: string;
  raw: string;
  line: number;
}

/** The grammar's own word lists, shared with the highlighter (`model.ts`). */
const SINGLE = SINGLE_DIRECTIVES;
const BLOCKS = BLOCK_DIRECTIVES;

/**
 * Strip a trailing comment, honouring doc 15's ` # ` rule.
 *
 * Exported because the highlighter has to make the *same* call about where a
 * comment starts. A second rule there is a file coloured differently from how it
 * is read, which is the failure `lang/highlight.ts` running on `lex()` exists to
 * prevent one format up.
 */
export function uncomment(text: string): string {
  if (text.trimStart().startsWith("#")) return "";
  const at = text.indexOf(" #");
  return at < 0 ? text : text.slice(0, at);
}

/** Split a line into words, treating a double-quoted run as one. */
function words(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    while (at < text.length && /\s/.test(text[at] as string)) at += 1;
    if (at >= text.length) break;
    if (text[at] === '"') {
      const close = text.indexOf('"', at + 1);
      if (close < 0) {
        out.push(text.slice(at + 1));
        break;
      }
      out.push(text.slice(at + 1, close));
      at = close + 1;
      continue;
    }
    let end = at;
    while (end < text.length && !/\s/.test(text[end] as string)) end += 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/** Everything after the first word, with quotes on a single trailing field removed. */
function absorbed(text: string): string {
  const trimmed = text.trim();
  const space = trimmed.search(/\s/);
  if (space < 0) return "";
  const rest = trimmed.slice(space).trim();
  return rest.startsWith('"') && rest.endsWith('"') && rest.length > 1 ? rest.slice(1, -1) : rest;
}

/** Parse a Demakefile's text into a model plus every diagnostic it earned. */
export function parseDemakefile(text: string): Demakefile & { diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fail = (line: number, code: string, message: string, hint?: string): void => {
    diagnostics.push({
      severity: "error",
      code,
      message,
      line,
      ...(hint === undefined ? {} : { hint }),
    });
  };

  // --- indentation, decided once for the whole file ------------------------
  const rawLines = text.split("\n");
  let unit = 0; // spaces per level; 0 until an indented line says
  let tabs: number | undefined;
  let spaces: number | undefined;
  for (const [index, raw] of rawLines.entries()) {
    const stripped = uncomment(raw);
    if (stripped.trim() === "") continue;
    const lead = /^[\t ]*/.exec(stripped)?.[0] ?? "";
    if (lead.includes("\t")) tabs ??= index + 1;
    if (lead.includes(" ")) spaces ??= index + 1;
    if (unit === 0 && lead.startsWith(" ")) unit = lead.length;
  }
  if (tabs !== undefined && spaces !== undefined) {
    fail(
      Math.min(tabs, spaces),
      "E_MIXED_INDENT",
      `this file indents with tabs (line ${String(tabs)}) and with spaces (line ${String(spaces)})`,
      "pick one; `demake fmt` writes two spaces per level.",
    );
  }
  if (unit === 0) unit = 2;

  const lines: Line[] = [];
  const pending: string[] = [];
  const structural: Line[] = [];
  for (const [index, raw] of rawLines.entries()) {
    const number = index + 1;
    const stripped = uncomment(raw);
    if (stripped.trim() === "") {
      // A comment or a blank line belongs to whatever comes next.
      if (index < rawLines.length - 1 || raw.trim() !== "") pending.push(raw);
      continue;
    }
    const lead = /^[\t ]*/.exec(stripped)?.[0] ?? "";
    const columns = lead.replace(/\t/g, " ".repeat(unit)).length;
    if (columns % unit !== 0) {
      fail(
        number,
        "E_BAD_INDENT",
        `line ${String(number)} is indented ${String(columns)} spaces, which is not a multiple of ${String(unit)}`,
        `this file's unit is ${String(unit)} spaces.`,
      );
    }
    const parsed: Line = {
      depth: Math.floor(columns / unit),
      words: words(stripped.trim()),
      rest: absorbed(stripped),
      raw,
      line: number,
    };
    if (pending.length > 0) {
      (parsed as { leading?: readonly string[] }).leading = [...pending];
      pending.length = 0;
    }
    lines.push(parsed);
    structural.push(parsed);
  }
  const trailing = pending.length > 0 ? [...pending] : undefined;

  // --- the model ----------------------------------------------------------
  const file: {
    project?: Demakefile["project"];
    source?: Option;
    assets: Option[];
    out?: Option;
    defaults: Partial<Record<Domain, Option[]>>;
    defaultsOrder: Domain[];
    defaultsLeading?: readonly string[];
    targets: Target[];
    assetBlocks: AssetBlock[];
  } = { assets: [], defaults: {}, defaultsOrder: [], targets: [], assetBlocks: [] };

  const seen = new Map<string, number>();
  const once = (key: string, line: number): boolean => {
    const first = seen.get(key);
    if (first !== undefined) {
      fail(
        line,
        "E_DUPLICATE_DIRECTIVE",
        `'${key}' is set twice, on lines ${String(first)} and ${String(line)}`,
        "this directive takes one value.",
      );
      return false;
    }
    seen.set(key, line);
    return true;
  };

  const option = (l: Line): Option => ({
    name: (l.words[0] as string).toLowerCase(),
    value: l.rest,
    ...((l as { leading?: readonly string[] }).leading === undefined
      ? {}
      : { leading: (l as { leading?: readonly string[] }).leading as readonly string[] }),
    line: l.line,
  });

  let index = 0;
  /** Collect the lines indented under the current one. */
  const children = (depth: number): Line[] => {
    const out: Line[] = [];
    while (index < structural.length && (structural[index] as Line).depth > depth) {
      out.push(structural[index] as Line);
      index += 1;
    }
    return out;
  };

  while (index < structural.length) {
    const l = structural[index] as Line;
    index += 1;
    const keyword = (l.words[0] ?? "").toLowerCase();

    if (l.depth !== 0) {
      fail(
        l.line,
        "E_BAD_INDENT",
        `'${keyword}' is indented but nothing above it opens a block`,
        "a directive at the top level starts at column zero.",
      );
      continue;
    }

    if (SINGLE.has(keyword)) {
      if (l.words.length < 2) {
        fail(l.line, "E_ARITY", `'${keyword}' needs a value`, `write \`${keyword} <value>\`.`);
        continue;
      }
      if (keyword === "assets") file.assets.push(option(l));
      else if (once(keyword, l.line)) {
        if (keyword === "source") file.source = option(l);
        else file.out = option(l);
      }
      continue;
    }

    if (keyword === "targets") {
      if (l.words.length < 2) {
        fail(
          l.line,
          "E_ARITY",
          "'targets' needs at least one console",
          "e.g. `targets gb nes md`.",
        );
        continue;
      }
      for (const name of l.words.slice(1)) {
        file.targets.push({
          name: name.toLowerCase(),
          outputs: [],
          header: [],
          options: [],
          shorthand: true,
          ...((l as { leading?: readonly string[] }).leading === undefined
            ? {}
            : { leading: (l as { leading?: readonly string[] }).leading as readonly string[] }),
          line: l.line,
        });
      }
      continue;
    }

    if (!BLOCKS.has(keyword)) {
      fail(
        l.line,
        "E_UNKNOWN_DIRECTIVE",
        `no directive named '${keyword}'`,
        `known: ${[...SINGLE, "targets", ...BLOCKS].sort().join(", ")}.`,
      );
      children(l.depth);
      continue;
    }

    const body = children(l.depth);
    const leading = (l as { leading?: readonly string[] }).leading;

    if (keyword === "project") {
      if (!once("project", l.line)) continue;
      file.project = {
        name: l.words[1] ?? "",
        fields: body.filter((one) => one.depth === l.depth + 1).map(option),
        ...(leading === undefined ? {} : { leading }),
        line: l.line,
      };
      continue;
    }

    if (keyword === "defaults") {
      if (!once("defaults", l.line)) continue;
      if (leading !== undefined) file.defaultsLeading = leading;
      let at = 0;
      const bare: Option[] = [];
      while (at < body.length) {
        const child = body[at] as Line;
        at += 1;
        const name = (child.words[0] as string).toLowerCase();
        if ((DOMAINS as readonly string[]).includes(name) && child.words.length === 1) {
          const nested: Option[] = [];
          while (at < body.length && (body[at] as Line).depth > child.depth) {
            nested.push(option(body[at] as Line));
            at += 1;
          }
          const domain = name as Domain;
          file.defaults[domain] = [...(file.defaults[domain] ?? []), ...nested];
          if (!file.defaultsOrder.includes(domain)) file.defaultsOrder.push(domain);
          continue;
        }
        // Bare options under `defaults` are art's, because art was the only
        // domain when doc 15 was written (doc 19 §The Demakefile).
        bare.push(option(child));
      }
      if (bare.length > 0) {
        file.defaults.art = [...bare, ...(file.defaults.art ?? [])];
        if (!file.defaultsOrder.includes("art")) file.defaultsOrder.unshift("art");
      }
      continue;
    }

    if (keyword === "target") {
      const name = (l.words[1] ?? "").toLowerCase();
      if (name === "") {
        fail(l.line, "E_ARITY", "'target' needs a name", "e.g. `target gb`.");
        continue;
      }
      const target: {
        name: string;
        console?: string;
        region?: string;
        outputs: Output[];
        header: Option[];
        options: Option[];
        leading?: readonly string[];
        line: number;
      } = {
        name,
        outputs: [],
        header: [],
        options: [],
        ...(leading === undefined ? {} : { leading }),
        line: l.line,
      };
      let at = 0;
      while (at < body.length) {
        const child = body[at] as Line;
        at += 1;
        const field = (child.words[0] as string).toLowerCase();
        if (field === "console") target.console = child.rest.toLowerCase();
        else if (field === "region") target.region = child.rest.toLowerCase();
        else if (field === "output") {
          if (child.words.length < 3) {
            fail(
              child.line,
              "E_ARITY",
              "'output' needs a format and a path",
              "e.g. `output rom pong.gb`.",
            );
            continue;
          }
          target.outputs.push({
            format: (child.words[1] as string).toLowerCase(),
            path: child.words.slice(2).join(" "),
            line: child.line,
          });
        } else if (field === "header") {
          while (at < body.length && (body[at] as Line).depth > child.depth) {
            target.header.push(option(body[at] as Line));
            at += 1;
          }
        } else target.options.push(option(child));
      }
      // A repeated target refines the shorthand rather than conflicting with it
      // (doc 19 §A shorthand for the common case).
      const existing = file.targets.findIndex((one) => one.name === name);
      if (existing >= 0 && file.targets[existing]?.shorthand === true) {
        file.targets[existing] = target as Target;
      } else if (existing >= 0) {
        fail(
          l.line,
          "E_DUPLICATE_DIRECTIVE",
          `target '${name}' is declared twice, on lines ${String(file.targets[existing]?.line ?? 0)} and ${String(l.line)}`,
          "one block per target.",
        );
      } else file.targets.push(target as Target);
      continue;
    }

    // `art <name>`, `music <name>`, `sound <name>`
    const domain = keyword as Domain;
    const name = l.rest;
    if (name === "") {
      fail(l.line, "E_ARITY", `'${keyword}' needs an asset name`, `e.g. \`${keyword} ball\`.`);
      continue;
    }
    const block: {
      domain: Domain;
      name: string;
      options: Option[];
      per: { target: string; options: Option[]; line: number }[];
      leading?: readonly string[];
      line: number;
    } = {
      domain,
      name,
      options: [],
      per: [],
      ...(leading === undefined ? {} : { leading }),
      line: l.line,
    };
    let at = 0;
    while (at < body.length) {
      const child = body[at] as Line;
      at += 1;
      if ((child.words[0] as string).toLowerCase() === "for") {
        const target = child.rest.toLowerCase();
        const nested: Option[] = [];
        while (at < body.length && (body[at] as Line).depth > child.depth) {
          nested.push(option(body[at] as Line));
          at += 1;
        }
        block.per.push({ target, options: nested, line: child.line });
        continue;
      }
      block.options.push(option(child));
    }
    file.assetBlocks.push(block as AssetBlock);
  }

  // A `for` naming no declared target is doc 15's `E_UNKNOWN_TARGET`.
  const declared = new Set(file.targets.map((one) => one.name));
  for (const block of file.assetBlocks) {
    for (const per of block.per) {
      if (!declared.has(per.target)) {
        fail(
          per.line,
          "E_UNKNOWN_TARGET",
          `'for ${per.target}' names no declared target`,
          declared.size === 0
            ? "declare one with `targets <console>` or a `target` block."
            : `declared: ${[...declared].join(", ")}.`,
        );
      }
    }
  }

  return {
    ...(file.project === undefined ? {} : { project: file.project }),
    ...(file.source === undefined ? {} : { source: file.source }),
    assets: file.assets,
    ...(file.out === undefined ? {} : { out: file.out }),
    defaults: file.defaults,
    defaultsOrder: file.defaultsOrder,
    ...(file.defaultsLeading === undefined ? {} : { defaultsLeading: file.defaultsLeading }),
    targets: file.targets,
    assetBlocks: file.assetBlocks,
    ...(trailing === undefined ? {} : { trailing }),
    indent: unit,
    diagnostics,
  };
}
