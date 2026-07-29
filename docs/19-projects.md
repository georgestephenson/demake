# 19 — Projects

A **project** is a folder. It holds a game's sources — the `.dmt` files, the art,
the music, the effects, the levels — and, optionally, a Demakefile saying how
they reach hardware. The CLI builds it, the web app edits it, and it is the same
folder either way.

This document is what turns the site from four tools that each hold one file into
one tool that holds a project. It is the counterpart to [doc 07](07-web-app.md),
which describes the sections, and to [doc 15](15-demakefile.md), which describes
the build file at the project's root.

> **The folder is the format.** There is no project file, no database, no
> manifest listing what a project contains. What a project contains is what is in
> the directory, and that is the only reason "save it to your machine and build
> it with the CLI" needs no export step.

## The layout

```
pong/
  Demakefile          # optional (doc 15) — how it reaches hardware
  src/                # pong.dmt, pong.test.dmt
  art/                # ball.svg, paddle.svg, pong.title.svg
  music/              # rally.mid
  sound/              # bounce.wav, point.wav
  levels/             # *.dmtl
  build/              # generated; never authored, never read
```

Five authored folders and one generated one. `build/` is the Demakefile's `out`
default (doc 15) and is listed here only so that nobody puts a source in it.

**A folder with a `.dmt` anywhere in it is a project.** The five folders are the
canonical arrangement, not a requirement: a directory holding `pong.dmt`,
`ball.svg` and `rally.mid` flat is a project too, and it is the shape
`demake build pong.dmt` already builds today. `demake init` writes the canonical
arrangement; nothing refuses the flat one. That is the same bargain doc 15 makes
about the Demakefile itself — the structured form is an escape from the defaults,
never a prerequisite.

**Empty folders are absent, not empty.** A game with no music has no `music/`.
`demake init` creates only the folders a project has something to put in, and the
site's explorer lists only those — a tree of four empty directories is a tree that
teaches nothing about the project.

## The rule that makes it work: a name's kind decides its folder

This is the load-bearing decision, and it is why the whole layout costs the
language nothing.

Every file reference in Demotic already says what kind of file it is, because the
statement that names it does:

| Written in the source | Kind | Resolved in |
|---|---|---|
| `sprite hero.svg` | art | `art/` |
| `backdrop caves.title.svg` | art | `art/` |
| `tile # wall solid brick.svg` (a `.dmtl` legend) | art | `art/` |
| `music hollow.mid` | music | `music/` |
| `sound jump.wav on …` | sound | `sound/` |
| `level cavern from cavern.dmtl` | levels | `levels/` |
| `stream` chunk names | levels | `levels/` |

So a `.dmt` keeps naming a bare file and never writes a path — which is not a
convenience, it is doc 14's central split holding. A path is a fact about the
build; the `.dmt` must not know one. `sprite art/hero.svg` would put the folder
layout inside the game, and moving a file would then change the program.

**Resolution**, for a name of kind `K`:

1. `K`'s folder, walked depth-first in filename order (so `art/enemies/alien.svg`
   resolves as `alien.svg`).
2. The project root.
3. Beside the `.dmt` that named it, which is what the flat layout and today's
   fixtures rely on.

Every `assets` root in the Demakefile is searched before all three, in the order
written (doc 15).

**Two files of the same basename are an error, never a pick.** `art/hero.svg` and
`art/bosses/hero.svg` produce `E_ASSET_AMBIGUOUS`, naming both paths. The
language already refuses to resolve an ambiguity quietly (doc 14 §The readings the
language will not guess between) and a resolver that silently preferred one
directory would be the same failure one layer down: the program would simply not
be the one in the folder. A miss stays `E_ASSET_MISSING`, listing every path
searched.

**Kinds are disjoint, so nothing collides across them.** `art/` holds what an
image decoder accepts, `music/` MIDI, `sound/` WAV, `levels/` `.dmtl`. A file in
the wrong folder is found by rule 2 or 3 and built; it is not an error, because a
rule that refused would be enforcing tidiness rather than correctness.

## The Demakefile, still optional

Doc 15 stands: delete the Demakefile and the game plays identically; only the
artifacts change. A project folder changes three of its defaults and adds two
blocks.

**Defaults the folder now supplies:**

