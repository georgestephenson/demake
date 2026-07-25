/**
 * The site shell: one wordmark, four demakers, one footer.
 *
 * demake demakes *game assets* — images, games, and (soon) music and sound —
 * so the site is a set of sections over one engine rather than one tool with a
 * bolted-on extra page. The art demaker remains the unmarked default so every
 * permalink shared before the site grew sections still opens what it used to.
 */

import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from "preact";

import { App } from "./app.js";
import { ComingSoon } from "./sections/ComingSoon.js";
import { COMING_SOON, readSection, SECTION_LABELS, SECTIONS, sectionHash } from "./lib/route.js";

const TAGLINES: Readonly<Record<string, string>> = {
  game: "one declarative game → every console",
  language: "every statement, property and diagnostic",
  art: "any image → hardware-compliant console art",
  music: "any track → chip music",
  sound: "any effect → chip sound",
};

export function Site() {
  const [section, setSection] = useState(() => readSection(location.hash));
  const [lazySections, setLazySections] = useState<Record<string, ComponentType>>({});

  useEffect(() => {
    const onHash = () => setSection(readSection(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // Both Demotic sections load on demand. Between them they carry the whole
  // game language — compiler, interpreter, test runner, registry — and someone
  // who came to convert an image should not download any of it. Splitting them
  // out keeps the art demaker's initial payload what it was before the site
  // grew sections (doc 07 §Quality bar).
  useEffect(() => {
    if (lazySections[section]) return;
    const load =
      section === "game"
        ? () => import("./sections/GameDemaker.js").then((m) => m.GameDemaker)
        : section === "language"
          ? () => import("./sections/LanguageDocs.js").then((m) => m.LanguageDocs)
          : null;
    if (!load) return;
    void load().then((component) =>
      setLazySections((previous) => ({ ...previous, [section]: component })),
    );
  }, [section, lazySections]);

  const Lazy = lazySections[section];

  return (
    <div class="layout">
      <header class="topbar">
        <h1>
          <span class="wordmark">demake</span>
          <span class="tagline">{TAGLINES[section]}</span>
        </h1>

        <nav class="sections" aria-label="Demakers">
          {SECTIONS.map((id) => (
            <a
              key={id}
              href={sectionHash(id)}
              class={`section-link${id === section ? " active" : ""}`}
              aria-current={id === section ? "page" : undefined}
            >
              {SECTION_LABELS[id]}
              {COMING_SOON.includes(id) ? <span class="soon">soon</span> : null}
            </a>
          ))}
        </nav>

        <p class="privacy">
          Runs entirely in your browser. Nothing is uploaded — the engine is the same{" "}
          <code>@demake/core</code> and <code>@demake/demotic</code> the CLI uses.
        </p>
      </header>

      {section === "art" ? <App /> : null}
      {section === "game" || section === "language" ? (
        Lazy ? (
          <Lazy />
        ) : (
          <main>
            <section class="pane">
              <p class="hint">Loading…</p>
            </section>
          </main>
        )
      ) : null}
      {COMING_SOON.includes(section) ? <ComingSoon section={section} /> : null}

      <footer>
        <a href="https://github.com/georgestephenson/demake">source</a> ·{" "}
        <a href="https://github.com/georgestephenson/demake/tree/main/docs">design docs</a> · the
        same conversion is available as <code>npx demake</code>
      </footer>
    </div>
  );
}
