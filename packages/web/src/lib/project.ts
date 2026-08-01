/**
 * A project, as the page holds one (doc 19).
 *
 * A folder: a map from project-relative path to bytes. That is the whole model,
 * and it is deliberately the *same* model the CLI builds and the same one a saved
 * folder or an imported zip produces — there is no page-side project format, and
 * nothing here decides where a file may live.
 *
 * Everything the sections need is derived rather than stored: which files are
 * art, which is a game's source, what the compiler should be handed. A stored
 * index would be a second answer to "what is in this project?", and the folder is
 * the first one.
 */

import { kindOf, type AssetKind } from "@demake/demotic";

/** One file. */
export interface ProjectFile {
  /** Project-relative, `/`-separated: `art/ball.svg`. */
  path: string;
  bytes: Uint8Array;
  /**
   * A URL for the bytes, when something has to point a browser at them.
   *
   * Only art needs this — the preview draws a sprite with an `<img>` — and it is
   * created on demand rather than up front, because a project holds a few dozen
   * files and most of them are never drawn.
   */
  url?: string;
}

/** A whole project. */
export interface Project {
  /** The folder's own name, which is what the explorer shows. */
  name: string;
  files: Map<string, ProjectFile>;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Every path in the project, sorted — what the compiler resolves against. */
export function projectFiles(project: Project): readonly string[] {
  return [...project.files.keys()].sort();
}

/** The paths of one kind, sorted. */
export function filesOfKind(project: Project, kind: AssetKind): readonly string[] {
  return projectFiles(project).filter((path) => kindOf(path) === kind);
}

/** The `.dmt` sources in the project, sorted, test suites last. */
export function gameFiles(project: Project): readonly string[] {
  const all = projectFiles(project).filter((path) => path.endsWith(".dmt"));
  return [
    ...all.filter((p) => !p.endsWith(".test.dmt")),
    ...all.filter((p) => p.endsWith(".test.dmt")),
  ];
}

/** One file's text. */
export function readText(project: Project, path: string): string {
  const file = project.files.get(path);
  return file ? decoder.decode(file.bytes) : "";
}

/** Replace a file's contents, returning a new project — state is immutable here. */
export function writeText(project: Project, path: string, text: string): Project {
  const files = new Map(project.files);
  const existing = files.get(path);
  if (existing?.url) URL.revokeObjectURL(existing.url);
  files.set(path, { path, bytes: encoder.encode(text) });
  return { ...project, files };
}

/** Add a file that was dropped in, returning a new project. */
export function addFile(project: Project, path: string, bytes: Uint8Array): Project {
  const files = new Map(project.files);
  files.set(path, { path, bytes });
  return { ...project, files };
}

/**
 * Move a file, which is also how one is renamed.
 *
 * They are the same operation because a project is a flat map from path to
 * bytes — there are no directories to move between, only names with slashes in
 * them (doc 19 §The layout: the folder structure is a convention, and nothing
 * resolves a reference by looking in one). So the explorer offers one gesture
 * and `art/ball.svg` → `sprites/ball.svg` is a rename like any other.
 *
 * Returns the project unchanged when there is nothing at `from`, and refuses to
 * land on a path something else already occupies: silently replacing a file is
 * the one outcome nobody can undo.
 */
export function moveFile(project: Project, from: string, to: string): Project {
  const file = project.files.get(from);
  if (!file || from === to || to === "" || project.files.has(to)) return project;
  const files = new Map(project.files);
  files.delete(from);
  // The URL is keyed to the bytes, not the name, so it survives the move — but
  // the entry records its own path and something will read it back.
  files.set(to, { ...file, path: to });
  return { ...project, files };
}

/** Remove a file, returning a new project. */
export function removeFile(project: Project, path: string): Project {
  const file = project.files.get(path);
  if (!file) return project;
  if (file.url) URL.revokeObjectURL(file.url);
  const files = new Map(project.files);
  files.delete(path);
  return { ...project, files };
}

/**
 * Tidy a path the way a person typing one expects.
 *
 * Leading and trailing slashes go, `\` becomes `/`, runs collapse, and `.`
 * segments are dropped. A `..` is refused outright rather than resolved — a
 * project is a folder and a path that climbs out of it is not a path in the
 * project, which is the same call `importZip` makes about an archive entry.
 */
export function normalisePath(input: string): string | undefined {
  const parts = input
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return undefined;
  return parts.join("/");
}

/**
 * The media type a blob URL needs, by extension.
 *
 * An `<img>` pointed at a blob URL believes the blob's type and does not sniff
 * for SVG: with the type left off, every drawing in the project is a broken
 * image and the preview quietly falls back to flat blocks. Only the kinds
 * something points a browser at are listed.
 */
const MEDIA: Readonly<Record<string, string>> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/**
 * The media type a blob URL for this path needs, or `undefined` for the rest.
 *
 * Exported because two things point a browser at a file's bytes — the explorer's
 * pictures and the art demaker's own source pane — and a second table is how one
 * of them comes to show broken images. It did: the art pane built its blob with
 * no type at all, so every `.svg` in every project was an empty box beside a
 * demade result that had come out perfectly.
 */
export function mediaTypeOf(path: string): string | undefined {
  return MEDIA[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
}

/**
 * A URL for one file's bytes, made once and kept.
 *
 * Mutates the entry rather than the map: a URL is a cache over immutable bytes,
 * not a change to the project, so creating one must not make the project look
 * edited.
 */
export function fileUrl(project: Project, path: string): string | undefined {
  const file = project.files.get(path);
  if (!file) return undefined;
  const type = mediaTypeOf(path);
  file.url ??= URL.createObjectURL(
    new Blob([file.bytes as BlobPart], ...(type === undefined ? [] : [{ type }])),
  );
  return file.url;
}

/** Every `.dmtl` in the project, as text keyed by path — `CompileOptions.levels`. */
export function levelSources(project: Project): Record<string, string> {
  const levels: Record<string, string> = {};
  for (const path of filesOfKind(project, "level")) levels[path] = readText(project, path);
  return levels;
}

/**
 * Every asset in the project as source bytes, keyed by path.
 *
 * All of them rather than the ones a program names: the build asks for what it
 * needs, an unused entry costs nothing, and deciding which are needed is the
 * compiler's job (it is what `Program.assets` is).
 */
export function assetBytes(project: Project): Map<string, Uint8Array> {
  const assets = new Map<string, Uint8Array>();
  for (const [path, file] of project.files) {
    if (path.endsWith(".dmt")) continue;
    assets.set(path, file.bytes);
  }
  return assets;
}

/** The folders a project has something in, in the canonical order, then the rest. */
export function folders(project: Project): readonly string[] {
  const order = ["src", "art", "music", "sound", "levels"];
  const seen = new Set<string>();
  for (const path of projectFiles(project)) {
    const slash = path.indexOf("/");
    seen.add(slash < 0 ? "" : path.slice(0, slash));
  }
  return [
    ...order.filter((f) => seen.has(f)),
    ...[...seen].filter((f) => !order.includes(f)).sort(),
  ];
}

/** The files directly inside one folder (`""` for the project root), sorted. */
export function filesIn(project: Project, folder: string): readonly string[] {
  return projectFiles(project).filter((path) => {
    const slash = path.lastIndexOf("/");
    return (slash < 0 ? "" : path.slice(0, slash)) === folder;
  });
}