- `source` — the single `.dmt` in `src/`, then the single `.dmt` at the root.
  Several with no `source` directive stays `E_NO_SOURCE`, which is also the
  diagnostic that would name a multi-file mechanism if one existed (§Splitting a
  game).
- `assets` — the four resource folders, per the table above, then the project
  root. An `assets` directive *adds* roots ahead of them rather than replacing
  them, so a Demakefile that names an extra directory does not lose the standard
  ones.
- `out` — `build/`.

**A shorthand for the common case.** Doc 15's `target` blocks are right when
targets differ, and ceremony when they do not: seven blocks saying nothing but
their own names is the whole of most projects. So a bare

```
targets  gb gbc nes sms gg snes md
```

declares one default target per console named. It is exactly equivalent to that
many empty `target` blocks, `demake fmt` leaves it alone, and a `target` block for
one of those names refines it rather than conflicting with it. With neither
directive the build targets every console with a runtime, which is what doc 15
already says the zero-config path does.

**Audio settings**, which doc 15 lists as Not-in-v1 and which a project needs,
because "which style you want to generate the audio with" is exactly the question
a build file exists to answer. Same shape as `art <name>`, one block per domain:

```
defaults
  art
    strategy  auto
    dither    none
    effort    default
  music
    strategy  auto
    effort    default
  sound
    effort    default

music rally.mid
  role  1 lead
  drop  4
  for gb
    effort  max

sound bounce.wav
  gesture  knock
```

The options are the doc-05 audio flags under their own names, exactly as `art`
blocks carry the `prep` flags under theirs. The rule doc 15 states for art holds
unchanged for audio: a block may say **how** a track is demade and never **what
it plays**. No block names a note, a channel, a register or a chip, for the same
reason no `art` block names a pixel.

Options written directly under `defaults` remain art's, because that is what doc
15 documents and art was the only domain when it was written. `demake fmt` writes
the nested form.

**The resolution cascade** gains the same shape it already had, per domain:

```
defaults/<domain>  <  target  <  <domain> <name>  <  <domain> <name>/for <target>
```

## The shell: an explorer, and an editor per file type

The site stops being four tools you navigate between and becomes one workspace
you open files in — the arrangement every code editor has settled on, for the
reason every code editor settled on it: the project is the constant and the file
you are looking at is the variable.

**An explorer down the left**: the project's name, and each non-empty folder with
its files. Clicking a file opens it. That is the whole of the navigation model,
and it replaces `#section=` as the thing that decides what is on screen.

**Opening a file opens the editor for its type**, and every editor is the same
shape — *one file, two or three views of it*:

| File | Editor | Views |
|---|---|---|
| `.dmt` | the game editor | **text**, **blocks** (§The block editor), **preview**, and the cartridge |
| `.dmtl` | the level editor | **text**, **map**, or side by side |
| `.svg` `.png` | the art demaker | source, options, result — as today |
| `.mid` | the music demaker | source, options, arrangement, listen — as today |
| `.wav` | the sound demaker | the same, for effects |
| `Demakefile` | the build view | the file as text, its resolved plan, and every target |

So the four demakers do not go away and do not change what they do; they become
what opens when you click a file of the kind they demake. The `#section=` route
becomes `#file=<path>`, and the section is derived from the extension — one less
thing that can disagree with itself. The art demaker's option permalink is
unaffected: it still carries only options (doc 07 §UX), now beside a `file` key.

**Tabs, and the project is the dirty unit.** Several files open at once, one
active. Editing any of them marks *the project* dirty — one Save, one export —
because a project half-written to disk is worse than either state.

**The console picker is the project's targets.** The game editor currently offers
any console with a backend; with a Demakefile it offers the targets the project
declares, and the build view builds all of them. With no Demakefile it is what it
is today, which is what the zero-config path means.

## Options edit the Demakefile

An asset editor's controls are the Demakefile's contents, so changing one writes
the file. This is doc 15 §The equivalence contract stopping being a promise: the
preview's settings are *a view of a Demakefile*, and the way to make that true
rather than aspirational is for there to be no second place the settings live.

