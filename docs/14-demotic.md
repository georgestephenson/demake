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
browser preview exist and run. No console runtime exists yet — that boundary is
deliberate and explained in §Runtime model. Milestones are in
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

Seven consoles: `gb`, `gbc`, `nes`, `sms`, `gg`, `md`, `snes` — all tiled sprite
machines with multi-colour hardware sprites and a comparable button set.

Deliberately excluded, each for its own reason:

- **SG-1000 / TMS9918** — four sprites per scanline and one colour per sprite.
  That does not constrain the language so much as distort it, since every other
  target shares a multi-colour sprite model. It remains a `prep`/`inspect` target.
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

Consequences, all deliberate: no floats in the simulation, no host RNG, no wall
clock, and one rounding rule — floor, which is what an arithmetic shift does on a
6502 or a Z80 — applied everywhere.

### 2. Compile to data, not to assembly

The compiler emits a `Program`: resolved tables of scenes, objects, controls and
rules, with every constant folded to fixed point. It does not emit Z80 or 6502.

A console runtime is a small fixed engine consuming those tables. Adding a
language feature is then a new opcode in each runtime, not a new code path in each
code generator — N + M work instead of N × M. It is the same move `ConsoleSpec`
makes for images: the constraint model is data, the engine is generic
(doc 02 §Extensibility).

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
- Speeds are per *second*, divided by the frame rate at compile time, so a 50 Hz
  build plays at the same speed as a 60 Hz one rather than 5/6 as fast.

## Language reference

Case-insensitive throughout — keywords and identifiers alike. `--` begins a
comment to end of line. **One statement per line, no nesting.** Declaration order
is irrelevant: `loop play` may precede `scene play`, and an instance may name a
class declared later.

Flatness is not stylistic. It buys total error recovery: a malformed statement
fails on its own line and every other statement still parses, so one pass reports
*every* problem in the file. That is the property that makes the language pleasant
to generate and patch programmatically.

### Statements

```
loop <scene>                                   -- entry point; exactly one per program
scene <name>                                   -- declare a scene
create object <class> ( <props> )              -- class definition with defaults
create <class> <name> [in <scene>] ( <props> ) -- instance, overriding class defaults
control <object> <button> ( <assigns> ) on hold|press|release
when <event> [in <scene>] ( <assigns> )
```

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
| `when <expr>` | level — every tick it holds |

**`hits` and `touches` are both needed and neither substitutes for the other.** A
bounce must happen once per contact, or it inverts every tick and the object
buzzes. Resting contact must be re-asserted every tick, or the state that contact
suppresses runs away unseen: a hero standing on a ledge under `hits` keeps
accumulating gravity into `ydirection` while the separation holds it in place, so
it looks correct and then fights the next jump. Sitting on something is not an
event.

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

### Type-directed resolution

Two resolutions remove all quoting ceremony:

- `sprite ball.svg` — the lexer sees a dotted name; because `sprite` is asset-typed,
  the compiler reads it as the literal string.
- `(scene) as gameover` — a bare name; because the `scene` target is scene-typed, it
  resolves to a scene rather than an expression.

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

All five compile for all seven consoles, stay inside every sprite budget, and
pass their own `.test.dmt` suites on every one — 196 cases in total, run in the
unit suite, from the CLI, and in the browser.

Writing them changed the language three times, which is the point of writing them
before the runtime rather than after: `touches` and the `reaches` crossing rule
both come from here, and `visible` gained its collision meaning here too.

### What they also found, and did not fix

Named because a runtime built to the current language will hit exactly these:

- **No background layer.** Static scenery has to be sprites, so a full-width
  floor costs twenty of a Game Boy's forty. The compiler warns, which is the
  right answer to the wrong problem — scenery wants tiles.
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
play 60 ticks
expect ball1.y > centery
expect ball1.x < centerx

test the player paddle reaches the left wall and stops there
press a
hold left for 300 ticks
expect paddle1.x = 0
expect paddle1.xdirection = 0

