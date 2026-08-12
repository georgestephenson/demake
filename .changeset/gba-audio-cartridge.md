---
"@demake/audio": minor
"demake": minor
---

Build a standalone Game Boy Advance audio cartridge, and fix this console's
driver rate.

`demake gen <schedule> -c gba --format rom` now produces a bootable `.gba` that
plays the schedule. It is the seventh standalone cartridge and the fifth
measurement of the same claim: `arm-player.ts` and `gba-driver.ts` are not
touched by it at all, so what the console added is a boot sequence, a clock and
a cartridge wrapper — the whole of `rom/gba.ts`.

**What makes it worth having anyway is that this is the first standalone whose
console's second sound device is not a chip.** Six of a Game Boy Advance's ten
voices are `@demake/chip`'s `GbaPcm`, a mixer the processor has to compute, so
this is the only cartridge in the set whose idle loop is not idle — and its
Level A proof is in two halves. `rom.test.ts` diffs the four Game Boy channels
tick for tick, as it does on six other machines, and diffs the **samples the
converters received** byte for byte against what the model renders from the same
schedule. Both halves are exact: the mixing is integer throughout.

**And this console's driver rate is not negotiable, which `fitRate` did not say.**
Every other `fitRate` here searches, because on every other console the clock and
the chip are separate things. Here a driver tick _is_ a block of mixer samples,
and a block is what the sample transfer's own interrupt counts out — 32768 ÷ 256
is 128 Hz exactly. This binding was searching the machine's spare timers instead
and fitting the example library's own fixtures at **56 Hz**: a schedule no
cartridge on this console could ever play, and one whose mixer samples would be
computed for the wrong moments if it tried.

The spec is unchanged and still declares `sources: ["timer", "vblank"]`, because
that is what the hardware has. What moved is the binding's answer about what a
_driver_ on it can keep — the distinction `psgBinding` reached from the other
side, where the hardware could not deliver the rate it was offering and here it
can, and the mixer is what cannot use it.

**Output bytes**: `demake arrange -c gba`, `demake sfx -c gba` and
`demake render -c gba` all change, because the schedule is now fitted to 128 Hz.
A `demake build -c gba` cartridge is byte-identical: a game already asked for
128 Hz through `gameDriverRate`, and until now the timer search happened to
answer it exactly.