**The block you write into is the file you have open.** Changing `dither` while
looking at `ball.svg` writes an `art ball.svg` block. Never `defaults`, because a
change made while looking at one asset must not silently retune every other one —
that is the same refusal the language makes about ambiguous readings, one layer
up. Applying something to everything is a separate, explicit control, and it
writes `defaults/art`. With a target selected, a modifier writes `for <target>`.

**An option set back to what it inherits deletes its line.** Otherwise the file
fills with directives that change nothing, and doc 15's third property —
`emit(settings(parse(x))) == fmt(x)` — is false the first time anyone nudges a
slider and nudges it back.

**A project with no Demakefile gets one on the first changed option**, and it is
byte-identical to what `demake init` writes, plus the block just edited. So the
file appearing is never a surprise: it is the file the CLI would have written
anyway, and deleting it restores the defaults it was an escape from.

**Every control shows its resolved value and where the value came from** —
`dither bayer4 · from defaults/art` — because a four-level cascade you cannot see
is a cascade you debug by guessing. It is the same data doc 15 promises from
`demake build --dry-run --json`, which is the point: one resolver, two surfaces.

**The Demakefile is also just a file in the explorer.** Open it as text, edit it,
and the panes follow; edit a pane and the text follows. Two views of one file,
the same rule the level editor and the block editor run under — and the reason
none of the three can become a second configuration model.

## `build/` is the CLI's; the page builds in the tab

`demake build` writes `build/`. The page never does.

The previewer compiles the cartridge in its worker and holds it in memory, which
is what it already does today and what the parity contract already covers: those
bytes are pinned byte-identical to `demake build`'s. Writing them into the project
would therefore add no capability at all — only a directory that can be stale, and
a second answer to "what is this project's cartridge?"

So `build/` is skipped when a project is opened, excluded from the zip, and absent
from the explorer. It is generated, and a tree that shows generated output invites
someone to edit it. Getting an artifact out of the page is what the Download
buttons in each pane are for; getting a `build/` tree is what the CLI is for, and
a project saved from the page builds one the moment you run it.

`demake init` writes a `.gitignore` naming `build/` for the same reason.

## The level editor

`.dmtl` is a text format an LLM can edit, and that was the point (doc 14
§Levels) — but a person drawing a room wants to draw it. Opening a `.dmtl` gives
you **text, map, or the two side by side**, and neither view is the authoritative
one: the file is.

**It is a view over the format, never a second one.** The same rule the syntax
highlighter runs under (doc 07 §The Demotic section): the file the editor writes
is the file the compiler reads, and a level stays hand-editable whether or not
the editor ever touched it.

The map view is two panes.

**Legend** — one row per tile: the character, the name, whether it is `solid`,
and its art. Art is picked from the project's `art/` folder, which is the first
thing the project model buys this editor: a dropdown of real files rather than a
typed filename. Adding a row picks an unused character; deleting one reports how
many cells in the grid use it before it goes.

**Grid** — the level, drawn with the tile art, painted with the selected legend
character. Pencil, rectangle, flood fill and pick, an eraser that paints the
empty character, and a resize control that pads with the empty character. It
draws through the same code the game section's preview draws tiles with, moved to
a shared component rather than copied — the "no second implementation" rule
applies to a tile drawn on screen exactly as it applies to one demade into a
cartridge.

**Console viewports overlay the grid**, one rectangle per target, because a level
is authored in cells and the consoles do not agree on how many of them fit: 20×18
on a Game Boy, 20×14 on a Game Gear, 32×28 on an NES, 40×28 on a Mega Drive. A
level whose interesting feature is 34 cells wide is a level nobody on a Game Boy
will see whole, and that is a thing to find out while drawing rather than after
building seven cartridges. It is the level-editor form of the *console pixels*
toggle: the product thesis, as a control.

**What the editor must not do to a file**, all three from `.dmtl`'s literalness:

- **A blank line inside the grid is a row of empty cells.** Not a separator.
  Dropping one moves every row below it up, which silently corrupts the shape the
  format exists to preserve (AGENTS.md §Working on Demotic).
- **One row per line, however long.** No reflow, no wrapping, no trailing-space
  trimming inside the grid — trailing spaces are cells.
- **A file it did not change comes back byte-identical.** Opening a level and
  saving the project must not rewrite it.

**Round-trip properties**, CI-checkable, the same shape doc 15 asks of the
Demakefile:

