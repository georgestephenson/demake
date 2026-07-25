# `runtime-harness/gb` — the Demotic runtime for the Game Boy

The fixed SM83 engine a Demotic game's program tables drive (doc 14 §Runtime
model). It is **not** generated code: one image serves every game, and a build
patches the tables into it.

| File | What |
| --- | --- |
| `main.asm` | memory map, boot, the tick order, input, and the table format's constants |
| `math.inc` | 16.16 fixed point: add, subtract, compare, clamp, multiply, divide, and the game's LCG |
| `eval.inc` | property access and the postfix expression VM |
| `rules.inc` | controls, level rules, integration, collision and separation, edge rules |
| `render.inc` | the background shadow and its diff, text and number glyphs, OAM |

## The two contracts

**With the table format.** Every offset, record size and opcode in
`packages/demotic/src/rom/format.ts` appears here as a `DEF`. They move together
in one commit or not at all; `packages/demotic/test/tables.test.ts` pins the
sizes so a drift fails a test rather than a ROM.

**With the reference interpreter.** `packages/demotic/src/sim.ts` is the
specification, and this is a conformance implementation of it — including the
parts that look like details and are not: the tick order, `hits` firing on entry
where `touches` fires every tick, separation re-testing after a rule runs, and
floor rounding everywhere. `packages/demotic/test/rom.test.ts` diffs raw 16.16
state for hundreds of ticks across five games, so a mistake here surfaces at the
tick it happened.

## Building it

```sh
pnpm gen:runtime        # reassemble and rewrite the checked-in image (needs RGBDS)
```

The image lives in `packages/demotic/src/rom/runtime-gb.generated.ts`, checked in
so that `demake build` and the browser need no toolchain, and guarded by a
staleness test in the same shape the man pages use. **Editing the assembly
without regenerating changes nothing.**

## What it does not do yet

Named rather than hidden, and `demake build` refuses a game that needs any of the
first two rather than shipping a cartridge that plays differently from the
preview:

- **Levels, tiles and the camera.** They landed in the language after this
  runtime's scope was set (doc 14 §Levels).
- **Sprite art.** Objects draw as a solid block from the built-in tile bank until
  doc 15's rasteriser exists; the instance record already carries the field real
  art will fill.
- **Speed.** It is correct before it is fast: a tick costs roughly three Game Boy
  frames, so a game runs at about 20 Hz on hardware, and the web app reports the
  measured figure rather than hiding it. The known wins, in order: pointer-based
  property access, a quarter-square table for `Mul32`, and skipping leading zero
  bytes in the general `Div32`. Profile with `@demake/dmg` and `rgblink -n`'s
  symbol map before changing anything — every optimisation so far came from that
  histogram and none from intuition.
