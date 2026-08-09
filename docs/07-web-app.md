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

| Section | Opens for | What it does | State |
|---|---|---|---|
| **demotic game demaker** | `.dmt` | write a game as text or as blocks, play it on any console | live |
| **demotic suite editor** | `.test.dmt` | the assertions about a game, run on every console at once | live (doc 19) |
| **art demaker** | `.svg` `.png` `.jpg` … | the image pipeline described below | live |
| **music demaker** | `.mid` | tracks → chip music (docs 16, 17) | live |
| **sound demaker** | `.wav` | effects → chip sound (docs 16, 18) | live |
| **level editor** | `.dmtl` | draw a room, see it at every console's viewport | live (doc 19) |
| **text editor** | `Demakefile`, `.md`, `.trace`, … | the project's other files, as text | live |
| **demotic reference** | — | the language, generated from the registry | live |
| **block editor** | `.dmt` `.test.dmt` | a program as draggable blocks instead of typed lines — a *view* inside the two editors above, not a section of its own | live (doc 19) |

**A section is not something you choose; it is what the open file is.** Clicking
`ball.svg` opens the art demaker because a `.svg` *is* art. The route is
`#file=<path>` and the section comes off the extension, so the two can never
disagree — which is why the row of section tabs the site used to carry is gone
(§The workbench). `#section=<id>` still reads, because every option permalink
shared before the site held projects has one in it, and an unrecognised hash
still falls back to the art demaker.

**A bare URL opens the project's game.** Somebody arriving has come to see a
game, and doc 19's entry-point rule (`src/`, then the root) is what says which
one. The art demaker was the landing page only because it was the first section
written.

## The workbench

The site is a **window**, not a page: a title bar, a menu bar, an explorer, one
editor, and a status bar, filling the viewport with nothing spare. The unit it
operates on is a *folder* — a `.dmt` and its test suite, its art, its music, its
effects, its levels and a Demakefile — because that is the object the CLI already
builds ([doc 19](19-projects.md)).

- **The title bar names the window**, `demake — <what this tool does with the
  thing you have open>`, and the tagline is per editor: a `.dmt` is the whole
  product thesis in one line and a `.wav` is one demaker. The browser tab says
  the same thing, from the same string.

  **A narrow window moves the name rather than dropping it.** The name sits in
  the middle of the strip, which is where a desktop puts a window's title and
  which is also where the menus are once the window is small — so below 900px
  the engine note goes and the name flows to the right of the menus, and on a
  phone the strip wraps and the name takes the row above them. What a phone
  loses is the title's *position*; the tagline gives up characters to an
  ellipsis before it gives up its row. It used to lose the tagline at 900px and
  the name itself at 640, which left the one thing on the screen that says what
  the site is showing nothing at all on the machine most likely to be told about
  it in a link.
- **The menus carry the commands**, with their accelerators: File (new, open a
  folder, import a zip, save, download a zip), Edit (undo, redo, rename, delete),
  View (the explorer, the reference), Go (go to file, the game, the Demakefile),
  Help. **A menu entry and its keybinding are one declaration** — the same array
  is what is drawn and what is bound — so a menu cannot advertise a shortcut
  nothing listens for. Same rule as the CLI's one flag spec (doc 05) and the
  highlighter's one word list.

  Which is why two commands carry no accelerator and two are marked `native`.
  ⌘N is the browser's new window and cannot be prevented; ⌘⌫ deletes the previous
  word in a text box and must not be taken over by a delete with no undo behind
  it. Undo and redo keep the *browser's* key, because a `<textarea>`'s own ⌘Z
  drives the native undo stack the user has been filling by typing — a journal of
  ours beside it would be a second history that disagrees with the key pressed
  with the caret in the box.
- **The explorer manages files.** Add, rename, move and delete, with a move and a
  rename being one gesture because a project is a flat map from path to bytes and
  a folder is a convention in the names. Doc 19 originally deferred this; §A file
  manager, after all records why the answer changed.
- **And it has a switch on the screen**, at the left of the title bar where every
  editor with a sidebar puts one. It was a menu entry and a key and nothing else,
  which is a control you have to already know about — and below 1000px, where the
  tree stacks above the editor and now *opens contracted*, it is the only way
  back to the project's files. A third of a phone screen is a third the editor
  does not get, so the width decides how it opens; a resize afterwards does not
  overrule the button somebody just pressed. The menu entry stays, because that
  is where the accelerator is written down, and the key itself is one string both
  of them read.
