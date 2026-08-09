---
"@demake/core": minor
"@demake/audio": minor
---

Declare the Neo Geo's sound hardware — fourteen voices, the widest in the matrix.

One chip and four sections that have almost nothing to do with each other, so the
spec reads like three consoles stacked rather than a longer version of any of
them: four FM voices on the YM2612's core at 8 MHz, three squares that reach 61 Hz
(_below_ an SN76489's floor, so this console needs none of the octave-doubling a
Master System's bass does) and leave the chip through their own mono output, six
fixed-rate sample voices, and one variable-rate one.

**The six fixed-rate voices are what make the console.** They play a recording at
18518.5 Hz and have no register that would change the note, so they are percussion
and nothing else — but they are _six_ of it, against every other console in the set
having one noise generator and calling it a drum kit. That is what the planner
learned: a `sample` channel is the best percussion voice there is, and whether it
can carry anything else is a question about its pitch. One with a lattice — the
ADPCM-B voice, whose rate is a phase increment the Super Nintendo's sample player
would recognise — is a real melodic option; one without is `UNUSABLE` for a melody,
because a tune on it is not a compromise, it is a wrong one. No existing console
spec has a `sample` channel, so every cartridge and every schedule is unchanged.

**The driver clock is a timer and only a timer.** This is the only console in the
matrix whose sound processor cannot see the picture: the Z80 takes an IRQ from the
YM2610's own timers and an NMI when the 68000 sends it a byte, and the vertical
blank reaches the 68000 alone. So `sources` names one entry where every other
console lists the frame among its options — and a frame the _game_ overran costs
the music no tempo at all, because the two processors share no clock.

The write budget is the largest in the matrix and it is arithmetic rather than
generosity: this processor has nothing else to do, so two thirds of a 120 Hz tick
is 192 register writes with the settling times the hardware documentation requires
between them.
