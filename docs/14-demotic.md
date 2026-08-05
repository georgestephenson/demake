# 14 — Demotic (the game language)

**Demotic** is a declarative language for describing a game once and building it
for every console in the target set. Files use the **`.dmt`** extension.

The name is the point: *demotic* is the everyday, popular register of a script —
the Rosetta Stone carries the same text in hieratic, Greek, and demotic. Demotic
carries the same game to every console, in the register a person (or an agent)
can actually write.

It is the third domain in the tool, alongside image conversion (`prep`/`gen`) and
the ROM path — and it reuses both. Implementation lives in
[`packages/demotic`](../packages/demotic/README.md); the build manifest that
aims it at real hardware is [doc 15, the Demakefile](15-demakefile.md).

**Status.** The language, its reference interpreter, the trace oracle, and a
browser preview exist and run — and so does the first console runtime: `demake
build` turns a `.dmt` into a playable 32 KiB Game Boy cartridge, proven against
the interpreter tick for tick (§Runtime model, §Conformance). Milestones are in
[doc 13](13-roadmap.md).

## The central split

Two files, one law:

> **Demotic describes the game. The Demakefile describes the build.**
> A `.dmt` file knows nothing about hardware — not a console name, not a palette,
> not a pixel. That is what makes it portable.

The operational test, which is a CI property and not a slogan:

- **Delete the Demakefile and the game still plays identically.** Only the
  artifacts change. `demake trace` for a given (console, region) must produce
  byte-identical output with and without one.
- **Nothing in the Demakefile can alter gameplay.** It selects *which* profile a
  build targets; it cannot change what a profile does.

The one apparent exception proves the rule. Region (NTSC vs PAL) changes the tick
rate, which changes traces. It is therefore not an override but a *profile
selector*: `md` and `md-pal` are two profiles with two golden traces. The
Demakefile picks one. It never edits one.

Where a property could plausibly live in either file, the split is:

| Belongs in `.dmt` | Belongs in the Demakefile |
|---|---|
| Collision box, absolute or relative (`1 cell`, `15vw`) | Which art file, prepped how |
| Speed, per second (`40vmin`) | Console, region, artifacts, paths |
| Rules, scenes, controls | ROM header title, mapper, serial |
| Which abstract button acts | How that button maps on odd hardware |
| Score limits, win conditions | Output formats and file names |

If removing a line changes how the game *plays*, it is Demotic. If it changes how
the game *looks or builds*, it is the Demakefile.

## Scope

Eleven consoles: `gb`, `gbc`, `megaduck`, `nes`, `sms`, `gg`, `md`, `snes`,
`gba`, `nds`, `pce` — all tiled sprite machines with multi-colour hardware
sprites and a comparable button set. Which of them *build today* is
[`console-support.md`](console-support.md), which is generated; doc 13 §Console
rollout costs the rest.

Deliberately excluded, each for its own reason:

- **SG-1000 / TMS9918** — four sprites per scanline and one colour per sprite.
  That does not constrain the language so much as distort it, since every other
  target shares a multi-colour sprite model. Two further facts about the hardware
  put it out of scope for games for good rather than for now — it has no scroll
  register, so a camera cannot be compiled, and 1 KB of work RAM against the
  700–950 bytes a game needs. Doc 13 §The SG-1000 is out of scope for games is
  where that decision is recorded in full. It remains a target for everything
  else demake does: art, data, a display ROM, and music and effects.
- **Framebuffer-only handhelds** (Supervision, Game.com, Lynx) — no hardware
  sprites at all.
- **Neo Geo** — no tilemap background; the background *is* sprites.
- **Atari 2600, Virtual Boy, Intellivision** — each breaks the model differently.

The honest shape of "every console" is therefore *profiles*, not one lowest common
denominator. Demotic implements the largest coherent profile; the excluded
machines would each need their own, and are not promised.

## The three decisions that matter

### 1. Simulate constrained, render unconstrained

Game state advances in **16.16 fixed point on a fixed logical tick**, identically
in the browser preview and on hardware. Only *rendering* is free — SVG art,
arbitrary resolution, interpolation between ticks.

Without this the preview would be a second, disagreeing implementation of the
game and would drift from a ROM within seconds. With it, the preview *is* the
specification: `packages/demotic/src/sim.ts` defines the semantics and every
console runtime is a conformance implementation of it.

Consequences, all deliberate: no floats in the simulation, no wall clock, no host
RNG — `random` draws from the language's own seeded generator (§Randomness) —
and one rounding rule — floor, which is what an arithmetic shift does on a
6502 or a Z80 — applied everywhere.

### 2. Compile to a `Program`, then compile the `Program` to machine code

The front end emits a `Program`: resolved tables of scenes, objects, controls and
rules, with every constant folded to fixed point. That much has not changed, and
it is still where the language stops and the machine begins — the `Program` names
no register and no opcode.

**A backend then compiles that `Program` to native code for the target.** This
reverses an earlier decision in this document, which said the `Program` *was* the
deliverable and each console got a small fixed engine to interpret it. The
argument for the fixed engine was N + M work instead of N × M, and it was
correct about effort. It was wrong about the machine.

Three things went wrong in practice, and all three are structural rather than
matters of tuning:

1. **It was too slow to be the thing it claimed to be.** The interpreter had to
   fetch a rule record, dispatch on its trigger, walk an expression tree through
   a stack evaluator and address every property through a pointer — for every
   rule, every object, every tick. Pong needed about three Game Boy frames per
   game tick, so the preview ran at 60 Hz and the cartridge ran at 20. A runtime
   that plays the game slower than the specification does is not a conformance
   implementation of it; it is a second, disagreeing one.
2. **Nothing could be left out.** A fixed engine ships every feature because it
   cannot know which ones a game uses: the divider, the multiplier, the seeded
   generator, the tile collision path, the camera. On a 32 KiB cartridge that is
   not an abstraction cost, it is the budget.
3. **The N + M saving did not appear.** Adding levels and a camera to the engine
   meant new opcodes, new table records, and a format contract restated in an
   assembly file — the same work as a code path, minus the ability to specialise
   it.

Compiling gets all three back at once, because at build time the compiler knows
things the interpreter never can. Entities live at *constant* addresses, so a
property access is a direct load. Rule loops are unrolled over the objects that
can actually match. Comparisons lower to branches instead of producing a value.
Constants fold. And a helper routine reaches the ROM only if something asked for
it while emitting — a game that never divides ships no divider, which is
reachability, not a pruning pass that might miss something.

Measured on the example library, in Game Boy frames per game tick, running each
game with input held so the camera scrolls and rules fire: one frame means the
game keeps up with the hardware, and the interpreter never did.

| | interpreter | compiler |
|---|---|---|
| pong | 3 | 1.01 |
| breakout | | 1.00 |
| platformer | | 1.00 |
| dodger | | 1.00 |
| shooter | 11 | 1.00 |
| caves | *would not build* | 1.03 |
| runner | *would not build* | 1.00 |

The interpreter's figures spanned 3 to 11 frames across the five games it could
build — roughly 20 Hz at best and 5 Hz at worst — and only its extremes were
recorded before it was removed, hence the gaps in that column.

