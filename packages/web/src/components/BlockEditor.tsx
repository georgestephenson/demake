/**
 * The program as blocks, one per line (doc 19 §The block editor).
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
 * **Moving a row is an edit, not a rearrangement.** Entities live in declaration
 * order, so moving a `create` changes what is drawn over what and which sprite the
 * hardware drops first past its per-scanline budget; a rule's place in the file is
 * its place in the tick. Nothing here sorts, groups or tidies on its own, and a row
 * nobody touched is emitted byte-identical (`lib/blocks.ts`).
 *
 * **A drag is one of three ways to move a row, and the weakest.** In a nesting
 * language a drag *is* the composition — you snap a block into a socket and the
 * gesture says what contains what. Demotic is flat, so a drag here expresses a
 * single number: which index. That is worth having and it is not worth relying
 * on, because a gesture has no keyboard, native drag-and-drop does not fire on
 * touch at all, and a drag can only reach as far as the list is tall. So the row
 * moves three ways and each is best at something different:
 *
 * - **Dragging** is direct and fastest over a few rows. The list scrolls itself
 *   when the pointer nears an edge, without which a move past the visible dozen
 *   would be impossible — with a mouse, which is the point: that was never only an
 *   accessibility gap.
 * - **Grab and move** is the keyboard's: Space picks a row up, the arrows carry
 *   it, Space drops it and Escape puts it back where it started. Every step is
 *   announced, because a row that moves silently under a screen reader has not
 *   moved as far as its user is concerned.
 * - **Choosing a destination** is the one that beats both over a long distance:
 *   clicking the grip opens a filtered list of every place the row could go, so
 *   line 60 reaches line 3 in two keystrokes. Dragging is O(distance) and the
 *   arrows are O(rows); this is O(1).
 *
 * **It offers; it does not validate.** Diagnostics are `check()`'s and the
 * parser's, shown against the rows they name. A field that decided for itself
 * what was legal would be a second front end, and it would be wrong the first time
 * the language changed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

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

/** A row the keyboard has picked up: where it is now, and where it started. */
interface Held {
  at: number;
  from: number;
}

/** How near an edge a drag has to come before the list starts moving itself. */
const SCROLL_EDGE = 52;

/** The fastest it moves, in pixels a frame, reached at the very edge. */
const SCROLL_STEP = 16;

