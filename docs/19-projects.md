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
site's rail lists only those — a tree of four empty directories is a tree that
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

## The site becomes a project workspace

Today each section holds one artifact and offers a bundled demo to fill it. With
a project open, the project *is* the demo, and a section shows the project's
resources of its kind.

**The rail.** A persistent list down the left: the project's name, and each
non-empty folder with its files. Clicking a file selects it *in the section that
edits its kind* and navigates there. So the rail is a router and a directory
listing, and it is the only genuinely new piece of chrome — the sections
themselves keep doing exactly what they do now, to one file at a time.

| Folder | Section | What changes |
|---|---|---|
| `src/` | demotic game demaker | the example picker becomes the project's `.dmt` list |
| `art/` | art demaker | the input pane becomes the project's art list; drop-to-add writes into `art/` |
| `music/` | music demaker | the bundled-track picker becomes the project's `music/` |
| `sound/` | sound demaker | the same, for `sound/` |
| `levels/` | **level editor** (new, §below) | — |
| `Demakefile` | build view (new) | the file, its resolved plan, and every artifact it produces |

**Which file a section is showing goes in the hash**, beside what is already
there: `#section=art&file=ball.svg`. It names a file *within whatever project is
open* and carries no content, so a link shared with a stranger opens that file of
the example project or nothing at all — which is the honest behaviour, since the
alternative is a URL that pretends to carry a project it cannot.

The art demaker's option permalink is unaffected: it is still the unmarked
default and still carries only options (doc 07 §UX). A `file=` key is additive.

**The console picker becomes the project's targets.** The game section currently
picks any console with a backend; with a Demakefile it picks among the targets
the project declares, and the build view builds all of them. With no Demakefile
it is what it is today, because that is what the zero-config path means.

**And the equivalent command line becomes an equivalent Demakefile.** Doc 15
§The equivalence contract already asks for this and gives the three round-trip
properties that make it true rather than aspirational; the project view is where
it finally has a place to live. A section still shows its own single-artifact
command line, because `demake prep ball.svg -c gbc …` is what you would actually
run to reproduce what that pane is showing.

**Editing a file marks the project dirty, not the section.** One dirty flag, one
Save, one export — a project half-written to disk is worse than either state.

## The level editor

`.dmtl` is a text format an LLM can edit, and that was the point (doc 14
§Levels) — but a person drawing a room wants to draw it. A sixth section, code-split
like the others.

**It is a view over the format, never a second one.** The same rule the syntax
highlighter runs under (doc 07 §The Demotic section): the file the editor writes
is the file the compiler reads, and a level stays hand-editable whether or not
the editor ever touched it.

Two panes.

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
cost 4.6 KB of it. This document adds a rail, a project resolver, a zip codec and
a level editor, and the plan for each is stated rather than assumed:

- **The level editor is code-split**, like every section but the art demaker.
- **The zip codec reuses `@demake/core`'s deflate and inflate**, so its own cost
  is the archive headers.
- **The project resolver runs in the worker**, where `@demake/demotic` already
  is. A resolver imported by a component is a second copy of the language in the
  bundle, which is the mistake the game section already made once (doc 07
  §Quality bar).
- **The rail is markup**, and the sections it routes to are the ones that exist.

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
5. **The rail and the sections**: the project opens, each section lists its kind.
   Bundled example projects only; no file I/O yet.
6. **Open and save**: File System Access, the zip, and the determinism property.
7. **The level editor**: the largest single piece, and the one that most needs
   the resolver under it, since its legend picks art from the project.

## Not in v1

Named so the shape stays honest.

- **Multiple projects open at once.** One project, one tab. Two would need a
  workspace concept above the folder, and nothing yet asks for one.
- **A file manager.** Rename, move and delete are the filesystem's job, or the
  zip's. The page adds files (drop one into a section) and edits them; it does not
  reorganise a folder.
- **Git, history or undo across files.** Per-editor undo, and nothing above it.
- **Project templates beyond `demake init`.** "New project from Pong" is copying a
  folder, which is a thing the operating system does well.
- **Editing binary resources.** The page demakes art, music and effects; it does
  not draw, compose or record them. That boundary is doc 01's and this document
  does not move it.
- **Tile editing**, for the reason doc 13 gives: a tileset exists because
  hardware forces art to be shared, so a tile editor cuts against the premise.
  The level editor edits a *level*, whose tiles are named art files.