The N × M cost is real and is paid deliberately: a new console family is a new
backend. What the design keeps from the earlier decision is the part that was
load-bearing — the `Program` is still the boundary, so the language, the
diagnostics and the reference interpreter are shared by every backend, and a
backend is the only thing that knows an opcode.

The assembler is ours and written in TypeScript
(`packages/demotic/src/codegen/asm.ts`), so "compile to machine code" costs a
browser nothing: the page builds the same cartridge the CLI does, with no
toolchain installed (doc 07 §parity, doc 13 §D5).

### 3. Two unit systems, because balance is not size

One unit is one 8×8 cell. Cells are the substrate: they are what an unsuffixed
number means, what sizes quantise to, and what the simulation actually runs in.
They are the right default because tiles and sprites are already cell-sized, so
nothing needs re-quantising per console.

But cells alone cannot express **balance**, and an early version of this document
was wrong to imply they could. A 3-cell paddle covers 15% of a Game Boy wall and
7.5% of a Mega Drive one; a ball at 8 cells per second crosses a Game Boy court
in 2.2 seconds and a Mega Drive court in 3.5. Same rules, different game — easier
and slower on the bigger machine. That is a real defect, not a defensible trade.

So a numeric literal may carry a **relative unit**, resolved against the target's
playfield at compile time. One unit is one percent, as in CSS:

| Unit | Resolves against |
|---|---|
| `cell` / `cells` | nothing — absolute, and the default |
| `vw` | playfield width |
| `vh` | playfield height |
| `vmin` | the shorter side |
| `vmax` | the longer side |

```
create object ball   (width 1 cell,  height 1 cell, speed 40vmin)
create object paddle (width 15vw,    height 1 cell, speed 60vw)
```

Mix them per property, which is the point: a ball is one cell everywhere because
one cell is the smallest thing that can be drawn, but it crosses the court in the
same 2.5 seconds on every console. A paddle is one cell tall and 15% of the wall
wide.

| | GB / GG | SMS | NES / SNES | MD |
|---|---|---|---|---|
| Playfield | 20×18 | 32×24 | 32×28 | 40×28 |
| Paddle width | 3 | 5 | 5 | 6 |
| Wall covered | 15.0% | 15.6% | 15.6% | 15.0% |
| Ball crosses in | 2.50s | 2.50s | 2.50s | 2.50s |
| Paddle traverses in | 1.67s | 1.67s | 1.67s | 1.67s |

Two rules keep this honest:

- **Sizes quantise to whole cells**, minimum one, rounded half up. A collision box
  is also a sprite's footprint, and hardware sprites come in whole 8×8 units — a
  4.8-cell box corresponds to nothing that can be drawn. Speeds and positions do
  not quantise; they stay fixed-point.
- **Use `vmin` for anything that must stay square.** The targets do not share an
  aspect ratio, so `width 5vw, height 5vh` is square on none of them consistently.
  The compiler warns on exactly that pairing.
- **And a rate a *rule* applies is divided by `fps`, because only `speed` is
  resolved for you.** A `speed` is cells per second and step 4 of the tick turns
  it into a displacement; a rule that adds to a property runs once a tick and
  nothing scales what it adds. So gravity written as
  `ydirection as ydirection + 0.04` is an acceleration per *tick*, which is half
  again as strong on a console that ticks 75.47 times a second as on one that
  ticks 60 — the caves' hero jumped five cells everywhere and four on the
  WonderSwan, and the top of its cavern was out of reach on that console alone.
  `2.4 / fps` says the same thing per second, folds at compile time, and is the
  identical constant wherever `fps` is 60.

None of this compromises the central split: `vw` is relative to an abstract
playfield, not to a named console, so a `.dmt` file still knows nothing about
hardware. What it now knows is the difference between *being one tile* and
*covering a sixth of the wall* — which was always a property of the game, and had
no way to be said.

Two further consequences of authoring in cells, unchanged:

- `screenwidth`/`screenheight` mean the **overscan-safe** area, from the
  `ConsoleSpec`'s `overscanSafe` rect. The raw NES frame is 30 cells tall but only
  28 are reliably visible, so something at raw `screenheight - 1` sits in
  overscan. `rawscreenwidth`/`rawscreenheight` remain for callers who know.
  A backdrop is demade at that same safe area rather than at the raw frame, so a
  picture's edges are the edges the game's rules talk about; the rows past it are
  drawn with a repeat of the last one, because a television would have cropped
  them and black would not be an improvement.
- Speeds are per *second*, divided by the frame rate at compile time, so a 50 Hz
  build plays at the same speed as a 60 Hz one rather than 5/6 as fast.

## Language reference

Case-insensitive throughout — keywords and identifiers alike. `--` begins a
comment to end of line, and **must be preceded by a space or start the line**:
`--` is also two minus signs, so `y--1` would otherwise be a comment where the
author meant `y - -1`, silently discarding the rest of the statement rather than
failing. **One statement per line, no nesting.** Declaration order is irrelevant:
`loop play` may precede `scene play`, and an instance may name a class declared
later.

**Order-free is about resolution, not about sequence**, and the distinction is
worth stating because a tool that reordered lines would get it wrong. Nothing has
to be declared before it is named — but the order `create` statements appear in
*is* the order entities exist in: an instance's id is its position
(`compile.ts`), which decides what is drawn over what, which sprite the hardware
drops first past its per-scanline budget, and the order entities appear in a
trace. Effects are indexed in first-mention order for the same reason. So moving
a `create` line is an edit under doc 09's stability rule, not a tidy-up, and
[doc 19](19-projects.md) §Dragging is an edit is where that lands on a UI.

Flatness is not stylistic. It buys total error recovery: a malformed statement
fails on its own line and every other statement still parses, so one pass reports
*every* problem in the file. That is the property that makes the language pleasant
to generate and patch programmatically.

**A declaration says as little as possible; the compiler does the work.** That is
the through-line of every decision in this document, and it is worth naming
because it is what the language trades away ceremony *for*. `width 1 cell` does
not say how many pixels, because the console does. `sprite ball` does not say
which file, because exactly one of the project's art files is called that
([doc 19](19-projects.md) §The rule) — and where two are, the compiler says so
with a line number instead of picking. `music theme` names no channel, no
register and no chip. Nothing in a `.dmt` is written twice, and nothing is written
that something downstream can work out; where that is genuinely impossible the
answer is a diagnostic naming the choice, never a guess and never a required
ceremony imposed on every other line to pre-empt a case that usually does not
arise.

### Statements

```
start <scene>                                  -- entry point; exactly one per program
seed <n>                                       -- the game's random source; optional
scene <name>                                   -- declare a scene
level <name> [in <scene>] from <file.dmtl>     -- a hand-drawn playfield
stream <name> [in <scene>] from <f>, <f>, … <n> wide|tall
camera follows <object> [in <scene>]
music <file> [in <scene>]                      -- a demade track, while the scene runs
sound <file> on <trigger> [in <scene>] [if <expr>]  -- a demade effect, on a rule's trigger
create object <class> ( <props> )              -- class definition with defaults
create <class> <name> [in <scene>] ( <props> ) -- instance, overriding class defaults
control <object> <button> ( <assigns> ) on hold|press|release
when <trigger> [in <scene>] [if <expr>] then <assigns> [else <assigns>]
```

