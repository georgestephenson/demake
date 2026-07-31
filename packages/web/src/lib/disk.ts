/**
 * A project on the user's machine (doc 19 §Opening, saving, and the parity claim).
 *
 * Two bindings from the in-memory tree to somewhere, and the tree is always the
 * model. A real directory, where the browser has the File System Access API: open
 * a folder, edit, save, and the files on disk are the files `demake build` builds.
 * A zip, everywhere else. Nothing goes to a server in either case — a project
 * never leaves the tab except when you save it (doc 07 §Principles).
 *
 * The `showDirectoryPicker` API is Chromium-only today, which is why the zip is
 * not a fallback for a lesser browser but the *other half* of the feature: a
 * project that made the round trip through a zip is byte-identical to one that
 * did not, so neither path is the degraded one.
 */

import { addFile, projectFiles, type Project } from "./project.js";
import { isIgnoredPath } from "@demake/demotic";
import { readZip, writeZip } from "./zip.js";

/** The subset of the File System Access API this uses, so the absence is testable. */
interface DirectoryHandle {
  name: string;
  values(): AsyncIterableIterator<FileSystemHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}
interface FileHandleLike {
  kind: "file" | "directory";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: BufferSource): Promise<void>; close(): Promise<void> }>;
}
type FileSystemHandleLike = FileHandleLike | (DirectoryHandle & { kind: "directory" });

interface PickerWindow {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandle>;
}

/** Whether this browser can open a real folder. */
export function canOpenFolder(): boolean {
  return typeof (globalThis as PickerWindow).showDirectoryPicker === "function";
}

/** Walk a directory handle into a project, skipping what a build writes. */
async function walk(handle: DirectoryHandle, prefix = ""): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for await (const entry of handle.values()) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    // `build/` and dot-directories are the CLI's, not the project's (doc 19).
    if (isIgnoredPath(path)) continue;
    if (entry.kind === "directory") {
      for (const [nested, bytes] of await walk(entry as DirectoryHandle, path)) {
        files.set(nested, bytes);
      }
    } else {
      const file = await (entry as FileHandleLike).getFile();
      files.set(path, new Uint8Array(await file.arrayBuffer()));
    }
  }
  return files;
}

/** What an opened folder gives back: the project, and the handle to save it to. */
export interface OpenedFolder {
  project: Project;
  handle: unknown;
}

/** Ask for a folder and read it as a project. Resolves to null if the user cancels. */
export async function openFolder(): Promise<OpenedFolder | null> {
  const picker = (globalThis as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("this browser cannot open a folder; import a zip instead");
  let handle: DirectoryHandle;
  try {
    handle = await picker({ mode: "readwrite" });
  } catch {
    return null; // the user dismissed the picker, which is not an error
  }
  let project: Project = { name: handle.name, files: new Map() };
  for (const [path, bytes] of await walk(handle)) project = addFile(project, path, bytes);
  return { project, handle };
}

/**
 * Write a project back to the folder it came from.
 *
 * Every file, every time, rather than tracking which changed: a project is a few
 * dozen small files, and a save that wrote only what it *believed* had changed
 * would be a second answer to what the project contains.
 */
export async function saveToFolder(handle: unknown, project: Project): Promise<void> {
  const root = handle as DirectoryHandle;
  for (const path of projectFiles(project)) {
    const parts = path.split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(part, { create: true });
    }
    const file = await directory.getFileHandle(parts[parts.length - 1] as string, { create: true });
    const writable = await file.createWritable();
    const bytes = project.files.get(path)?.bytes ?? new Uint8Array();
    await writable.write(bytes as unknown as BufferSource);
    await writable.close();
  }
}

/**
 * A project as a zip, under a folder of its own name.
 *
 * `build/` never goes in, in either direction: it is generated (doc 19 §`build/`
 * is the CLI's), so a zip carrying one would make a stale artifact travel with
 * the sources it no longer matches.
 */
export function exportZip(project: Project): Uint8Array {
  return writeZip(
    project.name,
    projectFiles(project)
      .filter((path) => !isIgnoredPath(path))
      .map((path) => ({
        path,
        bytes: project.files.get(path)?.bytes ?? new Uint8Array(),
      })),
  );
}

/** A zip as a project, with its folder name taken from the archive. */
export function importZip(name: string, bytes: Uint8Array): Project {
  const { folder, entries } = readZip(bytes);
  let project: Project = {
    name: folder === "" ? name.replace(/\.zip$/i, "") : folder,
    files: new Map(),
  };
  for (const entry of entries) {
    if (isIgnoredPath(entry.path)) continue;
    project = addFile(project, entry.path, entry.bytes);
  }
  return project;
}
