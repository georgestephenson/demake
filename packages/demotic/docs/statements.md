<!-- Generated from packages/demotic/src/lang/spec.ts. Do not edit by hand;
     run `pnpm gen:demotic-docs` after changing the registry. -->

# Statements

Case-insensitive throughout. `--` begins a comment. **One statement per line, no nesting**, and declaration order does not matter.

## `start`

Names the scene the game begins on. Exactly one per program.

```
start <scene>
```

```
start title
```

## `seed`

Fixes the game's random source. Optional; the default is 1.

```
seed <n>
```

```
seed 20260725
```

The seed lives in the game, never in the Demakefile: a different seed is a different game, and the build file may not change how a game plays (doc 15). It is also what `stream` composes its levels with, so one number decides the whole course.

## `scene`

Declares a scene. Objects and rules belong to one.

```
scene <name>
```

```
scene play
```

## `create object`

Declares a class and its default properties.

```
create object <class> ( <properties> )
```

```
create object ball (width 1 cell, height 1 cell, speed 40vmin, sprite ball.svg)
```

## `create`

Creates one object, overriding its class defaults.

```
create <class> <name> [in <scene>] ( <properties> )
```

```
create ball ball1 in play (x centerx, y centery, direction southwest)
```

## `level`

Loads a level, which becomes the scene's playfield.

```
level <name> [in <scene>] from <file.dmtl>
```

```
level cavern from cavern.dmtl
```

A scene with a level takes that level's size as its bounds, so `screenwidth` and the screen edges mean the *level's* edges — a player running right stops at the end of the level, not at an invisible wall a screen-width in. Object positions are level coordinates throughout; the camera decides what is on screen, which is why scrolling does not infect every rule in the game.

## `stream`

Builds a level by drawing `n` chunks at random and laying them end to end.

```
stream <name> [in <scene>] from <file>, <file>, … <n> wide|tall
```

```
stream course from gap.dmtl, low.dmtl, high.dmtl 24 wide
```

An endless scroller is not an endless level — it is a short vocabulary of hand-made pieces played in an order nobody wrote down. Composition happens at compile time from the program's `seed`, so the result is an ordinary level: the simulator, the camera and a console runtime all see a tilemap and need no notion of streaming. Chunks share one legend, and must agree on the dimension they are not laid along.

## `backdrop`

Fills a scene's background with a demade picture.

```
backdrop <file> [in <scene>]
```

```
backdrop title.svg
```

The picture goes through the *image* pipeline — the same fitter `prep` uses — so a title screen is demade exactly the way a photograph is, into tiles and a tilemap the background layer draws for free. It is scenery and nothing else: nothing collides with it, nothing reads it, and a scene that scrolls has a level instead. What it costs is tiles, and a console has a fixed number of them; art that needs more than are left over is a build error naming the number, because the alternative is a title screen with holes in it.

## `music`

Plays a demade track while a scene is on screen.

```
music <file> [in <scene>]
```

```
music theme.mid in play
```

The track goes through the *music* demaker — the same pipeline `demake arrange` uses — so a game's soundtrack is demade exactly the way a standalone track is: fitted to the console's chip, its tempo held, its dropped parts counted. It belongs to the scene, so entering the scene starts it from the top and leaving stops it; a scene with no `music` is silent, which is how a title screen stays quiet under a game that has a theme.

## `sound`

Fires a demade sound effect when something happens.

```
sound <file> on <trigger> [in <scene>] [if <expr>]
```

```
sound bounce.wav on ball hits paddle
```

The triggers are `when`'s, exactly: a sound fires on a collision, a button, a value being reached or a condition holding, and `in` and `if` narrow it the same way. What it does not have is `then` — a sound is not an assignment, and a rule that could both play a note and move an object would be two statements wearing one keyword. Effects share the chip with the music: one plays at a time, the louder one wins, and the channel it borrows goes back to the music when it ends.

## `camera`

Keeps the viewport centred on an object, clamped inside the level.

```
camera follows <object> [in <scene>]
```

```
camera follows player
```

The clamp is what stops the view running off the end of a level, and it means a level no bigger than the screen never scrolls — so a non-scrolling game needs no special case. `camera.x` and `camera.y` are readable in expressions.

## `control`

Binds a button to property changes on one object.

```
control <object> <button> ( <assignments> ) on hold|press|release
```

```
control paddle1 left (xdirection -1) on hold
```

`on hold` restores the previous value when the button comes up, so releasing leaves the object stopped. Snapshots are per binding, which is what makes overlapping presses unwind in reverse order.

## `when`

Fires assignments when something happens, or while something holds.

```
when <trigger> [in <scene>] [if <expr>] then <assignments> [else <assignments>]
```

```
when ball hits screenleft, screenright then xdirection as flip
```

`then` separates the condition from the consequence, which is what makes a long rule readable. `if` guards a trigger with a condition — `when a pressed if shot.visible = 0` is how a rule fires only when the state allows it. `else` runs when the rule was evaluated and did not fire, so it is allowed on level triggers and on any guarded rule, but not on a bare edge trigger, where "did not fire" would mean every other tick of the game. Brackets are optional around a single `name as value`.

## Clause keywords

The words that join a statement's parts. Each is a keyword only where the grammar expects it — `start` is also a button and `scene` is also an assignment target.

| Keyword | Meaning |
|---|---|
| `object` | Declares a class rather than an instance, in `create object`. |
| `in` | Narrows a declaration or a rule to one scene. |
| `from` | Names the file a level or a stream is built from, or the sides a collision may have been on. |
| `follows` | The camera's one verb. |
| `wide` | Lays a stream's chunks left to right. |
| `tall` | Lays a stream's chunks top to bottom. |
| `on` | Introduces a control's timing, or a sound's trigger. |
| `hold` | A control that restores the previous value on release. |
| `press` | A control that fires on the press and stays. |
| `release` | A control that fires on the release. |
| `if` | Guards a trigger with a condition. |
| `then` | Separates a rule's condition from its consequence. |
| `else` | Runs when an evaluated rule did not fire. |
| `as` | Assigns a value to a property. |
| `hits` | Contact, once — an edge trigger. |
| `touches` | Overlap, every tick — a level trigger. |
| `pressed` | A button's press edge. |
| `released` | A button's release edge. |
| `reaches` | A value landing on a target, or crossing it. |
