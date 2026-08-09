/**
 * A little symbol per statement (doc 19 §The palette is generated, and so are
 * the choices).
 *
 * **Grammar in the engine, theme in the page.** `@demake/demotic` names no
 * colour and it names no icon either, so the symbols live here, keyed off the
 * registry's own keyword — the same seam the syntax highlighter runs on, where
 * the engine says *what* a word is and the stylesheet says what it looks like.
 *
 * The table is keyed by keyword rather than by statement kind because that is
 * what `STATEMENTS` and `TEST_STATEMENTS` are keyed by: a statement added to
 * either registry appears in the palette the day it lands, and
 * `packages/web/test/symbols.test.ts` fails if it landed without a symbol. A
 * palette that silently drew a blank square would be the registry growing and the
 * page quietly not keeping up, which is the failure the derivation exists to
 * prevent.
 *
 * They are drawn rather than written: an emoji is a different picture in every
 * font on every platform, and half of them are a different *size*, which in a
 * column of rows is the one thing that reads as broken.
 */

/**
 * One symbol, as paths on a 16×16 grid.
 *
 * `fill` is drawn solid and `line` is stroked, so a shape can be either without
 * a second attribute per entry. Everything uses `currentColor`, which is what
 * lets the stylesheet tint a row by what it is.
 */
interface Glyph {
  fill?: string;
  line?: string;
}

const GLYPHS: Readonly<Record<string, Glyph>> = {
  // A game: the play triangle every machine in the set boots into.
  start: { fill: "M5 3 L13 8 L5 13 Z" },
  // A seed: a sown speck and the rays that come of it.
  seed: {
    fill: "M8 6.6 a1.4 1.4 0 1 1 0 2.8 a1.4 1.4 0 1 1 0-2.8",
    line: "M8 2v2M8 12v2M2 8h2M12 8h2M4 4l1.4 1.4M10.6 10.6L12 12M12 4l-1.4 1.4M5.4 10.6L4 12",
  },
  // A scene: the screen it happens on.
  scene: { line: "M2.5 3.5h11v9h-11z M2.5 6h11" },
  // A class: the outline an object is stamped from.
  "create object": {
    line: "M3 3.5h4M9 3.5h4M12.5 4v3M12.5 9v3M13 12.5h-4M7 12.5H3M3.5 12v-3M3.5 7V4",
  },
  // An object: the stamp itself.
  create: { fill: "M3.5 3.5h9v9h-9z" },
  // A level: cells.
  level: { line: "M2.5 3.5h11v9h-11z M6 3.5v9M10 3.5v9M2.5 8.5h11" },
  // A stream: chunks laid end to end, drawn in an order nobody wrote down.
  stream: { line: "M2.5 4.5h4v7h-4z M9.5 4.5h4v7h-4z", fill: "M7.4 7.4h1.2v1.2h-1.2z" },
  // A backdrop: a picture behind everything.
  backdrop: {
    line: "M2.5 3.5h11v9h-11z",
    fill: "M3.5 11.5 L6.5 7 L9 10 L10.5 8.5 L12.5 11.5 Z M10.8 5.2a1 1 0 1 1 0 2a1 1 0 1 1 0-2",
  },
  // Music: a note.
  music: {
    line: "M6.5 12V4l6-1.5v8",
    fill: "M4.8 10.4a1.8 1.4 0 1 1 1.7 1.9a1.8 1.4 0 1 1-1.7-1.9 M10.8 8.9a1.8 1.4 0 1 1 1.7 1.9a1.8 1.4 0 1 1-1.7-1.9",
  },
  // A sound effect: a source and what comes out of it.
  sound: {
    fill: "M2.5 6.5h2.5L8 4v8L5 9.5H2.5z",
    line: "M10.3 6.2a3 3 0 0 1 0 3.6M12.4 4.4a5.6 5.6 0 0 1 0 7.2",
  },
  // A camera: what it is pointed at.
  camera: {
    line: "M8 2.5v2.6M8 10.9v2.6M2.5 8h2.6M10.9 8h2.6 M8 4.6a3.4 3.4 0 1 1 0 6.8a3.4 3.4 0 1 1 0-6.8",
  },
  // A control: the pad it is bound to.
  control: { fill: "M6.2 2.5h3.6v3.7h3.7v3.6H9.8v3.7H6.2V9.8H2.5V6.2h3.7z" },
  // A rule: something happening.
  when: { fill: "M9.5 1.8 L4 8.8h3.2L6.5 14.2L12 7.2H8.8z" },

  // --- a suite's statements -------------------------------------------------
  // A case: a claim, ticked.
  test: { line: "M8 2.2a5.8 5.8 0 1 1 0 11.6a5.8 5.8 0 1 1 0-11.6 M5.3 8.2l2 2l3.4-4" },
  // Playing on with nobody touching anything.
  play: { fill: "M3 3.5 L8 8 L3 12.5 Z M8.5 3.5 L13.5 8 L8.5 12.5 Z" },
  // A press: down and straight back up.
  press: { line: "M8 2.5v6", fill: "M5.6 7.6 L8 10.8 L10.4 7.6 Z M3.5 12h9v1.6h-9z" },
  // A hold: down, and kept there.
  hold: {
    line: "M8 2.5v6",
    fill: "M5.6 7.6 L8 10.8 L10.4 7.6 Z M3.5 12h9v1.6h-9z M2 4.4h2.4v1.4H2z M11.6 4.4H14v1.4h-2.4z",
  },
  // An assertion: the two sides that have to balance.
  expect: { line: "M3 6h10M3 10h10" },
};

/** Whether this keyword has a symbol — what the registry check asks. */
export function hasSymbol(keyword: string): boolean {
  return keyword in GLYPHS;
}

/** Every keyword drawn, so a symbol left behind by a removed statement shows up. */
export const KEYWORDS_DRAWN = Object.keys(GLYPHS) as readonly string[];

/**
 * The symbol for a statement.
 *
 * A keyword with none draws an empty frame rather than nothing: the row still
 * has to line up with the rows around it, and a missing symbol is a thing to
 * notice rather than a gap to hide. The test above is what stops one shipping.
 */
export function StatementSymbol({ keyword }: { keyword: string }) {
  const glyph = GLYPHS[keyword];
  return (
    <svg
      class="block-symbol"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      {glyph === undefined ? (
        <rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="currentColor" />
      ) : (
        <>
          {glyph.fill ? <path d={glyph.fill} fill="currentColor" /> : null}
          {glyph.line ? (
            <path
              d={glyph.line}
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          ) : null}
        </>
      )}
    </svg>
  );
}
