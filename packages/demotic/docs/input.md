<!-- Generated from packages/demotic/src/lang/spec.ts. Do not edit by hand;
     run `pnpm gen:demotic-docs` after changing the registry. -->

# Input, edges and sides

## Buttons

The portable set — the floor across every target console, which is why it is this small.

| Button | Meaning |
|---|---|
| `left` | D-pad left. |
| `right` | D-pad right. |
| `up` | D-pad up. |
| `down` | D-pad down. |
| `a` | The primary face button. |
| `b` | The secondary face button. |
| `start` | Start or pause. Not a face button everywhere — the Master System has none, and the compiler warns. |

## Screen edges

Usable anywhere an object can be, as a collision target.

| Edge | Meaning |
|---|---|
| `screenleft` | The left edge of the playfield. |
| `screenright` | The right edge. |
| `screentop` | The top edge. |
| `screenbottom` | The bottom edge. |

## Collision sides

`from above, left` narrows a `hits` or `touches` rule to contacts resolved on those sides. Each name describes **the subject's** position, which is the reading the sentence has out loud: `when hero touches ledge from above` is the hero above the ledge, and so a landing.

Without a `from`, a rule fires on any side — which is what every rule written before this existed means. A screen edge has only one side, so it takes no `from`.

| Side | Meaning |
|---|---|
| `above` | The subject's underside met the other's top. |
| `below` | The subject's top met the other's underside. |
| `left` | The subject's right met the other's left. |
| `right` | The subject's left met the other's right. |
