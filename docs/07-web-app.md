# 07 — Web App (github.io)

The same engine, in the browser, hosted as a static site on GitHub Pages. No server,
no upload, no accounts, no telemetry. If GitHub Pages is up, the app works.

## Principles

- **Parity is a contract**: the web app calls the identical `@demake/core` build
  the CLI uses; CI verifies byte-identical PNG output between Node and browser for
  the fixture corpus (doc 10 §Determinism).
- **Everything client-side**: image decode (WASM codecs), pipeline, PNG/asm/c
  generation, and (where implemented, doc 06) in-browser ROM assembly all run in a
  Web Worker. The page never phones home.
- **The UI mirrors the CLI's mental model** — same option names, and it *shows you
  the equivalent CLI command* for the current settings (great for humans graduating
  to scripts, great for agents reading screenshots, great for bug reports).

## Stack

- Vite + TypeScript + Preact (small, fast, no framework lock-in for a one-page
  tool). State in a single store; no router beyond hash-permalinks.
- `@demake/core` in a Worker via Comlink-style RPC; transfers use
  `ArrayBuffer`s (zero-copy).
- Styling: hand-rolled CSS with light/dark via `prefers-color-scheme`. Pixel
  preview uses `image-rendering: pixelated` canvases.
- Static deploy: `packages/web` → `dist/` → GitHub Pages via Actions (doc 11).
  Base path configured for `https://georgestephenson.github.io/demake/`
  (plus custom domain support if ever wanted).

## Sections

The site is one shell over four demakers, because demake demakes game assets and
images are only one kind (doc 01 §Scope):

| Section | What it does | State |
|---|---|---|
| **demotic game demaker** | write a `.dmt`, play it on any console, run its `.test.dmt` suite | live |
| **art demaker** | the image pipeline described below | live |
| **music demaker** | tracks → chip music (docs 16, 17) | live |
| **sound demaker** | effects → chip sound (docs 16, 18) | live |

The route lives in the hash as `#section=<id>`, and the **art demaker is the
unmarked default** — so every option permalink shared before the site grew
sections still opens exactly what it used to.

### The Demotic section

Two panes. **Play** carries the console picker, the canvas, and a *console
pixels* toggle that switches between the art as authored (SVG, any resolution)
and the same state on the target's real 8×8 grid with over-limit scanlines shaded
red — the product thesis in one control. **Game** is the editable source with
per-line diagnostics, and a *Run tests* button that runs the `.test.dmt` suite
against every console at once and reports the tally.

The simulator runs on the main thread, not in the engine worker: a tick is a few
hundred integer operations on a handful of entities, so the round trip would cost
more than the work. Art conversion still goes to the worker.

**The section is code-split.** It carries the whole game language — compiler,
interpreter, test runner — and someone who came to convert an image should not
download any of it, so it loads on first navigation and the art demaker's initial
payload is what it was before the site grew sections.

**On-screen controls** appear where the primary pointer is coarse. They bind the
*abstract* button set (`left right up down a b start`), never a particular
console's controller — identical for every console and every game, because that
set is the only thing a `.dmt` file can bind to. Pointer events rather than touch
events, so a stylus and a mouse work too, and every button releases on
`pointerleave` and `pointercancel` as well as `pointerup`: sliding a thumb off
the d-pad must not leave a paddle running forever.

A syntax error never blanks the preview — the parser recovers per line, and the
page keeps running the last version that compiled.

**The source is syntax-coloured, and the grammar is the engine's.**
`@demake/demotic` exports `highlight()`, which scopes source with **TextMate
scope names** (`keyword.control`, `string.quoted`, `constant.numeric`) — the
convention every editor and every theme already speaks, so a theme matches on
scope prefixes and a future `.tmLanguage` file is a translation of one table
rather than a second grammar. Every word it knows comes from the language
registry and every token boundary comes from the lexer, so a keyword added to the
registry is coloured the day it is added, and the one thing a regular-expression
highlighter always gets wrong here — `y--1` is a comment, `y - -1` is not — has
exactly one answer. **Grammar in the engine, theme in the stylesheet**: the page
picks the colours (the conventional ones — comments green, keywords blue, control
flow magenta, strings red-brown, numbers pale green) and the engine never names
one. A highlighter written in the page would be a second description of the
language, which is the same mistake §The web app must never grow conversion logic
exists to prevent.

It is still an ordinary `<textarea>`, with a `<pre>` of colours stacked exactly
underneath it — the conventional technique, and the one that keeps native
editing, selection, mobile keyboards and the accessibility tree. Two things hold
the layers together: they share one CSS grid cell so the wrapper is what scrolls
(a scrollbar inside the textarea alone would narrow its lines and move every wrap
point out from under the colours), and no scope may set a `font-weight` or
`font-style`, because a bold run is a wider run in most monospace families.

