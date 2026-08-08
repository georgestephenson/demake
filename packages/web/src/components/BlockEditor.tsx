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
 * **The fields are what it is for.** Not the drag — "blocks you drag" describes
 * Scratch, where a drag *is* the composition, and Demotic is flat, so a drag here
 * expresses one number: which index. What this view buys over text is that a slot
 * knows what may go in it, and can therefore show you the four scenes, the seven
 * buttons or the project's own pictures. That half is a form, and a form works
 * from a keyboard by construction.
 *
 * **A row moves three ways**, because a drag alone is O(distance), has no
 * keyboard, and does not fire on touch at all: drag it (the list scrolls itself
 * near an edge), pick it up with Space and steer with the arrows, or press Enter
 * on the grip and choose a destination from a filtered list — which is O(1) and
 * the only one of the three that is better for being a form.
 *
 * **One tab stop, not one per control.** Rows are a roving-tabindex list: Tab
 * reaches the row you were last on, the arrows walk between rows, and only that
 * row puts its own fields in the tab order. Every control of every row being
 * tabbable put 352 stops between a seventy-line game and whatever came after it,
 * which is a worse barrier than the one the keyboard moves were added to remove.
 *
 * **A problem is shown where it is.** A diagnostic sits against its own row, a row
 * that has one is marked, the count above the list leads to the first, and
 * anything naming no row at all — the *game's* errors, when a suite is open — goes
 * at the top rather than being dropped. `check()` and the parser decide what is
 * wrong; this only decides where to put it (doc 19 §It offers; it does not
 * validate).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import {
  parseLevel,
  shortestName,
  SLOT_CHOICES,
  type Diagnostic,
  type SlotKind,
  type SourceList,
  type SourceSlot,
  type StatementSpec,
} from "@demake/demotic";

import {
  addItem,
  assetKindOf,
  assignableProperties,
  insertRow,
  moveRow,
  paletteFor,
  problemsOf,
  propertyOf,
  read,
  removeItem,
  removeRow,
  rowsOf,
  setSlot,
  slotValue,
  templateFor,
  vocabularyOf,
  type Dialect,
  type Part,
  type Row,
  type Vocabulary,
} from "../lib/blocks.js";
import { filesOfKind, fileUrl, levelSources, projectFiles, type Project } from "../lib/project.js";
import { useDismiss } from "./popover.js";
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