test a still player concedes a point and the ball returns to the middle
press a
play 80 ticks
expect score2.value = 1
expect abs(ball1.y - centery) < 15vh
```

Statements are `test <name>`, `play <n> ticks`, `press <button>`,
`hold <button> for <n> ticks`, `expect <expression>` and `expect scene <name>`.
Same shape as the language: one per line, no nesting, `--` comments, per-line
error recovery. A `test` line opens a case and every line after it belongs to
that case; each case gets a fresh simulator, so none can leak into another.

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

Every one is per-console, because every one of these is a property of the target
rather than of the source: a 30-cell wall is fine on a NES and impossible on a
Game Boy, and the same file is asked about both.

The dynamic counterpart is the per-scanline sprite count, which depends on where
things are and so is watched by the simulator as it runs (§Budgets).

## Runtime model

A build produces two things per target: the **program tables** (from the compiler,
console-specific only in that constants are folded) and a **runtime** (hand-written
per CPU family, identical across every game).

A conforming runtime must implement, in this order, once per tick:

1. Resolve input edges (pressed / released since last tick).
2. Apply `control` bindings.
3. Apply level-triggered rules.
4. Integrate positions: `direction × speed ÷ fps`, floored, in that order.
5. Detect collisions, fire `hits` rules on entry, then separate.
6. Fire edge-triggered rules.
7. Apply any pending scene change, resetting the entered scene.

The order is load-bearing: a runtime that reorders these diverges within seconds.
Rough size for a v1 runtime is 1.5–3k lines of assembly per family — entity table,
input, fixed-point integrator, AABB collision, OAM upload with per-scanline
mitigation, background glyphs, scene state, plus the table decoder.

Families map onto the existing codegen families (doc 06): `gb`, `nes`, `sms`
(SMS + GG), `md`, `snes`. Runtimes live in `runtime-harness/<family>/`, sibling to
`rom-harness/`, and are assembled by the same toolchain edge that already builds
image ROMs.

## Conformance

Two layers, both cheap, in the order that finds bugs fastest.

**1. State-trace equality.** Same input tape → identical fixed-point entity state
per tick. Values are emitted as raw 16.16 integers, never decimals: a decimal
rendering hides the one-bit disagreement that compounds into a visibly different
game a thousand ticks later. Golden traces are checked in per (console, region);
`packages/demotic/fixtures/pong.gb.trace` is the first. Proving a port is a `diff`,
not a judgement call.

```
# demotic trace v1 console=gb
# props=x,y,xdirection,ydirection,speed,value units=16.16
1 play ball1=655360,589824,-65536,65536,524288,0 paddle1=655360,1114112,0,0,786432,0
```

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

- **No console runtimes.** The whole point of §2 is that these are the next piece
  of work; the semantics are the risky part and are cheaper to settle in TypeScript
  first.
- **No deterministic art rasterisation.** The preview draws SVG natively; a ROM
  needs pixels, and deterministic SVG rasterisation across Node and browsers is
  genuinely hard — text metrics, font fallback and antialiasing all drift against
  an iron rule of byte-determinism. Doc 15 §Art specifies the raster-first path and
  treats SVG as a preview convenience until a restricted rasteriser exists.
- **No `destroy` or runtime spawn.** Pong does not need them; Breakout and Snake
  do. The schema has room.
- **No RNG.** It must be a seeded, specified generator, not the host's, or traces
  stop being comparable. `@demake/core`'s PCG32 is the obvious candidate.
- **No sound.** Overlaps with the audio demake entry in doc 13 §Phase 7+.
- **No scrolling or multi-screen levels.** The largest genuine language gap: it
  needs a camera concept and background streaming, and it is where per-scanline
  sprite pressure actually bites.
- **Single file.** No `include`; large games will want one.

## Where the rest of it lives

| Concern | Document |
|---|---|
| The build manifest, art binding, ROM headers | [15 — Demakefile](15-demakefile.md) |
| `build` / `run` / `check` / `trace` / `init` / `fmt` | [05 — CLI](05-cli-spec.md) |
| Runtime artifacts and per-family assembly | [06 — Codegen](06-codegen-spec.md) |
| The Demotic section of the web app | [07 — Web App](07-web-app.md) |
| `@demake/demotic` public API | [09 — Library API](09-library-api.md) |
| Trace conformance and input-tape E2E | [10 — Testing](10-testing-strategy.md) |
| Milestones | [13 — Roadmap](13-roadmap.md) |
