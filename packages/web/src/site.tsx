/**
 * The workbench: one project, an explorer, an editor per file type, and the
 * chrome around them (doc 19 §The shell, doc 07 §The workbench).
 *
 * The site used to be four tools you navigated between. It is one workspace you
 * open files in now — the arrangement every code editor settled on, for the
 * reason every code editor settled on it: the project is the constant and the
 * file you are looking at is the variable.
 *
 * **The section tabs are gone**, and their going is the point rather than a
 * tidy-up. A tab and a file selection were two answers to "what is on screen",
 * and the file is the better one because it is the thing the project actually
 * contains — clicking `ball.svg` opens the art demaker because a `.svg` *is*
 * art, not because a nav link was set to a matching value. What the tabs were
 * also carrying was the commands, and those are what the menu bar is for.
 *
 * So the window is a window: a title bar naming what is open, a menu bar under
 * it, the explorer and the editor filling the viewport, and a status bar. It
 * uses the whole screen because an editor that leaves a margin around itself is
 * an editor with less room for the thing you came to look at.
 *
 * `#section=` still opens a bare section, because every option permalink shared
 * before the site held projects has one in it — and a bare URL opens the
 * project's own game, which is what somebody arriving has come to see.
 */

import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { ComponentType } from "preact";

import { findEntry } from "@demake/demotic";

import { App } from "./app.js";
import { Explorer } from "./components/Explorer.js";
import { accelerator, MenuBar, useMenuKeys, type Menu } from "./components/MenuBar.js";
import { QuickOpen } from "./components/QuickOpen.js";
import {
  EXAMPLE_NAMES,
  exampleSkeleton,
  fillBinaries,
  loadExampleBinaries,
} from "./lib/examples.js";
import {
  fileHash,
  isBareHash,
  readRoute,
  sectionHash,
  SECTION_LABELS,
  type Section,
} from "./lib/route.js";
import {
  addFile,
  moveFile,
  projectFiles,
  removeFile,
  writeText,
  type Project,
} from "./lib/project.js";
import { DEMAKEFILE } from "./lib/demakefile.js";
import { exportZip, importZip, openFolder, saveToFolder, canOpenFolder } from "./lib/disk.js";
import { download } from "./lib/download.js";

/**
 * What the window is called, per editor.
 *
 * The title bar says what this tool *does with the thing you have open*, which
 * is a different claim per file type and the reason it is worth varying: a `.dmt`
 * is the whole product thesis in one line, and a `.wav` is one demaker.
 */
const TAGLINES: Readonly<Record<Section, string>> = {
  game: "one source project, ROMs for every game console",
  level: "draw a level, or write it",
  text: "the project's own files, as text",
  language: "every statement, property and diagnostic",
  art: "any image → hardware-compliant console art",
  music: "any track → chip music",
  sound: "any effect → chip sound",
};

/**
 * Which engine package a section is actually running.
 *
 * Named per section rather than listing all of them everywhere: the claim being
 * made is "this is the same code the CLI runs", and it is worth more when it
 * names the package doing the work in front of you.
 */
const ENGINES: Readonly<Record<Section, readonly string[]>> = {
  game: ["@demake/demotic", "@demake/core"],
  level: ["@demake/demotic"],
  text: ["@demake/demotic"],
  language: ["@demake/demotic"],
  art: ["@demake/core"],
  music: ["@demake/audio", "@demake/chip"],
  sound: ["@demake/audio", "@demake/chip"],
};

/**
 * The explorer's accelerator, written once.
 *
 * Two things offer the toggle — the View menu and the button in the title bar —
 * and only the menu can *draw* a key. So the string lives here and both read it:
 * a button whose tooltip advertised a shortcut the menu had since changed would
 * be the same failure the one-declaration rule (doc 07 §The workbench) exists to
 * prevent, arriving through the other door.
 */
const EXPLORER_KEY = "Mod+B";

