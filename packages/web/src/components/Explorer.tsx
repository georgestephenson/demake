/**
 * The project explorer (doc 19 §The shell, doc 07 §The workbench).
 *
 * A directory listing that is also the router: clicking a file opens the editor
 * for its type, and that is the whole navigation model. It shows only the
 * folders a project has something in — a tree of four empty directories teaches
 * nothing about the project.
 *
 * It knows nothing about what any editor does. Its only claim about a file is
 * which section opens it, which comes from the file's own extension
 * (`sectionForFile`), so a project with an unrecognised file lists it greyed out
 * rather than hiding it: a file you cannot see is a file you think you lost.
 *
 * **It manages files now**, which doc 19 originally deferred. What changed the
 * answer is that the page stopped being a viewer with a picker on the side and
 * became the workspace: a folder you can edit but not add to is a folder you
 * have to leave to do half the work, and the operations themselves are three
 * lines each over an immutable map (`lib/project.ts`). Two rules keep them
 * honest and both are the model's rather than this component's:
 *
 * - **A move and a rename are one gesture**, because a project is a flat map
 *   from path to bytes and a folder is a convention in the names (doc 19 §The
 *   layout). Typing `sprites/ball.svg` over `art/ball.svg` moves it, and so does
 *   dropping it on another folder.
 * - **Nothing is replaced silently.** A rename onto an occupied path and a
 *   delete of a file that is open are both reported rather than performed
 *   quietly, because those are the two that cannot be undone.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

import { fileHash, sectionForFile } from "../lib/route.js";
import { filesIn, folders, normalisePath, type Project } from "../lib/project.js";

/** How a folder is described when it is one of the canonical five. */
const FOLDER_NOTES: Readonly<Record<string, string>> = {
  src: "the game",
  art: "pictures and sprites",
  music: "tracks",
  sound: "effects",
  levels: "rooms",
};

/** What the explorer is asking the user to type, and where it started. */
interface Editing {
  /** The path being renamed, or `""` when a new file is being named. */
  from: string;
  /** What is in the box. */
  text: string;
}

