/**
 * A `.dmt` as a list of rows you can drag (doc 19 §The block editor).
 *
 * **The model is the file, line by line.** Not a parsed program the editor writes
 * back out — that would make the editor a second definition of the language, and
 * it would reformat every file it opened. Every operation here rewrites *only the
 * bytes it was asked to*: setting a field splices one slot, dragging a row moves
 * one line, and everything else in the file comes back exactly as it went in.
 * That is the same bargain `dmtl.ts` strikes with a level, and for the same
 * reason — a hand-written file has to survive being looked at.
 *
 * **Nothing here knows the grammar.** Which part of a line is a scene name and
 * which is a picture comes from the parsers' slot side channel
 * (`@demake/demotic`'s `lang/slots.ts`), which records what the parser already
 * decided; where a comment starts comes from the lexer, for the reason the
 * highlighter takes it from there too. The one thing this module reads off a line
 * itself is whether it is blank, and "blank" is the one judgement no grammar can
 * disagree about.
 *
 * Both dialects go through here. A game and its suite are different languages
 * with different statements, and the editor above this is written against the
 * rows rather than against either — so the drag, the palette and the fields are
 * one implementation and the two registries are what differ.
 */

import {
  EDGE_NAMES,
  lex,
  parse,
  parseTests,
  PROPERTIES,
  STATEMENTS,
  TEST_STATEMENTS,
  type AssetKind,
  type Comment,
  type Diagnostic,
  type PropertySpec,
  type SlotKind,
  type SourceList,
  type SourceRange,
  type SourceSlot,
  type StatementSpec,
  type StatementSpan,
} from "@demake/demotic";

/** Which of the two grammars a file is written in. */
export type Dialect = "game" | "suite";

/**
 * Which dialect a path holds.
 *
 * A suite is a `.dmt` too, and the double extension is the whole distinction —
 * so this is the one place it is spelled, and `route.ts` asks the same question
 * to decide which editor opens.
 */
export function dialectOf(path: string): Dialect {
  return path.endsWith(".test.dmt") ? "suite" : "game";
}

/** The statements a dialect offers, straight from its own registry. */
export function paletteFor(dialect: Dialect): readonly StatementSpec[] {
  return dialect === "suite" ? TEST_STATEMENTS : STATEMENTS;
}

/** What one parse of a file tells the editor. */
export interface Reading {
  spans: readonly StatementSpan[];
  comments: readonly Comment[];
  /** Syntax errors only — a rule about the *program* comes from `check()`. */
  diagnostics: readonly Diagnostic[];
}

/** Read a file with whichever of the engine's two front ends fits. */
export function read(text: string, dialect: Dialect): Reading {
  if (dialect === "suite") {
    const file = parseTests(text);
    return { spans: file.spans, comments: file.comments, diagnostics: file.diagnostics };
  }
  const result = parse(text);
  return { spans: result.spans, comments: lex(text).comments, diagnostics: result.diagnostics };
}

/**
 * One piece of a row: connective text, something you may change, or a control
 * for the part of the statement that repeats.
 *
 * `glue` is the grammar's own words — `in`, `then`, a bracket, a comma, a
 * trailing comment — and it is shown rather than hidden, because a rule whose
 * `then` had been replaced by a layout convention would read as a different
 * statement from the one in the file.
 *
 * `add` and `drop` are the arity of a list, made editable. They are parts rather
 * than something the row draws at its end because *where* they go is the point:
 * the ⊖ that takes `paddle2` out of `when ball hits paddle1, paddle2` sits after
 * `paddle2`, and a rule with two lists in it (`hits a, b from above`) has two
 * places to add and they mean different things.
 */
export type Part =
  | { kind: "glue"; text: string }
  | {
      kind: "slot";
      text: string;
      slot: SourceSlot;
      /** The list item this belongs to, where it is inside one. */
      in?: { list: number; item: number };
    }
  /** Append an item to the statement's `list`th list. */
  | { kind: "add"; list: number }
  /** Take item `item` out of it. Only emitted where the grammar allows it. */
  | { kind: "drop"; list: number; item: number };

