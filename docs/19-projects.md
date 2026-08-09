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

**This is a convention, not a rule.** It is what `demake init` writes and what
the web app arranges a new project as, and nothing anywhere requires it. A
directory holding `pong.dmt`, `ball.svg` and `rally.mid` flat is a project; so is
one with `assets/sprites/`, or a folder per level, or the sources of seven games
side by side. Nothing resolves a reference by looking in a particular directory
(§The rule), so the layout is free — which is the strongest form of the bargain
doc 15 already makes about the Demakefile: the structured form is an escape from
the defaults, never a prerequisite.

**A folder with a `.dmt` anywhere in it is a project.**

**Empty folders are absent, not empty.** A game with no music has no `music/`.
`demake init` creates only the folders a project has something to put in, and the
site's explorer lists only those — a tree of four empty directories is a tree that
teaches nothing about the project.

## The rule: the shortest name that identifies the file

**Paths and extensions are optional.** Write `ball` and if exactly one art file in
the project is called that, it is the one you meant. Write more only when *more*
is what it takes to say which file — and the compiler tells you when that moment
arrives, rather than guessing and being wrong quietly.

This is the load-bearing decision, and it replaces looking in a particular
directory with something both simpler and more general: a reference identifies a
file, and the folder it lives in is nobody's business.

**Kind comes from the statement, and it is what makes an extension optional.**
Every file reference in Demotic already says what kind of file it is, because the
statement naming it does — so `sprite ball` never has to consider `music/ball.mid`:

| Written in the source | Kind |
|---|---|
| `sprite hero`, `backdrop caves.title` | art |
| `tile # wall solid brick` (a `.dmtl` legend) | art |
| `music hollow` | music |
| `sound jump on …` | sound |
| `level cavern from cavern`, `stream` chunks | level |

### Matching

A reference matches a file when, splitting both on `/`:

- the reference's segments are a **tail** of the file's project-relative path,
  compared segment by segment — so `ball.png` never matches `pinball.png`, and
  `foo/ball` matches `art/foo/ball.png` but not `bar/ball.png`;
- the **final** segment matches the file's name *or* its name with the extension
  removed, which is the whole of "extensions are optional";
- the file's kind is the one the statement implies.

Then:

| Candidates | Result |
|---|---|
| exactly one | that file |
| more than one | `E_ASSET_AMBIGUOUS` — the line, every candidate, and the shortest string that would pick each |
| none | the reference stands as written: a missing asset, handled as it is today |

**Adding a leading segment is always enough**, because the whole relative path is
unique. Where a full path is itself a proper suffix of a longer one — `foo/ball.png`
beside `art/foo/ball.png` — the **exact whole-path match wins**, so every file in
a project can always be named. That is specificity, not a quiet tiebreak: naming a
file completely means that file. The alternative, a leading `/` to root a
reference, is syntax bought for a case the specificity rule already answers.

So the diagnostic is not "you did not write a path", it is "the name you wrote
fits two files, and here are the two strings that do not". Ambiguity is reported
where it exists rather than pre-empted everywhere it might.

### Where it happens, and when it does not

**In the compiler**, because it must be an error with a line number in it — the
edge that reads bytes has no idea which line asked. `CompileOptions` gains an
optional `files`: the project's relative paths, sorted. It is names only; the
compiler still reads nothing, so platform purity (doc 02) is untouched.

**Without that list, nothing is ambiguous.** A `.dmt` on stdin, or one compiled
with no project around it, resolves every reference to itself and reports
nothing — which is the point of making the list optional. A diagnostic exists
exactly where the compiler knows enough to be sure of it, and not one step
earlier.

**Missing and ambiguous are deliberately asymmetric.** A missing asset stays what
it is today: reported, with the build falling back to the built-in block or to
silence, because refusing to produce a playable cartridge over a renamed sprite
is the worse outcome. An ambiguous one is an error, because there is no safe
fallback — picking one of two files is exactly the silent wrong-program failure
the language refuses everywhere else (doc 14 §The readings the language will not
guess between).

**`Program.assets` becomes resolved paths.** Both edges then stop searching:
the CLI reads the path the compiler resolved and the page looks it up in the
tree. The lookup logic that exists in `cli/src/commands/build.ts` and again in
the page's demo loader is deleted rather than moved, which is most of the point —
one resolver, in the one place that can report a line.

