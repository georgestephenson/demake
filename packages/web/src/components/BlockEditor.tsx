/**
 * The program as blocks you drag (doc 19 §The block editor).
 *
 * One block is one line of Demotic and **the file is the model**. There are no
 * wires, no nesting and no canvas — the language is flat by design, and the
 * moment a block could express something no line can, the file would have stopped
 * being the model and this would have become a second definition of the language.
 *
 * Everything it draws is derived. The palette is `STATEMENTS` (or
 * `TEST_STATEMENTS` for a suite); the fields come from the parser's own slots, so
 * a name that is a scene gets a list of scenes because the *parser* said it was a
 * scene; the choices in each list come from the registry the language already
 * keeps, or from the project's own files. The page's contribution is the symbols
 * (`StatementSymbol.tsx`) and the layout.
 *
 * **A drag is an edit, not a rearrangement.** Entities live in declaration order,
 * so moving a `create` changes what is drawn over what and which sprite the
 * hardware drops first past its per-scanline budget; a rule's place in the file
 * is its place in the tick. Nothing here sorts, groups or tidies on its own, and
 * a row nobody touched is emitted byte-identical (`lib/blocks.ts`).
 *
 * **It offers; it does not validate.** Diagnostics are `check()`'s and the
 * parser's, shown against the rows they name. A field that decided for itself
 * what was legal would be a second front end, and it would be wrong the first time
 * the language changed.
 */

import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import {
  parseLevel,
  shortestName,
  SLOT_CHOICES,
  type Diagnostic,
  type SourceSlot,
  type StatementSpec,
} from "@demake/demotic";

import {
  assetKindOf,
  assignableProperties,
  insertRow,
  moveRow,
  paletteFor,
  propertyOf,
  read,
  removeRow,
  rowsOf,
  setSlot,
  templateFor,
  vocabularyOf,
  type Dialect,
  type Part,
  type Row,
  type Vocabulary,
} from "../lib/blocks.js";
import { filesOfKind, fileUrl, levelSources, projectFiles, type Project } from "../lib/project.js";
import { StatementSymbol } from "./StatementSymbol.js";

/** What is being dragged: a row of the file, or a statement from the palette. */
type Dragging = { kind: "row"; from: number } | { kind: "new"; spec: StatementSpec };