**Nothing downstream of the editor runs per keystroke.** The section holds two
copies of the text: a *draft*, which the editor shows and which changes on every
key, and the *source*, which is what the engine has been given and only catches
up once typing pauses. The compile, the diagnostics, the interpreter and the
cartridge all hang off the source, so a keystroke costs a lex for the colours and
nothing else — and the interpreter is no longer restarted from scratch on every
character. Only *typing* waits: picking a game or a console sets both copies at
once, because a dropdown is one deliberate action and a pause after it would read
as a fault. *Run tests* settles the draft on the way, so it can never report on
the version from 300 ms ago.

**And the pane says when it is demaking**, which is any time a cartridge is being
built — after a typing pause, and after a game or console change alike. The ROM
pane keeps playing the cartridge it has and shows a *demaking…* badge over the
screen: a screen that blanked as you typed would be worse than one that is a
version behind. The badge has to reach the screen *before* the work starts,
because the build is synchronous and nothing repaints while it runs — so the
build is scheduled from inside a `requestAnimationFrame` callback rather than a
bare `setTimeout`, which is the difference between a badge and a tab that freezes
for several seconds having shown nothing.

### Playing the real ROM in the page

The preview runs the reference interpreter, which is the specification — but the
product claim is a *ROM*, so the page builds one and plays it. **Live for `gb`,
`gbc` and `nes`.**

**Assembling needs no assembler installed** (doc 06), because the assemblers are
ours: `packages/core/src/asm/` is TypeScript and holds one for the SM83 and one
for the 6502, so the page compiles the game to whichever the chosen console runs,
exactly as the CLI does. The art travels the same way — the page hands the build
raw SVG text and `@demake/core`'s own rasteriser turns it into tiles, rather than
the browser's SVG renderer, which would antialias differently from Node's and put
a different byte in the cartridge. The bytes are identical to `demake build`'s —
the parity contract this document already asks of images, restated for games, and
pinned by a Playwright spec that builds `caves` on both sides, once per console
with a backend, and compares hashes — and the pane offers them as a download.

Once per console is the point: the two share a compiler and share nothing below
it. Different instruction set, a different fitter for the art, a different
cartridge wrapper. A page that agreed with the CLI about the Game Boy would say
nothing about whether it agreed about the NES.

**Playing it needs an emulator**, and they are ours: `@demake/dmg` and
`@demake/nes`, each around a thousand lines of dependency-free TypeScript.
Self-hosting a WASM core would have satisfied the never-from-a-CDN rule, but not
the reason behind it — a core we cannot read is a dependency we cannot trust with
the claim "this is what the hardware does". Writing them was also the cheaper
option, because the Demotic conformance suite (doc 10) needed a headless machine
for each console anyway, and one core now serves both jobs. Together they cost
about 13 KB gzipped inside the already code-split game chunk.

**Everything on screen describes the cartridge, not the picker.** The selector
changes the *cartridge*, and a cartridge takes a demake to arrive — seconds, when
the art is being fitted in colour. The pane keeps playing the one it has for
those seconds (§the demaking badge), so for those seconds the two disagree, and
the machine name, the canvas size, the download's extension and the CPU the
frames-per-tick figure names all follow the ROM that is actually running. Get
that backwards and the Download button offers you `.nes` and hands you a Game
Boy. The canvas is sized by the machine it is showing rather than by the
stylesheet, because 160×144 and 256×240 are not the same rectangle and a ratio
pinned in CSS could only ever be right for one of them.

**The pane reports frames per tick**, and that is deliberate. It is the measured
cost of one game tick on that console's CPU — currently right on one frame for
every example, on both machines — and it is reported rather than hidden behind a
speed multiplier, because running the emulator fast enough to paper over a slow
tick would be a lie to the person writing the game. The number names the CPU it
was measured on, since three frames a tick means different things on a 4 MHz SM83
and a 1.8 MHz 6502.

A game the chosen console's backend cannot compile gets a message naming the
feature instead of a cartridge that would play something else — the same refusal
`demake build` makes, for the same reason (doc 14 §A backend gap is a build
error).

**The cartridge is what the pane opens on**, and the preview is a view you can
choose: a `View` dropdown offers *Cartridge* (the default), *Preview*, or *Side
by side*. The ordering is the argument. The ROM is the artifact — it is what
`demake build` writes, what a player would load, and the thing the whole tool
exists to produce; the interpreter is what *proves* it right, and a proof is
something you ask to see. Side by side is the mode that earns its place: two
machines, one input path, and any disagreement between them visible at a glance
rather than inferred from a trace.