- **The status bar holds the project**, the way an editor's holds the branch: the
  picker for which example is open, whether it has unsaved changes, and whatever
  the last operation had to say.

Two things follow that this document did not previously have room for. **A
demaker's controls become the Demakefile** — doc 15 §The equivalence contract
stops being a promise, because there is no second place the settings live. That is
live for the art demaker: changing a control writes the block for the asset you
have open, setting it back removes the line again, and the pane says which file
and which block it is editing rather than doing it silently. And **`build/` stays
the CLI's**: the previewer compiles in the tab, as it already does, and writing
those bytes to a directory would add nothing but a way for two copies to disagree
about which is stale.

Still to come: a `.dmt`'s third view beside its text and its preview — a **block
editor**, generated from the language registry, offering the open project's own
sprites and tracks as pictures and sounds rather than as filenames. Nothing about
what a demaker *does* changes; what changes is what opens it, and where its
options are written down.

### The text editor

What opens for a file in the project that no demaker demakes: the Demakefile, a
`.md`, a golden `.trace`, a note somebody left. It is the smallest editor here on
purpose — a textarea over the project's own text — and it exists because doc 19
promises the build file is "also just a file in the explorer", which was not true
while nothing opened one.

**The Demakefile gets colours, and they are the engine's.** A `.dmt` has
`highlight()` and a Demakefile now has `highlightDemakefile()`, both in
`@demake/demotic` and both driven by the grammar's own word lists — the parser's
directive sets live in `demakefile/model.ts` and the highlighter imports them, so
a directive added to the format is coloured the day it is added and a file is
never coloured differently from how it is read. A page-side lexer for a format
the engine also parses is this document's forbidden second implementation, one
file type along from where that rule was first written.

**A file with no grammar is drawn plain rather than approximately.** Guessing at
Markdown or JSON with a regular expression in the page would be exactly the thing
the paragraph above refuses, for a smaller prize. And a file the extension says
is text but whose bytes hold a zero is shown read-only: `route.ts` decides by
extension, which is right for routing and cannot be right for everything.

### The Demotic section

Two panes. **Play** carries the console picker, the canvas, and a *console
pixels* toggle that switches between the art as authored (SVG, any resolution)
and the same state on the target's real 8×8 grid with over-limit scanlines shaded
red — the product thesis in one control. **Game** is the editable source with
per-line diagnostics, and a *Run tests* button that runs the `.test.dmt` suite
against every console at once and reports the tally.

**Game shows the source as text or as blocks** (doc 19 §The block editor), and
not both at once — two views of one file earn a split screen when they show
different things, and these show the same thing twice inside a pane that also
holds a console. Text is the default and the claim is why: a whole game is sixty
readable lines, and a visitor who arrives at a form cannot see that. Blocks are
the alternative — one line per row, a symbol per statement, a field per slot,
diagnostics against the rows they are about — and neither view is authoritative,
because the file is. A row moves by being dragged, by being picked up with `Space`
and carried on the arrows, or by having its destination chosen from a filtered
list; the language is flat, so a drag here expresses one number rather than a
nesting, and it is the weakest of the three.

**A `.test.dmt` opens the suite editor instead**, which is the same two views over
the suite plus the run, and no player at all. It is a `.dmt`, so it used to open
this section: a file that builds to nothing, handed a console picker, a cartridge
and a playable preview. What a suite needs on screen is the game it is about and
whether its claims hold on every console.

The simulator runs on the main thread, not in the engine worker: a tick is a few
hundred integer operations on a handful of entities, so the round trip would cost
more than the work. Art conversion goes to the worker, and so does building the
cartridge — that one *is* the art conversion, plus a compiler.

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
version behind. The build itself runs in the engine worker, so the badge is
simply what the pane shows while it waits — the UI thread keeps painting, and the
cartridge that is already loaded keeps playing at full speed throughout. It used
to run here, deferred from inside a `requestAnimationFrame` callback so the badge
would at least reach the screen before the tab stopped for several seconds; the
worker is the version of that which does not stop the tab at all.