export function BlockEditor({
  text,
  dialect,
  project,
  diagnostics,
  onChange,
}: {
  text: string;
  dialect: Dialect;
  project: Project;
  /** Everything known about the file, from `check()` and from the parser. */
  diagnostics: readonly Diagnostic[];
  onChange: (next: string) => void;
}) {
  const [dragging, setDragging] = useState<Dragging | null>(null);
  // Where a drop would land: an index in the row list, the length meaning "at
  // the end". Held in state because it is what draws the insertion line.
  const [over, setOver] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const files = useMemo(() => projectFiles(project), [project]);
  const reading = useMemo(() => read(text, dialect), [text, dialect]);
  const rows = useMemo(() => rowsOf(text, reading), [text, reading]);

  // Tile names come from the project's levels, because `when hero touches ledge`
  // names a tile in a `.dmtl` legend and not anything the `.dmt` declares.
  const tiles = useMemo(() => {
    const names = new Set<string>();
    for (const source of Object.values(levelSources(project))) {
      for (const tile of parseLevel(source).tiles) names.add(tile.name);
    }
    return [...names];
  }, [project]);
  const vocabulary = useMemo(() => vocabularyOf(text, reading, tiles), [text, reading, tiles]);

  const byLine = useMemo(() => {
    const map = new Map<number, Diagnostic[]>();
    for (const one of diagnostics) {
      const at = map.get(one.line);
      if (at) at.push(one);
      else map.set(one.line, [one]);
    }
    return map;
  }, [diagnostics]);

  const drop = useCallback(
    (at: number) => {
      if (!dragging) return;
      if (dragging.kind === "row") {
        onChange(moveRow(text, dragging.from, at));
        // Follow the row: the thing you just moved is the thing you are looking
        // at, and losing it in a long file is the whole cost of a mis-drop.
        setSelected(at > dragging.from ? at - 1 : at);
      } else {
        onChange(insertRow(text, at, templateFor(dragging.spec)));
        setSelected(at);
      }
      setDragging(null);
      setOver(null);
    },
    [dragging, text, onChange],
  );

  /** Move a row with the keyboard, because a drag is a mouse and not everyone has one. */
  const nudge = useCallback(
    (from: number, by: -1 | 1) => {
      const to = from + by;
      if (to < 0 || to >= rows.length) return;
      onChange(moveRow(text, from, by === 1 ? to + 1 : to));
      setSelected(to);
      // Take the focus with it. Rows are drawn by position, so the grip that has
      // the keyboard is now holding whatever moved *into* the old index — press
      // the key twice and you would be marching two different rows past each
      // other instead of moving one.
      setChasing(to);
    },
    [rows.length, text, onChange],
  );

  // Where the keyboard should be after a nudge, and one paint later it is.
  const [chasing, setChasing] = useState<number | null>(null);
  useEffect(() => {
    if (chasing === null) return;
    const grip = document.querySelector<HTMLElement>(
      `[data-testid="block-row-${String(chasing)}"] .block-grip`,
    );
    grip?.focus();
    setChasing(null);
  }, [chasing, rows]);

  return (
    <div class="block-editor" data-testid="block-editor">
      <Palette
        dialect={dialect}
        onPick={(spec) => {
          const at = selected === null ? rows.length : selected + 1;
          onChange(insertRow(text, at, templateFor(spec)));
          setSelected(at);
        }}
        onDrag={(spec) => setDragging({ kind: "new", spec })}
        onDragEnd={() => {
          setDragging(null);
          setOver(null);
        }}
      />

      <ol
        class="block-rows"
        data-testid="block-rows"
        onDragOver={(event) => {
          // The list itself takes a drop past the last row, which is the only way
          // to append by dragging.
          if (!dragging) return;
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          drop(over ?? rows.length);
        }}
      >
        {rows.map((row, index) => (
          <li
            key={row.line}
            class={`block-row block-${row.kind}${selected === index ? " selected" : ""}${
              over === index ? " drop-before" : ""
            }${over === rows.length && index === rows.length - 1 ? " drop-after" : ""}`}
            data-testid={`block-row-${String(index)}`}
            data-keyword={row.kind === "statement" ? row.keyword : undefined}
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              // Top half drops in front of this row, bottom half behind it —
              // which is what makes the last position reachable at all.
              const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
              setOver(event.clientY < box.top + box.height / 2 ? index : index + 1);
            }}
            onClick={() => setSelected(index)}
          >
            <button
              type="button"
              class="block-grip"
              draggable
              aria-label={`Move line ${String(row.line)}`}
              title="Drag to move, or use the arrow keys"
              onDragStart={(event) => {
                setDragging({ kind: "row", from: index });
                setSelected(index);
                event.dataTransfer?.setData("text/plain", row.text);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                nudge(index, event.key === "ArrowUp" ? -1 : 1);
              }}
            >
              <svg viewBox="0 0 8 16" width="8" height="16" aria-hidden="true" focusable="false">
                <path
                  d="M2 4h.01M6 4h.01M2 8h.01M6 8h.01M2 12h.01M6 12h.01"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
            </button>

            <span class="block-line">{row.line}</span>

            <div class="block-body">
              {row.kind === "statement" ? (
                <StatementRow
                  row={row}
                  text={text}
                  files={files}
                  project={project}
                  vocabulary={vocabulary}
                  onChange={onChange}
                />
              ) : row.kind === "blank" ? (
                <span class="block-note">&nbsp;</span>
              ) : (
                <input
                  class="block-text"
                  aria-label={row.kind === "comment" ? "Comment" : "Line the parser could not read"}
                  value={row.text}
                  onChange={(event) => {
                    const value = (event.target as HTMLInputElement).value;
                    onChange(replaceLine(text, index, value));
                  }}
                />
              )}
            </div>

            <button
              type="button"
              class="block-remove"
              aria-label={`Delete line ${String(row.line)}`}
              onClick={() => {
                onChange(removeRow(text, index));
                setSelected(null);
              }}
            >
              ×
            </button>

            {(byLine.get(row.line) ?? []).map((one, at) => (
              <p key={at} class={one.severity === "error" ? "diag-error" : "diag-warning"}>
                <strong>{one.code}</strong> {one.message}
                {one.hint ? <span class="diag-hint"> — {one.hint}</span> : null}
              </p>
            ))}
          </li>
        ))}

        {/* A file with nothing in it still needs somewhere to drop the first
            statement, and a row list with no rows has nowhere. */}
        {rows.length === 0 ? (
          <li
            class={`block-row block-empty${over === 0 ? " drop-before" : ""}`}
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              setOver(0);
            }}
          >
            <p class="hint">Pick a statement above to start the game.</p>
          </li>
        ) : null}
      </ol>

      <p class="hint">
        One block is one line. Dragging one is an <em>edit</em>: objects are drawn in the order they
        are created, and a rule runs where it sits in the file.
      </p>
    </div>
  );
}

