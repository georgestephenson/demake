---
"@demake/audio": minor
"@demake/demotic": minor
---

Give the example library the arrangements a wide console can actually spend, and
put the Game Boy Advance's mix loop where it can afford to run.

The fixtures were three- and four-part MIDIs. That is enough to make a Game Boy
choose, which is what they were written for, but it is not enough to make a Mega
Drive or a Nintendo DS do anything at all: four parts take four voices and the
other six or twelve sit idle, so a machine being spent looked exactly like a
machine being starved. Every tune is now a full arrangement of nine or ten parts
— bass, sub, chords, pad, arpeggio, melody, harmony, counter-line, echo, kit —
derived from its own material, so each added line is in key by construction and
the four parts that were there are unchanged, note for note.

What the demakers make of that is the point: the arranger takes as many parts as
the console can play and drops the rest by salience. A Game Boy, an NES and a
Master System take three or four; a Super Nintendo, a Mega Drive, a Game Boy
Advance and a Nintendo DS take six to eight — every part the arrangement has.

**Two faults in the arranger only a wide arrangement could reach**, and both are
fixed here. Salience _saturated_: a lead-role note's score was the role's weight
plus terms that pushed it past the ceiling and were clipped, so every note of
every lead scored exactly 1.0, two leads were indistinguishable, and the
planner's `worth` reduced to the role weight with ties broken on the part's id.
The terms now spend the headroom the role leaves rather than overflowing it. And
the planner ranked _purely_ by worth, so five melodic parts filled a
four-channel console and left nothing for the bass or the kit — which no
arranger does. It now offers a channel to the best part of each role before the
second-best of any role, which is one line for a piece with one part per role
and the difference between music and a pile of melodies for anything wider.

**And it uncovered a real cost.** The Game Boy Advance's mixer had never mixed
anything: no track in the library reached its sample voices, so its speed case
was measuring six silent voices. Pointed at a track that reaches them, a game
tick took 1.85 frames. The cause is this console's own arithmetic — an
instruction fetched over the cartridge bus costs the wait states `WAITCNT` names
and one fetched from internal work RAM costs none — so the driver now copies
`AudioMix` and its literal pool into internal RAM at boot and calls the copy,
which is what every real mixer on the machine does. That is 1.00 frames a tick,
and the samples it produces are byte-identical to what the model renders, which
is what says the move changed nothing but the address.

**And a second real cost, on the Super Nintendo.** Its sound processor's image
shared a cartridge bank with the tile art, which was fine while a schedule was
three voices wide and is not fine at eight: `caves` was refused for having too
much art when what it had too much of was music. The image has a bank of its own
now and the cartridge is 128 KiB rather than 64 — this console takes four
megabytes, so the old size was a choice rather than a limit — and the two are
refused separately, because "too much art" and "too much music" are different
things to be told.

Output bytes change for every console: the schedules are demade from different
source material, and a Super Nintendo cartridge is twice the size. Cartridge
budgets were re-checked on all of them — the tight ones are unaffected, because a
four-channel console still plays four channels.
