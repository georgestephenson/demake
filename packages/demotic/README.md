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

pnpm preview    # then open http://localhost:5173/
```

The browser preview is the interesting one: the same source, live-editable, with
a console selector and a **constrain to console pixels** toggle that switches
between the art as authored and the art on the target's real pixel grid.

## What is here

```
src/lang/        lex → parse → flat statement AST (one statement per line)
src/compile.ts   AST + console profile → a resolved Program (all constants folded)
src/sim.ts       the reference interpreter — the semantic definition of the language
src/trace.ts     state traces: the cross-implementation conformance oracle
src/profiles.ts  the game-relevant projection of each ConsoleSpec
fixtures/        pong.dmt, its SVG art, and a checked-in golden trace
preview/         the browser preview (no bundler — dist/ is plain ESM)
demo/play.mjs    the terminal runner
```

Platform-pure and deterministic on the same terms as `@demake/core`: no `fs`, no
DOM, no wall clock, no RNG, and no floats in the simulation. `src/profiles.ts`
restates a few numbers from `@demake/core`'s `ConsoleSpec`s rather than importing
them, so the simulator has zero dependencies and the preview needs no bundler;
`test/profiles.test.ts` cross-checks the two so they cannot drift.

## The language in one screen

```
loop title                                   -- the game starts here

scene play
create object ball (width 1, height 1, speed 8, sprite ball.svg)
create ball ball1 in play (x centerx, y centery, direction southwest)

control paddle1 left (xdirection -1) on hold  -- restores on release

when ball hits screenleft, screenright (xdirection) as flip
when ball hits paddle (ydirection, xdirection) as (flip, (ball.centerx - paddle.centerx) / paddle.width)
when paddle2.centerx > ball1.centerx in play (paddle2.xdirection) as -1
when score1.value reaches 10 in play (scene) as gameover
```

- Case-insensitive, `--` comments, **one statement per line, no nesting**.
  Declaration order does not matter.
- One unit is one 8×8 cell; speeds are cells per second. `screenwidth` and
  `screenheight` are the _overscan-safe_ size, so they are 20×18 on a Game Boy
  and 40×28 on a Mega Drive.
- `when <a> hits <b>` and `reaches` are edge-triggered; a bare `when <expr>` is
  level-triggered and re-fires every tick it holds — which is why the opponent
  needs no special "AI" feature.
- Buttons are `left right up down a b start`. `start` warns on the Master
  System, which has no Start button.

## Testing

```sh
pnpm test       # whole workspace
npx vitest run packages/demotic
```

`fixtures/pong.gb.trace` is the conformance target: raw 16.16 state per tick for
a fixed input tape. A console runtime is correct when it emits those exact lines.
Changing that file means the language's semantics changed, and that should be a
deliberate, reviewed act.
