/**
 * The workspace shell: one project, an explorer, and an editor per file type
 * (doc 19 §The shell).
 *
 * The site used to be four tools you navigated between. It is one workspace you
 * open files in now — the arrangement every code editor settled on, for the
 * reason every code editor settled on it: the project is the constant and the
 * file you are looking at is the variable. Clicking a file in the explorer opens
 * whichever demaker demakes that kind of file, and the demakers themselves are
 * unchanged in what they do.
 *
 * `#section=` still opens a bare section, because every option permalink shared
 * before the site held projects has one in it.
 */

import { useEffect, useMemo, useState } from "preact/hooks";
import type { ComponentType } from "preact";

import { App } from "./app.js";
import { Explorer } from "./components/Explorer.js";
import { EXAMPLE_NAMES, exampleSkeleton, loadExample } from "./lib/examples.js";
import { readRoute, SECTION_LABELS, sectionHash } from "./lib/route.js";
import { writeText, type Project } from "./lib/project.js";

const TAGLINES: Readonly<Record<string, string>> = {
  game: "one declarative game → every console",
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
const ENGINES: Readonly<Record<string, string[]>> = {
  game: ["@demake/demotic", "@demake/core"],
  language: ["@demake/demotic"],
  art: ["@demake/core"],
  music: ["@demake/audio", "@demake/chip"],
  sound: ["@demake/audio", "@demake/chip"],
};

/** What every editor is handed: the project, and which of its files is open. */
export interface EditorProps {
  project: Project;
  path?: string;
  onEdit: (path: string, text: string) => void;
}

export function Site() {
  const [route, setRoute] = useState(() => readRoute(location.hash));
  const [lazySections, setLazySections] = useState<Record<string, ComponentType<EditorProps>>>({});
  // The project opens with its text files present and its art and audio still
  // arriving, so the editor has source to show on the first frame rather than a
  // spinner. Pong, because that is the example the site has always opened on.
  const [project, setProject] = useState<Project>(() => exampleSkeleton("pong"));

  useEffect(() => {
    const onHash = () => setRoute(readRoute(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // The art and the audio, fetched once per project. Binary files are URLs in the
  // bundle rather than base64, so this is a handful of same-origin requests the
  // service worker caches like anything else (`examples.ts`).
  useEffect(() => {
    let live = true;
    void loadExample(project.name).then((loaded) => {
      if (live) setProject((current) => (current.name === loaded.name ? loaded : current));
    });
    return () => {
      live = false;
    };
    // Keyed on the *name*: an edit replaces the project object, and refetching
    // its art on every keystroke would be absurd.
  }, [project.name]);

  const section = route.section;

  // Every section but the art demaker loads on demand. The Demotic pair carry
  // the whole game language — compiler, interpreter, test runner, registry — and
  // the audio pair carry the chip models, the decoders and the analysis DSP;
  // someone who came to convert an image should download none of it. Splitting
  // them out keeps the art demaker's initial payload what it was before the site
  // grew sections (doc 07 §Quality bar).
  useEffect(() => {
    if (lazySections[section]) return;
    const load =
      section === "game"
        ? () => import("./sections/GameDemaker.js").then((m) => m.GameDemaker)
        : section === "language"
          ? () => import("./sections/LanguageDocs.js").then((m) => m.LanguageDocs)
          : section === "music"
            ? () => import("./sections/MusicDemaker.js").then((m) => m.MusicDemaker)
            : section === "sound"
              ? () => import("./sections/SoundDemaker.js").then((m) => m.SoundDemaker)
              : null;
    if (!load) return;
    void load().then((component) =>
      setLazySections((previous) => ({
        ...previous,
        [section]: component as ComponentType<EditorProps>,
      })),
    );
  }, [section, lazySections]);

  const Lazy = lazySections[section];

  const props = useMemo<EditorProps>(
    () => ({
      project,
      ...(route.file === undefined ? {} : { path: route.file }),
      onEdit: (path: string, text: string) =>
        setProject((current) => writeText(current, path, text)),
    }),
    [project, route.file],
  );

  return (
    <div class="layout workspace">
      <header class="topbar">
        <h1>
          <span class="wordmark">demake</span>
          <span class="tagline">{TAGLINES[section]}</span>
        </h1>

        <nav class="sections" aria-label="Demakers">
          {(["game", "art", "music", "sound", "language"] as const).map((id) => (
            <a
              key={id}
              href={sectionHash(id)}
              class={`section-link${id === section ? " active" : ""}`}
              aria-current={id === section ? "page" : undefined}
            >
              {SECTION_LABELS[id]}
            </a>
          ))}
        </nav>

        <p class="privacy">
          Runs entirely in your browser. Nothing is uploaded — the engine is the same{" "}
          {(ENGINES[section] ?? ENGINES["art"] ?? []).map((name, index, all) => (
            <span key={name}>
              <code>{name}</code>
              {index < all.length - 2 ? ", " : index === all.length - 2 ? " and " : ""}
            </span>
          ))}{" "}
          the CLI uses.
        </p>
      </header>

      <div class="workbench">
        <Explorer
          project={project}
          {...(route.file === undefined ? {} : { open: route.file })}
          examples={EXAMPLE_NAMES}
          onOpenExample={(name) => {
            setProject(exampleSkeleton(name));
            // The route keeps its *section*, not its file: a path from one
            // project rarely exists in the next, and landing on "no such file"
            // after picking a project would read as a fault.
            location.hash = sectionHash(section).slice(1);
          }}
        />

        <div class="editor-host">
          {section === "art" ? <App {...props} /> : null}
          {section !== "art" ? (
            Lazy ? (
              <Lazy {...props} />
            ) : (
              <main>
                <section class="pane">
                  <p class="hint">Loading…</p>
                </section>
              </main>
            )
          ) : null}
        </div>
      </div>

      <footer>
        <a href="https://github.com/georgestephenson/demake">source</a> ·{" "}
        <a href="https://github.com/georgestephenson/demake/tree/main/docs">design docs</a> · the
        same conversion is available as <code>npx demake</code>
      </footer>
    </div>
  );
}
