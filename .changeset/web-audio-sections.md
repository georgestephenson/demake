---
"@demake/audio": minor
---

The web app's music and sound demakers, with the CLI's whole flag surface.

Both sections of doc 07 §The audio sections are built. Drop a MIDI (or a WAV)
in, pick a console, press play, and hear exactly what the cartridge will play —
over the same `arrangeScore`, `demakeSfx` and `render` the CLI calls, in a worker
of their own so nobody converting an image downloads a chip model.

What is reachable from the page is `demake arrange`, `demake sfx` and
`demake render` in full: console, strategy, `--bpm`, `--tempo`, a role picker and
a keep tick per part (`--role`, `--drop`), `--channels`, `--reserve` per channel,
`--effort`, `--strict`, `--title`, `--output-stage`, `--sample-rate` and
`--loops` — with the equivalent command line underneath, as the art demaker has.
The tournament scoreboard doubles as the strategy picker, the channel plan is a
piano roll over a bar grid drawn from the _achieved_ tempo, and the timing report
is on screen rather than in a log: requested and achieved BPM, ppm error, worst
onset deviation, and whether the error accumulates.

The downloads are the CLI's outputs, one for one — the `.vgm`, the
`--emit-manifest` sidecar, the sample-exact WAV, and the cartridge that plays the
schedule, assembled in the page by our own SM83 assembler with a driver generated
for it. `packages/web/test/e2e/determinism.spec.ts` pins all four as
byte-identical to Node's, which is doc 07's parity contract extended from images
and games to audio.

`@demake/audio` gained the sidecar itself: `arrangeManifest`, `sfxManifest` and
`encodeAudioManifest`. It was built inline in the CLI, and a shape with two
callers is a shape the second one can only reimplement — the same reason the
image path's `buildManifest`/`encodeManifest` live in `@demake/core`. The bytes
are unchanged, trailing newline included.

Three decisions worth knowing:

- **Web Audio stays a playback device.** Every sample comes out of
  `@demake/chip` through `render()`, and a Playwright spec records the Web Audio
  constructors before the app loads to assert nothing else was ever built. Where
  a browser refuses a 48 kHz context the schedule is _rendered again_ at the rate
  it gave, rather than handed over for the browser to resample on its own terms.
- **The music section has no A/B**, because a MIDI file is a score and playing it
  would mean synthesizing it. The sound section does, and both its sides come out
  of `@demake/audio` — its WAV decoder for the recording, its chip models for the
  result — trimmed the way the demaker trims, next to the two envelope traces the
  fitting loop was actually scoring.
- **No key detection appears anywhere**, because there is none: the Source pane
  reports tempo, meter, sections, parts, roles and confidences, which is what
  analysis really produces.
