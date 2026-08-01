/**
 * Go to file (doc 07 §The workbench).
 *
 * The one navigation an explorer is bad at: a project with forty files in six
 * folders is faster to type at than to point at. Nothing here knows what any
 * file *is* — it filters paths and hands one back — which is why it is a
 * component and not a section.
 *
 * The match is a subsequence of the path, lower-cased, which is what every
 * editor's quick-open does and the reason `pbs` finds `art/pong.breakout.svg`.
 * Ranking is deliberately absent: the list is the project's own sorted order, so
 * the same query always offers the same first answer, and a scoring function
 * nobody can predict is worse than an order everybody can.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

/** Whether every character of `query` appears in `text`, in order. */
export function subsequence(query: string, text: string): boolean {
  let at = 0;
  for (const character of query) {
    at = text.indexOf(character, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/** The paths a query offers, in the list's own order. */
export function filterPaths(paths: readonly string[], query: string): readonly string[] {
  const wanted = query.trim().toLowerCase().replace(/\s+/g, "");
  if (wanted === "") return paths;
  return paths.filter((path) => subsequence(wanted, path.toLowerCase()));
}

export function QuickOpen({
  paths,
  onOpen,
  onClose,
}: {
  paths: readonly string[];
  onOpen: (path: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => input.current?.focus(), []);

  const matched = filterPaths(paths, query);
  // Clamped rather than reset: typing a character that shortens the list should
  // leave the selection on something, and the top is the only safe something.
  const selected = Math.min(index, Math.max(0, matched.length - 1));

  const pick = (path: string | undefined): void => {
    if (path === undefined) return;
    onOpen(path);
    onClose();
  };

  return (
    <div class="quick-open-backdrop" onPointerDown={onClose}>
      <div
        class="quick-open"
        role="dialog"
        aria-label="Go to file"
        data-testid="quick-open"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <input
          ref={input}
          class="quick-open-input"
          aria-label="Go to file"
          placeholder="Go to file…"
          spellcheck={false}
          autocomplete="off"
          value={query}
          onInput={(event) => {
            setQuery((event.currentTarget as HTMLInputElement).value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex(Math.min(selected + 1, matched.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex(Math.max(selected - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              pick(matched[selected]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <ul class="quick-open-list">
          {matched.slice(0, 40).map((path, at) => (
            <li key={path}>
              <button
                type="button"
                class={`quick-open-item${at === selected ? " active" : ""}`}
                onClick={() => pick(path)}
              >
                <span class="quick-open-name">{path.slice(path.lastIndexOf("/") + 1)}</span>
                <span class="quick-open-path">{path}</span>
              </button>
            </li>
          ))}
          {matched.length === 0 ? <li class="quick-open-empty">No matching file</li> : null}
        </ul>
      </div>
    </div>
  );
}