1. `parse(emit(m)) == m` — a model survives being written out.
2. `emit(parse(t)) == t` for canonical `t` — a canonical file survives a round
   trip byte for byte.
3. `emit(parse(t))` differs from `t` only where `t` is non-canonical, and
   `demake fmt` is what makes it canonical.

**Diagnostics are the compiler's**, surfaced in place rather than reinvented:
`E_LEVEL_SYNTAX`, `E_LEVEL_NO_MAP`, `E_DUPLICATE_TILE`, `E_LEVEL_TOO_SMALL`,
`E_STREAM_LEGEND`. A character in the grid with no legend row is shown as itself
on a hatched cell — visible, editable, and not quietly deleted.

**Composed levels (`stream`) are shown, not edited.** A `stream` draws chunks at
build time from the program's seed (doc 14 §Composed levels); the editor edits the
chunks, which are ordinary `.dmtl` files, and shows the composition read-only with
the seed the `.dmt` states. An editor that let you paint a composed course would
be painting something no build will produce.

## The block editor

The third view on a `.dmt`: the program as a list of blocks you drag, drop and
fill in, instead of lines you type. Optional, and never the only way — the text
view is right there, and a game stays hand-written whether or not anyone used
this.

**The language is already the right shape for it, and not by accident.** Demotic
is one statement per line, never nested, with total per-line error recovery, and
its entire surface — statements, properties, triggers, units, functions,
constants, buttons, directions — is a registry in `lang/spec.ts`. Those
properties were chosen so a model could write the language (doc 13
§Agent-driven demaking). They are the same properties a block editor needs: a
flat language needs a *list*, where a nested one would need a tree, a layout and
a set of decisions about what may contain what.

**It is not a visual programming language.** One block is one line of Demotic,
and the file is the model. There are no wires, no nesting and no canvas. The
moment a block can express something no line can, the file has stopped being the
model and the editor has become a second definition of the language — which is
the failure doc 07 already forbids for conversion logic and doc 14 for art.

### The model is the file, line by line

Every source line is a row, and there are four kinds:

- **A statement the editor models** — a block, with a field per slot.
- **A comment line** — kept as its own row and editable as text. `lex()` already
  records comments as source ranges tagged with their line, so reattaching them
  costs nothing and needs no second scanner.
- **A blank line** — kept. Blank lines and `-- title ----` rules are how every
  game in the example library is sectioned, and an editor that dropped them would
  hand back a file nobody recognises.
- **A line that does not parse** — shown as raw text with its diagnostic beside
  it, and never rewritten. The parser already recovers per line, so a broken line
  is one broken row rather than a document the editor refuses to open.

**A row nobody touched is emitted byte-identical.** Only edited rows are
re-rendered from the model. That is stronger than a round-trip property and it is
what makes the editor safe to open a hand-written file with: it cannot reformat,
requote, reorder or re-space anything you did not ask it to.

### The palette is generated, and so are the choices

**Every block the palette offers comes from `STATEMENTS`.** The registry already
carries a `keyword`, a `syntax`, a `summary` and an `example` for each, so the
palette entry, its tooltip and its inline help are all there — a statement added
to the registry appears in the palette the day it lands, exactly as a keyword
added to `KEYWORDS` is coloured the day it lands. **The page keeps no list of
statements**, which is the same iron rule the highlighter is held to.

**The symbols are the page's.** Grammar in the engine, theme in the stylesheet
(doc 07): the engine names no colour and it names no icon either. The page keys a
symbol off each registry keyword, and a `spec.test.ts`-shaped check fails when a
statement has none — so the registry can grow without the palette going quietly
blank, and the engine still knows nothing about how it is drawn.

**And every field offers only what exists**, which is what the project model
unlocks and the reason this editor belongs in this document rather than doc 07:

| Field | Offered from | Shown as |
|---|---|---|
| `sprite`, `backdrop` | the project's `art/` | the pictures themselves, rendered |
| `music` | the project's `music/` | a list you can play |
| `sound` | the project's `sound/` | a list you can play |
| `level … from` | the project's `levels/` | the map, drawn |
| object and scene names | the program's own `create` and `scene` lines | a list |
| buttons, directions, functions, constants, units | `BUTTONS`, `DIRECTIONS`, `FUNCTIONS`, `CONSTANTS`, `UNITS` | a list, with the registry's summary |
| properties | `PROPERTIES`, filtered by context | a list |

