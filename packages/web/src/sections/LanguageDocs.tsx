/**
 * The Demotic reference, rendered from the language registry.
 *
 * The same `lang/spec.ts` that drives the lexer, the compiler and the
 * markdown reference drives this page — rendered as components rather than by
 * parsing the generated markdown back, which keeps a markdown parser out of the
 * bundle and means the page cannot describe a feature the compiler does not
 * have (AGENTS.md §Iron rules).
 */

import { useState } from "preact/hooks";

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
} from "@demake/demotic";

type Topic = "statements" | "triggers" | "properties" | "expressions" | "input" | "diagnostics";

const TOPICS: readonly { id: Topic; label: string }[] = [
  { id: "statements", label: "Statements" },
  { id: "triggers", label: "Triggers" },
  { id: "properties", label: "Properties" },
  { id: "expressions", label: "Expressions" },
  { id: "input", label: "Input" },
  { id: "diagnostics", label: "Diagnostics" },
];

/**
 * Render a summary that may contain `code spans`, without a markdown parser.
 * The registry writes prose in backticks because that is what the markdown
 * rendering needs; splitting on them is enough to honour it here.
 */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text
        .split("`")
        .map((part, index) =>
          index % 2 === 1 ? <code key={index}>{part}</code> : <span key={index}>{part}</span>,
        )}
    </>
  );
}