### The cost, named

**Adding a file can break a reference that used to work.** Drop `ball.svg` beside
`ball.png` and `sprite ball` becomes ambiguous. That is the accepted price of
shortest-name resolution and every language with it pays the same one; what makes
it tolerable is that the error names the exact strings that fix it, arrives at
compile time with a line number, and can be one click in the block editor.

**A path in a `.dmt` is still not a hardware fact.** An earlier draft of this
document argued that a `.dmt` must never contain a path at all. That was too
strong: a relative path inside the project names a *source file*, exactly as a
bare name does, and doc 14's central split is about hardware, options and built
artifacts — none of which a path names. What holds is the weaker and truer
version: the shortest form is idiomatic and is what the tools write, a longer one
is available when the short one is genuinely ambiguous, and neither says anything
about a console.

## The Demakefile, still optional

Doc 15 stands: delete the Demakefile and the game plays identically; only the
artifacts change. A project folder changes three of its defaults and adds two
blocks.

**Defaults the folder now supplies:**

- `source` — the single `.dmt` in `src/`, then the single `.dmt` at the root.
  Several with no `source` directive stays `E_NO_SOURCE`, which is also the
  diagnostic that would name a multi-file mechanism if one existed (§Splitting a
  game).
- `assets` — every file in the project, `build/` excluded. There is no search
  path to configure any more (§The rule), so the directive's only remaining job
  is to bring in files from *outside* the project folder, and a project that
  keeps its sources inside itself never writes one.
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
and it replaces `#section=` as the thing that decides what is on screen — the
row of section tabs the site used to carry is **gone**, because a tab and a file
selection were two answers to one question and the file is the better one. What
the tabs were also carrying was the commands, and those are the menu bar's now
(doc 07 §The workbench).

**And it folds away, from a button on the title bar** rather than only from a
menu — on a phone it opens folded, because the tree stacks above the editor at
that width and a third of the screen spent on a file list is a third the editor
does not get (doc 07 §The workbench).

**A bare URL opens the project's game**, chosen by §Defaults the folder now
supplies. The art demaker was the landing page only because it was the first
section written, and a visitor arriving at a tool that turns a game into
cartridges should be looking at the game.

**Opening a file opens the editor for its type**, and every editor is the same
shape — *one file, two or three views of it*:

| File | Editor | Views |
|---|---|---|
| `.dmt` | the game editor | **text** or **blocks** (§The block editor), beside the preview and the cartridge |
| `.test.dmt` | the suite editor | **text** or **blocks**, beside the run (§The suite editor) |
| `.dmtl` | the level editor | **text**, **map**, or side by side |
| `.svg` `.png` | the art demaker | source, options, result — as today |
| `.mid` | the music demaker | source, options, arrangement, listen — as today |
| `.wav` | the sound demaker | the same, for effects |
| `Demakefile` | the text editor | the file as text, coloured by the format's own grammar |
| anything else that is text | the text editor | the file as text, drawn plain |

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

**The Demakefile is also just a file in the explorer** — *built*. Open it as
text, edit it, and the panes follow; edit a pane and the text follows. Two views
of one file, the same rule the level editor and the block editor run under — and
the reason none of the three can become a second configuration model.

It is the **text editor** that opens it (doc 07 §The text editor), which is what
any file in the project that no demaker demakes now opens in: a `.md`, a golden
`.trace`, a note somebody left. The Demakefile is the one of those with a
grammar, and the colours come from `highlightDemakefile()` in `@demake/demotic`,
built on the parser's own directive lists rather than on a regular expression in
the page. A resolved-plan view and a per-target view are still to come; what
exists is the file, editable, saved and zipped with everything else.

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

## A file manager, after all

This document originally listed one under §Not in v1, on the grounds that
rename, move and delete are the filesystem's job or the zip's. **That was wrong,
and it is worth saying why rather than quietly deleting the line.** It was
written when the page was a viewer with a picker on the side; the moment the
explorer became the thing that decides what is on screen, a folder you can edit
but cannot add to is a folder you have to leave the tool to do half the work in
— and "leave the tool" means File System Access on the browsers that have it and
a zip round trip on the ones that do not.

