/**
 * The Demotic reference, generated from the language registry.
 *
 * Two renderings from one source: markdown for the repository and anywhere that
 * reads files, and the registry itself for the web app, which renders the same
 * data as components rather than parsing the markdown back. Neither is written
 * by hand, and a test fails if the checked-in markdown drifts from the registry
 * — the same bargain `pnpm gen:man` strikes with `cli-spec` (doc 05).
 */

import {
  BUTTONS,
  CONSTANTS,
  DIAGNOSTICS,
  EDGES_SPEC,
  FUNCTIONS,
  PROPERTIES,
  STATEMENTS,
  TRIGGERS,
  UNITS,
} from "../lang/spec.js";

/** One generated file. */
export interface ReferencePage {
  /** Filename, e.g. `properties.md`. */
  name: string;
  title: string;
  markdown: string;
}

const HEADER =
  "<!-- Generated from packages/demotic/src/lang/spec.ts. Do not edit by hand;\n" +
  "     run `pnpm gen:demotic-docs` after changing the registry. -->\n";

function page(name: string, title: string, body: string): ReferencePage {
  return { name, title, markdown: `${HEADER}\n# ${title}\n\n${body.trimEnd()}\n` };
}

/** Escape a cell so a pipe in a summary cannot break the table. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function notes(entries: readonly { name?: string; syntax?: string; note?: string }[]): string {
  const withNotes = entries.filter((entry) => entry.note);
  if (withNotes.length === 0) return "";
  return (
    "\n## Notes\n\n" +
    withNotes.map((entry) => `**\`${entry.name ?? entry.syntax}\`** — ${entry.note}`).join("\n\n") +
    "\n"
  );
}

function statementsPage(): ReferencePage {
  const body =
    "Case-insensitive throughout. `--` begins a comment. **One statement per line, no " +
    "nesting**, and declaration order does not matter.\n\n" +
    STATEMENTS.map(
      (statement) =>
        `## \`${statement.keyword}\`\n\n${statement.summary}\n\n` +
        `\`\`\`\n${statement.syntax}\n\`\`\`\n\n` +
        `\`\`\`\n${statement.example}\n\`\`\`\n` +
        (statement.note ? `\n${statement.note}\n` : ""),
    ).join("\n");
  return page("statements.md", "Statements", body);
}

function triggersPage(): ReferencePage {
  const table =
    "| Trigger | Timing | Meaning |\n|---|---|---|\n" +
    TRIGGERS.map(
      (trigger) =>
        `| \`${cell(trigger.syntax)}\` | ${trigger.timing} | ${cell(trigger.summary)} |`,
    ).join("\n");
  const examples = TRIGGERS.map((trigger) => `\`\`\`\n${trigger.example}\n\`\`\``).join("\n\n");
  return page(
    "triggers.md",
    "Rule triggers",
    "A `when` rule fires on an **edge** (once, when something happens) or at a " +
      "**level** (every tick something holds). Choosing wrongly is the most common source " +
      `of a bug that looks correct.\n\n${table}\n\n## Examples\n\n${examples}\n${notes(TRIGGERS)}`,
  );
}

function propertiesPage(): ReferencePage {
  const rows = PROPERTIES.filter((property) => !property.derived)
    .map((property) => {
      const dflt = property.default !== undefined ? `\`${property.default}\`` : "—";
      const flags = [property.quantised ? "whole cells" : "", property.createOnly ? "create-only" : ""]
        .filter(Boolean)
        .join(", ");
      return `| \`${property.name}\` | ${property.kind} | ${dflt} | ${cell(property.summary)} | ${flags || "—"} |`;
    })
    .join("\n");
  const derivedRows = PROPERTIES.filter((property) => property.derived)
    .map((property) => `| \`${property.name}\` | ${cell(property.summary)} |`)
    .join("\n");
  return page(
    "properties.md",
    "Properties",
    `## Assignable\n\n| Property | Kind | Default | Meaning | Notes |\n|---|---|---|---|---|\n${rows}\n\n` +
      "## Derived\n\nReadable, never assignable — assigning one is an error that names the " +
      `property to use instead.\n\n| Property | Value |\n|---|---|\n${derivedRows}\n${notes(PROPERTIES)}`,
  );
}

function expressionsPage(): ReferencePage {
  const units = UNITS.map(
    (unit) =>
      `| \`${unit.name}\`${unit.aliases ? ` / \`${unit.aliases.join("`, `")}\`` : ""} | ${cell(unit.summary)} |`,
  ).join("\n");
  const functions = FUNCTIONS.map(
    (fn) => `| \`${fn.signature}\` | ${cell(fn.summary)} |`,
  ).join("\n");
  const constants = CONSTANTS.map(
    (constant) => `| \`${constant.name}\` | ${cell(constant.summary)} |`,
  ).join("\n");
  return page(
    "expressions.md",
    "Expressions",
    "## Units\n\nAny numeric literal may carry a unit, attached (`15vw`) or spaced " +
      `(\`15 vw\`).\n\n| Unit | Resolves against |\n|---|---|\n${units}\n\n` +
      `## Functions\n\n| Signature | Meaning |\n|---|---|\n${functions}\n\n` +
      "## Constants\n\nResolved against the target console at compile time.\n\n" +
      `| Constant | Value |\n|---|---|\n${constants}\n`,
  );
}

function inputPage(): ReferencePage {
  const buttons = BUTTONS.map((button) => `| \`${button.name}\` | ${cell(button.summary)} |`).join(
    "\n",
  );
  const edges = EDGES_SPEC.map((edge) => `| \`${edge.name}\` | ${cell(edge.summary)} |`).join("\n");
  return page(
    "input.md",
    "Input and edges",
    "## Buttons\n\nThe portable set — the floor across every target console, which is why " +
      `it is this small.\n\n| Button | Meaning |\n|---|---|\n${buttons}\n\n` +
      "## Screen edges\n\nUsable anywhere an object can be, as a collision target.\n\n" +
      `| Edge | Meaning |\n|---|---|\n${edges}\n`,
  );
}

function diagnosticsPage(): ReferencePage {
  const render = (severity: "error" | "warning"): string =>
    DIAGNOSTICS.filter((diagnostic) => diagnostic.severity === severity)
      .map((diagnostic) => `| \`${diagnostic.code}\` | ${cell(diagnostic.summary)} |`)
      .join("\n");
  return page(
    "diagnostics.md",
    "Diagnostics",
    "Every one of these is a mistake the cell-and-tick model makes easy to write and hard " +
      "to see, caught from the numbers rather than left to be found in an emulator. All are " +
      "per-console, because all of them are properties of the target rather than of the " +
      "source: a 30-cell wall is fine on a NES and impossible on a Game Boy.\n\n" +
      `## Errors\n\n| Code | Meaning |\n|---|---|\n${render("error")}\n\n` +
      `## Warnings\n\n| Code | Meaning |\n|---|---|\n${render("warning")}\n`,
  );
}

/** Every generated page, in reading order. */
export function referencePages(): ReferencePage[] {
  return [
    statementsPage(),
    triggersPage(),
    propertiesPage(),
    expressionsPage(),
    inputPage(),
    diagnosticsPage(),
  ];
}

/** An index linking the pages, for the repository copy. */
export function referenceIndex(pages: readonly ReferencePage[]): ReferencePage {
  const list = pages.map((entry) => `- [${entry.title}](${entry.name})`).join("\n");
  return page(
    "README.md",
    "Demotic reference",
    "The language, generated from `packages/demotic/src/lang/spec.ts`.\n\n" +
      `${list}\n\nThe design rationale lives in [doc 14](../../../docs/14-demotic.md); this ` +
      "is the surface itself.\n",
  );
}
