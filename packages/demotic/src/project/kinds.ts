/**
 * What kind of file a reference wants, and which extensions carry it.
 *
 * The kind never comes from the reference — it comes from the *statement* that
 * names it, because `sprite`, `music`, `sound` and `level … from` each want
 * exactly one kind of file (doc 19 §The rule). That is what makes an extension
 * optional: `sprite ball` has no need to say `.png`, since the only files it
 * could possibly mean are the art ones.
 *
 * The lists below are therefore a *filter over the project*, not a statement
 * about what the engine can decode. `art` names formats `decodeImage` has no
 * codec for yet on purpose: finding the file is this module's job, and being
 * told "JPEG decoding is not available in this build" is a far better answer
 * than being told the asset is missing.
 */

/** The kinds of file a Demotic program can name. */
export type AssetKind = "art" | "music" | "sound" | "level";

/**
 * Extensions per kind, lower case and without the dot.
 *
 * Disjoint by construction: no extension appears under two kinds, which is what
 * lets `ball` mean the art file and never the track of the same name.
 */
const EXTENSIONS: Readonly<Record<AssetKind, readonly string[]>> = {
  art: ["png", "svg", "jpg", "jpeg", "gif", "webp", "bmp"],
  music: ["mid", "midi"],
  sound: ["wav"],
  level: ["dmtl"],
};

/** Every kind, in a stable order. */
export const KINDS = Object.keys(EXTENSIONS) as readonly AssetKind[];

/** The extensions a kind accepts, for a picker that has to list them. */
export function extensionsFor(kind: AssetKind): readonly string[] {
  return EXTENSIONS[kind];
}

/** The extension of a path, lower case and without the dot; `""` when it has none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** A path with its extension removed; the whole name when it has none. */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/**
 * Which kind a file is, by extension — or `undefined` for anything a program
 * cannot name (a `.dmt`, a Demakefile, a stray note to self).
 */
export function kindOf(path: string): AssetKind | undefined {
  const extension = extensionOf(path);
  if (extension === "") return undefined;
  for (const kind of KINDS) {
    if (EXTENSIONS[kind].includes(extension)) return kind;
  }
  return undefined;
}