/**
 * The width at which the workbench stacks the explorer above the editor instead
 * of putting it beside it — and therefore the width at which it opens
 * contracted, because a tree taking a third of a phone screen is a third of the
 * screen the editor does not get.
 *
 * It mirrors the `@media` query in `styles.css`, which is the one thing to keep
 * in step: a value here that disagreed would collapse the tree at a width where
 * it was still a perfectly good sidebar.
 */
const STACKED = "(max-width: 1000px)";

/** Whether the explorer should open contracted, asked once when the page opens. */
function opensContracted(): boolean {
  return typeof matchMedia === "function" && matchMedia(STACKED).matches;
}

/** What every editor is handed: the project, and which of its files is open. */
export interface EditorProps {
  project: Project;
  path?: string;
  onEdit: (path: string, text: string) => void;
  /**
   * Replace the whole project.
   *
   * What an editor uses when its change is not to the file it has open: the art
   * demaker's controls write the *Demakefile* (doc 19 §Options edit the
   * Demakefile), which is a different file from the picture on screen.
   */
  onProject: (next: Project) => void;
}

/** Navigate, without leaving a history entry per keystroke of a file name. */
function go(hash: string): void {
  location.hash = hash.replace(/^#/, "");
}

export function Site() {
  const [route, setRoute] = useState(() => readRoute(location.hash));
  const [lazySections, setLazySections] = useState<Record<string, ComponentType<EditorProps>>>({});
  // Which sections asked for their chunk and did not get it. See the loader
  // below: a section with an entry here is showing a way out rather than a
  // spinner it will never replace.
  const [lazyFailed, setLazyFailed] = useState<Record<string, string>>({});
  // The project opens with its text files present and its art and audio still
  // arriving, so the editor has source to show on the first frame rather than a
  // spinner. Pong, because that is the example the site has always opened on.
  const [project, setProject] = useState<Project>(() => exampleSkeleton("pong"));
  // Where a save goes, when the project came from the machine. A bundled example
  // has nowhere to save *to* — that is what "Download zip" is for — so the entry
  // is disabled rather than present and broken.
  const [folder, setFolder] = useState<unknown>(null);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Beside the editor on a screen with room for both, and out of the way on one
  // without. Decided when the page opens and never again: a viewport that
  // changes width mid-session is a rotation or a resized window, and neither is
  // a reason to overrule the button somebody just pressed.
  const [showExplorer, setShowExplorer] = useState(() => !opensContracted());
  const [quickOpen, setQuickOpen] = useState(false);
  const [creating, setCreating] = useState<string | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);

  useEffect(() => {
    const onHash = () => setRoute(readRoute(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // The art and the audio, fetched once per project. Binary files are URLs in the
  // bundle rather than base64, so this is a handful of same-origin requests the
  // service worker caches like anything else (`examples.ts`).
  //
  // The bytes are *filled into* the project rather than replacing it, and that
  // is load-bearing rather than tidy. This used to swap in a freshly built
  // skeleton when the fetch landed, which threw away everything done in the
  // second before it — a file created, a rename, a line typed into the game.
  // The race is invisible on a fast machine and reliable on a loaded one, which
  // is exactly the shape of bug that ships.
  useEffect(() => {
    let live = true;
    const name = project.name;
    void loadExampleBinaries(name).then((binaries) => {
      if (!live) return;
      setProject((current) => (current.name === name ? fillBinaries(current, binaries) : current));
    });
    return () => {
      live = false;
    };
    // Keyed on the *name*: an edit replaces the project object, and refetching
    // its art on every keystroke would be absurd.
  }, [project.name]);

  /*
   * Unsaved work is worth a prompt, and there are two things that can take it.
   *
   * Closing the tab is the obvious one. The other is the service worker's
   * update-and-reload (`main.tsx`): a deploy landing while somebody has a folder
   * open half-edited must not be the thing that discards it, and because that
   * reload goes through `beforeunload` like any other, one guard covers both.
   */
  useEffect(() => {
    if (!dirty) return;
    const ask = (event: BeforeUnloadEvent): void => event.preventDefault();
    addEventListener("beforeunload", ask);
    return () => removeEventListener("beforeunload", ask);
  }, [dirty]);

  const paths = useMemo(() => projectFiles(project), [project]);
  const entry = useMemo(() => findEntry(paths).path, [paths]);

  /**
   * A bare URL opens the project's game.
   *
   * "Nothing in the hash" is somebody arriving at the site, and what they have
   * come to see is a game — the tabs used to land them on the art demaker, which
   * was the default only because it was the first section written. A hash with
   * *anything* in it is a link somebody shared, including an art-option
   * permalink that names neither a file nor a section, so it is left alone.
   */
  useEffect(() => {
    if (!isBareHash(location.hash) || entry === undefined) return;
    go(fileHash(entry));
  }, [entry]);

  const section = route.section;

  // Every section but the art demaker loads on demand. The Demotic trio carry
  // the whole game language — compiler, interpreter, test runner, registry — and
  // the audio pair carry the chip models, the decoders and the analysis DSP;
  // someone who came to convert an image should download none of it. Splitting
  // them out keeps the art demaker's initial payload what it was before the site
  // grew sections (doc 07 §Quality bar).
  //
  // **A chunk that does not arrive has to say so.** A dynamic import can reject
  // — a tab left open across a deploy holds a shell naming hashed chunks the
  // server has since replaced, and the first lazy section it asks for 404s — and
  // for as long as the rejection was dropped on the floor the page sat on
  // "Loading…" for ever, with the art demaker still working because it is in the
  // entry chunk. So a `.wav` opened nothing and said nothing. The failure is
  // recorded per section and shown, because the recovery (reload, and take the
  // new shell) is one the visitor has to be told to make.
  useEffect(() => {
    if (lazySections[section] || lazyFailed[section]) return;
    const load =
      section === "game"
        ? () => import("./sections/GameDemaker.js").then((m) => m.GameDemaker)
        : section === "level"
          ? () => import("./sections/LevelEditor.js").then((m) => m.LevelEditor)
          : section === "text"
            ? () => import("./sections/TextEditor.js").then((m) => m.TextEditor)
            : section === "language"
              ? () => import("./sections/LanguageDocs.js").then((m) => m.LanguageDocs)
              : section === "music"
                ? () => import("./sections/MusicDemaker.js").then((m) => m.MusicDemaker)
                : section === "sound"
                  ? () => import("./sections/SoundDemaker.js").then((m) => m.SoundDemaker)
                  : null;
    if (!load) return;
    void load().then(
      (component) =>
        setLazySections((previous) => ({
          ...previous,
          [section]: component as ComponentType<EditorProps>,
        })),
      (error: unknown) => {
        // A stale shell is the likely cause, so ask the worker to look for a new
        // one. That is what makes the reload button below fix it rather than
        // repeat it — the browser only checks on navigation, and this tab has
        // not navigated since before the deploy. Swallowed whole, and on purpose:
        // this is the error path, so a browser with no service worker (or one
        // that throws merely for asking, which private-browsing modes do) must
        // not turn "the section failed" into a second failure with no message at
        // all.
        try {
          void navigator.serviceWorker?.getRegistration().then(
            (registration) => void registration?.update(),
            () => {},
          );
        } catch {
          /* no service worker here */
        }
        setLazyFailed((previous) => ({ ...previous, [section]: String(error) }));
      },
    );
  }, [section, lazySections, lazyFailed]);

  const Lazy = lazySections[section];
  const failed = lazyFailed[section];

  // The window's own name, which is also the tab's. Kept in sync rather than
  // written twice: a browser tab that says something different from the title bar
  // above it is the sort of small wrongness nobody reports and everybody sees.
  const title = `demake — ${TAGLINES[section]}`;
  useEffect(() => {
    document.title = title;
  }, [title]);

  const props = useMemo<EditorProps>(
    () => ({
      project,
      ...(route.file === undefined ? {} : { path: route.file }),
      onEdit: (path: string, text: string) => {
        setProject((current) => {
          setDirty(true);
          return writeText(current, path, text);
        });
      },
      onProject: (next: Project) => {
        setDirty(true);
        setProject(next);
      },
    }),
    [project, route.file],
  );

  // --- the project's own commands -------------------------------------------

  const openExample = useCallback((name: string) => {
    const opened = exampleSkeleton(name);
    setProject(opened);
    setFolder(null);
    setDirty(false);
    setNotice(null);
    // Straight to the new project's game. A path from one project rarely exists
    // in the next, so keeping the old one would land on "no such file".
    const next = findEntry(projectFiles(opened)).path;
    go(next === undefined ? sectionHash("art") : fileHash(next));
  }, []);

  const move = useCallback(
    (from: string, to: string) => {
      setProject((current) => moveFile(current, from, to));
      setDirty(true);
      setNotice(null);
      // The editor follows the file it had open. Anything else is a pane that
      // silently goes blank on a rename.
      if (route.file === from) go(fileHash(to));
    },
    [route.file],
  );

  const remove = useCallback(
    (path: string) => {
      setProject((current) => removeFile(current, path));
      setDirty(true);
      setNotice(`Deleted ${path}. It is gone from the project, not from your disk until you save.`);
      if (route.file === path) go(entry === undefined ? sectionHash("art") : fileHash(entry));
    },
    [route.file, entry],
  );

  /** Both menu requests are one-shot, and this is how they are cleared. */
  const handled = useCallback(() => {
    setCreating(undefined);
    setRenaming(undefined);
  }, []);

  const create = useCallback((path: string) => {
    setProject((current) => addFile(current, path, new Uint8Array()));
    setDirty(true);
    setNotice(null);
    go(fileHash(path));
  }, []);

  const save = useCallback(() => {
    if (folder === null) return;
    void saveToFolder(folder, project)
      .then(() => {
        setDirty(false);
        setNotice(null);
      })
      .catch((error: unknown) => setNotice(String(error)));
  }, [folder, project]);

  // --- the menus -------------------------------------------------------------

  const menus = useMemo<Menu[]>(
    () => [
      {
        label: "File",
        items: [
          // No accelerator: ⌘N is the browser's new window and cannot be taken.
          { label: "New File…", run: () => setCreating(""), testId: "menu-new-file" },
          ...(canOpenFolder()
            ? [
                {
                  label: "Open Folder…",
                  key: "Mod+O",
                  testId: "open-folder",
                  run: () => {
                    void openFolder()
                      .then((opened) => {
                        if (!opened) return;
                        setProject(opened.project);
                        setFolder(opened.handle);
                        setDirty(false);
                        setNotice(null);
                        const next = findEntry(projectFiles(opened.project)).path;
                        go(next === undefined ? sectionHash("art") : fileHash(next));
                      })
                      .catch((error: unknown) => setNotice(String(error)));
                  },
                },
              ]
            : []),
          {
            label: "Import Zip…",
            testId: "import-zip",
            file: {
              accept: ".zip,application/zip",
              onPick: (picked: File) => {
                void picked
                  .arrayBuffer()
                  .then((bytes) => {
                    const opened = importZip(picked.name, new Uint8Array(bytes));
                    setProject(opened);
                    // An imported zip has no folder behind it, so it downloads
                    // rather than saves — a bundled example's position exactly.
                    setFolder(null);
                    setDirty(false);
                    setNotice(null);
                    const next = findEntry(projectFiles(opened)).path;
                    go(next === undefined ? sectionHash("art") : fileHash(next));
                  })
                  .catch((error: unknown) => setNotice(String(error)));
              },
            },
          },
          "separator",
          {
            label: "Save",
            key: "Mod+S",
            testId: "save-folder",
            disabled: folder === null,
            run: save,
          },
          {
            label: "Download Zip",
            key: "Shift+Mod+S",
            testId: "export-zip",
            run: () => download(`${project.name}.zip`, exportZip(project)),
          },
        ],
      },
      {
        label: "Edit",
        items: [
          { label: "Undo", key: "Mod+Z", native: true, run: () => edit("undo") },
          { label: "Redo", key: "Shift+Mod+Z", native: true, run: () => edit("redo") },
          "separator",
          {
            label: "Rename File…",
            key: "F2",
            disabled: route.file === undefined,
            run: () => {
              // The box is the explorer's, so the explorer has to be on screen
              // for it to exist — F2 with the sidebar hidden brings it back
              // rather than doing nothing.
              setShowExplorer(true);
              setRenaming(route.file);
            },
          },
          {
            // No accelerator either: ⌘⌫ deletes the previous word in a text box,
            // and a delete with no undo behind it is the worst thing to hang off
            // a key somebody presses while typing.
            label: "Delete File",
            disabled: route.file === undefined,
            run: () => {
              if (route.file !== undefined) remove(route.file);
            },
          },
        ],
      },
      {
        label: "View",
        items: [
          {
            label: "Explorer",
            key: EXPLORER_KEY,
            checked: showExplorer,
            run: () => setShowExplorer((on) => !on),
            testId: "toggle-explorer",
          },
          "separator",
          {
            label: "Demotic Reference",
            run: () => go(sectionHash("language")),
            testId: "menu-language",
          },
          { label: "Art Demaker", run: () => go(sectionHash("art")), testId: "menu-art" },
        ],
      },
      {
        label: "Go",
        items: [
          { label: "Go to File…", key: "Mod+P", run: () => setQuickOpen(true) },
          "separator",
          {
            label: "The Game",
            disabled: entry === undefined,
            run: () => {
              if (entry !== undefined) go(fileHash(entry));
            },
          },
          {
            label: "The Demakefile",
            disabled: !project.files.has(DEMAKEFILE),
            run: () => go(fileHash(DEMAKEFILE)),
          },
        ],
      },
      {
        label: "Help",
        items: [
          { label: "Demotic Reference", run: () => go(sectionHash("language")) },
          {
            label: "Design Docs",
            run: () =>
              open(
                "https://github.com/georgestephenson/demake/tree/main/docs",
                "_blank",
                "noopener",
              ),
          },
          {
            label: "Source",
            run: () => open("https://github.com/georgestephenson/demake", "_blank", "noopener"),
          },
        ],
      },
    ],
    [folder, project, route.file, entry, showExplorer, save, remove],
  );

  useMenuKeys(menus);

  return (
    <div class="workspace">
      {/*
        The title bar: the menus on the left and the window's name in the middle,
        which is where every desktop puts it and what VS Code's own custom title
        bar does. One strip rather than two, because a menu bar under a title bar
        is a row of chrome that says nothing.
      */}
      <header class="titlebar">
        {/*
          The explorer's own switch, at the left of the title bar where every
          editor puts one. It was a menu entry and a key and nothing else, which
          is a control you have to already know about — and on a phone, where the
          tree now opens contracted, the only way back to the project's files.
          The menu entry stays: it is where the shortcut is written down.
        */}
        <button
          type="button"
          class="titlebar-toggle"
          data-testid="explorer-toggle"
          aria-expanded={showExplorer}
          aria-controls="explorer"
          aria-label={showExplorer ? "Hide the explorer" : "Show the explorer"}
          title={`${showExplorer ? "Hide" : "Show"} the explorer (${accelerator(EXPLORER_KEY)})`}
          onClick={() => setShowExplorer((on) => !on)}
        >
          {/* A sidebar, filled while there is one. Marked `aria-hidden` because
              the button already says what it does. */}
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
            <rect
              x="1.75"
              y="2.75"
              width="12.5"
              height="10.5"
              rx="1.75"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path
              d="M6.25 3v10"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
            {showExplorer ? (
              <rect x="2.6" y="3.6" width="3" height="8.8" rx="0.9" fill="currentColor" />
            ) : null}
          </svg>
        </button>
        <MenuBar menus={menus} />
        <h1 class="window-title" data-testid="window-title">
          <span class="wordmark">demake</span>
          <span class="tagline">{TAGLINES[section]}</span>
        </h1>
        <p class="privacy" title="Nothing is uploaded; the engine is the CLI's.">
          in your browser ·{" "}
          {(ENGINES[section] ?? []).map((name) => (
            <code key={name}>{name}</code>
          ))}
        </p>
      </header>

      <div class={`workbench${showExplorer ? "" : " no-explorer"}`}>
        {showExplorer ? (
          <Explorer
            project={project}
            {...(route.file === undefined ? {} : { open: route.file })}
            onOpen={(path) => go(fileHash(path))}
            onMove={move}
            onDelete={remove}
            onCreate={create}
            onNotice={setNotice}
            {...(creating === undefined ? {} : { creating })}
            {...(renaming === undefined ? {} : { renaming })}
            onRequestHandled={handled}
          />
        ) : null}

        <div class="editor-host">
          {section === "art" ? <App {...props} /> : null}
          {section !== "art" ? (
            Lazy ? (
              <Lazy {...props} />
            ) : failed !== undefined ? (
              <main>
                <section class="pane">
                  <p class="error" role="alert" data-testid="section-error">
                    <strong>{SECTION_LABELS[section]}</strong> could not be loaded.
                    <span class="hint">
                      {" "}
                      This usually means the page has been open since before the site was updated,
                      so the part it just asked for is no longer on the server. Reloading takes the
                      new one.
                    </span>
                  </p>
                  {/*
                    Reload and nothing else, deliberately. Asking for the same
                    module again in this document is answered from the browser's
                    module map, which holds the *failure* against that URL — so a
                    "try again" button here would never once have worked, which
                    is worse than not offering one. Everything the page can do to
                    make the reload land on a fresh shell has already happened
                    above: the service worker was asked to update, and it fetches
                    `index.html` past the HTTP cache.
                  */}
                  <div class="row">
                    <button
                      type="button"
                      data-testid="section-reload"
                      onClick={() => location.reload()}
                    >
                      Reload the page
                    </button>
                  </div>
                  <p class="hint">
                    <code>{failed}</code>
                  </p>
                </section>
              </main>
            ) : (
              <main>
                <section class="pane">
                  <p class="hint" data-testid="section-loading">
                    Loading…
                  </p>
                </section>
              </main>
            )
          ) : null}
        </div>
      </div>

      <footer class="statusbar">
        {/*
          The project picker lives here for the reason an editor's branch picker
          does: it names the thing everything else on screen is about, and it is
          not a command.
        */}
        <label class="status-project">
          <span class="visually-hidden">Project</span>
          <select
            data-testid="project-select"
            value={project.name}
            onChange={(event) => openExample((event.currentTarget as HTMLSelectElement).value)}
          >
            {EXAMPLE_NAMES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <span class="status-dirty" data-testid="project-dirty">
          {dirty ? "unsaved changes" : folder === null ? "bundled example" : "saved"}
        </span>
        <span class="status-notice" data-testid="project-notice" role="status">
          {notice ?? ""}
        </span>
        <span class="status-spacer" />
        <a href="https://github.com/georgestephenson/demake">source</a>
        <code>npx demake</code>
      </footer>

      {quickOpen ? (
        <QuickOpen
          paths={paths}
          onOpen={(path) => go(fileHash(path))}
          onClose={() => setQuickOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * Undo and redo, in whatever editor has focus.
 *
 * `execCommand` is deprecated and universally implemented, and it is the only
 * way to reach a `<textarea>`'s *native* undo stack — which is the one the user
 * has been filling by typing. A journal of our own kept beside it would be a
 * second history that disagrees with ⌘Z pressed with the caret in the box, which
 * is worse than not offering the menu entry at all.
 */
function edit(command: "undo" | "redo"): void {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement)) return;
  document.execCommand(command);
}
