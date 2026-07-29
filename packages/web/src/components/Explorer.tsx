/**
 * The project explorer (doc 19 §The shell).
 *
 * A directory listing that is also the router: clicking a file opens the editor
 * for its type, and that is the whole navigation model. It shows only the folders
 * a project has something in — a tree of four empty directories teaches nothing
 * about the project.
 *
 * It knows nothing about what any editor does. Its only claim about a file is
 * which section opens it, which comes from the file's own extension
 * (`sectionForFile`), so a project with an unrecognised file lists it greyed out
 * rather than hiding it: a file you cannot see is a file you think you lost.
 */

import { fileHash, sectionForFile } from "../lib/route.js";
import { filesIn, folders, type Project } from "../lib/project.js";

/** How a folder is described when it is not one of the canonical five. */
const FOLDER_NOTES: Readonly<Record<string, string>> = {
  src: "the game",
  art: "pictures and sprites",
  music: "tracks",
  sound: "effects",
  levels: "rooms",
};

export function Explorer({
  project,
  open,
  examples,
  onOpenExample,
}: {
  project: Project;
  /** The path currently open, so it can be marked. */
  open?: string;
  examples: readonly string[];
  onOpenExample: (name: string) => void;
}) {
  return (
    <aside class="explorer" aria-label="Project">
      <label class="explorer-project">
        <span class="explorer-label">Project</span>
        <select
          data-testid="project-select"
          value={project.name}
          onChange={(event) => onOpenExample((event.currentTarget as HTMLSelectElement).value)}
        >
          {examples.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <nav class="explorer-tree" aria-label="Files">
        {folders(project).map((folder) => (
          <section key={folder} class="explorer-folder">
            <h3>
              {folder === "" ? project.name : folder}
              {FOLDER_NOTES[folder] ? (
                <span class="explorer-note">{FOLDER_NOTES[folder]}</span>
              ) : null}
            </h3>
            <ul>
              {filesIn(project, folder).map((path) => {
                const section = sectionForFile(path);
                const name = path.slice(path.lastIndexOf("/") + 1);
                return (
                  <li key={path}>
                    {section ? (
                      <a
                        href={fileHash(path)}
                        class={`explorer-file${path === open ? " active" : ""}`}
                        aria-current={path === open ? "page" : undefined}
                        data-testid="explorer-file"
                        data-path={path}
                      >
                        {name}
                      </a>
                    ) : (
                      <span class="explorer-file inert" title="no editor opens this file">
                        {name}
                      </span>
                    )}
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
