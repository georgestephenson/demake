---
"@demake/demotic": minor
---

Advance the generator on every draw, on every console.

`random(low, high)` advances the seeded generator whether or not the bounds leave
anything to choose. The interpreter has always done that; all five console
backends skipped the advance when the bounds met or crossed, so a cartridge and
the reference ran different games from the tick after a degenerate draw.

The definition now lives in one place. `rng.ts` gains `draw(state, low, high)` —
the whole of what `random` means, including *when* the state moves — and `sim.ts`
calls it. Each backend's `emitRngPick` hoists its advance to the top of the
routine, where nothing is live yet and the call therefore costs no saves; on the
Game Boy that also turns a `push hl` / `pop bc` pair into two register moves.

The regression guard is one battery over every console with a backend
(`rom.test.ts`, "the generator, on every console"): a program that draws twice a
tick, the first draw degenerate, traced against the interpreter. A backend that
skips the advance disagrees from the first tick and never recovers.

No golden trace moves — no fixture makes a degenerate draw, which is why this
survived five backends — but the emitted bytes do, so this is a minor.
