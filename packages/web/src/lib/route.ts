/**
 * Which of the site's demakers is on screen.
 *
 * The route lives in the hash alongside the art demaker's option permalink, and
 * the art demaker is the *unmarked* default — so every link shared before the
 * site grew sections still opens exactly what it used to (doc 07 §UX).
 */

/** The four top-level sections. */
export const SECTIONS = ["game", "art", "music", "sound"] as const;

/** One section id. */
export type Section = (typeof SECTIONS)[number];

/** Human-readable names, in nav order. */
export const SECTION_LABELS: Readonly<Record<Section, string>> = {
  game: "demotic game demaker",
  art: "art demaker",
  music: "music demaker",
  sound: "sound demaker",
};

/** Sections that are announced but not yet built. */
export const COMING_SOON: readonly Section[] = ["music", "sound"];

const DEFAULT_SECTION: Section = "art";

/** Read the section out of a hash fragment. Unknown or absent means art. */
export function readSection(hash: string): Section {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const value = params.get("section");
  return (SECTIONS as readonly string[]).includes(value ?? "")
    ? (value as Section)
    : DEFAULT_SECTION;
}

/** The hash that selects a section, preserving nothing else. */
export function sectionHash(section: Section): string {
  return section === DEFAULT_SECTION ? "#" : `#section=${section}`;
}