/** Replace one line of a file, for the two rows that are edited as plain text. */
function replaceLine(text: string, index: number, value: string): string {
  const lines = text.split("\n");
  lines[index] = value.replace(/[\r\n]+/g, " ");
  return lines.join("\n");
}

/**
 * The statements you can add, straight from the dialect's own registry.
 *
 * The page keeps no list of them: a statement added to `STATEMENTS` appears here
 * the day it lands, with its summary as the tooltip and its example as what a
 * drop inserts — which is the same rule that colours a new keyword for free.
 */
function Palette({
  dialect,
  onPick,
  onDrag,
  onDragEnd,
}: {
  dialect: Dialect;
  onPick: (spec: StatementSpec) => void;
  onDrag: (spec: StatementSpec) => void;
  onDragEnd: () => void;
}) {
  return (
    <div class="block-palette" data-testid="block-palette">
      {paletteFor(dialect).map((spec) => (
        <button
          key={spec.keyword}
          type="button"
          class="block-chip"
          draggable
          data-keyword={spec.keyword}
          title={`${spec.syntax}\n\n${spec.summary}`}
          onDragStart={(event) => {
            onDrag(spec);
            event.dataTransfer?.setData("text/plain", spec.example);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
          }}
          onDragEnd={onDragEnd}
          onClick={() => onPick(spec)}
        >
          <StatementSymbol keyword={spec.keyword} />
          <span>{spec.keyword}</span>
        </button>
      ))}
    </div>
  );
}

/** One statement: its symbol, its keyword, and a field per slot. */
function StatementRow({
  row,
  text,
  files,
  project,
  vocabulary,
  onChange,
}: {
  row: Extract<Row, { kind: "statement" }>;
  text: string;
  files: readonly string[];
  project: Project;
  vocabulary: Vocabulary;
  onChange: (next: string) => void;
}) {
  return (
    <>
      <span class="block-keyword" data-keyword={row.keyword}>
        <StatementSymbol keyword={row.keyword} />
        {row.keyword}
      </span>
      {row.parts.map((part, index) =>
        part.slot ? (
          <Field
            key={index}
            part={part}
            slot={part.slot}
            files={files}
            project={project}
            vocabulary={vocabulary}
            onChange={(value) => onChange(setSlot(text, part.slot as SourceSlot, value))}
          />
        ) : (
          <span key={index} class="block-glue">
            {part.text.trim()}
          </span>
        ),
      )}
    </>
  );
}

/** The words a slot may hold, when the answer is a list rather than free text. */
function choicesFor(slot: SourceSlot, vocabulary: Vocabulary): readonly string[] | undefined {
  switch (slot.kind) {
    case "scene":
      return vocabulary.scenes;
    case "class":
      return vocabulary.classes;
    case "entity":
      return vocabulary.entities;
    case "property":
      return assignableProperties().map((property) => property.name);
    default:
      return SLOT_CHOICES[slot.kind];
  }
}

