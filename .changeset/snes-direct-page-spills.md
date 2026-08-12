---
"@demake/demotic": minor
---

Let a Super Nintendo game overrun the direct page instead of being refused for
it.

The direct page is a pure size optimisation on a 65816: `$nn` is two bytes where
`$nnnn` is three, and the index registers are sixteen bits wide so `$nnnn,x`
reaches all of bank zero — nothing this backend allocates has to be down there.
So a game that fills the 238 bytes it has should get a slightly larger program,
and until now it got a build error. `quest` was one byte over.

`MemoryPlan.fastSpills` says so, and only the Super Nintendo's plan sets it. On a
6502 the same overrun has to stay fatal: page zero is the only place a pointer
can live, because `($nn),y` is that CPU's one indirect mode, so an address that
fell through to the heap could not be dereferenced at all.

Only a request the region cannot hold moves, so no game that fits changes by an
address — and a later smaller request still gets the cheap region, which keeps as
much of a game down there as will go.

This clears the first of the two walls `quest` hits on that console. The
cartridge is the other one, and it is doc 13 §Banked cartridges.