What made the answer cheap is the model. A project is a `Map<string,
Uint8Array>`, so:

- **A move and a rename are one operation.** There are no directories to move
  between, only names with slashes in them (§The layout: the folder structure is
  a convention, and nothing resolves a reference by looking in one). Typing
  `sprites/ball.svg` over `art/ball.svg` moves the file; so does dragging it onto
  another folder. One gesture, one function, and the explorer's tree is derived
  from the paths either way.
- **A new file is an empty entry**, named by typing its path. Naming it into a
  folder that does not exist yet creates the folder, because the folder was never
  a thing — it is a prefix.
- **Nothing is replaced silently.** A rename onto an occupied path is refused and
  said out loud, and a path that climbs out of the project with `..` is refused
  outright rather than resolved — the same call `importZip` already makes about
  an archive entry. Those are the two operations that cannot be undone, and the
  page has no undo across files (§Not in v1, which that line does still cover).

**The editor follows the file it had open.** A rename re-routes to the new path
and a delete falls back to the project's game; a pane that silently went blank on
a rename would be the sort of small wrongness that reads as a crash.

**What this does not add is a second answer to what a project contains.** The
explorer still derives everything from the map, `build/` is still excluded in
both directions, and a reference that becomes ambiguous because of a rename is
reported by the compiler with a line number exactly as §The cost, named says it
will be.

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
and its art. Art is picked from the project's art files, which is the first thing
the project model buys this editor: a dropdown of real pictures rather than a
typed filename, written back as the shortest name that identifies the one chosen. Adding a row suggests an unused character and lets you take
another; deleting one reports how many cells in the grid use it before it goes.

**Every column of a legend row is editable, the character included** — it is the
tile's name in the grid, and a name you can only pick once is a name you get
wrong once. It is edited where it is shown: the character's own box is both the
field and the swatch that says which tile the grid is painting with, because two
controls for one character would be two things to keep in step.

**Changing it redraws every cell that used it**, which is the one legend edit
that reaches the grid — the character in a `tile` line and the characters in the
map are one name for one tile, so a rename that stopped at the legend would
orphan a room full of cells and leave the new entry drawing nothing. That is the
opposite of removing an entry, deliberately: a removed tile is gone and its cells
are left for the compiler to report, while a renamed one is the same tile spelled
differently.

**A character another entry already draws is refused**, and it is the only thing
here that is. A duplicate *name* is written and left to `E_DUPLICATE_TILE`,
because typing it back undoes it; a duplicate character cannot be treated that
way, because the rename redraws the grid and cells merged under one character are
what no later edit can pick apart.

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
be painting something no build will produce. _The read-only composition view is
the one part of this section not yet built_; the chunks are ordinary levels and
edit like any other today.

## The suite editor

**A `.test.dmt` is not a game, and it used to open the game demaker.** It is a
`.dmt`, and the router asked no further question — so a file that builds to
nothing arrived with a console picker, a cartridge and a playable preview around
it, none of which it has anything to do with. A suite is a program *about* a
game.

So it has an editor of its own (`web/src/sections/TestEditor.tsx`), with two
halves and no player:

- **The suite**, as text or as blocks — the same two views a game gets, over the
  same component, because the two grammars differ and the *rows* do not.
- **The run**: every case against every console at once, which is the whole point
  of writing one (doc 14 §Testing a game). A suite that only ever ran on a Game
  Boy would be checking mechanics; running the same relative assertions on twelve
  playfields is what checks balance.

**It says which game it is about, and links to it.** The pairing is `gameFor` —
`suiteFor` read the other way, by name first and falling back to the project's own
entry point, both in the engine so an editor opening a suite and a CLI running one
cannot disagree about what it is asserting against. A project with no game in it
is told so rather than given a Run button that quietly does nothing.

**What is wrong with the game shows here too**, marked as the game's and carrying
no line, because a case that cannot run has two possible causes and only one of
them is in the file on screen.

**The `.test.dmt` grammar has a registry of its own**
(`demotic/src/testing/spec.ts`), separate from `lang/spec.ts` for the reason the
two are separate languages: folding `play` into the table of things a game can say
would put a statement in the language reference that no game may use. It is what
the palette is generated from, and what the parser's own "statements are …" hint
is built from.