export function Explorer({
  project,
  open,
  onOpen,
  onMove,
  onDelete,
  onCreate,
  onNotice,
  creating,
  renaming,
  onRequestHandled,
}: {
  project: Project;
  /** The path currently open, so it can be marked. */
  open?: string;
  /** Open a file — the same navigation the anchors perform, for the keyboard. */
  onOpen: (path: string) => void;
  /** Move a file, which is also how one is renamed. */
  onMove: (from: string, to: string) => void;
  onDelete: (path: string) => void;
  /** Create an empty file at a path. */
  onCreate: (path: string) => void;
  /** Say something the user needs to read — a refused rename, mostly. */
  onNotice: (message: string) => void;
  /**
   * A folder the menu bar asked for a new file in, or `""` for the project root.
   *
   * The File menu and the explorer's own `+` are the same gesture, so they open
   * the same inline box rather than the menu growing a dialog of its own.
   */
  creating?: string;
  /** A path the menu bar asked to rename. */
  renaming?: string;
  /** Told once either request has been taken up, so it does not fire twice. */
  onRequestHandled: () => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const box = useRef<HTMLInputElement | null>(null);

  // The menu bar's New File and Rename open the same boxes the row's own buttons
  // do, rather than the menu growing dialogs of its own. It asks by setting a
  // prop because the alternative — reaching into this component's DOM for the
  // right button — needs the path in a CSS selector, and a path is a string
  // somebody typed.
  useEffect(() => {
    if (creating !== undefined)
      setEditing({ from: "", text: creating === "" ? "" : `${creating}/` });
    else if (renaming !== undefined) setEditing({ from: renaming, text: renaming });
    else return;
    onRequestHandled();
  }, [creating, renaming, onRequestHandled]);

  // Focus lands in the box whenever one opens, with the *stem* selected: the
  // folder and the extension are usually right and the name usually is not,
  // which is what every editor's rename does.
  //
  // Keyed on which file is being renamed rather than on the text, or every
  // keystroke would reselect what was just typed.
  useEffect(() => {
    const element = box.current;
    if (!element || editing === null) return;
    element.focus();
    const name = editing.text.slice(editing.text.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    const start = editing.text.length - name.length;
    element.setSelectionRange(start, start + (dot > 0 ? dot : name.length));
  }, [editing === null, editing?.from]);

  const commit = (): void => {
    if (editing === null) return;
    const to = normalisePath(editing.text);
    setEditing(null);
    if (to === undefined) {
      if (editing.text.trim() !== "") onNotice(`'${editing.text}' is not a path in this project.`);
      return;
    }
    if (to === editing.from) return;
    if (project.files.has(to)) {
      onNotice(`'${to}' already exists — nothing was overwritten.`);
      return;
    }
    if (editing.from === "") onCreate(to);
    else onMove(editing.from, to);
  };

  const nameBox = (): JSX.Element => (
    <input
      ref={box}
      class="explorer-rename"
      aria-label={editing?.from === "" ? "New file path" : "New path for the file"}
      data-testid="explorer-rename"
      value={editing?.text ?? ""}
      spellcheck={false}
      autocomplete="off"
      onInput={(event) =>
        setEditing((current) =>
          current === null
            ? null
            : { ...current, text: (event.currentTarget as HTMLInputElement).value },
        )
      }
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setEditing(null);
        }
      }}
      onBlur={commit}
    />
  );

  return (
    // `id` so the title bar's toggle can name what it opens and closes; the
    // element is only in the document while the tree is showing, which is what a
    // disclosure's `aria-controls` describes.
    <aside id="explorer" class="explorer" aria-label="Project">
      <div class="explorer-head">
        <h2 class="explorer-title">{project.name}</h2>
        <button
          type="button"
          class="explorer-icon"
          title="New file"
          aria-label="New file"
          data-testid="new-file"
          onClick={() => setEditing({ from: "", text: "" })}
        >
          +
        </button>
      </div>

      <nav class="explorer-tree" aria-label="Files">
        {/*
          A new file is named at the top of the tree rather than inside whichever
          folder it will land in, and there is exactly one box on screen at a
          time. Rendering it in two candidate places instead — the tree and the
          matching folder — meant the *element* moved as soon as the typed path
          gained a slash, which blurs the input, which commits it: the file ended
          up called `D`.
        */}
        {editing?.from === "" ? <div class="explorer-row">{nameBox()}</div> : null}

        {folders(project).map((folder) => (
          <section
            key={folder}
            class={`explorer-folder${dropTarget === folder ? " drop" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDropTarget(folder);
            }}
            onDragLeave={() => setDropTarget((current) => (current === folder ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              setDropTarget(null);
              const from = event.dataTransfer?.getData("text/plain");
              if (!from || !project.files.has(from)) return;
              const name = from.slice(from.lastIndexOf("/") + 1);
              const to = folder === "" ? name : `${folder}/${name}`;
              if (to === from) return;
              if (project.files.has(to)) {
                onNotice(`'${to}' already exists — nothing was overwritten.`);
                return;
              }
              onMove(from, to);
            }}
          >
            <h3>
              <span>{folder === "" ? "/" : folder}</span>
              {FOLDER_NOTES[folder] ? (
                <span class="explorer-note">{FOLDER_NOTES[folder]}</span>
              ) : null}
              <button
                type="button"
                class="explorer-icon"
                title={`New file in ${folder === "" ? "the project root" : folder}`}
                aria-label={`New file in ${folder === "" ? "the project root" : folder}`}
                onClick={() => setEditing({ from: "", text: folder === "" ? "" : `${folder}/` })}
              >
                +
              </button>
            </h3>
            <ul>
              {filesIn(project, folder).map((path) => {
                const section = sectionForFile(path);
                const name = path.slice(path.lastIndexOf("/") + 1);
                if (editing?.from === path) {
                  return (
                    <li key={path} class="explorer-row">
                      {nameBox()}
                    </li>
                  );
                }
                return (
                  <li key={path} class="explorer-row">
                    {section ? (
                      <a
                        href={fileHash(path)}
                        class={`explorer-file${path === open ? " active" : ""}`}
                        aria-current={path === open ? "page" : undefined}
                        data-testid="explorer-file"
                        data-path={path}
                        draggable
                        onDragStart={(event) => event.dataTransfer?.setData("text/plain", path)}
                        onClick={(event) => {
                          // Left-click routes in the page; a modified click is a
                          // real navigation and stays the browser's.
                          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                          event.preventDefault();
                          onOpen(path);
                        }}
                      >
                        {name}
                      </a>
                    ) : (
                      <span class="explorer-file inert" title="no editor opens this file">
                        {name}
                      </span>
                    )}
                    <span class="explorer-row-actions">
                      <button
                        type="button"
                        class="explorer-icon"
                        title={`Rename or move ${path}`}
                        aria-label={`Rename or move ${path}`}
                        data-testid="rename-file"
                        data-path={path}
                        onClick={() => setEditing({ from: path, text: path })}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        class="explorer-icon"
                        title={`Delete ${path}`}
                        aria-label={`Delete ${path}`}
                        data-testid="delete-file"
                        data-path={path}
                        onClick={() => onDelete(path)}
                      >
                        ×
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
    </aside>
  );
}