`then` separates the condition from the consequence. It costs a word and buys a
seam that long rules badly need — without it the trigger and the assignment list
run together with nothing but a bracket between them. Brackets are optional
around a single `name as value`, so the common case reads
`then xdirection as flip`, and stay required for the `(name value)` pair form
where they mark one pair from the next.

`if` guards a trigger with a condition, evaluated at the instant the trigger
fires: `when a pressed if shot.visible = 0` is how firing reloads rather than
restarts. `else` runs when the rule was evaluated and did not fire, so it is
allowed on level triggers and on any guarded rule — and rejected on a bare edge
trigger, where "did not fire" would mean every other tick of the game.

Argument lists accept two shapes:

```
(height 1, width 2)              -- named pairs (canonical)
(height, width) as (1, 2)        -- positional, SQL INSERT style
```

The named form is canonical. The positional form is SQL's most-edited-wrongly
construct — insert a column, forget a value, silent shift — so the compiler checks
arity and says so, but the named form cannot drift at all. `demake fmt` rewrites
multi-field positional lists into named pairs.

An identifier followed by `,` or `)` is a bare column name; anything else starts a
`name <expression>` pair. That single lookahead is what makes `(xdirection -1)`
unambiguously "set `xdirection` to `-1`", never the expression `xdirection - 1`.

### Properties

| Property | Meaning | Default |
|---|---|---|
| `x`, `y` | Top-left position, in cells | 0 |
| `width`, `height` | **Collision box**, in cells — not sprite size (doc 15) | 1 |
| `speed` | Magnitude, in cells per second | 0 |
| `xdirection`, `ydirection` | Per-axis multiplier, −1…1 | 0 |
| `direction` | Compass shorthand setting both axes | — |
| `sprite` | Asset name; bound to real art by the Demakefile | — |
| `text` | Literal text, for `text` objects | — |
| `value` | Number held by a `number` object | 0 |
| `visible` | Drawn **and collidable** when non-zero | 1 |

Read-only derived properties: `centerx`, `centery`, `left`, `right`, `top`,
`bottom`. Assigning one is an error naming the property to assign instead.

Any numeric literal may carry a unit — `15vw`, `40vmin`, `3 cells` — attached or
spaced, per §3.

Builtins are `abs(x)`, `min(a, b)`, `max(a, b)` and `clamp(x, lo, hi)`. The set is
deliberately tiny and every member is exactly representable in integer
arithmetic, because each one has to be reimplementable in a page of 6502
(§Runtime model). Nothing transcendental will ever join them.

`always` and `never` are constants (1 and 0). `when always` is how a rule says
*every tick* — a continuous assignment rather than a conditional one, which is
what proportional control needs.

Compass names are `north south east west northeast northwest southeast southwest`,
with screen coordinates growing downward. Diagonals are deliberately **not**
normalised: `speed` applies per axis, so a northwest heading travels at `speed` on
both. Normalising needs a square root; the simulation stays in exact integers
instead. Stated, not hidden.

Two builtin classes render from the background layer rather than as sprites, and so
cost no sprite budget: `number` (renders `value`) and `text` (renders `text`).

**`visible 0` makes an object inert**: not drawn, not collided with, and not
moved. That is how a thing leaves play — a broken brick, a spent bullet — and it
is why there is no `destroy`. The pairing is deliberate: an object you cannot see
but can still hit is a bug in every game that has ever shipped one. The two
genuine exceptions, trigger zones and invisible walls, want a separate property
rather than a split in this one.

### Rule triggers

| Form | Timing |
|---|---|
| `when <a> hits <b>, <c>` | edge — on contact, not per tick of contact |
| `when <a> touches <b>, <c>` | level — every tick they overlap |
| `when <button> pressed \| released` | edge |
| `when <expr> reaches <expr>` | edge — when the value crosses or lands on the target |
| `when <class>.<prop> <op> <expr>` | level — once per object of that class |
| `when <expr>` | level — every tick it holds |

**`hits` and `touches` are both needed and neither substitutes for the other.** A
bounce must happen once per contact, or it inverts every tick and the object
buzzes. Resting contact must be re-asserted every tick, or the state that contact
suppresses runs away unseen: a hero standing on a ledge under `hits` keeps
accumulating gravity into `ydirection` while the separation holds it in place, so
it looks correct and then fights the next jump. Sitting on something is not an
event.

**A level rule naming a class runs once per object of it**, with that object
bound as the subject, exactly as a `hits` rule binds the thing that collided. So
`when rock.y >= screenheight then y as 0` recycles every rock, and `y` means
*this* rock's. Naming two classes has no single subject to pick and is an error
rather than a guess.

**`reaches` is a crossing detector, not a threshold.** "reaches 10" on a rising
score and "reaches 0" on falling lives have to mean the same thing, and a `>=`
test cannot express both — three lives are already past zero, so the rule would
fire on the first tick of the game. It fires when the value lands exactly on the
target or crosses it from either side, and a value that *starts* on its target
has not reached it.

The level form is what makes an opponent one ordinary rule rather than a special
"AI" feature — and the shape of that rule matters more than it looks:

```
when always in play (paddle2.xdirection) as clamp((ball1.centerx - paddle2.centerx) / 1.5vw, -1, 1)
```

That is **proportional** control, and it is the third thing tried. On/off steering
(`> ball` → -1, `< ball` → 1) overshoots by one tick of travel every tick and
reverses forever: visible jitter, the first thing anyone notices. Adding a dead
zone wide enough to stop that trades jitter for lurching — the paddle sits still,
then jumps, then sits still. Proportional steering does neither: far away the
clamp saturates and it runs flat out, and as it arrives the number shrinks and it
eases in and stops exactly on target. Measured over 600 ticks, stop/start events
fall from 64 to 2 on a Game Boy and 91 to 1 on a Mega Drive.

The gain is written in `vw` because the speed is: a paddle at `60vw` per second
covers `1vw` per tick, so dividing the error by `1.5vw` measures it in ticks of
the paddle's own travel and the feel ports unchanged to every console.

In a `hits` rule, bare class names bind to the two colliding instances, and an
unqualified property targets the subject. Within one rule every value is evaluated
against the pre-rule state and written together, so
`(ydirection, xdirection) as (flip, …)` sees consistent inputs. `flip` negates the
target's current value.

Collision separation is physics, not an event: contact fires the rule once on
entry, but the overlap is resolved every tick it persists — re-tested after the
rule runs, so a rule that teleports its subject (a ball reset to the middle after a
point) is not dragged back to the wall it just left.

### Buttons

`left right up down a b start` — the portable set, floored by the Game Boy and the
NES.

`start` is the one entry that is not portable in practice: the Master System has no
Start button, and pause is a console-mounted switch wired to the NMI line. The
compiler warns rather than failing, because the mapping is legitimate; it just is
not a face button. Simultaneous opposing input resolves last-pressed-wins, which
falls out of `on hold` keeping a snapshot per binding rather than per property.

### Levels, tiles and the camera

A scene's **playfield** is its level's size, or the screen's if it has none. That
one sentence is the whole of scrolling, and everything else follows from it:

- `screenleft`, `screenright`, `screentop`, `screenbottom` mean the *playfield's*
  edges. A hero running right stops at the end of the level, not at an invisible
  wall a screen-width in. The names keep their reading — "the edge of the
  playfield" — and what the playfield is has grown.
- **Object positions are level coordinates.** The camera decides what is on
  screen, so no rule ever has to know where the view is. That is the only reason
  scrolling does not infect every rule in the game.
- A game with no level is unchanged in every respect, because its playfield is
  still exactly the screen it always was.

Levels live in their own file, `.dmtl`, and are a legend followed by a grid drawn
in characters:

```
tile #  wall    solid  brick.svg
tile ^  spikes         spikes.svg
tile o  coin           coin.svg

map
##########################
#   o        ===       o #
#        ^^^^            #
##########################
```

The grid *is* the level, literally, and that is the entire argument for the
format. A model can read it, reason about it and edit it in place because the
shape in the file is the shape on screen; an array of tile indices is the
opposite — unreadable, and something editing one miscounts a column and silently
moves a wall. Two consequences follow from taking that seriously: **one row per
line, however long** (a hundred-cell level makes a hundred-character line), and
**no comments inside the grid** — `--` is a comment in the legend, but past `map`
every character is a cell and `-` is a perfectly good tile. The legend takes the
same space-before rule the language does, so `brick--old.svg` stays one filename.
A blank line inside the grid is a row of empty cells, not a separator.

**Tiles are named, and the names are what rules collide with.**
`when player touches spikes then scene as gameover` reads as a sentence precisely
because the legend supplied the noun. Tiles then behave exactly like objects, on
the same two conditions:

- something happens only where a rule named the pair, so a tile no rule mentions
  is scenery and nothing more;
- separation happens only where the tile is `solid`, which is the tile equivalent
  of the split `visible` makes for objects.

So a `coin` tile scores without blocking and a `wall solid` tile blocks whether or
not anything fired. One model, not two.

`camera follows <object>` centres the view on an object and clamps it inside the
playfield. The clamp is load-bearing twice: it stops the view running off the end
of a level, and it means a level no bigger than the screen never scrolls at all —
so a non-scrolling game needs no special case anywhere. `camera.x` and `camera.y`
are readable in expressions, which is how a HUD stays on screen while the world
under it moves:

```
when always in play then (score.x, score.y) as (camera.x + 1, camera.y + 1)
```

A rule reading the camera sees where the view was when the tick began, so a HUD
trails by one tick while the world is moving and lands on the view the moment it
stops. Invisible in play, and worth knowing before reading a trace.

### Backgrounds that are pictures: `backdrop`

A scene's background layer is either a playfield or a picture. `backdrop` names
the picture:

```
scene title
backdrop pong.title.svg
```

It is scenery and nothing else — nothing collides with it, no rule reads it, and
it has no cells to name — so it is the one statement in the language whose entire
effect is on the screen. A scene may have a level or a backdrop and not both,
because both are the same hardware layer, and the compiler says which one to drop
rather than picking.

What makes it worth having is *where the pixels come from*. The file goes through
the **image pipeline** — `prep`, at the console's own screen size, with the same
fitter a photograph gets — and comes back as deduplicated tiles plus a tilemap.
That is not a second art path bolted onto the game backend; it is the demaker
this whole tool is about, pointed at a title screen. A game's first screen is
therefore full-bleed artwork demade by the same code as everything else, and the
proof is that it costs a game nothing at run time: the background layer draws a
tilemap for free.

What it costs is **tiles**, and a console has a fixed number of them shared
between backgrounds and objects. A picture is as expensive as it is *varied*:
flat areas and repeated motifs collapse to one tile each, and detail that does
not land on the cell grid does not. Backdrops are pooled against the whole bank,
so a cell already drawn by the font, by a sprite, or by another scene's picture
is pointed at rather than stored twice. When the total still does not fit, the
build stops and names the number — a title screen with holes in it is not a
smaller title screen, it is a bug.

Two things follow for anyone drawing one, and both are properties of the
hardware rather than of taste:

- **Author well above the smallest screen.** A backdrop is fitted to the console
  being built for, and those screens differ by four times in area — 160×144 on a
  Game Boy against 320×224 on a Mega Drive. Art whose smallest feature is one
  Game Boy pixel gives the bigger machine nothing to resolve. The example
  library's screens are drawn on a 640×576 canvas with detail down to a quarter
  of a Game Boy pixel for exactly this reason.
- **Keep the playfield at the ends of the ramp.** An object's colour 0 is
  transparency, so the object palette is the three *darkest* shades (doc 15
  §The conversion path). A background in the middle of the ramp is a background
  objects vanish into; sky should be the lightest shade and space the darkest.
  For the same reason a scene that draws its HUD on the background layer needs a
  lit band where the counters go — the font's ink is the darkest shade, and a
  status bar is what that constraint looks like when you take it seriously.

#### Colour, on the machine that has it

A `gbc` build demakes the same art through the image engine's **RGB-lattice**
path instead of its mono one, and everything that follows is the hardware's
shape rather than a second set of decisions: a background cell names one of
eight four-colour palettes, an object names one of eight more, and both live in
an attribute the renderer writes alongside the tile. The interesting choice is
not "which colours" but **which assets share a palette** — the constrained
assignment `prep` already solves for an image's attribute cells, with an asset
in place of a cell, because the hardware names one palette per object and a
sprite whose halves want different colours has to pay for it somewhere.

Two consequences are worth knowing before drawing for it:

- **One palette of each kind is reserved for the font.** A picture's fit is free
  to spend all four colours of a palette on sky; a caption borrowing one would
  come out sky on sky. So the art gets seven and the HUD gets the eighth, which
  is a plain white-through-black ramp — the same thing the monochrome build
  shows, so the two read as one game.
- **Colour costs cartridge, the way audio does.** Every background cell carries
  an attribute byte, so a demade backdrop is 360 bytes of tile map *and* 360 of
  attributes; the palettes are uploaded per scene; and colour art deduplicates
  less than monochrome art, because two cells that differ only in tone are one
  tile on a Game Boy and two here. That is around a kilobyte for a game with two
  backdrops, out of 32. The build reports what is left, and a game that no longer
  fits is an error naming the number rather than a picture with holes in it. The
  second VRAM bank is what makes it affordable at all: 512 tiles rather than 256.

### Sound: `music` and `sound`

Audio arrives the way art does, and the split is the same one: `music` names a
track a scene plays, `sound` names an effect an event fires, and both files go
through the **demakers this tool is about** — the same `arrange` and `sfx`
pipelines the CLI exposes — rather than through anything the game backend knows
about notes.

```
scene play
music rally.mid in play
sound bounce.wav on ball hits paddle
sound point.wav on ball hits screentop, screenbottom
```

**Music belongs to a scene.** Entering the scene starts its track from the top
and leaving stops it, so a title screen is quiet under a game that has a theme
and a game-over screen does not inherit the one the player just lost to. A scene
has one track, for the reason it has one background.