**The game section keeps its *Run tests* button.** Running a suite is a thing you
do *while* changing the game, and walking to another file to press a button is
not — and both callers go through one `runSuite` (`web/src/lib/suite.ts`), so they
cannot come to report different numbers.

## The block editor

The third view on a `.dmt`: the program as a list of blocks you fill in and
rearrange, instead of lines you type. Optional, and never the only way — the text
view is right there and is the *default*, and a game stays hand-written whether or
not anyone used this. **Built** (`web/src/components/BlockEditor.tsx` over
`web/src/lib/blocks.ts`), for a suite as well as for a game.

**The fields are what it is for; the drag is not.** That is worth stating plainly,
because "blocks you drag" describes Scratch and this is not Scratch. There, a drag
*is* the composition — you snap a block into a socket and the gesture says what
contains what. Demotic is flat, so a drag here expresses one number: which index.
What the view actually buys over text is that a slot knows what may go in it, and
can therefore show you the four scenes, the seven buttons or the project's own
pictures. That half is a form, and a form is keyboard-operable by construction.

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

**A row nobody touched is emitted byte-identical.** In fact it is sharper than
that, because nothing is re-rendered from a model at all: **every operation is a
splice.** Setting a field rewrites the bytes of one slot, dragging a row moves one
line, and the rest of the file is the bytes that were already there. So the editor
cannot reformat, requote, reorder or re-space anything you did not ask it to —
not because it is careful, but because it never writes anything else.

**Where a slot is comes from the parser.** `parse()` and `parseTests()` each keep a
side channel of `StatementSpan`s (`demotic/src/lang/slots.ts`): the keyword the
registry spells it with, the statement's extent, and a `SourceSlot` per editable
part saying what may go in it. It is the lexer's own habit one phase along — `lex()`
keeps comment ranges the parser has no use for so the highlighter needs no second
scanner, and this keeps slots the *compiler* has no use for so an editor needs no
second parser. The alternative is a page-side walk over the same tokens deciding
the same things again, which is the duplication doc 07 forbids for conversion logic,
and it would be wrong the first time a statement changed shape.

Two properties make the side channel safe to edit through, and
`demotic/test/slots.test.ts` checks both against **every `.dmt` in the
repository** rather than against samples: slots are in source order and never
overlap, and reassembling a statement from its slots and the text between them
gives the line back byte for byte. A line whose slots did not tile it would show
as the text it could not read, which is the safe failure rather than a wrong edit.

### A statement's arity is editable too

Slots describe a statement of **fixed shape** — here are its parts, here is what
may go in each — and half the grammar is not that shape. `when ball hits paddle1,
paddle2` has as many targets as the author wrote; a property list has as many
entries; `stream course from gap.dmtl, pipe.dmtl` has as many chunks. An editor
built on slots alone draws exactly the parts already in the file and offers no way
to a further one, which is a rule whose arity was decided by whoever typed the
line first. That was the state this shipped in and it is the thing that made the
whole view feel like a viewer.

So the side channel has a second half: a `SourceList` per repeating clause, with
each item's range, the extent of the clause, and the three strings an edit writes
— what goes between two items, what a new item says, and what an *empty* clause
says when it gains its first. A ⊕ at the end of each clause and a ⊖ after each
item it may lose are the whole interface. Four things about it are load-bearing.

**A list contains slots rather than replacing them.** Every item's own parts are
still in `slots`, in source order, so the tiling property above is untouched and
the reassembly test still means what it meant. What a list adds is the arithmetic
— where each item is, where the clause begins, what separates two items — which is
exactly what "add one" and "take one out" need and nothing more.

**An absent clause is a list with no items, not a missing list.** `when hero
touches ledge` has a side list whose start and end are the same point, just after
`ledge`, and whose opener is ` from above` — so the ⊕ writes the clause *and the
word that introduces it*, and dropping its last side takes the word back out.
Without that, `from` would only ever be editable in a rule that already had one.
The same fact gives `create ball ball1` a property list, so the first property
brings its own brackets.