### Playing the real ROM in the page

The preview runs the reference interpreter, which is the specification — but the
product claim is a *ROM*, so the page builds one and plays it. **Live for `gb`,
`gbc`, `nes`, `sms`, `gg` and `md`.**

**Assembling needs no assembler installed** (doc 06), because the assemblers are
ours: `packages/core/src/asm/` is TypeScript and holds one for the SM83, one for
the 6502, one for the Z80 and one for the 68000, so the page compiles the game to
whichever the chosen console runs, exactly as the CLI does. The art travels the same way — the
page hands the build
raw SVG text and `@demake/core`'s own rasteriser turns it into tiles, rather than
the browser's SVG renderer, which would antialias differently from Node's and put
a different byte in the cartridge. The bytes are identical to `demake build`'s —
the parity contract this document already asks of images, restated for games, and
pinned by a Playwright spec that builds `caves` on both sides, once per console
with a backend, and compares hashes — and the pane offers them as a download.

Once per console is the point: they share a compiler and share nothing below it.
Different instruction set, a different fitter for the art, a different cartridge
wrapper. A page that agreed with the CLI about the Game Boy would say nothing
about whether it agreed about the NES, the Master System or the Mega Drive.

**Playing it needs an emulator**, and they are ours: `@demake/dmg`,
`@demake/nes`, `@demake/sms`, `@demake/snes` and `@demake/md`, each around a
thousand lines of
dependency-free TypeScript. Self-hosting a WASM core would have satisfied the never-from-a-CDN
rule, but not the reason behind it — a core we cannot read is a dependency we
cannot trust with the claim "this is what the hardware does". Writing them was
also the cheaper option, because the Demotic conformance suite (doc 10) needed a
headless machine for each console anyway, and one core now serves both jobs.
Together they are in the entry-adjacent game chunk rather than the worker,
because playing a cartridge is what the *page* does with one.

All five make sound, and two of them make it the hard way. The Super Nintendo's
chip belongs to a second processor with its own program, so what plays in the page
is the SPC700 driver the cartridge uploaded at boot — generated for that game and
running on its own timer. The Mega Drive has *two* chips on different clocks, so
the pane builds a sink apiece and sums them. Both arrive through the same
`StreamSink` the other three use, and the page still synthesizes nothing.

**Everything on screen describes the cartridge, not the picker.** The selector
changes the *cartridge*, and a cartridge takes a demake to arrive — seconds, when
the art is being fitted in colour. The pane keeps playing the one it has for
those seconds (§the demaking badge), so for those seconds the two disagree, and
the machine name, the canvas size, the download's extension and the CPU the
frames-per-tick figure names all follow the ROM that is actually running. Get
that backwards and the Download button offers you `.nes` and hands you a Game
Boy. The canvas is sized by the machine it is showing rather than by the
stylesheet, because 160×144, 256×240 and 256×192 are not the same rectangle and a
ratio pinned in CSS could only ever be right for one of them. Which family plays
a cartridge is the worker's answer too — it comes back with the ROM, from
`codegen/registry.ts`, so the page never keeps a second list of which consoles
build.

**The pane reports frames per tick**, and that is deliberate. It is the measured
cost of one game tick on that console's CPU — currently right on one frame for
every example, on every machine — and it is reported rather than hidden behind a
speed multiplier, because running the emulator fast enough to paper over a slow
tick would be a lie to the person writing the game. The number names the CPU it
was measured on, since three frames a tick means different things on a 4 MHz
SM83, a 1.8 MHz 6502 and a 3.6 MHz Z80.

**And what a frame costs in _time_ is the console's, not a constant.** The rate
beside that count is the frame rate divided by it, and the pane took the frame
rate from the profile of the console the cartridge is for (`profiles.ts` §fps) —
which is also the rate the emulator is paced at. It was one number for every
machine while every machine ran at 60 Hz; the WonderSwan draws 75.47 times a
second, so that number played its cartridges a fifth slow and then reported the
rate it had slowed them to.

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

Every console with a backend has a driver now, so the button is never withheld
in practice — but *whether* it is offered is the cartridge's answer rather than
an assumption: a player hands the pane its chips, and an empty list takes the
control away rather than offering one that does nothing. The WonderSwan Color
spent a release in exactly that state, which is why the question is asked.

