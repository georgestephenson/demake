---
"@demake/audio": minor
"@demake/demotic": minor
---

Give a borrowed channel back holding the music's own registers.

The packed music is a delta stream, so a register the music's own value did
not change is one it never states again. After a sound effect borrowed a
channel the chip was left holding the effect's values for it, and the music's
next volume step re-triggered the voice through a register whose neighbour
still carried the effect's pitch — a Game Boy pulse coming back a whole tone
sharp and ringing until the bar ended, on every bounce in pong.

The music now keeps a copy of every register belonging to a channel an effect
can take, and the release replays it. All seven drivers: SM83, 6502 (the NES and
the PC Engine), Z80, 68000, SPC700 and ARM (the Game Boy Advance and the
Nintendo DS).

Cartridge bytes move on every console with a driver: the run walk gains a
recording loop and the release a replay, and each borrowable channel takes a
few bytes of driver RAM.

Also: a percussion part could be assigned to a pitched channel and then played
General MIDI's drum numbers as pitches — an out-of-key bassline under the melody.
A channel that cannot voice a part at all now costs infinite, so the part is
dropped and counted; an arrangement that says "no drums" drops the part rather
than only the noise channel; and an FM voice, which really can be struck, is
struck at a pitch the drum class states rather than at its note number.