**The strings belong to the grammar, not to the page.** ` from above` is the
language's spelling of an empty side clause gaining a side, and a page that spelled
it itself would be a second, disagreeing statement of the syntax — the rule the
palette's templates already run under. It goes further for a property list, because
that list has rules of its own: a name may not repeat (`E_DUPLICATE_PROP`) and some
properties are `createOnly`, so the template is **computed from the list it is going
into** — the first free property at its own default, which parses, compiles and
changes nothing until somebody types in it. A fixed `visible 1` was the first
attempt and it is `E_DUPLICATE_PROP` on the row it was just added to.

**The positional `as` is one list written as two halves, and they move together.**
`(x, y) as (8, 4)` is two bracketed lists that the language refuses to let drift
apart — `E_ARITY` is what it calls that — so the two `SourceList`s carry each
other's index and one edit grows or shrinks both. Only the first half draws the
controls: two ⊕s that did the same thing would read as two different things.

Where the grammar needs an item, there is no ⊖ on the last one — a rule with
nothing to hit is not a rule, and deleting the row is what the × beside it is for.
`min` is the caller's rather than the clause's, which is why a `create`'s property
list can go down to none and a rule's assignment list cannot.

### The palette is generated, and so are the choices

**Every block the palette offers comes from `STATEMENTS`.** The registry already
carries a `keyword`, a `syntax`, a `summary` and an `example` for each, so the
palette entry, its tooltip and its inline help are all there — a statement added
to the registry appears in the palette the day it lands, exactly as a keyword
added to `KEYWORDS` is coloured the day it lands. **The page keeps no list of
statements**, which is the same iron rule the highlighter is held to.

**The symbols are the page's.** Grammar in the engine, theme in the stylesheet
(doc 07): the engine names no colour and it names no icon either. The page keys a
symbol off each registry keyword (`web/src/components/StatementSymbol.tsx`), and
`web/test/symbols.test.ts` fails when a statement has none *and* when a symbol is
drawn for a keyword no registry lists — so the registry can grow without the
palette going quietly blank, and a removed statement cannot leave a picture behind
advertising something the parser rejects. They are drawn as paths rather than
written as emoji, because an emoji is a different picture and often a different
*size* in every font on every platform, which in a column of rows is the one thing
that reads as broken.

**A closed set comes from the registry too.** Buttons, sides and compass headings
are `BUTTONS`, `SIDES` and `DIRECTIONS`; the grammar's own connective words —
`hits`/`touches`, `pressed`/`released`, `hold`/`press`/`release`, `wide`/`tall` —
are `SLOT_CHOICES` beside the slot kinds they belong to, and every one of them is
checked against `KEYWORDS`, so a picker cannot offer a word the reference does not
document. The parser reads the same list it offers: `CONTROL_MODES` *is*
`SLOT_CHOICES.mode`.

**And every field offers only what exists**, which is what the project model
unlocks and the reason this editor belongs in this document rather than doc 07:

| Field | Offered from | Shown as |
|---|---|---|
| `sprite`, `backdrop` | the project's art files | the pictures themselves, rendered |
| `music` | the project's tracks | a list you can play |
| `sound` | the project's effects | a list you can play |
| `level … from` | the project's levels | the map, drawn |
| object and scene names | the program's own `create` and `scene` lines | a list |
| tile names | the legends of the project's own `.dmtl` files | a list |
| buttons, directions, functions, constants, units | `BUTTONS`, `DIRECTIONS`, `FUNCTIONS`, `CONSTANTS`, `UNITS` | a list, with the registry's summary |
| properties | `PROPERTIES`, filtered by context | a list |

**And a picked file is written as the shortest name that identifies it** (§The
rule) — `ball`, growing to `ball.png` or `art/ball.png` only where the project
holds something the shorter form would also fit. The editor is the one thing that
never has to be told this twice: it knows every file, so it can always write the
shortest form, and it is the natural place to offer the one-click fix when a
newly-added file makes an existing reference ambiguous.

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

`when always in play then player.ydirection as min(player.ydirection + 2.4 / fps, 0.9)`
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
gesture the whole thing exists for, and it inserts the registry's own `example`
for that statement — already there for the reference page, always a statement of
that shape, and naming things a real game names rather than angle brackets nobody
can run. What it names may not exist in *this* project, and that is a diagnostic
against the new row rather than a reason to keep a second table of templates.

