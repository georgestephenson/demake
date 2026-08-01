/**
 * The plain text editor (doc 19 §The Demakefile is also just a file).
 *
 * What opens for a file in the project that no demaker demakes — the Demakefile,
 * a `.md`, a golden `.trace`, a note somebody left. It is the smallest editor in
 * the site on purpose: a textarea over the project's own text, and the exact
 * same `SourceEditor` the game and the level use, so a file edited here goes
 * back through `onEdit` and is saved, zipped and built like anything else.
 *
 * **The Demakefile gets colours, and they are the engine's.** `.dmt` has
 * `highlight()` and a Demakefile now has `highlightDemakefile()`, both driven by
 * the grammar's own word lists in `@demake/demotic`; this module chooses between
 * them by filename and supplies neither. A page-side lexer for a format the
 * engine also parses is doc 07's forbidden second implementation, one file type
 * along from where that rule was first written.
 *
 * **A file with no grammar is drawn plain rather than approximately.** Guessing
 * at Markdown or JSON with a regular expression here would be exactly the thing
 * the paragraph above refuses, for a smaller prize.
 */

import { useMemo } from "preact/hooks";

import { highlightDemakefile } from "@demake/demotic";

import { SourceEditor } from "../components/SourceEditor.js";
import { DEMAKEFILE } from "../lib/demakefile.js";
import { readText } from "../lib/project.js";
import type { EditorProps } from "../site.js";

/**
 * Whether these bytes are text at all.
 *
 * `route.ts` decides by extension, which is right for routing and cannot be
 * right for everything: a file called `notes.txt` holding a PNG exists. A NUL
 * byte is the same test every editor and `git` uses, and the answer here is
 * read-only rather than refuse-to-open — showing somebody their file and
 * declining to mangle it beats an empty pane.
 */
function looksBinary(bytes: Uint8Array): boolean {
  for (let at = 0; at < Math.min(bytes.length, 4096); at += 1) {
    if (bytes[at] === 0) return true;
  }
  return false;
}

export function TextEditor({ project, path, onEdit }: EditorProps) {
  const openPath = path ?? "";
  const text = readText(project, openPath);
  const binary = looksBinary(project.files.get(openPath)?.bytes ?? new Uint8Array());

  // **There is no draft here, and that is the point.** The game section keeps
  // one because a keystroke there costs a compile, and it pays for it: a rename
  // inside the settling window moves the file out from under the pending write
  // and the edit is lost. This editor's whole downstream cost is an encode and a
  // lex of a few kilobytes, so the project *is* the model — every keystroke
  // lands in it, and there is no window for a file operation to race with.
  const name = openPath.slice(openPath.lastIndexOf("/") + 1);
  const isDemakefile = name === DEMAKEFILE;
  const spans = useMemo(
    () => (isDemakefile ? highlightDemakefile(text) : undefined),
    [text, isDemakefile],
  );

  return (
    <main class="text-layout">
      <section class="pane">
        <h2>{openPath === "" ? "Text" : openPath}</h2>
        {binary ? (
          <p class="hint">
            This file is not text — it holds a zero byte — so it is shown as it is and cannot be
            edited here.
          </p>
        ) : null}
        <SourceEditor
          value={text}
          onInput={(next) => onEdit(openPath, next)}
          label={`${name === "" ? "File" : name} source`}
          {...(spans === undefined ? {} : { spans })}
          readOnly={binary}
        />
        <p class="hint">
          {isDemakefile
            ? "The build file (doc 15): how this project reaches hardware, and never what the game does. The art demaker's controls write into it, and this is the same file."
            : "A plain text file in the project. It is saved, zipped and built with everything else."}
        </p>
      </section>
    </main>
  );
}
