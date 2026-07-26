/**
 * The game source, coloured, and still an ordinary `<textarea>`.
 *
 * The technique is the conventional one for editable highlighted text: a `<pre>`
 * carrying the colours, and a transparent `<textarea>` stacked exactly on top of
 * it doing the editing. The page keeps native editing, native selection, native
 * spellcheck-off, native mobile keyboards and the accessibility tree a plain
 * textarea has — none of which a `contenteditable` re-implementation gets for
 * free, and all of which the section's tests already depend on.
 *
 * **Two rules keep the two layers aligned**, and both are load-bearing:
 *
 * 1. They are stacked as one CSS grid cell, so the row is sized by the taller of
 *    them — the `<pre>` — and the wrapper is what scrolls. Neither element
 *    scrolls on its own, so there is no scroll position to synchronise and, more
 *    importantly, no scrollbar inside either one: a scrollbar in the textarea
 *    alone would narrow its lines and move every wrap point by a few characters.
 * 2. Every glyph must be the same size in both layers. The stylesheet gives them
 *    one font shorthand and no `font-weight` or `font-style` per scope, because
 *    a bold keyword in a fallback font is a wider keyword, and the two layers
 *    would drift apart along the line.
 *
 * The grammar comes from `@demake/demotic` (`highlight()`), not from a regular
 * expression here. A second description of the language living in the page is
 * exactly what doc 07 §The web app must never grow conversion logic forbids, and
 * the registry is what makes one description enough.
 */

import { useMemo } from "preact/hooks";

import { highlight } from "@demake/demotic";

export function SourceEditor({
  value,
  onInput,
  label,
}: {
  value: string;
  onInput: (next: string) => void;
  label: string;
}) {
  // Colouring is a lex of a few kilobytes — well under a frame, and cheaper than
  // the compile that already runs on every keystroke beside it.
  const spans = useMemo(() => highlight(value), [value]);

  return (
    <div class="source-editor">
      <pre class="source-highlight" aria-hidden="true">
        {spans.map((span, index) =>
          span.scope ? (
            <span key={index} data-scope={span.scope}>
              {span.text}
            </span>
          ) : (
            span.text
          ),
        )}
        {/* A `<pre>` swallows one trailing newline; the textarea does not. Without
            this the last line of a file that ends in a newline sits one row high. */}
        {"\n"}
      </pre>
      <textarea
        class="source-input"
        aria-label={label}
        spellcheck={false}
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        rows={1}
        value={value}
        onInput={(event) => onInput((event.target as HTMLTextAreaElement).value)}
      />
    </div>
  );
}