**A row moves three ways, and dragging is the weakest of them.** Not because of
accessibility alone — that argument is real and it is not the strongest one. A
drag is O(distance) in a list that scrolls, it has no keyboard, and native
drag-and-drop does not fire on touch at all, so the gesture the editor was pitched
on is unavailable on a phone and impractical past the visible dozen rows. So:

- **Dragging** is direct and fastest over a few rows, and the list now **scrolls
  itself** when the pointer nears an edge. Without that a move past the visible
  rows was impossible *with a mouse* — the list is a fixed-height scroller, and
  nothing carried the drag beyond it.
- **Grab and move** is the keyboard's: `Space` on the grip picks a row up, the
  arrows carry it, `Space` drops it, `Escape` puts it back where it was picked up
  however far it travelled. With nothing held the arrows walk between grips, which
  is how you reach line 60 in order to pick it up. Every step is announced through
  a live region, because a row that moves silently has not moved as far as a
  screen reader's user is concerned.
- **Choosing a destination** beats both over a distance: clicking the grip opens
  a filtered list of every place the row could go, so line 60 reaches line 3 in
  two keystrokes. Dragging is O(distance), the arrows are O(rows), this is O(1) —
  and it is the only one of the three that is *better* for being a form.

The same argument reaches the palette, which is a grid of chips **and** a search
box: the grid is how you find out there are thirteen statements and what they are
called, the box is how somebody who knows that adds a `when` without reaching for
the mouse. It is the bargain Ctrl+P strikes with the explorer, one pane along.

### One tab stop per row, not one per control

Rows are a **roving-tabindex list**: Tab reaches the row you were last on, the
arrows walk between rows, and only that row puts its own fields in the tab order.
Any focus inside a row makes it the active one, so tabbing to a field and then
adding a statement puts the statement where you are looking.

The alternative is what it replaced, and the number is the argument: every control
of every row being tabbable put **352 tab stops** between a seventy-line game and
whatever came after it. That is a worse barrier for a keyboard than the drag ever
was, and it was introduced in the same change that added the keyboard moves — so
"is it operable" has to be asked about the *whole* pane and not about the gesture
being worked on.

### A problem is shown where it is

Not in a list underneath naming line numbers you then go and count to. That is the
text view's answer, and a graphical view has a better one:

- **Against its own row**, under the fields, with the row marked down its left
  edge — red for an error, amber for a warning.
- **Counted above the list**, with a button to the first one, because a row
  scrolled out of view is a problem you cannot see.
- **At the top of the list when it names no row**, which is how the suite editor
  reports that the *game* under it will not compile. That is a real reason a suite
  can never pass and it names no line in the file on screen; dropping it left a
  suite that always failed with nothing anywhere saying why.

Which problems exist is `check()`'s and the parser's; all this decides is where to
put them (§It offers; it does not validate).

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

**The first half holds and is checked.** `packages/web/test/zip.test.ts` takes
Pong's project folder off disk, exports it, imports it back and compares file for
file and byte for byte; the same comparison against an independent zip reader is
what the export was verified with. The second half is the browser-vs-CLI
comparison `determinism.spec.ts` already makes for a cartridge, now that both
sides start from a folder.

That is what "feature parity with the CLI" has to mean once the unit is a folder,
and it belongs in `packages/web/test/e2e/determinism.spec.ts` beside the four
artifact comparisons already there.

## The example library becomes example projects

Today the games are flat files in two directories and share assets by
sitting next to each other. As projects:

```
packages/demotic/fixtures/projects/
  pong/  breakout/  platformer/  dodger/  shooter/  caves/  runner/  quest/
```

Each with `src/`, `art/`, and whichever of `music/`, `sound/` and `levels/` it
uses. `pong` stays what the site opens with and what `pnpm play` runs.

**Shared assets get copied, and that is the right price.** `ball.svg` is Pong's
and Breakout's; `bounce.wav` is Pong's and Breakout's. Under a project folder each
gets its own, because a project you can hand to somebody must not reach outside
itself — a folder whose sprites live in a sibling directory is not a project, it
is a fragment of this repository. The duplication is a few kilobytes of SVG and it
buys the property the whole document rests on.

