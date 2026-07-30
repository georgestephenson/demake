<!-- Generated from packages/demotic/src/lang/spec.ts. Do not edit by hand;
     run `pnpm gen:demotic-docs` after changing the registry. -->

# Rule triggers

A `when` rule fires on an **edge** (once, when something happens) or at a **level** (every tick something holds). Choosing wrongly is the most common source of a bug that looks correct.

| Trigger | Timing | Meaning |
|---|---|---|
| `<a> hits <b>, <c> [from <side>, <side>]` | edge | On contact, once — not once per tick of contact. |
| `<a> touches <b>, <c> [from <side>, <side>]` | level | Every tick two things overlap. |
| `<button> pressed \| released` | edge | On the button's edge, once per press. |
| `<expr> reaches <expr>` | edge | When a value lands on a target or crosses it from either side. |
| `<class>.<property> <op> <expr>` | level | Every tick, once per object of that class, with it bound as the subject. |
| `<expr>` | level | Every tick the expression is non-zero. |

## Examples

```
when ball hits paddle then ydirection as flip
```

```
when player touches ledge from above then ydirection as 0
```

```
when a pressed in title then scene as play
```

```
when score1.value reaches 10 in play then scene as gameover
```

```
when rock.y >= screenheight then y as 0
```

```
when always in play then paddle2.xdirection as clamp(error / 1.5vw, -1, 1)
```

## Notes

**`<a> hits <b>, <c> [from <side>, <side>]`** — Bare class names bind to the two objects that collided, and an unqualified property targets the subject. `from above, below, left, right` narrows the rule to contacts resolved on those sides, named from the *subject's* position: `hits wall from below` is a head-bonk. Without it the rule fires on any side. A screen edge has only one, so it takes no `from`.

**`<a> touches <b>, <c> [from <side>, <side>]`** — Resting contact is not an event. Under `hits`, a hero standing on a ledge keeps accumulating gravity into `ydirection` while the separation holds it in place — it looks right, then fights the next jump.

**`<expr> reaches <expr>`** — A crossing detector, not a threshold: `reaches 0` on falling lives and `reaches 10` on a rising score must mean the same thing, and `>=` cannot express both. A value that *starts* on its target has not reached it.

**`<class>.<property> <op> <expr>`** — A level rule naming exactly one class runs once per instance of it, so an unqualified property means *this* object's. One line replaces one rule per object, and one place to forget one. Naming two classes has no single subject to pick and is an error rather than a guess.

**`<expr>`** — Level rules apply in program order and the last write wins, which is how a proportional controller and its limits compose.