/** One line of the file, as the editor draws it. */
export type Row =
  /** Nothing on it. Kept: blank lines are how every example game is sectioned. */
  | { kind: "blank"; line: number; text: string }
  /** Only a comment. Editable as the text it is. */
  | { kind: "comment"; line: number; text: string }
  /** Something the parser could not read. Shown as written, never rewritten. */
  | { kind: "raw"; line: number; text: string }
  | {
      kind: "statement";
      line: number;
      text: string;
      /** The registry's spelling, so the row can be looked up for its symbol. */
      keyword: string;
      /** Whatever sits before the statement on the line. */
      indent: string;
      /** The statement past its keyword, tiled. */
      parts: readonly Part[];
      span: StatementSpan;
    };

/**
 * The file's lines, and whether it ended with a newline.
 *
 * The trailing empty string a final newline leaves behind is not a row — it is
 * the newline — and treating it as one would grow the file by a blank line every
 * time anything was appended.
 */
export function splitRows(text: string): { lines: string[]; trailingNewline: boolean } {
  const lines = text.split("\n");
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

/** Put the lines back, keeping the file's own ending. */
export function joinRows(lines: readonly string[], trailingNewline: boolean): string {
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/** Turn a file and its reading into rows, one per line. */
export function rowsOf(text: string, reading: Reading): readonly Row[] {
  const { lines } = splitRows(text);
  const spans = new Map(reading.spans.map((span) => [span.line, span]));
  const commented = new Set(reading.comments.map((comment) => comment.line));

  const rows: Row[] = [];
  let at = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const source = lines[index] as string;
    const start = at;
    at += source.length + 1;

    const span = spans.get(line);
    if (span) {
      rows.push({
        kind: "statement",
        line,
        text: source,
        keyword: span.keyword,
        indent: text.slice(start, span.start),
        parts: partsOf(text, span, start + source.length),
        span,
      });
      continue;
    }
    if (source.trim() === "") rows.push({ kind: "blank", line, text: source });
    else if (commented.has(line)) rows.push({ kind: "comment", line, text: source });
    else rows.push({ kind: "raw", line, text: source });
  }
  return rows;
}

/**
 * Slice a statement into its editable parts and the text between them.
 *
 * It starts past the keyword because the keyword is what the row *is* — an
 * editor shows it as the block's own name and its symbol, and changing it means
 * a different statement rather than a different word. It runs to the end of the
 * line rather than to the end of the statement, so a trailing comment travels
 * with the row it was written beside.
 */
function partsOf(text: string, span: StatementSpan, lineEnd: number): readonly Part[] {
  const marks = markersOf(span);
  const inside = itemsOf(span);
  const parts: Part[] = [];
  let at = span.keywordEnd;
  let next = 0;

  /** Emit everything up to `to`: the markers that fall in it, then the glue. */
  const upTo = (to: number): void => {
    while (next < marks.length && (marks[next] as Marker).at <= to) {
      const mark = marks[next] as Marker;
      if (mark.at > at) {
        parts.push({ kind: "glue", text: text.slice(at, mark.at) });
        at = mark.at;
      }
      parts.push(mark.part);
      next += 1;
    }
    if (to > at) {
      parts.push({ kind: "glue", text: text.slice(at, to) });
      at = to;
    }
  };

  for (const slot of span.slots) {
    upTo(slot.start);
    const held = inside.get(slot);
    parts.push({
      kind: "slot",
      text: text.slice(slot.start, slot.end),
      slot,
      ...(held === undefined ? {} : { in: held }),
    });
    at = slot.end;
  }
  upTo(lineEnd);
  return parts;
}

/** A control, and the offset in the statement it belongs after. */
interface Marker {
  at: number;
  part: Part;
}

/**
 * Where a statement's add and drop controls go, in source order.
 *
 * A ⊖ sits at the end of the item it removes and the ⊕ at the end of the whole
 * clause, which for an *absent* clause is a single point — `when ball hits
 * paddle` has a side list of nothing at all, and the ⊕ after `paddle` is how
 * `from above` is written without typing it.
 *
 * The two halves of a positional `(x, y) as (8, 4)` are one list written twice,
 * so only the first half carries controls: two ⊕s that did the same thing would
 * read as two different things.
 */
function markersOf(span: StatementSpan): readonly Marker[] {
  const marks: Marker[] = [];
  span.lists.forEach((list, index) => {
    if (list.pair !== undefined && list.pair < index) return;
    list.items.forEach((item, at) => {
      if (list.items.length > list.min)
        marks.push({ at: item.end, part: { kind: "drop", list: index, item: at } });
    });
    marks.push({ at: list.end, part: { kind: "add", list: index } });
  });
  // Stable by offset, so a drop and the add that follows it at the same point —
  // a one-item clause — come out in that order.
  return marks
    .map((mark, order) => ({ mark, order }))
    .sort((a, b) => a.mark.at - b.mark.at || a.order - b.order)
    .map(({ mark }) => mark);
}

/** Which list item each slot sits inside, for the slots that sit inside one. */
function itemsOf(span: StatementSpan): ReadonlyMap<SourceSlot, { list: number; item: number }> {
  const held = new Map<SourceSlot, { list: number; item: number }>();
  span.lists.forEach((list, index) => {
    list.items.forEach((item, at) => {
      for (const slot of span.slots) {
        if (slot.start >= item.start && slot.end <= item.end)
          held.set(slot, { list: index, item: at });
      }
    });
  });
  return held;
}

/**
 * What a field may actually put in a slot.
 *
 * Two characters are taken out, and both are cases where keeping them would turn
 * one edit into a different program. A newline would split a statement across two
 * lines, and the language is one statement per line. A quote would close a string
 * it is inside of — and a Demotic string cannot contain one at all, since the
 * lexer ends the literal at the first it meets, so there is nothing to escape it
 * with.
 *
 * It is exported so a caller can see that it *did* something. Silently dropping a
 * character somebody typed is the kind of small wrongness that reads as the
 * keyboard being broken; the editor compares and says so.
 */
export function slotValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/["']/g, "");
}

/** Write a value into one slot, and change nothing else in the file. */
export function setSlot(text: string, slot: SourceSlot, value: string): string {
  return text.slice(0, slot.start) + slotValue(value) + text.slice(slot.end);
}

/** One rewritten range. Two of them at most, and they never overlap. */
interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Apply rewrites back to front, so an earlier one cannot move a later one. */
function spliced(text: string, edits: readonly Splice[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** Where a new item goes, and what it says. */
function grown(list: SourceList): Splice {
  const last = list.items[list.items.length - 1];
  // An empty clause is written whole — `from above` brings its own `from` — and
  // one that has items already grows by a separator and a template.
  if (last === undefined) return { start: list.start, end: list.end, text: list.opener };
  return { start: last.end, end: last.end, text: list.separator + list.template };
}

/** What taking item `index` out costs, or nothing if the grammar needs it. */
function shrunk(list: SourceList, index: number): Splice | undefined {
  const item = list.items[index];
  if (item === undefined || list.items.length <= list.min) return undefined;
  // The last one takes the whole clause with it, which is what makes `from
  // above` reversible: the word that introduced it goes too.
  if (list.items.length === 1) return { start: list.start, end: list.end, text: "" };
  const before = list.items[index - 1];
  const after = list.items[index + 1];
  return before === undefined
    ? { start: item.start, end: (after as SourceRange).start, text: "" }
    : { start: before.end, end: item.end, text: "" };
}

/**
 * The lists an operation touches: the one asked for, and its other half.
 *
 * `(x, y) as (8, 4)` is one list of assignments written as two, and the language
 * says so — `E_ARITY` is what it calls the two drifting apart. So growing one
 * grows both, in one edit, and a file is never left in the state the error names.
 */
function bothHalves(span: StatementSpan, index: number): readonly SourceList[] {
  const list = span.lists[index];
  if (list === undefined) return [];
  const twin = list.pair === undefined ? undefined : span.lists[list.pair];
  return twin === undefined ? [list] : [list, twin];
}

/** Append an item to a statement's `index`th list. */
export function addItem(text: string, span: StatementSpan, index: number): string {
  const halves = bothHalves(span, index);
  if (halves.length === 0) return text;
  return spliced(text, halves.map(grown));
}

/** Take item `item` out of it — or leave the file alone where it may not go. */
export function removeItem(text: string, span: StatementSpan, index: number, item: number): string {
  const halves = bothHalves(span, index);
  const edits = halves.map((list) => shrunk(list, item));
  if (edits.length === 0 || edits.some((edit) => edit === undefined)) return text;
  return spliced(text, edits as Splice[]);
}

/**
 * Diagnostics, sorted onto the rows they are about.
 *
 * A block editor's answer to "what is wrong" is **where** it is wrong: the
 * message belongs against the row, not in a list underneath that names a line
 * number you then have to go and count to. So this splits them.
 *
 * `loose` is the remainder, and it is not an edge case — it is how the suite
 * editor reports that the *game* will not compile, which is a real reason a suite
 * can never pass and which names no row in the file on screen. Anything left
 * without a row is shown at the top of the list rather than dropped, because a
 * diagnostic nothing displays is worse than one displayed in the wrong place.
 */
export interface Problems {
  /** Diagnostics against a row, keyed by its index in the row list. */
  byRow: ReadonlyMap<number, readonly Diagnostic[]>;
  /** Diagnostics naming no row in this file. */
  loose: readonly Diagnostic[];
  /** Row indices with an error, in order — what "go to the next problem" walks. */
  rowsWithErrors: readonly number[];
  errors: number;
  warnings: number;
}

/** Sort `diagnostics` onto `rowCount` rows. */
export function problemsOf(diagnostics: readonly Diagnostic[], rowCount: number): Problems {
  const byRow = new Map<number, Diagnostic[]>();
  const loose: Diagnostic[] = [];
  let errors = 0;
  let warnings = 0;

  for (const one of diagnostics) {
    if (one.severity === "error") errors += 1;
    else warnings += 1;
    const index = one.line - 1;
    if (index < 0 || index >= rowCount) {
      loose.push(one);
      continue;
    }
    const at = byRow.get(index);
    if (at) at.push(one);
    else byRow.set(index, [one]);
  }

  const rowsWithErrors = [...byRow.entries()]
    .filter(([, list]) => list.some((one) => one.severity === "error"))
    .map(([index]) => index)
    .sort((a, b) => a - b);

  return { byRow, loose, rowsWithErrors, errors, warnings };
}

/**
 * Move a row to sit in front of another.
 *
 * **A drag is an edit, not a rearrangement** (doc 19). Entities live in
 * declaration order, so moving a `create` changes what is drawn over what and
 * which sprite the hardware drops first past its per-scanline budget; rules apply
 * in declaration order within a tick phase. Nothing here sorts, groups or tidies
 * on its own for exactly that reason.
 *
 * `before` is an index in the list as it stands, and the list's length means "at
 * the end" — which is what a drop below the last row is.
 */
export function moveRow(text: string, from: number, before: number): string {
  const { lines, trailingNewline } = splitRows(text);
  if (from < 0 || from >= lines.length) return text;
  const [row] = lines.splice(from, 1);
  const at = Math.max(0, Math.min(lines.length, before > from ? before - 1 : before));
  lines.splice(at, 0, row as string);
  return joinRows(lines, trailingNewline);
}

/** Take one row out. */
export function removeRow(text: string, at: number): string {
  const { lines, trailingNewline } = splitRows(text);
  if (at < 0 || at >= lines.length) return text;
  lines.splice(at, 1);
  return joinRows(lines, trailingNewline);
}

/** Put a line in front of the row at `before`; the list's length appends. */
export function insertRow(text: string, before: number, line: string): string {
  const { lines, trailingNewline } = splitRows(text);
  const at = Math.max(0, Math.min(lines.length, before));
  lines.splice(at, 0, line);
  return joinRows(lines, trailingNewline);
}

/**
 * The line a palette entry drops in.
 *
 * The registry's own `example`, which is the honest generated default: it is
 * already there for the reference page, it is always a statement of that shape,
 * and it names things a real game names rather than angle brackets nobody can
 * run. What it names may not exist in *this* project, and that is a diagnostic
 * against the new row rather than a reason to invent a template — the editor
 * offers, `check()` validates (doc 19).
 */
export function templateFor(spec: StatementSpec): string {
  return spec.example;
}

/** The asset kinds a slot can hold, so a caller can list the project's files. */
const ASSET_SLOTS: Readonly<Record<string, AssetKind>> = {
  art: "art",
  music: "music",
  sound: "sound",
  level: "level",
};

/** Which kind of file this slot names, when it names one. */
export function assetKindOf(kind: SlotKind): AssetKind | undefined {
  return ASSET_SLOTS[kind];
}

/**
 * The property a value slot sets, when the registry documents one.
 *
 * `PROPERTIES` already says whether a property holds a number, an asset or a
 * string, whether it is derived and whether it may only be set at creation — so
 * an editor can offer the right control and the right list without knowing what
 * any of them mean (doc 19 §The palette is generated).
 */
export function propertyOf(slot: SourceSlot): PropertySpec | undefined {
  return slot.prop === undefined
    ? undefined
    : PROPERTIES.find((property) => property.name === slot.prop);
}

/**
 * The names a program has given itself, for the fields that offer them.
 *
 * Read off the spans rather than off a compile, and that is deliberate: a file
 * being edited is a file that does not compile every second keystroke, and a
 * dropdown that emptied itself the moment a rule below it was half-typed would
 * be a dropdown nobody could use. A `create` line is a `create` line whether or
 * not the class it names exists yet.
 */
export interface Vocabulary {
  scenes: readonly string[];
  classes: readonly string[];
  instances: readonly string[];
  /** Whatever a collision may name: objects, classes, tiles and screen edges. */
  entities: readonly string[];
}

/** Read a program's own names out of its rows. `tiles` come from its levels. */
export function vocabularyOf(
  text: string,
  reading: Reading,
  tiles: readonly string[] = [],
): Vocabulary {
  const scenes: string[] = [];
  const classes: string[] = [];
  const instances: string[] = [];
  for (const span of reading.spans) {
    const named = span.slots.find((slot) => slot.kind === "name" || slot.kind === "scene-name");
    if (named === undefined) continue;
    const name = text.slice(named.start, named.end);
    if (span.keyword === "scene") scenes.push(name);
    else if (span.keyword === "create object") classes.push(name);
    else if (span.keyword === "create") instances.push(name);
  }
  // `number` and `text` are classes every program has without declaring them,
  // which is why `E_RESERVED_CLASS` exists to stop one being redeclared.
  const allClasses = unique([...classes, "number", "text"]);
  return {
    scenes: unique(scenes),
    classes: allClasses,
    instances: unique(instances),
    entities: unique([...instances, ...allClasses, ...tiles, ...EDGE_NAMES]),
  };
}

function unique(names: readonly string[]): readonly string[] {
  return [...new Set(names)].sort();
}

/**
 * The properties worth offering where one is named.
 *
 * Derived properties are readable and never assignable, so a list that offered
 * `centerx` as somewhere to write would be offering `E_UNKNOWN_PROP`. Everything
 * else is offered, `createOnly` included, because whether *this* statement is a
 * creation is a question about the row and `check()` answers it either way.
 */
export function assignableProperties(): readonly PropertySpec[] {
  return PROPERTIES.filter((property) => !property.derived);
}