That last row is where the registry earns its keep twice over: a property already
declares whether it is `derived` (readable, never assignable) and whether it is
`createOnly` (settable at creation, not in a rule), so the editor offers exactly
the right set in each place without knowing a thing about what any of them mean.
`kind` — `number`, `asset` or `text` — decides which control a field gets.

**It offers; it does not validate.** Diagnostics come from `check()`, the same
call the text view makes, shown against the same rows. An editor that decided for
itself what was legal would be a second front end, and it would be wrong the first
time the language changed.

### The one place it stops: expressions

`when always in play then player.ydirection as min(player.ydirection + 0.04, 0.9)`
is a nested expression inside a flat line, and it is the only part of Demotic that
*is* nested. So it is the one part a list of blocks cannot mirror.

The block carries the statement's skeleton — trigger, subject, target property —
and the expression is a **text field with completion** drawn from the same
registry, staying one line. Nesting expression blocks inside statement blocks is
the obvious alternative and it is the thing that turns this into a visual
programming language: two layout models, two editing gestures, and a canvas. The
honest boundary is better than the slippery one, and the text view is always
there for the expression somebody would rather type.

### Dragging is an edit, not a rearrangement

**Reordering `create` statements changes the program.** Entities live in
declaration order (`sim.entities()`), so that order decides what is drawn over
what, which sprite the hardware drops first past the per-scanline budget, and the
order entities appear in a trace — which makes it an output-byte change under the
doc-09 stability rule, not a tidy-up. Rules are the same: order within a tick
phase is declaration order.

So the editor treats a drag as an edit like any other, and it **never sorts,
groups or tidies a file on its own**. Grouping by scene is a *view* filter that
changes no line. A palette drop inserts at the drop point, which is the main
gesture the whole thing exists for.

### What it must never carry

**No hardware option ever appears in a block**, because none can appear in a
`.dmt`. Which console, which dither, which arranger strategy — those are the
Demakefile's, they are edited by the asset editors (§Options edit the
Demakefile), and the fact that the two editors cannot reach each other's files is
doc 14's central split showing up as two panes instead of a paragraph.

## Opening, saving, and the parity claim

**The model is always an in-memory tree.** Everything else is a binding from it
to somewhere.

- **A real directory**, via the File System Access API where the browser has it:
  open a folder, edit, save, and the files on disk are the files the CLI builds.
  No import step and no copy — the page is editing the project, not a picture of
  it.
- **A zip**, everywhere else: export writes `pong.zip` holding exactly the folder;
  import reads one back. It is the same tree, so a project that made the round
  trip through a zip is byte-identical to one that did not.
- **The example projects**, which is what the site opens with, and which are
  bundled exactly as the demo files are bundled today.

**No server, no account, no upload** — doc 07 §Principles, restated for a folder
rather than an image. A project never leaves the tab except when you save it.

**The zip needs no dependency.** `@demake/core` already carries `deflateStored`
and `inflateRaw` for the PNG codec, so writing a zip is a header format over code
that exists and reading one is the same inflate a PNG uses. Written entries are
stored rather than deflated — a project is a few hundred kilobytes and most of it
is already-compressed WAV — and read entries must handle both, because other
tools write deflated ones.

**The parity contract, at the folder level.** Doc 07 pins the page's PNG, its
cartridge, its `.vgm` and its WAV as byte-identical to the CLI's. A project adds
one property above them:

> The example projects exported from the page unzip to the folders in the
> repository, byte for byte — and building an imported folder in the page
> produces the artifacts `demake build` produces from the same folder on disk.

That is what "feature parity with the CLI" has to mean once the unit is a folder,
and it belongs in `packages/web/test/e2e/determinism.spec.ts` beside the four
artifact comparisons already there.

## The example library becomes example projects

Today the seven games are flat files in two directories and share assets by
sitting next to each other. As projects:

```
packages/demotic/fixtures/projects/
  pong/  breakout/  platformer/  dodger/  shooter/  caves/  runner/
```

Each with `src/`, `art/`, and whichever of `music/`, `sound/` and `levels/` it
uses. `pong` stays what the site opens with and what `pnpm play` runs.

