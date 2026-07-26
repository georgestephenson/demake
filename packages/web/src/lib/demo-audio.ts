/**
 * The bundled tracks and effects, for the two audio sections.
 *
 * The same files the example games are built from, imported from
 * `@demake/demotic`'s fixtures rather than copied — so what the page demakes is
 * what `pnpm test` demakes and what a cartridge ends up carrying.
 *
 * URLs rather than inlined bytes, fetched on demand: these are binary, so
 * bundling them means base64, and a hundred kilobytes of WAV would become a
 * hundred and thirty of JavaScript that every visitor downloads whether they open
 * an audio section or not. They are static files on the same origin, so the
 * service worker caches them like anything else.
 *
 * They must reach the demakers as *bytes*. The page decodes nothing and demakes
 * nothing itself: the MIDI parser and the WAV decoder are `@demake/audio`'s, which
 * is what makes the page's `.vgm` the CLI's (doc 07 §Principles).
 */

const TRACK_URLS = import.meta.glob<string>("../../../demotic/fixtures/**/*.mid", {
  eager: true,
  query: "?url",
  import: "default",
});

const EFFECT_URLS = import.meta.glob<string>("../../../demotic/fixtures/**/*.wav", {
  eager: true,
  query: "?url",
  import: "default",
});

/** One bundled source file. */
export interface DemoAudio {
  /** File name, as a `.dmt` writes it. */
  name: string;
  /** What it is, and which example game it belongs to. */
  note: string;
  url: string;
}

/**
 * What each file is for.
 *
 * Written down rather than derived, because "descent.mid" says nothing about
 * being a four-part descending-bass loop — and the point of choosing between
 * them is hearing what the arranger does with *different* material.
 */
const NOTES: Readonly<Record<string, string>> = {
  "rally.mid": "Pong — sparse two-bar loop, room to spare",
  "arcade.mid": "Breakout — driving bass, chords and a busy kit",
  "meadow.mid": "Platformer — eight bars, the longest of them",
  "descent.mid": "Dodger — dense chords over a falling bass",
  "squadron.mid": "Shooter — two bars, held to a tight budget",
  "hollow.mid": "Caves — slow pads, mostly harmony",
  "updraft.mid": "Runner — fast arpeggios against a steady kit",
  "bounce.wav": "Pong — a short pitched knock",
  "point.wav": "Pong — a rising two-tone chime",
  "brick.wav": "Breakout — a bright ceramic crack",
  "jump.wav": "Platformer — an upward sweep",
  "coin.wav": "Platformer — a metallic pickup",
  "hurt.wav": "Dodger — a downward hit",
  "crash.wav": "Runner — broadband noise, no pitch at all",
  "flap.wav": "Runner — a soft airy thud",
  "shot.wav": "Shooter — a clipped noise burst",
  "boom.wav": "Shooter — a long decaying explosion",
};

function catalogue(found: Record<string, string>): DemoAudio[] {
  const byName = new Map<string, DemoAudio>();
  for (const [path, url] of Object.entries(found)) {
    // Keyed by basename, the way a `.dmt` names a file. The library ships one
    // sound under two paths; either copy is the same bytes.
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (byName.has(name)) continue;
    byName.set(name, { name, note: NOTES[name] ?? "from the example library", url });
  }
  // Ordered by the notes above, so the list reads as a tour rather than
  // alphabetically; anything unlisted follows in name order.
  const order = Object.keys(NOTES);
  return [...byName.values()].sort((a, b) => {
    const ai = order.indexOf(a.name);
    const bi = order.indexOf(b.name);
    if (ai !== bi) return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
    return a.name < b.name ? -1 : 1;
  });
}

/** The bundled MIDI tracks, for the music demaker. */
export const DEMO_TRACKS: readonly DemoAudio[] = catalogue(TRACK_URLS);

/** The bundled recorded effects, for the sound demaker. */
export const DEMO_EFFECTS: readonly DemoAudio[] = catalogue(EFFECT_URLS);

/** Fetch one bundled file's bytes. */
export async function fetchDemoAudio(entry: DemoAudio): Promise<Uint8Array> {
  const response = await fetch(entry.url);
  return new Uint8Array(await response.arrayBuffer());
}