Everything that reads the fixtures follows: `rom.test.ts`, `_audio-battery.ts`,
`games.test.ts`, `parallel.test.ts`, the terminal runners in `demo/`, and the
page's example loader — which globs the project folders, so a project added to the
repository is in the site's library without a list being edited. The golden traces travel with their
project. This is the largest mechanical change the document asks for and it is
almost entirely path arithmetic; the games themselves do not change a character,
which is the check that the conversion was faithful — every trace is a golden.

## Splitting a game across several `.dmt` files — open

The user-facing want is real: one file per scene, or a file of shared object
definitions. What it costs is a language change, and AGENTS.md reserves those for
the maintainer, so this section states the options and decides nothing.

**The evidence has moved, and it is worth saying so.** When this section was
written the library's largest game was 96 lines (`caves.dmt`) against a median of
73, and the honest position was that nothing in it asked for a split. `quest.dmt`
is 389 lines — three levels, a boss and a secret room — which is the first fixture
big enough to have an opinion. It still reads top to bottom, because it is written
against *classes* rather than named objects and one rule covers four playfields,
so it argues for a split less strongly than its line count suggests. But it is the
project the design question should be settled against, and AGENTS.md §Working on
Demotic is explicit that language features come from the example library rather
than from theory: the library now has the case.

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

- `demake build <dir>` builds a project — **built**. It finds the game (`src/`
  first, then the root), hands the compiler the folder's file list so a bare
  `sprite ball` resolves, loads every level and asset by resolved path, and
  reports what it resolved under `--json`. With no argument it builds the working
  directory when it looks like a project, and falls through to stdin when it does
  not. `demake build <file.dmt>` is unchanged, which is the zero-config path
  still being the zero-config path. Targets are still one console at a time until
  the Demakefile lands.
- `demake init [<dir>]` writes the Demakefile that reproduces the defaults, plus a
  `.gitignore` naming `build/` — **built**. It emits through the Demakefile
  *emitter* rather than a template, so what it writes is already canonical and
  parsing it gives the defaults back. The project's name is the entry file's
  *stem*, not the directory's, because that is what the resolver defaults to: a
  name off the directory changed the cartridge title, which would have made `init`
  a decision instead of a starting point.
- `demake check <dir>` resolves the whole project: every source, every asset, every
  target, every path that will be written — **built**, and it writes nothing at
  all, which is the whole difference from `build` and why it has no `--output`. It
  checks every target the Demakefile declares, or every console with a backend when
  there is none, and an error every target reports is printed **once** rather than
  eight times: an ambiguous reference is a fact about the source, not about a
  console.
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

- **A `.dmt` names no hardware, no option and no built artifact** (doc 14 §The
  central split). It names source files, at whatever length it takes to say which
  one (§The cost, named).
- **`trace(dmt, console, region)` is byte-identical with and without a
  Demakefile** (doc 15). A project cannot change how a game plays.
- **The page grows no conversion logic** (doc 07). A project is data; every byte
  it produces still comes out of `@demake/core`, `@demake/demotic` and
  `@demake/audio` through the workers.
- **The engine packages stay platform-pure** (doc 02). File System Access, zips
  and `node:fs` are all edge code; what the engine sees is a tree of names and
  `Uint8Array`s.
- **Determinism.** The candidate list is the project's paths, sorted, before
  anything matches against it — a resolver whose answer depended on readdir order
  would be a build whose output depended on a filesystem, and the two edges
  enumerate a directory by completely different means.

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

1. **Reference resolution** in the compiler: `CompileOptions.files`, suffix
   matching, kind filtering, `E_ASSET_AMBIGUOUS`, and `Program.assets` carrying
   resolved paths. Pure, testable with no filesystem at all, and it deletes the
   lookup code in both edges rather than moving it. Absent the file list nothing
   changes, so every existing caller keeps working while it lands.
2. **The example projects**: convert the fixtures, repoint every reader. The
   golden traces are the check that nothing moved but paths.
3. **The CLI** — **done**: `build <dir>`, `check <dir>` and `init`. Parity's other
   half, and it is what makes step 2 provably right: the cartridge
   `demake build ./caves` writes is byte-identical to the one the engine builds
   from the same folder, which is what the page is pinned against — and the
   cartridge built with `init`'s Demakefile is byte-identical to the zero-config
   one, which is doc 15's promise about that file made checkable.
