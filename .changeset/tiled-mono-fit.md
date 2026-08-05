---
"@demake/core": minor
---

Art for the mono WonderSwan, from a fit path whose search space is small enough
to enumerate.

`demake prep -c ws` and `demake inspect -c ws` now demake a picture for the one
console in the matrix whose palette has two levels of indirection — and the spec
says what that hardware really is, which it did not before. A tile is 2bpp, a
cell names one of sixteen four-entry palettes, and each entry is a three-bit
index into a **shared pool of eight shades**, itself chosen from the sixteen LCD
levels the panel can show. So `color.shades` (8, what the screen holds at once)
and a new `color.levels` (16, what the pool is chosen from) are different
numbers here and nowhere else.

`pipeline/fit-mono-tiled.ts` therefore chooses four things where the plain mono
path chooses none: the pool, the shared backdrop that entry zero holds in every
palette, each palette's other three, and each cell's palette. What makes that
affordable rather than another tournament is that the problem is **discrete**.
Once the pool is fixed there are exactly seventy quartets a cell could be given,
so the per-cell question is answered by evaluating all seventy rather than by
clustering toward one — exact, deterministic, PRNG-free, and less work than a
single k-means restart. Choosing which sixteen the picture gets is greedy
facility-location with a bounded swap pass, and the backdrop rides on top as an
outer sweep over the eight pool entries, each solved exactly under its own
restriction. Picking the backdrop by frequency first is how a fit comes to hold
three usable shades on hardware that has four.

A stored palette entry holds the **level**, 0–15, not the pool index, which is
what turns "at most eight distinct shades in the picture" into a rule `inspect`
checks (`E_SHADE_POOL`) rather than an encoding assumption nobody can verify. A
fit that reached for a ninth is caught rather than silently truncated.

No other console's output bytes change: `isMonoTiled` routes on
`subPalettes.count > 1` on a mono machine, which only this one is.
