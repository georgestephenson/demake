/**
 * Turning a reference in a program into a file in the project.
 *
 * A reference is **the shortest name that identifies one file** (doc 19 §The
 * rule): `ball` where one art file is called that, `ball.png` where two share a
 * stem, `foo/ball.png` where two directories hold the name. Nothing here looks
 * in a particular folder — the layout of a project is free, and `art/`,
 * `music/`, `sound/` and `levels/` are a convention `demake init` writes rather
 * than anything resolution depends on.
 *
 * Three properties this module has to keep:
 *
 * - **Ambiguity is reported, never resolved.** Two files answering to one
 *   reference is an error naming both, because picking one is exactly the
 *   silently-wrong-program failure the language refuses everywhere else (doc 14
 *   §The readings the language will not guess between).
 * - **Matching is case-insensitive**, because the lexer folds identifiers to
 *   lower case: `sprite Ball.PNG` reaches the compiler as `ball.png`, so a file
 *   spelled `Ball.png` would otherwise be unreferenceable. The *path returned*
 *   is always the file's own spelling.
 * - **It is pure and order-free.** Callers pass a sorted file list; the answer
 *   depends on the set, never on the order, so two edges that enumerate a
 *   directory by completely different means agree (doc 19 §What does not change).
 */

import { kindOf, stemOf, type AssetKind } from "./kinds.js";

/** What a reference matched. */
export interface Resolution {
  /** The file, when exactly one matched. */
  path?: string;
  /**
   * Every file the reference matched, in the order of the list it was given.
   *
   * Empty means nothing matched; more than one means ambiguous, and the caller
   * reports it with the line that asked.
   */
  candidates: readonly string[];
}

/** Strip the decoration a hand-written path might carry, and unify separators. */
function normalise(reference: string): string {
  return reference
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

/**
 * Whether `reference` names `file`.
 *
 * The reference's segments must be a **tail** of the file's, compared segment by
 * segment — so `ball.png` never matches `pinball.png` and `foo/ball` never
 * matches `bar/ball.png`. The final segment matches the file's name *or* its
 * name with the extension removed, which is the whole of "extensions are
 * optional".
 */
function matches(segments: readonly string[], file: string): boolean {
  const parts = normalise(file).split("/");
  if (segments.length === 0 || segments.length > parts.length) return false;
  const tail = parts.slice(parts.length - segments.length);
  for (let i = 0; i < segments.length - 1; i += 1) {
    if ((tail[i] as string).toLowerCase() !== segments[i]) return false;
  }
  const name = (tail[tail.length - 1] as string).toLowerCase();
  const wanted = segments[segments.length - 1] as string;
  return name === wanted || stemOf(name) === wanted;
}

/**
 * Resolve a reference of a known kind against the project's files.
 *
 * Where a candidate's whole relative path *is* the reference, that candidate
 * wins alone. Without that rule a file could be unnameable: `foo/ball.png`
 * beside `art/foo/ball.png` would leave the first permanently ambiguous with the
 * second, since a full path is also a suffix of a longer one. It is specificity
 * rather than a quiet tiebreak — naming a file completely means that file — and
 * it is why no rooting syntax (a leading `/`) had to be invented.
 */
export function resolveReference(
  reference: string,
  kind: AssetKind,
  files: readonly string[],
): Resolution {
  const wanted = normalise(reference).toLowerCase();
  const segments = wanted.split("/").filter((part) => part.length > 0);
  const candidates: string[] = [];
  for (const file of files) {
    if (kindOf(file) !== kind) continue;
    if (normalise(file).toLowerCase() === wanted) return { path: file, candidates: [file] };
    if (matches(segments, file)) candidates.push(file);
  }
  return candidates.length === 1 ? { path: candidates[0] as string, candidates } : { candidates };
}

/**
 * The shortest reference that identifies `path` and nothing else.
 *
 * The inverse of {@link resolveReference}, for anything that has to *write* a
 * reference: a file picker in the block editor, a level legend bound to a new
 * sprite, `demake fmt`. It walks the same ladder a person would — stem, then
 * name with its extension, then a leading segment at a time — and stops at the
 * first rung that is unambiguous. The whole path is the last rung and always
 * works, by the exact-match rule above.
 */
export function shortestName(path: string, files: readonly string[]): string {
  const kind = kindOf(path);
  if (kind === undefined) return path;
  const parts = normalise(path).split("/");
  const name = parts[parts.length - 1] as string;
  const rungs: string[] = [stemOf(name), name];
  for (let extra = 1; extra < parts.length; extra += 1) {
    rungs.push(parts.slice(parts.length - extra - 1).join("/"));
  }
  for (const rung of rungs) {
    if (resolveReference(rung, kind, files).path === path) return rung;
  }
  return path;
}