The ROM pane plays the cartridge's own sound, and every sample of it comes out of
`@demake/chip`'s model of that console's chip — the Game Boy's APU, the NES's
2A03, the SN76489 on either Sega machine, the PC Engine's six wavetables, the
WonderSwan's four, or
*both* of a Mega Drive's — six
four-operator FM voices and four tone generators, which is the one console here
that hands the player two chips on two clocks and has them summed. Two of them
are not on the processor the game runs on at all: a Super Nintendo's is a second
computer's and a Nintendo DS's answers the ARM7, so what the pane listens to
there is the *other* processor's output. In every
case the
same model the audio pipeline renders WAVs with and the same one the conformance
suite diffs register writes against. Which model is playing follows the cartridge
for the same reason the core does, and the stream is rebuilt against *that chip's*
clock: 4.19 MHz, 1.79 and 3.58, and a sink handed the wrong one would play the
game at the wrong speed rather than sounding wrong. The page
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

### The level editor *(built)*

Opening a `.dmtl` gives you **text, map, or both**, and neither view is the
authoritative one: the file is (doc 19 §The level editor). Two panes in the map
view — **Legend**, one row per tile, with its art chosen from the project's own
pictures and written back as the shortest name that identifies one; and **Grid**,
the level drawn with that art, painted with pencil, rectangle, flood, erase and
pick, resized from the top-left corner, with a console viewport rectangle over it
(the project's declared targets, or one machine where a project declares none).

**It is a view over the format, never a second one**, and that is structural
rather than careful: `src/lib/dmtl.ts` splits a file into its legend, its `map`
line and its rows and rewrites *only the lines an edit changes*, so nothing here
can reflow a row, drop the blank line that is a row of empty cells, or rewrite a
file it did not change. Those are `.dmtl`'s three literalness rules and they are
what an editor built on a parsed model would break first.

**A cell is drawn by the same function the Demotic section draws a scene's tiles
with** (`src/lib/tiles.ts`). The "no second implementation" rule applies to a
tile on screen exactly as it applies to one demade into a cartridge — a level
that looked one way while you drew it and another way in the preview would make
both untrustworthy.

Diagnostics are the compiler's, shown under the grid, and a character with no
legend row is drawn as itself on a hatched cell: visible, editable, and not
quietly deleted. Removing a legend row says how many cells use it and leaves
those cells alone, because the compiler reporting them is a better answer than an
editor silently erasing part of a level. Code-split, like the other sections.

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

- Works fully offline after first load (PWA manifest + service worker).
  **What may be cached for ever is decided by the URL.** Vite writes every
  content-hashed artifact under `assets/`, so a request inside it can never mean
  two different files and is cache-first; everything else same-origin —
  `index.html`, the manifest, the icon — has a stable URL and changing contents,
  so it is network-first with the cache as the offline fallback. That one rule is
  the whole policy, and `packages/web/test/sw.test.ts` is what enforces it.

  **The shell is the case that bites**, and it bit twice. `index.html` is the one
  URL that does not change and it is what names the hashed chunks: served from
  the cache, it asks for the chunks it already has, and a deploy reaches new
  visitors only. A console added to the app did not appear in anyone's browser
  after the deploy that contained it. The second time was subtler and had the
  same symptom — the shell was fetched from the network and the *browser's* HTTP
  cache answered, because Pages sends `max-age=600` on it. Network-first over a
  cached response is not first at all, so the request states `cache: "no-store"`.

  Three things outside the worker finish the job, each of which is a way a
  visitor gets stuck on an old build: the registration asks for
  `updateViaCache: "none"` so `sw.js` itself is never served from the HTTP cache
  (a worker that cannot be re-read is a worker that cannot be replaced); the page
  checks for an update on load and on becoming visible again, because a browser
  checks on navigation and this app is one page somebody leaves open for a week;
  and when a *new* worker takes control of a page an *old* one was running, the
  page reloads once, so the rescue costs no clicks. Bumping the cache name is
  still what drops a poisoned cache on activate.

  **That reload is the one thing that could throw away a project**, now that the
  page holds an editable folder rather than one dropped image — so the workbench
  registers a `beforeunload` guard whenever the project is dirty. A programmatic
  reload goes through it like any other navigation, which is why one guard covers
  both the deploy and the closed tab.
- Accessible: keyboard operable, labeled controls, honors reduced-motion.
  Contrast is always set with an explicit colour, **never with opacity** — a
  translucent foreground composites against whatever is behind it, which is both
  a measured contrast failure and genuinely harder to read.
- Budget: < 400 KB JS gzipped, Lighthouse ≥ 95 across the board, checked in CI.
  The figure is **what one visitor downloads** — everything always-loaded, plus
  the one console family they play — and it was a sum over the whole site until
  the site legitimately had to hold eight consoles' emitters and eight emulator
  cores. Every image codec is counted in it, because every image codec is ours
  and therefore in the bundle: PNG, SVG, JPEG, GIF and BMP (doc 02 §Image
  codecs). There is nothing lazy-loaded per input format and there is no WASM.
  It is still not satisfiable by moving code between always-loaded chunks, only
  by there being less of it, and moving something into a per-family chunk only
  helps if it genuinely belongs to one family. The next thing that does not fit
  should be made smaller rather than given more room.

  **The list of families is the registry's, not a copy.** `runtimeFamilies` in
  `demotic`'s `codegen/registry.ts`, plus `familyFor` for a chunk named after a
  console rather than its family. A hand-written copy sat in the checker until
  the ARM handhelds landed and nobody added them to it, so a Game Boy Advance
  emulator and emitter — 26.8 KB gzipped, behind an `import()` like every other
  core — were charged to every visitor for as long as the two lists disagreed.
  A budget that overstates itself fails the next honest change, which is what it
  did.

  **And a name alone cannot say who loads a chunk, which is the second time that
  bit.** A backend two consoles share is bundled into a chunk named after
  neither, so `codegen/m68k/` — the Mega Drive's alone until the Neo Geo shared
  it, which is the whole point of that directory — moved out of a chunk called
  `md-*` and started being charged to every visitor, along with `codegen/mos/`
  between the NES and the PC Engine and `rom/z80-player.ts` between the Sega
  8-bits and the Neo Geo: twenty kilobytes nobody playing a Game Boy fetches. The
  checker therefore walks the built import graph from the entry the HTML names,
  never through a per-family chunk, and charges what that walk cannot reach to
  each family that can. A chunk every family reaches costs exactly what it did
  before, so this can only ever change the answer for code a proper subset of
  consoles needs — and a split that stops working still puts its chunk back on a
  path from the entry, which is the loud failure the name rule was for.

  **The third console is what made that rule bite, and what it bought was one
  copy of the engine.** A Sega vertical is 21 KB gzipped and none of it is fat —
  a Z80 assembler, a Z80 core, a VDP, a code generator — so the room had to come
  from somewhere else, and it did: the game section was building its cartridge on
  the UI thread, which meant `@demake/core` was bundled twice, once in the image
  worker and once in the game chunk. Building through the worker instead deletes
  a whole second copy of the image engine and the audio demakers, which is
  genuinely less JavaScript rather than the same JavaScript somewhere else. It
  also stops the tab freezing while a colour backdrop is fitted, and it restores
  the rule the rest of the app already followed: the workers are the only place
  the page touches an engine.

  **It moved once, from 300, and the arithmetic is worth keeping.** By the time
  the Sega vertical and its Z80 audio driver had landed the site sat 36 bytes
  under 300 KB — a coincidence rather than headroom. Running the tournaments in
  parallel (doc 04 §Running the tournament) then cost 3.3 KB, nearly all of it the
  engine's executor seam and the content-keyed prologue cache that stops a fan-out
  decoding its source once per candidate. Both live in `@demake/core`, so the CLI
  half of that work pays for them too. The page's own share is nil, and that was
  the design rather than luck: a lane is *another instance of `core.worker.ts`*,
  which already holds both engines because it compiles cartridges, so the browser
  has the chunk cached and starting six of them downloads nothing. The alternative
  was built and measured first — a purpose-built lane worker gets its own module
  graph and re-ships a whole engine, 41 KB.
- Browser matrix: last 2 versions of Chrome/Firefox/Safari/Edge, tested via
  Playwright in CI (functional + determinism suites).