4. **The Demakefile's new surface** — **mostly done**: `targets`, the per-domain
   `defaults` and the `music`/`sound` blocks parse, emit and resolve, with doc 15's
   three round-trip properties as tests and the gameplay invariant beside them.
   `demake build <dir>` honours `source`, `out`, output paths and the header's
   `title`, and **art's conversion options now reach the fitter** on all five
   backends — a `dither` in a build file changes the cartridge, and a value the
   engine cannot use stops the build. Audio's options and the rest of `header` are
   still resolved-but-unapplied; doc 15 §Status names both.
5. **The shell**: the explorer, tabs, and an editor bound to each file type. The
   four demakers become what opens for their kind and are otherwise untouched.
   Bundled example projects only; no file I/O yet.
6. **Options edit the Demakefile** — **done for art**. The art demaker's
   controls are a view of the file when a project art file is open: they seed from
   the cascade, a change writes the `art <name>` block for *that* asset, and
   setting one back to what it inherits removes the line and the block with it. A
   project with no build file gets the one `demake init` would have written. A
   hand-authored file keeps its comments, blank lines and order, because the model
   is comment-preserving and only the changed line is rewritten. The pane says
   which file and which block it is writing, and what is inherited right now.
   Music and sound still hold their own settings: their options are resolved but
   not yet applied (doc 15 §Status), and a control that wrote one would be writing
   something no build reads.
7. **Open and save** — **done**: File System Access where the browser has it, a
   zip everywhere else, both over `@demake/core`'s own deflate and CRC. The zip is
   deterministic (every entry takes the DOS epoch, so an export is reproducible),
   `build/` is excluded in both directions, and a path climbing out of the archive
   is skipped rather than trusted. The parity property above is demonstrated: the
   zip the page exports, read by an independent zip implementation, unzips to the
   repository's own project folder with the same file list and every byte
   identical.
8. **The level editor** — **done**: text, map, or both, over one text-surgical
   model (`web/src/lib/dmtl.ts`) that rewrites only the lines it changes, so the
   three rules `.dmtl`'s literalness imposes hold by construction rather than by
   care. Legend rows edit in place — name, `solid`, and art picked from the
   project's own pictures and written as the shortest name that identifies one —
   and the grid paints with pencil, rectangle, flood, erase and pick, resizes
   from the top-left corner, and carries the console viewport overlays. Cells are
   drawn through the same function the game section's preview draws a scene's
   tiles with (`web/src/lib/tiles.ts`), which is the no-second-implementation
   rule applied to a tile on screen. A `stream` composition is still not shown;
   the chunks it draws from are ordinary levels and edit like any other.
9. **The block editor** — **done**: one row per source line over a text-surgical
   model (`web/src/lib/blocks.ts`) where every operation is a splice, so a row
   nobody touched is byte-identical by construction. The palette is `STATEMENTS`
   (or `TEST_STATEMENTS` for a suite), the fields come from the parsers' own slot
   side channel (`demotic/src/lang/slots.ts`), the closed sets come from the
   language registry, and the project supplies the rest — sprites and backdrops
   picked as *pictures*, tracks and effects and levels as lists, scene and object
   names as the program's own. A row moves three ways — dragged, carried with the
   keyboard, or sent to a destination picked from a list — because a drag alone is
   O(distance), silent, and absent on touch; rows are a roving-tabindex list, so
   the editor can be tabbed past; and a diagnostic is shown against its own row.
   Expressions stay a text field, which is where §The one place it stops said they
   would.
10. **The suite editor** — **done**: a `.test.dmt` opens §The suite editor rather
    than the game demaker, with the same two views over the file and the
    cross-console run in place of a player.

## Not in v1

Named so the shape stays honest.

- **Multiple projects open at once.** One project, one tab. Two would need a
  workspace concept above the folder, and nothing yet asks for one.
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
  does not move it. Where it might eventually move is
  [doc 13](13-roadmap.md) §Declarative art, music and sound — if a picture, a
  track and an effect ever have Demotic source forms, a project becomes entirely
  text and its assets get editors for the same reason `.dmtl` does. The condition
  that has to hold first is stated there, and it is a real one.
- **Tile editing**, for the reason doc 13 gives: a tileset exists because
  hardware forces art to be shared, so a tile editor cuts against the premise.
  The level editor edits a *level*, whose tiles are named art files.