/** How fast to scroll for a pointer this far inside the edge. */
function speed(inside: number): number {
  return Math.max(1, Math.ceil(SCROLL_STEP * (1 - Math.max(0, inside) / SCROLL_EDGE)));
}

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
  const [held, setHeld] = useState<Held | null>(null);
  // Which row's destination list is open, if any.
  const [moving, setMoving] = useState<number | null>(null);
  // What a screen reader is told. Moving a row is invisible without it.
  const [said, setSaid] = useState("");
  // Where the keyboard should be once the rows have been redrawn.
  const [chasing, setChasing] = useState<number | null>(null);

  const list = useRef<HTMLOListElement | null>(null);
  const velocity = useRef(0);
  const frame = useRef(0);

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

  // --- the list scrolls itself while a drag is near its edge ------------------

  const stopScrolling = useCallback(() => {
    velocity.current = 0;
    if (frame.current !== 0) cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);

  /**
   * Keep the list moving while the pointer sits near an edge.
   *
   * Driven by a frame loop rather than by `dragover` itself, because a pointer
   * held perfectly still at the edge stops producing those events in some
   * browsers — and "hold it at the bottom and wait" is exactly the gesture this
   * is for.
   */
  const edgeScroll = useCallback((clientY: number) => {
    const element = list.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const above = clientY - box.top;
    const below = box.bottom - clientY;
    velocity.current = above < SCROLL_EDGE ? -speed(above) : below < SCROLL_EDGE ? speed(below) : 0;
    if (velocity.current === 0 || frame.current !== 0) return;
    const step = (): void => {
      const scroller = list.current;
      if (!scroller || velocity.current === 0) {
        frame.current = 0;
        return;
      }
      scroller.scrollTop += velocity.current;
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => stopScrolling, [stopScrolling]);

  const endDrag = useCallback(() => {
    setDragging(null);
    setOver(null);
    stopScrolling();
  }, [stopScrolling]);

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
      endDrag();
    },
    [dragging, text, onChange, endDrag],
  );

  // --- and the keyboard picks a row up and carries it -------------------------

  /** Put the row at `from` in front of the row at `before`, and say so. */
  const place = useCallback(
    (from: number, before: number, note: string) => {
      onChange(moveRow(text, from, before));
      const landed = Math.max(0, Math.min(rows.length - 1, before > from ? before - 1 : before));
      setSelected(landed);
      setChasing(landed);
      setSaid(note.replace("%", String(landed + 1)));
      return landed;
    },
    [text, rows.length, onChange],
  );

  const carry = useCallback(
    (by: -1 | 1) => {
      if (!held) return;
      const to = held.at + by;
      if (to < 0 || to >= rows.length) {
        setSaid(by === -1 ? "Already the first line." : "Already the last line.");
        return;
      }
      const landed = place(held.at, by === 1 ? to + 1 : to, `Line % of ${String(rows.length)}.`);
      setHeld({ at: landed, from: held.from });
    },
    [held, rows.length, place],
  );

  const release = useCallback(() => {
    if (!held) return;
    setSaid(
      held.at === held.from
        ? `Line ${String(held.at + 1)} put down where it was.`
        : `Dropped at line ${String(held.at + 1)}.`,
    );
    setHeld(null);
  }, [held]);

  /** Escape: the row goes back where it was picked up, however far it travelled. */
  const abandon = useCallback(() => {
    if (!held) return;
    if (held.at !== held.from) {
      place(held.at, held.from > held.at ? held.from + 1 : held.from, "Back at line %.");
    } else {
      setSaid(`Line ${String(held.at + 1)} put down where it was.`);
    }
    setHeld(null);
  }, [held, place]);

  // The rows are drawn by position, so a row that moved left its grip behind:
  // without this, pressing the key twice would march two rows past each other
  // instead of moving one.
  useEffect(() => {
    if (chasing === null) return;
    const grip = document.querySelector<HTMLElement>(
      `[data-testid="block-row-${String(chasing)}"] .block-grip`,
    );
    grip?.focus();
    setChasing(null);
  }, [chasing, rows]);

  const insert = useCallback(
    (spec: StatementSpec) => {
      const at = selected === null ? rows.length : selected + 1;
      onChange(insertRow(text, at, templateFor(spec)));
      setSelected(at);
      setSaid(`Added ${spec.keyword} at line ${String(at + 1)}.`);
    },
    [selected, rows.length, text, onChange],
  );

  return (
    <div class="block-editor" data-testid="block-editor">
      <Palette
        dialect={dialect}
        onPick={insert}
        onDrag={(spec) => setDragging({ kind: "new", spec })}
        onDragEnd={endDrag}
      />

      {/* Every move is announced. A drag is its own feedback and this is the
          rest of it: the arrows move a row several lines in a second, and a
          screen reader that said nothing would be describing a file that had
          silently stopped being the one it read out. */}
      <p class="visually-hidden" role="status" aria-live="polite" data-testid="block-status">
        {said}
      </p>

      <ol
        class="block-rows"
        ref={list}
        data-testid="block-rows"
        onDragOver={(event) => {
          // The list itself takes a drop past the last row, which is the only way
          // to append by dragging — and it is what drives the edge scrolling,
          // because the rows under the pointer change as it moves.
          if (!dragging) return;
          event.preventDefault();
          edgeScroll(event.clientY);
        }}
        onDragLeave={stopScrolling}
        onDrop={(event) => {
          event.preventDefault();
          drop(over ?? rows.length);
        }}
      >
        {rows.map((row, index) => (
          <li
            key={row.line}
            class={`block-row block-${row.kind}${selected === index ? " selected" : ""}${
              held?.at === index ? " held" : ""
            }${over === index ? " drop-before" : ""}${
              over === rows.length && index === rows.length - 1 ? " drop-after" : ""
            }`}
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
              aria-label={`Line ${String(row.line)}: move it`}
              aria-pressed={held?.at === index}
              aria-expanded={moving === index}
              title="Drag to move it, click to choose where it goes, or press Space to pick it up"
              onDragStart={(event) => {
                setDragging({ kind: "row", from: index });
                setSelected(index);
                event.dataTransfer?.setData("text/plain", row.text);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={endDrag}
              onClick={(event) => {
                // The click is the *destination list*: dragging is what a mouse
                // does with a grip, so a plain click is free for the thing a drag
                // is worst at.
                event.stopPropagation();
                setSelected(index);
                setMoving((open) => (open === index ? null : index));
              }}
              onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  if (held) release();
                  else {
                    setHeld({ at: index, from: index });
                    setSelected(index);
                    setSaid(
                      `Line ${String(index + 1)} picked up. Arrow keys move it, Enter drops it, Escape puts it back.`,
                    );
                  }
                  return;
                }
                if (event.key === "Escape" && held) {
                  event.preventDefault();
                  abandon();
                  return;
                }
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                const by = event.key === "ArrowUp" ? -1 : 1;
                // Holding a row, the arrows carry it; holding nothing, they walk
                // the list — which is what a row of controls is expected to do
                // and how you reach line 60 in order to pick it up.
                if (held) carry(by);
                else setChasing(Math.max(0, Math.min(rows.length - 1, index + by)));
              }}
              onBlur={(event) => {
                // Carrying a row moves the focus with it, so only focus leaving
                // the list entirely counts as putting it down.
                const next = event.relatedTarget as Node | null;
                if (held && !list.current?.contains(next)) release();
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
                setSaid(`Deleted line ${String(row.line)}.`);
              }}
            >
              ×
            </button>

            {moving === index ? (
              <MoveTo
                rows={rows}
                from={index}
                onClose={() => setMoving(null)}
                onMove={(before) => {
                  setMoving(null);
                  place(index, before, "Moved to line %.");
                }}
              />
            ) : null}

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
        One block is one line, and moving one is an <em>edit</em>: objects are drawn in the order
        they are created, and a rule runs where it sits in the file. Drag a row by its grip, click
        the grip to choose where it goes, or press <kbd>Space</kbd> on it and steer with the arrows.
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
 * Every place a row could go, filtered by typing.
 *
 * This is the move a drag is worst at. Dragging costs a gesture proportional to
 * the distance and cannot leave the visible list without the edge scrolling
 * carrying it; the arrows cost a keystroke per row. Picking the destination costs
 * the same whether it is one line away or sixty, which on a file the length of a
 * real game is the difference between a move you make and one you give up on and
 * go and do in the text view.
 *
 * A destination is *in front of* a row, plus the end — the same vocabulary
 * `insertRow` and `moveRow` take, so nothing here has to reason about whether
 * removing the row first shifts the target.
 */
function MoveTo({
  rows,
  from,
  onMove,
  onClose,
}: {
  rows: readonly Row[];
  from: number;
  onMove: (before: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement | null>(null);
  // The popover exists to be typed into, so it takes the caret when it opens —
  // the explorer's own quick-open does the same thing for the same reason.
  useEffect(() => input.current?.focus(), []);

  const places = useMemo(() => {
    const all: { before: number; label: string }[] = [];
    for (let before = 0; before <= rows.length; before += 1) {
      // The two that would not move it: in front of itself, and in front of
      // whatever follows it. Offering a move that does nothing is offering a
      // control that looks broken.
      if (before === from || before === from + 1) continue;
      const row = rows[before];
      all.push({
        before,
        label:
          row === undefined
            ? "at the end"
            : `before line ${String(row.line)}: ${row.text.trim() === "" ? "(blank line)" : row.text.trim()}`,
      });
    }
    return all;
  }, [rows, from]);

  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    if (wanted === "") return places;
    // A number matches the line it names; anything else matches the text of the
    // row, which is how you say "before the rule about the paddle".
    return places.filter(
      (place) =>
        String((rows[place.before]?.line ?? rows.length + 1) as number).startsWith(wanted) ||
        place.label.toLowerCase().includes(wanted),
    );
  }, [places, query, rows]);

  return (
    <div class="block-moveto" data-testid="block-moveto">
      <input
        class="block-field"
        ref={input}
        aria-label={`Move line ${String(rows[from]?.line ?? from + 1)} — type a line number or part of a row`}
        placeholder="line number, or part of a row"
        value={query}
        onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Enter") return;
          event.preventDefault();
          const first = shown[0];
          if (first) onMove(first.before);
        }}
      />
      <ul class="block-places">
        {shown.length === 0 ? (
          <li class="hint">Nothing matches.</li>
        ) : (
          shown.map((place) => (
            <li key={place.before}>
              <button type="button" onClick={() => onMove(place.before)}>
                {place.label}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/**
 * The statements you can add, straight from the dialect's own registry.
 *
 * The page keeps no list of them: a statement added to `STATEMENTS` appears here
 * the day it lands, with its summary as the tooltip and its example as what a
 * drop inserts — which is the same rule that colours a new keyword for free.
 *
 * **Both a grid and a search box**, because they are good at opposite things. The
 * chips are how you find out there are thirteen statements and what they are
 * called; the box is how somebody who knows that adds a `when` without reaching
 * for the mouse. It is the same bargain Ctrl+P strikes with the explorer, one pane
 * along.
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
  const [query, setQuery] = useState("");
  const all = paletteFor(dialect);
  const wanted = query.trim().toLowerCase();
  const shown =
    wanted === ""
      ? all
      : all.filter(
          (spec) => spec.keyword.includes(wanted) || spec.summary.toLowerCase().includes(wanted),
        );

  return (
    <div class="block-palette-bar">
      <input
        class="block-field block-search"
        data-testid="block-search"
        aria-label="Find a statement to add"
        placeholder="add a statement…"
        value={query}
        onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setQuery("");
            return;
          }
          if (event.key !== "Enter") return;
          event.preventDefault();
          const first = shown[0];
          if (!first) return;
          onPick(first);
          setQuery("");
        }}
      />
      <div class="block-palette" data-testid="block-palette">
        {shown.map((spec) => (
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