**Shared assets get copied, and that is the right price.** `ball.svg` is Pong's
and Breakout's; `bounce.wav` is Pong's and Breakout's. Under a project folder each
gets its own, because a project you can hand to somebody must not reach outside
itself — a folder whose sprites live in a sibling directory is not a project, it
is a fragment of this repository. The duplication is a few kilobytes of SVG and it
buys the property the whole document rests on.

Everything that reads the fixtures follows: `rom.test.ts`, `audio.test.ts`,
`games.test.ts`, `parallel.test.ts`, the terminal runners in `demo/`, and the
page's `demo-game.ts` and `demo-audio.ts`. The golden traces travel with their
project. This is the largest mechanical change the document asks for and it is
almost entirely path arithmetic; the games themselves do not change a character,
which is the check that the conversion was faithful — every trace is a golden.

## Splitting a game across several `.dmt` files — open

The user-facing want is real: one file per scene, or a file of shared object
definitions. What it costs is a language change, and AGENTS.md reserves those for
the maintainer, so this section states the options and decides nothing.

**The evidence says it is not yet urgent.** The example library's largest game is
96 lines (`caves.dmt`), the median is 73, and no fixture has ever been split for
readability. AGENTS.md §Working on Demotic is explicit that language features come
from the example library rather than from theory, so the honest position is that
nothing in the library asks for this today — and that a project big enough to
need it is exactly what would settle the design.

**Option A — every `.dmt` in `src/` is the game.** No language surface at all:
the build concatenates them in filename order and compiles one program. Demotic is
already flat and order-free, so this is well-defined, and a name defined twice is
the duplicate-definition error the language already has.
*Against:* file layout becomes load-bearing — moving a file out of `src/` silently
removes code — and there is no way to share a file between two projects or to see
from the entry file what the program contains.

**Option B — an explicit `import` statement.** `import play.dmt` in the entry
file, resolved in `src/`, cycles refused, no conditional form. Greppable, and the
entry file tells you what the program is.
*Against:* it is a real addition to `lang/spec.ts` with its own diagnostics
(`E_IMPORT_MISSING`, `E_IMPORT_CYCLE`, `E_IMPORT_ESCAPE`), and it introduces a
second answer to "what is in this program?" — the file list and the import graph —
which is the kind of ambiguity the language avoids elsewhere.

**Option C — neither, for now.** One `.dmt` per project. Everything else in this
document works unchanged; `src/` simply holds a source and its test suite.

Whichever is chosen, two things do not move: a `.dmt` still names no path outside
its own kind's resolution (§The rule that makes it work), and the trace invariant
still holds — splitting a file must be byte-identical in `demake trace`, which is
the property that would make either mechanism safe to add later.

## The CLI keeps up

The parity claim is a two-way one, so the folder is a first-class CLI input.
Flags land in `packages/cli-spec` first, as always (doc 05).

- `demake build <dir>` builds a project: the Demakefile's targets, or every
  console with a runtime. With no argument, the working directory when it looks
  like a project. `demake build <file.dmt>` is unchanged.
- `demake init [<dir>]` scaffolds the canonical folders and writes the Demakefile
  that reproduces the defaults — which is what doc 15 already says `init` is for,
  now with somewhere to put the files.
- `demake check <dir>` resolves the whole project: every source, every asset, every
  target, every path that will be written. It is `--dry-run --json` with a folder
  in front of it.
- `demake fmt <dir>` canonicalizes every `.dmt`, `.test.dmt`, `.dmtl` and
  Demakefile in it.

None of these is a new engine capability. A project resolver is a pure function
from a file tree to a resolved plan, so it lives in `@demake/demotic` beside the
Demakefile parser (doc 02 §Monorepo layout) and both edges hand it a tree they
read their own way — `node:fs` on one side, the in-memory tree on the other. The
CLI and the page therefore resolve a project with the same code, which is the only
version of this that stays parity-safe.

## What does not change

Stated because a change this wide is exactly where invariants get lost:

- **A `.dmt` names no hardware and no build path** (doc 14 §The central split).
  The folder layout is resolution, not syntax.
- **`trace(dmt, console, region)` is byte-identical with and without a
  Demakefile** (doc 15). A project cannot change how a game plays.
