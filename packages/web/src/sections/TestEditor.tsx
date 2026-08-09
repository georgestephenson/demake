/**
 * The suite editor: what opens for a `.test.dmt` (doc 19 §The shell).
 *
 * A suite used to open the **game demaker**, because it is a `.dmt` and the
 * router asked no further question — so a file that asserts things about a game
 * arrived with a console picker, a cartridge and a playable preview, none of
 * which it has anything to do with. A `.test.dmt` builds to nothing: it is a
 * program *about* a game, and what it needs on screen is the game it is about and
 * whether its claims hold.
 *
 * So this pane has two halves and neither is a player. The **suite**, as blocks
 * or as text — the same two views a game gets, over the same editor, because the
 * two grammars differ and the rows do not. And the **run**: every case against
 * every console at once, which is the whole point of writing one (doc 14 §Testing
 * a game). A suite that only ever ran on a Game Boy would be checking mechanics;
 * running the same relative assertions on twelve playfields is what checks
 * balance.
 *
 * The game it tests is found beside it (`gameFor`), so the pane says which file
 * it is asserting against and opens it in a click — and a project whose game does
 * not compile is told that rather than shown zero cases.
 */

import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import {
  check,
  gameFor,
  highlight,
  parseTests,
  profiles,
  type ConsoleProfile,
  type Diagnostic,
} from "@demake/demotic";

import { BlockEditor } from "../components/BlockEditor.js";
import { SourceEditor } from "../components/SourceEditor.js";
import { dialectOf } from "../lib/blocks.js";
import { fileHash } from "../lib/route.js";
import { levelSources, projectFiles, readText } from "../lib/project.js";
import { passed, runSuite, summarise, type SuiteRun } from "../lib/suite.js";
import { VIEWS, type SourceView } from "../lib/views.js";
import type { EditorProps } from "../site.js";

/** How long the editor waits before handing the engine what you typed. */
const SETTLE_MS = 400;

export function TestEditor({ project, path, onEdit }: EditorProps) {
  const files = useMemo(() => projectFiles(project), [project]);
  const openPath = path ?? files.find((one) => one.endsWith(".test.dmt")) ?? "";
  const initial = readText(project, openPath);

  const [draft, setDraft] = useState(initial);
  const [source, setSource] = useState(initial);
  // Text by default, for the game section's reason: one rule for both files.
  const [view, setView] = useState<SourceView>("text");
  const [run, setRun] = useState<SuiteRun | null>(null);

  const game = useMemo(() => gameFor(openPath, files), [openPath, files]);
  const levels = useMemo(() => levelSources(project), [project]);
  const gameSource = game === undefined ? "" : readText(project, game);

  // Typing settles into the engine after a pause, exactly as it does in the game
  // section: a keystroke costs a lex for the colours and nothing else.
  useEffect(() => {
    if (draft === source) return;
    const timer = setTimeout(() => setSource(draft), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [draft, source]);

  useEffect(() => {
    const text = readText(project, openPath);
    setDraft(text);
    setSource(text);
    setRun(null);
    // Keyed on the path alone: reacting to the project would undo every keystroke,
    // since an edit is what replaces the project.
  }, [openPath]);

  useEffect(() => {
    if (source !== readText(project, openPath)) onEdit(openPath, source);
  }, [source]);

  /**
   * What is wrong with the suite, and what is wrong with the game under it.
   *
   * Both, because a case that cannot run has two possible causes and only one of
   * them is in the file on screen. The game's are marked as such and carry no
   * line, since they are about a different file.
   */
  const diagnostics = useMemo<readonly Diagnostic[]>(() => {
    const suite = parseTests(source).diagnostics;
    if (game === undefined) return suite;
    try {
      // Any console will do to find out whether the game compiles at all: what
      // is being reported here is a broken *game*, and a rule that only fails on
      // one machine is a balance question the run below answers properly.
      const compiled = check(gameSource, { profile: profiles[0] as ConsoleProfile, files, levels });
      return [
        ...suite,
        ...compiled.diagnostics
          .filter((one) => one.severity === "error")
          .map((one) => ({ ...one, line: 0, message: `${game}: ${one.message}` })),
      ];
    } catch {
      return suite;
    }
  }, [source, gameSource, game, files, levels]);

  const runNow = useCallback(() => {
    // The *draft*, not the settled copy, and it settles it on the way: pressing
    // Run within the typing pause has to test what is on screen. Reporting on the
    // version from 300 ms ago would be a failure nobody could reproduce.
    setSource(draft);
    if (game === undefined) return;
    setRun(runSuite(gameSource, draft, { files, levels }));
  }, [draft, gameSource, game, files, levels]);

  const suiteErrors = diagnostics.filter((one) => one.severity === "error" && one.line > 0);

  return (
    <main class="tests-layout">
      <section class="pane">
        <h2>Suite</h2>
        <div class="game-toolbar">
          <span class="game-name" data-testid="open-suite">
            {openPath.slice(openPath.lastIndexOf("/") + 1)}
          </span>
          <label class="field inline">
            <span>View</span>
            <select
              data-testid="suite-view-select"
              value={view}
              onChange={(event) => {
                const select = event.target as HTMLSelectElement;
                setView(select.value as SourceView);
                select.blur();
              }}
            >
              {VIEWS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="run-suite"
            onClick={runNow}
            disabled={game === undefined}
          >
            Run on every console
          </button>
          {/* Which game the assertions are about, and a way to it. A suite with
              no game beside it is a suite that can never run, and saying so beats
              a Run button that quietly does nothing. */}
          {game === undefined ? (
            <span class="hint">no game in this project to test</span>
          ) : (
            <span class="hint">
              about <a href={fileHash(game)}>{game}</a>
            </span>
          )}
        </div>

        {view === "blocks" ? (
          <BlockEditor
            text={draft}
            dialect={dialectOf(openPath)}
            project={project}
            diagnostics={diagnostics}
            onChange={setDraft}
          />
        ) : (
          <SourceEditor
            value={draft}
            onInput={setDraft}
            label="Demotic test suite"
            spans={highlight(draft)}
          />
        )}

        {view === "text" ? (
          <div class="game-diagnostics">
            {diagnostics.length === 0 ? (
              <p class="hint">No problems.</p>
            ) : (
              diagnostics.map((one, index) => (
                <p key={index} class={one.severity === "error" ? "diag-error" : "diag-warning"}>
                  <strong>{one.code}</strong>
                  {one.line > 0 ? ` line ${String(one.line)}` : ""}: {one.message}
                  {one.hint ? <span class="diag-hint"> — {one.hint}</span> : null}
                </p>
              ))
            )}
          </div>
        ) : null}
      </section>

      <section class="pane">
        <h2>Results</h2>
        {run === null ? (
          <p class="hint" data-testid="suite-idle">
            Nothing has run yet. Every case runs on every console the game compiles for — a suite
            written in the relative vocabulary (<code>centerx</code>, <code>15vw</code>) means the
            same thing on all of them, and one written in absolute cells is where it stops.
          </p>
        ) : (
          <>
            <p
              class={passed(run) ? "suite-pass" : "suite-fail"}
              role="status"
              data-testid="suite-summary"
            >
              {summarise(run)}
            </p>
            <pre class="game-status" data-testid="suite-report">
              {run.report}
            </pre>
          </>
        )}
        {suiteErrors.length > 0 ? (
          <p class="hint">A case with an error in it is skipped rather than failed.</p>
        ) : null}
      </section>
    </main>
  );
}