/** One editable part of a statement. */
function Field({
  part,
  slot,
  files,
  project,
  vocabulary,
  onChange,
}: {
  part: Part;
  slot: SourceSlot;
  files: readonly string[];
  project: Project;
  vocabulary: Vocabulary;
  onChange: (value: string) => void;
}) {
  const kind = assetKindOf(slot.kind);
  if (kind !== undefined) {
    return (
      <AssetField
        kind={kind}
        value={part.text}
        files={files}
        project={project}
        onChange={onChange}
      />
    );
  }

  const choices = choicesFor(slot, vocabulary);
  if (choices !== undefined) {
    return (
      <select
        class="block-field block-choice"
        data-slot={slot.kind}
        aria-label={labelFor(slot)}
        value={part.text}
        onChange={(event) => onChange((event.target as HTMLSelectElement).value)}
      >
        {/* Whatever the file already says, even where nothing offers it. A field
            that silently dropped an unknown name would rewrite the program on the
            next unrelated edit — and a name that is wrong is `check()`'s to
            report, not this list's to erase. */}
        {choices.includes(part.text) ? null : <option value={part.text}>{part.text}</option>}
        {choices.map((one) => (
          <option key={one} value={one}>
            {one}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      class="block-field"
      data-slot={slot.kind}
      aria-label={labelFor(slot)}
      inputMode={slot.kind === "number" ? "decimal" : undefined}
      size={Math.max(3, Math.min(40, part.text.length + 1))}
      value={part.text}
      onChange={(event) => onChange((event.target as HTMLInputElement).value)}
    />
  );
}

/**
 * What a screen reader calls a field.
 *
 * The property's own name where the registry has one, because "x" is what the
 * author is looking at and "expression" is what the parser calls it.
 */
function labelFor(slot: SourceSlot): string {
  const property = propertyOf(slot);
  return property === undefined ? slot.kind : `${property.name} — ${property.summary}`;
}

/**
 * A field that names one of the project's files.
 *
 * Pictures are **picked as pictures** (doc 19): the button shows the one the
 * statement names and opens a grid of the project's art to choose from, because a
 * dropdown of filenames is a dropdown you have to have memorised. Tracks, effects
 * and levels get a list, since there is nothing to look at.
 *
 * Whatever is chosen is written as **the shortest name that identifies it** (doc
 * 19 §The rule) — `ball`, growing to `ball.png` or `art/ball.png` only where the
 * project holds something the shorter form would also fit. The editor is the one
 * thing that never has to be told this twice: it knows every file in the project.
 */
function AssetField({
  kind,
  value,
  files,
  project,
  onChange,
}: {
  kind: "art" | "music" | "sound" | "level";
  value: string;
  files: readonly string[];
  project: Project;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const paths = useMemo(() => filesOfKind(project, kind), [project, kind]);
  const names = useMemo(() => paths.map((path) => shortestName(path, files)), [paths, files]);
  const current = paths[names.indexOf(value)];

  if (kind !== "art") {
    return (
      <select
        class="block-field block-choice"
        data-slot={kind}
        aria-label={`The ${kind} this names`}
        value={value}
        onChange={(event) => onChange((event.target as HTMLSelectElement).value)}
      >
        {names.includes(value) ? null : <option value={value}>{value}</option>}
        {names.map((one) => (
          <option key={one} value={one}>
            {one}
          </option>
        ))}
      </select>
    );
  }

  return (
    <span class="block-art">
      <button
        type="button"
        class="block-field block-thumb"
        data-slot="art"
        aria-expanded={open}
        aria-label={`Art: ${value}`}
        onClick={() => setOpen((on) => !on)}
      >
        {current === undefined ? null : <img src={fileUrl(project, current)} alt="" />}
        <span>{value}</span>
      </button>
      {open ? (
        <div class="block-gallery" data-testid="block-gallery">
          {paths.length === 0 ? (
            <p class="hint">This project has no pictures in it yet.</p>
          ) : (
            paths.map((path, index) => {
              const name = names[index] as string;
              return (
                <button
                  key={path}
                  type="button"
                  class={`block-tile${name === value ? " picked" : ""}`}
                  title={path}
                  onClick={() => {
                    onChange(name);
                    setOpen(false);
                  }}
                >
                  <img src={fileUrl(project, path)} alt="" />
                  <span>{name}</span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </span>
  );
}
