/**
 * The site shell: one wordmark, four demakers, one footer.
 *
 * demake demakes *game assets* — images, games, and (soon) music and sound —
 * so the site is a set of sections over one engine rather than one tool with a
 * bolted-on extra page. The art demaker remains the unmarked default so every
 * permalink shared before the site grew sections still opens what it used to.
 */

import { useEffect, useState } from "preact/hooks";

import { App } from "./app.js";
import { ComingSoon } from "./sections/ComingSoon.js";
import { GameDemaker } from "./sections/GameDemaker.js";
import { COMING_SOON, readSection, SECTION_LABELS, SECTIONS, sectionHash } from "./lib/route.js";

const TAGLINES: Readonly<Record<string, string>> = {
  game: "one declarative game → every console",
  art: "any image → hardware-compliant console art",
  music: "any track → chip music",
  sound: "any effect → chip sound",
};

export function Site() {
  const [section, setSection] = useState(() => readSection(location.hash));

  useEffect(() => {
    const onHash = () => setSection(readSection(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

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
      {section === "game" ? <GameDemaker /> : null}
      {COMING_SOON.includes(section) ? <ComingSoon section={section} /> : null}

      <footer>
        <a href="https://github.com/georgestephenson/demake">source</a> ·{" "}
        <a href="https://github.com/georgestephenson/demake/tree/main/docs">design docs</a> · the
        same conversion is available as <code>npx demake</code>
      </footer>
    </div>
  );
}