Only the view on screen runs. A hidden preview is work nobody sees — the
cartridge is machine code and never consults the interpreter — so the simulator's
loop stops with it, and the input latch is cleared so a tap taken while it was
hidden cannot fire a minute later when it comes back.

### Sound in the cartridge pane *(built)*

**Sound belongs to the cartridge, not to the preview**, and that is a fact about
the two machines rather than a decision about the page. The interpreter is the
language's specification: it says *when* a sound is asked for — that is the
`audio=<track>,<effect>` field in a trace (doc 14 §Sound) — and it has no notion
of a chip, a channel or a register, because those are the console's and the whole
point of the language is that a `.dmt` names none of them. The cartridge has an
APU. So the sound button lives in the cartridge view, the preview is silent, and
in *Preview* there is no sound control at all — which is the honest way to say
that a simulator has nothing to play.

On a console whose driver is not written yet — the NES, until doc 13 §A5 — the
button is *disabled* rather than silent, and the pane says why. A switch that
turns on nothing is worse than one that is plainly unavailable.

The ROM pane plays the cartridge's own sound, and every sample of it comes out of
`@demake/chip`'s Game Boy APU — the same model the audio pipeline renders WAVs
with, the same one the conformance suite diffs register writes against. The page
computes nothing: `StreamSink` box-integrates and DC-blocks the chip's output
exactly as the offline renderer does (`packages/chip/test/stream.test.ts` pins
the two as bit-identical, in any chunk size), and what reaches Web Audio is a
buffer.

Three things about it are decisions rather than details:

- **Nothing but an `AudioBufferSourceNode` is ever constructed**, and a
  Playwright spec asserts it by recording the constructors before the app loads.
  Not even a `GainNode`: muting is the context suspended and the stream detached,
  because a graph with one node in it cannot grow a second implementation of the
  hardware by accident.
- **The audio device is the clock while sound is on.** The emulator runs until
  the chip has produced the samples the player still needs, rather than on the
  frame clock — a browser tab whose display and audio clocks differ by a few ppm
  drifts into a click every few minutes otherwise. With sound off the frame
  clock takes over again, unchanged.
- **It is a button, off by default.** A browser will not start an `AudioContext`
  without a user gesture, so a page that tried to start sound on its own would be
  quiet and would have no way to say why; the click is the gesture.

### The audio sections *(built)*

Drop a track (or a sound) in, pick a console, press play, and hear exactly what
the cartridge will play. That last word is the whole design constraint, and it
rules out the obvious implementation:

**Web Audio is a playback device here, never a synthesizer.** No
`OscillatorNode`, no `BiquadFilterNode`, no `AudioWorklet` DSP — the page renders
the result with `@demake/chip` (the same models Node uses, the same models the
conformance suite validates) into a plain PCM buffer and hands that buffer to an
`AudioBufferSourceNode`. A browser-synthesized approximation would be a second
implementation of the hardware, which is the failure this document already
forbids for conversion logic and doc 14 forbids for art. The determinism suite
enforces it the same way it enforces byte-identical PNGs: the audio exported in
the page must be byte-identical to the audio exported in Node.

Two traps that follow, both worth stating because both are invisible until
someone compares waveforms:

- The `AudioContext` is constructed with an explicit `{ sampleRate: 48000 }` and
  the render matches it. A buffer whose rate differs from the context's is
  resampled *by the browser*, differently per engine. Where the constructor
  refuses the rate, the page **renders the schedule again** at the rate the
  context chose — nothing is resampled at all — and says which rate it played at.
- Nothing else goes in the graph — no gain automation, no compressor, no
  `preservesPitch`. Volume is applied inside the render or not at all.

The panes: **Source** (the file, its analysis, and — for music — the parts with
the roles the classifier gave them, each editable, which is `--role`, and a tick
per part, which is `--drop`), **Console & options** (every remaining flag, with
the equivalent command line underneath), **Arrangement** (the channel plan as a
piano roll, one lane per hardware channel over a bar grid drawn from the
*achieved* tempo, plus the timing report, the budgets, what was dropped, and the
tournament scoreboard doubling as a strategy picker exactly as the art demaker's
does), and **Listen** (play it, and the downloads: the `.vgm`, the
`--emit-manifest` sidecar, the sample-exact WAV that carries the doc-16
guarantee, and the cartridge that plays it).

Four things the built sections settled that the sketch above did not:

- **There is no key detection**, so the Source pane does not claim one. It
  reports what analysis actually produces — tempo, meter, sections, parts, roles
  and confidences — because a number with nothing behind it is worse than a
  missing one (the same rule doc 17 §The judge applies to timbral metrics).
