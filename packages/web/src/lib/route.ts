/**
 * What is on screen: a project, and a file open in it (doc 19).
 *
 * The route used to name a *section*; it names a **file** now, and the section is
 * derived from the extension. That is one fewer thing that can disagree with
 * itself — a `.mid` opens the music demaker because it is a track, not because a
 * nav link and a file picker were set to matching values.
 *
 * `#section=` still reads, because every option permalink shared before the site
 * held projects has one in it, and the art demaker is still the unmarked default
 * (doc 07 §UX).
 */

import { kindOf } from "@demake/demotic";

/** The editors, in the order the nav lists them. */
export const SECTIONS = ["game", "level", "language", "art", "music", "sound"] as const;

/** One editor's id. */
export type Section = (typeof SECTIONS)[number];

/** Human-readable names, in nav order. */
export const SECTION_LABELS: Readonly<Record<Section, string>> = {
  game: "demotic game demaker",
  level: "level editor",
  language: "demotic reference",
  art: "art demaker",
  music: "music demaker",
  sound: "sound demaker",
};

/**
 * Sections that load on demand.
 *
 * Everything except the art demaker, which is the unmarked default and therefore
 * has to be in the entry chunk. Between them the others carry the whole game
 * language and the whole audio engine, and someone who came to convert an image
 * should download neither (doc 07 §Quality bar).
 */
export const LAZY: readonly Section[] = ["game", "level", "language", "music", "sound"];

const DEFAULT_SECTION: Section = "art";

/**
 * Which editor opens a file.
 *
 * Straight off the kind the language already assigns by extension, so the page
 * keeps no second table of what a `.svg` is. A `.dmt` is the one case the
 * language has no kind for — nothing in a program can *name* a program — so it is
 * named here.
 */
export function sectionForFile(path: string): Section | undefined {
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
      return undefined;
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

/** The hash that opens a file, preserving nothing else. */
export function fileHash(path: string): string {
  return `#file=${encodeURIComponent(path)}`;
}

/** The hash that selects a section with no file open. */
export function sectionHash(section: Section): string {
  return section === DEFAULT_SECTION ? "#" : `#section=${section}`;
}
