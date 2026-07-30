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
import { canOpenFolder } from "../lib/disk.js";

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
  onOpenFolder,
  onImportZip,
  onSave,
  onExportZip,
  dirty,
  bound,
}: {
  project: Project;
  /** The path currently open, so it can be marked. */
  open?: string;
  examples: readonly string[];
  onOpenExample: (name: string) => void;
  /** Open a folder from the machine, where the browser allows one. */
  onOpenFolder: () => void;
  /** Read a zip the user picked. */
  onImportZip: (file: File) => void;
  /** Write the project back to the folder it came from. */
  onSave: () => void;
  /** Download the project as a zip. */
  onExportZip: () => void;
  /** Whether the project has unsaved edits, and whether it has a folder to save to. */
  dirty: boolean;
  bound: boolean;
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

      <div class="explorer-actions">
        {canOpenFolder() ? (
          <button type="button" data-testid="open-folder" onClick={onOpenFolder}>
            Open folder…
          </button>
        ) : null}
        <label class="explorer-import">
          <span>Import zip…</span>
          <input
            type="file"
            accept=".zip,application/zip"
            data-testid="import-zip"
            onChange={(event) => {
              const input = event.currentTarget as HTMLInputElement;
              const file = input.files?.[0];
              if (file) onImportZip(file);
              input.value = "";
            }}
          />
        </label>
        {bound ? (
          <button type="button" data-testid="save-folder" onClick={onSave}>
            {dirty ? "Save •" : "Save"}
          </button>
        ) : null}
        <button type="button" data-testid="export-zip" onClick={onExportZip}>
          Download zip
        </button>
      </div>

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
