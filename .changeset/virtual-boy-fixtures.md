---
"@demake/demotic": minor
---

Two example-library fixes the Virtual Boy found, and one of them is a real bug.

Adding a sixteenth console is also a sixteenth run of every example's own
`.test.dmt` suite, and this machine is at both ends of the table at once: the
**slowest clock** in the set at 50.2 ticks a second, and the **widest screen** at
forty-eight cells. Each end broke something that had been true of every other
console.

**A jump's impulse now carries half a tick of gravity.** `caves` writes its
gravity against `fps` — a delta added every tick, so a constant would be a
heavier fall on a machine that ticks faster (AGENTS.md §Working on Demotic) —
and the suite asserts that a jump clears five rows and not six. But a tick pulls
_before_ it moves, so the first tick of a jump is already slowed and a slower
machine loses more of the rise. The apex spread five hundredths of a cell across
the consoles, and the threshold sat inside that spread: this console came out a
hundredth short of the ledge where every other one cleared it by six thousandths,
which on the cavern's staircase is a climb that stops.

Adding `- 1.2 / fps` to the impulse — half of the `2.4 / fps` the next tick will
subtract — collapses the spread tenfold, to five thousandths of a cell across all
sixteen. It is the same correction gravity itself already had, applied to the
other half of the same arithmetic, and it makes the claim the fixture's own
comment was already making actually true.

**`quest`'s vault is 48×28.** That level is deliberately _exactly_ the size of the
largest screen, so that it never scrolls on any console and the whole room is the
view — and the largest screen used to be a Mega Drive's forty cells. It is this
console's forty-eight now, so a level that had always been exactly right became
`E_LEVEL_TOO_SMALL`. The four new columns went on each side
in whatever material that edge was made of, so every shelf sits where it did
relative to the ones above and below it and the climb is unchanged.

Both change what a `caves` and a `quest` cartridge assemble to, on every console.
