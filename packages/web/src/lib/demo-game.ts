/**
 * The example library, bundled into the page.
 *
 * Imported from `@demake/demotic`'s fixtures rather than copied, so the page,
 * the CLI, the unit suite and the conformance traces are all running the same
 * games. A second copy would drift the first time anyone edited one.
 *
 * Each example is here because it exercises something the others do not — the
 * set is the feature inventory a console runtime has to satisfy (doc 14
 * §Runtime model), not a gallery.
 */

import pongSource from "@demake/demotic/fixtures/pong.dmt?raw";
import pongTests from "@demake/demotic/fixtures/pong.test.dmt?raw";
import breakoutSource from "@demake/demotic/fixtures/games/breakout.dmt?raw";
import breakoutTests from "@demake/demotic/fixtures/games/breakout.test.dmt?raw";
import platformerSource from "@demake/demotic/fixtures/games/platformer.dmt?raw";
import platformerTests from "@demake/demotic/fixtures/games/platformer.test.dmt?raw";
import dodgerSource from "@demake/demotic/fixtures/games/dodger.dmt?raw";
import dodgerTests from "@demake/demotic/fixtures/games/dodger.test.dmt?raw";
import shooterSource from "@demake/demotic/fixtures/games/shooter.dmt?raw";
import shooterTests from "@demake/demotic/fixtures/games/shooter.test.dmt?raw";
import cavesSource from "@demake/demotic/fixtures/games/caves.dmt?raw";
import cavesTests from "@demake/demotic/fixtures/games/caves.test.dmt?raw";
import runnerSource from "@demake/demotic/fixtures/games/runner.dmt?raw";
import runnerTests from "@demake/demotic/fixtures/games/runner.test.dmt?raw";

import cavernLevel from "@demake/demotic/fixtures/games/cavern.dmtl?raw";
import openLevel from "@demake/demotic/fixtures/games/open.dmtl?raw";
import lowpipeLevel from "@demake/demotic/fixtures/games/lowpipe.dmtl?raw";
import highpipeLevel from "@demake/demotic/fixtures/games/highpipe.dmtl?raw";
import pipemidLevel from "@demake/demotic/fixtures/games/pipemid.dmtl?raw";

/**
 * Every piece of art the library ships, found rather than listed.
 *
 * A hand-written list of imports is the drift this module's own header warns
 * about: the games gained title screens, playfields and a dozen new sprites in
 * one change, and a list would have shipped a page whose cartridges were missing
 * art the CLI had. The glob is eager, so this is still a static bundle with no
 * runtime fetching — it just cannot go stale.
 *
 * Keys are basenames, because that is how a `.dmt` or a `.dmtl` legend names a
 * file: art is loaded from beside the source that named it.
 */
const ASSET_URLS = import.meta.glob<string>("../../../demotic/fixtures/**/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

const ASSET_SOURCES = import.meta.glob<string>("../../../demotic/fixtures/**/*.svg", {
  eager: true,
  query: "?raw",
  import: "default",
});

function byBasename(found: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, value] of Object.entries(found)) {
    out[path.slice(path.lastIndexOf("/") + 1)] = value;
  }
  return out;
}

/** One bundled example. */
export interface Example {
  id: string;
  name: string;
  /** What this one exercises that the others do not. */
  covers: string;
  source: string;
  tests: string;
}

