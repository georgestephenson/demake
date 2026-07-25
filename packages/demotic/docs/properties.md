<!-- Generated from packages/demotic/src/lang/spec.ts. Do not edit by hand;
     run `pnpm gen:demotic-docs` after changing the registry. -->

# Properties

## Assignable

| Property | Kind | Default | Meaning | Notes |
|---|---|---|---|---|
| `x` | number | `0` | Left edge, in cells from the left of the playfield. | — |
| `y` | number | `0` | Top edge, in cells from the top of the playfield. | — |
| `width` | number | `1` | Collision box width, in cells. | whole cells |
| `height` | number | `1` | Collision box height, in cells. | whole cells |
| `speed` | number | `0` | Movement magnitude, in cells per second. | — |
| `xdirection` | number | `0` | Horizontal multiplier applied to `speed`, normally −1…1. | — |
| `ydirection` | number | `0` | Vertical multiplier applied to `speed`. Positive is downward. | — |
| `visible` | number | `1` | Non-zero to take part in the game at all. | — |
| `value` | number | `0` | The number a `number` object displays. | — |
| `sprite` | asset | — | Art for this object. Unquoted filenames are read literally. | create-only |
| `text` | text | — | The string a `text` object displays. | create-only |
| `direction` | number | — | Compass shorthand that sets `xdirection` and `ydirection` together. | — |

## Derived

Readable, never assignable — assigning one is an error that names the property to use instead.

| Property | Value |
|---|---|
| `centerx` | `x + width / 2`. |
| `centery` | `y + height / 2`. |
| `left` | `x`. |
| `right` | `x + width`. |
| `top` | `y`. |
| `bottom` | `y + height`. |

## Notes

**`width`** — This is the box that collides *and* the sprite's footprint, so it rounds to whole cells — hardware sprites come in whole 8×8 units and a 4.8-cell box corresponds to nothing that can be drawn.

**`speed`** — Per *second*, not per tick: the frame rate is divided out at compile time, so a 50 Hz build plays at the same speed as a 60 Hz one rather than 5/6 as fast.

**`xdirection`** — Speed applies per axis, so a diagonal heading travels at `speed` on both. Nothing is normalised — that would need a square root, and the simulation stays in exact integers.

**`visible`** — `visible 0` is inert: not drawn, not collided with, not moved. That is how an object leaves play — a broken brick, a spent bullet — and why there is no `destroy`. An object you cannot see but can still hit is a bug in every game that has ever shipped one.

**`direction`** — Write-only sugar: `direction northwest` is exactly `xdirection -1, ydirection -1`.