- **The page grows no conversion logic** (doc 07). A project is data; every byte
  it produces still comes out of `@demake/core`, `@demake/demotic` and
  `@demake/audio` through the workers.
- **The engine packages stay platform-pure** (doc 02). File System Access, zips
  and `node:fs` are all edge code; what the engine sees is a tree of names and
  `Uint8Array`s.
- **Determinism.** Directory walks are sorted by filename before anything reads
  them, because a resolver whose answer depended on readdir order would be a
  build whose output depended on a filesystem.

## The JS budget

Doc 07's budget is a sum over the whole site and it is close — the last console
cost 4.6 KB of it. This document adds an explorer, a project resolver, a zip
codec, a level editor and a block editor, and the plan for each is stated rather
than assumed:

- **The level editor and the block editor are code-split**, each behind the file
  type that opens it. Someone who came to convert an image downloads neither.
- **The zip codec reuses `@demake/core`'s deflate and inflate**, so its own cost
  is the archive headers.
- **The project resolver runs in the worker**, where `@demake/demotic` already
  is. A resolver imported by a component is a second copy of the language in the
  bundle, which is the mistake the game section already made once (doc 07
  §Quality bar).
- **The explorer is markup**, and the editors it opens are the ones that exist.
- **The block editor's palette is data the engine already ships.** It reads
  `lang/spec.ts`, which the game editor has loaded anyway; its own weight is the
  drag interaction and the symbols. Generating a palette is cheaper than
  hand-writing one *and* smaller, which is the rare case where the rule that keeps
  it correct is also the one that keeps it light.

It must be measured with `pnpm check:web-budget` rather than argued about, and if
it does not fit, doc 07's rule applies unchanged: the next thing that does not fit
should be made smaller rather than given more room.

## Order of work

Each step is useful on its own and none of them breaks the one before.

1. **The resolver** in `@demake/demotic`: a tree of names and bytes → a resolved
   project. Kind-directed lookup, the ambiguity error, sorted walks. Pure, and
   testable with no filesystem at all.
2. **The example projects**: convert the fixtures, repoint every reader. The
   golden traces are the check that nothing moved but paths.
3. **The CLI**: `build <dir>`, `check <dir>`, `init`. Parity's other half, and it
   is what makes step 2 provably right.
4. **The Demakefile's new surface**: `targets`, the per-domain `defaults`, the
   `music`/`sound` blocks — with doc 15 absorbing them.
5. **The shell**: the explorer, tabs, and an editor bound to each file type. The
   four demakers become what opens for their kind and are otherwise untouched.
   Bundled example projects only; no file I/O yet.
6. **Options edit the Demakefile**: the write-back, the provenance display, and
   doc 15's three round-trip properties as tests. This is what makes step 4 a
   feature rather than a file format.
7. **Open and save**: File System Access, the zip, and the determinism property.
8. **The level editor**: wants the resolver under it, since its legend picks art
   from the project.
9. **The block editor**: last, because it wants everything above it — the
   registry-generated palette is free, but a field that offers you the project's
   sprites as pictures needs the project.

## Not in v1

Named so the shape stays honest.

- **Multiple projects open at once.** One project, one tab. Two would need a
  workspace concept above the folder, and nothing yet asks for one.
- **A file manager.** Rename, move and delete are the filesystem's job, or the
  zip's. The page adds files (drop one into the explorer or an editor) and edits
  them; it does not reorganise a folder.
- **A split editor, or two files side by side.** The side-by-side inside an
  editor is between two *views of one file*, which is a different thing and the
  only one this document argues for.
- **Expression blocks.** §The one place it stops: the nested part of the language
  stays a text field with completion.
- **Git, history or undo across files.** Per-editor undo, and nothing above it.
- **Project templates beyond `demake init`.** "New project from Pong" is copying a
  folder, which is a thing the operating system does well.
- **Editing binary resources.** The page demakes art, music and effects; it does
  not draw, compose or record them. That boundary is doc 01's and this document
  does not move it.
- **Tile editing**, for the reason doc 13 gives: a tileset exists because
  hardware forces art to be shared, so a tile editor cuts against the premise.
  The level editor edits a *level*, whose tiles are named art files.
