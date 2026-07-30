/**
 * The bundled example projects.
 *
 * Globbed out of `@demake/demotic`'s fixture folders rather than listed, so the
 * page, the CLI and the conformance suite open the *same* projects — the folder
 * on disk is the format (doc 19), and a hand-written list of files is the drift
 * that layout exists to remove. It went stale exactly that way once already,
 * when the games gained title screens and a dozen sprites in one change.
 *
 * Text arrives inlined (`?raw`) because a `.dmt` is what the editor shows on the
 * first frame. Everything binary arrives as a URL and is fetched on demand: a
 * hundred kilobytes of WAV becomes a hundred and thirty of JavaScript if it is
 * inlined, and every visitor would download it whether they opened a project or
 * not. They are static files on the same origin, so the service worker caches
 * them like anything else.
 */

import { addFile, type Project } from "./project.js";

const TEXT = import.meta.glob<string>("../../../demotic/fixtures/projects/**/*.{dmt,dmtl,trace}", {
  eager: true,
  query: "?raw",
  import: "default",
});

const BINARY = import.meta.glob<string>(
  "../../../demotic/fixtures/projects/**/*.{svg,png,mid,wav}",
  { eager: true, query: "?url", import: "default" },
);

const PREFIX = "../../../demotic/fixtures/projects/";

/** Split a globbed key into its project and the path inside it. */
function split(key: string): { project: string; path: string } | undefined {
  if (!key.startsWith(PREFIX)) return undefined;
  const rest = key.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  return { project: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

/** The example projects, by name. */
export const EXAMPLE_NAMES = [
  "pong",
  "breakout",
  "platformer",
  "dodger",
  "shooter",
  "caves",
  "runner",
  "quest",
] as const;

/** One example's name. Pong is what the page opens with. */
export type ExampleName = (typeof EXAMPLE_NAMES)[number];

/** Where each project's binary files live, so they can be fetched on demand. */
const urls = new Map<string, Map<string, string>>();

const encoder = new TextEncoder();

/**
 * The text half of every example, built at module load.
 *
 * Enough to open a project: the explorer lists its files, the editor shows its
 * source, and the interpreter runs. The art and the audio arrive with
 * {@link loadBinary}, which is what a cartridge and a preview wait for.
 */
const skeletons = new Map<string, Project>();

for (const [key, text] of Object.entries(TEXT)) {
  const found = split(key);
  if (!found) continue;
  const project = skeletons.get(found.project) ?? { name: found.project, files: new Map() };
  skeletons.set(found.project, addFile(project, found.path, encoder.encode(text)));
}

for (const [key, url] of Object.entries(BINARY)) {
  const found = split(key);
  if (!found) continue;
  const forProject = urls.get(found.project) ?? new Map<string, string>();
  forProject.set(found.path, url);
  urls.set(found.project, forProject);
}

/**
 * An example project with its text files, and its binaries still to fetch.
 *
 * Every binary is *present but empty* rather than absent, because the explorer
 * lists what a project contains and a tree that grew a dozen entries a moment
 * after opening would look like a fault. The bytes arrive with
 * {@link loadExample}; until they do, a build waits and says so.
 */
export function exampleSkeleton(name: string): Project {
  const found = skeletons.get(name);
  if (!found) throw new Error(`no example project '${name}'`);
  // A copy, so editing one never changes the bundle's idea of it — reopening an
  // example has to give you the example back.
  let project: Project = { name: found.name, files: new Map(found.files) };
  for (const path of exampleBinaryPaths(name)) {
    if (!project.files.has(path)) project = addFile(project, path, new Uint8Array());
  }
  return project;
}

/** Which binary files an example has, without fetching any of them. */
export function exampleBinaryPaths(name: string): readonly string[] {
  return [...(urls.get(name)?.keys() ?? [])].sort();
}

/**
 * Fetch an example's art and audio into the project.
 *
 * Every file at once rather than on first use: they are a few hundred kilobytes
 * from the same origin, a build needs most of them anyway, and a project whose
 * files appear one at a time would make the explorer flicker.
 */
export async function loadExample(name: string): Promise<Project> {
  let project = exampleSkeleton(name);
  const binaries = urls.get(name);
  if (!binaries) return project;
  const fetched = await Promise.all(
    [...binaries].map(async ([path, url]) => {
      const response = await fetch(url);
      return [path, new Uint8Array(await response.arrayBuffer())] as const;
    }),
  );
  for (const [path, bytes] of fetched) project = addFile(project, path, bytes);
  return project;
}
