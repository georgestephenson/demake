<!-- Generated from packages/demotic/src/lang/spec.ts. Do not edit by hand;
     run `pnpm gen:demotic-docs` after changing the registry. -->

# Expressions

## Units

Any numeric literal may carry a unit, attached (`15vw`) or spaced (`15 vw`).

| Unit | Resolves against |
|---|---|
| `cells` / `cell` | One 8×8 hardware cell. The default when no unit is written. |
| `vw` | One percent of the playfield's width. |
| `vh` | One percent of the playfield's height. |
| `vmin` | One percent of the playfield's shorter side. Use this for anything that must stay square. |
| `vmax` | One percent of the playfield's longer side. |

## Functions

| Signature | Meaning |
|---|---|
| `abs(x)` | Magnitude, dropping the sign. |
| `min(a, b)` | The smaller of two values. |
| `max(a, b)` | The larger of two values. |
| `clamp(x, low, high)` | `x` held between `low` and `high`. The basis of proportional control. |
| `random(low, high)` | A whole number from `low` to `high`, from the game's seeded generator. |

## Constants

Resolved against the target console at compile time.

| Constant | Value |
|---|---|
| `screenwidth` | Playfield width in cells — the overscan-*safe* width, not the raw frame. |
| `screenheight` | Playfield height in cells, overscan-safe. |
| `rawscreenwidth` | Raw framebuffer width in cells, before the overscan crop. |
| `rawscreenheight` | Raw framebuffer height in cells. |
| `centerx` | Horizontal middle of the playfield. |
| `centery` | Vertical middle of the playfield. |
| `screenleft` | Zero. Reads better than `0` in a position. |
| `screentop` | Zero. |
| `screenright` | Same as `screenwidth`. |
| `screenbottom` | Same as `screenheight`. |
| `fps` | Logical ticks per second on this console. |
| `levelwidth` | Playfield width in cells — the level's, or the screen's. |
| `levelheight` | Playfield height in cells. |
| `always` | One. `when always` is how a rule says *every tick*. |
| `never` | Zero. |

## Compass directions

Write-only sugar for the `direction` property. Diagonals are deliberately not normalised — `speed` applies per axis, so a diagonal travels at `speed` on both rather than `speed/√2`, which keeps the simulation in exact integers.

| Direction | `xdirection` | `ydirection` |
|---|---|---|
| `north` | `0` | `-1` |
| `south` | `0` | `1` |
| `east` | `1` | `0` |
| `west` | `-1` | `0` |
| `northeast` | `1` | `-1` |
| `northwest` | `-1` | `-1` |
| `southeast` | `1` | `1` |
| `southwest` | `-1` | `1` |

## Value words

| Word | Meaning |
|---|---|
| `flip` | Negates the property being assigned. `xdirection as flip` bounces. |