**An effect fires on a rule's trigger.** Not a new trigger vocabulary — `when`'s,
exactly: a collision, a button edge, a value being reached, a condition holding,
narrowed by `in` and guarded by `if` in the same words. What a `sound` does not
have is `then`, and that is the whole reason it is a statement rather than
something a rule could assign: playing a sound is not a property of anything, and
a rule that could both move an object and make a noise would need `then` to mean
two things.

A `sound` whose trigger is *exactly* a rule the program already has rides that
rule instead of becoming a second one — same trigger, same scene, same guard,
same tick. That is worth knowing rather than tidy: a collision trigger is the
expensive kind, and the natural way to write this

```
when shot hits alien then (alien.visible, shot.visible, score.value) as (0, 0, score.value + 1)
sound boom.wav on shot hits alien
```

costs four and a half kilobytes of cartridge unmerged — a second pass over every
shot-and-alien pair — and thirty bytes merged.

Two hardware facts leak through, and it is better that they do:

- **A `touches` trigger fires every tick of the contact**, so a one-shot effect
  hung on one restarts every tick and stutters. Bounces and pickups want `hits`.
- **Effects share the chip with the music.** One effect plays at a time; the
  louder one wins when two collide (the sound demaker measures that, doc 18
  §Placement); and the channel it borrows goes silent for a moment and then
  belongs to the music again. Doc 16 §Two streams, one clock has the mechanism.

What audio costs is **cartridge**, the way a backdrop costs tiles. A track is a
few kilobytes of register schedule and an effect a few hundred bytes, on a
machine with 32 KiB and no mapper — which is why the shooter's theme is two bars
where the platformer's is eight, and why the build reports both numbers. The
budget is per console and one example runs out of it: the shooter's NES cartridge
cannot hold its music, and `demake build -c nes` says so rather than dropping it
(doc 13 §D4).

Audio also joins the **trace** (§Conformance): a trace line carries
`audio=<track>,<effect>` — the track the running scene asks for, and the effect a
rule asked for on this tick. It records what the *game* asked for, not what the
chip did, for the same reason the trace has never carried sprite priority: which
channel an effect got is the hardware's business, but *when* a sound fires is the
game's, and two implementations that could disagree about it would be two games.

### Composed levels: `stream`

An endless scroller is not an endless level. It is a short vocabulary of
hand-made pieces played in an order nobody wrote down — Flappy Bird has one chunk
with a gap in it, 1942 a handful of formations. `stream` says exactly that:

```
seed 20260725
stream course from open.dmtl, lowpipe.dmtl, highpipe.dmtl, pipemid.dmtl 24 wide
```

Twenty-four chunks are drawn at random from the four and laid side by side, and
the result is an ordinary level. Three things follow from composing at **compile
time**, and all three are why it is done that way:

- the simulator, the collision model and the camera need no notion of streaming;
- a console runtime needs none either — the composed tilemap is data in the ROM,
  not a generator the SM83 has to run identically;
- the course is fixed for a given seed, so a trace is still a trace.

"Endless" therefore means "long enough, and different every seed", which is what
the era's own scrollers did. The axis is stated rather than inferred, because a
stack of square chunks is ambiguous and `24 wide` says which way the game scrolls
without the reader measuring anything. Chunks share one legend and must agree on
the dimension they are not laid along; both are compile errors.

A vocabulary can have properties a game relies on — the runner example's chunks
all leave rows 11 to 17 clear, so however the stream orders them there is a way
through. That is a good reason to hand-draw the pieces and generate only their
order.

### Randomness

`random(low, high)` draws a whole number from the game's generator, seeded by
`seed <n>` and defaulting to 1. The generator is *specified*, not borrowed: a host
`Math.random` would make every run a different game and take the trace oracle with
it, since two implementations could not be compared at all. It is a 32-bit LCG,
chosen because a console runtime has to reproduce it bit-for-bit and that is a
multiply and an add.

The seed lives in the game, never in the Demakefile — a different seed is a
different game, and the build file may not change how a game plays (doc 15).
Drawing advances the generator, so *when* a draw happens is part of the game's
behaviour: `random` cannot set an initial property value (that would be drawn once
at build time and be the same every play), and a `.test.dmt` assertion may not
call it, because asserting would change the run.

### Type-directed resolution

Two resolutions remove all quoting ceremony:

- `sprite ball.svg` — the lexer sees a dotted name; because `sprite` is asset-typed,
  the compiler reads it as the literal string.
- `(scene) as gameover` — a bare name; because the `scene` target is scene-typed, it
  resolves to a scene rather than an expression.

Asset-typed is also what makes the *file* half of it short. Because the statement
says which kind of file it wants, the extension carries no information the
compiler needs — so `sprite ball` is legal, and so is `music theme`. **A reference
is the shortest name that identifies one file**: a bare stem where that is enough,
a name with its extension where two art files share a stem, and as much leading
path as it takes where two directories hold the same name. Two files answering to
the same reference is `E_ASSET_AMBIGUOUS`, naming both and the strings that
separate them; one file answering is the file; none is the missing-asset path,
which reports and falls back rather than refusing to build. Given no list of the
project's files — a `.dmt` on stdin, or one compiled on its own — a reference is
simply itself and nothing is ambiguous. [Doc 19](19-projects.md) §The rule has the
matching rules and the reasoning.

## The example library

Pong was never enough evidence: two movers, one collision shape, no removal. The
examples in `packages/demotic/fixtures/games/` exist to pin down what a console
runtime actually has to implement, and each is there for something the others do
not do.

| Example | Exercises |
|---|---|
| `pong` | two movers, a bounce angle, proportional opponent steering |
| `breakout` | a grid of one class, removal via `visible`, sprite-budget pressure |
| `platformer` | gravity as a level rule, an impulse jump, resting contact |
| `dodger` | many objects at staggered speeds, recycled rather than removed |
| `shooter` | the per-scanline sprite limit's worst case, a fast projectile |
| `caves` | a hand-drawn level bigger than the screen, tiles, a scrolling camera |
| `runner` | a course composed from chunks at build time, and the seeded generator |

All eight compile for all eleven consoles, stay inside every sprite budget, and
pass their own `.test.dmt` suites on every one — run in the unit suite, from the
CLI, and in the browser.

**They are also the shop window, so they are written to be read at a glance.**
The web app shows a game's source beside the cartridge it built, and the claim
being made there is that a whole game is sixty lines. An example whose commentary
outweighs its code argues the opposite, however good the commentary is: a reader
skimming Pong should see five statements that declare a court and eight rules
that play it. So a comment earns its place only where the line above it cannot be
read without one — tick order, an absolute unit chosen over a relative one, why a
rule is `touches` and not `hits` — and the rationale that used to sit in the
fixtures lives in this document and in `AGENTS.md`, where it can be longer and is
read by the people it is for. Section rules are kept short enough not to wrap in
the page's editor.

Writing them changed the language, which is the point of writing them before the
runtime rather than after: `touches` and the `reaches` crossing rule both come
from here, and `visible` gained its collision meaning here too.

### What they also found, and did not fix

Named because a runtime built to the current language will hit exactly these:

- ~~**No background layer.**~~ Fixed by `level`: scenery is tiles, and a
  full-width floor costs no sprites at all. What the tile layer still cannot do
  is *change* — a collected coin drawn as a tile stays drawn, because tiles have
  no `visible`. A game that wants a thing to vanish uses an object for it, as the
  platformer does, and `caves` says so in a comment rather than pretending.
- **A level rule cannot address a class.** `when <a> hits <b>` binds the objects
  that collided, so a rule can drive every alien at once; `when always
  (alien.xdirection)` has no subject to bind and is rejected. Driving a whole
  class from a condition is not expressible.
- **An input edge cannot be conditioned on state.** "fire whichever bullet is
  parked" needs `when a pressed and s1.visible = 0`, and a `control` binding
  carries no condition. The shooter reuses a single shot because of it.

## Testing a game: `.test.dmt`

Assertions about a game, written in the same expression language as the game, run
against every console.

```
test the ball serves down and to the left
press a
play 1 second
expect ball1.y > centery
expect ball1.x < centerx

test the player paddle reaches the left wall and stops there
press a
hold left for 5 seconds
expect paddle1.x = 0
expect paddle1.xdirection = 0

test a still player concedes a point and the ball returns to the middle
press a
play 1.33 seconds
expect score2.value = 1
expect abs(ball1.y - centery) < 15vh
```

Statements are `test <name>`, `play <n> seconds`, `press <button>`,
`hold <button> for <n> seconds`, `expect <expression>` and `expect scene <name>`.
Same shape as the language: one per line, no nesting, `--` comments, per-line
error recovery. A `test` line opens a case and every line after it belongs to
that case; each case gets a fresh simulator, so none can leak into another.

**A duration is written in seconds, and that is the same rule one layer up.** A
`speed` is cells per *second* because dividing by the frame rate at compile time
is what makes a 50 Hz build play at the same speed as a 60 Hz one (§3); a script
says `play 4 seconds` for the same reason, and the runner resolves it against the
console's `fps`. `ticks` is still a unit — a step that means "one more tick"
should say so, and the example suites use it for the two- and eight-tick waits
that give a rule an edge to fire on — but anything that means *an amount of
elapsed game* is a duration and belongs in seconds.

This was portable by accident until it wasn't. Every console in the set ticked
sixty times a second, so a tick count was a duration in disguise and nothing
noticed; the WonderSwan Color runs at 75.47 Hz, and `hold right for 42 ticks`
covers three quarters of the ground there that it covers on a Game Boy. The
suites now say what they mean, and the conversion changed no console's behaviour
— two decimal places of seconds round-trips to the same tick count at sixty.

**The relative vocabulary is what makes one suite cover every console.** `centery`
is 9 on a Game Boy and 14 on a Mega Drive; `15vh` is 2.7 cells and 4.2. An
assertion written in cells would have to be written once per console and would
drift. Written this way it is a single line that means the same thing everywhere,
which is exactly how a *balance* regression — as opposed to a mechanical one —
becomes visible at all.

A failure reports both sides in cells, because "expected `ball1.y > centery`"
alone tells you nothing you did not already know:

```
FAIL line 38: ball1.y = centery  [5.0396 = 9.0000]
```

## Diagnostics: catching hardware traps at compile time

The cell-and-tick model makes a particular class of mistake easy to write and
hard to see. Each of these is knowable from the numbers, so the compiler says so
rather than leaving it to be found in an emulator.

| Code | Catches |
|---|---|
| `E_SPRITE_BUDGET` | a scene needing more hardware sprites than the console has |
| `W_SPRITE_BUDGET` | a scene past three quarters of that budget |
| `E_OBJECT_TOO_WIDE` / `E_OBJECT_TOO_TALL` | an object larger than the playfield |
| `W_OFFSCREEN_START` | an object whose initial position is partly outside it |
| `W_TUNNELLING` | a mover whose per-tick step exceeds the thickness of what it collides with — collision is tested at tick boundaries, so it will pass straight through |
| `W_SUBTICK_SPEED` | a speed whose per-tick step floors to zero, leaving the object frozen |
| `W_SIZE_ROUNDING` | a relative size the cell grid moved by more than a quarter |
| `W_ASPECT_MISMATCH` | width and height sized against different screen axes, which cannot stay square |
| `W_TEXT_TOO_WIDE` | text running past the edge on a narrow playfield |
| `W_START_MAPPING` | `start` on hardware with no Start button |
| `E_LEVEL_TOO_SMALL` | a level smaller than the screen on some console, leaving part of the view empty |
| `E_LEVEL_SYNTAX` / `E_LEVEL_NO_MAP` / `E_UNKNOWN_TILE` / `E_DUPLICATE_TILE` | a malformed `.dmtl` |
| `E_DUPLICATE_LEVEL` | two playfields in one scene |
| `E_STREAM_MISMATCH` | stream chunks disagreeing on the dimension they are not laid along |
| `E_STREAM_LEGEND` | stream chunks giving one character two meanings |

Every one is per-console, because every one of these is a property of the target
rather than of the source: a 30-cell wall is fine on a NES and impossible on a
Game Boy, and the same file is asked about both.

The dynamic counterpart is the per-scanline sprite count, which depends on where
things are and so is watched by the simulator as it runs (§Budgets).

### The readings the language will not guess between

A second family, console-independent, and with a different justification. Each
of these *parses* — under the obvious reading it produces a perfectly good
program, just not the one that was written down. There is no emulator run that
would reveal them as syntax, only a game that plays wrong, so the compiler
refuses the ambiguity instead of resolving it.

| Code | Catches |
|---|---|
| `E_GLUED_COMMENT` | `--` run onto the token before it: `y as y--1` is `y as y`, and the rest of the line is gone |
| `E_UNTERMINATED_STRING` | a string with no closing quote, which swallows the line and gets a bracket blamed for it |
| `E_UNKNOWN_UNIT` | a word attached to a number that is not a unit — `40vmn` is a misspelling, not two tokens |
| `E_DUPLICATE_PROP` | one list setting the same property twice, where the first value is written down and does nothing |
| `E_DUPLICATE_CONTROL` | two bindings writing one property from one button, whose `on hold` restores unwind into each other |
| `E_DUPLICATE_CAMERA` | two cameras in one scene, where the second silently wins |

The last three share a shape with `E_DUPLICATE_SCENE`, `E_DUPLICATE_INSTANCE`
and `E_DUPLICATE_LEVEL`: *two of a thing that should be one*, where a "last one
wins" rule would be easy to specify and impossible to see. Nothing in the
language resolves a conflict quietly.

## Runtime model

A build produces one thing per target: **machine code for the game**. The
compiler front end still emits a `Program` — resolved tables of scenes, objects,
controls and rules, console-specific only in that constants are folded — and a
backend then compiles that `Program` into code written for this game and no
other (§2).

Seven backends exist, in `packages/demotic/src/codegen/`: `gb` (SM83), `nes`
(6502, NROM), `sms` (Z80), `snes` (65816, LoROM), `md` (68000, Mega Drive), `gba`
(ARM) and `pce` (HuC6280, HuCard). Nothing about any of them is a table format,
so there is no format contract to keep in step with an assembly file.

