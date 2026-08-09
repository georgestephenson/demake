/**
 * What is on screen: a project, and a file open in it (doc 19).
 *
 * The route used to name a *section*; it names a **file** now, and the section
 * is derived from the extension. That is one fewer thing that can disagree with
 * itself — a `.mid` opens the music demaker because it is a track, not because a
 * nav link and a file picker were set to matching values. With the section tabs
 * gone (doc 07 §The workbench) the derivation is the *only* way a section is
 * chosen, apart from the two that open no file at all.
 *
 * `#section=` still reads, because every option permalink shared before the site
 * held projects has one in it, and the art demaker is still what an unrecognised
 * one falls back to (doc 07 §UX).
 */

import { extensionOf, isSuite, kindOf } from "@demake/demotic";

/** The editors, in the order the workbench would list them. */
export const SECTIONS = [
  "game",
  "tests",
  "level",
  "text",
  "language",
  "art",
  "music",
  "sound",
] as const;

/** One editor's id. */
export type Section = (typeof SECTIONS)[number];

/** Human-readable names. */
export const SECTION_LABELS: Readonly<Record<Section, string>> = {
  game: "demotic game demaker",
  tests: "demotic suite editor",
  level: "level editor",
  text: "text editor",
  language: "demotic reference",
  art: "art demaker",
  music: "music demaker",
  sound: "sound demaker",
};

/**
 * Sections that load on demand.
 *
 * Everything except the art demaker, which is what an unrecognised hash falls
 * back to and therefore has to be in the entry chunk. Between them the others
 * carry the whole game language and the whole audio engine, and someone who came
 * to convert an image should download neither (doc 07 §Quality bar).
 */
export const LAZY: readonly Section[] = [
  "game",
  "tests",
  "level",
  "text",
  "language",
  "music",
  "sound",
];

const DEFAULT_SECTION: Section = "art";

/**
 * Extensions the text editor opens, plus the rule for a file with none.
 *
 * An allow-list rather than "anything without a picture editor", because a
 * `.wav` opened in a textarea is a corrupted `.wav` the moment anyone types. A
 * file with **no** extension is text by convention — `Demakefile`, `LICENSE`,
 * `README` — which is the case this list exists for, since the build file is the
 * one doc 19 promises is "also just a file in the explorer".
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "cfg",
  "conf",
  "csv",
  "demakefile",
  "gitignore",
  "ini",
  "json",
  "log",
  "md",
  "text",
  "toml",
  "trace",
  "tsv",
  "txt",
  "yaml",
  "yml",
]);

/** Whether the text editor should open this path. */
export function isTextFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  // A dotfile is `.gitignore`, not a file with the extension `gitignore` — and
  // `extensionOf` agrees, since it ignores a dot at position zero.
  if (name.startsWith(".")) return TEXT_EXTENSIONS.has(name.slice(1).toLowerCase());
  const extension = extensionOf(path);
  return extension === "" || TEXT_EXTENSIONS.has(extension);
}

/**
 * Which editor opens a file.
 *
 * Straight off the kind the language already assigns by extension, so the page
 * keeps no second table of what a `.svg` is. A `.dmt` is the one case the
 * language has no kind for — nothing in a program can *name* a program — so it
 * is named here, and everything left over that reads as text gets the plain
 * editor rather than nothing.
 *
 * The two `.dmt`s are two editors, and `isSuite` is the engine's own answer to
 * which is which — the same predicate `findEntry` uses to decide that a folder
 * holding `pong.dmt` and `pong.test.dmt` has one game in it rather than two.
 */
export function sectionForFile(path: string): Section | undefined {
  // A suite is asked about *first*, because it is a `.dmt` too and the longer
  // extension is the whole distinction. Without this it opened the game demaker
  // — a console picker, a cartridge and a playable preview, wrapped around a
  // file that builds to nothing (doc 19 §The suite editor).
  if (isSuite(path)) return "tests";
  if (path.endsWith(".dmt")) return "game";
  switch (kindOf(path)) {
    case "art":
      return "art";
    case "music":
      return "music";
    case "sound":
      return "sound";
    case "level":
      return "level";
    default:
      return isTextFile(path) ? "text" : undefined;
  }
}

/** Where the hash points: a file if it names one, and the section either way. */
export interface Route {
  section: Section;
  /** The open file's project-relative path, when the hash names one. */
  file?: string;
}

/** Read the route out of a hash fragment. */
export function readRoute(hash: string): Route {
  const query = new URLSearchParams(hash.replace(/^#/, ""));
  const file = query.get("file");
  if (file !== null && file !== "") {
    const section = sectionForFile(file);
    if (section) return { section, file };
  }
  const named = query.get("section");
  const section = (SECTIONS as readonly string[]).includes(named ?? "")
    ? (named as Section)
    : DEFAULT_SECTION;
  return { section };
}

/** Read just the section, for callers that do not care which file. */
export function readSection(hash: string): Section {
  return readRoute(hash).section;
}

/**
 * Whether a hash says nothing at all.
 *
 * The one question that decides where a cold visit lands. An empty hash is
 * somebody arriving at the site, and doc 07 §The workbench says they get the
 * project's game open; a hash with *anything* in it is a link somebody shared —
 * an option permalink carries no `file` and no `section` and must still land on
 * the art demaker it was copied from.
 */
export function isBareHash(hash: string): boolean {
  return hash.replace(/^#/, "").trim() === "";
}

/** The hash that opens a file, preserving nothing else. */
export function fileHash(path: string): string {
  return `#file=${encodeURIComponent(path)}`;
}

/**
 * The hash that selects a section with no file open.
 *
 * Always written out, the art demaker included. It used to be bare `#` for the
 * default section, which cannot survive {@link isBareHash}: "no hash" now means
 * "open the project", so a section with no file needs to say which one.
 */
export function sectionHash(section: Section): string {
  return `#section=${section}`;
}