- **The music section's Listen pane has one side, not an A/B.** A MIDI file is a
  score, not a recording: playing it would mean synthesizing it. The *sound*
  section does have the A/B, and both its sides come out of `@demake/audio` —
  its own WAV decoder for the recording, its own chip models for the result —
  trimmed the way the demaker trims, so the comparison is between two things the
  engine produced.
- **The sound section draws both envelopes**, the recording's and the chip's,
  measured by the same function at the same frame rate, because that shape is
  what the fitting loop was chasing (doc 18 §Stage 3). It is the audio
  counterpart of the image demaker's side-by-side.
- **The cartridge is offered here too**, not only in the game section: the driver
  is generated for the schedule and assembled by our own SM83 assembler, so
  `gen --format rom` needs no toolchain in the browser either. Where a console
  has no driver backend the button says so and names `render` as the exact
  alternative, rather than being silently absent.

**Code-split**, like the Demotic section: the chip models, the decoders and the
analysis DSP are a large payload and someone who came to convert an image must
not download any of it. The engine runs in its own worker
(`src/worker/audio.worker.ts`), separate from the image one for the same reason —
and it holds each schedule it produces, so the sidecar, a cartridge and a
re-render at another rate are asked for by token rather than shipped across the
boundary on every keystroke.

## UX specification

The art demaker: single screen, three panes:

1. **Input pane** — drag-and-drop / file-picker / paste-from-clipboard; shows
   source with dimensions and detected profile (art vs photo).
2. **Controls pane** — console picker (grouped by tier/era, with a one-line
   constraint summary per console: "GBC · 160×144 · 8 palettes × 4 colors"); then
   the doc-05 options: size (auto/preset/custom), mode, dither, scale kernel,
   effort, background. Advanced options collapsed by default. Live "equivalent
   command" line: `demake prep img.png -c gbc --dither bayer4 …` with a copy
   button.
3. **Preview pane** — side-by-side or A/B-slider source vs result, at integer zoom
   with optional CRT-ish PAR-corrected view (uses the spec's `pixelAspect` and DAC
   model); a palette strip showing fitted sub-palettes; fit-error and tile-budget
   stats from the manifest; and the tournament scoreboard — which strategy won,
   per-candidate scores, with click-to-preview of any candidate's output (this
   doubles as a strategy picker: choosing one sets `--strategy <name>` in the
   equivalent-command line).

Conversion re-runs debounced on option changes (fast path: cached analysis +
geometry; the fitter reruns). `--effort max` is behind an explicit "High effort"
toggle with a progress bar (worker reports stage progress).

**Export buttons**: PNG · manifest JSON · asm · C · bin · ROM (family-dependent,
disabled with a tooltip linking to the CLI when browser assembly isn't available
for that console).

**Permalinks**: options (not the image) serialize into the URL hash so settings are
shareable; "Load demo image" ships a bundled test image so the page demos itself.
The hash is the art demaker's alone — the audio sections keep only `#section=`,
because their option names overlap the art demaker's and a shared hash would
carry a gesture id into `--strategy` on the way back. Each of them loads a
bundled track or effect on arrival instead, so every section demos itself.

## Quality bar

- Works fully offline after first load (PWA manifest + service worker). Hashed
  assets are cache-first, because a content-hashed name can only ever mean one
  file. **The shell is network-first**, because `index.html` is the one URL that
  does not change and it is what names the hashed chunks: served from the cache,
  it asks for the chunks it already has, and a deploy reaches new visitors only.
  That shipped once — a console added to the app did not appear in anyone's
  browser after the deploy that contained it — and
  `packages/web/test/sw.test.ts` is what now says which requests may be answered
  from the cache. Offline still works: the shell falls back to the cached copy.
- Accessible: keyboard operable, labeled controls, honors reduced-motion.
  Contrast is always set with an explicit colour, **never with opacity** — a
  translucent foreground composites against whatever is behind it, which is both
  a measured contrast failure and genuinely harder to read.
- Budget: < 300 KB JS gzipped before WASM codecs (lazy-loaded per input format);
  Lighthouse ≥ 95 across the board, checked in CI. The figure is a **sum over the
  whole site** — entry chunk, all five lazy sections, both workers — which is more
  than any one visit costs: opening the heaviest section downloads about 200 KB.
  A sum is the honest shape for this check, because it cannot be satisfied by
  moving code from one chunk to another, only by there being less of it. It is
  close: a second console — a second instruction set, a second emulator, a second
  set of hardware tables — came to 4.6 KB of it. The next thing that does not fit
  should be made smaller rather than given more room.
- Browser matrix: last 2 versions of Chrome/Firefox/Safari/Edge, tested via
  Playwright in CI (functional + determinism suites).