**Seven backends, eleven consoles** — because a console is not always a machine.
The `gb` backend builds for three: a Game Boy, a Game Boy Color (the same
machine code with a second half bolted to the renderer, §Colour) and a Mega Duck
(the same machine code through that console's own I/O page). The `sms` backend
builds for two, a Master System and a Game Gear, and the `gba` backend for two
more: a Nintendo DS's 2D engine A *is* a Game Boy Advance's. A variant costs a
*machine description* — a register table, a permuted `LCDC`, an entry point, a
cartridge shape, a smaller window — and not one instruction, which is why the
whole example library traces identically on all eleven.

**And a backend is not always an instruction set of its own, either.** The `pce`
backend's CPU is the `nes` backend's with a memory mapper on it, so the two share
`codegen/mos/` — the 16.16 value layer, the expression compiler, the rule bodies,
the tile walk and step 6 of the tick — and what the seventh backend owns is a
renderer. The same rule applies one level down: if you find yourself copying a
*routine* between two backends on related processors, it belongs in the family's
directory. Before writing a backend, check whether
the console is a variant of one you have: if you find yourself copying an
emitter, it is.

**A backend is an implementation of an interface, not a file that resembles
another one.** `codegen/backend.ts` is the contract: a console answers six
questions — where its state goes, what it cannot compile, how its art and its
audio are demade, how many tiles it has, and how a plan becomes a cartridge — and
everything between those answers happens once, in code no console owns. That
includes both orders that matter: the build's, and the *tick's*, which is the
list below emitted by one function with a method per step. A backend supplies the
instructions for a step and has no say in the sequence, which is what turns "the
order is load-bearing" from a warning into a property.

What a program *means* is shared for the same reason (`codegen/shape.ts`):
whether a rule can fire in this scene, whether a caption can ever change, which
cells a tile rule may cache, what a tick of movement comes to, how far a camera
may travel, and the level tables themselves. Those answers have to be identical
on every console or the trace oracle would be comparing two different games.

The dividing line is exact, and it is what stops the sharing becoming a fake
common denominator: **anything that would emit an instruction stays in the
backend.** A machine with seven registers and one with three do not want the same
code, and pretending otherwise would make both worse. The 6502 backend is a third
smaller than the SM83 one for its arithmetic and a third larger for its
addressing, which is exactly what the two instruction sets are like. The 65816
backend is smaller than either, for one reason: its accumulator is *sixteen*
bits, so a 16.16 add is two `lda`/`adc`/`sta` triples rather than four, and its
index registers are sixteen bits too — which means a helper is handed an address
in `X` rather than through a pointer somebody had to write first. The 68000's
value layer is a quarter the size of the Z80's, because a 16.16 number is a
register on that machine and an `add.l` is one instruction — the same division of
labour, at the other end of the range.

**A build is an assembly, and the assembler is ours.** It is written in
TypeScript with no dependencies, so:

- the browser can build a ROM, which is what makes doc 13 §D5 possible at all;
- `demake build` needs no toolchain, on any machine;
- the CLI and the web emit identical bytes, which is doc 07's parity contract
  restated for games rather than images.

Two things fall out of compiling that an interpreter could not have:

- **Unused features leave no trace.** Helpers are *pulled*, never pushed: a
  routine is emitted only if something asked for it while generating code. A
  game with no division ships no divider; one that never calls `random` ships no
  generator. There is no list to prune, so nothing can be missed.
- **Work RAM is allocated per object**, not per worst case, and the camera and
  the generator's state simply do not exist in a game that has neither.

A conforming backend must implement, in this order, once per tick:

1. Resolve input edges (pressed / released since last tick).
2. Apply `control` bindings.
3. Apply level-triggered rules.
4. Integrate positions: `direction × speed ÷ fps`, floored, in that order.
5. Detect collisions, fire `hits` rules on entry, then separate.
6. Fire edge-triggered rules.
7. Apply any pending scene change, resetting the entered scene.

The order is load-bearing: a backend that reorders these diverges within seconds.

**A gap is a build error, never a silent difference.** If a backend cannot do
what a `.dmt` asks for, `unsupportedFeatures` names it and the build stops. A
cartridge that played a different game from the preview would make the trace
oracle report a divergence three layers from its cause. The `gb` list is empty
today — levels, tile collision, the camera and scrolling all compile.

**Speed is a published number, not a claim.** The web app shows measured Game
Boy frames per game tick rather than running the emulator fast enough to
disguise the cost, because a person writing a game needs to know what their
rules cost. Every example in the library is at 1.00–1.03 frames per tick, so a
game keeps up with the hardware; a rule set expensive enough to overrun a frame
will say so in that figure.

It is also what tells you *what to fix*. A dozen collectible objects in a level
four screens wide first arrived at 1.4 frames a tick, and the profile named the
reason twice: the game was doing per-object work for objects nobody could see,
and it was walking the grid under the hero once per tile rule to reach the same
answer each time. Culling what the view does not cover, and walking those cells
once, put it back at 1.03 — with the coins kept as objects, so that a collected
one is gone. The measurement decided which of the two to give up, and the answer
turned out to be neither.

Families map onto the existing codegen families (doc 06): `gb`, `nes`, `sms`
(SMS + GG), `md`, `snes`. Each is a backend module beside the `gb` one, and each
brings its own instruction encoder — which is the N × M cost §2 accepts
deliberately. What the second one showed is that the cost really is only the
encoder and the emitters: of the Game Boy backend's code, the RAM plan, the
program-shape decisions, the level tables, the constant pool, the pull-only
helper registry, the trace reader and the build's own sequence all turned out to
be the console's business in no way at all, and are now shared.

## Conformance

Two layers, both cheap, in the order that finds bugs fastest.

**1. State-trace equality.** Same input tape → identical fixed-point entity state
per tick. Values are emitted as raw 16.16 integers, never decimals: a decimal
rendering hides the one-bit disagreement that compounds into a visibly different
game a thousand ticks later. Golden traces are checked in per (console, region);
`packages/demotic/fixtures/pong.gb.trace` is the first. Proving a port is a `diff`,
not a judgement call.

This runs as a **unit test**, not an E2E: the runtime keeps its entity table at
fixed work-RAM addresses, and `@demake/dmg` — a Game Boy core of ours, ~1200
lines with no dependencies — boots the ROM and reads them. So the loop that
proves a runtime correct needs no toolchain and no emulator install, and it runs
on every machine that can run `pnpm test`. `packages/demotic/test/rom.test.ts`
does this for every game in the example library.

A game with sound carries an extra field, and an extra header line saying so.
`audio=<track>,<effect>` is the track the running scene asks for and the effect a
rule asked for on this tick, `-1` for neither — what the *game* requested, not
what the chip did (§Sound). A game with no `music` and no `sound` traces exactly
as it did before audio existed, so no golden trace of one was re-baselined for a
column of nothing.

```
# demotic trace v1 console=gb
# props=x,y,xdirection,ydirection,speed,value units=16.16
# audio=track,effect
1 play ball1=655360,589824,-65536,65536,524288,0 paddle1=655360,1114112,0,0,786432,0 audio=0,-1
```

The chip has its own conformance layer, one level below this one and sharper:
`packages/demotic/test/_audio-battery.ts` boots a cartridge and diffs every register
write the APU receives against the schedule the music demaker produced, tick for
tick (doc 16 §The proof, Level A). A trace proves the game is the same game; that
proves the sound is the same sound.

**2. Framebuffer equality.** The existing pixel-perfect emulator E2E (doc 10),
which by then tests only rendering, because the logic is already proven equal.

Closing this loop needs one addition to the emulator harness: feed a scripted input
tape, and dump the runtime's entity table each tick. See doc 10.

## Budgets

The most common way a game that previews fine breaks on hardware is the
per-scanline sprite limit — 8 on NES and SMS, 10 on Game Boy — past which sprites
simply do not draw. So it is reported, never discovered:

- **Statically**, per scene, against the console's total sprite count. Over budget
  is a compile error; three quarters is a warning.
- **Dynamically**, per scanline, by the simulator as it runs, and shaded red in the
  preview.

Sprite cost is deliberately pessimistic: an object `w` cells wide is charged
`ceil(w)` sprites on every scanline it covers, ignoring 8×16 sprite modes that
would halve it on some targets.

### Elastic cartridges

**A cartridge is as big as the game needs and no bigger.** Every console that
shipped its games on more than one board picks the smallest that holds the
program, and grows only when the game does:

| Console                  | Boards                    | What decides it                     |
| ------------------------ | ------------------------- | ----------------------------------- |
| Game Boy / Color / Duck  | 32 KiB                    | fixed — see below                   |
| NES                      | NROM-128, NROM-256        | the program's own length            |
| Master System / Game Gear| 32 KiB, 48 KiB            | whether the code reaches `$7FF0`    |
| Super Nintendo           | 64 KiB, 128 KiB           | whether there is a sound image      |
| Mega Drive               | 128 KiB … 4 MiB           | the program's own length            |
| Game Boy Advance         | 32 KiB steps              | the program's own length            |
| Nintendo DS              | 128 KiB … powers of two   | both binaries' length               |

Two of the rows are worth reading for what they say about the hardware.
**The Game Boy is the one console that cannot shrink or grow**, and that is the
header rather than a decision: the size field's smallest code *is* 32 KiB and
every code above it names a cartridge with a memory bank controller in it. And
**the NES's two boards differ only in where the program is assembled** — an
NROM-128's image is mapped at `$C000` and mirrored at `$8000`, so its vectors sit
at the top of its own sixteen kilobytes and everything else about the build is
unchanged.

Which boards exist is the *console's* answer and lives beside its header in
`core/src/asm/*-cart.ts`; a backend's job is to pick, and where picking the small
one means moving the code it emits the program a second time rather than patching
the first attempt. Never add a size the hardware did not ship — the point is a
game on the board a game that size shipped on, not the smallest file that boots.

`stats.cartridge` is what was written. `stats.free` is measured against the
**largest** board the console can build, always: it is the budget-regression
signal, and a headroom figure that jumped by sixteen kilobytes the moment a game
grew past a boundary would move in the wrong direction.

### When it does not fit, the music goes first

A game too big for the biggest board its console came on **loses its music and
its sound effects, and the build says so** (`stats.cut`, a `warning:` line in the
CLI, a note under the cartridge in the page). A track is a few kilobytes of
register schedule and the game around it is the game; a cartridge that plays
silently is something somebody can play, and a build error is not.

It is done by binding the audio again with no asset bytes at all, so what comes
out is exactly the cartridge a project with its music left out already produces —
the request bytes a rule writes are still there, so **the trace is unchanged**
(§Conformance) and the only difference is that nothing is listening. A game that
still does not fit is refused, and told that the music was already gone.

## Stability

The language's semantics are **output bytes**, and carry the same guarantees as
`prep` output (doc 09 §Stability):

- A change that alters any golden trace is a **minor** bump, and needs the traces
  re-baselined in the same PR, a changeset, and a release-note line.
- Patch releases never change a trace.
- Syntax additions that leave existing programs compiling identically are minor;
  removals wait for a major.
- The trace format is itself versioned in its header (`trace v1`).

## Known gaps

Named rather than hidden, in rough order of how much they matter.

- ~~**No console runtimes.**~~ The `gb`, `nes`, `sms`/`gg`, `snes` and `md`
  backends exist and their gap lists are empty of *language* features (§Runtime
  model): levels, tiles, the camera, scrolling, music and effects all compile on
  every one of them, and every one of them makes a noise.
- ~~**No deterministic art rasterisation.**~~ `@demake/core` has its own SVG
  rasteriser (doc 15 §The conversion path, step 2), so a `.dmt`'s art is demade
  by the image engine and appears in the cartridge. The subset is deliberate —
  shapes, paths, gradients, strokes — and what is *not* in it fails loudly by
  name: text, filters, clip paths, masks, elliptical arcs. Text and numbers in a
  game are drawn from a 5×7 font authored as ASCII in `rom/graphics.ts`, because
  a font is data and a kilobyte of hand-written `db` lines is not proofreadable.
- **One object palette for the whole build.** The hardware has two OBJ palette
  registers and the conversion uses one, chosen over every asset at once. A game
  wanting a pale sprite and a dark one to each get their own three shades cannot
  say so.
- **No `destroy` or runtime spawn.** Pong does not need them; Breakout and Snake
  do. The schema has room.
- ~~**No sound.**~~ `music` and `sound` are in the language (§Sound), the
  demakers of docs [16](16-audio-engine.md)–[18](18-sound-demaker.md) produce
  what a cartridge plays, and audio events are in the trace. What is still thin
  is *how much* of it: one effect plays at a time, an effect cannot be stopped
  once started, and there is no way to say "quieter here" — a track is as loud as
  the arranger made it.
- **Tiles cannot change at run time.** The tile layer is fixed once composed, so
  a door that opens or a block that breaks has to be an object. Editing the
  tilemap live is what a console does most cheaply, so this is a gap worth
  closing — and it needs a way to name a cell, which the language does not have.
- **The camera only follows.** No dead zone, no lookahead, no fixed regions, and
  no second scroll plane. Enough for the examples; not enough for a game that
  wants the view ahead of the player.
- **Single file.** No `include`; large games will want one.
  [Doc 19](19-projects.md) §Splitting a game states the two shapes it could
  take — every `.dmt` in a project's `src/` concatenated, or an explicit
  `import` — with the argument that the example library does not yet ask for
  either (96 lines is the largest game). It is a language change, so it waits on
  the maintainer rather than on a plan.

## Where the rest of it lives

| Concern | Document |
|---|---|
| The build manifest, art binding, ROM headers | [15 — Demakefile](15-demakefile.md) |
| The project folder, and how a bare asset name finds its file | [19 — Projects](19-projects.md) |
| `build` / `run` / `check` / `trace` / `init` / `fmt` | [05 — CLI](05-cli-spec.md) |
| Runtime artifacts and per-family assembly | [06 — Codegen](06-codegen-spec.md) |
| The Demotic section of the web app | [07 — Web App](07-web-app.md) |
| `@demake/demotic` public API | [09 — Library API](09-library-api.md) |
| Trace conformance and input-tape E2E | [10 — Testing](10-testing-strategy.md) |
| Milestones | [13 — Roadmap](13-roadmap.md) |
