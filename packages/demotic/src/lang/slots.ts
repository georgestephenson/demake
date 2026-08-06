/**
 * Where a statement's editable parts are, and what each one means.
 *
 * This is what a block editor needs and nothing else has: the parser already
 * decides that the word after `backdrop` is a picture and the word after `in` is
 * a scene, and it threw that away as soon as it had built the AST. A slot is that
 * decision kept — a source range with a name for what may go in it.
 *
 * **It is a side channel, exactly like the lexer's comment ranges.** `lex.ts`
 * records comments the parser has no use for so `highlight.ts` can colour source
 * without a second scanner; this records slots the *compiler* has no use for so an
 * editor can offer fields without a second parser. The alternative is a page-side
 * walk over the same tokens deciding the same things a second time, which is the
 * duplication doc 07 forbids for conversion logic and doc 19 forbids for the
 * language — and it would be wrong the first time a statement changed shape.
 *
 * Two properties make it safe to edit through:
 *
 * 1. **Slots are source ranges, so an edit is a splice.** Setting a field
 *    rewrites those bytes and nothing else — not the line around it, not its
 *    comment, not its spacing. That is stronger than a round trip through a model
 *    and it is what lets a block editor open a hand-written file.
 * 2. **They never overlap and they are in source order**, so a caller can slice a
 *    line into "the parts you may change" and "the text between them" and put it
 *    back together by concatenation. `packages/demotic/test/slots.test.ts` checks
 *    that reassembly is byte-identical for every `.dmt` in the repository.
 *
 * A slot is an *offer*, never a rule. Whether the name in a `scene` slot is a
 * scene that exists is `check()`'s question, and an editor that answered it here
 * would be a second front end (doc 19 §It offers; it does not validate).
 */

import { BUTTON_NAMES, DIRECTIONS, SIDES } from "./spec.js";

/**
 * What may go in a slot.
 *
 * Each name says where the choices come from rather than what they mean: `art`,
 * `music`, `sound` and `level` are {@link AssetKind}s so a caller can filter a
 * project's files by one directly, and `button`, `side`, `direction`, `mode`,
 * `axis`, `verb` and `edge` are closed sets the language registry already lists.
 */
export type SlotKind =
  /** A reference to a scene declared elsewhere. */
  | "scene"
  /** A scene being declared, so the name is the author's to choose. */
  | "scene-name"
  /** Any other identifier being declared: a class, an instance, a level. */
  | "name"
  /** A reference to a class declared by `create object`. */
  | "class"
  /** An object, a class or a screen edge — whatever a collision may name. */
  | "entity"
  /** A property name, in a list or as an assignment target. */
  | "property"
  /** One of `BUTTONS`. */
  | "button"
  /** One of `SIDES`. */
  | "side"
  /** One of `DIRECTIONS`. */
  | "direction"
  /** A control's timing: `hold`, `press` or `release`. */
  | "mode"
  /** A stream's layout: `wide` or `tall`. */
  | "axis"
  /** A collision's timing: `hits` or `touches`. */
  | "verb"
  /** A button edge: `pressed` or `released`. */
  | "edge"
  /** A picture, from the project's art files. */
  | "art"
  /** A track, from the project's music files. */
  | "music"
  /** An effect, from the project's sound files. */
  | "sound"
  /** A `.dmtl`, from the project's levels. */
  | "level"
  /** A whole expression — the one part of the language a block cannot mirror. */
  | "expression"
  /** A bare number with no unit of its own (a seed, a chunk count). */
  | "number"
  /** A duration's unit: `ticks` or `seconds`. */
  | "duration-unit"
  /** The contents of a string literal, quotes excluded. */
  | "string"
  /** Free prose: a test case's name. */
  | "title";

/** One editable part of a statement. */
export interface SourceSlot {
  kind: SlotKind;
  /** 1-indexed source line. Statements never span lines, so this is the row. */
  line: number;
  /** Offset of the slot's first character in the source. */
  start: number;
  /** Offset one past its last character. */
  end: number;
  /**
   * The property this value belongs to, on an `expression`, `string`, `art` or
   * `direction` slot that is a property's value.
   *
   * It is what lets a caller ask `PROPERTIES` which control to draw without
   * knowing anything about the statement it is in — the registry already says
   * whether `sprite` is an asset and whether `value` is a number (doc 19 §The
   * palette is generated).
   */
  prop?: string;
}

/**
 * One statement, as a row an editor can draw.
 *
 * `keyword` is spelled the way `STATEMENTS` spells it — `create object` rather
 * than `create` — so a caller can look the row up in the registry for its
 * summary, its syntax line and its symbol, and keeps no list of statements of its
 * own.
 */
export interface StatementSpan {
  keyword: string;
  line: number;
  /** Offsets of the whole statement: its first character to its last. */
  start: number;
  end: number;
  /**
   * Offset one past the keyword itself.
   *
   * Recorded rather than derived from `keyword.length`, because the keyword's
   * *spelling* need not be its source text: `create object` is two words with
   * whatever spacing the author used between them, and a caller that assumed one
   * space would slice a program at the wrong character the first time somebody
   * lined a file up in columns.
   */
  keywordEnd: number;
  /** Its editable parts, in source order and never overlapping. */
  slots: readonly SourceSlot[];
}

/**
 * The words a closed-set slot may hold, in the order a picker should list them.
 *
 * Here rather than in the page for the reason everything else about the grammar
 * is: these are the language's own words, and a second list of them is a list
 * that goes stale the day one changes. Where a registry already holds the set —
 * buttons, sides, compass headings — it *is* the set; where the set is the
 * grammar's own connective words, it is written once and
 * `packages/demotic/test/slots.test.ts` checks every one of them against
 * `KEYWORDS`, so a word cannot be offered here that the reference does not
 * document.
 *
 * `duration-unit` is the one entry with no `KEYWORDS` behind it, because it is a
 * *suite's* vocabulary rather than a game's: `seconds` and `ticks` mean nothing
 * inside a `.dmt`.
 */
export const SLOT_CHOICES: Readonly<Partial<Record<SlotKind, readonly string[]>>> = {
  button: BUTTON_NAMES,
  side: SIDES.map((side) => side.name),
  direction: DIRECTIONS.map((heading) => heading.name),
  verb: ["hits", "touches"],
  edge: ["pressed", "released"],
  mode: ["hold", "press", "release"],
  axis: ["wide", "tall"],
  "duration-unit": ["seconds", "ticks"],
};