function Table({ head, rows }: { head: readonly string[]; rows: readonly (string | null)[][] }) {
  return (
    <div class="doc-table-wrap">
      <table class="doc-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((value, j) => (
                <td key={j}>{value === null ? "—" : <Prose text={value} />}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Notes({ entries }: { entries: readonly { label: string; note?: string }[] }) {
  const withNotes = entries.filter((e) => e.note);
  if (withNotes.length === 0) return null;
  return (
    <>
      <h3>Notes</h3>
      {withNotes.map((entry) => (
        <p key={entry.label} class="doc-note">
          <code>{entry.label}</code> — <Prose text={entry.note as string} />
        </p>
      ))}
    </>
  );
}

function Body({ topic }: { topic: Topic }) {
  switch (topic) {
    case "statements":
      return (
        <>
          <p class="hint">
            Case-insensitive throughout. <code>--</code> begins a comment.{" "}
            <strong>One statement per line, no nesting</strong>, and declaration order does not
            matter — which is what buys per-line error recovery, so one pass reports every problem
            in a file.
          </p>
          {STATEMENTS.map((statement) => (
            <section key={statement.keyword} class="doc-entry">
              <h3>
                <code>{statement.keyword}</code>
              </h3>
              <p>
                <Prose text={statement.summary} />
              </p>
              <pre class="doc-syntax">{statement.syntax}</pre>
              <pre class="doc-example">{statement.example}</pre>
              {statement.note ? (
                <p class="doc-note">
                  <Prose text={statement.note} />
                </p>
              ) : null}
            </section>
          ))}
        </>
      );

    case "triggers":
      return (
        <>
          <p class="hint">
            A <code>when</code> rule fires on an <strong>edge</strong> (once, when something
            happens) or at a <strong>level</strong> (every tick something holds). Choosing wrongly
            is the most common source of a bug that looks correct.
          </p>
          <Table
            head={["Trigger", "Timing", "Meaning"]}
            rows={TRIGGERS.map((t) => [`\`${t.syntax}\``, t.timing, t.summary])}
          />
          {TRIGGERS.map((trigger) => (
            <pre key={trigger.syntax} class="doc-example">
              {trigger.example}
            </pre>
          ))}
          <Notes
            entries={TRIGGERS.map((t) => ({
              label: t.syntax,
              ...(t.note ? { note: t.note } : {}),
            }))}
          />
        </>
      );

    case "properties":
      return (
        <>
          <h3>Assignable</h3>
          <Table
            head={["Property", "Kind", "Default", "Meaning", "Notes"]}
            rows={PROPERTIES.filter((p) => !p.derived).map((p) => [
              `\`${p.name}\``,
              p.kind,
              p.default === undefined ? null : `\`${p.default}\``,
              p.summary,
              [p.quantised ? "whole cells" : "", p.createOnly ? "create-only" : ""]
                .filter(Boolean)
                .join(", ") || null,
            ])}
          />
          <h3>Derived</h3>
          <p class="hint">
            Readable, never assignable — assigning one is an error that names the property to use
            instead.
          </p>
          <Table
            head={["Property", "Value"]}
            rows={PROPERTIES.filter((p) => p.derived).map((p) => [`\`${p.name}\``, p.summary])}
          />
          <Notes
            entries={PROPERTIES.map((p) => ({
              label: p.name,
              ...(p.note ? { note: p.note } : {}),
            }))}
          />
        </>
      );

    case "expressions":
      return (
        <>
          <h3>Units</h3>
          <p class="hint">
            Any numeric literal may carry a unit, attached (<code>15vw</code>) or spaced (
            <code>15 vw</code>).
          </p>
          <Table
            head={["Unit", "Resolves against"]}
            rows={UNITS.map((u) => [
              `\`${[u.name, ...(u.aliases ?? [])].join("` / `")}\``,
              u.summary,
            ])}
          />
          <h3>Functions</h3>
          <Table
            head={["Signature", "Meaning"]}
            rows={FUNCTIONS.map((f) => [`\`${f.signature}\``, f.summary])}
          />
          <h3>Constants</h3>
          <p class="hint">Resolved against the target console at compile time.</p>
          <Table
            head={["Constant", "Value"]}
            rows={CONSTANTS.map((c) => [`\`${c.name}\``, c.summary])}
          />
        </>
      );

    case "input":
      return (
        <>
          <h3>Buttons</h3>
          <p class="hint">
            The portable set — the floor across every target console, which is why it is this small.
            A pad drawn for it is the same on every machine.
          </p>
          <Table
            head={["Button", "Meaning"]}
            rows={BUTTONS.map((b) => [`\`${b.name}\``, b.summary])}
          />
          <h3>Screen edges</h3>
          <Table
            head={["Edge", "Meaning"]}
            rows={EDGES_SPEC.map((e) => [`\`${e.name}\``, e.summary])}
          />
        </>
      );

    case "diagnostics":
      return (
        <>
          <p class="hint">
            Every one is a mistake the cell-and-tick model makes easy to write and hard to see,
            caught from the numbers rather than left to be found in an emulator — and all are
            per-console, because all of them are properties of the target rather than of the source.
          </p>
          <h3>Errors</h3>
          <Table
            head={["Code", "Meaning"]}
            rows={DIAGNOSTICS.filter((d) => d.severity === "error").map((d) => [
              `\`${d.code}\``,
              d.summary,
            ])}
          />
          <h3>Warnings</h3>
          <Table
            head={["Code", "Meaning"]}
            rows={DIAGNOSTICS.filter((d) => d.severity === "warning").map((d) => [
              `\`${d.code}\``,
              d.summary,
            ])}
          />
        </>
      );
  }
}

export function LanguageDocs() {
  const [topic, setTopic] = useState<Topic>("statements");

  return (
    <main class="docs-layout">
      <nav class="doc-nav" aria-label="Reference topics">
        {TOPICS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            class={`doc-topic${entry.id === topic ? " active" : ""}`}
            aria-current={entry.id === topic ? "true" : undefined}
            onClick={() => setTopic(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <section class="pane doc-body">
        <h2>{TOPICS.find((entry) => entry.id === topic)?.label}</h2>
        <Body topic={topic} />
        <p class="hint doc-footer">
          Generated from the language registry, the same file the compiler reads — so this page
          cannot describe a feature the compiler does not have. The design rationale is in{" "}
          <a href="https://github.com/georgestephenson/demake/blob/main/docs/14-demotic.md">
            doc 14
          </a>
          ; the markdown copy is in{" "}
          <a href="https://github.com/georgestephenson/demake/tree/main/packages/demotic/docs">
            packages/demotic/docs
          </a>
          .
        </p>
      </section>
    </main>
  );
}