export const EXAMPLES: readonly Example[] = [
  {
    id: "pong",
    name: "Pong",
    covers: "two movers, a bounce angle, and proportional opponent steering",
    source: pongSource,
    tests: pongTests,
  },
  {
    id: "breakout",
    name: "Breakout",
    covers: "a grid of objects, removal, and real sprite-budget pressure",
    source: breakoutSource,
    tests: breakoutTests,
  },
  {
    id: "platformer",
    name: "Platformer",
    covers: "gravity, an impulse jump, and resting contact",
    source: platformerSource,
    tests: platformerTests,
  },
  {
    id: "dodger",
    name: "Dodger",
    covers: "many objects at staggered speeds, recycled rather than destroyed",
    source: dodgerSource,
    tests: dodgerTests,
  },
  {
    id: "shooter",
    name: "Shooter",
    covers: "the per-scanline sprite limit's worst case, and a fast projectile",
    source: shooterSource,
    tests: shooterTests,
  },
  {
    id: "caves",
    name: "Caves",
    covers: "a hand-drawn level bigger than the screen, tiles, and a scrolling camera",
    source: cavesSource,
    tests: cavesTests,
  },
  {
    id: "runner",
    name: "Runner",
    covers: "a course composed from chunks at build time, and the seeded generator",
    source: runnerSource,
    tests: runnerTests,
  },
];

/**
 * `.dmtl` sources, keyed as a `.dmt` file names them.
 *
 * The compiler never reads a file, so the page resolves these the way the CLI
 * and the terminal runners do — same `levelFiles()` lookup, same set. Handing
 * over every bundled level rather than only the ones a game names is fine and
 * one fewer moving part: an unused entry is simply never asked for.
 */
export const DEMO_LEVELS: Readonly<Record<string, string>> = {
  "cavern.dmtl": cavernLevel,
  "open.dmtl": openLevel,
  "lowpipe.dmtl": lowpipeLevel,
  "highpipe.dmtl": highpipeLevel,
  "pipemid.dmtl": pipemidLevel,
};

/** Asset name (as written in a `.dmt`) → bundled URL. */
export const DEMO_ASSETS: Readonly<Record<string, string>> = byBasename(ASSET_URLS);

/**
 * The same assets as text, for the ROM build.
 *
 * The preview draws them through the browser's own SVG renderer, which is fine
 * because a preview only has to look right. A cartridge has to be *identical*
 * to the one `demake build` writes, so the page hands the source text to
 * `@demake/core`'s rasteriser instead — the same code, the same pixels, both
 * sides (doc 07 §parity).
 */
export const DEMO_ASSET_SOURCES: Readonly<Record<string, string>> = byBasename(ASSET_SOURCES);

/** The bundled art, as the bytes a ROM build takes. */
export function demoAssetBytes(): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  const out = new Map<string, Uint8Array>();
  for (const [name, text] of Object.entries(DEMO_ASSET_SOURCES)) {
    out.set(name, encoder.encode(text));
  }
  return out;
}

/**
 * The library's music and effects, by the name a `.dmt` writes.
 *
 * As URLs rather than inlined bytes, and fetched when a cartridge is built:
 * these are binary, so bundling them means base64, and a hundred kilobytes of
 * WAV becomes a hundred and thirty of JavaScript every visitor downloads whether
 * they build a ROM or not. They are static files on the same origin, so the
 * service worker caches them like anything else.
 *
 * They must be *bytes*, not something the page decoded: the ROM build hands them
 * to `@demake/audio`, which is what makes the page's cartridge identical to the
 * CLI's (doc 07 §parity). The page decodes nothing and demakes nothing itself.
 */
const AUDIO_URLS = import.meta.glob<string>("../../../demotic/fixtures/**/*.{mid,wav}", {
  eager: true,
  query: "?url",
  import: "default",
});

let audioBytes: Map<string, Uint8Array> | undefined;

/** Fetch the bundled audio once; later calls get the same map back. */
export async function demoAudioBytes(): Promise<Map<string, Uint8Array>> {
  if (audioBytes) return audioBytes;
  const out = new Map<string, Uint8Array>();
  const named = byBasename(AUDIO_URLS);
  await Promise.all(
    Object.entries(named).map(async ([name, url]) => {
      const response = await fetch(url);
      out.set(name, new Uint8Array(await response.arrayBuffer()));
    }),
  );
  audioBytes = out;
  return out;
}

/** The example the section opens with. */
export const DEFAULT_EXAMPLE = EXAMPLES[0] as Example;
