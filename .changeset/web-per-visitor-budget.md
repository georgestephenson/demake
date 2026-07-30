---
"@demake/demotic": minor
---

A visitor downloads the console they are using, not all five.

The page shipped every console's emitter and every console's emulator core to
everyone. That was the right trade while there were two of each and an
increasingly bad one at five: `tools/ci/check-web-budget.mjs` had been raised
three times, its header said it must not move again, and the way out it named was
to split by family and let the budget become per-visitor. This is that.

**`demotic`'s `codegen/registry.ts` is descriptions, not backends.** Which
consoles a family covers, what its cartridge is called and what it cannot do are
a few lines each and stay synchronous, because every surface asks them — the
CLI's console check, the page's picker, the conformance suite's target list. The
emitter and its assembler are a hundred kilobytes, and `buildGame` — which was
already `async` — now `await`s the one family it needs. `registry.test.ts` pins
each description against the backend it describes, because a description that
drifted would be a page offering a console the build then refuses.

**The page's emulator cores moved to `src/players/`**, one module each, reached
through `bootPlayer`'s `import()`. `RomPane` lost five static imports and a
hundred lines of `boot`, and gained the one thing that arrangement costs: the
core arrives after an await, so a cartridge replaced across it must not leave two
machines running. Each console's framebuffer size stays eagerly importable —
`players.test.ts` pins the table against the cores' own constants — because the
canvas has to be sized before the core has landed.

**The budget is now what one visitor downloads**: every chunk once, except the
per-console ones, of which the largest family is charged. Chunks are matched to a
family by name, so a chunk that is not a family's counts as always-loaded and a
split that stopped working fails loudly. The site is 424 KB gzipped and a visitor
is 335 KB of it, against a budget of 400 that has not moved.

That headroom is what lets `quest` into the bundled example library, where it had
not fitted.