/** `1 error`, `2 errors` — the one line that reads badly inlined. */
function count(n: number, thing: string): string {
  return `${String(n)} ${thing}${n === 1 ? "" : "s"}`;
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
  // The row everything else is relative to: where the palette inserts, where the
  // arrows start, and whose fields are in the tab order. *Any* focus inside a row
  // makes it the active one, so tabbing to a field and then adding a statement
  // puts the statement where you are looking.
  const [active, setActive] = useState(0);
  const [held, setHeld] = useState<Held | null>(null);
  // Which row's destination list is open, if any.
  const [moving, setMoving] = useState<number | null>(null);
  // What a screen reader is told. Moving a row is invisible without it, and the
  // counter is what makes the *same* message announce twice — pressing the key
  // again at the end of the list has to say so again.
  const [said, setSaid] = useState({ text: "", n: 0 });
  // Where the keyboard should be once the rows have been redrawn.
  const [chasing, setChasing] = useState<number | null>(null);
  // And where it should be after a list has grown: the item that was just added,
  // which does not exist until the file has been reparsed.
  const [chasingItem, setChasingItem] = useState<{
    line: number;
    list: number;
    item: number;
  } | null>(null);

  const list = useRef<HTMLOListElement | null>(null);
  const grips = useRef(new Map<number, HTMLButtonElement>());
  const velocity = useRef(0);
  const frame = useRef(0);

  const announce = useCallback((message: string) => {
    setSaid((was) => ({ text: message, n: was.n + 1 }));
  }, []);

  const files = useMemo(() => projectFiles(project), [project]);
  const reading = useMemo(() => read(text, dialect), [text, dialect]);
  const rows = useMemo(() => rowsOf(text, reading), [text, reading]);
  const problems = useMemo(() => problemsOf(diagnostics, rows.length), [diagnostics, rows.length]);

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

  // A file that shrank under the cursor must not leave it pointing past the end.
  const anchor = Math.max(0, Math.min(active, rows.length - 1));

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
        setActive(at > dragging.from ? at - 1 : at);
      } else {
        onChange(insertRow(text, at, templateFor(dragging.spec)));
        setActive(at);
      }
      endDrag();
    },
    [dragging, text, onChange, endDrag],
  );

  // --- and the keyboard picks a row up and carries it -------------------------

  /** Put the keyboard on a row's grip, scrolling the list to it if need be. */
  const focusRow = useCallback((index: number) => {
    const grip = grips.current.get(index);
    grip?.scrollIntoView({ block: "nearest" });
    grip?.focus();
  }, []);

  /** Put the row at `from` in front of the row at `before`, and say so. */
  const place = useCallback(
    (from: number, before: number, note: string) => {
      onChange(moveRow(text, from, before));
      const landed = Math.max(0, Math.min(rows.length - 1, before > from ? before - 1 : before));
      setActive(landed);
      setChasing(landed);
      announce(note.replace("%", String(landed + 1)));
      return landed;
    },
    [text, rows.length, onChange, announce],
  );

  const carry = useCallback(
    (by: -1 | 1) => {
      if (!held) return;
      const to = held.at + by;
      if (to < 0 || to >= rows.length) {
        announce(by === -1 ? "Already the first line." : "Already the last line.");
        return;
      }
      const landed = place(held.at, by === 1 ? to + 1 : to, `Line % of ${String(rows.length)}.`);
      setHeld({ at: landed, from: held.from });
    },
    [held, rows.length, place, announce],
  );

  const release = useCallback(() => {
    if (!held) return;
    announce(
      held.at === held.from
        ? `Line ${String(held.at + 1)} put down where it was.`
        : `Dropped at line ${String(held.at + 1)}.`,
    );
    setHeld(null);
  }, [held, announce]);

  /** Escape: the row goes back where it was picked up, however far it travelled. */
  const abandon = useCallback(() => {
    if (!held) return;
    if (held.at !== held.from) {
      place(held.at, held.from > held.at ? held.from + 1 : held.from, "Back at line %.");
    } else {
      announce(`Line ${String(held.at + 1)} put down where it was.`);
    }
    setHeld(null);
  }, [held, place, announce]);

  // The rows are drawn by position, so a row that moved left its grip behind:
  // without this, pressing the key twice would march two rows past each other
  // instead of moving one.
  useEffect(() => {
    if (chasing === null) return;
    focusRow(chasing);
    setChasing(null);
  }, [chasing, rows, focusRow]);

  // Likewise for a list that just grew: the new item is a field that did not
  // exist when the button was pressed, so it is found by where it landed.
  useEffect(() => {
    if (chasingItem === null) return;
    const at = rows.findIndex((row) => row.line === chasingItem.line);
    const item = list.current?.querySelector(
      `[data-testid="block-row-${String(at)}"] [data-item="${String(chasingItem.list)}:${String(chasingItem.item)}"]`,
    );
    const field = item?.querySelector<HTMLElement>("input, select, button, textarea");
    field?.focus();
    setChasingItem(null);
  }, [chasingItem, rows]);

  const insert = useCallback(
    (spec: StatementSpec) => {
      const at = rows.length === 0 ? 0 : anchor + 1;
      onChange(insertRow(text, at, templateFor(spec)));
      setActive(at);
      announce(`Added ${spec.keyword} at line ${String(at + 1)}.`);
    },
    [anchor, rows.length, text, onChange, announce],
  );

  /** Take a field's value, and say so if the language would not hold it. */
  const write = useCallback(
    (slot: SourceSlot, value: string) => {
      if (slotValue(value) !== value) {
        announce("Quotes and line breaks cannot go inside a statement, so they were removed.");
      }
      onChange(setSlot(text, slot, value));
    },
    [text, onChange, announce],
  );

  /**
   * Give a statement one more of whatever repeats in it, and go and stand in it.
   *
   * The new item says something the grammar accepts (`screenleft`, `visible 1`)
   * and is almost never what was meant, so the caret lands there: adding a target
   * and then having to find it is two operations where the point of the ⊕ was
   * that it is one.
   */
  const grow = useCallback(
    (row: Extract<Row, { kind: "statement" }>, index: number) => {
      const list = row.span.lists[index];
      if (list === undefined) return;
      onChange(addItem(text, row.span, index));
      setChasingItem({ line: row.line, list: index, item: list.items.length });
      // What it says as well as that it happened: the caret is about to land in
      // a field holding a word nobody chose, and hearing which one is the point.
      const wrote = (list.items.length === 0 ? list.opener : list.template).trim();
      announce(`Added ${wrote} to line ${String(row.line)}.`);
    },
    [text, onChange, announce],
  );

  const shrink = useCallback(
    (row: Extract<Row, { kind: "statement" }>, index: number, item: number) => {
      const list = row.span.lists[index];
      if (list === undefined) return;
      onChange(removeItem(text, row.span, index, item));
      announce(`Removed ${nounFor(list)} ${String(item + 1)} from line ${String(row.line)}.`);
    },
    [text, onChange, announce],
  );

  const firstProblem = problems.rowsWithErrors[0];

  return (
    <div class="block-editor" data-testid="block-editor">
      <Palette dialect={dialect} onPick={insert} onDrag={setDragging} onDragEnd={endDrag} />

      {/* What is wrong, counted, with a way to the first one. A row scrolled out
          of view is a problem you cannot see, and a list of line numbers under
          the editor is the text view's answer rather than this one's. */}
      {problems.errors + problems.warnings > 0 ? (
        <p class="block-problems" data-testid="block-problems">
          <span class={problems.errors > 0 ? "diag-error" : "diag-warning"}>
            {problems.errors > 0 ? count(problems.errors, "error") : ""}
            {problems.errors > 0 && problems.warnings > 0 ? ", " : ""}
            {problems.warnings > 0 ? count(problems.warnings, "warning") : ""}
          </span>
          {firstProblem === undefined ? null : (
            <button
              type="button"
              data-testid="block-goto-problem"
              onClick={() => focusRow(firstProblem)}
            >
              Go to the first
            </button>
          )}
        </p>
      ) : null}

      {/* Every move is announced. A drag is its own feedback and this is the rest
          of it: the arrows move a row several lines in a second, and a screen
          reader that said nothing would be describing a file that had silently
          stopped being the one it read out. */}
      <p class="visually-hidden" role="status" aria-live="polite" data-testid="block-status">
        {said.text}
        {/* An invisible pair of states, so saying the same thing twice is still
            two changes to the region and therefore two announcements. */}
        {said.n % 2 === 0 ? "" : " "}
      </p>

      <p class="visually-hidden" id="block-move-help">
        Press Space to pick this line up and steer it with the arrow keys, or Enter to choose where
        it goes. It can also be dragged.
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
        {/* Diagnostics that name no row in this file — which is how a suite says
            the *game* under it will not compile. At the top rather than dropped:
            a suite that can never pass, with nothing on screen saying why, is the
            worst of the places to put it. */}
        {problems.loose.length > 0 ? (
          <li class="block-row block-loose" data-testid="block-loose">
            {problems.loose.map((one, at) => (
              <p key={at} class={one.severity === "error" ? "diag-error" : "diag-warning"}>
                <strong>{one.code}</strong> {one.message}
                {one.hint ? <span class="diag-hint"> — {one.hint}</span> : null}
              </p>
            ))}
          </li>
        ) : null}

        {rows.map((row, index) => {
          const mine = problems.byRow.get(index) ?? [];
          const worst = mine.some((one) => one.severity === "error")
            ? " has-error"
            : mine.length > 0
              ? " has-warning"
              : "";
          // Only the row you are on puts its own controls in the tab order.
          const here = index === anchor;
          return (
            <li
              key={row.line}
              class={`block-row block-${row.kind}${here ? " active" : ""}${
                held?.at === index ? " held" : ""
              }${worst}${over === index ? " drop-before" : ""}${
                over === rows.length && index === rows.length - 1 ? " drop-after" : ""
              }`}
              data-testid={`block-row-${String(index)}`}
              data-keyword={row.kind === "statement" ? row.keyword : undefined}
              onFocusCapture={() => setActive(index)}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                // Top half drops in front of this row, bottom half behind it —
                // which is what makes the last position reachable at all.
                const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
                setOver(event.clientY < box.top + box.height / 2 ? index : index + 1);
              }}
              onClick={() => setActive(index)}
            >
              <button
                type="button"
                class="block-grip"
                draggable
                ref={(element) => {
                  if (element) grips.current.set(index, element as HTMLButtonElement);
                  else grips.current.delete(index);
                }}
                tabIndex={here ? 0 : -1}
                aria-label={`Move line ${String(row.line)}`}
                aria-describedby="block-move-help"
                aria-haspopup="dialog"
                aria-expanded={moving === index}
                title="Drag to move it, Enter to choose where it goes, Space to pick it up"
                onDragStart={(event) => {
                  setDragging({ kind: "row", from: index });
                  setActive(index);
                  event.dataTransfer?.setData("text/plain", row.text);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={endDrag}
                onClick={(event) => {
                  event.stopPropagation();
                  setActive(index);
                  setMoving((open) => (open === index ? null : index));
                }}
                onKeyDown={(event) => {
                  // Space picks up, Enter chooses a destination. Two keys for two
                  // moves, rather than one key that means whichever of them you
                  // were not expecting.
                  if (event.key === " ") {
                    event.preventDefault();
                    if (held) release();
                    else {
                      setHeld({ at: index, from: index });
                      setActive(index);
                      announce(
                        `Line ${String(index + 1)} picked up. Arrow keys move it, Space drops it, Escape puts it back.`,
                      );
                    }
                    return;
                  }
                  if (event.key === "Enter" && !held) {
                    event.preventDefault();
                    setMoving((open) => (open === index ? null : index));
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
                  // Holding a row, the arrows carry it; holding nothing, they
                  // walk the list — which is what a row of controls is expected
                  // to do, and how you reach line 60 in order to pick it up.
                  if (held) carry(by);
                  else focusRow(Math.max(0, Math.min(rows.length - 1, index + by)));
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
                    files={files}
                    project={project}
                    vocabulary={vocabulary}
                    tabbable={here}
                    onWrite={write}
                    onAdd={(which) => grow(row, which)}
                    onDrop={(which, item) => shrink(row, which, item)}
                  />
                ) : row.kind === "blank" ? (
                  <span class="block-note">&nbsp;</span>
                ) : (
                  <input
                    class="block-text"
                    tabIndex={here ? 0 : -1}
                    aria-label={
                      row.kind === "comment" ? "Comment" : "Line the parser could not read"
                    }
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
                tabIndex={here ? 0 : -1}
                aria-label={`Delete line ${String(row.line)}`}
                onClick={() => {
                  onChange(removeRow(text, index));
                  announce(`Deleted line ${String(row.line)}.`);
                }}
              >
                ×
              </button>

              {moving === index ? (
                <MoveTo
                  rows={rows}
                  from={index}
                  onClose={() => {
                    setMoving(null);
                    focusRow(index);
                  }}
                  onMove={(before) => {
                    setMoving(null);
                    place(index, before, "Moved to line %.");
                  }}
                />
              ) : null}

              {mine.map((one, at) => (
                <p key={at} class={one.severity === "error" ? "diag-error" : "diag-warning"}>
                  <strong>{one.code}</strong> {one.message}
                  {one.hint ? <span class="diag-hint"> — {one.hint}</span> : null}
                </p>
              ))}
            </li>
          );
        })}

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
        they are created, and a rule runs where it sits in the file. <kbd>Tab</kbd> reaches the row
        you were last on and the arrows walk between rows; on a row&rsquo;s grip, <kbd>Space</kbd>{" "}
        picks it up to steer and <kbd>Enter</kbd> chooses where it goes.
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
 *
 * It expands the row rather than floating over it, and that is not taste: the
 * list is an `overflow: auto` scroller, and an absolutely positioned panel inside
 * one is clipped by it the moment the row it belongs to is near the bottom.
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
  const panel = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  // It exists to be typed into, so it takes the caret when it opens — the
  // explorer's own quick-open does the same thing for the same reason.
  useEffect(() => input.current?.focus(), []);
  useDismiss(panel, true, onClose);

  const places = useMemo(() => {
    const all: { before: number; line: number; label: string }[] = [];
    for (let before = 0; before <= rows.length; before += 1) {
      // The two that would not move it: in front of itself, and in front of
      // whatever follows it. Offering a move that does nothing is offering a
      // control that looks broken.
      if (before === from || before === from + 1) continue;
      const row = rows[before];
      all.push({
        before,
        line: row?.line ?? rows.length + 1,
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
        String(place.line).startsWith(wanted) || place.label.toLowerCase().includes(wanted),
    );
  }, [places, query]);

  return (
    <div
      class="block-moveto"
      ref={panel}
      role="dialog"
      aria-label="Choose where this line goes"
      data-testid="block-moveto"
    >
      <input
        class="block-field"
        ref={input}
        aria-label="Type a line number, or part of a row"
        placeholder="line number, or part of a row"
        value={query}
        onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        onKeyDown={(event) => {
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
  onDrag: (dragging: Dragging) => void;
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
              onDrag({ kind: "new", spec });
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
  files,
  project,
  vocabulary,
  tabbable,
  onWrite,
  onAdd,
  onDrop,
}: {
  row: Extract<Row, { kind: "statement" }>;
  files: readonly string[];
  project: Project;
  vocabulary: Vocabulary;
  tabbable: boolean;
  onWrite: (slot: SourceSlot, value: string) => void;
  onAdd: (list: number) => void;
  onDrop: (list: number, item: number) => void;
}) {
  return (
    <>
      <span class="block-keyword" data-keyword={row.keyword}>
        <StatementSymbol keyword={row.keyword} />
        {row.keyword}
      </span>
      {row.parts.map((part, index) => {
        if (part.kind === "glue") return <Glue key={index} text={part.text} />;
        if (part.kind === "add") {
          const list = row.span.lists[part.list] as SourceList;
          // "another" only where there is one already: an empty clause is a
          // control that writes the *first*, and a rule with no `from` in it
          // reading "add another side" is a rule the label describes wrongly.
          const what = `${list.items.length === 0 ? "a" : "another"} ${nounFor(list)}`;
          return (
            <button
              key={index}
              type="button"
              class="block-arity block-add"
              data-list={String(part.list)}
              tabIndex={tabbable ? 0 : -1}
              title={`Add ${what}`}
              aria-label={`Add ${what} to line ${String(row.line)}`}
              onClick={() => onAdd(part.list)}
            >
              +
            </button>
          );
        }
        if (part.kind === "drop") {
          const list = row.span.lists[part.list] as SourceList;
          return (
            <button
              key={index}
              type="button"
              class="block-arity block-drop"
              tabIndex={tabbable ? 0 : -1}
              title={`Remove this ${nounFor(list)}`}
              aria-label={`Remove ${nounFor(list)} ${String(part.item + 1)} from line ${String(row.line)}`}
              onClick={() => onDrop(part.list, part.item)}
            >
              −
            </button>
          );
        }
        const field = (
          <Field
            key={index}
            part={part}
            slot={part.slot}
            files={files}
            project={project}
            vocabulary={vocabulary}
            tabbable={tabbable}
            onChange={(value) => onWrite(part.slot, value)}
          />
        );
        if (part.in === undefined) return field;
        // A list item is wrapped so the editor can find the one it has just
        // added and put the caret in it. `display: contents`, so the row lays
        // out exactly as it did before there were lists.
        return (
          <span
            key={index}
            class="block-item"
            data-item={`${String(part.in.list)}:${String(part.in.item)}`}
          >
            {field}
          </span>
        );
      })}
    </>
  );
}

/**
 * What one item of a list is called, which is the one thing about it the engine
 * does not decide.
 *
 * `SlotKind` is the parser's vocabulary — `entity`, `expression` — and reading
 * "add another expression" on a rule that sets two properties is reading the
 * compiler's name for something the author calls a value. Same division as
 * `StatementSymbol`.
 */
const LIST_NOUNS: Readonly<Partial<Record<SlotKind, string>>> = {
  entity: "target",
  side: "side",
  property: "property",
  expression: "value",
  level: "chunk",
};

function nounFor(list: SourceList): string {
  return LIST_NOUNS[list.kind] ?? list.kind;
}

/**
 * The grammar's own words between two fields — `in`, `then`, a bracket, a comma.
 *
 * Shown rather than hidden, because a rule whose `then` had been replaced by a
 * layout convention would read as a different statement from the one in the file.
 * The exception is a quote: a string's slot covers the *contents* of the literal,
 * so the quotes belong to the field that draws them, and printed here they came
 * out as debris at the end of a wrapped line.
 */
function Glue({ text }: { text: string }) {
  const shown = text.replace(/["']/g, "").trim();
  return shown === "" ? null : <span class="block-glue">{shown}</span>;
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
  tabbable,
  onChange,
}: {
  part: Extract<Part, { kind: "slot" }>;
  slot: SourceSlot;
  files: readonly string[];
  project: Project;
  vocabulary: Vocabulary;
  tabbable: boolean;
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
        tabbable={tabbable}
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
        tabIndex={tabbable ? 0 : -1}
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

  const box = (
    <input
      class="block-field"
      data-slot={slot.kind}
      tabIndex={tabbable ? 0 : -1}
      aria-label={labelFor(slot)}
      inputMode={slot.kind === "number" ? "decimal" : undefined}
      size={Math.max(3, Math.min(40, part.text.length + 1))}
      value={part.text}
      onChange={(event) => onChange((event.target as HTMLInputElement).value)}
    />
  );
  // The quotes the glue no longer prints, drawn around the field they belong to.
  return slot.kind === "string" ? <span class="block-quoted">{box}</span> : box;
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
  tabbable,
  onChange,
}: {
  kind: "art" | "music" | "sound" | "level";
  value: string;
  files: readonly string[];
  project: Project;
  tabbable: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLSpanElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const paths = useMemo(() => filesOfKind(project, kind), [project, kind]);
  const names = useMemo(() => paths.map((path) => shortestName(path, files)), [paths, files]);
  const current = paths[names.indexOf(value)];

  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);
  useDismiss(panel, open, close);

  if (kind !== "art") {
    return (
      <select
        class="block-field block-choice"
        data-slot={kind}
        tabIndex={tabbable ? 0 : -1}
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
    <span class="block-art" ref={panel}>
      <button
        type="button"
        class="block-field block-thumb"
        ref={button}
        data-slot="art"
        tabIndex={tabbable ? 0 : -1}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Art: ${value}`}
        onClick={() => setOpen((on) => !on)}
      >
        {current === undefined ? null : <img src={fileUrl(project, current)} alt="" />}
        <span>{value}</span>
      </button>
      {open ? (
        // In the flow rather than floating: the row list is an `overflow: auto`
        // scroller, and an absolutely positioned panel inside one is clipped by
        // it as soon as the row it belongs to is near the bottom.
        <span
          class="block-gallery"
          role="dialog"
          aria-label="Pictures in this project"
          data-testid="block-gallery"
        >
          {paths.length === 0 ? (
            <span class="hint">This project has no pictures in it yet.</span>
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
                    close();
                  }}
                >
                  <img src={fileUrl(project, path)} alt="" />
                  <span>{name}</span>
                </button>
              );
            })
          )}
        </span>
      ) : null}
    </span>
  );
}
