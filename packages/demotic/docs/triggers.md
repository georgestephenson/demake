<!-- Generated from packages/demotic/src/lang/spec.ts. Do not edit by hand;
     run `pnpm gen:demotic-docs` after changing the registry. -->

# Rule triggers

A `when` rule fires on an **edge** (once, when something happens) or at a **level** (every tick something holds). Choosing wrongly is the most common source of a bug that looks correct.

| Trigger | Timing | Meaning |
|---|---|---|
| `<a> hits <b>, <c>` | edge | On contact, once — not once per tick of contact. |
| `<a> touches <b>, <c>` | level | Every tick two things overlap. |
| `<button> pressed \| released` | edge | On the button's edge, once per press. |
| `<expr> reaches <expr>` | edge | When a value lands on a target or crosses it from either side. |
| `<expr>` | level | Every tick the expression is non-zero. |

## Examples

```
when ball hits paddle (ydirection) as flip
```

```
when player touches ledge (ydirection) as 0
```

```
when a pressed in title (scene) as play
```

```
when score1.value reaches 10 in play (scene) as gameover
```

```
when always in play (paddle2.xdirection) as clamp(error / 1.5vw, -1, 1)
```

## Notes

**`<a> hits <b>, <c>`** — Bare class names bind to the two objects that collided, and an unqualified property targets the subject.

**`<a> touches <b>, <c>`** — Resting contact is not an event. Under `hits`, a hero standing on a ledge keeps accumulating gravity into `ydirection` while the separation holds it in place — it looks right, then fights the next jump.

**`<expr> reaches <expr>`** — A crossing detector, not a threshold: `reaches 0` on falling lives and `reaches 10` on a rising score must mean the same thing, and `>=` cannot express both. A value that *starts* on its target has not reached it.

**`<expr>`** — Level rules apply in program order and the last write wins, which is how a proportional controller and its limits compose.
