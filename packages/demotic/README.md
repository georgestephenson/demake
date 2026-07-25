# @demake/demotic

**Exploratory prototype.** A declarative, SQL-flavoured language for describing a
game once and running it on every console in the target set. Design notes and the
reasoning behind each decision live in [`docs/14-demotic.md`](../../docs/14-demotic.md);
this file is how to run it.

Private to the workspace, not published.

## Try it

```sh
pnpm build      # required — both entry points import dist/

pnpm play                          # play Pong in the terminal, on a Game Boy
pnpm play -- --console md --frames # animate it on a Mega Drive playfield
pnpm play -- --trace               # emit a state trace instead

pnpm play -- packages/demotic/fixtures/games/caves.dmt --frames   # a scrolling level
pnpm test:dmt -- packages/demotic/fixtures/games/caves.dmt \
                 packages/demotic/fixtures/games/caves.test.dmt   # on every console

pnpm dev:web    # the browser preview, in the site's game section
```

The browser preview is the interesting one: the same source, live-editable, with
a console selector and a **constrain to console pixels** toggle that switches
between the art as authored and the art on the target's real pixel grid.

## What is here

```
src/lang/        lex → parse → flat statement AST (one statement per line)
src/lang/spec.ts the language registry — the only place its surface is defined
src/compile.ts   AST + console profile → a resolved Program (all constants folded)
src/sim.ts       the reference interpreter — the semantic definition of the language
src/level/       .dmtl levels: parse, camera + tile collision, `stream` composition
src/rng.ts       the game's seeded generator, shared by build time and run time
src/trace.ts     state traces: the cross-implementation conformance oracle
src/profiles.ts  the game-relevant projection of each ConsoleSpec
fixtures/        pong.dmt, its SVG art, and a checked-in golden trace
fixtures/games/  the example library — one game per feature nobody else exercises
demo/play.mjs    the terminal runner
```

Platform-pure and deterministic on the same terms as `@demake/core`: no `fs`, no
DOM, no wall clock, no host RNG, and no floats in the simulation. `src/profiles.ts`
restates a few numbers from `@demake/core`'s `ConsoleSpec`s rather than importing
them, so the simulator has zero dependencies and the preview needs no bundler;
`test/profiles.test.ts` cross-checks the two so they cannot drift.

## The language in one screen

```
start title                                  -- the game starts here

scene play
create object ball (width 1 cell, height 1 cell, speed 40vmin, sprite ball.svg)
create ball ball1 in play (x centerx, y centery, direction southwest)

control paddle1 left (xdirection -1) on hold  -- restores on release

when ball hits screenleft, screenright then xdirection as flip
when ball hits paddle then (ydirection, xdirection) as (flip, (ball.centerx - paddle.centerx) / paddle.width)
when always in play then paddle2.xdirection as clamp((ball1.centerx - paddle2.centerx) / 1.5vw, -1, 1)
when score1.value reaches 10 in play then scene as gameover
```

- Case-insensitive, `--` comments, **one statement per line, no nesting**.
  Declaration order does not matter.
- One unit is one 8×8 cell; speeds are cells per second. Relative units (`15vw`,
  `40vmin`) resolve against the playfield, which is how balance ports: use cells
  where a thing _is what it is_ everywhere, relative where it must stay balanced.
- `when <a> hits <b>` and `reaches` are edge-triggered; `touches` and a bare
  `when <expr>` are level-triggered and re-fire every tick they hold — which is
  why the opponent needs no special "AI" feature.
- Buttons are `left right up down a b start`. `start` warns on the Master
  System, which has no Start button.

## Levels

A scene's playfield is its level's size, or the screen's if it has none, so
`screenright` means the end of the level and the camera decides what is on
screen. Levels are their own file:

```
tile #  wall   solid  brick.svg
tile ^  spikes        spikes.svg

map
######################
#        ^^^^        #
######################
```

```
level cavern from cavern.dmtl
camera follows player
when player touches spikes then scene as gameover
```

`stream course from open.dmtl, lowpipe.dmtl 24 wide` composes a course from
chunks at build time using the program's `seed`, which is also what `random`
draws from. The reference is generated from the registry into
[`docs/`](docs/README.md) — never hand-edited, and a test fails if it goes stale.

## Testing

```sh
pnpm test       # whole workspace
npx vitest run packages/demotic
pnpm test:dmt   # the .test.dmt suites, on every console
```

`fixtures/pong.gb.trace` is the conformance target: raw 16.16 state per tick for
a fixed input tape. A console backend is correct when it emits those exact lines.
Changing that file means the language's semantics changed, and that should be a
deliberate, reviewed act.

`test/rom.test.ts` is that oracle applied to real hardware: it builds a Game Boy
cartridge from _every_ fixture game, boots it in `@demake/dmg`, reads the
entities out of work RAM every tick, and diffs. No toolchain and no emulator
install, so the loop that proves a backend correct runs wherever `pnpm test`
does. `test/art.test.ts` covers what a trace cannot see, because art is not
state.

## Building a ROM

```sh
demake build fixtures/pong.dmt -o pong.gb --title PONG
```

`src/codegen/` is the console backend, and it is a _compiler_ (doc 14 §2):
`asm.ts` encodes SM83 with labels and forward references, `analyze.ts` works out
which properties a game can actually change, `layout.ts` places its entities in
work RAM, and the emitters generate code for that game — entities at constant
addresses, rule loops unrolled over the objects that can match, comparisons
lowered to branches. A helper routine reaches the ROM only if something asked
for it, so a game that never divides ships no divider.

`art.ts` binds the art: it works out what the program needs and at what size,
hands the bytes to `@demake/core`, and hands the tiles back to the emitter. Every
decision about pixels is made in the image engine, which is what lets the browser
and the CLI produce identical cartridges.

The assembler being ours is the whole reason `demake build` needs no toolchain
and the web app can hand you the same bytes.
